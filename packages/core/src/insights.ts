import {
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
    const currentRecords = records.filter((record) => record.timestamp.slice(0, 10) === anomaly.key);
    const topAgent = topBreakdown(currentRecords, (record) => record.agentId);
    const topClient = topBreakdown(currentRecords, (record) => record.clientId);
    const topProject = topBreakdown(currentRecords, (record) => record.projectId);
    const topModels = breakdown(currentRecords, (record) => record.model).slice(0, 2).map((entry) => entry.key);
    const deltaUsd = roundMoney(anomaly.currentAmountUsd - anomaly.previousAmountUsd);
    const likelyDriver = topAgent?.key ?? topProject?.key ?? topClient?.key ?? "unmapped usage";

    return {
      id: `spike-${anomaly.key}`,
      kind: "spike_explanation" as const,
      severity: deltaUsd >= 25 || anomaly.multiplier >= 3 ? "critical" as const : "high" as const,
      title: `Spend spike on ${anomaly.key} needs owner review`,
      summary: `${anomaly.key} spend rose ${formatMultiplier(anomaly.multiplier)} day over day, from ${formatUsd(anomaly.previousAmountUsd)} to ${formatUsd(anomaly.currentAmountUsd)}. The likely driver is ${likelyDriver}, so this needs owner review before the pattern repeats.`,
      evidence: compactEvidence([
        { label: "Previous day spend", value: formatUsd(anomaly.previousAmountUsd) },
        { label: "Current day spend", value: formatUsd(anomaly.currentAmountUsd) },
        { label: "Increase", value: formatUsd(deltaUsd), detail: `${formatMultiplier(anomaly.multiplier)} day-over-day multiplier` },
        topAgent ? { label: "Likely driver", value: topAgent.key, detail: `${formatUsd(topAgent.amountUsd)} across ${topAgent.recordCount} records` } : undefined,
        topClient ? { label: "Client concentration", value: topClient.key, detail: `${formatUsd(topClient.amountUsd)} on spike day` } : undefined,
        topModels.length > 0 ? { label: "Dominant models", value: topModels.join(", ") } : undefined
      ]),
      affectedClients: keysFrom(currentRecords, (record) => record.clientId),
      affectedProjects: keysFrom(currentRecords, (record) => record.projectId),
      affectedAgents: keysFrom(currentRecords, (record) => record.agentId),
      affectedModels: keysFrom(currentRecords, (record) => record.model),
      estimatedImpactUsd: deltaUsd,
      confidence: anomaly.confidence,
      recommendedAction: `Review the ${likelyDriver} runs from ${anomaly.key}, set a temporary warning threshold for this owner, and pause expansion until the largest calls have an expected budget range.`,
      verificationNeeded: "Verify the spike against the provider billing export before treating the dollar amount as finance-grade."
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
  const estimatedImpactUsd = roundMoney(topAgent.amountUsd * 0.15);

  return [{
    id: `agent-cost-driver-${topAgent.key}`,
    kind: "agent_runaway",
    severity: share >= 0.5 ? "high" : "medium",
    title: `${topAgent.key} is the dominant autonomous spend driver`,
    summary: `${topAgent.key} accounts for ${formatPercent(share)} of tracked spend. That is the agent to cap first because one runaway workflow can consume budget before invoice review.`,
    evidence: compactEvidence([
      { label: "Agent spend", value: formatUsd(topAgent.amountUsd), detail: `${topAgent.recordCount} records` },
      { label: "Share of tracked spend", value: formatPercent(share) },
      topModel ? { label: "Dominant model", value: topModel.key, detail: `${formatUsd(topModel.amountUsd)} inside this agent` } : undefined,
      topOperation ? { label: "Dominant operation", value: topOperation.key, detail: `${formatUsd(topOperation.amountUsd)} inside this agent` } : undefined
    ]),
    affectedClients: keysFrom(agentRecords, (record) => record.clientId),
    affectedProjects: keysFrom(agentRecords, (record) => record.projectId),
    affectedAgents: [topAgent.key],
    affectedModels: keysFrom(agentRecords, (record) => record.model),
    estimatedImpactUsd,
    confidence: topAgent.confidence,
    recommendedAction: `Set a local warning threshold and hard cap for ${topAgent.key}, then require approval when a run exceeds its expected spend range.`,
    verificationNeeded: "Confirm whether this agent has an approved budget owner and expected daily range."
  }];
}

function contextBloatInsights(records: UsageRecord[]): SpendInsight[] {
  const highInputRecords = records.filter((record) => record.inputTokens >= 100_000);
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
    title: `${operationLabel} is carrying oversized context`,
    summary: `${operationLabel} includes ${scopedRecords.length} high-input calls and ${formatNumber(totalInputTokens)} input tokens. This is a strong signal that retrieval or prompt context can be trimmed without changing the product surface.`,
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
    estimatedImpactUsd: roundMoney(scopedSpend * 0.18),
    confidence: combinedConfidence(scopedRecords.map((record) => record.costConfidence)),
    recommendedAction: `Sample the largest ${operationLabel} prompts, cap retrieved chunks, and require justification before agents include full documents or long histories.`,
    verificationNeeded: "Inspect representative prompts locally to confirm whether the large context is necessary for output quality."
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

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
