import { describe, expect, it } from "vitest";
import {
  buildContextHealth,
  type ContextHealthResult
} from "./contextHealth.js";
import type { InventoryItem } from "./agentInventory.js";
import type { LocalAgentCall } from "./localAgentLogs.js";
import type { InvocationSummary } from "./toolInvocations.js";

const usage = (tokens: number) => ({
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0
});

function call(
  sessionId: string,
  timestamp: string,
  tokens: number
): LocalAgentCall {
  return {
    agent: "codex",
    sessionId,
    project: "agent-finops",
    model: "gpt-5.6-codex",
    timestamp,
    usage: usage(tokens)
  };
}

function invocationSummary(partial: Partial<InvocationSummary> = {}): InvocationSummary {
  return {
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
  };
}

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, "kind" | "name">): InventoryItem {
  return {
    scope: "user",
    activation: "discoverable",
    invocationTracking: partial.kind === "hook" ? "not_observable" : "observable",
    alwaysLoadedTokens: 20,
    weightConfidence: "estimated",
    ...partial
  };
}

describe("buildContextHealth", () => {
  it("recommends a fresh session from same-agent transcript tokens", () => {
    const health = buildContextHealth({
      now: new Date("2026-07-29T12:00:00.000Z"),
      calls: [
        call("old-1", "2026-07-28T10:00:00.000Z", 100),
        call("old-2", "2026-07-28T11:00:00.000Z", 120),
        call("old-3", "2026-07-28T12:00:00.000Z", 110),
        call("current", "2026-07-29T11:55:00.000Z", 330)
      ]
    });

    expect(health).toMatchObject({
      schemaVersion: 1,
      status: "start_fresh",
      recommendation: "start_fresh",
      confidence: "high",
      currentSession: {
        status: "active",
        agent: "codex",
        project: "agent-finops",
        totalTokens: 330,
        ratioToMedian: 3,
        comparisonSessions: 3
      },
      provenance: {
        uploaded: false,
        hookPayload: "not_executed_or_inferred"
      }
    });
  });

  it("detects hook-injected context but never assigns its payload tokens", () => {
    const items: InventoryItem[] = [
      item({
        kind: "hook",
        name: "ponytail:SessionStart",
        group: "ponytail",
        activation: "hook_injected",
        host: "claude-code",
        event: "SessionStart",
        path: "/plugins/ponytail/hooks/hooks.json",
        alwaysLoadedTokens: 0,
        weightConfidence: "unmeasured"
      }),
      item({
        kind: "hook",
        name: "security:PreToolUse",
        group: "security",
        activation: "lifecycle_hook",
        host: "claude-code",
        event: "PreToolUse",
        alwaysLoadedTokens: 0,
        weightConfidence: "unmeasured"
      })
    ];

    const health = buildContextHealth({
      inventory: { items },
      invocations: invocationSummary()
    });

    expect(health.status).toBe("watch");
    expect(health.recommendation).toBe("review_hooks");
    expect(health.activation).toEqual({
      discoverableItems: 0,
      explicitlyInvokedItems: 0,
      hookInjectedItems: 1,
      lifecycleHooks: 1,
      mcpSchemaLoadedItems: 0,
      unmeasuredItems: 2,
      invocationUnobservableItems: 0
    });
    expect(health.deadContext.loadedItems).toBe(0);
    expect(health.evidence[0]).toMatchObject({
      kind: "hook_config",
      confidence: "unmeasured"
    });
  });

  it("counts discoverable, invoked, and schema-loaded states separately", () => {
    const items: InventoryItem[] = [
      item({ kind: "skill", name: "used-skill" }),
      item({ kind: "skill", name: "unused-skill" }),
      item({
        kind: "mcp_server",
        name: "github",
        activation: "mcp_schema_loaded",
        alwaysLoadedTokens: 700,
        weightConfidence: "estimated_understated"
      })
    ];
    const invocations = invocationSummary({
      sessions: 2,
      totalAssistantTurns: 4,
      sessionTurnCounts: [2, 2],
      invokedSkills: ["used-skill"],
      invokedMcpTools: ["mcp__github__get_issue"]
    });

    const health = buildContextHealth({ inventory: { items }, invocations });

    expect(health.activation).toMatchObject({
      discoverableItems: 2,
      explicitlyInvokedItems: 2,
      hookInjectedItems: 0,
      mcpSchemaLoadedItems: 1
    });
    expect(health.recommendation).toBe("trim_dead_context");
    expect(health.deadContext.neverInvokedItems).toBe(1);
  });

  it("does not call a Codex skill dead when invocation is not transcript-observable", () => {
    const codexSkill = item({
      kind: "skill",
      name: "plugin-skill",
      host: "codex",
      invocationTracking: "not_observable"
    });
    const health = buildContextHealth({
      inventory: { items: [codexSkill] },
      invocations: invocationSummary({
        sessions: 3,
        totalAssistantTurns: 9,
        sessionTurnCounts: [3, 3, 3]
      })
    });

    expect(health.activation.invocationUnobservableItems).toBe(1);
    expect(health.deadContext).toMatchObject({
      loadedItems: 0,
      neverInvokedItems: 0
    });
    expect(health.recommendation).toBe("collect_more_history");
  });

  it("has a stable adapter-ready contract shape", () => {
    const health: ContextHealthResult = buildContextHealth();
    expect(Object.keys(health).sort()).toEqual([
      "action",
      "activation",
      "caveats",
      "confidence",
      "currentSession",
      "deadContext",
      "evidence",
      "generatedAt",
      "headline",
      "provenance",
      "recommendation",
      "schemaVersion",
      "status"
    ]);
  });
});
