// LIVE check: talks to the real Base network through the real public RPC.
// It finds a recent real USDC Transfer on Base, then proves verify_settlement
// gives the right verdict for it (and the right *wrong* verdicts for near-misses).
// Run: pnpm run test:live   (needs internet; skipped from the offline unit tests)
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, decodeFunctionData, erc20Abi, http, parseAbiItem } from "viem";
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
  throw new Error(`${label} failed after ${tries} tries: ${last instanceof Error ? last.message : String(last)}`);
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

test("live Base: verify_settlement and proposal against a real USDC transfer", { timeout: 240_000 }, async () => {
  const checks: Check[] = [];
  const failures: string[] = [];
  let tx: { hash: string; block: string; from: string; to: string; value: string; logIndex: number } | undefined;

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
    const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

    let picked;
    for (const window of [20n, 200n]) {
      const logs = await retry("getLogs", () =>
        client.getLogs({ address: USDC_BASE, event: transferEvent, fromBlock: latest - window - 12n, toBlock: latest - 12n }),
      );
      picked = logs.find(
        (l) =>
          l.args.from !== undefined &&
          l.args.to !== undefined &&
          l.args.value !== undefined &&
          l.args.value >= 1000n &&
          l.args.value + 1n <= MAX_ATOMIC &&
          l.args.from.toLowerCase() !== l.args.to.toLowerCase() &&
          l.transactionHash !== null &&
          l.logIndex !== null &&
          l.blockNumber !== null,
      );
      if (picked) break;
    }
    assert.ok(picked, "no usable recent USDC Transfer found on Base");
    const from = picked.args.from as string;
    const to = picked.args.to as string;
    const value = picked.args.value as bigint;
    const hash = picked.transactionHash as `0x${string}`;
    const logIndex = picked.logIndex as number;
    tx = { hash, block: String(picked.blockNumber), from, to, value: value.toString(), logIndex };
    checks.push({ name: "found a real recent USDC transfer", ok: true, detail: `${hash} block ${tx.block} value ${tx.value} atomic` });

    const reader = retrying(createBaseReader());
    const exact = { txHash: hash, recipient: to, amount: formatUsdc(value) };

    await check("verified: exact recipient and amount", async () => {
      const r = await verifySettlement(exact, reader);
      assert.equal(r.verdict, "verified", r.summary);
      assert.ok(
        r.transfersToRecipient.some((t) => t.logIndex === logIndex && t.atomicAmount === value.toString()),
        "real transfer log not listed",
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
