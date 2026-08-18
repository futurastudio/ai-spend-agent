import { describe, expect, it } from "vitest";
import {
  createActionVerificationReference,
  createWasteFindingV0,
  type ActionVerificationProjectionV0,
  type SessionVitalV0,
  type SessionVitalsV0,
  type TokenReductionExperimentV0,
  type WasteFindingV0
} from "@agent-finops/core";
import {
  buildGuidedExperience,
  renderGuidedExperience,
  type GuidedExperienceInput
} from "./guidedExperience.js";

const NOW = "2026-08-16T16:00:00.000Z";
const REF = (value: string) => createActionVerificationReference("guided-test", value);

function vital(input: {
  id: string;
  project?: string;
  tokens: number;
  completed?: boolean;
}): SessionVitalV0 {
  return {
    sessionRef: REF(`session:${input.id}`),
    agent: "codex",
    sessionType: "parent",
    ...(input.project ? { project: input.project, projectRef: REF(`project:${input.project}`) } : {}),
    models: ["gpt-5"],
    sourceVersions: ["1.0.0"],
    observedFrom: "2026-08-16T14:00:00.000Z",
    observedTo: "2026-08-16T15:00:00.000Z",
    completion: input.completed === false
      ? { status: "missing", evidence: "missing", reason: "completion_marker_not_observed" }
      : { status: "completed", evidence: "codex_task_complete", observedAt: NOW },
    tokenEvidence: {
      status: "observed",
      basis: "session_cumulative",
      inputTokens: input.tokens,
      outputTokens: 0,
      componentTotalTokens: input.tokens,
      componentEvidence: {
        inputTokens: "observed",
        outputTokens: "observed",
        cacheReadTokens: "observed",
        cacheWriteTokens: "observed",
        thoughtTokens: "observed",
        toolTokens: "observed",
        componentTotalTokens: "calculated_complete",
        reportedTotalTokens: "not_reported"
      }
    },
    activity: { kind: "task", action: "building", promptCount: 1, toolCallCount: 2 },
    provenance: { source: "parsed_local_agent_calls", confidence: "observed", uploaded: false }
  };
}

function vitals(...sessions: SessionVitalV0[]): SessionVitalsV0 {
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
      excludedCalls: { unsupportedAgent: 0, missingSessionIdentity: 0, invalidTimestamp: 0 }
    },
    privacy: { rawSessionIds: false, promptOrResponseText: false, absolutePaths: false, uploaded: false }
  };
}

function finding(
  findingType: WasteFindingV0["findingType"] = "high_context_relative_to_baseline",
  action: WasteFindingV0["candidateAction"]["kind"] = "trim_context",
  value = 2.4
): WasteFindingV0 {
  return createWasteFindingV0({
    kind: "aibill.waste_finding",
    schemaVersion: "0.1.0",
    generatedAt: NOW,
    window: { start: "2026-08-10T00:00:00.000Z", end: "2026-08-16T15:00:00.000Z" },
    findingType,
    objective: {
      metric: "total_tokens_per_matched_session",
      direction: "reduce",
      guard: "user_declared_quality_must_hold"
    },
    caveats: ["signal_not_cause", "no_cash_claim", "missing_outcome_evidence"],
    candidateAction: {
      kind: action,
      provider: "openai",
      surface: findingType === "configured_not_observed"
        ? "local_agent_configuration"
        : "session_workflow",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: { kind: "session", ref: REF("target") },
    scope: {
      agent: "codex",
      provider: "openai",
      model: "gpt-5",
      projectRef: REF("project:agent-finops")
    },
    source: { id: "session-vitals-v0", validationCoverage: "live_verified", freshness: "fresh" },
    metric: {
      name: findingType === "configured_not_observed" ? "configured_items" : "total_tokens",
      unit: findingType === "configured_not_observed" ? "items" : "ratio",
      value,
      sampleCount: 3,
      evidence: findingType === "configured_not_observed" ? "observed" : "calculated"
    },
    evidenceRefs: [REF("session:a"), REF("session:b"), REF("session:c")],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });
}

function projection(
  overrides: Partial<ActionVerificationProjectionV0> = {}
): ActionVerificationProjectionV0 {
  return {
    schemaVersion: 0,
    experimentId: `tre_v0_${"a".repeat(64)}`,
    findingId: `wf_v0_${"b".repeat(64)}`,
    candidateKey: `wfc_v0_${"c".repeat(64)}`,
    state: "collect_post_change",
    tone: "neutral",
    headline: "Collect three matched post-change sessions",
    detail: "Canonical projection detail",
    evidenceLabel: "missing",
    qualityLabel: "insufficient",
    qualityEvidence: "missing",
    baselineSessions: 3,
    postChangeSessions: 2,
    minimumSessions: 3,
    reductionPercent: null,
    ...overrides
  };
}

describe("guided launch experience", () => {
  it("turns completed session evidence into one compact why/action card", () => {
    const model = buildGuidedExperience({
      sessionVitals: vitals(
        vital({ id: "a", project: "agent-finops", tokens: 4_000_000 }),
        vital({ id: "b", project: "agent-finops", tokens: 2_400_000 }),
        vital({ id: "c", project: "other", tokens: 2_000_000 }),
        vital({ id: "active", project: "other", tokens: 50_000_000, completed: false })
      ),
      wasteFinding: finding(),
      qualitativeCoverage: "complete",
      interactive: true
    });
    const text = renderGuidedExperience(model);

    expect(model.usage).toMatchObject({
      headline: "8.4M tokens · 3 completed sessions",
      source: "completed_sessions"
    });
    expect(model.mainDriver).toMatchObject({
      headline: "agent-finops",
      detail: "76% of completed-session tokens with complete totals"
    });
    expect(model.insight.heading).toBe("WHY IS IT HIGH?");
    expect(model.insight.headline).toContain("2.4× the comparable-session baseline");
    expect(model.safeTest.headline).toBe(
      "Start the next comparable task with only the files and instructions it needs."
    );
    expect(text.match(/HOW DO I REDUCE IT\?/gu)).toHaveLength(1);
    expect(text).toContain("[Enter] Set up this test");
    expect(text).not.toMatch(/universal savings|cash savings/iu);
  });

  it("explains home-directory sessions instead of exposing the ambiguous home label", () => {
    const model = buildGuidedExperience({
      sessionVitals: vitals(
        vital({ id: "a", project: "(home)", tokens: 8_100 }),
        vital({ id: "b", project: "agent-finops", tokens: 1_900 })
      ),
      qualitativeCoverage: "complete",
      interactive: false
    });

    expect(model.mainDriver.headline).toBe("Sessions started outside a project folder");
    expect(model.mainDriver.detail).toBe("81% of completed-session tokens with complete totals");
  });

  it("narrows driver and why language when qualitative indexing is incomplete", () => {
    const model = buildGuidedExperience({
      sessionVitals: vitals(
        vital({ id: "a", project: "agent-finops", tokens: 8_100 }),
        vital({ id: "b", project: "other", tokens: 1_900 })
      ),
      wasteFinding: finding(),
      qualitativeCoverage: "partial",
      interactive: false
    });
    const text = renderGuidedExperience(model);

    expect(model.mainDriver).toMatchObject({
      heading: "TOP OBSERVED PROJECT",
      detail: "81% of indexed completed-session tokens with complete totals"
    });
    expect(model.insight.heading).toBe("WHAT STANDS OUT IN INDEXED EVIDENCE");
    expect(model.insight.headline).toContain("No supported waste signal");
    expect(model.safeTest.available).toBe(false);
    expect(text).not.toContain("MAIN DRIVER");
    expect(text).not.toContain("WHY IS IT HIGH?");
  });

  it("does not let complete qualitative indexing relabel incomplete financial rows as a global driver", () => {
    const model = buildGuidedExperience({
      summary: {
        totalUsd: 100,
        byProject: [{ key: "agent-finops", amountUsd: 100, confidence: "estimated" }]
      } as NonNullable<GuidedExperienceInput["summary"]>,
      qualitativeCoverage: "complete",
      financialDriverComplete: false,
      interactive: false
    });

    expect(model.mainDriver).toEqual({
      heading: "TOP OBSERVED PROJECT",
      headline: "agent-finops",
      detail: "100% of indexed tracked cost/value",
      source: "tracked_cost_value"
    });
    expect(renderGuidedExperience(model)).not.toContain("MAIN DRIVER");
  });

  it.each(["partial", "unknown"] as const)(
    "does not turn a Context Health start-fresh fallback into an action when coverage is %s",
    (qualitativeCoverage) => {
      const model = buildGuidedExperience({
        sessionVitals: vitals(
          vital({ id: "partial-a", project: "agent-finops", tokens: 8_100 }),
          vital({ id: "partial-b", project: "other", tokens: 1_900 })
        ),
        contextHealth: {
          recommendation: "start_fresh",
          currentSession: { agent: "codex" }
        } as NonNullable<GuidedExperienceInput["contextHealth"]>,
        qualitativeCoverage,
        interactive: true
      });
      const text = renderGuidedExperience(model);

      expect(model.safeTest).toEqual({
        available: false,
        headline: "No safe test is ready yet.",
        detail: "Finish enough comparable sessions for aibill to choose one supported change."
      });
      expect(model.interaction.startPrompt).toBeNull();
      expect(text).not.toContain("Start the next independent task");
      expect(text).not.toContain("[Enter]");
    }
  );

  it("never promotes partial token components into an exact usage total or driver", () => {
    const partial = vital({ id: "partial", project: "agent-finops", tokens: 99_999 });
    if (partial.tokenEvidence.status !== "observed") throw new Error("fixture");
    partial.tokenEvidence.componentEvidence = {
      ...partial.tokenEvidence.componentEvidence,
      cacheReadTokens: "not_separately_reported",
      componentTotalTokens: "calculated_partial"
    };
    const model = buildGuidedExperience({
      sessionVitals: vitals(partial),
      qualitativeCoverage: "complete",
      interactive: false
    });

    expect(model.usage.source).not.toBe("completed_sessions");
    expect(model.mainDriver.source).toBe("not_available");
    expect(renderGuidedExperience(model)).not.toContain("99,999 tokens");
  });

  it("keeps configured-but-unused evidence under WHAT STANDS OUT", () => {
    const model = buildGuidedExperience({
      wasteFinding: finding("configured_not_observed", "inspect_scope", 2),
      qualitativeCoverage: "complete",
      interactive: true
    });

    expect(model.insight).toMatchObject({
      heading: "WHAT STANDS OUT",
      headline: "2 always-loaded items had no matching use."
    });
    expect(model.safeTest.headline).toContain("Review one unused always-loaded item");
  });

  it("shows simple post-change progress without experiment IDs or evidence jargon", () => {
    const text = renderGuidedExperience(buildGuidedExperience({
      wasteFinding: finding(),
      projection: projection(),
      qualitativeCoverage: "complete",
      interactive: true
    }));

    expect(text).toContain("2/3 test sessions complete");
    expect(text).not.toContain("tre_v0_");
    expect(text).not.toMatch(/cohort|metric evidence|revision/iu);
  });

  it("shows a reduction only when the canonical result and quality guard support it", () => {
    const supported = buildGuidedExperience({
      wasteFinding: finding(),
      projection: projection({
        state: "review_measured_result",
        tone: "positive",
        evidenceLabel: "calculated",
        qualityLabel: "held",
        qualityEvidence: "user_declared",
        postChangeSessions: 3,
        reductionPercent: 18
      }),
      qualitativeCoverage: "complete",
      interactive: false
    });
    const unsupported = buildGuidedExperience({
      wasteFinding: finding(),
      projection: projection({
        state: "review_measured_result",
        evidenceLabel: "missing",
        qualityLabel: "insufficient",
        reductionPercent: 18
      }),
      qualitativeCoverage: "complete",
      interactive: false
    });

    expect(supported.result).toEqual({
      headline: "18% fewer tokens per comparable completed session",
      detail: "Quality held, confirmed by you.",
      direction: "fewer"
    });
    expect(unsupported.result).toBeNull();
    expect(renderGuidedExperience(unsupported)).not.toContain("18% fewer");
  });

  it("uses the preferred experiment's canonical projection over conflicting adapter input", () => {
    const waste = finding();
    const experiment = {
      id: `tre_v0_${"d".repeat(64)}`,
      finding: waste,
      lifecycle: "complete",
      matchingPolicy: { minimumPostSessions: 3 },
      evaluation: {
        status: "measured_token_reduction",
        metricEvidence: "calculated",
        matchingEvidence: "observed",
        qualityStatus: "held",
        qualityEvidence: "observed",
        baseline: { includedSessions: 3, medianTotalTokens: 112_000 },
        postChange: { includedSessions: 3, medianTotalTokens: 92_000 },
        reductionPercent: 17.86,
        rollbackRecommended: false
      }
    } as TokenReductionExperimentV0;
    const model = buildGuidedExperience({
      preferredExperiment: experiment,
      projection: projection({
        state: "review_measured_result",
        evidenceLabel: "calculated",
        qualityLabel: "held",
        reductionPercent: 99
      }),
      qualitativeCoverage: "complete",
      interactive: false
    });

    expect(model.result).toEqual({
      headline: "17.86% fewer tokens per comparable completed session",
      detail: "112K → 92K median tokens. Quality held in the recorded check.",
      direction: "fewer"
    });
  });

  it("reports a supported regression as more tokens and recommends undoing it", () => {
    const model = buildGuidedExperience({
      wasteFinding: finding(),
      projection: projection({
        state: "rollback",
        tone: "negative",
        evidenceLabel: "calculated",
        qualityLabel: "held",
        qualityEvidence: "verified",
        postChangeSessions: 3,
        reductionPercent: -12.5
      }),
      qualitativeCoverage: "complete",
      interactive: true
    });

    expect(model.result).toEqual({
      headline: "12.5% more tokens per comparable completed session",
      detail: "The quality check passed. Undo the change.",
      direction: "more"
    });
  });

  it("never emits an interactive prompt in non-TTY mode", () => {
    const input: GuidedExperienceInput = {
      wasteFinding: finding(),
      projection: projection({ state: "approve_one_change" }),
      qualitativeCoverage: "complete",
      interactive: false
    };
    const model = buildGuidedExperience(input);
    const text = renderGuidedExperience(model);

    expect(model.interaction).toEqual({ mode: "read_only", startPrompt: null });
    expect(text).not.toContain("[Enter]");
    expect(text).toContain(
      "No experiment, approval, or project state changed. The private local evidence cache may refresh."
    );
  });
});
