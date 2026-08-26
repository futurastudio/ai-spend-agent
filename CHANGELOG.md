# Changelog

All notable changes to `ai-spend-agent` (and the `@agent-finops/*` packages)
are documented here. Versions follow [semver](https://semver.org). Public
release tags identify the Git source for tagged npm releases; 0.5.6 is the
historical untagged exception.

## 0.9.6 — 2026-08-26

Two things ship together: your Codex spend is now counted on a corrected
basis, and the report you read it in stopped contradicting itself.

### Your Codex total changed, and you deserve the whole story

If you run Codex, the number this release shows you is different from the
one 0.9.5 showed — and the honest account of why has two parts, because we
got it wrong twice before getting it right.

- **0.9.5 undercounted you.** Codex writes one running total per session,
  and a long session's cached prompt made that total look larger than any
  single request the model actually priced. Rather than guess, aibill
  refused to price those sessions at all — it voided them. That is the
  safe failure, but it is still a wrong answer: real spend was quietly
  missing from your total, and the sessions most likely to be voided were
  the expensive ones. Sessions are now tiered from the largest single
  request they contain, which is evidence the transcript already carries,
  so cache-heavy sessions get priced instead of dropped.
- **Our first fix then overcounted forked sessions.** When you fork a Codex
  session, the child transcript replays the parent's entire history before
  its own work begins. Priced naively, that replay is billed twice — and
  three times down a fork chain. On our own corpus one forked session
  carried 1.26B cumulative input tokens of which 95.9% was replayed parent
  history; it was priced at $669.26 when its true cost was $29.05. The
  arithmetic was right and the basis was wrong, which is the more dangerous
  of the two failures, because an overstatement reads as confidence.
- **What ships is the corrected basis.** Forked sessions are now charged
  only for work that happens after the replayed history ends. On the
  corpus we test against, 5 of 352 sessions were forks; the 30-day Codex
  total settles at $2,299.79, down from the $4,187.54 the intermediate fix
  would have reported and up from the voided-session undercount before it.
  If your total moved between 0.9.5 and 0.9.6, this is why.

Caches and checkpoints written by earlier versions are discarded rather
than reused, so no fork-inflated amount survives the upgrade. Sessions on a
model we have no published rate for — `codex-auto-review`, for one — still
report as honestly missing rather than as zero, and the report says so.

### The statusline and the receipt now agree

The statusline, Glance snapshot, and macOS Glance priced sessions through a
different code path than the receipt did, and that path had not been
updated — so it kept voiding sessions the receipt had priced. Every surface
now prices from the same evidence, verified across 348 real sessions with
zero disagreements. If your statusline and your receipt ever showed you
different money for the same work, they no longer can.

### Corrected OpenAI rates

- OpenAI pricing correction. `gpt-5.6-sol` carried GPT-5.5's rates
  ($5.00/$0.50/$30.00) instead of its own published $4.00/$0.40/$20.00, so
  every Codex record on the default OpenAI model was overstated by 25% on
  input and 50% on output; the long-context leg moved $10/$45 → $8/$30.
  `gpt-5.6-terra` and `gpt-5.6-luna` were already correct and are unchanged.
  Added `gpt-5-nano` ($0.05/$0.005/$0.40), which had been falling through to
  the `^gpt-5` fallback at 25x its real rate, and the published >272K
  long-context tiers for `gpt-5.5` and `gpt-5.4`. Rates verified twice
  against developers.openai.com/api/docs/pricing and each model's own doc
  page (2026-08-25).
- Rule ordering hardened, same doctrine as 0.9.4's Kimi fix: the GPT-5.6/5.5/
  5.4 rules are end-anchored and the `^gpt-5` fallback no longer crosses a
  dot-minor boundary, so an unverified or future sibling (`gpt-5.7-sol`,
  `gpt-5.6-cyber`, `gpt-5.6-<newvariant>`) reports honest "missing" instead
  of silently inheriting a neighbour's price.

### The report and the screen tell the same story

- `npx aibill report` run from your home folder wrote an artifact whose ACT
  and VERIFY sections were empty while `npx aibill --full`, run from the
  same folder in the same minute, showed real ranked recommendations. Two
  builders had drifted apart; there is now one. Both surfaces read the same
  records and rank the same candidates in the same order, and both disclose
  what could not be read. The "transcript coverage" gate now applies only
  to the sections that genuinely come from transcripts (Context Health and
  dead-context) instead of suppressing recommendations that never needed it.
- Degradation messages no longer describe our internals to you. Lines like
  "no action candidate is emitted because qualitative indexing is unknown"
  told you nothing you could act on; every gap now names the next step and
  the command that closes it. Swept across every artifact, including the
  shareable demo package.

### Every printed command runs where it was printed

- We harvested all 30 commands the CLI prints as next steps across 26
  surfaces and ran each one from the directory that printed it. Four
  failed: `npx aibill init` from the sample screen, `npx aibill apply` from
  the HTML report footer, `npx aibill improve` from `index`, and
  `npx aibill statusline refresh` from `statusline expand` — which also
  reported its own deliberate safety check as if it were a crash. All four
  now carry the `cd` they need or speak in the guard's voice. This is
  pinned as a class: the test re-harvests and re-runs every printed command
  on each build, so a new surface with a bad pointer fails immediately.
- Padding in next-step lists was being collapsed by the text sanitizer, so
  `npx aibill report        write a shareable report` reached you with the
  boundary between command and description gone. Next steps are structured
  now and the gap is rebuilt after sanitization.
- Windows: commands were quoted with POSIX single quotes, which `cmd` passes
  through literally, so the printed command named a file that did not
  exist. Quoting is per-platform now, and `start` no longer swallows the
  file path as a window title.

### Smaller fixes

- `npx aibill report-card` now opens your receipt instead of leaving you to
  find the file. It opens a small companion HTML alongside the SVG, because
  platform openers frequently route `.svg` to a text editor — the `.svg`
  remains the canonical shareable file and the companion adds no data of
  its own. Same suppression rules as `report` (`--no-open`,
  `AI_SPEND_NO_OPEN=1`, non-TTY, CI, SSH).
- The shareable caption no longer copies its own UI label to your clipboard.
- The no-evidence screen offers `--sample` first, so a first run with
  nothing to read has somewhere to go.
- Contrast fix: the faint text tier failed AA at 4.07:1 while carrying the
  honesty line about estimates. It passes now.
- `report-card --out` no longer silently overwrites a second file.
- Backticks in report prose render as code instead of printing literally.
- Four internal guards that could not fail — a canary greping an empty
  directory, a coverage test whose fixtures were all complete, a
  case-sensitive assertion against differently-cased output, and a parity
  test asserting order over a single-element list — were rebuilt and each
  verified to fail against the bug it is meant to catch.

## 0.9.5 — 2026-08-25

Terminal polish from direct founder feedback ("really hard to read… I wonder
if we can have the text aligned"). Display-only: no change to data, math,
scanning, or file contents.

- Aligned `report` and `report-card` terminal summaries: both now render in
  the receipt's visual language — a proper header, one shared label column
  (Scope/Path · Markdown · HTML · Total · Privacy; Receipt · Data ·
  Privacy), dot separators, and a Next block whose commands pad to one
  shared description column instead of drifting per row. Long paths never
  wrap mid-path (descriptions drop gracefully below), and narrow terminals
  (<58 columns) stack label over value like the receipt does.
- De-duplicated the receipt caption: when observed value and observed
  exposure agree within rounding noise (≤ $0.05 — sub-cent per-action
  rounding put $2,281.89 next to $2,281.87 on a live card), the caption and
  the SVG card print ONE number with combined phrasing ("effectively all of
  it exposure to investigate"). Genuinely different figures keep both
  numbers, and "savings unavailable without a matched counterfactual"
  survives verbatim.
- Broad-root pointers, same doctrine as 0.9.4: a `--full` readout printed
  from a broad root now cd-prefixes its project-scoped pointers
  (`cd <project> && npx aibill apply …`, apply-artifact, watch, connect)
  instead of advertising bare commands that friendly-refuse right where
  they were printed. Project folders keep the bare forms.
- Explicit `--path /` or `--path /etc` on report/report-card now gets the
  friendly guard voice up front ("…writes its report files into the folder
  it points at") instead of dying at write time with a wrapped raw error
  (`EROFS`, "Refusing to use /etc…"). Home keeps running machine-wide; an
  explicit absolute `--out` elsewhere still works.
- `npx aibill report` now opens the HTML report in your browser
  automatically (darwin `open`, linux `xdg-open` when present, win32
  `cmd /c start`), fired detached so a missing or slow opener can never
  crash, hang, or delay exit. Escape hatches: `--no-open`,
  `AI_SPEND_NO_OPEN=1`, and automatic suppression when stdout is not a
  TTY, in CI, or inside an SSH session — the summary then keeps the plain
  `open <path>` pointer, and only a genuinely fired opener prints "opened
  … in your browser". report-card is unchanged (SVG openers are
  inconsistent across platforms).
- Brand-aligned artifact palette: report.html and the receipt SVG now wear
  the landing's warm green-black token family (ground `#0C0D09`, green
  `#4CC98A` for command affordances, receipt amber `#C9A24B` for estimated
  money, white-alpha hairlines, neutral bar fills, tabular-nums, no
  shadows, no macOS traffic dots) instead of the off-brand cool blue-black
  + cyan and indigo grounds. Display-only: every number, label, and
  section is unchanged.
- Caption equal-case threshold hardened to integer cents so the exact-5¢
  boundary is deterministic at every magnitude (a float diff let
  $20.05/$20.00 keep both figures while $100.05/$100.00 collapsed).
- Security (report auto-open, Windows): closed a command-injection hole in
  the browser opener. The earlier win32 opener (`cmd /c start "" <path>`)
  passed the report path through cmd.exe, which re-parses `& ^ % ( ) < > |`
  even with `shell:false`, so a space-free path like `C:\code\proj&calc`
  (all legal filename characters, reachable via the cwd-derived
  machine-wide path or an absolute `--out`) could execute an arbitrary
  program and `%VAR%` could expand. Two independent defenses: auto-open now
  refuses any path containing a cmd metacharacter or quote on every
  platform (falling back to the plain `open <path>` pointer), and the win32
  opener no longer uses a shell at all — it opens via
  `rundll32 url.dll,FileProtocolHandler` with a discrete argv. darwin and
  linux were unaffected and stay unchanged.
- Brand retint follow-up: the receipt SVG's neutral text inks (previously
  blue-tinted periwinkle) now match the warm white-alpha ink/muted/faint
  ladder; a color-only swap with sizes and positions untouched.

## 0.9.4 — 2026-08-25

Pricing correctness for Kimi (official list rates as of 2026-08-25), and
report/report-card from anywhere.

- `npx aibill report` and `npx aibill report-card` now RUN from your home
  directory (or any broad root) instead of refusing: machine-wide mode uses
  the exact read-only transcript scanning the bare receipt uses, creates no
  project state, and writes the artifacts to the current directory
  (`./ai-spend-report.md`, `./ai-spend-report.html`, `./ai-receipt.svg`).
  These commands render machine-wide content anyway — the exact-project
  requirement was incoherent, and the receipt's own Next pointer walked
  people straight into the refusal. Project folders behave exactly as
  before; genuinely project-scoped commands (improve, apply, verify, watch,
  connect, reset) keep the guard.
- Display fixes from founder live-testing: overflow "+N more" rows now
  compute their amount as the displayed total minus the displayed rows, so
  every column reconciles to its header by construction (rows could sum a
  penny off); a plan-price multiple below 1x renders two decimals
  ("~0.05×"), never "~0×".
- Local dev hygiene: every script that spawns the real built/packed CLI
  (smokes, MCP audits, statusline benchmark, demo recording) now hard-sets
  the telemetry kill-switches, so local runs can never emit phantom
  installs into production counts.

- Fixed a silent mispricing: `kimi-k2.7-code` (and `-highspeed`) matched the
  legacy K2 rule by prefix and was priced ~40% low ($0.60/$2.50 instead of
  the published $0.95/$4.00). The legacy rule now matches only the models it
  is true for (`kimi-k2`, `kimi-k2-*`, `moonshot-*`).
- Added verified list rates from platform.kimi.ai: `kimi-k3` ($3/$15,
  cache-hit $0.30 — also matches the `kimi-k3[1m]` context-suffix form),
  `kimi-k2.7-code` ($0.95/$4, hit $0.19), `kimi-k2.7-code-highspeed`
  ($1.90/$8, hit $0.38), `kimi-k2.6` ($0.95/$4, hit $0.16).
- Deliberately NOT added, staying on the honest unpriced path: first-party
  Qwen commercial rates (the canonical price list is console-gated;
  aggregator numbers have been wrong for this family) and `deepseek-v4-*`
  (published rates are time-of-day — flattening them would be wrong by up
  to 2x; deferred to timestamp-aware pricing). Unknown models keep
  rendering labeled and unpriced, never guessed.

## 0.9.3 — 2026-08-25

The founder-test patch: fixes from the first production run of 0.9.2 and the
cold-start audit, all in the first-five-minutes path.

- Fixed the consent step so it can never be answered by a buffered keypress.
  In 0.9.2 the Enter that had just submitted your email could land on the
  consent question the instant it armed and silently decline it — no outcome
  line, nothing sent, no way to tell. The consent read now drains all
  buffered input, renders its line exactly once, waits for a fresh
  deliberate keypress, and ALWAYS ends with an outcome line: either
  `sent: exactly that JSON · nothing else in the payload` or `nothing sent`.
- Every command aibill's output tells you to run is now the npx form
  (`npx aibill telemetry off`, not `aibill telemetry off`) — npx users have
  no bare `aibill` on PATH.
- Every project-scoped command run from a too-broad folder (home, root, a
  system directory) now explains itself the same friendly way: which exact
  project folder to stand in, with nothing read, created, or changed. In
  0.9.2 ten commands leaked the raw refusal — four of them dressed as an
  "unexpected error" with a file-an-issue link. The machine-wide receipt
  also stopped pointing at project-scoped commands without saying where to
  stand.
- First runs no longer poison `~/.aibill`: home state is created private
  (0700), a 0.9.2-poisoned directory that holds only aibill's own state
  files self-heals, and the remaining `init` refusal names the exact path
  and the one-line rescue. The `npx aibill` → `npx aibill init` funnel now
  works on a fresh machine with a default umask.
- The email ask is calmer under real fingers: Ctrl-D/EOF renders the receipt
  like every other skip, a rapid double-Enter skip counts as the one
  lifetime skip instead of dying as "pasted input", and the receipt-ready
  notice renders on its own line.
- Five near-identical recommendations ("only the amount changes") now
  collapse into one grouped entry with per-project amounts; genuinely
  different suggestions keep their own ranks.
- The shareable receipt caption only quotes figures the card itself renders,
  recomputed from the same data — a sample caption used to cite an exposure
  number no other surface showed.
- `glance` (the menu-bar app's ~30s machine poll) never emits telemetry
  events — it is not a human command, and counting it was pure noise.

## 0.9.2 — 2026-08-24

The Friday launch build: the funnel, the analytics, and the last truth fixes.

- Added the one-time launch-list ask. On a first interactive run, while
  aibill reads your evidence, it asks once: type your email for launch
  updates, or press Enter to skip. Before anything is sent you see the
  LITERAL payload — `{"email","ref"}`, nothing else — and confirm with a
  typed `y`. Deliverability-checked (MX lookup + disposable-domain screen),
  one lifetime ask, `npx aibill signup <email>` for the deliberate path,
  and the receipt renders no matter how the ask ends.
- Introduced disclosed, anonymous usage counting — default-on, notice-first.
  aibill counts which commands run: never your content, paths, arguments,
  or anything joinable to an email. The three-line notice prints BEFORE the
  first event ever fires (run 1 sends nothing); `npx aibill telemetry off`
  switches it off, DO_NOT_TRACK / CI / AI_SPEND_NO_TELEMETRY hard-disable
  it, and `npx aibill telemetry` shows the exact last payload verbatim.
  Every "nothing uploaded" line swaps to a disclosure line while counting
  is active, so no surface ever claims less than what leaves the machine.
  Delivery is a detached one-shot child: the CLI never waits on it.
- Connected reports keep both bases in report.md/html too: provider-billed
  and local API-equivalent figures stay separate, never a blended total.
- Truth fixes from launch-week QA: `--help` reflects published commands,
  every printed NEXT command runs as printed, Copilot AI-credit billing
  reflected in source status, seat dedupe, Cursor "Enterprise teams",
  neutral demo names, and npm `funding` metadata on all packages.

## 0.9.1 — 2026-08-20

The agent-native loop: your coding agent is now a first-class participant in
the improve loop — it drafts, you approve.

- Added agent-drafted experiments. The new read-only MCP tool
  `draft_improve_command` (the tenth tool) lets an agent propose and refine the
  change/rollback/canary plan conversationally, then hand over ONE command:
  `npx aibill improve --draft ab1.…`. In the terminal every sentence shows who
  wrote it ("Drafted with your agent" vs aibill's "Suggested"), Enter accepts
  each, and APPROVE is typed by the human, always — no agent can authorize
  anything. The draft travels as a single token whose alphabet contains no
  shell metacharacter: it cannot break out of its argv slot, and a
  credential-shaped draft is set aside unechoed.
- Made Enter navigation and typing testimony: start/resume/identity-confirm
  answer to Enter, while the answers that become user-declared evidence —
  baseline quality, canary outcome, APPROVE — must always be typed.
- Supported multiple provider organizations. OpenAI Admin keys cover one org
  each; syncs now accumulate named per-account slices, warn when two slices
  look like the same org twice, name any superseded billed amounts, and the
  new `aibill drop-slice` removes a stale slice.
- Kept the complete mixed card: with providers connected, the receipt shows
  all three kinds of money — `committed $/mo · API-equivalent ~$ · billed $` —
  billed leads, nothing is blended, nothing is erased.
- Polish from founder live-testing: `~` on every API-equivalent figure, the
  receipt says to run `improve` from the project folder you want to improve,
  `connect` hands over a runnable sync command with a computed 30-day window,
  and unsure answers get help instead of being recorded.

## 0.9.0 — 2026-08-19

The guided action loop: aibill doesn't just show where the AI money goes — it
walks through one reversible experiment to reduce it and measures whether it
worked.

- Published `npx aibill improve`, the guided token-reduction test. aibill finds
  a waste pattern in your own local evidence, drafts the plan (press Enter to
  accept each sentence), records your explicit APPROVE before anything changes,
  hands your coding agent one instruction, then measures before vs. after on
  quality-accepted sessions only. `npx aibill improve --sample` is the safe
  practice run.
- Unified the result card everywhere: per-subscription rows, then a labeled
  total stack — `committed $/mo · API-equivalent ~$ · billed $` — one figure
  per kind of money, never summed across kinds. By-project rows reconcile
  exactly, including the honest `unattributed` row.
- Added `npx aibill index` to read very large agent histories to completion
  once, so results stop saying "indexing". Multi-GB Codex histories converge
  run-over-run with resumable, privacy-stripped checkpoints.
- Shipped statusline v2: every subscription plus the committed total at any
  terminal width; `npx aibill statusline expand` prints the full view.
- Moved the evidence engine to a sharded per-transcript index (~40× faster);
  typical warm runs land in 1–3 seconds.
- Updated the Cursor connector to the 2026 Admin API with fail-closed
  live-reconciliation: `billed` appears only after a real reconciliation run
  verifies it.
- Upgrade note: the qualitative parser contract moved to v4. Existing installs
  re-index bounded slices over their first few runs (or run `npx aibill index`
  once) before coverage reports complete again. Output stays honest
  ("indexing") during the catch-up — no action required.

## 0.8.1 — 2026-08-14

- Re-reviewed current OpenAI, Anthropic, and Cursor provider pages after the
  release drift gate detected official-page changes; strengthened Anthropic
  price markers and added published Claude Mythos 5, Opus 5, and Sonnet 5
  API-equivalent pricing while unknown models continue to fail closed.
- Prevented a freshly regenerated cache from presenting old transcript limit
  percentages as live runway. Statusline and Glance now label old reports
  stale, and past exhaustion projections cannot drive a current action.
- Preserved positive fractional-cent evidence in summaries, watch state,
  reports, statusline, MCP, and machine-readable policy drafts instead of
  rounding a real value to zero.
- Corrected each provider onboarding flow to name its own credential reference
  and removed duplicated sentence punctuation from MCP recommendations.

- Replaced the default terminal audit with a compact, responsive decision
  receipt: explicit trust state, one primary figure, one driver, separated
  evidence bases, one safe next action, and `--full` for the complete audit.
- Removed implicit sample fallback from every normal entry point. Missing or
  unreadable evidence now stays unavailable rather than becoming sample money,
  `$0`, a percentage share, a completed scan, or an actionable Apply prompt.
- Kept provider-reported cost, API-equivalent estimates, and unverified detected
  value visibly separate. Dominant unattributed activity is disclosed instead
  of promoting a smaller named project as the primary driver.
- Made the CLI grammar fail closed for unknown flags, missing values,
  unsupported provider connections, ignored time bounds, malformed external
  labels, and unsupported main-receipt JSON requests.
- Hardened provider readiness for Claude Code, Codex, Gemini CLI, OpenAI Admin,
  Anthropic Admin, Cursor Admin, and GitHub Copilot. Authentication now removes
  only the credential prerequisite it satisfies and preserves every known
  financial, attribution, export, and invoice-coverage gap.
- Refreshed the Aug 14 official provider-contract hashes and reran the complete
  five-package, MCP, statusline, Glance, public-boundary, consumer-install, and
  live contract-drift release gates.

## 0.8.0 — 2026-08-13

- Corrected OpenAI organization usage normalization to treat reported input and
  output token totals as inclusive rather than adding their modality
  breakdowns twice. Forwarded the complete supported `group_by` vocabulary and
  kept Costs as provider-reported financial evidence instead of deriving billed
  dollars from usage tokens.
- Added a versioned provider financial-contract registry and fail-closed drift
  gate for OpenAI, Anthropic, Google, Cursor, and GitHub. Refreshed the official
  GPT-5.6 Sol, Terra, and Luna prices and their per-request `>272K` prompt tier;
  cumulative multi-request totals that cannot select a tier honestly remain
  `missing`.
- Hardened MCP no-state and malformed-state handling so missing, stale,
  malformed, or hostile persisted data cannot become sample money, leak local
  paths, or silently fall back to a different evidence mode.
- Published the supported Node library preview for the narrow root-import
  contracts in `@agent-finops/core` and `@agent-finops/report`, with packed ESM
  and TypeScript consumer tests and blocked internal deep imports.
- Updated production dependency pins and verified all five packed public
  packages with a zero-high-severity npm audit and public-boundary scan.

- Added an experimental, registry-native Gemini CLI financial reader for
  supported JSON and JSONL sessions under
  `~/.gemini/tmp/<opaque-project-id>/chats/`. `logs.json` is presence-only and
  can never enter the financial parser or create a financial row.
- Preserved explicit input, output, cached, thought, tool, and total-token
  evidence. Cached input is never double-counted; thought/tool splits are
  priced only when the full token equation is internally consistent. Missing
  components, inconsistent totals, unknown or suffixed model identifiers, and
  evolving shapes remain `missing` rather than estimated `$0`.
- Applied Gemini 2.5 Pro's published per-request prompt tiers at the exact
  200,000-token boundary before daily aggregation. A request is priced only
  when the separate prompt and tool-token counts agree on the tier; ambiguous
  rows stay missing. Thought tokens use the output rate. Flash/Flash-Lite rows
  stay missing because chats omit modality while published modality rates
  differ. Mixed small/large calls are never priced as one synthetic request.
- Kept project hashes private and irreversible. Gemini rows use session-carried
  project/cwd evidence when usable, otherwise a deterministic opaque alias or
  no project attribution.
- Added bounded synthetic JSON/JSONL, nested-session, malformed, partial,
  unknown-model, duplicate-update, and `logs.json`-only fixtures plus generated
  source documentation and CLI/MCP empty-state coverage.
- Kept Gemini out of the Claude Code status line, Glance, Context Health, plan
  runway, invocation evidence, recommendations, and Apply activity logic.
  Existing Claude Code and Codex behavior remains capability-gated and
  unchanged.
- Preserved source-version provenance when the evolving session format reports
  a safe version, deduplicated copied stable session/message identities across
  the chats tree, failed conflicting duplicate identities closed, and
  documented component subsets so cached/tool/thought fields cannot be added
  to normalized headline totals twice.
- Kept MCP local-log reads inside their original project scope on every
  authoritative transcript re-read and surfaced sanitized complete/partial/
  missing coverage without paths or transcript content. Unrelated detected
  sources no longer change the selected records' validation label.

## 0.7.3 — 2026-08-11

- Fixed multi-subscription status-line attribution so every displayed runway
  window and subscription API-equivalent value identifies its Claude Code or
  Codex agent. Single-subscription output remains unchanged.
- Ranked multi-agent runway globally by lowest reported percentage remaining,
  with deterministic width degradation that shows both agents when they fit
  and preserves the most urgent labeled window when only one fits.
- Added golden coverage for reversed cache order, full and compact widths,
  multiple windows, mixed billing, verified overage, missing runway, strict
  cache reads, hostile hook input, and the exit-zero one-line hook contract.

## 0.7.2 — 2026-08-10

- Refactored the existing Claude Code and Codex local readers into an ordered,
  data-driven format registry without adding a new parser. Each descriptor now
  owns discovery, provider normalization, financial-reader strategy,
  capabilities, evidence defaults, validation coverage, documentation, and
  recorded-fixture references.
- Added synthetic recorded JSONL fixtures and exact normalized-output goldens
  for Claude deduplication, malformed and unsupported usage, plus Codex
  cumulative usage, latest-turn context, and transcript-reported five-hour and
  weekly limits. CI rejects fixture privacy leaks and parser-output drift.
- Added deterministic generated source pages that state how each format is
  read, what the parser validation proves, what financial values remain
  estimated or missing, and the known privacy and coverage limits. The public
  contribution guide now defines the registry-only path for future parsers.
- Kept existing CLI, MCP, report, cache/statusline, Context Health, and Glance
  behavior compatible. Source diagnostics and status enumeration now consume
  the registry, while capability gates keep unsupported future formats out of
  downstream surfaces until their descriptors explicitly opt in.

## 0.7.1 — 2026-08-10

- Added the additive `AgentEconomicsReceiptV0` contract to
  `@agent-finops/core`: a strict, content-addressed envelope for agent usage
  and cost evidence with deterministic canonical IDs, opaque source-record
  references, explicit source freshness and validation coverage, and a hard
  demo-data boundary.
- Kept token usage separate from financial cost and grouped USD totals by
  accounting basis and financial evidence, so provider-billed money,
  API-equivalent estimates, and user-declared cost cannot become one blended
  number. Invalid totals, unsupported versions, broken references, unsafe
  metadata, and contradictory evidence fail closed.
- Added version-pinned projections for ratified FOCUS 1.4, the FOCUS 1.5
  working draft, and OpenTelemetry GenAI Development conventions. Requested
  model data is projected only when explicitly present; API-equivalent value
  never becomes FOCUS `BilledCost`. The Tokenomics Foundation adapter remains
  an explicit no-row tracking stub until a technical specification is
  published.
- Kept Receipt v0 additive to the core API with no changes to CLI output, MCP,
  report, Glance, or persisted-state behavior. Also made statusline uninstall
  restore the verified settings backup byte-for-byte when no post-install
  edits occurred, while preserving the surgical merge path for changed files.

## 0.7.0 — 2026-08-10

- Added an optional, plan-aware Claude Code status line over the private
  aggregate cache. Metered use leads with dollars, subscriptions lead with
  transcript-reported runway, and mixed mode keeps subscribed and metered
  cohorts separate. `~` always means API-equivalent value; untilded `billed`
  money requires verified provider evidence.
- Added deterministic fresh, stale, failed-refresh, empty, missing, malformed,
  narrow-terminal, and verified-overage states. The standalone
  Node-builtins-only renderer ignores bounded Claude session input, emits one
  sanitized line, exits zero on every hook path, and never scans transcripts,
  starts a subprocess, contacts a provider, or uses the network.
- Added explicit `statusline install`, `refresh`, and `uninstall` commands plus
  `init --statusline`. Bare init only prints the opt-in. Installation is
  user-scoped, conflict-aware, reversible, and backed by private exact-byte
  backups and a strict ownership receipt; users verify all effective Claude
  setting sources with `/status`.
- Added status-line performance coverage and a clean five-tarball smoke that
  installs, executes, and uninstalls the exact runner shipped in the npm
  artifact.

## 0.6.1 — 2026-08-10

- Rebuilt `aibill init` as an idempotent first-value transaction: it detects
  Claude Code and Codex, performs one machine-wide financial-only 30-day
  backfill, explicitly distinguishes the state project from the usage scope,
  prints an evidence-labeled personal receipt, reports source coverage, and
  preserves existing source, audit, connected-provider, and spend state.
- Added a strict plan-aware activity snapshot with separate metered,
  subscription, and mixed cohorts. API-equivalent estimates, subscription
  runway, trusted provider-billed cost, and missing evidence remain separate;
  sample data cannot seed the cache, and no limit window is inferred.
- Added a private external cache with bounded schema validation, symlink and
  non-regular-file refusal, `0700`/`0600` permissions, atomic writes, writer
  locking, newer-snapshot protection, and last-good preservation after a
  failed refresh. The aggregate contains no prompts, paths, project/session
  identifiers, credentials, or auth references and is never an evidence-trust
  or action-authorization source.
- Added a streaming financial-only local-log path so init can reach first value
  without running the heavier focus, tool-invocation, or Glance analysis. Its
  financial and transcript-reported limit fields remain fixture-equivalent to
  the canonical full reader.
- Made rolling windows exact at call boundaries and conservative at daily or
  billing-bucket boundaries. Missing/unsupported token shapes remain missing,
  financially bounded JSONL scans report partial validation, and provider
  billed zero requires a trusted sync interval that spans the displayed
  window.
- Hardened legacy connected-provider migration without borrowing freshness
  across providers, kept provider and local-source coverage independent, and
  rejected contradictory cumulative token counters or invalid provider time
  bounds before they can enter financial output.

## 0.6.0 — 2026-08-08

- Added the canonical two-axis source-status contract and `aibill doctor
  --sources`: connector validation coverage remains separate from each
  number's financial evidence, with local freshness and sanitized last errors.
- Hardened Claude Code and Codex reader correctness against adversarial local
  corpus replays. The Codex replay produced 25 aggregate rows—14 supported
  estimates and 11 honestly missing—with zero false estimated-$0 rows.
- Updated Cursor and GitHub Copilot to their current official response shapes,
  pagination/download flows, and per-seat plan evidence. Canonical fixtures
  pass; both remain `fixture_verified` beta until live-account QA. OpenAI and
  Anthropic have non-empty live-API coverage; OpenAI product QA reconciled the
  tested Costs total to invoiced API credits less the provider-UI balance with
  `$0.00` variance. Each user's final invoice remains separate.
- Added a deterministic stdio fixture matrix that exercises all eight MCP
  tools, explicit sample persistence, safe empty/authentication failures, and
  a conspicuous automatic in-memory sample fallback that never creates project
  state or authorizes a real recommendation.
- Reserved `verified`/provider-reported financial semantics for real evidence:
  bundled sample rows are estimated or detected/unverified, legacy persisted
  samples are demoted on read, and the initiating sample scan now returns an
  explicit demo-only boundary while skipping local discovery. Agent-facing
  discovery uses deterministic opaque references for repository-controlled
  descendant paths and secret identifiers. `list_sources` keeps only the
  approved root and canonical product capabilities readable; persisted prose,
  forged lane metadata, and credential metadata are not echoed.
- Added a machine-local connected-state integrity receipt outside the
  repository. It binds the canonical root plus exact `spend.json` and
  `sources.json` hashes, so cloned or edited repository state cannot promote
  connected totals, Apply actions, or source-status truth axes.
- Hardened provider ingestion against malformed and schema-invalid rows,
  transformed credential variants, terminal control sequences, and partial
  pagination. Returned rows retain their own financial labels while missing
  coverage remains explicit in reports and recommendation evidence.
- Reordered the terminal receipt around mode/trust, source evidence, plan
  context, bounded recommendations, context evidence, Apply/Verify, and the
  shareable AI Receipt CTA. Modeled opportunity remains amber and is never
  presented as verified savings.
- Corrected missing connected cost so it stays unavailable instead of becoming
  `$0.00`, preserved sub-cent values as `<$0.01` throughout the evidence ledger,
  and neutralized raw HTML/control injection in shareable report artifacts.
- Added a restrained Teams & Agencies design-partner path for planned
  monitoring, alerts, shared workspaces, and white-label reports, with tested
  `source_ref=teams` attribution and no public pricing.
- Expanded the public-boundary gate for private monetization, build-spec,
  research, and fundraising material, concrete macOS/Linux/Windows developer
  paths, and unreviewed symbolic links. Added packed-package content checks,
  isolated five-tarball install smoke coverage, and production dependency
  overrides that audit with zero known vulnerabilities. Removed Glance's
  developer-specific checkout fallback in favor of explicit, current-checkout,
  or installed CLI resolution.

## 0.5.9 — 2026-08-03

Recommendation-truth hotfix for the public beta.

- Bound Codex usage to the first/root session identity and subtract inherited
  cumulative baselines from supported forked subagents before child-specific
  work. Identical root IDs are deduplicated; ambiguous legacy forks and missing
  post-boundary totals remain omitted rather than assigned to a project.
- Added explicit record granularity and workload-semantics gates. Only priced
  `call`/`invocation` records with a named operation can enter modeled action
  math, and model routing, cache, or Batch candidates also require the relevant
  adapter attestation. Billing/usage buckets, seats, users, and local daily
  aggregates remain reconciliation or observed-exposure evidence.
- Rebuilt `npx aibill apply` as an evidence-constrained, billing-aware plan with
  source/window/candidate IDs, read-only inspection, explicit approval, one
  reversible change, rollback, and matched future accepted-outcome plus cost
  verification. API-equivalent value is never presented as billed spend,
  guaranteed cash savings, or ROI.
- Made bundled sample Apply and all sample sidecars explicitly non-executable.
  Explicit `apply --sample` is now a strict share-safe privacy boundary: it
  reads no live transcripts, account metadata, credentials, or persisted spend
  state and omits absolute local paths from terminal output.
  MCP now persists and returns `mode: sample`, recovers narrowly identifiable
  legacy mode-less bundled samples, and returns demo-only guidance. Any other
  unlabeled legacy state fails closed across Apply, action/policy/verification,
  demo-package, Markdown, and HTML artifacts instead of becoming a connected
  action.
- Connected MCP recommendations now preserve a stable candidate ID, record IDs,
  provider/source, accounting basis, candidate-specific UTC window, confidence,
  approval boundary, rollback, and matched verification. Aggregate provider
  rows return `NO MODELED CUT` rather than manufactured call-level advice.
- Corrected Context Health and inventory semantics across host/project scopes:
  configured definitions, explicit always-load requests, hook activation, and
  observed invocations remain separate; hooks are never executed or assigned a
  guessed payload; undated coverage and cross-project focus are excluded.
- Glance copies a compact project-aware session handoff, not the full financial
  Apply plan. Stale/failed snapshots disable Copy, retry is real, snapshot
  generation is bounded at 75 seconds, missing limits remain unavailable, and
  reported reset is separate from projected exhaustion.
- Corrected report/card/terminal cost-vs-value wording, aggregate record units,
  `detected/unverified` display labels, package/plugin/privacy descriptions, and
  provider readiness: Anthropic is live-verified; OpenAI auth and endpoint access
  are exercised, while non-empty cost reconciliation remains pending. Copilot
  and Cursor remain fixture-verified pending live-account QA.

## 0.5.8 — 2026-08-03

Launch-day attribution and product-truth release.

- Current Codex Desktop nested `exec` envelopes now contribute their explicit
  working directories to project attribution without evaluating transcript
  code. Home-launched work can therefore resolve to the observed project
  instead of remaining in the fallback bucket.
- Home-directory fallbacks are no longer promoted to a real project or an
  automatic 98%-confidence mapping. Any unresolved remainder is labeled
  `Unattributed` with its evidence limitation stated in the terminal.
- Local-log breakdowns now label their aggregate count as `Records`, explain
  the day + agent + model + project unit, and describe an unattributed leading
  share directly instead of saying that “Home” consumed it.
- Includes the public onboarding, discoverable MCP setup, deterministic sample
  privacy, financial-accountability copy, focused landing page, interactive
  product tour, and production design-partner form improvements landed after
  0.5.7.

## 0.5.7 — 2026-07-31

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
  provider's records. Anthropic was live-verified through stdio; OpenAI auth and
  endpoint access were exercised but non-empty cost reconciliation remained
  pending. Copilot and Cursor remain fixture-verified pending account QA.
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
