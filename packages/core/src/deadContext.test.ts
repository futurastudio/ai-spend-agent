import { describe, expect, it } from "vitest";
import { computeDeadContext, deadContextCutAction, sampleDeadContext } from "./deadContext.js";
import type { InventoryItem } from "./agentInventory.js";
import type { HostInvocationEvidence, InvocationSummary } from "./toolInvocations.js";

function item(partial: Partial<InventoryItem> & Pick<InventoryItem, "kind" | "name">): InventoryItem {
  return {
    scope: "user",
    activation: partial.kind === "mcp_server" || partial.kind === "mcp_tool"
      ? "mcp_configured"
      : partial.kind === "hook"
        ? "hook_injected"
        : "discoverable",
    invocationTracking: "observable",
    alwaysLoadedTokens: 100,
    weightConfidence: "estimated",
    ...partial
  };
}

function invocations(partial: Partial<InvocationSummary>): InvocationSummary {
  return {
    invocations: [],
    invokedMcpTools: [],
    invokedSkills: [],
    invokedSubagents: [],
    invokedCommands: [],
    sessions: 1,
    totalAssistantTurns: 1,
    sessionTurnCounts: [1],
    ...partial
  };
}

function hostEvidence(
  partial: Partial<HostInvocationEvidence> = {}
): HostInvocationEvidence {
  return {
    sessions: 0,
    totalAssistantTurns: 0,
    sessionTurnCounts: [],
    invokedMcpTools: [],
    invokedSkills: [],
    invokedSubagents: [],
    invokedCommands: [],
    ...partial
  };
}

describe("computeDeadContext", () => {
  const config = { windowDays: 30, pricingModel: "claude-sonnet-4" };

  it("counts every dead kind, but prices ONLY measured-weight items (not MCP)", () => {
    const items: InventoryItem[] = [
      item({ kind: "skill", name: "deep-research", alwaysLoadedTokens: 40 }),
      item({ kind: "skill", name: "unused-skill", alwaysLoadedTokens: 60 }),
      item({ kind: "subagent", name: "Explore", alwaysLoadedTokens: 80 }),
      item({ kind: "command", name: "ship", alwaysLoadedTokens: 30 }),
      item({ kind: "mcp_tool", name: "mcp__github__create_issue", alwaysLoadedTokens: 500 }),
      // MCP server: config proves availability, not payload loading → counted, never priced.
      item({ kind: "mcp_server", name: "supabase", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" })
    ];
    const inv = invocations({
      invokedSkills: ["deep-research"],
      invokedSubagents: ["Explore"],
      invokedMcpTools: ["mcp__github__create_issue"],
      sessions: 2,
      totalAssistantTurns: 10,
      sessionTurnCounts: [4, 6]
    });

    const result = computeDeadContext(items, inv, config);

    expect(result.loadedCount).toBe(6);
    // dead: unused-skill (measured), ship (measured), supabase (unmeasured MCP)
    expect(result.deadCount).toBe(3);
    expect(result.measuredDeadCount).toBe(2);
    expect(result.unmeasuredDeadCount).toBe(1);
    // deadTokens / monthly figures exclude the MCP server (unmeasured).
    expect(result.deadTokens).toBe(60 + 30);
    expect(result.monthlyDeadTokens).toBe((60 + 30) * 10);
    expect(result.wastePercent).toBeCloseTo(3 / 6);
    expect(result.hasData).toBe(true);
  });

  it("counts MCP-only waste but assigns it NO dollars/tokens", () => {
    const items = [
      item({ kind: "mcp_server", name: "context7", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" }),
      item({ kind: "mcp_server", name: "framer", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" })
    ];
    const inv = invocations({ sessions: 5, totalAssistantTurns: 200, sessionTurnCounts: [40, 40, 40, 40, 40] });
    const result = computeDeadContext(items, inv, config);
    expect(result.deadCount).toBe(2);
    expect(result.unmeasuredDeadCount).toBe(2);
    expect(result.measuredDeadCount).toBe(0);
    expect(result.monthlyDeadTokens).toBe(0);
    expect(result.monthlyUsd).toBe(0); // never fabricate a $ for MCP
    expect(result.hasData).toBe(true); // still show the count
  });

  it("treats an MCP server as used when any of its tools was invoked", () => {
    const items = [item({ kind: "mcp_server", name: "github", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" })];
    const inv = invocations({ invokedMcpTools: ["mcp__github__create_issue"], sessions: 1, totalAssistantTurns: 3 });
    const result = computeDeadContext(items, inv, config);
    expect(result.deadCount).toBe(0);
    expect(result.hasData).toBe(false);
  });

  it("preserves host, scope, activation, and observability on not-observed candidates", () => {
    const result = computeDeadContext([
      item({
        kind: "mcp_server",
        name: "framer",
        scope: "user",
        host: "claude-code",
        activation: "mcp_configured",
        invocationTracking: "observable",
        alwaysLoadedTokens: 0,
        weightConfidence: "unmeasured",
        path: "/Users/dev/.claude.json"
      })
    ], invocations({ sessions: 2, totalAssistantTurns: 4 }), config);

    expect(result.deadItems).toEqual([
      expect.objectContaining({
        name: "framer",
        scope: "user",
        host: "claude-code",
        activation: "mcp_configured",
        invocationTracking: "observable"
      })
    ]);
  });

  it("does not use Codex-only transcripts as coverage for Claude inventory", () => {
    const result = computeDeadContext([
      item({ kind: "skill", name: "claude-only", host: "claude-code" })
    ], invocations({
      sessions: 3,
      totalAssistantTurns: 9,
      sessionTurnCounts: [3, 3, 3],
      sourceSessions: { claudeCode: 0, codex: 3 },
      byHost: {
        "claude-code": hostEvidence(),
        codex: hostEvidence({
          sessions: 3,
          totalAssistantTurns: 9,
          sessionTurnCounts: [3, 3, 3]
        })
      }
    }), config);

    expect(result).toMatchObject({
      hasData: false,
      loadedCount: 0,
      deadCount: 0,
      monthlyDeadTokens: 0,
      monthlyUsd: 0
    });
  });

  it("matches and prices inventory only against evidence from the same host", () => {
    const result = computeDeadContext([
      item({ kind: "skill", name: "shared-name", host: "claude-code" })
    ], invocations({
      sessions: 11,
      totalAssistantTurns: 1_010,
      sessionTurnCounts: [10, ...Array.from({ length: 10 }, () => 100)],
      invokedSkills: ["shared-name"],
      sourceSessions: { claudeCode: 1, codex: 10 },
      byHost: {
        "claude-code": hostEvidence({
          sessions: 1,
          totalAssistantTurns: 10,
          sessionTurnCounts: [10]
        }),
        codex: hostEvidence({
          sessions: 10,
          totalAssistantTurns: 1_000,
          sessionTurnCounts: Array.from({ length: 10 }, () => 100),
          invokedSkills: ["shared-name"]
        })
      }
    }), config);

    expect(result.deadCount).toBe(1);
    expect(result.monthlyDeadTokens).toBe(100 * 10);
    expect(result.totalTurns).toBe(1_010);
  });

  it("excludes a multi-owner MCP scope ambiguity from action candidates", () => {
    const result = computeDeadContext([
      item({
        kind: "mcp_server",
        name: "duplicate",
        scope: "local",
        host: "claude-code",
        invocationTracking: "not_observable",
        alwaysLoadedTokens: 0,
        weightConfidence: "unmeasured",
        path: "/Users/dev/.claude.json",
        ownerDirs: ["/Users/dev/project-a", "/Users/dev/project-b"]
      })
    ], invocations({ sessions: 2, totalAssistantTurns: 4 }), config);

    expect(result).toMatchObject({
      hasData: false,
      loadedCount: 0,
      deadCount: 0,
      deadItems: []
    });
  });

  it("prices the cached measured estimate BELOW the uncached upper bound", () => {
    const items = [item({ kind: "skill", name: "dead", alwaysLoadedTokens: 5000 })];
    const inv = invocations({ sessions: 3, totalAssistantTurns: 60, sessionTurnCounts: [20, 20, 20] });
    const result = computeDeadContext(items, inv, config);
    expect(result.monthlyUsd).toBeGreaterThan(0);
    expect(result.monthlyUsdUpperBound).toBeGreaterThan(result.monthlyUsd);
  });

  it("scales the monthly projection by the window length", () => {
    const items = [item({ kind: "skill", name: "dead", alwaysLoadedTokens: 5000 })];
    const inv = invocations({ sessions: 1, totalAssistantTurns: 10, sessionTurnCounts: [10] });
    const full = computeDeadContext(items, inv, { ...config, windowDays: 30 });
    const half = computeDeadContext(items, inv, { ...config, windowDays: 15 });
    expect(half.monthlyUsd).toBeCloseTo(full.monthlyUsd * 2, 5);
  });

  it("reports no data when there are no transcripts to compare against", () => {
    const items = [item({ kind: "skill", name: "x" })];
    const result = computeDeadContext(items, invocations({ sessions: 0, totalAssistantTurns: 0, sessionTurnCounts: [] }), config);
    expect(result.hasData).toBe(false);
    expect(result.loadedCount).toBe(1);
    expect(result.deadCount).toBe(0);
    expect(result.deadItems).toEqual([]);
    expect(result.wastePercent).toBe(0);
    expect(result.monthlyDeadTokens).toBe(0);
    expect(result.monthlyUsd).toBe(0);
  });

  it("does not classify configured items when a session count has no observed turns", () => {
    const items = [item({ kind: "mcp_server", name: "framer", weightConfidence: "unmeasured" })];
    const result = computeDeadContext(
      items,
      invocations({ sessions: 2, totalAssistantTurns: 0, sessionTurnCounts: [0, 0] }),
      config
    );
    expect(result.hasData).toBe(false);
    expect(result.loadedCount).toBe(1);
    expect(result.deadCount).toBe(0);
    expect(result.deadItems).toEqual([]);
  });
});

describe("sampleDeadContext", () => {
  it("returns illustrative, renderable numbers flagged isSample", () => {
    const s = sampleDeadContext();
    expect(s.isSample).toBe(true);
    expect(s.hasData).toBe(true);
    expect(s.deadCount).toBeGreaterThan(0);
    expect(s.deadCount).toBeLessThan(s.loadedCount);
    expect(s.measuredDeadCount).toBeGreaterThan(0);
    expect(s.monthlyDeadTokens).toBeGreaterThan(0);
    expect(s.monthlyUsd).toBeGreaterThan(0);
    expect(s.monthlyUsdUpperBound).toBeGreaterThan(s.monthlyUsd);
  });
});

describe("deadContextCutAction", () => {
  it("returns null when nothing meaningful is dead", () => {
    const result = computeDeadContext(
      [item({ kind: "mcp_server", name: "github", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" })],
      invocations({ invokedMcpTools: ["mcp__github__x"] }),
      { windowDays: 30, pricingModel: "claude-sonnet-4" }
    );
    expect(deadContextCutAction(result)).toBeNull();
  });

  it("returns null for MCP-only waste (counted, not a dollar cut)", () => {
    const items = [item({ kind: "mcp_server", name: "dead", alwaysLoadedTokens: 0, weightConfidence: "unmeasured" })];
    const inv = invocations({ sessions: 5, totalAssistantTurns: 200, sessionTurnCounts: [40, 40, 40, 40, 40] });
    const result = computeDeadContext(items, inv, { windowDays: 30, pricingModel: "claude-sonnet-4" });
    expect(deadContextCutAction(result)).toBeNull();
  });

  it("produces a context_trim cut action from MEASURED dead weight", () => {
    const items = [item({ kind: "skill", name: "dead", alwaysLoadedTokens: 50000 })];
    const inv = invocations({ sessions: 5, totalAssistantTurns: 200, sessionTurnCounts: [40, 40, 40, 40, 40] });
    const result = computeDeadContext(items, inv, { windowDays: 30, pricingModel: "claude-sonnet-4" });
    const cut = deadContextCutAction(result);
    expect(cut).not.toBeNull();
    expect(cut!.kind).toBe("context_trim");
    expect(cut!.estimatedMonthlySavingsUsd).toBe(result.monthlyUsd);
    expect(cut!.impactBasis).toBe("modeled_savings");
    expect(cut!.confidence).toBe("estimated");
  });
});
