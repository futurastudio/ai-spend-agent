# Changelog

All notable changes to `ai-spend-agent` (and the `@agent-finops/*` packages)
are documented here. Versions follow [semver](https://semver.org); every
release is tagged `vX.Y.Z` so what npm serves is always reconstructible from
git.

## 0.5.7 — Unreleased

MCP provider and local-log hardening.

- Added side-effect-free `--version` / `-v` handling so a standard metadata
  request never falls through to local transcript discovery.

- Added one canonical, hook-aware Context Health contract shared by
  `aibill context`, the `get_context_health` MCP tool, `get_usage_glance`, and
  the native Glance card. The decision is based on same-agent session token
  history, observed activation metadata, and observable invocations—not API
  value or subscription price.
- Context Health inventories installed Claude Code and enabled Codex skills,
  MCP servers, subagents, commands, and hook metadata. It never executes hooks
  or guesses their payload size, and it keeps invocation-unobservable items out
  of “never invoked” findings.
- Added a thin, explicit-only aibill Codex plugin with `check`, `explain`, and
  `help` skills. It delegates calculations to the version-pinned MCP server,
  adds no hooks, and returns the same canonical data as CLI and Glance.
- Added deterministic Context Health fixtures, adapter-drift checks, and a
  public-boundary CI check that blocks internal roadmap, audit, research, GTM,
  environment, and developer-home files from the public repository.
- Context Health now records explicit compaction markers, basename-only
  repeated file-read evidence, cache-write change against prior same-agent
  sessions, and separate parent/subagent transcript coverage. The expanded
  13-case benchmark includes Ponytail-shaped context-hook fixtures and avoids
  treating repeated reads alone as a restart rule.
- Added a Context Health methodology/SEO page and documentation for all three
  delivery surfaces, their shared provenance, known limitations, and the
  difference between local computation and an MCP client's transport boundary.
- `sync_local_agent_spend` now produces real, explicitly estimated reports
  from local Claude Code and Codex metadata.
- `sync_provider_spend` exposes the existing read-only OpenAI, Anthropic,
  GitHub Copilot, and Cursor connectors through strict `env:NAME` references.
  Raw keys are rejected and never persisted.
- `get_usage_glance` now exposes a read-only transcript-derived contract for
  current-session value at API rates, locally detected billing mode,
  provider-reported limit/reset windows, a privacy-conscious description of
  the user's main recent work focus, and one evidence-backed anomaly. Missing
  plan windows remain unavailable instead of being inferred.
- Added one canonical `primaryAction` shared by CLI JSON, MCP, and native
  Glance. It combines Context Health, Main focus, and transcript-reported
  runway into a project-aware label, compact reason, and copy-ready handoff
  prompt. The hover card shows only two short lines; execution is always an
  explicit copy/paste and never automatic.
- Added `aibill glance`, a machine-readable version of that contract for
  local rendering surfaces.
- Added an ad-hoc-signed native macOS Glance prototype: one stationary
  liquid-glass `aibill` wordmark to the left of the camera reveals a
  session/limit, reset/exhaustion, main-focus, and anomaly panel
  on hover. Public distribution still requires a universal Developer
  ID-signed and notarized release bundle.
- Glance now labels the last successful refresh age, turns stale after 75
  seconds, preserves and labels the last good snapshot after an error, and
  provides right-click launch-at-login control.
- Added dormant-by-default Sparkle 2.9.2 integration plus a credential-gated
  universal build/sign/notarize/staple/appcast release script. No source build
  is described as automatically updatable without a real HTTPS feed and EdDSA
  key, and public signing remains blocked on maintainer Apple credentials.
- Published the preregistered 8–12-person Glance comprehension and day-seven
  retention protocol with a blank scorecard; no participant outcome is
  claimed yet.
- Home-launched Codex sessions now use their dominant explicit tool working
  directory for project attribution, so Glance can name the project where work
  actually happened instead of grouping it under `(home)`.
- Glance uses separate trigger and detail surfaces so its single wordmark
  never moves while the card slides down. Its seven-day “Main focus” is based
  on locally observed human prompts and tool activity—not spend—and can surface
  a task, automation, agent, file, or project as the evidence supports. Raw
  prompt text is not included in the Glance contract.
- Removed the redundant metric strip below the camera and the duplicate native
  window/web-preview framing, leaving one clean rounded glass card on hover.
- The `aibill` wordmark now stays fully hidden until the pointer reaches the
  top menu-bar strip, keeping it off movies and full-screen video while making
  the same hover target available on demand.
- Native hosting layers now use the same continuous corner mask as the glass,
  with an inside-only stroke and no external shadow, eliminating square lines
  outside the rounded card corners.
- Balanced the native card's top and bottom insets so session text no longer
  crowds the upper rounded edge.
- Added per-field Glance provenance to the JSON contract and visible card:
  local transcript facts, local API-rate calculations, locally detected plan
  context, coding-agent-reported limits, local activity/history derivations,
  the bundled pricing date, and an explicit no-upload flag.
- Updated GPT-5.2 through GPT-5.6 API-rate rules to current published prices;
  GPT-5.6 Sol no longer falls through to the older generic GPT-5 rate.
- Filtered temporary screenshot-path noise from Main focus summaries so local
  folder fragments do not displace the actual hover/UI topic.
- Subscription users now see their locally detected plan beside session value
  at API rates, making clear that the estimate is not an added charge. Limit
  availability is reported per window, so a missing five-hour gauge explains
  whether only a weekly window was present instead of silently showing a dash.
- The CLI help header now uses the public `aibill` name consistently.
- Provider syncs merge by provider instead of silently replacing the previous
  provider's records. OpenAI and Anthropic were live-verified through stdio;
  Copilot and Cursor remain fixture-verified pending account QA.
- The MCP server reports its actual package version, returns structured tool
  content, carries accurate safety annotations, refuses broad roots on reads
  and writes, and no longer starts as a side effect of a library import.
- Report-backed recommendations replace generic discovery advice when spend
  data exists.
- Fixed a shared analyzer edge case where display rounding on a tiny total
  could produce a workflow share greater than 100%.
- Added protocol-level initialization, tool-list, safe-error, local-log,
  multi-provider merge, credential non-persistence, and cold stdio audits.

## 0.5.5 — 2026-07-28

Launch hardening and public web release.

- Fixed legacy persisted-state routing so `apply` refreshes real local logs
  instead of serving stale or demo-shaped state.
- Added the liquid-glass aibill landing page, Glance interaction prototype,
  technical SEO, corrected provider claims, and current comparison pages.
- Pinned the production dependency tree, added CI/security gates, coordinated
  package versions, and published all five npm packages.

## 0.5.4 — 2026-07-20

**The shareable report now looks like the product: a terminal.** Its own
design system replaces the borrowed agency CSS — dark terminal window with
title-bar chrome, monospace, green/cyan accents, a giant value-multiple hero,
stat cards, gradient share bars, dead-context chips — and the sections are
the loop itself: WHAT HAPPENED → WHY → FIX → VERIFY. ~10KB, one screen,
zero paragraphs of filler.

## 0.5.3 — 2026-07-20

Field testing caught a state-poisoning bug in `watch` — fixed at the root,
plus defense in depth and a new invariant test suite so this class can't ship
again.

- **`watch` no longer mislabels data.** It stamped everything it persisted as
  `connected_provider`, so after one watch run the quickstart claimed
  "connected provider billing" over local-log data and `report`/`apply`
  routed to the agency artifacts (the generic identical per-project
  recommendations). Watch now follows the same freshness rule as every other
  command (fresh local-log read; provider records only when they exist) and
  persists the TRUE mode.
- **Defense in depth:** persisted `connected_provider` state is only believed
  if its records are actually provider-sourced; mislabeled local-log records
  are superseded by a fresh read everywhere (quickstart, report, apply).
- **Watch cycles are compact now** — delta headline + focused table, not the
  full four-stage readout repeated every cycle.
- **`--group-by` without a dimension errors with usage** instead of silently
  printing the full readout; `sync-provider`'s error shows a complete example
  command.
- **New command-sequence invariant suite**: realistic multi-command runs
  against shared state assert that data-mode labels can never lie, totals
  agree across back-to-back commands, and agency framing can never leak into
  local-log artifacts — including a regression test that replays the exact
  poisoned-state bug.

## 0.5.2 — 2026-07-19

Model-price coverage beyond Anthropic/OpenAI.

- **New pricing rules** (published list prices): Google Gemini 2.5
  Pro/Flash/Flash-Lite, DeepSeek chat/reasoner (v3/r1), Moonshot Kimi K2,
  xAI Grok 4/3/3-mini. Local logs that ran these models now price instead of
  reading `missing`.
- **Open-weight models stay honestly unpriced**: Llama/Qwen/Mistral/GLM have
  no canonical price (hosting rates vary several-fold), so they remain
  `missing` by design — documented in README, one-line PRs invited for new
  models.
- README states transcript-parser coverage honestly (Claude Code + Codex
  today; Cursor/Gemini CLI/Cline/Aider planned, parsers welcome).

## 0.5.1 — 2026-07-09

Apply-prompt hardening, pre-validated before the first real coding-agent run.

- **Every dead MCP server now names its owning project(s)** ("used by
  projects: ~/pitcht.com, ~") so the executing agent knows exactly where
  `claude mcp remove` must run — no discovery step, no wrong-cwd fumble.
- **The approval gate forbids instead of requests**: "do NOT use any
  file-editing or shell tool until I approve" replaces "show me the removals
  before applying" — prohibition binds agents harder than description.
- Rollback instruction now tells the agent to read the current config block
  first so removals can be restored verbatim.

## 0.5.0 — 2026-07-06

**The HTML report is now actually shareable.** For local-log users it was a
44KB agency board pack: five copies of retired workflow advice, three
"unmapped" enterprise-attribution blocks, savings from a third engine that
disagreed with the readout — and no dead context, no detected plan, no value
multiple.

- **Compact share-first report** for local-log data (~¼ the size): hero with
  the value multiple ("Covered by Claude Max 5x — ~11.8× the plan price"),
  headline metrics, TL;DR, by-project + by-model, dead context with named
  items, the deduplicated cut list, plan check, and a "reproduce this: `npx
  aibill`" footer. Every number from the same engines as the terminal readout.
- The agency board report remains for connected/mapped data.
- Regression test asserts agency framing (unmapped-client, margin risk,
  retired workflow advice) can never leak into the shareable report.

## 0.4.4 — 2026-07-05

One freshness rule everywhere.

- **`report`/`apply` now re-read local logs fresh, always.** They previously
  preferred the persisted snapshot from a prior run, so the artifact's numbers
  could lag the readout's (42 vs 47 session-days in field testing). Local-log
  state is now treated as a cache; persisted state stays authoritative only
  for connected/sample data. Regression test: a transcript added between two
  `report` runs must appear in the second.
- Every suggested command now says `npx aibill` (VERIFY, Next, report hints,
  error messages) — the long form remains as a footnote in APPLY.
- "1 session-days" plural bug fixed in the artifact's why-lines.

## 0.4.3 — 2026-07-05

Digestibility: decide in five lines whether to read sixty.

- **TL;DR block** opens every local-log readout: your value multiple (+ limit
  pressure), the top-burner project, and the one action (`npx aibill apply`) —
  each traceable to a section below.
- **Plan-check lines no longer wrap badly**: fact-dense headlines split into a
  short lead + dim continuation for narrow terminals.

## 0.4.2 — 2026-07-05

**The apply artifact now says what the readout says.** For local-log users it
was generated by a different engine (agency workflow-watch) than the readout's
cut list — generic "budget cap / cheaper tier / cache inputs" advice a coding
agent can't act on, with "unmapped-client" noise, conflicting savings numbers,
and none of the dead-context findings.

- **Local-log apply artifact rebuilt from the readout's own engines**: the
  cut list + the NAMED dead-context items with their config paths ("remove
  mcp server \"context7\" (configured in ~/.claude.json) — `claude mcp
  remove context7`"), heavy-context guidance, config-only constraints,
  explicit rollback per removal, and the `npx aibill` verify step. Roughly a
  quarter of the old length.
- The agency workflow artifact remains for attributed (connected/mapped)
  data, where clients and projects are real.
- `DeadContextItem` now carries the config `path` it was loaded from.

## 0.4.1 — 2026-07-05

**The short command is `npx aibill`.** npm's typosquat protection blocked the
0.4.0 alias names (`aispend`/`aireceipt` are too similar to the pre-existing
`ai-spend`/`ai-receipt` packages, which are not ours) — and the 0.4.0 readout
briefly pointed at the unpublished `aispend`. Hotfix:

- **`aibill`** alias package published (both `aibill` and `ai-bill` were
  free, so the similarity rule cannot bite): a 4-line wrapper over `runMain`.
  "Check your AI bill: `npx aibill`."
- Readout APPLY step and README now say `npx aibill apply` / `npx aibill`.

## 0.4.0 — 2026-07-05 (cli/core/report only — alias packages never published)

- **`apply` command** — short form of `apply-artifact`.
- `runMain()` exported from the CLI so alias bins run the exact same
  entrypoint. CI smoke-tests the alias bin against the built CLI.

## 0.3.0 — 2026-07-04

**Subscription-first.** The launch audience is engineers on Claude Max /
ChatGPT plans — for them the dollars are counterfactual (they pay flat), so
the readout now leads with what the plan buys, not what the tokens would cost.

- **Value-led header** for detected subscription users: `COVERED BY Claude
  Max 5x ($100/mo) — you're getting ~10.6× what you pay`, with DIAGNOSE
  reframed as "what your subscription actually buys you" and RECOMMEND as
  "frees up plan headroom".
- **By-project is the default table for local-log users** — "which project
  burns my plan" is the flagship question; `--group-by model` still available.
  Demo/connected modes keep by-model.
- **Hard limit-pressure evidence**: Claude Code records when extra-usage
  credits run out (`cachedExtraUsageDisabledReason`); the plan check now
  surfaces it — "your local config shows extra-usage credits exhausted — you
  ARE hitting your plan's limits" — turning the upgrade/trim advice from
  hypothesis into fact.

## 0.2.2 — 2026-07-04

Field-testing fixes: drill-downs answer one question; artifacts are usable in
the terminal.

- **Explicit `--group-by` renders a focused view** — headline, the requested
  table, its definition, and the data window ("window: 14 days of data
  (2026-05-21 → 2026-07-04)") — instead of repeating the entire four-stage
  readout around one table.
- **`apply-artifact` prints the paste-ready prompt inline** ("copy everything
  below into Claude Code / Codex") instead of only listing file paths;
  `report` now ends with open/read hints (`open report.html`, `less
  report.md`).
- Fixed a 0.2.1 regression: state persisted by `report`/`apply-artifact`
  (`local_logs` mode) no longer triggers the misleading "Ignored persisted
  sample/legacy state" warning on the next quickstart run.

## 0.2.1 — 2026-07-03

Field-testing fixes: the APPLY→VERIFY loop now works end-to-end for quickstart
users.

- **`report` and `apply-artifact` work right after a first run.** Both fell
  over with "No local spend state found — run scan --sample" for every npx
  quickstart user (the quickstart persists nothing, and suggesting sample data
  to a real-data user was the worst possible advice). They now fall back to
  the same live local-log read as the quickstart (never sample), persist it as
  `local_logs` state, and the empty-machine error says what to actually run.
- **Sub-$1/mo cuts collapse into one summary line** (still counted in plan
  math and included in the apply artifact) — no more near-duplicate noise.
- **By-project accuracy polish:** sessions launched from the home directory
  are labeled `(home)` instead of your username, and the project table states
  its definition ("project = the folder the session ran in").

## 0.2.0 — 2026-07-02

**The tool now knows who it's talking to: local plan detection + persona
framing.** Consumer subscriptions have no billing API — but the coding agents
already did their own OAuth and persist what they learned on disk, next to the
transcripts we already read.

- **Real plan detection** (`@agent-finops/core` `detectLocalPlans`): Claude
  Max/Pro tier from `~/.claude.json` (`oauthAccount.organizationRateLimitTier`
  etc.) and ChatGPT plan from `~/.codex/auth.json` (local id_token claims).
  Read-only, whitelisted fields only — token values are never read into
  results; no network, no account access.
- **Plan check speaks in facts, not guesses**: "you're on Claude Max 5x
  ($100/mo, detected locally): ~10.6× the plan price in usage" — and warns
  when projected usage runs past what the detected tier typically covers,
  with the honest ordering (trim context first, upgrade second).
- **Persona framing**: a PLAN line up front for subscription users; the
  headroom-not-cash caveat now keys off the *detected* plan; unknown
  tiers/plans are named honestly without invented prices.
- **`--plan <id>` override** for setups detection can't see
  (claude-max-5x | claude-max-20x | claude-pro | chatgpt-plus | chatgpt-pro);
  invalid ids list the valid ones. `doctor` reports detected plans.

## 0.1.5 — 2026-07-02

Field-testing fixes for the npx-first audience.

- **Every suggested command is `npx`-prefixed.** The APPLY step told npx users
  to run `ai-spend-agent apply-artifact` — a guaranteed "command not found"
  for anyone without a global install. All readout commands now work on both
  install paths (regression-tested: no bare `ai-spend-agent <cmd>` can ship).
- **Plan check answers "am I getting my money's worth?"** — when a plan covers
  your usage it now shows the value multiple ("You're getting ~5× the plan
  price in usage").
- **Honest savings framing on flat-price plans.** When a subscription covers
  the usage, the cut list says so: cuts buy rate-limit headroom and faster
  sessions, not cash — they become cash the day you pay per token.
- Dead-context MCP hint no longer points at `connect` (which cannot size MCP
  token weight); the honest lever is removing unused servers from `.mcp.json`.

## 0.1.4 — 2026-07-02

Readability + accuracy release from first real-user field testing. No new
commands.

### The readout is now the loop the product sells
- The terminal summary is structured as four numbered stages — **1 · DIAGNOSE**
  (spend, dead context, plan check, breakdown table) → **2 · RECOMMEND**
  (ranked cuts) → **3 · APPLY** (`apply-artifact`: a ready-to-paste prompt for
  your coding agent) → **4 · VERIFY** (re-run / `watch` deltas, then optionally
  connect verified billing). Apply and Verify existed but were invisible on the
  first-run path.

### Accuracy for coding-agent data
- **No more "cache repeated calls" advice for interactive sessions.** Local
  agent-log records are day-level session aggregates sharing one operation
  label; that is aggregation, not repetition, so the result-cache cut (and the
  matching report recommendation) no longer fires on them.
- **Session aggregates are called what they are.** Headline and cut-list
  grounding lines say "session-days", not "calls", for local-log data; the
  context-trim cut for coding agents now names the real levers (dead context,
  lean CLAUDE.md/AGENTS.md, no whole-directory context pulls).
- **Every monthly projection states its basis.** Plan-check headlines say
  "projected from N active days" so they can't be mistaken for the calendar-
  window projection shown in the cut list.
- **Subscription transparency.** The plan check now states it compares
  published list prices and that the tool never sees or connects to your
  subscription account (subscriptions have no billing API — that's why local
  logs are the source). Tiny real amounts render as `<$0.01`, not `$0.00`.

## 0.1.3 — 2026-07-02

Launch-hardening release: precision, reliability, and safety fixes ahead of
the public launch. No new commands.

### Honest numbers
- **Removed all undocumented savings multipliers.** Every "estimated
  savings/impact" figure now derives from documented, round planning ratios in
  `analyze.ts` (`impactRatios`), aligned with the per-model economics already
  documented in `cutList.ts`. Headline effect: workflow-watch savings are now
  `spend × 0.20` (was an unexplained `× 0.236875`).
- **Completeness labels are derived, never hardcoded.** A provider result is
  labeled by the weakest cost-bearing record it contains: GitHub Copilot seat
  reconciliation and the beta Cursor connector now report `estimated` (they
  were wrongly stamped `verified`). README updated to match.
- **Sample dead-context never appears on a real readout.** The illustrative
  "29 of 38 tools dead" card is demo-mode only; a real readout with a clean
  setup gets an honest "none found" line instead.

### Reliability
- **Scans no longer crash on messy filesystems.** Dangling symlinks,
  permission-denied directories, and unreadable files are skipped and reported
  (`unreadablePaths`) instead of rejecting the whole scan; the CLI entrypoint
  now prints a friendly, secret-redacted error instead of a raw stack trace.
- **Provider fetches retry transient failures.** 429/5xx responses are retried
  with `retry-after` honored; a mid-pagination or mid-date-range failure
  returns the pages already fetched with an explicit QA note instead of
  discarding everything.
- **Response-drift QA is now meaningful for all four providers.** Known-field
  maps added for Anthropic (cost + Claude Code), GitHub Copilot (metrics +
  seats), and Cursor — legitimate fields no longer flood
  `provider-records.json` with thousands of false "drift" entries.
- **`audit-log.json` is capped** at the last 500 events (same pattern as
  watch history).

### Safety
- **MCP `scan_ai_spend` now enforces the same unsafe-root guard as the CLI**
  (shared `@agent-finops/core` implementation): scans of `~`, `/`, ancestors
  of home, and system directories are refused on every surface.
- **Secret redaction widened** beyond `sk-*`: GitHub tokens (`ghp_`,
  `github_pat_`, `gho_`…), JWTs, Google `AIza…`, Slack `xox…`, AWS `AKIA…`,
  GitLab/npm tokens, and any `*_KEY`/`*_TOKEN`/`*_SECRET`-style assignment are
  now redacted in discovery evidence, persisted state, and CLI error output.

### Release engineering
- **CI added** (GitHub Actions): typecheck, 166-test suite, build, and a
  built-bin smoke test on every push/PR, plus a waitlist-app build and
  `npm audit` job.
- **`prepack` build hooks** in all publishable packages — `npm publish` can no
  longer ship a stale `dist/`.
- **`engines.node >= 22`** declared in every published package (not just the
  CLI). Unused `picocolors` dependency dropped from the CLI. Duplicate
  `--group-by` parser branch removed; `--confidence` now rejects
  non-numeric/out-of-range values instead of rendering `NaN%`.

## 0.1.2 — 2026-06-29 (git only, never published to npm)

- Record-level savings dedup (`savingsMath: "deduplicated"`) so overlapping
  cut-list items no longer double-count the same spend.
- Persisted data-mode tagging + DATA MODE banner: prior `scan --sample` state
  can never be re-served as if it were real or connected data.
- `reset` command, launch-grade `doctor` diagnostics, symlink-safe bin
  detection, runtime Node >= 22 guard.
- Dead-context pricing made count-led and measured-only (documented accuracy
  contract).

## 0.1.1 — 2026-06-15

- Initial public release on npm: instant zero-key demo, Claude Code / Codex
  local-log ingestion, OpenAI/Anthropic/Copilot/Cursor connectors, ranked cut
  list, AI Receipt SVG report card, MCP server (unpublished), waitlist app.
- Fixed npm-installed CLI not being runnable (stale `dist/` in the published
  tarball).

## 0.1.0 — 2026-06-14

- Internal pre-release of the local-first CLI.
