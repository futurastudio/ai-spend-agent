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

describe("RECOMMEND grouped collapse (0.9.3 founder feedback)", () => {
  // Five near-identical "Investigate cumulative context in claude-code ·
  // <project>" entries (only the amount changed) collapse into ONE grouped
  // recommendation with per-project amounts; different-kind items follow.
  function contextRecord(project: string, index: number, amountUsd: number): UsageRecord {
    return {
      id: `local-ctx-${project}-${index}`,
      timestamp: "2026-08-11T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local logs", provider: "anthropic", confidence: "estimated", observedFrom: "fixture" },
      model: "claude-opus-4-8",
      inputTokens: 150_000,
      outputTokens: 4_000,
      amountUsd,
      costConfidence: "estimated",
      projectId: project,
      agentId: "claude-code",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    } as UsageRecord;
  }

  it("collapses the per-project fan-out of one action kind into one grouped entry", () => {
    const projects: Array<[string, number]> = [
      ["agent-finops", 1274.2],
      ["action-verifier", 408.4],
      ["tilden-web", 99.9],
      ["glance-macos", 55.5],
      ["tiktok-pipeline", 22.2]
    ];
    const records = projects.map(([project, amount], index) => contextRecord(project, index, amount));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs"
    });
    const normalized = normalizeWhitespace(text);

    // ONE grouped headline, not five numbered near-duplicates.
    expect(text.match(/Investigate cumulative context in claude-code/gu)).toHaveLength(1);
    expect(text).not.toContain("2. Investigate cumulative context");
    // The across-line carries per-project detail, largest first, ~rounded.
    expect(normalized).toContain("across 5 projects — agent-finops ~$1,274 · action-verifier ~$408 · tilden-web ~$100 · glance-macos ~$56 · + 1 more");
    // Shared guidance renders once; combined grounding sums the aggregates.
    expect(text).toContain("Inspect per-session context");
    expect(normalized).toContain("5 daily aggregates");
    // Observed-value discipline: no modeled ~$/mo is invented for the group.
    expect(text).toContain("reduction unproven");
  });

  it("a single-project action renders exactly as before (no grouping artifacts)", () => {
    const records = [contextRecord("agent-finops", 0, 1274.2)];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs"
    });
    expect(text).toContain("Investigate cumulative context in claude-code · agent-finops");
    expect(text).not.toMatch(/across \d+ projects/u);
  });
});

describe("RECOMMEND collapse never fabricates groups (adversary F1)", () => {
  // Identical titles do NOT imply one action for kinds other than
  // context_trim: two cache actions on the same operation with different
  // models, or two batch actions from different sources, are genuinely
  // different recommendations and must keep their own ranks.
  function connectedCall(
    id: string,
    source: string,
    model: string,
    fingerprint: string | undefined,
    batchEligible: boolean,
    hour: number
  ): UsageRecord {
    return {
      id,
      timestamp: `2026-08-11T${String(hour).padStart(2, "0")}:00:00.000Z`,
      source: { id: source, name: source, provider: "openai", confidence: "estimated", observedFrom: "fixture" },
      model,
      operation: "research_summary",
      inputTokens: 20_000,
      outputTokens: 2_000,
      amountUsd: 12.5,
      costConfidence: "estimated",
      usageGranularity: "call",
      workloadSemantics: {
        ...(fingerprint !== undefined ? { stableInputFingerprint: fingerprint } : {}),
        ...(batchEligible ? { batchEligible: true } : {})
      }
    } as UsageRecord;
  }

  it("two cache actions on the same operation but different models never merge", () => {
    // Same operation → identical "Cache repeated research_summary calls"
    // titles; different model+fingerprint → two distinct cache actions.
    const records = [
      connectedCall("a-1", "api-a", "gpt-5.5", "fp-alpha", false, 1),
      connectedCall("a-2", "api-a", "gpt-5.5", "fp-alpha", false, 2),
      connectedCall("a-3", "api-a", "gpt-5.5", "fp-alpha", false, 3),
      connectedCall("b-1", "api-a", "gpt-5.5-mini", "fp-beta", false, 4),
      connectedCall("b-2", "api-a", "gpt-5.5-mini", "fp-beta", false, 5),
      connectedCall("b-3", "api-a", "gpt-5.5-mini", "fp-beta", false, 6)
    ];
    const text = generatePlainEnglishSummary(analyzeSpend(records), { records, color: false });
    expect(text.match(/Cache repeated research_summary calls/gu)?.length).toBe(2);
    expect(text).not.toMatch(/across \d+ projects/u);
    expect(text).not.toContain("this project");
  });

  it("two batch actions from different sources never merge", () => {
    const records = [
      connectedCall("s1-1", "source-one", "gpt-5.5", undefined, true, 1),
      connectedCall("s1-2", "source-one", "gpt-5.5", undefined, true, 2),
      connectedCall("s1-3", "source-one", "gpt-5.5", undefined, true, 3),
      connectedCall("s2-1", "source-two", "gpt-5.5", undefined, true, 4),
      connectedCall("s2-2", "source-two", "gpt-5.5", undefined, true, 5),
      connectedCall("s2-3", "source-two", "gpt-5.5", undefined, true, 6)
    ];
    const text = generatePlainEnglishSummary(analyzeSpend(records), { records, color: false });
    expect(text.match(/Move research_summary calls to the Batch API/gu)?.length).toBe(2);
    expect(text).not.toMatch(/across \d+ projects/u);
    expect(text).not.toContain("this project");
  });
});

describe("cross-surface parity (terminal side)", () => {
  function localDayRecord(
    id: string,
    project: string,
    model: string,
    amountUsd: number,
    day: number
  ): UsageRecord {
    return {
      id,
      timestamp: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      source: { id: "local-agent-logs", name: "Local logs", provider: "anthropic", confidence: "estimated", observedFrom: "fixture" },
      model,
      inputTokens: 10_000,
      outputTokens: 1_000,
      amountUsd,
      costConfidence: "estimated",
      projectId: project,
      agentId: "claude-code",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    } as UsageRecord;
  }

  it("D1: the $15.995 half-cent boundary renders $16.00 on the group-by model surface", () => {
    // The corpus defect: 6.452 + 0.3563 + 9.1867 = 15.995 exactly rendered
    // ~$15.99 in the terminal but $16.00 in report.md/html.
    const records = [
      localDayRecord("m-1", "app", "claude-opus-4-8", 6.452, 5),
      localDayRecord("m-2", "app", "claude-opus-4-8", 0.3563, 6),
      localDayRecord("m-3", "app", "claude-opus-4-8", 9.1867, 7)
    ];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records, color: false, mode: "local-logs", view: "breakdown", groupBy: "model"
    });
    expect(text).toContain("$16.00");
    expect(text).not.toContain("$15.99");
  });

  it("D3: an 11-project table shows 10 rows plus an explicit +1 more row that reconciles to the total", () => {
    const amounts = [1443.49, 407.74, 81.49, 58.65, 49.86, 28.27, 19.43, 9.18, 4.93, 1.39, 0.62];
    const records = amounts.map((amountUsd, index) =>
      localDayRecord(`p-${index}`, `project-${String(index).padStart(2, "0")}`, "claude-opus-4-8", amountUsd, 5 + index));
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records, color: false, mode: "local-logs", view: "breakdown", groupBy: "project"
    });
    // The smallest project no longer vanishes silently.
    expect(text).toContain("+1 more");
    expect(text).toContain("~$0.62");
    // Visible rows + the overflow row reconcile to the header total.
    const rowAmounts = [...text.matchAll(/~\$(\d+\.\d{2})/gu)].map((match) => Number(match[1]));
    const tableSum = rowAmounts.reduce((total, value) => total + value, 0);
    expect(Math.abs(tableSum - 2105.05)).toBeLessThan(0.02);
  });

  it("tilde parity: the --full project table carries the same approximation markers as --group-by", () => {
    const records = [
      localDayRecord("t-1", "alpha", "claude-opus-4-8", 100.25, 5),
      localDayRecord("t-2", "beta", "claude-opus-4-8", 50.5, 6)
    ];
    const summary = analyzeSpend(records);
    const full = generatePlainEnglishSummary(summary, { records, color: false, mode: "local-logs", view: "full" });
    const grouped = generatePlainEnglishSummary(summary, {
      records, color: false, mode: "local-logs", view: "breakdown", groupBy: "model"
    });
    // Same renderer, same tilde discipline: the table embedded in --full
    // (model dimension here, $150.75 total row) marks approximation exactly
    // like the standalone --group-by table. Before the fix --full rendered
    // the identical row WITHOUT the tilde.
    expect(full).toContain("~$150.75");
    expect(grouped).toContain("~$150.75");
    expect(full).not.toMatch(/│\s*\$150\.75/u);
  });
});

describe("overflow-row reconciliation (0.9.4 founder fix)", () => {
  function pennyRecord(id: string, project: string, amountUsd: number, day: number): UsageRecord {
    return {
      id,
      timestamp: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      source: { id: "local-agent-logs", name: "Local logs", provider: "anthropic", confidence: "estimated", observedFrom: "fixture" },
      model: "claude-opus-4-8",
      inputTokens: 10_000,
      outputTokens: 1_000,
      amountUsd,
      costConfidence: "estimated",
      projectId: project,
      agentId: "claude-code",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    } as UsageRecord;
  }

  it("the +N-more amount is header-minus-displayed-rows, so the column reconciles by construction", () => {
    // Engineered penny exposure: ten $1.005 rows each display $1.01
    // (half-up), so displayed rows sum $10.10 while the raw total is
    // $10.67. An independently rounded remainder ($0.62) would make the
    // column sum $10.72 — 5 cents off the header. The founder hit the
    // 1-cent version of this live ($2,192.30 vs $2,192.31).
    const records = [
      ...Array.from({ length: 10 }, (_, index) =>
        pennyRecord(`p-${index}`, `proj-${String(index).padStart(2, "0")}`, 1.005, 5 + index)),
      pennyRecord("p-hidden", "proj-10", 0.62, 15)
    ];
    const text = generatePlainEnglishSummary(analyzeSpend(records), {
      records, color: false, mode: "local-logs", view: "breakdown", groupBy: "project"
    });
    expect(text).toContain("+1 more");
    // Reconciled remainder: $10.67 header − $10.10 displayed rows = $0.57
    // (NOT the raw hidden $0.62).
    expect(text).toContain("~$0.57");
    expect(text).not.toContain("~$0.62");
    const rowAmounts = [...text.matchAll(/~\$(\d+\.\d{2})/gu)].map((match) => Number(match[1]));
    const tableSum = rowAmounts.reduce((total, value) => total + value, 0);
    expect(tableSum).toBeCloseTo(10.67, 2);
  });
});
