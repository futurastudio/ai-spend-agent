import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  estimateTokenCostUsd,
  estimateTokenCostsUsd,
  promptTierThreshold,
  usesPromptTieredPricing,
  type TokenUsage
} from "./modelPricing.js";
import type { UsageRecord } from "./schema.js";
import { redactSecrets } from "./discovery.js";
import type { ParsedInvocationFile } from "./toolInvocations.js";
import {
  localAgentFormatDescriptor,
  localAgentFormatDescriptors,
  localAgentFormatLabel,
  matchesLocalAgentDetectionFile,
  matchesLocalAgentFormatFile,
  validateLocalAgentFormatDescriptors
} from "./localAgentFormats/registry.js";
import type {
  LocalAgentFormatDescriptor,
  LocalAgentFormatFinancialFileContext,
  LocalAgentFormatId,
  LocalAgentFormatRuntime
} from "./localAgentFormats/types.js";
import {
  parseGeminiSession,
  type GeminiParseDiagnostic
} from "./localAgentFormats/gemini.js";

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
  agent: LocalAgentFormatId;
  /** Stable source call/message identity when the format safely exposes one. */
  callId?: string;
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
  /** Optional parser/source version when the evolving session format reports it. */
  sourceVersion?: string;
  /** Raw Gemini token split retained for evidence/debugging, never prompt content. */
  geminiTokenEvidence?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
    cacheAccounting: "included" | "none" | "unknown";
  };
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
  /** Default: ~/.gemini/tmp (financial evidence is bounded to chats files). */
  geminiSessionsDir?: string;
  /** Registry-native source-root overrides, keyed by format id. */
  sourceDirectories?: Readonly<Partial<Record<LocalAgentFormatId, string>>>;
  /** Only include calls at/after this ISO timestamp. */
  sinceIso?: string;
  /** Collect privacy-safe Codex invocation summaries during the same JSON pass. */
  collectCodexInvocationEvidence?: boolean;
};

/**
 * Options accepted by the financial-only loader. Invocation collection is
 * intentionally unavailable: this path reads only the evidence needed for a
 * financial snapshot and transcript-reported plan limits.
 */
export type LocalAgentFinancialLogOptions = Omit<
  LocalAgentLogOptions,
  "collectCodexInvocationEvidence"
>;

export type LocalAgentLogDiagnosticCode =
  | "directory_missing"
  | "directory_unreadable"
  | "file_unreadable"
  | "malformed_jsonl"
  | "malformed_session_file"
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
  /** Malformed lines observed inside `jsonlValidationCoverage`. */
  malformedLines: number;
  unreadableFiles: number;
  unsupportedUsageSnapshots: number;
  /** Presence-only files such as Gemini CLI logs.json; never financial rows. */
  detectionSignals?: number;
  /** Regular files safely excluded because their metadata predates `sinceIso`. */
  filesSkippedBeforeWindow?: number;
  /** Codex files resolved from bounded head/tail financial evidence. */
  filesReadFinancially?: number;
  /** Bytes not replayed as events after the required Codex financial state was proved. */
  bytesSkippedAsNonFinancialHistory?: number;
  /** JSONL lines classified from their envelope and skipped before JSON decoding. */
  nonFinancialLinesPrefiltered?: number;
  /** Bytes covered by the non-financial event prefilter. */
  nonFinancialBytesPrefiltered?: number;
  /** Whether JSON syntax was checked for every line or financial events only. */
  jsonlValidationCoverage?: "complete" | "financial_events_only";
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
  code: "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape";
  count: number;
};

type TranscriptParseDiagnosticHandler = (diagnostic: TranscriptParseDiagnostic) => void;

/**
 * Codex rollout/compaction files can repeat the same session's cumulative
 * token counter. Keep only the latest snapshot per session so financial value,
 * Glance, and project totals never add cumulative checkpoints together.
 * Turn-scoped calls with a stable session+call identity are also deduplicated
 * across copied/checkpointed files. Calls without that proof are retained.
 */
export function dedupeCumulativeSessionCalls(
  calls: LocalAgentCall[],
  onStableTurnConflict?: (agent: LocalAgentFormatId) => void
): LocalAgentCall[] {
  const retained: LocalAgentCall[] = [];
  const cumulative = new Map<string, LocalAgentCall>();
  const stableTurns = new Map<string, LocalAgentCall>();
  for (const call of calls) {
    if (call.usageScope === "turn" && call.sessionId && call.callId) {
      const key = `${call.agent}:${call.sessionId}:${call.callId}`;
      const prior = stableTurns.get(key);
      if (!prior) {
        stableTurns.set(key, call);
      } else if (isStableTurnConflict(prior)) {
        continue;
      } else if (isCompleteStableTurn(prior) && isCompleteStableTurn(call) &&
          stableTurnEvidenceFingerprint(call) !== stableTurnEvidenceFingerprint(prior)) {
        stableTurns.set(key, conflictingStableTurn(prior, call));
        onStableTurnConflict?.(call.agent);
      } else if (!isCompleteStableTurn(prior) && isCompleteStableTurn(call)) {
        // JSONL/checkpoint copies can preserve an early tokenless snapshot
        // beside its later complete update. Complete evidence supersedes only
        // unsupported evidence for the same stable identity.
        stableTurns.set(key, call);
      } else if (!isCompleteStableTurn(call) && isCompleteStableTurn(prior)) {
        continue;
      } else if (isLaterCumulativeSnapshot(call, prior)) {
        stableTurns.set(key, call);
      }
      continue;
    }
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
  return [...retained, ...stableTurns.values(), ...cumulative.values()];
}

function isCompleteStableTurn(call: LocalAgentCall): boolean {
  return call.usageSupport !== "unsupported_token_shape";
}

function stableTurnEvidenceFingerprint(call: LocalAgentCall): string {
  return JSON.stringify({
    timestamp: call.timestamp,
    model: call.model,
    project: call.project ?? null,
    workingDirectory: call.workingDirectory ?? null,
    usageSupport: call.usageSupport ?? null,
    reportedTotalTokens: call.reportedTotalTokens ?? null,
    usage: {
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens ?? null,
      cacheWrite5mTokens: call.usage.cacheWrite5mTokens ?? null,
      cacheWrite1hTokens: call.usage.cacheWrite1hTokens ?? null,
      thoughtTokens: call.usage.thoughtTokens ?? null,
      toolTokens: call.usage.toolTokens ?? null
    },
    geminiTokenEvidence: call.geminiTokenEvidence ?? null
  });
}

function isStableTurnConflict(call: LocalAgentCall): boolean {
  return call.model === "conflicting-local-evidence" &&
    call.usageSupport === "unsupported_token_shape";
}

function conflictingStableTurn(
  left: LocalAgentCall,
  right: LocalAgentCall
): LocalAgentCall {
  const call = left.timestamp.localeCompare(right.timestamp) <= 0 ? left : right;
  return {
    agent: call.agent,
    ...(call.callId ? { callId: call.callId } : {}),
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    model: "conflicting-local-evidence",
    timestamp: call.timestamp,
    usageScope: "turn",
    usageSupport: "unsupported_token_shape",
    usage: { inputTokens: 0, outputTokens: 0 }
  };
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
    (usage.cacheWrite1hTokens ?? 0) +
    (usage.thoughtTokens ?? 0) +
    (usage.toolTokens ?? 0);
}

type ParsedClaudeFinancialUsage = {
  usage: TokenUsage;
  latestTurnUsage?: LocalAgentTurnUsage;
  usageSupport?: "unsupported_token_shape";
  reportedTotalTokens?: number;
};

function parseClaudeFinancialUsage(
  value: Record<string, unknown>,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): ParsedClaudeFinancialUsage {
  const inputTokens = tokenComponentOf(value.input_tokens);
  const outputTokens = tokenComponentOf(value.output_tokens);
  const cacheReadField = optionalTokenComponent(value, "cache_read_input_tokens");
  const writeTotalField = optionalTokenComponent(value, "cache_creation_input_tokens");
  const reportedTotalField = optionalTokenComponent(value, "total_tokens");
  const cacheCreationPresent = Object.prototype.hasOwnProperty.call(value, "cache_creation");
  const cacheCreation = isRecord(value.cache_creation) ? value.cache_creation : undefined;
  const write5mField = cacheCreation
    ? optionalTokenComponent(cacheCreation, "ephemeral_5m_input_tokens")
    : { present: false };
  const write1hField = cacheCreation
    ? optionalTokenComponent(cacheCreation, "ephemeral_1h_input_tokens")
    : { present: false };
  const componentsSupported = inputTokens !== undefined &&
    outputTokens !== undefined &&
    (!cacheReadField.present || cacheReadField.value !== undefined) &&
    (!writeTotalField.present || writeTotalField.value !== undefined) &&
    (!reportedTotalField.present || reportedTotalField.value !== undefined) &&
    (!cacheCreationPresent || Boolean(cacheCreation)) &&
    (!write5mField.present || write5mField.value !== undefined) &&
    (!write1hField.present || write1hField.value !== undefined);
  const usage: TokenUsage = {
    // Retain every valid component for partial evidence, but never let a
    // missing/invalid required field become a priceable zero-dollar call.
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadField.value ?? 0,
    // Prefer the 5m/1h breakdown; fall back to the total as 5m (cheaper bound).
    cacheWrite5mTokens: write5mField.value ?? writeTotalField.value ?? 0,
    cacheWrite1hTokens: write1hField.value ?? 0
  };
  if (componentsSupported) {
    return {
      usage,
      latestTurnUsage: toTurnUsage(usage, "assistant_message_usage")
    };
  }
  onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  const reportedTotalTokens = reportedTotalField.value;
  return {
    usage,
    usageSupport: "unsupported_token_shape",
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {})
  };
}

type OptionalTokenComponent = {
  present: boolean;
  value?: number;
};

function optionalTokenComponent(
  record: Record<string, unknown>,
  key: string
): OptionalTokenComponent {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
  const value = tokenComponentOf(record[key]);
  return value === undefined ? { present: true } : { present: true, value };
}

type ParsedCodexCumulativeUsage = {
  usage: TokenUsage;
  supported: boolean;
  reportedTotalTokens?: number;
};

function parseCodexCumulativeUsage(
  current: Record<string, unknown>,
  baseline?: Record<string, unknown>
): ParsedCodexCumulativeUsage {
  const rawInput = tokenComponentOf(current.input_tokens);
  const rawOutput = tokenComponentOf(current.output_tokens);
  const currentCachedField = optionalTokenComponent(current, "cached_input_tokens");
  const currentTotalField = optionalTokenComponent(current, "total_tokens");
  const rawCached = currentCachedField.value ?? 0;
  const rawReportedTotal = currentTotalField.value;

  const baselineInput = baseline ? tokenComponentOf(baseline.input_tokens) : undefined;
  const baselineOutput = baseline ? tokenComponentOf(baseline.output_tokens) : undefined;
  const baselineCachedField = baseline
    ? optionalTokenComponent(baseline, "cached_input_tokens")
    : { present: false };
  const baselineTotalField = baseline
    ? optionalTokenComponent(baseline, "total_tokens")
    : { present: false };
  const baselineCached = baselineCachedField.value ?? 0;
  const baselineReportedTotal = baselineTotalField.value;

  const currentSupported = rawInput !== undefined &&
    rawOutput !== undefined &&
    (!currentCachedField.present || currentCachedField.value !== undefined) &&
    (!currentTotalField.present || currentTotalField.value !== undefined) &&
    rawCached <= rawInput &&
    (rawReportedTotal === undefined || rawReportedTotal >= rawInput + rawOutput) &&
    !((rawReportedTotal ?? 0) > 0 && rawInput === 0 && rawOutput === 0);
  const baselineSupported = !baseline || (
    baselineInput !== undefined &&
    baselineOutput !== undefined &&
    (!baselineCachedField.present || baselineCachedField.value !== undefined) &&
    (!baselineTotalField.present || baselineTotalField.value !== undefined) &&
    baselineCached <= baselineInput &&
    (baselineReportedTotal === undefined ||
      baselineReportedTotal >= baselineInput + baselineOutput) &&
    !((baselineReportedTotal ?? 0) > 0 && baselineInput === 0 && baselineOutput === 0)
  );
  const monotonic = !baseline || (
    rawInput !== undefined && baselineInput !== undefined && rawInput >= baselineInput &&
    rawOutput !== undefined && baselineOutput !== undefined && rawOutput >= baselineOutput &&
    rawCached >= baselineCached &&
    rawInput - rawCached >= baselineInput - baselineCached &&
    (rawReportedTotal === undefined ||
      baselineReportedTotal === undefined ||
      rawReportedTotal >= baselineReportedTotal)
  );

  const input = Math.max(0, (rawInput ?? 0) - (baselineInput ?? 0));
  const cached = Math.max(0, rawCached - baselineCached);
  const output = Math.max(0, (rawOutput ?? 0) - (baselineOutput ?? 0));
  const reportedTotalTokens = rawReportedTotal === undefined
    ? undefined
    : Math.max(0, rawReportedTotal - (baselineReportedTotal ?? 0));
  return {
    usage: {
      // Codex input_tokens includes cached input; expose the non-cached split.
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      cacheReadTokens: cached
    },
    supported: currentSupported && baselineSupported && monotonic,
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {})
  };
}

function parseCodexTurnUsage(value: Record<string, unknown>): {
  supported: boolean;
  usage?: LocalAgentTurnUsage;
} {
  const rawInput = tokenComponentOf(value.input_tokens);
  const rawOutput = tokenComponentOf(value.output_tokens);
  const cachedField = optionalTokenComponent(value, "cached_input_tokens");
  const totalField = optionalTokenComponent(value, "total_tokens");
  const cached = cachedField.value ?? 0;
  const total = totalField.value;
  const supported = rawInput !== undefined &&
    rawOutput !== undefined &&
    (!cachedField.present || cachedField.value !== undefined) &&
    (!totalField.present || totalField.value !== undefined) &&
    cached <= rawInput &&
    (total === undefined || total >= rawInput + rawOutput);
  if (!supported) return { supported: false };
  return {
    supported: true,
    usage: {
      inputTokens: rawInput - cached,
      outputTokens: rawOutput,
      cacheReadTokens: cached,
      contextTokens: rawInput,
      totalTokens: total ?? rawInput + rawOutput,
      source: "transcript_last_token_usage"
    }
  };
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
    const parsedUsage = parseClaudeFinancialUsage(usage, onDiagnostic);
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
      ...(parsedUsage.latestTurnUsage
        ? { latestTurnUsage: parsedUsage.latestTurnUsage }
        : {}),
      usageScope: "turn",
      ...(parsedUsage.usageSupport ? { usageSupport: parsedUsage.usageSupport } : {}),
      ...(parsedUsage.reportedTotalTokens !== undefined
        ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
        : {}),
      usage: parsedUsage.usage
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
  const parsedUsage = parseCodexCumulativeUsage(lastTotal, inheritedUsageBaseline);
  const parsedTurn = lastTurn
    ? parseCodexTurnUsage(lastTurn)
    : { supported: true as const };
  const usageSupport = parsedUsage.supported && parsedTurn.supported
    ? "complete" as const
    : "unsupported_token_shape" as const;
  if (usageSupport === "unsupported_token_shape") {
    onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  }
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
    ...(usageSupport === "complete" && parsedTurn.usage
      ? { latestTurnUsage: parsedTurn.usage }
      : {}),
    usageScope: "session_cumulative",
    usageSupport,
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    usage: parsedUsage.usage
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
  return loadLocalAgentUsageWithFormats(await localAgentFormatRuntimes(), options);
}

/**
 * Registry-driven ingestion engine. Exported from this module for registry
 * contract tests and format modules, but intentionally omitted from the
 * package-root API.
 */
export async function loadLocalAgentUsageWithFormats(
  registry: readonly LocalAgentFormatRuntime[],
  options: LocalAgentLogOptions = {}
): Promise<LocalAgentLogResult> {
  validateLocalAgentFormatDescriptors(registry.map((entry) => entry.descriptor));
  const home = homedir();
  const calls: LocalAgentCall[] = [];
  const codexInvocationFiles = options.collectCodexInvocationEvidence
    ? [] as ParsedInvocationFile[]
    : undefined;
  let filesParsed = 0;
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;
  const diagnostics: LocalAgentLogDiagnostic[] = [];
  const sourceScans: LocalAgentSourceScan[] = [];

  for (const runtime of registry) {
    const { descriptor } = runtime;
    const scan = emptySourceScan(descriptor.id);
    sourceScans.push(scan);
    const root = localAgentFormatRoot(descriptor, options, home);
    for (const file of await listFormatCandidateFiles(root, descriptor, scan, diagnostics)) {
      if (!matchesLocalAgentFormatFile(descriptor, file)) continue;
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch (error) {
        recordUnreadableFile(descriptor.id, scan, diagnostics, error);
        continue;
      }
      if (!content) continue;
      filesParsed += 1;
      scan.filesParsed += 1;
      const collectInvocationEvidence = Boolean(codexInvocationFiles) &&
        descriptor.id === "codex" && descriptor.capabilities.invocationEvidence;
      const parsed = runtime.parseFull({
        content,
        filePath: file,
        sinceMs,
        collectInvocationEvidence,
        onDiagnostic: (diagnostic) => {
          recordParseDiagnostic(descriptor.id, scan, diagnostics, diagnostic);
        }
      });
      assertFormatCallOwnership(descriptor, parsed.calls);
      assertInvocationOwnership(descriptor, parsed.invocationFile, collectInvocationEvidence);
      calls.push(...parsed.calls);
      if (codexInvocationFiles && collectInvocationEvidence && parsed.invocationFile) {
        codexInvocationFiles.push(parsed.invocationFile);
      }
    }
  }

  const normalizedCalls = dedupeCumulativeSessionCalls(calls, (agent) => {
    const scan = sourceScans.find((entry) => entry.agent === agent);
    if (scan) {
      recordParseDiagnostic(agent, scan, diagnostics, {
        code: "unsupported_token_shape",
        count: 1
      });
    }
  });
  const filtered = typeof sinceMs === "number"
    ? normalizedCalls.filter((call) => Date.parse(call.timestamp) >= sinceMs)
    : normalizedCalls;

  return {
    records: aggregateCallsForFormats(filtered, registry.map((entry) => entry.descriptor)),
    calls: filtered,
    filesParsed,
    agentsDetected: [...new Set(filtered.map((call) => call.agent))],
    sourceScans,
    diagnostics,
    ...(codexInvocationFiles ? { codexInvocationFiles } : {})
  };
}

type StreamedJsonlResult = {
  hadContent: boolean;
  malformedLines: number;
};

type CodexFinancialFileResult = StreamedJsonlResult & {
  entries: Record<string, unknown>[];
  bytesSkipped: number;
  prefilteredLines: number;
  prefilteredBytes: number;
};

type CodexFinancialStreamState = {
  model?: string;
  rootCwd?: string;
  sessionId?: string;
  rootSessionMetaSeen: boolean;
  startedAt?: string;
  rootStartedAtMs?: number;
  rootTaskStarted: boolean;
  isSubagent: boolean;
  inheritedUsageBaseline?: Record<string, unknown>;
  lastActivityAt?: string;
  lastTotal?: Record<string, unknown>;
  lastTurn?: Record<string, unknown>;
  lastRateLimits?: LocalAgentRateLimitSnapshot;
};

/**
 * Stream only the financial evidence required by init/status snapshots.
 *
 * Unlike `loadLocalAgentUsage`, this path never derives prompts, file focus,
 * tool activity, or invocation evidence. It deliberately returns the same
 * result contract so callers can preserve the existing evidence and
 * diagnostics vocabulary without maintaining a second loader schema. Codex
 * project attribution intentionally uses only root metadata; home-launched
 * tool-workdir inference remains exclusive to the full qualitative loader.
 */
export async function loadLocalAgentFinancialUsage(
  options: LocalAgentFinancialLogOptions = {}
): Promise<LocalAgentLogResult> {
  return loadLocalAgentFinancialUsageWithFormats(await localAgentFormatRuntimes(), options);
}

/** Registry-driven financial-only engine; package-root exports stay unchanged. */
export async function loadLocalAgentFinancialUsageWithFormats(
  registry: readonly LocalAgentFormatRuntime[],
  options: LocalAgentFinancialLogOptions = {}
): Promise<LocalAgentLogResult> {
  validateLocalAgentFormatDescriptors(registry.map((entry) => entry.descriptor));
  const home = homedir();
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;
  const scanned = await Promise.all(registry.map(async (runtime) => {
    const { descriptor } = runtime;
    const diagnostics: LocalAgentLogDiagnostic[] = [];
    const scan = financialSourceScan(descriptor);
    const calls: LocalAgentCall[] = [];
    const root = localAgentFormatRoot(descriptor, options, home);
    for (const file of await listFormatCandidateFiles(root, descriptor, scan, diagnostics)) {
      if (!matchesLocalAgentFormatFile(descriptor, file)) continue;
      const parsedCalls = await runtime.parseFinancialFile({
        filePath: file,
        sinceMs,
        scan,
        diagnostics
      });
      assertFormatCallOwnership(descriptor, parsedCalls);
      assertFinancialSourceOwnership(descriptor, scan, diagnostics);
      calls.push(...parsedCalls);
    }
    return { calls, scan, diagnostics };
  }));

  // Sources scan concurrently, but flatten in registry order to preserve the
  // long-standing Claude-then-Codex output and diagnostic contract.
  const calls = scanned.flatMap((entry) => entry.calls);
  const normalizedCalls = dedupeCumulativeSessionCalls(calls, (agent) => {
    const source = scanned.find((entry) => entry.scan.agent === agent);
    if (source) {
      recordParseDiagnostic(agent, source.scan, source.diagnostics, {
        code: "unsupported_token_shape",
        count: 1
      });
    }
  });
  const filtered = typeof sinceMs === "number"
    ? normalizedCalls.filter((call) => Date.parse(call.timestamp) >= sinceMs)
    : normalizedCalls;

  return {
    records: aggregateCallsForFormats(filtered, registry.map((entry) => entry.descriptor)),
    calls: filtered,
    filesParsed: scanned.reduce((total, entry) => total + entry.scan.filesParsed, 0),
    agentsDetected: [...new Set(filtered.map((call) => call.agent))],
    sourceScans: scanned.map((entry) => entry.scan),
    diagnostics: scanned.flatMap((entry) => entry.diagnostics)
  };
}

/** @internal Runtime hook owned by the Claude Code registry entry. */
export async function readClaudeCodeFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "claude-code", scan, diagnostics)) {
    return [];
  }
  const calls: LocalAgentCall[] = [];
  const fileDiagnostics: TranscriptParseDiagnostic[] = [];
  const seen = new Set<string>();
  let streamed: StreamedJsonlResult;
  try {
    streamed = await streamJsonlRecords(filePath, (entry) => {
      const call = parseClaudeFinancialEntry(
        entry,
        filePath,
        sinceMs,
        seen,
        (diagnostic) => fileDiagnostics.push(diagnostic)
      );
      if (call) calls.push(call);
    });
  } catch (error) {
    recordUnreadableFile("claude-code", scan, diagnostics, error);
    return [];
  }
  if (!streamed.hadContent) return [];
  scan.filesParsed += 1;
  for (const diagnostic of fileDiagnostics) {
    recordParseDiagnostic("claude-code", scan, diagnostics, diagnostic);
  }
  if (streamed.malformedLines > 0) {
    recordParseDiagnostic("claude-code", scan, diagnostics, {
      code: "malformed_jsonl",
      count: streamed.malformedLines
    });
  }
  return calls;
}

/** @internal Runtime hook owned by the Codex registry entry. */
export async function readCodexFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "codex", scan, diagnostics)) {
    return [];
  }
  let financialFile: CodexFinancialFileResult;
  try {
    financialFile = await readCodexFinancialFile(filePath);
  } catch (error) {
    recordUnreadableFile("codex", scan, diagnostics, error);
    return [];
  }
  if (!financialFile.hadContent) return [];
  scan.filesParsed += 1;
  scan.filesReadFinancially = (scan.filesReadFinancially ?? 0) + 1;
  scan.bytesSkippedAsNonFinancialHistory =
    (scan.bytesSkippedAsNonFinancialHistory ?? 0) + financialFile.bytesSkipped;
  scan.nonFinancialLinesPrefiltered =
    (scan.nonFinancialLinesPrefiltered ?? 0) + financialFile.prefilteredLines;
  scan.nonFinancialBytesPrefiltered =
    (scan.nonFinancialBytesPrefiltered ?? 0) + financialFile.prefilteredBytes;
  if (financialFile.bytesSkipped > 0 || financialFile.prefilteredLines > 0) {
    scan.jsonlValidationCoverage = "financial_events_only";
  }
  if (financialFile.malformedLines > 0) {
    recordParseDiagnostic("codex", scan, diagnostics, {
      code: "malformed_jsonl",
      count: financialFile.malformedLines
    });
  }
  const state = createCodexFinancialStreamState();
  for (const entry of financialFile.entries) {
    consumeCodexFinancialEntry(state, entry);
  }
  const call = finishCodexFinancialStream(state, (diagnostic) => {
    recordParseDiagnostic("codex", scan, diagnostics, diagnostic);
  });
  return call ? [call] : [];
}

/** @internal Runtime hook owned by the Gemini CLI registry entry. */
export async function readGeminiFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "gemini-cli", scan, diagnostics)) {
    return [];
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    recordUnreadableFile("gemini-cli", scan, diagnostics, error);
    return [];
  }
  if (!content) return [];
  scan.filesParsed += 1;
  const parsed = parseGeminiSession(content, { filePath, ...(sinceMs !== undefined ? { sinceMs } : {}) });
  for (const diagnostic of parsed.diagnostics) {
    recordParseDiagnostic(
      "gemini-cli",
      scan,
      diagnostics,
      normalizeGeminiDiagnostic(diagnostic)
    );
  }
  return parsed.calls;
}

function normalizeGeminiDiagnostic(
  diagnostic: GeminiParseDiagnostic
): TranscriptParseDiagnostic {
  if (diagnostic.code === "malformed_jsonl") {
    return { code: "malformed_jsonl", count: diagnostic.count };
  }
  if (diagnostic.code === "unsupported_token_shape") {
    return { code: "unsupported_token_shape", count: diagnostic.count };
  }
  return { code: "malformed_session_file", count: diagnostic.count };
}

async function localAgentFormatRuntimes(): Promise<readonly LocalAgentFormatRuntime[]> {
  const module = await import("./localAgentFormats/runtimeRegistry.js");
  return module.localAgentFormatRuntimeRegistry;
}

function localAgentFormatRoot(
  descriptor: LocalAgentFormatDescriptor,
  options: LocalAgentLogOptions,
  home: string
): string {
  const registryOverride = options.sourceDirectories?.[descriptor.id];
  if (registryOverride) return registryOverride;
  if (descriptor.legacyDirectoryOption === "claudeProjectsDir" && options.claudeProjectsDir) {
    return options.claudeProjectsDir;
  }
  if (descriptor.legacyDirectoryOption === "codexSessionsDir" && options.codexSessionsDir) {
    return options.codexSessionsDir;
  }
  if (descriptor.legacyDirectoryOption === "geminiSessionsDir" && options.geminiSessionsDir) {
    return options.geminiSessionsDir;
  }
  const canonicalHome = resolve(home);
  const root = resolve(canonicalHome, ...descriptor.defaultHomeRelative);
  const fromHome = relative(canonicalHome, root);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error(`Local-agent format ${descriptor.id} resolved outside the home boundary.`);
  }
  return root;
}

function assertFormatCallOwnership(
  descriptor: LocalAgentFormatDescriptor,
  calls: readonly LocalAgentCall[]
): void {
  if (calls.some((call) => call.agent !== descriptor.id)) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted a call for a different source.`
    );
  }
}

function assertFinancialSourceOwnership(
  descriptor: LocalAgentFormatDescriptor,
  scan: LocalAgentSourceScan,
  diagnostics: readonly LocalAgentLogDiagnostic[]
): void {
  if (scan.agent !== descriptor.id || diagnostics.some((entry) => entry.agent !== descriptor.id)) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted financial metadata for a different source.`
    );
  }
}

function assertInvocationOwnership(
  descriptor: LocalAgentFormatDescriptor,
  invocationFile: ParsedInvocationFile | undefined,
  collectionAllowed: boolean
): void {
  if (!invocationFile) return;
  if (!collectionAllowed || descriptor.id !== "codex" ||
      invocationFile.contextSignal.agent !== descriptor.id) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted invocation evidence for a different source.`
    );
  }
}

function financialSourceScan(descriptor: LocalAgentFormatDescriptor): LocalAgentSourceScan {
  const scan: LocalAgentSourceScan = {
    ...emptySourceScan(descriptor.id),
    filesSkippedBeforeWindow: 0
  };
  if (descriptor.financialRead === "bounded_event_jsonl") {
    scan.filesReadFinancially = 0;
    scan.bytesSkippedAsNonFinancialHistory = 0;
    scan.nonFinancialLinesPrefiltered = 0;
    scan.nonFinancialBytesPrefiltered = 0;
  }
  // Keep this after format-specific metrics: persisted/debug JSON has used
  // this exact insertion order since the optimized financial reader shipped.
  scan.jsonlValidationCoverage = "complete";
  return scan;
}

async function streamJsonlRecords(
  file: string,
  onRecord: (entry: Record<string, unknown>) => void
): Promise<StreamedJsonlResult> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let hadContent = false;
  let malformedLines = 0;
  try {
    for await (const line of lines) {
      hadContent = true;
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      // Parsed event type is checked before any deeper traversal. This keeps
      // qualitative payloads out of the fast path while still validating
      // every JSONL line and reporting malformed coverage honestly.
      if (isRecord(entry)) onRecord(entry);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { hadContent, malformedLines };
}

const FINANCIAL_REVERSE_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Codex token counters are cumulative. Reading the root metadata plus the
 * newest complete financial tail is therefore equivalent to replaying copied
 * prompt/tool history, while avoiding multi-gigabyte inherited histories in
 * compaction and subagent rollouts.
 *
 * The reverse scan has proof-based stopping conditions. A normal rollout must
 * expose the newest total, last-turn usage, model, and rate-limit snapshot.
 * Subagent rollouts always continue to byte zero because the full parser's
 * first qualifying task boundary cannot be proved from timestamps alone. If
 * any normal-session proof is missing, it also continues to byte zero; no
 * byte/line cap silently truncates evidence.
 */
async function readCodexFinancialFile(file: string): Promise<CodexFinancialFileResult> {
  const handle = await open(file, "r");
  try {
    const fileStat = await handle.stat();
    if (fileStat.size === 0) {
      return {
        hadContent: false,
        malformedLines: 0,
        entries: [],
        bytesSkipped: 0,
        prefilteredLines: 0,
        prefilteredBytes: 0
      };
    }
    const rootEntry = await readFirstJsonlRecord(handle, fileStat.size);
    const rootPayload = rootEntry?.type === "session_meta" && isRecord(rootEntry.payload)
      ? rootEntry.payload
      : undefined;
    const isSubagent = Boolean(rootPayload) && (
      stringOf(rootPayload?.thread_source) === "subagent" ||
      isRecord(rootPayload?.source) && "subagent" in rootPayload.source
    );
    const entriesReverse: Record<string, unknown>[] = [];
    let malformedLines = 0;
    let prefilteredLines = 0;
    let prefilteredBytes = 0;
    let position = fileStat.size;
    // Chunks for one cross-boundary line are retained newest-first. Appending
    // is O(1); they are ordered only once when the line's start is found.
    let suffixPartsReverse: Buffer[] = [];
    let stoppedEarly = false;
    let bytesSkipped = 0;
    const proof = createCodexReverseProof(isSubagent, !rootPayload);

    while (position > 0 && !stoppedEarly) {
      const chunkStart = Math.max(0, position - FINANCIAL_REVERSE_CHUNK_BYTES);
      const length = position - chunkStart;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, chunkStart);
      if (bytesRead !== length) {
        throw newErrorWithCode("EIO");
      }
      const current = chunk.subarray(0, bytesRead);
      let lineEnd = current.length;
      let newline = current.lastIndexOf(0x0a, lineEnd - 1);
      while (newline >= 0) {
        const leadingPart = current.subarray(newline + 1, lineEnd);
        const parts = suffixPartsReverse.length > 0
          ? [leadingPart, ...suffixPartsReverse.slice().reverse()]
          : [leadingPart];
        const observed = parseCodexFinancialLine(parts);
        if (observed.malformed) malformedLines += 1;
        if (observed.prefilteredBytes > 0) {
          prefilteredLines += 1;
          prefilteredBytes += observed.prefilteredBytes;
        }
        if (observed.entry) {
          entriesReverse.push(observed.entry);
          if (observeCodexReverseProof(proof, observed.entry)) {
            stoppedEarly = true;
            bytesSkipped = chunkStart + newline;
            break;
          }
        }
        suffixPartsReverse = [];
        lineEnd = newline;
        newline = current.lastIndexOf(0x0a, lineEnd - 1);
      }
      if (!stoppedEarly) {
        const prefix = current.subarray(0, lineEnd);
        if (prefix.length > 0) suffixPartsReverse.push(prefix);
        position = chunkStart;
      }
    }

    if (!stoppedEarly && suffixPartsReverse.length > 0) {
      const observed = parseCodexFinancialLine(suffixPartsReverse.slice().reverse());
      if (observed.malformed) malformedLines += 1;
      if (observed.prefilteredBytes > 0) {
        prefilteredLines += 1;
        prefilteredBytes += observed.prefilteredBytes;
      }
      if (observed.entry) entriesReverse.push(observed.entry);
    }

    const entries = entriesReverse.reverse();
    // A proof-complete tail does not contain byte-zero root metadata. Inject
    // the separately parsed first record so session identity/start/cwd remain
    // identical to the full parser. A full scan already contains that record.
    if (stoppedEarly && rootEntry) entries.unshift(rootEntry);
    return {
      hadContent: true,
      malformedLines,
      entries,
      bytesSkipped: Math.max(0, bytesSkipped),
      prefilteredLines,
      prefilteredBytes
    };
  } finally {
    await handle.close();
  }
}

async function readFirstJsonlRecord(
  handle: FileHandle,
  fileSize: number
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < fileSize) {
    const length = Math.min(FINANCIAL_REVERSE_CHUNK_BYTES, fileSize - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead <= 0) break;
    const value = chunk.subarray(0, bytesRead);
    const newline = value.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(value.subarray(0, newline));
      break;
    }
    chunks.push(value);
    position += bytesRead;
  }
  if (chunks.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type ParsedCodexFinancialLine = {
  entry?: Record<string, unknown>;
  malformed: boolean;
  prefilteredBytes: number;
};

const CODEX_ENVELOPE_PREFIX_BYTES = 16 * 1024;

function parseCodexFinancialLine(parts: readonly Buffer[]): ParsedCodexFinancialLine {
  const byteLength = parts.reduce((total, part) => total + part.length, 0);
  if (byteLength === 0) return { malformed: false, prefilteredBytes: 0 };
  const prefix = bufferPartsPrefix(parts, CODEX_ENVELOPE_PREFIX_BYTES).toString("utf8");
  const classification = classifyCodexFinancialEnvelope(prefix);
  if (classification === "nonfinancial") {
    return { malformed: false, prefilteredBytes: byteLength };
  }
  const text = Buffer.concat(parts, byteLength).toString("utf8").trim();
  if (!text) return { malformed: false, prefilteredBytes: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { malformed: true, prefilteredBytes: 0 };
  }
  if (!isRecord(parsed)) return { malformed: false, prefilteredBytes: 0 };
  const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
  const financial = parsed.type === "session_meta" ||
    parsed.type === "turn_context" ||
    parsed.type === "event_msg" && (
      payload?.type === "token_count" || payload?.type === "task_started"
    );
  return financial
    ? { entry: parsed, malformed: false, prefilteredBytes: 0 }
    : { malformed: false, prefilteredBytes: byteLength };
}

function bufferPartsPrefix(parts: readonly Buffer[], limit: number): Buffer {
  const selected: Buffer[] = [];
  let remaining = limit;
  for (const part of parts) {
    if (remaining <= 0) break;
    const value = part.subarray(0, Math.min(part.length, remaining));
    if (value.length > 0) selected.push(value);
    remaining -= value.length;
  }
  return selected.length === 1
    ? selected[0]!
    : Buffer.concat(selected, limit - remaining);
}

function classifyCodexFinancialEnvelope(
  prefix: string
): "financial" | "nonfinancial" | "unknown" {
  // JSON property order is not semantic. Scan string/object depth so a nested
  // payload type can never be mistaken for the top-level event type. If the
  // bounded prefix does not prove the envelope, return unknown and let the
  // complete line go through JSON.parse rather than silently prefiltering it.
  const { topLevelType, payloadType } = scanCodexEnvelopeTypes(prefix);
  if (!topLevelType) return "unknown";
  if (topLevelType === "session_meta" || topLevelType === "turn_context") {
    return "financial";
  }
  if (topLevelType !== "event_msg") return "nonfinancial";
  if (!payloadType) return "unknown";
  return payloadType === "token_count" || payloadType === "task_started"
    ? "financial"
    : "nonfinancial";
}

function scanCodexEnvelopeTypes(prefix: string): {
  topLevelType?: string;
  payloadType?: string;
} {
  let objectDepth = 0;
  let payloadDepth: number | undefined;
  let topLevelType: string | undefined;
  let payloadType: string | undefined;
  for (let index = 0; index < prefix.length; index += 1) {
    const character = prefix[index];
    if (character === "{") {
      objectDepth += 1;
      continue;
    }
    if (character === "}") {
      if (payloadDepth === objectDepth) payloadDepth = undefined;
      objectDepth = Math.max(0, objectDepth - 1);
      continue;
    }
    if (character !== '"') continue;
    const token = readJsonStringToken(prefix, index);
    if (!token) break;
    index = token.end;
    let cursor = skipJsonWhitespace(prefix, token.end + 1);
    if (prefix[cursor] !== ":") continue;
    cursor = skipJsonWhitespace(prefix, cursor + 1);
    if (token.value === "payload" && objectDepth === 1 && prefix[cursor] === "{") {
      payloadDepth = objectDepth + 1;
      continue;
    }
    if (token.value !== "type" || prefix[cursor] !== '"') continue;
    const value = readJsonStringToken(prefix, cursor);
    if (!value) break;
    if (objectDepth === 1) topLevelType = value.value;
    if (payloadDepth === objectDepth) payloadType = value.value;
    index = value.end;
  }
  return { topLevelType, payloadType };
}

function readJsonStringToken(
  input: string,
  start: number
): { value: string; end: number } | undefined {
  if (input[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const value: unknown = JSON.parse(input.slice(start, index + 1));
      return typeof value === "string" ? { value, end: index } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function skipJsonWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  return index;
}

type CodexReverseProof = {
  isSubagent: boolean;
  forceFullScan: boolean;
  totalSeen: boolean;
  turnSeen: boolean;
  rateLimitsSeen: boolean;
  modelSeen: boolean;
};

function createCodexReverseProof(
  isSubagent: boolean,
  forceFullScan: boolean
): CodexReverseProof {
  return {
    isSubagent,
    forceFullScan,
    totalSeen: false,
    turnSeen: false,
    rateLimitsSeen: false,
    modelSeen: false
  };
}

function observeCodexReverseProof(
  proof: CodexReverseProof,
  entry: Record<string, unknown>
): boolean {
  if (proof.forceFullScan || proof.isSubagent) return false;
  const payload = isRecord(entry.payload) ? entry.payload : undefined;
  const info = payload?.type === "token_count" && isRecord(payload.info)
    ? payload.info
    : undefined;
  const hasTotal = Boolean(info && isRecord(info.total_token_usage));
  if (hasTotal) proof.totalSeen = true;
  if (info && isRecord(info.last_token_usage)) proof.turnSeen = true;
  if (parseCodexRateLimits(payload?.rate_limits, stringOf(entry.timestamp))) {
    proof.rateLimitsSeen = true;
  }
  if (entry.type === "turn_context" && stringOf(payload?.model)) {
    proof.modelSeen = true;
  }
  return !proof.isSubagent &&
    proof.totalSeen &&
    proof.turnSeen &&
    proof.rateLimitsSeen &&
    proof.modelSeen;
}

async function shouldStreamFile(
  file: string,
  sinceMs: number | undefined,
  agent: LocalAgentCall["agent"],
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[]
): Promise<boolean> {
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch (error) {
    recordUnreadableFile(agent, scan, diagnostics, error);
    return false;
  }
  // Refuse a path swapped to a symlink/non-file after directory discovery.
  if (!fileStat.isFile()) {
    recordUnreadableFile(agent, scan, diagnostics, newErrorWithCode("EINVAL"));
    return false;
  }
  if (typeof sinceMs !== "number") return true;
  // ctime catches a file whose mtime was restored after recent replacement;
  // birthtime catches a newly copied file with a preserved old mtime. Skip
  // only when all available metadata proves the file predates the window.
  const newestFileEvidence = Math.max(
    fileStat.mtimeMs,
    fileStat.ctimeMs,
    fileStat.birthtimeMs
  );
  if (!Number.isFinite(newestFileEvidence) || newestFileEvidence >= sinceMs) {
    return true;
  }
  scan.filesSkippedBeforeWindow = (scan.filesSkippedBeforeWindow ?? 0) + 1;
  return false;
}

function newErrorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function parseClaudeFinancialEntry(
  entry: Record<string, unknown>,
  filePath: string,
  sinceMs: number | undefined,
  seen: Set<string>,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall | undefined {
  if (entry.type !== "assistant") return undefined;
  const message = isRecord(entry.message) ? entry.message : undefined;
  const usage = message && isRecord(message.usage) ? message.usage : undefined;
  if (!message || !usage || stringOf(message.model) === "<synthetic>") return undefined;
  const dedupeKey = `${stringOf(message.id) ?? ""}:${stringOf(entry.requestId) ?? ""}`;
  if (dedupeKey !== ":" && seen.has(dedupeKey)) return undefined;
  seen.add(dedupeKey);
  const timestamp = toIso(stringOf(entry.timestamp)) ?? new Date(0).toISOString();
  if (typeof sinceMs === "number" && Date.parse(timestamp) < sinceMs) return undefined;
  const parsedUsage = parseClaudeFinancialUsage(usage, onDiagnostic);
  const workingDirectory = absoluteWorkingDirectory(stringOf(entry.cwd));
  return {
    agent: "claude-code",
    model: stringOf(message.model) ?? "claude-code",
    timestamp,
    project: projectFromCwd(workingDirectory) ?? projectFromTranscriptPath(filePath),
    workingDirectory,
    sessionId: stringOf(entry.sessionId),
    ...(parsedUsage.latestTurnUsage
      ? { latestTurnUsage: parsedUsage.latestTurnUsage }
      : {}),
    usageScope: "turn",
    ...(parsedUsage.usageSupport ? { usageSupport: parsedUsage.usageSupport } : {}),
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    usage: parsedUsage.usage
  };
}

function createCodexFinancialStreamState(): CodexFinancialStreamState {
  return {
    rootSessionMetaSeen: false,
    rootTaskStarted: false,
    isSubagent: false
  };
}

function consumeCodexFinancialEntry(
  state: CodexFinancialStreamState,
  entry: Record<string, unknown>
): void {
  const payload = isRecord(entry.payload) ? entry.payload : undefined;
  if (entry.type === "session_meta" && payload && !state.rootSessionMetaSeen) {
    state.rootSessionMetaSeen = true;
    state.sessionId = stringOf(payload.id);
    state.rootCwd = stringOf(payload.cwd);
    state.startedAt = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp));
    state.rootStartedAtMs = timestampMilliseconds(payload.timestamp ?? entry.timestamp);
    state.isSubagent = stringOf(payload.thread_source) === "subagent" ||
      isRecord(payload.source) && "subagent" in payload.source;
  }
  if (entry.type === "turn_context" && payload) {
    state.model = stringOf(payload.model) ?? state.model;
    state.rootCwd ??= stringOf(payload.cwd);
  }
  if (
    state.isSubagent &&
    !state.rootTaskStarted &&
    payload?.type === "task_started" &&
    isRootSpecificTaskStart(payload.started_at, state.rootStartedAtMs)
  ) {
    state.inheritedUsageBaseline = state.lastTotal;
    state.lastTotal = undefined;
    state.rootTaskStarted = true;
    state.model = undefined;
    state.lastTurn = undefined;
    state.lastRateLimits = undefined;
    state.lastActivityAt = toIso(stringOf(entry.timestamp)) ?? state.startedAt;
  }
  if (entry.type !== "event_msg" || payload?.type !== "token_count") return;
  const eventTimestamp = toIso(stringOf(entry.timestamp)) ??
    state.lastActivityAt ??
    state.startedAt;
  const info = isRecord(payload.info) ? payload.info : undefined;
  const total = info && isRecord(info.total_token_usage)
    ? info.total_token_usage
    : undefined;
  const turn = info && isRecord(info.last_token_usage)
    ? info.last_token_usage
    : undefined;
  if (total) {
    state.lastTotal = total;
    state.lastActivityAt = eventTimestamp;
  }
  if (turn) {
    state.lastTurn = turn;
    state.lastActivityAt = eventTimestamp;
  }
  const rateLimits = parseCodexRateLimits(payload.rate_limits, eventTimestamp);
  if (rateLimits) state.lastRateLimits = rateLimits;
}

function finishCodexFinancialStream(
  state: CodexFinancialStreamState,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall | undefined {
  if (!state.lastTotal || state.isSubagent && !state.rootTaskStarted) return undefined;
  const parsedUsage = parseCodexCumulativeUsage(
    state.lastTotal,
    state.inheritedUsageBaseline
  );
  const parsedTurn = state.lastTurn
    ? parseCodexTurnUsage(state.lastTurn)
    : { supported: true as const };
  const usageSupport = parsedUsage.supported && parsedTurn.supported
    ? "complete" as const
    : "unsupported_token_shape" as const;
  if (usageSupport === "unsupported_token_shape") {
    onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  }
  const workingDirectory = absoluteWorkingDirectory(state.rootCwd);
  return {
    agent: "codex",
    model: state.model ?? "codex",
    timestamp: state.lastActivityAt ?? state.startedAt ?? new Date(0).toISOString(),
    startedAt: state.startedAt,
    project: projectFromCwd(workingDirectory),
    workingDirectory,
    sessionId: state.sessionId,
    rateLimits: state.lastRateLimits,
    ...(usageSupport === "complete" && parsedTurn.usage
      ? { latestTurnUsage: parsedTurn.usage }
      : {}),
    usageScope: "session_cumulative",
    usageSupport,
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    usage: parsedUsage.usage
  };
}

/** Aggregate per-call usage into one UsageRecord per day+agent+model+project. */
export function aggregateCalls(calls: LocalAgentCall[]): UsageRecord[] {
  return aggregateCallsForFormats(calls, localAgentFormatDescriptors);
}

/** @internal Registry-aware aggregation used by the extensible ingestion engine. */
export function aggregateCallsForFormats(
  calls: LocalAgentCall[],
  descriptors: readonly LocalAgentFormatDescriptor[]
): UsageRecord[] {
  const formats = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const groups = new Map<string, LocalAgentCall[]>();
  for (const call of dedupeCumulativeSessionCalls(calls)) {
    const day = call.timestamp.slice(0, 10);
    const key = [day, call.agent, call.model, call.project ?? "unattributed"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }

  const records: UsageRecord[] = [];
  for (const [key, groupCalls] of groups) {
    const [day, agent, model, project] = key.split("|") as [string, LocalAgentFormatId, string, string];
    const format = formats.get(agent);
    const usage: TokenUsage = {
      inputTokens: sum(groupCalls, (c) => c.usage.inputTokens),
      outputTokens: sum(groupCalls, (c) => c.usage.outputTokens),
      cacheReadTokens: sum(groupCalls, (c) => c.usage.cacheReadTokens ?? 0),
      cacheWrite5mTokens: sum(groupCalls, (c) => c.usage.cacheWrite5mTokens ?? 0),
      cacheWrite1hTokens: sum(groupCalls, (c) => c.usage.cacheWrite1hTokens ?? 0),
      thoughtTokens: sum(groupCalls, (c) => c.usage.thoughtTokens ?? 0),
      toolTokens: sum(groupCalls, (c) => c.usage.toolTokens ?? 0)
    };
    const usageSupported = groupCalls.every((call) => call.usageSupport !== "unsupported_token_shape");
    const sourceVersions = [...new Set(
      groupCalls.flatMap((call) => call.sourceVersion ? [call.sourceVersion] : [])
    )].sort().slice(0, 8);
    const tieredPricingEvidenceSupported = !usesPromptTieredPricing(model) ||
      agent !== "gemini-cli" ||
      groupCalls.every(hasCompleteGeminiPromptEvidence);
    const amountUsd = usageSupported && tieredPricingEvidenceSupported && format
      ? agent === "gemini-cli" && usesPromptTieredPricing(model)
        ? estimateTokenCostsUsd(model, groupCalls.map((call) => call.usage))
        : estimateTokenCostUsd(model, usage)
      : undefined;
    const priced = usageSupported && typeof amountUsd === "number";
    records.push({
      id: slug(["local", agent, day, model, project].join("-")),
      timestamp: new Date(`${day}T00:00:00Z`).toISOString(),
      source: {
        id: format?.sourceRecord.id ?? "local-agent-logs",
        name: format?.sourceRecord.name ?? "Local agent session logs",
        provider: format?.provider ?? "unknown",
        confidence: format?.confidenceDefaults.sourceConfidence ?? "estimated",
        observedFrom: format?.sourceRecord.observedFrom ?? "unregistered local transcript (this machine)"
      },
      model,
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) +
        (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0) +
        (usage.toolTokens ?? 0),
      outputTokens: usage.outputTokens + (usage.thoughtTokens ?? 0),
      ...(agent === "gemini-cli"
        ? {
            ...(groupCalls.every((call) => call.usage.cacheReadTokens !== undefined)
              ? { cacheReadTokens: usage.cacheReadTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.usage.thoughtTokens !== undefined)
              ? { thoughtTokens: usage.thoughtTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.usage.toolTokens !== undefined)
              ? { toolTokens: usage.toolTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.reportedTotalTokens !== undefined)
              ? { reportedTotalTokens: sum(groupCalls, (call) => call.reportedTotalTokens ?? 0) }
              : {}),
            ...(sourceVersions.length > 0 ? { sourceVersions } : {})
          }
        : {}),
      amountUsd: priced ? amountUsd : null,
      costConfidence: priced
        ? format?.confidenceDefaults.pricedFinancialEvidence ?? "estimated"
        : format?.confidenceDefaults.unpricedFinancialEvidence ?? "missing",
      // `(home)` is an attribution fallback, not a real project. Keep it on
      // LocalAgentCall for Glance/session context, but do not promote it to a
      // high-confidence project id in receipts or the attribution engine.
      projectId: project === "unattributed" || project === "(home)" ? undefined : project,
      agentId: agent,
      providerCostType: format?.sourceRecord.providerCostType ?? "local_agent_logs",
      usageGranularity: format?.sourceRecord.usageGranularity ?? "daily_aggregate",
      quantity: groupCalls.length,
      operation: format?.sourceRecord.operation ?? `${agent} sessions`
    });
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function hasCompleteGeminiPromptEvidence(call: LocalAgentCall): boolean {
  const evidence = call.geminiTokenEvidence;
  if (call.usageSupport !== "complete" || !evidence ||
      evidence.cacheAccounting === "unknown") {
    return false;
  }
  const components = [
    evidence.input,
    evidence.output,
    evidence.cached,
    evidence.thoughts,
    evidence.tool,
    evidence.total
  ];
  if (!components.every((value) => Number.isSafeInteger(value) && (value ?? -1) >= 0)) {
    return false;
  }
  const input = evidence.input!;
  const output = evidence.output!;
  const cached = evidence.cached!;
  const thoughts = evidence.thoughts!;
  const tool = evidence.tool!;
  const freshInput = evidence.cacheAccounting === "included"
    ? input - cached
    : input;
  const expectedTotal = input + output + thoughts + tool;
  const threshold = promptTierThreshold(call.model);
  // Gemini exposes promptTokenCount and toolUsePromptTokenCount separately,
  // while the published >200k rule does not resolve which side owns tool
  // prompt tokens. Only price when both interpretations select the same tier.
  const promptTierIsUnambiguous = threshold === undefined ||
    input > threshold || input + tool <= threshold;
  return freshInput >= 0 && Number.isSafeInteger(expectedTotal) &&
    promptTierIsUnambiguous &&
    evidence.total === expectedTotal &&
    call.usage.inputTokens === freshInput &&
    call.usage.outputTokens === output &&
    call.usage.cacheReadTokens === cached &&
    call.usage.thoughtTokens === thoughts &&
    call.usage.toolTokens === tool;
}

async function listFormatCandidateFiles(
  root: string,
  descriptor: LocalAgentFormatDescriptor,
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
      else if (entry.isFile() && matchesLocalAgentDetectionFile(descriptor, path)) {
        scan.detectionSignals = (scan.detectionSignals ?? 0) + 1;
      } else if (entry.isFile() && matchesLocalAgentFormatFile(descriptor, path)) {
        out.push(path);
        scan.filesDiscovered += 1;
      }
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function emptySourceScan(agent: LocalAgentFormatId): LocalAgentSourceScan {
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
  agent: LocalAgentFormatId,
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
  agent: LocalAgentFormatId,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  diagnostic: TranscriptParseDiagnostic
): void {
  if (diagnostic.code === "malformed_jsonl" || diagnostic.code === "malformed_session_file") {
    scan.malformedLines += diagnostic.count;
    diagnostics.push({
      agent,
      code: diagnostic.code,
      severity: "warning",
      message: diagnostic.code === "malformed_jsonl"
        ? `${diagnostic.count} malformed JSONL line(s) were skipped in ${agentLabel(agent)} transcripts.`
        : `${diagnostic.count} malformed session file(s) were skipped in ${agentLabel(agent)} transcripts.`,
      count: diagnostic.count
    });
    return;
  }
  scan.unsupportedUsageSnapshots += diagnostic.count;
  diagnostics.push({
    agent,
    code: diagnostic.code,
    severity: "warning",
    message: `${diagnostic.count} ${agentLabel(agent)} token snapshot(s) lacked the complete, internally consistent fields required for safe normalization and pricing.`,
    count: diagnostic.count
  });
}

function agentLabel(agent: LocalAgentFormatId): string {
  return localAgentFormatLabel(agent);
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

function tokenComponentOf(value: unknown): number | undefined {
  const parsed = numberOf(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
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
