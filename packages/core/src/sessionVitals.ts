import { createHash } from "node:crypto";
import {
  dedupeCumulativeSessionCalls,
  sanitizeLocalActivityText,
  type LocalAgentActivity,
  type LocalAgentCall,
  type LocalAgentRateLimitWindow,
  type LocalAgentTurnUsage,
  type LocalAgentTokenComponentEvidence
} from "./localAgentLogs.js";

/**
 * Additive, privacy-reduced session evidence for future before/after tests.
 *
 * V0 deliberately accepts already-parsed LocalAgentCall values rather than
 * reading transcripts itself. It never carries prompts, responses, absolute
 * paths, filenames, or raw provider session identifiers.
 */
export type SessionVitalsAgentV0 = "claude-code" | "codex";

export type SessionVitalsTokenEvidenceV0 =
  | {
      status: "observed";
      basis: "turn_sum" | "session_cumulative";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWrite5mTokens?: number;
      cacheWrite1hTokens?: number;
      thoughtTokens?: number;
      toolTokens?: number;
      componentTotalTokens: number;
      reportedTotalTokens?: number;
      componentEvidence: {
        inputTokens: "observed";
        outputTokens: "observed";
        cacheReadTokens: "observed" | "not_separately_reported";
        cacheWriteTokens: "observed" | "partial" | "not_separately_reported";
        thoughtTokens: "observed" | "not_separately_reported";
        toolTokens: "observed" | "not_separately_reported";
        componentTotalTokens: "calculated_complete" | "calculated_partial";
        reportedTotalTokens: "provider_reported" | "not_reported";
      };
    }
  | {
      status: "missing";
      reason:
        | "unsupported_token_shape"
        | "mixed_usage_scope"
        | "invalid_token_evidence";
    };

type ObservedSessionVitalsTokenEvidenceV0 = Extract<
  SessionVitalsTokenEvidenceV0,
  { status: "observed" }
>;

export type SessionVitalsLatestTurnV0 = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  thoughtTokens?: number;
  toolTokens?: number;
  contextTokens: number;
  totalTokens: number;
  source: LocalAgentTurnUsage["source"];
};

export type SessionVitalsRateLimitWindowV0 = {
  kind: LocalAgentRateLimitWindow["kind"];
  name: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type SessionVitalsCompletionV0 =
  | {
      status: "completed";
      /**
       * A completed session snapshot, not permanent transcript closure.
       * `claude_task_result` is the host-recorded Task tool result
       * (`status: "completed"`) written into the owning transcript when a
       * subagent run finishes — the only explicit completion marker Claude
       * Code produces for subagent transcript files.
       */
      evidence: "claude_turn_duration" | "codex_task_complete" | "claude_task_result";
      observedAt: string;
    }
  | {
      status: "missing";
      evidence: "missing";
      reason: "completion_marker_not_observed" | "inconsistent_completion_evidence";
    };

export type SessionVitalV0 = {
  /** Stable AV-compatible pseudonym. The raw transcript session id is never returned. */
  sessionRef: string;
  /**
   * Pseudonym of the owning parent session, present only on rows split out of
   * a shared-sessionId subagent transcript. Matches the parent row's
   * `sessionRef`; raw identifiers are never returned.
   */
  parentSessionRef?: string;
  agent: SessionVitalsAgentV0;
  /** Unknown remains ineligible for automatic before/after cohort matching. */
  sessionType: "parent" | "subagent" | "unknown";
  /** Existing privacy-reduced project label; paths and suspicious values are omitted. */
  project?: string;
  /** Stable opaque identity derived from one consistent native working directory. */
  projectRef?: string;
  models: string[];
  /** Empty means the parser did not report a safe version; never inferred. */
  sourceVersions: string[];
  observedFrom: string;
  observedTo: string;
  /** Omitted unless a distinct, valid start and end are present. */
  observedDurationMs?: number;
  /** Explicit host completion boundary for this snapshot; inactivity is never treated as completion. */
  completion: SessionVitalsCompletionV0;
  tokenEvidence: SessionVitalsTokenEvidenceV0;
  latestTurn?: SessionVitalsLatestTurnV0;
  activity?: {
    kind: LocalAgentActivity["kind"];
    action: LocalAgentActivity["action"];
    promptCount: number;
    toolCallCount: number;
  };
  rateLimits?: {
    observedAt: string;
    planType?: string;
    windows: SessionVitalsRateLimitWindowV0[];
  };
  provenance: {
    source: "parsed_local_agent_calls";
    confidence: "observed";
    uploaded: false;
  };
};

export type SessionVitalsV0 = {
  schemaVersion: 0;
  sessions: SessionVitalV0[];
  coverage: {
    inputCalls: number;
    deduplicatedCalls: number;
    eligibleCalls: number;
    emittedSessions: number;
    sessionsWithObservedTokens: number;
    sessionsWithMissingTokens: number;
    excludedCalls: {
      unsupportedAgent: number;
      missingSessionIdentity: number;
      invalidTimestamp: number;
    };
  };
  privacy: {
    rawSessionIds: false;
    promptOrResponseText: false;
    absolutePaths: false;
    uploaded: false;
  };
};

type EligibleCall = LocalAgentCall & {
  agent: SessionVitalsAgentV0;
  sessionId: string;
};

/**
 * Build one deterministic V0 row per Claude Code or Codex session.
 *
 * Token evidence fails closed at the session boundary: one unsupported,
 * invalid, or mixed-scope call prevents a partial sum from looking complete.
 */
export function extractSessionVitalsV0(calls: readonly LocalAgentCall[]): SessionVitalsV0 {
  const excludedCalls = {
    unsupportedAgent: 0,
    missingSessionIdentity: 0,
    invalidTimestamp: 0
  };
  const eligible: EligibleCall[] = [];

  for (const call of calls) {
    if (call.agent !== "claude-code" && call.agent !== "codex") {
      excludedCalls.unsupportedAgent += 1;
      continue;
    }
    if (!call.sessionId) {
      excludedCalls.missingSessionIdentity += 1;
      continue;
    }
    if (!validObservedTimestamp(call.timestamp)) {
      excludedCalls.invalidTimestamp += 1;
      continue;
    }
    eligible.push(call as EligibleCall);
  }

  const deduplicated = dedupeCumulativeSessionCalls(eligible) as EligibleCall[];
  // A subagent transcript that shares its parent's sessionId is still its own
  // run: merging it into the parent would emit a session shape no real task
  // has (mixed models, mixed subagent flags, conflicting completion markers)
  // and would permanently block cohort comparability for that agent. Calls
  // without a subagent identity keep their existing grouping unchanged.
  const groups = new Map<string, EligibleCall[]>();
  for (const call of deduplicated) {
    const key = `${call.agent}\u0000${call.sessionId}\u0000${call.subagentId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  const subagentCompletionLookup = subagentCompletionsByIdentity(eligible);

  const sessions = [...groups.values()]
    .map((group) => buildSessionVital(group, subagentCompletionLookup))
    .sort((left, right) =>
      left.observedFrom.localeCompare(right.observedFrom) ||
      left.agent.localeCompare(right.agent) ||
      left.sessionRef.localeCompare(right.sessionRef)
    );
  const sessionsWithObservedTokens = sessions.filter(
    (session) => session.tokenEvidence.status === "observed"
  ).length;

  return {
    schemaVersion: 0,
    sessions,
    coverage: {
      inputCalls: calls.length,
      deduplicatedCalls: deduplicated.length,
      eligibleCalls: eligible.length,
      emittedSessions: sessions.length,
      sessionsWithObservedTokens,
      sessionsWithMissingTokens: sessions.length - sessionsWithObservedTokens,
      excludedCalls
    },
    privacy: {
      rawSessionIds: false,
      promptOrResponseText: false,
      absolutePaths: false,
      uploaded: false
    }
  };
}

function buildSessionVital(
  calls: EligibleCall[],
  subagentCompletionLookup: ReadonlyMap<string, string>
): SessionVitalV0 {
  const ordered = calls.slice().sort((left, right) =>
    Date.parse(left.timestamp) - Date.parse(right.timestamp)
  );
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const explicitStarts = ordered
    .map((call) => normalizedTimestamp(call.startedAt))
    .filter((value): value is string => Boolean(value));
  const observedFrom = [...explicitStarts, normalizedTimestamp(first.timestamp)!]
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
  const observedTo = normalizedTimestamp(last.timestamp)!;
  const durationMs = Date.parse(observedTo) - Date.parse(observedFrom);
  const project = oneSafeProject(ordered);
  const projectRef = oneProjectRef(ordered);
  const models = [...new Set(ordered.map((call) => safeMetadata(call.model, 96)).filter(Boolean))]
    .sort();
  const sourceVersions = safeSourceVersions(ordered);
  const latestTurn = latestTurnEvidence(ordered);
  const activity = sessionActivity(ordered);
  const rateLimits = latestRateLimits(ordered);
  const subagentId = oneSubagentId(ordered);
  const completion = sessionCompletion(
    ordered,
    observedTo,
    subagentId === undefined
      ? undefined
      : subagentCompletionLookup.get(
          subagentCompletionKey(first.agent, first.sessionId, subagentId)
        )
  );

  return {
    sessionRef: pseudonymousSessionRef(first.agent, first.sessionId, subagentId),
    ...(subagentId === undefined
      ? {}
      : { parentSessionRef: pseudonymousSessionRef(first.agent, first.sessionId) }),
    agent: first.agent,
    sessionType: sessionType(ordered, subagentId !== undefined),
    ...(project ? { project } : {}),
    ...(projectRef ? { projectRef } : {}),
    models,
    sourceVersions,
    observedFrom,
    observedTo,
    ...(durationMs > 0 ? { observedDurationMs: durationMs } : {}),
    completion,
    tokenEvidence: tokenEvidence(ordered),
    ...(latestTurn ? { latestTurn } : {}),
    ...(activity ? { activity } : {}),
    ...(rateLimits ? { rateLimits } : {}),
    provenance: {
      source: "parsed_local_agent_calls",
      confidence: "observed",
      uploaded: false
    }
  };
}

function tokenEvidence(calls: EligibleCall[]): SessionVitalsTokenEvidenceV0 {
  if (calls.some((call) => call.usageSupport === "unsupported_token_shape")) {
    return { status: "missing", reason: "unsupported_token_shape" };
  }
  const scopes = new Set(calls.map((call) => call.usageScope));
  if (scopes.size !== 1 || scopes.has(undefined)) {
    return { status: "missing", reason: "mixed_usage_scope" };
  }
  if (calls.some((call) => !validUsage(call))) {
    return { status: "missing", reason: "invalid_token_evidence" };
  }

  const basis = calls[0]!.usageScope === "session_cumulative"
    ? "session_cumulative"
    : "turn_sum";
  const inputTokens = sum(calls, (call) => call.usage.inputTokens);
  const outputTokens = sum(calls, (call) => call.usage.outputTokens);
  const cacheReadTokens = completeSum(calls, (call) => call.usage.cacheReadTokens);
  const cacheWrite5mTokens = completeSum(calls, (call) => call.usage.cacheWrite5mTokens);
  const cacheWrite1hTokens = completeSum(calls, (call) => call.usage.cacheWrite1hTokens);
  const thoughtTokens = completeSum(calls, (call) => call.usage.thoughtTokens);
  const toolTokens = completeSum(calls, (call) => call.usage.toolTokens);
  const reportedTotalTokens = completeSum(calls, (call) => call.reportedTotalTokens);
  const componentTotalTokens = inputTokens + outputTokens +
    (cacheReadTokens ?? 0) +
    (cacheWrite5mTokens ?? 0) +
    (cacheWrite1hTokens ?? 0) +
    (thoughtTokens ?? 0) +
    (toolTokens ?? 0);
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens,
    cacheWrite1hTokens, thoughtTokens, toolTokens, reportedTotalTokens,
    componentTotalTokens].every(validOptionalCount)) {
    return { status: "missing", reason: "invalid_token_evidence" };
  }

  return {
    status: "observed",
    basis,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens } : {}),
    ...(cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    ...(toolTokens !== undefined ? { toolTokens } : {}),
    componentTotalTokens,
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {}),
    componentEvidence: mergedTokenComponentEvidence(calls, reportedTotalTokens)
  };
}

function mergedTokenComponentEvidence(
  calls: EligibleCall[],
  reportedTotalTokens: number | undefined
): ObservedSessionVitalsTokenEvidenceV0["componentEvidence"] {
  const evidence = calls.map((call) =>
    call.tokenComponentEvidence ?? inferredTokenComponentEvidence(call)
  );
  const all = <T extends string>(
    pick: (item: LocalAgentTokenComponentEvidence) => T,
    value: T
  ): boolean => evidence.every((item) => pick(item) === value);
  return {
    inputTokens: "observed",
    outputTokens: "observed",
    cacheReadTokens: all((item) => item.cacheReadTokens, "observed")
      ? "observed"
      : "not_separately_reported",
    cacheWriteTokens: all((item) => item.cacheWriteTokens, "observed")
      ? "observed"
      : all((item) => item.cacheWriteTokens, "not_separately_reported")
        ? "not_separately_reported"
        : "partial",
    thoughtTokens: all((item) => item.thoughtTokens, "observed")
      ? "observed"
      : "not_separately_reported",
    toolTokens: all((item) => item.toolTokens, "observed")
      ? "observed"
      : "not_separately_reported",
    componentTotalTokens: all(
      (item) => item.calculatedTotalTokens,
      "calculated_complete"
    ) ? "calculated_complete" : "calculated_partial",
    reportedTotalTokens: reportedTotalTokens === undefined
      ? "not_reported"
      : "provider_reported"
  };
}

/** Conservative fallback for additive in-memory callers predating parser evidence. */
function inferredTokenComponentEvidence(
  call: EligibleCall
): LocalAgentTokenComponentEvidence {
  const hasCacheRead = call.usage.cacheReadTokens !== undefined;
  const hasWrite5m = call.usage.cacheWrite5mTokens !== undefined;
  const hasWrite1h = call.usage.cacheWrite1hTokens !== undefined;
  const complete = call.agent === "codex" ||
    (hasCacheRead && hasWrite5m && hasWrite1h);
  return {
    inputTokens: "observed",
    outputTokens: "observed",
    cacheReadTokens: hasCacheRead ? "observed" : "not_separately_reported",
    cacheWriteTokens: hasWrite5m && hasWrite1h
      ? "observed"
      : hasWrite5m || hasWrite1h
        ? "partial"
        : "not_separately_reported",
    thoughtTokens: call.usage.thoughtTokens === undefined
      ? "not_separately_reported"
      : "observed",
    toolTokens: call.usage.toolTokens === undefined
      ? "not_separately_reported"
      : "observed",
    calculatedTotalTokens: complete
      ? "calculated_complete"
      : "calculated_partial",
    reportedTotalTokens: call.reportedTotalTokens === undefined
      ? "not_reported"
      : "provider_reported"
  };
}

function latestTurnEvidence(calls: EligibleCall[]): SessionVitalsLatestTurnV0 | undefined {
  const call = calls
    .filter((candidate) => candidate.latestTurnUsage && candidate.usageSupport !== "unsupported_token_shape")
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
  const usage = call?.latestTurnUsage;
  if (!usage || !validTurnUsage(usage)) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens: usage.cacheWrite5mTokens } : {}),
    ...(usage.cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens: usage.cacheWrite1hTokens } : {}),
    ...(usage.thoughtTokens !== undefined ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.toolTokens !== undefined ? { toolTokens: usage.toolTokens } : {}),
    contextTokens: usage.contextTokens,
    totalTokens: usage.totalTokens,
    source: usage.source
  };
}

function sessionActivity(calls: EligibleCall[]): SessionVitalV0["activity"] | undefined {
  const activity = calls.map((call) => call.activity).filter((value) => value !== undefined);
  if (activity.length === 0) return undefined;
  if (activity.some((item) => !validActivityCount(item.promptCount) ||
      !validActivityCount(item.toolCallCount))) {
    return undefined;
  }
  const workTypes = [...new Set(activity.map((item) => `${item.kind}\u0000${item.action}`))];
  if (workTypes.length !== 1) return undefined;
  const [kind, action] = workTypes[0]!.split("\u0000") as [
    LocalAgentActivity["kind"],
    LocalAgentActivity["action"]
  ];
  return {
    kind,
    action,
    // Parsers can attach the same cumulative activity snapshot to several turns;
    // max preserves that evidence without multiplying it by the turn count.
    promptCount: Math.max(...activity.map((item) => item.promptCount)),
    toolCallCount: Math.max(...activity.map((item) => item.toolCallCount))
  };
}

function sessionType(
  calls: EligibleCall[],
  hasSubagentIdentity: boolean
): SessionVitalV0["sessionType"] {
  const flags = [...new Set(calls.flatMap((call) =>
    call.activity ? [call.activity.isSubagent] : []
  ))];
  if (hasSubagentIdentity) {
    // A per-transcript subagent identity is itself subagent evidence (the
    // host only writes agentId onto sidechain lines). An explicit
    // contradicting parent flag still fails closed to unknown.
    return flags.every((flag) => flag === true) ? "subagent" : "unknown";
  }
  if (flags.length !== 1) return "unknown";
  return flags[0] ? "subagent" : "parent";
}

/** The group key already splits by subagentId; mixed groups fail to none. */
function oneSubagentId(calls: EligibleCall[]): string | undefined {
  const values = [...new Set(calls.map((call) => call.subagentId))];
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Latest host-recorded completion per subagent run, joined across transcript
 * files. Claude Code writes a subagent's completion (Task tool result) into
 * the owning transcript, never into the subagent's own file.
 */
function subagentCompletionsByIdentity(
  calls: readonly EligibleCall[]
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const call of calls) {
    for (const record of call.subagentCompletions ?? []) {
      const observedAt = normalizedTimestamp(record.observedAt);
      if (!record.subagentId || !observedAt) continue;
      const key = subagentCompletionKey(call.agent, call.sessionId, record.subagentId);
      const prior = latest.get(key);
      if (!prior || Date.parse(observedAt) > Date.parse(prior)) {
        latest.set(key, observedAt);
      }
    }
  }
  return latest;
}

function subagentCompletionKey(
  agent: SessionVitalsAgentV0,
  sessionId: string,
  subagentId: string
): string {
  return `${agent}\u0000${sessionId}\u0000${subagentId}`;
}

function safeSourceVersions(calls: EligibleCall[]): string[] {
  const observed = calls.map((call) => call.sourceVersion?.trim());
  // Partial host-version evidence is still missing at the session boundary;
  // it cannot support an exact-version cohort claim.
  if (observed.some((value) => !value)) return [];
  const safe = (observed as string[]).map(safeSourceVersion);
  if (safe.some((value) => value === undefined)) return [];
  return [...new Set(safe as string[])].sort();
}

function sessionCompletion(
  calls: EligibleCall[],
  observedTo: string,
  crossFileObservedAt?: string
): SessionVitalsCompletionV0 {
  const expectedEvidence = calls[0]!.agent === "claude-code"
    ? "claude_turn_duration" as const
    : "codex_task_complete" as const;
  const completions = calls.map((call) => call.completion);
  if (completions.every((completion) => completion === undefined)) {
    // Subagent transcripts carry no in-file completion marker; the owning
    // transcript's Task tool result is the host's explicit completion
    // evidence for that run. A record older than the run's last observed
    // activity contradicts itself and fails closed.
    if (crossFileObservedAt !== undefined) {
      const normalized = normalizedTimestamp(crossFileObservedAt);
      if (normalized && Date.parse(normalized) >= Date.parse(observedTo)) {
        return {
          status: "completed",
          evidence: "claude_task_result",
          observedAt: normalized
        };
      }
      return {
        status: "missing",
        evidence: "missing",
        reason: "inconsistent_completion_evidence"
      };
    }
    return {
      status: "missing",
      evidence: "missing",
      reason: "completion_marker_not_observed"
    };
  }
  if (completions.some((completion) =>
    !completion || completion.status !== "completed" ||
    completion.evidence !== expectedEvidence ||
    normalizedTimestamp(completion.observedAt) === undefined ||
    Date.parse(completion.observedAt) < Date.parse(observedTo)
  )) {
    return {
      status: "missing",
      evidence: "missing",
      reason: "inconsistent_completion_evidence"
    };
  }
  const normalized = completions.map((completion) =>
    normalizedTimestamp(completion!.observedAt)!
  );
  if (new Set(normalized).size !== 1) {
    return {
      status: "missing",
      evidence: "missing",
      reason: "inconsistent_completion_evidence"
    };
  }
  return {
    status: "completed",
    evidence: expectedEvidence,
    observedAt: normalized[0]!
  };
}

function safeSourceVersion(value: string): string | undefined {
  const sanitized = safeMetadata(value, 96);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sanitized)
    ? sanitized
    : undefined;
}

function latestRateLimits(calls: EligibleCall[]): SessionVitalV0["rateLimits"] | undefined {
  const candidates = calls
    .map((call) => call.rateLimits)
    .filter((value) => value && normalizedTimestamp(value.observedAt))
    .sort((left, right) => Date.parse(right!.observedAt) - Date.parse(left!.observedAt));
  const latest = candidates[0];
  if (!latest) return undefined;
  const windows = latest.windows.flatMap((window): SessionVitalsRateLimitWindowV0[] => {
    const name = safeMetadata(window.name, 80);
    const resetsAt = normalizedTimestamp(window.resetsAt);
    if (!name || !resetsAt ||
        !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 ||
        !Number.isSafeInteger(window.windowMinutes) || window.windowMinutes <= 0) {
      return [];
    }
    return [{
      kind: window.kind,
      name,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetsAt
    }];
  });
  if (windows.length === 0) return undefined;
  const planType = safeMetadata(latest.planType ?? "", 80);
  return {
    observedAt: normalizedTimestamp(latest.observedAt)!,
    ...(planType ? { planType } : {}),
    windows
  };
}

function oneSafeProject(calls: EligibleCall[]): string | undefined {
  const observed = calls
    .map((call) => call.project?.trim())
    .filter((value): value is string => Boolean(value));
  // Do not let one safe-looking label override conflicting path-shaped or
  // placeholder metadata elsewhere in the same session.
  if (observed.some((value) => safeProject(value) === undefined)) return undefined;
  const projects = [...new Set(observed.map((value) => safeProject(value)!))];
  return projects.length === 1 ? projects[0] : undefined;
}

function oneProjectRef(calls: EligibleCall[]): string | undefined {
  const observed = calls.map((call) => {
    const supplied = call.workingDirectoryRef?.trim();
    const directory = call.workingDirectory?.trim();
    const derived = directory && directory.length <= 4_096 && !hasControl(directory)
      ? projectRefForWorkingDirectory(directory)
      : undefined;
    if (supplied && (!/^avref_[a-f0-9]{64}$/.test(supplied) || derived && supplied !== derived)) {
      return undefined;
    }
    return supplied || derived;
  });
  if (observed.some((value) => !value)) {
    return undefined;
  }
  const references = [...new Set(observed as string[])];
  return references.length === 1 ? references[0] : undefined;
}

function projectRefForWorkingDirectory(directory: string): string {
  return `avref_${createHash("sha256")
    .update("project-working-directory")
    .update("\u0000")
    .update(directory)
    .digest("hex")}`;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function safeProject(value: string | undefined): string | undefined {
  if (!value || value === "(home)" || /[\\/]/.test(value)) return undefined;
  return safeMetadata(value, 120) || undefined;
}

function safeMetadata(value: string, maxLength: number): string {
  return sanitizeLocalActivityText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function pseudonymousSessionRef(
  agent: SessionVitalsAgentV0,
  sessionId: string,
  subagentId?: string
): string {
  const hash = createHash("sha256").update(agent).update("\u0000").update(sessionId);
  if (subagentId !== undefined) {
    // Domain-separated so a subagent ref can never collide with a plain
    // session ref, while parent refs stay byte-identical to their pre-split
    // values (existing action-verification records keep matching).
    hash.update("\u0000subagent\u0000").update(subagentId);
  }
  return `avref_${hash.digest("hex")}`;
}

function validUsage(call: LocalAgentCall): boolean {
  return [
    call.usage.inputTokens,
    call.usage.outputTokens,
    call.usage.cacheReadTokens,
    call.usage.cacheWrite5mTokens,
    call.usage.cacheWrite1hTokens,
    call.usage.thoughtTokens,
    call.usage.toolTokens,
    call.reportedTotalTokens
  ].every(validOptionalCount);
}

function validTurnUsage(usage: LocalAgentTurnUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWrite5mTokens,
    usage.cacheWrite1hTokens,
    usage.thoughtTokens,
    usage.toolTokens,
    usage.contextTokens,
    usage.totalTokens
  ].every(validOptionalCount) && usage.totalTokens >= usage.contextTokens;
}

function validOptionalCount(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value) && value >= 0;
}

function validActivityCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sum(calls: EligibleCall[], select: (call: EligibleCall) => number): number {
  return calls.reduce((total, call) => total + select(call), 0);
}

function completeSum(
  calls: EligibleCall[],
  select: (call: EligibleCall) => number | undefined
): number | undefined {
  const values = calls.map(select);
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((total, value) => total + value, 0)
    : undefined;
}

function normalizedTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function validObservedTimestamp(value: string): boolean {
  return normalizedTimestamp(value) !== undefined;
}
