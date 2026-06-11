# AI Spend Analyst — MCP Server

See your AI spend in one view, locally. This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) stdio server that lets an MCP client such as **Cursor** or **Claude Desktop** scan a local folder for AI provider usage signals (OpenAI, Anthropic, and more), build a spend report, and suggest where to cut. Everything runs on your machine: folders are scanned read-only, secrets are redacted before anything is returned, and nothing is uploaded to the cloud.

- Package: `@agent-finops/mcp`
- Binary: `ai-spend-mcp`
- Built entrypoint: `packages/mcp/dist/server.js`
- Transport: stdio (JSON-RPC)
- Tools: `scan_ai_spend`, `list_sources`, `get_spend_report`, `recommend_cuts`

---

## Quick start

```bash
# From the repo root
npm install
npm run build        # produces packages/mcp/dist/server.js (with a #!/usr/bin/env node shebang)
```

Then point your MCP client at the built server (see [Use it in Cursor / Claude Desktop](#use-it-in-cursor--claude-desktop)).

To run the binary by name instead of an absolute path, link or install it globally:

```bash
# Option A: link from the workspace (development)
cd packages/mcp && npm link
# Option B: install globally (after publish)
npm install -g @agent-finops/mcp
```

After linking, `ai-spend-mcp` is on your PATH and starts the stdio server.

---

## Use it in Cursor / Claude Desktop

Add one of the configs below. Use the **`node /abs/path` form** for a local checkout, or the **`ai-spend-mcp` bin form** after `npm link` / global install.

### Cursor

Open **Settings → MCP → Add new MCP server** (or edit `~/.cursor/mcp.json`).

`node /abs/path` form:

```json
{
  "mcpServers": {
    "ai-spend-analyst": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/agent-finops/packages/mcp/dist/server.js"]
    }
  }
}
```

`ai-spend-mcp` bin form (after `npm link` / global install):

```json
{
  "mcpServers": {
    "ai-spend-analyst": {
      "command": "ai-spend-mcp"
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

`node /abs/path` form:

```json
{
  "mcpServers": {
    "ai-spend-analyst": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/agent-finops/packages/mcp/dist/server.js"]
    }
  }
}
```

`ai-spend-mcp` bin form (after `npm link` / global install):

```json
{
  "mcpServers": {
    "ai-spend-analyst": {
      "command": "ai-spend-mcp"
    }
  }
}
```

> Replace `/ABSOLUTE/PATH/TO/agent-finops` with the real path to your checkout. Restart Cursor / Claude Desktop after editing the config, then look for `ai-spend-analyst` and its four tools in the MCP tool list.

---

## Tools

All tools take an absolute `path` to the folder you want to analyze. State for that folder is written to `<path>/.ai-spend-agent/` (a read-only registry, an audit log, the discovery result, and — when sampled — a spend report).

> **Run `scan_ai_spend` first.** The other three tools read state produced by a scan, so calling them before scanning returns an error result (`isError: true`) rather than crashing the server.

### `scan_ai_spend`

Scan a local folder for AI provider usage signals. Registers the folder as a read-only source, writes an audit log, and redacts secrets before output. Pass `sample: true` to also load the bundled demo usage data so `get_spend_report` has a report to return. Nothing is uploaded.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Absolute path to a local folder to analyze. |
| `sample` | boolean | no | When `true`, load bundled sample usage data and compute a demo spend report. |

Example call (arguments):

```json
{ "path": "/Users/you/projects/my-agency", "sample": true }
```

Returns a JSON text block with `{ registry, auditLog, discovery }`.

### `list_sources`

List the approved local sources discovered by a previous `scan_ai_spend` run for the given folder. Returns the source registry.

```json
{ "path": "/Users/you/projects/my-agency" }
```

### `get_spend_report`

Return the AI spend report (usage records plus an analyzed summary — totals, breakdowns by source/model/client/agent, anomalies, recommendations, and insights) produced by a `scan_ai_spend` run with `sample: true`.

```json
{ "path": "/Users/you/projects/my-agency" }
```

### `recommend_cuts`

Return scanner-backed recommendations for reducing AI spend, derived from the providers discovered during a `scan_ai_spend` run for the given folder.

```json
{ "path": "/Users/you/projects/my-agency" }
```

---

## Talk to it in plain language

Once the server is connected, you can just ask your assistant:

> "Scan `/Users/you/projects/my-agency` for AI spend with the sample data, then show me the spend report and where I can cut."

The client will call `scan_ai_spend`, then `get_spend_report` and `recommend_cuts` for you.

---

## Privacy and safety

- **Local-first.** All scanning and analysis happen on your machine over stdio. There is no network upload.
- **Read-only sources.** Scanned folders are registered as read-only; the server never writes back into your source files (only into `<path>/.ai-spend-agent/`).
- **Secret redaction.** Detected secrets are redacted before any result leaves the server, and redactions are recorded in the audit log.

---

## Troubleshooting

- **Tools don't appear in the client.** Confirm `packages/mcp/dist/server.js` exists (run `npm run build`) and that the `command`/`args` path in your config is absolute and correct. Restart the client after editing the config.
- **`command not found: ai-spend-mcp`.** Run `npm link` in `packages/mcp` (or `npm install -g @agent-finops/mcp`) so the bin is on your PATH, or switch to the `node /abs/path` form.
- **A tool returns an error result.** Make sure you ran `scan_ai_spend` for that `path` first; `list_sources`, `get_spend_report`, and `recommend_cuts` read state a scan creates. Use `sample: true` if you want `get_spend_report` to return demo data.
