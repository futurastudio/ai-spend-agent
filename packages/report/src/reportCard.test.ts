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
    expect(svg).toContain("ILLUSTRATIVE API-EQUIVALENT VALUE");
    expect(svg).toContain("modeled API-rate opportunity");
    expect(svg).toMatch(/~\$[\d,]+\.\d{2}\/mo/);
    expect(svg).toContain("ai-spend-agent");
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

  it("escapes XML-special characters so the SVG is always well-formed", () => {
    const summary = analyzeSpend([]);
    const svg = generateReportCardSvg({ summary, records: [] });
    expect(svg).not.toMatch(/<text[^>]*>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(svg).toContain("No high-confidence cut");
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
});
