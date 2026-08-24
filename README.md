# aibill — financial accountability for AI agents

[![CI](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/ai-spend-agent)](https://www.npmjs.com/package/ai-spend-agent) [![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Know what cost evidence exists for your AI agents, what drove it, and what
to do next—with the source and limits attached.**

```bash
npx aibill         # short form — same CLI as `npx ai-spend-agent`
```

[Documentation](https://asktilden.com/docs) · [Supported sources](https://asktilden.com/docs/sources) · [MCP setup](https://asktilden.com/docs/mcp) · [Roadmap](https://asktilden.com/docs/roadmap)

Building a Node integration? The
[supported library preview](docs/LIBRARY.md) documents the narrow, packed-test
contract for usage-record validation, analysis, Receipt v0, pinned standards
projections, and terminal rendering.

> **Version boundary:** npm latest is `v0.9.1`. It reads supported Claude Code,
> Codex, and experimental Gemini CLI financial evidence. Gemini remains
> `fixture_verified`, financial-only, and excluded from statusline, Glance,
> Context Health, plan/runway, invocation evidence, recommendations, and Apply.
>
> **The guided token-reduction and local accountability loop is published.**
> Run `npx aibill improve` from the project you want to improve — or practice
> safely first with `npx aibill improve --sample`, a labeled demo that writes
> nothing. The guided flow gives one personalized test, tracks matched
> before/after completed-session snapshots, and prints a percentage only when
> the user's declared quality held. An MCP client can draft the plan
> conversationally and hand you one `npx aibill improve --draft …` command;
> APPROVE is still typed by you in the terminal, never by an agent.
> `identify`, `outcome github`, and `accountability` add explicitly confirmed
> ownership, a pre-change local self-attestation audit, and an opt-in
> merged-PR outcome. None of this certifies cash savings, business value,
> company RBAC, invoice reconciliation, productivity, or ROI.

The launch wedge is deliberately simple:

1. **Why is it high?** Show the strongest supported driver without hiding missing coverage.
2. **How do I reduce it?** Propose one provider-aware, reversible test—not a list of generic tips.
3. **Did it work?** After matched post-change sessions and a held quality check, aibill may say: **“Token usage fell X% per matched completed session.”** It never turns that personal result into a universal savings, cash, or ROI claim.

aibill is building the financial accountability system for the AI-agent
workforce: connecting what agents did to what they cost, who owns it, what
outcome it produced, and what should happen next. The public beta establishes
the private evidence layer for that mission. The published package consolidates
observed Claude Code and Codex activity, subscription context, API-equivalent
value, optional provider-reported cost, attribution, runway, and Context Health
into one evidence-labeled local view. It also reads supported experimental
Gemini CLI financial evidence in its financial surfaces only; that narrower
capability boundary stays explicit in the generated source documentation.
It separates what was billed from what was included in a plan and what was
calculated at API rates, so the number can support a decision instead of
becoming another misleading meter.

If you use **Claude Code or Codex**, the published command reads supported
financial fields from session files already on your machine and
shows observed usage at API-equivalent rates where the token evidence is
complete. Local cumulative usage remains observed exposure. The guided
`npx aibill improve` flow compares matched completed session snapshots before
and after one approved change; it can calculate token change
only after matched evidence and an explicit quality guard, and it is not a
cash-savings, accepted-outcome, or ROI conclusion. No provider connection or
signup is required, and nothing leaves your laptop on the default local run.
Connect a provider's admin cost report only when you need official
provider-reported cost alongside the local evidence.

> **Public beta boundary:** CLI, the optional cache-only Claude Code status
> line, and the explicit MCP/plugin ship publicly.
> Glance remains a source-built macOS preview until its signed standalone
> download passes. Workspace, automatic enforcement, and ROI measurement are not
> shipped.

No supported agent evidence? The default command returns an honest empty state
with one diagnostic next step; it never substitutes sample dollars. Run
`npx aibill --sample` only when you explicitly want the labeled illustrative
demo. A presence-only Gemini `logs.json` signal likewise produces zero financial
rows. When you're ready, `connect` sets up an OpenAI or Anthropic admin connector
and prints the separate sync command required to fetch provider-reported cost.
Availability depends on the permissions of that provider account.

![Terminal recording of npx aibill rendering the spend report on sample data](docs/assets/demo.gif)

*Illustrative sample output — demo cost/value evidence with clearly separated
bases, not your provider-reported cost, invoice, or an outcome/ROI conclusion. Regenerate
it from the real CLI with `scripts/record-demo.sh` for every release that changes
terminal copy.*

## Get started

1. **Initialize a private personal baseline:** run `npx aibill init` from a
   project. npm v0.9.1 detects supported Claude Code, Codex, and experimental
   Gemini CLI financial evidence and backfills the last 30 days. It prints the
   first evidence-labeled
   receipt and stores only the Claude Code/Codex fields supported by the small
   aggregate status-line snapshot under `~/.aibill/cache/`. Empty or unavailable evidence stays
   explicit; init never substitutes sample dollars for your own.
2. **Optional—add the Claude Code status line:** `npx aibill statusline
   install`. Bare init only prints this opt-in; it never changes Claude
   settings. Use `npx aibill statusline uninstall` to restore the prior value.
3. **Open the complete private view:** `npx aibill --full` (bare `npx aibill`
   stays compact: trust, one number, one driver, one evidence gap, one action)
4. **Get the current session decision:** `npx aibill context`
5. **Test one evidence-constrained change and measure it:**
   `npx aibill improve` runs the guided flow: one safe test, progress, then
   this project's measured token change when the matched evidence and
   user-declared quality guard support it. Practice first with
   `npx aibill improve --sample`, a labeled demo that writes nothing. The
   narrower `npx aibill apply` creates the inspection and approval artifact
   without running a change or verifying a result; in sample mode, Apply is
   an explicitly non-executable demo.
6. **Optional—set up official provider-reported cost:** `npx aibill connect
   openai` or `npx aibill connect anthropic` registers the connector and prints
   the exact `sync-provider` command. Only that explicit sync contacts the
   provider and fetches evidence. The provider report remains separate from
   local API-equivalent estimates.
7. **Optional—ask why through AI:** configure the explicit-only MCP/plugin.
8. **Share a redacted report card:** `npx aibill report-card` writes an SVG and
   caption without client, project, or user names.

## Who this is for

- **You run a startup or freelance on AI tools** and can't answer what you are
  paying for, what your agents consumed, and whether those are the same number.
  The evidence is split across provider reports, subscriptions, and local logs.
- **You live in Claude Code / Codex** and the meters keep coming — Copilot's
  AI Credits plus Claude's mix of plan limits, model-specific usage credits,
  and optional API overages. Your burn rate is hard to compare until you read
  your own logs.
- **You lead a small team** and need to know which project, model, or person
  owns the available usage evidence before you set budgets, without uploading
  raw conversations to a shared dashboard.
- **You run an agency** and want per-client usage or cost attribution where the
  source exposes that dimension (`--group-by client`).

## What a trustworthy spend view lets you decide

A dashboard is not the outcome. The view is useful when it changes what a
developer, engineering leader, agency owner, or finance team does next:

| Question | Decision it supports | Status |
| --- | --- | --- |
| Can this work finish before the reported limit? | Pair available five-hour or weekly windows with reset time, a separately labeled exhaustion projection, and one session action. | **Available** when the coding agent reports the limit metadata; missing windows are never guessed. |
| What work is driving the available usage and cost evidence? | Inspect observed activity and cost evidence by project, model, agent, workspace, user, or client. | **Available** where the source exposes the dimension; coverage gaps stay visible. |
| Who owns it—and did it produce an accepted outcome? | Confirm attribution, then compare attempts, rework, tests, review, and acceptance instead of optimizing for token volume. | **Published in npm v0.9.1:** `identify` records an explicitly confirmed human/team/client/cost-center locally; `outcome github` opt-in verifies a merged PR whose observed status checks all passed. It does not inspect branch-protection rules or claim which checks were required. Business meaning remains user-declared. |
| Which subscriptions and provider charges never reach finance? | Keep local plan context, provider-reported cost, purchased credits, and API-equivalent value separate before reconciling them. | **Partial:** local plan context and optional provider reports exist. Centralized seat and invoice reconciliation is Workspace next. |
| What changed, what needs approval, and did the action work? | Investigate Context Health, model mix, repeats, anomalies, and one bounded recommendation; then compare the next result. | **Published in npm v0.9.1:** Apply drafts candidate-specific inspection, approval, and rollback steps but does not verify a result; `improve` reuses one command for the matched experiment, records the named local self-attested approval before it prints the handoff, and returns progress or the quality-gated result. Shared approval routing and company history remain Workspace work. |
| Can finance defend the ROI? | Join reconciled cost to an accepted outcome and independently evidenced business value before deciding what to scale, constrain, redesign, or stop. | **Next:** the beta does not calculate productivity or ROI. |

aibill's beta establishes the cost-and-capacity evidence: provider-reported
cost, subscription context, API-equivalent value, ownership, coverage, and
what is missing. Company-wide reconciliation, accepted outcomes, approvals,
and ROI are next. ROI additionally requires independently measured monetary
value; spend or token volume alone cannot prove it.

## Why

AI coding cost now mixes several systems. [GitHub moved Copilot usage to AI
Credits on June 1, 2026](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/);
Claude combines shared plan limits with
model-specific usage credits and optional API overages depending on plan.
Those meters run in different dashboards, and local coding-agent usage is also
sitting in logs on your machine. This tool puts the available evidence in one
view, keeps local estimates separate from provider reports, and ranks what to
investigate and how to verify it.

## What you get

- **Fast private initialization**: `npx aibill init` performs one machine-wide
  financial-only transcript pass, labels the selected project as the state
  location rather than the usage scope, prints an honest first receipt, preserves
  existing connected/source state, and writes an atomic aggregate cache for
  lightweight local surfaces. The cache contains no prompts, responses,
  project names, transcript paths, session IDs, or credential references and
  is never trusted as authorization for Report or Apply.
- **Plan-aware Claude Code status line**: an explicitly installed standalone
  runner rereads only that aggregate cache. Metered evidence leads with dollars;
  detected subscriptions lead with transcript-reported five-hour/weekly runway;
  mixed mode keeps cohorts separate. `~` always means API-equivalent value,
  while untilded `billed` money requires verified provider evidence. It shows
  fresh, stale, failed-refresh, missing, and malformed-cache states and ignores
  Claude's session JSON and host-reported limits as financial evidence.
- **Evidence ledger**: provider-reported cost, local API-equivalent value,
  detected subscription context, missing cost, source, freshness, and coverage
  stay visibly separate.
- **Evidence-constrained action plan (public beta)**: on real local evidence,
  `npx aibill apply` turns supported findings into candidate IDs, read-only
  inspection steps, an approval gate, and rollback guidance. Apply itself does
  not run a change or verify a result; the guided `improve` flow adds the
  separate completed-session-snapshot experiment lifecycle described below. Local
  cumulative usage is observed exposure with no invented savings. Connected
  provider buckets, daily aggregates, seats, and user totals stay reconciliation
  evidence—not call-level optimization advice. A modeled routing, cache, Batch,
  or context candidate requires an explicit schema-validated call/invocation
  record plus a named workload. Bundled sample Apply is non-executable.
- **Bounded why/action index**: financial fields are streamed
  independently, while qualitative action evidence reads only complete selected
  Claude Code/Codex files under fixed per-file and per-source byte budgets. A
  private, path-opaque cache accelerates warm runs, and `npx aibill index`
  reads very large agent histories to completion once — with resumable,
  privacy-stripped checkpoints — so results stop saying
  "indexing". Omitted files remain visible
  as partial coverage; they never contribute placeholder values or a global
  “main driver” claim. Exact fully read files may still support a narrowly
  labeled matched experiment.
- **Context inventory and invocation evidence**: shows what is discoverable,
  configured, explicitly always-loaded, hook-injected, unmeasured, or
  invocation-unobservable. Configuration proves availability, not that an MCP
  schema loaded every turn. It says no matching invocation was observed only
  where the host transcript supports that conclusion, and prices overhead only
  where the relevant context size is measurable.
- **Hook-aware Context Health**: `npx aibill context` distinguishes context
  that is merely discoverable, configured, explicitly invoked, or
  injected by an installed lifecycle hook. Hook commands are never executed
  and their runtime payload stays `unmeasured`; the session action prioritizes
  explicit compaction evidence and otherwise compares latest-turn input context
  with comparable local sessions—never cumulative session lifetime totals. Items
  whose host transcript does not expose an invocation event are labeled
  invocation-unobservable and excluded from “no matching invocation” findings.
- **Plan context and comparison**: compares local usage valued at published API
  rates with a plan label detected from whitelisted local account metadata or
  supplied with `--plan`. This is comparison math—not proof of incremental
  spend, remaining entitlement, plan coverage, or the cheapest plan. Reported
  limit windows are shown separately when available.
- **Drill-down**: `--group-by source|model|client|project|agent|user|workspace|apiKey`.
  Local project rows use observed working-directory evidence; unsupported
  activity stays `Unattributed` instead of becoming a guessed project. The
  `Records` column counts day + agent + model + project aggregates, not raw
  API calls.
- **Shareable AI Receipt**: `report-card` writes a redacted SVG (no client/
  project/user names) + a paste-ready caption.
- **Honest confidence labels**: each financial value carries a source and a
  verified / estimated / detected-unverified / missing label. The structured
  contract uses the enum `detected_unverified`.

![Sample AI Receipt — illustrative demo data and modeled opportunities, not provider-reported cost](docs/assets/report-card-sample.svg)

*The shareable AI Receipt (`report-card`) — redacted SVG with illustrative demo
data. Modeled opportunities require verification before they can be called savings.*

## Local estimates and provider reports

Each financial value carries a confidence label. Other displayed metrics retain
their source, basis, or provenance so an estimate is not mistaken for a bill:

| Label | What it means |
| --- | --- |
| `verified` | Official provider-reported cost or usage from an authenticated API/export. Source-authoritative, but not necessarily the final invoice. |
| `estimated` | Local usage priced at published API rates. Comparison math—not a subscription charge or invoice. |
| `detected_unverified` | A local signal was detected but **not** reconciled against billing. |
| `missing` | Usage exists but there's no cost basis to price it. |

Priced financial values calculated from your local **Claude Code, Codex, or
supported Gemini CLI**
session evidence are `estimated` at API-equivalent rates—never `verified`.
The experimental, `fixture_verified` Gemini reader's
complete token splits can be priced, while incomplete or unknown shapes remain
`missing`. Records without a
supported cost basis stay `missing`. Connecting provider billing adds official
provider-reported cost beside the local API-rate estimate. It does not convert a
transcript estimate into an invoice line item.

Connector validation is a separate question from financial evidence quality.
`live_verified`, `fixture_verified`, `untested`, and `failed` describe how the
reader/connector itself has been exercised; they never upgrade an individual
number's financial label. Run `npx aibill doctor --sources` to see both axes,
freshness, and the last locally recorded error for every supported source.
Read-boundary approval is separate again: approving a local folder permits a
read-only scan, but never turns its contents into verified financial evidence.

## Data sources

| Source | What | Validation coverage | Financial evidence when present |
| --- | --- | --- | --- |
| Claude Code logs (local) | Observed transcript usage, priced at published API rates | `live_verified` | `estimated` or `missing`—never billed spend |
| Codex logs (local) | Root-session-aware rollout usage with fork accounting and snapshot deduplication | `live_verified` | `estimated` or `missing`—never billed spend |
| Gemini CLI chats (local, experimental) | Supported `chats/**/*.json` and `chats/**/*.jsonl` token records; `logs.json` is detection-only | `fixture_verified` | `estimated` only for complete recognized token/model evidence; otherwise `missing`—never billed spend |
| OpenAI Costs/Usage API | Admin-gated billing, per project/key | `live_verified` on a non-empty Admin API window; tested Costs total reconciled to invoiced API credits less the provider-UI balance with `$0.00` variance | `verified`, `estimated`, or `missing` by returned endpoint; each user's final invoice remains separate |
| Anthropic Cost Report + Claude Code Analytics | Admin-gated billing/usage, per workspace | `live_verified` on non-empty API records | `verified`, `estimated`, or `missing` by returned row |
| Cursor Admin API | Team spend (Business plan, team admin) | Current official response and pagination fixtures pass; `fixture_verified` beta until live-account QA | `estimated`, `detected_unverified`, or `missing` |
| GitHub Copilot org APIs | Metrics + seats (org/billing admin) | Current official metrics-download and per-seat fixtures pass; `fixture_verified` beta until live-account QA | `estimated`, `detected_unverified`, or `missing` |
| Cursor / Cline / Aider local sessions | Local transcript parsing | `untested` / planned | `missing` until a parser produces supported evidence ([request an agent or provider](https://github.com/futurastudio/ai-spend-agent/issues/new/choose)) |

See the generated [local source-format pages](docs/sources/README.md) for each
reader's discovery boundary, fields used, validation evidence, privacy rules,
and known limitations. The generated [provider financial contracts](docs/sources/provider-contracts.md)
pin each official endpoint, authentication boundary, units, windows, exclusions,
reconciliation anchor, review state, and semantic drift fingerprint.

The August 8 adversarial corpus replay exercised the live-verified Claude Code
and Codex readers. Its Codex
slice produced 25 aggregate rows: 14 supported API-rate estimates and 11
honestly `missing` rows where pricing or token components were insufficient,
with zero false estimated-$0 rows. That is reader-validation evidence—not an
upgrade of any local estimate to billed spend.

**Model price coverage:** local-log estimates use published list prices for
Anthropic, OpenAI, Google (Gemini), DeepSeek, Moonshot (Kimi), and xAI (Grok)
models. Open-weight models (Llama, Qwen, Mistral, GLM) have no canonical
price — hosting rates vary several-fold — so those records are honestly
labeled `missing` rather than guessed. New model out? One pricing rule +
a PR: `packages/core/src/modelPricing.ts`. The bundled table exposes its
`pricingAsOf` date in the Glance provenance contract; the GPT-5.6 rates were
checked against their official OpenAI model pages on 2026-08-13.
GPT-5.6's published long-context tier is applied only from request-level
evidence; ambiguous cumulative aggregates fail closed as `missing`.

## Connect provider cost and usage

Provider APIs are admin/owner-gated, so setup and sync are deliberate steps.
OpenAI and Anthropic Admin API reports can add official provider-reported
cost. Both connectors have non-empty live-API coverage; OpenAI product QA
reconciled the tested Costs total to invoiced API credits less the current
provider-UI balance with `$0.00` variance. User-specific invoices, tax,
discounts, and later adjustments remain separate. Cursor and Copilot match
current official response fixtures but remain beta until live-account QA:

```bash
npx aibill connect openai          # registers a stub; prints the required sync-provider command
npx aibill connect anthropic       # registers a stub; prints the required sync-provider command
npx aibill connect cursor          # fixture-verified beta connector setup
npx aibill connect github-copilot  # fixture-verified beta connector setup
```

`connect` does not fetch billing data. The printed `sync-provider` command makes
the read-only provider request. Credentials are referenced from your local
environment (`--auth-reference env:NAME`). aibill never sits in the inference
path and never stores, prints, or proxies provider credentials.

## Commands

| Command | What it does |
| --- | --- |
| _(no command)_ | Zero-key compact receipt from supported local or trusted connected evidence; otherwise an honest no-evidence state (sample data is never implicit) |
| `init [--path <dir>] [--statusline]` | Detect supported Claude Code, Codex, and experimental Gemini CLI financial evidence, backfill 30 days, print the first private receipt, and atomically seed the Claude/Codex status-line cache; optional `--statusline` is explicit installation consent and sample data is never substituted |
| `statusline` | Render one plan-aware line from the private cache; no scan, provider call, or network |
| `statusline refresh` | Explicitly run the foreground local refresh, then render the cache |
| `statusline install [--replace]` | Reversibly install the standalone Claude Code runner; replacement of another status line requires the explicit flag |
| `statusline uninstall` | Remove only the owned setting and restore the preserved predecessor without rolling back unrelated settings |
| `statusline expand` | Print every subscription with committed price, runways, and 7-day API-equivalent value |
| `quickstart [--sample]` | Same readout; `--sample` forces demo data |
| `connect <provider>` | Register an admin-gated local connector stub and print the required `sync-provider` command; does not fetch billing data |
| `sync-provider` | Pull provider cost/usage through a local `env:` reference; confidence follows the source |
| `context [--project <name>] [--since-days N]` | Human-readable hook-aware Context Health (`--json` emits the canonical contract) |
| `glance [--project <name>] [--plan <id>] [--since-days N]` | Emit the local machine-readable Glance snapshot |
| `apply [--sample] [--since-days N]` | Print a paste-ready, evidence-constrained inspection and approval prompt and save its local artifact bundle under the selected project's `.ai-spend-agent/`; explicit `--sample` is a non-executable, share-safe demo path that does not read live transcripts, account metadata, credentials, or persisted spend state |
| `improve [--sample] [--draft <token>]` | Reuse one guided command to start the best supported reversible token test, persist its pre-change local self-attested approval before printing any agent handoff, record the later application/canary against the same opaque references, show matched-session progress, and calculate a quality-gated result; `--sample` is a labeled guided demo that writes nothing, `--draft` accepts the one paste-safe command an MCP client composed via `draft_improve_command` (APPROVE is always typed by the human), and non-interactive calls do not mutate experiment/accountability state, though the private local evidence cache may refresh |
| `index` | Read very large agent histories to completion with resumable, privacy-stripped checkpoints so results stop saying "indexing" |
| `identify --person … --team … --role …` | Explicitly confirm the accountable human, team, approval role, and optional client/cost center in private project state; none are inferred |
| `outcome github [--pr N] [--business-outcome …]` | **Opt-in network:** ask the installed `gh` CLI for one merged PR with exact commit evidence whose observed status checks all passed, then retain only opaque references and optional user-declared business meaning; branch-protection requirements are not inspected |
| `accountability [--json]` | Answer owner, accepted outcome, local approver, measured token result, and missing bill reconciliation from one private project view |
| `verify inspect <candidate-key>` | **Advanced** (the guided `improve` command normally handles these): resolve the exact fresh local target for the candidate, read-only; stale or unresolvable candidates fail closed |
| `verify start <candidate-key> --quality held` | **Advanced:** freeze the comparable baseline only after the user declares pre-change quality held; returns a stable experiment lineage ID and a separate revision ID |
| `verify mark-applied <experiment-id> --approved-at <ISO-8601> --applied-at <ISO-8601> --canary passed\|failed --change-digest <sha256> --rollback-digest <sha256> --canary-digest <sha256>` | **Advanced:** record user-declared actual approval/application timestamps plus three opaque SHA-256 evidence references; aibill does not invent approval chronology after the canary, and a failed canary produces no percentage and requires a separate rollback |
| `verify rollback <experiment-id> --rollback-digest <sha256>` | **Advanced:** record execution of the same rollback reference frozen at the intervention boundary |
| `verify cancel <experiment-id>` | **Advanced:** invalidate an un-applied baseline while retaining its local audit evidence |
| `verify [<experiment-id>] --quality held\|regressed\|missing` | **Advanced, result (default action):** refresh and calculate the canonical completed-session-snapshot result; missing quality blocks a result, and a complete result is frozen; it never labels a measured percentage as savings, an accepted outcome, or ROI |
| `watch [--interval N] [--cycles N]` | Re-run on an interval, report deltas + anomalies (cron-friendly) |
| `report [--sample] [--path <dir>] [--out <name>] [--since-days N]` | Generate local Markdown + HTML reports and action sidecars under an explicitly narrow project path; for a new demo folder use `mkdir -p ./demo-workspace && npx aibill report --sample --path ./demo-workspace` (a broad home/root path is intentionally refused) |
| `report-card [--sample]` | Your AI Receipt — redacted shareable SVG + caption |
| `scan [--path <dir>]` | Scan a local workspace for AI usage signals |
| `doctor [--sources]` | Check local runtime and safety posture; `--sources` separates connector validation, financial evidence, freshness, and errors |

Run `npx aibill --help` for the full list.

### The guided token-reduction test

This is deliberately a narrow experiment loop, not an automatic optimizer. The
published experience is one stateful command: define an exact reversible
plan, approve it locally before a handoff is printed, rerun after the actual
change and canary, see progress, and read the final result. The later application
must reuse the same opaque change, rollback, and canary references. Raw plan
contents are not persisted. The experience hides evidence hashes without
weakening the canonical audit underneath:

```bash
# Run from the project folder you want to improve.
npx aibill improve

# Practice the full guided flow first on labeled demo data; it writes nothing.
npx aibill improve --sample

# Optional local accountability and accepted GitHub outcome.
npx aibill identify --person "Name" --team "Team" --role "Role"
npx aibill outcome github --pr 123
npx aibill accountability
```

An MCP client can also draft the plan conversationally through the read-only
`draft_improve_command` tool and hand you one paste-safe
`npx aibill improve --draft …` command; every prefilled sentence is labeled by
who wrote it, Enter-accept re-validates it, and APPROVE is always typed by the
human.

The advanced commands remain available for inspection and automation:

```bash
npx aibill apply

# 1. `apply` prints the current candidate key. Inspect it without changing anything.
npx aibill verify inspect <candidate-key>

# 2. Freeze the comparable pre-change cohort after you declare its quality held.
npx aibill verify start <candidate-key> --quality held

# 3. After you approve one reversible change and run its canary, record opaque proof.
npx aibill verify mark-applied <experiment-id> \
  --approved-at <actual-approval-ISO-8601> \
  --applied-at <actual-application-ISO-8601> \
  --canary passed \
  --change-digest <64-character-sha256> \
  --rollback-digest <64-character-sha256> \
  --canary-digest <64-character-sha256>

# 4. Use normally, then label the matched post-change work and calculate the result.
npx aibill verify <experiment-id> --quality held
```

`<experiment-id>` is the stable lineage identifier. Every permitted state
change also produces a distinct `revisionId`; it is not an invitation to edit
the baseline, intervention, or prior cohort. The evaluator requires at least
three comparable Claude Code or Codex completed session snapshots on each side
of the intervention, matched on agent, provider, model, project reference,
session type, work type, and source version when the source reports one. A
session enters that cohort only when its host emits an explicit completion
marker (`Claude` turn duration or `Codex` task completion); inactivity or
transcript age is never treated as completion. One native session can contribute
at most once to an experiment; resuming it later cannot rewrite or become a
second sample in that experiment.

The evaluator preserves token-component evidence instead of silently filling
gaps. Input, output, cache read/write, tool, and thought components are each
marked observed, partial, or not separately reported; its component total is
calculated and any provider-reported total remains distinct. Incomplete,
inconsistent, changed-version, duplicate, or active records are excluded with
reasons. Missing quality is not described as a row exclusion: it blocks the
experiment from producing a result or percentage until the matched completed
session snapshots have user-declared quality. A percentage is only a calculated
change in total tokens per matched session with quality held—not a cash-savings,
verified outcome, or ROI claim. Once an experiment is complete, its baseline,
post-change cohort, and result are frozen; later sessions and later experiments
cannot rewrite it.

If the canary fails, record it with `--canary failed`; no post-change result or
percentage is calculated. Execute the frozen rollback, then record that
separate event:

```bash
npx aibill verify rollback <experiment-id> \
  --rollback-digest <the-same-64-character-sha256>
```

`verify cancel <experiment-id>` is available before an intervention if you
decide not to proceed. The state stays local under `.ai-spend-agent/`; prompts,
raw paths, raw session IDs, and the underlying change contents are not stored
in the experiment envelope.

## Claude Code status line

Installation is explicit and reversible:

```bash
npx aibill init                       # seeds the private cache; changes no Claude setting
npx aibill statusline install         # installs at Claude user scope
npx aibill statusline refresh         # foreground evidence refresh when you want one
npx aibill statusline uninstall       # restores the preserved predecessor
```

Claude rereads the standalone runner on normal status events and at the
configured 30-second interval. That rereads the cache—it does not rescan
transcripts or contact a provider—so the line says `updated`, `stale`, or
`update error` rather than claiming to be live. Run `/status` inside Claude
Code after installation to verify the effective user/project/local/managed
setting sources on that host.

## Choose your interface

All four interfaces share evidence semantics. Terminal, MCP, and Glance also
share parsers and Context Health fields where their sources overlap; the
status line deliberately reads only the aggregate cache those data-producing
paths publish. Their available sources and actions differ: CLI Apply
is an inspection and approval plan, while the guided `improve` flow adds the
matched verification lifecycle; Glance is local-only and Copy creates a current-session
handoff; MCP may also read an explicitly connected provider report.

| Interface | Best for | Command / install |
| --- | --- | --- |
| Terminal | Complete private inspection plus an evidence-constrained AI-client action plan | `npx aibill`, `npx aibill context`, and `npx aibill apply` |
| Claude status line | One cache-only view of runway, metered value/cost, evidence basis, and freshness while coding | `npx aibill statusline install` |
| MCP/plugin | Asking an AI client to explain compatible structured evidence on demand | Install the optional aibill plugin or configure `@agent-finops/mcp` |
| macOS Glance | A hover-only monitor with one focus-aware, copy-to-agent next move | Build the current prototype from `apps/glance-macos` |

Contract tests compare terminal JSON, MCP, and Glance decision fields. Custom
interfaces should render `aibill glance` or `aibill context --json` instead of
adding another transcript parser.

### The most complete workflow

The interfaces work best as one local loop:

1. Run `npx aibill init` once to establish the private cross-agent cache, then
   use `npx aibill` for local Claude Code/Codex usage, attribution, plan
   context, and API-equivalent value. npm v0.9.1 also reads supported
   experimental Gemini CLI financial evidence. Gemini
   does not enter the statusline, Glance, Context Health, or Apply activity
   surfaces.
2. Optionally install `npx aibill statusline install` for cache-only runway,
   financial evidence, and freshness inside Claude Code.
3. Run `npx aibill context` when deciding whether to continue the current
   session or start fresh before a new task.
4. Run `npx aibill improve` when you want the guided experiment: one
   reversible change, an approval you type yourself, and a comparison of
   matched completed session snapshots afterward. The narrower `npx aibill
   apply` prints the inspection/approval plan alone, and the separate `verify`
   lifecycle remains available for automation.
5. Keep the optional macOS Glance companion running for current work, reported
   five-hour/weekly runway, reset or projected exhaustion, freshness, and one
   action. Click its compact action only when you want to copy a project-aware
   handoff into your coding agent.
6. Invoke the optional MCP/plugin only when you want an AI client to explain
   the compatible evidence available to that tool conversationally.
7. Set up and explicitly sync OpenAI or Anthropic only when official
   provider-reported cost is needed; local estimates, subscription context,
   and provider reports remain separate.

Terminal is the most complete private inspection surface, Glance is the
monitor and momentum surface, and MCP is the on-demand explanation layer.
Glance can prepare a safe handoff, but it does not become an always-on prompt
injector or run an agent by itself. None maintains separate usage or Context
Health logic.

## Use it inside an AI client (MCP or optional plugin)

The same engine ships as `@agent-finops/mcp`, so any stdio-compatible MCP
client can read supported local Claude Code, Codex, and experimental Gemini
CLI financial estimates or sync
official OpenAI and Anthropic provider reports through reference-only
credentials. Gemini remains financial-only and `fixture_verified`:

> **AI-client data boundary:** aibill sends no telemetry and does not upload
> transcript contents. The selected MCP result is returned to the AI client
> you configure and then follows that client's data-handling policy.

```bash
npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
```

GitHub Copilot and Cursor connectors are fixture-verified and remain labeled
accordingly until live account QA. See [`docs/MCP.md`](docs/MCP.md) for client
configuration, the ten tools in published `v0.9.1` — including the read-only
`draft_improve_command` that lets an agent draft the improve plan — and the
safety model.

Beta problem? [Report a bug or request an agent/provider
format](https://github.com/futurastudio/ai-spend-agent/issues/new/choose).

Codex users can instead install the thin, explicit-only plugin in
[`plugins/aibill`](plugins/aibill). It exposes the same MCP plus
`$aibill-check`, `$aibill-explain`, and `$aibill-help`. The plugin adds no
lifecycle hooks and no always-on instructions.

## Glance for macOS

The native Glance prototype stays completely hidden until the pointer reaches
the top menu bar, so it does not sit over movies or full-screen video. In the
menu bar, one tiny liquid-glass `aibill` wordmark appears to the left of the
camera/notch. Hover that fixed target—no click required—to slide down
current-session value at API rates, available
five-hour/weekly limits, reset or exhaustion timing, a local transcript-derived
description of the user's main work focus, and one actionable Context Health
and runway decision. The final row shows only a short project-aware label and reason;
clicking it copies a longer handoff prompt for any coding agent, while nothing
runs automatically. Moving
away hides the panel again.

Glance reads the same local Claude Code and Codex transcript metadata as the
CLI. A detected monthly subscription is shown beside the API-rate value so it
cannot be mistaken for incremental spend. Nothing is uploaded, estimates stay
labeled, and each limit window that an agent did not report remains explicitly
unavailable. “Main focus” ranks observed prompt/tool activity rather than cost,
and uses a project, file, automation, or delegated-agent label only when local
evidence supports it. The current app is a source-built prototype;
the public install will be a Developer ID-signed and Apple-notarized Mac
download from the website and GitHub Releases. See
[`apps/glance-macos/README.md`](apps/glance-macos/README.md) to test it locally.

Each Glance field carries its own provenance instead of inheriting one vague
“local” label:

| Glance field | User-specific source | What Glance does |
| --- | --- | --- |
| Session/model/project | Local Claude Code transcript or Codex rollout metadata | Reports the latest observed session |
| API-rate value | Local transcript token counts + published provider list prices | Calculates an estimate locally; never calls it a bill |
| Subscription context | Whitelisted plan claims in the agent's local account metadata, or an explicit `--plan` override | Labels whether the plan was detected or user-declared |
| Five-hour/weekly headroom | Rate-limit metadata embedded by the coding agent in its local transcript | Reports only windows actually present |
| Exhaustion time | Reported headroom + reset time | Calculates a separate local pace estimate |
| Main focus | Local prompt/tool activity | Returns a short activity summary, never raw prompt text |
| Context Health | This user's prior same-agent sessions + local skill/MCP/plugin configuration and transcript invocations | Reuses the canonical CLI/MCP decision; hook commands are not run and hook payload size is not inferred |
| Next move | Canonical Context Health + Main focus + transcript-reported runway | Shows one compact session action and copies a verification-first handoff; it is not the CLI financial Apply plan and never auto-runs an agent |

The machine-readable snapshot includes the same mapping under `provenance`,
including the price-table date and `uploaded: false`, so custom UIs do not
have to infer trust from display copy.

Glance refreshes its local snapshot every 30 seconds while running. The footer
shows the age of the last successful update, changes to stale after 75 seconds,
keeps the last good result visibly labeled if refresh fails, and disables Copy
until a fresh snapshot exists. The local command times out after 75 seconds
instead of leaving a stale panel silently blocked. Launch at
login is available in source builds. Signed Sparkle updates remain disabled
unless a release embeds a valid feed and key; no signed public build exists yet.

The Glance source is MIT-licensed and intentionally editable. Fork it to
change the panel size, placement, visual treatment, refresh interval, or which
fields appear in the hover card. The shared `aibill glance`
JSON contract keeps custom interfaces on the same local, evidence-labeled data
as the CLI and MCP server.

The preregistered 8–12-person comprehension/retention protocol is public at
[`benchmarks/glance-comprehension/README.md`](benchmarks/glance-comprehension/README.md).
Its blank scorecard is not a launch result; broad-distribution claims wait for
real participant sessions and the day-seven follow-up. Mac users can
[volunteer for the Glance preview
study](https://asktilden.com/?ref=github-glance-study#beta); the
current form records interest, not access to a signed download.

## Privacy & trust

- **Local-first by default.** CLI and Glance transcript analysis happens on
  your machine and sends no telemetry. An explicit `sync-provider` call uses
  the inherited credential only with that provider's official API.
- **Explicit MCP boundary.** When you invoke an MCP tool or plugin skill, its
  selected structured result is returned to that AI client and follows the
  client's data policy. The aibill process itself makes no telemetry/upload
  request.
- **No raw secrets.** Keys are referenced from your environment and redacted
  from all output and persisted state.
- **Launch-list signup is the sole, consent-gated exception to "uploads
  nothing".** `npx aibill signup <email>` — and the single optional ask after
  a real receipt — sends exactly one JSON payload,
  `{"email":"you@work.com","ref":"cli-signup"}`, to
  `https://asktilden.com/api/waitlist`, and only after the CLI prints that
  literal payload and you type `y`. Enter always skips; two skips or `n`
  means it never asks again. The decision is stored in `~/.aibill/signup.json`
  (aibill's second home-scope file, next to the statusline cache); a failed
  send is never retried, queued, or persisted. Like any web request, standard
  HTTP metadata (source IP, request headers) accompanies the payload. The
  address is used only for launch updates — the audience policy is written
  down in [`docs/EMAIL_SEND_POLICY.md`](docs/EMAIL_SEND_POLICY.md).
- **Estimates labeled as estimates.** Log-derived financial values with a
  supported price basis use published API rates and are tagged `estimated`;
  unsupported cost bases stay `missing`. Authenticated OpenAI and Anthropic
  cost-report rows can be `verified`; usage, seat, estimated, and unavailable
  rows retain their own evidence labels, and final invoices can still include
  credits, discounts, tax, or later adjustments. Copilot seat-price
  reconciliation and the beta Cursor connector remain `estimated` until
  reconciled against a real invoice.

## Open core, optional Workspace

The CLI, parsers, MCP/plugin, public contracts, generated local action
artifacts, and Glance source are MIT-licensed. Local-only mode remains useful,
free, and private.

**Company direction:** aibill is building the financial accountability system
for the AI-agent workforce—connecting what agents did to what they cost, who
owns it, what outcome it produced, and what should happen next. The planned
Workspace is the paid, permissioned financial teammate over that ledger:
continuous monitoring, spend alerts, a shared team workspace, white-label
client reports, explicit aggregate-only synchronization, provider-invoice
reconciliation, allocation, budgets, approvals, and evidence-backed cost per
accepted outcome where coverage supports it. It will never be required to
inspect a user's own local data.

**[Apply as a Workspace design partner →](https://asktilden.com/?ref=github-readme#beta)**

See the [public roadmap](ROADMAP.md) for the evidence-first sequence and its
explicit non-goals.

## Run from source

```bash
git clone https://github.com/futurastudio/ai-spend-agent
cd ai-spend-agent
npm install
npm run build
node packages/cli/dist/index.js
```

Requires Node.js >= 22.

## License

[MIT](LICENSE) © Futura Studio LLC
