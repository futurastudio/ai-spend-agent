import {
  loadAgentInventory,
  type AgentInventoryOptions,
  type AgentInventoryResult,
  type InventoryItem
} from "./agentInventory.js";
import {
  computeDeadContext,
  type DeadContextResult
} from "./deadContext.js";
import type { LocalAgentCall } from "./localAgentLogs.js";
import {
  loadToolInvocations,
  type InvocationSummary,
  type ToolInvocationOptions
} from "./toolInvocations.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WINDOW_DAYS = 30;

export type ContextHealthStatus =
  | "healthy"
  | "watch"
  | "start_fresh"
  | "insufficient_data";

export type ContextHealthRecommendation =
  | "continue"
  | "start_fresh"
  | "review_hooks"
  | "trim_dead_context"
  | "collect_more_history";

export type ContextHealthEvidence = {
  kind: "session_history" | "hook_config" | "inventory_usage";
  summary: string;
  source: string;
  confidence: "observed" | "derived" | "unmeasured";
};

export type ContextHealthResult = {
  schemaVersion: 1;
  generatedAt: string;
  status: ContextHealthStatus;
  recommendation: ContextHealthRecommendation;
  headline: string;
  action: string;
  confidence: "high" | "medium" | "low";
  currentSession: {
    status: "active" | "recent";
    agent: LocalAgentCall["agent"];
    project?: string;
    totalTokens: number;
    ratioToMedian: number | null;
    comparisonSessions: number;
    source: "local_transcript_metadata";
  } | null;
  activation: {
    discoverableItems: number;
    explicitlyInvokedItems: number;
    hookInjectedItems: number;
    lifecycleHooks: number;
    mcpSchemaLoadedItems: number;
    unmeasuredItems: number;
    invocationUnobservableItems: number;
  };
  deadContext: {
    loadedItems: number;
    neverInvokedItems: number;
    measuredNeverInvokedItems: number;
    unmeasuredNeverInvokedItems: number;
    windowDays: number;
  };
  evidence: ContextHealthEvidence[];
  provenance: {
    inventory: "local_agent_configuration";
    invocations: "local_claude_code_and_codex_transcripts";
    session: "local_transcript_metadata";
    hookPayload: "not_executed_or_inferred";
    uploaded: false;
  };
  caveats: string[];
};

export type BuildContextHealthInput = {
  calls?: LocalAgentCall[];
  inventory?: AgentInventoryResult | { items: InventoryItem[] };
  invocations?: InvocationSummary;
  deadContext?: DeadContextResult;
  now?: Date;
  activeWithinMinutes?: number;
  windowDays?: number;
};

export type LoadContextHealthOptions = AgentInventoryOptions &
  ToolInvocationOptions & {
    now?: Date;
    activeWithinMinutes?: number;
    windowDays?: number;
    pricingModel?: string;
    inventory?: AgentInventoryResult;
    invocations?: InvocationSummary;
  };

/**
 * Load one canonical Context Health snapshot. CLI, MCP, and Glance all consume
 * this contract so their recommendation and provenance cannot drift.
 */
export async function loadContextHealth(
  calls: LocalAgentCall[],
  options: LoadContextHealthOptions = {}
): Promise<ContextHealthResult> {
  const inventory = options.inventory ?? await loadAgentInventory(options);
  const invocations = options.invocations ?? await loadToolInvocations(options);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const deadContext = computeDeadContext(inventory.items, invocations, {
    windowDays,
    pricingModel: options.pricingModel ?? "claude-sonnet-4"
  });
  return buildContextHealth({
    calls,
    inventory,
    invocations,
    deadContext,
    now: options.now,
    activeWithinMinutes: options.activeWithinMinutes,
    windowDays
  });
}

/** Pure Context Health contract builder for deterministic tests and adapters. */
export function buildContextHealth(
  input: BuildContextHealthInput = {}
): ContextHealthResult {
  const now = input.now ?? new Date();
  const calls = input.calls ?? [];
  const items = input.inventory?.items ?? [];
  const invocations = input.invocations ?? emptyInvocations();
  const windowDays = input.windowDays ?? input.deadContext?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const deadContext = input.deadContext ?? computeDeadContext(items, invocations, {
    windowDays,
    pricingModel: "claude-sonnet-4"
  });
  const currentSession = buildCurrentSession(
    calls,
    now,
    input.activeWithinMinutes ?? 20
  );
  const activation = activationSummary(items, invocations);
  const hookItems = items.filter((item) => item.activation === "hook_injected");
  const evidence: ContextHealthEvidence[] = [];

  if (currentSession) {
    evidence.push({
      kind: "session_history",
      summary: currentSession.ratioToMedian === null
        ? `${currentSession.totalTokens.toLocaleString("en-US")} local transcript tokens; no same-agent baseline yet.`
        : `${currentSession.totalTokens.toLocaleString("en-US")} local transcript tokens, ${currentSession.ratioToMedian}× the median of ${currentSession.comparisonSessions} prior same-agent session${currentSession.comparisonSessions === 1 ? "" : "s"}.`,
      source: `${currentSession.agent} local transcripts`,
      confidence: currentSession.ratioToMedian === null ? "observed" : "derived"
    });
  }

  for (const hook of hookItems.slice(0, 3)) {
    evidence.push({
      kind: "hook_config",
      summary: `${hook.group ?? hook.name} is configured on ${hook.event ?? "a lifecycle event"} for ${hostLabel(hook.host)}.`,
      source: hook.path ?? "installed plugin metadata",
      confidence: "unmeasured"
    });
  }
  if (hookItems.length > 3) {
    evidence.push({
      kind: "hook_config",
      summary: `${hookItems.length - 3} additional hook-injected context source${hookItems.length - 3 === 1 ? "" : "s"} detected.`,
      source: "installed plugin metadata",
      confidence: "unmeasured"
    });
  }

  if (deadContext.deadCount > 0) {
    evidence.push({
      kind: "inventory_usage",
      summary: `${deadContext.deadCount} of ${deadContext.loadedCount} discoverable/schema-loaded item${deadContext.loadedCount === 1 ? "" : "s"} were not invoked in the parsed window.`,
      source: "local inventory compared with local transcript invocations",
      confidence: deadContext.unmeasuredDeadCount > 0 ? "unmeasured" : "derived"
    });
  }
  if (activation.invocationUnobservableItems > 0) {
    evidence.push({
      kind: "inventory_usage",
      summary: `${activation.invocationUnobservableItems} configured item${activation.invocationUnobservableItems === 1 ? "" : "s"} cannot be matched to an explicit invocation in the available transcript format and were excluded from never-invoked counts.`,
      source: "local inventory and transcript capability metadata",
      confidence: "unmeasured"
    });
  }

  const decision = contextDecision({
    currentSession,
    hookInjectedItems: activation.hookInjectedItems,
    deadContext
  });

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    ...decision,
    currentSession,
    activation,
    deadContext: {
      loadedItems: deadContext.loadedCount,
      neverInvokedItems: deadContext.deadCount,
      measuredNeverInvokedItems: deadContext.measuredDeadCount,
      unmeasuredNeverInvokedItems: deadContext.unmeasuredDeadCount,
      windowDays
    },
    evidence,
    provenance: {
      inventory: "local_agent_configuration",
      invocations: "local_claude_code_and_codex_transcripts",
      session: "local_transcript_metadata",
      hookPayload: "not_executed_or_inferred",
      uploaded: false
    },
    caveats: [
      "Hook commands are never run by aibill. Configuration proves activation, but runtime output and token size remain unmeasured.",
      "A session comparison uses local transcript token totals from the same coding agent; it is not a provider charge or a universal context-window measurement.",
      "Never-invoked means no matching invocation was observed in the selected local transcript window, not that an item has no future value.",
      "Items whose host transcript does not expose explicit invocation evidence are excluded from never-invoked counts.",
      "No per-session savings claim is made without an observed counterfactual baseline."
    ]
  };
}

function contextDecision(input: {
  currentSession: ContextHealthResult["currentSession"];
  hookInjectedItems: number;
  deadContext: DeadContextResult;
}): Pick<
  ContextHealthResult,
  "status" | "recommendation" | "headline" | "action" | "confidence"
> {
  const ratio = input.currentSession?.ratioToMedian;
  if (ratio !== null && ratio !== undefined && ratio >= 1.5) {
    return {
      status: "start_fresh",
      recommendation: "start_fresh",
      headline: `This session is ${ratio}× your same-agent token median.`,
      action: "Start fresh before a new task; keep this session only while its existing context is directly useful.",
      confidence: input.currentSession!.comparisonSessions >= 3 ? "high" : "medium"
    };
  }
  if (input.hookInjectedItems > 0) {
    return {
      status: "watch",
      recommendation: "review_hooks",
      headline: `${input.hookInjectedItems} hook-injected context source${input.hookInjectedItems === 1 ? "" : "s"} detected.`,
      action: "Review the installed hook sources before removing anything; their runtime payload size is not measurable from configuration.",
      confidence: "medium"
    };
  }
  if (input.deadContext.hasData && input.deadContext.deadCount > 0) {
    return {
      status: "watch",
      recommendation: "trim_dead_context",
      headline: `${input.deadContext.deadCount} loaded item${input.deadContext.deadCount === 1 ? "" : "s"} were not invoked in this window.`,
      action: "Lazy-load or remove only the items you do not expect to need, then re-run Context Health.",
      confidence: input.deadContext.unmeasuredDeadCount > 0 ? "medium" : "high"
    };
  }
  if (input.currentSession && input.currentSession.comparisonSessions > 0) {
    return {
      status: "healthy",
      recommendation: "continue",
      headline: "No evidence-backed context action is needed.",
      action: "Continue in this session while its context remains useful.",
      confidence: input.currentSession.comparisonSessions >= 3 ? "high" : "medium"
    };
  }
  return {
    status: "insufficient_data",
    recommendation: "collect_more_history",
    headline: "More local session history is needed for a context recommendation.",
    action: "Keep using your coding agents, then re-run Context Health after a few sessions.",
    confidence: "low"
  };
}

type ContextSessionGroup = {
  key: string;
  agent: LocalAgentCall["agent"];
  project?: string;
  lastActivityAt: string;
  totalTokens: number;
};

function buildCurrentSession(
  calls: LocalAgentCall[],
  now: Date,
  activeWithinMinutes: number
): ContextHealthResult["currentSession"] {
  const sessions = contextSessions(calls);
  const latest = sessions
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0];
  if (!latest) return null;
  const comparisons = sessions.filter((session) => (
    session.key !== latest.key &&
    session.agent === latest.agent &&
    session.totalTokens > 0
  ));
  const baseline = median(comparisons.map((session) => session.totalTokens));
  const ratio = baseline && baseline > 0
    ? roundRatio(latest.totalTokens / baseline)
    : null;
  const ageMs = Math.max(0, now.getTime() - Date.parse(latest.lastActivityAt));
  return {
    status: ageMs <= activeWithinMinutes * 60_000 ? "active" : "recent",
    agent: latest.agent,
    project: latest.project,
    totalTokens: latest.totalTokens,
    ratioToMedian: ratio,
    comparisonSessions: comparisons.length,
    source: "local_transcript_metadata"
  };
}

function contextSessions(calls: LocalAgentCall[]): ContextSessionGroup[] {
  const groups = new Map<string, LocalAgentCall[]>();
  calls.forEach((call, index) => {
    const fallback = `${call.project ?? "unattributed"}:${call.model}:${call.timestamp}:${index}`;
    const key = `${call.agent}:${call.sessionId ?? fallback}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  });
  return [...groups.entries()].map(([key, grouped]) => {
    const ordered = grouped.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const latest = ordered[ordered.length - 1]!;
    return {
      key,
      agent: latest.agent,
      project: latest.project ?? ordered[0]?.project,
      lastActivityAt: latest.timestamp,
      totalTokens: ordered.reduce((total, call) => total + (
        call.usage.inputTokens +
        call.usage.outputTokens +
        (call.usage.cacheReadTokens ?? 0) +
        (call.usage.cacheWrite5mTokens ?? 0) +
        (call.usage.cacheWrite1hTokens ?? 0)
      ), 0)
    };
  });
}

function activationSummary(
  items: InventoryItem[],
  invocations: InvocationSummary
): ContextHealthResult["activation"] {
  return {
    discoverableItems: items.filter((item) => item.activation === "discoverable").length,
    explicitlyInvokedItems: items.filter((item) => itemWasInvoked(item, invocations)).length,
    hookInjectedItems: items.filter((item) => item.activation === "hook_injected").length,
    lifecycleHooks: items.filter((item) => item.activation === "lifecycle_hook").length,
    mcpSchemaLoadedItems: items.filter((item) => item.activation === "mcp_schema_loaded").length,
    unmeasuredItems: items.filter((item) => item.weightConfidence !== "estimated").length,
    invocationUnobservableItems: items.filter(
      (item) => item.kind !== "hook" && item.invocationTracking === "not_observable"
    ).length
  };
}

function itemWasInvoked(item: InventoryItem, invocations: InvocationSummary): boolean {
  if (item.invocationTracking === "not_observable") return false;
  switch (item.kind) {
    case "skill":
      return invocations.invokedSkills.includes(item.name);
    case "subagent":
      return invocations.invokedSubagents.includes(item.name);
    case "command":
      return invocations.invokedCommands.includes(item.name);
    case "mcp_tool":
      return invocations.invokedMcpTools.includes(item.name);
    case "mcp_server":
      return invocations.invokedMcpTools.some((tool) => tool.split("__")[1] === item.name);
    case "hook":
      return false;
  }
}

function emptyInvocations(): InvocationSummary {
  return {
    invocations: [],
    invokedMcpTools: [],
    invokedSkills: [],
    invokedSubagents: [],
    invokedCommands: [],
    sessions: 0,
    totalAssistantTurns: 0,
    sessionTurnCounts: [],
    sourceSessions: { claudeCode: 0, codex: 0 }
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function roundRatio(value: number): number {
  return Math.round(value * 10) / 10;
}

function hostLabel(host: InventoryItem["host"]): string {
  if (host === "claude-code") return "Claude Code";
  if (host === "codex") return "Codex";
  return "an agent host";
}

/** Exposed for deterministic benchmark fixtures. */
export const CONTEXT_HEALTH_DEFAULT_WINDOW_DAYS = DEFAULT_WINDOW_DAYS;
export const CONTEXT_HEALTH_DAY_MS = DAY_MS;
