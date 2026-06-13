import { describe, expect, it } from "vitest";
import { analyzeSpend } from "./analyze.js";
import { generateSpendInsights } from "./insights.js";
import { loadSampleUsageData } from "./sampleData.js";


describe("analyst insights", () => {
  it("produces ranked analyst-grade findings with evidence and verification guidance", async () => {
    const records = await loadSampleUsageData();
    const summary = analyzeSpend(records);
    const insights = generateSpendInsights(records, summary);

    expect(insights.map((insight) => insight.id)).toEqual([
      "spike-2026-05-19",
      "agent-cost-driver-agent-analyst",
      "context-bloat-research_summary"
    ]);

    expect(insights[0]).toMatchObject({
      kind: "spike_explanation",
      severity: "critical",
      title: "Spend spike on 2026-05-19 needs owner review",
      confidence: "detected_unverified",
      estimatedImpactUsd: 44.3,
      affectedClients: ["client-beta"],
      affectedProjects: ["project-research"],
      affectedAgents: ["agent-analyst"],
      affectedModels: ["gpt-5.5", "claude-fable-5"],
      recommendedAction: expect.stringContaining("agent-analyst"),
      verificationNeeded: expect.stringContaining("provider billing export")
    });
    expect(insights[0].summary).toContain("4.3x");
    expect(insights[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Previous day spend", value: "$13.60" }),
        expect.objectContaining({ label: "Current day spend", value: "$57.90" }),
        expect.objectContaining({ label: "Likely driver", value: "agent-analyst" })
      ])
    );

    expect(insights.every((insight) => insight.evidence.length >= 3)).toBe(true);
    expect(insights.every((insight) => insight.recommendedAction.length > 30)).toBe(true);
  });

  it("attaches insights to the spend summary as the shared intelligence layer", async () => {
    const summary = analyzeSpend(await loadSampleUsageData());

    expect(summary.insights).toHaveLength(3);
    expect(summary.insights[0]).toMatchObject({
      id: "spike-2026-05-19",
      severity: "critical",
      kind: "spike_explanation"
    });
  });
});
