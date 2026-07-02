# Changelog

All notable changes to `ai-spend-agent` (and the `@agent-finops/*` packages)
are documented here. Versions follow [semver](https://semver.org); every
release is tagged `vX.Y.Z` so what npm serves is always reconstructible from
git.

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
