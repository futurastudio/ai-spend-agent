import {
  AGENT_ECONOMICS_RECEIPT_KIND,
  AGENT_ECONOMICS_RECEIPT_V0_VERSION,
  FOCUS_1_4_PIN,
  FOCUS_1_5_WORKING_DRAFT_PIN,
  OTEL_GENAI_DEVELOPMENT_PIN,
  TOKENOMICS_TRACKING_PIN,
  agentEconomicsReceiptV0DraftSchema,
  agentEconomicsReceiptV0Schema,
  analyzeSpend,
  createAgentEconomicsReceiptV0,
  createReceiptSourceRecordReference,
  parseAgentEconomicsReceiptV0,
  parseUsageRecord,
  projectAgentEconomicsReceiptV0ToFocus,
  projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi,
  projectAgentEconomicsReceiptV0ToTokenomics,
  usageRecordSchema
} from "@agent-finops/core";
import {
  generatePlainEnglishSummary,
  groupByDimensions
} from "@agent-finops/report";

const record = parseUsageRecord({
  id: "example-call-1",
  timestamp: "2026-08-13T14:00:00.000Z",
  source: {
    id: "local-example",
    name: "Local example adapter",
    provider: "openai",
    confidence: "estimated",
    observedFrom: "supported_local_adapter"
  },
  model: "gpt-5.5",
  inputTokens: 1_200,
  outputTokens: 240,
  amountUsd: 0.012,
  costConfidence: "estimated",
  projectId: "example-project",
  operation: "code-review",
  usageGranularity: "call"
});

const summary = analyzeSpend([record]);
const sourceRecordReference = createReceiptSourceRecordReference(
  record.source.id,
  record.id
);
const receipt = createAgentEconomicsReceiptV0({
  kind: AGENT_ECONOMICS_RECEIPT_KIND,
  schemaVersion: AGENT_ECONOMICS_RECEIPT_V0_VERSION,
  generatedAt: "2026-08-13T14:05:00.000Z",
  mode: "local",
  demoOnly: false,
  window: {
    start: "2026-08-13T13:59:00.000Z",
    end: "2026-08-13T14:01:00.000Z"
  },
  sources: [{
    id: record.source.id,
    kind: "local_agent_log",
    provider: record.source.provider,
    validationCoverage: "untested",
    freshness: {
      status: "fresh",
      checkedAt: "2026-08-13T14:01:00.000Z",
      latestEvidenceAt: record.timestamp
    }
  }],
  lines: [{
    id: "tokens-1",
    kind: "token_usage",
    sourceId: record.source.id,
    provider: record.source.provider,
    model: record.model,
    requestedModel: record.model,
    observedAt: record.timestamp,
    granularity: "call",
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    provenance: {
      origin: "locally_observed",
      transformations: ["normalized"]
    },
    sourceRecordReferences: [sourceRecordReference]
  }, {
    id: "cost-1",
    kind: "financial_cost",
    sourceId: record.source.id,
    observedAt: record.timestamp,
    granularity: "call",
    amountUsd: 0.012,
    currency: "USD",
    accountingBasis: "api_equivalent",
    financialEvidence: "estimated",
    provenance: {
      origin: "locally_observed",
      transformations: ["normalized", "api_rate_estimated"]
    },
    sourceRecordReferences: [sourceRecordReference]
  }],
  mappingGaps: []
});

const parsedReceipt = parseAgentEconomicsReceiptV0(
  JSON.parse(JSON.stringify(receipt))
);
const focus = projectAgentEconomicsReceiptV0ToFocus(receipt, "focus_1_4");
const openTelemetry = projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(receipt);
const tokenomics = projectAgentEconomicsReceiptV0ToTokenomics(receipt);
const focusCostRow = focus.rows.find((row) => row.kind === "financial_cost");
const terminal = generatePlainEnglishSummary(summary, {
  records: [record],
  mode: "local-logs",
  color: false
});

if (
  !usageRecordSchema.safeParse(record).success ||
  !agentEconomicsReceiptV0DraftSchema.safeParse({
    kind: receipt.kind,
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    mode: receipt.mode,
    demoOnly: receipt.demoOnly,
    window: receipt.window,
    sources: receipt.sources,
    lines: receipt.lines,
    mappingGaps: receipt.mappingGaps
  }).success ||
  !agentEconomicsReceiptV0Schema.safeParse(receipt).success ||
  parsedReceipt.id !== receipt.id ||
  receipt.sources[0]?.validationCoverage !== "untested" ||
  FOCUS_1_4_PIN.version !== "1.4" ||
  FOCUS_1_5_WORKING_DRAFT_PIN.draftAsOf !== "2026-08-08" ||
  OTEL_GENAI_DEVELOPMENT_PIN.version !== "development-2026-08-08" ||
  TOKENOMICS_TRACKING_PIN.status !== "not_published" ||
  focus.target.version !== "1.4" ||
  focusCostRow?.BilledCost !== null ||
  focusCostRow?.extensions["x_aibill.api_equivalent_cost_usd"] !== 0.012 ||
  !focus.gaps.some((gap) => gap.code === "api_equivalent_not_billed_cost") ||
  openTelemetry.target.status !== "development" ||
  tokenomics.target.status !== "not_published" ||
  !groupByDimensions.includes("project") ||
  !terminal.includes("LOCAL ESTIMATE") ||
  !terminal.includes("API-EQUIVALENT VALUE") ||
  !terminal.includes("not billed spend") ||
  !terminal.includes("estimated") ||
  terminal.includes("PROVIDER-REPORTED COST") ||
  terminal.length === 0
) {
  throw new Error("The supported library example did not satisfy its contract.");
}

console.log(JSON.stringify({
  totalUsd: summary.totalUsd,
  receiptSchemaVersion: receipt.schemaVersion,
  focusRows: focus.rows.length,
  openTelemetryRows: openTelemetry.rows.length,
  tokenomicsRows: tokenomics.rows.length,
  focusApiEquivalentNotBilled: true,
  exampleAdapterValidationCoverage: receipt.sources[0].validationCoverage,
  terminalEvidenceLabels: true,
  renderedTerminalReceipt: true
}));
