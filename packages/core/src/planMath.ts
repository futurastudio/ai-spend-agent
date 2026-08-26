import type { DetectedPlan } from "./planDetection.js";
import type { UsageRecord } from "./schema.js";
import {
  safeUntrustedLabel,
  WITHHELD_ENTITY_LABEL,
  WITHHELD_PLAN_LABEL
} from "./untrustedLabel.js";

/**
 * The plan label and the limit signal are read out of the agent's own local
 * config files, so both are untrusted text that lands mid-sentence in a
 * headline the readout, the report and `doctor` all print verbatim.
 */
function safePlanLabel(value: string): string {
  return safeUntrustedLabel(value, WITHHELD_PLAN_LABEL);
}

function safeLimitSignal(value: string): string {
  return safeUntrustedLabel(value, WITHHELD_ENTITY_LABEL);
}

/**
 * Plan-price math: compares API-equivalent usage (from local agent logs)
 * against published subscription plan prices. This is comparison context,
 * not proof of entitlement, marginal cash cost, remaining capacity, or the
 * cheapest option for a particular account.
 *
 * Prices are mid-2026 list prices. As of 2026-06-15, programmatic/Agent-SDK
 * usage on Claude plans is metered against a separate monthly credit pool at
 * API rates ($20 Pro / $100 Max 5x / $200 Max 20x) — which makes the
 * API-equivalent dollar figure the number that matters on both paths.
 */
export type SubscriptionPlan = {
  id: string;
  provider: "anthropic" | "openai";
  agent: "claude-code" | "codex";
  name: string;
  monthlyUsd: number;
  /** Rough API-equivalent comparison threshold; not an entitlement limit. */
  coversUpToUsd: number;
};

export const subscriptionPlans: SubscriptionPlan[] = [
  { id: "claude-pro", provider: "anthropic", agent: "claude-code", name: "Claude Pro", monthlyUsd: 20, coversUpToUsd: 50 },
  { id: "claude-max-5x", provider: "anthropic", agent: "claude-code", name: "Claude Max 5x", monthlyUsd: 100, coversUpToUsd: 250 },
  { id: "claude-max-20x", provider: "anthropic", agent: "claude-code", name: "Claude Max 20x", monthlyUsd: 200, coversUpToUsd: 1000 },
  { id: "chatgpt-plus", provider: "openai", agent: "codex", name: "ChatGPT Plus", monthlyUsd: 20, coversUpToUsd: 60 },
  { id: "chatgpt-pro", provider: "openai", agent: "codex", name: "ChatGPT Pro", monthlyUsd: 200, coversUpToUsd: 1000 }
];

export type PlanCheck = {
  agent: "claude-code" | "codex";
  /** 30-day projection of API-equivalent spend observed in local logs. */
  apiEquivalentMonthlyUsd: number;
  /** Distinct days of observed usage the projection is based on. */
  windowDays: number;
  /** Reference plan selected by a rough API-equivalent comparison (if any). */
  suggestedPlan?: SubscriptionPlan;
  /** apiEquivalentMonthlyUsd - plan price, when positive. */
  monthlySavingsVsApiUsd?: number;
  /**
   * API-equivalent usage ÷ plan price. This is a value comparison, not an
   * account entitlement or ROI measurement.
   */
  valueMultiple?: number;
  /** Plan label detected in local metadata (or supplied via --plan), if any. */
  detectedPlan?: DetectedPlan;
  /** Set when projection exceeds a rough comparison threshold or a limit signal exists. */
  upgradeHint?: string;
  /** One-line, render-ready verdict. */
  headline: string;
};

const localLogCostType = "local_agent_logs";

/**
 * Compute per-agent plan checks from usage records. Only records that came
 * from local agent logs participate (billing-API records already have real
 * prices and a real plan behind them).
 *
 * When `detectedPlans` carries a locally detected plan label (or --plan
 * override), the result identifies that provenance and keeps comparison math
 * separate from provider-reported limits.
 */
export function computePlanChecks(records: UsageRecord[], detectedPlans: DetectedPlan[] = []): PlanCheck[] {
  const localRecords = records.filter(
    (record) =>
      record.providerCostType === localLogCostType &&
      (record.agentId === "claude-code" || record.agentId === "codex") &&
      typeof record.amountUsd === "number"
  );
  if (localRecords.length === 0) {
    return [];
  }

  const byAgent = new Map<"claude-code" | "codex", UsageRecord[]>();
  for (const record of localRecords) {
    const agent = record.agentId as "claude-code" | "codex";
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), record]);
  }

  const checks: PlanCheck[] = [];
  for (const [agent, agentRecords] of byAgent) {
    const windowDays = Math.max(1, new Set(agentRecords.map((record) => record.timestamp.slice(0, 10))).size);
    const windowUsd = agentRecords.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
    const monthly = roundMoney((windowUsd / windowDays) * 30);
    const candidates = subscriptionPlans.filter((plan) => plan.agent === agent);
    const suggested = candidates.find((plan) => monthly <= plan.coversUpToUsd) ?? candidates[candidates.length - 1];
    const savings = suggested ? roundMoney(monthly - suggested.monthlyUsd) : undefined;

    // Always state the projection basis: this number divides by ACTIVE days
    // (days with usage), which can differ from the calendar window shown
    // elsewhere on the readout — a technical reader will divide and check.
    const basis = `projected from ${windowDays} active day${windowDays === 1 ? "" : "s"}`;
    const detected = detectedPlans.find((plan) => plan.agent === agent);
    const detectedKnown = detected?.planId
      ? subscriptionPlans.find((plan) => plan.id === detected.planId)
      : undefined;

    let headline: string;
    let valueMultiple: number | undefined;
    let upgradeHint: string | undefined;
    let effectiveSavings: number | undefined;

    if (detectedKnown) {
      // The label comes from local metadata or an explicit override. It is not
      // independently verified against the provider account.
      valueMultiple = roundValueMultiple(monthly / detectedKnown.monthlyUsd);
      const savingsVsApi = roundMoney(monthly - detectedKnown.monthlyUsd);
      effectiveSavings = savingsVsApi > 0 ? savingsVsApi : undefined;
      headline =
        `${agent}: ~${formatUsd(monthly)}/mo at API rates (${basis}) — compared with ${detectedKnown.name} ` +
        `($${detectedKnown.monthlyUsd}/mo; label detected locally): ~${valueMultiple}× the plan price in API-equivalent usage` +
        (effectiveSavings ? `, a ~${formatUsd(effectiveSavings)}/mo value difference to investigate.` : `.`);
      if (monthly > detectedKnown.coversUpToUsd) {
        const nextTier = subscriptionPlans.find(
          (plan) => plan.agent === agent && plan.coversUpToUsd > detectedKnown.coversUpToUsd
        );
        // A local limit signal upgrades "might hit limits" to hard evidence.
        const evidence = detected?.limitSignal
          ? `local metadata reports ${safeLimitSignal(detected.limitSignal)}`
          : `if the provider reports active rate limits`;
        upgradeHint = nextTier
          ? `API-equivalent projection exceeds the rough ${detectedKnown.name} comparison threshold (~$${detectedKnown.coversUpToUsd}/mo); ${evidence}. ${nextTier.name} ($${nextTier.monthlyUsd}/mo) is the next listed tier, but verify account limits before changing plans; trimming context (below) may buy headroom.`
          : `API-equivalent projection exceeds the rough ${detectedKnown.name} comparison threshold (~$${detectedKnown.coversUpToUsd}/mo); verify account limits before changing plans. Trimming context (below) may buy headroom.`;
      } else if (detected?.limitSignal) {
        upgradeHint = `local metadata reports ${safeLimitSignal(detected.limitSignal)}; verify the live provider window. Trimming context (below) may buy headroom.`;
      }
    } else if (detected) {
      // Detected a plan we can't price (e.g. an unrecognized tier): state the
      // fact, then fall back to suggestion math without pretending certainty.
      headline =
        `${agent}: ~${formatUsd(monthly)}/mo at API rates (${basis}) — compared with ${safePlanLabel(detected.planLabel)} ` +
        `(label detected locally; price not in our table)` +
        (suggested ? `; reference listed plan: ${suggested.name} ($${suggested.monthlyUsd}/mo).` : `.`);
    } else {
      const covered = suggested && typeof savings === "number" && savings > 0;
      valueMultiple = covered ? roundValueMultiple(monthly / suggested.monthlyUsd) : undefined;
      effectiveSavings = covered ? savings : undefined;
      if (!suggested) {
        headline = `${agent}: ~${formatUsd(monthly)}/mo at API rates (${basis}).`;
      } else if (covered) {
        headline = `${agent}: ~${formatUsd(monthly)}/mo at API rates (${basis}) — ${suggested.name} is a $${suggested.monthlyUsd}/mo reference point. That is ~${valueMultiple}× the plan price in API-equivalent usage, a ~${formatUsd(savings)}/mo value difference to investigate; it does not prove plan coverage.`;
      } else {
        headline = `${agent}: ~${formatUsd(monthly)}/mo at API rates (${basis}) — below the $${suggested.monthlyUsd}/mo price of ${suggested.name}; compare account benefits and provider-reported charges before changing plans.`;
      }
    }

    checks.push({
      agent,
      apiEquivalentMonthlyUsd: monthly,
      windowDays,
      suggestedPlan: detectedKnown ?? suggested,
      monthlySavingsVsApiUsd: effectiveSavings,
      valueMultiple,
      detectedPlan: detected,
      upgradeHint,
      headline
    });
  }
  return checks.sort((left, right) => right.apiEquivalentMonthlyUsd - left.apiEquivalentMonthlyUsd);
}

function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * Display rounding for the plan-price multiple. One decimal at >= 1x
 * ("~24.3x" stays as-is); TWO decimals below 1x so a small-but-real
 * multiple never renders "~0x" (founder's live case: $9.63/mo vs a
 * $200/mo plan printed "~0x" — now "~0.05x"), floored at 0.01 for any
 * positive ratio so the tilde always marks a nonzero approximation.
 */
function roundValueMultiple(ratio: number): number {
  if (ratio >= 1) return Math.round(ratio * 10) / 10;
  return Math.max(0.01, Math.round(ratio * 100) / 100);
}
