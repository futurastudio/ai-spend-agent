import {
  hasCallLevelProvenance,
  hasPricedEvidence,
  spendComparisonKey,
  type CostConfidence,
  type EvidenceItem,
  type SpendBreakdownEntry,
  type SpendInsight,
  type SpendSummary,
  type UsageRecord,
  spendInsightSchema
} from "./schema.js";

const confidenceRank: Record<CostConfidence, number> = {
  verified: 0,
  estimated: 1,
  detected_unverified: 2,
  missing: 3
};

const severityRank: Record<SpendInsight["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

export function generateSpendInsights(records: UsageRecord[], summary: SpendSummary): SpendInsight[] {
  const insights = [
    ...spikeInsights(records, summary),
    ...agentCostDriverInsights(records, summary),
    ...contextBloatInsights(records)
  ];

  return insights
    .map((insight) => spendInsightSchema.parse(insight))
    .sort((left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      right.estimatedImpactUsd - left.estimatedImpactUsd ||
      left.id.localeCompare(right.id)
    );
}

function spikeInsights(records: UsageRecord[], summary: SpendSummary): SpendInsight[] {
  return summary.anomalies.map((anomaly) => {
    const currentRecords = records.filter((record) =>
      record.timestamp.slice(0, 10) === anomaly.key &&
      (anomaly.comparisonKey === undefined || spendComparisonKey(record) === anomaly.comparisonKey)
    );
    const topAgent = topBreakdown(currentRecords, (record) => record.agentId);
    const topClient = topBreakdown(currentRecords, (record) => record.clientId);
    const topProject = topBreakdown(currentRecords, (record) => record.projectId);
    const topModels = breakdown(currentRecords, (record) => record.model).slice(0, 2).map((entry) => entry.key);
    const deltaUsd = roundMoney(anomaly.currentAmountUsd - anomaly.previousAmountUsd);
    const likelyOwner = topAgent?.key ?? topProject?.key ?? topClient?.key ?? "an unassigned owner";
    const cohortSuffix = stableSuffix(anomaly.comparisonKey ?? "legacy");
    const isProviderBilledCost = currentRecords.length > 0 && currentRecords.every((record) =>
      record.usageGranularity === "billing_bucket" &&
      record.costConfidence === "verified"
    );
    const isAggregateCohort = currentRecords.some((record) => !hasCallLevelProvenance(record));
    const evidenceLabel = isProviderBilledCost ? "Spend" : "Cost/value evidence";
    const evidenceBasis = uniqueStrings(currentRecords.map((record) =>
      `${record.source.provider} · ${record.providerCostType ?? "unclassified"} · ${record.usageGranularity ?? "unclassified"}`
    )).join(", ");

    return {
      id: `spike-${anomaly.key}-${cohortSuffix}`,
      kind: "spike_explanation" as const,
      severity: deltaUsd >= 25 || anomaly.multiplier >= 3 ? "critical" as const : "high" as const,
      title: `${evidenceLabel} spike on ${anomaly.key} needs owner review`,
      summary: `${anomaly.key} ${evidenceLabel.toLowerCase()} in one comparable provider cohort rose ${formatMultiplier(anomaly.multiplier)} day over day, from ${formatUsd(anomaly.previousAmountUsd)} to ${formatUsd(anomaly.currentAmountUsd)}. ${likelyOwner} is the best available ownership lead; ${isAggregateCohort ? "this aggregate bucket does not identify causal runs" : "this cohort change does not by itself prove a cause"}.`,
      evidence: compactEvidence([
        evidenceBasis ? { label: "Comparison basis", value: evidenceBasis } : undefined,
        { label: `Previous cohort ${isProviderBilledCost ? "spend" : "value"}`, value: formatUsd(anomaly.previousAmountUsd) },
        { label: `Current cohort ${isProviderBilledCost ? "spend" : "value"}`, value: formatUsd(anomaly.currentAmountUsd) },
        { label: `${evidenceLabel} increase`, value: formatUsd(deltaUsd), detail: `${formatMultiplier(anomaly.multiplier)} day-over-day multiplier` },
        topAgent ? { label: "Ownership lead", value: topAgent.key, detail: `${formatUsd(topAgent.amountUsd)} across ${topAgent.recordCount} cohort records` } : undefined,
        topClient ? { label: "Client concentration", value: topClient.key, detail: `${formatUsd(topClient.amountUsd)} on spike day` } : undefined,
        topModels.length > 0 ? { label: "Dominant models", value: topModels.join(", ") } : undefined
      ]),
      affectedClients: keysFrom(currentRecords, (record) => record.clientId),
      affectedProjects: keysFrom(currentRecords, (record) => record.projectId),
      affectedAgents: keysFrom(currentRecords, (record) => record.agentId),
      affectedModels: keysFrom(currentRecords, (record) => record.model),
      estimatedImpactUsd: deltaUsd,
      confidence: anomaly.confidence,
      recommendedAction: `Review and reconcile the provider-cohort records from ${anomaly.key}, confirm the accountable owner, and obtain run-level evidence before diagnosing behavior or changing a policy.`,
      verificationNeeded: isAggregateCohort
        ? "Verify both periods against the same provider report shape; aggregate buckets do not identify causal calls or savings."
        : "Verify both periods use the same call-level schema and inspect the underlying workloads before attributing cause or savings."
    };
  });
}

function agentCostDriverInsights(records: UsageRecord[], summary: SpendSummary): SpendInsight[] {
  const topAgent = summary.byAgent[0];
  if (!topAgent || topAgent.key === "unmapped" || topAgent.amountUsd < 25 || summary.totalUsd === 0) {
    return [];
  }

  const agentRecords = records.filter((record) => record.agentId === topAgent.key);
  const share = topAgent.amountUsd / summary.totalUsd;
  if (share < 0.35) {
    return [];
  }

  const topOperation = topBreakdown(agentRecords, (record) => record.operation);
  const topModel = topBreakdown(agentRecords, (record) => record.model);
  const hasRunLevelEvidence = agentRecords.length > 0 && agentRecords.every(hasCallLevelProvenance);

  return [{
    id: `agent-spend-concentration-${topAgent.key}`,
    kind: "optimization_opportunity",
    severity: "medium",
    title: `${topAgent.key} spend concentration needs owner and budget review`,
    summary: `${topAgent.key} is attached to ${formatPercent(share)} of tracked spend. Concentration alone does not prove abnormal behavior or an avoidable dollar amount${hasRunLevelEvidence ? "." : "; the evidence is aggregate rather than run-level."}`,
    evidence: compactEvidence([
      { label: "Attributed spend", value: formatUsd(topAgent.amountUsd), detail: `${topAgent.recordCount} ${hasRunLevelEvidence ? "call-level" : "aggregate"} record${topAgent.recordCount === 1 ? "" : "s"}` },
      { label: "Share of tracked spend", value: formatPercent(share) },
      topModel ? { label: "Dominant model or billing label", value: topModel.key, detail: `${formatUsd(topModel.amountUsd)} in this concentration` } : undefined,
      topOperation ? { label: "Operation label", value: topOperation.key, detail: hasRunLevelEvidence ? "Call-level attribution" : "Not verified as one call or run" } : undefined
    ]),
    affectedClients: keysFrom(agentRecords, (record) => record.clientId),
    affectedProjects: keysFrom(agentRecords, (record) => record.projectId),
    affectedAgents: [topAgent.key],
    affectedModels: keysFrom(agentRecords, (record) => record.model),
    estimatedImpactUsd: 0,
    confidence: topAgent.confidence,
    recommendedAction: `Confirm who owns ${topAgent.key}, reconcile the spend to its approved budget, and collect behavioral evidence before setting a cap or savings target.`,
    verificationNeeded: "Confirm the budget owner and expected range; concentration alone is not behavioral evidence."
  }];
}

function contextBloatInsights(records: UsageRecord[]): SpendInsight[] {
  const highInputRecords = records.filter((record) =>
    hasCallLevelProvenance(record) &&
    hasPricedEvidence(record) &&
    record.inputTokens >= 100_000
  );
  if (highInputRecords.length === 0) {
    return [];
  }

  const topOperation = topBreakdown(highInputRecords, (record) => record.operation);
  const scopedRecords = topOperation
    ? highInputRecords.filter((record) => record.operation === topOperation.key)
    : highInputRecords;
  const operationLabel = topOperation?.key ?? "large-context calls";
  const totalInputTokens = scopedRecords.reduce((total, record) => total + record.inputTokens, 0);
  const scopedSpend = roundMoney(sumRecords(scopedRecords));

  if (scopedSpend < 20) {
    return [];
  }

  return [{
    id: `context-bloat-${slug(operationLabel)}`,
    kind: "context_bloat",
    severity: scopedSpend >= 60 ? "high" : "medium",
    title: `${operationLabel} needs context inspection`,
    summary: `${operationLabel} includes ${scopedRecords.length} high-input calls and ${formatNumber(totalInputTokens)} input tokens. This proves context exposure, not that any particular context is removable or that quality will hold after a cut.`,
    evidence: [
      { label: "High-input calls", value: String(scopedRecords.length), detail: "Calls at or above 100,000 input tokens" },
      { label: "Input tokens", value: formatNumber(totalInputTokens) },
      { label: "Spend attached to large context", value: formatUsd(scopedSpend) },
      { label: "Dominant operation", value: operationLabel }
    ],
    affectedClients: keysFrom(scopedRecords, (record) => record.clientId),
    affectedProjects: keysFrom(scopedRecords, (record) => record.projectId),
    affectedAgents: keysFrom(scopedRecords, (record) => record.agentId),
    affectedModels: keysFrom(scopedRecords, (record) => record.model),
    estimatedImpactUsd: 0,
    confidence: combinedConfidence(scopedRecords.map((record) => record.costConfidence)),
    recommendedAction: `Inspect representative ${operationLabel} prompts locally and run a matched before/after with the same acceptance criteria before proposing one reversible context change.`,
    verificationNeeded: "Measure token and quality deltas on matched calls; no savings counterfactual is present yet."
  }];
}

function topBreakdown(records: UsageRecord[], select: (record: UsageRecord) => string | undefined): SpendBreakdownEntry | undefined {
  return breakdown(records, select)[0];
}

function breakdown(records: UsageRecord[], select: (record: UsageRecord) => string | undefined): SpendBreakdownEntry[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = select(record) ?? "unmapped";
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return Array.from(groups.entries())
    .map(([key, groupRecords]) => ({
      key,
      amountUsd: roundMoney(sumRecords(groupRecords)),
      recordCount: groupRecords.length,
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence))
    }))
    .sort((left, right) => right.amountUsd - left.amountUsd || left.key.localeCompare(right.key));
}

function keysFrom(records: UsageRecord[], select: (record: UsageRecord) => string | undefined): string[] {
  return Array.from(new Set(records.map(select).filter((value): value is string => value !== undefined)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function compactEvidence(items: Array<EvidenceItem | undefined>): EvidenceItem[] {
  return items.filter((item): item is EvidenceItem => item !== undefined);
}

function sumRecords(records: UsageRecord[]): number {
  return records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
}

function combinedConfidence(confidences: CostConfidence[]): CostConfidence {
  if (confidences.length === 0) {
    return "missing";
  }

  return confidences.reduce((lowest, current) =>
    confidenceRank[current] > confidenceRank[lowest] ? current : lowest
  );
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function formatMultiplier(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)}x`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function stableSuffix(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
