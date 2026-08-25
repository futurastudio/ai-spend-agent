# aibill public roadmap

aibill is building the financial accountability system for the AI-agent
workforce: connect what agents did to what they cost, who owns it, which
outcome is supported, and what should happen next.

This roadmap describes direction, not a delivery guarantee. Availability is
part of the product truth: published and planned capabilities
stay separate. Shipped behavior is documented in the [release
notes](CHANGELOG.md), and the client-friendly version of this roadmap lives at
[/docs/roadmap](https://asktilden.com/docs/roadmap).

Last updated: August 23, 2026.

## Available now — npm v0.9.1

The deliberately narrow launch loop shipped in v0.9.0/v0.9.1:

**Why is usage high? → What one safe change should I test? → Did token usage
change while quality held?**

A percentage is allowed only for that user's calculated before/after result
when the declared quality check held. It is not a universal saving,
provider-bill, productivity, accepted-outcome, cash, or ROI claim.

- The guided action loop: `npx aibill improve` finds a waste pattern in your
  own local evidence, drafts one provider-aware reversible test, records your
  typed APPROVE before anything changes, and calculates one canonical
  matched-session result shared by CLI, MCP, report, and Glance.
  `npx aibill improve --sample` is the labeled practice run; it writes
  nothing.
- The agent-native loop: the read-only `draft_improve_command` MCP tool (the
  tenth tool) lets an AI client draft the change/rollback/canary plan
  conversationally and hand over one paste-safe `improve --draft` command.
  Approval is still typed by the human in the terminal, never by an agent.
- Local contracts for explicitly confirmed human/team/role ownership, optional
  client/cost-centre labels, pre-change local self-attestation, and an opt-in
  merged-GitHub-PR evidence record (`identify`, `outcome github`,
  `accountability`). Those are foundations for Workspace, not company
  identity, RBAC, approval routing, or a reconciled Project Economics Receipt.
- A bounded, coverage-labeled Claude Code/Codex qualitative index, with
  `npx aibill index` to read very large agent histories to completion through
  resumable, privacy-stripped checkpoints.
- Statusline v2: every subscription plus the committed total at any terminal
  width, with `npx aibill statusline expand` for the full view.
- Multiple provider organizations per connector: named per-account slices,
  same-org duplicate warnings, and `aibill drop-slice` to remove a stale
  slice.
- Claude Code, Codex, and experimental Gemini CLI financial evidence in the CLI
  and explicit MCP/plugin,
  private init/cache, and optional cache-only Claude Code statusline.
- Separation of provider-billed cost, subscription context, API-equivalent
  value, validation coverage, freshness, and missing evidence.
- Optional OpenAI and Anthropic provider reports. Cursor and GitHub Copilot
  connectors remain `fixture_verified` beta until live-account QA.
- The additive `AgentEconomicsReceiptV0` core contract plus the data-driven
  local-reader registry, synthetic fixtures, generated source pages, and
  contribution path.
- An unsigned, source-built Glance preview. There is no public Mac download
  yet.

The Gemini reader is `fixture_verified`, not live-verified. It reads supported
chat-session JSON/JSONL financial evidence; unknown, incomplete, inconsistent,
or unsupported evidence stays `missing`, and `logs.json` is presence-only.
Gemini does not feed statusline, Glance, Context Health, plan runway,
invocation evidence, recommendations, or Apply.

Workspace, accepted-outcome economics, ROI measurement, and autonomous
enforcement are not shipped.

## Next 30 days — current focus areas, not an exhaustive build order

1. **Deepen attribution and session evidence before outcomes.** Add branch,
   ticket, and work-unit attribution plus plan presets and session vitals
   before accepted, rejected, reverted, rework, and unknown outcome states.
   The first verified unit is an accepted coding task or merged PR—not lines of
   code or modeled hours.
2. **Add financial CI carefully.** Begin with warnings, preview, dry-run,
   explicit approval, rollback, and a verified result. No autonomous control
   claim without a real adapter and validated team policy.
3. **Close distribution and comprehension proof.** Run the 8–12-person study,
   collect real billing-reconciliation cases, and finish signed, notarized,
   update-safe Glance distribution before offering a public download.
4. **Earn the organization foundation with design partners.** Test one
   read-only observability import and gather design-partner proof first. Then
   begin an opt-in aggregate receipt sync for shared reconciliation,
   allocation, and approval history. This is a foundation, not Workspace
   general availability.

- **Guided provider connect.** `connect <provider>` becomes a short guided
  sitting: the one console URL where the admin key is created, a wait-and-
  verify step for the env reference (the key itself never touches aibill),
  then the first sync runs automatically over a default 30-day window — no
  placeholders, no second command to compose. The agent-native loop drafts
  it conversationally where an MCP client is present.
- **Per-basis saved reports in connected mode (implemented in the current
  source preview).** Connected Markdown and HTML reports keep the provider
  headline and fresh local API-equivalent evidence on separate axes. They
  explicitly decline to publish a combined total; missing local cost stays
  unavailable rather than becoming zero. Improve's waste lane is unchanged
  because it derives from bounded action evidence, not financial aggregates;
  its project standing uses the separate local API-equivalent axis when that
  evidence is present.
- **Aggregate receipt transport (groundwork only).** The source preview has a
  strict client-supplied numeric aggregate schema and a pure waitlist/durable-rate-limit
  decision for a future opt-in receipt delivery route. No upload, email route,
  ESP, `push`, authentication, storage, or cloud receipt is shipped. A hosted
  surface remains post-launch work and must pass retention and abuse QA first.

## Later — the paid accountability system

The intended Workspace is an opt-in, permissioned layer over approved Agent
Economics Receipts:

- organization-wide provider and subscription reconciliation;
- project, client, user, agent, and use-case allocation;
- budgets, anomalies, approvals, and audit history;
- accepted-outcome economics and rework where evidence supports them; and
- a read-only financial teammate that cites freshness, source quality, and
  missing coverage with every meaningful answer.

Defensible ROI requires reconciled cost, an accepted outcome, and independently
evidenced business value. Token volume, activity, lines of code, or invented
hours saved are not ROI.

## Explicitly not yet

- ROI or productivity claims from usage evidence alone.
- Autonomous budget enforcement or provider changes.
- Cursor-local financial parsing from current internal IDE databases; official
  admin APIs remain the financial path unless a stable, versioned local format
  emerges.
- General Workspace availability, RBAC, or team billing.
- A signed public Glance binary.
- A general trace explorer, prompt warehouse, model gateway, or long-tail
  parser race.

## Product sequence

The dependency order remains:

**source evidence → Receipt → Outcome → Recommendation → Guard/approval →
bounded action → verified result**

Open an issue with the user decision, evidence source, privacy boundary, and
success measure when proposing a priority change.
