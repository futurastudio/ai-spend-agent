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
    expect(text).toContain("What to test");
    expect(text).toMatch(/Move .* to .*model ~\$/);
    expect(text).toContain("ILLUSTRATIVE COST / VALUE EVIDENCE");
    expect(text).toContain("Cost/value evidence by source");
    expect(text).toContain("Cost/value evidence by model");
    expect(text).toContain("Evidence");
    expect(text).not.toContain("Spend by model");
    expect(text).toContain("modeled API-rate opportunity");
    expect(text).toContain("/mo");
  });

  it("states the projection window and caveats a short one", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const multiDay = generatePlainEnglishSummary(summary, { records, color: false });
    // Sample spans multiple days: states the window, no short-window caveat.
    expect(multiDay).toMatch(/projected from \d+ days of data/);
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
    expect(text).toContain("Cost/value evidence by agent");
    expect(text).toContain("agent-analyst");
  });

  it("supports every declared group-by dimension", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    for (const dimension of groupByDimensions) {
      const text = generatePlainEnglishSummary(summary, { records, color: false, groupBy: dimension });
      expect(text).toContain("Cost/value evidence by");
    }
  });

  it("shows a demo banner and connect CTA in demo mode", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "demo" });
    expect(text).toContain("DEMO");
    expect(text).toContain("connect");
    expect(text).toContain("not one invoice or homogeneous spend basis");
    expect(text).toContain("combined illustrative evidence");
    expect(text).toContain("illustrative SAMPLE API-equivalent estimates");
    expect(text).toContain("no local logs or account data were used");
    expect(text).toContain("Illustrative hypotheses only");
    expect(text).toContain("not this user's savings, bill, or ROI");
    expect(text).toContain("disabled for sample data");
    expect(text).toContain("NON-EXECUTABLE DEMO");
    expect(text).toContain("does not authorize or propose a user change");
    expect(text).not.toContain("ESTIMATES from local logs");
    expect(text).not.toContain("paste it into Claude Code / Codex — it carries the candidates above");
  });

  it("structures the readout as the diagnose/recommend/apply/verify loop, in order", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs" });

    const positions = [
      text.indexOf("1 · DIAGNOSE"),
      text.indexOf("2 · RECOMMEND"),
      text.indexOf("3 · APPLY"),
      text.indexOf("4 · VERIFY")
    ];
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // APPLY surfaces the copy artifact; VERIFY surfaces re-run/watch + connect.
    expect(text).toContain("apply-artifact");
    expect(text).toContain("watch");
    expect(text).toContain("no account was connected or authorized");
  });

  it("prefixes every suggested command with npx (bare bins are not on PATH for npx users)", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs" });
    expect(text).toContain("npx aibill apply-artifact");
    // No bare `aibill <cmd>` may survive without the npx prefix.
    for (const line of text.split("\n")) {
      const bare = line.match(/(?<!npx )aibill (apply-artifact|watch|connect|report|sync-provider)/);
      expect(bare, line).toBeNull();
    }
  });

  it("leads with the detected plan for subscription users (persona framing)", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, {
      records,
      color: false,
      mode: "local-logs",
      detectedPlans: [{
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        source: "test"
      }]
    });
    expect(text).toContain("PLAN Claude Max 5x — detected from your agents' local config");
    expect(text).toContain("for agents with a detected flat-price subscription");
  });

  it("collapses sub-$1/mo cuts into one summary line", async () => {
    const records = await sample();
    // Add a tiny explicit call-level routing candidate that yields a <$1/mo
    // modeled cut alongside the larger sample candidates.
    const tiny = records.slice(0, 3).map((record, index) => ({
      ...record,
      id: `tiny-${index}`,
      model: "gpt-4.1",
      operation: "tiny_summary",
      amountUsd: 0.03,
      inputTokens: 100,
      usageGranularity: "call" as const,
      workloadSemantics: { downgradeSafe: true }
    }));
    const all = [...records, ...tiny];
    const text = generatePlainEnglishSummary(analyzeSpend(all), { records: all, color: false });
    expect(text).toMatch(/\+ \d+ smaller cuts? under \$1\/mo/);
    expect(text).toContain("included in apply-artifact");
  });

  it("leads with an explicit plan-price comparison for subscription users", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      providerCostType: "local_agent_logs",
      agentId: "claude-code" as const
    }));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      detectedPlans: [{
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        source: "test"
      }]
    });
    expect(text).toContain("COMPARED WITH Claude Max 5x ($100/mo)");
    expect(text).toMatch(/~[\d.]+× the listed price/);
    expect(text).toContain("compare observed usage with plan context");
    expect(text).toContain("evidence first; reduction is not yet established");
  });

  it("opens with a TL;DR on local-log readouts (value, top burner, one action)", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      providerCostType: "local_agent_logs",
      agentId: "claude-code" as const
    }));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      detectedPlans: [{
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        source: "test"
      }]
    });
    expect(text).toContain("TL;DR");
    expect(text).toMatch(/API-equivalent usage is ~[\d.]+× the Claude Max 5x list price/);
    expect(text).toContain("run npx aibill apply");
    // TL;DR comes before the detail sections.
    expect(text.indexOf("TL;DR")).toBeLessThan(text.indexOf("1 · DIAGNOSE"));
  });

  it("treats no-matching-invocation inventory as candidates, never removal proof", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      providerCostType: "local_agent_logs",
      agentId: "claude-code" as const
    }));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      deadContext: {
        hasData: true,
        loadedCount: 3,
        deadCount: 1,
        measuredDeadCount: 0,
        unmeasuredDeadCount: 1,
        deadTokens: 0,
        monthlyDeadTokens: 0,
        wastePercent: 1 / 3,
        monthlyUsd: 0,
        monthlyUsdUpperBound: 0,
        deadItems: [],
        sessions: 2,
        totalTurns: 5,
        pricingModel: "claude-sonnet-4",
        windowDays: 30
      }
    });

    expect(text).toContain("inspect 1 context candidate with no matching invocation");
    expect(text).not.toMatch(/remove .*dead tool/i);
  });

  it("labels local-log records as session-day records, not calls", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const local = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs" });
    expect(local).toMatch(/tracked across \d+ session-day records/);
    const demo = generatePlainEnglishSummary(summary, { records, color: false, mode: "demo" });
    expect(demo).toMatch(/combined illustrative evidence across \d+ illustrative records/);
  });

  it("renders home-launched project usage as unattributed with an honest record unit", () => {
    const records: UsageRecord[] = [{
      id: "local-home",
      timestamp: "2026-08-03T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local agent session logs", provider: "openai", confidence: "estimated", observedFrom: "test" },
      model: "gpt-5.6-sol",
      inputTokens: 100_000,
      outputTokens: 5_000,
      amountUsd: 81,
      costConfidence: "estimated",
      agentId: "codex",
      providerCostType: "local_agent_logs"
    }, {
      id: "local-project",
      timestamp: "2026-08-03T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local agent session logs", provider: "openai", confidence: "estimated", observedFrom: "test" },
      model: "gpt-5.6-sol",
      inputTokens: 20_000,
      outputTokens: 1_000,
      amountUsd: 19,
      costConfidence: "estimated",
      projectId: "agent-finops",
      agentId: "codex",
      providerCostType: "local_agent_logs"
    }];

    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      groupBy: "project"
    });

    expect(text).toContain("81% is not yet attributable to a project");
    expect(text).toContain("Unattributed");
    expect(text).toContain("Records");
    expect(text).not.toContain("(home) eats");
  });
});
