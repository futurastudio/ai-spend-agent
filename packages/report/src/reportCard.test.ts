import { describe, expect, it } from "vitest";
import { analyzeSpend, loadSampleUsageData, type UsageRecord } from "@agent-finops/core";
import { generateReportCardSvg, generateReportCardCaption } from "./reportCard.js";

let cachedRecords: UsageRecord[] | undefined;
async function sample(): Promise<UsageRecord[]> {
  cachedRecords ??= await loadSampleUsageData();
  return cachedRecords;
}

describe("generateReportCardSvg", () => {
  it("renders a valid, self-contained SVG with the headline numbers", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records, mode: "demo" });

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("AI RECEIPT");
    expect(svg).toContain("$87.00");
    expect(svg).toContain("ILLUSTRATIVE COST / VALUE EVIDENCE");
    expect(svg).toContain("modeled API-rate opportunity");
    expect(svg).toMatch(/~\$[\d,]+\.\d{2}\/mo/);
    expect(svg).toContain("aibill · local-first · npx aibill");
    expect(svg).not.toContain("ai-spend-agent · local-first");
  });

  it("never leaks identifying entity names (client/project/user/api-key)", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records });

    for (const entry of [
      ...summary.byClient,
      ...summary.byProject,
      ...summary.byUser,
      ...summary.byApiKey
    ]) {
      if (entry.key === "unmapped") {
        continue;
      }
      expect(svg).not.toContain(entry.key);
    }
  });

  it("never renders adversarial project or operation text in candidate titles", () => {
    const privateProject = "PROJECT-OMEGA-PRIVATE";
    const privateOperation = "summary_OPERATION-DELTA-PRIVATE";
    const records: UsageRecord[] = [{
      id: "private-operation",
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "provider-source",
        name: "Provider source",
        provider: "openai",
        confidence: "estimated",
        observedFrom: "test fixture"
      },
      model: "gpt-5.5",
      inputTokens: 200_000,
      outputTokens: 1_000,
      amountUsd: 20,
      costConfidence: "estimated",
      projectId: privateProject,
      operation: privateOperation,
      usageGranularity: "call",
      workloadSemantics: {
        downgradeSafe: true
      }
    }];
    const svg = generateReportCardSvg({
      summary: analyzeSpend(records),
      records,
      mode: "demo"
    });

    expect(svg).toContain("Investigate a model-routing candidate");
    expect(svg).toContain("Inspect cumulative coding-agent context");
    expect(svg).not.toContain(privateProject);
    expect(svg).not.toContain(privateOperation);
  });

  it("escapes XML-special characters so the SVG is always well-formed", () => {
    const summary = analyzeSpend([]);
    const svg = generateReportCardSvg({ summary, records: [] });
    expect(svg).not.toMatch(/<text[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(svg).toContain("No high-confidence cut");
    expect(svg).toContain("Savings unavailable");
    expect(svg).not.toContain("$0.00/mo");
  });

  it("renders local context evidence as exposure with no invented savings", () => {
    const records: UsageRecord[] = [{
      id: "local-heavy-context",
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: "openai",
        confidence: "estimated",
        observedFrom: "Codex transcript JSONL (this machine)"
      },
      model: "gpt-5.6",
      inputTokens: 200_000,
      outputTokens: 1_000,
      amountUsd: 20,
      costConfidence: "estimated",
      providerCostType: "local_agent_logs",
      agentId: "codex",
      projectId: "test-project",
      operation: "codex sessions"
    }];
    const summary = analyzeSpend(records);

    const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
    expect(svg).toContain("$20.00");
    expect(svg).toContain("API-equivalent exposure · savings unavailable");
    expect(svg).toContain("$20.00 observed exposure");
    expect(svg).toContain("1 daily aggregate");
    expect(svg).not.toContain("1 call");
    expect(svg).not.toContain("$0.00/mo modeled");

    const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
    expect(caption).toContain("$20.00 in observed API-equivalent exposure");
    expect(caption).toContain("savings unavailable without a matched counterfactual");
    expect(caption).not.toContain("/mo");
    expect(caption).not.toContain("modeled opportunities");
  });

  it("produces a shareable caption with an explicitly modeled opportunity", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const caption = generateReportCardCaption({ summary, records, mode: "demo" });
    expect(caption).toContain("$87.00");
    expect(caption).toContain("/mo");
    expect(caption).toContain("modeled opportunities to test—not verified savings");
    expect(caption).toContain("npx aibill");
  });

  it("counts unique providers, labels provider records honestly, and preserves unverified confidence", () => {
    const records: UsageRecord[] = [
      {
        id: "openai-cost-a",
        timestamp: "2026-08-03T12:00:00.000Z",
        source: { id: "openai-cost", name: "Costs", provider: "openai", confidence: "detected_unverified", observedFrom: "test" },
        model: "cost bucket",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: 10,
        costConfidence: "detected_unverified",
        providerCostType: "openai_cost",
        usageGranularity: "billing_bucket"
      },
      {
        id: "openai-cost-b",
        timestamp: "2026-08-03T13:00:00.000Z",
        source: { id: "openai-usage", name: "Usage", provider: "openai", confidence: "detected_unverified", observedFrom: "test" },
        model: "usage bucket",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: 5,
        costConfidence: "detected_unverified",
        providerCostType: "openai_cost",
        usageGranularity: "billing_bucket"
      }
    ];
    const svg = generateReportCardSvg({ summary: analyzeSpend(records), records, mode: "connected" });

    expect(svg).toContain("1 provider · 2 provider records · detected/unverified");
    expect(svg).not.toContain("2 providers");
    expect(svg).not.toContain("2 calls");
  });
});
