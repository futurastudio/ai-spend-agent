#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = async (path) => JSON.parse(
  await readFile(resolve(root, path), "utf8")
);
const mcpPackage = await readJson("packages/mcp/package.json");
const plugin = await readJson("plugins/aibill/.codex-plugin/plugin.json");
const mcpConfig = await readJson("plugins/aibill/.mcp.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const skillRoot = resolve(root, "plugins/aibill/skills");
const skillNames = (await readdir(skillRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert(plugin.version === mcpPackage.version,
  `plugin version ${plugin.version} != MCP version ${mcpPackage.version}`);
assert(!("hooks" in plugin), "aibill plugin must remain on-demand and hook-free");
assert(plugin.mcpServers === "./.mcp.json", "plugin must reference the canonical MCP config");

const server = mcpConfig.mcpServers?.aibill;
assert(server?.command === "npx", "aibill MCP adapter must launch through npx");
assert(
  server.args?.includes(`@agent-finops/mcp@${mcpPackage.version}`),
  "aibill MCP adapter must pin the workspace MCP version"
);
assert(server.args?.includes("ai-spend-mcp"), "aibill MCP bin is missing");

assert(
  JSON.stringify(skillNames) === JSON.stringify([
    "aibill-check",
    "aibill-explain",
    "aibill-help"
  ]),
  `unexpected plugin skill set: ${JSON.stringify(skillNames)}`
);
for (const skillName of skillNames) {
  const skill = await readFile(resolve(skillRoot, skillName, "SKILL.md"), "utf8");
  const metadata = await readFile(
    resolve(skillRoot, skillName, "agents/openai.yaml"),
    "utf8"
  );
  assert(!skill.includes("TODO"), `${skillName} contains a TODO placeholder`);
  assert(
    metadata.includes("allow_implicit_invocation: false"),
    `${skillName} must remain explicit-only`
  );
  assert(
    metadata.includes(`$${skillName}`),
    `${skillName} default prompt must name the skill`
  );
}

const marketplaceEntry = marketplace.plugins?.find((entry) => entry.name === "aibill");
assert(marketplaceEntry, "repo marketplace is missing aibill");
assert(
  marketplaceEntry.source?.path === "./plugins/aibill",
  "repo marketplace must point at ./plugins/aibill"
);
assert(
  marketplaceEntry.policy?.installation === "AVAILABLE",
  "aibill plugin must be optional"
);

console.log(JSON.stringify({
  status: "pass",
  plugin: plugin.name,
  version: plugin.version,
  hookFree: true,
  explicitOnlySkills: skillNames,
  mcpPackage: `@agent-finops/mcp@${mcpPackage.version}`
}));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
