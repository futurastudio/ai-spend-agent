# aibill MCP Server

`@agent-finops/mcp` is a local-first Model Context Protocol server for aibill.
It lets compatible AI clients ask sourced questions about coding-agent work,
cost evidence, attribution, runway, and Context Health from the same contract
as the CLI and Glance. It works with any client that supports a local stdio
MCP server, including Claude Desktop/Claude Code, Codex, Cursor, and compatible
agent hosts.

The MCP client and the spend provider are separate concerns:

- **MCP clients:** any stdio-compatible agent can call the tools.
- **Local usage:** Claude Code and Codex transcript metadata.
- **Provider APIs:** OpenAI, Anthropic, GitHub Copilot, and Cursor.
- **Live verification:** Anthropic is implemented and live-verified. OpenAI
  authentication and endpoint access were exercised on 2026-07-28, while a
  non-empty cost reconciliation is still pending. Copilot and Cursor have
  fixture and failure-path coverage but still require a live account QA pass.

Package: `@agent-finops/mcp` · Binary: `ai-spend-mcp` · Transport: stdio

## Quick start from npm

### Codex

Add the server with the Codex CLI:

```bash
codex mcp add aibill -- npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
codex mcp list
```

Codex stores user-level MCP configuration in `~/.codex/config.toml`. The
ChatGPT desktop app, Codex CLI, and Codex IDE extension share that
configuration on the same host. For a trusted project-only setup, place the
same table in `.codex/config.toml` at the project root:

```toml
[mcp_servers.aibill]
command = "npx"
args = ["--yes", "--package", "@agent-finops/mcp@latest", "ai-spend-mcp"]
```

Restart the client, then use `/mcp` to confirm that `aibill` is active.

### Claude Code

Add a private user-level server:

```bash
claude mcp add --scope user aibill -- npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
claude mcp list
```

For a project-shared setup, put this JSON in `.mcp.json` at the project root.
Claude Code asks for approval before using project-scoped servers:

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

### Cursor

Put the same JSON server definition in `~/.cursor/mcp.json` for all projects,
or `.cursor/mcp.json` at a project root for project-only use:

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

Restart Cursor and confirm `aibill` appears under available MCP tools.

### Other stdio clients

Use the JSON server definition above wherever that client stores its
`mcpServers` configuration. The command is `npx`; the four arguments are
`--yes`, `--package`, `@agent-finops/mcp@latest`, and
`ai-spend-mcp`. Consult that client's documentation for its exact config
path and restart behavior.

Restart the client and confirm that these eight tools appear:

1. `scan_ai_spend`
2. `sync_local_agent_spend`
3. `sync_provider_spend`
4. `get_usage_glance`
5. `get_context_health`
6. `list_sources`
7. `get_spend_report`
8. `recommend_cuts`

## Optional on-demand Codex plugin

The repo also contains [`plugins/aibill`](../plugins/aibill), a thin plugin
that pins this MCP package and adds three explicit-only skills. It has no
lifecycle hooks or always-on prompt injection.

From a clone:

```bash
codex plugin marketplace add /absolute/path/to/ai-spend-agent
codex plugin add aibill@aibill
```

Start a new Codex task, then explicitly invoke `$aibill-check`,
`$aibill-explain`, or `$aibill-help`.

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
        "/ABSOLUTE/PATH/TO/ai-spend-agent/packages/mcp/dist/server.js"
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
- aibill itself does not upload local transcript contents or send telemetry.
  An MCP tool's selected structured result is returned to the invoking AI
  client and follows that client's data-handling policy.
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
{ "path": "/Users/you/projects/your-project" }
```

For a deterministic demo only:

```json
{ "path": "/Users/you/projects/your-project", "sample": true }
```

### `sync_local_agent_spend`

Reads local Claude Code and Codex transcript metadata, calculates
API-equivalent usage value, and writes a local report. The optional project
filter matches the aggregated project name exactly.

```json
{
  "path": "/Users/you/projects/your-project",
  "sinceDays": 30,
  "project": "your-project"
}
```

Returned totals are estimates, not provider invoices, billed spend, or
subscription quota consumption. The response labels this as
`valueBasis: local_api_equivalent_value_not_billed_spend`; any deterministic
day-over-day anomaly is unavailable because daily transcript aggregates are not
comparable call-level records. The response reports
`anomalyBasis: unavailable_no_comparable_call_level_records` instead of
manufacturing a billing or usage spike.

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
- one `primaryAction` derived from canonical Context Health, Main focus, and
  reported runway. It includes a compact label/detail plus a copy-ready agent
  handoff; it is never executed automatically.

When `path` is supplied, project-scoped inventory uses that approved root. When
it is omitted, MCP matches the CLI and scopes read-only inventory to the latest
absolute working directory observed in the selected transcript calls; only when
no transcript cwd is available does it fall back to the MCP server's cwd.

```json
{
  "path": "/Users/you/projects/your-project",
  "sinceDays": 30,
  "project": "your-project"
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
- Context Health: the canonical CLI/MCP/Glance result, with hook payload
  explicitly marked `not_executed_or_inferred`; and
- primary action: the canonical local Context Health + focus + reported-runway
  decision, with `execution: copy_prompt` and `automaticExecution: false`; and
- network: `uploaded: false`.

### `get_context_health`

Returns the same hook-aware decision contract used by
`aibill context --json` and `get_usage_glance.sessionHealth`.

```json
{
  "path": "/Users/you/projects/your-project",
  "sinceDays": 30,
  "project": "your-project"
}
```

It distinguishes:

- discoverable skills, commands, and subagents;
- items explicitly invoked where the local Claude Code or Codex transcript
  exposes a matchable event;
- MCP servers observed in configuration, including an explicit always-load
  request when the config proves it (schema payload and runtime overhead remain
  unmeasured);
- context-injecting lifecycle events such as `SessionStart`,
  `UserPromptSubmit`, and `SubagentStart`; and
- other lifecycle hooks that are configured but not treated as prompt
  injection.

Installed hook configuration is read as metadata only. aibill never executes a
hook command, never reads its runtime stdout, and never assigns it a token or
dollar value. The recommendation precedence is deterministic: a large
same-agent session can recommend starting fresh; otherwise hook review,
inventory with no matching invocation, a healthy continue decision, or insufficient history
is returned with evidence and caveats.
Configured items whose host transcript does not expose explicit invocation
evidence are counted as `invocationUnobservableItems` and excluded from
no-matching-invocation totals.

### `sync_provider_spend`

Pulls provider billing/usage with an inherited reference-only credential.

OpenAI:

```json
{
  "path": "/Users/you/projects/your-project",
  "provider": "openai",
  "authReference": "env:OPENAI_ADMIN_KEY",
  "startTime": 1784606400,
  "endTime": 1785211200
}
```

Anthropic:

```json
{
  "path": "/Users/you/projects/your-project",
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
{ "path": "/Users/you/projects/your-project" }
```

### `get_spend_report`

Returns the active data mode, records, and analyzed summary after a local,
provider, or explicit sample sync:

```json
{ "path": "/Users/you/projects/your-project" }
```

An explicit sample remains `mode: sample` after persistence. Its accounting
policy is `demo_sample_not_user_data`; it is never silently reclassified as
connected provider evidence.

### `recommend_cuts`

The tool name is retained for compatibility. A modeled recommendation requires
schema-validated `call` or `invocation` granularity, a named operation, priced
evidence, and the action-specific workload semantics needed for its
counterfactual (for example an adapter-attested downgrade-safe workload, Batch
eligibility, or stable input fingerprint). Its
response keeps the evidence window, confidence, modeled/not-verified status,
approval boundary, rollback, and matched-verification requirement. Provider
cost buckets, usage aggregates, seats, and user totals remain useful for
reconciliation and attribution but do not support call-level cuts. Bundled
sample state returns demo-only guidance; local Claude Code/Codex day aggregates
return observed API-equivalent exposure candidates—or a collect-more-evidence
result—because they do not prove an individual call, a safe change, or a
savings counterfactual. Discovery-only state never invents downgrade, cache,
batch, or savings advice. For the complete local workflow, run `npx aibill
apply` to get read-only checks, an explicit approval gate, rollback, and matched
future-session verification.

```json
{ "path": "/Users/you/projects/your-project" }
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

Deterministic Context Health classification and safety benchmark:

```bash
npm run benchmark:context
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
