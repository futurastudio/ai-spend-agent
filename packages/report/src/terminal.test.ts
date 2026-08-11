import { describe, expect, it } from "vitest";
import { analyzeSpend, loadSampleUsageData, type UsageRecord } from "@agent-finops/core";
import { generatePlainEnglishSummary, groupByDimensions } from "./terminal.js";

// eslint-disable-next-line no-control-regex
const ansiPattern = /\[/;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

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
    expect(normalizeWhitespace(text)).toMatch(/Move .* to .*model ~\$/);
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

  it("renders all-missing local evidence as unavailable instead of estimated $0", () => {
    const records: UsageRecord[] = [{
      id: "local-gemini-missing",
      timestamp: "2026-08-11T00:00:00.000Z",
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: "google",
        confidence: "estimated",
        observedFrom: "gemini-cli chats session JSON/JSONL (this machine)"
      },
      model: "gemini-future-synthetic-unknown",
      inputTokens: 600,
      outputTokens: 70,
      amountUsd: null,
      costConfidence: "missing",
      agentId: "gemini-cli",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs"
    });
    const normalized = normalizeWhitespace(text);

    expect(normalized).toContain("OBSERVED VALUE UNAVAILABLE evidence-labeled financial view Unavailable");
    expect(text).toContain("Not priced");
    expect(normalized).not.toContain("OBSERVED API-EQUIVALENT VALUE evidence-labeled financial view $0.00");
  });

  it("never renders a missing Gemini breakdown row as zero or a known share", () => {
    const records: UsageRecord[] = [
      {
        id: "local-gemini-priced",
        timestamp: "2026-08-11T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local logs", provider: "google", confidence: "estimated", observedFrom: "fixture" },
        model: "gemini-2.5-pro",
        inputTokens: 1_000,
        outputTokens: 100,
        amountUsd: 0.01,
        costConfidence: "estimated",
        projectId: "priced-project",
        agentId: "gemini-cli",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate"
      },
      {
        id: "local-gemini-missing-row",
        timestamp: "2026-08-11T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local logs", provider: "google", confidence: "estimated", observedFrom: "fixture" },
        model: "gemini-future-unknown",
        inputTokens: 1_000,
        outputTokens: 100,
        amountUsd: null,
        costConfidence: "missing",
        projectId: "missing-project",
        agentId: "gemini-cli",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate"
      }
    ];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "breakdown",
      groupBy: "project"
    });
    const missingRow = text.split("\n").find((line) => line.includes("missing-project"));

    expect(missingRow).toContain("Unavailable");
    expect(missingRow).toContain("missing");
    expect(missingRow).not.toContain("$0.00");
    expect(missingRow).not.toContain("0%");
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
    const normalized = normalizeWhitespace(text);
    expect(text).toContain("DEMO");
    expect(text).toContain("connect");
    expect(text).toContain("not one invoice or homogeneous spend basis");
    expect(text).toContain("combined illustrative evidence");
    expect(text).toContain("illustrative SAMPLE API-equivalent estimates");
    expect(normalized).toContain("no local logs or account data were used");
    expect(text).toContain("Illustrative hypotheses only");
    expect(normalized).toContain("not this user's savings, bill, or ROI");
    expect(text).toContain("disabled for sample data");
    expect(text).toContain("NON-EXECUTABLE DEMO");
    expect(text).toContain("npx aibill apply --sample");
    expect(text).toContain("npx aibill report-card --sample");
    expect(text).toContain("· evidence mix:");
    expect(normalized).toContain("does not authorize or propose a user change");
    expect(text).not.toContain("ESTIMATES from local logs");
    expect(normalized).not.toContain("paste it into Claude Code / Codex — it carries the candidates above");
  });

  it("orders the deterministic receipt from trust through evidence to the final receipt CTA", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs" });

    const positions = [
      text.indexOf("MODE / TRUST"),
      text.indexOf("OBSERVED API-EQUIVALENT VALUE"),
      text.indexOf("1 · DIAGNOSE"),
      text.indexOf("Where observed API-equivalent value goes"),
      text.indexOf("Plan context"),
      text.indexOf("2 · RECOMMEND"),
      text.indexOf("Context evidence"),
      text.indexOf("3 · APPLY"),
      text.indexOf("4 · VERIFY"),
      text.indexOf("AI RECEIPT")
    ];
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // APPLY surfaces the copy artifact; VERIFY surfaces re-run/watch + connect.
    expect(text).toContain("apply-artifact");
    expect(text).toContain("watch");
    expect(normalizeWhitespace(text)).toContain("no account was connected or authorized");
    expect(text.trimEnd().endsWith("› npx aibill report-card  write a redacted, shareable SVG + caption")).toBe(true);
  });

  it("prefixes every suggested command with npx (bare bins are not on PATH for npx users)", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    const text = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs" });
    expect(text).toContain("npx aibill apply-artifact");
    // No bare `aibill <cmd>` may survive without the npx prefix.
    for (const line of text.split("\n")) {
      const bare = line.match(/(?<!npx )aibill (apply-artifact|watch|connect|report-card|report|sync-provider)/);
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
    expect(normalizeWhitespace(text)).toMatch(/\+ \d+ smaller cuts? under \$1\/mo/);
    expect(normalizeWhitespace(text)).toContain("included in apply-artifact");
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
    expect(normalizeWhitespace(text)).toContain("COMPARED WITH Claude Max 5x ($100/mo)");
    expect(normalizeWhitespace(text)).toMatch(/~[\d.]+× the listed price/);
    expect(text).toContain("compare observed usage with plan context");
    expect(normalizeWhitespace(text)).toContain("evidence first; reduction is not yet established");
  });

  it("keeps the plan comparison in plan context without a duplicative TL;DR", async () => {
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
    expect(text).not.toContain("TL;DR");
    expect(normalizeWhitespace(text)).toMatch(/COMPARED WITH Claude Max 5x \(\$100\/mo\).*~[\d.]+× the listed price/);
    expect(text.indexOf("COMPARED WITH")).toBeGreaterThan(text.indexOf("Plan context"));
    expect(text.indexOf("COMPARED WITH")).toBeLessThan(text.indexOf("2 · RECOMMEND"));
  });

  it("uses green only for verified evidence and amber for modeled or estimated claims", async () => {
    const sampleRecords = await sample();
    const verifiedRecords: UsageRecord[] = sampleRecords.map((record) => ({
      ...record,
      costConfidence: "verified",
      source: { ...record.source, confidence: "verified" }
    }));
    const connected = generatePlainEnglishSummary(analyzeSpend(verifiedRecords), {
      records: verifiedRecords,
      color: true,
      mode: "connected"
    });
    const local = generatePlainEnglishSummary(analyzeSpend(sampleRecords), {
      records: sampleRecords,
      color: true,
      mode: "local-logs"
    });

    expect(connected).toContain("\u001b[32m● provider-reported\u001b[39m");
    expect(connected).toMatch(/\u001b\[1m\u001b\[32m\$87\.00/);
    expect(connected).toContain("PROVIDER-REPORTED COST");
    expect(connected).toMatch(/\u001b\[33m\u001b\[1mmodel ~\$/);
    expect(connected).toMatch(/\u001b\[33m\u001b\[1m~\$/);
    expect(connected).not.toMatch(/\u001b\[32m\u001b\[1m(?:model|~\$)/);
    expect(local).toContain("\u001b[33m\u001b[1mLOCAL ESTIMATE\u001b[22m\u001b[39m");
    expect(local).toMatch(/\u001b\[1m\u001b\[33m\$87\.00/);
    expect(local).not.toContain("\u001b[31m");
  });

  it("never relabels connected estimates as provider-reported cost", async () => {
    const records = (await sample()).filter((record) => record.costConfidence === "estimated");
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected"
    });

    expect(text).toContain("CONNECTED · ESTIMATED");
    expect(text).toContain("CONNECTED ESTIMATED COST / VALUE");
    expect(text).toContain("Where connected estimated cost/value appears");
    expect(text).toContain("Connected estimated cost/value by model");
    expect(text).not.toContain("PROVIDER-REPORTED COST");
    expect(text).not.toContain("Where provider-reported cost goes");
    expect(text).not.toContain("Provider-reported cost by model");
  });

  it("keeps provider completeness separate from verified row evidence", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      costConfidence: "verified" as const,
      source: { ...record.source, confidence: "verified" as const }
    }));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: true,
      mode: "connected",
      providerCoverage: "partial"
    });

    expect(text).toContain("\u001b[33m\u001b[1mCONNECTED · PARTIAL COVERAGE\u001b[22m\u001b[39m");
    expect(text).toContain("available rows keep their financial evidence labels");
    expect(text).not.toContain("CONNECTED · PROVIDER-REPORTED");
    expect(text).toContain("\u001b[32m● provider-reported\u001b[39m");
    expect(text).toContain("PROVIDER-REPORTED COST");
  });

  it("renders a positive sub-cent headline as less than one cent", async () => {
    const [sampleRecord] = await sample();
    const records: UsageRecord[] = [{
      ...sampleRecord!,
      id: "positive-sub-cent",
      amountUsd: 0.004,
      costConfidence: "estimated",
      source: { ...sampleRecord!.source, confidence: "estimated" },
      providerCostType: "local_agent_logs",
      agentId: "codex"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs"
    });
    const normalized = normalizeWhitespace(text);

    expect(normalized).toContain("OBSERVED API-EQUIVALENT VALUE evidence-labeled financial view <$0.01 tracked");
    expect(normalized).not.toContain("OBSERVED API-EQUIVALENT VALUE evidence-labeled financial view $0.00");
    expect(normalized).toContain("evidence mix: <$0.01 API-equivalent/estimated");
  });

  it("renders missing connected financial evidence as unavailable, never zero", () => {
    const records: UsageRecord[] = [{
      id: "connected-usage-without-cost",
      timestamp: "2026-08-08T00:00:00.000Z",
      source: {
        id: "openai-usage",
        name: "OpenAI usage",
        provider: "openai",
        confidence: "verified",
        observedFrom: "usage API"
      },
      model: "gpt-5.5",
      inputTokens: 100,
      outputTokens: 10,
      amountUsd: null,
      costConfidence: "missing",
      providerCostType: "openai_usage_evidence",
      usageGranularity: "usage_bucket"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected",
      width: 120
    });

    expect(normalizeWhitespace(text)).toContain("CONNECTED COST / VALUE UNAVAILABLE evidence-labeled financial view Unavailable");
    expect(text).toContain("Not priced");
    expect(text).not.toContain("$0.00");
  });

  it("keeps modeled opportunity copy evidence-scoped and hides raw/debug values", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected"
    });

    expect(text).toContain("modeled API-rate opportunity (deduplicated)");
    expect(normalizeWhitespace(text)).toContain("verify quality and the next provider report");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\/Users\/[^<]/);
  });

  it("wraps prose at the default receipt width without corrupting table rows", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "demo",
      width: 72
    });

    for (const line of text.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(72);
    }
    expect(text).toContain("not one invoice or homogeneous spend basis");
    expect(normalizeWhitespace(text)).toContain("No context-inventory evidence available");
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

  it("makes partial pricing coverage visible instead of folding missing rows into zero", () => {
    const records: UsageRecord[] = [
      {
        id: "priced",
        timestamp: "2026-08-08T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated", observedFrom: "test" },
        model: "gpt-5.6-sol",
        inputTokens: 1_000,
        outputTokens: 100,
        amountUsd: 0.01,
        costConfidence: "estimated",
        agentId: "codex",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate"
      },
      {
        id: "unsupported-total-only",
        timestamp: "2026-08-08T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "missing", observedFrom: "test" },
        model: "gpt-5.6-sol",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: null,
        costConfidence: "missing",
        agentId: "codex",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate"
      }
    ];

    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs"
    });
    expect(normalizeWhitespace(text)).toContain("$0.01 API-equivalent/estimated · 1 record missing cost");
    expect(text).toContain("● missing");
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

  it("strips ANSI, OSC hyperlinks, and control-line injection from terminal metadata", async () => {
    const [sampleRecord] = await sample();
    const records: UsageRecord[] = [{
      ...sampleRecord!,
      id: "hostile-terminal-metadata",
      source: {
        ...sampleRecord!.source,
        id: "safe-source\u001b[31mRED\u001b[0m\nFORGED",
        name: "source\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007"
      },
      model: "safe-model\u001b[2J\rFORGED-MODEL",
      projectId: "safe-project\u009b31mC1-COLOR\u0000END",
      operation: "safe-operation\u001b]0;hostile-title\u0007"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      width: 120,
      groupBy: "source",
      nextSteps: ["safe next\nFORGED-NEXT\u001b[32mGREEN\u001b[0m"]
    });

    expect(text).toContain("safe-sourceRED");
    expect(text).toContain("safe next FORGED-NEXTGREEN");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("hostile-title");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("safe next\nFORGED-NEXT");
  });
});
