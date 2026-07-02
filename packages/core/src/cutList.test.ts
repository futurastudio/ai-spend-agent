import { describe, expect, it } from "vitest";
import { generateCutList, totalEstimatedMonthlySavingsUsd, buildRecommendedPlan } from "./cutList.js";
import { loadSampleUsageData } from "./sampleData.js";
import type { UsageRecord } from "./schema.js";

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: overrides.id ?? "rec-1",
    timestamp: overrides.timestamp ?? "2026-05-17T10:00:00.000Z",
    source: overrides.source ?? {
      id: "openai-sample",
      name: "OpenAI sample",
      provider: "openai",
      confidence: "estimated",
      observedFrom: "sample_csv"
    },
    model: overrides.model ?? "gpt-4.1",
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 200,
    amountUsd: overrides.amountUsd ?? 10,
    costConfidence: overrides.costConfidence ?? "estimated",
    clientId: overrides.clientId,
    projectId: overrides.projectId,
    agentId: overrides.agentId,
    userId: overrides.userId,
    workspaceId: overrides.workspaceId,
    apiKeyId: overrides.apiKeyId,
    operation: overrides.operation,
    providerCostType: overrides.providerCostType
  };
}

describe("generateCutList", () => {
  it("produces a model-downgrade action for downgrade-safe operations", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20 }),
      record({ id: "b", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20 })
    ];
    const actions = generateCutList(records);
    const downgrade = actions.find((action) => action.kind === "model_downgrade");
    expect(downgrade).toBeDefined();
    expect(downgrade!.title).toContain("gpt-4.1-mini");
    expect(downgrade!.recordCount).toBe(2);
    // Same-day window: 40 * 0.8 saved, projected to 30 days.
    expect(downgrade!.estimatedMonthlySavingsUsd).toBeGreaterThan(0);
  });

  it("does not downgrade clearly high-stakes operations", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "legal_review", amountUsd: 40 })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "model_downgrade")).toBeUndefined();
  });

  it("flags oversized context as a trim action", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "research", inputTokens: 180_000, amountUsd: 40 })
    ];
    const actions = generateCutList(records);
    expect(actions.some((action) => action.kind === "context_trim")).toBe(true);
  });

  it("sorts actions by descending monthly savings and sums them", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 50 }),
      record({ id: "b", model: "claude-sonnet-4", operation: "reply_draft", amountUsd: 8, source: { id: "anthropic-sample", name: "Anthropic", provider: "anthropic", confidence: "detected_unverified", observedFrom: "sample_csv" }, costConfidence: "detected_unverified" })
    ];
    const actions = generateCutList(records);
    for (let i = 1; i < actions.length; i += 1) {
      expect(actions[i - 1]!.estimatedMonthlySavingsUsd).toBeGreaterThanOrEqual(actions[i]!.estimatedMonthlySavingsUsd);
    }
    expect(totalEstimatedMonthlySavingsUsd(actions)).toBeGreaterThan(0);
  });

  it("flags repeated offline-looking operations for the Batch API", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12 }),
      record({ id: "b", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12 }),
      record({ id: "c", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12 })
    ];
    const actions = generateCutList(records);
    const batch = actions.find((action) => action.kind === "batch");
    expect(batch).toBeDefined();
    expect(batch!.title).toContain("Batch API");
    expect(batch!.recordCount).toBe(3);
    // Flat 50% discount on the $36 window, projected to 30 days.
    expect(batch!.estimatedMonthlySavingsUsd).toBe(540);
  });

  it("does not suggest batching interactive operations", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12 }),
      record({ id: "b", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12 }),
      record({ id: "c", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12 })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "batch")).toBeUndefined();
  });

  it("returns deterministic, non-empty actions for the bundled sample", async () => {
    const records = await loadSampleUsageData();
    const actions = generateCutList(records);
    expect(actions.length).toBeGreaterThan(0);
    // Every action must carry a concrete, copy-pasteable instruction and $ value.
    for (const action of actions) {
      expect(action.action.length).toBeGreaterThan(10);
      expect(action.estimatedMonthlySavingsUsd).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe("buildRecommendedPlan", () => {
  it("deduplicates overlapping savings so the headline can't exceed the spend it draws from", () => {
    // One operation that triggers several overlapping cut actions on the SAME
    // records: downgrade-safe + >=100k input (trim) + repeated (cache) +
    // batch-safe — all on the same 4 records, same day.
    const records = Array.from({ length: 4 }, (_unused, index) =>
      record({
        id: `r${index}`,
        model: "gpt-4.1",
        operation: "research_summary",
        amountUsd: 30,
        inputTokens: 150_000,
        timestamp: "2026-05-17T10:00:00.000Z"
      })
    );
    const projectedMonthlySpend = 4 * 30 * 30; // $120 window, 1-day window, ×30

    const actions = generateCutList(records);
    expect(actions.length).toBeGreaterThan(1); // overlapping opportunities exist

    const rawSum = totalEstimatedMonthlySavingsUsd(actions);
    const plan = buildRecommendedPlan(actions);

    expect(plan.savingsMath).toBe("deduplicated");
    // Overlap is dropped from the recommended plan, so it's strictly smaller
    // than the naive sum of every opportunity.
    expect(plan.additional.length).toBeGreaterThan(0);
    expect(plan.recommendedSavingsUsd).toBeLessThan(rawSum);
    // The defensible headline can never exceed the projected spend it draws from.
    expect(plan.recommendedSavingsUsd).toBeLessThanOrEqual(projectedMonthlySpend);

    // Recommended actions cover disjoint record sets.
    const claimed = new Set<string>();
    for (const action of plan.recommended) {
      for (const id of action.recordIds) {
        expect(claimed.has(id)).toBe(false);
        claimed.add(id);
      }
    }
  });

  it("treats fully non-overlapping actions as all-recommended, none additional", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20 }),
      record({ id: "b", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20 })
    ];
    const plan = buildRecommendedPlan(generateCutList(records));
    expect(plan.additional).toHaveLength(0);
    expect(plan.recommendedSavingsUsd).toBe(totalEstimatedMonthlySavingsUsd(plan.recommended));
  });

  it("never recommends a result cache for local agent session aggregates", () => {
    // "claude-code sessions" records are day-level aggregates of interactive
    // sessions, not repeated identical calls — a result cache is not a lever.
    const records = [
      record({ id: "a", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 80 }),
      record({ id: "b", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 90 }),
      record({ id: "c", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 70 }),
      record({ id: "d", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 60 })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "cache")).toBeUndefined();
  });

  it("words context-trim for session aggregates in session-days with coding-agent levers", () => {
    const records = [
      record({ id: "a", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", inputTokens: 250_000, amountUsd: 80 }),
      record({ id: "b", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", inputTokens: 180_000, amountUsd: 90 })
    ];
    const actions = generateCutList(records);
    const trim = actions.find((action) => action.kind === "context_trim");
    expect(trim).toBeDefined();
    expect(trim!.recordUnit).toBe("session-days");
    expect(trim!.action).toContain("session-day");
    expect(trim!.action).toContain("dead context");
    expect(trim!.action).not.toContain("large claude-code sessions call");
  });
});
