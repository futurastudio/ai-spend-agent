# ai-spend-agent — Tilden’s free AI spend CLI

Inspect Claude Code and Codex activity locally, see its estimated value at
published API rates, and identify what deserves a closer look. Optional provider
reports add billing evidence; estimates and reported costs stay separate.

```bash
npx aibill@latest init
npx aibill@latest --full
```

Requires Node.js 22+. Free and MIT-licensed; no account or provider key is
needed for local analysis. `aibill` and `ai-spend-agent` run the same CLI.
Run from a project directory: `init` reviews the last 30 days of supported
machine-wide records, uses that project for local state, and seeds the private
Claude Code/Codex status cache. It does not change Claude settings or connect
Workspace. Missing evidence stays missing; `--sample` explicitly selects a demo.

Local values are API-equivalent estimates, not subscription charges or invoices.
Claude Code/Codex readers are live-verified; Gemini CLI is experimental and
fixture-verified, supported only in financial CLI/report surfaces.
Gemini does not feed statusline, Glance, Context Health, Apply or plan/runway.
`npx aibill@latest doctor --sources` shows reader validation separately from
each number’s financial label and coverage.

## Choose a next step

- `npx aibill@latest context`: inspect context evidence.
- `npx aibill@latest improve`: guide one reversible token experiment; a result
  requires matched completed sessions and user-declared quality, not a claim
  of cash savings or ROI.
- `npx aibill@latest statusline install`: optionally install the cache-only
  Claude Code status line. Remove it with `statusline uninstall`.
- `npx aibill@latest guard install`: turn a committed `.aibill/policy.json`
  (model allowlist, daily token and session budget per repository) into Claude
  Code project settings and a hook that fails open on uncertain evidence.
  Remove it with `guard install --uninstall`.
- `npx aibill@latest connect openai` or `connect anthropic`: register local
  provider setup and print the separate `sync-provider` command. Only an
  explicit sync reads the provider, using the required admin environment
  credential reference. Cursor/Copilot connectors remain fixture-verified beta
  pending real-account acceptance.

## Use standalone or connect to Workspace

Use the free CLI on its own, or keep working locally and connect it to your
invited [Tilden Workspace](https://asktilden.com/docs/workspace) for a shared
spending review. Start with `npx aibill@latest workspace connect`, complete the
browser enrollment and sharing consent, then accept the first-push offer or run
`npx aibill@latest workspace push` to preview and approve a share. The browser
does not need to stay open for later pushes while the machine’s grant and
sharing consent remain valid. Shared facts include eligible
Claude Code/Codex sessions, tokens and project labels where available, plus
hashed identities and the subscription tier each agent is signed in with
(`AIBILL_NO_PLAN_TIER=1` leaves the tier out); they exclude raw prompts,
transcript contents, full paths, raw session IDs, dollar amounts, credential tokens and
account identities. Local provider records are not uploaded.
Hosted provider connections are set up separately.

Optional `npx aibill@latest workspace push --schedule daily` installs a daily
macOS launchd or cron job after separate standing consent, once Workspace has
accepted a first push from the machine. Each run sends one bounded session batch
and may follow it with announced tier facts. A run whose answer is lost sends the
same batch again on the next run, and if Workspace refuses the machine, daily
sync turns itself off. `npx aibill@latest workspace push --schedule none`
removes daily sharing and everything it installed; `workspace disconnect` removes
it too. The installed CLI is retained locally; run setup again
after CLI or Node.js updates. Windows scheduling is not yet supported.
`npx aibill@latest workspace status` shows the schedule and its last run, and says
`NOT RUNNING` when no run has been recorded for 48 hours. A manual push with more
than one batch of facts shows them all in one preview and sends them in one command.

Shared facts include device-keyed session identities and unkeyed directory hashes.
They expire from hosted reads after the machine policy's displayed retention
period; expiry and disconnect do not promise physical deletion.

Read [Workspace setup and limits](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/WORKSPACE.md)
before pairing. [Join the Tilden waitlist](https://asktilden.com/?ref=npm-cli#beta)
for updates and access invitations; joining does not grant immediate access.

## Privacy

Default transcript analysis runs locally. Reports remain local until shared.
Manual Workspace pushes require approval of the exact batch. Daily pushes require
separate standing consent tied to the current machine connection. Explicit provider
sync uses the referenced credential only with that provider’s read-only API;
aibill never sits in the inference path and never stores, prints, or proxies provider credentials.
Workspace pairing uses separate private local device credentials.

**Telemetry: command counts, disclosed at first run.** Events begin
only after the first interactive notice. They include a random installation ID
and operational fields. Events can be linked to the same installation, but do
not include your arguments, paths, prompts, project names,
dollar amounts or email. `npx aibill telemetry off` disables them; so do
`DO_NOT_TRACK`, `CI` or `AI_SPEND_NO_TELEMETRY` when non-empty.
`npx aibill telemetry` shows the exact last payload.
[Full telemetry disclosure](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/TELEMETRY.md).
The optional signup command sends its displayed email/ref payload only after
confirmation; `outcome github` explicitly uses the installed `gh` CLI.

[Full guide](https://github.com/futurastudio/ai-spend-agent#readme) ·
[Source coverage](https://asktilden.com/docs/sources) ·
[Command reference](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/CLI_REFERENCE.md)
