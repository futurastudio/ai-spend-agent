import { describe, expect, it } from "vitest";
import {
  analyzeSpend,
  resultCardKilledTerms,
  type DetectedPlan,
  type UsageRecord
} from "@agent-finops/core";
import { generatePlainEnglishSummary, type PlainEnglishSummaryOptions } from "./terminal.js";

/**
 * Golden-output tests for the C-lane canonical result card on the CLI
 * default receipt and the --full header (design §1.4/§1.5/§3). Character
 * counts reproduce the design's script-verified measurements.
 */

let recordCounter = 0;

function localRecord(input: {
  agent: "claude-code" | "codex";
  amountUsd: number;
  projectId?: string;
}): UsageRecord {
  recordCounter += 1;
  return {
    id: `rc-${recordCounter}`,
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: input.agent === "claude-code" ? "anthropic" : "openai",
      confidence: "estimated",
      observedFrom: "local transcript"
    },
    model: input.agent === "claude-code" ? "claude-opus-4-6" : "gpt-5.6-sol",
    inputTokens: 100,
    outputTokens: 10,
    amountUsd: input.amountUsd,
    costConfidence: "estimated",
    agentId: input.agent,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    providerCostType: "local_agent_logs",
    usageGranularity: "daily_aggregate"
  };
}

function cursorRecord(amountUsd: number, costConfidence: "estimated" | "verified" = "estimated"): UsageRecord {
  recordCounter += 1;
  return {
    id: `rc-cursor-${recordCounter}`,
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "cursor-provider-api",
      name: "Cursor Admin API",
      provider: "cursor",
      confidence: costConfidence,
      observedFrom: "provider API"
    },
    model: "cursor-team-usage",
    inputTokens: 0,
    outputTokens: 0,
    amountUsd,
    costConfidence,
    userId: "user@example.com",
    projectId: "cursor-team",
    providerCostType: "cursor_spend",
    usageGranularity: "user_aggregate"
  };
}

const claudePlan: DetectedPlan = {
  agent: "claude-code",
  provider: "anthropic",
  planId: "claude-max-5x",
  planLabel: "Claude Max 5x",
  billing: "subscription",
  source: "~/.claude.json"
};

const codexPlan: DetectedPlan = {
  agent: "codex",
  provider: "openai",
  planId: "chatgpt-pro",
  planLabel: "ChatGPT Pro",
  billing: "subscription",
  source: "~/.codex/auth.json"
};

/** §1.4 fixture: claude 412.18 across projects, codex 70.02 unattributed, cursor 12.40 beta. */
function canonicalRecords(): UsageRecord[] {
  return [
    localRecord({ agent: "claude-code", amountUsd: 210.10, projectId: "tilden-web" }),
    localRecord({ agent: "claude-code", amountUsd: 122.05, projectId: "agent-finops" }),
    localRecord({ agent: "claude-code", amountUsd: 20.01, projectId: "proj-a" }),
    localRecord({ agent: "claude-code", amountUsd: 15.02, projectId: "proj-b" }),
    localRecord({ agent: "claude-code", amountUsd: 12.00, projectId: "proj-c" }),
    localRecord({ agent: "claude-code", amountUsd: 11.00, projectId: "proj-d" }),
    localRecord({ agent: "claude-code", amountUsd: 11.00, projectId: "proj-e" }),
    localRecord({ agent: "claude-code", amountUsd: 11.00, projectId: "proj-f" }),
    localRecord({ agent: "codex", amountUsd: 70.02 }),
    cursorRecord(12.40)
  ];
}

function render(
  records: UsageRecord[],
  overrides: Partial<PlainEnglishSummaryOptions> = {}
): string {
  return generatePlainEnglishSummary(analyzeSpend(records), {
    records,
    color: false,
    mode: "local-logs",
    view: "compact",
    width: 72,
    windowDays: 30,
    detectedPlans: [claudePlan, codexPlan],
    ...overrides
  });
}

const cursorPlanPriced = [{ provider: "cursor", planLabel: "Pro", committedUsdPerMonth: 20 }];

describe("compact card — canonical fixture (§1.4)", () => {
  const text = () => render(canonicalRecords(), { providerPlans: cursorPlanPriced });

  it("renders the §1.4 subscription rows verbatim with script-verified widths", () => {
    const output = text();
    const claudeRow = "    claude    Max 5x      $100/mo committed     ~$412 API-equivalent";
    const chatgptRow = "    chatgpt   Pro         $200/mo committed      ~$70 API-equivalent";
    const cursorRow = "    cursor    Pro          $20/mo committed     billed n/r";
    expect(output).toContain("  Subscriptions   30d window");
    expect(output).toContain(claudeRow);
    expect(output).toContain(chatgptRow);
    expect(output).toContain(cursorRow);
    // Design-measured: claude/chatgpt rows 68 · cursor row 58.
    expect([...claudeRow].length).toBe(68);
    expect([...chatgptRow].length).toBe(68);
    expect([...cursorRow].length).toBe(58);
  });

  it("renders the labeled totals stack — never one blended number (QA-2)", () => {
    const output = text();
    const totalLine = "  Total   committed $320/mo · API-equivalent ~$482";
    expect(output).toContain(totalLine);
    expect([...totalLine].length).toBe(50);
    expect(output).toContain("two kinds of money — never added into one number");
    expect(output).toContain("cursor beta: billed unlocks after live verification");
    expect(output).toContain("n/r = not reported — no evidence in this window");
    // No blended figure exists anywhere near a total.
    expect(output).not.toContain("$814");
    expect(output).not.toContain("$502");
  });

  it("renders by-project rows that reconcile with largest-remainder shares (§3/QA-8)", () => {
    const output = text();
    const line1 = "  By project     tilden-web ~$210 (44%) · agent-finops ~$122 (25%)";
    const line2 = "                 unattributed ~$70 (14%)";
    const line3 = "                 everything else ~$80 (17% · 6 projects)";
    expect(output).toContain(line1);
    expect(output).toContain(line2);
    expect(output).toContain(line3);
    // Design-measured: 66/40/56.
    expect([...line1].length).toBe(66);
    expect([...line2].length).toBe(40);
    expect([...line3].length).toBe(56);
    // Printed shares sum to exactly 100 (largest remainder).
    expect(44 + 25 + 14 + 17).toBe(100);
  });

  it("keeps cursor money in Evidence only — decision (f)/B2 (QA-3)", () => {
    const output = text();
    const evidence1 = "  Evidence       ~$482 API-equivalent (estimated)";
    const evidence2 = "                 $12.40 cursor detected (unverified · beta connector)";
    expect(output).toContain(evidence1);
    expect(output).toContain(evidence2);
    // Design-measured: 49/69.
    expect([...evidence1].length).toBe(49);
    expect([...evidence2].length).toBe(69);
    // $12.40 appears ONLY in the Evidence disclosure — never in a row's
    // money column, never in the Total stack, never as billed.
    const occurrences = output.split("$12.40").length - 1;
    expect(occurrences).toBe(1);
    expect(output).not.toContain("$12.40 billed");
    expect(output).not.toContain("~$12.40");
  });

  it("keeps ~ and billed apart within every segment (QA-1)", () => {
    const output = text();
    for (const line of output.split("\n")) {
      for (const segment of line.split(" · ")) {
        expect(
          segment.includes("~") && segment.includes("billed"),
          `~/billed collision in segment: ${segment}`
        ).toBe(false);
      }
    }
  });

  it("prints no killed vocabulary (QA-10)", () => {
    const output = text();
    for (const killed of resultCardKilledTerms) {
      expect(output).not.toContain(killed);
    }
    // n/r never prints without its legend.
    if (output.includes("n/r")) {
      expect(output).toContain("n/r = not reported");
    }
  });

  it("stays within 72 columns everywhere (QA-4)", () => {
    for (const line of text().split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(72);
    }
  });

  it("keeps the compact card's Next and Details footer", () => {
    const output = text();
    expect(output).toContain("Next");
    expect(output).toContain("npx aibill --full");
  });
});

describe("compact card — state variants (§1.4)", () => {
  it("cursor connected but unpriced: committed n/r · billed n/r with a flagged partial sum", () => {
    const output = render(canonicalRecords());
    const cursorRow = "    cursor    connected   committed n/r · billed n/r";
    const totalLine = "  Total   committed $300/mo (2/3 priced) · API-equivalent ~$482";
    expect(output).toContain(cursorRow);
    expect(output).toContain(totalLine);
    // Design-measured: row 52, Total 63 — a partial committed sum is never bare.
    expect([...cursorRow].length).toBe(52);
    expect([...totalLine].length).toBe(63);
    expect(output).not.toContain("committed $300/mo ·");
  });

  it("plan detected with no transcript evidence renders API-equivalent n/r (partial connection)", () => {
    const output = render(
      canonicalRecords().filter((record) => record.agentId === "claude-code"),
      { providerPlans: cursorPlanPriced }
    );
    const chatgptRow = "    chatgpt   Pro         $200/mo committed     API-equivalent n/r";
    expect(output).toContain(chatgptRow);
    expect([...chatgptRow].length).toBe(66);
    expect(output).toContain("n/r = not reported");
  });

  it("zero usage in window: all-n/r totals with the day-one legend (QA-6)", () => {
    const output = render([]);
    expect(output).toContain("    claude    Max 5x      $100/mo committed     API-equivalent n/r");
    expect(output).toContain("    chatgpt   Pro         $200/mo committed     API-equivalent n/r");
    // §1.4 zero-usage variant (committed sums its own two rows: $300).
    const totalLine = "  Total   committed $300/mo · API-equivalent n/r";
    expect(output).toContain(totalLine);
    expect([...totalLine].length).toBe(48);
    const legend = "n/r = not reported — no usage evidence in this window yet";
    expect(output).toContain(legend);
    expect(output).not.toContain("By project");
    expect(output).not.toContain("$0.00");
  });

  it("single sub compresses the stack — no stack theater for one row", () => {
    const output = render(
      canonicalRecords().filter((record) => record.agentId === "claude-code"),
      { detectedPlans: [claudePlan] }
    );
    const totalLine = "  Total   committed $100/mo · API-equivalent ~$412";
    expect(output).toContain(totalLine);
    expect(output).not.toContain("kinds of money");
  });

  it("explains a total that exceeds the row sums — claude sub + codex API key (QA finding M1)", () => {
    // codex runs on an API key: NO codex subscription row, but its $70.02 of
    // API-equivalent evidence still belongs to the basis-wide total (§1.1).
    const output = render(canonicalRecords().filter((record) => record.source.provider !== "cursor"), {
      detectedPlans: [claudePlan]
    });
    expect(output).toContain("    claude    Max 5x      $100/mo committed     ~$412 API-equivalent");
    expect(output).not.toContain("chatgpt");
    const totalLine = "  Total   committed $100/mo · API-equivalent ~$482";
    expect(output).toContain(totalLine);
    // The $70 gap between the row (~$412) and the total (~$482) is explained
    // ON the card — never left as silent arithmetic.
    const gapNote = "includes ~$70 from agents without a detected subscription";
    expect(output).toContain(gapNote);
    expect([...`          ${gapNote}`].length).toBeLessThanOrEqual(72);
    // The note precedes the legend/beta notes and sits under Total.
    expect(output.indexOf(gapNote)).toBeGreaterThan(output.indexOf(totalLine));
  });

  it("explains the gap in the narrow layout too (M1)", () => {
    const output = render(canonicalRecords().filter((record) => record.source.provider !== "cursor"), {
      detectedPlans: [claudePlan],
      width: 57
    });
    expect(output).toContain("  includes ~$70 with no detected subscription");
    for (const line of output.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(57);
    }
  });

  it("no subscriptions: falls back to today's single-basis headline", () => {
    const output = render(canonicalRecords().filter((record) => record.agentId === "codex"), {
      detectedPlans: []
    });
    expect(output).toContain("API-equivalent value · not billed spend");
    expect(output).not.toContain("Subscriptions");
    expect(output).not.toContain("Total   committed");
  });

  it("verified cursor dollars graduate to billed in rows and Total (aspirational variant)", () => {
    const records = [
      ...canonicalRecords().filter((record) => record.source.provider !== "cursor"),
      cursorRecord(12.40, "verified")
    ];
    const output = render(records, { providerPlans: cursorPlanPriced });
    const totalLine = "  Total   committed $320/mo · API-equivalent ~$482 · billed $12.40";
    expect(output).toContain(totalLine);
    expect([...totalLine].length).toBe(66);
    expect(output).toContain("$12.40 billed");
    expect(output).toContain("three kinds of money — never added into one number");
    expect(output).not.toContain("detected (unverified");
  });

  it("a verified cursor row never hijacks By-project away from local attribution (QA M3)", () => {
    const records = [
      ...canonicalRecords().filter((record) => record.source.provider !== "cursor"),
      cursorRecord(12.40, "verified")
    ];
    const output = render(records, { providerPlans: cursorPlanPriced });
    // The per-basis rule holds: local attribution stays the by-project view.
    expect(output).toContain("  By project     tilden-web ~$210 (44%) · agent-finops ~$122 (25%)");
    expect(output).toContain("                 unattributed ~$70 (14%)");
    expect(output).not.toContain("cursor-team");
    expect(output).not.toContain("(100%)");
    // The verified billed money still shows — in the Total stack and Evidence.
    expect(output).toContain("billed $12.40");
  });

  it("narrow (<58 col): label-above-value rows, no plan column, mandatory legend", () => {
    const output = render(canonicalRecords(), {
      providerPlans: cursorPlanPriced,
      width: 57
    });
    expect(output).toContain("  SUBSCRIPTIONS (30D)");
    expect(output).toContain("  claude $100/mo committed · ~$412");
    expect(output).toContain("  chatgpt $200/mo committed · ~$70");
    expect(output).toContain("  cursor $20/mo committed · billed n/r");
    expect(output).toContain("  TOTAL");
    expect(output).toContain("  committed $320/mo");
    expect(output).toContain("  API-equivalent ~$482");
    expect(output).toContain("~ = estimated at API rates · n/r = not reported");
    for (const line of output.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(57);
    }
  });
});

describe("narrow legend integrity (QA MINOR-1)", () => {
  it("splits the legend onto one line per part instead of wrapping mid-phrase", () => {
    const output = render(canonicalRecords(), {
      providerPlans: cursorPlanPriced,
      width: 46
    });
    expect(output).toContain("  ~ = estimated at API rates");
    expect(output).toContain("  n/r = not reported");
    expect(output).not.toContain("n/r = not\n");
    for (const line of output.split("\n")) {
      expect([...line].length, line).toBeLessThanOrEqual(46);
    }
  });
});

describe("--full header (§1.5)", () => {
  it("replaces the hero with the same Subscriptions + Total + By-project card", () => {
    const output = generatePlainEnglishSummary(analyzeSpend(canonicalRecords()), {
      records: canonicalRecords(),
      color: false,
      mode: "local-logs",
      view: "full",
      width: 72,
      windowDays: 30,
      detectedPlans: [claudePlan, codexPlan],
      providerPlans: cursorPlanPriced
    });
    expect(output).toContain("  Subscriptions   30d window");
    expect(output).toContain("  Total   committed $320/mo · API-equivalent ~$482");
    expect(output).toContain("  By project     tilden-web ~$210 (44%) · agent-finops ~$122 (25%)");
    // One card contract, two zoom levels — not two framings.
    expect(output).not.toContain("evidence-labeled financial view");
    // The four-section loop stays.
    expect(output).toContain("1 · DIAGNOSE");
    expect(output).toContain("2 · RECOMMEND");
  });

  it("never blends unverified dollars into the API-equivalent bars (QA M2)", () => {
    const records = canonicalRecords();
    const output = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "full",
      width: 72,
      windowDays: 30,
      detectedPlans: [claudePlan, codexPlan],
      providerPlans: cursorPlanPriced
    });
    // The DIAGNOSE bars/tables stay same-kind: the cross-kind $494.60 sum
    // must not exist, and cursor's $12.40 never rides an API-equivalent
    // heading or share computation.
    expect(output).not.toContain("494.60");
    expect(output).not.toContain("$494");
    const barsStart = output.indexOf("Where API-equivalent value goes");
    expect(barsStart).toBeGreaterThan(-1);
    const nextHeading = output.indexOf("Plan context");
    const diagnoseSection = output.slice(barsStart, nextHeading);
    expect(diagnoseSection).not.toContain("cursor");
    expect(diagnoseSection).not.toContain("12.40");
    // §1.2 marker rule (QA MINOR-3): every API-equivalent figure carries ~.
    expect(diagnoseSection).toContain("~$482.20");
    // The detected-unverified disclosure exists ON the --full screen (M2).
    expect(output).toContain("$12.40 cursor detected (unverified · beta connector)");
  });

  it("keeps the single-basis hero when no subscriptions are detected", () => {
    const records = canonicalRecords().filter((record) => record.agentId === "codex");
    const output = generatePlainEnglishSummary(analyzeSpend(records), {
      records,
      color: false,
      mode: "local-logs",
      view: "full",
      width: 72,
      detectedPlans: []
    });
    expect(output).toContain("API-EQUIVALENT VALUE");
    expect(output).toContain("evidence-labeled financial view");
  });
});
