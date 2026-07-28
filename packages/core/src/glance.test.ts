import { describe, expect, it } from "vitest";
import { buildUsageGlance } from "./glance.js";
import type { LocalAgentCall } from "./localAgentLogs.js";

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0
});

describe("buildUsageGlance", () => {
  it("prioritizes the latest session, reported limits, heaviest work, and one anomaly", () => {
    const calls: LocalAgentCall[] = [
      {
        agent: "claude-code",
        sessionId: "older-1",
        project: "small-app",
        model: "claude-opus-4-8",
        timestamp: "2026-07-27T15:05:00.000Z",
        startedAt: "2026-07-27T15:00:00.000Z",
        usage: usage(100_000, 10_000)
      },
      {
        agent: "claude-code",
        sessionId: "older-2",
        project: "small-app",
        model: "claude-opus-4-8",
        timestamp: "2026-07-27T16:05:00.000Z",
        startedAt: "2026-07-27T16:00:00.000Z",
        usage: usage(120_000, 12_000)
      },
      {
        agent: "claude-code",
        sessionId: "current",
        project: "agent-finops",
        model: "claude-opus-4-8",
        timestamp: "2026-07-28T17:52:00.000Z",
        startedAt: "2026-07-28T17:10:00.000Z",
        usage: usage(600_000, 60_000)
      },
      {
        agent: "codex",
        sessionId: "codex-1",
        project: "agent-finops",
        model: "gpt-5.1-codex",
        timestamp: "2026-07-28T17:45:00.000Z",
        startedAt: "2026-07-28T17:30:00.000Z",
        usage: usage(50_000, 5_000),
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
      filesParsed: 4
    });

    expect(snapshot.currentSession).toMatchObject({
      status: "active",
      agent: "claude-code",
      project: "agent-finops",
      model: "claude-opus-4-8",
      durationMinutes: 42,
      costConfidence: "estimated"
    });
    expect(snapshot.currentSession?.apiEquivalentUsd).toBeGreaterThan(0);
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
    expect(snapshot.heaviest.projectModel).toMatchObject({
      project: "agent-finops",
      model: "claude-opus-4-8",
      costConfidence: "estimated"
    });
    expect(snapshot.anomaly).toMatchObject({
      kind: "session_spend",
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
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.heaviest.project).toBeNull();
    expect(snapshot.anomaly).toBeNull();
    expect(snapshot.coverage.rateLimitMetadata).toEqual([
      { agent: "claude-code", status: "not_reported_by_transcript" },
      { agent: "codex", status: "not_seen" }
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
