# @agent-finops/mcp

**aibill for MCP.** A local-first stdio server that lets Claude, Codex,
Cursor, and other MCP clients answer sourced questions about local Claude
Code/Codex work, cost evidence, attribution, runway, and Context Health—or add
provider billing evidence to the same aibill report.

The protocol is client-neutral. Provider ingestion currently supports OpenAI,
Anthropic, GitHub Copilot, and Cursor. Anthropic is implemented and
live-verified. OpenAI authentication and endpoint access were exercised, while
non-empty cost reconciliation is still pending. Copilot and Cursor are
connector-fixture verified and still need live-account QA. Local transcript
support is Claude Code and Codex.

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
| `sync_local_agent_spend` | Build an estimated API-equivalent usage-value report from local Claude Code/Codex metadata. Totals are not billed spend; day-over-day anomalies remain unavailable because daily aggregates are not comparable calls. |
| `sync_provider_spend` | Pull read-only provider billing evidence through an `env:NAME` reference, with billed cost, estimates, and coverage kept separate. |
| `get_usage_glance` | Read current-session, exact reported limit/reset, locally derived main focus, and one copy-ready next move without guessing missing fields or auto-running an agent. An explicit `path` wins; otherwise project inventory follows the latest transcript cwd, matching CLI. |
| `get_context_health` | Distinguish discoverable, configured, explicitly invoked, hook-injected, and invocation-unobservable context without assuming MCP schemas loaded or running hook commands. |
| `list_sources` | List locally registered sources and verification levels. |
| `get_spend_report` | Return the active records, data mode, and analyzed summary. |
| `recommend_cuts` | Inspect report-backed reduction candidates (legacy tool name). Only priced records explicitly marked `call`/`invocation`, with a named operation and the action-specific workload semantics needed for a counterfactual, may support modeled recommendations; provider buckets/seats do not. Sample mode is demo-only, and local transcript aggregates return observed evidence or collect-more-evidence guidance. Use `npx aibill apply` for approval, rollback, and matched verification. |

State tools use an absolute project `path`; broad roots, state symlinks, and
symlinked state files are refused. State is written only to
`<path>/.ai-spend-agent/`. `get_usage_glance` is read-only and
reads known Claude Code/Codex transcript metadata. See
[`docs/MCP.md`](../../docs/MCP.md) for inputs, provider support, development
configuration, and troubleshooting.

aibill sends no telemetry or transcripts to an aibill service. Explicit
provider sync sends the referenced credential only to the selected provider's
official read-only API; raw credentials are never persisted or returned. An MCP
tool result is returned to the invoking AI client under that client's
data-handling policy. The optional repo plugin is explicit-only and adds no
lifecycle hooks.
