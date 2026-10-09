# aibill — Tilden’s free AI spend CLI

[![CI](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/aibill)](https://www.npmjs.com/package/aibill) [![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Understand your coding-agent usage before you mistake it for a bill.**

Inspect Claude Code and Codex activity on your machine, see its estimated value
at published API rates, and find what deserves a closer look. Add supported
provider cost reports when you need billing evidence. Estimates, reported costs
and missing data stay separate.

```bash
npx aibill@latest init
```

Free and MIT-licensed. Node.js 22+. No account or provider key is needed for the
local workflow. `aibill` is the short command for the same `ai-spend-agent` CLI.

[CLI guide](https://asktilden.com/docs/cli) · [Source coverage](https://asktilden.com/docs/sources) · [Local MCP](docs/MCP.md) · [Workspace sharing](docs/WORKSPACE.md)

Built by [Tilden](https://asktilden.com): **Building financial infrastructure for
the AI workforce.** Your agents are doing more. Know where the money goes.
This repository is the free local starting point; Workspace is the separate,
invitation-only product for reviewing supported AI spend. The pilot has one owner seat.

**Use aibill on its own or with Workspace.** Start with a free local review,
without an account. If you already use Tilden Workspace, keep working locally
and, as the Workspace owner, connect your CLI to explicitly share supported
coding activity into your spending review. [Connect your CLI to Workspace](docs/WORKSPACE.md).

## Get started

Run these from a project directory:

```bash
npx aibill@latest init       # first receipt; scans supported local financial evidence
npx aibill@latest --full     # inspect the evidence and its coverage
```

`init` looks back 30 days across supported local agent records on the machine.
The current project selects where project state lives; it does not limit the
scan to that project. It preserves existing connector and audit state and
seeds the private Claude Code/Codex status cache. It does not change Claude
settings or connect Workspace.

Read the basis beside each number: **API-equivalent value is an estimate, not
your subscription charge or invoice.** A missing price or token component stays
missing. If supported records are absent, the CLI says so and offers a
diagnostic step; it never substitutes demo dollars.

Want to inspect the format first?

```bash
npx aibill@latest --sample   # labeled illustrative data
```

Local analysis does not send transcripts to Tilden. The CLI can send command-count events after its first interactive notice. Disable them with
`npx aibill@latest telemetry off` or set `AI_SPEND_NO_TELEMETRY=1` before running.
Optional sharing paths are explained in [Privacy & trust](#privacy--trust).

## Who it helps and what to do next

| Your job | Start here | What you can learn |
| --- | --- | --- |
| Developer using Claude Code or Codex: understand a heavy week | `npx aibill@latest --full` | Observed usage, API-rate estimates and reported plan limits where available. These do not establish what your subscription billed. |
| Founder or engineering lead: explain which projects need investigation | `npx aibill@latest --group-by project` | Project activity where local working-directory evidence supports it; missing attribution stays visible. This is the current machine’s evidence, not a team census. |
| Developer: investigate context and test one bounded change | `npx aibill@latest context`, then `npx aibill@latest improve` | Context evidence and a guided comparison of matched completed sessions. A token change requires user-declared quality; it is not cash savings or ROI. |
| Agency or team with provider admin access: prepare a cost discussion | `npx aibill@latest connect openai` or `connect anthropic` | Setup for a separate, explicit provider sync. Grouping by client, user or workspace works only where the source or confirmed mapping supplies that dimension. |

For a shared engineering-and-finance review, [explore Workspace](#open-core-optional-workspace).
You can keep using the local CLI without joining.

## Why use this alongside provider dashboards?

Provider reports answer what that source recorded. Local transcripts help
explain coding activity on your machine. aibill puts the available evidence in
one local review while preserving the difference between them. It shows source,
freshness and gaps so you can decide what to investigate without treating token
volume as a reconciled bill.

It does not sit in the inference path, route your requests or change providers.
It cannot infer a person’s billed cost, business value or productivity from
activity alone.

## Local estimates and provider reports

| CLI label | Meaning |
| --- | --- |
| `verified` | Source-authoritative provider-reported cost or usage from an authenticated API/export; not necessarily the final invoice. |
| `estimated` | A calculated or qualified value. Local transcript values use published API rates and are not subscription charges. |
| `detected_unverified` | A detected signal that has not been reconciled against billing. |
| `missing` | The evidence does not support a value; missing does not mean zero. |

Reader validation is separate. `live_verified` and `fixture_verified` describe
how a reader or connector was exercised, not whether every number is a bill.
`npx aibill@latest doctor --sources` shows validation, financial evidence,
freshness and recorded errors. Permission to read a folder is not verification
of its contents.

## Data sources

| Local CLI source | Current boundary |
| --- | --- |
| Claude Code and Codex | Supported local readers; `live_verified`. Usage with a supported price basis is `estimated`, otherwise `missing`. Reported plan windows appear only when present. |
| Gemini CLI | Experimental, `fixture_verified` reader for supported chats JSON/JSONL. Financial CLI/report/local MCP only; excluded from statusline, Glance, Context Health, Apply, recommendations and plan/runway. `logs.json` is detection-only. |
| OpenAI Costs/Usage APIs | Optional admin-gated connector with non-empty live verification. Evidence depends on endpoint; invoice adjustments and source coverage remain separate. |
| Anthropic Cost Report / Claude Code Analytics | Optional admin-gated connector with non-empty live verification. Evidence and available dimensions depend on the returned rows. |
| Cursor Admin / GitHub Copilot organization APIs | Optional, fixture-verified **beta** connectors requiring appropriate admin access. Real-account acceptance remains pending. |
| Other local agents or providers | No implied support. [Request a source](https://github.com/futurastudio/ai-spend-agent/issues/new/choose) with the decision it would help you make. |

A model in the price table is not a connector. Planned providers are not
available integrations. CLI support does not automatically enable a source in
Workspace. Historical coverage depends on the source and retained records.
See the generated [local format reference](docs/sources/README.md),
[provider contracts](docs/sources/provider-contracts.md) and
[Workspace coverage](https://asktilden.com/docs/sources#workspace).

The OpenAI CLI connector reads organization Costs and completions Usage; it
does not read ChatGPT/Codex seat or subscription invoices. The Anthropic CLI
connector reads Cost Report and Claude Code Analytics, not every surface in
the provider’s API contract. Enterprise Analytics and third-party-hosted
activity are outside those implemented endpoints. Final credits, tax,
discounts and settlement remain separate from reported API costs.

## Connect provider cost and usage

Provider setup is optional and separate from Workspace pairing:

```bash
npx aibill@latest connect openai
# Or: npx aibill@latest connect anthropic
```

`connect` registers a local connector and prints the next `sync-provider`
command. It does not fetch billing data. Review that command, supply the required
admin credential through a local environment-variable reference such as
`--auth-reference env:OPENAI_ADMIN_KEY`, then run the explicit sync.
The credential is used with the selected provider’s official read-only API;
it is not persisted in aibill state or sent to Workspace by this command.

Provider records are stored locally for the CLI review. They are not uploaded
by `workspace push`. Set up hosted provider connections separately in
Workspace. Local estimates do not become invoice line items after connecting.

## Choose your next local step

| Need | Command or guide |
| --- | --- |
| Inspect current context | `npx aibill@latest context` |
| Prepare an inspection and approval plan | `npx aibill@latest apply` writes local artifacts; it does not execute the change. |
| Test one reversible change | `npx aibill@latest improve`; practice with `improve --sample`, which writes nothing. You type approval, perform the change and supply the quality check. |
| Keep a compact view in Claude Code | `npx aibill@latest statusline install`; uninstall with `statusline uninstall`. Installation is optional; the runner only rereads a private cache. |
| Save a local report | `npx aibill@latest report --no-open` |
| Prepare a redacted receipt for sharing | `npx aibill@latest report-card`; inspect the output before sharing. |
| Ask an AI client about local evidence | [Local MCP setup](docs/MCP.md) or the [local Codex plugin](plugins/aibill/README.md). Selected results go to that client. |
| Explore a native monitor | [Glance for macOS](apps/glance-macos/README.md), a source-built preview; no signed public download yet. |

[Full command reference and experiment limits](docs/CLI_REFERENCE.md).
The guided experiment compares matched completed Claude Code/Codex session
snapshots and requires declared quality. It does not automatically optimize
requests, certify outcomes or prove ROI. Ownership and GitHub outcome commands
record explicitly supplied or narrowly checked evidence, not company approval
routing or automated business-value measurement.

## Optional automatic Workspace uploads on macOS

Pair this machine with Tilden and approve its repository scope in **Settings → Machines** first. Pairing alone does not upload activity. You can continue using `npx aibill@latest workspace push` for a reviewed manual upload, or opt into recurring summaries:

```sh
npx aibill@latest workspace sync enable
npx aibill@latest workspace sync status
npx aibill@latest workspace sync disable
```

Enable asks for recurring-upload permission and previews the first changed batch. It installs a user LaunchAgent that checks hourly while your Mac is awake and you are logged in. Each check reads the latest 30 days of Claude Code and Codex local logs, within the approved collection dates; today's UTC day is included only after it closes. Each run sends at most 256 changed daily fact groups, so larger initial histories finish over later checks. Unchanged facts are skipped, and updated facts replace their earlier revision.

Summaries include repository names, hashed directory/session references, session counts, model names and recorded token components. They contain no prompts, transcripts, raw paths, credentials or dollar amounts. Unknown tokens stay unknown. These are machine-reported activity summaries, separate from provider-reported tokens and billed costs.

An uncertain response, refused batch, incomplete source reading, expired pairing or changed grant pauses automatic uploads. It does not retry an uncertain batch automatically. Run `workspace sync disable`, inspect `workspace status`, resolve the retained batch with the existing manual flow, then enable again. Disconnecting also disables automatic uploads. Disable keeps your pairing and previously accepted records.

The schedule pins the installed upload code and parser version; it does not download updates in the background. If that installed runtime is removed (including npm-cache cleanup) or changes, disable and enable sync from the installed CLI again. Status shows local permission and the last check/result, not proof of a currently active server grant or running scheduler. Other platforms retain manual `workspace push` support.

## Open core, optional Workspace

**Work locally. Bring supported activity into your Workspace review.**

Use aibill as a standalone free CLI, or connect it to your invited Tilden
Workspace and continue using the same local tools. Connected members can share
eligible coding activity alongside the provider costs their team reviews.

Workspace is invitation-only, with assisted source setup. Teams can review
supported provider costs, project/model groups, briefings, coverage and budget
settings alongside the coding activity members explicitly share. A budget
setting is not a provider spending limit. Available history and detail depend
on each source; a known subtotal can exclude missing days.

The product order is:

- **Free CLI:** inspect local evidence; optionally read provider reports.
- **Workspace:** review supported AI spend together through invited onboarding.
- **Workspace MCP:** read hosted reports from a compatible AI client through
  assisted, read-only access. This is separate from the local npm MCP server.
- **Plugin / ChatGPT Pilot:** a private Workspace experience using hosted MCP;
  access must be confirmed during onboarding. It is not publicly listed or a
  replacement for the local Codex plugin in this repository.

To connect, run `npx aibill@latest workspace connect`, complete enrollment and
sharing consent in Workspace Settings → Machines, then use
`npx aibill@latest workspace push` to preview and share supported activity.
The browser is needed for setup; it does not need to stay open for later pushes
while the machine’s grant and sharing consent remain valid.

Shared activity includes eligible Claude Code/Codex session and token counts
and project labels where available. Raw transcripts and dollar amounts stay out
of that upload; provider billing is connected separately. See the
[setup and sharing guide](docs/WORKSPACE.md) for the supported dates, data fields
and recovery steps.

**[Join the Tilden waitlist →](https://asktilden.com/?ref=github-readme#beta)**

Bring the spending question your team needs to answer. Joining records interest
in product updates and access invitations; it does not create a Workspace or
grant immediate access. [Already invited? Sign in](https://app.asktilden.com/sign-in).

Need help defining the review? Explore the assisted
[AI Spend Assessment](https://asktilden.com/solutions#spend-assessment) for a
scoped cost-and-coverage readout, or the
[AI Value Pilot](https://asktilden.com/solutions#value-pilot) to define one
workflow’s outcome baseline. Scope, access and terms are agreed before starting;
these are assisted engagements, not automated ROI features.

## Privacy & trust

- **Local analysis:** transcript processing runs on your machine. Project state
  lives in `.ai-spend-agent/`; caches, trust receipts and pairing state use
  `~/.aibill/`. Saved reports remain local until you share them.
- **Telemetry:** command-count events can begin only after a notice
  was shown on an interactive run. The payload includes a random installation
  ID and operational fields, not command arguments, paths, prompts, project
  names, dollar amounts or email. Events can be linked to the same installation.
  `npx aibill@latest telemetry` shows the exact
  last payload; `telemetry off` or `AI_SPEND_NO_TELEMETRY=1` disables it.
  See [the full disclosure](docs/TELEMETRY.md).
- **Provider sync:** an explicit read uses the local environment credential
  reference with that provider. aibill never sits in the inference path and
  never stores, prints, or proxies provider credentials.
- **Workspace:** pairing is optional; each explicit push requires consent to
  the outgoing facts. Project labels may be shared. Device credentials stay
  in private local pairing state. Disconnect revokes future machine access;
  previously accepted records follow hosted retention rules.
- **AI clients:** local MCP/plugin results and hosted Workspace MCP results go
  to the client you authorize and then follow its data policy. The local MCP
  process does not emit the CLI’s telemetry.
- **Other explicit network actions:** `outcome github` asks the installed `gh`
  CLI for merged-PR evidence. The optional signup command sends the displayed
  email/ref payload only after confirmation. Normal HTTP metadata accompanies
  network requests. See [Tilden’s privacy policy](https://asktilden.com/privacy).

## Contribute or build from source

```bash
git clone https://github.com/futurastudio/ai-spend-agent
cd ai-spend-agent
npm ci
npm run build
node packages/cli/dist/index.js --help
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for checks and synthetic-fixture rules.
Report a [bug or source request](https://github.com/futurastudio/ai-spend-agent/issues/new/choose)
without private transcripts or credentials. Developers integrating the evidence
engine can use the [supported library preview](docs/LIBRARY.md).
See [ROADMAP.md](ROADMAP.md) for direction and explicit limits.

## License

[MIT](LICENSE) © Futura Studio LLC
