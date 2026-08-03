import {
  hasCallLevelProvenance,
  hasModeledWorkloadEvidence,
  hasPricedEvidence,
  type CostConfidence,
  type UsageRecord
} from "./schema.js";

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
  /**
   * Estimated monthly savings in USD for this single action. Zero means the
   * evidence identifies value worth investigating but contains no observed
   * counterfactual from which a savings amount can be earned.
   */
  estimatedMonthlySavingsUsd: number;
  /** Spend (in the analyzed window) this action touches. */
  affectedSpendUsd: number;
  /** How many usage records this action is grounded in. */
  recordCount: number;
  /**
   * What one record represents, for honest grounding lines. Local agent logs
   * aggregate a day of sessions into one record, so calling those "calls"
   * overstates precision to the exact audience that will check.
   */
  recordUnit: "calls" | "daily-aggregates" | "tools";
  /** Whether the number is an intervention model or only observed exposure. */
  impactBasis: "modeled_savings" | "observed_value_no_counterfactual";
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

/** Published retained-cost fraction for providers whose Batch pricing we explicitly support. */
const batchCostRetainedByProvider: Readonly<Record<string, number>> = {
  openai: 0.5,
  anthropic: 0.5
};

export function generateCutList(records: UsageRecord[]): CutAction[] {
  // Connected-provider rows are commonly billing buckets, usage aggregates,
  // seats, or user totals. They may be real financial evidence, but they are
  // not individual calls. Modeled cuts require an adapter to explicitly attest
  // `call`/`invocation` granularity and provide a named workload operation.
  // Local transcript aggregates remain eligible only for the observed-only
  // context exposure path below; they never earn a modeled savings number.
  const callLevelRecords = records.filter(hasModeledWorkloadEvidence);
  const contextEvidenceRecords = records.filter((record) =>
    isLocalAgentRecord(record) || (hasCallLevelProvenance(record) && hasPricedEvidence(record))
  );
  const actions: CutAction[] = [
    ...modelDowngradeActions(callLevelRecords),
    ...contextTrimActions(contextEvidenceRecords),
    ...cacheActions(callLevelRecords),
    ...batchActions(callLevelRecords)
  ];

  return actions
    .filter((action) => (
      action.impactBasis === "observed_value_no_counterfactual" ||
      action.estimatedMonthlySavingsUsd >= 0.5
    ))
    .sort(
      (left, right) =>
        right.estimatedMonthlySavingsUsd - left.estimatedMonthlySavingsUsd ||
        right.affectedSpendUsd - left.affectedSpendUsd ||
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
    if (!rule || !record.operation || record.workloadSemantics?.downgradeSafe !== true) {
      continue;
    }
    const operation = record.operation;
    // A named, clearly downgrade-safe workload is required. Unknown operations
    // are not sufficient evidence for a routing counterfactual.
    if (!downgradeSafeOperation.test(operation)) {
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
      recordUnit: groupRecords.every(isLocalAgentRecord) ? "daily-aggregates" : "calls",
      impactBasis: "modeled_savings",
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "model_downgrade"
    });
  }
  return actions;
}

function contextTrimActions(records: UsageRecord[]): CutAction[] {
  const heavy = records.filter((record) => record.inputTokens >= 100_000);
  if (heavy.length === 0) {
    return [];
  }
  const byOperation = new Map<string, UsageRecord[]>();
  for (const record of heavy) {
    const operation = record.operation ?? "large-context calls";
    const key = isLocalAgentRecord(record)
      ? `local::${record.agentId ?? "unknown-agent"}::${record.projectId ?? "unattributed"}`
      : `connected::${operation}`;
    byOperation.set(key, [...(byOperation.get(key) ?? []), record]);
  }

  const actions: CutAction[] = [];
  for (const [key, groupRecords] of byOperation) {
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    const sessionAggregates = groupRecords.every(isLocalAgentRecord);
    const operation = sessionAggregates
      ? groupRecords[0]?.operation ?? "coding-agent activity"
      : key.replace(/^connected::/, "");
    const count = groupRecords.length;
    const agent = groupRecords[0]?.agentId ?? "coding-agent";
    const project = groupRecords[0]?.projectId;
    // Large token volume proves exposure, not that context is removable or
    // what quality/cost delta a change would produce. Context remains an
    // inspect-only action until matched before/after evidence exists.
    const monthlySavings = 0;
    actions.push({
      id: sessionAggregates
        ? `inspect-context-${slug(agent)}-${slug(project ?? "unattributed")}`
        : `inspect-context-${slug(operation)}`,
      title: sessionAggregates
        ? `Investigate cumulative context in ${agent}${project ? ` · ${project}` : " · Unattributed"}`
        : `Inspect oversized context on ${operation}`,
      action: sessionAggregates
        ? `${count} day + agent + model + project aggregate${count === 1 ? "" : "s"} contained at least 100k summed input/cache tokens. Inspect per-session context, compactions, repeated reads, and measured instruction-file size before proposing one reversible change.`
        : `${count} call-level ${operation} record${count === 1 ? "" : "s"} exceeded 100k input tokens. Inspect retrieved chunks and prompt history, then run a matched before/after before claiming savings.`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: count,
      recordUnit: sessionAggregates ? "daily-aggregates" : "calls",
      impactBasis: "observed_value_no_counterfactual",
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "context_trim"
    });
  }
  return actions;
}

function cacheActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const counts = new Map<string, { operation: string; records: UsageRecord[] }>();
  for (const record of records) {
    const fingerprint = record.workloadSemantics?.stableInputFingerprint;
    if (!record.operation || !fingerprint) {
      continue;
    }
    // Local agent logs aggregate interactive sessions under one operation
    // label ("claude-code sessions"). Those are NOT repeated identical calls —
    // a result cache is not a real lever there (prompt caching already applies
    // and is priced into the estimate), so recommending one would be wrong.
    if (isLocalAgentRecord(record)) {
      continue;
    }
    const key = JSON.stringify([record.source.provider, record.model, record.operation, fingerprint]);
    const current = counts.get(key);
    counts.set(key, {
      operation: record.operation,
      records: [...(current?.records ?? []), record]
    });
  }

  const actions: CutAction[] = [];
  for (const [key, group] of counts) {
    const { operation, records: groupRecords } = group;
    if (groupRecords.length < 2) {
      continue;
    }
    const chronological = [...groupRecords].sort(
      (left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
    );
    // The first observation is the canonical miss. Only subsequent calls with
    // the same explicit fingerprint are modeled as avoidable cache hits.
    const avoidableRecords = chronological.slice(1);
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    const windowSavings = sumRecords(avoidableRecords);
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `cache-${slug(operation)}-${stableSuffix(key)}`,
      title: `Cache repeated ${operation} calls`,
      action: `Keep the earliest ${operation} call as the canonical miss and cache the ${avoidableRecords.length} subsequent call${avoidableRecords.length === 1 ? "" : "s"} with the same adapter-provided input fingerprint.`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordUnit: "calls",
      impactBasis: "modeled_savings",
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "cache"
    });
  }
  return actions;
}

function batchActions(records: UsageRecord[]): CutAction[] {
  const window = windowDays(records);
  const byOperation = new Map<string, { operation: string; records: UsageRecord[] }>();
  for (const record of records) {
    if (
      !record.operation ||
      record.workloadSemantics?.batchEligible !== true ||
      batchCostRetainedByProvider[record.source.provider] === undefined ||
      !batchSafeOperation.test(record.operation)
    ) {
      continue;
    }
    const key = JSON.stringify([
      record.source.id,
      record.source.provider,
      record.model,
      record.operation
    ]);
    const current = byOperation.get(key);
    byOperation.set(key, {
      operation: record.operation,
      records: [...(current?.records ?? []), record]
    });
  }

  const actions: CutAction[] = [];
  for (const [key, group] of byOperation) {
    const { operation, records: groupRecords } = group;
    if (groupRecords.length < 3) {
      continue;
    }
    const affectedSpendUsd = roundMoney(sumRecords(groupRecords));
    const retainedCost = batchCostRetainedByProvider[groupRecords[0]!.source.provider]!;
    const windowSavings = affectedSpendUsd * (1 - retainedCost);
    const monthlySavings = roundMoney(toMonthly(windowSavings, window));
    actions.push({
      id: `batch-${slug(operation)}-${stableSuffix(key)}`,
      title: `Move ${operation} calls to the Batch API`,
      action: `Submit ${groupRecords.length} ${operation} call${groupRecords.length === 1 ? "" : "s"} through the provider's Batch API (flat 50% off; results within 24h, fine for offline work).`,
      estimatedMonthlySavingsUsd: monthlySavings,
      affectedSpendUsd,
      recordCount: groupRecords.length,
      recordUnit: "calls",
      impactBasis: "modeled_savings",
      recordIds: groupRecords.map((record) => record.id),
      confidence: combinedConfidence(groupRecords.map((record) => record.costConfidence)),
      kind: "batch"
    });
  }
  return actions;
}

/** Records ingested from local agent transcripts (day-level session aggregates). */
function isLocalAgentRecord(record: UsageRecord): boolean {
  return record.providerCostType === "local_agent_logs";
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

function stableSuffix(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
