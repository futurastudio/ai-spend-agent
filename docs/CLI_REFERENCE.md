# aibill CLI reference

Command details for [aibill, Tilden’s free CLI](../README.md). Start with the
[quick start](../README.md#get-started) or the [Workspace sharing guide](WORKSPACE.md).

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
| `report [--sample] [--path <dir>] [--out <name>] [--since-days N] [--no-open]` | Generate local Markdown + HTML reports (project folders keep `.ai-spend-agent/report.*`; from your home directory it runs machine-wide and writes `./ai-spend-report.*`) and open the HTML in your browser — auto-open is TTY-only, never fires in CI or SSH sessions, and `--no-open` or `AI_SPEND_NO_OPEN=1` (same convention as `AI_SPEND_NO_TELEMETRY`) turns it off |
| `report-card [--sample]` | Your AI Receipt — redacted shareable SVG + caption |
| `scan [--path <dir>]` | Scan a local workspace for AI usage signals |
| `doctor [--sources]` | Check local runtime and safety posture; `--sources` separates connector validation, financial evidence, freshness, and errors |

Run `npx aibill --help` for the full list. Workspace commands and their consent
boundaries are documented in [Workspace sharing](WORKSPACE.md).

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

The advanced commands remain available for inspection and automation. Replace
each quoted placeholder with the actual identifier, timestamp or digest; do
not run the examples with placeholder values:

```bash
npx aibill apply

# 1. `apply` prints the current candidate key. Inspect it without changing anything.
npx aibill verify inspect '<candidate-key>'

# 2. Freeze the comparable pre-change cohort after you declare its quality held.
npx aibill verify start '<candidate-key>' --quality held

# 3. After you approve one reversible change and run its canary, record opaque proof.
npx aibill verify mark-applied '<experiment-id>' \
  --approved-at '<actual-approval-ISO-8601>' \
  --applied-at '<actual-application-ISO-8601>' \
  --canary passed \
  --change-digest '<64-character-sha256>' \
  --rollback-digest '<64-character-sha256>' \
  --canary-digest '<64-character-sha256>'

# 4. Use normally, then label the matched post-change work and calculate the result.
npx aibill verify '<experiment-id>' --quality held
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
npx aibill verify rollback '<experiment-id>' \
  --rollback-digest '<the-same-64-character-sha256>'
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
