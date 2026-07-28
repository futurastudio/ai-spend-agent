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
      verified: 8.1,
      estimated: 48.5,
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
      // 64 × 0.2 (documented workflowSavings planning ratio in analyze.ts)
      estimatedSavingsUsd: 12.8,
      suggestedOptimization: expect.stringContaining("Cap context")
    });
    expect(summary.workflowWatch[0]?.shareOfSpend).toBeCloseTo(0.7356, 4);
  });

  it("detects day-over-day spikes from sample timestamps", async () => {
    const anomalies = detectSpendSpikes(await loadSampleUsageData());

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      kind: "day_over_day_spike",
      key: "2026-05-19",
      previousAmountUsd: 13.6,
      currentAmountUsd: 57.9,
      confidence: "detected_unverified"
    });
  });

  it("generates deterministic recommendations", async () => {
    const recommendations = generateRecommendations(await loadSampleUsageData());

    expect(recommendations.map((recommendation) => recommendation.id)).toEqual([
      "model-downgrade",
      "prompt-context-trimming",
      "caching",
      "agent-caps",
      "batching",
      "routing"
    ]);
    expect(recommendations[0]).toMatchObject({
      id: "model-downgrade",
      priority: "high",
      // 51.9 × 0.3 (documented modelDowngrade planning ratio in analyze.ts)
      estimatedImpactUsd: 15.57
    });
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

  it("keeps workflow share within one when a tiny total rounds up for display", () => {
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
      operation: "claude-code sessions"
    }]);

    expect(summary.workflowWatch[0]?.amountUsd).toBe(0.01);
    expect(summary.workflowWatch[0]?.shareOfSpend).toBe(1);
  });
});
