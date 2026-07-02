import { generateSpendInsights } from "./insights.js";
import {
  costConfidenceValues,
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

/**
 * Planning ratios behind every "estimated impact/savings" figure this module
 * emits. These are deliberately ROUND heuristics — orientation numbers for a
 * first conversation, not measured savings — and every consumer labels them
 * estimated. They are aligned with the documented per-model economics in
 * cutList.ts (downgradeRules retain 20–50% of cost on downgrade-safe work;
 * the Batch API retains 50%): applying those cuts to only the eligible slice
 * of a workload typically lands in the 10–30% range below.
 *
 * If you change one, change the doc line with it. No undocumented multiplier
 * may ever reach user-visible output — that is a product bug on an
 * honest-numbers brand, not a style issue.
 */
const impactRatios = {
  /** Portion of a workflow's spend typically cuttable via caps, caching, and tier routing. */
  workflowSavings: 0.2,
  /** Un-attributed workflow spend treated as margin-exposed until mapped to a client/project (coin-flip prior). */
  workflowMarginRisk: 0.5,
  /** Top-model spend recoverable by moving downgrade-safe work to a cheaper tier (see cutList.ts downgradeRules). */
  modelDowngrade: 0.3,
  /** Cost of oversized-context calls recoverable by trimming prompts/retrieval. */
  promptTrimming: 0.15,
  /** Spend on repeated identical operations recoverable via caching/memoization. */
  caching: 0.25,
  /** Top-agent spend avoidable with budget caps catching runaway loops. */
  agentCaps: 0.15,
  /** Total spend addressable by moving latency-tolerant work to Batch APIs (50% price × eligible slice). */
  batching: 0.1,
  /** Total spend addressable with price/quality routing across multiple providers. */
  routing: 0.1
} as const;

export function analyzeSpend(records: UsageRecord[]): SpendSummary {
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
    anomalies: detectSpendSpikes(records),
    recommendations: generateRecommendations(records),
    insights: []
  };

  summary.insights = generateSpendInsights(records, summary);

  return spendSummarySchema.parse(summary);
}

export function detectSpendSpikes(records: UsageRecord[]): SpendAnomaly[] {
  const byDay = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const day = record.timestamp.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), record]);
  }

  const days = [...byDay.keys()].sort();
  const anomalies: SpendAnomaly[] = [];
  for (let index = 1; index < days.length; index += 1) {
    const previousDay = days[index - 1]!;
    const currentDay = days[index]!;
    const previousAmountUsd = roundMoney(sumRecords(byDay.get(previousDay) ?? []));
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
        previousAmountUsd,
        currentAmountUsd,
        multiplier: roundMoney(multiplier),
        confidence: combinedConfidence(currentRecords.map((record) => record.costConfidence))
      });
    }
  }

  return anomalies;
}

export function generateWorkflowWatch(records: UsageRecord[]): WorkflowWatchEntry[] {
  const totalUsd = sumRecords(records);
  if (totalUsd === 0) {
    return [];
  }

  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
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
      const amountUsd = roundMoney(sumRecords(groupRecords));
      const shareOfSpend = roundRatio(amountUsd / totalUsd);
      const estimatedSavingsUsd = roundMoney(amountUsd * impactRatios.workflowSavings);
      const estimatedMarginRiskUsd = roundMoney(amountUsd * impactRatios.workflowMarginRisk);
      const confidence = combinedConfidence(groupRecords.map((record) => record.costConfidence));
      const suggestedOptimization = workflowOptimizationFor(workflowKey, agentId);

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
        applyArtifact: `Copy this into your coding agent to cut cost: ${suggestedOptimization}`,
        verificationPlan: `After applying, rerun the ${workflowKey} workflow on the same sample and compare spend, latency, and output acceptance before rolling it out.`
      } satisfies WorkflowWatchEntry;
    })
    .filter((entry) => entry.amountUsd > 0)
    .sort((left, right) => right.estimatedMarginRiskUsd - left.estimatedMarginRiskUsd || left.id.localeCompare(right.id))
    .slice(0, 5);
}

export function generateRecommendations(records: UsageRecord[]): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const modelSpend = breakdown(records, (record) => record.model);
  const topModel = modelSpend[0];
  if (topModel && topModel.amountUsd >= 20) {
    recommendations.push({
      id: "model-downgrade",
      title: "Review expensive model workloads for downgrade candidates",
      rationale: `${topModel.key} is the largest cost driver in the current local sample.`,
      whyItMatters: "Premium model usage tends to become invisible once agents are running in the background. Board owners need a clear rule for which jobs deserve the expensive model.",
      nextAction: `Audit the top ${topModel.key} operations and move low-risk summarization, extraction, and draft work to a cheaper model tier first.`,
      priority: "high",
      estimatedImpactUsd: roundMoney(topModel.amountUsd * impactRatios.modelDowngrade),
      confidence: topModel.confidence,
      relatedKeys: [topModel.key]
    });
  }

  const highInputTokenRecords = records.filter((record) => record.inputTokens >= 100_000);
  if (highInputTokenRecords.length > 0) {
    recommendations.push({
      id: "prompt-context-trimming",
      title: "Trim large prompts and retrieved context",
      rationale: "High input-token calls suggest prompt or retrieval context may be oversized.",
      whyItMatters: "Context bloat compounds across every agent run and can make spend rise even when output quality does not improve.",
      nextAction: "Sample the largest prompts, cap retrieval chunks, and require justification before agents include full documents or long histories.",
      priority: "high",
      estimatedImpactUsd: roundMoney(sumRecords(highInputTokenRecords) * impactRatios.promptTrimming),
      confidence: combinedConfidence(highInputTokenRecords.map((record) => record.costConfidence)),
      relatedKeys: unique(highInputTokenRecords.map((record) => record.model))
    });
  }

  const repeatedOperations = repeatedValues(records.map((record) => record.operation).filter(isPresent));
  if (repeatedOperations.length > 0) {
    recommendations.push({
      id: "caching",
      title: "Cache repeated operations",
      rationale: "Repeated operation labels are present in the sample and may be cacheable.",
      whyItMatters: "Repeated AI calls are the easiest spend to defend cutting because they usually do not change the customer experience.",
      nextAction: "Add a local cache or memoization policy for repeated operation labels before expanding this workflow to more clients.",
      priority: "medium",
      estimatedImpactUsd: roundMoney(sumRecords(records.filter((record) => repeatedOperations.includes(record.operation ?? ""))) * impactRatios.caching),
      confidence: combinedConfidence(records.map((record) => record.costConfidence)),
      relatedKeys: repeatedOperations
    });
  }

  const agentSpend = breakdown(records, (record) => record.agentId);
  const topAgent = agentSpend[0];
  if (topAgent && topAgent.amountUsd >= 25) {
    recommendations.push({
      id: "agent-caps",
      title: "Set local spend caps for the highest-cost agent",
      rationale: `${topAgent.key} accounts for a material share of sampled usage.`,
      whyItMatters: "An autonomous agent can quietly turn one bad loop or broad task into a budget issue before anyone reviews the invoice.",
      nextAction: `Set a warning threshold and hard cap for ${topAgent.key}, then require approval when a run exceeds its expected range.`,
      priority: "high",
      estimatedImpactUsd: roundMoney(topAgent.amountUsd * impactRatios.agentCaps),
      confidence: topAgent.confidence,
      relatedKeys: [topAgent.key]
    });
  }

  if (records.length >= 8) {
    recommendations.push({
      id: "batching",
      title: "Batch low-latency-tolerant work",
      rationale: "The sample contains enough discrete calls to review for batching opportunities.",
      whyItMatters: "Batching turns scattered background calls into an intentional queue, which makes spend easier to forecast and approve.",
      nextAction: "Mark jobs that do not need immediate responses and run them in scheduled batches with a shared context budget.",
      priority: "medium",
      estimatedImpactUsd: roundMoney(sumRecords(records) * impactRatios.batching),
      confidence: combinedConfidence(records.map((record) => record.costConfidence)),
      relatedKeys: ["usage-records"]
    });
  }

  const sources = unique(records.map((record) => record.source.id));
  if (sources.length > 1) {
    recommendations.push({
      id: "routing",
      title: "Route workloads by price and quality requirements",
      rationale: "Multiple AI providers are represented, so routing policy can reduce avoidable spend.",
      whyItMatters: "Without routing policy, teams pay premium prices for tasks where cheaper models or providers would be good enough.",
      nextAction: "Define default provider/model tiers for extraction, drafting, research, and high-stakes reasoning, then measure quality deltas.",
      priority: "medium",
      estimatedImpactUsd: roundMoney(sumRecords(records) * impactRatios.routing),
      confidence: combinedConfidence(records.map((record) => record.costConfidence)),
      relatedKeys: sources
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

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function workflowOptimizationFor(workflowKey: string, agentId: string): string {
  const normalized = workflowKey.toLowerCase();
  if (normalized.includes("research") || normalized.includes("summary")) {
    return `Cap context for ${workflowKey}, cache repeated research inputs, and route first-pass summaries from ${agentId} to a cheaper model tier unless confidence drops.`;
  }

  if (normalized.includes("draft") || normalized.includes("copy")) {
    return `Move first-draft generation for ${workflowKey} to a cheaper model tier, keep premium review only for final approval, and cache brand/context blocks.`;
  }

  return `Add a per-run budget cap for ${workflowKey}, route low-risk calls to a cheaper model tier, and cache stable inputs before expanding ${agentId}.`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
