import type { DetectedPlan } from "./planDetection.js";
import type { UsageRecord } from "./schema.js";

/**
 * Plan-price math: compares API-equivalent usage (from local agent logs)
 * against published subscription plan prices — the arbitrage check no
 * provider will ever show, because it's the math that tells you to pay
 * them less.
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
  /** Rough API-equivalent monthly usage this plan comfortably covers. */
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
  /** Cheapest plan that comfortably covers the projected usage (if any). */
  suggestedPlan?: SubscriptionPlan;
  /** apiEquivalentMonthlyUsd - plan price, when positive. */
  monthlySavingsVsApiUsd?: number;
  /**
   * API-equivalent usage ÷ plan price — "you're getting N× the plan price in
   * usage". The number a subscription user actually wants: am I getting my
   * money's worth? Present only when a plan covers the usage.
   */
  valueMultiple?: number;
  /** The plan actually detected on this machine (or --plan override), if any. */
  detectedPlan?: DetectedPlan;
  /** Set when projected usage exceeds what the detected tier typically covers. */
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
 * When `detectedPlans` carries a locally detected plan (or --plan override)
 * for an agent, the check speaks in facts ("you're on Claude Max 5x") instead
 * of guesses ("Max 20x likely covers this") — and warns when projected usage
 * exceeds what the detected tier typically covers.
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
      // FACT mode: we know the user's actual plan from local agent config.
      valueMultiple = Math.round((monthly / detectedKnown.monthlyUsd) * 10) / 10;
      const savingsVsApi = roundMoney(monthly - detectedKnown.monthlyUsd);
      effectiveSavings = savingsVsApi > 0 ? savingsVsApi : undefined;
      headline =
        `${agent}: ~$${monthly.toFixed(2)}/mo at API rates (${basis}) — you're on ${detectedKnown.name} ` +
        `($${detectedKnown.monthlyUsd}/mo, detected locally): ~${valueMultiple}× the plan price in usage` +
        (effectiveSavings ? `, ~$${effectiveSavings.toFixed(2)}/mo cheaper than paying per token.` : `.`);
      if (monthly > detectedKnown.coversUpToUsd) {
        const nextTier = subscriptionPlans.find(
          (plan) => plan.agent === agent && plan.coversUpToUsd > detectedKnown.coversUpToUsd
        );
        upgradeHint = nextTier
          ? `usage runs past what ${detectedKnown.name} typically covers (~$${detectedKnown.coversUpToUsd}/mo) — if you're hitting rate limits, ${nextTier.name} ($${nextTier.monthlyUsd}/mo) is the next tier; trimming context (below) buys headroom without upgrading.`
          : `usage runs past what ${detectedKnown.name} typically covers (~$${detectedKnown.coversUpToUsd}/mo) — trimming context (below) is the main headroom lever.`;
      }
    } else if (detected) {
      // Detected a plan we can't price (e.g. an unrecognized tier): state the
      // fact, then fall back to suggestion math without pretending certainty.
      headline =
        `${agent}: ~$${monthly.toFixed(2)}/mo at API rates (${basis}) — you're on ${detected.planLabel} ` +
        `(detected locally; price not in our table)` +
        (suggested ? `; closest known plan: ${suggested.name} ($${suggested.monthlyUsd}/mo).` : `.`);
    } else {
      const covered = suggested && typeof savings === "number" && savings > 0;
      valueMultiple = covered ? Math.round((monthly / suggested.monthlyUsd) * 10) / 10 : undefined;
      effectiveSavings = covered ? savings : undefined;
      if (!suggested) {
        headline = `${agent}: ~$${monthly.toFixed(2)}/mo at API rates (${basis}).`;
      } else if (covered) {
        headline = `${agent}: ~$${monthly.toFixed(2)}/mo at API rates (${basis}) — ${suggested.name} ($${suggested.monthlyUsd}/mo) likely covers this. You're getting ~${valueMultiple}× the plan price in usage, ~$${savings.toFixed(2)}/mo cheaper than paying per token.`;
      } else {
        headline = `${agent}: ~$${monthly.toFixed(2)}/mo at API rates (${basis}) — within ${suggested.name} ($${suggested.monthlyUsd}/mo); pay-as-you-go API could be cheaper if you drop the subscription.`;
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
  return Math.round(value * 100) / 100;
}
