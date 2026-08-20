import { describe, expect, it } from "vitest";
import { analyzeSpend, loadSampleUsageData, type UsageRecord } from "@agent-finops/core";
import { generatePlainEnglishSummary, groupByDimensions } from "./terminal.js";

// Copy assertions follow the C-lane result-centralization design (§1.2/§1.5):
// every money label routes through the basis vocabulary (committed /
// API-equivalent / billed); killed synonyms — "cost/value", "observed value",
// "API-equivalent/estimated", "Value"/"Evidence" amount headers — were
// replaced with the signed-off forms across these expectations.

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
    expect(text).toContain("ILLUSTRATIVE EVIDENCE");
    expect(text).toContain("Illustrative evidence by source");
    expect(text).toContain("Illustrative evidence by model");
    // C-lane §1.2: "Evidence" is killed as an amount column header — the
    // basis-neutral "Amount" replaces it on unpriced/demo bases.
    expect(text).toContain("Amount");
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

    expect(normalized).toContain("API-EQUIVALENT VALUE UNAVAILABLE evidence-labeled financial view Unavailable");
    expect(text).toContain("value unavailable · share unavailable");
    expect(text).not.toContain("Not priced");
    expect(normalized).not.toContain("API-EQUIVALENT VALUE evidence-labeled financial view $0.00");
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
        projectId: "missing-proj",
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
    const missingRow = text.split("\n").find((line) => line.includes("missing-proj"));

    expect(missingRow).toContain("Unavailable");
    expect(missingRow).toContain("missing");
    expect(missingRow).not.toContain("$0.00");
    expect(missingRow).not.toContain("0%");
    expect(text).toContain("npx aibill --full");
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
    expect(text).toContain("Illustrative evidence by agent");
    expect(text).toContain("agent-analyst");
  });

  it("supports every declared group-by dimension", async () => {
    const records = await sample();
    const summary = analyzeSpend(records);
    for (const dimension of groupByDimensions) {
      const text = generatePlainEnglishSummary(summary, { records, color: false, groupBy: dimension });
      expect(text).toContain("Illustrative evidence by");
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
      text.indexOf("API-EQUIVALENT VALUE"),
      text.indexOf("1 · DIAGNOSE"),
      text.indexOf("Where API-equivalent value goes"),
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
    expect(connected).toContain("BILLED COST");
    expect(connected).toMatch(/\u001b\[33m\u001b\[1mmodel ~\$/);
    expect(connected).toMatch(/\u001b\[33m\u001b\[1m~\$/);
    expect(connected).not.toMatch(/\u001b\[32m\u001b\[1m(?:model|~\$)/);
    expect(local).toContain("\u001b[33m\u001b[1mLOCAL ESTIMATE\u001b[22m\u001b[39m");
    expect(local).toMatch(/\u001b\[1m\u001b\[33m\$87\.00/);
    expect(local).not.toContain("\u001b[31m");
  });

  it("never relabels connected estimates as provider-reported cost", async () => {
    // C-lane QA finding M2: an estimated dollar is API-equivalent ONLY when
    // priced at published API rates. These sample rows carry a generic
    // connector cost type, so the honest basis is detected (unverified) —
    // and it must still never be promoted to billed/provider-reported.
    const records = (await sample()).filter((record) => record.costConfidence === "estimated");
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected"
    });

    expect(text).toContain("CONNECTED · ESTIMATED");
    expect(text).toContain("CONNECTED DETECTED (UNVERIFIED)");
    expect(text).toContain("Where connected detected (unverified) appears");
    expect(text).toContain("Connected detected (unverified) by model");
    expect(text).not.toContain("BILLED COST");
    expect(text).not.toContain("Where billed cost goes");
    expect(text).not.toContain("Billed cost by model");
  });

  it("keeps API-rate-priced connected estimates on the API-equivalent basis with marked figures", () => {
    // The one connected source that IS priced at published API rates keeps
    // the API-equivalent heading, and every figure of that basis carries ~
    // (§1.2 marker rule / QA MINOR-3).
    const records: UsageRecord[] = [{
      id: "anthropic-usage-estimated",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "anthropic-usage", name: "Anthropic usage", provider: "anthropic", confidence: "estimated", observedFrom: "Usage API" },
      model: "claude-sonnet-4-6",
      inputTokens: 1_000,
      outputTokens: 100,
      amountUsd: 5,
      costConfidence: "estimated",
      providerCostType: "anthropic_claude_code_usage",
      usageGranularity: "daily_aggregate"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected",
      width: 120
    });
    expect(text).toContain("CONNECTED API-EQUIVALENT (ESTIMATED)");
    expect(text).toContain("Where connected API-equivalent (estimated) appears");
    expect(text).toContain("~$5.00");
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
    expect(text).toContain("BILLED COST");
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

    expect(normalized).toContain("API-EQUIVALENT VALUE evidence-labeled financial view <$0.01 tracked");
    expect(normalized).not.toContain("API-EQUIVALENT VALUE evidence-labeled financial view $0.00");
    expect(normalized).toContain("evidence mix: <$0.01 API-equivalent (estimated)");
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

    expect(normalizeWhitespace(text)).toContain("CONNECTED EVIDENCE UNAVAILABLE evidence-labeled financial view Unavailable");
    expect(text).toContain("value unavailable · share unavailable");
    expect(text).not.toContain("Not priced");
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
    expect(normalizeWhitespace(text)).toContain("$0.01 API-equivalent (estimated) · 1 record missing cost");
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

  it("renders a compact decision receipt with one grounded action and one details CTA", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "compact",
      width: 72
    });
    const normalized = normalizeWhitespace(text);

    expect(text).toContain("aibill · LOCAL ESTIMATE");
    expect(text).toContain("~$87.00");
    expect(text).toContain("API-equivalent value · not billed spend");
    expect(text).toContain("Primary driver");
    expect(text).toContain("Evidence");
    expect(normalized).toMatch(/\d+ calls? · ~\$[\d.]+ API-equivalent value · (estimated|detected\/unverified)/u);
    expect(text.match(/^  Next\s/gmu)).toHaveLength(1);
    expect(text.match(/^  › npx aibill apply$/gmu)).toHaveLength(1);
    expect(text.match(/npx aibill --full/gu)).toHaveLength(1);
    expect(text).not.toContain("1 · DIAGNOSE");
    expect(text).not.toContain("2 · RECOMMEND");
    expect(text).not.toContain("┌");
  });

  it("keeps the compact sample boundary non-executable and gives one acquisition step", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "demo",
      view: "compact"
    });

    expect(text).toContain("DEMO SAMPLE");
    expect(text).toContain("no user data · no action authorized");
    expect(text).toContain("Read your own local evidence");
    expect(text).toContain("npx aibill init");
    expect(text).toContain("npx aibill --sample --full");
    expect(text).not.toContain("npx aibill apply");
  });

  it("renders a compact no-price state as unavailable with one coverage diagnostic", () => {
    const records: UsageRecord[] = [{
      id: "gemini-missing-compact",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "google", confidence: "missing", observedFrom: "fixture" },
      model: "gemini-future-unknown",
      inputTokens: 100,
      outputTokens: 10,
      amountUsd: null,
      costConfidence: "missing",
      agentId: "gemini-cli",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "compact"
    });
    const normalized = normalizeWhitespace(text);

    expect(normalized).toContain("Unavailable local activity found · financial evidence missing");
    expect(normalized).toContain("Primary activity gemini-cli · agent · financial evidence unavailable");
    expect(normalized).toContain("1 record missing cost");
    expect(text).toContain("npx aibill doctor --sources");
    expect(text).not.toContain("npx aibill apply");
    expect(text).not.toContain("0%");
    expect(text).not.toContain("$0.00");
  });

  it("does not overflow or render a fixed table in the narrow compact tier", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "compact",
      width: 40
    });

    for (const line of text.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(40);
    }
    expect(text).toContain("PRIMARY DRIVER");
    expect(text).toContain("DETAILS");
    expect(text).toContain("npx aibill --full");
    expect(text).not.toContain("┌");
    expect(text).not.toContain("│");
  });

  it("degrades the full-audit table to a narrow list without overflowing", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "full",
      width: 54
    });

    for (const line of text.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(54);
    }
    expect(text).toContain("1 · DIAGNOSE");
    expect(text).not.toContain("┌");
    expect(text).not.toContain("│");
  });

  it("keeps the default full table within 72 columns without truncating its evidence label", async () => {
    const records = await sample();
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "demo",
      view: "full",
      width: 72
    });

    for (const line of text.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(72);
    }
    expect(text).toContain("detected/unverified");
    expect(text).not.toContain("detected/unverif…");
  });

  it("keeps provider-reported compact cost exact and untilded", async () => {
    const records = (await sample()).map((record) => ({
      ...record,
      costConfidence: "verified" as const,
      source: { ...record.source, confidence: "verified" as const }
    }));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected",
      view: "compact"
    });

    expect(text).toContain("CONNECTED · PROVIDER-REPORTED");
    expect(normalizeWhitespace(text)).toContain("$87.00 billed cost (provider-reported)");
    expect(text).toContain("Primary driver");
    expect(text).not.toContain("(unmapped) · agent");
    expect(text).not.toContain("~$87.00");
  });

  it("never blends provider-reported cost with estimated value in compact or full views", () => {
    const records: UsageRecord[] = [{
      id: "openai-verified",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified", observedFrom: "Costs API" },
      model: "gpt-5.6",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 10,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    }, {
      id: "anthropic-estimated",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "anthropic-usage", name: "Anthropic usage", provider: "anthropic", confidence: "estimated", observedFrom: "Usage API" },
      model: "claude-sonnet-4-6",
      inputTokens: 1_000,
      outputTokens: 100,
      amountUsd: 5,
      costConfidence: "estimated",
      providerCostType: "anthropic_claude_code_usage",
      usageGranularity: "daily_aggregate"
    }];

    for (const view of ["compact", "full"] as const) {
      const text = generatePlainEnglishSummary(analyzeSpend(records), {
        records,
        color: false,
        mode: "connected",
        view,
        width: 120
      });
      const normalized = normalizeWhitespace(text);
      expect(text).toContain("CONNECTED · MIXED EVIDENCE");
      expect(normalized).toContain("$10.00 provider-reported");
      expect(normalized).toContain("$5.00 API-equivalent (estimated)");
      expect(text).not.toContain("$15.00");
    }
  });

  it("discloses a dominant unattributed project bucket instead of promoting a smaller named project", () => {
    const records: UsageRecord[] = [{
      id: "home-heavy",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated", observedFrom: "fixture" },
      model: "gpt-5-mini",
      inputTokens: 10,
      outputTokens: 2,
      amountUsd: 81,
      costConfidence: "estimated",
      projectId: "(home)",
      agentId: "codex",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    }, {
      id: "named-project",
      timestamp: "2026-08-14T01:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated", observedFrom: "fixture" },
      model: "gpt-5-mini",
      inputTokens: 10,
      outputTokens: 2,
      amountUsd: 19,
      costConfidence: "estimated",
      projectId: "agent-finops",
      agentId: "codex",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "compact"
    });

    expect(normalizeWhitespace(text)).toContain("Primary activity Unattributed project · ~$81.00 API-equivalent value · 81% of priced evidence");
    expect(text).not.toContain("Primary driver agent-finops · project");
  });

  it("uses a runnable diagnostic when connected evidence has no action candidate", () => {
    const records: UsageRecord[] = [{
      id: "quiet-connected-record",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "openai-costs", name: "OpenAI costs", provider: "openai", confidence: "verified", observedFrom: "Costs API" },
      model: "gpt-5-mini",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 1,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "connected",
      view: "compact"
    });

    expect(text).toContain("Inspect connected source coverage");
    expect(normalizeWhitespace(text)).toContain("Primary driver openai-costs · source");
    expect(text).toContain("npx aibill doctor --sources");
    expect(text).not.toContain("npx aibill sync-provider");
  });

  it("does not advertise Apply or a shell pipe when no evidence candidate exists", () => {
    const records: UsageRecord[] = [{
      id: "quiet-local-record",
      timestamp: "2026-08-14T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "openai", confidence: "estimated", observedFrom: "fixture" },
      model: "gpt-5-mini",
      inputTokens: 10,
      outputTokens: 2,
      amountUsd: 0.01,
      costConfidence: "estimated",
      agentId: "codex",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    }];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "full"
    });

    expect(text).not.toContain("3 · APPLY");
    expect(text).not.toContain("npx aibill apply");
    expect(text).toContain("3 · VERIFY");
    expect(text).toContain("npx aibill connect openai");
    expect(text).toContain("npx aibill connect anthropic");
    expect(text).not.toContain("anthropic|openai");
  });
});
