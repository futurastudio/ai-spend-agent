import {
  type LocalAgentActivity,
  type LocalAgentCall,
  type LocalAgentLogResult,
  type LocalAgentRateLimitWindow
} from "./localAgentLogs.js";
import { estimateTokenCostUsd, PRICING_TABLE_AS_OF } from "./modelPricing.js";
import type { DetectedPlan } from "./planDetection.js";
import { subscriptionPlans } from "./planMath.js";
import { buildContextHealth, type ContextHealthResult } from "./contextHealth.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export type GlanceSession = {
  status: "active" | "recent";
  agent: LocalAgentCall["agent"];
  project?: string;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  durationMinutes: number;
  apiEquivalentUsd: number | null;
  costConfidence: "estimated" | "missing";
  inputTokens: number;
  outputTokens: number;
};

export type GlanceLimit = {
  agent: LocalAgentCall["agent"];
  kind: LocalAgentRateLimitWindow["kind"];
  name: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  observedAt: string;
  resetsAt: string;
  source: "transcript_reported";
  projectedExhaustionAt: string | null;
  projectedToExhaustBeforeReset: boolean;
  projectionConfidence: "estimated";
};

export type GlanceAnomaly = {
  kind: "session_spend" | "session_tokens";
  ratioToMedian: number;
  summary: string;
  action: string;
  confidence: "derived";
};

export type GlancePlanContext = {
  agent: LocalAgentCall["agent"];
  planId: string | null;
  planLabel: string;
  billing: DetectedPlan["billing"];
  monthlyUsd: number | null;
  priceConfidence: "published_list" | "missing";
  source: "locally_detected" | "user_declared";
};

export type GlanceFocus = {
  windowDays: number;
  summary: string;
  kind: LocalAgentActivity["kind"];
  project?: string;
  file?: string;
  agents: Array<LocalAgentCall["agent"]>;
  sessions: number;
  activitySharePercent: number;
  measure: "observed_prompt_and_tool_activity";
  confidence: "high" | "medium" | "low";
};

export type GlanceProvenance = {
  session: {
    source: "local_transcript_metadata";
    agents: Array<LocalAgentCall["agent"]>;
    filesParsed: number;
  };
  sessionValue: {
    source: "local_calculation";
    basis: "transcript_tokens_at_public_api_rates";
    confidence: GlanceSession["costConfidence"];
    pricingAsOf: string;
  };
  plan: {
    source: "local_agent_account_metadata" | "user_declared" | "not_available";
    agent?: LocalAgentCall["agent"];
  };
  limits: {
    source: "transcript_reported" | "not_available";
    agents: Array<LocalAgentCall["agent"]>;
    windows: Array<LocalAgentRateLimitWindow["kind"]>;
    projection: "local_pace_estimate";
  };
  focus: {
    source: "local_prompt_and_tool_activity" | "not_available";
    agents: Array<LocalAgentCall["agent"]>;
    rawPromptTextReturned: false;
  };
  anomaly: {
    source: "local_session_history" | "not_available";
    comparison: "same_agent_session_median";
  };
  contextHealth: {
    source: "canonical_context_health_contract";
    hookPayload: "not_executed_or_inferred";
  };
  network: {
    uploaded: false;
  };
};

export type UsageGlanceSnapshot = {
  dataMode: "local_transcripts";
  generatedAt: string;
  coverage: {
    filesParsed: number;
    supportedTranscriptAgents: Array<LocalAgentCall["agent"]>;
    detectedAgents: Array<LocalAgentCall["agent"]>;
    rateLimitMetadata: Array<{
      agent: LocalAgentCall["agent"];
      status: "reported" | "not_reported_by_transcript" | "not_seen";
      windowsReported: Array<LocalAgentRateLimitWindow["kind"]>;
    }>;
    providerConnectionRequired: ["cursor", "github-copilot"];
  };
  provenance: GlanceProvenance;
  currentSession: GlanceSession | null;
  plan: GlancePlanContext | null;
  limits: GlanceLimit[];
  focus: GlanceFocus | null;
  anomaly: GlanceAnomaly | null;
  sessionHealth: ContextHealthResult;
  caveats: string[];
};

export type BuildUsageGlanceOptions = {
  now?: Date;
  activeWithinMinutes?: number;
  focusWindowDays?: number;
  filesParsed?: number;
  detectedAgents?: Array<LocalAgentCall["agent"]>;
  /** Locally detected or explicitly declared subscription/API billing modes. */
  detectedPlans?: DetectedPlan[];
  /** Account-level limit metadata should not be removed by a project filter. */
  limitCalls?: LocalAgentCall[];
  /** Canonical result shared with CLI/MCP. Falls back to session-only health. */
  contextHealth?: ContextHealthResult;
};

type SessionGroup = {
  key: string;
  calls: LocalAgentCall[];
  agent: LocalAgentCall["agent"];
  project?: string;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  apiEquivalentUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  activity?: LocalAgentActivity;
};

/**
 * Build the read model used by the native Glance surface.
 *
 * Token counts, projects, models, timestamps, and Codex limit windows come
 * directly from local transcript metadata. Dollar values and exhaustion
 * times are deterministic estimates and are labeled as such.
 */
export function buildUsageGlance(
  calls: LocalAgentCall[],
  options: BuildUsageGlanceOptions = {}
): UsageGlanceSnapshot {
  const contextGeneratedAt = options.contextHealth
    ? new Date(options.contextHealth.generatedAt)
    : undefined;
  const now = options.now ??
    (contextGeneratedAt && Number.isFinite(contextGeneratedAt.getTime())
      ? contextGeneratedAt
      : new Date());
  const activeWithinMinutes = options.activeWithinMinutes ?? 20;
  const focusWindowDays = options.focusWindowDays ?? 7;
  const sessions = groupSessions(calls);
  const latest = sessions
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0];
  const currentSession = latest
    ? toGlanceSession(latest, now, activeWithinMinutes)
    : null;
  const plan = currentSession
    ? toGlancePlan(currentSession.agent, options.detectedPlans ?? [])
    : null;
  const limitCalls = options.limitCalls ?? calls;
  const limits = latestLimits(limitCalls, now).map(({ agent, window, observedAt }) =>
    toGlanceLimit(agent, window, observedAt)
  );
  const windowStart = now.getTime() - focusWindowDays * DAY_MS;
  const windowCalls = calls.filter((call) => Date.parse(call.timestamp) >= windowStart);
  const focus = buildMainFocus(groupSessions(windowCalls), focusWindowDays, now);
  const sessionHealth = options.contextHealth ?? buildContextHealth({ calls, now });
  const anomaly = anomalyFromContextHealth(sessionHealth);
  const detectedAgents = options.detectedAgents ?? uniqueAgents(calls);
  const agentsWithLimits = new Set(limits.map((limit) => limit.agent));
  const limitAgents = uniqueAgents(limitCalls.filter((call) => call.rateLimits));
  const reportedWindows = (agent: LocalAgentCall["agent"]) => (
    [...new Set(
      limits
        .filter((limit) => limit.agent === agent)
        .map((limit) => limit.kind)
    )]
  );
  const caveats = [
    "Session value is an API-equivalent estimate from transcript token counts, not an invoice or subscription charge.",
    "A detected monthly subscription changes the interpretation, not the token math: the API-equivalent amount is value delivered at list rates, not incremental spend.",
    "Exhaustion time is a pace projection; remaining percentage and reset time are provider-reported only when embedded in a transcript.",
    "Main focus is a local summary of observed human prompts and tool activity, not elapsed time or spend; raw prompts are not returned.",
    "Claude Code transcripts do not report plan headroom. Missing limits remain unavailable instead of being inferred.",
    "Cursor and GitHub Copilot require their provider connections because their local chat stores are not treated as authoritative billing transcripts."
  ];

  return {
    dataMode: "local_transcripts",
    generatedAt: now.toISOString(),
    coverage: {
      filesParsed: options.filesParsed ?? 0,
      supportedTranscriptAgents: ["claude-code", "codex"],
      detectedAgents,
      rateLimitMetadata: [
        {
          agent: "claude-code",
          status: "not_reported_by_transcript",
          windowsReported: reportedWindows("claude-code")
        },
        {
          agent: "codex",
          status: agentsWithLimits.has("codex") ? "reported" : "not_seen",
          windowsReported: reportedWindows("codex")
        }
      ],
      providerConnectionRequired: ["cursor", "github-copilot"]
    },
    provenance: {
      session: {
        source: "local_transcript_metadata",
        agents: currentSession ? [currentSession.agent] : [],
        filesParsed: options.filesParsed ?? 0
      },
      sessionValue: {
        source: "local_calculation",
        basis: "transcript_tokens_at_public_api_rates",
        confidence: currentSession?.costConfidence ?? "missing",
        pricingAsOf: PRICING_TABLE_AS_OF
      },
      plan: {
        source: plan
          ? plan.source === "user_declared"
            ? "user_declared"
            : "local_agent_account_metadata"
          : "not_available",
        ...(plan ? { agent: plan.agent } : {})
      },
      limits: {
        source: limits.length > 0 ? "transcript_reported" : "not_available",
        agents: limitAgents,
        windows: limits.map((limit) => limit.kind),
        projection: "local_pace_estimate"
      },
      focus: {
        source: focus ? "local_prompt_and_tool_activity" : "not_available",
        agents: focus?.agents ?? [],
        rawPromptTextReturned: false
      },
      anomaly: {
        source: anomaly ? "local_session_history" : "not_available",
        comparison: "same_agent_session_median"
      },
      contextHealth: {
        source: "canonical_context_health_contract",
        hookPayload: "not_executed_or_inferred"
      },
      network: {
        uploaded: false
      }
    },
    currentSession,
    plan,
    limits,
    focus,
    anomaly,
    sessionHealth,
    caveats
  };
}

function toGlancePlan(
  agent: LocalAgentCall["agent"],
  detectedPlans: DetectedPlan[]
): GlancePlanContext | null {
  const detected = detectedPlans.find((plan) => plan.agent === agent);
  if (!detected) return null;
  const known = detected.planId
    ? subscriptionPlans.find((plan) => plan.id === detected.planId)
    : undefined;
  return {
    agent,
    planId: detected.planId ?? null,
    planLabel: detected.planLabel,
    billing: detected.billing,
    monthlyUsd: known?.monthlyUsd ?? null,
    priceConfidence: known ? "published_list" : "missing",
    source: detected.source === "--plan override" ? "user_declared" : "locally_detected"
  };
}

export function buildUsageGlanceFromLogs(
  logs: LocalAgentLogResult,
  options: Omit<BuildUsageGlanceOptions, "filesParsed"> = {}
): UsageGlanceSnapshot {
  return buildUsageGlance(logs.calls, {
    ...options,
    filesParsed: logs.filesParsed,
    detectedAgents: logs.agentsDetected
  });
}

function groupSessions(calls: LocalAgentCall[]): SessionGroup[] {
  const groups = new Map<string, LocalAgentCall[]>();
  calls.forEach((call, index) => {
    const fallback = `${call.project ?? "unattributed"}:${call.model}:${call.timestamp}:${index}`;
    const key = `${call.agent}:${call.sessionId ?? fallback}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  });

  return [...groups.entries()].map(([key, grouped]) => {
    const ordered = grouped.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const costs = ordered.map(callCost);
    const costComplete = costs.every((cost): cost is number => typeof cost === "number");
    const startedAt = ordered
      .map((call) => call.startedAt ?? call.timestamp)
      .sort()[0]!;
    return {
      key,
      calls: ordered,
      agent: last.agent,
      project: last.project ?? first.project,
      model: last.model,
      startedAt,
      lastActivityAt: last.timestamp,
      apiEquivalentUsd: costComplete ? costs.reduce((total, cost) => total + cost, 0) : null,
      inputTokens: sum(ordered, (call) => (
        call.usage.inputTokens +
        (call.usage.cacheReadTokens ?? 0) +
        (call.usage.cacheWrite5mTokens ?? 0) +
        (call.usage.cacheWrite1hTokens ?? 0)
      )),
      outputTokens: sum(ordered, (call) => call.usage.outputTokens),
      totalTokens: sum(ordered, (call) => (
        call.usage.inputTokens +
        call.usage.outputTokens +
        (call.usage.cacheReadTokens ?? 0) +
        (call.usage.cacheWrite5mTokens ?? 0) +
        (call.usage.cacheWrite1hTokens ?? 0)
      )),
      activity: ordered
        .slice()
        .reverse()
        .find((call) => call.activity)?.activity
    };
  });
}

function toGlanceSession(
  session: SessionGroup,
  now: Date,
  activeWithinMinutes: number
): GlanceSession {
  const lastActivityMs = Date.parse(session.lastActivityAt);
  const ageMs = Math.max(0, now.getTime() - lastActivityMs);
  const durationMs = Math.max(
    0,
    Date.parse(session.lastActivityAt) - Date.parse(session.startedAt)
  );
  return {
    status: ageMs <= activeWithinMinutes * 60 * 1_000 ? "active" : "recent",
    agent: session.agent,
    project: session.project,
    model: session.model,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    durationMinutes: Math.max(1, Math.round(durationMs / 60_000)),
    apiEquivalentUsd: roundUsd(session.apiEquivalentUsd),
    costConfidence: session.apiEquivalentUsd === null ? "missing" : "estimated",
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens
  };
}

function latestLimits(calls: LocalAgentCall[], now: Date): Array<{
  agent: LocalAgentCall["agent"];
  window: LocalAgentRateLimitWindow;
  observedAt: string;
}> {
  const byWindow = new Map<string, {
    agent: LocalAgentCall["agent"];
    window: LocalAgentRateLimitWindow;
    observedAt: string;
  }>();
  for (const call of calls) {
    if (!call.rateLimits) continue;
    for (const window of call.rateLimits.windows) {
      if (Date.parse(window.resetsAt) <= now.getTime()) continue;
      const key = `${call.agent}:${window.kind}:${window.windowMinutes}`;
      const prior = byWindow.get(key);
      if (!prior || prior.observedAt < call.rateLimits.observedAt) {
        byWindow.set(key, {
          agent: call.agent,
          window,
          observedAt: call.rateLimits.observedAt
        });
      }
    }
  }
  const order = { "five-hour": 0, weekly: 1, custom: 2 };
  return [...byWindow.values()].sort((left, right) => (
    order[left.window.kind] - order[right.window.kind] ||
    left.agent.localeCompare(right.agent)
  ));
}

function toGlanceLimit(
  agent: LocalAgentCall["agent"],
  window: LocalAgentRateLimitWindow,
  observedAt: string
): GlanceLimit {
  const projection = projectExhaustion(window, observedAt);
  return {
    agent,
    kind: window.kind,
    name: window.name,
    usedPercent: window.usedPercent,
    remainingPercent: roundPercent(100 - window.usedPercent),
    windowMinutes: window.windowMinutes,
    observedAt,
    resetsAt: window.resetsAt,
    source: "transcript_reported",
    projectedExhaustionAt: projection.at,
    projectedToExhaustBeforeReset: projection.beforeReset,
    projectionConfidence: "estimated"
  };
}

function projectExhaustion(
  window: LocalAgentRateLimitWindow,
  observedAt: string
): { at: string | null; beforeReset: boolean } {
  const observedMs = Date.parse(observedAt);
  const resetMs = Date.parse(window.resetsAt);
  const windowStartMs = resetMs - window.windowMinutes * 60_000;
  const elapsedMs = observedMs - windowStartMs;
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(resetMs) ||
    elapsedMs <= 0 ||
    observedMs >= resetMs ||
    window.usedPercent <= 0
  ) {
    return { at: null, beforeReset: false };
  }
  if (window.usedPercent >= 100) {
    return { at: observedAt, beforeReset: true };
  }
  const remainingMs = elapsedMs * ((100 - window.usedPercent) / window.usedPercent);
  const exhaustionMs = observedMs + remainingMs;
  return exhaustionMs < resetMs
    ? { at: new Date(exhaustionMs).toISOString(), beforeReset: true }
    : { at: null, beforeReset: false };
}

type FocusCandidate = {
  session: SessionGroup;
  activity: LocalAgentActivity;
  score: number;
};

type FocusCluster = {
  candidates: FocusCandidate[];
  tokens: Set<string>;
  score: number;
};

function buildMainFocus(
  sessions: SessionGroup[],
  windowDays: number,
  now: Date
): GlanceFocus | null {
  const candidates = sessions.map((session): FocusCandidate => {
    const activity = session.activity ?? fallbackActivity(session);
    const ageDays = Math.max(0, now.getTime() - Date.parse(session.lastActivityAt)) / DAY_MS;
    const recency = ageDays <= 1 ? 1.15 : ageDays <= 3 ? 1 : 0.8;
    const evidence = activity.promptCount * 3 +
      activity.toolCallCount +
      Math.min(session.calls.length, 8);
    const fallbackDiscount = activity.source === "project" ? 0.35 : 1;
    const subagentDiscount = activity.isSubagent ? 0.35 : 1;
    return {
      session,
      activity,
      score: Math.max(1, evidence) * recency * fallbackDiscount * subagentDiscount
    };
  });
  if (candidates.length === 0) return null;

  const clusters: FocusCluster[] = [];
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    const tokens = focusTokens(candidate.activity.summary);
    const existing = clusters.find((cluster) => focusSimilarity(cluster.tokens, tokens) >= 0.5);
    if (existing) {
      existing.candidates.push(candidate);
      existing.score += candidate.score;
      for (const token of tokens) existing.tokens.add(token);
    } else {
      clusters.push({ candidates: [candidate], tokens, score: candidate.score });
    }
  }
  clusters.sort((left, right) => right.score - left.score);
  const selected = clusters[0]!;
  const totalScore = clusters.reduce((total, cluster) => total + cluster.score, 0);
  const lead = selected.candidates
    .slice()
    .sort((left, right) => right.score - left.score)[0]!;
  const promptCount = selected.candidates.reduce(
    (total, candidate) => total + candidate.activity.promptCount,
    0
  );
  const source = lead.activity.source;
  const project = mostWeightedValue(
    selected.candidates,
    (candidate) => candidate.session.project
  );
  const file = mostRelevantFile(selected.candidates, lead.activity.summary);
  const agents = [...new Set(selected.candidates.map((candidate) => candidate.session.agent))].sort();
  const share = totalScore > 0 ? Math.round(selected.score / totalScore * 100) : 0;
  const confidence: GlanceFocus["confidence"] = source === "user_prompts" && promptCount >= 2 && share >= 30
    ? "high"
    : source !== "project"
      ? "medium"
      : "low";

  return {
    windowDays,
    summary: lead.activity.summary,
    kind: lead.activity.kind,
    project,
    file,
    agents,
    sessions: selected.candidates.length,
    activitySharePercent: share,
    measure: "observed_prompt_and_tool_activity",
    confidence
  };
}

function fallbackActivity(session: SessionGroup): LocalAgentActivity {
  return {
    summary: session.project ? `Working in ${session.project}` : "Working with coding agents",
    kind: session.project ? "project" : "agent",
    action: "working",
    source: "project",
    promptCount: 0,
    toolCallCount: 0,
    files: [],
    isSubagent: false
  };
}

function focusTokens(summary: string): Set<string> {
  const ignored = new Set([
    "auditing", "building", "configuring", "fixing", "in", "publishing",
    "refining", "researching", "running", "testing", "the", "working"
  ]);
  return new Set(
    (summary.toLowerCase().match(/[a-z0-9+#.-]+/g) ?? [])
      .filter((token) => token.length > 1 && !ignored.has(token))
  );
}

function focusSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function mostWeightedValue(
  candidates: FocusCandidate[],
  valueFor: (candidate: FocusCandidate) => string | undefined
): string | undefined {
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    const value = valueFor(candidate);
    if (value) scores.set(value, (scores.get(value) ?? 0) + candidate.score);
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function mostRelevantFile(
  candidates: FocusCandidate[],
  summary: string
): string | undefined {
  const topicTokens = focusTokens(summary);
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    candidate.activity.files.forEach((file, index) => {
      const tokens = focusTokens(
        file.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ")
      );
      const overlap = [...tokens].filter((token) => topicTokens.has(token)).length;
      if (overlap === 0 && candidate.activity.kind !== "file") return;
      const rankWeight = 1 / (index + 1);
      scores.set(file, (scores.get(file) ?? 0) + candidate.score * rankWeight * Math.max(1, overlap));
    });
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function anomalyFromContextHealth(health: ContextHealthResult): GlanceAnomaly | null {
  const ratio = health.currentSession?.ratioToMedian;
  if (health.recommendation !== "start_fresh" || ratio === null || ratio === undefined) {
    return null;
  }
  return {
    kind: "session_tokens",
    ratioToMedian: ratio,
    summary: health.headline,
    action: health.action,
    confidence: "derived"
  };
}

function callCost(call: LocalAgentCall): number | undefined {
  return estimateTokenCostUsd(call.model, call.usage);
}

function uniqueAgents(calls: LocalAgentCall[]): Array<LocalAgentCall["agent"]> {
  return [...new Set(calls.map((call) => call.agent))].sort();
}

function sum(calls: LocalAgentCall[], pick: (call: LocalAgentCall) => number): number {
  return calls.reduce((total, call) => total + pick(call), 0);
}

function roundUsd(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}
