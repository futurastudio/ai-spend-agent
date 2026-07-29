import { describe, expect, it } from "vitest";
import { buildUsageGlance } from "./glance.js";
import type { LocalAgentActivity, LocalAgentCall } from "./localAgentLogs.js";

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0
});

const activity = (
  summary: string,
  promptCount: number,
  toolCallCount: number,
  overrides: Partial<LocalAgentActivity> = {}
): LocalAgentActivity => ({
  summary,
  kind: "task",
  action: "refining",
  source: "user_prompts",
  promptCount,
  toolCallCount,
  files: [],
  isSubagent: false,
  ...overrides
});

describe("buildUsageGlance", () => {
  it("prioritizes the latest session, reported limits, main focus, and one anomaly", () => {
    const calls: LocalAgentCall[] = [
      {
        agent: "claude-code",
        sessionId: "older-1",
        project: "small-app",
        model: "claude-opus-4-8",
        timestamp: "2026-07-27T15:05:00.000Z",
        startedAt: "2026-07-27T15:00:00.000Z",
        usage: usage(100_000, 10_000),
        activity: activity("Auditing landing page", 1, 1, {
          action: "auditing",
          files: ["page.tsx"]
        })
      },
      {
        agent: "claude-code",
        sessionId: "older-2",
        project: "small-app",
        model: "claude-opus-4-8",
        timestamp: "2026-07-27T16:05:00.000Z",
        startedAt: "2026-07-27T16:00:00.000Z",
        usage: usage(120_000, 12_000),
        activity: activity("Auditing landing page", 1, 1, {
          action: "auditing",
          files: ["page.tsx"]
        })
      },
      {
        agent: "claude-code",
        sessionId: "current",
        project: "agent-finops",
        model: "claude-opus-4-8",
        timestamp: "2026-07-28T17:52:00.000Z",
        startedAt: "2026-07-28T17:10:00.000Z",
        usage: usage(600_000, 60_000),
        activity: activity("Refining Glance hover UI", 6, 8, {
          files: ["GlanceView.swift"]
        })
      },
      {
        agent: "codex",
        sessionId: "codex-1",
        project: "agent-finops",
        model: "gpt-5.1-codex",
        timestamp: "2026-07-28T17:45:00.000Z",
        startedAt: "2026-07-28T17:30:00.000Z",
        usage: usage(50_000, 5_000),
        activity: activity("Refining Glance hover UI", 3, 4, {
          files: ["UsageGlance.tsx"]
        }),
        rateLimits: {
          observedAt: "2026-07-28T17:45:00.000Z",
          limitId: "codex",
          planType: "pro",
          windows: [
            {
              kind: "five-hour",
              name: "five-hour",
              usedPercent: 71,
              windowMinutes: 300,
              resetsAt: "2026-07-28T20:00:00.000Z"
            },
            {
              kind: "weekly",
              name: "weekly",
              usedPercent: 43,
              windowMinutes: 10_080,
              resetsAt: "2026-08-03T00:00:00.000Z"
            }
          ]
        }
      }
    ];

    const snapshot = buildUsageGlance(calls, {
      now: new Date("2026-07-28T18:00:00.000Z"),
      filesParsed: 4,
      detectedPlans: [{
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        source: "/local/claude/config"
      }]
    });

    expect(snapshot.currentSession).toMatchObject({
      status: "active",
      agent: "claude-code",
      project: "agent-finops",
      model: "claude-opus-4-8",
      durationMinutes: 42,
      costConfidence: "estimated"
    });
    expect(snapshot.sessionHealth.generatedAt).toBe(snapshot.generatedAt);
    expect(snapshot.currentSession?.apiEquivalentUsd).toBeGreaterThan(0);
    expect(snapshot.provenance).toEqual({
      session: {
        source: "local_transcript_metadata",
        agents: ["claude-code"],
        filesParsed: 4
      },
      sessionValue: {
        source: "local_calculation",
        basis: "transcript_tokens_at_public_api_rates",
        confidence: "estimated",
        pricingAsOf: "2026-07-28"
      },
      plan: {
        source: "local_agent_account_metadata",
        agent: "claude-code"
      },
      limits: {
        source: "transcript_reported",
        agents: ["codex"],
        windows: ["five-hour", "weekly"],
        projection: "local_pace_estimate"
      },
      focus: {
        source: "local_prompt_and_tool_activity",
        agents: ["claude-code", "codex"],
        rawPromptTextReturned: false
      },
      anomaly: {
        source: "local_session_history",
        comparison: "same_agent_session_median"
      },
      contextHealth: {
        source: "canonical_context_health_contract",
        hookPayload: "not_executed_or_inferred"
      },
      network: {
        uploaded: false
      }
    });
    expect(snapshot.plan).toEqual({
      agent: "claude-code",
      planId: "claude-max-5x",
      planLabel: "Claude Max 5x",
      billing: "subscription",
      monthlyUsd: 100,
      priceConfidence: "published_list",
      source: "locally_detected"
    });
    expect(snapshot.limits).toHaveLength(2);
    expect(snapshot.limits[0]).toMatchObject({
      agent: "codex",
      kind: "five-hour",
      usedPercent: 71,
      remainingPercent: 29,
      resetsAt: "2026-07-28T20:00:00.000Z",
      source: "transcript_reported",
      projectionConfidence: "estimated"
    });
    expect(snapshot.limits[0]!.projectedToExhaustBeforeReset).toBe(true);
    expect(snapshot.focus).toMatchObject({
      windowDays: 7,
      summary: "Refining Glance hover UI",
      kind: "task",
      project: "agent-finops",
      file: "GlanceView.swift",
      agents: ["claude-code", "codex"],
      sessions: 2,
      measure: "observed_prompt_and_tool_activity",
      confidence: "high"
    });
    expect(snapshot.focus!.activitySharePercent).toBeGreaterThan(70);
    expect(snapshot.anomaly).toMatchObject({
      kind: "session_tokens",
      summary: expect.stringContaining("same-agent token median"),
      confidence: "derived"
    });
    expect(snapshot.anomaly!.ratioToMedian).toBeGreaterThan(1.5);
    expect(snapshot.coverage).toEqual(expect.objectContaining({
      filesParsed: 4,
      supportedTranscriptAgents: ["claude-code", "codex"],
      detectedAgents: ["claude-code", "codex"],
      providerConnectionRequired: ["cursor", "github-copilot"]
    }));
  });

  it("never invents plan headroom or spend when transcripts do not report enough data", () => {
    const snapshot = buildUsageGlance([{
      agent: "claude-code",
      sessionId: "unknown-model",
      project: "private-project",
      model: "unknown-local-model",
      timestamp: "2026-07-28T17:55:00.000Z",
      usage: usage(10_000, 1_000)
    }], {
      now: new Date("2026-07-28T18:00:00.000Z")
    });

    expect(snapshot.currentSession).toMatchObject({
      project: "private-project",
      apiEquivalentUsd: null,
      costConfidence: "missing"
    });
    expect(snapshot.plan).toBeNull();
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.focus).toEqual(expect.objectContaining({
      summary: "Working in private-project",
      kind: "project",
      project: "private-project",
      confidence: "low"
    }));
    expect(snapshot.anomaly).toBeNull();
    expect(snapshot.provenance).toMatchObject({
      sessionValue: {
        confidence: "missing"
      },
      plan: {
        source: "not_available"
      },
      limits: {
        source: "not_available",
        windows: []
      },
      anomaly: {
        source: "not_available"
      },
      contextHealth: {
        source: "canonical_context_health_contract"
      },
      network: {
        uploaded: false
      }
    });
    expect(snapshot.coverage.rateLimitMetadata).toEqual([
      {
        agent: "claude-code",
        status: "not_reported_by_transcript",
        windowsReported: []
      },
      {
        agent: "codex",
        status: "not_seen",
        windowsReported: []
      }
    ]);
  });

  it("keeps account limit metadata when project-scoped usage is passed separately", () => {
    const projectCall: LocalAgentCall = {
      agent: "claude-code",
      sessionId: "project",
      project: "agent-finops",
      model: "claude-sonnet-4-6",
      timestamp: "2026-07-28T17:55:00.000Z",
      usage: usage(10_000, 1_000)
    };
    const accountLimitCall: LocalAgentCall = {
      agent: "codex",
      sessionId: "other",
      project: "another-project",
      model: "gpt-5.1-codex",
      timestamp: "2026-07-28T17:50:00.000Z",
      usage: usage(10_000, 1_000),
      rateLimits: {
        observedAt: "2026-07-28T17:50:00.000Z",
        windows: [{
          kind: "weekly",
          name: "weekly",
          usedPercent: 9,
          windowMinutes: 10_080,
          resetsAt: "2026-08-04T00:00:00.000Z"
        }, {
          kind: "custom",
          name: "expired-window",
          usedPercent: 99,
          windowMinutes: 60,
          resetsAt: "2026-07-28T17:59:00.000Z"
        }]
      }
    };

    const snapshot = buildUsageGlance([projectCall], {
      now: new Date("2026-07-28T18:00:00.000Z"),
      limitCalls: [projectCall, accountLimitCall]
    });

    expect(snapshot.currentSession?.project).toBe("agent-finops");
    expect(snapshot.limits).toEqual([
      expect.objectContaining({
        agent: "codex",
        kind: "weekly",
        remainingPercent: 91
      })
    ]);
  });
});
