import { describe, expect, it } from "vitest";
import {
  activitySnapshotAgentValues,
  activitySnapshotSchema,
  buildActivitySnapshot,
  createActivitySnapshotError
} from "./activitySnapshot.js";
import { localAgentFormatDescriptors } from "./localAgentFormats/registry.js";
import {
  aggregateCalls,
  type LocalAgentCall,
  type LocalAgentSourceScan
} from "./localAgentLogs.js";
import type { DetectedPlan } from "./planDetection.js";
import type { UsageRecord } from "./schema.js";

const AS_OF = "2026-08-09T18:00:00.000Z";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "local-codex-1",
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: "openai",
      confidence: "estimated",
      observedFrom: "local transcript"
    },
    model: "gpt-5.6-sol",
    inputTokens: 100,
    outputTokens: 10,
    amountUsd: 2,
    costConfidence: "estimated",
    agentId: "codex",
    providerCostType: "local_agent_logs",
    usageGranularity: "daily_aggregate",
    ...overrides
  };
}

function plan(
  agent: "claude-code" | "codex",
  billing: DetectedPlan["billing"],
  overrides: Partial<DetectedPlan> = {}
): DetectedPlan {
  return {
    agent,
    provider: agent === "codex" ? "openai" : "anthropic",
    planId: agent === "codex" ? "chatgpt-pro" : "claude-max-5x",
    planLabel: "sensitive-plan-label-that-must-not-be-cached",
    billing,
    source: "sensitive-plan-source-that-must-not-be-cached",
    ...overrides
  };
}

function scan(
  agent: "claude-code" | "codex",
  overrides: Partial<LocalAgentSourceScan> = {}
): LocalAgentSourceScan {
  return {
    agent,
    directoryStatus: "readable",
    filesDiscovered: 1,
    filesParsed: 1,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0,
    jsonlValidationCoverage: "complete",
    ...overrides
  };
}

function call(
  agent: "claude-code" | "codex",
  overrides: Partial<LocalAgentCall> = {}
): LocalAgentCall {
  return {
    agent,
    model: agent === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4",
    timestamp: "2026-08-09T12:00:00.000Z",
    usage: { inputTokens: 100, outputTokens: 10 },
    ...overrides
  };
}

function meteredSnapshotFromCalls(
  calls: LocalAgentCall[],
  asOf: string
) {
  return buildActivitySnapshot({
    asOf,
    generatedAt: asOf,
    records: aggregateCalls(calls),
    calls,
    detectedPlans: [plan("codex", "api_key")],
    sourceScans: [scan("codex")]
  });
}

describe("buildActivitySnapshot", () => {
  it("builds a metered snapshot led by labeled API-equivalent windows", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [
        record({ amountUsd: 1, timestamp: "2026-08-09T12:00:00.000Z" }),
        record({ id: "local-codex-2", amountUsd: 2, timestamp: "2026-08-05T12:00:00.000Z" }),
        record({ id: "local-codex-3", amountUsd: 4, timestamp: "2026-07-20T12:00:00.000Z" })
      ],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.mode).toBe("metered");
    expect(snapshot.subscription).toBeNull();
    expect(snapshot.unresolved).toBeNull();
    expect(snapshot.metered?.apiEquivalent).toEqual({
      oneDay: {
        amountUsd: 1,
        recordCount: 1,
        basis: "api_equivalent",
        financialEvidence: "estimated",
        coverage: "partial"
      },
      sevenDays: {
        amountUsd: 3,
        recordCount: 2,
        basis: "api_equivalent",
        financialEvidence: "estimated",
        coverage: "partial"
      },
      thirtyDays: {
        amountUsd: 7,
        recordCount: 3,
        basis: "api_equivalent",
        financialEvidence: "estimated",
        coverage: "partial"
      }
    });
    expect(snapshot.metered?.providerBilled.sevenDays).toMatchObject({
      amountUsd: null,
      financialEvidence: "missing",
      coverage: "missing"
    });
  });

  it("uses exact local-call timestamps at every rolling-window boundary", () => {
    const asOf = "2026-08-09T12:00:00.000Z";
    const calls = [
      call("codex", { timestamp: "2026-08-08T13:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), // 23h
      call("codex", { timestamp: "2026-08-08T11:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), // 25h
      call("codex", { timestamp: "2026-08-02T13:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), // 6d23h
      call("codex", { timestamp: "2026-08-02T11:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), // 7d1h
      call("codex", { timestamp: "2026-07-10T13:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }), // 29d23h
      call("codex", { timestamp: "2026-07-10T11:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }) // 30d1h
    ];
    const snapshot = meteredSnapshotFromCalls(calls, asOf);

    expect(snapshot.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 8,
      recordCount: 1,
      coverage: "complete"
    });
    expect(snapshot.metered?.apiEquivalent.sevenDays).toMatchObject({
      amountUsd: 24,
      recordCount: 3,
      coverage: "complete"
    });
    expect(snapshot.metered?.apiEquivalent.thirtyDays).toMatchObject({
      amountUsd: 40,
      recordCount: 5,
      coverage: "complete"
    });
  });

  it("splits a same-day aggregate at the exact asOf cutoff without changing its total", () => {
    const calls = [
      call("codex", { timestamp: "2026-08-09T10:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
      call("codex", { timestamp: "2026-08-09T14:00:00.000Z", usageScope: "turn", usage: { inputTokens: 1_000_000, outputTokens: 0 } })
    ];
    const beforeSecondCall = meteredSnapshotFromCalls(calls, "2026-08-09T12:00:00.000Z");
    const afterSecondCall = meteredSnapshotFromCalls(calls, "2026-08-09T15:00:00.000Z");

    expect(beforeSecondCall.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 8,
      recordCount: 1,
      coverage: "complete"
    });
    expect(afterSecondCall.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 16,
      recordCount: 2,
      coverage: "complete"
    });
    expect(aggregateCalls(calls)[0]?.amountUsd).toBe(16);
  });

  it("deduplicates cumulative calls before splitting local daily aggregates", () => {
    const calls = [
      call("codex", {
        timestamp: "2026-08-09T10:00:00.000Z",
        startedAt: "2026-08-09T09:00:00.000Z",
        sessionId: "same-session",
        usageScope: "session_cumulative",
        usage: { inputTokens: 1_000_000, outputTokens: 0 }
      }),
      call("codex", {
        timestamp: "2026-08-09T11:00:00.000Z",
        startedAt: "2026-08-09T09:00:00.000Z",
        sessionId: "same-session",
        usageScope: "session_cumulative",
        usage: { inputTokens: 2_000_000, outputTokens: 0 }
      })
    ];
    const snapshot = meteredSnapshotFromCalls(calls, "2026-08-09T12:00:00.000Z");

    expect(snapshot.metered?.apiEquivalent.oneDay).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "partial"
    });
  });

  it("keeps a 1-day cutoff-straddling cumulative Codex session but omits its amount", () => {
    const asOf = "2026-08-09T12:00:00.000Z";
    const calls = [call("codex", {
      timestamp: "2026-08-09T11:00:00.000Z",
      startedAt: "2026-08-08T11:00:00.000Z",
      sessionId: "one-day-straddle",
      usageScope: "session_cumulative",
      usage: { inputTokens: 1_000_000, outputTokens: 0 }
    })];
    const snapshot = meteredSnapshotFromCalls(calls, asOf);

    expect(snapshot.metered?.apiEquivalent.oneDay).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "partial"
    });
    expect(snapshot.metered?.apiEquivalent.sevenDays).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "partial"
    });
  });

  it("keeps a 30-day cutoff-straddling cumulative Codex session but omits its amount", () => {
    const asOf = "2026-08-09T12:00:00.000Z";
    const calls = [call("codex", {
      timestamp: "2026-07-10T13:00:00.000Z",
      startedAt: "2026-07-10T11:00:00.000Z",
      sessionId: "thirty-day-straddle",
      usageScope: "session_cumulative",
      usage: { inputTokens: 1_000_000, outputTokens: 0 }
    })];
    const snapshot = meteredSnapshotFromCalls(calls, asOf);

    expect(snapshot.metered?.apiEquivalent.thirtyDays).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "partial"
    });
  });

  it("keeps turn-scoped Claude usage exact even when its session started before the cutoff", () => {
    const asOf = "2026-08-09T12:00:00.000Z";
    const calls = [call("claude-code", {
      timestamp: "2026-08-09T11:00:00.000Z",
      startedAt: "2026-08-08T11:00:00.000Z",
      sessionId: "claude-turn",
      usageScope: "turn",
      usage: { inputTokens: 1_000_000, outputTokens: 0 }
    })];
    const snapshot = buildActivitySnapshot({
      asOf,
      generatedAt: asOf,
      records: aggregateCalls(calls),
      calls,
      detectedPlans: [plan("claude-code", "api_key")],
      sourceScans: [scan("claude-code")]
    });

    expect(snapshot.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 3,
      recordCount: 1,
      financialEvidence: "estimated",
      coverage: "complete"
    });
  });

  it("makes subscription runway primary only from unexpired transcript-reported windows", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      calls: [call("codex", {
        workingDirectory: "sensitive-working-directory",
        sessionId: "sensitive-session-id",
        rateLimits: {
          observedAt: "2026-08-09T12:00:00.000Z",
          planType: "sensitive-raw-plan",
          windows: [
            {
              kind: "five-hour",
              name: "five-hour",
              usedPercent: 71,
              windowMinutes: 300,
              resetsAt: "2026-08-09T20:00:00.000Z"
            },
            {
              kind: "weekly",
              name: "weekly",
              usedPercent: 43,
              windowMinutes: 10_080,
              resetsAt: "2026-08-16T00:00:00.000Z"
            },
            {
              kind: "custom",
              name: "custom-freeform",
              usedPercent: 10,
              windowMinutes: 60,
              resetsAt: "2026-08-09T19:00:00.000Z"
            }
          ]
        }
      })],
      detectedPlans: [plan("codex", "subscription")],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.mode).toBe("subscription");
    expect(snapshot.subscription?.agents).toEqual([
      expect.objectContaining({
        agent: "codex",
        billing: "subscription",
        planId: "chatgpt-pro",
        limits: [
          expect.objectContaining({ kind: "five-hour", usedPercent: 71, remainingPercent: 29 }),
          expect.objectContaining({ kind: "weekly", usedPercent: 43, remainingPercent: 57 })
        ]
      })
    ]);
    expect(snapshot.subscription?.agents[0]?.apiEquivalent.sevenDays).toMatchObject({
      amountUsd: 2,
      basis: "api_equivalent",
      financialEvidence: "estimated"
    });
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      "sensitive-plan-label",
      "sensitive-plan-source",
      "sensitive-working-directory",
      "sensitive-session-id",
      "sensitive-raw-plan",
      "custom-freeform"
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("does not infer runway and omits expired transcript windows", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      calls: [call("codex", {
        rateLimits: {
          observedAt: "2026-08-08T12:00:00.000Z",
          windows: [{
            kind: "five-hour",
            name: "five-hour",
            usedPercent: 99,
            windowMinutes: 300,
            resetsAt: "2026-08-09T17:59:59.000Z"
          }]
        }
      })],
      detectedPlans: [plan("codex", "subscription")],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.subscription?.agents[0]?.limits).toEqual([]);
  });

  it("keeps subscription value and trusted metered billing separate in mixed mode", () => {
    const billed = record({
      id: "provider-bill-1",
      agentId: undefined,
      source: {
        id: "provider",
        name: "Provider",
        provider: "openai",
        confidence: "verified",
        observedFrom: "provider API"
      },
      amountUsd: 7,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "call"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({ amountUsd: 5 }), billed],
      calls: [call("codex")],
      detectedPlans: [plan("codex", "subscription")],
      sourceScans: [scan("codex")],
      trustedProviderRecordIds: [billed.id],
      providerCoverage: [{
        provider: "openai",
        status: "partial",
        validationCoverage: "live_verified",
        checkedAt: AS_OF
      }]
    });

    expect(snapshot.mode).toBe("mixed");
    expect(snapshot.subscription?.agents[0]?.apiEquivalent.sevenDays.amountUsd).toBe(5);
    expect(snapshot.metered?.providerBilled.sevenDays.amountUsd).toBe(7);
    expect(snapshot.metered?.providerBilled.sevenDays.coverage).toBe("partial");
    expect(snapshot.metered?.apiEquivalent.sevenDays.amountUsd).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('"amountUsd":12');
  });

  it("retains unresolved API-equivalent evidence beside a known metered cohort", () => {
    const billed = record({
      id: "trusted-provider-bill",
      agentId: undefined,
      amountUsd: 8,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "call"
    });
    const unresolved = record({
      id: "provider-usage-without-billing-proof",
      agentId: undefined,
      amountUsd: 3,
      costConfidence: "estimated",
      providerCostType: "openai_usage_evidence",
      usageGranularity: "usage_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [billed, unresolved],
      trustedProviderRecordIds: [billed.id],
      providerCoverage: [{
        provider: "openai",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF
      }]
    });

    expect(snapshot.mode).toBe("metered");
    expect(snapshot.metered?.providerBilled.sevenDays.amountUsd).toBe(8);
    expect(snapshot.unresolved?.apiEquivalent.sevenDays).toMatchObject({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "missing"
    });
    expect(snapshot.coverage.recordsParsed).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain('"amountUsd":11');
  });

  it("never relabels a trusted Cursor financial estimate as API-equivalent value", () => {
    const cursorEstimate = record({
      id: "cursor-estimate",
      agentId: undefined,
      source: {
        id: "cursor",
        name: "Cursor",
        provider: "cursor",
        confidence: "estimated",
        observedFrom: "provider API"
      },
      amountUsd: 42,
      costConfidence: "estimated",
      providerCostType: "cursor_spend",
      usageGranularity: "user_aggregate"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [cursorEstimate],
      trustedProviderRecordIds: [cursorEstimate.id],
      providerCoverage: [{
        provider: "cursor",
        status: "complete",
        validationCoverage: "fixture_verified",
        checkedAt: AS_OF,
        latestEvidenceAt: "2026-08-09T12:00:00.000Z"
      }]
    });

    expect(snapshot.mode).toBe("unresolved");
    expect(snapshot.unresolved?.apiEquivalent.sevenDays).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "missing"
    });
    expect(snapshot.metered).toBeNull();
  });

  it("keeps the known trusted Anthropic usage estimate on its API-equivalent basis", () => {
    const anthropicUsage = record({
      id: "anthropic-usage-estimate",
      agentId: undefined,
      source: {
        id: "anthropic",
        name: "Anthropic usage",
        provider: "anthropic",
        confidence: "estimated",
        observedFrom: "provider API"
      },
      amountUsd: 6,
      costConfidence: "estimated",
      providerCostType: "anthropic_claude_code_usage",
      usageGranularity: "usage_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [anthropicUsage],
      trustedProviderRecordIds: [anthropicUsage.id],
      providerCoverage: [{
        provider: "anthropic",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF,
        latestEvidenceAt: "2026-08-09T12:00:00.000Z"
      }]
    });

    expect(snapshot.unresolved?.apiEquivalent.sevenDays).toMatchObject({
      amountUsd: 6,
      basis: "api_equivalent",
      financialEvidence: "estimated",
      coverage: "partial"
    });
  });

  it("allows billed overage only for an explicit verified trusted provider record", () => {
    const billed = record({
      id: "provider-overage",
      agentId: undefined,
      amountUsd: 9.25,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [billed],
      trustedProviderRecordIds: [billed.id],
      billedOverageRecordIds: [billed.id],
      providerCoverage: [{
        provider: "openai",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF
      }]
    });

    expect(snapshot.overage).toEqual({
      amountUsd: 9.25,
      currency: "USD",
      basis: "provider_billed",
      financialEvidence: "verified",
      alertEligible: true,
      recordCount: 1
    });
    expect(snapshot.metered?.providerBilled.sevenDays.coverage).toBe("partial");
    expect(() => buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [billed],
      billedOverageRecordIds: [billed.id]
    })).toThrow(/externally trusted/);
  });

  it("proves billed $0 only inside an exact receipt-bound provider interval", () => {
    const oldBill = record({
      id: "old-provider-bill",
      timestamp: "2026-07-01T12:00:00.000Z",
      agentId: undefined,
      amountUsd: 12,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [oldBill],
      trustedProviderRecordIds: [oldBill.id],
      providerCoverage: [{
        provider: "openai",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF,
        coverageStart: "2026-08-08T18:00:00.000Z",
        coverageEnd: AS_OF
      }]
    });

    expect(snapshot.metered?.providerBilled.oneDay).toEqual({
      amountUsd: 0,
      recordCount: 0,
      basis: "provider_billed",
      financialEvidence: "verified",
      coverage: "complete"
    });
    expect(snapshot.metered?.providerBilled.sevenDays).toEqual({
      amountUsd: null,
      recordCount: 0,
      basis: "provider_billed",
      financialEvidence: "missing",
      coverage: "missing"
    });
    expect(snapshot.metered?.providerBilled.thirtyDays.amountUsd).toBeNull();
    expect(snapshot.coverage.providers[0]).toEqual({
      provider: "openai",
      status: "complete",
      validationCoverage: "live_verified",
      checkedAt: AS_OF,
      latestEvidenceAt: null,
      coverageStart: "2026-08-08T18:00:00.000Z",
      coverageEnd: AS_OF
    });
  });

  it("never manufactures billed zero without receipt-bound interval coverage", () => {
    const oldBill = record({
      id: "old-provider-bill-no-interval",
      timestamp: "2026-07-01T12:00:00.000Z",
      agentId: undefined,
      amountUsd: 12,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [oldBill],
      trustedProviderRecordIds: [oldBill.id],
      providerCoverage: [{
        provider: "openai",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF
      }]
    });

    expect(snapshot.mode).toBe("empty");
    expect(snapshot.metered).toBeNull();
    expect(snapshot.coverage.recordsParsed).toBe(0);
  });

  it("does not present a billing bucket that straddles the rolling cutoff as an exact amount", () => {
    const boundaryBucket = record({
      id: "provider-boundary-bucket",
      timestamp: "2026-08-08T12:00:00.000Z",
      agentId: undefined,
      amountUsd: 14,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [boundaryBucket],
      trustedProviderRecordIds: [boundaryBucket.id],
      providerCoverage: [{
        provider: "openai",
        status: "complete",
        validationCoverage: "live_verified",
        checkedAt: AS_OF,
        latestEvidenceAt: "2026-08-08T12:00:00.000Z",
        coverageStart: "2026-08-08T12:00:00.000Z",
        coverageEnd: AS_OF
      }]
    });

    expect(snapshot.metered?.providerBilled.oneDay).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "provider_billed",
      financialEvidence: "missing",
      coverage: "partial"
    });
  });

  it("keeps a receipt-checked partial current-day billed bucket visible", () => {
    const currentBucket = record({
      id: "provider-current-bucket",
      timestamp: "2026-08-09T17:00:00.000Z",
      agentId: undefined,
      amountUsd: 12.34,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [currentBucket],
      trustedProviderRecordIds: [currentBucket.id],
      providerCoverage: [{
        provider: "openai",
        status: "partial",
        validationCoverage: "live_verified",
        checkedAt: AS_OF,
        latestEvidenceAt: currentBucket.timestamp
      }]
    });

    expect(snapshot.metered?.providerBilled.oneDay).toEqual({
      amountUsd: 12.34,
      recordCount: 1,
      basis: "provider_billed",
      financialEvidence: "verified",
      coverage: "partial"
    });
  });

  it("does not upgrade an untrusted verified row to provider-billed truth", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({
        id: "repository-authored-verified",
        agentId: undefined,
        amountUsd: 999,
        costConfidence: "verified",
        providerCostType: "openai_cost"
      })]
    });

    expect(snapshot.mode).toBe("unresolved");
    expect(snapshot.metered).toBeNull();
    expect(snapshot.overage).toBeNull();
    expect(snapshot.unresolved?.apiEquivalent.sevenDays).toMatchObject({
      amountUsd: null,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "missing"
    });
  });

  it("keeps unknown billing unresolved and missing values distinct from proved zero", () => {
    const unpriced = record({ amountUsd: null, costConfidence: "missing" });
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [unpriced],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.mode).toBe("unresolved");
    expect(snapshot.unresolved?.apiEquivalent.sevenDays).toEqual({
      amountUsd: null,
      recordCount: 1,
      basis: "api_equivalent",
      financialEvidence: "missing",
      coverage: "partial"
    });
    expect(snapshot.coverage).toMatchObject({
      recordsParsed: 1,
      recordsPriced: 0,
      recordsUnpriced: 1,
      validationStatus: "partial"
    });
  });

  it("excludes conflicting duplicate IDs instead of double-counting them", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({ amountUsd: 2 }), record({ amountUsd: 20 })],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.mode).toBe("empty");
    expect(snapshot.coverage).toMatchObject({ recordsParsed: 0, validationStatus: "partial" });
  });

  it("filters stale history before duplicate-ID conflict detection and cohort selection", () => {
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [
        record({
          id: "reused-id",
          timestamp: "2026-07-01T12:00:00.000Z",
          agentId: undefined,
          amountUsd: 999,
          costConfidence: "verified",
          providerCostType: "openai_cost",
          usageGranularity: "billing_bucket"
        }),
        record({
          id: "reused-id",
          timestamp: "2026-08-09T12:00:00.000Z",
          amountUsd: 2
        })
      ],
      trustedProviderRecordIds: ["reused-id"],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });

    expect(snapshot.mode).toBe("metered");
    expect(snapshot.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 2,
      recordCount: 1,
      financialEvidence: "estimated"
    });
    expect(snapshot.metered?.providerBilled.thirtyDays.amountUsd).toBeNull();
    expect(snapshot.coverage).toMatchObject({
      recordsParsed: 1,
      recordsPriced: 1,
      recordsUnpriced: 0
    });
  });

  it.each([
    {
      label: "skipped non-financial history",
      scanEvidence: {
        filesReadFinancially: 1,
        bytesSkippedAsNonFinancialHistory: 10_000,
        nonFinancialLinesPrefiltered: 0,
        nonFinancialBytesPrefiltered: 0
      }
    },
    {
      label: "prefiltered non-financial lines",
      scanEvidence: {
        filesReadFinancially: 1,
        bytesSkippedAsNonFinancialHistory: 0,
        nonFinancialLinesPrefiltered: 17,
        nonFinancialBytesPrefiltered: 2_048
      }
    }
  ])("keeps priced values but marks $label coverage partial", ({ scanEvidence }) => {
    const calls = [call("codex", {
      timestamp: "2026-08-09T12:00:00.000Z",
      usageScope: "turn",
      usage: { inputTokens: 1_000_000, outputTokens: 0 }
    })];
    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: aggregateCalls(calls),
      calls,
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex", {
        jsonlValidationCoverage: "financial_events_only",
        ...scanEvidence
      })]
    });

    expect(snapshot.metered?.apiEquivalent.oneDay).toMatchObject({
      amountUsd: 8,
      financialEvidence: "estimated",
      coverage: "partial"
    });
    expect(snapshot.coverage.validationStatus).toBe("partial");
    expect(snapshot.coverage.agents[0]).toMatchObject({
      jsonlValidationCoverage: "financial_events_only",
      ...scanEvidence
    });
  });

  it("rejects sample input and never serializes arbitrary input metadata", () => {
    const sensitive = "sensitive-input-marker\u0007";
    expect(() => buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({
        id: sensitive,
        projectId: sensitive,
        clientId: sensitive,
        userId: sensitive,
        apiKeyId: sensitive,
        workspaceId: sensitive,
        operation: sensitive,
        source: {
          id: sensitive,
          name: sensitive,
          provider: "openai",
          confidence: "estimated",
          observedFrom: sensitive
        }
      })],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")],
      sampleData: true
    } as never)).toThrow(/Sample data/);
    expect(() => buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({
        id: "openai-sample",
        source: {
          id: "openai-sample",
          name: "Illustrative",
          provider: "openai",
          confidence: "estimated",
          observedFrom: "sample_csv"
        }
      })]
    })).toThrow(/Sample data/);

    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record({
        id: sensitive,
        projectId: sensitive,
        clientId: sensitive,
        userId: sensitive,
        apiKeyId: sensitive,
        workspaceId: sensitive,
        operation: sensitive,
        source: {
          id: sensitive,
          name: sensitive,
          provider: "openai",
          confidence: "estimated",
          observedFrom: sensitive
        }
      })],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-input-marker");
    expect(activitySnapshotSchema.safeParse({ ...snapshot, projectPath: sensitive }).success).toBe(false);
  });

  it("rejects internally inconsistent window and limit evidence", () => {
    const subscription = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      calls: [call("codex", {
        rateLimits: {
          observedAt: "2026-08-09T12:00:00.000Z",
          windows: [{
            kind: "weekly",
            name: "weekly",
            usedPercent: 25,
            windowMinutes: 10_080,
            resetsAt: "2026-08-16T00:00:00.000Z"
          }]
        }
      })],
      detectedPlans: [plan("codex", "subscription")],
      sourceScans: [scan("codex")]
    });
    const agent = subscription.subscription!.agents[0]!;
    expect(activitySnapshotSchema.safeParse({
      ...subscription,
      subscription: {
        agents: [{
          ...agent,
          limits: [{ ...agent.limits[0]!, remainingPercent: 99 }]
        }]
      }
    }).success).toBe(false);

    const metered = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });
    expect(activitySnapshotSchema.safeParse({
      ...metered,
      metered: {
        ...metered.metered!,
        apiEquivalent: {
          ...metered.metered!.apiEquivalent,
          sevenDays: {
            ...metered.metered!.apiEquivalent.sevenDays,
            financialEvidence: "missing"
          }
        }
      }
    }).success).toBe(false);
  });

  it("rejects semantically impossible cached snapshot states", () => {
    const metered = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });
    const meteredAgent = metered.metered!.agents[0]!;
    const missingApiWindow = {
      amountUsd: null,
      recordCount: 0,
      basis: "api_equivalent" as const,
      financialEvidence: "missing" as const,
      coverage: "missing" as const
    };
    const missingBilledWindow = {
      amountUsd: null,
      recordCount: 0,
      basis: "provider_billed" as const,
      financialEvidence: "missing" as const,
      coverage: "missing" as const
    };
    const invalid = [
      {
        ...metered,
        metered: {
          ...metered.metered!,
          apiEquivalent: {
            ...metered.metered!.apiEquivalent,
            oneDay: {
              ...metered.metered!.apiEquivalent.oneDay,
              coverage: "missing"
            }
          }
        }
      },
      {
        ...metered,
        metered: {
          ...metered.metered!,
          apiEquivalent: {
            ...metered.metered!.apiEquivalent,
            oneDay: {
              ...metered.metered!.apiEquivalent.oneDay,
              recordCount: 0,
              amountUsd: 2
            }
          }
        }
      },
      {
        ...metered,
        coverage: { ...metered.coverage, recordsUnpriced: 1 }
      },
      {
        ...metered,
        metered: { ...metered.metered!, agents: [meteredAgent, meteredAgent] }
      },
      {
        ...metered,
        metered: {
          agents: [],
          apiEquivalent: {
            oneDay: missingApiWindow,
            sevenDays: missingApiWindow,
            thirtyDays: missingApiWindow
          },
          providerBilled: {
            oneDay: missingBilledWindow,
            sevenDays: missingBilledWindow,
            thirtyDays: missingBilledWindow
          }
        }
      },
      { ...metered, generatedAt: "2026-08-09T17:59:59.000Z" },
      { ...metered, lastAttemptAt: "2026-08-09T17:59:59.000Z" },
      { ...metered, lastSuccessAt: "2026-08-09T17:59:59.000Z" }
    ];
    for (const value of invalid) {
      expect(activitySnapshotSchema.safeParse(value).success).toBe(false);
    }

    const subscription = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      calls: [call("codex", {
        rateLimits: {
          observedAt: "2026-08-09T12:00:00.000Z",
          windows: [{
            kind: "weekly",
            name: "weekly",
            usedPercent: 25,
            windowMinutes: 10_080,
            resetsAt: "2026-08-16T00:00:00.000Z"
          }]
        }
      })],
      detectedPlans: [plan("codex", "subscription")],
      sourceScans: [scan("codex")]
    });
    const subscriptionAgent = subscription.subscription!.agents[0]!;
    expect(activitySnapshotSchema.safeParse({
      ...subscription,
      subscription: { agents: [] }
    }).success).toBe(false);
    expect(activitySnapshotSchema.safeParse({
      ...subscription,
      subscription: {
        agents: [{
          ...subscriptionAgent,
          limits: [subscriptionAgent.limits[0]!, subscriptionAgent.limits[0]!]
        }]
      }
    }).success).toBe(false);

    const billed = record({
      id: "semantic-provider-row",
      agentId: undefined,
      amountUsd: 3,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "call"
    });
    const providerSnapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [billed],
      trustedProviderRecordIds: [billed.id],
      providerCoverage: [{
        provider: "openai",
        status: "partial",
        validationCoverage: "live_verified",
        checkedAt: AS_OF,
        latestEvidenceAt: billed.timestamp
      }]
    });
    const provider = providerSnapshot.coverage.providers[0]!;
    expect(activitySnapshotSchema.safeParse({
      ...providerSnapshot,
      coverage: {
        ...providerSnapshot.coverage,
        providers: [provider, provider]
      }
    }).success).toBe(false);
    expect(activitySnapshotSchema.safeParse({
      ...providerSnapshot,
      coverage: {
        ...providerSnapshot.coverage,
        providers: [{ ...provider, checkedAt: null }]
      }
    }).success).toBe(false);
  });

  it("derives accepted agents and cohort bounds from the local-agent registry", () => {
    expect(activitySnapshotAgentValues).toEqual(
      localAgentFormatDescriptors
        .filter((descriptor) => descriptor.capabilities.statuslineSnapshot)
        .map((descriptor) => descriptor.id)
    );

    const snapshot = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [record()],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    });
    const cohortAgent = snapshot.metered!.agents[0]!;
    const coverageAgent = snapshot.coverage.agents[0]!;
    const everyRegisteredAgent = activitySnapshotAgentValues.map((agent) => ({
      ...cohortAgent,
      agent
    }));
    const everyRegisteredCoverage = activitySnapshotAgentValues.map((agent) => ({
      ...coverageAgent,
      agent
    }));

    expect(activitySnapshotSchema.safeParse({
      ...snapshot,
      metered: {
        ...snapshot.metered!,
        agents: everyRegisteredAgent
      },
      coverage: {
        ...snapshot.coverage,
        agents: everyRegisteredCoverage
      }
    }).success).toBe(true);

    expect(activitySnapshotSchema.safeParse({
      ...snapshot,
      metered: {
        ...snapshot.metered!,
        agents: [{ ...cohortAgent, agent: "unregistered-agent" }]
      }
    }).success).toBe(false);
  });

  it("creates a strict bounded error state with no financial evidence", () => {
    const snapshot = createActivitySnapshotError(AS_OF, "scan_failed");
    expect(snapshot).toMatchObject({
      mode: "error",
      lastSuccessAt: null,
      refresh: { status: "error", errorCode: "scan_failed" },
      subscription: null,
      metered: null,
      unresolved: null,
      overage: null,
      networkUploaded: false
    });
  });

  it("is deterministic for identical explicit timestamps and rejects time inversion", () => {
    const input = {
      asOf: "2026-08-09T17:59:59.000Z",
      generatedAt: AS_OF,
      records: [record()],
      detectedPlans: [plan("codex", "api_key")],
      sourceScans: [scan("codex")]
    };
    expect(buildActivitySnapshot(input)).toEqual(buildActivitySnapshot(input));
    expect(buildActivitySnapshot(input)).toMatchObject({
      asOf: "2026-08-09T17:59:59.000Z",
      generatedAt: AS_OF,
      lastAttemptAt: "2026-08-09T17:59:59.000Z",
      lastSuccessAt: AS_OF
    });
    expect(() => buildActivitySnapshot({
      ...input,
      asOf: "2026-08-09T18:00:01.000Z"
    })).toThrow(/generatedAt must be at or after asOf/);
  });
});
