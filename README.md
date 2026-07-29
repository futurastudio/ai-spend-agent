# aibill — AI Spend Analyst

[![CI](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/futurastudio/ai-spend-agent/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/ai-spend-agent)](https://www.npmjs.com/package/ai-spend-agent) [![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**You don't know what AI cost you this month — and your provider won't tell you until the meter does.**

```bash
npx aibill         # short form — same CLI as `npx ai-spend-agent`
```

**Oversized context and unused tools can consume tokens on every turn.** An
illustrative sample month surfaces **$253 in API-equivalent agent usage and
about $61/mo in potential cuts** across wrong-model calls, uncached repeats,
and heavy context. Run the command to measure yours in 90 seconds,
local-first, no signup.

If you use **Claude Code or Codex**, that one command reads the session logs
already on your machine and shows your real usage — total dollars *estimated*
at API-equivalent rates, where it goes by project, a ranked "where to cut" list,
and a **plan check** (subscription vs pay-per-token — the math no provider
shows you). Zero keys, zero signup, nothing leaves your laptop. Connect a
provider's billing to turn those estimates into *verified* numbers.

No agent logs? You get a full demo on sample data instead. When you're ready,
connect verified billing with an org admin/owner key (a few minutes, OpenAI /
Anthropic self-serve).

![Terminal recording of npx ai-spend-agent rendering the spend report on sample data](docs/assets/demo.gif)

*Illustrative sample output — demo data, not real or verified spend. Regenerated
from the real CLI by `scripts/record-demo.sh` so it can't drift from the product.*

## Get started in 60 seconds

1. **Run it** — nothing to install, configure, or sign up for:
   ```bash
   npx ai-spend-agent
   ```
2. **Read your number.** If Claude Code or Codex logs exist on this machine,
   that's your real usage *estimated* at API-equivalent rates — by project, by
   model, with a ranked cut list and the plan check.
3. **(Optional, ~2 min)** Connect verified billing with an org admin key:
   `ai-spend-agent connect openai` / `connect anthropic`. Numbers move from
   *estimated* to *verified*.
4. **Share the receipt**: `ai-spend-agent report-card` writes a redacted SVG
   + caption — no client, project, or user names ever leave redacted.

## Who this is for

- **You run a startup or freelance on AI tools** and can't answer "what is
  AI actually costing me per month?" — because the answer is split across
  four dashboards and two subscriptions that have no dashboard at all.
- **You live in Claude Code / Codex** and the meters keep coming — Copilot's
  AI Credits plus Claude's mix of plan limits, model-specific usage credits,
  and optional API overages. Your burn rate is hard to compare until you read
  your own logs.
- **You lead a small team** and need to know which project, model, or
  person the spend goes to before you set budgets — without buying a
  $500/mo enterprise FinOps seat.
- **You run an agency** and want per-client AI cost attribution (the
  `--group-by client` dimension exists for exactly this).

## Why

AI coding cost now mixes several systems. Copilot organization billing moved
to AI Credits in June 2026; Claude combines shared plan limits with
model-specific usage credits and optional API overages depending on plan.
Those meters run in different dashboards, and local coding-agent usage is also
sitting in logs on your machine. This tool puts the available evidence in one
view, labels estimates versus verified cost reports, and tells you what to cut.

## What you get

- **Headline number**: total tracked spend across every source it can see.
- **Where to cut**: ranked, dollar-specific actions (move X calls to a
  cheaper model, batch offline work for the flat 50% discount, cache repeats,
  trim oversized context) with estimated $/mo savings.
- **Dead context**: the skills, subagents, and MCP servers your agent loads
  but never actually calls — counted from your real transcripts, with the
  utilization %. Where the token weight is measurable (skills/agents), it adds
  an honest, cache-aware $/mo; MCP servers are counted (schemas aren't readable
  from config) until you connect to size them.
- **Plan check with real plan detection**: your projected monthly usage at API
  rates vs your *actual* subscription — the tool reads the plan your coding
  agents already know locally (Claude Max tier, ChatGPT plan; read-only,
  whitelisted fields, no account access) and tells you your value multiple
  ("you're on Max 5x: ~10× the plan price in usage") plus when usage runs past
  your tier. Override with `--plan <id>` if detection can't see your setup.
- **Drill-down**: `--group-by source|model|client|project|agent|user|workspace|apiKey`.
- **Shareable AI Receipt**: `report-card` writes a redacted SVG (no client/
  project/user names) + a paste-ready caption.
- **Honest confidence labels**: every number is tagged verified / estimated /
  detected_unverified / missing so you know how much to trust it.

![Sample AI Receipt — illustrative demo data, not real or verified numbers](docs/assets/report-card-sample.svg)

*The shareable AI Receipt (`report-card`) — redacted SVG, demo data shown.*

## Estimated vs verified

Every number carries a confidence label so you never mistake an estimate for a
bill:

| Label | What it means |
| --- | --- |
| `verified` | Real billing from a provider's cost API / export — the bill itself. |
| `estimated` | Priced from your local logs / token usage at published API rates. Your actual invoice can differ (discounts, subscriptions, rounding). |
| `detected_unverified` | A local signal was detected but **not** reconciled against billing. |
| `missing` | Usage exists but there's no cost basis to price it. |

Numbers read from your local **Claude Code / Codex** logs are always
`estimated` at API-equivalent rates — never `verified`. To get `verified`
numbers, connect a provider's billing with an admin/owner key (below); the tool
then reconciles your estimates against your real bills.

## Data sources

| Source | What | Status |
| --- | --- | --- |
| Claude Code logs (local) | Real session usage, priced at published API rates | ✅ Reads your machine's transcripts |
| Codex logs (local) | Real session usage, priced at published API rates | ✅ Reads your machine's rollouts |
| OpenAI Costs/Usage API | Admin-gated billing, per project/key | ✅ Implemented and live-verified |
| Anthropic Cost Report + Claude Code Analytics | Admin-gated billing/usage, per workspace | ✅ Implemented and live-verified |
| Cursor Admin API | Team spend (Business plan, team admin) | 🧪 Fixture-verified beta; live account QA pending |
| GitHub Copilot org APIs | Metrics + seats (org/billing admin) | 🧪 Fixture-verified beta; live account QA pending |
| Cursor / Gemini CLI / Cline / Aider local sessions | Local transcript parsing | 🔜 Planned — parsers welcome ([open an issue](https://github.com/futurastudio/ai-spend-agent/issues)) |

**Model price coverage:** local-log estimates use published list prices for
Anthropic, OpenAI, Google (Gemini), DeepSeek, Moonshot (Kimi), and xAI (Grok)
models. Open-weight models (Llama, Qwen, Mistral, GLM) have no canonical
price — hosting rates vary several-fold — so those records are honestly
labeled `missing` rather than guessed. New model out? One pricing rule +
a PR: `packages/core/src/modelPricing.ts`.

## Connect verified billing

Provider **cost** APIs are admin/owner-gated, so connecting is a deliberate step:

```bash
ai-spend-agent connect openai          # ~2 min with an org-owner Admin key
ai-spend-agent connect anthropic       # ~2 min with an Admin key
ai-spend-agent connect cursor          # Cursor team-admin key (Business plan)
ai-spend-agent connect github-copilot  # GitHub billing-admin token
```

Credentials are referenced from your local environment (`--auth-reference
env:NAME`) — the tool never stores or prints a raw key.

## Commands

| Command | What it does |
| --- | --- |
| _(no command)_ | Zero-key instant readout: your local agent logs if present, sample demo otherwise |
| `quickstart [--sample]` | Same readout; `--sample` forces demo data |
| `connect <provider>` | Connect a provider's cost data (admin-gated) |
| `sync-provider` | Pull verified cost via a local `env:` reference |
| `glance [--project <name>] [--plan <id>]` | Emit the local machine-readable Glance snapshot |
| `watch [--interval N] [--cycles N]` | Re-run on an interval, report deltas + anomalies (cron-friendly) |
| `report [--out <name>]` | Generate local Markdown + HTML reports |
| `report-card [--sample]` | Your AI Receipt — redacted shareable SVG + caption |
| `scan [--path <dir>]` | Scan a local workspace for AI usage signals |
| `doctor` | Check local runtime and safety posture |

Run `ai-spend-agent --help` for the full list.

## Use it inside Cursor / Claude Desktop (MCP)

The same engine ships as `@agent-finops/mcp`, so any stdio-compatible MCP
client can read local Claude Code/Codex estimates or sync verified OpenAI and
Anthropic billing through reference-only credentials:

```bash
npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
```

GitHub Copilot and Cursor connectors are fixture-verified and remain labeled
accordingly until live account QA. See [`docs/MCP.md`](docs/MCP.md) for client
configuration, all seven tools, and the safety model.

## Glance for macOS

The native Glance prototype leaves one tiny liquid-glass `aibill` wordmark
parked to the left of the camera/notch. Hover that fixed target—no click
required—to slide down current-session value at API rates, available
five-hour/weekly limits, reset or exhaustion timing, a local transcript-derived
description of the user's main work focus, and one actionable anomaly; moving
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

The Glance source is MIT-licensed and intentionally editable. Fork it to
change the panel size, placement, visual treatment, refresh interval, or which
fields appear in the compact and expanded states. The shared `aibill glance`
JSON contract keeps custom interfaces on the same local, evidence-labeled data
as the CLI and MCP server.

## Privacy & trust

- **Local-first.** Analysis happens on your machine; nothing is uploaded.
  No telemetry, ever.
- **No raw secrets.** Keys are referenced from your environment and redacted
  from all output and persisted state.
- **Estimates labeled as estimates.** Log-derived numbers use published API
  rates and are always tagged `estimated`. OpenAI and Anthropic cost-report
  numbers are `verified`; Copilot seat-price reconciliation and the beta
  Cursor connector are honestly tagged `estimated` until reconciled against a
  real invoice.

## Open-core

The CLI and MCP server are MIT-licensed and free, forever. A hosted tier is
in development for what local-first can't do: **continuous monitoring while
your laptop is off, burn-rate alerts before you hit Claude/Copilot/Cursor
credit caps, history and trends, and white-label client reports.** It syncs
only derived aggregates — never raw keys or line items.

**[Join the hosted beta waitlist →](https://ai-spend-agent.vercel.app)**

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
