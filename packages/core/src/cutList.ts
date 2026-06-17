import type { CostConfidence, UsageRecord } from "./schema.js";

/**
 * Actionable, dollar-specific "cut" suggestions.
 *
 * The product wow is specificity: instead of "review expensive model
 * workloads", we say "move these 4 gpt-4.1 ticket_triage calls to
 * gpt-4.1-mini -> save ~$3.10/mo". Every entry is grounded in real records
 * from the loaded sample/usage so the dollar amount is defensible.
 */
export type CutAction = {
  id: string;
  /** Short imperative headline, e.g. "Move gpt-4.1 ticket_triage to gpt-4.1-mini". */
  title: string;
  /** One-line, copy-pasteable instruction with the exact target. */
  action: string;
  /** Estimated monthly savings in USD for this single action. */
  estimatedMonthlySavingsUsd: number;
  /** Spend (in the analyzed window) this action touches. */
  affectedSpendUsd: number;
  /** How many usage records this action is grounded in. */
  recordCount: number;
  /** Lowest confidence of the underlying records (drives how we caveat $). */
  confidence: CostConfidence;
  kind: "model_downgrade" | "context_trim" | "cache" | "batch";
  /**
   * IDs of the usage records this action's savings are computed from. Used to
   * deduplicate overlapping recommendations so the same spend is never counted
   * by two actions (see {@link buildRecommendedPlan}).
   */
  recordIds: string[];
};

/**
 * A non-overlapping "recommended plan" plus the leftover overlapping
 * opportunities. The recommended-plan total is the only savings number safe to
 * present as a single figure: each underlying record is optimized by at most one
 * action, so the total can never exceed the projected spend it draws from.
 */
export type RecommendedPlan = {
  /** Actions chosen so their underlying records don't overlap. */
  recommended: CutAction[];
  /** Actions dropped because they target spend already claimed above. */
  additional: CutAction[];
  /** Deduplicated monthly savings — safe to display as one number. */
  recommendedSavingsUsd: number;
  /** Savings from the overlapping leftovers — NOT additive with the above. */
  additionalSavingsUsd: number;
  /** How the headline number was derived (for honest labeling). */
  savingsMath: "deduplicated";
};

/**
 * Select a non-overlapping subset of cut actions, highest-savings first. An
 * action is added only if none of its records were already claimed by a
 * previously selected action; otherwise it falls to {@link RecommendedPlan.additional}.
 * This guarantees the recommended total never double-counts a dollar of spend.
 */
export function buildRecommendedPlan(actions: CutAction[]): RecommendedPlan {
  const sorted = [...actions].sort(
    (left, right) =>
      right.estimatedMonthlySavingsUsd - left.estimatedMonthlySavingsUsd ||
      left.id.localeCompare(right.id)
  );
  const claimed = new Set<string>();
  const recommended: CutAction[] = [];
  const additional: CutAction[] = [];
  for (const action of sorted) {
    const overlaps = action.recordIds.some((id) => claimed.has(id));
    if (overlaps) {
      additional.push(action);
      continue;
    }
    for (const id of action.recordIds) claimed.add(id);
    recommended.push(action);
  }
  return {
    recommended,
    additional,
    recommendedSavingsUsd: roundMoney(recommended.reduce((total, a) => total + a.estimatedMonthlySavingsUsd, 0)),
    additionalSavingsUsd: roundMoney(additional.reduce((total, a) => total + a.estimatedMonthlySavingsUsd, 0)),
    savingsMath: "deduplicated"
  };
}

const confidenceRank: Record<CostConfidence, number> = {
  verified: 0,
  estimated: 1,
  detected_unverified: 2,
  missing: 3
};

/**
 * Known cheaper-tier substitutes and the fraction of cost they typically
 * preserve. e.g. gpt-4.1-mini costs roughly 20% of gpt-4.1, so moving a
 * downgrade-safe workload saves ~80% of that slice. These are conservative,
 * widely-published mid-2026 ratios used only for *estimates* (labeled as such).
 */
type DowngradeRule = {
  match: RegExp;
  target: string;
  /** Fraction of the original cost retained after the downgrade (0..1). */
  costRetained: number;
};

const downgradeRules: DowngradeRule[] = [
  // Frontier tiers (mid-2026): Fable 5 ($10/$50 per M) -> Opus 4.8 ($5/$25)
  // retains ~50% of cost; GPT-5.x -> matching mini tier retains ~20%.
  { match: /^claude-fable-5(?:[.-].*)?$/i, target: "claude-opus-4-8", costRetained: 0.5 },
  { match: /^gpt-5\.5$/i, target: "gpt-5.5-mini", costRetained: 0.2 },
  { match: /^gpt-5(\.\d+)?$/i, target: "gpt-5-mini", costRetained: 0.2 },
  { match: /^gpt-4\.1$/i, target: "gpt-4.1-mini", costRetained: 0.2 },
  { match: /^gpt-4o$/i, target: "gpt-4o-mini", costRetained: 0.18 },
  { match: /^gpt-4-turbo$/i, target: "gpt-4o-mini", costRetained: 0.12 },
  { match: /^o3$/i, target: "o4-mini", costRetained: 0.25 },
  { match: /^claude-sonnet-4(?:[.-].*)?$/i, target: "claude-haiku-4-5", costRetained: 0.25 },
  { match: /^claude-opus-4(?:[.-].*)?$/i, target: "claude-sonnet-4-6", costRetained: 0.3 },
  { match: /^claude-3-5-sonnet.*$/i, target: "claude-3-5-haiku", costRetained: 0.25 }
];

/**
 * Operations that are usually quality-safe to run on a cheaper tier
 * (extraction, triage, drafting, summarization). Used to gate model
 * downgrade suggestions so we don't recommend downgrading high-stakes work.
 */
const downgradeSafeOperation = /triage|extract|classif|summary|summari|draft|reply|tag|label|categor/i;

/**
 * Operations that read as offline/asynchronous (nobody is waiting on the
 * response), so they can move to the providers' Batch APIs — a flat 50%
 * discount at both OpenAI and Anthropic. Deliberately narrower than
 * downgradeSafeOperation: drafting/replying is interactive, summarizing a
 * backlog is not.
 */
const batchSafeOperation = /summar|extract|classif|embed|enrich|index|backfill|digest|report|translat|transcri|batch/i;

/** Fraction of cost retained on the Batch API (both providers price it at 50%). */
const batchCostRetained = 0.5;

export function generateCutList(records: UsageRecord[]): CutAction[] {
  const actions: CutAction[] = [
    ...modelDowngradeActions(records),
    ...contextTrimActions(records),
    ...cacheActions(records),
    ...batchActions(records)
  ];

  return actions
    .filter((action) => action.estimatedMonthlySavingsUsd >= 0.5)
    .sort(
      (left, right) =>
        right.estimatedMonthlySavingsUsd - left.estimatedMonthlySavingsUsd ||
        left.id.localeCompare(right.id)
    );
}

/** Sum of all per-action estimated monthly savings. */
export function totalEstimatedMonthlySavingsUsd(actions: CutAction[]): number {
  return roundMoney(actions.reduce((total, action) => total + action.estimatedMonthlySavingsUsd, 0));
}

function modelDowngradeActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const rule = downgradeRules.find((candidate) => candidate.match.test(record.model));
    if (!rule) {
      continue;
    }
    const operation = record.operation ?? "general";
    // Only suggest downgrades for clearly downgrade-safe operations, OR when
    // the operation is unknown (we still flag it, but caveat via confidence).
    if (record.operation && !downgradeSafeOperation.test(operation)) {
      continue;
    }
    const key = `${record.model}::${operation}::${rule.target}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const actions: CutAction[] = [];
  for (const [key, groupRecords] of groups) {
    const [model, operation, target] = key.split("::") as [string, string, string];
    const rule = downgradeRules.find((candidate) => candidate.match.test(model))!;
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    const windowSavings = affectedSpendUsd * (1 - rule.costRetained);
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `downgrade-${slug(model)}-${slug(operation)}`,
      title: `Move ${model} ${operation} calls to ${target}`,
      action: `Route ${groupRecords.length} ${operation} call${groupRecords.length === 1 ? "" : "s"} from ${model} to ${target} (keep ${model} only when output is rejected).`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "model_downgrade"
    });
  }
  return actions;
}

function contextTrimActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const heavy = records.filter((record) => record.inputTokens >= 100_000);
  if (heavy.length === 0) {
    return [];
  }
  const byOperation = new Map<string, UsageRecord[]>();
  for (const record of heavy) {
    const operation = record.operation ?? "large-context calls";
    byOperation.set(operation, [...(byOperation.get(operation) ?? []), record]);
  }

  const actions: CutAction[] = [];
  for (const [operation, groupRecords] of byOperation) {
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    // Trimming oversized retrieval/context conservatively recovers ~25% of the
    // input-token cost on these large calls.
    const windowSavings = affectedSpendUsd * 0.25;
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `trim-${slug(operation)}`,
      title: `Trim oversized context on ${operation}`,
      action: `Cap retrieval/prompt size on ${groupRecords.length} large ${operation} call${groupRecords.length === 1 ? "" : "s"} (>=100k input tokens) before they fan out.`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "context_trim"
    });
  }
  return actions;
}

function cacheActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const counts = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (!record.operation) {
      continue;
    }
    counts.set(record.operation, [...(counts.get(record.operation) ?? []), record]);
  }

  const actions: CutAction[] = [];
  for (const [operation, groupRecords] of counts) {
    if (groupRecords.length < 3) {
      continue;
    }
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    // Caching repeated identical-ish operations conservatively recovers ~20%.
    const windowSavings = affectedSpendUsd * 0.2;
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `cache-${slug(operation)}`,
      title: `Cache repeated ${operation} calls`,
      action: `Add a result cache for ${operation} (${groupRecords.length} repeated call${groupRecords.length === 1 ? "" : "s"}) so identical inputs do not re-bill.`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "cache"
    });
  }
  return actions;
}

function batchActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const byOperation = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (!record.operation || !batchSafeOperation.test(record.operation)) {
      continue;
    }
    byOperation.set(record.operation, [...(byOperation.get(record.operation) ?? []), record]);
  }

  const actions: CutAction[] = [];
  for (const [operation, groupRecords] of byOperation) {
    if (groupRecords.length < 3) {
      continue;
    }
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    const windowSavings = affectedSpendUsd * (1 - batchCostRetained);
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `batch-${slug(operation)}`,
      title: `Move ${operation} calls to the Batch API`,
      action: `Submit ${groupRecords.length} ${operation} call${groupRecords.length === 1 ? "" : "s"} through the provider's Batch API (flat 50% off; results within 24h, fine for offline work).`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "batch"
    });
  }
  return actions;
}

/** Number of distinct calendar days the records span (min 1). */
function windowDays(records: UsageRecord[]): number {
  const days = new Set(records.map((record) => record.timestamp.slice(0, 10)));
  return Math.max(1, days.size);
}

/**
 * Public view of the observed window, so the renderer can caveat monthly
 * projections honestly: a 30-day figure extrapolated from 1–2 days of data
 * assumes the pattern repeats, which it may not.
 */
export function usageWindowDays(records: UsageRecord[]): number {
  return windowDays(records);
}

/** Project a window's savings to a 30-day month. */
function toMonthly(windowSavings: number, windowDayCount: number): number {
  return (windowSavings / windowDayCount) * 30;
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
