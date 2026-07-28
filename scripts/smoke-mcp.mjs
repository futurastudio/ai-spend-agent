#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
