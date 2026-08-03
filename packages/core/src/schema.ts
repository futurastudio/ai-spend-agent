import { z } from "zod";

export const costConfidenceValues = [
  "verified",
  "estimated",
  "detected_unverified",
  "missing"
] as const;

export const costConfidenceSchema = z.enum(costConfidenceValues);
export type CostConfidence = z.infer<typeof costConfidenceSchema>;

export const spendSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  confidence: costConfidenceSchema,
  observedFrom: z.string().min(1)
});
export type SpendSource = z.infer<typeof spendSourceSchema>;

/**
 * What one normalized usage record represents.
 *
 * Only `call` and `invocation` are precise enough to support per-workload
 * counterfactuals such as model routing, result caching, Batch API moves, or
 * prompt trimming. The remaining values are still useful financial evidence,
 * but must never be silently treated as individual calls.
 */
export const usageGranularityValues = [
  "call",
  "invocation",
  "session",
  "daily_aggregate",
  "usage_bucket",
  "billing_bucket",
  "seat",
  "user_aggregate"
] as const;

export const usageGranularitySchema = z.enum(usageGranularityValues);
export type UsageGranularity = z.infer<typeof usageGranularitySchema>;

/**
 * Explicit adapter attestations for workload-specific optimization advice.
 * These fields are intentionally absent by default: an operation label alone
 * does not prove identical inputs, latency tolerance, or downgrade safety.
 */
export const workloadSemanticsSchema = z.object({
  stableInputFingerprint: z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/).optional(),
  batchEligible: z.boolean().optional(),
  downgradeSafe: z.boolean().optional()
}).strict();
export type WorkloadSemantics = z.infer<typeof workloadSemanticsSchema>;

export const usageRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  source: spendSourceSchema,
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  amountUsd: z.number().nonnegative().nullable(),
  costConfidence: costConfidenceSchema,
  clientId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  apiKeyId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  providerCostType: z.string().min(1).optional(),
  quantity: z.number().nonnegative().optional(),
  agentId: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  usageGranularity: usageGranularitySchema.optional(),
  workloadSemantics: workloadSemanticsSchema.optional()
}).superRefine((record, context) => {
  if (record.costConfidence === "missing" && record.amountUsd !== null) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "Records with missing cost confidence must not include a cost."
    });
  }

  if (record.costConfidence !== "missing" && record.amountUsd === null) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "Records with cost confidence require a cost amount."
    });
  }
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/**
 * True only when a record can honestly ground a modeled workload change.
 *
 * A provider billing row, usage bucket, seat, user total, or unlabelled legacy
 * row may describe real spend, but it does not prove that one row was one
 * optimizable call. Requiring both explicit call/invocation provenance and a
 * named operation keeps aggregate connector data in accounting views without
 * manufacturing per-call savings advice from it.
 */
export function hasModeledWorkloadEvidence(record: UsageRecord): boolean {
  return (
    hasCallLevelProvenance(record) &&
    typeof record.operation === "string" &&
    record.operation.trim().length > 0 &&
    hasPricedEvidence(record)
  );
}

/** Explicit one-call / one-model-invocation provenance, never inferred. */
export function hasCallLevelProvenance(record: UsageRecord): boolean {
  return record.usageGranularity === "call" || record.usageGranularity === "invocation";
}

/** A positive priced observation from which a dollar counterfactual can be modeled. */
export function hasPricedEvidence(record: UsageRecord): boolean {
  return (
    typeof record.amountUsd === "number" &&
    record.amountUsd > 0 &&
    record.costConfidence !== "missing"
  );
}

/**
 * Recognize the bundled demo records written by releases that predate the
 * persisted `mode` field. The marker is deliberately narrow: every record
 * must come from the shipped sample CSV and use a sample source identifier.
 * This lets newer clients recover the demo boundary without guessing that an
 * arbitrary unlabeled state is real local or connected evidence.
 */
export function isBundledSampleUsage(records: UsageRecord[]): boolean {
  return records.length > 0 && records.every((record) =>
    record.source.observedFrom === "sample_csv" &&
    /(?:^|-)sample$/i.test(record.source.id)
  );
}

/**
 * Stable financial cohort for period-over-period comparisons. Missing shape
 * provenance returns `undefined`; unknown rows must not be pooled into a fake
 * comparable series.
 */
export function spendComparisonKey(record: UsageRecord): string | undefined {
  if (!record.providerCostType || !record.usageGranularity) {
    return undefined;
  }
  return [
    record.source.id,
    record.source.provider,
    record.providerCostType,
    record.usageGranularity
  ].map((part) => encodeURIComponent(part)).join("|");
}

export const attributionCandidateSchema = z.object({
  entityType: z.enum(["client", "project", "agent", "user", "workspace", "api_key"]),
  entityId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).min(1)
});
export type AttributionCandidate = z.infer<typeof attributionCandidateSchema>;

export const attributionMappingSchema = z.object({
  usageRecordId: z.string().min(1),
  candidates: z.array(attributionCandidateSchema),
  selected: attributionCandidateSchema.optional(),
  status: z.enum(["auto_mapped", "needs_confirmation", "needs_question", "unmapped"]),
  evidence: z.array(z.string().min(1))
});
export type AttributionMapping = z.infer<typeof attributionMappingSchema>;

export const spendBreakdownEntrySchema = z.object({
  key: z.string().min(1),
  amountUsd: z.number().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  confidence: costConfidenceSchema
});
export type SpendBreakdownEntry = z.infer<typeof spendBreakdownEntrySchema>;

export const spendAnomalySchema = z.object({
  kind: z.enum(["day_over_day_spike", "week_over_week_spike"]),
  key: z.string().min(1),
  comparisonKey: z.string().min(1).optional(),
  previousAmountUsd: z.number().nonnegative(),
  currentAmountUsd: z.number().nonnegative(),
  multiplier: z.number().nonnegative(),
  confidence: costConfidenceSchema
});
export type SpendAnomaly = z.infer<typeof spendAnomalySchema>;

export const workflowWatchEntrySchema = z.object({
  id: z.string().min(1),
  clientId: z.string().min(1),
  projectId: z.string().min(1),
  workflowKey: z.string().min(1),
  agentId: z.string().min(1),
  amountUsd: z.number().nonnegative(),
  shareOfSpend: z.number().min(0).max(1),
  recordCount: z.number().int().nonnegative(),
  confidence: costConfidenceSchema,
  estimatedMarginRiskUsd: z.number().nonnegative(),
  estimatedSavingsUsd: z.number().nonnegative(),
  suggestedOptimization: z.string().min(1),
  applyArtifact: z.string().min(1),
  verificationPlan: z.string().min(1)
});
export type WorkflowWatchEntry = z.infer<typeof workflowWatchEntrySchema>;

export const recommendationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  whyItMatters: z.string().min(1),
  nextAction: z.string().min(1),
  priority: z.enum(["high", "medium", "low"]),
  estimatedImpactUsd: z.number().nonnegative(),
  confidence: costConfidenceSchema,
  relatedKeys: z.array(z.string().min(1))
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const evidenceItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  detail: z.string().min(1).optional()
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const spendInsightSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "spike_explanation",
    "margin_risk",
    "agent_runaway",
    "model_misuse",
    "context_bloat",
    "unmapped_spend",
    "connector_gap",
    "optimization_opportunity"
  ]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  evidence: z.array(evidenceItemSchema).min(1),
  affectedClients: z.array(z.string().min(1)),
  affectedProjects: z.array(z.string().min(1)),
  affectedAgents: z.array(z.string().min(1)),
  affectedModels: z.array(z.string().min(1)),
  estimatedImpactUsd: z.number().nonnegative(),
  confidence: costConfidenceSchema,
  recommendedAction: z.string().min(1),
  verificationNeeded: z.string().min(1).optional()
});
export type SpendInsight = z.infer<typeof spendInsightSchema>;

export const spendSummarySchema = z.object({
  totalUsd: z.number().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  confidence: costConfidenceSchema,
  confidenceBreakdown: z.record(costConfidenceSchema, z.number().nonnegative()),
  bySource: z.array(spendBreakdownEntrySchema),
  byModel: z.array(spendBreakdownEntrySchema),
  byClient: z.array(spendBreakdownEntrySchema),
  byProject: z.array(spendBreakdownEntrySchema),
  byAgent: z.array(spendBreakdownEntrySchema),
  byUser: z.array(spendBreakdownEntrySchema).default([]),
  byWorkspace: z.array(spendBreakdownEntrySchema).default([]),
  byApiKey: z.array(spendBreakdownEntrySchema).default([]),
  workflowWatch: z.array(workflowWatchEntrySchema),
  anomalies: z.array(spendAnomalySchema),
  recommendations: z.array(recommendationSchema),
  insights: z.array(spendInsightSchema).default([])
});
export type SpendSummary = z.infer<typeof spendSummarySchema>;

export function parseUsageRecord(value: unknown): UsageRecord {
  return usageRecordSchema.parse(value);
}

export function parseSpendSummary(value: unknown): SpendSummary {
  return spendSummarySchema.parse(value);
}
