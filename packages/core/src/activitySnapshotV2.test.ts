import { describe, expect, it } from "vitest";
import {
  activitySnapshotV1Payload,
  buildActivitySnapshot,
  type ActivitySnapshotBilledWindow
} from "./activitySnapshot.js";
import type { DetectedPlan } from "./planDetection.js";
import type { UsageRecord } from "./schema.js";

/**
 * C-lane design §2.1 — snapshot schema v2: per-agent committed prices, the
 * committed total, provider-billed subscriptions with the writer-side
 * verified-only lock, and the v1 dual-write payload for the installed fleet.
 */

const AS_OF = "2026-08-09T18:00:00.000Z";

function claudeRecord(amountUsd = 12): UsageRecord {
  return {
    id: "local-claude-1",
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: "anthropic",
      confidence: "estimated",
      observedFrom: "local transcript"
    },
    model: "claude-opus-4-8",
    inputTokens: 1_000,
    outputTokens: 100,
    amountUsd,
    costConfidence: "estimated",
    agentId: "claude-code",
    providerCostType: "local_agent_logs",
    usageGranularity: "daily_aggregate"
  };
}

const claudeMaxPlan: DetectedPlan = {
  agent: "claude-code",
  provider: "anthropic",
  planId: "claude-max-5x",
  planLabel: "Claude Max 5x",
  billing: "subscription",
  source: "~/.claude.json"
};

function verifiedBilled(amountUsd: number): ActivitySnapshotBilledWindow {
  return {
    amountUsd,
    recordCount: 1,
    basis: "provider_billed",
    financialEvidence: "verified",
    coverage: "complete"
  };
}

describe("activity snapshot v2 (C-lane §2.1)", () => {
  it("stamps schemaVersion 2 and prices detected subscription plans", () => {
    const value = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [claudeRecord()],
      detectedPlans: [claudeMaxPlan]
    });
    expect(value.schemaVersion).toBe(2);
    expect(value.subscription?.agents[0]).toMatchObject({
      agent: "claude-code",
      planId: "claude-max-5x",
      committedUsdPerMonth: 100
    });
    expect(value.committedTotal).toEqual({ amountUsd: 100, pricedSubs: 1, totalSubs: 1 });
    expect(value.providers).toBeNull();
  });

  it("keeps unpriced plans honest: committed null, never $0", () => {
    const unpriced: DetectedPlan = {
      ...claudeMaxPlan,
      planId: undefined,
      planLabel: "Claude Max (tier: unknown)"
    };
    const value = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [claudeRecord()],
      detectedPlans: [unpriced]
    });
    expect(value.subscription?.agents[0]?.committedUsdPerMonth).toBeNull();
    expect(value.committedTotal).toEqual({ amountUsd: null, pricedSubs: 0, totalSubs: 1 });
  });

  it("totals committed across agents and provider subscriptions (2.1 committedTotal)", () => {
    const value = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [claudeRecord()],
      detectedPlans: [claudeMaxPlan],
      providerSubscriptions: [{
        provider: "cursor",
        planLabel: "Pro",
        committedUsdPerMonth: 20,
        billed30d: verifiedBilled(12.4)
      }]
    });
    expect(value.committedTotal).toEqual({ amountUsd: 120, pricedSubs: 2, totalSubs: 2 });
    expect(value.providers).toEqual([{
      provider: "cursor",
      billing: "subscription",
      planLabel: "Pro",
      committedUsdPerMonth: 20,
      billed30d: verifiedBilled(12.4)
    }]);
  });

  it("degrades non-verified provider dollars to a missing window — writer-side lock (QA-3)", () => {
    const value = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [claudeRecord()],
      detectedPlans: [claudeMaxPlan],
      providerSubscriptions: [{
        provider: "cursor",
        planLabel: "Pro",
        committedUsdPerMonth: 20,
        billed30d: {
          amountUsd: 12.4,
          recordCount: 1,
          basis: "provider_billed",
          // The beta cursor connector hard-codes estimated confidence.
          financialEvidence: "estimated" as unknown as "verified",
          coverage: "complete"
        }
      }]
    });
    expect(value.providers?.[0]?.billed30d).toEqual({
      amountUsd: null,
      recordCount: 0,
      basis: "provider_billed",
      financialEvidence: "missing",
      coverage: "missing"
    });
    // The committed price still counts — only the money claim is locked.
    expect(value.committedTotal.amountUsd).toBe(120);
  });

  it("dual-write payload carries today's exact v1 shape (QA-12b)", () => {
    const value = buildActivitySnapshot({
      asOf: AS_OF,
      generatedAt: AS_OF,
      records: [claudeRecord()],
      detectedPlans: [claudeMaxPlan],
      providerSubscriptions: [{
        provider: "cursor",
        planLabel: "Pro",
        committedUsdPerMonth: 20,
        billed30d: verifiedBilled(12.4)
      }]
    });
    const payload = activitySnapshotV1Payload(value);
    expect(Object.keys(payload).sort()).toEqual([
      "asOf", "coverage", "currency", "generatedAt", "kind", "lastAttemptAt",
      "lastSuccessAt", "metered", "mode", "networkUploaded", "overage",
      "refresh", "schemaVersion", "subscription", "unresolved"
    ]);
    expect(payload.schemaVersion).toBe(1);
    const subscription = payload.subscription as { agents: Array<Record<string, unknown>> };
    expect(Object.keys(subscription.agents[0]!).sort()).toEqual([
      "agent", "apiEquivalent", "billing", "limits", "planId", "pressure"
    ]);
    expect(JSON.stringify(payload)).not.toContain("committedUsdPerMonth");
    expect(JSON.stringify(payload)).not.toContain("committedTotal");
  });
});
