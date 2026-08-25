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
    expect(svg).toContain("AI RECEIPT · DEMO SAMPLE");
    expect(svg).toContain('aria-label="AI receipt demo sample"');
    expect(svg).toContain("$87.00");
    expect(svg).toContain("ILLUSTRATIVE EVIDENCE · DEMO SAMPLE");
    expect(svg).toContain("modeled API-rate opportunity");
    expect(svg).toMatch(/~\$[\d,]+\.\d{2}\/mo/);
    expect(svg).toContain('.modeled { fill: #fbbf24;');
    expect(svg).toContain('.cutImpact { fill: #fbbf24;');
    expect(svg).not.toContain("#4ade80");
    expect(svg).not.toContain('class="save"');
    expect(svg).not.toContain('class="cutSave"');
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
    expect(svg).toContain('<tspan class="modeled">$20.00</tspan>');
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
    expect(caption).toMatch(/^DEMO SAMPLE — My AI receipt:/);
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
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records, mode: "connected" });
    const caption = generateReportCardCaption({ summary, records, mode: "connected" });

    expect(svg).toContain("1 provider · 2 provider records · detected/unverified");
    expect(svg).toContain("CONNECTED DETECTED EVIDENCE (UNVERIFIED)");
    expect(svg).not.toContain("PROVIDER-REPORTED COST");
    expect(caption).toContain("connected detected evidence (unverified)");
    expect(caption).not.toContain("in provider-reported cost");
    expect(svg).not.toContain("2 providers");
    expect(svg).not.toContain("2 calls");
  });

  it("uses provider-reported wording only for verified priced records", () => {
    const records: UsageRecord[] = [{
      id: "verified-cost",
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "openai-cost",
        name: "OpenAI costs",
        provider: "openai",
        confidence: "verified",
        observedFrom: "test"
      },
      model: "cost bucket",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 10,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    }];
    const summary = analyzeSpend(records);

    const svg = generateReportCardSvg({ summary, records, mode: "connected" });
    const caption = generateReportCardCaption({ summary, records, mode: "connected" });

    expect(svg).toContain("PROVIDER-REPORTED COST (THIS WINDOW)");
    expect(caption).toContain("in provider-reported cost");
  });

  it("labels partial provider coverage without downgrading verified rows", () => {
    const records: UsageRecord[] = [{
      id: "partial-verified-cost",
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "openai-cost",
        name: "OpenAI costs",
        provider: "openai",
        confidence: "verified",
        observedFrom: "test"
      },
      model: "cost bucket",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 10,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    }];
    const summary = analyzeSpend(records);
    const input = { summary, records, mode: "connected" as const, providerCoverage: "partial" as const };

    const svg = generateReportCardSvg(input);
    const caption = generateReportCardCaption(input);

    expect(svg).toContain("partial coverage · verified rows");
    expect(svg).not.toContain("provider records · verified</text>");
    expect(caption).toContain("Provider coverage was partial");
    expect(caption).toContain("available rows retain their evidence labels");
  });

  it("renders positive sub-cent headlines and captions as less than one cent", () => {
    const records: UsageRecord[] = [{
      id: "positive-sub-cent",
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "openai-cost",
        name: "OpenAI costs",
        provider: "openai",
        confidence: "estimated",
        observedFrom: "test"
      },
      model: "estimated bucket",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 0.004,
      costConfidence: "estimated",
      providerCostType: "openai_usage",
      usageGranularity: "billing_bucket"
    }];
    const summary = analyzeSpend(records);

    const svg = generateReportCardSvg({ summary, records, mode: "connected" });
    const caption = generateReportCardCaption({ summary, records, mode: "connected" });

    expect(svg).toContain("&lt;$0.01");
    expect(svg).not.toContain(">$0.00</text>");
    expect(caption).toContain("My AI receipt: <$0.01");
    expect(caption).not.toContain("My AI receipt: $0.00");
  });

  it("never renders missing connected financial evidence as a zero-dollar receipt", () => {
    const records: UsageRecord[] = [{
      id: "usage-without-cost",
      timestamp: "2026-08-08T12:00:00.000Z",
      source: {
        id: "openai-usage",
        name: "OpenAI usage",
        provider: "openai",
        confidence: "verified",
        observedFrom: "usage API"
      },
      model: "gpt-5.5",
      inputTokens: 120,
      outputTokens: 20,
      amountUsd: null,
      costConfidence: "missing",
      providerCostType: "openai_usage_evidence",
      usageGranularity: "usage_bucket"
    }];
    const input = { summary: analyzeSpend(records), records, mode: "connected" as const };

    const svg = generateReportCardSvg(input);
    const caption = generateReportCardCaption(input);

    expect(svg).toContain("CONNECTED EVIDENCE · NO PRICED AMOUNT");
    expect(svg).toContain(">Unavailable</text>");
    expect(svg).not.toContain("$0.00");
    expect(caption).toContain("amounts unavailable (no priced financial evidence)");
    expect(caption).not.toContain("$0.00");
  });
});

describe("caption ↔ card reconciliation (launch-sweep fix)", () => {
  // The shipped sample caption once quoted "$41.00" — observed exposure summed
  // from cuts the card and receipt never display. Contract now: the caption is
  // recomputed from the same fixture the artifact renders, and every dollar
  // figure in the caption is present on the card itself.
  it("recomputes the expected sample caption from the fixture and finds every caption figure on the card", async () => {
    const { generateCutList, buildRecommendedPlan } = await import("@agent-finops/core");
    const records = await sample();
    const summary = analyzeSpend(records);
    const caption = generateReportCardCaption({ summary, records, mode: "demo" });
    const svg = generateReportCardSvg({ summary, records, mode: "demo" });

    // Expected caption, derived from the fixture through the same helpers the
    // renderer uses — never a hand-typed dollar literal.
    const expectedModeled = buildRecommendedPlan(generateCutList(records)).recommendedSavingsUsd;
    const expectedTotal = summary.totalUsd;
    expect(caption).toBe(
      `DEMO SAMPLE — My AI receipt: $${expectedTotal.toFixed(2)} in illustrative evidence, ` +
      `with ~$${expectedModeled.toFixed(2)}/mo in modeled opportunities to test—not verified savings. ` +
      "Local-first: npx aibill"
    );

    // Reconciliation: every dollar figure the caption quotes appears on the
    // artifact it captions.
    const captionFigures = caption.match(/\$\d[\d,]*\.\d{2}/gu) ?? [];
    expect(captionFigures.length).toBeGreaterThan(0);
    for (const figure of captionFigures) {
      expect(svg, `caption figure ${figure} must appear on the card`).toContain(figure);
    }
    // The old unreconcilable appendix is gone.
    expect(caption).not.toContain("is observed API-equivalent exposure");
  });
});
