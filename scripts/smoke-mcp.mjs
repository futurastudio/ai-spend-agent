#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Telemetry kill-switch (0.9.4): this script spawns the REAL built/packed
// CLI. Without these, every local run emitted production telemetry from the
// developer's machine (phantom unpublished-version installs in the live
// counts). Set at script level so no human ever has to remember it; every
// child env below either inherits process.env or spreads it.
process.env.AI_SPEND_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";


const projectRoot = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(
  await readFile(resolve(projectRoot, "packages/mcp/package.json"), "utf8")
);
const serverPath = resolve(
  projectRoot,
  process.argv[2] ?? "packages/mcp/dist/server.js"
);
const expectedTools = [
  "scan_ai_spend",
  "sync_local_agent_spend",
  "sync_provider_spend",
  "get_usage_glance",
  "get_context_health",
  "get_token_reduction_test",
  "draft_improve_command",
  "list_sources",
  "get_spend_report",
  "recommend_cuts"
];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: projectRoot,
  stderr: "pipe"
});
const client = new Client({ name: "aibill-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const actualTools = tools.tools.map((tool) => tool.name);
  const serverVersion = client.getServerVersion();
  if (serverVersion?.name !== "aibill" || serverVersion.version !== packageMetadata.version) {
    throw new Error(`Unexpected MCP identity: ${JSON.stringify(serverVersion)}`);
  }
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected MCP tools: ${JSON.stringify(actualTools)}`);
  }
  const unsafeResult = await client.callTool({
    name: "scan_ai_spend",
    arguments: { path: homedir() }
  });
  if (!unsafeResult.isError) {
    throw new Error("MCP unsafe-root guard did not return a tool error.");
  }
  console.log(JSON.stringify({ serverVersion, tools: actualTools, unsafeRootGuard: "pass" }));
} finally {
  await client.close().catch(() => undefined);
}
