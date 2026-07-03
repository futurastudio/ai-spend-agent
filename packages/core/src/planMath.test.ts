import { describe, expect, it } from "vitest";
import { computePlanChecks } from "./planMath.js";
import type { UsageRecord } from "./schema.js";

function localLogRecord(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: overrides.id ?? "rec-1",
    timestamp: overrides.timestamp ?? "2026-06-08T00:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: "anthropic",
      confidence: "estimated",
      observedFrom: "claude-code transcript JSONL (this machine)"
    },
    model: overrides.model ?? "claude-opus-4-8",
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 500,
    amountUsd: overrides.amountUsd === undefined ? 10 : overrides.amountUsd,
    costConfidence: overrides.costConfidence ?? "estimated",
    agentId: overrides.agentId ?? "claude-code",
    providerCostType: overrides.providerCostType ?? "local_agent_logs",
    operation: overrides.operation
  };
}

describe("computePlanChecks", () => {
  it("projects to 30 days and suggests the cheapest covering plan", () => {
    // $10/day over 2 distinct days -> $20/2d -> $300/mo -> Max 20x territory.
    const checks = computePlanChecks([
      localLogRecord({ id: "a", timestamp: "2026-06-07T00:00:00.000Z", amountUsd: 10 }),
      localLogRecord({ id: "b", timestamp: "2026-06-08T00:00:00.000Z", amountUsd: 10 })
    ]);
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.agent).toBe("claude-code");
    expect(check.apiEquivalentMonthlyUsd).toBe(300);
    expect(check.windowDays).toBe(2);
    expect(check.suggestedPlan!.id).toBe("claude-max-20x");
    expect(check.monthlySavingsVsApiUsd).toBe(100);
    expect(check.headline).toContain("Claude Max 20x");
    // The projection basis must be stated: this divides by ACTIVE days, which
    // can differ from the calendar window shown elsewhere on the readout.
    expect(check.headline).toContain("projected from 2 active days");
    // $300/mo usage on a $200 plan -> 1.5× the plan price in usage.
    expect(check.valueMultiple).toBe(1.5);
    expect(check.headline).toContain("~1.5× the plan price in usage");
  });

  it("flags light usage as possibly cheaper on pay-as-you-go", () => {
    // $0.10 on one day -> $3/mo -> within Claude Pro, no positive savings.
    const checks = computePlanChecks([localLogRecord({ amountUsd: 0.1 })]);
    expect(checks[0]!.suggestedPlan!.id).toBe("claude-pro");
    expect(checks[0]!.monthlySavingsVsApiUsd).toBeUndefined();
    expect(checks[0]!.headline).toContain("pay-as-you-go");
  });

  it("separates agents and ignores non-log records", () => {
    const checks = computePlanChecks([
      localLogRecord({ id: "a", agentId: "claude-code", amountUsd: 20 }),
      localLogRecord({ id: "b", agentId: "codex", amountUsd: 5, model: "gpt-5.1-codex" }),
      localLogRecord({ id: "c", providerCostType: "openai_cost", amountUsd: 999 })
    ]);
    expect(checks).toHaveLength(2);
    expect(checks[0]!.agent).toBe("claude-code");
    expect(checks[1]!.agent).toBe("codex");
  });

  it("returns nothing when there are no local-log records", () => {
    expect(computePlanChecks([localLogRecord({ providerCostType: "openai_cost" })])).toHaveLength(0);
  });
});
