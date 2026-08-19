import { describe, expect, it } from "vitest";
import type { DetectedPlan } from "./planDetection.js";
import {
  buildResultCard,
  buildResultCardProjectLine,
  clipResultCardProjectName,
  formatApproxUsd,
  formatBilledUsdExact,
  formatCommittedPerMonth,
  largestRemainderPercents,
  resultCardKilledTerms,
  resultCardSchema,
  resultCardVocabulary,
  type ResultCard,
  type ResultCardRunway
} from "./resultCard.js";
import type { UsageRecord } from "./schema.js";

/**
 * C-lane design §1.1/§1.4/§1.6 — canonical fixture. Every number reconciles:
 * claude ~$412.18 API-equivalent across tilden-web 210.10 + agent-finops
 * 122.05 + 6 others 80.03; codex ~$70.02 with NO project attribution;
 * cursor $12.40 detected (unverified — beta connector). API-equivalent total
 * 482.20; by-project rows 210.10 + 122.05 + 70.02 + 80.03 = 482.20.
 */

let recordCounter = 0;

function localRecord(input: {
  agent: "claude-code" | "codex";
  amountUsd: number;
  projectId?: string;
  costConfidence?: UsageRecord["costConfidence"];
  providerCostType?: string;
}): UsageRecord {
  recordCounter += 1;
  return {
    id: `record-${recordCounter}`,
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: input.agent === "claude-code" ? "anthropic" : "openai",
      confidence: input.costConfidence ?? "estimated",
      observedFrom: "local transcript"
    },
    model: input.agent === "claude-code" ? "claude-opus-4-6" : "gpt-5.6-sol",
    inputTokens: 100,
    outputTokens: 10,
    amountUsd: input.amountUsd,
    costConfidence: input.costConfidence ?? "estimated",
    agentId: input.agent,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    providerCostType: input.providerCostType ?? "local_agent_logs",
    usageGranularity: "daily_aggregate"
  };
}

function cursorRecord(amountUsd: number, costConfidence: "estimated" | "verified" = "estimated"): UsageRecord {
  recordCounter += 1;
  return {
    id: `cursor-${recordCounter}`,
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

const claudeRunways: ResultCardRunway[] = [
  { kind: "weekly", remainingPercent: 71, resetsAt: "2026-08-21T07:00:00Z" },
  { kind: "five-hour", remainingPercent: 38, resetsAt: "2026-08-17T19:00:00Z" }
];

const codexRunways: ResultCardRunway[] = [
  { kind: "weekly", remainingPercent: 52, resetsAt: "2026-08-20T07:00:00Z" }
];

/** claude project spread: 210.10 + 122.05 + (6 others = 80.03) = 412.18. */
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
    // codex evidence carries NO project attribution → the unattributed row.
    localRecord({ agent: "codex", amountUsd: 70.02 }),
    cursorRecord(12.40)
  ];
}

function canonicalCard(): ResultCard {
  return buildResultCard({
    mode: "mixed",
    windowDays: 30,
    records: canonicalRecords(),
    detectedPlans: [claudePlan, codexPlan],
    runways: { "claude-code": claudeRunways, codex: codexRunways },
    providerPlans: [{ provider: "cursor", planLabel: "Pro", committedUsdPerMonth: 20 }]
  });
}

describe("buildResultCard — canonical fixture (§1.4/§1.6)", () => {
  it("produces per-subscription rows in stable order with per-basis figures", () => {
    const card = canonicalCard();
    expect(card.kind).toBe("aibill.result_card");
    expect(card.schemaVersion).toBe(1);
    expect(card.currency).toBe("USD");
    expect(card.windowDays).toBe(30);
    expect(card.subscriptions.map((row) => row.id)).toEqual(["claude", "chatgpt", "cursor"]);

    const [claude, chatgpt, cursor] = card.subscriptions;
    expect(claude).toMatchObject({
      agentId: "claude-code",
      planLabel: "Max 5x",
      connection: "local_logs",
      committedUsdPerMonth: 100,
      apiEquivalentUsd: 412.18,
      providerBilledUsd: null,
      detectedUnverifiedUsd: null
    });
    expect(chatgpt).toMatchObject({
      agentId: "codex",
      planLabel: "Pro",
      committedUsdPerMonth: 200,
      apiEquivalentUsd: 70.02,
      providerBilledUsd: null,
      detectedUnverifiedUsd: null
    });
    // B2/decision (f): the beta cursor connector hard-codes estimated
    // confidence, so its dollars are disclosure-only — never billed.
    expect(cursor).toMatchObject({
      agentId: null,
      planLabel: "Pro",
      connection: "connected",
      committedUsdPerMonth: 20,
      apiEquivalentUsd: null,
      providerBilledUsd: null,
      detectedUnverifiedUsd: 12.40
    });
  });

  it("orders runways most-urgent first and caps at two (§1.1/C3 fix)", () => {
    const card = canonicalCard();
    const claude = card.subscriptions[0]!;
    expect(claude.runways).toEqual([
      { kind: "five-hour", remainingPercent: 38, resetsAt: "2026-08-17T19:00:00Z" },
      { kind: "weekly", remainingPercent: 71, resetsAt: "2026-08-21T07:00:00Z" }
    ]);
    expect(card.subscriptions[1]!.runways).toHaveLength(1);
    expect(card.subscriptions[2]!.runways).toHaveLength(0);
  });

  it("builds the labeled totals stack and never a blended figure (QA-2)", () => {
    const card = canonicalCard();
    expect(card.totals.subscriptionCommitted).toEqual({
      amountUsd: 320,
      pricedSubs: 3,
      totalSubs: 3
    });
    expect(card.totals.apiEquivalent).toEqual({
      amountUsd: 482.20,
      financialEvidence: "estimated"
    });
    // Cursor's detected-unverified $12.40 joins NO total (QA-14).
    expect(card.totals.providerBilled).toEqual({
      amountUsd: null,
      financialEvidence: "missing"
    });
    expect(card.totals.blended).toBeNull();
    expect(card.totals.blendPolicy).toBe("never_blended");
  });

  it("reconciles by-project rows + everything else exactly to the basis total (QA-8)", () => {
    const card = canonicalCard();
    expect(card.byProject).not.toBeNull();
    const byProject = card.byProject!;
    expect(byProject.basis).toBe("api_equivalent");
    expect(byProject.rows).toEqual([
      { project: "tilden-web", amountUsd: 210.10, share: 0.4357, unattributed: false },
      { project: "agent-finops", amountUsd: 122.05, share: 0.2531, unattributed: false },
      { project: "unattributed", amountUsd: 70.02, share: 0.1452, unattributed: true }
    ]);
    expect(byProject.everythingElse).toEqual({
      amountUsd: 80.03,
      share: 0.1660,
      projectCount: 6
    });
    const sum = byProject.rows.reduce((total, row) => total + row.amountUsd, 0) +
      byProject.everythingElse!.amountUsd;
    expect(sum).toBeCloseTo(482.20, 10);
    const shareSum = byProject.rows.reduce((total, row) => total + row.share, 0) +
      byProject.everythingElse!.share;
    expect(shareSum).toBeCloseTo(1.0000, 10);
  });

  it("prints display shares that sum to exactly 100 via largest remainder (§1.1)", () => {
    const card = canonicalCard();
    const byProject = card.byProject!;
    const weights = [
      ...byProject.rows.map((row) => row.amountUsd),
      byProject.everythingElse!.amountUsd
    ];
    expect(largestRemainderPercents(weights)).toEqual([44, 25, 14, 17]);
  });

  it("passes its own zod contract", () => {
    expect(() => resultCardSchema.parse(canonicalCard())).not.toThrow();
  });
});

describe("buildResultCard — state variants (§1.4)", () => {
  it("single sub: totals compress to that sub's figures", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: canonicalRecords().filter((record) => record.agentId === "claude-code"),
      detectedPlans: [claudePlan]
    });
    expect(card.subscriptions).toHaveLength(1);
    expect(card.totals.subscriptionCommitted).toEqual({ amountUsd: 100, pricedSubs: 1, totalSubs: 1 });
    expect(card.totals.apiEquivalent.amountUsd).toBe(412.18);
  });

  it("plan detected, no transcript evidence: apiEquivalentUsd null, never $0 (partial connection)", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: canonicalRecords().filter((record) => record.agentId === "claude-code"),
      detectedPlans: [claudePlan, codexPlan]
    });
    const chatgpt = card.subscriptions.find((row) => row.id === "chatgpt")!;
    expect(chatgpt.apiEquivalentUsd).toBeNull();
    expect(chatgpt.committedUsdPerMonth).toBe(200);
  });

  it("cursor connected with no priced plan: committed n/r; partial committed sums stay flagged", () => {
    const card = buildResultCard({
      mode: "mixed",
      records: canonicalRecords(),
      detectedPlans: [claudePlan, codexPlan]
      // no providerPlans: the cursor plan is not priced
    });
    const cursor = card.subscriptions.find((row) => row.id === "cursor")!;
    expect(cursor.planLabel).toBeNull();
    expect(cursor.committedUsdPerMonth).toBeNull();
    // QA-5: a partial sum is never silently complete — 2/3 priced is visible.
    expect(card.totals.subscriptionCommitted).toEqual({
      amountUsd: 300,
      pricedSubs: 2,
      totalSubs: 3
    });
  });

  it("subscriptions detected, zero usage in window: all-n/r totals with committed intact (QA-6)", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [],
      detectedPlans: [claudePlan, codexPlan]
    });
    expect(card.subscriptions).toHaveLength(2);
    // §1.4 zero-usage variant prints "$320/mo", but its own two rows are
    // $100 + $200; the reconciliation rule (§1.1) wins: the committed total
    // is the sum of priced rows, $300.
    expect(card.totals.subscriptionCommitted.amountUsd).toBe(300);
    expect(card.totals.apiEquivalent).toEqual({ amountUsd: null, financialEvidence: "missing" });
    expect(card.totals.providerBilled).toEqual({ amountUsd: null, financialEvidence: "missing" });
    expect(card.byProject).toBeNull();
  });

  it("no subscriptions detected: empty rows, basis totals still honest", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [localRecord({ agent: "claude-code", amountUsd: 10, projectId: "solo" })]
    });
    expect(card.subscriptions).toHaveLength(0);
    expect(card.totals.subscriptionCommitted).toEqual({ amountUsd: null, pricedSubs: 0, totalSubs: 0 });
    expect(card.totals.apiEquivalent.amountUsd).toBe(10);
  });

  it("demo/sample: real detected plans never mix into demo output (QA-13)", () => {
    const card = buildResultCard({
      mode: "demo",
      records: [localRecord({ agent: "claude-code", amountUsd: 10, projectId: "sample" })],
      detectedPlans: [claudePlan, codexPlan],
      providerPlans: [{ provider: "cursor", planLabel: "Pro", committedUsdPerMonth: 20 }]
    });
    expect(card.subscriptions).toEqual([]);
    expect(card.totals.subscriptionCommitted).toEqual({ amountUsd: null, pricedSubs: 0, totalSubs: 0 });
  });

  it("zero data: no fabricated totals, no byProject, no $0 (QA-6)", () => {
    const card = buildResultCard({ mode: "local-logs", records: [] });
    expect(card.subscriptions).toEqual([]);
    expect(card.totals.apiEquivalent.amountUsd).toBeNull();
    expect(card.totals.providerBilled.amountUsd).toBeNull();
    expect(card.byProject).toBeNull();
  });

  it("verified $0 stays a receipt-proved zero, never n/r (QA-6)", () => {
    const card = buildResultCard({
      mode: "connected",
      records: [localRecord({
        agent: "claude-code",
        amountUsd: 0,
        projectId: "quiet",
        costConfidence: "verified",
        providerCostType: "anthropic_cost"
      })]
    });
    expect(card.totals.providerBilled).toEqual({ amountUsd: 0, financialEvidence: "verified" });
    // A $0 basis total still never fabricates a by-project row.
    expect(card.byProject).toBeNull();
  });
});

describe("buildResultCard — estimated-never-billed locks (QA-3)", () => {
  it("cursor estimated dollars land ONLY in detectedUnverifiedUsd", () => {
    const card = buildResultCard({
      mode: "connected",
      records: [cursorRecord(12.40)]
    });
    const cursor = card.subscriptions.find((row) => row.id === "cursor")!;
    expect(cursor.detectedUnverifiedUsd).toBe(12.40);
    expect(cursor.providerBilledUsd).toBeNull();
    expect(cursor.apiEquivalentUsd).toBeNull();
    expect(card.totals.providerBilled.amountUsd).toBeNull();
    expect(card.totals.apiEquivalent.amountUsd).toBeNull();
  });

  it("detected_unverified confidence is likewise disclosure-only", () => {
    recordCounter += 1;
    const record: UsageRecord = {
      ...cursorRecord(5),
      id: `record-${recordCounter}-du`,
      costConfidence: "detected_unverified"
    };
    const card = buildResultCard({ mode: "connected", records: [record] });
    const cursor = card.subscriptions.find((row) => row.id === "cursor")!;
    expect(cursor.detectedUnverifiedUsd).toBe(5);
    expect(card.totals.providerBilled.amountUsd).toBeNull();
  });

  it("verified cursor dollars graduate to providerBilledUsd (aspirational path)", () => {
    const card = buildResultCard({
      mode: "connected",
      records: [cursorRecord(12.40, "verified")]
    });
    const cursor = card.subscriptions.find((row) => row.id === "cursor")!;
    expect(cursor.providerBilledUsd).toBe(12.40);
    expect(cursor.detectedUnverifiedUsd).toBeNull();
    expect(card.totals.providerBilled).toEqual({ amountUsd: 12.40, financialEvidence: "verified" });
  });
});

describe("buildResultCard — by-project rules (§3/QA-8)", () => {
  it("keeps local/mixed by-project on api_equivalent even when verified billed rows exist (QA M3)", () => {
    // The founder's by-project ask must survive the day cursor verification
    // lands: one verified billed row must not hijack the block away from
    // $482 of local project attribution.
    const card = buildResultCard({
      mode: "mixed",
      windowDays: 30,
      records: [
        ...canonicalRecords().filter((record) => record.source.provider !== "cursor"),
        cursorRecord(12.40, "verified")
      ],
      detectedPlans: [claudePlan, codexPlan],
      providerPlans: [{ provider: "cursor", planLabel: "Pro", committedUsdPerMonth: 20 }]
    });
    expect(card.totals.providerBilled).toEqual({ amountUsd: 12.40, financialEvidence: "verified" });
    const byProject = card.byProject!;
    expect(byProject.basis).toBe("api_equivalent");
    expect(byProject.rows.map((row) => row.project)).toEqual([
      "tilden-web",
      "agent-finops",
      "unattributed"
    ]);
    expect(byProject.rows.some((row) => row.project === "cursor-team")).toBe(false);
  });

  it("uses provider_billed as the primary basis when verified money exists", () => {
    const card = buildResultCard({
      mode: "connected",
      records: [
        localRecord({
          agent: "claude-code",
          amountUsd: 30,
          projectId: "verified-project",
          costConfidence: "verified",
          providerCostType: "anthropic_cost"
        }),
        localRecord({ agent: "claude-code", amountUsd: 10, projectId: "estimated-project" })
      ]
    });
    expect(card.byProject!.basis).toBe("provider_billed");
    expect(card.byProject!.rows).toEqual([
      { project: "verified-project", amountUsd: 30, share: 1, unattributed: false }
    ]);
  });

  it("everythingElse is null with two or fewer named projects — never $0.00 (0% · 0 projects)", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [
        localRecord({ agent: "claude-code", amountUsd: 30, projectId: "alpha" }),
        localRecord({ agent: "claude-code", amountUsd: 10, projectId: "beta" })
      ]
    });
    expect(card.byProject!.rows).toHaveLength(2);
    expect(card.byProject!.everythingElse).toBeNull();
  });

  it("single-project window keeps a lone full-share row", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [localRecord({ agent: "claude-code", amountUsd: 30, projectId: "alpha" })]
    });
    expect(card.byProject!.rows).toEqual([
      { project: "alpha", amountUsd: 30, share: 1, unattributed: false }
    ]);
    expect(card.byProject!.everythingElse).toBeNull();
  });

  it("never renames or folds the unattributed row", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [
        localRecord({ agent: "claude-code", amountUsd: 30, projectId: "alpha" }),
        localRecord({ agent: "claude-code", amountUsd: 10, projectId: "(home)" }),
        localRecord({ agent: "claude-code", amountUsd: 5, projectId: "unmapped" }),
        localRecord({ agent: "codex", amountUsd: 5 })
      ]
    });
    const unattributed = card.byProject!.rows.find((row) => row.unattributed)!;
    expect(unattributed.project).toBe(resultCardVocabulary.unattributed);
    expect(unattributed.amountUsd).toBe(20);
  });

  it("absorbs cent-rounding drift so rows always sum exactly to the basis total", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [
        localRecord({ agent: "claude-code", amountUsd: 0.333, projectId: "alpha" }),
        localRecord({ agent: "claude-code", amountUsd: 0.333, projectId: "beta" }),
        localRecord({ agent: "claude-code", amountUsd: 0.334 })
      ]
    });
    const byProject = card.byProject!;
    const sum = byProject.rows.reduce((total, row) => total + row.amountUsd, 0) +
      (byProject.everythingElse?.amountUsd ?? 0);
    expect(sum).toBeCloseTo(card.totals.apiEquivalent.amountUsd!, 10);
  });

  it("clips project names at 24 chars + ellipsis (§1.1/D6)", () => {
    const longName = "a-very-long-project-name-that-keeps-going";
    const card = buildResultCard({
      mode: "local-logs",
      records: [localRecord({ agent: "claude-code", amountUsd: 10, projectId: longName })]
    });
    expect(card.byProject!.rows[0]!.project).toBe(`${longName.slice(0, 24)}…`);
    expect(clipResultCardProjectName("short")).toBe("short");
  });
});

describe("resultCardSchema — contract enforcement (QA-2/QA-14)", () => {
  it("rejects a blended total", () => {
    const card = canonicalCard();
    const blended = { ...card, totals: { ...card.totals, blended: 814.60 as unknown as null } };
    expect(resultCardSchema.safeParse(blended).success).toBe(false);
  });

  it("rejects any blend policy other than never_blended", () => {
    const card = canonicalCard();
    const policy = {
      ...card,
      totals: { ...card.totals, blendPolicy: "sum" as unknown as "never_blended" }
    };
    expect(resultCardSchema.safeParse(policy).success).toBe(false);
  });

  it("rejects amount/evidence disagreement on both bases (D3: null ⟺ missing)", () => {
    const card = canonicalCard();
    const wrongApi = {
      ...card,
      totals: {
        ...card.totals,
        apiEquivalent: { amountUsd: null, financialEvidence: "estimated" as const }
      }
    };
    expect(resultCardSchema.safeParse(wrongApi).success).toBe(false);
    const wrongBilled = {
      ...card,
      totals: {
        ...card.totals,
        providerBilled: { amountUsd: 5, financialEvidence: "missing" as const }
      }
    };
    expect(resultCardSchema.safeParse(wrongBilled).success).toBe(false);
  });

  it("rejects demo cards that carry subscriptions (QA-13)", () => {
    const card = canonicalCard();
    expect(resultCardSchema.safeParse({ ...card, mode: "demo" }).success).toBe(false);
  });

  it("rejects more than two runways", () => {
    const card = canonicalCard();
    const claude = card.subscriptions[0]!;
    const overloaded = {
      ...card,
      subscriptions: [
        {
          ...claude,
          runways: [
            ...claude.runways,
            { kind: "weekly" as const, remainingPercent: 10, resetsAt: "2026-08-22T07:00:00Z" }
          ]
        },
        ...card.subscriptions.slice(1)
      ]
    };
    expect(resultCardSchema.safeParse(overloaded).success).toBe(false);
  });

  it("rejects by-project blocks that do not reconcile to the basis total (B1)", () => {
    const card = canonicalCard();
    const drifted = {
      ...card,
      byProject: {
        ...card.byProject!,
        rows: card.byProject!.rows.map((row, index) =>
          index === 0 ? { ...row, amountUsd: row.amountUsd - 70.02 } : row
        )
      }
    };
    expect(resultCardSchema.safeParse(drifted).success).toBe(false);
  });

  it("rejects a totalSubs count that disagrees with the rows", () => {
    const card = canonicalCard();
    const wrong = {
      ...card,
      totals: {
        ...card.totals,
        subscriptionCommitted: { ...card.totals.subscriptionCommitted, totalSubs: 5 }
      }
    };
    expect(resultCardSchema.safeParse(wrong).success).toBe(false);
  });
});

describe("buildResultCardProjectLine — improve card PROJECT line (§3/QA-9)", () => {
  const cardAndRecords = () => {
    const records = canonicalRecords();
    const card = buildResultCard({
      mode: "mixed",
      windowDays: 30,
      records,
      detectedPlans: [claudePlan, codexPlan],
      providerPlans: [{ provider: "cursor", planLabel: "Pro", committedUsdPerMonth: 20 }]
    });
    return { card, records };
  };

  it("renders the canonical §3 line with rank and the FULL basis denominator", () => {
    const { card, records } = cardAndRecords();
    const line = buildResultCardProjectLine({
      card,
      records,
      currentProjectId: "tilden-web"
    });
    // Denominator is ~$482 (the full basis total), not the attributable subset.
    expect(line).toBe("tilden-web · ~$210 of ~$482 API-equivalent (44%, 30d) · rank 1 of 8 projects");
  });

  it("ranks a non-top project honestly among named projects", () => {
    const { card, records } = cardAndRecords();
    const line = buildResultCardProjectLine({
      card,
      records,
      currentProjectId: "proj-a"
    });
    expect(line).toBe("proj-a · ~$20 of ~$482 API-equivalent (4%, 30d) · rank 3 of 8 projects");
  });

  it("keeps an unattributed cwd honest — no rank, never renamed", () => {
    const { card, records } = cardAndRecords();
    const line = buildResultCardProjectLine({
      card,
      records,
      currentProjectId: undefined
    });
    // QA MINOR-2: the share matches the card's largest-remainder 14% — the
    // same money never shows two different percentages across surfaces.
    expect(line).toBe("unattributed · ~$70 of ~$482 API-equivalent (14%, 30d)");
    expect(line).not.toContain("rank");
  });

  it("omits the line entirely when the current project has no attribution", () => {
    const { card, records } = cardAndRecords();
    expect(buildResultCardProjectLine({
      card,
      records,
      currentProjectId: "never-observed-project"
    })).toBeUndefined();
  });

  it("omits the line when no by-project evidence exists at all", () => {
    const card = buildResultCard({
      mode: "local-logs",
      records: [],
      detectedPlans: [claudePlan]
    });
    expect(buildResultCardProjectLine({
      card,
      records: [],
      currentProjectId: "tilden-web"
    })).toBeUndefined();
  });
});

describe("shared formatting grammar (§1.2)", () => {
  it("committed figures are whole-dollar list prices, never ~", () => {
    expect(formatCommittedPerMonth(320)).toBe("$320/mo");
    expect(formatCommittedPerMonth(20)).toBe("$20/mo");
    expect(formatCommittedPerMonth(1200)).toBe("$1,200/mo");
    expect(formatCommittedPerMonth(320)).not.toContain("~");
  });

  it("API-equivalent figures always carry ~ and round to whole dollars", () => {
    expect(formatApproxUsd(412.18)).toBe("~$412");
    expect(formatApproxUsd(70.02)).toBe("~$70");
    expect(formatApproxUsd(482.20)).toBe("~$482");
  });

  it("renders real-but-tiny API-equivalent usage as ~<$1, never ~$0 (QA MINOR-4)", () => {
    expect(formatApproxUsd(0.4)).toBe("~<$1");
    expect(formatApproxUsd(0.004)).toBe("~<$1");
    expect(formatApproxUsd(0)).toBe("~$0");
    expect(formatApproxUsd(0.5)).toBe("~$1");
  });

  it("billed money is exact — never compacted, never ~ (QA-1)", () => {
    expect(formatBilledUsdExact(12.4)).toBe("$12.40");
    expect(formatBilledUsdExact(0)).toBe("$0.00");
    expect(formatBilledUsdExact(1234.5)).toBe("$1,234.50");
    expect(formatBilledUsdExact(12.4)).not.toContain("~");
  });

  it("largest-remainder percents always sum to exactly 100", () => {
    for (const weights of [
      [210.10, 122.05, 70.02, 80.03],
      [1, 1, 1],
      [33.33, 33.33, 33.34],
      [0.001, 0.001, 0.998]
    ]) {
      const percents = largestRemainderPercents(weights);
      expect(percents.reduce((total, value) => total + value, 0)).toBe(100);
    }
    expect(largestRemainderPercents([])).toEqual([]);
    expect(largestRemainderPercents([0, 0])).toEqual([0, 0]);
  });

  it("keeps the kill-list available for renderer sweeps (§1.2)", () => {
    expect(resultCardKilledTerms).toContain("usage value");
    expect(resultCardKilledTerms).toContain("cost/value");
    // QA MINOR-5: the pre-C-lane statusline suffix is on the list too.
    expect(resultCardKilledTerms).toContain("7d value");
    expect(resultCardVocabulary.blendPolicy).toBe("never_blended");
  });
});
