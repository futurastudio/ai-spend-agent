#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getSpendReportTool,
  listSourcesTool,
  recommendCutsTool,
  scanAiSpendTool
} from "./index.js";

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "ai-spend-analyst",
    version: "0.0.0"
  });

  server.registerTool(
    "scan_ai_spend",
    {
      title: "Scan AI spend",
      description:
        "Scan an approved local folder for AI provider usage signals and persist a local registry, audit log, and discovery report (local-first, no cloud upload). Pass sample=true to also load bundled sample usage data into a spend report.",
      inputSchema: {
        path: z.string().describe("Absolute path to the local folder to scan."),
        sample: z
          .boolean()
          .optional()
          .describe("When true, load bundled sample usage data into a spend report.")
      }
    },
    async ({ path, sample }) => jsonContent(await scanAiSpendTool({ path, sample }))
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "List the approved AI spend sources recorded by a previous scan_ai_spend run for the given folder.",
      inputSchema: {
        path: z.string().describe("Absolute path previously scanned with scan_ai_spend.")
      }
    },
    async ({ path }) => jsonContent(await listSourcesTool({ path }))
  );

  server.registerTool(
    "get_spend_report",
    {
      title: "Get spend report",
      description:
        "Return the persisted spend report (records and summary) for a folder previously scanned with scan_ai_spend (requires a sample or imported run).",
      inputSchema: {
        path: z.string().describe("Absolute path previously scanned with scan_ai_spend.")
      }
    },
    async ({ path }) => jsonContent(await getSpendReportTool({ path }))
  );

  server.registerTool(
    "recommend_cuts",
    {
      title: "Recommend cuts",
      description:
        "Return scanner-backed cost-cut recommendations derived from the discovery signals of a previously scanned folder.",
      inputSchema: {
        path: z.string().describe("Absolute path previously scanned with scan_ai_spend.")
      }
    },
    async ({ path }) => jsonContent(await recommendCutsTool({ path }))
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("ai-spend-mcp server failed to start:", error);
  process.exit(1);
});
