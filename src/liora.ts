import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, http, isAddress, keccak256, stringToHex } from "viem";
import { base } from "viem/chains";
import * as z from "zod/v4";
import { atomicAmount, proposeEvm } from "./paybox.js";

type Hex = `0x${string}`;

// ---------------------------------------------------------------------------
// Constants. Everything chain-specific is hardcoded: tools cannot choose a
// token, chain or RPC endpoint, so a caller cannot redirect funds or requests.
// ---------------------------------------------------------------------------
export const BASE_CHAIN = "eip155:8453" as const;
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
export const USDC_DECIMALS = 6;
/** 1,000,000,000 USDC in atomic units: a sanity ceiling, not a protocol limit. */
export const MAX_ATOMIC = 10n ** 15n;
export const BASE_RPC_URL = "https://mainnet.base.org";
export const BASE_RPC_HOST = "mainnet.base.org";
export const RPC_TIMEOUT_MS = 4_000;
export const DEFAULT_MIN_CONFIRMATIONS = 1;
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const MAX_LISTED_TRANSFERS = 20;

// ---------------------------------------------------------------------------
// Money: decimal strings in, bigint atomic units internally. No floats anywhere.
// ---------------------------------------------------------------------------
export function parseUsdc(amount: string): bigint {
  const atomic = BigInt(atomicAmount(amount, USDC_DECIMALS));
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  if (atomic > MAX_ATOMIC) throw new Error("Amount exceeds the 1,000,000,000 USDC limit.");
  return atomic;
}

export function formatUsdc(atomic: bigint): string {
  if (atomic < 0n) throw new Error("Amount cannot be negative.");
  const digits = atomic.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = digits.slice(0, digits.length - USDC_DECIMALS);
  const fraction = digits.slice(digits.length - USDC_DECIMALS).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function isValidUsdc(amount: string): boolean {
  try {
    parseUsdc(amount);
    return true;
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Schemas. Every object is .strict(); money is always a string.
// ---------------------------------------------------------------------------
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Use a 0x-prefixed 20-byte EVM address.")
  .refine((value) => isAddress(value), "Invalid EVM address: mixed-case input must have a valid EIP-55 checksum.");

export const amountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/, 'Use a decimal string with at most 6 decimals, for example "1.25".')
  .refine(isValidUsdc, "Amount must be greater than 0 and at most 1,000,000,000 USDC.");

const descriptionSchema = z
  .string()
  .min(1)
  .max(280)
  .refine((value) => value === value.trim(), "Description must not start or end with whitespace.")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Description must not contain control characters.");

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine(isRealDate, "Not a real calendar date.");

const referenceSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/, "Use letters, digits, and . _ : - only.");

export const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Use a 0x-prefixed 32-byte transaction hash.");

export const createAgreementInputSchema = z
  .object({
    payee: addressSchema,
    payer: addressSchema.optional(),
    amount: amountSchema,
    description: descriptionSchema,
    dueDate: dueDateSchema.optional(),
    reference: referenceSchema.optional(),
  })
  .strict();

export const agreementSchema = z
  .object({
    version: z.literal("liora/1"),
    chain: z.literal(BASE_CHAIN),
    asset: z.object({ symbol: z.literal("USDC"), address: z.literal(USDC_BASE), decimals: z.literal(6) }).strict(),
    payee: addressSchema,
    payer: addressSchema.optional(),
    amount: amountSchema,
    atomicAmount: z.string().regex(/^[1-9][0-9]{0,15}$/),
    description: descriptionSchema,
    dueDate: dueDateSchema.optional(),
    reference: referenceSchema.optional(),
    agreementId: z.string().regex(/^0x[0-9a-f]{64}$/),
  })
  .strict();

export const createAgreementOutputSchema = z.object({ agreement: agreementSchema }).strict();
export const proposePaymentInputSchema = z.object({ agreement: agreementSchema }).strict();

export type Agreement = z.infer<typeof agreementSchema>;

// ---------------------------------------------------------------------------
// create_agreement: stateless. The agreementId is a pure function of the terms,
// so any later call can re-derive it and detect tampering. Nothing is stored.
// ---------------------------------------------------------------------------
function orderedBody(a: Omit<Agreement, "agreementId">) {
  return {
    version: a.version,
    chain: a.chain,
    asset: { symbol: a.asset.symbol, address: a.asset.address, decimals: a.asset.decimals },
    payee: a.payee,
    ...(a.payer === undefined ? {} : { payer: a.payer }),
    amount: a.amount,
    atomicAmount: a.atomicAmount,
    description: a.description,
    ...(a.dueDate === undefined ? {} : { dueDate: a.dueDate }),
    ...(a.reference === undefined ? {} : { reference: a.reference }),
  };
}

export function computeAgreementId(a: Omit<Agreement, "agreementId">): Hex {
  return keccak256(stringToHex(JSON.stringify(orderedBody(a))));
}

export function buildAgreement(raw: unknown): Agreement {
  const input = createAgreementInputSchema.parse(raw);
  const atomic = parseUsdc(input.amount);
  const body: Omit<Agreement, "agreementId"> = {
    version: "liora/1",
    chain: BASE_CHAIN,
    asset: { symbol: "USDC", address: USDC_BASE, decimals: 6 },
    payee: getAddress(input.payee),
    payer: input.payer === undefined ? undefined : getAddress(input.payer),
    amount: formatUsdc(atomic),
    atomicAmount: atomic.toString(),
    description: input.description,
    dueDate: input.dueDate,
    reference: input.reference,
  };
  return agreementSchema.parse({ ...orderedBody(body), agreementId: computeAgreementId(body) });
}

/** Rebuilds the agreement from its terms and requires a byte-for-byte canonical match. */
export function verifyAgreement(raw: unknown): Agreement {
  const given = agreementSchema.parse(raw);
  const rebuilt = buildAgreement({
    payee: given.payee,
    payer: given.payer,
    amount: given.amount,
    description: given.description,
    dueDate: given.dueDate,
    reference: given.reference,
  });
  const a = JSON.stringify({ ...orderedBody(rebuilt), agreementId: rebuilt.agreementId });
  const b = JSON.stringify({ ...orderedBody(given), agreementId: given.agreementId });
  if (a !== b) {
    throw new Error("Agreement failed its integrity check: it was modified, is not canonical, or its agreementId does not match its terms.");
  }
  return rebuilt;
}

// ---------------------------------------------------------------------------
// propose_usdc_payment: one unsigned ERC-20 transfer() call on the Base USDC
// contract. PayBox chooses the wallet, simulates, asks for approval, signs.
// ---------------------------------------------------------------------------
export function proposeAgreementPayment(raw: unknown) {
  const agreement = verifyAgreement(raw);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(agreement.payee), BigInt(agreement.atomicAmount)],
  });
  const proposal = proposeEvm({ chain: BASE_CHAIN, to: USDC_BASE, value: "0", data });
  const payerNote = agreement.payer === undefined ? "" : ` Intended payer: ${agreement.payer} (PayBox wallet selection decides the actual sender).`;
  return {
    content: [
      ...proposal.content,
      {
        type: "text" as const,
        text: `Liora agreement ${agreement.agreementId}: pay ${agreement.amount} USDC (${agreement.atomicAmount} atomic units) to ${agreement.payee} on Base.${payerNote} Confirm these details in the PayBox review window; this text is not verified by PayBox.`,
      },
    ],
    structuredContent: proposal.structuredContent,
  };
}

// ---------------------------------------------------------------------------
// verify_settlement: read-only check of a Base receipt.
// ---------------------------------------------------------------------------
export const verifySettlementInputSchema = z
  .object({
    txHash: txHashSchema,
    recipient: addressSchema,
    amount: amountSchema,
    payer: addressSchema.optional(),
    minConfirmations: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const verifySettlementOutputSchema = z
  .object({
    verdict: z.enum(["verified", "insufficient_confirmations", "mismatch", "reverted", "not_found"]),
    txHash: txHashSchema,
    chain: z.literal(BASE_CHAIN),
    token: z.literal(USDC_BASE),
    expected: z.object({ recipient: addressSchema, atomicAmount: z.string(), payer: addressSchema.optional() }).strict(),
    blockNumber: z.string().regex(/^[0-9]{1,20}$/).optional(),
    confirmations: z.number().int().min(0).optional(),
    matchedLogIndex: z.number().int().min(0).optional(),
    transfersToRecipient: z
      .array(z.object({ logIndex: z.number().int().min(0), from: addressSchema, atomicAmount: z.string() }).strict())
      .max(MAX_LISTED_TRANSFERS),
    summary: z.string(),
  })
  .strict();

export type VerifyResult = z.infer<typeof verifySettlementOutputSchema>;

export type ReceiptLog = { address: string; topics: readonly string[]; data: string; logIndex: number };
export type Receipt = {
  status: "success" | "reverted";
  transactionHash: string;
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
};
export interface ChainReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /** Resolves null only when the node says the receipt does not exist (yet). */
  getTransactionReceipt(hash: Hex): Promise<Receipt | null>;
}

export function createBaseReader(url: string = BASE_RPC_URL): ChainReader {
  const client = createPublicClient({ chain: base, transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }) });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getTransactionReceipt: async (hash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status,
          transactionHash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          logs: receipt.logs.map((log) => ({ address: log.address, topics: [...log.topics], data: log.data, logIndex: log.logIndex })),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
  };
}

type Transfer = { logIndex: number; from: string; to: string; value: bigint };

function topicToAddress(topic: string): string | null {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26)}`.toLowerCase() : null;
}

/** Only logs emitted BY the Base USDC contract count; 4-topic (ERC-721 style) Transfers are ignored. */
export function decodeUsdcTransfers(logs: readonly ReceiptLog[]): Transfer[] {
  const transfers: Transfer[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== USDC_BASE) continue;
    if (log.topics.length !== 3) continue;
    const [topic0, topic1, topic2] = log.topics;
    if (topic0 === undefined || topic1 === undefined || topic2 === undefined) continue;
    if (topic0.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicToAddress(topic1);
    const to = topicToAddress(topic2);
    if (from === null || to === null || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    transfers.push({ logIndex: log.logIndex, from, to, value: BigInt(log.data) });
  }
  return transfers;
}

function errorMessage(error: unknown): string {
  let message = "unknown error";
  if (error instanceof Error) {
    message = "shortMessage" in error && typeof error.shortMessage === "string" ? error.shortMessage : error.message;
  }
  return message.slice(0, 200);
}

async function readChain(reader: ChainReader, hash: Hex) {
  try {
    const [chainId, latest, receipt] = await Promise.all([
      reader.getChainId(),
      reader.getBlockNumber(),
      reader.getTransactionReceipt(hash),
    ]);
    return { chainId, latest, receipt };
  } catch (error) {
    throw new Error(`Base RPC request failed: ${errorMessage(error)}`);
  }
}

export async function verifySettlement(raw: unknown, reader: ChainReader): Promise<VerifyResult> {
  const input = verifySettlementInputSchema.parse(raw);
  const expectedAtomic = parseUsdc(input.amount);
  const recipient = input.recipient.toLowerCase();
  const payer = input.payer?.toLowerCase();
  const hash = input.txHash.toLowerCase() as Hex;
  const minConfirmations = input.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS;

  const { chainId, latest, receipt } = await readChain(reader, hash);
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(`RPC endpoint reported chain ${chainId}; expected Base (${BASE_CHAIN_ID}). Refusing to verify.`);
  }

  const common = {
    txHash: hash,
    chain: BASE_CHAIN,
    token: USDC_BASE,
    expected: {
      recipient: getAddress(recipient),
      atomicAmount: expectedAtomic.toString(),
      ...(payer === undefined ? {} : { payer: getAddress(payer) }),
    },
  };

  if (receipt === null) {
    return verifySettlementOutputSchema.parse({
      ...common,
      verdict: "not_found",
      transfersToRecipient: [],
      summary: "No receipt for this transaction on Base yet. It may still be pending, or the hash may be wrong. This is not proof of failure.",
    });
  }

  if (receipt.transactionHash.toLowerCase() !== hash) {
    throw new Error("RPC returned a receipt for a different transaction hash. Refusing to verify.");
  }

  const blockNumber = receipt.blockNumber.toString();
  const confirmationsBig = latest >= receipt.blockNumber ? latest - receipt.blockNumber + 1n : 0n;
  const confirmations = confirmationsBig > 1_000_000_000n ? 1_000_000_000 : Number(confirmationsBig);

  if (receipt.status !== "success") {
    return verifySettlementOutputSchema.parse({
      ...common,
      verdict: "reverted",
      blockNumber,
      confirmations,
      transfersToRecipient: [],
      summary: "The transaction was mined but reverted. No funds moved.",
    });
  }

  const transfers = decodeUsdcTransfers(receipt.logs);
  const toRecipient = transfers
    .filter((t) => t.to === recipient)
    .slice(0, MAX_LISTED_TRANSFERS)
    .map((t) => ({ logIndex: t.logIndex, from: getAddress(t.from), atomicAmount: t.value.toString() }));
  const matched = transfers.find(
    (t) => t.to === recipient && t.value === expectedAtomic && (payer === undefined || t.from === payer),
  );

  if (matched === undefined) {
    return verifySettlementOutputSchema.parse({
      ...common,
      verdict: "mismatch",
      blockNumber,
      confirmations,
      transfersToRecipient: toRecipient,
      summary:
        toRecipient.length === 0
          ? "The transaction succeeded but contains no USDC Transfer to the expected recipient."
          : "The transaction succeeded but no USDC Transfer matches the expected amount (and payer, if given). See transfersToRecipient.",
    });
  }

  if (confirmations < minConfirmations) {
    return verifySettlementOutputSchema.parse({
      ...common,
      verdict: "insufficient_confirmations",
      blockNumber,
      confirmations,
      matchedLogIndex: matched.logIndex,
      transfersToRecipient: toRecipient,
      summary: `Matching USDC Transfer found, but only ${confirmations} confirmation(s); ${minConfirmations} required. Check again later.`,
    });
  }

  return verifySettlementOutputSchema.parse({
    ...common,
    verdict: "verified",
    blockNumber,
    confirmations,
    matchedLogIndex: matched.logIndex,
    transfersToRecipient: toRecipient,
    summary: `Verified: a Base USDC Transfer of ${formatUsdc(expectedAtomic)} USDC to the expected recipient exists in a successful transaction with ${confirmations} confirmation(s), as reported by the configured RPC.`,
  });
}
