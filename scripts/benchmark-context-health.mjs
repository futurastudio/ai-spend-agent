#!/usr/bin/env node
import {
  buildContextHealth
} from "../packages/core/dist/index.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const invocation = (partial = {}) => ({
  invocations: [],
  invokedMcpTools: [],
  invokedSkills: [],
  invokedSubagents: [],
  invokedCommands: [],
  sessions: 0,
  totalAssistantTurns: 0,
  sessionTurnCounts: [],
  sourceSessions: { claudeCode: 0, codex: 0 },
  ...partial
});
const call = (sessionId, hour, tokens) => ({
  agent: "codex",
  sessionId,
  project: "benchmark",
  model: "gpt-5.6-codex",
  timestamp: `2026-07-${hour < 20 ? "28" : "29"}T${String(hour % 20).padStart(2, "0")}:00:00.000Z`,
  usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0 }
});
const hook = (event, activation = "hook_injected") => ({
  kind: "hook",
  name: `ponytail:${event}`,
  scope: "user",
  group: "ponytail",
  activation,
  host: "claude-code",
  event,
  invocationTracking: "not_observable",
  alwaysLoadedTokens: 0,
  weightConfidence: "unmeasured",
  path: "/fixture/ponytail/hooks.json"
});
const deadSkill = {
  kind: "skill",
  name: "unused",
  scope: "user",
  activation: "discoverable",
  alwaysLoadedTokens: 20,
  invocationTracking: "observable",
  weightConfidence: "estimated",
  path: "/fixture/SKILL.md"
};
const invokedSkill = {
  ...deadSkill,
  name: "used",
  path: "/fixture/used/SKILL.md"
};
const history = [
  call("old-1", 10, 100),
  call("old-2", 11, 110),
  call("old-3", 12, 120)
];
const cases = [
  {
    name: "no evidence",
    expected: "collect_more_history",
    input: {}
  },
  {
    name: "ordinary session",
    expected: "continue",
    input: { calls: [...history, call("current", 31, 115)] }
  },
  {
    name: "large same-agent session",
    expected: "start_fresh",
    input: { calls: [...history, call("current", 31, 330)] }
  },
  {
    name: "normal explicitly invoked skill",
    expected: "continue",
    input: {
      calls: [...history, call("current", 31, 115)],
      inventory: { items: [invokedSkill] },
      invocations: invocation({
        invokedSkills: ["used"],
        sessions: 1,
        totalAssistantTurns: 1,
        sessionTurnCounts: [1]
      })
    }
  },
  {
    name: "Ponytail SessionStart hook metadata without payload execution",
    expected: "review_hooks",
    expectedEvidence: "hook_config",
    input: { inventory: { items: [hook("SessionStart")] }, invocations: invocation() }
  },
  {
    name: "Ponytail UserPromptSubmit hook metadata without payload execution",
    expected: "review_hooks",
    expectedEvidence: "hook_config",
    input: { inventory: { items: [hook("UserPromptSubmit")] }, invocations: invocation() }
  },
  {
    name: "Ponytail SubagentStart hook metadata without payload execution",
    expected: "review_hooks",
    expectedEvidence: "hook_config",
    input: { inventory: { items: [hook("SubagentStart")] }, invocations: invocation() }
  },
  {
    name: "Ponytail lifecycle-only PreCompact hook",
    expected: "collect_more_history",
    input: {
      inventory: { items: [hook("PreCompact", "lifecycle_hook")] },
      invocations: invocation()
    }
  },
  {
    name: "current session has two explicit compactions",
    expected: "start_fresh",
    expectedEvidence: "context_churn",
    input: {
      calls: [...history, call("current", 31, 115)],
      invocations: invocation({
        sessionSignals: [{
          agent: "codex",
          sessionId: "current",
          compactionEvents: 2,
          fileReads: [],
          repeatedFileReads: [],
          isSubagent: false,
          readCoverage: "explicit_read_tools_only"
        }]
      })
    }
  },
  {
    name: "explicit repeated reads are evidence but not a standalone restart rule",
    expected: "continue",
    expectedEvidence: "context_churn",
    input: {
      calls: [...history, call("current", 31, 115)],
      invocations: invocation({
        sessionSignals: [{
          agent: "codex",
          sessionId: "current",
          compactionEvents: 0,
          fileReads: [{ name: "roadmap.md", count: 3 }],
          repeatedFileReads: [{ name: "roadmap.md", count: 3 }],
          isSubagent: false,
          readCoverage: "explicit_read_tools_only"
        }]
      })
    }
  },
  {
    name: "parent and subagent transcript evidence stays separated",
    expected: "continue",
    expectedScope: "parent",
    expectedParentSessions: 1,
    expectedSubagentSessions: 1,
    input: {
      calls: [...history, call("current", 31, 115)],
      invocations: invocation({
        sessionSignals: [
          {
            agent: "codex",
            sessionId: "current",
            compactionEvents: 0,
            fileReads: [],
            repeatedFileReads: [],
            isSubagent: false,
            readCoverage: "explicit_read_tools_only"
          },
          {
            agent: "claude-code",
            sessionId: "child",
            compactionEvents: 0,
            fileReads: [],
            repeatedFileReads: [],
            isSubagent: true,
            parentSessionId: "parent",
            readCoverage: "explicit_read_tools_only"
          }
        ]
      })
    }
  },
  {
    name: "never-invoked discoverable item",
    expected: "trim_dead_context",
    input: {
      inventory: { items: [deadSkill] },
      invocations: invocation({
        sessions: 2,
        totalAssistantTurns: 4,
        sessionTurnCounts: [2, 2]
      })
    }
  },
  {
    name: "session decision outranks hook review",
    expected: "start_fresh",
    input: {
      calls: [...history, call("current", 31, 330)],
      inventory: { items: [hook("SessionStart")] },
      invocations: invocation()
    }
  }
];

const results = cases.map((fixture) => {
  const output = buildContextHealth({ ...fixture.input, now });
  const safety = {
    hookPayloadNotInferred: output.provenance.hookPayload === "not_executed_or_inferred",
    uploadedFalse: output.provenance.uploaded === false,
    noSavingsClaim: !("estimatedSavings" in output) && !("savedTokens" in output),
    noRawPath: !JSON.stringify(output).includes("/private/")
  };
  const fixtureChecks = {
    evidence: !fixture.expectedEvidence ||
      output.evidence.some((evidence) => evidence.kind === fixture.expectedEvidence),
    scope: !fixture.expectedScope ||
      output.contextChurn.currentSessionScope === fixture.expectedScope,
    parentSessions: fixture.expectedParentSessions === undefined ||
      output.contextChurn.observedParentSessions === fixture.expectedParentSessions,
    subagentSessions: fixture.expectedSubagentSessions === undefined ||
      output.contextChurn.observedSubagentSessions === fixture.expectedSubagentSessions
  };
  return {
    name: fixture.name,
    expected: fixture.expected,
    actual: output.recommendation,
    decisionPass: output.recommendation === fixture.expected &&
      Object.values(fixtureChecks).every(Boolean),
    fixtureChecks,
    safety,
    safetyPass: Object.values(safety).every(Boolean)
  };
});
const passed = results.filter((result) => result.decisionPass && result.safetyPass).length;
const report = {
  benchmark: "context-health-fixtures",
  generatedAt: now.toISOString(),
  cases: results.length,
  passed,
  failed: results.length - passed,
  results
};

console.log(JSON.stringify(report, null, 2));
if (passed !== results.length) process.exitCode = 1;
