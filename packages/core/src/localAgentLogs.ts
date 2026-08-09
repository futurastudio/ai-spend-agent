import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { estimateTokenCostUsd, type TokenUsage } from "./modelPricing.js";
import type { UsageRecord } from "./schema.js";
import { redactSecrets } from "./discovery.js";
import {
  createCodexInvocationCollector,
  type ParsedInvocationFile
} from "./toolInvocations.js";

/**
 * Local agent-session log ingestion: turns the transcript files that coding
 * agents already write on this machine into UsageRecords, priced at
 * API-equivalent rates ("estimated" confidence).
 *
 * Why this exists: subscription usage (Claude Max, ChatGPT plans) has NO
 * billing API — local logs are the only place that spend is visible. This is
 * also what makes the zero-key first run show REAL numbers.
 *
 * Supported agents:
 *  - Claude Code: ~/.claude/projects/** /*.jsonl — one JSON object per line;
 *    assistant messages carry message.usage token counts.
 *  - Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — event stream;
 *    the LAST event_msg/token_count carries the session's cumulative
 *    total_token_usage (earlier ones are running updates — never summed).
 */

export type LocalAgentCall = {
  agent: "claude-code" | "codex";
  model: string;
  /** ISO timestamp of this call, or the latest cumulative usage event. */
  timestamp: string;
  /** ISO session start when the transcript format reports it separately. */
  startedAt?: string;
  /** Project attribution derived from the session's working directory. */
  project?: string;
  /**
   * Internal absolute working directory observed in the local transcript.
   * Renderers must not expose it; adapters use it only to scope local inventory
   * reads to the same repository as the active session.
   */
  workingDirectory?: string;
  /**
   * Numeric-only usage for the latest observed model turn. Codex reports this
   * separately from cumulative `total_token_usage`; Claude assistant-message
   * usage is already turn-scoped. Context Health uses this field so a long
   * session lifetime is never compared with a short session's final turn.
   */
  latestTurnUsage?: LocalAgentTurnUsage;
  /** Whether `usage` is one model turn or the session's cumulative financial total. */
  usageScope?: "turn" | "session_cumulative";
  /**
   * Whether the transcript exposed the input/output components required for
   * pricing. A total-only snapshot is still usage evidence, but pricing it as
   * zero would be false precision.
   */
  usageSupport?: "complete" | "unsupported_token_shape";
  /** Provider-reported total retained when component fields are unavailable. */
  reportedTotalTokens?: number;
  usage: TokenUsage;
  sessionId?: string;
  /** Provider-reported plan windows embedded in the transcript, when present. */
  rateLimits?: LocalAgentRateLimitSnapshot;
  /**
   * Privacy-conscious work summary derived locally from prompt/tool metadata.
   * Raw prompt text never leaves the parser or enters the Glance snapshot.
   */
  activity?: LocalAgentActivity;
};

/**
 * Resolve the repository root most recently observed in transcript metadata.
 *
 * CLI, MCP, and Glance use this only to scope read-only project inventory when
 * the caller did not explicitly choose a path. Absolute working directories
 * never enter rendered output.
 */
export function latestObservedWorkingDirectory(
  calls: readonly LocalAgentCall[]
): string | undefined {
  return calls
    .filter((call) => call.workingDirectory)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0]
    ?.workingDirectory;
}

export type LocalAgentTurnUsage = TokenUsage & {
  /** Input-side context observed for this turn, including cached/write tokens. */
  contextTokens: number;
  /** Context plus output tokens for this turn. */
  totalTokens: number;
  source: "assistant_message_usage" | "transcript_last_token_usage" | "call_usage";
};

export type LocalAgentActivity = {
  summary: string;
  kind: "task" | "automation" | "agent" | "file" | "project";
  action:
    | "building"
    | "refining"
    | "fixing"
    | "testing"
    | "auditing"
    | "researching"
    | "configuring"
    | "publishing"
    | "running"
    | "working";
  source: "agent_title" | "user_prompts" | "file_activity" | "project";
  promptCount: number;
  toolCallCount: number;
  /** Basenames only, ordered by observed tool activity. */
  files: string[];
  isSubagent: boolean;
  parentSessionId?: string;
};

export type LocalAgentRateLimitWindow = {
  kind: "five-hour" | "weekly" | "custom";
  name: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type LocalAgentRateLimitSnapshot = {
  observedAt: string;
  limitId?: string;
  planType?: string;
  windows: LocalAgentRateLimitWindow[];
};

export type LocalAgentLogOptions = {
  /** Default: ~/.claude/projects */
  claudeProjectsDir?: string;
  /** Default: ~/.codex/sessions */
  codexSessionsDir?: string;
  /** Only include calls at/after this ISO timestamp. */
  sinceIso?: string;
  /** Collect privacy-safe Codex invocation summaries during the same JSON pass. */
  collectCodexInvocationEvidence?: boolean;
};

export type LocalAgentLogDiagnosticCode =
  | "directory_missing"
  | "directory_unreadable"
  | "file_unreadable"
  | "malformed_jsonl"
  | "unsupported_token_shape";

export type LocalAgentLogDiagnostic = {
  agent: LocalAgentCall["agent"];
  code: LocalAgentLogDiagnosticCode;
  severity: "info" | "warning" | "error";
  /** Privacy-safe summary; absolute local paths and transcript text are omitted. */
  message: string;
  count: number;
};

export type LocalAgentSourceScan = {
  agent: LocalAgentCall["agent"];
  directoryStatus: "readable" | "missing" | "unreadable";
  filesDiscovered: number;
  filesParsed: number;
  malformedLines: number;
  unreadableFiles: number;
  unsupportedUsageSnapshots: number;
};

export type LocalAgentLogResult = {
  records: UsageRecord[];
  /** Per-call entries before aggregation (for drill-down/debugging). */
  calls: LocalAgentCall[];
  filesParsed: number;
  /** Which agents actually had data on this machine. */
  agentsDetected: Array<LocalAgentCall["agent"]>;
  /** Per-source scan outcome, including honest empty and unsupported states. */
  sourceScans: LocalAgentSourceScan[];
  /** Structured, privacy-safe failures/warnings encountered during the scan. */
  diagnostics: LocalAgentLogDiagnostic[];
  /** Present only when requested; contains counts/basenames, never raw text. */
  codexInvocationFiles?: ParsedInvocationFile[];
};

type TranscriptParseDiagnostic = {
  code: "malformed_jsonl" | "unsupported_token_shape";
  count: number;
};

type TranscriptParseDiagnosticHandler = (diagnostic: TranscriptParseDiagnostic) => void;

/**
 * Codex rollout/compaction files can repeat the same session's cumulative
 * token counter. Keep only the latest snapshot per session so financial value,
 * Glance, and project totals never add cumulative checkpoints together.
 * Turn-scoped Claude calls and calls without a stable session id are retained.
 */
export function dedupeCumulativeSessionCalls(calls: LocalAgentCall[]): LocalAgentCall[] {
  const retained: LocalAgentCall[] = [];
  const cumulative = new Map<string, LocalAgentCall>();
  for (const call of calls) {
    if (call.usageScope !== "session_cumulative" || !call.sessionId) {
      retained.push(call);
      continue;
    }
    const key = `${call.agent}:${call.sessionId}`;
    const prior = cumulative.get(key);
    if (!prior || isLaterCumulativeSnapshot(call, prior)) {
      cumulative.set(key, call);
    }
  }
  return [...retained, ...cumulative.values()];
}

function isLaterCumulativeSnapshot(candidate: LocalAgentCall, prior: LocalAgentCall): boolean {
  const timestampOrder = candidate.timestamp.localeCompare(prior.timestamp);
  if (timestampOrder !== 0) return timestampOrder > 0;
  return totalUsageTokens(candidate.usage) > totalUsageTokens(prior.usage);
}

function totalUsageTokens(usage: TokenUsage): number {
  return usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0);
}

/** Parse one Claude Code transcript (JSONL). Exported for tests. */
export function parseClaudeCodeTranscript(
  content: string,
  filePath = "",
  sinceMs?: number,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall[] {
  const calls: LocalAgentCall[] = [];
  const seen = new Set<string>();
  const pendingPrompts: string[] = [];
  const activityEvidence = new Map<string, {
    prompts: string[];
    files: Map<string, number>;
    toolCallCount: number;
  }>();
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let latestActivityKey: string | undefined;
  let isSubagent = filePath.split(sep).includes("subagents");
  let parentSessionId: string | undefined;
  let malformedLines = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === "ai-title") {
      title = stringOf(entry.aiTitle) ?? title;
    }
    if (entry.type === "last-prompt") {
      lastPrompt = stringOf(entry.lastPrompt) ?? lastPrompt;
    }
    if (entry.isSidechain === true) isSubagent = true;
    parentSessionId = stringOf(entry.parentSessionId) ?? parentSessionId;

    const message = isRecord(entry.message) ? entry.message : undefined;
    if (entry.type === "user" && message) {
      for (const prompt of textValues(message.content)) {
        if (isHumanPrompt(prompt)) pendingPrompts.push(prompt);
      }
    }
    if (entry.type !== "assistant") continue;
    const usage = message && isRecord(message.usage) ? message.usage : undefined;
    if (!message || !usage) continue;
    // "<synthetic>" marks Claude Code internal placeholder messages, not API calls.
    if (stringOf(message.model) === "<synthetic>") continue;
    // Streaming/retries can write the same API response on multiple lines.
    const dedupeKey = `${stringOf(message.id) ?? ""}:${stringOf(entry.requestId) ?? ""}`;
    if (dedupeKey !== ":" && seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const timestamp = toIso(stringOf(entry.timestamp)) ?? new Date(0).toISOString();
    if (typeof sinceMs === "number" && Date.parse(timestamp) < sinceMs) {
      // These prompts led to a call outside the selected evidence window. Do
      // not let them become the focus of a later in-window project/call.
      pendingPrompts.length = 0;
      continue;
    }
    const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
    const write5m = numberOf(cacheCreation?.ephemeral_5m_input_tokens);
    const write1h = numberOf(cacheCreation?.ephemeral_1h_input_tokens);
    const writeTotal = numberOf(usage.cache_creation_input_tokens) ?? 0;
    const parsedUsage: TokenUsage = {
      inputTokens: numberOf(usage.input_tokens) ?? 0,
      outputTokens: numberOf(usage.output_tokens) ?? 0,
      cacheReadTokens: numberOf(usage.cache_read_input_tokens) ?? 0,
      // Prefer the 5m/1h breakdown; fall back to the total as 5m (cheaper bound).
      cacheWrite5mTokens: write5m ?? writeTotal,
      cacheWrite1hTokens: write1h ?? 0
    };
    const workingDirectory = absoluteWorkingDirectory(stringOf(entry.cwd));
    const project = projectFromCwd(workingDirectory) ?? projectFromTranscriptPath(filePath);
    const sessionId = stringOf(entry.sessionId);
    const call: LocalAgentCall = {
      agent: "claude-code",
      model: stringOf(message.model) ?? "claude-code",
      timestamp,
      project,
      workingDirectory,
      sessionId,
      latestTurnUsage: toTurnUsage(parsedUsage, "assistant_message_usage"),
      usageScope: "turn",
      usage: parsedUsage
    };
    calls.push(call);

    const activityKey = localActivityScopeKey(sessionId, workingDirectory, project);
    const evidence = activityEvidence.get(activityKey) ?? {
      prompts: [],
      files: new Map<string, number>(),
      toolCallCount: 0
    };
    evidence.prompts.push(...pendingPrompts);
    pendingPrompts.length = 0;
    for (const item of recordValues(message.content)) {
      if (item.type !== "tool_use") continue;
      evidence.toolCallCount += 1;
      collectToolFiles(item.input, evidence.files);
    }
    activityEvidence.set(activityKey, evidence);
    latestActivityKey = activityKey;
  }
  const fallbackPrompt = lastPrompt && isHumanPrompt(lastPrompt) ? lastPrompt : undefined;
  const activities = new Map<string, LocalAgentActivity>();
  for (const [activityKey, evidence] of activityEvidence) {
    const matchingCall = calls.find((call) => (
      localActivityScopeKey(call.sessionId, call.workingDirectory, call.project) === activityKey
    ));
    const isLatest = activityKey === latestActivityKey;
    const activity = buildLocalAgentActivity({
      title: isLatest ? title : undefined,
      prompts: evidence.prompts.length > 0
        ? evidence.prompts
        : isLatest && fallbackPrompt
          ? [fallbackPrompt]
          : [],
      files: evidence.files,
      toolCallCount: evidence.toolCallCount,
      project: matchingCall?.project ?? projectFromTranscriptPath(filePath),
      isSubagent,
      parentSessionId
    });
    if (activity) activities.set(activityKey, activity);
  }
  for (const call of calls) {
    call.activity = activities.get(
      localActivityScopeKey(call.sessionId, call.workingDirectory, call.project)
    );
  }
  if (malformedLines > 0) {
    onDiagnostic?.({ code: "malformed_jsonl", count: malformedLines });
  }
  return calls;
}

/** Parse one Codex rollout file (JSONL event stream). Exported for tests. */
export function parseCodexRollout(
  content: string,
  onEntry?: (entry: Record<string, unknown>) => void,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall[] {
  let model: string | undefined;
  let rootCwd: string | undefined;
  const toolWorkdirs = new Map<string, number>();
  let sessionId: string | undefined;
  let rootSessionMetaSeen = false;
  let startedAt: string | undefined;
  let rootStartedAtMs: number | undefined;
  let rootTaskStarted = false;
  let inheritedUsageBaseline: Record<string, unknown> | undefined;
  let lastActivityAt: string | undefined;
  let lastTotal: Record<string, unknown> | undefined;
  let lastTurn: Record<string, unknown> | undefined;
  let lastRateLimits: LocalAgentRateLimitSnapshot | undefined;
  const prompts: string[] = [];
  const fileCounts = new Map<string, number>();
  let toolCallCount = 0;
  let isSubagent = false;
  let parentSessionId: string | undefined;
  let malformedLines = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!isRecord(entry)) continue;
    onEntry?.(entry);
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (entry.type === "session_meta" && payload && !rootSessionMetaSeen) {
      // A forked/subagent rollout can embed the parent transcript, including
      // many later session_meta records. The first metadata record belongs to
      // this rollout file; later records are nested/history evidence and must
      // never replace the financial session identity or root cwd.
      rootSessionMetaSeen = true;
      sessionId = stringOf(payload.id);
      rootCwd = stringOf(payload.cwd);
      startedAt = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp));
      rootStartedAtMs = timestampMilliseconds(payload.timestamp ?? entry.timestamp);
      isSubagent = stringOf(payload.thread_source) === "subagent" || isRecord(payload.source) && "subagent" in payload.source;
      parentSessionId = stringOf(payload.parent_thread_id);
    }
    if (entry.type === "turn_context" && payload) {
      model = stringOf(payload.model) ?? model;
      rootCwd ??= stringOf(payload.cwd);
    }
    if (
      isSubagent &&
      !rootTaskStarted &&
      payload?.type === "task_started" &&
      isRootSpecificTaskStart(payload.started_at, rootStartedAtMs)
    ) {
      // Forked Codex rollouts copy the parent's complete event history after
      // the child's root session_meta. The cumulative counter immediately
      // before the child's first task is the inherited baseline, not child
      // usage. Reset qualitative evidence at the same boundary so parent
      // prompts/files cannot become the child's focus.
      inheritedUsageBaseline = lastTotal;
      lastTotal = undefined;
      rootTaskStarted = true;
      prompts.length = 0;
      fileCounts.clear();
      toolWorkdirs.clear();
      toolCallCount = 0;
      model = undefined;
      lastTurn = undefined;
      lastRateLimits = undefined;
      lastActivityAt = toIso(stringOf(entry.timestamp)) ?? startedAt;
    }
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      toolCallCount += 1;
      const args = jsonRecord(stringOf(payload.arguments));
      const workdir = stringOf(args?.workdir) ?? stringOf(args?.cwd);
      if (workdir && isAbsolute(workdir)) {
        const normalized = resolve(workdir);
        toolWorkdirs.set(normalized, (toolWorkdirs.get(normalized) ?? 0) + 1);
      }
      // Current Codex Desktop records the orchestration wrapper as a custom
      // `exec` call whose input is JavaScript containing nested tool calls.
      // Extract only quoted absolute workdir/cwd values; never evaluate it.
      if (payload.type === "custom_tool_call" && stringOf(payload.name) === "exec") {
        collectEmbeddedToolWorkdirs(stringOf(payload.input), toolWorkdirs);
      }
      collectToolFiles(args, fileCounts);
      collectPatchFiles(
        stringOf(args?.patch) ?? stringOf(args?.input) ?? stringOf(payload.input),
        fileCounts
      );
    }
    if (payload?.type === "message" && payload.role === "user") {
      for (const prompt of textValues(payload.content)) {
        if (isHumanPrompt(prompt)) prompts.push(prompt);
      }
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      const eventTimestamp = toIso(stringOf(entry.timestamp)) ?? lastActivityAt ?? startedAt;
      const info = isRecord(payload.info) ? payload.info : undefined;
      const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
      const turn = info && isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
      if (total) {
        lastTotal = total;
        lastActivityAt = eventTimestamp;
      }
      if (turn) {
        lastTurn = turn;
        lastActivityAt = eventTimestamp;
      }
      const rateLimits = parseCodexRateLimits(payload.rate_limits, eventTimestamp);
      if (rateLimits) {
        lastRateLimits = rateLimits;
      }
    }
  }
  // A fork without a recognized root-task boundary is ambiguous: older Codex
  // formats may contain only inherited parent history. Omitting that child is
  // safer than charging the parent cumulative counter again. Likewise, a
  // recognized boundary with no later total_token_usage is not a financial
  // call yet.
  if (malformedLines > 0) {
    onDiagnostic?.({ code: "malformed_jsonl", count: malformedLines });
  }
  if (!lastTotal || isSubagent && !rootTaskStarted) return [];
  const rawInput = numberOf(lastTotal.input_tokens);
  const rawOutput = numberOf(lastTotal.output_tokens);
  const rawCached = numberOf(lastTotal.cached_input_tokens);
  const rawReportedTotal = numberOf(lastTotal.total_tokens);
  const baselineInput = numberOf(inheritedUsageBaseline?.input_tokens);
  const baselineOutput = numberOf(inheritedUsageBaseline?.output_tokens);
  const baselineReportedTotal = numberOf(inheritedUsageBaseline?.total_tokens);
  const currentComponentsComplete = rawInput !== undefined && rawOutput !== undefined && !(
    (rawReportedTotal ?? 0) > 0 && rawInput === 0 && rawOutput === 0
  );
  const baselineComponentsComplete = !inheritedUsageBaseline || (
    baselineInput !== undefined && baselineOutput !== undefined && !(
      (baselineReportedTotal ?? 0) > 0 && baselineInput === 0 && baselineOutput === 0
    )
  );
  const usageSupport = currentComponentsComplete && baselineComponentsComplete
    ? "complete" as const
    : "unsupported_token_shape" as const;
  if (usageSupport === "unsupported_token_shape") {
    onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  }
  const input = Math.max(
    0,
    (rawInput ?? 0) - (baselineInput ?? 0)
  );
  const cached = Math.max(
    0,
    (rawCached ?? 0) -
      (numberOf(inheritedUsageBaseline?.cached_input_tokens) ?? 0)
  );
  const output = Math.max(
    0,
    (rawOutput ?? 0) - (baselineOutput ?? 0)
  );
  const reportedTotalTokens = rawReportedTotal === undefined
    ? undefined
    : Math.max(0, rawReportedTotal - (baselineReportedTotal ?? 0));
  const latestTurnUsage = lastTurn
    ? codexTurnUsage(lastTurn)
    : undefined;
  const workingDirectory = absoluteWorkingDirectory(dominantCodexCwd(rootCwd, toolWorkdirs));
  const project = projectFromCwd(workingDirectory);
  const activity = buildLocalAgentActivity({
    prompts,
    files: fileCounts,
    toolCallCount,
    project,
    isSubagent,
    parentSessionId
  });
  return [{
    agent: "codex",
    model: model ?? "codex",
    timestamp: lastActivityAt ?? startedAt ?? new Date(0).toISOString(),
    startedAt,
    project,
    workingDirectory,
    sessionId,
    rateLimits: lastRateLimits,
    activity,
    latestTurnUsage,
    usageScope: "session_cumulative",
    usageSupport,
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {}),
    usage: {
      // Codex input_tokens INCLUDES cached tokens; split them out.
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      cacheReadTokens: cached
    }
  }];
}

function collectEmbeddedToolWorkdirs(
  input: string | undefined,
  toolWorkdirs: Map<string, number>
): void {
  if (!input) return;
  const fieldPattern = /(?:^|[^A-Za-z0-9_])["']?(?:workdir|cwd)["']?\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of input.matchAll(fieldPattern)) {
    let value: unknown;
    try {
      value = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    if (typeof value !== "string" || !isAbsolute(value)) continue;
    const normalized = resolve(value);
    toolWorkdirs.set(normalized, (toolWorkdirs.get(normalized) ?? 0) + 1);
  }
}

function parseCodexRateLimits(
  value: unknown,
  observedAt: string | undefined
): LocalAgentRateLimitSnapshot | undefined {
  if (!isRecord(value) || !observedAt) return undefined;
  const windows = [value.primary, value.secondary]
    .map((window) => parseCodexRateLimitWindow(window))
    .filter((window): window is LocalAgentRateLimitWindow => Boolean(window));
  if (windows.length === 0) return undefined;
  return {
    observedAt,
    limitId: stringOf(value.limit_id),
    planType: stringOf(value.plan_type),
    windows
  };
}

function parseCodexRateLimitWindow(value: unknown): LocalAgentRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberOf(value.used_percent);
  const windowMinutes = numberOf(value.window_minutes);
  const resetsAtSeconds = numberOf(value.resets_at);
  if (
    usedPercent === undefined ||
    windowMinutes === undefined ||
    windowMinutes <= 0 ||
    resetsAtSeconds === undefined
  ) {
    return undefined;
  }
  const resetMs = resetsAtSeconds < 1_000_000_000_000
    ? resetsAtSeconds * 1_000
    : resetsAtSeconds;
  const resetsAt = toIso(new Date(resetMs).toISOString());
  if (!resetsAt) return undefined;
  const kind = windowMinutes === 300
    ? "five-hour"
    : windowMinutes === 10_080
      ? "weekly"
      : "custom";
  return {
    kind,
    name: kind === "custom" ? `${windowMinutes}-minute` : kind,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt
  };
}

/** Scan this machine's agent logs and return aggregated UsageRecords. */
export async function loadLocalAgentUsage(options: LocalAgentLogOptions = {}): Promise<LocalAgentLogResult> {
  const home = homedir();
  const claudeDir = options.claudeProjectsDir ?? join(home, ".claude", "projects");
  const codexDir = options.codexSessionsDir ?? join(home, ".codex", "sessions");
  const calls: LocalAgentCall[] = [];
  const codexInvocationFiles = options.collectCodexInvocationEvidence
    ? [] as ParsedInvocationFile[]
    : undefined;
  let filesParsed = 0;
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;
  const diagnostics: LocalAgentLogDiagnostic[] = [];
  const sourceScans: LocalAgentSourceScan[] = [
    emptySourceScan("claude-code"),
    emptySourceScan("codex")
  ];
  const claudeScan = sourceScans[0]!;
  const codexScan = sourceScans[1]!;

  for (const file of await listJsonlFiles(claudeDir, claudeScan, diagnostics)) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      recordUnreadableFile("claude-code", claudeScan, diagnostics, error);
      continue;
    }
    if (!content) continue;
    filesParsed += 1;
    claudeScan.filesParsed += 1;
    calls.push(...parseClaudeCodeTranscript(content, file, sinceMs, (diagnostic) => {
      recordParseDiagnostic("claude-code", claudeScan, diagnostics, diagnostic);
    }));
  }
  for (const file of await listJsonlFiles(codexDir, codexScan, diagnostics)) {
    if (!basename(file).startsWith("rollout-")) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      recordUnreadableFile("codex", codexScan, diagnostics, error);
      continue;
    }
    if (!content) continue;
    filesParsed += 1;
    codexScan.filesParsed += 1;
    const collector = codexInvocationFiles
      ? createCodexInvocationCollector(sinceMs)
      : undefined;
    calls.push(...parseCodexRollout(content, collector?.consume, (diagnostic) => {
      recordParseDiagnostic("codex", codexScan, diagnostics, diagnostic);
    }));
    if (collector) codexInvocationFiles!.push(collector.finish());
  }

  const normalizedCalls = dedupeCumulativeSessionCalls(calls);
  const filtered = typeof sinceMs === "number"
    ? normalizedCalls.filter((call) => Date.parse(call.timestamp) >= sinceMs)
    : normalizedCalls;

  return {
    records: aggregateCalls(filtered),
    calls: filtered,
    filesParsed,
    agentsDetected: [...new Set(filtered.map((call) => call.agent))],
    sourceScans,
    diagnostics,
    ...(codexInvocationFiles ? { codexInvocationFiles } : {})
  };
}

/** Aggregate per-call usage into one UsageRecord per day+agent+model+project. */
export function aggregateCalls(calls: LocalAgentCall[]): UsageRecord[] {
  const groups = new Map<string, LocalAgentCall[]>();
  for (const call of dedupeCumulativeSessionCalls(calls)) {
    const day = call.timestamp.slice(0, 10);
    const key = [day, call.agent, call.model, call.project ?? "unattributed"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }

  const records: UsageRecord[] = [];
  for (const [key, groupCalls] of groups) {
    const [day, agent, model, project] = key.split("|") as [string, LocalAgentCall["agent"], string, string];
    const usage: TokenUsage = {
      inputTokens: sum(groupCalls, (c) => c.usage.inputTokens),
      outputTokens: sum(groupCalls, (c) => c.usage.outputTokens),
      cacheReadTokens: sum(groupCalls, (c) => c.usage.cacheReadTokens ?? 0),
      cacheWrite5mTokens: sum(groupCalls, (c) => c.usage.cacheWrite5mTokens ?? 0),
      cacheWrite1hTokens: sum(groupCalls, (c) => c.usage.cacheWrite1hTokens ?? 0)
    };
    const usageSupported = groupCalls.every((call) => call.usageSupport !== "unsupported_token_shape");
    const amountUsd = usageSupported ? estimateTokenCostUsd(model, usage) : undefined;
    const priced = usageSupported && typeof amountUsd === "number";
    records.push({
      id: slug(["local", agent, day, model, project].join("-")),
      timestamp: new Date(`${day}T00:00:00Z`).toISOString(),
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: agent === "claude-code" ? "anthropic" : "openai",
        confidence: "estimated",
        observedFrom: `${agent} transcript JSONL (this machine)`
      },
      model,
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0),
      outputTokens: usage.outputTokens,
      amountUsd: priced ? amountUsd : null,
      costConfidence: priced ? "estimated" : "missing",
      // `(home)` is an attribution fallback, not a real project. Keep it on
      // LocalAgentCall for Glance/session context, but do not promote it to a
      // high-confidence project id in receipts or the attribution engine.
      projectId: project === "unattributed" || project === "(home)" ? undefined : project,
      agentId: agent,
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate",
      quantity: groupCalls.length,
      operation: `${agent} sessions`
    });
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

async function listJsonlFiles(
  root: string,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[]
): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      scan.directoryStatus = "missing";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_missing",
        severity: "info",
        message: `${agentLabel(scan.agent)} transcript directory was not found.`,
        count: 1
      });
    } else {
      scan.directoryStatus = "unreadable";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_unreadable",
        severity: "error",
        message: `${agentLabel(scan.agent)} transcript directory could not be read${errorCodeSuffix(error)}.`,
        count: 1
      });
    }
    return [];
  }
  if (!rootStat.isDirectory()) {
    scan.directoryStatus = "unreadable";
    diagnostics.push({
      agent: scan.agent,
      code: "directory_unreadable",
      severity: "error",
      message: `${agentLabel(scan.agent)} transcript path is not a readable directory.`,
      count: 1
    });
    return [];
  }
  scan.directoryStatus = "readable";
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      scan.directoryStatus = "unreadable";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_unreadable",
        severity: "error",
        message: `${agentLabel(scan.agent)} transcript directory could not be read${errorCodeSuffix(error)}.`,
        count: 1
      });
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(path);
        scan.filesDiscovered += 1;
      }
    }
  }
  return out;
}

function emptySourceScan(agent: LocalAgentCall["agent"]): LocalAgentSourceScan {
  return {
    agent,
    directoryStatus: "readable",
    filesDiscovered: 0,
    filesParsed: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0
  };
}

function recordUnreadableFile(
  agent: LocalAgentCall["agent"],
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  error: unknown
): void {
  scan.unreadableFiles += 1;
  diagnostics.push({
    agent,
    code: "file_unreadable",
    severity: "error",
    message: `${agentLabel(agent)} transcript file could not be read${errorCodeSuffix(error)}.`,
    count: 1
  });
}

function recordParseDiagnostic(
  agent: LocalAgentCall["agent"],
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  diagnostic: TranscriptParseDiagnostic
): void {
  if (diagnostic.code === "malformed_jsonl") {
    scan.malformedLines += diagnostic.count;
    diagnostics.push({
      agent,
      code: diagnostic.code,
      severity: "warning",
      message: `${diagnostic.count} malformed JSONL line(s) were skipped in ${agentLabel(agent)} transcripts.`,
      count: diagnostic.count
    });
    return;
  }
  scan.unsupportedUsageSnapshots += diagnostic.count;
  diagnostics.push({
    agent,
    code: diagnostic.code,
    severity: "warning",
    message: `${diagnostic.count} ${agentLabel(agent)} token snapshot(s) lacked the input/output components required for pricing.`,
    count: diagnostic.count
  });
}

function agentLabel(agent: LocalAgentCall["agent"]): string {
  return agent === "claude-code" ? "Claude Code" : "Codex";
}

function errorCodeSuffix(error: unknown): string {
  const code = error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function projectFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Sessions launched from the home directory aren't a "project" — labeling
  // them with the username reads like a data bug on the by-project table.
  if (resolve(cwd) === resolve(homedir())) return "(home)";
  const name = basename(cwd);
  return name.length > 0 ? name : undefined;
}

function absoluteWorkingDirectory(cwd: string | undefined): string | undefined {
  return cwd && isAbsolute(cwd) ? resolve(cwd) : undefined;
}

/**
 * Codex can be launched from HOME and do nearly all of its work through tools
 * that declare a more specific working directory. Prefer that observed
 * activity only when the session-level cwd is not already a real project.
 * Nested tool directories roll up to the shallowest observed ancestor with
 * the strongest descendant-weighted activity.
 */
function dominantCodexCwd(
  sessionCwd: string | undefined,
  toolWorkdirs: Map<string, number>
): string | undefined {
  const sessionProject = projectFromCwd(sessionCwd);
  if (sessionProject && sessionProject !== "(home)") return sessionCwd;

  const home = resolve(homedir());
  const candidates = [...toolWorkdirs.entries()]
    .filter(([path]) => resolve(path) !== home);
  const scored = candidates.map(([candidate]) => ({
    candidate,
    score: candidates.reduce((total, [path, count]) => (
      path === candidate || path.startsWith(`${candidate}${sep}`)
        ? total + count
        : total
    ), 0)
  }));
  scored.sort((left, right) => (
    right.score - left.score ||
    left.candidate.split(sep).length - right.candidate.split(sep).length ||
    left.candidate.localeCompare(right.candidate)
  ));
  return scored[0]?.candidate ?? sessionCwd;
}

/** Claude Code encodes the project path into the transcript's parent dir name. */
function projectFromTranscriptPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const parent = basename(join(filePath, ".."));
  const tail = parent.split("-").filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : undefined;
}

type ActivityInput = {
  title?: string;
  prompts: string[];
  files: Map<string, number>;
  toolCallCount: number;
  project?: string;
  isSubagent: boolean;
  parentSessionId?: string;
};

function localActivityScopeKey(
  sessionId: string | undefined,
  workingDirectory: string | undefined,
  project: string | undefined
): string {
  // The absolute cwd stays inside this ephemeral parser key and is never
  // persisted or rendered. It prevents one transcript that changes projects
  // from attaching Project A's prompt/file evidence to Project B's calls.
  return [sessionId ?? "unknown-session", workingDirectory ?? project ?? "unattributed"].join("\u0000");
}

const FOCUS_STOP_WORDS = new Set([
  "about", "above", "after", "again", "also", "and", "are", "at", "been", "being", "but",
  "can", "check", "could", "did", "does", "doing", "dont", "every", "from",
  "for", "have", "here", "how", "in", "into", "its", "just", "like", "make", "more",
  "need", "not", "now", "on", "only", "other", "our", "please", "really", "should",
  "earlier", "is", "mentioned", "one", "something", "sure", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "thing", "think", "this", "through", "to", "too", "use", "user",
  "users", "want", "was", "way", "we", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "work", "working", "would", "you", "your",
  "redacted"
]);

const ACTION_WORDS: Array<{
  action: LocalAgentActivity["action"];
  words: Set<string>;
}> = [
  { action: "refining", words: new Set(["adjust", "change", "customize", "design", "edit", "improve", "refine", "revise", "update"]) },
  { action: "fixing", words: new Set(["bug", "debug", "fix", "repair", "resolve"]) },
  { action: "testing", words: new Set(["test", "testing", "validate", "verification", "verify"]) },
  { action: "auditing", words: new Set(["audit", "review", "status"]) },
  { action: "researching", words: new Set(["compare", "find", "investigate", "research"]) },
  { action: "configuring", words: new Set(["configure", "connect", "setup"]) },
  { action: "publishing", words: new Set(["deploy", "launch", "publish", "release"]) },
  { action: "running", words: new Set(["automation", "monitor", "run", "schedule"]) },
  { action: "building", words: new Set(["add", "build", "create", "develop", "implement", "include"]) }
];

function buildLocalAgentActivity(input: ActivityInput): LocalAgentActivity | undefined {
  // Prompt text is never retained, but derived topic tokens can still disclose
  // a credential if redaction happens only at persistence/output boundaries.
  // Sanitize before every title/topic/action derivation and again at output.
  const prompts = input.prompts
    .map(sanitizeLocalActivityText)
    .filter(isHumanPrompt);
  const topic = focusTopic(prompts);
  const title = cleanTitle(sanitizeLocalActivityText(input.title ?? ""));
  const files = [...input.files.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([file]) => sanitizeLocalActivityText(file))
    .filter(Boolean)
    .slice(0, 5);
  const action = inferAction(prompts, title);
  let source: LocalAgentActivity["source"];
  let kind: LocalAgentActivity["kind"];
  let subject: string;

  if (topic) {
    source = "user_prompts";
    kind = inferActivityKind(topic, input.isSubagent);
    subject = topic;
  } else if (title) {
    source = "agent_title";
    kind = inferActivityKind(title, input.isSubagent);
    subject = stripLeadingAction(title);
  } else if (files[0]) {
    source = "file_activity";
    kind = "file";
    subject = files[0];
  } else if (input.project) {
    source = "project";
    kind = "project";
    subject = sanitizeLocalActivityText(input.project);
  } else {
    return undefined;
  }

  if (!subject) return undefined;

  return {
    summary: sanitizeLocalActivityText(activitySummary(action, subject, source)),
    kind,
    action,
    source,
    promptCount: prompts.length,
    toolCallCount: input.toolCallCount,
    files,
    isSubagent: input.isSubagent,
    parentSessionId: input.parentSessionId
  };
}

function focusTopic(prompts: string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  const recent = prompts.slice(-12);
  const promptTokenSets = recent.map((prompt) => (
    new Set(topicTokens(prompt).filter((token) => !FOCUS_STOP_WORDS.has(token)))
  ));
  const observedTopicTokens = new Set(promptTokenSets.flatMap((tokens) => [...tokens]));

  // Recognized product/work concepts are meaningful even in one prompt. Generic
  // tokens must repeat across distinct prompts below; that keeps attachment
  // prose and one-off screenshot filenames from becoming a confident topic.
  if (observedTopicTokens.has("aibill") && observedTopicTokens.has("prompt")) {
    return "aibill prompt";
  }
  if (observedTopicTokens.has("glance") && observedTopicTokens.has("hover")) {
    return observedTopicTokens.has("ui") ? "Glance hover UI" : "Glance hover";
  }
  if (
    observedTopicTokens.has("glance") &&
    ["action", "agent", "handoff", "prompt"].some((token) => observedTopicTokens.has(token))
  ) {
    return "Glance agent handoff";
  }
  if (observedTopicTokens.has("landing") && observedTopicTokens.has("page")) return "landing page";
  if (observedTopicTokens.has("hover")) {
    return observedTopicTokens.has("ui") ? "hover UI" : "hover interaction";
  }
  if (observedTopicTokens.has("mcp")) {
    return observedTopicTokens.has("feature") ? "MCP feature" : "MCP";
  }
  if (observedTopicTokens.has("seo")) {
    return observedTopicTokens.has("strategy") ? "SEO strategy" : "SEO";
  }

  const promptOccurrences = new Map<string, number>();
  for (const tokens of promptTokenSets) {
    for (const token of tokens) {
      promptOccurrences.set(token, (promptOccurrences.get(token) ?? 0) + 1);
    }
  }
  const repeatedTokens = new Set(
    [...promptOccurrences.entries()]
      .filter(([, count]) => count >= 2)
      .map(([token]) => token)
  );
  if (repeatedTokens.size === 0) return undefined;

  const tokenScores = new Map<string, number>();
  const pairScores = new Map<string, number>();
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    const tokens = topicTokens(prompt)
      .filter((token) => !FOCUS_STOP_WORDS.has(token) && repeatedTokens.has(token));
    const unique = [...new Set(tokens)];
    for (const token of unique) {
      tokenScores.set(token, (tokenScores.get(token) ?? 0) + weight);
    }
    for (let pairIndex = 0; pairIndex < tokens.length - 1; pairIndex += 1) {
      const pair = `${tokens[pairIndex]} ${tokens[pairIndex + 1]}`;
      pairScores.set(pair, (pairScores.get(pair) ?? 0) + weight);
    }
  });

  const topPairs = [...pairScores.entries()]
    .filter(([, score]) => score >= 2.5)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const topTokens = [...tokenScores.entries()]
    .filter(([token]) => !isActionToken(token))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const candidateTokens = new Set<string>();
  for (const [pair] of topPairs.slice(0, 2)) {
    pair.split(" ").forEach((token) => candidateTokens.add(token));
  }
  for (const [token] of topTokens) {
    if (candidateTokens.size >= 3) break;
    candidateTokens.add(token);
  }
  if (candidateTokens.size === 0) return undefined;

  const tokens = [...candidateTokens].slice(0, 3);
  if (tokens.includes("hover")) {
    return tokens.includes("ui") ? "hover UI" : "hover interaction";
  }
  return tokens.map(displayToken).join(" ");
}

function inferAction(prompts: string[], title: string | undefined): LocalAgentActivity["action"] {
  const scores = new Map<LocalAgentActivity["action"], number>();
  const recent = prompts.slice(-12);
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    for (const token of promptTokens(prompt)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + weight);
        }
      }
    }
  });
  if (title) {
    for (const token of promptTokens(title)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + 0.75);
        }
      }
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "working";
}

function inferActivityKind(subject: string, isSubagent: boolean): LocalAgentActivity["kind"] {
  const tokens = new Set(promptTokens(subject));
  if (tokens.has("automation") || tokens.has("workflow") || tokens.has("schedule")) return "automation";
  if (tokens.has("agent") || tokens.has("subagent") || isSubagent) return "agent";
  return "task";
}

function activitySummary(
  action: LocalAgentActivity["action"],
  subject: string,
  source: LocalAgentActivity["source"]
): string {
  if (source === "project") return `Working in ${subject}`;
  const actionLabel = action[0]!.toUpperCase() + action.slice(1);
  return `${actionLabel} ${subject}`.replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return clean.length >= 3 && clean.length <= 96 ? clean : undefined;
}

function stripLeadingAction(value: string): string {
  const words = value.split(/\s+/);
  return isActionToken(words[0]?.toLowerCase() ?? "") && words.length > 1
    ? words.slice(1).join(" ")
    : value;
}

function isActionToken(token: string): boolean {
  return ACTION_WORDS.some((group) => group.words.has(token)) ||
    ["building", "refining", "fixing", "testing", "auditing", "researching", "configuring", "publishing", "running"].includes(token);
}

function displayToken(token: string): string {
  const acronym = new Map([
    ["api", "API"],
    ["cli", "CLI"],
    ["mcp", "MCP"],
    ["seo", "SEO"],
    ["ui", "UI"],
    ["ux", "UX"]
  ]).get(token);
  return acronym ?? token;
}

function promptTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? [])
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && token !== "cz" && !/^\d+$/.test(token));
}

function topicTokens(value: string): string[] {
  // Absolute paths often appear in attached-image metadata and tool-oriented
  // prompts. They are machine context, not the user's work topic, and can
  // otherwise outrank meaningful words when only one recent prompt exists.
  const withoutAbsolutePaths = value.replace(
    /(^|[\s("'=:])(?:file:\/\/)?\/[^\s)"']+/g,
    "$1"
  )
    .replace(/\b[^\s/\\]+\.(?:png|jpe?g|gif|webp|heic|svg|pdf|mov|mp4)\b/gi, " ")
    .replace(/\b(?:attached|attachment|clipboard|image|images|photo|picture|screenshot|screenshots)\b/gi, " ");
  return promptTokens(sanitizeLocalActivityText(withoutAbsolutePaths));
}

function codexTurnUsage(value: Record<string, unknown>): LocalAgentTurnUsage {
  const rawInput = numberOf(value.input_tokens) ?? 0;
  const cached = Math.min(rawInput, numberOf(value.cached_input_tokens) ?? 0);
  const output = numberOf(value.output_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, rawInput - cached),
    outputTokens: output,
    cacheReadTokens: cached,
    contextTokens: rawInput,
    totalTokens: numberOf(value.total_tokens) ?? rawInput + output,
    source: "transcript_last_token_usage"
  };
}

function toTurnUsage(
  usage: TokenUsage,
  source: LocalAgentTurnUsage["source"]
): LocalAgentTurnUsage {
  const contextTokens = usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0);
  return {
    ...usage,
    contextTokens,
    totalTokens: contextTokens + usage.outputTokens,
    source
  };
}

/**
 * Remove known and assignment-shaped credentials from metadata before it can
 * become a topic, title, Glance field, MCP result, or copy-ready handoff.
 * This intentionally favors dropping a suspicious token over displaying it.
 */
export function sanitizeLocalActivityText(value: string): string {
  return redactSecrets(value)
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, " ")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, " ")
    .replace(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)=\[REDACTED\]/g, " ")
    .replace(/\[REDACTED\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHumanPrompt(value: string): boolean {
  const text = value.trim();
  if (text.length < 3) return false;
  return ![
    /^</,
    /^>>>/,
    /^\s*\[\d+\]\s+(tool|assistant|user)\b/i,
    /^#\s*AGENTS\.md/i,
    /^Assess the exact/i,
    /^Planned action JSON/i,
    /^Reviewed Codex/i,
    /^Some conversation/i,
    /^The Codex agent/i,
    /^The following is the Codex/i,
    /^You are .*primary agent/i,
    /^You have \d+ weighted tokens left/i
  ].some((pattern) => pattern.test(text));
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [stringOf(item.text) ?? stringOf(item.content)].filter((text): text is string => Boolean(text));
  });
}

function recordValues(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function collectToolFiles(value: unknown, counts: Map<string, number>): void {
  if (!isRecord(value)) return;
  for (const key of ["file_path", "path", "notebook_path"]) {
    addFile(stringOf(value[key]), counts);
  }
  collectPatchFiles(stringOf(value.patch) ?? stringOf(value.input), counts);
}

function collectPatchFiles(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    addFile(match[1], counts);
  }
}

function addFile(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  const file = basename(value.trim());
  if (!file || file === "." || file === sep) return;
  counts.set(file, (counts.get(file) ?? 0) + 1);
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

const ROOT_TASK_CLOCK_TOLERANCE_MS = 5_000;

function isRootSpecificTaskStart(value: unknown, rootStartedAtMs: number | undefined): boolean {
  const taskStartedAtMs = timestampMilliseconds(value);
  return typeof rootStartedAtMs === "number" &&
    typeof taskStartedAtMs === "number" &&
    taskStartedAtMs >= rootStartedAtMs - ROOT_TASK_CLOCK_TOLERANCE_MS;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sum(calls: LocalAgentCall[], pick: (call: LocalAgentCall) => number): number {
  return calls.reduce((total, call) => total + pick(call), 0);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
