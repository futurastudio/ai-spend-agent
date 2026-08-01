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
  it("projects to 30 days and selects a reference plan without asserting coverage", () => {
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
    expect(check.headline).toContain("~1.5× the plan price in API-equivalent usage");
    expect(check.headline).toContain("does not prove plan coverage");
  });

  it("labels locally detected plan context and warns when usage exceeds the comparison threshold", () => {
    const detected = {
      agent: "claude-code" as const,
      provider: "anthropic" as const,
      planId: "claude-max-5x",
      planLabel: "Claude Max 5x",
      billing: "subscription" as const,
      source: "test"
    };
    // $20 over 2 days -> $300/mo, well past Max 5x's ~$250 coverage.
    const checks = computePlanChecks([
      localLogRecord({ id: "a", timestamp: "2026-06-07T00:00:00.000Z", amountUsd: 10 }),
      localLogRecord({ id: "b", timestamp: "2026-06-08T00:00:00.000Z", amountUsd: 10 })
    ], [detected]);

    const check = checks[0]!;
    // Detection pins the locally observed plan label, not a guessed tier.
    expect(check.detectedPlan?.planId).toBe("claude-max-5x");
    expect(check.suggestedPlan!.id).toBe("claude-max-5x");
    expect(check.headline).toContain("compared with Claude Max 5x");
    expect(check.headline).toContain("detected locally");
    // $300 usage / $100 plan = 3× value multiple.
    expect(check.valueMultiple).toBe(3);
    expect(check.upgradeHint).toContain("Claude Max 20x");
  });

  it("preserves a local limit signal without claiming live provider verification", () => {
    const detected = {
      agent: "claude-code" as const,
      provider: "anthropic" as const,
      planId: "claude-max-5x",
      planLabel: "Claude Max 5x",
      billing: "subscription" as const,
      limitSignal: "extra-usage credits exhausted",
      source: "test"
    };
    const checks = computePlanChecks([
      localLogRecord({ id: "a", timestamp: "2026-06-07T00:00:00.000Z", amountUsd: 10 }),
      localLogRecord({ id: "b", timestamp: "2026-06-08T00:00:00.000Z", amountUsd: 10 })
    ], [detected]);
    expect(checks[0]!.upgradeHint).toContain("extra-usage credits exhausted");
    expect(checks[0]!.upgradeHint).toContain("local metadata reports");
    expect(checks[0]!.upgradeHint).toContain("verify account limits");
  });

  it("states detected-but-unpriceable plans without inventing numbers", () => {
    const detected = {
      agent: "claude-code" as const,
      provider: "anthropic" as const,
      planLabel: "Claude Max (tier: default_claude_max_100x)",
      billing: "subscription" as const,
      source: "test"
    };
    const checks = computePlanChecks([localLogRecord({ amountUsd: 10 })], [detected]);
    expect(checks[0]!.headline).toContain("price not in our table");
    expect(checks[0]!.valueMultiple).toBeUndefined();
  });

  it("flags light usage as a comparison that requires account context", () => {
    // $0.10 on one day -> $3/mo -> within Claude Pro, no positive savings.
    const checks = computePlanChecks([localLogRecord({ amountUsd: 0.1 })]);
    expect(checks[0]!.suggestedPlan!.id).toBe("claude-pro");
    expect(checks[0]!.monthlySavingsVsApiUsd).toBeUndefined();
    expect(checks[0]!.headline).toContain("compare account benefits");
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
