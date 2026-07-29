# aibill MCP Server

`@agent-finops/mcp` is a local-first Model Context Protocol server for aibill.
It works with any client that supports a local stdio MCP server, including
Claude Desktop/Claude Code, Codex, Cursor, and compatible agent hosts.

The MCP client and the spend provider are separate concerns:

- **MCP clients:** any stdio-compatible agent can call the tools.
- **Local usage:** Claude Code and Codex transcript metadata.
- **Provider APIs:** OpenAI, Anthropic, GitHub Copilot, and Cursor.
- **Live verification:** OpenAI and Anthropic were exercised against their
  read-only billing/usage APIs on 2026-07-28. Copilot and Cursor have fixture
  and failure-path coverage but still require a live account QA pass.

Package: `@agent-finops/mcp` · Binary: `ai-spend-mcp` · Transport: stdio

## Quick start from npm

Use this server definition in a JSON-based MCP client:

```json
{
  "mcpServers": {
    "aibill": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "@agent-finops/mcp@latest",
        "ai-spend-mcp"
      ]
    }
  }
}
```

For Codex-style TOML configuration:

```toml
[mcp_servers.aibill]
command = "npx"
args = ["--yes", "--package", "@agent-finops/mcp@latest", "ai-spend-mcp"]
```

Restart the client and confirm that these seven tools appear:

1. `scan_ai_spend`
2. `sync_local_agent_spend`
3. `sync_provider_spend`
4. `get_usage_glance`
5. `list_sources`
6. `get_spend_report`
7. `recommend_cuts`

## Local development

```bash
npm install
npm run build --workspace @agent-finops/core
npm run build --workspace @agent-finops/mcp
```

Point the MCP client at the checkout:

```json
{
  "mcpServers": {
    "aibill-local": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/agent-finops/packages/mcp/dist/server.js"
      ]
    }
  }
}
```

Importing `@agent-finops/mcp` as a library does not start the stdio server.
The executable starts only when `dist/server.js` is invoked as the main module.

## Data and safety model

- State tools require an absolute project `path`; home, filesystem, and system
  roots are refused.
- `get_usage_glance` is read-only and scans only the known Claude Code and
  Codex transcript locations (or the documented test-directory overrides).
- State is written only to `<path>/.ai-spend-agent/`.
- Local transcript contents are never uploaded.
- Provider tools are read-only against provider APIs.
- Provider credentials must be inherited environment variables referenced as
  `env:NAME`; raw keys are rejected before any network request.
- Only the reference name is persisted. Raw credentials are neither returned
  to the MCP client nor written to state.
- Provider syncs merge with prior provider syncs by provider. Re-syncing one
  provider replaces only that provider's older records.
- Local-log estimates and provider-billed costs use separate active modes to
  avoid silently double-counting the same work.

## Tools

### `scan_ai_spend`

Discovers provider configuration, dependencies, exports, invoices, and secret
names in an approved folder. Evidence is redacted before persistence/output.
Discovery does not make a file a verified billing source and does not parse an
arbitrary provider export into spend.

```json
{ "path": "/Users/you/projects/agent-finops" }
```

For a deterministic demo only:

```json
{ "path": "/Users/you/projects/agent-finops", "sample": true }
```

### `sync_local_agent_spend`

Reads local Claude Code and Codex transcript metadata, estimates
API-equivalent model cost, and writes a local report. The optional project
filter matches the aggregated project name exactly.

```json
{
  "path": "/Users/you/projects/agent-finops",
  "sinceDays": 30,
  "project": "agent-finops"
}
```

Returned totals are estimates, not provider invoices or subscription quota
consumption.

### `get_usage_glance`

Builds the read-only data contract for the native Glance UI:

- current or latest session value at API rates, duration, project, and model;
- locally detected subscription/API billing context, without exposing tokens
  or config paths;
- five-hour, weekly, or custom plan windows only when a transcript reports
  remaining usage and reset metadata;
- projected exhaustion time, explicitly labeled as a pace estimate;
- the main recent work focus derived from observed local prompt/tool activity,
  with task, project, file, automation, or delegated-agent context only when
  supported; and
- at most one evidence-backed session anomaly with a concrete next action.

```json
{
  "sinceDays": 30,
  "project": "agent-finops"
}
```

Claude Code and Codex session value is an API-equivalent estimate calculated
from transcript token metadata. Codex rollouts can contain exact
provider-reported rate-limit percentages and reset times; Claude Code
transcripts do not currently contain equivalent plan-headroom fields. The tool
returns that limit as unavailable instead of guessing. Cursor and GitHub
Copilot require their provider connections rather than local chat stores.
“Main focus” is not a time tracker or spend ranking: its percentage is the
share of observed prompt/tool activity in the focus window. Raw prompts are
reduced locally to a short summary and are not returned in the snapshot.

The response includes a `provenance` object that makes these distinctions
machine-readable for every custom client:

- session/model/project: local transcript metadata;
- session value: local token calculation at published API list rates, with
  the bundled price-table date;
- plan: locally detected account metadata, user-declared override, or
  unavailable;
- limits: transcript-reported windows, with exhaustion labeled as a separate
  local pace estimate;
- focus and anomaly: local activity/history derivations; and
- network: `uploaded: false`.

### `sync_provider_spend`

Pulls provider billing/usage with an inherited reference-only credential.

OpenAI:

```json
{
  "path": "/Users/you/projects/agent-finops",
  "provider": "openai",
  "authReference": "env:OPENAI_ADMIN_KEY",
  "startTime": 1784606400,
  "endTime": 1785211200
}
```

Anthropic:

```json
{
  "path": "/Users/you/projects/agent-finops",
  "provider": "anthropic",
  "authReference": "env:ANTHROPIC_ADMIN_KEY",
  "startTime": 1784606400,
  "endTime": 1785211200
}
```

GitHub Copilot additionally requires `org` or `enterprise`; Cursor can take
`accountId`. The server returns record counts, completeness, totals, and QA
metadata. Detailed records are available through `get_spend_report`.

### `list_sources`

Lists approved sources, ingestion method, and verification level:

```json
{ "path": "/Users/you/projects/agent-finops" }
```

### `get_spend_report`

Returns the active data mode, records, and analyzed summary after a local,
provider, or explicit sample sync:

```json
{ "path": "/Users/you/projects/agent-finops" }
```

### `recommend_cuts`

Uses analyzed spend recommendations when a report exists. If only discovery
state exists, it returns clearly labeled discovery-based guidance:

```json
{ "path": "/Users/you/projects/agent-finops" }
```

## Repeatable QA

Focused protocol and connector tests:

```bash
npx vitest run packages/core/src/providerConnectors.test.ts \
  packages/core/src/localAgentLogs.test.ts \
  packages/mcp/src/index.test.ts
```

Read-only live provider audit (outputs only sanitized summaries):

```bash
node scripts/audit-mcp-providers.mjs
```

Full stdio audit through a spawned MCP server:

```bash
node scripts/audit-mcp-stdio.mjs
```

## Troubleshooting

- **Tools do not appear:** run the exact `npx` command manually and ensure the
  client supports local stdio servers.
- **Provider variable is missing:** launch the MCP client from an environment
  that exports the referenced variable. Do not paste a raw key into tool
  arguments.
- **Provider returns 401/403:** the credential needs organization/admin
  billing-read scopes, not a normal inference API key.
- **`get_spend_report` is missing:** run a local/provider sync or an explicit
  sample scan first.
- **A root is refused:** select a specific project folder; broad-root refusal
  is intentional prompt-injection protection.
