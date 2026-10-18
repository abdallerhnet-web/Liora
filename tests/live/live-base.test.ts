// LIVE check: talks to the real Base network through the real public RPC.
// It finds a recent real USDC transfer() call on Base (recipient and amount read from the
// transaction's own calldata, i.e. a source independent of the receipt logs), then proves
// verify_settlement gives the right verdict for it and the right *wrong* verdicts for near-misses.
// Run: pnpm run test:live   (needs internet; not part of the offline unit tests)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, decodeFunctionData, erc20Abi, http } from "viem";
import { base } from "viem/chains";
import {
  BASE_RPC_URL,
  MAX_ATOMIC,
  USDC_BASE,
  buildAgreement,
  createBaseReader,
  formatUsdc,
  proposeAgreementPayment,
  verifySettlement,
  type ChainReader,
} from "../../src/liora.js";

type Check = { name: string; ok: boolean; detail: string };

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 400);
  const e = error as Error & { shortMessage?: string; details?: string };
  const text = [e.shortMessage ?? e.message, e.details].filter(Boolean).join(" | ");
  return text.replace(/Request body:.*$/s, "").slice(0, 400);
}

async function retry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${message(last)}`);
}

// The production reader never retries (10s budget). The test retries only so a shared
// CI runner hitting a public-RPC rate limit does not produce a false failure.
function retrying(reader: ChainReader): ChainReader {
  return {
    getChainId: () => retry("chainId", () => reader.getChainId()),
    getBlockNumber: () => retry("blockNumber", () => reader.getBlockNumber()),
    getTransactionReceipt: (hash) => retry("receipt", () => reader.getTransactionReceipt(hash)),
  };
}

test("live Base: verify_settlement and proposal against a real USDC transfer", { timeout: 240_000 }, async () => {
  const checks: Check[] = [];
  const failures: string[] = [];
  let tx: { hash: string; block: string; from: string; to: string; value: string } | undefined;

  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = (await fn()) ?? "";
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: message(error) });
      failures.push(`${name}: ${message(error)}`);
    }
  };

  try {
    const client = createPublicClient({ chain: base, transport: http(BASE_RPC_URL, { timeout: 8_000, retryCount: 0 }) });
    const latest = await retry("latest block", () => client.getBlockNumber());
    checks.push({ name: "RPC reachable, latest block read", ok: true, detail: `block ${latest}` });

    // Scan recent blocks for a successful direct USDC transfer(to, value) call.
    let found: { hash: `0x${string}`; block: bigint; from: string; to: string; value: bigint } | undefined;
    for (let n = latest - 12n; n > latest - 60n && found === undefined; n -= 1n) {
      const block = await retry(`getBlock ${n}`, () => client.getBlock({ blockNumber: n, includeTransactions: true }));
      for (const t of block.transactions) {
        if (t.to?.toLowerCase() !== USDC_BASE || !t.input.startsWith("0xa9059cbb")) continue;
        let args: readonly [string, bigint];
        try {
          const decoded = decodeFunctionData({ abi: erc20Abi, data: t.input });
          if (decoded.functionName !== "transfer") continue;
          args = [decoded.args[0] as string, decoded.args[1] as bigint];
        } catch {
          continue;
        }
        const [to, value] = args;
        if (value < 1000n || value + 1n > MAX_ATOMIC || to.toLowerCase() === t.from.toLowerCase()) continue;
        const receipt = await retry("receipt", () => client.getTransactionReceipt({ hash: t.hash }));
        if (receipt.status !== "success") continue;
        found = { hash: t.hash, block: n, from: t.from, to, value };
        break;
      }
    }
    assert.ok(found, "no successful direct USDC transfer() found in the last ~60 Base blocks");
    const { hash, from, to, value } = found;
    tx = { hash, block: String(found.block), from, to, value: value.toString() };
    checks.push({ name: "found a real recent USDC transfer() call", ok: true, detail: `${hash} block ${tx.block} value ${tx.value} atomic` });

    const reader = retrying(createBaseReader());
    const exact = { txHash: hash, recipient: to, amount: formatUsdc(value) };

    await check("verified: exact recipient and amount", async () => {
      const r = await verifySettlement(exact, reader);
      assert.equal(r.verdict, "verified", r.summary);
      assert.ok(
        r.transfersToRecipient.some((t) => t.atomicAmount === value.toString()),
        "real transfer not listed in transfersToRecipient",
      );
      return `confirmations=${r.confirmations} matchedLogIndex=${r.matchedLogIndex}`;
    });

    await check("verified: with the real payer", async () => {
      const r = await verifySettlement({ ...exact, payer: from }, reader);
      assert.equal(r.verdict, "verified", r.summary);
    });

    await check("mismatch: amount off by one atomic unit", async () => {
      const r = await verifySettlement({ ...exact, amount: formatUsdc(value + 1n) }, reader);
      assert.equal(r.verdict, "mismatch", `expected mismatch, got ${r.verdict}`);
    });

    await check("mismatch: wrong payer", async () => {
      const r = await verifySettlement({ ...exact, payer: "0x1111111111111111111111111111111111111111" }, reader);
      assert.equal(r.verdict, "mismatch", `expected mismatch, got ${r.verdict}`);
    });

    await check("mismatch: wrong recipient", async () => {
      const r = await verifySettlement({ ...exact, recipient: "0x1111111111111111111111111111111111111111" }, reader);
      assert.equal(r.verdict, "mismatch", `expected mismatch, got ${r.verdict}`);
    });

    await check("insufficient_confirmations at minConfirmations=1000", async () => {
      const r = await verifySettlement({ ...exact, minConfirmations: 1000 }, reader);
      assert.equal(r.verdict, "insufficient_confirmations", `expected insufficient_confirmations, got ${r.verdict}`);
      return `confirmations=${r.confirmations}`;
    });

    await check("not_found: unknown transaction hash", async () => {
      const r = await verifySettlement({ ...exact, txHash: `0x${"ab".repeat(32)}` }, reader);
      assert.equal(r.verdict, "not_found", `expected not_found, got ${r.verdict}`);
    });

    await check("proposal calldata decodes with real viem; tampering rejected", async () => {
      const agreement = buildAgreement({ payee: to, amount: formatUsdc(value), description: "live check" });
      const out = proposeAgreementPayment(agreement);
      const proposal = out.structuredContent["io.paybox/transactionProposal"];
      const decoded = decodeFunctionData({ abi: erc20Abi, data: proposal.transaction.data as `0x${string}` });
      assert.equal(proposal.transaction.to, USDC_BASE);
      assert.equal(proposal.chain, "eip155:8453");
      assert.equal(decoded.functionName, "transfer");
      assert.equal(String(decoded.args?.[0]).toLowerCase(), to.toLowerCase());
      assert.equal(decoded.args?.[1], value);
      assert.throws(() => proposeAgreementPayment({ ...agreement, atomicAmount: (value + 1n).toString() }), /integrity/);
    });
  } catch (error) {
    checks.push({ name: "setup", ok: false, detail: message(error) });
    failures.push(`setup: ${message(error)}`);
  } finally {
    const path = process.env.LIVE_REPORT_PATH;
    if (path) writeFileSync(path, JSON.stringify({ tx, checks }, null, 2));
  }

  assert.deepEqual(failures, []);
});
