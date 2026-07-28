# @agent-finops/mcp

**aibill for MCP.** A local-first stdio server that lets Claude, Codex,
Cursor, and other MCP clients read local Claude Code/Codex usage or sync
verified provider billing into the same aibill report.

The protocol is client-neutral. Provider ingestion currently supports OpenAI,
Anthropic, GitHub Copilot, and Cursor. OpenAI and Anthropic are live-verified;
Copilot and Cursor are connector-fixture verified. Local transcript support is
Claude Code and Codex.

## Run from npm

```bash
npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
```

MCP client configuration:

```jsonc
{
  "mcpServers": {
    "aibill": {
      "command": "npx",
      "args": ["--yes", "--package", "@agent-finops/mcp@latest", "ai-spend-mcp"]
    }
  }
}
```

Provider sync accepts only references such as `env:OPENAI_ADMIN_KEY`. The
referenced variable must be inherited by the MCP server process. Raw keys are
rejected and never persisted.

## Tools

| Tool | Purpose |
| --- | --- |
| `scan_ai_spend` | Discover provider files/configuration; `sample: true` is explicitly demo-only. |
| `sync_local_agent_spend` | Build an estimated API-equivalent report from local Claude Code/Codex metadata. |
| `sync_provider_spend` | Pull read-only provider billing through an `env:NAME` reference. |
| `list_sources` | List locally registered sources and verification levels. |
| `get_spend_report` | Return the active records, data mode, and analyzed summary. |
| `recommend_cuts` | Return report-backed recommendations, with discovery fallback. |

All tools use an absolute project `path`; broad roots are refused. State is
written only to `<path>/.ai-spend-agent/`. See
[`docs/MCP.md`](../../docs/MCP.md) for inputs, provider support, development
configuration, and troubleshooting.
