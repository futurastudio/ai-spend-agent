import { describe, expect, it } from "vitest";
import { analyzeSpend } from "./analyze.js";
import { generateSpendInsights } from "./insights.js";
import { loadSampleUsageData } from "./sampleData.js";


describe("analyst insights", () => {
  it("produces ranked analyst-grade findings with evidence and verification guidance", async () => {
    const records = await loadSampleUsageData();
    const summary = analyzeSpend(records);
    const insights = generateSpendInsights(records, summary);

    expect(insights).toHaveLength(4);
    expect(insights[0]?.id).toMatch(/^spike-2026-05-19-/);
    expect(insights[1]?.id).toMatch(/^spike-2026-05-19-/);
    expect(insights[0]?.id).not.toBe(insights[1]?.id);
    expect(insights.slice(2).map((insight) => insight.id)).toEqual([
      "agent-spend-concentration-agent-analyst",
      "context-bloat-research_summary"
    ]);

    expect(insights[0]).toMatchObject({
      kind: "spike_explanation",
      severity: "critical",
      title: "Cost/value evidence spike on 2026-05-19 needs owner review",
      confidence: "estimated",
      estimatedImpactUsd: 32.9,
      affectedClients: ["client-beta"],
      affectedProjects: ["project-research"],
      affectedAgents: ["agent-analyst"],
      affectedModels: ["gpt-5.5"],
      recommendedAction: expect.stringContaining("provider-cohort records"),
      verificationNeeded: expect.stringContaining("same call-level schema")
    });
    expect(insights[0].summary).toContain("5.1x");
    expect(insights[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Previous cohort value", value: "$8.10" }),
        expect.objectContaining({ label: "Current cohort value", value: "$41.00" }),
        expect.objectContaining({ label: "Ownership lead", value: "agent-analyst" })
      ])
    );

    expect(insights.find((insight) => insight.id === "agent-spend-concentration-agent-analyst")).toMatchObject({
      kind: "optimization_opportunity",
      estimatedImpactUsd: 0
    });
    expect(insights.find((insight) => insight.id === "context-bloat-research_summary")).toMatchObject({
      estimatedImpactUsd: 0,
      recommendedAction: expect.stringContaining("matched before/after")
    });
    expect(JSON.stringify(insights)).not.toContain("agent_runaway");

    expect(insights.every((insight) => insight.evidence.length >= 3)).toBe(true);
    expect(insights.every((insight) => insight.recommendedAction.length > 30)).toBe(true);
  });

  it("attaches insights to the spend summary as the shared intelligence layer", async () => {
    const summary = analyzeSpend(await loadSampleUsageData());

    expect(summary.insights).toHaveLength(4);
    expect(summary.insights[0]).toMatchObject({
      severity: "critical",
      kind: "spike_explanation"
    });
    expect(summary.insights[0]?.id).toMatch(/^spike-2026-05-19-/);
    expect(summary.insights[1]?.id).toMatch(/^spike-2026-05-19-/);
    expect(summary.insights[0]?.id).not.toBe(summary.insights[1]?.id);
  });
});
