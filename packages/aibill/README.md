# aibill — Tilden’s free AI spend CLI

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
fixture-verified, supported only in financial CLI/report/local MCP surfaces.
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
- `npx aibill@latest connect openai` or `connect anthropic`: register local
  provider setup and print the separate `sync-provider` command. Only an
  explicit sync reads the provider, using the required admin environment
  credential reference. Cursor/Copilot connectors remain fixture-verified beta
  pending real-account acceptance.

## Use standalone or connect to Workspace

Use the free CLI on its own, or keep working locally and connect it to your
invited [Tilden Workspace](https://asktilden.com/docs/workspace) for a shared
spending review. Start with `npx aibill@latest workspace connect`, complete the
browser enrollment and sharing consent, then run
`npx aibill@latest workspace push` to preview and approve a share. The browser
does not need to stay open for later pushes while the machine’s grant and
sharing consent remain valid. Shared facts include eligible
Claude Code/Codex sessions, tokens and project labels where available, plus
hashed identities; they exclude raw prompts, transcript contents, full paths,
raw session IDs and dollar amounts. Local provider records are not uploaded.
Hosted provider connections are set up separately.

Read [Workspace setup and limits](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/WORKSPACE.md)
before pairing. [Join the Tilden waitlist](https://asktilden.com/?ref=npm-aibill#beta)
for updates and access invitations; joining does not grant immediate access.

## Privacy

Default transcript analysis runs locally. Reports remain local until shared.
Explicit Workspace pushes send only the approved facts. Local MCP results go
to the AI client you configure and follow its data policy. Explicit provider
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
