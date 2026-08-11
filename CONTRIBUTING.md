# Contributing to aibill

Thank you for helping build the open evidence layer for financial
accountability across the AI-agent workforce.
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
npm run check:source-fixtures
npm run check:source-docs
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

## Contributing a local-agent parser

Start with a GitHub issue describing the agent, its documented on-device data
format, and the smallest useful fixture matrix. Do not attach a real transcript.
A parser proposal should add a registry-owned format descriptor and minimal,
synthetic recorded fixtures without adding source-specific branches to the CLI,
MCP server, reports, Glance, or other shared consumers.

Add the stable format ID to `packages/core/src/localAgentFormats/types.ts`,
then keep its descriptor and runtime adapter under that same registry-owned
directory. This preserves the existing public TypeScript union while keeping
future parser changes inside the registry boundary.

Each descriptor must declare:

- a stable format ID, provider, discovery boundary, and deterministic order;
- validation coverage separately from financial-evidence defaults;
- `estimated` for supported transcript-derived API-equivalent value and
  `missing` for unsupported or unpriced values—never provider-billed spend;
- normalized source-record semantics, capabilities, and full versus optimized
  financial-reader behavior;
- documentation for how the format is read, fields used, evidence boundaries,
  privacy, limitations, and recorded fixture IDs.

When a format has both financial files and a presence-only signal, declare
them separately. A detection file may support an honest empty-state funnel but
must never enter the financial parser or create a zero-dollar row. Bound
multi-format readers by both extension and a required ancestor directory; do
not treat a broad product-state directory as financial evidence.

Fixtures must be minimal synthetic reproductions of observed format shapes.
Remove prompts, responses, credentials, account identifiers, session IDs, user
names, and concrete home paths. A fixture proves reader behavior; it cannot
promote validation coverage or financial evidence. Malformed, unsupported,
partial, retry/duplicate, and empty cases should fail honestly, and incomplete
token shapes must remain `missing` instead of becoming an estimated `$0`.
Opaque hash directories must stay opaque: never reverse, guess, or expose them
as project names. Attribute only from usable session-carried project/cwd
evidence, otherwise use a privacy-safe alias or leave the record unattributed.

Keep full and optimized financial readers behavior-compatible and preserve all
existing CLI/JSON, MCP, report, statusline, cache, and Glance output. Adding a
future parser must stay inside the parser-registry boundary plus fixtures. Any
new shared engine capability must be source-neutral and descriptor-gated; do
not add parser-specific logic to Glance, statusline, Context Health, or Apply.
Regenerate the public source pages from the
registry and verify that nothing drifted:

```bash
npm run generate:source-docs
npm run check:source-docs
```

The generator reads the built `@agent-finops/core` registry and produces
deterministic files under `docs/sources/`. Do not edit those pages by hand.

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
