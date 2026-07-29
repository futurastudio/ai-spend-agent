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
const hook = {
  kind: "hook",
  name: "fixture:SessionStart",
  scope: "user",
  group: "fixture",
  activation: "hook_injected",
  host: "codex",
  event: "SessionStart",
  invocationTracking: "not_observable",
  alwaysLoadedTokens: 0,
  weightConfidence: "unmeasured",
  path: "/fixture/hooks.json"
};
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
    name: "hook metadata without payload execution",
    expected: "review_hooks",
    input: { inventory: { items: [hook] }, invocations: invocation() }
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
      inventory: { items: [hook] },
      invocations: invocation()
    }
  }
];

const results = cases.map((fixture) => {
  const output = buildContextHealth({ ...fixture.input, now });
  const safety = {
    hookPayloadNotInferred: output.provenance.hookPayload === "not_executed_or_inferred",
    uploadedFalse: output.provenance.uploaded === false,
    noSavingsClaim: !("estimatedSavings" in output) && !("savedTokens" in output)
  };
  return {
    name: fixture.name,
    expected: fixture.expected,
    actual: output.recommendation,
    decisionPass: output.recommendation === fixture.expected,
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
