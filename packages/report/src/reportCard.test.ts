import { describe, expect, it } from "vitest";
import { analyzeSpend, loadSampleUsageData, type UsageRecord } from "@agent-finops/core";
import { generateReceiptCompanionHtml, generateReportCardSvg, generateReportCardCaption } from "./reportCard.js";

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
    // Estimated-money amber stays receipt-scoped #fbbf24 by mandate.
    expect(svg).toContain('.modeled { fill: #fbbf24;');
    expect(svg).toContain('.cutImpact { fill: #fbbf24;');
    expect(svg).not.toContain("#4ade80");
    // 0.9.5 brand retint: warm green-black ground ladder + white-alpha
    // hairline stroke, and the neutral text inks recolored off the
    // blue-tinted periwinkle to the warm white-alpha ink/muted/faint ladder.
    expect(svg).toContain('stop-color="#0C0D09"');
    expect(svg).toContain('stop-color="#12140E"');
    expect(svg).toContain('stroke="rgba(255,255,255,0.08)"');
    expect(svg).toContain('.big { fill: #EDEDED;');
    expect(svg).toContain('.meta { fill: rgba(255,255,255,0.62);');
    expect(svg).toContain('.label { fill: rgba(255,255,255,0.47);');
    expect(svg).not.toContain("#0b1020");
    expect(svg).not.toContain("#121a33");
    expect(svg).not.toContain("#26304f");
    // Periwinkle text inks are gone.
    expect(svg).not.toContain("#e8edff");
    expect(svg).not.toContain("#9aa6d6");
    expect(svg).not.toContain("#7c89b3");
    expect(svg).not.toContain("#cdd6f7");
    expect(svg).not.toContain("#5b6790");
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

    // 0.9.5: exposure here EQUALS the headline value, so the card collapses
    // the second $20.00 into words instead of printing the same number twice.
    const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
    expect(svg).toContain("$20.00");
    expect(svg).toContain('<tspan class="modeled">All</tspan>');
    expect(svg).toContain("of the value above is exposure · savings unavailable");
    expect(svg).not.toContain('<tspan class="modeled">$20.00</tspan>');
    expect(svg).toContain("$20.00 observed exposure");
    expect(svg).toContain("1 daily aggregate");
    expect(svg).not.toContain("1 call");
    expect(svg).not.toContain("$0.00/mo modeled");

    const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
    expect(caption).toContain("$20.00 in observed API-equivalent value");
    expect(caption).toContain("effectively all of it exposure to investigate");
    expect(caption).toContain("savings unavailable without a matched counterfactual");
    // ONE dollar figure: the near-identical exposure repeat is gone.
    expect(caption.match(/\$/gu)).toHaveLength(1);
    expect(caption).not.toContain("/mo");
    expect(caption).not.toContain("modeled opportunities");
  });

  // 0.9.5 equal-case collapse: value vs exposure within $0.05 is rounding
  // noise (the founder's live card read $2,281.89 vs $2,281.87) and prints
  // ONE number; a genuinely different pair keeps both. Both sides of the
  // documented threshold are pinned here.
  describe("observed value/exposure caption dedup threshold ($0.05)", () => {
    const localRecord = (id: string, amountUsd: number, inputTokens: number): UsageRecord => ({
      id,
      timestamp: "2026-08-03T12:00:00.000Z",
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: "openai",
        confidence: "estimated",
        observedFrom: "Codex transcript JSONL (this machine)"
      },
      model: "gpt-5.6",
      inputTokens,
      outputTokens: 1_000,
      amountUsd,
      costConfidence: "estimated",
      providerCostType: "local_agent_logs",
      agentId: "codex",
      projectId: "test-project",
      operation: "codex sessions"
    });

    it("collapses to one number when the figures differ by rounding noise (≤ $0.05)", () => {
      // Heavy record drives the $20.00 exposure; the 4¢ record stays under
      // the 100k-token context threshold, so total = $20.04 vs exposure
      // $20.00 — the founder's sub-cent-rounding case.
      const records = [
        localRecord("heavy", 20, 200_000),
        localRecord("tiny-rounding-drift", 0.04, 1_000)
      ];
      const summary = analyzeSpend(records);

      const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
      expect(caption).toContain("$20.04 in observed API-equivalent value");
      expect(caption).toContain("effectively all of it exposure to investigate");
      expect(caption).toContain("savings unavailable without a matched counterfactual");
      expect(caption).not.toContain("$20.00");
      expect(caption.match(/\$/gu)).toHaveLength(1);

      const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
      expect(svg).toContain('<tspan class="modeled">All</tspan>');
      expect(svg).toContain("of the value above is exposure · savings unavailable");
      expect(svg).not.toContain('<tspan class="modeled">$20.00</tspan>');
    });

    it("the exact-5¢ boundary collapses deterministically at every magnitude (integer cents, no float jitter)", () => {
      // Float subtraction made this boundary magnitude-dependent:
      // 20.05−20.00 = 0.05000000000000071 (kept both) while 100.05−100.00 =
      // 0.04999999999999716 (collapsed). Integer-cent comparison pins both
      // shapes to the SAME verdict: exactly 5¢ apart merges.
      for (const heavyAmount of [20, 100]) {
        const records = [
          localRecord("heavy", heavyAmount, 200_000),
          localRecord("five-cent-drift", 0.05, 1_000)
        ];
        const summary = analyzeSpend(records);
        const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
        expect(caption, `heavy=$${heavyAmount}`).toContain("effectively all of it exposure to investigate");
        expect(caption.match(/\$/gu), `heavy=$${heavyAmount}`).toHaveLength(1);
        const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
        expect(svg, `heavy=$${heavyAmount}`).toContain('<tspan class="modeled">All</tspan>');
      }
    });

    it("keeps both numbers when they genuinely differ (> $0.05)", () => {
      const records = [
        localRecord("heavy", 20, 200_000),
        localRecord("real-remainder", 0.06, 1_000)
      ];
      const summary = analyzeSpend(records);

      const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
      expect(caption).toContain("$20.06 in observed API-equivalent value");
      expect(caption).toContain("with $20.00 in observed API-equivalent exposure to investigate");
      expect(caption).toContain("savings unavailable without a matched counterfactual");
      expect(caption).not.toContain("effectively all of it");

      const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
      expect(svg).toContain('<tspan class="modeled">$20.00</tspan>');
      expect(svg).toContain("API-equivalent exposure · savings unavailable");
      expect(svg).not.toContain('<tspan class="modeled">All</tspan>');
    });
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
    const usd = (value: number) =>
      value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(caption).toBe(
      `DEMO SAMPLE — My AI receipt: $${usd(expectedTotal)} in illustrative evidence, ` +
      `with ~$${usd(expectedModeled)}/mo in modeled opportunities to test—not verified savings. ` +
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

describe("cross-surface parity (SVG receipt card)", () => {
  it("uses ONE thousands style — every dollar on the card carries commas at >= $1,000", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      amountUsd: record.amountUsd === null ? null : record.amountUsd * 100
    }));
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records, mode: "demo" });
    const caption = generateReportCardCaption({ summary, records, mode: "demo" });
    // The corpus defect: "$2,105.06" (big) and "$2105.06" (modeled) two
    // lines apart. Every 4+ digit dollar on the card and caption now
    // carries the comma form; the bare form must not appear.
    expect(svg).not.toMatch(/\$\d{4,}\.\d{2}/u);
    expect(caption).not.toMatch(/\$\d{4,}\.\d{2}/u);
    expect(svg).toMatch(/\$\d{1,3}(,\d{3})+\.\d{2}/u);
  });

  /**
   * N1 (0.9.6): `user-select: all` sat on `.caption`, which ALSO wraps the
   * "Caption to share" UI label, under `white-space: pre-wrap`. A single
   * click-and-copy therefore yielded 208 characters for a ~190-character
   * caption — the label, a newline and the template's indentation, pasted
   * straight into the user's post. This page exists so that one line can be
   * pasted into a post; it pasted broken.
   *
   * The pin extracts the text a browser would select (the element carrying
   * `user-select: all`) and asserts it equals the caption EXACTLY.
   */
  it("the selectable region holds the caption and nothing else", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const caption = generateReportCardCaption({ summary, records, mode: "demo" });
    const html = generateReceiptCompanionHtml({ svg: "<svg/>", caption });

    // The one element that carries `user-select: all`.
    const selectable = /<div class="caption-text">([\s\S]*?)<\/div>/u.exec(html);
    expect(selectable, "no single element carries the selectable caption").not.toBeNull();
    const copied = selectable![1]!
      .replaceAll("&amp;", "&").replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

    expect(copied).toBe(caption);
    expect(copied).not.toContain("Caption to share");
    // No leading/trailing whitespace: `pre-wrap` would preserve indentation.
    expect(copied).toBe(copied.trim());
    expect(copied.length).toBe(caption.length);

    // And the label is still on the page — outside the selectable region.
    expect(html).toContain(">Caption to share<");
    const labelIndex = html.indexOf("Caption to share");
    expect(labelIndex).toBeLessThan(html.indexOf('class="caption-text"'));
  });

  it("shareable footer: the card points at asktilden.com", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records, mode: "demo" });
    expect(svg).toContain("aibill · local-first · npx aibill · asktilden.com");
  });
});

/**
 * B1 (0.9.7): the shareable receipt printed $0.00 for money that is UNKNOWN.
 *
 * Reproduced end to end: any model id absent from the pricing table (e.g.
 * `gpt-6-preview`) with ordinary sessions produced, in one directory two
 * commands apart, `npx aibill` → "Unavailable · local activity found ·
 * financial evidence missing · 3 records missing cost" and `npx aibill
 * report-card` → a caption reading "$0.00 in observed API-equivalent value"
 * over an SVG reading "OBSERVED API-EQUIVALENT VALUE / $0.00 / 3 daily
 * aggregates". "3 aggregates, $0.00" reads as "these cost me nothing"; the
 * truth is "cost unknown" — on the one artifact the product tells people to
 * post publicly.
 *
 * Three cases are pinned, plus the agreement between them: all-unknown (no
 * $0.00 anywhere), mixed (a real total that STILL discloses the count it
 * could not price), and fully priced (unchanged, no spurious caveat).
 */
describe("B1 — an unknown total is never rendered as $0.00", () => {
  const localRecord = (
    id: string,
    model: string,
    amountUsd: number | null
  ): UsageRecord => ({
    id,
    timestamp: "2026-08-03T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: "anthropic",
      confidence: amountUsd === null ? "missing" : "estimated",
      observedFrom: "Claude Code transcript JSONL (this machine)"
    },
    model,
    inputTokens: 120_000,
    outputTokens: 3_000,
    amountUsd,
    costConfidence: amountUsd === null ? "missing" : "estimated",
    providerCostType: "local_agent_logs",
    agentId: "claude-code",
    projectId: "demo-proj",
    operation: "claude-code sessions"
  });

  const unpriced = [
    localRecord("unknown-1", "gpt-6-preview", null),
    localRecord("unknown-2", "gpt-6-preview", null),
    localRecord("unknown-3", "gpt-6-preview", null)
  ];
  const mixed = [
    localRecord("priced-1", "claude-opus-4-8", 1.2),
    localRecord("priced-2", "claude-opus-4-8", 0.61),
    localRecord("unknown-1", "gpt-6-preview", null)
  ];
  const priced = [
    localRecord("priced-1", "claude-opus-4-8", 1.2),
    localRecord("priced-2", "claude-opus-4-8", 0.61)
  ];

  const surfaces = (records: UsageRecord[]) => {
    const summary = analyzeSpend(records);
    const svg = generateReportCardSvg({ summary, records, mode: "local-logs" });
    const caption = generateReportCardCaption({ summary, records, mode: "local-logs" });
    return { svg, caption, html: generateReceiptCompanionHtml({ svg, caption }) };
  };

  describe("all-unknown: nothing in the window could be priced", () => {
    it("prints Unavailable — and no $0.00 — on the card, the caption and the companion page", () => {
      const { svg, caption, html } = surfaces(unpriced);

      for (const [name, surface] of Object.entries({ svg, caption, html })) {
        expect(surface, `${name} still prints a zero total`).not.toContain("$0.00");
        expect(surface, `${name} lost the unknown-total word`).toContain("Unavailable");
      }
      // The headline itself, not merely the word somewhere on the card.
      expect(svg).toContain('class="big">Unavailable</text>');
      expect(svg).toContain("OBSERVED EVIDENCE · NO PRICED AMOUNT");
      expect(svg).not.toContain("OBSERVED API-EQUIVALENT VALUE<");
      expect(caption).toContain("observed API-equivalent value Unavailable (no priced cost evidence)");
      expect(caption).not.toContain("$0.00 in observed API-equivalent value");
    });

    it("carries the missing-cost count the terminal already prints", () => {
      const { svg, caption, html } = surfaces(unpriced);
      for (const [name, surface] of Object.entries({ svg, caption, html })) {
        expect(surface, `${name} hides how many records are missing cost`)
          .toContain("3 records missing cost");
        expect(surface, `${name} drops the truth clause`).toContain("missing/null is not zero");
      }
    });

    it("says 'record' in the singular for a one-record window", () => {
      const { svg, caption } = surfaces([localRecord("only", "gpt-6-preview", null)]);
      expect(svg).toContain("1 record missing cost");
      expect(caption).toContain("1 record missing cost");
      expect(svg).not.toContain("1 records missing cost");
    });
  });

  describe("mixed: a real total that still owes the reader a count", () => {
    it("keeps the dollars AND discloses the unpriced records on every surface", () => {
      const { svg, caption, html } = surfaces(mixed);

      // The money that IS known still leads — this is not the missing case.
      expect(svg).toContain('class="big">$1.81</text>');
      expect(caption).toContain("$1.81 in observed API-equivalent value");
      // …and the caveat the terminal shows for the same records travels with
      // the card. This is exactly what the shipped receipt dropped: "$1.81 ·
      // 6 daily aggregates" while only 5 of 6 were priced.
      for (const [name, surface] of Object.entries({ svg, caption, html })) {
        expect(surface, `${name} silently dropped the mixed-case caveat`)
          .toContain("1 record missing cost");
        expect(surface, `${name} drops the truth clause`).toContain("missing/null is not zero");
      }
    });
  });

  describe("fully priced: unchanged, and no caveat invented", () => {
    it("adds no missing-cost line to a window where everything was priced", () => {
      const { svg, caption, html } = surfaces(priced);

      expect(svg).toContain('class="big">$1.81</text>');
      expect(caption).toContain("$1.81 in observed API-equivalent value");
      for (const [name, surface] of Object.entries({ svg, caption, html })) {
        expect(surface, `${name} invented a missing-cost caveat`).not.toContain("missing cost");
        expect(surface, `${name} invented a truth clause`).not.toContain("missing/null is not zero");
        expect(surface, `${name} lost its real total`).toContain("$1.81");
      }
      expect(svg).toContain("OBSERVED API-EQUIVALENT VALUE");
      expect(svg).not.toContain("NO PRICED AMOUNT");
    });
  });

  it("cross-surface: the card and its caption never disagree about whether the total is known", () => {
    for (const [name, records] of Object.entries({ unpriced, mixed, priced })) {
      const { svg, caption, html } = surfaces(records);
      const cardUnknown = svg.includes('class="big">Unavailable</text>');
      const captionUnknown = caption.includes("value Unavailable");
      expect(captionUnknown, `${name}: card and caption disagree on the headline`).toBe(cardUnknown);
      // The companion page embeds both verbatim, so it inherits the verdict.
      expect(html.includes("value Unavailable"), `${name}: companion page disagrees`).toBe(cardUnknown);
    }
  });

  it("the caveat line never runs off the 640px card", () => {
    const { svg } = surfaces(unpriced);
    const metaLines = [...svg.matchAll(/class="meta">([^<]*)<\/text>/gu)].map((match) => match[1]!);
    expect(metaLines.length).toBeGreaterThan(1);
    for (const line of metaLines) {
      // 14px monospace advances ~0.6em; x=40 leaves ~600px, i.e. ~71 chars.
      expect(line.length, `overflows the card: ${line}`).toBeLessThanOrEqual(71);
    }
  });
});
