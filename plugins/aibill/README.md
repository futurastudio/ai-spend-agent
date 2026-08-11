# aibill plugin

The optional aibill plugin exposes the existing local MCP server and three
explicit-only skills. It adds no lifecycle hooks and injects no always-on
instructions.

## What it provides

- `$aibill-check`: current usage plus the canonical Context Health decision.
- `$aibill-explain`: field-level provenance, confidence, and missing-data
  explanations.
- `$aibill-help`: choose CLI, MCP/plugin, or macOS Glance.
- Eight MCP tools, including `get_usage_glance` and `get_context_health`.

The plugin launches `@agent-finops/mcp@0.8.0` with `npx` when the AI client
starts the MCP server. Node.js 22 or newer is required.

## Install from this repository

Clone the repository, add its repo-local marketplace, then install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/ai-spend-agent
codex plugin add aibill@aibill
```

Start a new Codex task after installation so the MCP tools and explicit skills
are loaded. Use `$aibill-check` only when you want the AI client to read the
local structured result.

## Privacy boundary

aibill sends no telemetry or transcripts to an aibill service. CLI transcript
analysis and the source-built Glance preview run locally. Scan, sync, and report
tools may write explicit local state under the selected project's
`.ai-spend-agent/` directory. A successful provider sync also writes a
hash-only, credential-free trust receipt under `~/.aibill/state-receipts/` so
cloned repository state cannot claim connected totals or source-status truth.
The receipt binds hashes of the exact `spend.json` and `sources.json` plus the
canonical root and timestamp; it contains no spend rows, source records, or
credentials. No external provider or project setting is changed automatically.
An explicitly requested provider sync sends the referenced credential only to
the selected provider's official read-only API. aibill never sits in the inference path and never stores, prints, or proxies provider credentials. An invoked MCP skill returns the selected structured result to that AI client under the client's own data-handling policy.

Connector validation (`live_verified`, `fixture_verified`, `untested`, or
`failed`) is separate from each number's financial evidence (`verified`,
`estimated`, `detected_unverified`, or `missing`).
