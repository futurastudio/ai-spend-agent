import { describe, expect, it } from "vitest";
import type { ContextHealthResult } from "./contextHealth.js";
import type { DeadContextResult } from "./deadContext.js";
import type { SessionVitalV0, SessionVitalsV0 } from "./sessionVitals.js";
import { extractSessionVitalsV0 } from "./sessionVitals.js";
import { parseClaudeCodeTranscript } from "./localAgentLogs.js";
import { createActionVerificationReference } from "./actionVerification.js";
import {
  buildActionVerificationProjectionV0,
  invalidateTokenReductionExperimentV0,
  markTokenReductionAppliedV0,
  markTokenReductionRolledBackV0,
  planTokenReductionActionV0,
  refreshTokenReductionExperimentV0,
  resolveWasteFindingTargetV0,
  selectBestWasteFindingV0
} from "./actionPlanner.js";

const generatedAt = "2026-08-04T12:00:00.000Z";

function vital(
  label: string,
  total: number,
  day: number,
  overrides: Partial<SessionVitalV0> = {}
): SessionVitalV0 {
  const observedFrom = `2026-08-${String(day).padStart(2, "0")}T09:00:00.000Z`;
  const observedTo = `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  const completion = overrides.completion ?? {
    status: "completed" as const,
    evidence: "claude_turn_duration" as const,
    observedAt: observedTo
  };
  return {
    sessionRef: createActionVerificationReference("session", label),
    agent: "claude-code",
    sessionType: "parent",
    project: "agent-finops",
    projectRef: createActionVerificationReference("project", "agent-finops"),
    models: ["claude-sonnet-5"],
    sourceVersions: ["2.1.170"],
    observedFrom,
    observedTo,
    observedDurationMs: 3_600_000,
    tokenEvidence: {
      status: "observed",
      basis: "turn_sum",
      inputTokens: total,
      outputTokens: 0,
      componentTotalTokens: total,
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
    activity: {
      kind: "task",
      action: "testing",
      promptCount: 2,
      toolCallCount: 3
    },
    provenance: {
      source: "parsed_local_agent_calls",
      confidence: "observed",
      uploaded: false
    },
    ...overrides,
    completion
  };
}

function vitals(sessions: SessionVitalV0[]): SessionVitalsV0 {
  const observed = sessions.filter((session) => session.tokenEvidence.status === "observed").length;
  return {
    schemaVersion: 0,
    sessions,
    coverage: {
      inputCalls: sessions.length,
      deduplicatedCalls: sessions.length,
      eligibleCalls: sessions.length,
      emittedSessions: sessions.length,
      sessionsWithObservedTokens: observed,
      sessionsWithMissingTokens: sessions.length - observed,
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

function applicationEvidence(label: string) {
  return {
    changeRef: createActionVerificationReference("change", label),
    rollbackRef: createActionVerificationReference("rollback", label),
    canaryRef: createActionVerificationReference("canary", label),
    canaryStatus: "passed" as const
  };
}

function health(overrides: {
  active?: boolean;
  compactions?: number | null;
  repeatedReads?: number | null;
  ratio?: number | null;
} = {}): ContextHealthResult {
  return {
    schemaVersion: 1,
    generatedAt,
    status: "watch",
    recommendation: "start_fresh",
    headline: "product-authored fixture",
    action: "product-authored fixture",
    confidence: "high",
    currentSession: {
      status: overrides.active === false ? "recent" : "active",
      agent: "claude-code",
      project: "agent-finops",
      totalTokens: 200,
      contextTokens: 190,
      usageSource: "assistant_message_usage",
      ratioToMedian: overrides.ratio ?? 2,
      ratioCapped: false,
      comparisonSessions: 3,
      comparisonBasis: "same_project_and_session_type",
      cacheWriteTokens: 0,
      cacheWriteRatioToMedian: null,
      source: "local_transcript_metadata"
    },
    activation: {
      discoverableItems: 0,
      explicitlyInvokedItems: 0,
      hookInjectedItems: 0,
      lifecycleHooks: 0,
      mcpConfiguredItems: 0,
      mcpAlwaysLoadedItems: 0,
      mcpSchemaLoadedItems: 0,
      unmeasuredItems: 0,
      invocationUnobservableItems: 0
    },
    deadContext: {
      loadedItems: 0,
      neverInvokedItems: 0,
      measuredNeverInvokedItems: 0,
      unmeasuredNeverInvokedItems: 0,
      windowDays: 30
    },
    contextChurn: {
      currentSessionEvidence: "matched",
      compactionEvents: overrides.compactions ?? 2,
      explicitFileReads: 6,
      repeatedReadEvents: overrides.repeatedReads ?? 3,
      repeatedFiles: [{ file: "/private/never-export-this", readCount: 3 }],
      readCoverage: "explicit_read_tools_only",
      currentSessionScope: "parent",
      observedParentSessions: 4,
      observedSubagentSessions: 0
    },
    evidence: [],
    provenance: {
      inventory: "local_agent_configuration",
      invocations: "local_claude_code_and_codex_transcripts",
      session: "local_transcript_metadata",
      hookPayload: "not_executed_or_inferred",
      uploaded: false
    },
    caveats: []
  };
}

function deadContext(items: DeadContextResult["deadItems"]): DeadContextResult {
  const measured = items.filter((item) => item.weightConfidence === "estimated").length;
  return {
    hasData: items.length > 0,
    loadedCount: items.length,
    deadCount: items.length,
    measuredDeadCount: measured,
    unmeasuredDeadCount: items.length - measured,
    deadTokens: items.reduce((sum, item) =>
      item.weightConfidence === "estimated" ? sum + item.alwaysLoadedTokens : sum, 0),
    monthlyDeadTokens: 1_000,
    wastePercent: 1,
    monthlyUsd: 1,
    monthlyUsdUpperBound: 2,
    deadItems: items,
    sessions: 8,
    totalTurns: 20,
    pricingModel: "claude-sonnet-5",
    windowDays: 30
  };
}

function baseSessions(): SessionVitalV0[] {
  return [vital("base-1", 100, 1), vital("base-2", 110, 2), vital("base-3", 120, 3)];
}

describe("action planner", () => {
  it("selects exactly one highest-priority explicit signal and never leaks raw read paths", () => {
    const sessions = [...baseSessions(), vital("active", 500, 4)];
    const finding = selectBestWasteFindingV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health()
    });

    expect(finding?.findingType).toBe("compaction_pressure");
    expect(finding?.candidateAction.kind).toBe("start_fresh");
    expect(finding?.evidenceRefs).toHaveLength(4);
    expect(JSON.stringify(finding)).not.toContain("never-export-this");
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health()
    });
    expect(plan?.experiment.evaluation.baseline.includedSessions).toBe(3);
  });

  it("falls through from compaction to explicit repeated reads, then context ratio", () => {
    const sessions = [...baseSessions(), vital("active", 500, 4)];
    const repeated = selectBestWasteFindingV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health({ compactions: 0 })
    });
    const ratio = selectBestWasteFindingV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health({ compactions: 0, repeatedReads: 0 })
    });
    expect(repeated?.findingType).toBe("repeated_context_read");
    expect(ratio?.findingType).toBe("high_context_relative_to_baseline");
  });

  it("never points a current-session finding at a different model's baseline", () => {
    const sessions = [
      ...baseSessions(),
      vital("active-after-model-switch", 500, 4, { models: ["claude-opus-4-8"] })
    ];
    expect(selectBestWasteFindingV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health()
    })).toBeNull();
    expect(planTokenReductionActionV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      contextHealth: health()
    })).toBeNull();
  });

  it("joins a current-session finding to the exact opaque project cohort", () => {
    const repoA = createActionVerificationReference(
      "project-working-directory",
      "/private/team-a/app"
    );
    const repoB = createActionVerificationReference(
      "project-working-directory",
      "/private/team-b/app"
    );
    const context = health();
    context.currentSession!.project = "app";
    const repoABaseline = [1, 2, 3].map((day) =>
      vital(`repo-a-${day}`, 100 + day, day, { project: "app", projectRef: repoA })
    );
    const repoBBaseline = [1, 2, 3].map((day) =>
      vital(`repo-b-${day}`, 110 + day, day, { project: "app", projectRef: repoB })
    );
    const active = vital("repo-b-active", 500, 4, {
      project: "app",
      projectRef: repoB
    });
    const snapshot = vitals([...repoABaseline, ...repoBBaseline, active]);
    const finding = selectBestWasteFindingV0({
      sessionVitals: snapshot,
      generatedAt,
      contextHealth: context
    });
    const plan = planTokenReductionActionV0({
      sessionVitals: snapshot,
      generatedAt,
      contextHealth: context
    });

    expect(finding?.scope.projectRef).toBe(repoB);
    expect(resolveWasteFindingTargetV0({ finding: finding!, sessionVitals: snapshot }))
      .toMatchObject({ status: "resolved", ref: active.sessionRef });
    expect(plan?.experiment.cohort.projectRef).toBe(repoB);
    expect(plan?.experiment.baselineSessions).toHaveLength(3);
    expect(plan?.experiment.baselineSessions.every((session) =>
      session.projectRef === repoB
    )).toBe(true);

    const noRepoBBaseline = vitals([...repoABaseline, active]);
    expect(selectBestWasteFindingV0({
      sessionVitals: noRepoBBaseline,
      generatedAt,
      contextHealth: context
    })).toBeNull();
  });

  it("uses only measured configured-not-observed inventory and never prices MCP config", () => {
    const measured = deadContext([
      {
        kind: "skill",
        name: "private-skill-name",
        scope: "user",
        activation: "discoverable",
        host: "claude-code",
        invocationTracking: "observable",
        alwaysLoadedTokens: 80,
        weightConfidence: "estimated",
        path: "/private/skill.md"
      },
      {
        kind: "mcp_server",
        name: "private-mcp-name",
        scope: "user",
        activation: "mcp_configured",
        host: "claude-code",
        invocationTracking: "observable",
        alwaysLoadedTokens: 0,
        weightConfidence: "unmeasured",
        path: "/private/mcp.json"
      }
    ]);
    const finding = selectBestWasteFindingV0({
      sessionVitals: vitals(baseSessions()),
      generatedAt,
      deadContext: measured
    });
    expect(finding?.findingType).toBe("configured_not_observed");
    expect(finding?.metric).toMatchObject({ name: "configured_items", value: 1 });
    expect(JSON.stringify(finding)).not.toMatch(/private-skill|private-mcp|skill\.md|mcp\.json/);

    const mcpOnly = deadContext([{
      kind: "mcp_server",
      name: "server",
      scope: "user",
      activation: "mcp_configured",
      host: "claude-code",
      invocationTracking: "observable",
      alwaysLoadedTokens: 999,
      weightConfidence: "unmeasured"
    }]);
    expect(selectBestWasteFindingV0({
      sessionVitals: vitals(baseSessions()),
      generatedAt,
      deadContext: mcpOnly
    })).toBeNull();
  });

  it("binds one configured-item target into candidate identity and resolves it only from fresh local evidence", () => {
    const heavier = {
      kind: "skill" as const,
      name: "private-heavy-skill",
      scope: "user" as const,
      activation: "discoverable" as const,
      host: "claude-code" as const,
      invocationTracking: "observable" as const,
      alwaysLoadedTokens: 80,
      weightConfidence: "estimated" as const,
      path: "/private/heavy/SKILL.md"
    };
    const lighter = {
      ...heavier,
      name: "private-light-skill",
      alwaysLoadedTokens: 20,
      path: "/private/light/SKILL.md"
    };
    const evidence = deadContext([lighter, heavier]);
    const reordered = deadContext([heavier, lighter]);
    const first = selectBestWasteFindingV0({
      sessionVitals: vitals(baseSessions()), generatedAt, deadContext: evidence
    })!;
    const second = selectBestWasteFindingV0({
      sessionVitals: vitals(baseSessions()), generatedAt, deadContext: reordered
    })!;

    expect(first.target.kind).toBe("configured_item");
    expect(second.target).toEqual(first.target);
    expect(second.candidateKey).toBe(first.candidateKey);
    expect(JSON.stringify(first)).not.toMatch(/private-heavy|private-light|SKILL\.md/);
    expect(resolveWasteFindingTargetV0({ finding: first, deadContext: evidence }))
      .toMatchObject({
        status: "resolved",
        kind: "configured_item",
        ref: first.target.ref,
        name: "private-heavy-skill",
        path: "/private/heavy/SKILL.md",
        localOnly: true
      });
    expect(resolveWasteFindingTargetV0({
      finding: first,
      deadContext: deadContext([lighter])
    })).toMatchObject({ status: "not_found", ref: first.target.ref, localOnly: true });

    const lighterOnly = selectBestWasteFindingV0({
      sessionVitals: vitals(baseSessions()), generatedAt,
      deadContext: deadContext([lighter])
    })!;
    expect(lighterOnly.target.ref).not.toBe(first.target.ref);
    expect(lighterOnly.candidateKey).not.toBe(first.candidateKey);
  });

  it("binds a repeated-read target without persisting its path and fails resolution after evidence drift", () => {
    const sessions = [...baseSessions(), vital("active-read", 500, 4)];
    const context = health({ compactions: 0 });
    const finding = selectBestWasteFindingV0({
      sessionVitals: vitals(sessions), generatedAt, contextHealth: context
    })!;

    expect(finding.target.kind).toBe("repeated_read_file");
    expect(JSON.stringify(finding)).not.toContain("/private/never-export-this");
    expect(resolveWasteFindingTargetV0({ finding, contextHealth: context }))
      .toMatchObject({
        status: "resolved",
        kind: "repeated_read_file",
        ref: finding.target.ref,
        file: "/private/never-export-this",
        readCount: 3,
        localOnly: true
      });
    const changed = health({ compactions: 0 });
    changed.contextChurn.repeatedFiles = [{ file: "/private/different", readCount: 3 }];
    expect(resolveWasteFindingTargetV0({ finding, contextHealth: changed }))
      .toMatchObject({ status: "not_found", ref: finding.target.ref, localOnly: true });
  });

  it("resolves a session target only from one current privacy-safe SessionVitals row", () => {
    const sessions = [...baseSessions(), vital("active-session-target", 500, 4)];
    const snapshot = vitals(sessions);
    const finding = selectBestWasteFindingV0({
      sessionVitals: snapshot,
      generatedAt,
      contextHealth: health()
    })!;
    expect(finding.target.kind).toBe("session");
    const resolved = resolveWasteFindingTargetV0({ finding, sessionVitals: snapshot });
    expect(resolved).toEqual({
      status: "resolved",
      kind: "session",
      ref: finding.target.ref,
      agent: "claude-code",
      sessionType: "parent",
      observedFrom: "2026-08-04T09:00:00.000Z",
      observedTo: "2026-08-04T10:00:00.000Z",
      localOnly: true
    });
    expect(JSON.stringify(resolved)).not.toMatch(/agent-finops|claude-sonnet|prompt|private/i);
    expect(resolveWasteFindingTargetV0({ finding })).toEqual({
      status: "not_found",
      kind: "session",
      ref: finding.target.ref,
      localOnly: true
    });
    expect(resolveWasteFindingTargetV0({
      finding,
      sessionVitals: vitals([...sessions, { ...sessions.at(-1)! }])
    })).toMatchObject({ status: "not_found", kind: "session" });
    expect(resolveWasteFindingTargetV0({
      finding,
      sessionVitals: vitals(sessions.map((session) =>
        session.sessionRef === finding.target.ref
          ? { ...session, models: ["drifted-model"] }
          : session
      ))
    })).toMatchObject({ status: "not_found", kind: "session" });
  });

  it("fails closed when fewer than three comparable completed sessions survive drift", () => {
    const sessions = [
      vital("good-1", 100, 1),
      vital("good-2", 110, 2),
      vital("no-project", 120, 3, { project: undefined, projectRef: undefined }),
      vital("path-project", 130, 4, { project: "/private/acme", projectRef: undefined }),
      vital("model-drift", 140, 5, { models: ["a", "b"] }),
      vital("unknown-session", 150, 6, { sessionType: "unknown" }),
      vital("unsupported", 160, 7, {
        tokenEvidence: { status: "missing", reason: "unsupported_token_shape" }
      })
    ];
    expect(planTokenReductionActionV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      deadContext: deadContext([{
        kind: "skill",
        name: "x",
        scope: "user",
        activation: "discoverable",
        host: "claude-code",
        invocationTracking: "observable",
        alwaysLoadedTokens: 10,
        weightConfidence: "estimated"
      }])
    })).toBeNull();
  });

  it("deduplicates adversarial references instead of manufacturing a baseline", () => {
    const duplicate = vital("same-ref", 100, 1);
    const sessions = [duplicate, { ...duplicate, observedTo: "2026-08-02T10:00:00.000Z" },
      vital("unique", 120, 3)];
    expect(selectBestWasteFindingV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      deadContext: deadContext([{
        kind: "skill", name: "x", scope: "user", activation: "discoverable",
        host: "claude-code", invocationTracking: "observable", alwaysLoadedTokens: 1,
        weightConfidence: "estimated"
      }])
    })).toBeNull();
  });

  it("deterministically bounds finding evidence and baseline arrays at their schema caps", () => {
    const sessions = Array.from({ length: 300 }, (_, index) =>
      vital(`bounded-${String(index).padStart(3, "0")}`, 100 + index % 3, index % 3 + 1)
    );
    const inventory = deadContext([{
      kind: "skill",
      name: "bounded-skill",
      scope: "user",
      activation: "discoverable",
      host: "claude-code",
      invocationTracking: "observable",
      alwaysLoadedTokens: 10,
      weightConfidence: "estimated"
    }]);
    const first = planTokenReductionActionV0({
      sessionVitals: vitals(sessions), generatedAt, deadContext: inventory
    })!;
    const reversed = planTokenReductionActionV0({
      sessionVitals: vitals([...sessions].reverse()), generatedAt, deadContext: inventory
    })!;

    expect(first.finding.evidenceRefs).toHaveLength(256);
    expect(first.experiment.baselineSessions).toHaveLength(256);
    expect(reversed.finding.evidenceRefs).toEqual(first.finding.evidenceRefs);
    expect(reversed.experiment.baselineSessions.map((session) => session.sessionRef))
      .toEqual(first.experiment.baselineSessions.map((session) => session.sessionRef));
    expect(reversed.finding.id).toBe(first.finding.id);
    expect(reversed.experiment.id).toBe(first.experiment.id);
  });

  it("never merges separate repositories that share the same display basename", () => {
    const repoA = createActionVerificationReference("project-working-directory", "/private/a/app");
    const repoB = createActionVerificationReference("project-working-directory", "/private/b/app");
    const sessions = [
      vital("same-name-a1", 100, 1, { project: "app", projectRef: repoA }),
      vital("same-name-a2", 110, 2, { project: "app", projectRef: repoA }),
      vital("same-name-b1", 120, 1, { project: "app", projectRef: repoB }),
      vital("same-name-b2", 300, 2, { project: "app", projectRef: repoB })
    ];
    expect(planTokenReductionActionV0({
      sessionVitals: vitals(sessions),
      generatedAt
    })).toBeNull();
  });

  it("does not draft an exact cohort when the host source version is missing", () => {
    const sessions = [
      vital("format-1", 100, 1, { sourceVersions: [] }),
      vital("format-2", 110, 2, { sourceVersions: [] }),
      vital("format-3", 300, 3, { sourceVersions: [] })
    ];
    const plan = planTokenReductionActionV0({ sessionVitals: vitals(sessions), generatedAt });
    expect(plan).toBeNull();
  });

  it("requires an explicit completed session snapshot rather than inferring from inactivity", () => {
    const missingCompletion = baseSessions().map((session) => ({
      ...session,
      completion: {
        status: "missing" as const,
        evidence: "missing" as const,
        reason: "completion_marker_not_observed" as const
      }
    }));
    expect(planTokenReductionActionV0({
      sessionVitals: vitals(missingCompletion),
      generatedAt,
      contextHealth: health({ active: false })
    })).toBeNull();
  });

  it("excludes observed host-version drift from the exact post-change cohort", () => {
    const baseline = [vital("vb1", 100, 1), vital("vb2", 120, 2), vital("vb3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline),
      generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    expect(plan.experiment.cohort.sourceVersionRef).toMatch(/^avref_/);
    expect(plan.experiment.matchingPolicy.requireExactSourceVersion).toBe(true);
    const legacyParserRef = createActionVerificationReference(
      "parser-format-version",
      "claude-code:schema-1:claude-code-v1"
    );
    const legacySourceRef = createActionVerificationReference(
      "host-source-and-parser-version",
      `claude-code:2.1.170:${legacyParserRef}`
    );
    expect(plan.experiment.cohort.sourceVersionRef).not.toBe(legacySourceRef);
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("version-drift")
    });
    const post = [
      vital("vp1", 70, 11),
      vital("vp2", 80, 12),
      vital("vp3-drift", 90, 13, { sourceVersions: ["2.1.171"] })
    ];
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals(post),
      observedAt: "2026-08-14T12:00:00.000Z"
    });
    expect(refreshed.postSessions).toHaveLength(2);
    expect(refreshed.evaluation.postChange.includedSessions).toBe(2);
    expect(refreshed.lifecycle).toBe("collecting");
  });

  it("does not turn a stale session-only signal into an action candidate", () => {
    expect(selectBestWasteFindingV0({
      sessionVitals: vitals([vital("stale-1", 100, 1), vital("stale-2", 110, 2),
        vital("stale-3", 300, 3)]),
      generatedAt: "2026-08-20T12:00:00.000Z"
    })).toBeNull();
  });

  it("records explicit approval and a user-declared passing canary", () => {
    const qualities = Object.fromEntries(baseSessions().map((session) =>
      [session.sessionRef, "passed"] as const
    ));
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals([vital("base-1", 100, 1), vital("base-2", 110, 2),
        vital("base-3", 300, 3)]),
      generatedAt,
      qualityBySessionRef: qualities
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("one-reversible-change")
    });
    expect(applied.lifecycle).toBe("applied");
    expect(applied.intervention).toMatchObject({
      approval: { status: "explicit", evidence: "user_declared" },
      canary: { status: "passed", evidence: "user_declared" }
    });
    expect(() => markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("invalid-change"),
      changeRef: "/raw/change/path"
    })).toThrow(/opaque/);
    expect(() => markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-03T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("approval-before-experiment")
    })).toThrow(/cannot be approved before its experiment exists/);
  });

  it("requires frozen baseline quality and all three opaque intervention evidence references", () => {
    const sessions = [vital("guard-1", 100, 1), vital("guard-2", 110, 2),
      vital("guard-3", 300, 3)];
    const missingQuality = planTokenReductionActionV0({
      sessionVitals: vitals(sessions), generatedAt
    })!;
    expect(missingQuality.experiment.lifecycle).toBe("baseline_ready");
    expect(missingQuality.experiment.evaluation.qualityStatus).toBe("insufficient");
    expect(() => markTokenReductionAppliedV0(missingQuality.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("missing-baseline-quality")
    })).toThrow(/Baseline quality must be recorded/);

    const guarded = planTokenReductionActionV0({
      sessionVitals: vitals(sessions),
      generatedAt,
      qualityBySessionRef: Object.fromEntries(sessions.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const valid = applicationEvidence("required-digests");
    for (const [field, message] of [
      ["changeRef", /change.*opaque/i],
      ["rollbackRef", /rollback.*opaque/i],
      ["canaryRef", /canary.*opaque/i]
    ] as const) {
      expect(() => markTokenReductionAppliedV0(guarded.experiment, {
        approvedAt: "2026-08-10T12:05:00.000Z",
        appliedAt: "2026-08-10T12:10:00.000Z",
        ...valid,
        [field]: undefined as unknown as string
      })).toThrow(message);
    }
  });

  it("persists a failed canary without inventing rollback execution, then accepts only one frozen rollback", () => {
    const sessions = [vital("rb-guard-1", 100, 1), vital("rb-guard-2", 110, 2),
      vital("rb-guard-3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(sessions), generatedAt,
      qualityBySessionRef: Object.fromEntries(sessions.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const evidence = applicationEvidence("failed-canary");
    const failed = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...evidence,
      canaryStatus: "failed"
    });
    expect(failed.lifecycle).toBe("applied");
    expect(failed.evaluation.status).toBe("inconclusive");
    expect(failed.evaluation.rollbackRecommended).toBe(true);
    expect(failed.intervention).toMatchObject({
      changeRef: evidence.changeRef,
      rollbackRef: evidence.rollbackRef,
      canary: {
        status: "failed",
        evidence: "user_declared",
        evidenceRef: evidence.canaryRef
      },
      appliedAt: "2026-08-10T12:10:00.000Z"
    });
    expect(failed.intervention.rolledBackAt).toBeUndefined();

    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("explicit-rollback")
    });
    expect(() => invalidateTokenReductionExperimentV0(applied, {
      invalidatedAt: "2026-08-10T12:15:00.000Z",
      reason: "manual"
    })).toThrow(/applied changes require rollback/i);
    expect(() => markTokenReductionRolledBackV0(applied, {
      rolledBackAt: applied.intervention.appliedAt!,
      rollbackRef: applied.intervention.rollbackRef!
    })).toThrow(/rollback must follow application/i);
    expect(() => markTokenReductionRolledBackV0(applied, {
      rolledBackAt: "2026-08-10T12:20:00.000Z",
      rollbackRef: createActionVerificationReference("rollback", "wrong")
    })).toThrow(/does not match/);
    const rolledBack = markTokenReductionRolledBackV0(applied, {
      rolledBackAt: "2026-08-10T12:20:00.000Z",
      rollbackRef: applied.intervention.rollbackRef!
    });
    expect(rolledBack.lifecycle).toBe("rolled_back");
    expect(rolledBack.intervention.rolledBackAt).toBe("2026-08-10T12:20:00.000Z");
    expect(() => markTokenReductionRolledBackV0(rolledBack, {
      rolledBackAt: "2026-08-10T12:30:00.000Z",
      rollbackRef: rolledBack.intervention.rollbackRef!
    })).toThrow(/terminal.*another rollback boundary/i);
  });

  it("keeps calculated and provider-reported totals and their evidence labels distinct", () => {
    const sessions = [
      vital("totals-1", 100, 1, {
        tokenEvidence: {
          ...vital("unused", 100, 1).tokenEvidence as Extract<SessionVitalV0["tokenEvidence"], { status: "observed" }>,
          reportedTotalTokens: 100,
          componentEvidence: {
            inputTokens: "observed",
            outputTokens: "observed",
            cacheReadTokens: "not_separately_reported",
            cacheWriteTokens: "not_separately_reported",
            thoughtTokens: "not_separately_reported",
            toolTokens: "not_separately_reported",
            componentTotalTokens: "calculated_complete",
            reportedTotalTokens: "provider_reported"
          }
        }
      }),
      vital("totals-2", 110, 2),
      vital("totals-3", 300, 3)
    ];
    const plan = planTokenReductionActionV0({ sessionVitals: vitals(sessions), generatedAt })!;
    const reported = plan.experiment.baselineSessions.find((session) =>
      session.sessionRef === sessions[0]!.sessionRef
    );
    const calculatedOnly = plan.experiment.baselineSessions.find((session) =>
      session.sessionRef === sessions[1]!.sessionRef
    );

    expect(reported?.tokens).toMatchObject({
      calculatedTotalTokens: 100,
      reportedTotalTokens: 100,
      componentEvidence: {
        calculatedTotalTokens: "calculated_complete",
        reportedTotalTokens: "provider_reported"
      }
    });
    expect(calculatedOnly?.tokens).toMatchObject({
      calculatedTotalTokens: 110,
      reportedTotalTokens: null,
      componentEvidence: {
        calculatedTotalTokens: "calculated_complete",
        reportedTotalTokens: "not_reported"
      }
    });
  });

  it("excludes partial component sums unless an honest provider-reported total is available", () => {
    const partial = vital("partial-total", 300, 3);
    if (partial.tokenEvidence.status !== "observed") throw new Error("fixture must be observed");
    const partialWithoutReportedEvidence: Extract<
      SessionVitalV0["tokenEvidence"],
      { status: "observed" }
    > = {
      ...partial.tokenEvidence,
      componentEvidence: {
        ...partial.tokenEvidence.componentEvidence,
        componentTotalTokens: "calculated_partial",
        reportedTotalTokens: "not_reported"
      }
    };
    const partialWithoutReported: SessionVitalV0 = {
      ...partial,
      tokenEvidence: partialWithoutReportedEvidence
    };
    const complete = [vital("partial-base-1", 100, 1), vital("partial-base-2", 110, 2)];

    expect(planTokenReductionActionV0({
      sessionVitals: vitals([...complete, partialWithoutReported]),
      generatedAt
    })).toBeNull();

    const partialWithReported: SessionVitalV0 = {
      ...partialWithoutReported,
      tokenEvidence: {
        ...partialWithoutReportedEvidence,
        reportedTotalTokens: 300,
        componentEvidence: {
          ...partialWithoutReportedEvidence.componentEvidence,
          reportedTotalTokens: "provider_reported"
        }
      }
    };
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals([...complete, partialWithReported]),
      generatedAt
    });
    expect(plan?.experiment.lifecycle).toBe("baseline_ready");
    const session = plan?.experiment.baselineSessions.find((entry) =>
      entry.sessionRef === partial.sessionRef
    );
    expect(session?.tokens).toMatchObject({
      calculatedTotalTokens: 300,
      reportedTotalTokens: 300,
      componentEvidence: {
        calculatedTotalTokens: "calculated_partial",
        reportedTotalTokens: "provider_reported"
      }
    });
  });

  it("refreshes after the boundary through the canonical evaluator", () => {
    const baseline = [vital("b1", 100, 1), vital("b2", 120, 2), vital("b3", 300, 3)];
    const baselineQuality = Object.fromEntries(baseline.map((session) =>
      [session.sessionRef, "passed"] as const
    ));
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline), generatedAt, qualityBySessionRef: baselineQuality
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("one")
    });
    const post = [
      vital("p1", 70, 11), vital("p2", 80, 12), vital("p3", 90, 13),
      vital("wrong-model", 1, 13, { models: ["other-model"] }),
      vital("before-boundary", 1, 9)
    ];
    const allQuality = Object.fromEntries([...baseline, ...post].map((session) =>
      [session.sessionRef, "passed"] as const
    ));
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals([...baseline, ...post]),
      observedAt: "2026-08-14T12:00:00.000Z",
      qualityBySessionRef: allQuality
    });
    expect(refreshed.lifecycle).toBe("complete");
    expect(refreshed.evaluation.status).toBe("measured_token_reduction");
    expect(refreshed.evaluation.status).not.toBe("verified_token_reduction");
    expect(refreshed.evaluation.postChange.includedSessions).toBe(3);
    expect(refreshed.postSessions).toHaveLength(3);
    expect(refreshed.postSessions.map((session) => session.model)).not.toContain("other-model");
  });

  it("freezes one resumed cumulative-session snapshot and only fills its missing quality", () => {
    const baseline = [
      vital("resume-b1", 100, 1), vital("resume-b2", 120, 2), vital("resume-b3", 300, 3)
    ];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline),
      generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("resume-snapshot")
    });
    const firstSnapshot = vital("resumed-native-session", 70, 11);
    const first = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals([firstSnapshot]),
      observedAt: "2026-08-11T12:00:00.000Z"
    });
    expect(first.postSessions).toHaveLength(1);
    expect(first.postSessions[0]).toMatchObject({
      sessionRef: firstSnapshot.sessionRef,
      tokens: { calculatedTotalTokens: 70 },
      quality: { status: "missing", evidence: "missing" }
    });

    const laterCumulativeSnapshot = vital("resumed-native-session", 700, 12);
    const labelled = refreshTokenReductionExperimentV0(first, {
      sessionVitals: vitals([laterCumulativeSnapshot]),
      observedAt: "2026-08-12T12:00:00.000Z",
      qualityBySessionRef: { [firstSnapshot.sessionRef]: "passed" }
    });
    expect(labelled.postSessions).toHaveLength(1);
    expect(labelled.postSessions[0]).toMatchObject({
      sessionRef: firstSnapshot.sessionRef,
      startedAt: "2026-08-11T09:00:00.000Z",
      endedAt: "2026-08-11T10:00:00.000Z",
      tokens: { calculatedTotalTokens: 70 },
      quality: { status: "passed", evidence: "user_declared" }
    });

    const attemptedRelabel = refreshTokenReductionExperimentV0(labelled, {
      sessionVitals: vitals([laterCumulativeSnapshot]),
      observedAt: "2026-08-12T13:00:00.000Z",
      qualityBySessionRef: { [firstSnapshot.sessionRef]: "failed" }
    });
    expect(attemptedRelabel.revisionId).toBe(labelled.revisionId);
    expect(attemptedRelabel.postSessions[0]?.quality.status).toBe("passed");

    const resumedBaselineRef = vital("resume-b1", 999, 13);
    const baselineReuse = refreshTokenReductionExperimentV0(attemptedRelabel, {
      sessionVitals: vitals([laterCumulativeSnapshot, resumedBaselineRef]),
      observedAt: "2026-08-13T12:00:00.000Z"
    });
    expect(baselineReuse.postSessions).toHaveLength(1);
    expect(baselineReuse.postSessions[0]?.sessionRef).toBe(firstSnapshot.sessionRef);
  });

  it("deterministically bounds the first post-change snapshot cohort", () => {
    const baseline = [vital("post-cap-b1", 100, 1), vital("post-cap-b2", 120, 2),
      vital("post-cap-b3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline), generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("post-cap")
    });
    const post = Array.from({ length: 300 }, (_, index) =>
      vital(`post-cap-${String(index).padStart(3, "0")}`, 70 + index % 5, 11 + index % 3)
    );
    const quality = Object.fromEntries(post.map((session) =>
      [session.sessionRef, "passed"] as const
    ));
    const first = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals(post), observedAt: "2026-08-14T12:00:00.000Z",
      qualityBySessionRef: quality
    });
    const reversed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals([...post].reverse()), observedAt: "2026-08-14T12:00:00.000Z",
      qualityBySessionRef: quality
    });

    expect(first.postSessions).toHaveLength(256);
    expect(first.lifecycle).toBe("complete");
    expect(reversed.postSessions).toEqual(first.postSessions);
    expect(reversed.revisionId).toBe(first.revisionId);
  });

  it("preserves baseline quality and freezes a completed result", () => {
    const baseline = [vital("q1", 100, 1), vital("q2", 120, 2), vital("q3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline), generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("preserve-quality")
    });
    const post = [vital("qp1", 70, 11), vital("qp2", 80, 12), vital("qp3", 90, 13)];
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals(post),
      observedAt: "2026-08-14T12:00:00.000Z",
      qualityBySessionRef: Object.fromEntries(post.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    });
    expect(refreshed.evaluation.qualityStatus).toBe("held");
    expect(refreshed.evaluation.status).toBe("measured_token_reduction");
    expect(() => refreshTokenReductionExperimentV0(refreshed, {
      sessionVitals: vitals(post),
      observedAt: "2026-08-14T13:00:00.000Z"
    })).toThrow(/complete.*cannot collect new evidence/i);
    const rolledBack = markTokenReductionRolledBackV0(refreshed, {
      rolledBackAt: "2026-08-14T13:00:00.000Z",
      rollbackRef: refreshed.intervention.rollbackRef!
    });
    expect(rolledBack.lifecycle).toBe("rolled_back");
    expect(rolledBack.postSessions).toEqual(refreshed.postSessions);
  });

  it("excludes the current active post-change session from a completed cohort", () => {
    const baseline = [vital("a1", 100, 1), vital("a2", 120, 2), vital("a3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline),
      generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("exclude-active-post")
    });
    const post = [
      vital("ap1", 70, 11),
      vital("ap2", 80, 12),
      vital("ap3", 90, 13),
      vital("active-post", 1, 14)
    ];
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals(post),
      observedAt: "2026-08-15T12:00:00.000Z",
      contextHealth: health(),
      qualityBySessionRef: Object.fromEntries(post.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    });
    expect(refreshed.evaluation.postChange.includedSessions).toBe(3);
    expect(refreshed.postSessions.map((session) => session.sessionRef))
      .not.toContain(post[3]!.sessionRef);
  });

  it("never persists unrelated same-name projects in another project's post cohort", () => {
    const projectA = createActionVerificationReference("project-working-directory", "/private/a/app");
    const projectB = createActionVerificationReference("project-working-directory", "/private/b/app");
    const baseline = [
      vital("iso-a1", 100, 1, { project: "app", projectRef: projectA }),
      vital("iso-a2", 120, 2, { project: "app", projectRef: projectA }),
      vital("iso-a3", 300, 3, { project: "app", projectRef: projectA })
    ];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline),
      generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("isolate-project")
    });
    const postA = [1, 2, 3].map((day) =>
      vital(`iso-post-a${day}`, 70 + day, 10 + day, { project: "app", projectRef: projectA })
    );
    const unrelated = Array.from({ length: 260 }, (_, index) =>
      vital(`iso-post-b${index}`, 1, 10 + (index % 3), {
        project: "app",
        projectRef: projectB,
        observedFrom: `2026-08-1${1 + (index % 3)}T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
        observedTo: `2026-08-1${1 + (index % 3)}T10:${String(index % 60).padStart(2, "0")}:00.000Z`
      })
    );
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals([...postA, ...unrelated]),
      observedAt: "2026-08-15T12:00:00.000Z"
    });

    expect(refreshed.postSessions).toHaveLength(3);
    expect(refreshed.postSessions.every((session) => session.projectRef === projectA)).toBe(true);
    expect(JSON.stringify(refreshed)).not.toContain(projectB);
  });

  it("turns failed post quality into a rollback recommendation, not a savings claim", () => {
    const baseline = [vital("rb1", 100, 1), vital("rb2", 120, 2), vital("rb3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(baseline), generatedAt,
      qualityBySessionRef: Object.fromEntries(baseline.map((session) => [session.sessionRef, "passed"]))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("rollback-case")
    });
    const post = [vital("rp1", 70, 11), vital("rp2", 80, 12), vital("rp3", 90, 13)];
    const quality = Object.fromEntries([...baseline, ...post].map((session) =>
      [session.sessionRef, session.sessionRef === post[0]!.sessionRef ? "failed" : "passed"]
    )) as Record<string, "passed" | "failed">;
    const refreshed = refreshTokenReductionExperimentV0(applied, {
      sessionVitals: vitals(post), observedAt: "2026-08-14T12:00:00.000Z",
      qualityBySessionRef: quality
    });
    expect(refreshed.evaluation.status).toBe("regressed");
    expect(buildActionVerificationProjectionV0(refreshed)).toMatchObject({
      state: "rollback", tone: "negative", evidenceLabel: "missing",
      qualityLabel: "regressed"
    });
  });

  it("keeps the compact projection product-authored and privacy-safe", () => {
    const sessions = [vital("s1", 100, 1), vital("s2", 110, 2), vital("s3", 300, 3)];
    const plan = planTokenReductionActionV0({ sessionVitals: vitals(sessions), generatedAt })!;
    const projection = buildActionVerificationProjectionV0(plan.experiment);
    expect(projection.state).toBe("approve_one_change");
    expect(JSON.stringify(projection)).not.toMatch(/agent-finops|claude-sonnet|private|prompt/i);
  });

  it("gives rolled-back and cancelled histories explicit terminal projection states", () => {
    const sessions = [vital("terminal-1", 100, 1), vital("terminal-2", 110, 2),
      vital("terminal-3", 300, 3)];
    const plan = planTokenReductionActionV0({
      sessionVitals: vitals(sessions), generatedAt,
      qualityBySessionRef: Object.fromEntries(sessions.map((session) =>
        [session.sessionRef, "passed"] as const
      ))
    })!;
    const applied = markTokenReductionAppliedV0(plan.experiment, {
      approvedAt: "2026-08-10T12:05:00.000Z",
      appliedAt: "2026-08-10T12:10:00.000Z",
      ...applicationEvidence("terminal-state")
    });
    const rolledBack = markTokenReductionRolledBackV0(applied, {
      rolledBackAt: "2026-08-10T12:20:00.000Z",
      rollbackRef: applied.intervention.rollbackRef!
    });
    const cancelled = invalidateTokenReductionExperimentV0(plan.experiment, {
      invalidatedAt: "2026-08-10T12:05:00.000Z",
      reason: "manual"
    });

    expect(buildActionVerificationProjectionV0(rolledBack).state).toBe("rolled_back");
    expect(buildActionVerificationProjectionV0(cancelled).state).toBe("cancelled");
  });
});

describe("claude-code subagent cohort formation (ccd shared-sessionId corpus)", () => {
  // Modeled on the real Claude Code desktop layout: every subagent transcript
  // lives under <parent-session-id>/subagents/agent-<id>.jsonl, carries the
  // PARENT's sessionId on every line, and has no completion marker of its
  // own — the parent transcript records each run's completion as a Task tool
  // result. One agent version, one model, one project, many subagent files.
  const parentSessionId = "ccd-parent-session";
  const projectsDir = "/Users/testuser/.claude/projects/-Users-testuser-agent-finops";

  function assistantLine(input: {
    agentId?: string;
    requestId: string;
    timestamp: string;
    inputTokens: number;
  }): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: input.timestamp,
      cwd: "/Users/testuser/agent-finops",
      sessionId: parentSessionId,
      requestId: input.requestId,
      version: "2.1.229",
      ...(input.agentId ? { isSidechain: true, agentId: input.agentId } : {}),
      message: {
        id: `msg-${input.requestId}`,
        model: "claude-sonnet-5",
        usage: {
          input_tokens: input.inputTokens,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
        }
      }
    });
  }

  function completionLine(agentId: string, timestamp: string): string {
    return JSON.stringify({
      type: "user",
      timestamp,
      sessionId: parentSessionId,
      toolUseResult: { agentId, status: "completed", totalDurationMs: 60_000 }
    });
  }

  function corpusCalls() {
    const subagentRuns = [
      { agentId: "a1111111111111111", day: 1, inputTokens: 100 },
      { agentId: "a2222222222222222", day: 2, inputTokens: 100 },
      { agentId: "a3333333333333333", day: 3, inputTokens: 100 },
      { agentId: "a4444444444444444", day: 4, inputTokens: 4_000 }
    ];
    const files: Array<[string, string]> = subagentRuns.map((run) => [
      `${projectsDir}/${parentSessionId}/subagents/agent-${run.agentId}.jsonl`,
      assistantLine({
        agentId: run.agentId,
        requestId: `req-${run.agentId}`,
        timestamp: `2026-08-0${run.day}T09:00:00.000Z`,
        inputTokens: run.inputTokens
      })
    ]);
    files.push([
      `${projectsDir}/${parentSessionId}.jsonl`,
      [
        assistantLine({
          requestId: "req-parent",
          timestamp: "2026-08-01T08:00:00.000Z",
          inputTokens: 60
        }),
        ...subagentRuns.map((run) =>
          completionLine(run.agentId, `2026-08-0${run.day}T09:30:00.000Z`)
        )
      ].join("\n")
    ]);
    return files.flatMap(([filePath, content]) =>
      parseClaudeCodeTranscript(content, filePath)
    );
  }

  it("forms a usable subagent cohort from split run identities where the old merge collapsed to nothing", () => {
    const calls = corpusCalls();
    const sessionVitals = extractSessionVitalsV0(calls);

    // Five transcript files -> five rows: one parent, four subagent runs.
    expect(sessionVitals.sessions).toHaveLength(5);
    expect(sessionVitals.sessions.filter((session) =>
      session.sessionType === "subagent"
    )).toHaveLength(4);

    const finding = selectBestWasteFindingV0({ sessionVitals, generatedAt });
    expect(finding).toMatchObject({
      findingType: "high_context_relative_to_baseline",
      scope: { agent: "claude-code", model: "claude-sonnet-5" },
      source: { id: "session-vitals-v0", freshness: "fresh" }
    });

    // The same evidence without per-run identity reproduces the defect: all
    // 88-files-into-4-rows style merging collapses to one unknown-type row
    // that fails the structural gates, so no cohort and no finding ever form.
    const merged = calls.map(({ subagentId: _s, subagentCompletions: _c, ...rest }) => rest);
    const mergedVitals = extractSessionVitalsV0(merged);
    expect(mergedVitals.sessions).toHaveLength(1);
    expect(mergedVitals.sessions[0]?.sessionType).toBe("unknown");
    expect(selectBestWasteFindingV0({ sessionVitals: mergedVitals, generatedAt })).toBeNull();

    // Token totals survive the split exactly: no financial evidence is
    // dropped or invented by giving runs their own rows.
    const observedTotal = (vitals: typeof sessionVitals) =>
      vitals.sessions.reduce((sum, session) =>
        session.tokenEvidence.status === "observed"
          ? sum + session.tokenEvidence.componentTotalTokens
          : sum, 0);
    expect(observedTotal(sessionVitals)).toBe(observedTotal(mergedVitals));
  });
});
