# @agent-finops/core

The canonical local-first evidence and decision engine for
[aibill](https://github.com/futurastudio/ai-spend-agent): Claude Code/Codex
activity ingestion, experimental Gemini CLI financial ingestion, provider cost
semantics, attribution, provenance, runway, Context Health, and the shared
Glance contract. Gemini support is fixture-verified and does not enter the
Glance/status-line or Context Health contracts.

Most users should run `npx aibill`. This package is for integrations that
need the same evidence-labeled calculations as the CLI and MCP server.

## Supported library preview

Use Node.js 22+ ESM and import only from the package root:

```ts
import { analyzeSpend, parseUsageRecord } from "@agent-finops/core";
```

The supported 0.x subset covers usage-record validation/parsing,
`analyzeSpend`, Receipt v0 creation/parsing, opaque source-record references,
and the explicitly version-pinned FOCUS, OpenTelemetry GenAI, and Tokenomics
projections. Tokenomics remains a `not_published`, zero-row tracking stub.

An explicit export map blocks unsupported deep imports. Other historical root
exports remain available for compatibility but are not stabilized by this
narrow preview. See the complete
[library contract](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/LIBRARY.md),
including the runnable JavaScript/TypeScript example and 0.x deprecation
policy.

The supported functions are local, deterministic operations on caller-supplied
objects for a given package version. Importing this package does not read
transcripts or credentials, write state, call a provider, upload evidence, or
send telemetry.

Schema parsing checks structure and internal consistency; it does not
authenticate a source, verify a price, or reconcile an invoice. Callers must
keep provenance and confidence labels truthful: reserve `verified` for
official provider-reported financial evidence, keep modeled/local value
`estimated` or `missing`, and leave unvalidated adapters `untested`.

This is the open foundation for aibill's financial-accountability mission. This
package includes contracts for locally confirmed ownership, local
self-attested approvals, and opt-in accepted GitHub outcomes. Those are
not company-wide identity, RBAC, approval routing, invoice reconciliation, or
verified business ROI.

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
