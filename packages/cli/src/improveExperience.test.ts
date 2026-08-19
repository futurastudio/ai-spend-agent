import { describe, expect, it } from "vitest";
import {
  createActionVerificationReference,
  createProjectEconomicsPlannedActionRefV0,
  createWasteFindingV0,
  type ActionVerificationProjectionV0,
  type SessionVitalV0,
  type SessionVitalsV0,
  type TokenReductionExperimentV0,
  type WasteFindingV0
} from "@agent-finops/core";
import {
  buildImproveExperience,
  type ImproveExperienceInput
} from "./improveExperience.js";

const NOW = "2026-08-16T16:00:00.000Z";
const REF = (value: string) => createActionVerificationReference("improve-test", value);

function finding(): WasteFindingV0 {
  return createWasteFindingV0({
    kind: "aibill.waste_finding",
    schemaVersion: "0.1.0",
    generatedAt: NOW,
    window: {
      start: "2026-08-10T00:00:00.000Z",
      end: "2026-08-16T15:00:00.000Z"
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
      provider: "openai",
      surface: "session_workflow",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: { kind: "session", ref: REF("target") },
    scope: {
      agent: "codex",
      provider: "openai",
      model: "gpt-5",
      projectRef: REF("project")
    },
    source: {
      id: "session-vitals-v0",
      validationCoverage: "live_verified",
      freshness: "fresh"
    },
    metric: {
      name: "total_tokens",
      unit: "ratio",
      value: 2.1,
      sampleCount: 3,
      evidence: "calculated"
    },
    evidenceRefs: [REF("one"), REF("two"), REF("three")],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });
}

function vital(id: string, completed = true): SessionVitalV0 {
  return {
    sessionRef: REF(`session:${id}`),
    agent: "codex",
    sessionType: "parent",
    project: "agent-finops",
    projectRef: REF("project"),
    models: ["gpt-5"],
    sourceVersions: ["1"],
    observedFrom: "2026-08-16T13:00:00.000Z",
    observedTo: "2026-08-16T14:00:00.000Z",
    completion: completed
      ? { status: "completed", evidence: "codex_task_complete", observedAt: NOW }
      : { status: "missing", evidence: "missing", reason: "completion_marker_not_observed" },
    tokenEvidence: {
      status: "observed",
      basis: "session_cumulative",
      inputTokens: 900,
      outputTokens: 100,
      componentTotalTokens: 1_000,
      componentEvidence: {
        inputTokens: "observed",
        outputTokens: "observed",
        cacheReadTokens: "not_separately_reported",
        cacheWriteTokens: "not_separately_reported",
        thoughtTokens: "not_separately_reported",
        toolTokens: "not_separately_reported",
        componentTotalTokens: "calculated_complete",
        reportedTotalTokens: "not_reported"
      }
    },
    activity: { kind: "task", action: "building", promptCount: 1, toolCallCount: 2 },
    provenance: {
      source: "parsed_local_agent_calls",
      confidence: "observed",
      uploaded: false
    }
  };
}

function vitals(): SessionVitalsV0 {
  const sessions = [vital("one"), vital("two"), vital("three"), vital("active", false)];
  return {
    schemaVersion: 0,
    sessions,
    coverage: {
      inputCalls: sessions.length,
      deduplicatedCalls: sessions.length,
      eligibleCalls: sessions.length,
      emittedSessions: sessions.length,
      sessionsWithObservedTokens: sessions.length,
      sessionsWithMissingTokens: 0,
      excludedCalls: {
        unsupportedAgent: 0,
        missingSessionIdentity: 0,
        invalidTimestamp: 0
      }
    },
    privacy: {
      rawSessionIds: false,
      promptOrResponseText: false,
      absolutePaths: false,
      uploaded: false
    }
  };
}

function projection(
  waste: WasteFindingV0,
  overrides: Partial<ActionVerificationProjectionV0> = {}
): ActionVerificationProjectionV0 {
  return {
    schemaVersion: 0,
    experimentId: `tre_v0_${"a".repeat(64)}`,
    findingId: waste.id,
    candidateKey: waste.candidateKey,
    state: "approve_one_change",
    tone: "attention",
    headline: "One reversible token test is ready",
    detail: "Define and approve one exact change, rollback, and canary before any handoff.",
    evidenceLabel: "missing",
    qualityLabel: "insufficient",
    qualityEvidence: "missing",
    baselineSessions: 3,
    postChangeSessions: 0,
    minimumSessions: 3,
    reductionPercent: null,
    ...overrides
  };
}

function experiment(input: {
  lifecycle: TokenReductionExperimentV0["lifecycle"];
  waste?: WasteFindingV0;
  applied?: boolean;
  status?: TokenReductionExperimentV0["evaluation"]["status"];
  reductionPercent?: number | null;
  qualityStatus?: TokenReductionExperimentV0["evaluation"]["qualityStatus"];
  rollbackRecommended?: boolean;
  postSessions?: number;
}): TokenReductionExperimentV0 {
  const waste = input.waste ?? finding();
  return {
    id: `tre_v0_${"a".repeat(64)}`,
    revisionId: `trev_v0_${"d".repeat(64)}`,
    finding: waste,
    lifecycle: input.lifecycle,
    matchingPolicy: { minimumPostSessions: 3 },
    intervention: input.applied ? {
      appliedAt: "2026-08-16T15:30:00.000Z",
      rollbackRef: createActionVerificationReference(
        "rollback-artifact",
        "git revert --no-edit abc123"
      )
    } : {},
    evaluation: {
      status: input.status ?? "not_evaluated",
      metricEvidence: input.reductionPercent === null || input.reductionPercent === undefined
        ? "missing"
        : "calculated",
      matchingEvidence: "observed",
      qualityStatus: input.qualityStatus ?? "insufficient",
      qualityEvidence: input.qualityStatus === "held" ? "user_declared" : "missing",
      baseline: { includedSessions: 3 },
      postChange: { includedSessions: input.postSessions ?? 0 },
      reductionPercent: input.reductionPercent ?? null,
      rollbackRecommended: input.rollbackRecommended ?? false
    }
  } as TokenReductionExperimentV0;
}

describe("one-command improve orchestration", () => {
  it("moves from setup to start without creating state during observation", () => {
    expect(buildImproveExperience({ interactive: true }).phase).toBe("setup");

    const model = buildImproveExperience({
      finding: finding(),
      sessionVitals: vitals(),
      interactive: true,
      intent: { kind: "observe" }
    });

    expect(model).toMatchObject({
      phase: "start",
      oneChange: { available: true, action: "trim_context" },
      advancedOperation: null,
      interaction: { blockedReason: null }
    });
  });

  it("returns the exact baseline operation only after an explicit quality-held start", () => {
    const waste = finding();
    const model = buildImproveExperience({
      finding: waste,
      sessionVitals: vitals(),
      interactive: true,
      intent: { kind: "start", createdAt: NOW, baselineQuality: "held" }
    });

    expect(model.phase).toBe("start");
    expect(model.advancedOperation).toMatchObject({
      kind: "freeze_baseline",
      finding: waste,
      createdAt: NOW
    });
    if (model.advancedOperation?.kind !== "freeze_baseline") throw new Error("wrong operation");
    expect(Object.keys(model.advancedOperation.qualityBySessionRef)).toHaveLength(3);
    expect(Object.values(model.advancedOperation.qualityBySessionRef)).toEqual([
      "passed", "passed", "passed"
    ]);
  });

  it.each([
    { interactive: false, readOnly: false },
    { interactive: true, readOnly: true }
  ])("never mutates in noninteractive/read-only mode: %o", ({ interactive, readOnly }) => {
    const model = buildImproveExperience({
      finding: finding(),
      sessionVitals: vitals(),
      interactive,
      readOnly,
      intent: { kind: "start", createdAt: NOW, baselineQuality: "held" }
    });

    expect(model.advancedOperation).toBeNull();
    expect(model.interaction).toEqual({
      mode: "read_only",
      requestedIntent: "start",
      blockedReason: "Read-only or non-interactive output cannot change token-test state."
    });
  });

  it("hashes supplied approval/change/rollback/canary evidence without retaining raw text", () => {
    const current = experiment({ lifecycle: "baseline_ready" });
    const evidence = {
      approvalEvidence: "Founder approved experiment in terminal prompt #42",
      changeEvidence: "AGENTS.md context section changed in commit abc123",
      rollbackEvidence: "git revert --no-edit abc123",
      canaryEvidence: "npm test passed at 2026-08-16T16:00:00Z"
    };
    const model = buildImproveExperience({
      preferredExperiment: current,
      sessionVitals: vitals(),
      interactive: true,
      intent: {
        kind: "apply",
        approved: true,
        approvedAt: "2026-08-16T15:00:00.000Z",
        appliedAt: NOW,
        canaryStatus: "passed",
        ...evidence
      }
    });

    expect(model.phase).toBe("awaiting_intervention");
    expect(model.advancedOperation).toMatchObject({
      kind: "mark_applied",
      expectedRevisionId: current.revisionId,
      approvalRef: createActionVerificationReference(
        "approval-evidence",
        evidence.approvalEvidence
      ),
      input: {
        changeRef: createActionVerificationReference("approved-change", evidence.changeEvidence),
        rollbackRef: createActionVerificationReference(
          "rollback-artifact",
          evidence.rollbackEvidence
        ),
        canaryRef: createActionVerificationReference("canary-result", evidence.canaryEvidence)
      }
    });
    const serialized = JSON.stringify(model.advancedOperation);
    expect(serialized).not.toContain(evidence.approvalEvidence);
    expect(serialized).not.toContain(evidence.changeEvidence);
    expect(serialized).not.toContain(evidence.rollbackEvidence);
    expect(serialized).not.toContain(evidence.canaryEvidence);
  });

  it("records a later application only against the exact earlier approval references", () => {
    const current = experiment({ lifecycle: "baseline_ready" });
    const changeRef = REF("planned-change");
    const rollbackRef = REF("planned-rollback");
    const canaryRef = REF("planned-canary");
    const approvalRef = createProjectEconomicsPlannedActionRefV0(current, {
      changeRef,
      rollbackRef,
      canaryRef
    });
    const model = buildImproveExperience({
      preferredExperiment: current,
      interactive: true,
      intent: {
        kind: "record_preapproved_application",
        approvedAt: "2026-08-16T15:00:00.000Z",
        appliedAt: NOW,
        approvalRef,
        changeRef,
        rollbackRef,
        canaryRef,
        canaryStatus: "passed"
      }
    });

    expect(model.advancedOperation).toMatchObject({
      kind: "mark_applied",
      approvalRef,
      input: {
        approvedAt: "2026-08-16T15:00:00.000Z",
        appliedAt: NOW,
        changeRef,
        rollbackRef,
        canaryRef,
        canaryStatus: "passed"
      }
    });
  });

  it("refuses opaque application references that do not bind the exact approved plan", () => {
    const current = experiment({ lifecycle: "baseline_ready" });
    const model = buildImproveExperience({
      preferredExperiment: current,
      interactive: true,
      intent: {
        kind: "record_preapproved_application",
        approvedAt: "2026-08-16T15:00:00.000Z",
        appliedAt: NOW,
        approvalRef: REF("different-plan"),
        changeRef: REF("planned-change"),
        rollbackRef: REF("planned-rollback"),
        canaryRef: REF("planned-canary"),
        canaryStatus: "passed"
      }
    });

    expect(model.advancedOperation).toBeNull();
    expect(model.interaction.blockedReason).toContain("do not match");
  });

  it("refuses an application timestamp that predates the approval", () => {
    const model = buildImproveExperience({
      preferredExperiment: experiment({ lifecycle: "baseline_ready" }),
      interactive: true,
      intent: {
        kind: "record_preapproved_application",
        approvedAt: NOW,
        appliedAt: "2026-08-16T15:00:00.000Z",
        approvalRef: REF("pre-change-approval"),
        changeRef: REF("planned-change"),
        rollbackRef: REF("planned-rollback"),
        canaryRef: REF("planned-canary"),
        canaryStatus: "passed"
      }
    });

    expect(model.advancedOperation).toBeNull();
    expect(model.interaction.blockedReason).toContain("follow its valid pre-change approval time");
  });

  it("refuses an application timestamp equal to the approval boundary", () => {
    const model = buildImproveExperience({
      preferredExperiment: experiment({ lifecycle: "baseline_ready" }),
      interactive: true,
      intent: {
        kind: "apply",
        approved: true,
        approvedAt: NOW,
        appliedAt: NOW,
        approvalEvidence: "approved here",
        changeEvidence: "changed here",
        rollbackEvidence: "rollback here",
        canaryEvidence: "canary here",
        canaryStatus: "passed"
      }
    });

    expect(model.advancedOperation).toBeNull();
    expect(model.interaction.blockedReason).toContain("after its pre-change approval");
  });

  it("refuses to fabricate a missing intervention reference", () => {
    const model = buildImproveExperience({
      preferredExperiment: experiment({ lifecycle: "baseline_ready" }),
      interactive: true,
      intent: {
        kind: "apply",
        approved: true,
        approvedAt: "2026-08-16T15:00:00.000Z",
        appliedAt: NOW,
        approvalEvidence: "approved here",
        changeEvidence: "changed here",
        rollbackEvidence: "   ",
        canaryEvidence: "test passed here",
        canaryStatus: "passed"
      }
    });

    expect(model.advancedOperation).toBeNull();
    expect(model.interaction.blockedReason).toContain("must all be supplied");
  });

  it("returns one refresh operation while collecting and labels quality only when declared", () => {
    const current = experiment({ lifecycle: "collecting", applied: true, postSessions: 1 });
    const held = buildImproveExperience({
      preferredExperiment: current,
      sessionVitals: vitals(),
      interactive: true,
      intent: { kind: "refresh", observedAt: NOW, quality: "held" }
    });
    const missing = buildImproveExperience({
      preferredExperiment: current,
      sessionVitals: vitals(),
      interactive: true,
      intent: { kind: "refresh", observedAt: NOW, quality: "missing" }
    });

    expect(held.phase).toBe("collecting");
    expect(held.advancedOperation).toMatchObject({
      kind: "refresh_experiment",
      expectedRevisionId: current.revisionId,
      input: { observedAt: NOW }
    });
    if (held.advancedOperation?.kind !== "refresh_experiment" ||
        missing.advancedOperation?.kind !== "refresh_experiment") {
      throw new Error("wrong operation");
    }
    expect(Object.values(held.advancedOperation.input.qualityBySessionRef ?? {}))
      .toEqual(["passed", "passed", "passed"]);
    expect(missing.advancedOperation.input.qualityBySessionRef).toBeUndefined();
  });

  it("shows the percentage only for a calculated result whose quality held", () => {
    const supported = buildImproveExperience({
      preferredExperiment: experiment({
        lifecycle: "complete",
        status: "measured_token_reduction",
        reductionPercent: 18,
        qualityStatus: "held",
        postSessions: 3
      }),
      interactive: false
    });
    const unsupportedProjection = projection(finding(), {
      state: "review_measured_result",
      evidenceLabel: "missing",
      qualityLabel: "insufficient",
      reductionPercent: 18
    });
    const unsupported = buildImproveExperience({
      projection: unsupportedProjection,
      interactive: false
    });

    expect(supported).toMatchObject({
      phase: "result",
      result: {
        status: "reduced",
        reductionPercent: 18,
        headline: "18% fewer tokens per comparable completed session",
        metricEvidence: "calculated",
        qualityLabel: "held",
        qualityEvidence: "user_declared"
      }
    });
    expect(unsupported.result).toEqual({
      status: "inconclusive",
      reductionPercent: null,
      headline: "No defensible token-reduction result yet",
      metricEvidence: "missing",
      qualityLabel: "insufficient",
      qualityEvidence: "missing"
    });
  });

  it("requires the same explicit rollback evidence and never re-hashes an absent value", () => {
    const current = experiment({
      lifecycle: "collecting",
      applied: true,
      rollbackRecommended: true
    });
    const model = buildImproveExperience({
      preferredExperiment: current,
      interactive: true,
      intent: {
        kind: "rollback",
        rolledBackAt: NOW,
        rollbackEvidence: "git revert --no-edit abc123"
      }
    });

    expect(model.phase).toBe("rollback");
    expect(model.advancedOperation).toMatchObject({
      kind: "mark_rolled_back",
      input: {
        rollbackRef: current.intervention.rollbackRef,
        rolledBackAt: NOW
      }
    });
  });

  it("cancels only an explicit un-applied test and projects terminal cancellation", () => {
    const current = experiment({ lifecycle: "baseline_ready" });
    const cancelled = buildImproveExperience({
      preferredExperiment: current,
      interactive: true,
      intent: { kind: "cancel", cancelledAt: NOW, confirmed: true }
    });
    const terminal = buildImproveExperience({
      projection: projection(finding(), {
        state: "cancelled",
        headline: "Token test cancelled"
      }),
      interactive: false
    });

    expect(cancelled.advancedOperation).toMatchObject({
      kind: "cancel_experiment",
      expectedRevisionId: current.revisionId,
      input: { invalidatedAt: NOW, reason: "manual" }
    });
    expect(terminal.phase).toBe("cancelled");
    expect(terminal.advancedOperation).toBeNull();
  });
});
