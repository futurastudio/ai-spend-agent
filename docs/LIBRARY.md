# Supported Node library preview

`@agent-finops/core` exposes a small, local-first evidence contract for teams
that need aibill's validation, analysis, and Receipt v0 semantics inside their
own Node applications. `@agent-finops/report` can render the resulting summary
with the same evidence labels as the CLI.

This supported subset is published in **v0.9.1**. It remains a **0.x preview**,
not a promise that every name currently available
from the root barrels is stable. The supported subset below is the contract we
test from packed npm artifacts.

## Runtime and import boundary

- Node.js 22 or newer.
- ESM only. Set `"type": "module"`; TypeScript projects should use
  `module: "NodeNext"` and `moduleResolution: "NodeNext"`.
- Import only from `@agent-finops/core` and `@agent-finops/report`.
- Deep imports such as `@agent-finops/core/dist/analyze.js`,
  `@agent-finops/core/analyze`, or `@agent-finops/report/terminal` are not
  public API and are blocked by package export maps.
- CommonJS `require`, browsers, edge runtimes, Deno, and Bun are not part of
  this preview's tested runtime matrix.

The legacy `main` and `types` fields remain in each manifest for root-import
compatibility with ESM-aware tooling. The export map is authoritative.

> **Caller trust boundary:** schema parsing validates shape and internal
> consistency; it does not authenticate where a record came from, reconcile an
> invoice, verify a price, or independently prove a confidence label. The
> caller must keep `mode`, provenance, validation coverage, and financial
> evidence truthful. Use `verified` only for an amount observed in an official
> provider-reported financial record. Locally observed or modeled API-rate
> value remains `estimated` (or `missing`), and an adapter without completed
> fixture or live validation remains `untested`. The report renderer preserves
> these caller-supplied claims; it cannot turn them into proof.

## Supported 0.x subset

### `@agent-finops/core`

| Capability | Supported root exports | Boundary |
| --- | --- | --- |
| Usage-record validation | `usageRecordSchema`, `parseUsageRecord`, `UsageRecord`, `CostConfidence` | Invalid or internally inconsistent evidence throws; missing cost remains `null` with `missing` confidence. This is schema validation, not source authentication. |
| Evidence analysis | `analyzeSpend`, `SpendSummary` | Pure analysis of caller-supplied normalized records. It does not read local agent files or contact a provider. |
| Receipt v0 | `createAgentEconomicsReceiptV0`, `parseAgentEconomicsReceiptV0`, `createReceiptSourceRecordReference`, `agentEconomicsReceiptV0DraftSchema`, `agentEconomicsReceiptV0Schema`, `AgentEconomicsReceiptV0`, `AgentEconomicsReceiptV0DraftInput`, `AGENT_ECONOMICS_RECEIPT_KIND`, `AGENT_ECONOMICS_RECEIPT_V0_VERSION` | Creates or validates the content-addressed `0.1.0` envelope. Unknown schema versions, stale digests, invalid totals, and unresolved references fail closed. |
| FOCUS projections | `projectAgentEconomicsReceiptV0ToFocus`, `FOCUS_1_4_PIN`, `FOCUS_1_5_WORKING_DRAFT_PIN`, `FocusProjection`, `FocusProjectionTarget` | The target is explicit. FOCUS 1.4 is ratified; FOCUS 1.5 is pinned to the working draft dated 2026-08-08. API-equivalent value never becomes `BilledCost`. |
| OpenTelemetry GenAI projection | `projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi`, `OTEL_GENAI_DEVELOPMENT_PIN`, `OpenTelemetryGenAiProjection` | Pinned as `development-2026-08-08` and returned as a projection, never a claim of a conformant emitted span. |
| Tokenomics tracking stub | `projectAgentEconomicsReceiptV0ToTokenomics`, `TOKENOMICS_TRACKING_PIN`, `TokenomicsProjection` | Tracked as of 2026-08-08. The technical specification is not published, so the function deliberately returns zero rows and an explicit gap. |

Other root exports remain available for existing callers, but are not in the
narrow supported-library subset yet. They may change during 0.x without the
deprecation window described below.

### `@agent-finops/report`

`generatePlainEnglishSummary`, `PlainEnglishSummaryOptions`,
`GroupByDimension`, and `groupByDimensions` form the supported renderer subset.
The function signature and evidence-label semantics are supported; terminal
wording, spacing, color, and table layout are presentation, not a byte-stable
data contract. Use the typed core objects—not parsed terminal text—for
integrations.

The other Markdown, HTML, Apply, policy, verification, and report-card root
exports remain preview surfaces for existing callers, not part of this narrow
support promise.

## Five-minute Node 22 ESM example

Create an empty directory:

```bash
npm init -y
npm pkg set type=module
npm install @agent-finops/core @agent-finops/report
```

Save this as `example.mjs`:

```js
import { analyzeSpend, parseUsageRecord } from "@agent-finops/core";
import { generatePlainEnglishSummary } from "@agent-finops/report";

const record = parseUsageRecord({
  id: "call-1",
  timestamp: "2026-08-13T14:00:00.000Z",
  source: {
    id: "my-adapter",
    name: "My supported adapter",
    provider: "openai",
    confidence: "estimated",
    observedFrom: "my_local_adapter"
  },
  model: "gpt-5.5",
  inputTokens: 1200,
  outputTokens: 240,
  amountUsd: 0.012,
  costConfidence: "estimated",
  projectId: "checkout",
  operation: "code-review",
  usageGranularity: "call"
});

const summary = analyzeSpend([record]);
console.log(generatePlainEnglishSummary(summary, {
  records: [record],
  mode: "local-logs",
  color: false
}));
```

Run it with `node example.mjs`. The amount is labeled API-equivalent estimated
value because that is what the input record says; the library does not upgrade
it to billed spend.

For TypeScript, add `typescript` and `@types/node`, use this configuration, and
run `npx tsc --noEmit`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

The repository's runnable
[`examples/library-preview/example.ts`](../examples/library-preview/example.ts)
continues through Receipt v0 creation/parsing plus the pinned FOCUS,
OpenTelemetry, and Tokenomics projections. CI installs packed tarballs into a
clean consumer, executes the JavaScript version, type-checks the TypeScript
version with `tsc --noEmit`, and verifies that runtime and TypeScript deep
imports fail.

## Local-first privacy boundary

The supported core functions above operate locally only on objects the caller
passes in. The report renderer also stays local; when `color` is omitted it
reads only standard terminal presentation state (`NO_COLOR`, `FORCE_COLOR`,
and TTY detection). Pass explicit `color` and `width` options when reproducible
presentation matters.

These supported calls do not read transcripts, credentials, or aibill state;
they do not write files, send telemetry, upload evidence, or call any network
service. Your application owns collection, consent, storage, and transport of
its input and output.

The CLI's local readers and optional provider connectors are separate surfaces
with separate permissions. Importing these two package roots has no startup or
network side effect.

## 0.x compatibility and deprecation policy

- Patch releases do not intentionally break the documented supported subset.
- A planned breaking change to this subset lands in a new minor release. When
  practical, the old API is deprecated for at least one minor before removal.
- An evidence-integrity, privacy, or security correction may fail closed
  immediately. The release notes will call out the changed behavior.
- Receipt `schemaVersion` is independent of the npm version. Parsers reject an
  unknown receipt version rather than guessing compatibility.
- Root exports outside the table and all generated presentation wording may
  change during 0.x without a deprecation period.
- No deep-import path is supported, even if a file happens to exist inside a
  tarball.

If you need another contract stabilized, open a focused request with the use
case, required evidence semantics, and runtime in the
[public issue tracker](https://github.com/futurastudio/ai-spend-agent/issues).
