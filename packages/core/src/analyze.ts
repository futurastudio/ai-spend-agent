import { generateSpendInsights } from "./insights.js";
import {
  costConfidenceValues,
  hasModeledWorkloadEvidence,
  hasPricedEvidence,
  spendComparisonKey,
  spendSummarySchema,
  type CostConfidence,
  type Recommendation,
  type SpendAnomaly,
  type SpendBreakdownEntry,
  type SpendSummary,
  type UsageRecord,
  type WorkflowWatchEntry
} from "./schema.js";

type GroupSelector = (record: UsageRecord) => string | undefined;

const confidenceRank: Record<CostConfidence, number> = {
  verified: 0,
  estimated: 1,
  detected_unverified: 2,
  missing: 3
};

/** Published retained-cost fraction for providers whose Batch pricing we explicitly support. */
const batchCostRetainedByProvider: Readonly<Record<string, number>> = {
  openai: 0.5,
  anthropic: 0.5
};

export function analyzeSpend(records: UsageRecord[]): SpendSummary {
  // Billing buckets, usage aggregates, seats, and user totals are useful for
  // financial breakdowns and spend-spike detection. They do not prove a
  // workload-level counterfactual. Only records with explicit call/invocation
  // provenance and a named operation feed modeled recommendations/insights.
  const decisionRecords = records.filter(hasModeledWorkloadEvidence);
  const anomalyRecords = records.filter((record) => !isLocalAgentRecord(record));
  const summary: SpendSummary = {
    totalUsd: roundMoney(sumRecords(records)),
    recordCount: records.length,
    confidence: combinedConfidence(records.map((record) => record.costConfidence)),
    confidenceBreakdown: confidenceBreakdown(records),
    bySource: breakdown(records, (record) => record.source.id),
    byModel: breakdown(records, (record) => record.model),
    byClient: breakdown(records, (record) => record.clientId),
    byProject: breakdown(records, (record) => record.projectId),
    byAgent: breakdown(records, (record) => record.agentId),
    byUser: breakdown(records, (record) => record.userId),
    byWorkspace: breakdown(records, (record) => record.workspaceId),
    byApiKey: breakdown(records, (record) => record.apiKeyId),
    workflowWatch: generateWorkflowWatch(records),
    anomalies: detectSpendSpikes(anomalyRecords),
    recommendations: generateRecommendations(decisionRecords),
    insights: []
  };

  // Insights may explain stable provider-billing cohorts, but their own
  // engines distinguish aggregate accounting evidence from run-level evidence.
  // Recompute without local transcript aggregates so cumulative local session
  // rows cannot leak into provider anomaly or ownership diagnostics.
  if (anomalyRecords.length > 0) {
    const evidenceSummary: SpendSummary = anomalyRecords.length === records.length
      ? summary
      : {
          totalUsd: roundMoney(sumRecords(anomalyRecords)),
          recordCount: anomalyRecords.length,
          confidence: combinedConfidence(anomalyRecords.map((record) => record.costConfidence)),
          confidenceBreakdown: confidenceBreakdown(anomalyRecords),
          bySource: breakdown(anomalyRecords, (record) => record.source.id),
          byModel: breakdown(anomalyRecords, (record) => record.model),
          byClient: breakdown(anomalyRecords, (record) => record.clientId),
          byProject: breakdown(anomalyRecords, (record) => record.projectId),
          byAgent: breakdown(anomalyRecords, (record) => record.agentId),
          byUser: breakdown(anomalyRecords, (record) => record.userId),
          byWorkspace: breakdown(anomalyRecords, (record) => record.workspaceId),
          byApiKey: breakdown(anomalyRecords, (record) => record.apiKeyId),
          workflowWatch: generateWorkflowWatch(anomalyRecords),
          anomalies: detectSpendSpikes(anomalyRecords),
          recommendations: generateRecommendations(anomalyRecords),
          insights: []
        };
    summary.insights = generateSpendInsights(anomalyRecords, evidenceSummary);
  }

  return spendSummarySchema.parse(summary);
}

export function detectSpendSpikes(records: UsageRecord[]): SpendAnomaly[] {
  // Local coding-agent records are day + agent + model + project aggregates.
  // A cumulative session counter may be attributed to its final observation
  // day, so comparing those rows day-over-day would manufacture a "spike."
  // Only provider/call-level records can participate in this detector.
  const byCohort = new Map<string, Map<string, UsageRecord[]>>();
  for (const record of records) {
    if (isLocalAgentRecord(record) || !hasPricedEvidence(record)) continue;
    const comparisonKey = spendComparisonKey(record);
    // Unknown row shape is not a comparable cohort. Pooling all unclassified
    // provider rows creates fake spikes when source mix changes between days.
    if (!comparisonKey) continue;
    const day = record.timestamp.slice(0, 10);
    const byDay = byCohort.get(comparisonKey) ?? new Map<string, UsageRecord[]>();
    byDay.set(day, [...(byDay.get(day) ?? []), record]);
    byCohort.set(comparisonKey, byDay);
  }

  const anomalies: SpendAnomaly[] = [];
  for (const [comparisonKey, byDay] of [...byCohort.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const days = [...byDay.keys()].sort();
    for (let index = 1; index < days.length; index += 1) {
      const previousDay = days[index - 1]!;
      const currentDay = days[index]!;
      if (!isNextCalendarDay(previousDay, currentDay)) continue;
      const previousRecords = byDay.get(previousDay) ?? [];
      const previousAmountUsd = roundMoney(sumRecords(previousRecords));
      const currentRecords = byDay.get(currentDay) ?? [];
      const currentAmountUsd = roundMoney(sumRecords(currentRecords));
      if (previousAmountUsd === 0 || currentAmountUsd - previousAmountUsd < 10) {
        continue;
      }

      const multiplier = currentAmountUsd / previousAmountUsd;
      if (multiplier >= 1.75) {
        anomalies.push({
          kind: "day_over_day_spike",
          key: currentDay,
          comparisonKey,
          previousAmountUsd,
          currentAmountUsd,
          multiplier: roundMoney(multiplier),
          confidence: combinedConfidence(
            [...previousRecords, ...currentRecords].map((record) => record.costConfidence)
          )
        });
      }
    }
  }

  return anomalies.sort((left, right) =>
    left.key.localeCompare(right.key) ||
    (left.comparisonKey ?? "").localeCompare(right.comparisonKey ?? "")
  );
}

function isNextCalendarDay(previousDay: string, currentDay: string): boolean {
  const previous = Date.parse(`${previousDay}T00:00:00Z`);
  const current = Date.parse(`${currentDay}T00:00:00Z`);
  return Number.isFinite(previous) && Number.isFinite(current) && current - previous === 86_400_000;
}

export function generateWorkflowWatch(records: UsageRecord[]): WorkflowWatchEntry[] {
  // Workflow Watch is an ownership/concentration diagnostic. Do not attach a
  // generic savings or margin prior: savings need a named counterfactual and
  // margin risk needs real revenue/margin inputs that UsageRecord does not have.
  const decisionRecords = records.filter((record) => !isLocalAgentRecord(record));
  const totalUsd = sumRecords(decisionRecords);
  if (totalUsd === 0) {
    return [];
  }

  const groups = new Map<string, UsageRecord[]>();
  for (const record of decisionRecords) {
    const clientId = record.clientId ?? "unmapped-client";
    const projectId = record.projectId ?? "unmapped-project";
    const workflowKey = record.operation ?? "unmapped-workflow";
    const agentId = record.agentId ?? "unmapped-agent";
    const key = [clientId, projectId, workflowKey, agentId].join("::");
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return [...groups.entries()]
    .map(([key, groupRecords]) => {
      const [clientId, projectId, workflowKey, agentId] = key.split("::") as [string, string, string, string];
      const rawAmountUsd = sumRecords(groupRecords);
      const amountUsd = roundMoney(rawAmountUsd);
      // Compute the ratio from unrounded amounts. A tiny single-record total
      // such as $0.0075 rounds to $0.01 for display; dividing that rounded
      // value by the raw total produced 1.3333 and failed the [0, 1] schema.
      const shareOfSpend = roundRatio(Math.min(1, rawAmountUsd / totalUsd));
      const estimatedSavingsUsd = 0;
      const estimatedMarginRiskUsd = 0;
      const confidence = combinedConfidence(groupRecords.map((record) => record.costConfidence));
      const hasRunLevelEvidence = groupRecords.every(hasModeledWorkloadEvidence);
      const suggestedOptimization = workflowDiagnosticFor(workflowKey, agentId, hasRunLevelEvidence);

      return {
        id: slugify(["workflow", clientId, projectId, workflowKey].join("-")),
        clientId,
        projectId,
        workflowKey,
        agentId,
        amountUsd,
        shareOfSpend,
        recordCount: groupRecords.length,
        confidence,
        estimatedMarginRiskUsd,
        estimatedSavingsUsd,
        suggestedOptimization,
        applyArtifact: `Before changing this workload: ${suggestedOptimization}`,
        verificationPlan: hasRunLevelEvidence
          ? `Reconcile ${workflowKey} to its owner and budget, then define one reversible candidate and compare matched future accepted outcomes plus provider-reported cost.`
          : `Reconcile ${workflowKey} to its owner and budget, then collect call-level workload evidence before modeling or applying a cost change.`
      } satisfies WorkflowWatchEntry;
    })
    .filter((entry) => entry.amountUsd > 0)
    .sort((left, right) => right.amountUsd - left.amountUsd || left.id.localeCompare(right.id))
    .slice(0, 5);
}

export function generateRecommendations(records: UsageRecord[]): Recommendation[] {
  const decisionRecords = records.filter(hasModeledWorkloadEvidence);
  const recommendations: Recommendation[] = [];
  const downgradeRecords = decisionRecords.filter(
    (record) => record.workloadSemantics?.downgradeSafe === true
  );
  const modelSpend = breakdown(downgradeRecords, (record) => record.model);
  const topModel = modelSpend[0];
  if (topModel && topModel.amountUsd >= 20) {
    recommendations.push({
      id: "model-downgrade",
      title: "Review expensive model workloads for downgrade candidates",
      rationale: `${topModel.key} is the largest cost driver in the current local sample.`,
      whyItMatters: "Premium model usage tends to become invisible once agents are running in the background. Spend owners need a clear rule for which jobs deserve the expensive model.",
      nextAction: `Audit the top ${topModel.key} operations and move low-risk summarization, extraction, and draft work to a cheaper model tier first.`,
      priority: "high",
      // The high-level recommendation does not know which model-specific rule
      // will pass quality verification. Dollar math lives in the exact cut
      // candidate; concentration alone earns no flat percentage.
      estimatedImpactUsd: 0,
      confidence: topModel.confidence,
      relatedKeys: [topModel.key]
    });
  }

  const highInputTokenRecords = decisionRecords.filter((record) => record.inputTokens >= 100_000);
  if (highInputTokenRecords.length > 0) {
    recommendations.push({
      id: "prompt-context-trimming",
      title: "Inspect large prompts and retrieved context",
      rationale: "High-input call records identify context exposure, but no matched reduction counterfactual is attached.",
      whyItMatters: "Large context can consume budget, but token volume alone does not prove which context is removable or what quality tradeoff a cut would cause.",
      nextAction: "Inspect the largest prompts locally and run a matched before/after with the same output-acceptance criteria before applying a broader limit.",
      priority: "high",
      estimatedImpactUsd: 0,
      confidence: combinedConfidence(highInputTokenRecords.map((record) => record.costConfidence)),
      relatedKeys: unique(highInputTokenRecords.map((record) => record.model))
    });
  }

  // An operation label alone does not prove identical inputs. Require an
  // adapter-provided stable fingerprint repeated within the same
  // provider/model/operation cohort before presenting a cache candidate.
  const cacheKeys = decisionRecords.map(cacheEvidenceKey).filter(isPresent);
  const repeatedCacheKeys = repeatedValues(cacheKeys);
  const cacheableRecords = cacheAvoidableRecords(decisionRecords, repeatedCacheKeys);
  if (cacheableRecords.length > 0) {
    const repeatedOperations = unique(cacheableRecords.map((record) => record.operation).filter(isPresent));
    recommendations.push({
      id: "caching",
      title: "Cache repeated operations",
      rationale: "The same adapter-provided stable input fingerprint repeats within a provider/model workload.",
      whyItMatters: "Repeated AI calls are the easiest spend to defend cutting because they usually do not change the customer experience.",
      nextAction: "Add a local cache or memoization policy for repeated operation labels before expanding this workflow to more clients.",
      priority: "medium",
      estimatedImpactUsd: roundMoney(sumRecords(cacheableRecords)),
      confidence: combinedConfidence(cacheableRecords.map((record) => record.costConfidence)),
      relatedKeys: repeatedOperations
    });
  }

  const agentSpend = breakdown(decisionRecords, (record) => record.agentId);
  const topAgent = agentSpend[0];
  if (topAgent && topAgent.amountUsd >= 25) {
    recommendations.push({
      id: "agent-caps",
      title: "Confirm the owner and budget for the highest-cost agent",
      rationale: `${topAgent.key} accounts for a material share of sampled usage.`,
      whyItMatters: "Concentration is an accountability signal, but it does not by itself prove abnormal behavior or an avoidable dollar amount.",
      nextAction: `Confirm ${topAgent.key}'s owner and approved range, then collect run-level evidence before proposing a warning threshold or hard cap.`,
      priority: "high",
      estimatedImpactUsd: 0,
      confidence: topAgent.confidence,
      relatedKeys: [topAgent.key]
    });
  }

  const batchableRecords = decisionRecords.filter(
    (record) =>
      record.workloadSemantics?.batchEligible === true &&
      batchCostRetainedByProvider[record.source.provider] !== undefined
  );
  if (batchableRecords.length >= 3) {
    recommendations.push({
      id: "batching",
      title: "Batch low-latency-tolerant work",
      rationale: "At least three call-level records are explicitly attested as latency-tolerant and Batch-eligible.",
      whyItMatters: "Batching turns scattered background calls into an intentional queue, which makes spend easier to forecast and approve.",
      nextAction: "Mark jobs that do not need immediate responses and run them in scheduled batches with a shared context budget.",
      priority: "medium",
      estimatedImpactUsd: roundMoney(batchableRecords.reduce((total, record) => {
        const retained = batchCostRetainedByProvider[record.source.provider]!;
        return total + (record.amountUsd ?? 0) * (1 - retained);
      }, 0)),
      confidence: combinedConfidence(batchableRecords.map((record) => record.costConfidence)),
      relatedKeys: unique(batchableRecords.map((record) => record.operation).filter(isPresent))
    });
  }

  return recommendations;
}

function breakdown(records: UsageRecord[], select: GroupSelector): SpendBreakdownEntry[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = select(record) ?? "unmapped";
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return [...groups.entries()]
    .map(([key, groupRecords]) => ({
      key,
      amountUsd: roundMoney(sumRecords(groupRecords)),
      recordCount: groupRecords.length,
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence))
    }))
    .sort((left, right) => right.amountUsd - left.amountUsd || left.key.localeCompare(right.key));
}

function sumRecords(records: UsageRecord[]): number {
  return records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
}

function confidenceBreakdown(records: UsageRecord[]): Record<CostConfidence, number> {
  return Object.fromEntries(
    costConfidenceValues.map((confidence) => [
      confidence,
      roundMoney(sumRecords(records.filter((record) => record.costConfidence === confidence)))
    ])
  ) as Record<CostConfidence, number>;
}

function combinedConfidence(confidences: CostConfidence[]): CostConfidence {
  if (confidences.length === 0) {
    return "missing";
  }

  return confidences.reduce((lowest, current) =>
    confidenceRank[current] > confidenceRank[lowest] ? current : lowest
  );
}

function repeatedValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function cacheEvidenceKey(record: UsageRecord): string | undefined {
  const fingerprint = record.workloadSemantics?.stableInputFingerprint;
  if (!record.operation || !fingerprint) return undefined;
  return JSON.stringify([record.source.provider, record.model, record.operation, fingerprint]);
}

function cacheAvoidableRecords(records: UsageRecord[], repeatedKeys: string[]): UsageRecord[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = cacheEvidenceKey(record);
    if (!key || !repeatedKeys.includes(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].flatMap((group) =>
    [...group]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
      .slice(1)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function isLocalAgentRecord(record: UsageRecord): boolean {
  return record.providerCostType === "local_agent_logs";
}

function workflowDiagnosticFor(
  workflowKey: string,
  agentId: string,
  hasRunLevelEvidence: boolean
): string {
  return hasRunLevelEvidence
    ? `Confirm the owner and approved budget for ${workflowKey} (${agentId}), reconcile the observed spend, and define one reversible candidate with an accepted-outcome quality bar before approval.`
    : `Confirm the owner and approved budget for ${workflowKey} (${agentId}), reconcile the observed spend, and collect call-level provenance before proposing a reversible optimization.`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundMoney(value: number): number {
  // Persist fractional-cent evidence instead of turning a real positive amount
  // into numeric zero. Presentation layers decide whether to show `<$0.01`.
  return Math.round(value * 10_000) / 10_000;
}
