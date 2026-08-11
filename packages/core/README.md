# @agent-finops/core

The canonical local-first evidence and decision engine for
[aibill](https://github.com/futurastudio/ai-spend-agent): Claude Code/Codex
activity ingestion, experimental Gemini CLI financial ingestion, provider cost
semantics, attribution, provenance, runway, Context Health, and the shared
Glance contract. Gemini support is fixture-verified and does not enter the
Glance/status-line or Context Health contracts.

Most users should run `npx aibill`. This package is for integrations that
need the same evidence-labeled calculations as the CLI and MCP server.

This is the open foundation for aibill's financial-accountability mission. It
does not yet implement company-wide ownership, accepted outcomes, approvals,
invoice reconciliation, or ROI.

Local API-equivalent estimates, subscription context, and official
provider-reported cost are separate concepts and must not be added together.
Reader/connector validation (`live_verified`, `fixture_verified`, `untested`,
or `failed`) is also separate from each number's financial evidence
(`verified`, `estimated`, `detected_unverified`, or `missing`). A live-tested
local reader still emits estimates or missing cost—not billed spend.
Source-boundary approval is a third, permission-only field: approving a folder
for read-only scanning never verifies any financial number inside it.

MIT licensed. See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) and
[public roadmap](https://github.com/futurastudio/ai-spend-agent/blob/main/ROADMAP.md).
