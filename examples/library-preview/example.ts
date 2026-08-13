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
  usageRecordSchema,
  type AgentEconomicsReceiptV0,
  type AgentEconomicsReceiptV0DraftInput,
  type CostConfidence,
  type FocusProjection,
  type FocusProjectionTarget,
  type OpenTelemetryGenAiProjection,
  type SpendSummary,
  type TokenomicsProjection,
  type UsageRecord
} from "@agent-finops/core";
import {
  generatePlainEnglishSummary,
  groupByDimensions,
  type GroupByDimension,
  type PlainEnglishSummaryOptions
} from "@agent-finops/report";

const record: UsageRecord = parseUsageRecord({
  id: "typed-example-call-1",
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

const summary: SpendSummary = analyzeSpend([record]);
const confidence: CostConfidence = record.costConfidence;
const reference = createReceiptSourceRecordReference(record.source.id, record.id);
const receiptDraft: AgentEconomicsReceiptV0DraftInput = {
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
    sourceRecordReferences: [reference]
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
    sourceRecordReferences: [reference]
  }],
  mappingGaps: []
};
const receipt: AgentEconomicsReceiptV0 = createAgentEconomicsReceiptV0(receiptDraft);

const reportOptions: PlainEnglishSummaryOptions = {
  records: [record],
  mode: "local-logs",
  color: false
};
const terminalReceipt: string = generatePlainEnglishSummary(summary, reportOptions);
const parsed: AgentEconomicsReceiptV0 = parseAgentEconomicsReceiptV0(receipt);
const focusTarget: FocusProjectionTarget = "focus_1_4";
const focus: FocusProjection = projectAgentEconomicsReceiptV0ToFocus(parsed, focusTarget);
const openTelemetry: OpenTelemetryGenAiProjection =
  projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(parsed);
const tokenomics: TokenomicsProjection = projectAgentEconomicsReceiptV0ToTokenomics(parsed);
const dimension: GroupByDimension = groupByDimensions[0]!;

usageRecordSchema.parse(record);
agentEconomicsReceiptV0DraftSchema.parse(receiptDraft);
agentEconomicsReceiptV0Schema.parse(receipt);
void {
  confidence,
  dimension,
  FOCUS_1_4_PIN,
  FOCUS_1_5_WORKING_DRAFT_PIN,
  OTEL_GENAI_DEVELOPMENT_PIN,
  TOKENOMICS_TRACKING_PIN
};

void { terminalReceipt, focus, openTelemetry, tokenomics };
