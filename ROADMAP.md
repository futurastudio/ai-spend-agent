# aibill public roadmap

aibill is building the financial accountability system for the AI-agent
workforce: connect what agents did to what they cost, who owns it, which
outcome is supported, and what should happen next.

This roadmap describes direction, not a delivery guarantee. Availability is
part of the product truth: published, merged-preview, and planned capabilities
stay separate. Shipped behavior is documented in the [release
notes](CHANGELOG.md), and the client-friendly version of this roadmap lives at
[/docs/roadmap](https://asktilden.com/docs/roadmap).

Last updated: August 11, 2026.

## Available now — npm v0.7.3

- Claude Code and Codex local evidence in the CLI, explicit MCP/plugin,
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

Workspace, accepted-outcome economics, ROI measurement, and autonomous
enforcement are not shipped.

## Merged preview — v0.8.0, not published

The experimental Gemini CLI financial reader is merged to `main` but is not
available from bare `npx aibill@latest`:

- supported complete chat-session records may produce `estimated`
  API-equivalent value;
- unknown, incomplete, inconsistent, or unsupported evidence stays `missing`;
- the reader is `fixture_verified`, not live-verified;
- `logs.json` is presence-only and creates no financial row; and
- Gemini does not feed statusline, Glance, Context Health, plan runway,
  invocation evidence, recommendations, or Apply.

Publication remains a separate release gate. Until it closes, npm latest is
v0.7.3.

## Next 30 days — current focus areas, not an exhaustive build order

1. **Publish the gated Gemini merge.** After explicit approval, publish the
   already-gated merge, then run the post-publication cold-registry smoke,
   exact tag, and GitHub Release. Improve positive sub-cent display separately
   as post-release polish.
2. **Deepen attribution and session evidence before outcomes.** Add branch,
   ticket, and work-unit attribution plus plan presets and session vitals
   before accepted, rejected, reverted, rework, and unknown outcome states.
   The first verified unit is an accepted coding task or merged PR—not lines of
   code or modeled hours.
3. **Add financial CI carefully.** Begin with warnings, preview, dry-run,
   explicit approval, rollback, and a verified result. No autonomous control
   claim without a real adapter and validated team policy.
4. **Close distribution and comprehension proof.** Run the 8–12-person study,
   collect real billing-reconciliation cases, and finish signed, notarized,
   update-safe Glance distribution before offering a public download.
5. **Earn the organization foundation with design partners.** Test one
   read-only observability import and gather design-partner proof first. Then
   begin an opt-in aggregate receipt sync for shared reconciliation,
   allocation, and approval history. This is a foundation, not Workspace
   general availability.

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
