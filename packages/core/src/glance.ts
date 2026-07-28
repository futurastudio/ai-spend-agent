import {
  type LocalAgentCall,
  type LocalAgentLogResult,
  type LocalAgentRateLimitWindow
} from "./localAgentLogs.js";
import { estimateTokenCostUsd } from "./modelPricing.js";

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

export type GlanceHeavyItem = {
  name: string;
  apiEquivalentUsd: number;
  costConfidence: "estimated";
};

export type GlanceAnomaly = {
  kind: "session_spend" | "session_tokens";
  ratioToMedian: number;
  summary: string;
  action: string;
  confidence: "derived";
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
    }>;
    providerConnectionRequired: ["cursor", "github-copilot"];
  };
  currentSession: GlanceSession | null;
  limits: GlanceLimit[];
  heaviest: {
    windowDays: number;
    project: GlanceHeavyItem | null;
    model: GlanceHeavyItem | null;
    projectModel: (GlanceHeavyItem & { project: string; model: string }) | null;
  };
  anomaly: GlanceAnomaly | null;
  caveats: string[];
};

export type BuildUsageGlanceOptions = {
  now?: Date;
  activeWithinMinutes?: number;
  heaviestWindowDays?: number;
  filesParsed?: number;
  detectedAgents?: Array<LocalAgentCall["agent"]>;
  /** Account-level limit metadata should not be removed by a project filter. */
  limitCalls?: LocalAgentCall[];
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
  const now = options.now ?? new Date();
  const activeWithinMinutes = options.activeWithinMinutes ?? 20;
  const heaviestWindowDays = options.heaviestWindowDays ?? 7;
  const sessions = groupSessions(calls);
  const latest = sessions
    .slice()
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))[0];
  const currentSession = latest
    ? toGlanceSession(latest, now, activeWithinMinutes)
    : null;
  const limitCalls = options.limitCalls ?? calls;
  const limits = latestLimits(limitCalls, now).map(({ agent, window, observedAt }) =>
    toGlanceLimit(agent, window, observedAt)
  );
  const windowStart = now.getTime() - heaviestWindowDays * DAY_MS;
  const windowCalls = calls.filter((call) => Date.parse(call.timestamp) >= windowStart);
  const heaviest = buildHeaviest(windowCalls, heaviestWindowDays);
  const anomaly = latest ? buildAnomaly(latest, sessions) : null;
  const detectedAgents = options.detectedAgents ?? uniqueAgents(calls);
  const agentsWithLimits = new Set(limits.map((limit) => limit.agent));
  const caveats = [
    "Session spend is an API-equivalent estimate from transcript token counts, not an invoice or subscription charge.",
    "Exhaustion time is a pace projection; remaining percentage and reset time are provider-reported only when embedded in a transcript.",
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
          status: "not_reported_by_transcript"
        },
        {
          agent: "codex",
          status: agentsWithLimits.has("codex") ? "reported" : "not_seen"
        }
      ],
      providerConnectionRequired: ["cursor", "github-copilot"]
    },
    currentSession,
    limits,
    heaviest,
    anomaly,
    caveats
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
      ))
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

function buildHeaviest(
  calls: LocalAgentCall[],
  windowDays: number
): UsageGlanceSnapshot["heaviest"] {
  const project = heaviestGroup(calls, (call) => call.project ?? "unattributed");
  const model = heaviestGroup(calls, (call) => call.model);
  const projectModelGroup = heaviestGroup(
    calls,
    (call) => `${call.project ?? "unattributed"}\u0000${call.model}`
  );
  const projectModel = projectModelGroup
    ? {
        ...projectModelGroup,
        project: projectModelGroup.name.split("\u0000")[0]!,
        model: projectModelGroup.name.split("\u0000")[1]!
      }
    : null;
  if (projectModel) projectModel.name = `${projectModel.project} · ${projectModel.model}`;
  return { windowDays, project, model, projectModel };
}

function heaviestGroup(
  calls: LocalAgentCall[],
  keyFor: (call: LocalAgentCall) => string
): GlanceHeavyItem | null {
  const groups = new Map<string, number>();
  for (const call of calls) {
    const cost = callCost(call);
    if (cost === undefined) continue;
    const key = keyFor(call);
    groups.set(key, (groups.get(key) ?? 0) + cost);
  }
  const heaviest = [...groups.entries()].sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  ))[0];
  return heaviest
    ? {
        name: heaviest[0],
        apiEquivalentUsd: roundUsd(heaviest[1]) ?? 0,
        costConfidence: "estimated"
      }
    : null;
}

function buildAnomaly(
  current: SessionGroup,
  sessions: SessionGroup[]
): GlanceAnomaly | null {
  const comparisons = sessions.filter((session) => (
    session.key !== current.key &&
    session.agent === current.agent
  ));
  const spendBaseline = median(
    comparisons
      .map((session) => session.apiEquivalentUsd)
      .filter((value): value is number => typeof value === "number" && value > 0)
  );
  if (
    current.apiEquivalentUsd !== null &&
    spendBaseline !== null &&
    spendBaseline > 0
  ) {
    const ratio = current.apiEquivalentUsd / spendBaseline;
    if (ratio >= 1.5) {
      const roundedRatio = roundRatio(ratio);
      return {
        kind: "session_spend",
        ratioToMedian: roundedRatio,
        summary: `Current session spend is ${roundedRatio}× the ${current.agent} median.`,
        action: "Start a fresh session before the next task; keep this one only if its context is still essential.",
        confidence: "derived"
      };
    }
  }

  const tokenBaseline = median(
    comparisons.map((session) => session.totalTokens).filter((value) => value > 0)
  );
  if (tokenBaseline !== null && tokenBaseline > 0) {
    const ratio = current.totalTokens / tokenBaseline;
    if (ratio >= 1.5) {
      const roundedRatio = roundRatio(ratio);
      return {
        kind: "session_tokens",
        ratioToMedian: roundedRatio,
        summary: `Current session token throughput is ${roundedRatio}× the ${current.agent} median.`,
        action: "Start a fresh session before the next task to avoid carrying unnecessary context.",
        confidence: "derived"
      };
    }
  }
  return null;
}

function callCost(call: LocalAgentCall): number | undefined {
  return estimateTokenCostUsd(call.model, call.usage);
}

function uniqueAgents(calls: LocalAgentCall[]): Array<LocalAgentCall["agent"]> {
  return [...new Set(calls.map((call) => call.agent))].sort();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
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

function roundRatio(value: number): number {
  return Math.round(value * 10) / 10;
}
