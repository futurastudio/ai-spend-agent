# aibill public roadmap

aibill is building the financial accountability system for the AI-agent
workforce: connect what agents did to what they cost, who owns it, which
outcome is supported, and what should happen next.

This roadmap describes direction, not a delivery guarantee. Availability is
part of the product truth: published and planned capabilities
stay separate. Shipped behavior is documented in the [release
notes](CHANGELOG.md), and the client-friendly version of this roadmap lives at
[/docs/roadmap](https://asktilden.com/docs/roadmap).

Last updated: August 16, 2026.

## Available now — npm v0.8.1

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

## Unreleased source preview — action and proof

The current development branch is testing one deliberately narrow launch loop:

**Why is usage high? → What one safe change should I test? → Did token usage
change while quality held?**

It adds a bounded, coverage-labeled Claude Code/Codex qualitative index; one
provider-aware reversible candidate; a repeated `aibill improve` flow; and one
canonical matched-session result shared by CLI, MCP, report, and Glance. A
percentage is allowed only for that user's calculated before/after result when
the declared quality check held. It is not a universal saving, provider-bill,
productivity, accepted-outcome, cash, or ROI claim.

The same source preview contains local contracts for explicitly confirmed
human/team/role ownership, optional client/cost-centre labels, pre-change local
self-attestation, and an opt-in merged-GitHub-PR evidence record. Those are
foundations for Workspace, not company identity, RBAC, approval routing, or a
reconciled Project Economics Receipt. Public npm remains `v0.8.1` until a
separate exact-version release passes its complete technical, external, and
human acceptance gates.

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
