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
import type { LocalAgentCall, LocalAgentTurnUsage } from "./localAgentLogs.js";
import { localAgentFormatSupports } from "./localAgentFormats/registry.js";
import {
  loadToolInvocations,
  type InvocationSummary,
  type SessionContextSignal,
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
  kind: "session_history" | "context_churn" | "hook_config" | "inventory_usage";
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
    /** Latest observed turn total, never cumulative session lifetime usage. */
    totalTokens: number;
    /** Latest observed input-side context, including cached input. */
    contextTokens: number;
    usageSource: LocalAgentTurnUsage["source"] | "not_available";
    ratioToMedian: number | null;
    ratioCapped: boolean;
    comparisonSessions: number;
    comparisonBasis:
      | "same_project_and_session_type"
      | "same_session_type"
      | "not_available";
    cacheWriteTokens: number;
    cacheWriteRatioToMedian: number | null;
    source: "local_transcript_metadata";
  } | null;
  activation: {
    discoverableItems: number;
    explicitlyInvokedItems: number;
    hookInjectedItems: number;
    lifecycleHooks: number;
    mcpConfiguredItems: number;
    mcpAlwaysLoadedItems: number;
    /** Legacy adapter state; current local inventory does not infer this. */
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
  contextChurn: {
    currentSessionEvidence:
      | "matched"
      | "not_matched"
      | "no_current_session";
    compactionEvents: number | null;
    explicitFileReads: number | null;
    repeatedReadEvents: number | null;
    repeatedFiles: Array<{
      file: string;
      readCount: number;
    }>;
    readCoverage: "explicit_read_tools_only" | "not_available";
    currentSessionScope: "parent" | "subagent" | "unknown" | null;
    observedParentSessions: number;
    observedSubagentSessions: number;
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
  const [inventory, invocations] = await Promise.all([
    options.inventory ?? loadAgentInventory(options),
    options.invocations ?? loadToolInvocations(options)
  ]);
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
  const calls = (input.calls ?? [])
    .filter((call) => localAgentFormatSupports(call.agent, "contextHealth"));
  const items = input.inventory?.items ?? [];
  const invocations = input.invocations ?? emptyInvocations();
  const windowDays = input.windowDays ?? input.deadContext?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const deadContext = input.deadContext ?? computeDeadContext(items, invocations, {
    windowDays,
    pricingModel: "claude-sonnet-4"
  });
  const sessionGroups = contextSessions(calls);
  const latestSession = latestContextSession(sessionGroups);
  const currentSession = buildCurrentSession(
    sessionGroups,
    now,
    input.activeWithinMinutes ?? 20
  );
  const contextChurn = buildContextChurn(latestSession, invocations);
  const activation = activationSummary(items, invocations);
  const hookItems = items.filter((item) => item.activation === "hook_injected");
  const evidence: ContextHealthEvidence[] = [];

  if (currentSession) {
    evidence.push({
      kind: "session_history",
      summary: currentSession.usageSource === "not_available"
        ? "Latest-turn context usage was not present in this transcript format; cumulative session usage was excluded from Context Health comparison."
        : currentSession.ratioToMedian === null
          ? `${currentSession.contextTokens.toLocaleString("en-US")} input context tokens in the latest observed turn; no comparable baseline yet.`
          : `${currentSession.contextTokens.toLocaleString("en-US")} input context tokens in the latest observed turn, ${currentSession.ratioCapped ? "at least " : ""}${currentSession.ratioToMedian}× the median of ${currentSession.comparisonSessions} comparable prior session${currentSession.comparisonSessions === 1 ? "" : "s"}.`,
      source: `${currentSession.agent} local transcript latest-turn usage`,
      confidence: currentSession.usageSource === "not_available"
        ? "unmeasured"
        : currentSession.ratioToMedian === null
          ? "observed"
          : "derived"
    });
  }
  if ((contextChurn.compactionEvents ?? 0) > 0) {
    evidence.push({
      kind: "context_churn",
      summary: `${contextChurn.compactionEvents} explicit compaction event${contextChurn.compactionEvents === 1 ? "" : "s"} observed in the current session transcript.`,
      source: `${currentSession?.agent ?? "coding-agent"} local transcript event metadata`,
      confidence: "observed"
    });
  }
  if ((contextChurn.repeatedReadEvents ?? 0) > 0) {
    const files = contextChurn.repeatedFiles
      .slice(0, 3)
      .map((file) => `${file.file} ×${file.readCount}`)
      .join(", ");
    evidence.push({
      kind: "context_churn",
      summary: `${contextChurn.repeatedReadEvents} repeat read event${contextChurn.repeatedReadEvents === 1 ? "" : "s"} observed through explicit file-read tools${files ? ` (${files})` : ""}.`,
      source: "local transcript tool-call metadata; basenames only",
      confidence: "observed"
    });
  }
  if (
    currentSession?.cacheWriteRatioToMedian !== null &&
    currentSession?.cacheWriteRatioToMedian !== undefined &&
    currentSession.cacheWriteRatioToMedian >= 1.5
  ) {
    evidence.push({
      kind: "context_churn",
      summary: `${currentSession.cacheWriteTokens.toLocaleString("en-US")} cache-write tokens, ${currentSession.cacheWriteRatioToMedian}× the median of prior same-agent sessions with cache-write data.`,
      source: `${currentSession.agent} local transcript usage metadata`,
      confidence: "derived"
    });
  }

  for (const hook of hookItems.slice(0, 3)) {
    evidence.push({
      kind: "hook_config",
      summary: `${safeHookCategory(hook)} is configured for ${hostLabel(hook.host)}.`,
      source: safeHookProvenance(hook),
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
      summary: `${deadContext.deadCount} of ${deadContext.loadedCount} configured item${deadContext.loadedCount === 1 ? "" : "s"} had no matching invocation in the parsed window; configuration alone does not prove their definitions were loaded every turn.`,
      source: "local inventory compared with local transcript invocations",
      confidence: deadContext.unmeasuredDeadCount > 0 ? "unmeasured" : "derived"
    });
  }
  if (activation.invocationUnobservableItems > 0) {
    evidence.push({
      kind: "inventory_usage",
      summary: `${activation.invocationUnobservableItems} configured item${activation.invocationUnobservableItems === 1 ? "" : "s"} cannot be matched reliably to an explicit invocation or one concrete configuration scope in the available transcript format and were excluded from never-invoked counts.`,
      source: "local inventory and transcript capability metadata",
      confidence: "unmeasured"
    });
  }

  const decision = contextDecision({
    currentSession,
    contextChurn,
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
    contextChurn,
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
      "A Context Health comparison uses latest-turn input context from comparable local sessions, never cumulative session lifetime usage. It is not a provider charge or a universal context-window measurement.",
      "No matching invocation means none was observed in the selected local transcript window. Configuration alone does not prove an item was loaded every turn or that it has no future value.",
      "Items whose host transcript does not expose explicit invocation evidence, or whose evidence cannot be attributed to one concrete configuration scope, are excluded from never-invoked counts.",
      "Repeated-read evidence includes only explicit file-read tools and returns basenames only. Shell commands are not guessed to be reads.",
      "Compaction counts come from explicit transcript markers; absence means not observed in the parsed format, not proof that compaction never occurred.",
      "No per-session savings claim is made without an observed counterfactual baseline."
    ]
  };
}

function contextDecision(input: {
  currentSession: ContextHealthResult["currentSession"];
  contextChurn: ContextHealthResult["contextChurn"];
  hookInjectedItems: number;
  deadContext: DeadContextResult;
}): Pick<
  ContextHealthResult,
  "status" | "recommendation" | "headline" | "action" | "confidence"
> {
  // Explicit compaction markers are direct evidence and outrank any ratio
  // derived from a comparison cohort.
  if ((input.contextChurn.compactionEvents ?? 0) >= 2) {
    const count = input.contextChurn.compactionEvents!;
    return {
      status: "start_fresh",
      recommendation: "start_fresh",
      headline: `This session has compacted ${count} times.`,
      action: "Start fresh before the next task; preserve only the concrete state you still need.",
      confidence: "high"
    };
  }
  const ratio = input.currentSession?.ratioToMedian;
  if (ratio !== null && ratio !== undefined && ratio >= 1.5) {
    const ratioLabel = input.currentSession?.ratioCapped ? `at least ${ratio}` : `${ratio}`;
    const exactComparisons = input.currentSession?.comparisonBasis === "same_project_and_session_type";
    return {
      status: "start_fresh",
      recommendation: "start_fresh",
      headline: `This turn's context load is ${ratioLabel}× your comparable same-agent token median.`,
      action: "Start fresh before a new task; keep this session only while its existing context is directly useful.",
      confidence: exactComparisons &&
        !input.currentSession?.ratioCapped &&
        input.currentSession!.comparisonSessions >= 3
        ? "high"
        : "medium"
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
      headline: `${input.deadContext.deadCount} configured item${input.deadContext.deadCount === 1 ? "" : "s"} had no matching invocation in this window.`,
      action: "First verify how each host makes the item available; then lazy-load or remove only items you confirm you do not need, and re-run Context Health.",
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
  contextTokens: number;
  usageSource: LocalAgentTurnUsage["source"] | "not_available";
  cacheWriteTokens: number;
  sessionType: "parent" | "subagent" | "unknown";
};

const MIN_EXACT_COMPARISONS = 2;
const MIN_SESSION_TYPE_COMPARISONS = 2;
const MAX_DISPLAY_RATIO = 20;

function buildCurrentSession(
  sessions: ContextSessionGroup[],
  now: Date,
  activeWithinMinutes: number
): ContextHealthResult["currentSession"] {
  const latest = latestContextSession(sessions);
  if (!latest) return null;
  const eligible = sessions.filter((session) => (
    session.key !== latest.key &&
    session.agent === latest.agent &&
    session.contextTokens > 0
  ));
  const sameProjectAndType = eligible.filter((session) => (
    Boolean(latest.project) &&
    session.project === latest.project &&
    session.sessionType === latest.sessionType
  ));
  const sameType = eligible.filter((session) => (
    latest.sessionType !== "unknown" &&
    session.sessionType === latest.sessionType
  ));
  const comparisons = sameProjectAndType.length > 0
    ? sameProjectAndType
    : sameType.length > 0
      ? sameType
      : [];
  const comparisonBasis: NonNullable<ContextHealthResult["currentSession"]>["comparisonBasis"] = comparisons === sameProjectAndType
      ? "same_project_and_session_type"
      : comparisons === sameType
        ? "same_session_type"
        : "not_available";
  const minimumComparisons = comparisonBasis === "same_project_and_session_type"
    ? MIN_EXACT_COMPARISONS
    : MIN_SESSION_TYPE_COMPARISONS;
  const baseline = comparisons.length >= minimumComparisons
    ? median(comparisons.map((session) => session.contextTokens))
    : null;
  const cacheWriteBaseline = median(
    comparisons
      .map((session) => session.cacheWriteTokens)
      .filter((tokens) => tokens > 0)
  );
  const rawRatio = baseline && baseline > 0 && latest.contextTokens > 0
    ? latest.contextTokens / baseline
    : null;
  const ratioCapped = rawRatio !== null && rawRatio > MAX_DISPLAY_RATIO;
  const ratio = rawRatio === null
    ? null
    : roundRatio(Math.min(rawRatio, MAX_DISPLAY_RATIO));
  const ageMs = Math.max(0, now.getTime() - Date.parse(latest.lastActivityAt));
  return {
    status: ageMs <= activeWithinMinutes * 60_000 ? "active" : "recent",
    agent: latest.agent,
    project: latest.project,
    totalTokens: latest.totalTokens,
    contextTokens: latest.contextTokens,
    usageSource: latest.usageSource,
    ratioToMedian: ratio,
    ratioCapped,
    comparisonSessions: comparisons.length,
    comparisonBasis,
    cacheWriteTokens: latest.cacheWriteTokens,
    cacheWriteRatioToMedian: cacheWriteBaseline && latest.cacheWriteTokens > 0
      ? roundRatio(latest.cacheWriteTokens / cacheWriteBaseline)
      : null,
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
    const latestWithTurnUsage = ordered
      .slice()
      .reverse()
      .find((call) => call.latestTurnUsage || call.usageScope !== "session_cumulative");
    const turnUsage = latestWithTurnUsage
      ? latestWithTurnUsage.latestTurnUsage ?? turnUsageFromCall(latestWithTurnUsage)
      : undefined;
    return {
      key,
      agent: latest.agent,
      project: latest.project ?? ordered[0]?.project,
      lastActivityAt: latest.timestamp,
      totalTokens: turnUsage?.totalTokens ?? 0,
      contextTokens: turnUsage?.contextTokens ?? 0,
      usageSource: turnUsage?.source ?? "not_available",
      cacheWriteTokens: turnUsage
        ? (turnUsage.cacheWrite5mTokens ?? 0) + (turnUsage.cacheWrite1hTokens ?? 0)
        : 0,
      sessionType: latest.activity?.isSubagent === true
        ? "subagent"
        : latest.activity?.isSubagent === false
          ? "parent"
          : "unknown"
    };
  });
}

function turnUsageFromCall(call: LocalAgentCall): LocalAgentTurnUsage | undefined {
  if (call.usageScope === "session_cumulative") return undefined;
  const contextTokens = call.usage.inputTokens +
    (call.usage.cacheReadTokens ?? 0) +
    (call.usage.cacheWrite5mTokens ?? 0) +
    (call.usage.cacheWrite1hTokens ?? 0);
  return {
    ...call.usage,
    contextTokens,
    totalTokens: contextTokens + call.usage.outputTokens,
    source: call.agent === "claude-code" ? "assistant_message_usage" : "call_usage"
  };
}

function latestContextSession(
  sessions: ContextSessionGroup[]
): ContextSessionGroup | undefined {
  return sessions
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0];
}

function buildContextChurn(
  latest: ContextSessionGroup | undefined,
  invocations: InvocationSummary
): ContextHealthResult["contextChurn"] {
  const signals = mergeSessionSignals(invocations.sessionSignals ?? []);
  const currentSignal = latest
    ? signals.find((signal) => (
      signal.agent === latest.agent &&
      signal.sessionId &&
      latest.key === `${signal.agent}:${signal.sessionId}`
    ))
    : undefined;
  const repeatedFiles = (currentSignal?.repeatedFileReads ?? [])
    .map((file) => ({ file: file.name, readCount: file.count }));
  return {
    currentSessionEvidence: !latest
      ? "no_current_session"
      : currentSignal
        ? "matched"
        : "not_matched",
    compactionEvents: currentSignal?.compactionEvents ?? null,
    explicitFileReads: currentSignal
      ? currentSignal.fileReads.reduce((total, file) => total + file.count, 0)
      : null,
    repeatedReadEvents: currentSignal
      ? repeatedFiles.reduce((total, file) => total + file.readCount - 1, 0)
      : null,
    repeatedFiles,
    readCoverage: currentSignal?.readCoverage ?? "not_available",
    currentSessionScope: currentSignal
      ? currentSignal.isSubagent
        ? "subagent"
        : "parent"
      : latest
        ? "unknown"
        : null,
    observedParentSessions: signals.filter((signal) => !signal.isSubagent).length,
    observedSubagentSessions: signals.filter((signal) => signal.isSubagent).length
  };
}

function mergeSessionSignals(signals: SessionContextSignal[]): SessionContextSignal[] {
  const keyed = new Map<string, SessionContextSignal[]>();
  const anonymous: SessionContextSignal[] = [];
  for (const signal of signals) {
    if (!signal.sessionId) {
      anonymous.push(signal);
      continue;
    }
    const key = `${signal.agent}:${signal.sessionId}`;
    keyed.set(key, [...(keyed.get(key) ?? []), signal]);
  }
  const merged = [...keyed.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => mergeSignalGroup(group));
  const sortedAnonymous = anonymous.slice().sort(compareSessionSignals);
  return [...merged, ...sortedAnonymous];
}

function mergeSignalGroup(group: SessionContextSignal[]): SessionContextSignal {
  const ordered = group.slice().sort(compareSessionSignals);
  const preferred = ordered[0]!;
  const fileReadCounts = new Map<string, number>();
  for (const signal of group) {
    for (const file of signal.fileReads) {
      fileReadCounts.set(file.name, Math.max(fileReadCounts.get(file.name) ?? 0, file.count));
    }
  }
  const fileReads = [...fileReadCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return {
    ...preferred,
    lastActivityAt: group
      .map((signal) => signal.lastActivityAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0],
    compactionEvents: Math.max(...group.map((signal) => signal.compactionEvents)),
    fileReads,
    repeatedFileReads: fileReads.filter((file) => file.count > 1)
  };
}

function compareSessionSignals(
  left: SessionContextSignal,
  right: SessionContextSignal
): number {
  return (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "") ||
    right.compactionEvents - left.compactionEvents ||
    totalFileReads(right) - totalFileReads(left) ||
    sessionSignalSignature(left).localeCompare(sessionSignalSignature(right));
}

function totalFileReads(signal: SessionContextSignal): number {
  return signal.fileReads.reduce((total, file) => total + file.count, 0);
}

function sessionSignalSignature(signal: SessionContextSignal): string {
  return JSON.stringify({
    agent: signal.agent,
    sessionId: signal.sessionId,
    isSubagent: signal.isSubagent,
    parentSessionId: signal.parentSessionId,
    files: signal.fileReads
      .map((file) => [file.name, file.count])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
  });
}

function safeHookCategory(hook: InventoryItem): string {
  if (hook.event === "SessionStart") return "Session-start context hook";
  if (hook.event === "UserPromptSubmit") return "Prompt-submit context hook";
  if (hook.event === "SubagentStart") return "Subagent-start context hook";
  if (hook.activation === "hook_injected") return "Context-injecting lifecycle hook";
  return "Lifecycle hook";
}

function safeHookProvenance(hook: InventoryItem): string {
  if (hook.path === "Claude user settings") return "Claude user settings";
  if (hook.path === "Claude project settings") return "Claude project settings";
  if (hook.path === "Claude project-local settings") return "Claude project-local settings";
  const normalized = hook.path?.replace(/\\/g, "/");
  if (normalized?.endsWith("/.claude/settings.local.json")) {
    return ".claude/settings.local.json";
  }
  if (normalized?.endsWith("/.claude/settings.json")) {
    return ".claude/settings.json";
  }
  if (normalized?.endsWith("/hooks/hooks.json")) {
    return "installed plugin hooks/hooks.json";
  }
  const scope = hook.scope === "user"
    ? "user"
    : hook.scope === "local"
      ? "project-local"
      : "project";
  return `${hostLabel(hook.host)} ${scope} hook configuration`;
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
    mcpConfiguredItems: items.filter((item) => item.activation === "mcp_configured").length,
    mcpAlwaysLoadedItems: items.filter((item) => item.activation === "mcp_always_loaded").length,
    mcpSchemaLoadedItems: items.filter((item) => item.activation === "mcp_schema_loaded").length,
    unmeasuredItems: items.filter((item) => item.weightConfidence !== "estimated").length,
    invocationUnobservableItems: items.filter(
      (item) => item.kind !== "hook" && item.invocationTracking === "not_observable"
    ).length
  };
}

function itemWasInvoked(item: InventoryItem, invocations: InvocationSummary): boolean {
  if (item.invocationTracking === "not_observable") return false;
  const evidence = item.host && invocations.byHost
    ? invocations.byHost[item.host]
    : invocations;
  switch (item.kind) {
    case "skill":
      return evidence.invokedSkills.includes(item.name);
    case "subagent":
      return evidence.invokedSubagents.includes(item.name);
    case "command":
      return evidence.invokedCommands.includes(item.name);
    case "mcp_tool":
      return evidence.invokedMcpTools.includes(item.name);
    case "mcp_server":
      return evidence.invokedMcpTools.some((tool) => tool.split("__")[1] === item.name);
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
