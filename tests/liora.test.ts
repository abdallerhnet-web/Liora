import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress, pad, toEventSelector } from "viem";
import { evmOutputSchema } from "../src/paybox.js";
import {
  BASE_CHAIN,
  BASE_CHAIN_ID,
  TRANSFER_TOPIC,
  USDC_BASE,
  buildAgreement,
  createAgreementInputSchema,
  createBaseReader,
  decodeUsdcTransfers,
  formatUsdc,
  parseUsdc,
  proposeAgreementPayment,
  verifyAgreement,
  verifySettlement,
  verifySettlementOutputSchema,
  type ChainReader,
  type Receipt,
  type ReceiptLog,
} from "../src/liora.js";

const HASH = `0x${"ab".repeat(32)}` as const;
const PAYEE = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const INPUT = { payee: PAYEE, amount: "1.25", description: "Design work", reference: "INV-7" };

function addrTopic(address: string): string {
  return pad(address as `0x${string}`, { size: 32 }).toLowerCase();
}
function valueData(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function log(over: Partial<ReceiptLog> & { from?: string; to?: string; value?: bigint } = {}): ReceiptLog {
  return {
    address: over.address ?? USDC_BASE,
    topics: over.topics ?? [TRANSFER_TOPIC, addrTopic(over.from ?? PAYER), addrTopic(over.to ?? PAYEE)],
    data: over.data ?? valueData(over.value ?? 1_250_000n),
    logIndex: over.logIndex ?? 0,
  };
}
function receipt(over: Partial<Receipt> = {}): Receipt {
  return { status: "success", transactionHash: HASH, blockNumber: 100n, logs: [log()], ...over };
}
function reader(over: { chainId?: number; latest?: bigint; receipt?: Receipt | null } = {}): ChainReader {
  return {
    getChainId: async () => over.chainId ?? BASE_CHAIN_ID,
    getBlockNumber: async () => over.latest ?? 110n,
    getTransactionReceipt: async () => (over.receipt === undefined ? receipt() : over.receipt),
  };
}
const VERIFY = { txHash: HASH, recipient: PAYEE, amount: "1.25" };

// ---------------------------------------------------------------- money
test("parseUsdc converts decimal strings exactly", () => {
  assert.equal(parseUsdc("1.25"), 1_250_000n);
  assert.equal(parseUsdc("0.000001"), 1n);
  assert.equal(parseUsdc("1000000000"), 10n ** 15n);
  assert.equal(parseUsdc("0.1") + parseUsdc("0.2"), parseUsdc("0.3")); // the float trap
});

test("parseUsdc rejects zero, too many decimals, malformed, negative, exponent, oversize", () => {
  for (const bad of ["0", "0.0", "0.0000001", "1.2345678", "-1", "+1", "1e6", ".5", "1.", "1,5", " 1", "01", "NaN", "", "1000000000.000001"]) {
    assert.throws(() => parseUsdc(bad), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

test("formatUsdc round-trips and trims trailing zeros", () => {
  assert.equal(formatUsdc(1_250_000n), "1.25");
  assert.equal(formatUsdc(1_000_000n), "1");
  assert.equal(formatUsdc(1n), "0.000001");
  assert.equal(formatUsdc(10_000_000n), "10");
  for (const amount of ["0.000001", "1", "1.5", "123456.789012"]) assert.equal(formatUsdc(parseUsdc(amount)), amount);
});

// ---------------------------------------------------------------- schemas
test("createAgreement input rejects numbers, extra keys, bad checksums, bad dates, control chars", () => {
  const ok = (value: unknown) => createAgreementInputSchema.safeParse(value).success;
  assert.equal(ok(INPUT), true);
  assert.equal(ok({ ...INPUT, amount: 1.25 }), false, "number amount");
  assert.equal(ok({ ...INPUT, amount: 2 }), false, "integer number amount");
  assert.equal(ok({ ...INPUT, extra: "x" }), false, "unknown key");
  assert.equal(ok({ ...INPUT, payee: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), true, "valid EIP-55");
  assert.equal(ok({ ...INPUT, payee: "0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913" }), false, "bad EIP-55 checksum");
  assert.equal(ok({ ...INPUT, payee: "0x1234" }), false, "short address");
  assert.equal(ok({ ...INPUT, dueDate: "2026-02-30" }), false, "impossible date");
  assert.equal(ok({ ...INPUT, dueDate: "2026-12-31" }), true);
  assert.equal(ok({ ...INPUT, description: "bad\nline" }), false, "control char");
  assert.equal(ok({ ...INPUT, description: " padded" }), false, "leading whitespace");
  assert.equal(ok({ ...INPUT, description: "" }), false, "empty description");
  assert.equal(ok({ ...INPUT, reference: "has space" }), false, "bad reference");
  assert.equal(ok({ amount: "1", description: "x" }), false, "missing payee");
});

// ---------------------------------------------------------------- agreements
test("buildAgreement is deterministic, canonical and normalizes the amount", () => {
  const a = buildAgreement(INPUT);
  const b = buildAgreement({ ...INPUT, amount: "1.250" });
  assert.equal(a.amount, "1.25");
  assert.equal(a.atomicAmount, "1250000");
  assert.equal(a.chain, BASE_CHAIN);
  assert.equal(a.asset.address, USDC_BASE);
  assert.match(a.agreementId, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(a, b, "equivalent input gives the identical agreement");
  assert.equal(a.payee, getAddress(PAYEE), "payee is checksummed");
});

test("every term changes the agreementId", () => {
  const base = buildAgreement(INPUT).agreementId;
  const variants = [
    { ...INPUT, amount: "1.26" },
    { ...INPUT, payee: OTHER },
    { ...INPUT, description: "Other work" },
    { ...INPUT, reference: "INV-8" },
    { ...INPUT, payer: PAYER },
    { ...INPUT, dueDate: "2026-12-31" },
  ];
  const ids = new Set([base, ...variants.map((v) => buildAgreement(v).agreementId)]);
  assert.equal(ids.size, variants.length + 1);
});

test("verifyAgreement accepts a fresh agreement and rejects tampering", () => {
  const a = buildAgreement({ ...INPUT, payer: PAYER });
  assert.deepEqual(verifyAgreement(a), a);
  assert.throws(() => verifyAgreement({ ...a, atomicAmount: "9999999" }), /integrity/);
  assert.throws(() => verifyAgreement({ ...a, amount: "9.99" }), /integrity/);
  assert.throws(() => verifyAgreement({ ...a, payee: getAddress(OTHER) }), /integrity/);
  assert.throws(() => verifyAgreement({ ...a, description: "Changed" }), /integrity/);
  assert.throws(() => verifyAgreement({ ...a, agreementId: `0x${"00".repeat(32)}` }), /integrity/);
  assert.throws(() => verifyAgreement({ ...a, amount: "1.250" }), /integrity|Use/, "non-canonical amount");
  assert.throws(() => verifyAgreement({ ...a, extra: true }), undefined, "unknown key");
  const { agreementId: _omit, ...withoutId } = a;
  assert.throws(() => verifyAgreement(withoutId), undefined, "missing id");
});

// ---------------------------------------------------------------- proposal
test("proposal is one unsigned Base USDC transfer() call with exact calldata", () => {
  const agreement = buildAgreement({ ...INPUT, amount: "1.25" });
  const out = proposeAgreementPayment(agreement);
  const proposal = out.structuredContent["io.paybox/transactionProposal"];

  assert.equal(proposal.kind, "evm");
  assert.equal(proposal.chain, "eip155:8453");
  assert.equal(proposal.transaction.to, USDC_BASE);
  assert.equal(proposal.transaction.value, "0", "no native value");
  assert.ok(proposal.transaction.data.startsWith("0xa9059cbb"), "transfer(address,uint256) selector");

  const decoded = decodeFunctionData({ abi: erc20Abi, data: proposal.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, "transfer");
  assert.equal(String(decoded.args?.[0]).toLowerCase(), PAYEE);
  assert.equal(decoded.args?.[1], 1_250_000n);

  const ttl = Date.parse(proposal.expiresAt) - Date.now();
  assert.ok(ttl > 0 && ttl <= 300_000, "expiry within five minutes");
  assert.match(proposal.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.doesNotThrow(() => evmOutputSchema.parse(out.structuredContent), "matches PayBox proposal schema");
  assert.ok(out.content.some((c) => c.text.includes(agreement.agreementId)));
});

test("proposal refuses a tampered agreement", () => {
  const a = buildAgreement(INPUT);
  assert.throws(() => proposeAgreementPayment({ ...a, atomicAmount: "100000000" }), /integrity/);
  assert.throws(() => proposeAgreementPayment({ ...a, payee: getAddress(OTHER) }), /integrity/);
  assert.throws(() => proposeAgreementPayment({ nope: true }));
});

// ---------------------------------------------------------------- settlement logic
test("TRANSFER_TOPIC is the ERC-20 Transfer selector", () => {
  assert.equal(TRANSFER_TOPIC, toEventSelector("Transfer(address,address,uint256)"));
});

test("verified: matching USDC Transfer, success, enough confirmations", async () => {
  const r = await verifySettlement(VERIFY, reader());
  assert.equal(r.verdict, "verified");
  assert.equal(r.matchedLogIndex, 0);
  assert.equal(r.confirmations, 11);
  assert.equal(r.blockNumber, "100");
  assert.doesNotThrow(() => verifySettlementOutputSchema.parse(r));
});

test("mismatch: wrong recipient, off-by-one amount (either way), wrong payer", async () => {
  assert.equal((await verifySettlement({ ...VERIFY, recipient: OTHER }, reader())).verdict, "mismatch");
  assert.equal((await verifySettlement({ ...VERIFY, amount: "1.250001" }, reader())).verdict, "mismatch");
  assert.equal((await verifySettlement({ ...VERIFY, amount: "1.249999" }, reader())).verdict, "mismatch");
  assert.equal((await verifySettlement({ ...VERIFY, payer: OTHER }, reader())).verdict, "mismatch");
  assert.equal((await verifySettlement({ ...VERIFY, payer: PAYER }, reader())).verdict, "verified");
  const wrongAmount = await verifySettlement({ ...VERIFY, amount: "2" }, reader());
  assert.equal(wrongAmount.transfersToRecipient[0]?.atomicAmount, "1250000", "reports what actually moved");
});

test("a Transfer from a different token contract never counts", async () => {
  const fake = receipt({ logs: [log({ address: OTHER })] });
  assert.equal((await verifySettlement(VERIFY, reader({ receipt: fake }))).verdict, "mismatch");
});

test("4-topic (ERC-721 style) and malformed logs are ignored", () => {
  const nft = log({ topics: [TRANSFER_TOPIC, addrTopic(PAYER), addrTopic(PAYEE), pad("0x01", { size: 32 })] });
  const shortData = log({ data: "0x1234" });
  const dirtyTopic = log({ topics: [TRANSFER_TOPIC, `0x${"11".repeat(32)}`, addrTopic(PAYEE)] });
  const wrongEvent = log({ topics: [`0x${"22".repeat(32)}`, addrTopic(PAYER), addrTopic(PAYEE)] });
  assert.equal(decodeUsdcTransfers([nft, shortData, dirtyTopic, wrongEvent]).length, 0);
  assert.equal(decodeUsdcTransfers([log()]).length, 1);
});

test("verified picks the matching log among several transfers", async () => {
  const multi = receipt({
    logs: [log({ logIndex: 0, to: OTHER, value: 5n }), log({ logIndex: 1, value: 3n }), log({ logIndex: 2 })],
  });
  const r = await verifySettlement(VERIFY, reader({ receipt: multi }));
  assert.equal(r.verdict, "verified");
  assert.equal(r.matchedLogIndex, 2);
  assert.equal(r.transfersToRecipient.length, 2);
});

test("reverted and not_found are distinct, honest verdicts", async () => {
  const reverted = await verifySettlement(VERIFY, reader({ receipt: receipt({ status: "reverted" }) }));
  assert.equal(reverted.verdict, "reverted");
  const missing = await verifySettlement(VERIFY, reader({ receipt: null }));
  assert.equal(missing.verdict, "not_found");
  assert.match(missing.summary, /not proof of failure/);
});

test("insufficient_confirmations honours minConfirmations", async () => {
  const early = await verifySettlement({ ...VERIFY, minConfirmations: 20 }, reader({ latest: 110n }));
  assert.equal(early.verdict, "insufficient_confirmations");
  assert.equal(early.confirmations, 11);
  const ok = await verifySettlement({ ...VERIFY, minConfirmations: 11 }, reader({ latest: 110n }));
  assert.equal(ok.verdict, "verified");
  const lagging = await verifySettlement({ ...VERIFY, minConfirmations: 1 }, reader({ latest: 99n }));
  assert.equal(lagging.confirmations, 0);
  assert.equal(lagging.verdict, "insufficient_confirmations");
});

test("refuses to answer on wrong chain or mismatched tx hash (throws, never a verdict)", async () => {
  await assert.rejects(verifySettlement(VERIFY, reader({ chainId: 1 })), /expected Base/);
  const other = receipt({ transactionHash: `0x${"cd".repeat(32)}` });
  await assert.rejects(verifySettlement(VERIFY, reader({ receipt: other })), /different transaction hash/);
});

test("RPC failure surfaces as an error, not as a verdict", async () => {
  const broken: ChainReader = {
    getChainId: async () => BASE_CHAIN_ID,
    getBlockNumber: async () => {
      throw new Error("boom");
    },
    getTransactionReceipt: async () => null,
  };
  await assert.rejects(verifySettlement(VERIFY, broken), /Base RPC request failed: boom/);
});

test("verify input is strict", async () => {
  await assert.rejects(verifySettlement({ ...VERIFY, amount: 1.25 }, reader()));
  await assert.rejects(verifySettlement({ ...VERIFY, txHash: "0x1234" }, reader()));
  await assert.rejects(verifySettlement({ ...VERIFY, extra: 1 }, reader()));
  await assert.rejects(verifySettlement({ ...VERIFY, minConfirmations: 1.5 }, reader()));
  await assert.rejects(verifySettlement({ ...VERIFY, minConfirmations: 0 }, reader()));
});

// ---------------------------------------------------------------- real viem transport against a local JSON-RPC server
function fakeRpc(handlers: Record<string, unknown>) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string };
      const result = call.method in handlers ? handlers[call.method] : null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

function wireReceipt(over: { status?: string; logs?: unknown[] } = {}) {
  const blockHash = `0x${"ee".repeat(32)}`;
  return {
    blockHash,
    blockNumber: "0x64",
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    from: PAYER,
    gasUsed: "0x5208",
    logs: over.logs ?? [
      {
        address: USDC_BASE,
        blockHash,
        blockNumber: "0x64",
        data: valueData(1_250_000n),
        logIndex: "0x0",
        removed: false,
        topics: [TRANSFER_TOPIC, addrTopic(PAYER), addrTopic(PAYEE)],
        transactionHash: HASH,
        transactionIndex: "0x0",
      },
    ],
    logsBloom: `0x${"00".repeat(256)}`,
    status: over.status ?? "0x1",
    to: USDC_BASE,
    transactionHash: HASH,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

test("end-to-end over real viem http transport: verified", async () => {
  const rpc = await fakeRpc({ eth_chainId: "0x2105", eth_blockNumber: "0x6e", eth_getTransactionReceipt: wireReceipt() });
  try {
    const r = await verifySettlement(VERIFY, createBaseReader(rpc.url));
    assert.equal(r.verdict, "verified");
    assert.equal(r.confirmations, 11);
    assert.equal(r.matchedLogIndex, 0);
  } finally {
    await rpc.close();
  }
});

test("end-to-end over real viem http transport: unknown tx is not_found, reverted is reverted, wrong chain throws", async () => {
  const none = await fakeRpc({ eth_chainId: "0x2105", eth_blockNumber: "0x6e" });
  try {
    assert.equal((await verifySettlement(VERIFY, createBaseReader(none.url))).verdict, "not_found");
  } finally {
    await none.close();
  }
  const reverted = await fakeRpc({ eth_chainId: "0x2105", eth_blockNumber: "0x6e", eth_getTransactionReceipt: wireReceipt({ status: "0x0" }) });
  try {
    assert.equal((await verifySettlement(VERIFY, createBaseReader(reverted.url))).verdict, "reverted");
  } finally {
    await reverted.close();
  }
  const mainnet = await fakeRpc({ eth_chainId: "0x1", eth_blockNumber: "0x6e", eth_getTransactionReceipt: wireReceipt() });
  try {
    await assert.rejects(verifySettlement(VERIFY, createBaseReader(mainnet.url)), /expected Base/);
  } finally {
    await mainnet.close();
  }
});

// ---------------------------------------------------------------- hygiene
test("source has no float math, env access, or key material", () => {
  for (const file of ["src/liora.ts", "src/plugin.ts"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /parseFloat|toFixed|Math\.|process\.env|privateKey|mnemonic|apiKey/i, file);
  }
});

test("paybox-plugin.json sample is valid for its tool", () => {
  const sample = JSON.parse(readFileSync(new URL("../paybox-plugin.json", import.meta.url), "utf8")) as {
    tool: string;
    arguments: unknown;
  };
  assert.equal(sample.tool, "create_agreement");
  assert.equal(createAgreementInputSchema.safeParse(sample.arguments).success, true);
  assert.doesNotThrow(() => buildAgreement(sample.arguments));
});
