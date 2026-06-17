# @agent-finops/mcp

> `@agent-finops/mcp` is the internal workspace package scope; the published CLI is **`ai-spend-agent`** (`github.com/futurastudio/ai-spend-agent`).

**AI Spend Analyst — MCP server.** See your AI spend in one view, locally. A [Model Context Protocol](https://modelcontextprotocol.io) stdio server that lets Cursor, Claude Desktop, and other MCP clients scan a local folder for AI provider usage (OpenAI, Anthropic, and more), build a spend report, and suggest where to cut. Everything runs on your machine — folders are scanned read-only, secrets are redacted before output, and nothing is uploaded.

## Install & build

```bash
npm install
npm run build   # produces dist/server.js (bin: ai-spend-mcp)
```

## Use it in Cursor / Claude Desktop

Add this to Cursor (Settings → MCP, or `~/.cursor/mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-spend-analyst": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/ai-spend-agent/packages/mcp/dist/server.js"]
    }
  }
}
```

After `npm link` (in this package) or `npm install -g @agent-finops/mcp`, you can use the bin instead:

```json
{
  "mcpServers": {
    "ai-spend-analyst": { "command": "ai-spend-mcp" }
  }
}
```

Restart the client, then ask: *"Scan `/path/to/my-agency` for AI spend with the sample data and show me where I can cut."*

## Tools

| Tool | Purpose |
| --- | --- |
| `scan_ai_spend` | Scan a folder for AI usage signals (run this first; `sample: true` for demo data). |
| `list_sources` | List the read-only sources a scan registered. |
| `get_spend_report` | Return the analyzed spend report (totals, breakdowns, anomalies, insights). |
| `recommend_cuts` | Return scanner-backed recommendations for cutting spend. |

All tools take an absolute `path`. See [`docs/MCP.md`](../../docs/MCP.md) for full configuration, tool inputs, copy-paste examples, and troubleshooting.
