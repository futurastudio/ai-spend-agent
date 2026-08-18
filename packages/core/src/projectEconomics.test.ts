import { describe, expect, it } from "vitest";
import {
  ACCEPTED_OUTCOME_V0_KIND,
  APPROVAL_EVENT_V0_KIND,
  CONFIRMED_OWNERSHIP_V0_KIND,
  OWNERSHIP_SUGGESTION_V0_KIND,
  PROJECT_ECONOMICS_RECEIPT_V0_KIND,
  PROJECT_ECONOMICS_V0_VERSION,
  appendApprovalEventV0,
  createAcceptedOutcomeV0,
  createApprovalEventV0,
  createConfirmedOwnershipV0,
  createOwnershipSuggestionV0,
  createProjectEconomicsReceiptV0,
  createProjectEconomicsReference,
  deserializeProjectEconomicsReceiptV0,
  parseAcceptedOutcomeV0,
  parseApprovalEventV0,
  parseConfirmedOwnershipV0,
  parseOwnershipSuggestionV0,
  parseProjectEconomicsReceiptV0,
  serializeProjectEconomicsReceiptV0,
  type AcceptedOutcomeV0DraftInput,
  type ApprovalEventV0DraftInput,
  type ConfirmedOwnershipV0DraftInput,
  type ProjectEconomicsReceiptV0DraftInput
} from "./projectEconomics.js";

const GENERATED_AT = "2026-08-16T16:00:00.000Z";
const APPROVED_AT = "2026-08-16T12:00:00.000Z";
const ACCEPTED_AT = "2026-08-16T15:00:00.000Z";
const hex = (character: string): string => character.repeat(64);
const avref = (character: string): string => `avref_${hex(character)}`;

const projectRef = createProjectEconomicsReference("project", "agent-finops");
const workUnitRef = createProjectEconomicsReference("github-pr", "futurastudio/repo#42");
const ownerRef = createProjectEconomicsReference("person", "local-owner@example.test");
const teamRef = createProjectEconomicsReference("team", "developer-experience");
const approverRef = createProjectEconomicsReference("person", "local-approver@example.test");
const roleRef = createProjectEconomicsReference("role", "engineering-lead");
const repositoryRef = createProjectEconomicsReference("repository", "futurastudio/repo");
const commitRef = createProjectEconomicsReference("commit", "0123456789abcdef");
const checkRef = createProjectEconomicsReference("check", "ci:12345");
const costSourceRef = createProjectEconomicsReference("cost-source", "openai-admin:org");

function ownershipDraft(
  overrides: Partial<ConfirmedOwnershipV0DraftInput> = {}
): ConfirmedOwnershipV0DraftInput {
  return {
    kind: CONFIRMED_OWNERSHIP_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    status: "confirmed",
    projectRef,
    humanOwnerRef: ownerRef,
    teamRef,
    confirmation: {
      evidence: "user_declared",
      confirmedAt: "2026-08-16T11:00:00.000Z",
      confirmedByRef: ownerRef,
      locallyStored: true
    },
    ...overrides
  };
}

function approvalDraft(
  overrides: Partial<ApprovalEventV0DraftInput> = {}
): ApprovalEventV0DraftInput {
  return {
    kind: APPROVAL_EVENT_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    sequence: 0,
    previousEventId: null,
    approvedAt: APPROVED_AT,
    decision: "approved",
    attestation: {
      scope: "local_self_attested",
      evidence: "user_declared",
      approverIdentityRef: approverRef,
      approverRoleRef: roleRef,
      rbacVerified: false
    },
    references: {
      actionRef: avref("a"),
      changeRef: avref("b"),
      rollbackRef: avref("c"),
      canaryRef: avref("d")
    },
    ...overrides
  };
}

function outcomeDraft(
  overrides: Partial<AcceptedOutcomeV0DraftInput> = {}
): AcceptedOutcomeV0DraftInput {
  return {
    kind: ACCEPTED_OUTCOME_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    platform: "github",
    outcomeType: "pull_request",
    repositoryRef,
    workUnitRef,
    state: "merged",
    stateEvidence: "verified",
    acceptedAt: ACCEPTED_AT,
    commit: { commitRef, evidence: "verified" },
    checks: {
      status: "passed",
      evidence: "verified",
      evidenceRefs: [checkRef]
    },
    businessDescription: {
      value: "Reduced context carried into accepted coding tasks.",
      evidence: "user_declared"
    },
    ...overrides
  };
}

function receiptDraft(
  overrides: Partial<ProjectEconomicsReceiptV0DraftInput> = {}
): ProjectEconomicsReceiptV0DraftInput {
  return {
    kind: PROJECT_ECONOMICS_RECEIPT_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    generatedAt: GENERATED_AT,
    scope: { projectRef, workUnitRef },
    ownership: createConfirmedOwnershipV0(ownershipDraft()),
    costs: {
      lines: [{
        sourceRef: costSourceRef,
        basis: "api_equivalent_estimate",
        amountUsd: 12.5,
        evidence: "calculated"
      }],
      coverage: {
        status: "partial",
        coveredRecords: 8,
        eligibleRecords: 10,
        evidence: "calculated"
      }
    },
    action: {
      wasteFindingRef: `wf_v0_${hex("e")}`,
      tokenExperimentRef: `tre_v0_${hex("f")}`,
      tokenExperimentRevisionRef: `trev_v0_${hex("1")}`,
      approvalEvent: createApprovalEventV0(approvalDraft())
    },
    outcome: createAcceptedOutcomeV0(outcomeDraft()),
    measuredTokenResult: {
      status: "measured_token_reduction",
      baselineMedianTokens: 112_000,
      postChangeMedianTokens: 91_840,
      baselineSessions: 3,
      postChangeSessions: 3,
      reductionPercent: 18,
      metricEvidence: "calculated",
      matchingEvidence: "observed",
      qualityStatus: "held",
      qualityEvidence: "verified"
    },
    billReconciliation: {
      status: "not_attempted",
      evidence: "missing"
    },
    claims: {
      roi: "not_claimed",
      invoiceReconciled: false,
      rbacVerified: false
    },
    ...overrides
  };
}

describe("privacy-safe ownership contracts", () => {
  it("hashes source-native identities without returning them", () => {
    const first = createProjectEconomicsReference("person", "jose@example.test");
    const second = createProjectEconomicsReference("person", "jose@example.test");

    expect(first).toBe(second);
    expect(first).toMatch(/^peref_[a-f0-9]{64}$/);
    expect(first).not.toContain("jose");
    expect(() => createProjectEconomicsReference("../../secret", "person"))
      .toThrow();
    expect(() => createProjectEconomicsReference("person", "\ud800"))
      .toThrow();
  });

  it("keeps inferred suggestions structurally separate from confirmation", () => {
    const suggestion = createOwnershipSuggestionV0({
      kind: OWNERSHIP_SUGGESTION_V0_KIND,
      schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
      status: "suggested",
      generatedAt: GENERATED_AT,
      projectRef,
      suggestedHumanRef: ownerRef,
      suggestedTeamRef: teamRef,
      source: "codeowners",
      evidence: "observed",
      requiresUserConfirmation: true
    });

    expect(parseOwnershipSuggestionV0(suggestion)).toEqual(suggestion);
    expect(() => createConfirmedOwnershipV0(suggestion as never)).toThrow();
    expect(() => createConfirmedOwnershipV0({
      ...ownershipDraft(),
      confirmation: {
        ...ownershipDraft().confirmation,
        evidence: "observed"
      }
    } as never)).toThrow();
  });

  it("requires both a confirmed human owner and team", () => {
    expect(() => createConfirmedOwnershipV0({
      ...ownershipDraft(),
      humanOwnerRef: undefined
    } as never)).toThrow();
    expect(() => createConfirmedOwnershipV0({
      ...ownershipDraft(),
      teamRef: undefined
    } as never)).toThrow();

    const confirmed = createConfirmedOwnershipV0({
      ...ownershipDraft(),
      clientRef: createProjectEconomicsReference("client", "Futura"),
      costCenterRef: createProjectEconomicsReference("cost-center", "R&D")
    });
    expect(parseConfirmedOwnershipV0(confirmed)).toEqual(confirmed);
  });
});

describe("append-only approval evidence", () => {
  it("records local self-attested identity, role, and bounded action evidence", () => {
    const event = createApprovalEventV0(approvalDraft());
    expect(event).toMatchObject({
      sequence: 0,
      previousEventId: null,
      attestation: {
        scope: "local_self_attested",
        evidence: "user_declared",
        rbacVerified: false
      }
    });
    expect(parseApprovalEventV0(event)).toEqual(event);
  });

  it("derives a monotonic digest chain without mutating history", () => {
    const first = createApprovalEventV0(approvalDraft());
    const original = [first];
    const appended = appendApprovalEventV0(original, {
      ...approvalDraft({ approvedAt: "2026-08-16T13:00:00.000Z" }),
      decision: "approved"
    } as Omit<ApprovalEventV0DraftInput, "sequence" | "previousEventId">);

    expect(original).toHaveLength(1);
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({ sequence: 1, previousEventId: first.id });
    expect(() => appendApprovalEventV0(original, {
      ...approvalDraft({ approvedAt: "2026-08-16T10:00:00.000Z" })
    } as Omit<ApprovalEventV0DraftInput, "sequence" | "previousEventId">))
      .toThrow(/predate/);
  });

  it("fails closed on forged content and broken chain claims", () => {
    const event = createApprovalEventV0(approvalDraft());
    expect(() => parseApprovalEventV0({
      ...event,
      references: { ...event.references, actionRef: avref("9") }
    })).toThrow(/canonical body/);
    expect(() => createApprovalEventV0(approvalDraft({
      sequence: 1,
      previousEventId: null
    }))).toThrow();
  });
});

describe("accepted GitHub outcomes", () => {
  it("requires merged PR state plus linked commit and passed checks", () => {
    const outcome = createAcceptedOutcomeV0(outcomeDraft());
    expect(parseAcceptedOutcomeV0(outcome)).toEqual(outcome);
    expect(outcome.businessDescription?.evidence).toBe("user_declared");

    expect(() => createAcceptedOutcomeV0(outcomeDraft({ state: "accepted" })))
      .toThrow(/must be merged/);
    expect(() => createAcceptedOutcomeV0(outcomeDraft({
      stateEvidence: "user_declared"
    }))).toThrow(/observed or verified/);
    expect(() => createAcceptedOutcomeV0({
      ...outcomeDraft(),
      checks: { status: "passed", evidence: "verified", evidenceRefs: [] }
    })).toThrow();
  });

  it("allows a user-attested accepted GitHub task but still requires code evidence", () => {
    const task = createAcceptedOutcomeV0(outcomeDraft({
      outcomeType: "task",
      state: "accepted",
      stateEvidence: "user_declared"
    }));
    expect(task.state).toBe("accepted");
    expect(task.commit.evidence).toBe("verified");
    expect(task.checks.status).toBe("passed");
  });
});

describe("ProjectEconomicsReceiptV0", () => {
  it("links ownership, cost, approval, outcome, and a defensible token result", () => {
    const receipt = createProjectEconomicsReceiptV0(receiptDraft());

    expect(receipt).toMatchObject({
      kind: "aibill.project_economics_receipt",
      measuredTokenResult: {
        status: "measured_token_reduction",
        reductionPercent: 18,
        qualityStatus: "held"
      },
      billReconciliation: { status: "not_attempted", evidence: "missing" },
      claims: {
        roi: "not_claimed",
        invoiceReconciled: false,
        rbacVerified: false
      }
    });
    expect(parseProjectEconomicsReceiptV0(receipt)).toEqual(receipt);
    expect(deserializeProjectEconomicsReceiptV0(
      serializeProjectEconomicsReceiptV0(receipt)
    )).toEqual(receipt);
  });

  it("canonicalizes equivalent line and check ordering into one digest", () => {
    const otherSource = createProjectEconomicsReference("cost-source", "anthropic-admin");
    const checkTwo = createProjectEconomicsReference("check", "security:12345");
    const lines = [
      {
        sourceRef: costSourceRef,
        basis: "api_equivalent_estimate" as const,
        amountUsd: 12.5,
        evidence: "calculated" as const
      },
      {
        sourceRef: otherSource,
        basis: "subscription_included" as const,
        amountUsd: 4,
        evidence: "observed" as const
      }
    ];
    const first = createProjectEconomicsReceiptV0(receiptDraft({
      costs: {
        lines,
        coverage: { status: "complete", coveredRecords: 2, eligibleRecords: 2,
          evidence: "calculated" }
      },
      outcome: createAcceptedOutcomeV0(outcomeDraft({
        checks: {
          status: "passed",
          evidence: "verified",
          evidenceRefs: [checkTwo, checkRef]
        }
      }))
    }));
    const second = createProjectEconomicsReceiptV0(receiptDraft({
      costs: {
        lines: [...lines].reverse(),
        coverage: { status: "complete", coveredRecords: 2, eligibleRecords: 2,
          evidence: "calculated" }
      },
      outcome: createAcceptedOutcomeV0(outcomeDraft({
        checks: {
          status: "passed",
          evidence: "verified",
          evidenceRefs: [checkRef, checkTwo]
        }
      }))
    }));

    expect(second).toEqual(first);
  });

  it("rejects invented evidence, arithmetic, ownership, and outcome links", () => {
    expect(() => createProjectEconomicsReceiptV0(receiptDraft({
      costs: {
        lines: [{
          sourceRef: costSourceRef,
          basis: "provider_billed",
          amountUsd: 12,
          evidence: "calculated"
        }],
        coverage: { status: "complete", coveredRecords: 1, eligibleRecords: 1,
          evidence: "verified" }
      }
    }))).toThrow(/cannot support/);
    expect(() => createProjectEconomicsReceiptV0(receiptDraft({
      measuredTokenResult: {
        ...receiptDraft().measuredTokenResult,
        reductionPercent: 25
      }
    }))).toThrow(/must match/);
    expect(() => createProjectEconomicsReceiptV0(receiptDraft({
      ownership: createConfirmedOwnershipV0(ownershipDraft({
        projectRef: createProjectEconomicsReference("project", "other")
      }))
    }))).toThrow(/receipt project/);
    expect(() => createProjectEconomicsReceiptV0(receiptDraft({
      outcome: createAcceptedOutcomeV0(outcomeDraft({
        workUnitRef: createProjectEconomicsReference("github-pr", "repo#99")
      }))
    }))).toThrow(/receipt work unit/);
  });

  it("rejects tampered receipts and unknown fields", () => {
    const receipt = createProjectEconomicsReceiptV0(receiptDraft());
    expect(() => parseProjectEconomicsReceiptV0({
      ...receipt,
      measuredTokenResult: {
        ...receipt.measuredTokenResult,
        postChangeMedianTokens: 90_000
      }
    })).toThrow();
    expect(() => parseProjectEconomicsReceiptV0({ ...receipt, roiUsd: 1000 }))
      .toThrow();
    expect(() => deserializeProjectEconomicsReceiptV0("not-json"))
      .toThrow(/valid JSON/);
  });

  it("permits a partial provider-bill match without claiming invoice or ROI", () => {
    const receipt = createProjectEconomicsReceiptV0(receiptDraft({
      billReconciliation: {
        status: "partial",
        evidence: "verified",
        providerBillRef: createProjectEconomicsReference("provider-bill", "bucket-1"),
        coveragePercent: 94,
        matchedAmountUsd: 12.5
      }
    }));
    expect(receipt.billReconciliation.status).toBe("partial");
    expect(receipt.claims).toEqual({
      roi: "not_claimed",
      invoiceReconciled: false,
      rbacVerified: false
    });
    expect(() => createProjectEconomicsReceiptV0(receiptDraft({
      billReconciliation: {
        status: "partial",
        evidence: "verified",
        providerBillRef: createProjectEconomicsReference("provider-bill", "bucket-1"),
        coveragePercent: 100,
        matchedAmountUsd: 12.5
      }
    }))).toThrow(/below complete coverage/);
  });
});
