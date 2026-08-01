# aibill public roadmap

aibill's vision is an open financial intelligence layer for the AI-agent
economy. Its mission is to build the financial accountability system for the
AI-agent workforce: connect what agents did to what they cost, who owns it,
what outcome it produced, and what should happen next.

The public beta begins with software-development teams and ships the private
evidence layer for that mission—not the finished company system. The roadmap
follows one rule: each milestone must turn trustworthy evidence into a clearer
decision without making local users surrender their data.

The end-to-end accountability record is:

**agent work → cost/capacity → owner → evidence → accepted outcome → policy →
approval → bounded action → verified result**

Roadmap items describe direction, not a delivery guarantee. Shipped behavior is
documented in the README and release notes.

## Public beta: trustworthy local evidence

- One-command Claude Code and Codex activity discovery.
- Honest separation of provider-billed cost, subscription context,
  API-equivalent value, and missing cost bases.
- Project/model attribution, source coverage, freshness, and provenance.
- Context Health and one evidence-backed session action.
- A shared data contract across CLI, MCP/plugin, and the Glance source preview.
- Optional read-only OpenAI and Anthropic billing reconciliation.
- Cursor and GitHub Copilot connectors labeled fixture-verified beta until live
  account validation is complete.

This layer can answer what observed work is driving the available cost evidence
and what a user should investigate next. Cross-provider company ownership,
centralized subscription reconciliation, accepted outcomes, approvals, and ROI
remain later milestones and must stay labeled as such.

## Now: reliability, runway, and distribution

- Make clean CLI and MCP installation the fastest path to first value.
- Finish the human-readable limits/runway view over the existing canonical
  contract; never infer a window a provider or coding agent did not report.
- Resolve installation, privacy, data-trust, and semantic issues reported by
  beta users before adding breadth.
- Package Glance as a standalone, signed, notarized, independently installable,
  safely updatable Mac app before describing it as a public download.
- Complete the public comprehension/retention study and real provider-billing
  reconciliation cases.

## Next: an open Agent Economics Receipt

Publish a portable, versioned record for one unit of agent work. It will keep
these concepts separate:

- invoice cost, credits/overage, subscription capacity, and API-equivalent
  value;
- observed, reported, calculated, estimated, modeled, missing, and verified
  provenance;
- source, freshness, coverage, and reconciliation;
- agent, provider, model, project, client, work unit, attempt, verification,
  outcome, rework, recommendation, approval, and result.

Raw prompts and responses will not be embedded by default. External trace and
task references can provide evidence without making aibill another prompt
warehouse.

## Then: outcomes and financial CI

- `aibill outcome`: connect coding-agent activity to Git, tests, CI, reviews,
  and task/PR acceptance. Cost per outcome remains pending until the outcome is
  actually accepted.
- `aibill guard`: warn on cost-per-success regressions, falling billing
  coverage, missing attribution, or ROI claims without sufficient evidence.
- Read-only imports from open observability standards and products instead of
  rebuilding their tracing and evaluation interfaces.

The first controls will warn, recommend, and request explicit approval. Hard
enforcement requires a real provider control or gateway adapter and validated
team policy.

## Later: opt-in aibill Workspace

Workspace will be the paid, permissioned financial teammate over a shared
organizational ledger of approved Agent Economics Receipts:

- centralized provider and subscription reconciliation;
- project, client, user, agent, and use-case allocation;
- retained history, budgets, anomalies, approvals, and audit records;
- verified cost-per-outcome and rework where evidence supports it;
- export and deletion from the first alpha.

Its two role-scoped experiences will answer:

- **Employees:** What am I working on, what is consuming capacity, can I
  finish, is it attributed correctly, and what should I do next?
- **Spend owners and finance:** What changed, who owns it, which numbers
  reconcile, where did cost per accepted outcome regress, what needs approval,
  and did the approved action work?

Defensible ROI comes only after reconciled cost, an accepted outcome, and
independently evidenced business value. Workspace must not turn activity or
token volume into an invented ROI number.

Local-only mode will remain free and private. Synchronization will be explicit,
aggregate-only, inspectable before upload, and optional.

## Explicit non-goals for this sequence

- A general trace explorer or raw-prompt warehouse.
- Prompt management or a general-purpose evaluation suite.
- A new model gateway, router, or cache.
- An always-on financial persona injected into every agent turn.
- Autonomous spend enforcement without explicit policy and provider support.
- Productivity or ROI claims based on tokens, lines of code, or invented hours
  saved.
- A crowded compact Glance dashboard; it remains current work, runway, source
  health, and one action.

## How priorities change

Priorities change when beta users or design partners provide evidence, a trust
or release blocker appears, a provider changes a required data path, or a
measured product assumption fails. Feature parity and novelty alone are not
enough. Open an issue describing the user decision, evidence, data source, and
success measure for a proposed change.
