import { z } from "zod";
import {
  aggregateCalls,
  dedupeCumulativeSessionCalls,
  type LocalAgentCall,
  type LocalAgentRateLimitWindow,
  type LocalAgentSourceScan
} from "./localAgentLogs.js";
import { localAgentFormatDescriptors } from "./localAgentFormats/registry.js";
import type { LocalAgentFormatId } from "./localAgentFormats/types.js";
import {
  canPriceTokenUsageAtScope,
  estimateTokenCostsUsd,
  PRICING_TABLE_AS_OF
} from "./modelPricing.js";
import type { DetectedPlan } from "./planDetection.js";
import { subscriptionPlans } from "./planMath.js";
import { isBundledSampleUsage, type UsageRecord } from "./schema.js";
import {
  sourceValidationCoverageValues,
  type SourceValidationCoverage
} from "./sourceStatus.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ActivitySnapshotAgent = Extract<LocalAgentFormatId, "claude-code" | "codex">;
export const activitySnapshotAgentValues: readonly ActivitySnapshotAgent[] = Object.freeze(
  localAgentFormatDescriptors
    .filter((descriptor) => descriptor.capabilities.statuslineSnapshot)
    .map((descriptor) => descriptor.id as ActivitySnapshotAgent)
);
const activitySnapshotAgentValueSet = new Set(activitySnapshotAgentValues);
const activitySnapshotAgentLimit = activitySnapshotAgentValues.length;

export const activitySnapshotPlanIdValues = [
  "claude-pro",
  "claude-max-5x",
  "claude-max-20x",
  "chatgpt-plus",
  "chatgpt-pro"
] as const;
export type ActivitySnapshotPlanId = typeof activitySnapshotPlanIdValues[number];

export const activitySnapshotProviderValues = [
  "openai",
  "anthropic",
  "cursor",
  "github-copilot",
  "other"
] as const;
export type ActivitySnapshotProvider = typeof activitySnapshotProviderValues[number];

export const activitySnapshotModeValues = [
  "metered",
  "subscription",
  "mixed",
  "unresolved",
  "empty",
  "error"
] as const;
export type ActivitySnapshotMode = typeof activitySnapshotModeValues[number];

export const activitySnapshotRefreshErrorCodeValues = [
  "scan_failed",
  "source_unreadable",
  "invalid_evidence",
  "timeout",
  "cache_write_failed",
  "unknown"
] as const;
export type ActivitySnapshotRefreshErrorCode =
  typeof activitySnapshotRefreshErrorCodeValues[number];

export const activitySnapshotProviderCoverageStatusValues = [
  "complete",
  "partial",
  "unavailable",
  "error"
] as const;
export type ActivitySnapshotProviderCoverageStatus =
  typeof activitySnapshotProviderCoverageStatusValues[number];

export type ActivitySnapshotProviderCoverageInput = {
  provider: ActivitySnapshotProvider;
  status: ActivitySnapshotProviderCoverageStatus;
  validationCoverage: SourceValidationCoverage;
  checkedAt?: string;
  latestEvidenceAt?: string;
  /** Receipt-bound provider interval; required before an empty window can prove $0. */
  coverageStart?: string;
  coverageEnd?: string;
};

export type ActivitySnapshotBuildInput = {
  /** One timestamp shared by every rolling window. */
  asOf: string;
  /** Explicit scan-completion time; keeps the pure builder deterministic. */
  generatedAt: string;
  records: readonly UsageRecord[];
  /** Calls are used only for activity presence and transcript-reported limits. */
  calls?: readonly LocalAgentCall[];
  detectedPlans?: readonly DetectedPlan[];
  sourceScans?: readonly LocalAgentSourceScan[];
  /** Only externally trust-validated, provider-reported records belong here. */
  trustedProviderRecordIds?: readonly string[];
  /** Explicit provider-billed overage records; must also be trusted. */
  billedOverageRecordIds?: readonly string[];
  providerCoverage?: readonly ActivitySnapshotProviderCoverageInput[];
  /**
   * C-lane §2.1: provider-billed subscriptions with no local agent (cursor).
   * The builder includes a billed30d amount only when the supplied window is
   * "verified"; anything else is degraded to a missing window (writer-side
   * lock — the renderer re-checks independently).
   */
  providerSubscriptions?: readonly {
    provider: ActivitySnapshotProvider;
    planLabel: string | null;
    committedUsdPerMonth: number | null;
    billed30d?: ActivitySnapshotBilledWindow;
  }[];
  pricingAsOf?: string;
  /** Deliberately accepts only false; a runtime true is rejected as defense in depth. */
  sampleData?: false;
};

const isoTimestampSchema = z.string().datetime({ offset: true });
const usdSchema = z.number().finite().nonnegative();
const countSchema = z.number().int().nonnegative();
const windowCoverageSchema = z.enum(["complete", "partial", "missing"]);
const agentSchema = z.string().refine(isSnapshotAgent, {
  message: "Agent must be registered as a local-agent format."
});
const planIdSchema = z.enum(activitySnapshotPlanIdValues).nullable();

export const activitySnapshotApiEquivalentWindowSchema = z.object({
  amountUsd: usdSchema.nullable(),
  recordCount: countSchema,
  basis: z.literal("api_equivalent"),
  financialEvidence: z.enum(["estimated", "missing"]),
  coverage: windowCoverageSchema
}).strict().superRefine((window, context) => {
  if ((window.amountUsd === null) !== (window.financialEvidence === "missing")) {
    context.addIssue({
      code: "custom",
      path: ["financialEvidence"],
      message: "API-equivalent amount and financial evidence must agree."
    });
  }
  if (window.coverage === "missing" && window.amountUsd !== null) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "Missing API-equivalent coverage cannot carry an amount."
    });
  }
  if (window.recordCount === 0 && window.amountUsd !== null &&
      (window.amountUsd !== 0 || window.coverage !== "complete")) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "An empty API-equivalent window may carry only a coverage-proved zero."
    });
  }
});
export type ActivitySnapshotApiEquivalentWindow = z.infer<
  typeof activitySnapshotApiEquivalentWindowSchema
>;

export const activitySnapshotBilledWindowSchema = z.object({
  amountUsd: usdSchema.nullable(),
  recordCount: countSchema,
  basis: z.literal("provider_billed"),
  financialEvidence: z.enum(["verified", "missing"]),
  coverage: windowCoverageSchema
}).strict().superRefine((window, context) => {
  if ((window.amountUsd === null) !== (window.financialEvidence === "missing")) {
    context.addIssue({
      code: "custom",
      path: ["financialEvidence"],
      message: "Provider-billed amount and financial evidence must agree."
    });
  }
  if (window.coverage === "missing" && window.amountUsd !== null) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "Missing provider-billed coverage cannot carry an amount."
    });
  }
  if (window.recordCount === 0 && window.amountUsd !== null &&
      (window.amountUsd !== 0 || window.coverage !== "complete")) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "An empty provider-billed window may carry only a receipt-proved zero."
    });
  }
});
export type ActivitySnapshotBilledWindow = z.infer<typeof activitySnapshotBilledWindowSchema>;

function rollingWindowsSchema<T extends z.ZodType>(windowSchema: T) {
  return z.object({
    oneDay: windowSchema,
    sevenDays: windowSchema,
    thirtyDays: windowSchema
  }).strict();
}

export const activitySnapshotApiEquivalentWindowsSchema = rollingWindowsSchema(
  activitySnapshotApiEquivalentWindowSchema
);
export type ActivitySnapshotApiEquivalentWindows = z.infer<
  typeof activitySnapshotApiEquivalentWindowsSchema
>;

export const activitySnapshotBilledWindowsSchema = rollingWindowsSchema(
  activitySnapshotBilledWindowSchema
);
export type ActivitySnapshotBilledWindows = z.infer<typeof activitySnapshotBilledWindowsSchema>;

function rollingWindowsHaveEvidence(windows: {
  oneDay: { amountUsd: number | null; recordCount: number };
  sevenDays: { amountUsd: number | null; recordCount: number };
  thirtyDays: { amountUsd: number | null; recordCount: number };
}): boolean {
  return [windows.oneDay, windows.sevenDays, windows.thirtyDays]
    .some((window) => window.recordCount > 0 || window.amountUsd !== null);
}

function uniqueAgentEntries(
  value: { agents: readonly { agent: string }[] },
  context: z.RefinementCtx
): void {
  if (new Set(value.agents.map((agent) => agent.agent)).size !== value.agents.length) {
    context.addIssue({
      code: "custom",
      path: ["agents"],
      message: "A cohort may contain each agent only once."
    });
  }
}

export const activitySnapshotLimitSchema = z.object({
  kind: z.enum(["five-hour", "weekly"]),
  usedPercent: z.number().finite().min(0).max(100),
  remainingPercent: z.number().finite().min(0).max(100),
  observedAt: isoTimestampSchema,
  resetsAt: isoTimestampSchema,
  source: z.literal("transcript_reported")
}).strict().superRefine((limit, context) => {
  if (Math.abs(limit.usedPercent + limit.remainingPercent - 100) > 0.11) {
    context.addIssue({
      code: "custom",
      path: ["remainingPercent"],
      message: "Reported used and remaining percentages must sum to 100."
    });
  }
  if (Date.parse(limit.observedAt) >= Date.parse(limit.resetsAt)) {
    context.addIssue({
      code: "custom",
      path: ["resetsAt"],
      message: "A reported limit reset must follow its observation."
    });
  }
});
export type ActivitySnapshotLimit = z.infer<typeof activitySnapshotLimitSchema>;

export const activitySnapshotSubscriptionAgentSchema = z.object({
  agent: agentSchema,
  billing: z.literal("subscription"),
  planId: planIdSchema,
  /** C-lane §2.1: detected-plan list price; null when the plan is unpriced. */
  committedUsdPerMonth: usdSchema.nullable(),
  apiEquivalent: activitySnapshotApiEquivalentWindowsSchema,
  limits: z.array(activitySnapshotLimitSchema).max(2),
  pressure: z.enum(["extra_usage_credits_exhausted"]).nullable()
}).strict().superRefine((value, context) => {
  if (new Set(value.limits.map((limit) => limit.kind)).size !== value.limits.length) {
    context.addIssue({
      code: "custom",
      path: ["limits"],
      message: "An agent may contain at most one limit of each kind."
    });
  }
});
export type ActivitySnapshotSubscriptionAgent = z.infer<
  typeof activitySnapshotSubscriptionAgentSchema
>;

const activitySnapshotSubscriptionSchema = z.object({
  agents: z.array(activitySnapshotSubscriptionAgentSchema).min(1).max(activitySnapshotAgentLimit)
}).strict().superRefine(uniqueAgentEntries);

const activitySnapshotMeteredSchema = z.object({
  agents: z.array(z.object({
    agent: agentSchema,
    billing: z.literal("api_key"),
    planId: planIdSchema
  }).strict()).max(activitySnapshotAgentLimit),
  apiEquivalent: activitySnapshotApiEquivalentWindowsSchema,
  providerBilled: activitySnapshotBilledWindowsSchema
}).strict().superRefine((value, context) => {
  uniqueAgentEntries(value, context);
  const hasFinancialEvidence = rollingWindowsHaveEvidence(value.apiEquivalent) ||
    rollingWindowsHaveEvidence(value.providerBilled);
  if (value.agents.length === 0 && !hasFinancialEvidence) {
    context.addIssue({
      code: "custom",
      path: ["agents"],
      message: "A metered cohort requires an agent or bounded financial evidence."
    });
  }
});

const activitySnapshotUnresolvedSchema = z.object({
  agents: z.array(z.object({
    agent: agentSchema,
    billing: z.literal("unknown"),
    planId: planIdSchema
  }).strict()).max(activitySnapshotAgentLimit),
  apiEquivalent: activitySnapshotApiEquivalentWindowsSchema
}).strict().superRefine((value, context) => {
  uniqueAgentEntries(value, context);
  if (value.agents.length === 0 && !rollingWindowsHaveEvidence(value.apiEquivalent)) {
    context.addIssue({
      code: "custom",
      path: ["agents"],
      message: "An unresolved cohort requires an agent or bounded financial evidence."
    });
  }
});

/**
 * C-lane §2.1: a provider-billed subscription with no local agent (cursor
 * today). The writer includes a billed30d amount ONLY when its financial
 * evidence is "verified"; the renderer independently drops anything else
 * (double lock: estimated/unverified provider dollars can never reach a
 * statusline segment).
 */
export const activitySnapshotProviderSubscriptionSchema = z.object({
  provider: z.enum(activitySnapshotProviderValues),
  billing: z.literal("subscription"),
  planLabel: z.string().min(1).max(64).nullable(),
  committedUsdPerMonth: usdSchema.nullable(),
  billed30d: activitySnapshotBilledWindowSchema
}).strict();
export type ActivitySnapshotProviderSubscription = z.infer<
  typeof activitySnapshotProviderSubscriptionSchema
>;

/** C-lane §2.1: the committed $/mo total across every detected subscription. */
export const activitySnapshotCommittedTotalSchema = z.object({
  amountUsd: usdSchema.nullable(),
  pricedSubs: countSchema,
  totalSubs: countSchema
}).strict().superRefine((total, context) => {
  if (total.pricedSubs > total.totalSubs) {
    context.addIssue({
      code: "custom",
      path: ["pricedSubs"],
      message: "Priced subscriptions cannot exceed total subscriptions."
    });
  }
  if ((total.amountUsd === null) !== (total.pricedSubs === 0)) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "A committed total exists exactly when at least one subscription is priced."
    });
  }
});
export type ActivitySnapshotCommittedTotal = z.infer<typeof activitySnapshotCommittedTotalSchema>;

export const activitySnapshotOverageSchema = z.object({
  amountUsd: z.number().finite().positive(),
  currency: z.literal("USD"),
  basis: z.literal("provider_billed"),
  financialEvidence: z.literal("verified"),
  alertEligible: z.literal(true),
  recordCount: z.number().int().positive()
}).strict();
export type ActivitySnapshotOverage = z.infer<typeof activitySnapshotOverageSchema>;

const activitySnapshotAgentCoverageSchema = z.object({
  agent: agentSchema,
  directoryStatus: z.enum(["readable", "missing", "unreadable"]),
  filesDiscovered: countSchema,
  filesParsed: countSchema,
  malformedLines: countSchema,
  unreadableFiles: countSchema,
  unsupportedUsageSnapshots: countSchema,
  filesSkippedBeforeWindow: countSchema,
  filesReadFinancially: countSchema,
  bytesSkippedAsNonFinancialHistory: countSchema,
  nonFinancialLinesPrefiltered: countSchema,
  nonFinancialBytesPrefiltered: countSchema,
  jsonlValidationCoverage: z.enum(["complete", "financial_events_only", "not_reported"])
}).strict();

const activitySnapshotProviderCoverageSchema = z.object({
  provider: z.enum(activitySnapshotProviderValues),
  status: z.enum(activitySnapshotProviderCoverageStatusValues),
  validationCoverage: z.enum(sourceValidationCoverageValues),
  checkedAt: isoTimestampSchema.nullable(),
  latestEvidenceAt: isoTimestampSchema.nullable(),
  coverageStart: isoTimestampSchema.nullable(),
  coverageEnd: isoTimestampSchema.nullable()
}).strict().superRefine((coverage, context) => {
  if ((coverage.latestEvidenceAt || coverage.coverageStart || coverage.coverageEnd) &&
      !coverage.checkedAt) {
    context.addIssue({
      code: "custom",
      path: ["checkedAt"],
      message: "Provider evidence timestamps require a receipt-bound check time."
    });
  }
  if (coverage.latestEvidenceAt && coverage.checkedAt &&
      Date.parse(coverage.latestEvidenceAt) > Date.parse(coverage.checkedAt)) {
    context.addIssue({
      code: "custom",
      path: ["latestEvidenceAt"],
      message: "Latest provider evidence cannot be newer than the receipt-bound check."
    });
  }
  if ((coverage.coverageStart === null) !== (coverage.coverageEnd === null)) {
    context.addIssue({
      code: "custom",
      path: ["coverageEnd"],
      message: "Provider coverage bounds must be supplied together."
    });
  }
  if (coverage.coverageStart && coverage.coverageEnd &&
      Date.parse(coverage.coverageStart) > Date.parse(coverage.coverageEnd)) {
    context.addIssue({
      code: "custom",
      path: ["coverageEnd"],
      message: "Provider coverage end must not precede its start."
    });
  }
  if (coverage.coverageEnd && coverage.checkedAt &&
      Date.parse(coverage.coverageEnd) > Date.parse(coverage.checkedAt)) {
    context.addIssue({
      code: "custom",
      path: ["coverageEnd"],
      message: "Provider coverage cannot extend beyond its receipt-bound check."
    });
  }
  if (coverage.latestEvidenceAt && coverage.coverageStart && coverage.coverageEnd &&
      (Date.parse(coverage.latestEvidenceAt) < Date.parse(coverage.coverageStart) ||
       Date.parse(coverage.latestEvidenceAt) > Date.parse(coverage.coverageEnd))) {
    context.addIssue({
      code: "custom",
      path: ["latestEvidenceAt"],
      message: "Latest provider evidence must fall inside the receipt-bound coverage interval."
    });
  }
});

export const activitySnapshotCoverageSchema = z.object({
  agents: z.array(activitySnapshotAgentCoverageSchema).max(activitySnapshotAgentLimit),
  providers: z.array(activitySnapshotProviderCoverageSchema).max(5),
  recordsParsed: countSchema,
  recordsPriced: countSchema,
  recordsUnpriced: countSchema,
  validationStatus: z.enum(["complete", "partial", "failed", "not_checked"]),
  pricingAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  networkUploaded: z.literal(false)
}).strict().superRefine((coverage, context) => {
  if (coverage.recordsPriced + coverage.recordsUnpriced !== coverage.recordsParsed) {
    context.addIssue({
      code: "custom",
      path: ["recordsParsed"],
      message: "Priced and unpriced record counts must equal parsed records."
    });
  }
  if (new Set(coverage.agents.map((agent) => agent.agent)).size !== coverage.agents.length) {
    context.addIssue({
      code: "custom",
      path: ["agents"],
      message: "Coverage may contain each agent only once."
    });
  }
  if (new Set(coverage.providers.map((provider) => provider.provider)).size !== coverage.providers.length) {
    context.addIssue({
      code: "custom",
      path: ["providers"],
      message: "Coverage may contain each provider only once."
    });
  }
});
export type ActivitySnapshotCoverage = z.infer<typeof activitySnapshotCoverageSchema>;

export const activitySnapshotSchema = z.object({
  kind: z.literal("aibill.activity_snapshot"),
  // v2 (C-lane §2.1): adds per-agent committedUsdPerMonth, provider-billed
  // subscriptions, and the committed total. The writer dual-writes a v1
  // payload for already-installed v1 runners during the deprecation window.
  schemaVersion: z.literal(2),
  currency: z.literal("USD"),
  asOf: isoTimestampSchema,
  generatedAt: isoTimestampSchema,
  lastAttemptAt: isoTimestampSchema,
  lastSuccessAt: isoTimestampSchema.nullable(),
  refresh: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok") }).strict(),
    z.object({
      status: z.literal("error"),
      errorCode: z.enum(activitySnapshotRefreshErrorCodeValues)
    }).strict()
  ]),
  mode: z.enum(activitySnapshotModeValues),
  subscription: activitySnapshotSubscriptionSchema.nullable(),
  metered: activitySnapshotMeteredSchema.nullable(),
  unresolved: activitySnapshotUnresolvedSchema.nullable(),
  providers: z.array(activitySnapshotProviderSubscriptionSchema).max(5).nullable(),
  committedTotal: activitySnapshotCommittedTotalSchema,
  overage: activitySnapshotOverageSchema.nullable(),
  coverage: activitySnapshotCoverageSchema,
  networkUploaded: z.literal(false)
}).strict().superRefine((snapshot, context) => {
  const invalid = (message: string, path: string[]) => context.addIssue({
    code: "custom",
    message,
    path
  });
  if (snapshot.mode === "metered" && (!snapshot.metered || snapshot.subscription)) {
    invalid("Metered mode requires a metered cohort and no subscription cohort.", ["mode"]);
  }
  if (snapshot.mode === "subscription" && (!snapshot.subscription || snapshot.metered)) {
    invalid("Subscription mode requires a subscription cohort and no metered cohort.", ["mode"]);
  }
  if (snapshot.mode === "mixed" && (!snapshot.subscription || !snapshot.metered)) {
    invalid("Mixed mode must keep subscription and metered cohorts separate.", ["mode"]);
  }
  if (snapshot.mode === "unresolved" && (!snapshot.unresolved || snapshot.subscription || snapshot.metered)) {
    invalid("Unresolved mode must contain only unresolved API-equivalent evidence.", ["mode"]);
  }
  if ((snapshot.mode === "empty" || snapshot.mode === "error") &&
      (snapshot.subscription || snapshot.metered || snapshot.unresolved || snapshot.overage)) {
    invalid("Empty and error snapshots cannot carry financial cohorts.", ["mode"]);
  }
  if ((snapshot.mode === "empty" || snapshot.mode === "error") &&
      (snapshot.providers || snapshot.committedTotal.amountUsd !== null ||
       snapshot.committedTotal.totalSubs !== 0)) {
    invalid("Empty and error snapshots cannot carry subscription pricing.", ["committedTotal"]);
  }
  if (snapshot.providers &&
      new Set(snapshot.providers.map((provider) => provider.provider)).size !== snapshot.providers.length) {
    invalid("A provider subscription may appear only once.", ["providers"]);
  }
  const expectedTotalSubs = (snapshot.subscription?.agents.length ?? 0) +
    (snapshot.providers?.length ?? 0);
  if (snapshot.committedTotal.totalSubs !== expectedTotalSubs) {
    invalid("The committed total must count every subscription row exactly once.", ["committedTotal"]);
  }
  if (snapshot.mode === "error" && snapshot.refresh.status !== "error") {
    invalid("Error mode requires an error refresh state.", ["refresh"]);
  }
  if (snapshot.refresh.status === "ok" && snapshot.lastSuccessAt === null) {
    invalid("Successful refreshes require lastSuccessAt.", ["lastSuccessAt"]);
  }
  if (snapshot.overage && !snapshot.metered) {
    invalid("Verified billed overage belongs to the metered cohort.", ["overage"]);
  }
  const cohortAgents = [
    ...(snapshot.subscription?.agents ?? []),
    ...(snapshot.metered?.agents ?? []),
    ...(snapshot.unresolved?.agents ?? [])
  ].map((entry) => entry.agent);
  if (new Set(cohortAgents).size !== cohortAgents.length) {
    invalid("An agent cannot appear in more than one financial cohort.", ["mode"]);
  }
  const asOfMs = Date.parse(snapshot.asOf);
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const lastAttemptAtMs = Date.parse(snapshot.lastAttemptAt);
  const lastSuccessAtMs = snapshot.lastSuccessAt === null
    ? null
    : Date.parse(snapshot.lastSuccessAt);
  if (asOfMs > generatedAtMs) {
    invalid("Snapshot generation cannot precede its as-of time.", ["generatedAt"]);
  }
  for (let index = 0; index < snapshot.coverage.providers.length; index += 1) {
    const provider = snapshot.coverage.providers[index]!;
    for (const field of ["checkedAt", "latestEvidenceAt", "coverageEnd"] as const) {
      const value = provider[field];
      if (value !== null && Date.parse(value) > generatedAtMs) {
        invalid(
          "Provider evidence cannot be newer than snapshot generation.",
          ["coverage", "providers", String(index), field]
        );
      }
    }
  }
  if (snapshot.refresh.status === "ok") {
    if (snapshot.mode === "error") {
      invalid("A successful refresh cannot use error mode.", ["mode"]);
    }
    if (lastSuccessAtMs !== generatedAtMs) {
      invalid("A successful refresh must bind lastSuccessAt to generatedAt.", ["lastSuccessAt"]);
    }
    if (lastAttemptAtMs !== asOfMs) {
      invalid("A successful refresh must bind lastAttemptAt to asOf.", ["lastAttemptAt"]);
    }
  } else if (snapshot.lastSuccessAt === null) {
    if (snapshot.mode !== "error" || lastAttemptAtMs !== asOfMs || generatedAtMs !== asOfMs) {
      invalid("An initial failed refresh must be a single-time no-evidence error state.", ["refresh"]);
    }
  } else {
    if (snapshot.mode === "error") {
      invalid("A retained last-good snapshot keeps its prior financial mode.", ["mode"]);
    }
    if (lastSuccessAtMs !== generatedAtMs || lastAttemptAtMs < generatedAtMs) {
      invalid("A retained failure must follow the last successful generation.", ["lastAttemptAt"]);
    }
  }
});
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;

type CohortRecord = {
  record: UsageRecord;
  cohort: "subscription" | "metered_api" | "metered_billed" | "unresolved";
};

/**
 * Build the privacy-bounded, plan-aware snapshot consumed by the status line.
 * This function never trusts provider billing implicitly: the caller must pass
 * IDs already validated by the external connected-state trust receipt.
 */
export function buildActivitySnapshot(input: ActivitySnapshotBuildInput): ActivitySnapshot {
  if (
    (input as { sampleData?: boolean }).sampleData === true ||
    input.records.some((record) => isBundledSampleUsage([record]))
  ) {
    throw new Error("Sample data cannot create an activity snapshot.");
  }
  const asOfMs = parseTimestamp(input.asOf, "asOf");
  const generatedAtMs = parseTimestamp(input.generatedAt, "generatedAt");
  if (generatedAtMs < asOfMs) {
    throw new Error("generatedAt must be at or after asOf.");
  }
  const generatedAt = new Date(generatedAtMs).toISOString();
  const plans = safePlanMap(input.detectedPlans ?? []);
  const scans = normalizeAgentScans(input.sourceScans ?? []);
  const providers = normalizeProviderCoverage(input.providerCoverage ?? [], generatedAtMs);
  const trustedIds = new Set(input.trustedProviderRecordIds ?? []);
  const overageIds = new Set(input.billedOverageRecordIds ?? []);
  for (const id of overageIds) {
    if (!trustedIds.has(id)) {
      throw new Error("Billed overage evidence must also be externally trusted provider evidence.");
    }
  }

  const horizonStartMs = asOfMs - 30 * DAY_MS;
  // Horizon filtering must precede ID conflict detection: stale history must
  // neither activate a cohort nor suppress a current row that reused an ID.
  const horizonRecords = input.records.filter((record) =>
    validRecordTimestampInHorizon(record, horizonStartMs, asOfMs) &&
    // The statusline cache is a deliberately narrower contract than the full
    // parser registry. Registry-native sources join only after their snapshot
    // capability has its own host/UI verification.
    (record.providerCostType !== "local_agent_logs" ||
      record.agentId === undefined || isSnapshotAgent(record.agentId))
  );
  const deduplicated = deduplicateRecords(horizonRecords);
  const classified = deduplicated.records
    .map((record): CohortRecord => ({
      record,
      cohort: classifyRecord(record, plans, trustedIds)
    }));
  // Keep later same-day calls available only for proportionally splitting a
  // daily aggregate at asOf; activity and limit selection remain <= asOf.
  const allCalls = dedupeCumulativeSessionCalls(
    [...(input.calls ?? [])].filter((call) =>
      isSnapshotAgent(call.agent) &&
      // One preceding bucket is needed to preserve the denominator when a
      // daily aggregate straddles the 30-day cutoff.
      validCallAtOrAfter(call, horizonStartMs - DAY_MS)
    )
  );
  const calls = allCalls.filter((call) => validCallAtOrBefore(call, asOfMs));

  const subscriptionAgents = activitySubscriptionAgents(
    classified,
    calls,
    allCalls,
    plans,
    scans,
    trustedIds,
    asOfMs
  );
  const meteredApiRecords = classified
    .filter((entry) => entry.cohort === "metered_api")
    .map((entry) => entry.record);
  const meteredBilledRecords = classified
    .filter((entry) => entry.cohort === "metered_billed")
    .map((entry) => entry.record);
  const unresolvedRecords = classified
    .filter((entry) => entry.cohort === "unresolved")
    .map((entry) => entry.record);
  const activeAgents = new Set<ActivitySnapshotAgent>();
  for (const entry of classified) {
    if (isSnapshotAgent(entry.record.agentId)) activeAgents.add(entry.record.agentId);
  }
  for (const call of calls) {
    if (isSnapshotAgent(call.agent)) activeAgents.add(call.agent);
  }
  const meteredAgents = [...activeAgents]
    .filter((agent) => plans.get(agent)?.billing === "api_key")
    .sort()
    .map((agent) => {
      const detected = plans.get(agent);
      return {
        agent,
        billing: "api_key" as const,
        planId: isKnownPlanId(detected?.planId) ? detected.planId : null
      };
    });
  const unresolvedAgents = [...activeAgents]
    .filter((agent) => {
      const billing = plans.get(agent)?.billing;
      return billing !== "subscription" && billing !== "api_key";
    })
    .sort()
    .map((agent) => {
      const detected = plans.get(agent);
      return {
        agent,
        billing: "unknown" as const,
        planId: isKnownPlanId(detected?.planId) ? detected.planId : null
      };
    });

  const hasReceiptProvedMeteredWindow = providerIntervalCoverage(
    providers,
    asOfMs - DAY_MS,
    asOfMs
  ) === "complete";
  const hasMeteredActivity = meteredApiRecords.length > 0 || meteredBilledRecords.length > 0 ||
    meteredAgents.length > 0 || hasReceiptProvedMeteredWindow;
  const hasSubscriptionActivity = subscriptionAgents.length > 0;
  const hasUnresolvedActivity = unresolvedRecords.length > 0 || unresolvedAgents.length > 0;

  let mode: ActivitySnapshotMode;
  if (hasSubscriptionActivity && hasMeteredActivity) mode = "mixed";
  else if (hasSubscriptionActivity) mode = "subscription";
  else if (hasMeteredActivity) mode = "metered";
  else if (hasUnresolvedActivity) mode = "unresolved";
  else mode = "empty";

  const subscription = hasSubscriptionActivity ? { agents: subscriptionAgents } : null;
  const metered = hasMeteredActivity ? {
    agents: meteredAgents,
    apiEquivalent: buildApiWindows(
      meteredApiRecords,
      allCalls.filter((call) => (
        isSnapshotAgent(call.agent) && plans.get(call.agent)?.billing === "api_key"
      )),
      trustedIds,
      asOfMs,
      localCoverageForRecords(
        meteredApiRecords,
        scans,
        [...plans.entries()]
          .filter(([, plan]) => plan.billing === "api_key")
          .map(([agent]) => agent)
      )
    ),
    providerBilled: buildBilledWindows(
      meteredBilledRecords,
      asOfMs,
      providers
    )
  } : null;
  const unresolved = hasUnresolvedActivity ? {
    agents: unresolvedAgents,
    apiEquivalent: buildApiWindows(
      unresolvedRecords,
      allCalls.filter((call) => {
        if (!isSnapshotAgent(call.agent)) return false;
        const billing = plans.get(call.agent)?.billing;
        return billing !== "subscription" && billing !== "api_key";
      }),
      trustedIds,
      asOfMs,
      unresolvedCoverageForRecords(unresolvedRecords, scans, providers)
    )
  } : null;
  const overage = buildOverage(meteredBilledRecords, overageIds, asOfMs);
  const coverage = buildCoverage(
    classified.map((entry) => entry.record),
    scans,
    providers,
    input.pricingAsOf ?? PRICING_TABLE_AS_OF,
    deduplicated.conflictingIds
  );

  const finalSubscription = mode === "metered" || mode === "unresolved" || mode === "empty"
    ? null
    : subscription;
  // Writer-side lock (C-lane §2.1): a provider-billed amount survives only
  // when its supplied window is verified; anything else degrades to missing.
  const providerSubscriptionRows = mode === "empty"
    ? []
    : (input.providerSubscriptions ?? []).map((row) => ({
        provider: row.provider,
        billing: "subscription" as const,
        planLabel: row.planLabel,
        committedUsdPerMonth: row.committedUsdPerMonth,
        billed30d: row.billed30d &&
            row.billed30d.financialEvidence === "verified" &&
            row.billed30d.amountUsd !== null
          ? row.billed30d
          : missingBilledWindow()
      }));
  const committedRows = [
    ...(finalSubscription?.agents ?? []).map((agent) => agent.committedUsdPerMonth),
    ...providerSubscriptionRows.map((row) => row.committedUsdPerMonth)
  ];
  const pricedRows = committedRows.filter((amount): amount is number => amount !== null);

  return activitySnapshotSchema.parse({
    kind: "aibill.activity_snapshot",
    schemaVersion: 2,
    currency: "USD",
    asOf: new Date(asOfMs).toISOString(),
    generatedAt,
    lastAttemptAt: new Date(asOfMs).toISOString(),
    lastSuccessAt: generatedAt,
    refresh: { status: "ok" },
    mode,
    subscription: finalSubscription,
    metered: mode === "subscription" || mode === "unresolved" || mode === "empty"
      ? null
      : metered,
    unresolved,
    providers: providerSubscriptionRows.length > 0 ? providerSubscriptionRows : null,
    committedTotal: {
      amountUsd: pricedRows.length > 0
        ? roundUsd(pricedRows.reduce((total, amount) => total + amount, 0))
        : null,
      pricedSubs: pricedRows.length,
      totalSubs: committedRows.length
    },
    overage: mode === "metered" || mode === "mixed" ? overage : null,
    coverage,
    networkUploaded: false
  });
}

/** Detected-plan list price (subscriptionPlans); null when unpriced. */
function committedPriceForPlanId(planId: string | undefined): number | null {
  if (!planId) return null;
  return subscriptionPlans.find((plan) => plan.id === planId)?.monthlyUsd ?? null;
}

function missingBilledWindow(): ActivitySnapshotBilledWindow {
  return {
    amountUsd: null,
    recordCount: 0,
    basis: "provider_billed",
    financialEvidence: "missing",
    coverage: "missing"
  };
}

/**
 * The v1 dual-write payload (C-lane §2.1 fleet back-compat): today's fields
 * only, so an already-installed v1 runner keeps rendering fresh data instead
 * of decaying into permanent staleness. Exact v1 key set; no v2 fields.
 */
export function activitySnapshotV1Payload(snapshot: ActivitySnapshot): Record<string, unknown> {
  return {
    kind: snapshot.kind,
    schemaVersion: 1,
    currency: snapshot.currency,
    asOf: snapshot.asOf,
    generatedAt: snapshot.generatedAt,
    lastAttemptAt: snapshot.lastAttemptAt,
    lastSuccessAt: snapshot.lastSuccessAt,
    refresh: snapshot.refresh,
    mode: snapshot.mode,
    subscription: snapshot.subscription
      ? {
          agents: snapshot.subscription.agents.map((agent) => ({
            agent: agent.agent,
            billing: agent.billing,
            planId: agent.planId,
            apiEquivalent: agent.apiEquivalent,
            limits: agent.limits,
            pressure: agent.pressure
          }))
        }
      : null,
    metered: snapshot.metered,
    unresolved: snapshot.unresolved,
    overage: snapshot.overage,
    coverage: snapshot.coverage,
    networkUploaded: snapshot.networkUploaded
  };
}

/** A bounded no-evidence state for an initial failed refresh. */
export function createActivitySnapshotError(
  attemptedAt: string,
  errorCode: ActivitySnapshotRefreshErrorCode
): ActivitySnapshot {
  const timestamp = new Date(parseTimestamp(attemptedAt, "attemptedAt")).toISOString();
  return activitySnapshotSchema.parse({
    kind: "aibill.activity_snapshot",
    schemaVersion: 2,
    currency: "USD",
    asOf: timestamp,
    generatedAt: timestamp,
    lastAttemptAt: timestamp,
    lastSuccessAt: null,
    refresh: { status: "error", errorCode },
    mode: "error",
    subscription: null,
    metered: null,
    unresolved: null,
    providers: null,
    committedTotal: { amountUsd: null, pricedSubs: 0, totalSubs: 0 },
    overage: null,
    coverage: {
      agents: [],
      providers: [],
      recordsParsed: 0,
      recordsPriced: 0,
      recordsUnpriced: 0,
      validationStatus: "failed",
      pricingAsOf: PRICING_TABLE_AS_OF,
      networkUploaded: false
    },
    networkUploaded: false
  });
}

function safePlanMap(plans: readonly DetectedPlan[]): Map<ActivitySnapshotAgent, DetectedPlan> {
  const byAgent = new Map<ActivitySnapshotAgent, DetectedPlan>();
  for (const plan of plans) {
    if (!isSnapshotAgent(plan.agent) || byAgent.has(plan.agent)) continue;
    byAgent.set(plan.agent, plan);
  }
  return byAgent;
}

function classifyRecord(
  record: UsageRecord,
  plans: ReadonlyMap<ActivitySnapshotAgent, DetectedPlan>,
  trustedProviderIds: ReadonlySet<string>
): CohortRecord["cohort"] {
  if (
    trustedProviderIds.has(record.id) &&
    record.costConfidence === "verified" &&
    typeof record.amountUsd === "number"
  ) {
    return "metered_billed";
  }
  const agent = isSnapshotAgent(record.agentId) ? record.agentId : undefined;
  const billing = agent ? plans.get(agent)?.billing : undefined;
  if (billing === "subscription") return "subscription";
  if (billing === "api_key") return "metered_api";
  return "unresolved";
}

function activitySubscriptionAgents(
  records: readonly CohortRecord[],
  calls: readonly LocalAgentCall[],
  allCalls: readonly LocalAgentCall[],
  plans: ReadonlyMap<ActivitySnapshotAgent, DetectedPlan>,
  scans: readonly LocalAgentSourceScan[],
  trustedProviderIds: ReadonlySet<string>,
  asOfMs: number
): ActivitySnapshotSubscriptionAgent[] {
  const result: ActivitySnapshotSubscriptionAgent[] = [];
  for (const agent of activitySnapshotAgentValues) {
    const plan = plans.get(agent);
    if (plan?.billing !== "subscription") continue;
    const agentRecords = records
      .filter((entry) => entry.cohort === "subscription" && entry.record.agentId === agent)
      .map((entry) => entry.record);
    const agentCalls = calls.filter((call) => call.agent === agent);
    if (agentRecords.length === 0 && agentCalls.length === 0) continue;
    result.push({
      agent,
      billing: "subscription",
      planId: isKnownPlanId(plan.planId) ? plan.planId : null,
      committedUsdPerMonth: committedPriceForPlanId(plan.planId),
      apiEquivalent: buildApiWindows(
        agentRecords,
        allCalls.filter((call) => call.agent === agent),
        trustedProviderIds,
        asOfMs,
        localCoverageForAgent(agent, scans)
      ),
      limits: latestReportedLimits(agentCalls, asOfMs),
      pressure: plan.limitSignal === "extra-usage credits exhausted"
        ? "extra_usage_credits_exhausted"
        : null
    });
  }
  return result;
}

function latestReportedLimits(
  calls: readonly LocalAgentCall[],
  asOfMs: number
): ActivitySnapshotLimit[] {
  const selected = new Map<"five-hour" | "weekly", {
    observedAt: string;
    window: LocalAgentRateLimitWindow;
  }>();
  for (const call of calls) {
    if (!call.rateLimits) continue;
    const observedMs = Date.parse(call.rateLimits.observedAt);
    if (!Number.isFinite(observedMs) || observedMs > asOfMs) continue;
    for (const window of call.rateLimits.windows) {
      if (window.kind !== "five-hour" && window.kind !== "weekly") continue;
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs) || resetMs <= asOfMs) continue;
      const prior = selected.get(window.kind);
      if (!prior || Date.parse(prior.observedAt) < observedMs) {
        selected.set(window.kind, { observedAt: call.rateLimits.observedAt, window });
      }
    }
  }
  return (["five-hour", "weekly"] as const).flatMap((kind) => {
    const value = selected.get(kind);
    if (!value) return [];
    const usedPercent = roundPercent(value.window.usedPercent);
    return [{
      kind,
      usedPercent,
      remainingPercent: roundPercent(100 - usedPercent),
      observedAt: new Date(Date.parse(value.observedAt)).toISOString(),
      resetsAt: new Date(Date.parse(value.window.resetsAt)).toISOString(),
      source: "transcript_reported" as const
    }];
  });
}

function buildApiWindows(
  records: readonly UsageRecord[],
  calls: readonly LocalAgentCall[],
  trustedProviderIds: ReadonlySet<string>,
  asOfMs: number,
  sourceCoverage: "complete" | "partial" | "missing"
): ActivitySnapshotApiEquivalentWindows {
  const observations = apiEquivalentObservations(records, calls, trustedProviderIds);
  return {
    oneDay: buildApiWindow(observations, asOfMs, 1, sourceCoverage),
    sevenDays: buildApiWindow(observations, asOfMs, 7, sourceCoverage),
    thirtyDays: buildApiWindow(observations, asOfMs, 30, sourceCoverage)
  };
}

type FinancialWindowObservation = {
  timestamp: string;
  /** Inclusive start for one cumulative session observation, when reported. */
  intervalStart?: string;
  amountUsd: number | null;
  precision: "exact" | "session_interval" | "daily_bucket" | "unbounded_bucket";
  apiEquivalentBasisAvailable: boolean;
};

function buildApiWindow(
  observations: readonly FinancialWindowObservation[],
  asOfMs: number,
  days: number,
  sourceCoverage: "complete" | "partial" | "missing"
): ActivitySnapshotApiEquivalentWindow {
  const inWindow = observationsForWindow(observations, asOfMs, days);
  const basisAvailable = inWindow.filter((observation) => observation.apiEquivalentBasisAvailable);
  const priced = basisAvailable.filter((observation) => typeof observation.amountUsd === "number");
  const unpriced = basisAvailable.length - priced.length;
  const basisUnavailable = inWindow.length - basisAvailable.length;
  const boundaryLimited = inWindow.some((observation) => observation.precision !== "exact");
  const coverage = basisAvailable.length === 0 && basisUnavailable > 0
    ? "missing"
    : windowCoverage(sourceCoverage, unpriced + basisUnavailable, boundaryLimited);
  const observedAmount = priced.length > 0
    ? roundUsd(priced.reduce((sum, observation) => sum + (observation.amountUsd ?? 0), 0))
    : null;
  const amountUsd = observedAmount !== null &&
      sourceCoverage !== "missing" &&
      (observedAmount > 0 || coverage === "complete")
    ? observedAmount
    : coverage === "complete"
      ? 0
      : null;
  return {
    amountUsd,
    recordCount: inWindow.length,
    basis: "api_equivalent",
    financialEvidence: amountUsd === null ? "missing" : "estimated",
    coverage
  };
}

function apiEquivalentObservations(
  records: readonly UsageRecord[],
  calls: readonly LocalAgentCall[],
  trustedProviderIds: ReadonlySet<string>
): FinancialWindowObservation[] {
  const deduplicatedCalls = dedupeCumulativeSessionCalls([...calls]);
  const callsByAggregateId = new Map<string, LocalAgentCall[]>();
  for (const call of deduplicatedCalls) {
    const aggregateId = aggregateCalls([call])[0]?.id;
    if (!aggregateId) continue;
    callsByAggregateId.set(aggregateId, [...(callsByAggregateId.get(aggregateId) ?? []), call]);
  }
  const matchedCalls = new Set<LocalAgentCall>();
  const observations: FinancialWindowObservation[] = [];
  for (const record of records) {
    const apiEquivalentBasisAvailable = record.providerCostType === "local_agent_logs" ||
      (record.providerCostType === "anthropic_claude_code_usage" &&
       trustedProviderIds.has(record.id));
    if (!apiEquivalentBasisAvailable) {
      observations.push({
        timestamp: record.timestamp,
        amountUsd: null,
        precision: bucketPrecision(record),
        apiEquivalentBasisAvailable: false
      });
      continue;
    }
    const matchingCalls = callsByAggregateId.get(record.id) ?? [];
    if (matchingCalls.length === 0) {
      observations.push({
        timestamp: record.timestamp,
        amountUsd: record.amountUsd,
        precision: record.usageGranularity === "daily_aggregate" ? "daily_bucket" : bucketPrecision(record),
        apiEquivalentBasisAvailable: true
      });
      continue;
    }
    const allocated = allocateAggregateAmount(record.amountUsd, matchingCalls);
    for (let index = 0; index < matchingCalls.length; index += 1) {
      const call = matchingCalls[index]!;
      matchedCalls.add(call);
      observations.push({
        timestamp: call.timestamp,
        ...(call.usageScope === "session_cumulative" && call.startedAt
          ? { intervalStart: call.startedAt }
          : {}),
        amountUsd: allocated[index] ?? null,
        precision: call.usageScope === "session_cumulative"
          ? "session_interval"
          : "exact",
        apiEquivalentBasisAvailable: true
      });
    }
  }
  for (const call of deduplicatedCalls) {
    if (matchedCalls.has(call)) continue;
    observations.push({
      timestamp: call.timestamp,
      ...(call.usageScope === "session_cumulative" && call.startedAt
        ? { intervalStart: call.startedAt }
        : {}),
      amountUsd: null,
      precision: call.usageScope === "session_cumulative"
        ? "session_interval"
        : "exact",
      apiEquivalentBasisAvailable: true
    });
  }
  return observations;
}

/**
 * One call's API-equivalent cost with its tier taken from the largest single
 * request it contains, matching the report's aggregation. Weighting a
 * session-cumulative slice at its own cache-inflated prompt would put it on the
 * wrong tier and skew the allocation.
 */
function callAmountUsd(call: LocalAgentCall): number | undefined {
  return estimateTokenCostsUsd(
    call.model,
    [call.usage],
    [call.maxRequestPromptTokens]
  );
}

function allocateAggregateAmount(
  amountUsd: number | null,
  calls: readonly LocalAgentCall[]
): Array<number | null> {
  if (amountUsd === null) return calls.map(() => null);
  const priceable = calls.map((call) =>
    canPriceTokenUsageAtScope(
      call.model,
      call.usage,
      call.usageScope === "turn" ? "request" : "aggregate",
      call.maxRequestPromptTokens
    ) && callAmountUsd(call) !== undefined
  );
  if (priceable.some((supported) => !supported)) return calls.map(() => null);
  const weights = calls.map((call) => callAmountUsd(call) ?? 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return amountUsd === 0 ? calls.map(() => 0) : calls.map(() => null);
  }
  return weights.map((weight) => amountUsd * weight / totalWeight);
}

function observationsForWindow(
  observations: readonly FinancialWindowObservation[],
  asOfMs: number,
  days: number
): FinancialWindowObservation[] {
  const boundaryMs = asOfMs - days * DAY_MS;
  const selected: FinancialWindowObservation[] = [];
  for (const observation of observations) {
    const timestampMs = Date.parse(observation.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    if (observation.precision === "exact") {
      if (timestampMs >= boundaryMs) selected.push(observation);
      continue;
    }
    if (observation.precision === "session_interval") {
      if (timestampMs < boundaryMs) continue;
      const intervalStartMs = observation.intervalStart === undefined
        ? Number.NaN
        : Date.parse(observation.intervalStart);
      if (!Number.isFinite(intervalStartMs) || intervalStartMs > timestampMs ||
          intervalStartMs < boundaryMs) {
        selected.push({ ...observation, amountUsd: null });
      } else {
        // A cumulative total wholly observed inside this rolling window is
        // exact for the window; only a cutoff-straddling interval is partial.
        selected.push({ ...observation, precision: "exact" });
      }
      continue;
    }
    if (observation.precision === "daily_bucket") {
      const intervalEndMs = Math.min(timestampMs + DAY_MS, asOfMs);
      if (intervalEndMs <= boundaryMs || timestampMs > asOfMs) continue;
      if (timestampMs < boundaryMs) {
        selected.push({ ...observation, amountUsd: null });
      } else {
        selected.push(observation);
      }
      continue;
    }
    if (timestampMs >= boundaryMs) selected.push(observation);
  }
  return selected;
}

function bucketPrecision(record: UsageRecord): FinancialWindowObservation["precision"] {
  if (record.usageGranularity === "call" || record.usageGranularity === "invocation") {
    return "exact";
  }
  return record.usageGranularity === "daily_aggregate"
    ? "daily_bucket"
    : "unbounded_bucket";
}

function buildBilledWindows(
  records: readonly UsageRecord[],
  asOfMs: number,
  providers: readonly ActivitySnapshotProviderCoverageInput[]
): ActivitySnapshotBilledWindows {
  return {
    oneDay: buildBilledWindow(records, asOfMs, 1, providers),
    sevenDays: buildBilledWindow(records, asOfMs, 7, providers),
    thirtyDays: buildBilledWindow(records, asOfMs, 30, providers)
  };
}

function buildBilledWindow(
  records: readonly UsageRecord[],
  asOfMs: number,
  days: number,
  providers: readonly ActivitySnapshotProviderCoverageInput[]
): ActivitySnapshotBilledWindow {
  const sourceCoverage = providerIntervalCoverage(providers, asOfMs - days * DAY_MS, asOfMs);
  const boundaryMs = asOfMs - days * DAY_MS;
  const fullyContained: UsageRecord[] = [];
  let overlappingRecordCount = 0;
  let boundaryLimited = false;
  for (const record of records) {
    const timestampMs = Date.parse(record.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    const precision = billedBucketPrecision(record);
    if (precision === "exact") {
      if (timestampMs >= boundaryMs) {
        fullyContained.push(record);
        overlappingRecordCount += 1;
      }
      continue;
    }
    if (precision === "daily_bucket") {
      const intervalEndMs = billedBucketObservedEnd(record, providers, asOfMs);
      if (intervalEndMs === null) {
        if (timestampMs >= boundaryMs) {
          overlappingRecordCount += 1;
          boundaryLimited = true;
        }
        continue;
      }
      if (intervalEndMs <= boundaryMs || timestampMs > asOfMs) continue;
      overlappingRecordCount += 1;
      if (timestampMs < boundaryMs || intervalEndMs > asOfMs) {
        boundaryLimited = true;
      } else {
        fullyContained.push(record);
      }
      continue;
    }
    if (timestampMs >= boundaryMs) {
      overlappingRecordCount += 1;
      boundaryLimited = true;
    }
  }
  if (overlappingRecordCount === 0) {
    const intervalProved = sourceCoverage === "complete";
    return {
      amountUsd: intervalProved ? 0 : null,
      recordCount: 0,
      basis: "provider_billed",
      financialEvidence: intervalProved ? "verified" : "missing",
      coverage: intervalProved ? "complete" : "missing"
    };
  }
  const coverage = windowCoverage(
    sourceCoverage === "complete" ? "complete" : "partial",
    0,
    boundaryLimited
  );
  const amountUsd = boundaryLimited
    ? null
    : roundUsd(fullyContained.reduce((sum, record) => sum + (record.amountUsd ?? 0), 0));
  return {
    amountUsd,
    recordCount: overlappingRecordCount,
    basis: "provider_billed",
    financialEvidence: amountUsd === null ? "missing" : "verified",
    coverage
  };
}

function billedBucketPrecision(record: UsageRecord): FinancialWindowObservation["precision"] {
  if (record.usageGranularity === "call" || record.usageGranularity === "invocation") {
    return "exact";
  }
  if (record.usageGranularity === "billing_bucket" ||
      record.usageGranularity === "daily_aggregate") {
    return "daily_bucket";
  }
  return "unbounded_bucket";
}

function billedBucketObservedEnd(
  record: UsageRecord,
  providers: readonly ActivitySnapshotProviderCoverageInput[],
  asOfMs: number
): number | null {
  const timestampMs = Date.parse(record.timestamp);
  const provider = activitySnapshotProviderForRecord(record);
  const checkedAt = providers
    .filter((candidate) => candidate.provider === provider && candidate.checkedAt !== undefined)
    .map((candidate) => Date.parse(candidate.checkedAt!))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  if (checkedAt === undefined) return null;
  return Math.min(timestampMs + DAY_MS, checkedAt, asOfMs);
}

function activitySnapshotProviderForRecord(record: UsageRecord): ActivitySnapshotProvider {
  const provider = record.source.provider.toLowerCase();
  if (provider === "openai") return "openai";
  if (provider === "anthropic") return "anthropic";
  if (provider === "cursor") return "cursor";
  if (provider === "github-copilot" || provider === "github" || provider === "copilot") {
    return "github-copilot";
  }
  return "other";
}

function providerIntervalCoverage(
  providers: readonly ActivitySnapshotProviderCoverageInput[],
  windowStartMs: number,
  windowEndMs: number
): "complete" | "partial" | "missing" {
  if (providers.length === 0) return "missing";
  const spansWindow = (provider: ActivitySnapshotProviderCoverageInput) =>
    provider.status === "complete" &&
    provider.checkedAt !== undefined &&
    provider.coverageStart !== undefined &&
    provider.coverageEnd !== undefined &&
    Date.parse(provider.coverageStart) <= windowStartMs &&
    Date.parse(provider.coverageEnd) >= windowEndMs &&
    Date.parse(provider.checkedAt) >= Date.parse(provider.coverageEnd);
  if (providers.every(spansWindow)) return "complete";
  const overlapsWindow = providers.some((provider) =>
    (provider.status === "complete" || provider.status === "partial") &&
    provider.coverageStart !== undefined &&
    provider.coverageEnd !== undefined &&
    Date.parse(provider.coverageStart) < windowEndMs &&
    Date.parse(provider.coverageEnd) > windowStartMs
  );
  return overlapsWindow ? "partial" : "missing";
}

function buildOverage(
  billedRecords: readonly UsageRecord[],
  overageIds: ReadonlySet<string>,
  asOfMs: number
): ActivitySnapshotOverage | null {
  const records = billedRecords.filter((record) =>
    overageIds.has(record.id) &&
    typeof record.amountUsd === "number" &&
    record.amountUsd > 0 &&
    inRollingWindow(record.timestamp, asOfMs, 30)
  );
  if (records.length === 0) return null;
  return {
    amountUsd: roundUsd(records.reduce((sum, record) => sum + (record.amountUsd ?? 0), 0)),
    currency: "USD",
    basis: "provider_billed",
    financialEvidence: "verified",
    alertEligible: true,
    recordCount: records.length
  };
}

function buildCoverage(
  records: readonly UsageRecord[],
  scans: readonly LocalAgentSourceScan[],
  providers: readonly ActivitySnapshotProviderCoverageInput[],
  pricingAsOf: string,
  conflictingIds: number
): ActivitySnapshotCoverage {
  const priced = records.filter((record) => typeof record.amountUsd === "number").length;
  const unpriced = records.length - priced;
  const failed = scans.some((scan) => scan.directoryStatus === "unreadable") ||
    providers.some((provider) =>
      provider.status === "error" || provider.validationCoverage === "failed"
    );
  const partial = conflictingIds > 0 || unpriced > 0 ||
    scans.some((scan) => scan.directoryStatus === "missing" ||
      scan.malformedLines > 0 || scan.unreadableFiles > 0 ||
      scan.unsupportedUsageSnapshots > 0 ||
      scan.jsonlValidationCoverage !== "complete") ||
    providers.some((provider) =>
      provider.status === "partial" || provider.status === "unavailable"
    );
  const checked = scans.length > 0 || providers.length > 0;
  const validationStatus = failed
    ? "failed"
    : partial
      ? "partial"
      : checked
        ? "complete"
        : "not_checked";
  return activitySnapshotCoverageSchema.parse({
    agents: scans.map((scan) => ({
      agent: scan.agent,
      directoryStatus: scan.directoryStatus,
      filesDiscovered: scan.filesDiscovered,
      filesParsed: scan.filesParsed,
      malformedLines: scan.malformedLines,
      unreadableFiles: scan.unreadableFiles,
      unsupportedUsageSnapshots: scan.unsupportedUsageSnapshots,
      filesSkippedBeforeWindow: scan.filesSkippedBeforeWindow ?? 0,
      filesReadFinancially: scan.filesReadFinancially ?? 0,
      bytesSkippedAsNonFinancialHistory: scan.bytesSkippedAsNonFinancialHistory ?? 0,
      nonFinancialLinesPrefiltered: scan.nonFinancialLinesPrefiltered ?? 0,
      nonFinancialBytesPrefiltered: scan.nonFinancialBytesPrefiltered ?? 0,
      jsonlValidationCoverage: scan.jsonlValidationCoverage ?? "not_reported"
    })),
    providers: providers.map((provider) => ({
      ...provider,
      checkedAt: provider.checkedAt ?? null,
      latestEvidenceAt: provider.latestEvidenceAt ?? null,
      coverageStart: provider.coverageStart ?? null,
      coverageEnd: provider.coverageEnd ?? null
    })),
    recordsParsed: records.length,
    recordsPriced: priced,
    recordsUnpriced: unpriced,
    validationStatus,
    pricingAsOf,
    networkUploaded: false
  });
}

function normalizeAgentScans(scans: readonly LocalAgentSourceScan[]): LocalAgentSourceScan[] {
  const latest = new Map<ActivitySnapshotAgent, LocalAgentSourceScan>();
  for (const scan of scans) {
    if (isSnapshotAgent(scan.agent)) latest.set(scan.agent, scan);
  }
  return [...latest.values()].sort((left, right) => left.agent.localeCompare(right.agent));
}

function normalizeProviderCoverage(
  providers: readonly ActivitySnapshotProviderCoverageInput[],
  generatedAtMs: number
): ActivitySnapshotProviderCoverageInput[] {
  const latest = new Map<ActivitySnapshotProvider, ActivitySnapshotProviderCoverageInput>();
  for (const provider of providers) {
    if (!activitySnapshotProviderValues.includes(provider.provider)) continue;
    if (provider.checkedAt !== undefined) parseTimestamp(provider.checkedAt, "provider checkedAt");
    if (provider.latestEvidenceAt !== undefined) {
      parseTimestamp(provider.latestEvidenceAt, "provider latestEvidenceAt");
    }
    if (provider.coverageStart !== undefined) {
      parseTimestamp(provider.coverageStart, "provider coverageStart");
    }
    if (provider.coverageEnd !== undefined) {
      parseTimestamp(provider.coverageEnd, "provider coverageEnd");
    }
    if ((provider.coverageStart === undefined) !== (provider.coverageEnd === undefined)) {
      throw new Error("Provider coverageStart and coverageEnd must be supplied together.");
    }
    if ((provider.latestEvidenceAt !== undefined || provider.coverageStart !== undefined) &&
        provider.checkedAt === undefined) {
      throw new Error("Provider evidence timestamps require checkedAt.");
    }
    if (provider.checkedAt && provider.latestEvidenceAt &&
        Date.parse(provider.latestEvidenceAt) > Date.parse(provider.checkedAt)) {
      throw new Error("Provider latestEvidenceAt must not be newer than checkedAt.");
    }
    if (provider.coverageStart && provider.coverageEnd &&
        Date.parse(provider.coverageStart) > Date.parse(provider.coverageEnd)) {
      throw new Error("Provider coverageEnd must not precede coverageStart.");
    }
    if (provider.coverageEnd && provider.checkedAt &&
        Date.parse(provider.coverageEnd) > Date.parse(provider.checkedAt)) {
      throw new Error("Provider coverageEnd must not be newer than checkedAt.");
    }
    if (provider.checkedAt && Date.parse(provider.checkedAt) > generatedAtMs) {
      throw new Error("Provider checkedAt must not be newer than generatedAt.");
    }
    if (provider.latestEvidenceAt && provider.coverageStart && provider.coverageEnd &&
        (Date.parse(provider.latestEvidenceAt) < Date.parse(provider.coverageStart) ||
         Date.parse(provider.latestEvidenceAt) > Date.parse(provider.coverageEnd))) {
      throw new Error("Provider latestEvidenceAt must fall inside its coverage interval.");
    }
    latest.set(provider.provider, provider);
  }
  return [...latest.values()].sort((left, right) => left.provider.localeCompare(right.provider));
}

function localCoverageForAgent(
  agent: ActivitySnapshotAgent,
  scans: readonly LocalAgentSourceScan[]
): "complete" | "partial" | "missing" {
  const scan = scans.find((candidate) => candidate.agent === agent);
  if (!scan) return "missing";
  if (scan.directoryStatus !== "readable") return "missing";
  return scan.malformedLines > 0 || scan.unreadableFiles > 0 || scan.unsupportedUsageSnapshots > 0
    || scan.jsonlValidationCoverage !== "complete"
    ? "partial"
    : "complete";
}

function localCoverageForRecords(
  records: readonly UsageRecord[],
  scans: readonly LocalAgentSourceScan[],
  fallbackAgents: readonly ActivitySnapshotAgent[] = []
): "complete" | "partial" | "missing" {
  const agents = new Set([
    ...records.map((record) => record.agentId).filter(isSnapshotAgent),
    ...fallbackAgents
  ]);
  if (agents.size === 0) {
    return "missing";
  }
  const statuses = [...agents].map((agent) => localCoverageForAgent(agent, scans));
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.some((status) => status !== "missing")) return "partial";
  return "missing";
}

function unresolvedCoverageForRecords(
  records: readonly UsageRecord[],
  scans: readonly LocalAgentSourceScan[],
  providers: readonly ActivitySnapshotProviderCoverageInput[]
): "complete" | "partial" | "missing" {
  const localRecords = records.filter((record) => record.providerCostType === "local_agent_logs");
  const providerRecords = records.filter((record) => record.providerCostType !== "local_agent_logs");
  const statuses: Array<"complete" | "partial" | "missing"> = [];
  if (localRecords.length > 0) statuses.push(localCoverageForRecords(localRecords, scans));
  if (providerRecords.length > 0) statuses.push(providerCoverageCompleteness(providers));
  if (statuses.length === 0) return "missing";
  if (statuses.every((status) => status === "complete")) return "complete";
  if (statuses.some((status) => status !== "missing")) return "partial";
  return "missing";
}

function providerCoverageCompleteness(
  providers: readonly ActivitySnapshotProviderCoverageInput[]
): "complete" | "partial" | "missing" {
  if (providers.length === 0) return "missing";
  if (providers.every((provider) => provider.status === "complete")) return "complete";
  if (providers.some((provider) =>
    provider.status === "complete" || provider.status === "partial"
  )) return "partial";
  return "missing";
}

function windowCoverage(
  sourceCoverage: "complete" | "partial" | "missing",
  unpriced: number,
  boundaryLimited = false
): "complete" | "partial" | "missing" {
  if (sourceCoverage === "missing") return "missing";
  return sourceCoverage === "partial" || unpriced > 0 || boundaryLimited
    ? "partial"
    : "complete";
}

function deduplicateRecords(records: readonly UsageRecord[]): {
  records: UsageRecord[];
  conflictingIds: number;
} {
  const byId = new Map<string, UsageRecord[]>();
  for (const record of records) byId.set(record.id, [...(byId.get(record.id) ?? []), record]);
  const output: UsageRecord[] = [];
  let conflictingIds = 0;
  for (const group of byId.values()) {
    const signatures = new Set(group.map(financialRecordSignature));
    if (signatures.size > 1) {
      conflictingIds += 1;
      continue;
    }
    output.push(group[0]!);
  }
  return { records: output, conflictingIds };
}

function financialRecordSignature(record: UsageRecord): string {
  return JSON.stringify([
    record.timestamp,
    record.agentId ?? null,
    record.amountUsd,
    record.costConfidence,
    record.providerCostType ?? null,
    record.inputTokens,
    record.outputTokens
  ]);
}

function validRecordTimestampInHorizon(
  record: UsageRecord,
  horizonStartMs: number,
  asOfMs: number
): boolean {
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > asOfMs) return false;
  if (record.usageGranularity === "daily_aggregate" ||
      record.usageGranularity === "billing_bucket") {
    return timestamp + DAY_MS > horizonStartMs;
  }
  return timestamp >= horizonStartMs;
}

function validCallAtOrBefore(call: LocalAgentCall, asOfMs: number): boolean {
  const timestamp = Date.parse(call.timestamp);
  return Number.isFinite(timestamp) && timestamp <= asOfMs;
}

function validCallAtOrAfter(call: LocalAgentCall, horizonStartMs: number): boolean {
  const timestamp = Date.parse(call.timestamp);
  return Number.isFinite(timestamp) && timestamp >= horizonStartMs;
}

function inRollingWindow(timestamp: string, asOfMs: number, days: number): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= asOfMs - days * DAY_MS && value <= asOfMs;
}

function isSnapshotAgent(value: unknown): value is ActivitySnapshotAgent {
  return typeof value === "string" && activitySnapshotAgentValueSet.has(
    value as ActivitySnapshotAgent
  );
}

function isKnownPlanId(value: string | undefined): value is ActivitySnapshotPlanId {
  return typeof value === "string" && activitySnapshotPlanIdValues.includes(value as ActivitySnapshotPlanId);
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid ISO timestamp.`);
  return parsed;
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
