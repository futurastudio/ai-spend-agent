import { describe, expect, it } from "vitest";
import type { LocalAgentCall } from "./localAgentLogs.js";
import { extractSessionVitalsV0 } from "./sessionVitals.js";

function call(overrides: Partial<LocalAgentCall> = {}): LocalAgentCall {
  return {
    agent: "claude-code",
    callId: "call-1",
    sessionId: "private-session-id",
    model: "claude-sonnet-4-6",
    timestamp: "2026-08-15T12:00:00.000Z",
    project: "agent-finops",
    workingDirectory: "/workspace/private/agent-finops",
    usageScope: "turn",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWrite5mTokens: 10,
      cacheWrite1hTokens: 0
    },
    ...overrides
  };
}

describe("extractSessionVitalsV0", () => {
  it("aggregates Claude turns without exposing raw session, prompt, file, or path data", () => {
    const calls = [
      call({
        callId: "call-1",
        timestamp: "2026-08-15T12:00:00.000Z",
        activity: {
          summary: "Fix secret customer workflow",
          kind: "task",
          action: "fixing",
          source: "user_prompts",
          promptCount: 2,
          toolCallCount: 3,
          files: ["secret-customer.ts"],
          isSubagent: false
        }
      }),
      call({
        callId: "call-2",
        timestamp: "2026-08-15T12:05:00.000Z",
        usage: {
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 75,
          cacheWrite5mTokens: 5,
          cacheWrite1hTokens: 0
        },
        latestTurnUsage: {
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 75,
          cacheWrite5mTokens: 5,
          cacheWrite1hTokens: 0,
          contextTokens: 280,
          totalTokens: 320,
          source: "assistant_message_usage"
        },
        activity: {
          summary: "Fix secret customer workflow",
          kind: "task",
          action: "fixing",
          source: "user_prompts",
          promptCount: 4,
          toolCallCount: 7,
          files: ["secret-customer.ts", "private-config.ts"],
          isSubagent: false
        }
      }),
      // Copied/checkpointed turn evidence with the same stable call identity is
      // removed by the canonical local-call deduper before session aggregation.
      call({
        callId: "call-2",
        timestamp: "2026-08-15T12:05:00.000Z",
        usage: {
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 75,
          cacheWrite5mTokens: 5,
          cacheWrite1hTokens: 0
        }
      })
    ];

    const result = extractSessionVitalsV0(calls);

    expect(result.schemaVersion).toBe(0);
    expect(result.coverage).toMatchObject({
      inputCalls: 3,
      eligibleCalls: 3,
      deduplicatedCalls: 2,
      emittedSessions: 1,
      sessionsWithObservedTokens: 1,
      sessionsWithMissingTokens: 0
    });
    expect(result.sessions[0]).toMatchObject({
      agent: "claude-code",
      sessionType: "parent",
      project: "agent-finops",
      models: ["claude-sonnet-4-6"],
      sourceVersions: [],
      observedFrom: "2026-08-15T12:00:00.000Z",
      observedTo: "2026-08-15T12:05:00.000Z",
      observedDurationMs: 300_000,
      tokenEvidence: {
        status: "observed",
        basis: "turn_sum",
        inputTokens: 300,
        outputTokens: 60,
        cacheReadTokens: 125,
        cacheWrite5mTokens: 15,
        cacheWrite1hTokens: 0,
        componentTotalTokens: 500,
        componentEvidence: {
          componentTotalTokens: "calculated_complete",
          reportedTotalTokens: "not_reported"
        }
      },
      latestTurn: {
        contextTokens: 280,
        totalTokens: 320,
        source: "assistant_message_usage"
      },
      activity: {
        kind: "task",
        action: "fixing",
        promptCount: 4,
        toolCallCount: 7
      }
    });
    expect(result.sessions[0]!.sessionRef).toMatch(/^avref_[a-f0-9]{64}$/);
    expect(result.sessions[0]!.projectRef).toMatch(/^avref_[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-session-id");
    expect(serialized).not.toContain("/workspace/private");
    expect(serialized).not.toContain("secret customer");
    expect(serialized).not.toContain("secret-customer.ts");
  });

  it("retains only the latest Codex cumulative snapshot and transcript-reported runway", () => {
    const earlier = call({
      agent: "codex",
      callId: undefined,
      sessionId: "codex-session",
      model: "gpt-5.6",
      startedAt: "2026-08-15T10:00:00.000Z",
      timestamp: "2026-08-15T10:20:00.000Z",
      usageScope: "session_cumulative",
      usageSupport: "complete",
      sourceVersion: "2.1.170",
      usage: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 100 },
      reportedTotalTokens: 540
    });
    const latest = call({
      agent: "codex",
      callId: undefined,
      sessionId: "codex-session",
      model: "gpt-5.6",
      startedAt: "2026-08-15T10:00:00.000Z",
      timestamp: "2026-08-15T10:45:00.000Z",
      usageScope: "session_cumulative",
      usageSupport: "complete",
      sourceVersion: "2.1.170",
      usage: { inputTokens: 900, outputTokens: 90, cacheReadTokens: 300 },
      reportedTotalTokens: 1_290,
      latestTurnUsage: {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 50,
        contextTokens: 250,
        totalTokens: 270,
        source: "transcript_last_token_usage"
      },
      rateLimits: {
        observedAt: "2026-08-15T10:45:00.000Z",
        planType: "pro",
        windows: [{
          kind: "weekly",
          name: "weekly",
          usedPercent: 37,
          windowMinutes: 10_080,
          resetsAt: "2026-08-18T12:00:00.000Z"
        }]
      }
    });

    const result = extractSessionVitalsV0([latest, earlier]);

    expect(result.coverage.deduplicatedCalls).toBe(1);
    expect(result.sessions[0]).toMatchObject({
      agent: "codex",
      sessionType: "unknown",
      sourceVersions: ["2.1.170"],
      observedFrom: "2026-08-15T10:00:00.000Z",
      observedTo: "2026-08-15T10:45:00.000Z",
      observedDurationMs: 2_700_000,
      tokenEvidence: {
        status: "observed",
        basis: "session_cumulative",
        inputTokens: 900,
        outputTokens: 90,
        cacheReadTokens: 300,
        componentTotalTokens: 1_290,
        reportedTotalTokens: 1_290,
        componentEvidence: {
          componentTotalTokens: "calculated_complete",
          reportedTotalTokens: "provider_reported"
        }
      },
      latestTurn: {
        contextTokens: 250,
        totalTokens: 270,
        source: "transcript_last_token_usage"
      },
      rateLimits: {
        observedAt: "2026-08-15T10:45:00.000Z",
        planType: "pro",
        windows: [{ usedPercent: 37, windowMinutes: 10_080 }]
      }
    });
  });

  it("fails the entire session token total closed on unsupported or mixed evidence", () => {
    const unsupported = extractSessionVitalsV0([
      call(),
      call({
        callId: "call-2",
        timestamp: "2026-08-15T12:05:00.000Z",
        usageSupport: "unsupported_token_shape",
        reportedTotalTokens: 999,
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    ]);
    expect(unsupported.sessions[0]!.tokenEvidence).toEqual({
      status: "missing",
      reason: "unsupported_token_shape"
    });
    expect(JSON.stringify(unsupported.sessions[0]!.tokenEvidence)).not.toContain("999");

    const mixed = extractSessionVitalsV0([
      call(),
      call({
        agent: "claude-code",
        callId: undefined,
        timestamp: "2026-08-15T12:05:00.000Z",
        usageScope: "session_cumulative"
      })
    ]);
    expect(mixed.sessions[0]!.tokenEvidence).toEqual({
      status: "missing",
      reason: "mixed_usage_scope"
    });
  });

  it("preserves partial component coverage instead of presenting it as a complete total", () => {
    const result = extractSessionVitalsV0([call({
      tokenComponentEvidence: {
        inputTokens: "observed",
        outputTokens: "observed",
        cacheReadTokens: "not_separately_reported",
        cacheWriteTokens: "not_separately_reported",
        thoughtTokens: "not_separately_reported",
        toolTokens: "not_separately_reported",
        calculatedTotalTokens: "calculated_partial",
        reportedTotalTokens: "not_reported"
      },
      usage: { inputTokens: 100, outputTokens: 20 }
    })]);

    expect(result.sessions[0]?.tokenEvidence).toMatchObject({
      status: "observed",
      componentTotalTokens: 120,
      componentEvidence: {
        cacheReadTokens: "not_separately_reported",
        cacheWriteTokens: "not_separately_reported",
        componentTotalTokens: "calculated_partial",
        reportedTotalTokens: "not_reported"
      }
    });
  });

  it("excludes unsupported agents and calls without provable identity or time", () => {
    const result = extractSessionVitalsV0([
      call({ agent: "gemini-cli" }),
      call({ sessionId: undefined }),
      call({ timestamp: "1970-01-01T00:00:00.000Z" }),
      call({ callId: "valid", sessionId: "valid-session" })
    ]);

    expect(result.sessions).toHaveLength(1);
    expect(result.coverage.excludedCalls).toEqual({
      unsupportedAgent: 1,
      missingSessionIdentity: 1,
      invalidTimestamp: 1
    });
  });

  it("omits conflicting or path-shaped project metadata and invalid runway windows", () => {
    const result = extractSessionVitalsV0([
      call({
        callId: "one",
        project: "/workspace/private/project",
        rateLimits: {
          observedAt: "2026-08-15T12:00:00.000Z",
          windows: [{
            kind: "weekly",
            name: "weekly",
            usedPercent: 101,
            windowMinutes: 10_080,
            resetsAt: "2026-08-18T12:00:00.000Z"
          }]
        }
      }),
      call({
        callId: "two",
        timestamp: "2026-08-15T12:01:00.000Z",
        project: "other-project"
      })
    ]);

    expect(result.sessions[0]).not.toHaveProperty("project");
    expect(result.sessions[0]).not.toHaveProperty("rateLimits");
    expect(JSON.stringify(result)).not.toContain("/workspace/private/project");
  });

  it("fails closed on invalid numeric evidence instead of emitting a partial zero", () => {
    const invalid = call({
      usage: { inputTokens: -1, outputTokens: 10 }
    });
    const result = extractSessionVitalsV0([invalid]);

    expect(result.sessions[0]!.tokenEvidence).toEqual({
      status: "missing",
      reason: "invalid_token_evidence"
    });

    const overflow = extractSessionVitalsV0([
      call({ usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } }),
      call({
        callId: "overflow-2",
        timestamp: "2026-08-15T12:01:00.000Z",
        usage: { inputTokens: 1, outputTokens: 0 }
      })
    ]);
    expect(overflow.sessions[0]!.tokenEvidence).toEqual({
      status: "missing",
      reason: "invalid_token_evidence"
    });
  });

  it("retains only consistent coarse work type and path-free source versions", () => {
    const result = extractSessionVitalsV0([
      call({
        sourceVersion: "claude-code/unsafe/path",
        activity: {
          summary: "private raw text",
          kind: "task",
          action: "researching",
          source: "user_prompts",
          promptCount: 1,
          toolCallCount: 2,
          files: ["secret.md"],
          isSubagent: true,
          parentSessionId: "raw-parent-id"
        }
      })
    ]);

    expect(result.sessions[0]).toMatchObject({
      sessionType: "subagent",
      sourceVersions: [],
      activity: {
        kind: "task",
        action: "researching",
        promptCount: 1,
        toolCallCount: 2
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private raw text");
    expect(serialized).not.toContain("secret.md");
    expect(serialized).not.toContain("raw-parent-id");
    expect(serialized).not.toContain("unsafe/path");
  });

  it("keeps partial host-version evidence missing instead of claiming an exact match", () => {
    const result = extractSessionVitalsV0([
      call({ callId: "versioned", sourceVersion: "2.1.170" }),
      call({
        callId: "unversioned",
        timestamp: "2026-08-15T12:01:00.000Z",
        sourceVersion: undefined
      })
    ]);

    expect(result.sessions[0]?.sourceVersions).toEqual([]);
  });

  it("preserves explicit completed-work evidence and fails closed on inconsistent markers", () => {
    const observedAt = "2026-08-15T12:00:01.000Z";
    const completed = extractSessionVitalsV0([call({
      completion: {
        status: "completed",
        evidence: "claude_turn_duration",
        observedAt
      }
    })]);
    expect(completed.sessions[0]?.completion).toEqual({
      status: "completed",
      evidence: "claude_turn_duration",
      observedAt
    });

    const absent = extractSessionVitalsV0([call()]);
    expect(absent.sessions[0]?.completion).toEqual({
      status: "missing",
      evidence: "missing",
      reason: "completion_marker_not_observed"
    });

    const inconsistent = extractSessionVitalsV0([
      call({
        callId: "completion-1",
        completion: {
          status: "completed",
          evidence: "claude_turn_duration",
          observedAt: "2026-08-15T12:05:01.000Z"
        }
      }),
      call({
        callId: "completion-2",
        timestamp: "2026-08-15T12:05:00.000Z"
      })
    ]);
    expect(inconsistent.sessions[0]?.completion).toEqual({
      status: "missing",
      evidence: "missing",
      reason: "inconsistent_completion_evidence"
    });
  });

  it("splits shared-sessionId subagent transcripts into their own truthful session rows", () => {
    // Claude Code writes the parent's sessionId on every subagent transcript
    // line. Truth rule: one transcript-run identity (sessionId + subagentId)
    // is one session row — merging them would emit a session shape no real
    // task has (mixed models, mixed subagent flags, conflicting completion
    // markers) and permanently block cohort comparability.
    const completionAt = "2026-08-15T12:10:00.000Z";
    const parentCompletion = {
      status: "completed" as const,
      evidence: "claude_turn_duration" as const,
      observedAt: completionAt
    };
    const parentActivity = {
      summary: "Fixing checkout flow",
      kind: "task" as const,
      action: "fixing" as const,
      source: "user_prompts" as const,
      promptCount: 2,
      toolCallCount: 3,
      files: [],
      isSubagent: false
    };
    const subagentActivity = {
      ...parentActivity,
      promptCount: 1,
      toolCallCount: 1,
      isSubagent: true
    };
    const calls = [
      call({
        callId: "parent-1",
        sessionId: "shared-host-session",
        usage: { inputTokens: 100, outputTokens: 10 },
        activity: parentActivity,
        completion: parentCompletion
      }),
      call({
        callId: "parent-2",
        sessionId: "shared-host-session",
        timestamp: "2026-08-15T12:05:00.000Z",
        usage: { inputTokens: 200, outputTokens: 20 },
        activity: parentActivity,
        completion: parentCompletion,
        subagentCompletions: [
          { subagentId: "raw-subagent-alpha", observedAt: "2026-08-15T12:04:00.000Z" },
          { subagentId: "raw-subagent-beta", observedAt: "2026-08-15T12:06:00.000Z" }
        ]
      }),
      call({
        callId: "alpha-1",
        sessionId: "shared-host-session",
        subagentId: "raw-subagent-alpha",
        model: "claude-opus-5",
        timestamp: "2026-08-15T12:01:00.000Z",
        usage: { inputTokens: 400, outputTokens: 40 },
        activity: subagentActivity
      }),
      call({
        callId: "alpha-2",
        sessionId: "shared-host-session",
        subagentId: "raw-subagent-alpha",
        model: "claude-opus-5",
        timestamp: "2026-08-15T12:03:00.000Z",
        usage: { inputTokens: 800, outputTokens: 80 },
        activity: subagentActivity
      }),
      call({
        callId: "beta-1",
        sessionId: "shared-host-session",
        subagentId: "raw-subagent-beta",
        timestamp: "2026-08-15T12:02:00.000Z",
        usage: { inputTokens: 50, outputTokens: 5 },
        activity: subagentActivity
      })
    ];

    const result = extractSessionVitalsV0(calls);
    expect(result.sessions).toHaveLength(3);

    const parent = result.sessions.find((session) => session.sessionType === "parent")!;
    const subagents = result.sessions.filter((session) => session.sessionType === "subagent");
    expect(subagents).toHaveLength(2);
    expect(parent.parentSessionRef).toBeUndefined();
    expect(parent.completion).toEqual(parentCompletion);
    expect(parent.tokenEvidence).toMatchObject({ inputTokens: 300, outputTokens: 30 });

    const alpha = subagents.find((session) => session.models[0] === "claude-opus-5")!;
    const beta = subagents.find((session) => session !== alpha)!;
    expect(alpha.tokenEvidence).toMatchObject({ inputTokens: 1_200, outputTokens: 120 });
    expect(alpha.completion).toEqual({
      status: "completed",
      evidence: "claude_task_result",
      observedAt: "2026-08-15T12:04:00.000Z"
    });
    expect(beta.completion).toEqual({
      status: "completed",
      evidence: "claude_task_result",
      observedAt: "2026-08-15T12:06:00.000Z"
    });
    for (const subagent of subagents) {
      expect(subagent.parentSessionRef).toBe(parent.sessionRef);
      expect(subagent.sessionRef).toMatch(/^avref_[a-f0-9]{64}$/);
    }
    expect(new Set(result.sessions.map((session) => session.sessionRef)).size).toBe(3);

    // Financial surface pin: the split moves token totals between rows but
    // never drops any — the sum across rows equals the sum across all calls.
    // (Financial parsing itself never groups by vitals rows and is untouched.)
    const observedTotals = result.sessions.map((session) =>
      session.tokenEvidence.status === "observed"
        ? session.tokenEvidence.inputTokens + session.tokenEvidence.outputTokens
        : 0
    );
    expect(observedTotals.reduce((sum, value) => sum + value, 0)).toBe(
      calls.reduce((sum, item) => sum + item.usage.inputTokens + item.usage.outputTokens, 0)
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("shared-host-session");
    expect(serialized).not.toContain("raw-subagent-alpha");
    expect(serialized).not.toContain("raw-subagent-beta");
  });

  it("keeps subagent rows fail-closed without or against host completion evidence", () => {
    const subagentActivity = {
      summary: "Fixing checkout flow",
      kind: "agent" as const,
      action: "fixing" as const,
      source: "user_prompts" as const,
      promptCount: 1,
      toolCallCount: 1,
      files: [],
      isSubagent: true
    };
    const unproven = extractSessionVitalsV0([
      call({ subagentId: "run-a", activity: subagentActivity })
    ]);
    expect(unproven.sessions[0]?.completion).toEqual({
      status: "missing",
      evidence: "missing",
      reason: "completion_marker_not_observed"
    });

    // A host completion older than the run's last observed activity
    // contradicts itself and must not read as a completed snapshot.
    const contradicted = extractSessionVitalsV0([
      call({ subagentId: "run-a", activity: subagentActivity }),
      call({
        callId: "owner-1",
        timestamp: "2026-08-15T12:05:00.000Z",
        subagentCompletions: [
          { subagentId: "run-a", observedAt: "2026-08-15T11:59:00.000Z" }
        ]
      })
    ]);
    const subagentRow = contradicted.sessions.find(
      (session) => session.sessionType === "subagent"
    );
    expect(subagentRow?.completion).toEqual({
      status: "missing",
      evidence: "missing",
      reason: "inconsistent_completion_evidence"
    });
  });

  it("fails closed to unknown when a subagent identity contradicts the activity flag", () => {
    const result = extractSessionVitalsV0([
      call({
        subagentId: "run-a",
        activity: {
          summary: "Fixing checkout flow",
          kind: "task",
          action: "fixing",
          source: "user_prompts",
          promptCount: 1,
          toolCallCount: 1,
          files: [],
          isSubagent: false
        }
      })
    ]);
    expect(result.sessions[0]?.sessionType).toBe("unknown");
  });

  it("keeps same-basename repositories in distinct opaque project cohorts", () => {
    const first = extractSessionVitalsV0([call({
      sessionId: "first",
      project: "app",
      workingDirectory: "/private/customer-a/app"
    })]).sessions[0]!;
    const second = extractSessionVitalsV0([call({
      sessionId: "second",
      project: "app",
      workingDirectory: "/private/customer-b/app"
    })]).sessions[0]!;

    expect(first.project).toBe("app");
    expect(second.project).toBe("app");
    expect(first.projectRef).toMatch(/^avref_/);
    expect(second.projectRef).toMatch(/^avref_/);
    expect(first.projectRef).not.toBe(second.projectRef);
    expect(JSON.stringify([first, second])).not.toContain("/private/customer");
  });
});
