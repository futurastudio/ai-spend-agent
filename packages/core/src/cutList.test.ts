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
    providerCostType: overrides.providerCostType,
    workloadSemantics: overrides.workloadSemantics,
    // This helper models one illustrative workload call unless a test
    // explicitly asks for an aggregate evidence shape.
    usageGranularity: overrides.usageGranularity ?? "call"
  };
}

describe("generateCutList", () => {
  it("produces a model-downgrade action for downgrade-safe operations", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20, workloadSemantics: { downgradeSafe: true } }),
      record({ id: "b", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20, workloadSemantics: { downgradeSafe: true } })
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
      record({ id: "a", model: "gpt-4.1", operation: "legal_review", amountUsd: 40, workloadSemantics: { downgradeSafe: true } })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "model_downgrade")).toBeUndefined();
  });

  it("flags oversized context as a trim action", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "research", inputTokens: 180_000, amountUsd: 40 })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "context_trim")).toMatchObject({
      impactBasis: "observed_value_no_counterfactual",
      estimatedMonthlySavingsUsd: 0,
      title: expect.stringContaining("Inspect")
    });
  });

  it("never turns unpriced or non-action-capable local evidence into a $0 recommendation", () => {
    const unpricedClaude: UsageRecord = {
      ...record({
        id: "unpriced-claude",
        inputTokens: 180_000,
        agentId: "claude-code",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate"
      }),
      amountUsd: null,
      costConfidence: "missing"
    };
    const pricedGemini = record({
      id: "priced-gemini",
      inputTokens: 180_000,
      agentId: "gemini-cli",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate",
      amountUsd: 12
    });

    expect(generateCutList([unpricedClaude, pricedGemini])).toEqual([]);
  });

  it("sorts actions by descending monthly savings and sums them", () => {
    const records = [
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 50, workloadSemantics: { downgradeSafe: true } }),
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
      record({ id: "a", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12, workloadSemantics: { batchEligible: true } }),
      record({ id: "b", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12, workloadSemantics: { batchEligible: true } }),
      record({ id: "c", model: "gpt-4.1", operation: "nightly_embed", amountUsd: 12, workloadSemantics: { batchEligible: true } })
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
      record({ id: "a", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12, workloadSemantics: { batchEligible: true } }),
      record({ id: "b", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12, workloadSemantics: { batchEligible: true } }),
      record({ id: "c", model: "gpt-4.1", operation: "reply_draft", amountUsd: 12, workloadSemantics: { batchEligible: true } })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "batch")).toBeUndefined();
  });

  it("returns deterministic, non-empty actions for the bundled sample", async () => {
    const records = await loadSampleUsageData();
    const actions = generateCutList(records);
    expect(actions.length).toBeGreaterThan(0);
    // Every action must carry a concrete instruction. Observed-only context
    // exposure stays at $0 until a matched counterfactual exists.
    for (const action of actions) {
      expect(action.action.length).toBeGreaterThan(10);
      if (action.impactBasis === "modeled_savings") {
        expect(action.estimatedMonthlySavingsUsd).toBeGreaterThanOrEqual(0.5);
      } else {
        expect(action.estimatedMonthlySavingsUsd).toBe(0);
      }
    }
  });

  it("never models cuts from OpenAI buckets, Anthropic daily aggregates, Copilot seats, or Cursor user spend", () => {
    const records = [
      record({ id: "openai-cost", source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified", observedFrom: "Costs API" }, providerCostType: "openai_cost", operation: "gpt-5.5 input tokens", inputTokens: 0, amountUsd: 50, usageGranularity: "billing_bucket" }),
      record({ id: "openai-usage", source: { id: "openai-usage", name: "OpenAI usage", provider: "openai", confidence: "verified", observedFrom: "Usage API" }, providerCostType: "openai_usage_evidence", operation: "OpenAI completions usage evidence", inputTokens: 180_000, amountUsd: 50, usageGranularity: "usage_bucket" }),
      record({ id: "anthropic-day", source: { id: "anthropic-usage", name: "Claude Code Usage", provider: "anthropic", confidence: "estimated", observedFrom: "Usage report" }, providerCostType: "anthropic_claude_code_usage", operation: "Claude Code sessions: 8", inputTokens: 180_000, amountUsd: 50, usageGranularity: "daily_aggregate" }),
      record({ id: "anthropic-cost", source: { id: "anthropic-cost", name: "Anthropic cost", provider: "anthropic", confidence: "verified", observedFrom: "Cost report" }, providerCostType: "tokens", operation: "Claude output tokens", inputTokens: 0, amountUsd: 50, usageGranularity: "billing_bucket" }),
      record({ id: "copilot-seat", source: { id: "copilot-seats", name: "Copilot seats", provider: "github-copilot", confidence: "estimated", observedFrom: "Seats API" }, providerCostType: "copilot_seat_reconciliation", operation: "GitHub Copilot business seat", amountUsd: 19, usageGranularity: "seat" }),
      record({ id: "cursor-user", source: { id: "cursor-spend", name: "Cursor spend", provider: "cursor", confidence: "estimated", observedFrom: "Admin API" }, providerCostType: "cursor_spend", operation: "Cursor team spend", amountUsd: 30, usageGranularity: "user_aggregate" })
    ];

    expect(generateCutList(records)).toEqual([]);
  });

  it("does not infer downgrade, cache, or Batch semantics from an operation label", () => {
    const records = [10, 20, 30].map((amountUsd, index) => record({
      id: `label-${index}`,
      model: "gpt-4.1",
      operation: "nightly_research_summary",
      amountUsd
    }));
    expect(generateCutList(records)).toEqual([]);
  });

  it("models cache savings from subsequent same-fingerprint costs, not a flat percentage", () => {
    const records = [10, 20, 30].map((amountUsd, index) => record({
      id: `cache-${index}`,
      timestamp: `2026-05-17T1${index}:00:00.000Z`,
      operation: "research_summary",
      amountUsd,
      workloadSemantics: { stableInputFingerprint: "same-input-v1" }
    }));
    const cache = generateCutList(records).find((action) => action.kind === "cache");
    expect(cache?.estimatedMonthlySavingsUsd).toBe(1_500);
    expect(cache?.action).toContain("2 subsequent calls");
  });

  it("does not apply OpenAI/Anthropic Batch pricing to an unknown provider", () => {
    const records = ["a", "b", "c"].map((id) => record({
      id,
      source: { id: "other", name: "Other", provider: "other-provider", confidence: "verified", observedFrom: "API" },
      operation: "nightly_summary",
      workloadSemantics: { batchEligible: true }
    }));
    expect(generateCutList(records).some((action) => action.kind === "batch")).toBe(false);
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
        timestamp: "2026-05-17T10:00:00.000Z",
        workloadSemantics: {
          downgradeSafe: true,
          batchEligible: true,
          stableInputFingerprint: "research-summary-v1"
        }
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
      record({ id: "a", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20, workloadSemantics: { downgradeSafe: true } }),
      record({ id: "b", model: "gpt-4.1", operation: "ticket_triage", amountUsd: 20, workloadSemantics: { downgradeSafe: true } })
    ];
    const plan = buildRecommendedPlan(generateCutList(records));
    expect(plan.additional).toHaveLength(0);
    expect(plan.recommendedSavingsUsd).toBe(totalEstimatedMonthlySavingsUsd(plan.recommended));
  });

  it("never recommends a result cache for local agent session aggregates", () => {
    // "claude-code sessions" records are day-level aggregates of interactive
    // sessions, not repeated identical calls — a result cache is not a lever.
    const records = [
      record({ id: "a", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 80, usageGranularity: "daily_aggregate" }),
      record({ id: "b", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 90, usageGranularity: "daily_aggregate" }),
      record({ id: "c", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 70, usageGranularity: "daily_aggregate" }),
      record({ id: "d", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", amountUsd: 60, usageGranularity: "daily_aggregate" })
    ];
    const actions = generateCutList(records);
    expect(actions.find((action) => action.kind === "cache")).toBeUndefined();
  });

  it("labels local daily aggregates as observed exposure without inventing savings", () => {
    const records = [
      record({ id: "a", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", inputTokens: 250_000, amountUsd: 80, usageGranularity: "daily_aggregate" }),
      record({ id: "b", model: "claude-fable-5", operation: "claude-code sessions", providerCostType: "local_agent_logs", inputTokens: 180_000, amountUsd: 90, usageGranularity: "daily_aggregate" })
    ];
    const actions = generateCutList(records);
    const trim = actions.find((action) => action.kind === "context_trim");
    expect(trim).toBeDefined();
    expect(trim!.recordUnit).toBe("daily-aggregates");
    expect(trim!.impactBasis).toBe("observed_value_no_counterfactual");
    expect(trim!.estimatedMonthlySavingsUsd).toBe(0);
    expect(trim!.title).toContain("Investigate cumulative context");
    expect(trim!.action).toContain("day + agent + model + project aggregate");
    expect(trim!.action).toContain("Inspect per-session context");
    expect(trim!.action).not.toContain("large claude-code sessions call");
  });

  it("categorically excludes local aggregates from downgrade, cache, and batch savings", () => {
    const records = [
      record({ id: "a", model: "gpt-5.5", operation: "research_summary", providerCostType: "local_agent_logs", inputTokens: 150_000, amountUsd: 80, usageGranularity: "daily_aggregate" }),
      record({ id: "b", model: "gpt-5.5", operation: "research_summary", providerCostType: "local_agent_logs", inputTokens: 150_000, amountUsd: 70, usageGranularity: "daily_aggregate" }),
      record({ id: "c", model: "gpt-5.5", operation: "research_summary", providerCostType: "local_agent_logs", inputTokens: 150_000, amountUsd: 60, usageGranularity: "daily_aggregate" }),
      record({ id: "d", model: "gpt-5.5", providerCostType: "local_agent_logs", inputTokens: 150_000, amountUsd: 50, usageGranularity: "daily_aggregate" })
    ];

    const actions = generateCutList(records);

    expect(actions).not.toHaveLength(0);
    expect(actions.every((action) => action.kind === "context_trim")).toBe(true);
    expect(actions.every((action) => action.impactBasis === "observed_value_no_counterfactual")).toBe(true);
    expect(actions.every((action) => action.estimatedMonthlySavingsUsd === 0)).toBe(true);
  });

  it("preserves provider modeled actions without letting mixed local records inflate them", () => {
    const provider = record({ id: "provider", model: "gpt-5.5", operation: "research_summary", inputTokens: 150_000, amountUsd: 30, providerCostType: "billed_cost", usageGranularity: "call", workloadSemantics: { downgradeSafe: true } });
    const local = record({ id: "local", model: "gpt-5.5", operation: "research_summary", inputTokens: 150_000, amountUsd: 90, providerCostType: "local_agent_logs", usageGranularity: "daily_aggregate" });

    const actions = generateCutList([provider, local]);
    const modeled = actions.filter((action) => action.impactBasis === "modeled_savings");

    expect(modeled.length).toBeGreaterThan(0);
    expect(modeled.every((action) => action.recordIds.includes("provider"))).toBe(true);
    expect(modeled.every((action) => !action.recordIds.includes("local"))).toBe(true);
    expect(actions.some((action) => action.id.includes("inspect-context"))).toBe(true);
  });
});
