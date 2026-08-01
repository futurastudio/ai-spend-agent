# @agent-finops/mcp

**aibill for MCP.** A local-first stdio server that lets Claude, Codex,
Cursor, and other MCP clients read local Claude Code/Codex usage or add
provider billing evidence to the same aibill report.

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
| `sync_provider_spend` | Pull read-only provider billing evidence through an `env:NAME` reference, with billed cost, estimates, and coverage kept separate. |
| `get_usage_glance` | Read current-session, exact reported limit/reset, locally derived main focus, and one copy-ready next move without guessing missing fields or auto-running an agent. |
| `get_context_health` | Distinguish discoverable, invoked, MCP-schema-loaded, hook-injected, and invocation-unobservable context without running hook commands. |
| `list_sources` | List locally registered sources and verification levels. |
| `get_spend_report` | Return the active records, data mode, and analyzed summary. |
| `recommend_cuts` | Return report-backed recommendations, with discovery fallback. |

State tools use an absolute project `path`; broad roots, state symlinks, and
symlinked state files are refused. State is written only to
`<path>/.ai-spend-agent/`. `get_usage_glance` is read-only and
reads known Claude Code/Codex transcript metadata. See
[`docs/MCP.md`](../../docs/MCP.md) for inputs, provider support, development
configuration, and troubleshooting.

aibill makes no telemetry or upload request. An MCP tool result is returned to
the AI client that invoked it and follows that client's data-handling policy.
The optional repo plugin is explicit-only and adds no lifecycle hooks.
