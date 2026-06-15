import { describe, expect, it } from "vitest";
import { analyzeSpend, loadSampleUsageData, type UsageRecord } from "@agent-finops/core";
import { generatePlainEnglishSummary, groupByDimensions } from "./terminal.js";

// eslint-disable-next-line no-control-regex
const ansiPattern = /\[/;

let cachedRecords: UsageRecord[] | undefined;
async function sample(): Promise<UsageRecord[]> {
  cachedRecords ??= await loadSampleUsageData();
  return cachedRecords;
}

describe("generatePlainEnglishSummary", () => {
  it("leads with the headline total and a ranked actionable cut list", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false });

    expect(text).toContain("$87.00");
    expect(text).toContain("Where to cut");
    expect(text).toMatch(/Move .* to .*save ~\$/);
    expect(text).toContain("/mo");
  });

  it("states the projection window and caveats a short one", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const multiDay = generatePlainEnglishSummary(summary, { records, color: false });
    // Sample spans multiple days: states the window, no short-window caveat.
    expect(multiDay).toMatch(/30-day projection from \d+ days of data/);
    expect(multiDay).not.toContain("pattern repeats");

    // Collapse to a single day -> the honesty caveat must appear.
    const oneDay = records.map((record) => ({
      ...record,
      timestamp: "2026-06-08T10:00:00.000Z",
    }));
    const oneDayText = generatePlainEnglishSummary(analyzeSpend(oneDay), {
      records: oneDay,
      color: false,
    });
    expect(oneDayText).toContain("pattern repeats");
  });

  it("renders without ANSI escapes when color is disabled (pipe-safe)", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false });
    expect(text).not.toMatch(ansiPattern);
  });

  it("includes ANSI escapes when color is forced on", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: true });
    expect(text).toMatch(ansiPattern);
  });

  it("drills down by the requested group-by dimension", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, groupBy: "agent" });
    expect(text).toContain("Spend by agent");
    expect(text).toContain("agent-analyst");
  });

  it("supports every declared group-by dimension", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    for (const dimension of groupByDimensions) {
      const text = generatePlainEnglishSummary(summary, { records, color: false, groupBy: dimension });
      expect(text).toContain("Spend by");
    }
  });

  it("shows a demo banner and connect CTA in demo mode", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "demo" });
    expect(text).toContain("DEMO");
    expect(text).toContain("connect");
  });
});
