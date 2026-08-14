import { describe, expect, it } from "vitest";
import { analyzeSpend, detectSpendSpikes, generateRecommendations } from "./analyze.js";
import { loadSampleUsageData } from "./sampleData.js";

describe("spend analysis", () => {
  it("summarizes spend by core dimensions", async () => {
    const summary = analyzeSpend(await loadSampleUsageData());

    expect(summary.totalUsd).toBe(87);
    expect(summary.recordCount).toBe(9);
    expect(summary.confidence).toBe("detected_unverified");
    expect(summary.confidenceBreakdown).toEqual({
      verified: 0,
      estimated: 56.6,
      detected_unverified: 30.4,
      missing: 0
    });
    expect(summary.bySource.map((entry) => [entry.key, entry.amountUsd])).toEqual([
      ["openai-sample", 56.6],
      ["anthropic-sample", 30.4]
    ]);
    expect(summary.byClient[0]).toMatchObject({
      key: "client-beta",
      amountUsd: 64
    });
    expect(summary.byAgent[0]).toMatchObject({
      key: "agent-analyst",
      amountUsd: 64
    });
    expect(summary.byUser[0]).toMatchObject({
      key: "user-research-lead",
      amountUsd: 64
    });
    expect(summary.byWorkspace[0]).toMatchObject({
      key: "workspace-beta",
      amountUsd: 64
    });
    expect(summary.byApiKey[0]).toMatchObject({
      key: "key-research",
      amountUsd: 47.1
    });
    expect(summary.byApiKey[1]).toMatchObject({
      key: "anthropic-key-research",
      amountUsd: 16.9
    });
    expect(summary.workflowWatch[0]).toMatchObject({
      id: "workflow-client-beta-project-research-research-summary",
      clientId: "client-beta",
      projectId: "project-research",
      workflowKey: "research_summary",
      agentId: "agent-analyst",
      amountUsd: 64,
      estimatedSavingsUsd: 0,
      estimatedMarginRiskUsd: 0,
      suggestedOptimization: expect.stringContaining("define one reversible candidate")
    });
    expect(summary.workflowWatch[0]?.shareOfSpend).toBeCloseTo(0.7356, 4);
  });

  it("detects day-over-day spikes from sample timestamps", async () => {
    const anomalies = detectSpendSpikes(await loadSampleUsageData());

    expect(anomalies).toHaveLength(2);
    expect(anomalies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "day_over_day_spike",
        key: "2026-05-19",
        previousAmountUsd: 8.1,
        currentAmountUsd: 41,
        confidence: "estimated"
      }),
      expect.objectContaining({
        kind: "day_over_day_spike",
        key: "2026-05-19",
        previousAmountUsd: 5.5,
        currentAmountUsd: 16.9,
        confidence: "detected_unverified"
      })
    ]));
  });

  it("generates deterministic recommendations", async () => {
    const recommendations = generateRecommendations(await loadSampleUsageData());

    expect(recommendations.map((recommendation) => recommendation.id)).toEqual([
      "model-downgrade",
      "prompt-context-trimming",
      "caching",
      "agent-caps",
      "batching"
    ]);
    expect(recommendations[0]).toMatchObject({
      id: "model-downgrade",
      priority: "high",
      estimatedImpactUsd: 0
    });
    expect(recommendations.find((recommendation) => recommendation.id === "prompt-context-trimming")?.estimatedImpactUsd).toBe(0);
    expect(recommendations.find((recommendation) => recommendation.id === "agent-caps")?.estimatedImpactUsd).toBe(0);
    expect(recommendations.find((recommendation) => recommendation.id === "caching")?.estimatedImpactUsd).toBe(41);
    expect(recommendations.find((recommendation) => recommendation.id === "batching")?.estimatedImpactUsd).toBe(32);
    expect(recommendations.every((recommendation) => recommendation.whyItMatters.length > 20)).toBe(true);
    expect(recommendations.every((recommendation) => recommendation.nextAction.length > 20)).toBe(true);
  });

  it("preserves confidence labels in summary output", async () => {
    const summary = analyzeSpend(await loadSampleUsageData());

    expect(summary.byModel.find((entry) => entry.key === "claude-fable-5")?.confidence).toBe(
      "detected_unverified"
    );
    expect(summary.recommendations.every((recommendation) => recommendation.confidence)).toBe(true);
  });

  it("keeps local transcript aggregates out of fixed-ratio decision output", () => {
    const summary = analyzeSpend([{
      id: "tiny-local-call",
      timestamp: "2026-07-28T00:00:00.000Z",
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: "anthropic",
        confidence: "estimated",
        observedFrom: "test transcript"
      },
      model: "claude-opus-4-8",
      inputTokens: 1_000,
      outputTokens: 100,
      amountUsd: 0.0075,
      costConfidence: "estimated",
      projectId: "mcp-project",
      agentId: "claude-code",
      providerCostType: "local_agent_logs",
      operation: "claude-code sessions",
      usageGranularity: "daily_aggregate"
    }]);

    expect(summary.totalUsd).toBe(0.0075);
    expect(summary.byProject[0]).toMatchObject({ key: "mcp-project", amountUsd: 0.0075 });
    expect(summary.workflowWatch).toEqual([]);
    expect(summary.recommendations).toEqual([]);
    expect(summary.insights).toEqual([]);
    expect(summary.anomalies).toEqual([]);
  });

  it("uses provider records only for decision output in a mixed evidence set", () => {
    const local: Parameters<typeof analyzeSpend>[0][number] = {
      id: "local-heavy",
      timestamp: "2026-07-28T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated", observedFrom: "test" },
      model: "gpt-5.5",
      inputTokens: 200_000,
      outputTokens: 100,
      amountUsd: 100,
      costConfidence: "estimated",
      agentId: "codex",
      operation: "research_summary",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    };
    const provider = {
      ...local,
      id: "provider-call",
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified" as const, observedFrom: "provider API" },
      amountUsd: 30,
      costConfidence: "verified" as const,
      agentId: "provider-agent",
      providerCostType: "billed_cost",
      usageGranularity: "call" as const
    };

    const summary = analyzeSpend([local, provider]);

    expect(summary.totalUsd).toBe(130);
    expect(summary.workflowWatch).toHaveLength(1);
    expect(summary.workflowWatch[0]?.amountUsd).toBe(30);
    expect(summary.recommendations.every((recommendation) => recommendation.estimatedImpactUsd <= 30)).toBe(true);
    expect(JSON.stringify(summary.insights)).not.toContain("codex");
  });

  it("keeps provider billing, usage, seat, and user aggregates out of modeled decisions", () => {
    const aggregate = (id: string, usageGranularity: "billing_bucket" | "usage_bucket" | "seat" | "user_aggregate") => ({
      id,
      timestamp: "2026-07-28T00:00:00.000Z",
      source: { id: "provider-aggregate", name: "Provider aggregate", provider: "openai", confidence: "verified" as const, observedFrom: "provider API" },
      model: "gpt-5.5",
      inputTokens: 200_000,
      outputTokens: 100,
      amountUsd: 30,
      costConfidence: "verified" as const,
      agentId: "provider-agent",
      operation: "research_summary",
      providerCostType: "billed_cost",
      usageGranularity
    });
    const summary = analyzeSpend([
      aggregate("billing", "billing_bucket"),
      aggregate("usage", "usage_bucket"),
      aggregate("seat", "seat"),
      aggregate("user", "user_aggregate")
    ]);

    expect(summary.totalUsd).toBe(120);
    expect(summary.workflowWatch).toHaveLength(1);
    expect(summary.workflowWatch[0]).toMatchObject({
      estimatedSavingsUsd: 0,
      estimatedMarginRiskUsd: 0,
      suggestedOptimization: expect.stringContaining("collect call-level provenance")
    });
    expect(summary.recommendations).toEqual([]);
    expect(summary.insights).toHaveLength(1);
    expect(summary.insights[0]).toMatchObject({
      id: "agent-spend-concentration-provider-agent",
      estimatedImpactUsd: 0,
      recommendedAction: expect.stringContaining("reconcile the spend")
    });
    expect(summary.insights.some((insight) => insight.kind === "agent_runaway")).toBe(false);
  });

  it("never treats local aggregate observation days as spend spikes", () => {
    const localRecord = (id: string, timestamp: string, amountUsd: number) => ({
      id,
      timestamp,
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated" as const, observedFrom: "test" },
      model: "gpt-5.5",
      inputTokens: 200_000,
      outputTokens: 100,
      amountUsd,
      costConfidence: "estimated" as const,
      agentId: "codex",
      projectId: "agent-finops",
      operation: "codex sessions",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate" as const
    });

    const summary = analyzeSpend([
      localRecord("local-day-1", "2026-07-27T00:00:00.000Z", 1),
      localRecord("local-day-2", "2026-07-28T00:00:00.000Z", 500)
    ]);

    expect(summary.totalUsd).toBe(501);
    expect(summary.anomalies).toEqual([]);
    expect(detectSpendSpikes([
      localRecord("direct-day-1", "2026-07-27T00:00:00.000Z", 1),
      localRecord("direct-day-2", "2026-07-28T00:00:00.000Z", 500)
    ])).toEqual([]);
  });

  it("does not manufacture spikes across provider shapes, missing provenance, or non-adjacent days", () => {
    const row = (overrides: Record<string, unknown>) => ({
      id: "row",
      timestamp: "2026-07-27T00:00:00.000Z",
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified" as const, observedFrom: "API" },
      model: "billing",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 10,
      costConfidence: "verified" as const,
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket" as const,
      ...overrides
    });

    expect(detectSpendSpikes([
      row({ id: "openai-day-1" }),
      row({
        id: "copilot-day-2",
        timestamp: "2026-07-28T00:00:00.000Z",
        source: { id: "copilot-seats", name: "Copilot seats", provider: "github-copilot", confidence: "estimated", observedFrom: "API" },
        providerCostType: "copilot_seat_reconciliation",
        usageGranularity: "seat",
        amountUsd: 100,
        costConfidence: "estimated"
      }),
      row({ id: "openai-day-3", timestamp: "2026-07-29T00:00:00.000Z", amountUsd: 100 }),
      row({ id: "unknown-day-1", source: { id: "unknown", name: "Unknown", provider: "openai", confidence: "verified", observedFrom: "API" }, usageGranularity: undefined }),
      row({ id: "unknown-day-2", source: { id: "unknown", name: "Unknown", provider: "openai", confidence: "verified", observedFrom: "API" }, usageGranularity: undefined, timestamp: "2026-07-28T00:00:00.000Z", amountUsd: 100 })
    ] as Parameters<typeof detectSpendSpikes>[0])).toEqual([]);
  });

  it("uses both adjacent periods for anomaly confidence and ignores missing-cost rows", () => {
    const base = {
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified" as const, observedFrom: "API" },
      model: "billing",
      inputTokens: 0,
      outputTokens: 0,
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket" as const
    };
    const anomalies = detectSpendSpikes([
      { ...base, id: "day-1", timestamp: "2026-07-27T00:00:00.000Z", amountUsd: 10, costConfidence: "estimated" as const },
      { ...base, id: "day-2", timestamp: "2026-07-28T00:00:00.000Z", amountUsd: 30, costConfidence: "verified" as const },
      { ...base, id: "missing", timestamp: "2026-07-27T12:00:00.000Z", amountUsd: null, costConfidence: "missing" as const }
    ]);

    expect(anomalies).toEqual([expect.objectContaining({
      previousAmountUsd: 10,
      currentAmountUsd: 30,
      confidence: "estimated"
    })]);
  });

  it("retains provider anomalies without local aggregates inflating them", () => {
    const base = {
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified" as const, observedFrom: "provider API" },
      model: "gpt-5.5",
      inputTokens: 1_000,
      outputTokens: 100,
      costConfidence: "verified" as const,
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket" as const
    };
    const localBase = {
      ...base,
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated" as const, observedFrom: "test" },
      costConfidence: "estimated" as const,
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate" as const
    };
    const summary = analyzeSpend([
      { ...base, id: "provider-day-1", timestamp: "2026-07-27T00:00:00.000Z", amountUsd: 10 },
      { ...base, id: "provider-day-2", timestamp: "2026-07-28T00:00:00.000Z", amountUsd: 30 },
      { ...localBase, id: "local-day-1", timestamp: "2026-07-27T00:00:00.000Z", amountUsd: 1 },
      { ...localBase, id: "local-day-2", timestamp: "2026-07-28T00:00:00.000Z", amountUsd: 500 }
    ]);

    expect(summary.totalUsd).toBe(541);
    expect(summary.anomalies).toEqual([expect.objectContaining({
      previousAmountUsd: 10,
      currentAmountUsd: 30,
      confidence: "verified"
    })]);
  });
});
