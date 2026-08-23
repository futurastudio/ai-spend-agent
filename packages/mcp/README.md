# @agent-finops/mcp

**aibill for MCP.** A local-first stdio server that lets Claude, Codex,
Cursor, and other MCP clients answer sourced attribution, runway, and Context
Health questions from local Claude Code/Codex work. It can also add
experimental Gemini CLI financial evidence or provider billing evidence to
the same aibill report.

The protocol is client-neutral. Local Claude Code and Codex readers are
`live_verified` against an adversarial local corpus. The Gemini CLI chats
reader is experimental and `fixture_verified`; it never treats `logs.json` as
financial evidence. Provider ingestion currently
supports OpenAI, Anthropic, GitHub Copilot, and Cursor. OpenAI and Anthropic
have non-empty live-API verification. OpenAI QA reconciled the tested Costs
total to invoiced API credits less the current provider-UI balance with `$0.00`
variance; each user's final invoice remains separate. Copilot and Cursor pass
current official-format fixtures but remain `fixture_verified` beta until
live-account QA. Connector validation coverage is separate from each number's financial-evidence label;
`npx aibill doctor --sources` shows both.
`list_sources` also exposes read-boundary approval separately. An approved
folder boundary never means its financial contents were verified.

## Run from npm

> **AI-client data boundary:** aibill sends no telemetry and does not upload
> transcript contents. A selected tool result is returned to the AI client you
> configure below and then follows that client's data-handling policy.

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
rejected. aibill never sits in the inference path and never stores, prints, or proxies provider credentials.

## Tools

The published `@agent-finops/mcp@latest` package is `v0.9.1` and exposes all
ten tools below, including the read-only experiment pair
`get_token_reduction_test` and `draft_improve_command`.

| Tool | Purpose |
| --- | --- |
| `scan_ai_spend` | Discover provider files/configuration using opaque descendant-path references; `sample: true` skips local discovery and is explicitly demo-only. |
| `sync_local_agent_spend` | Build an estimated API-equivalent usage-value report from supported local Claude Code, Codex, and experimental Gemini CLI financial metadata. Totals are not billed spend; incomplete Gemini shapes remain `missing`, and day-over-day anomalies remain unavailable because daily aggregates are not comparable calls. |
| `sync_provider_spend` | Pull read-only provider billing evidence through an `env:NAME` reference, with billed cost, estimates, and coverage kept separate. |
| `get_usage_glance` | Read current-session, exact reported limit/reset, locally derived main focus, and one copy-ready next move without guessing missing fields or auto-running an agent. Bounded qualitative coverage is explicit; partial indexing withholds a global focus/action. An explicit `path` wins; otherwise project inventory follows the latest transcript cwd, matching CLI. |
| `get_context_health` | Distinguish discoverable, configured, explicitly invoked, hook-injected, and invocation-unobservable context without assuming MCP schemas loaded or running hook commands. Returns complete/partial qualitative-index coverage beside the canonical contract. |
| `get_token_reduction_test` | Read one canonical local token-reduction experiment using active-preferred selection by default, refresh an eligible in-progress Claude Code/Codex comparison without writing state, and return the same compact projection plus bounded-index coverage used across aibill surfaces. Complete results stay frozen; it never infers quality or claims cash savings or verified outcome ROI. |
| `draft_improve_command` | Validate agent-drafted change/rollback/canary sentences with the terminal's own shared classifier and compose exactly one version-pinned, paste-safe `npx aibill improve --draft …` (or `--record-applied-at …`) command. It writes nothing and authorizes nothing; APPROVE exists only as the word typed by the human in their own terminal. |
| `list_sources` | List canonical product-authored source names/scopes, the approved local root, ingestion methods, and separate boundary/validation/financial axes without trusting persisted capability or credential metadata. |
| `get_spend_report` | Return the active records, data mode, analyzed summary, and separate connector-validation, financial-evidence, freshness, and last-error source statuses. With no synced state, it returns `no_state`, zero records, a null financial headline, and exact sync/demo next steps. Sample rows require an explicit `scan_ai_spend(sample=true)`; malformed or untrusted real state still fails closed. |
| `recommend_cuts` | Inspect report-backed reduction candidates (legacy tool name). Only priced records explicitly marked `call`/`invocation`, with a named operation and the action-specific workload semantics needed for a counterfactual, may support modeled recommendations; provider buckets/seats do not. Sample mode is demo-only, and local transcript aggregates return observed evidence or collect-more-evidence guidance. `npx aibill apply` produces an inspection/approval artifact; the matched completed-session-snapshot lifecycle is the guided `npx aibill improve` flow. |

State tools use an absolute project `path`; broad roots, state symlinks, and
symlinked state files are refused. Project state is written to
`<path>/.ai-spend-agent/`. A successful provider sync also writes a hash-only,
credential-free machine trust receipt under `~/.aibill/state-receipts/`
(override: `AI_SPEND_STATE_TRUST_DIR`) so repository-authored connected state
fails closed. It binds hashes of both `spend.json` and `sources.json`; it never
contains spend rows, source records, or credentials. `get_usage_glance` and
`get_token_reduction_test` are read-only. They read only supported local Claude
Code/Codex transcript metadata. The latter revalidates the persisted experiment
and refreshes only an eligible in-progress comparison; complete and terminal
results remain frozen. It never applies or persists a change, infers quality,
or claims savings, an accepted outcome, or ROI. See the
[MCP guide](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/MCP.md) for inputs, provider support, development
configuration, and troubleshooting.

aibill sends no telemetry or transcripts to an aibill service. Explicit
provider sync sends the referenced credential only to the selected provider's
official read-only API; raw credentials are never persisted or returned. An MCP
tool result is returned to the invoking AI client under that client's
data-handling policy. The optional repo plugin is explicit-only and adds no
lifecycle hooks.

## Token-reduction experiments over MCP

`get_token_reduction_test` is a read-only view of a locally created
experiment. The CLI alone creates and
records its lifecycle: inspect an exact candidate, freeze a baseline only with
`--quality held`, record one approved change plus passing or failed canary with
three required opaque SHA-256 evidence digests, record the frozen rollback when
needed, cancel an un-applied baseline, then calculate a matched result.

The returned `experiment.id` is stable lineage identity; `revisionId` identifies
the immutable-content revision being read. It compares only explicit completed
Claude Code/Codex session snapshots—not idle or merely old sessions—and preserves
per-component token coverage. Components can be observed, partial, or not
separately reported; calculated totals and provider-reported totals are never
silently blended. One native session contributes at most once to an experiment,
so a resumed transcript cannot rewrite or become a second sample. Missing
quality blocks a result rather than excluding that matched snapshot; a failed
canary yields no result or percentage and requires a separately evidenced
rollback. Once complete, the cohort and result are frozen. Its compact
projection is shared with Glance, but both are read-only views and never certify
token savings, outcome quality, or ROI. With no explicit experiment ID, the
canonical default is active-preferred with a deterministic fallback.
MCP may reuse a private qualitative index already populated by the local CLI,
but it never creates or updates that cache or any experiment/project state.
