import { describe, expect, it } from "vitest";
import type { ResultCard } from "./resultCard.js";
import {
  buildReceiptShareCardV0,
  decideReceiptEmailDeliveryV0,
  receiptEmailRequestV0Schema,
  receiptShareCardV0Schema
} from "./receiptShare.js";

const resultCard: ResultCard = {
  kind: "aibill.result_card",
  schemaVersion: 1,
  currency: "USD",
  windowDays: 30,
  mode: "mixed",
  subscriptions: [
    {
      id: "claude",
      agentId: "claude-code",
      planLabel: "Max 20x",
      connection: "local_logs",
      committedUsdPerMonth: 200,
      apiEquivalentUsd: 7.5,
      providerBilledUsd: null,
      detectedUnverifiedUsd: null,
      runways: []
    },
    {
      id: "chatgpt",
      agentId: "codex",
      planLabel: "Pro",
      connection: "connected",
      committedUsdPerMonth: 200,
      apiEquivalentUsd: null,
      providerBilledUsd: 8.66,
      detectedUnverifiedUsd: null,
      runways: []
    }
  ],
  totals: {
    subscriptionCommitted: { amountUsd: 400, pricedSubs: 2, totalSubs: 2 },
    apiEquivalent: { amountUsd: 7.5, financialEvidence: "estimated" },
    providerBilled: { amountUsd: 8.66, financialEvidence: "verified" },
    blended: null,
    blendPolicy: "never_blended"
  },
  byProject: null
};

const shareCard = () => buildReceiptShareCardV0({
  resultCard,
  providerCount: 2,
  recordCount: 12,
  confidence: "verified",
  cuts: [
    {
      template: "narrow_context",
      modeledOpportunityUsd: 3.25,
      evidence: "modeled_not_verified"
    }
  ]
});

describe("receipt share V0 aggregate contract", () => {
  it("projects only bounded aggregate fields and preserves all three financial bases", () => {
    const card = shareCard();

    expect(card).toEqual({
      kind: "aibill.receipt_share_card",
      schemaVersion: "0.1.0",
      currency: "USD",
      windowDays: 30,
      mode: "mixed",
      transportEvidence: "client_supplied_aggregate",
      financials: resultCard.totals,
      providerCount: 2,
      recordCount: 12,
      confidence: "verified",
      cuts: [{
        template: "narrow_context",
        modeledOpportunityUsd: 3.25,
        evidence: "modeled_not_verified"
      }],
      contentBoundary: {
        rawHistoryIncluded: false,
        localIdentifiersIncluded: false,
        clientMarkupIncluded: false
      }
    });
    expect(receiptShareCardV0Schema.parse(card)).toEqual(card);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("totalUsd");
    expect(serialized).not.toContain("savingsUsd");
    expect(serialized).not.toContain("project");
    expect(serialized).not.toContain("clientId");
    expect(serialized).not.toContain("clientName");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("response");
    expect(serialized).not.toContain("html");
    expect(serialized).not.toContain("svg");
  });

  it("rejects sample/demo cards from a real delivery payload", () => {
    expect(() => buildReceiptShareCardV0({
      resultCard: { ...resultCard, mode: "demo", subscriptions: [], totals: {
        ...resultCard.totals,
        subscriptionCommitted: { amountUsd: null, pricedSubs: 0, totalSubs: 0 }
      } },
      providerCount: 1,
      recordCount: 1,
      confidence: "estimated",
      cuts: []
    })).toThrow();
  });

  it("rejects legacy blended totals and savings claims", () => {
    const valid = shareCard();
    expect(receiptShareCardV0Schema.safeParse({ ...valid, totalUsd: 16.16 }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({ ...valid, savingsUsd: 3.25 }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      financials: { ...valid.financials, blended: 16.16 }
    }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      financials: { ...valid.financials, blendPolicy: "sum_everything" }
    }).success).toBe(false);
  });

  it("cannot relabel a client-supplied aggregate as server-verified evidence", () => {
    const valid = shareCard();
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      transportEvidence: "server_verified"
    }).success).toBe(false);
  });

  it("rejects identity, history, and client-markup fields", () => {
    const valid = shareCard();
    for (const extra of [
      { project: "secret-project" },
      { client: "secret-client" },
      { owner: "private person" },
      { rawHistory: [{ prompt: "secret" }] },
      { html: "<a href='https://phish.example'>approve</a>" },
      { svg: "<svg onload='alert(1)'>" }
    ]) {
      expect(receiptShareCardV0Schema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it("allows at most three fixed-template cuts and no free-form labels", () => {
    const valid = shareCard();
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      cuts: Array.from({ length: 4 }, () => valid.cuts[0])
    }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      cuts: [{ ...valid.cuts[0], title: "Click this private project" }]
    }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      cuts: [{ ...valid.cuts[0], model: "../../private/path" }]
    }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      cuts: [{ ...valid.cuts[0], evidence: "verified_savings" }]
    }).success).toBe(false);
  });

  it("rejects invalid, negative, non-finite, and contradictory numeric evidence", () => {
    const valid = shareCard();
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, "7.50"]) {
      expect(receiptShareCardV0Schema.safeParse({
        ...valid,
        financials: {
          ...valid.financials,
          apiEquivalent: { amountUsd: amount, financialEvidence: "estimated" }
        }
      }).success).toBe(false);
    }
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      financials: {
        ...valid.financials,
        providerBilled: { amountUsd: 8.66, financialEvidence: "missing" }
      }
    }).success).toBe(false);
    expect(receiptShareCardV0Schema.safeParse({
      ...valid,
      providerCount: 13,
      recordCount: 12
    }).success).toBe(false);
  });
});

describe("receipt email request and authorization groundwork", () => {
  it("normalizes an explicit recipient and names the exact consent scope", () => {
    const request = receiptEmailRequestV0Schema.parse({
      kind: "aibill.receipt_email_request",
      schemaVersion: "0.1.0",
      recipientEmail: "  Founder@Example.COM ",
      consent: "email_and_aggregate_card_via_mail_provider",
      card: shareCard()
    });

    expect(request.recipientEmail).toBe("founder@example.com");
    expect(request.consent).toBe("email_and_aggregate_card_via_mail_provider");
  });

  it("rejects control bytes, malformed recipients, hidden fields, and client markup", () => {
    const base = {
      kind: "aibill.receipt_email_request",
      schemaVersion: "0.1.0",
      recipientEmail: "founder@example.com",
      consent: "email_and_aggregate_card_via_mail_provider",
      card: shareCard()
    };
    for (const recipientEmail of [
      "founder@example.com\nBcc: victim@example.com",
      "founder@example.com\u0000",
      "not-an-email",
      "@example.com"
    ]) {
      expect(receiptEmailRequestV0Schema.safeParse({ ...base, recipientEmail }).success).toBe(false);
    }
    expect(receiptEmailRequestV0Schema.safeParse({ ...base, html: "<b>trusted</b>" }).success).toBe(false);
    expect(receiptEmailRequestV0Schema.safeParse({ ...base, subject: "urgent invoice" }).success).toBe(false);
  });

  it("requires existing waitlist membership before rate-limit evaluation", () => {
    expect(decideReceiptEmailDeliveryV0({
      waitlistMember: false,
      emailSendsLast24Hours: 99,
      ipSendsLast24Hours: 99
    })).toEqual({ status: "join_first", httpStatus: 403 });
  });

  it("enforces durable-counter limits of one per email and ten per IP per day", () => {
    expect(decideReceiptEmailDeliveryV0({
      waitlistMember: true,
      emailSendsLast24Hours: 1,
      ipSendsLast24Hours: 0
    })).toEqual({ status: "rate_limited", httpStatus: 429, scope: "email" });
    expect(decideReceiptEmailDeliveryV0({
      waitlistMember: true,
      emailSendsLast24Hours: 0,
      ipSendsLast24Hours: 10
    })).toEqual({ status: "rate_limited", httpStatus: 429, scope: "ip" });
  });

  it("accepts only a waitlisted request below both durable limits", () => {
    expect(decideReceiptEmailDeliveryV0({
      waitlistMember: true,
      emailSendsLast24Hours: 0,
      ipSendsLast24Hours: 9
    })).toEqual({ status: "accepted", httpStatus: 202 });
  });

  it("fails closed on malformed or unbounded counter state", () => {
    for (const counters of [
      { waitlistMember: true, emailSendsLast24Hours: -1, ipSendsLast24Hours: 0 },
      { waitlistMember: true, emailSendsLast24Hours: 0.5, ipSendsLast24Hours: 0 },
      { waitlistMember: true, emailSendsLast24Hours: 0, ipSendsLast24Hours: Number.NaN },
      { waitlistMember: true, emailSendsLast24Hours: 0, ipSendsLast24Hours: 1_000_001 }
    ]) {
      expect(() => decideReceiptEmailDeliveryV0(counters)).toThrow();
    }
  });
});
