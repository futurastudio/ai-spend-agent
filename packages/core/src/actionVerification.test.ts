import { describe, expect, it } from "vitest";
import {
  TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
  TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
  WASTE_FINDING_V0_KIND,
  WASTE_FINDING_V0_VERSION,
  createActionVerificationReference,
  createTokenReductionExperimentV0,
  createWasteFindingV0,
  evaluateTokenReductionExperimentV0,
  parseTokenReductionExperimentV0,
  parseWasteFindingV0,
  type TokenExperimentSessionV0Input,
  type TokenReductionExperimentV0DraftInput,
  type WasteFindingV0,
  type WasteFindingV0DraftInput
} from "./actionVerification.js";

const findingEvidenceA = createActionVerificationReference("evidence", "config-item-a");
const findingEvidenceB = createActionVerificationReference("evidence", "session-history-b");
const projectRef = createActionVerificationReference("project", "/private/project/acme");
const workTypeRef = createActionVerificationReference("work-type", "fix-and-test");
const sourceVersionRef = createActionVerificationReference("source-version", "claude-code-2.1.170");
const changeRef = createActionVerificationReference("change", "permission-preserving-patch-digest");
const rollbackRef = createActionVerificationReference("rollback", "permission-preserving-backup-digest");

function componentEvidence(reported = true) {
  return {
    uncachedInputTokens: "observed" as const,
    cacheReadTokens: "observed" as const,
    cacheWriteTokens: "observed" as const,
    toolTokens: "observed" as const,
    outputTokens: "observed" as const,
    thoughtTokens: "observed" as const,
    calculatedTotalTokens: "calculated_complete" as const,
    reportedTotalTokens: reported ? "provider_reported" as const : "not_reported" as const
  };
}

function unavailableComponentEvidence(reported = true) {
  return {
    uncachedInputTokens: "not_separately_reported" as const,
    cacheReadTokens: "not_separately_reported" as const,
    cacheWriteTokens: "not_separately_reported" as const,
    toolTokens: "not_separately_reported" as const,
    outputTokens: "not_separately_reported" as const,
    thoughtTokens: "not_separately_reported" as const,
    calculatedTotalTokens: "missing" as const,
    reportedTotalTokens: reported ? "provider_reported" as const : "not_reported" as const
  };
}

function findingInput(
  overrides: Partial<WasteFindingV0DraftInput> = {}
): WasteFindingV0DraftInput {
  return {
    kind: WASTE_FINDING_V0_KIND,
    schemaVersion: WASTE_FINDING_V0_VERSION,
    generatedAt: "2026-08-03T00:00:00.000Z",
    window: {
      start: "2026-07-03T00:00:00.000Z",
      end: "2026-08-02T00:00:00.000Z"
    },
    findingType: "high_context_relative_to_baseline",
    objective: {
      metric: "total_tokens_per_matched_session",
      direction: "reduce",
      guard: "user_declared_quality_must_hold"
    },
    caveats: [
      "signal_not_cause",
      "no_cash_claim",
      "missing_outcome_evidence"
    ],
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
      ref: createActionVerificationReference("session", "candidate-target")
    },
    scope: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef
    },
    source: {
      id: "claude-code-local",
      validationCoverage: "live_verified",
      freshness: "fresh"
    },
    metric: {
      name: "input_context_tokens",
      unit: "tokens",
      value: 120_000,
      sampleCount: 5,
      evidence: "calculated"
    },
    evidenceRefs: [findingEvidenceA, findingEvidenceB],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true,
    ...overrides
  };
}

function makeFinding(): WasteFindingV0 {
  return createWasteFindingV0(findingInput());
}

function passedQuality(
  evidence: "verified" | "observed" | "user_declared" = "user_declared",
  label = "quality"
): TokenExperimentSessionV0Input["quality"] {
  return {
    status: "passed",
    evidence,
    ...((evidence === "verified" || evidence === "observed")
      ? { evidenceRef: createActionVerificationReference("quality", label) }
      : {})
  };
}

function tokenSession(
  label: string,
  totalTokens: number,
  startedAt: string,
  overrides: Partial<TokenExperimentSessionV0Input> = {}
): TokenExperimentSessionV0Input {
  const endedAt = new Date(Date.parse(startedAt) + 30 * 60 * 1_000).toISOString();
  return {
    sessionRef: createActionVerificationReference("session", label),
    startedAt,
    endedAt,
    agent: "claude-code",
    provider: "anthropic",
    model: "claude-sonnet-5",
    projectRef,
    sessionType: "parent",
    workTypeRef,
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
      componentEvidence: componentEvidence()
    },
    quality: passedQuality(),
    ...overrides
  };
}

function baselineSessions(
  quality: TokenExperimentSessionV0Input["quality"] = passedQuality()
): TokenExperimentSessionV0Input[] {
  return [
    tokenSession("baseline-1", 100, "2026-08-04T10:00:00.000Z", { quality }),
    tokenSession("baseline-2", 120, "2026-08-05T10:00:00.000Z", { quality }),
    tokenSession("baseline-3", 140, "2026-08-06T10:00:00.000Z", { quality })
  ];
}

function postSessions(
  quality: TokenExperimentSessionV0Input["quality"] = passedQuality()
): TokenExperimentSessionV0Input[] {
  return [
    tokenSession("post-1", 75, "2026-08-11T10:00:00.000Z", { quality }),
    tokenSession("post-2", 90, "2026-08-12T10:00:00.000Z", { quality }),
    tokenSession("post-3", 105, "2026-08-13T10:00:00.000Z", { quality })
  ];
}

function pendingIntervention(): TokenReductionExperimentV0DraftInput["intervention"] {
  return {
    approval: {
      status: "pending",
      evidence: "missing"
    }
  };
}

function appliedIntervention(): TokenReductionExperimentV0DraftInput["intervention"] {
  return {
    approval: {
      status: "explicit",
      evidence: "user_declared",
      approvedAt: "2026-08-10T09:55:00.000Z"
    },
    appliedAt: "2026-08-10T10:00:00.000Z",
    changeRef,
    rollbackRef,
    canary: passedQuality("observed", "canary-pass")
  };
}

function experimentInput(
  overrides: Partial<TokenReductionExperimentV0DraftInput> = {}
): TokenReductionExperimentV0DraftInput {
  return {
    kind: TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
    schemaVersion: TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
    createdAt: "2026-08-07T12:00:00.000Z",
    finding: makeFinding(),
    cohort: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef,
      sessionType: "parent",
      workTypeRef,
      workTypeEvidence: "user_declared",
      sourceVersionRef
    },
    matchingPolicy: {
      basis: "session_cohort",
      minimumBaselineSessions: 3,
      minimumPostSessions: 3,
      requireExactSourceVersion: true
    },
    qualityGuard: {
      required: true,
      minimumEvidence: "user_declared",
      rollbackOnRegression: true
    },
    baselineSessions: baselineSessions(),
    intervention: pendingIntervention(),
    postSessions: [],
    ...overrides
  };
}

describe("action verification privacy-safe references", () => {
  it("hashes native identifiers with a namespace and never returns the source value", () => {
    const native = "/workspace/private-client/project";
    const project = createActionVerificationReference("project", native);
    const session = createActionVerificationReference("session", native);

    expect(project).toMatch(/^avref_[a-f0-9]{64}$/);
    expect(project).not.toContain(native);
    expect(session).not.toBe(project);
    expect(createActionVerificationReference("project", native)).toBe(project);
    expect(() => createActionVerificationReference("../project", native)).toThrow();
    expect(() => createActionVerificationReference("env:SECRET", native)).toThrow();
    expect(() => createActionVerificationReference("project", "\ud800")).toThrow();
  });
});

describe("WasteFindingV0", () => {
  it("is stable across evidence-reference order and remains explicitly non-causal", () => {
    const first = createWasteFindingV0(findingInput());
    const second = createWasteFindingV0(findingInput({
      evidenceRefs: [findingEvidenceB, findingEvidenceA]
    }));

    expect(first).toEqual(second);
    expect(first.id).toMatch(/^wf_v0_[a-f0-9]{64}$/);
    expect(first.candidateKey).toMatch(/^wfc_v0_[a-f0-9]{64}$/);
    expect(first.causalStatus).toBe("unproven");
    expect(first.actionability).toBe("inspect_only");
    expect(first.approvalRequired).toBe(true);
    expect(JSON.stringify(first)).not.toContain("/private/project/acme");
    expect(parseWasteFindingV0(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it("rejects stale IDs and dishonest missing-value labels", () => {
    const finding = makeFinding();
    expect(() => parseWasteFindingV0({
      ...finding,
      metric: { ...finding.metric, value: 1 }
    })).toThrow(/ID or candidate key/);
    expect(() => createWasteFindingV0(findingInput({
      metric: {
        name: "total_tokens",
        unit: "tokens",
        value: null,
        sampleCount: 0,
        evidence: "observed"
      }
    }))).toThrow();
  });

  it("keeps candidateKey stable across reruns while evidence-version IDs change", () => {
    const first = makeFinding();
    const rerun = createWasteFindingV0(findingInput({
      generatedAt: "2026-08-04T00:00:00.000Z",
      window: {
        start: "2026-07-04T00:00:00.000Z",
        end: "2026-08-03T00:00:00.000Z"
      },
      metric: {
        name: "input_context_tokens",
        unit: "tokens",
        value: 110_000,
        sampleCount: 7,
        evidence: "calculated"
      }
    }));

    expect(rerun.candidateKey).toBe(first.candidateKey);
    expect(rerun.id).not.toBe(first.id);
  });

  it("requires the provider-aware reversible action and every launch caveat", () => {
    expect(() => createWasteFindingV0(findingInput({
      candidateAction: {
        kind: "trim_context",
        provider: "openai",
        surface: "local_agent_configuration",
        reversible: true,
        canaryRequired: true,
        rollbackRequired: true
      }
    }))).toThrow(/provider/);
    expect(() => createWasteFindingV0(findingInput({
      caveats: ["signal_not_cause", "no_cash_claim", "no_cash_claim"]
    }))).toThrow(/missing_outcome_evidence/);
  });
});

describe("TokenReductionExperimentV0 lifecycle and evaluation", () => {
  it("freezes a sufficient baseline without claiming a result", () => {
    const experiment = createTokenReductionExperimentV0(experimentInput());

    expect(experiment.id).toMatch(/^tre_v0_[a-f0-9]{64}$/);
    expect(experiment.revisionId).toMatch(/^trev_v0_[a-f0-9]{64}$/);
    expect(experiment.lifecycle).toBe("baseline_ready");
    expect(experiment.evaluation.status).toBe("not_evaluated");
    expect(experiment.evaluation.baseline).toMatchObject({
      includedSessions: 3,
      medianTotalTokens: 120
    });
    expect(experiment.evaluation.postChange.includedSessions).toBe(0);
    expect(experiment.evaluation.reductionPercent).toBeNull();
    expect(experiment.evaluation.metricEvidence).toBe("missing");
  });

  it("keeps missing source versions explicitly unmatched", () => {
    const withoutVersion = (session: TokenExperimentSessionV0Input) => {
      const { sourceVersionRef: _sourceVersionRef, ...rest } = session;
      return rest;
    };
    const cohort = {
      agent: "claude-code" as const,
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef,
      sessionType: "parent" as const,
      workTypeRef,
      workTypeEvidence: "user_declared" as const
    };
    const matchingPolicy = {
      basis: "session_cohort" as const,
      minimumBaselineSessions: 3,
      minimumPostSessions: 3,
      requireExactSourceVersion: false
    };
    const result = createTokenReductionExperimentV0(experimentInput({
      cohort,
      matchingPolicy,
      baselineSessions: baselineSessions().map(withoutVersion),
      intervention: appliedIntervention(),
      postSessions: [
        ...postSessions().slice(0, 2).map(withoutVersion),
        postSessions()[2]!
      ]
    }));

    expect(result.cohort.sourceVersionRef).toBeUndefined();
    expect(result.matchingPolicy.requireExactSourceVersion).toBe(false);
    expect(result.evaluation.baseline.includedSessions).toBe(0);
    expect(result.evaluation.postChange.includedSessions).toBe(0);
    expect(result.evaluation.reductionPercent).toBeNull();
    expect(result.evaluation.exclusions).toHaveLength(6);
    expect(result.evaluation.exclusions.every((exclusion) =>
      exclusion.reasons.includes("source_version_mismatch")
    )).toBe(true);
    expect(() => createTokenReductionExperimentV0(experimentInput({
      cohort,
      matchingPolicy: { ...matchingPolicy, requireExactSourceVersion: true },
      baselineSessions: baselineSessions().map(withoutVersion)
    }))).toThrow(/Exact source-version matching/);
  });

  it("calculates a measured cohort reduction with medians and truth labels", () => {
    const experiment = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: postSessions()
    }));

    expect(experiment.lifecycle).toBe("complete");
    expect(experiment.evaluation).toMatchObject({
      status: "measured_token_reduction",
      metricEvidence: "calculated",
      matchingEvidence: "user_declared",
      qualityStatus: "held",
      qualityEvidence: "user_declared",
      reductionPercent: 25,
      rollbackRecommended: false,
      baseline: {
        includedSessions: 3,
        medianTotalTokens: 120
      },
      postChange: {
        includedSessions: 3,
        medianTotalTokens: 90
      }
    });
    expect(experiment.evaluation.baseline.componentMedians.uncachedInputTokens).toBe(120);
    expect(experiment.evaluation.exclusions).toEqual([]);
  });

  it("keeps one stable experiment ID as intervention and post evidence arrive", () => {
    const prepared = createTokenReductionExperimentV0(experimentInput());
    const completed = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: postSessions()
    }));

    expect(completed.id).toBe(prepared.id);
    expect(completed.lifecycle).not.toBe(prepared.lifecycle);
  });

  it("keeps even accepted-work-unit evidence measured until Outcome verification ships", () => {
    const verifiedBaseline = baselineSessions(passedQuality("verified", "baseline-quality"))
      .map((session, index) => ({
        ...session,
        workUnitRef: createActionVerificationReference("work-unit", `baseline-work-${index}`),
        workUnitEvidence: "verified" as const
      }));
    const verifiedPost = postSessions(passedQuality("verified", "post-quality"))
      .map((session, index) => ({
        ...session,
        workUnitRef: createActionVerificationReference("work-unit", `post-work-${index}`),
        workUnitEvidence: "verified" as const
      }));
    const input = experimentInput({
      cohort: {
        agent: "claude-code",
        provider: "anthropic",
        model: "claude-sonnet-5",
        projectRef,
        sessionType: "parent",
        workTypeRef,
        workTypeEvidence: "verified",
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
        minimumEvidence: "verified",
        rollbackOnRegression: true
      },
      baselineSessions: verifiedBaseline,
      intervention: appliedIntervention(),
      postSessions: verifiedPost
    });

    const result = createTokenReductionExperimentV0(input);
    expect(result.evaluation.status).toBe("measured_token_reduction");
    expect(result.evaluation.matchingEvidence).toBe("verified");
    expect(result.evaluation.qualityEvidence).toBe("verified");
  });

  it("does not promote fixture-only token evidence to a verified reduction", () => {
    const quality = passedQuality("verified", "fixture-quality");
    const withWorkUnit = (session: TokenExperimentSessionV0Input, index: number) => ({
      ...session,
      sourceValidationCoverage: "fixture_verified" as const,
      workUnitRef: createActionVerificationReference("work-unit", `fixture-work-${index}`),
      workUnitEvidence: "verified" as const,
      quality
    });
    const result = createTokenReductionExperimentV0(experimentInput({
      cohort: {
        agent: "claude-code",
        provider: "anthropic",
        model: "claude-sonnet-5",
        projectRef,
        sessionType: "parent",
        workTypeRef,
        workTypeEvidence: "verified",
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
        minimumEvidence: "verified",
        rollbackOnRegression: true
      },
      baselineSessions: baselineSessions(quality).map(withWorkUnit),
      intervention: appliedIntervention(),
      postSessions: postSessions(quality).map((session, index) => withWorkUnit(session, index + 3))
    }));

    expect(result.evaluation.status).toBe("measured_token_reduction");
    expect(result.evaluation.status).toBe("measured_token_reduction");
  });

  it("withholds the public reduction arithmetic without its quality guard", () => {
    const missingQuality = { status: "missing", evidence: "missing" } as const;
    const result = createTokenReductionExperimentV0(experimentInput({
      baselineSessions: baselineSessions(missingQuality),
      intervention: appliedIntervention(),
      postSessions: postSessions(missingQuality)
    }));

    expect(result.lifecycle).toBe("collecting");
    expect(result.evaluation.reductionPercent).toBeNull();
    expect(result.evaluation.metricEvidence).toBe("missing");
    expect(result.evaluation.qualityStatus).toBe("insufficient");
    expect(result.evaluation.status).toBe("inconclusive");
  });

  it("makes a quality failure or token increase a rollback-triggering regression", () => {
    const failedPost = postSessions();
    failedPost[0] = {
      ...failedPost[0]!,
      quality: { status: "failed", evidence: "user_declared" }
    };
    const qualityRegression = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: failedPost
    }));
    expect(qualityRegression.evaluation.status).toBe("regressed");
    expect(qualityRegression.evaluation.reductionPercent).toBeNull();
    expect(qualityRegression.evaluation.metricEvidence).toBe("missing");
    expect(qualityRegression.evaluation.rollbackRecommended).toBe(true);

    const tokenRegression = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: [
        tokenSession("larger-1", 150, "2026-08-11T10:00:00.000Z"),
        tokenSession("larger-2", 180, "2026-08-12T10:00:00.000Z"),
        tokenSession("larger-3", 210, "2026-08-13T10:00:00.000Z")
      ]
    }));
    expect(tokenRegression.evaluation.reductionPercent).toBe(-50);
    expect(tokenRegression.evaluation.status).toBe("regressed");
    expect(tokenRegression.evaluation.rollbackRecommended).toBe(true);
  });

  it("never accepts or exposes post-change evidence after a failed canary", () => {
    const failedCanary = {
      ...appliedIntervention(),
      canary: {
        status: "failed" as const,
        evidence: "user_declared" as const,
        evidenceRef: createActionVerificationReference("canary", "failed-before-post")
      }
    };
    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: failedCanary,
      postSessions: postSessions()
    }))).toThrow(/failed canary cannot collect or expose post-change token evidence/i);

    const stopped = createTokenReductionExperimentV0(experimentInput({
      intervention: failedCanary,
      postSessions: []
    }));
    expect(stopped.lifecycle).toBe("applied");
    expect(stopped.evaluation).toMatchObject({
      status: "inconclusive",
      metricEvidence: "missing",
      reductionPercent: null,
      rollbackRecommended: true,
      postChange: {
        includedSessions: 0,
        medianTotalTokens: null
      }
    });
  });

  it("derives collecting, invalidated, and rolled-back lifecycle labels", () => {
    const collecting = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: [postSessions()[0]!]
    }));
    expect(collecting.lifecycle).toBe("collecting");
    expect(collecting.evaluation.status).toBe("collecting");

    const invalidated = createTokenReductionExperimentV0(experimentInput({
      intervention: pendingIntervention(),
      postSessions: [],
      invalidation: {
        reason: "concurrent_change",
        invalidatedAt: "2026-08-12T15:00:00.000Z"
      }
    }));
    expect(invalidated.lifecycle).toBe("invalidated");
    expect(invalidated.evaluation.status).toBe("inconclusive");
    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: postSessions(),
      invalidation: {
        reason: "concurrent_change",
        invalidatedAt: "2026-08-12T15:00:00.000Z"
      }
    }))).toThrow(/applied intervention cannot be invalidated.*rolled back/i);

    const rolledBack = createTokenReductionExperimentV0(experimentInput({
      intervention: {
        ...appliedIntervention(),
        rolledBackAt: "2026-08-14T10:00:00.000Z"
      },
      postSessions: postSessions()
    }));
    expect(rolledBack.lifecycle).toBe("rolled_back");
    expect(rolledBack.evaluation.status).toBe("inconclusive");
  });

  it("fails closed on reused, duplicate, mismatched, boundary, and token-shape evidence", () => {
    const reused = {
      ...tokenSession("baseline-1", 80, "2026-08-11T10:00:00.000Z")
    };
    const duplicate = tokenSession("duplicate", 80, "2026-08-11T11:00:00.000Z");
    const crossing = tokenSession("crossing", 80, "2026-08-10T09:50:00.000Z", {
      endedAt: "2026-08-10T10:10:00.000Z"
    });
    const missing = tokenSession("missing", 80, "2026-08-11T12:00:00.000Z", {
      tokens: {
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        toolTokens: null,
        outputTokens: null,
        thoughtTokens: null,
        calculatedTotalTokens: null,
        reportedTotalTokens: null,
        componentEvidence: unavailableComponentEvidence(false)
      }
    });
    const inconsistent = tokenSession("inconsistent", 80, "2026-08-11T13:00:00.000Z", {
      tokens: {
        uncachedInputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        calculatedTotalTokens: 80,
        reportedTotalTokens: 81,
        componentEvidence: componentEvidence()
      }
    });
    const wrongModel = tokenSession("wrong-model", 80, "2026-08-11T14:00:00.000Z", {
      model: "claude-haiku-5"
    });
    const wrongVersion = tokenSession("wrong-version", 80, "2026-08-11T15:00:00.000Z", {
      sourceVersionRef: createActionVerificationReference("source-version", "changed")
    });
    const evaluation = evaluateTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: [
        reused,
        duplicate,
        { ...duplicate },
        crossing,
        missing,
        inconsistent,
        wrongModel,
        wrongVersion
      ]
    })).evaluation;

    const reasons = evaluation.exclusions.flatMap((exclusion) => exclusion.reasons);
    expect(reasons).toEqual(expect.arrayContaining([
      "reused_across_phases",
      "duplicate_session",
      "crosses_intervention_boundary",
      "missing_total_tokens",
      "inconsistent_total_tokens",
      "model_mismatch",
      "source_version_mismatch"
    ]));
    expect(evaluation.postChange.includedSessions).toBe(0);
    expect(evaluation.status).toBe("collecting");
  });

  it("uses a provider-reported total when components are honestly missing", () => {
    const totalOnlyPost = postSessions().map((session) => ({
      ...session,
      tokens: {
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        toolTokens: null,
        outputTokens: null,
        thoughtTokens: null,
        calculatedTotalTokens: null,
        reportedTotalTokens: session.tokens.reportedTotalTokens,
        componentEvidence: unavailableComponentEvidence(true)
      }
    }));
    const result = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: totalOnlyPost
    }));

    expect(result.evaluation.status).toBe("measured_token_reduction");
    expect(result.evaluation.postChange.medianTotalTokens).toBe(90);
    expect(result.evaluation.postChange.componentMedians.uncachedInputTokens).toBeNull();
  });

  it("rejects a contradictory provider total even when the calculated total is labeled partial", () => {
    const contradictory = postSessions().map((session, index) => ({
      ...session,
      sessionRef: createActionVerificationReference("session", `partial-contradiction-${index}`),
      tokens: {
        ...session.tokens,
        reportedTotalTokens: 1,
        componentEvidence: {
          ...session.tokens.componentEvidence,
          calculatedTotalTokens: "calculated_partial" as const
        }
      }
    }));
    const result = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: contradictory
    }));

    expect(result.evaluation.postChange.includedSessions).toBe(0);
    expect(result.evaluation.status).toBe("collecting");
    expect(result.evaluation.reductionPercent).toBeNull();
    expect(result.evaluation.exclusions).toHaveLength(3);
    expect(result.evaluation.exclusions.every((exclusion) =>
      exclusion.reasons.includes("inconsistent_total_tokens")
    )).toBe(true);
  });

  it("rejects future baseline evidence and rollback boundaries before post evidence ends", () => {
    expect(() => createTokenReductionExperimentV0(experimentInput({
      baselineSessions: [
        ...baselineSessions().slice(0, 2),
        tokenSession("future-baseline", 140, "2026-08-08T10:00:00.000Z")
      ]
    }))).toThrow(/baseline evidence cannot end after experiment creation/i);

    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: {
        ...appliedIntervention(),
        rolledBackAt: "2026-08-12T10:15:00.000Z"
      },
      postSessions: postSessions()
    }))).toThrow(/post-change evidence cannot end after the rollback boundary/i);

    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: {
        ...appliedIntervention(),
        rolledBackAt: appliedIntervention().appliedAt
      }
    }))).toThrow(/rollback must follow application/i);
  });

  it("rejects mutation without approval/canary and detects tampered derived results", () => {
    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: {
        approval: { status: "pending", evidence: "missing" },
        appliedAt: "2026-08-10T10:00:00.000Z",
        changeRef,
        rollbackRef,
        canary: passedQuality("observed", "mutation-canary")
      }
    }))).toThrow();

    const experiment = createTokenReductionExperimentV0(experimentInput({
      intervention: appliedIntervention(),
      postSessions: postSessions()
    }));
    expect(parseTokenReductionExperimentV0(JSON.parse(JSON.stringify(experiment)))).toEqual(experiment);
    expect(() => parseTokenReductionExperimentV0({
      ...experiment,
      evaluation: {
        ...experiment.evaluation,
        reductionPercent: 99
      }
    })).toThrow(/derived evaluation/);
    expect(() => parseTokenReductionExperimentV0({
      ...experiment,
      intervention: {
        approval: {
          status: "explicit",
          evidence: "user_declared",
          approvedAt: "2026-08-10T09:55:00.000Z"
        },
        appliedAt: "2026-08-10T10:00:00.000Z",
        changeRef,
        rollbackRef,
        canary: passedQuality("observed", "tampered-canary")
      }
    })).toThrow(/revision/);
  });

  it("requires approval to strictly precede the application boundary", () => {
    expect(() => createTokenReductionExperimentV0(experimentInput({
      intervention: {
        approval: {
          status: "explicit",
          evidence: "user_declared",
          approvedAt: "2026-08-10T10:00:00.000Z"
        },
        appliedAt: "2026-08-10T10:00:00.000Z",
        changeRef,
        rollbackRef,
        canary: passedQuality("observed", "same-boundary-canary")
      }
    }))).toThrow(/after approval/);
  });
});
