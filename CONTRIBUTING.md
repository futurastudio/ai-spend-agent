# Contributing to aibill

Thank you for helping build an open financial intelligence layer for AI agents.
Bug reports, source-format fixtures, pricing updates, documentation, and small
focused pull requests are especially useful during the public beta.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- macOS only for the native Glance target

```bash
git clone https://github.com/futurastudio/ai-spend-agent
cd ai-spend-agent
npm ci
npm run typecheck
npm test
npm run build
```

Before opening a pull request, also run:

```bash
npm run check:public-boundary
npm run check:adapters
```

## Product and data rules

1. Keep calculations and shared contracts in `@agent-finops/core`. CLI, MCP,
   Glance, reports, and future hosted adapters must not invent separate usage,
   billing, provenance, or recommendation logic.
2. Keep billed cost, credits/overage, subscription capacity, and
   API-equivalent value distinct.
3. Label each field's source, freshness, coverage, and confidence. Missing data
   remains missing.
4. Never add a real credential, transcript, account identifier, home path, or
   internal planning document to code, fixtures, screenshots, packages, or
   commits.
5. Use synthetic, minimal fixtures. Provider connector tests must not make live
   paid requests or depend on a contributor's account.
6. Keep Glance compact. A feature appropriate for Terminal or Workspace does
   not automatically belong in the hover panel.
7. Prefer read-only integrations with observability/evaluation products over
   duplicating their trace, prompt, evaluation, gateway, routing, or caching
   products.
8. Do not claim savings, productivity, or ROI without an observable outcome and
   sufficient reconciliation evidence.

## Pull requests

- Start with an issue for a new parser, connector, contract change, or large UI
  change.
- Keep one coherent purpose per pull request.
- Add or update tests for behavior and data semantics.
- Document user-visible behavior and limitations.
- Note whether package versions, public schemas, privacy boundaries, or
  provider credentials are affected.
- Confirm that no internal/private files appear in `git status`, the diff, or
  packed npm artifacts.

See [ROADMAP.md](ROADMAP.md) for current priorities and explicit non-goals.
Security issues belong in the private process described in
[SECURITY.md](SECURITY.md), not in a public pull request.
