# @agent-finops/core

The canonical local-first data and decision engine for
[aibill](https://github.com/futurastudio/ai-spend-agent): Claude Code/Codex
activity ingestion, provider cost semantics, attribution, provenance, runway,
Context Health, and the shared Glance contract.

Most users should run `npx aibill`. This package is for integrations that
need the same evidence-labeled calculations as the CLI and MCP server.

Local API-equivalent estimates, subscription context, and official
provider-reported cost are separate concepts and must not be added together.

MIT licensed. See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) and
[public roadmap](https://github.com/futurastudio/ai-spend-agent/blob/main/ROADMAP.md).
