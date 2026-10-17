import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { evmOutputSchema } from "./paybox.js";
import {
  buildAgreement,
  createAgreementInputSchema,
  createAgreementOutputSchema,
  createBaseReader,
  proposeAgreementPayment,
  proposePaymentInputSchema,
  verifySettlement,
  verifySettlementInputSchema,
  verifySettlementOutputSchema,
} from "./liora.js";

const PROTOCOL_VERSION = "2026-07-28";

function createServer() {
  const server = new McpServer(
    { name: "liora", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "create_agreement",
    {
      title: "Create payment agreement",
      description:
        "Creates a tamper-evident USDC payment agreement on Base. Stateless: nothing is stored; the agreementId is derived from the terms. Amounts are decimal strings (max 6 decimals), never numbers.",
      inputSchema: createAgreementInputSchema,
      outputSchema: createAgreementOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const agreement = buildAgreement(args);
      return {
        content: [
          {
            type: "text",
            text: `Agreement ${agreement.agreementId}: ${agreement.amount} USDC to ${agreement.payee} on Base.`,
          },
        ],
        structuredContent: { agreement },
      };
    },
  );

  server.registerTool(
    "propose_usdc_payment",
    {
      title: "Propose USDC payment",
      description:
        "Takes an agreement from create_agreement, re-verifies its integrity, and returns an unsigned Base USDC transfer proposal for PayBox to simulate, approve and sign. Nothing is sent by this tool.",
      inputSchema: proposePaymentInputSchema,
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => proposeAgreementPayment(args.agreement),
  );

  server.registerTool(
    "verify_settlement",
    {
      title: "Verify USDC settlement",
      description:
        "Reads the Base receipt for txHash and checks for a Transfer log emitted by the USDC contract matching the recipient, exact amount (and optional payer). Read-only. 'verified' reflects what the configured Base RPC reports.",
      inputSchema: verifySettlementInputSchema,
      outputSchema: verifySettlementOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await verifySettlement(args, createBaseReader());
      return { content: [{ type: "text", text: result.summary }], structuredContent: result };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
