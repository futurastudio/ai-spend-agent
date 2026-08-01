# @agent-finops/core

The canonical local-first evidence and decision engine for
[aibill](https://github.com/futurastudio/ai-spend-agent): Claude Code/Codex
activity ingestion, provider cost semantics, attribution, provenance, runway,
Context Health, and the shared Glance contract.

Most users should run `npx aibill`. This package is for integrations that
need the same evidence-labeled calculations as the CLI and MCP server.

This is the open foundation for aibill's financial-accountability mission. It
does not yet implement company-wide ownership, accepted outcomes, approvals,
invoice reconciliation, or ROI.

Local API-equivalent estimates, subscription context, and official
provider-reported cost are separate concepts and must not be added together.

MIT licensed. See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) and
[public roadmap](https://github.com/futurastudio/ai-spend-agent/blob/main/ROADMAP.md).
