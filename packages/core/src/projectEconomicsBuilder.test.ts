import { describe, expect, it } from "vitest";
import {
  TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
  TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
  WASTE_FINDING_V0_KIND,
  WASTE_FINDING_V0_VERSION,
  createActionVerificationReference,
  createTokenReductionExperimentV0,
  createWasteFindingV0,
  type TokenExperimentSessionV0Input,
  type TokenReductionExperimentV0
} from "./actionVerification.js";
import {
  ACCEPTED_OUTCOME_V0_KIND,
  APPROVAL_EVENT_V0_KIND,
  CONFIRMED_OWNERSHIP_V0_KIND,
  PROJECT_ECONOMICS_V0_VERSION,
  createAcceptedOutcomeV0,
  createApprovalEventV0,
  createConfirmedOwnershipV0,
  createProjectEconomicsReference
} from "./projectEconomics.js";
import {
  buildProjectEconomicsProjectionV0,
  createProjectEconomicsApprovalActionRefV0,
  createProjectEconomicsPlannedActionRefV0,
  type BuildProjectEconomicsProjectionV0Input,
  type ProjectEconomicsUsageBindingV0
} from "./projectEconomicsBuilder.js";
import type { UsageRecord } from "./schema.js";

const GENERATED_AT = "2026-08-16T16:00:00.000Z";
const APPROVED_AT = "2026-08-10T09:55:00.000Z";
const projectRef = createProjectEconomicsReference("project", "agent-finops");
const workUnitRef = createProjectEconomicsReference("github-pr", "repo#88");
const otherWorkUnitRef = createProjectEconomicsReference("github-pr", "repo#89");
const actionProjectRef = createActionVerificationReference("project", "agent-finops");
const actionWorkUnitRef = createActionVerificationReference("github-pr", "repo#88");
const sourceVersionRef = createActionVerificationReference(
  "source-version",
  "claude-code-2.1.170"
);
const workTypeRef = createActionVerificationReference("work-type", "fix-and-test");
const changeRef = createActionVerificationReference("change", "one-context-change");
const rollbackRef = createActionVerificationReference("rollback", "restore-context-change");
const canaryRef = createActionVerificationReference("quality", "canary-passed");

function quality(
  status: "passed" | "failed" = "passed"
): TokenExperimentSessionV0Input["quality"] {
  return { status, evidence: "user_declared" };
}

function session(
  label: string,
  totalTokens: number,
  startedAt: string,
  options: {
    qualityStatus?: "passed" | "failed";
    workUnit?: string;
  } = {}
): TokenExperimentSessionV0Input {
  return {
    sessionRef: createActionVerificationReference("session", label),
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(),
    agent: "claude-code",
    provider: "anthropic",
    model: "claude-sonnet-5",
    projectRef: actionProjectRef,
    sessionType: "parent",
    workTypeRef,
    workUnitRef: options.workUnit ?? actionWorkUnitRef,
    workUnitEvidence: "verified",
    sourceVersionRef,
    sourceValidationCoverage: "live_verified",
    tokens: {
      uncachedInputTokens: totalTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      calculatedTotalTokens: totalTokens,
      reportedTotalTokens: totalTokens,
      componentEvidence: {
        uncachedInputTokens: "observed",
        cacheReadTokens: "observed",
        cacheWriteTokens: "observed",
        toolTokens: "observed",
        outputTokens: "observed",
        thoughtTokens: "observed",
        calculatedTotalTokens: "calculated_complete",
        reportedTotalTokens: "provider_reported"
      }
    },
    quality: quality(options.qualityStatus)
  };
}

function experiment(options: {
  postQuality?: "passed" | "failed";
  workUnit?: string;
  distinctWorkUnits?: boolean;
} = {}): TokenReductionExperimentV0 {
  const finding = createWasteFindingV0({
    kind: WASTE_FINDING_V0_KIND,
    schemaVersion: WASTE_FINDING_V0_VERSION,
    generatedAt: "2026-08-01T10:00:00.000Z",
    window: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-08-01T00:00:00.000Z"
    },
    findingType: "high_context_relative_to_baseline",
    objective: {
      metric: "total_tokens_per_matched_session",
      direction: "reduce",
      guard: "user_declared_quality_must_hold"
    },
    caveats: ["signal_not_cause", "no_cash_claim", "missing_outcome_evidence"],
    candidateAction: {
      kind: "trim_context",
      provider: "anthropic",
      surface: "local_agent_configuration",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: {
      kind: "session",
      ref: createActionVerificationReference("session", "high-context-target")
    },
    scope: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef: actionProjectRef
    },
    source: {
      id: "claude-code-local",
      validationCoverage: "live_verified",
      freshness: "fresh"
    },
    metric: {
      name: "input_context_tokens",
      unit: "tokens",
      value: 1_200,
      sampleCount: 3,
      evidence: "calculated"
    },
    evidenceRefs: [createActionVerificationReference("evidence", "context-ratio")],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });
  const workUnit = options.workUnit ?? actionWorkUnitRef;
  const baselineWorkUnit = (index: number) => options.distinctWorkUnits
    ? createActionVerificationReference("github-pr", `baseline-${index}`)
    : workUnit;
  const postWorkUnit = (index: number) => options.distinctWorkUnits && index > 0
    ? createActionVerificationReference("github-pr", `post-${index}`)
    : workUnit;
  return createTokenReductionExperimentV0({
    kind: TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
    schemaVersion: TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
    createdAt: "2026-08-07T12:00:00.000Z",
    finding,
    cohort: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef: actionProjectRef,
      sessionType: "parent",
      workTypeRef,
      workTypeEvidence: "user_declared",
      sourceVersionRef
    },
    matchingPolicy: {
      basis: "accepted_work_unit",
      minimumBaselineSessions: 3,
      minimumPostSessions: 3,
      requireExactSourceVersion: true
    },
    qualityGuard: {
      required: true,
      minimumEvidence: "user_declared",
      rollbackOnRegression: true
    },
    baselineSessions: [
      session("baseline-1", 1_000, "2026-08-04T10:00:00.000Z", {
        workUnit: baselineWorkUnit(0)
      }),
      session("baseline-2", 1_200, "2026-08-05T10:00:00.000Z", {
        workUnit: baselineWorkUnit(1)
      }),
      session("baseline-3", 1_400, "2026-08-06T10:00:00.000Z", {
        workUnit: baselineWorkUnit(2)
      })
    ],
    intervention: {
      approval: {
        status: "explicit",
        evidence: "user_declared",
        approvedAt: APPROVED_AT
      },
      appliedAt: "2026-08-10T10:00:00.000Z",
      changeRef,
      rollbackRef,
      canary: {
        status: "passed",
        evidence: "observed",
        evidenceRef: canaryRef
      }
    },
    postSessions: [
      session("post-1", 800, "2026-08-11T10:00:00.000Z", {
        workUnit: postWorkUnit(0),
        qualityStatus: options.postQuality
      }),
      session("post-2", 960, "2026-08-12T10:00:00.000Z", {
        workUnit: postWorkUnit(1),
        qualityStatus: options.postQuality
      }),
      session("post-3", 1_120, "2026-08-13T10:00:00.000Z", {
        workUnit: postWorkUnit(2),
        qualityStatus: options.postQuality
      })
    ]
  });
}

function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "openai-billed",
    timestamp: "2026-08-14T00:00:00.000Z",
    source: {
      id: "openai-costs",
      name: "OpenAI organization costs API",
      provider: "openai",
      confidence: "verified",
      observedFrom: "Costs API"
    },
    model: "gpt-5",
    inputTokens: 0,
    outputTokens: 0,
    amountUsd: 25,
    costConfidence: "verified",
    providerCostType: "openai_cost",
    usageGranularity: "billing_bucket",
    ...overrides
  };
}

function binding(
  record: UsageRecord,
  overrides: Partial<Omit<ProjectEconomicsUsageBindingV0, "record">> = {}
): ProjectEconomicsUsageBindingV0 {
  return {
    record,
    projectRef,
    projectEvidence: "observed",
    workUnitRef,
    workUnitEvidence: "verified",
    ...overrides
  };
}

function ownership() {
  const ownerRef = createProjectEconomicsReference("person", "local-owner");
  return createConfirmedOwnershipV0({
    kind: CONFIRMED_OWNERSHIP_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    status: "confirmed",
    projectRef,
    humanOwnerRef: ownerRef,
    teamRef: createProjectEconomicsReference("team", "developer-experience"),
    confirmation: {
      evidence: "user_declared",
      confirmedAt: "2026-08-09T12:00:00.000Z",
      confirmedByRef: ownerRef,
      locallyStored: true
    }
  });
}

function approval(tokenExperiment: TokenReductionExperimentV0, wrongChange = false) {
  return createApprovalEventV0({
    kind: APPROVAL_EVENT_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    sequence: 0,
    previousEventId: null,
    approvedAt: APPROVED_AT,
    decision: "approved",
    attestation: {
      scope: "local_self_attested",
      evidence: "user_declared",
      approverIdentityRef: createProjectEconomicsReference("person", "local-approver"),
      approverRoleRef: createProjectEconomicsReference("role", "engineering-lead"),
      rbacVerified: false
    },
    references: {
      actionRef: createProjectEconomicsApprovalActionRefV0(tokenExperiment),
      changeRef: wrongChange
        ? createActionVerificationReference("change", "different-change")
        : changeRef,
      rollbackRef,
      canaryRef
    }
  });
}

function outcome() {
  return createAcceptedOutcomeV0({
    kind: ACCEPTED_OUTCOME_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    platform: "github",
    outcomeType: "pull_request",
    repositoryRef: createProjectEconomicsReference("repository", "futurastudio/repo"),
    workUnitRef,
    state: "merged",
    stateEvidence: "verified",
    acceptedAt: "2026-08-15T15:00:00.000Z",
    commit: {
      commitRef: createProjectEconomicsReference("commit", "abc123"),
      evidence: "verified"
    },
    checks: {
      status: "passed",
      evidence: "verified",
      evidenceRefs: [createProjectEconomicsReference("check", "ci:123")]
    }
  });
}

function completeInput(
  records: ProjectEconomicsUsageBindingV0[],
  tokenExperiment = experiment()
): BuildProjectEconomicsProjectionV0Input {
  return {
    generatedAt: GENERATED_AT,
    scope: { projectRef, workUnitRef, actionProjectRef, actionWorkUnitRef },
    financialRecords: records,
    ownership: ownership(),
    approvalEvent: approval(tokenExperiment),
    outcome: outcome(),
    tokenExperiment
  };
}

describe("project economics projection builder", () => {
  it("keeps provider-billed money and API-equivalent value in distinct lines", () => {
    const localValue = usageRecord({
      id: "claude-local-value",
      source: {
        id: "claude-local",
        name: "Claude Code local logs",
        provider: "anthropic",
        confidence: "estimated",
        observedFrom: "local transcripts"
      },
      model: "claude-sonnet-5",
      inputTokens: 10_000,
      amountUsd: 10,
      costConfidence: "estimated",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    });
    const projection = buildProjectEconomicsProjectionV0(completeInput([
      binding(usageRecord()),
      binding(localValue)
    ]));

    expect(projection.status).toBe("receipt_ready");
    expect(projection.costs.coverage).toEqual({
      status: "complete",
      coveredRecords: 2,
      eligibleRecords: 2,
      evidence: "calculated"
    });
    expect(projection.costs.lines.map((line) => ({
      basis: line.basis,
      amountUsd: line.amountUsd,
      evidence: line.evidence
    }))).toEqual(expect.arrayContaining([
      { basis: "provider_billed", amountUsd: 25, evidence: "verified" },
      { basis: "api_equivalent_estimate", amountUsd: 10, evidence: "calculated" }
    ]));
    expect(projection.receipt?.measuredTokenResult).toMatchObject({
      status: "measured_token_reduction",
      reductionPercent: 20,
      qualityStatus: "held"
    });
    expect(projection.receipt?.claims).toEqual({
      roi: "not_claimed",
      invoiceReconciled: false,
      rbacVerified: false
    });
    expect(projection.receipt?.billReconciliation).toEqual({
      status: "not_attempted",
      evidence: "missing"
    });
    expect(projection.missing).toEqual([{
      code: "provider_bill_reconciliation",
      evidence: "missing",
      blocksReceipt: false
    }]);
  });

  it("returns stable explicit missing evidence instead of inventing a receipt", () => {
    const projection = buildProjectEconomicsProjectionV0({
      generatedAt: GENERATED_AT,
      scope: { projectRef, workUnitRef, actionProjectRef, actionWorkUnitRef },
      financialRecords: []
    });

    expect(projection.status).toBe("incomplete");
    expect(projection.receipt).toBeNull();
    expect(projection.costs).toEqual({
      lines: [],
      coverage: {
        status: "missing",
        coveredRecords: 0,
        eligibleRecords: 0,
        evidence: "missing"
      }
    });
    expect(projection.missing.map((entry) => entry.code)).toEqual([
      "confirmed_ownership",
      "token_experiment",
      "approval_event",
      "accepted_outcome",
      "financial_cost_evidence",
      "measured_token_result",
      "provider_bill_reconciliation"
    ]);
  });

  it("keeps estimated Cursor and Copilot list-price rows missing", () => {
    const cursor = usageRecord({
      id: "cursor-estimate",
      source: {
        id: "cursor-spend",
        name: "Cursor Admin API",
        provider: "cursor",
        confidence: "estimated",
        observedFrom: "Admin API"
      },
      amountUsd: 30,
      costConfidence: "estimated",
      providerCostType: "cursor_spend",
      usageGranularity: "user_aggregate"
    });
    const copilot = usageRecord({
      id: "copilot-list-price",
      source: {
        id: "copilot-seats",
        name: "GitHub Copilot billing seats API",
        provider: "github-copilot",
        confidence: "estimated",
        observedFrom: "Seats API"
      },
      amountUsd: 19,
      costConfidence: "estimated",
      providerCostType: "copilot_seat_reconciliation",
      usageGranularity: "seat"
    });
    const projection = buildProjectEconomicsProjectionV0(completeInput([
      binding(cursor),
      binding(copilot)
    ]));

    expect(projection.status).toBe("receipt_ready");
    expect(projection.costs.coverage.status).toBe("missing");
    expect(projection.costs.lines).toHaveLength(2);
    expect(projection.costs.lines.every((line) =>
      line.basis === "missing" && line.amountUsd === null && line.evidence === "missing"
    )).toBe(true);
    expect(projection.costs.lines.some((line) =>
      line.basis === "provider_billed" || line.basis === "api_equivalent_estimate"
    )).toBe(false);
  });

  it("never promotes an API-equivalent source to billed money from labels alone", () => {
    const mislabeledLocal = usageRecord({
      id: "mislabeled-local",
      source: {
        id: "local",
        name: "Local transcript estimate",
        provider: "anthropic",
        confidence: "verified",
        observedFrom: "local transcripts"
      },
      amountUsd: 99,
      costConfidence: "verified",
      providerCostType: "local_agent_logs",
      usageGranularity: "billing_bucket"
    });
    const projection = buildProjectEconomicsProjectionV0(
      completeInput([binding(mislabeledLocal)])
    );

    expect(projection.costs.lines).toEqual([
      expect.objectContaining({ basis: "missing", amountUsd: null, evidence: "missing" })
    ]);
  });

  it("fails closed on a forged experiment revision", () => {
    const tokenExperiment = experiment();
    const forged = {
      ...tokenExperiment,
      revisionId: `trev_v0_${"0".repeat(64)}`
    } as TokenReductionExperimentV0;
    expect(() => buildProjectEconomicsProjectionV0({
      ...completeInput([binding(usageRecord())], tokenExperiment),
      tokenExperiment: forged
    })).toThrow(/identity, revision, or derived evaluation/);
  });

  it("never turns a quality regression into a positive reduction", () => {
    const regressed = experiment({ postQuality: "failed" });
    expect(regressed.evaluation.status).toBe("regressed");
    const projection = buildProjectEconomicsProjectionV0(
      completeInput([binding(usageRecord())], regressed)
    );

    expect(projection.measuredTokenResult).toMatchObject({
      status: "inconclusive",
      reductionPercent: null,
      metricEvidence: "missing",
      qualityStatus: "insufficient",
      qualityEvidence: "missing"
    });
    expect(projection.receipt?.measuredTokenResult.reductionPercent).toBeNull();
    expect(projection.missing.map((entry) => entry.code)).toContain(
      "measured_token_result"
    );
  });

  it("requires approval of the exact applied action and intervention refs", () => {
    const tokenExperiment = experiment();
    const projection = buildProjectEconomicsProjectionV0({
      ...completeInput([binding(usageRecord())], tokenExperiment),
      approvalEvent: approval(tokenExperiment, true)
    });

    expect(projection.status).toBe("incomplete");
    expect(projection.receipt).toBeNull();
    expect(projection.missing).toContainEqual({
      code: "approval_experiment_link",
      evidence: "missing",
      blocksReceipt: true
    });
  });

  it("keeps the approved-action ref stable as post evidence advances the revision", () => {
    const completed = experiment();
    const {
      id: _id,
      revisionId: _revisionId,
      lifecycle: _lifecycle,
      evaluation: _evaluation,
      ...body
    } = completed;
    const applied = createTokenReductionExperimentV0({
      ...body,
      postSessions: []
    });

    expect(applied.revisionId).not.toBe(completed.revisionId);
    expect(createProjectEconomicsApprovalActionRefV0(applied)).toBe(
      createProjectEconomicsApprovalActionRefV0(completed)
    );
  });

  it("binds the exact planned action before application and preserves it afterward", () => {
    const completed = experiment();
    const {
      id: _id,
      revisionId: _revisionId,
      lifecycle: _lifecycle,
      evaluation: _evaluation,
      ...body
    } = completed;
    const baselineReady = createTokenReductionExperimentV0({
      ...body,
      intervention: {
        approval: { status: "pending", evidence: "missing" }
      },
      postSessions: []
    });
    const planned = createProjectEconomicsPlannedActionRefV0(baselineReady, {
      changeRef,
      rollbackRef,
      canaryRef
    });

    expect(baselineReady.lifecycle).toBe("baseline_ready");
    expect(planned).toBe(createProjectEconomicsApprovalActionRefV0(completed));
    expect(() => createProjectEconomicsPlannedActionRefV0(baselineReady, {
      changeRef,
      rollbackRef,
      canaryRef: "not-an-opaque-reference"
    })).toThrow(/opaque change, rollback, and canary references/);
  });

  it("does not count a differently attributed work unit as covered cost", () => {
    const projection = buildProjectEconomicsProjectionV0(completeInput([
      binding(usageRecord()),
      binding(usageRecord({ id: "other-work-unit", amountUsd: 500 }), {
        workUnitRef: otherWorkUnitRef
      })
    ]));

    expect(projection.costs.coverage).toEqual({
      status: "partial",
      coveredRecords: 1,
      eligibleRecords: 2,
      evidence: "calculated"
    });
    expect(projection.costs.lines.find((line) =>
      line.basis === "provider_billed"
    )?.amountUsd).toBe(25);
    expect(projection.costs.lines.some((line) =>
      line.basis === "missing" && line.amountUsd === null
    )).toBe(true);
    expect(projection.missing.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["financial_work_unit_attribution", "financial_cost_evidence"])
    );
  });

  it("withholds a scoped result when experiment sessions target another work unit", () => {
    const otherActionWorkUnit = createActionVerificationReference("github-pr", "repo#89");
    const tokenExperiment = experiment({ workUnit: otherActionWorkUnit });
    const projection = buildProjectEconomicsProjectionV0(
      completeInput([binding(usageRecord())], tokenExperiment)
    );

    expect(projection.status).toBe("incomplete");
    expect(projection.receipt).toBeNull();
    expect(projection.measuredTokenResult.reductionPercent).toBeNull();
    expect(projection.missing).toContainEqual({
      code: "experiment_work_unit_scope",
      evidence: "missing",
      blocksReceipt: true
    });
  });

  it("links one exact accepted post outcome without pretending the cohort is one PR", () => {
    const tokenExperiment = experiment({ distinctWorkUnits: true });
    const projection = buildProjectEconomicsProjectionV0(
      completeInput([binding(usageRecord())], tokenExperiment)
    );

    expect(projection.status).toBe("receipt_ready");
    expect(projection.receipt?.outcome.workUnitRef).toBe(workUnitRef);
    expect(projection.measuredTokenResult).toMatchObject({
      status: "measured_token_reduction",
      reductionPercent: 20
    });
  });

  it("is deterministic across financial record input order", () => {
    const local = usageRecord({
      id: "local-value",
      source: {
        id: "local",
        name: "Local agent logs",
        provider: "anthropic",
        confidence: "estimated",
        observedFrom: "local transcripts"
      },
      amountUsd: 3,
      costConfidence: "estimated",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate"
    });
    const records = [binding(usageRecord()), binding(local)];
    const first = buildProjectEconomicsProjectionV0(completeInput(records));
    const second = buildProjectEconomicsProjectionV0(completeInput([...records].reverse()));

    expect(first.receipt?.id).toBe(second.receipt?.id);
    expect(first.costs).toEqual(second.costs);
  });
});
