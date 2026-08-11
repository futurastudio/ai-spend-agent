import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { TokenUsage } from "../modelPricing.js";

export type GeminiCacheAccounting = "included" | "none" | "unknown";

export type GeminiTokenEvidence = {
  /** Raw provider fields. Invalid or absent fields remain absent. */
  readonly input?: number;
  readonly output?: number;
  readonly cached?: number;
  readonly thoughts?: number;
  readonly tool?: number;
  readonly total?: number;
  /** Whether the reported input count includes the cached count. */
  readonly cacheAccounting: GeminiCacheAccounting;
};

/**
 * Structural call type that can be wired into LocalAgentCall once the Gemini
 * registry descriptor is enabled. It deliberately exposes no prompt content
 * or raw project hash.
 */
export type GeminiParsedCall = {
  readonly agent: "gemini-cli";
  readonly callId: string;
  readonly model: string;
  readonly timestamp: string;
  readonly startedAt?: string;
  readonly project?: string;
  readonly workingDirectory?: string;
  readonly sessionId?: string;
  readonly usageScope: "turn";
  readonly usageSupport: "complete" | "unsupported_token_shape";
  readonly reportedTotalTokens?: number;
  readonly sourceVersion?: string;
  readonly usage: TokenUsage;
  readonly geminiTokenEvidence: GeminiTokenEvidence;
};

export type GeminiParseDiagnosticCode =
  | "malformed_json"
  | "malformed_jsonl"
  | "unsupported_token_shape"
  | "missing_timestamp";

export type GeminiParseDiagnostic = {
  readonly code: GeminiParseDiagnosticCode;
  readonly count: number;
};

export type GeminiParseOptions = {
  /** Caller-supplied path, including recursive chats/subagent paths. */
  readonly filePath: string;
  readonly sinceMs?: number;
};

export type GeminiParseResult = {
  readonly calls: GeminiParsedCall[];
  readonly diagnostics: GeminiParseDiagnostic[];
};

type JsonRecord = Record<string, unknown>;

type SessionMetadata = {
  sessionId?: string;
  projectHash?: string;
  startedAt?: string;
  model?: string;
  sourceVersion?: string;
  project?: string;
  workingDirectory?: string;
};

type MutableParseState = {
  metadata: SessionMetadata;
  keyedCalls: Map<string, GeminiParsedCall>;
  diagnostics: DiagnosticCounter;
  filePath: string;
  sinceMs?: number;
};

type TokenField = {
  present: boolean;
  value?: number;
};

type ParsedTokens = {
  usage: TokenUsage;
  evidence: GeminiTokenEvidence;
  supported: boolean;
  reportedTotalTokens?: number;
};

class DiagnosticCounter {
  readonly #counts = new Map<GeminiParseDiagnosticCode, number>();

  add(code: GeminiParseDiagnosticCode, count = 1): void {
    this.#counts.set(code, (this.#counts.get(code) ?? 0) + count);
  }

  values(): GeminiParseDiagnostic[] {
    return [...this.#counts].map(([code, count]) => ({ code, count }));
  }
}

/** Parse a Gemini chat file according to its caller-supplied extension. */
export function parseGeminiSession(
  content: string,
  options: GeminiParseOptions
): GeminiParseResult {
  const extension = extensionOf(options.filePath);
  if (extension === ".jsonl") return parseGeminiJsonlSession(content, options);
  if (extension === ".json") return parseGeminiJsonSession(content, options);

  // A registry should normally constrain extensions. This fallback keeps the
  // standalone API useful without guessing a malformed JSON document is JSONL.
  try {
    JSON.parse(content);
    return parseGeminiJsonSession(content, options);
  } catch {
    return parseGeminiJsonlSession(content, options);
  }
}

/** Parse the legacy whole-conversation JSON representation. */
export function parseGeminiJsonSession(
  content: string,
  options: GeminiParseOptions
): GeminiParseResult {
  const state = createState(options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    state.diagnostics.add("malformed_json");
    return finish(state);
  }

  if (Array.isArray(parsed)) {
    processRecordSequence(parsed, state);
    return finish(state);
  }
  if (!isRecord(parsed)) {
    state.diagnostics.add("unsupported_token_shape");
    return finish(state);
  }

  state.metadata = mergeMetadata(state.metadata, parsed);
  if (Object.prototype.hasOwnProperty.call(parsed, "messages")) {
    if (!Array.isArray(parsed.messages)) {
      state.diagnostics.add("unsupported_token_shape");
      return finish(state);
    }
    for (const message of parsed.messages) {
      if (isRecord(message)) processMessage(message, state);
    }
  } else {
    processRecord(parsed, state);
  }
  return finish(state);
}

/** Parse the append-only current JSONL message representation. */
export function parseGeminiJsonlSession(
  content: string,
  options: GeminiParseOptions
): GeminiParseResult {
  // Gemini's loader remains backward compatible with a legacy conversation
  // document even when the file has a .jsonl suffix. Accept that exact shape
  // before falling back to the append-only line reader.
  try {
    const whole = JSON.parse(content);
    if (Array.isArray(whole) || (isRecord(whole) && Array.isArray(whole.messages))) {
      return parseGeminiJsonSession(content, options);
    }
  } catch {
    // A normal JSONL stream is not one JSON document.
  }
  const state = createState(options);
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      state.diagnostics.add("malformed_jsonl");
      continue;
    }
    if (!isRecord(parsed)) {
      state.diagnostics.add("unsupported_token_shape");
      continue;
    }
    processRecord(parsed, state);
  }
  return finish(state);
}

function createState(options: GeminiParseOptions): MutableParseState {
  return {
    metadata: {},
    keyedCalls: new Map(),
    diagnostics: new DiagnosticCounter(),
    filePath: options.filePath,
    ...(options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {})
  };
}

function processRecordSequence(values: unknown[], state: MutableParseState): void {
  for (const value of values) {
    if (isRecord(value)) processRecord(value, state);
  }
}

function processRecord(record: JsonRecord, state: MutableParseState): void {
  if (isRecord(record.$set)) {
    const update = record.$set;
    state.metadata = mergeMetadata(state.metadata, update);
    if (Object.prototype.hasOwnProperty.call(update, "messages")) {
      if (!Array.isArray(update.messages)) {
        state.diagnostics.add("unsupported_token_shape");
        return;
      }
      // A checkpoint can replace conversational state, but earlier model work
      // was still incurred usage. Reprocessing keyed messages updates matching
      // ids without deleting prior unique token-bearing calls.
      for (const message of update.messages) {
        if (isRecord(message)) processMessage(message, state);
      }
    }
    return;
  }

  if (nonEmptyString(record.$rewindTo)) {
    // Rewind changes resumable conversation state, not already incurred model
    // usage. Financial evidence therefore keeps earlier token-bearing calls.
    return;
  }

  state.metadata = mergeMetadata(state.metadata, record);
  if (Object.prototype.hasOwnProperty.call(record, "messages")) {
    if (!Array.isArray(record.messages)) {
      state.diagnostics.add("unsupported_token_shape");
      return;
    }
    for (const message of record.messages) {
      if (isRecord(message)) processMessage(message, state);
    }
    return;
  }
  if (record.type === "gemini") {
    processMessage(record, state);
  } else if (Object.prototype.hasOwnProperty.call(record, "tokens")) {
    // Evolving token-bearing envelopes are evidence of coverage we cannot yet
    // normalize. Surface partial coverage instead of silently omitting them.
    state.diagnostics.add("unsupported_token_shape");
  }
}

function processMessage(message: JsonRecord, state: MutableParseState): void {
  if (message.type !== "gemini") {
    if (Object.prototype.hasOwnProperty.call(message, "tokens")) {
      state.diagnostics.add("unsupported_token_shape");
    }
    return;
  }
  const messageId = nonEmptyString(message.id);
  // A later tokenless duplicate must not erase an earlier complete snapshot.
  // A unique tokenless Gemini response is still missing financial evidence,
  // so retain it as unsupported instead of silently calling coverage complete.
  if ((!Object.prototype.hasOwnProperty.call(message, "tokens") || message.tokens === null) &&
      messageId &&
      state.keyedCalls.get(messageId)?.usageSupport === "complete") {
    return;
  }

  const timestamp = firstIsoTimestamp(
    message.timestamp,
    message.createdAt,
    message.created_at
  );
  if (!timestamp) {
    state.diagnostics.add("missing_timestamp");
    return;
  }
  if (state.sinceMs !== undefined && Date.parse(timestamp) < state.sinceMs) return;

  const parsedTokens = parseTokens(message.tokens);

  const metadata = mergeMetadata(state.metadata, message);
  const attribution: { project?: string; workingDirectory?: string } | undefined =
    explicitAttribution(message, metadata) ??
    opaqueAttribution(state.filePath, metadata.projectHash);
  const sessionId = firstString(message.sessionId, message.session_id, metadata.sessionId);
  if (!messageId || !sessionId) {
    // A stable session + message identity is required to prevent copied or
    // checkpointed chat files from being counted twice across the chats tree.
    state.diagnostics.add("unsupported_token_shape");
    return;
  }
  const sourceVersion = sourceVersionOf(message) ?? metadata.sourceVersion;
  const model = firstString(message.model, metadata.model) ?? "gemini-cli-unknown";
  const startedAt = isoTimestamp(metadata.startedAt);
  const call: GeminiParsedCall = {
    agent: "gemini-cli",
    callId: messageId,
    model,
    timestamp,
    ...(startedAt ? { startedAt } : {}),
    ...(attribution?.project ? { project: attribution.project } : {}),
    ...(attribution?.workingDirectory
      ? { workingDirectory: attribution.workingDirectory }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    usageScope: "turn",
    usageSupport: parsedTokens.supported ? "complete" : "unsupported_token_shape",
    ...(parsedTokens.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedTokens.reportedTotalTokens }
      : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    usage: parsedTokens.usage,
    geminiTokenEvidence: parsedTokens.evidence
  };

  // Delete first so iteration order also reflects the authoritative snapshot.
  state.keyedCalls.delete(messageId);
  state.keyedCalls.set(messageId, call);
}

function parseTokens(value: unknown): ParsedTokens {
  if (!isRecord(value)) {
    return {
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      evidence: { cacheAccounting: "unknown" },
      supported: false
    };
  }

  const input = tokenField(value, "input");
  const output = tokenField(value, "output");
  const cached = tokenField(value, "cached");
  const thoughts = tokenField(value, "thoughts");
  const tool = tokenField(value, "tool");
  const total = tokenField(value, "total");
  const detailedFieldsValid = thoughts.present && thoughts.value !== undefined &&
    tool.present && tool.value !== undefined;
  const requiredFieldsValid = input.present && input.value !== undefined &&
    output.present && output.value !== undefined &&
    cached.present && cached.value !== undefined &&
    total.present && total.value !== undefined;

  const rawInput = input.value;
  const rawOutput = output.value;
  const rawCached = cached.value;
  const rawThoughts = thoughts.value ?? 0;
  const rawTool = tool.value ?? 0;
  const rawTotal = total.value;
  let cacheAccounting: GeminiCacheAccounting = "unknown";

  if (requiredFieldsValid && detailedFieldsValid &&
      rawInput !== undefined && rawOutput !== undefined &&
      rawCached !== undefined && rawTotal !== undefined) {
    const includedTotal = rawInput + rawOutput + rawThoughts + rawTool;
    if (Number.isSafeInteger(includedTotal)) {
      if (rawCached === 0 && rawTotal === includedTotal) {
        cacheAccounting = "none";
      } else if (rawTotal === includedTotal && rawCached <= rawInput) {
        cacheAccounting = "included";
      }
    }
  }

  const supported = requiredFieldsValid && detailedFieldsValid &&
    cacheAccounting !== "unknown";
  const normalizedInput = cacheAccounting === "included"
    ? (rawInput ?? 0) - (rawCached ?? 0)
    : cacheAccounting === "none"
      ? rawInput ?? 0
      : 0;
  // Cached is an independently reported component. Retain it even when the
  // fresh-input split is ambiguous; fresh input remains zero in that state so
  // this never double-counts an uncertain overlap.
  const normalizedCache = rawCached ?? 0;

  return {
    usage: {
      inputTokens: normalizedInput,
      outputTokens: rawOutput ?? 0,
      ...(cached.value !== undefined ? { cacheReadTokens: normalizedCache } : {}),
      ...(thoughts.value !== undefined ? { thoughtTokens: rawThoughts } : {}),
      ...(tool.value !== undefined ? { toolTokens: rawTool } : {})
    },
    evidence: {
      ...(rawInput !== undefined ? { input: rawInput } : {}),
      ...(rawOutput !== undefined ? { output: rawOutput } : {}),
      ...(rawCached !== undefined ? { cached: rawCached } : {}),
      ...(thoughts.value !== undefined ? { thoughts: thoughts.value } : {}),
      ...(tool.value !== undefined ? { tool: tool.value } : {}),
      ...(rawTotal !== undefined ? { total: rawTotal } : {}),
      cacheAccounting
    },
    supported,
    ...(rawTotal !== undefined ? { reportedTotalTokens: rawTotal } : {})
  };
}

function tokenField(record: JsonRecord, key: string): TokenField {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { present: true, value }
    : { present: true };
}

function mergeMetadata(current: SessionMetadata, record: JsonRecord): SessionMetadata {
  const sessionId = firstString(record.sessionId, record.session_id);
  const projectHash = nonEmptyString(record.projectHash);
  const startedAt = firstIsoTimestamp(record.startTime, record.startedAt);
  const model = nonEmptyString(record.model);
  const sourceVersion = sourceVersionOf(record);
  const explicit = explicitAttributionFromRecord(record, projectHash ?? current.projectHash);
  return {
    ...current,
    ...(sessionId ? { sessionId } : {}),
    ...(projectHash ? { projectHash } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(model ? { model } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(explicit?.project ? { project: explicit.project } : {}),
    ...(explicit?.workingDirectory
      ? { workingDirectory: explicit.workingDirectory }
      : {})
  };
}

function sourceVersionOf(record: JsonRecord): string | undefined {
  return safeVersionString(record.geminiCliVersion) ?? safeVersionString(record.cliVersion);
}

function safeVersionString(value: unknown): string | undefined {
  const parsed = nonEmptyString(value);
  return parsed && parsed.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(parsed)
    ? parsed
    : undefined;
}

function explicitAttribution(
  record: JsonRecord,
  metadata: SessionMetadata
): { project?: string; workingDirectory?: string } | undefined {
  return explicitAttributionFromRecord(record, metadata.projectHash) ??
    (metadata.project || metadata.workingDirectory
      ? {
          ...(metadata.project ? { project: metadata.project } : {}),
          ...(metadata.workingDirectory
            ? { workingDirectory: metadata.workingDirectory }
            : {})
        }
      : undefined);
}

function explicitAttributionFromRecord(
  record: JsonRecord,
  projectHash?: string
): { project?: string; workingDirectory?: string } | undefined {
  const pathValue = firstString(
    record.cwd,
    record.workingDirectory,
    record.working_directory,
    record.projectPath,
    record.project_path
  );
  if (pathValue && isAbsolutePath(pathValue)) {
    const normalized = trimTrailingSeparators(pathValue);
    const project = lastPathSegment(normalized);
    if (project) return { project, workingDirectory: normalized };
  }

  const project = nonEmptyString(record.project);
  if (!project || project === projectHash || looksLikeProjectHash(project)) return undefined;
  if (project.includes("/") || project.includes("\\")) return undefined;
  return { project };
}

function opaqueAttribution(
  filePath: string,
  metadataProjectHash?: string
): { project?: string; workingDirectory?: string } | undefined {
  const pathProjectHash = projectHashFromPath(filePath);
  const recordedProjectHash = metadataProjectHash && looksLikeProjectHash(metadataProjectHash)
    ? metadataProjectHash
    : undefined;
  // Conflicting opaque identities are not attribution evidence. Financial
  // tokens remain usable, but project ownership stays unattributed.
  if (pathProjectHash && recordedProjectHash && pathProjectHash !== recordedProjectHash) {
    return undefined;
  }
  const projectHash = pathProjectHash ?? recordedProjectHash;
  if (!projectHash) return undefined;
  const alias = createHash("sha256").update(projectHash).digest("hex").slice(0, 12);
  return { project: `gemini-project-${alias}` };
}

function projectHashFromPath(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== "chats" || index === 0) continue;
    const value = parts[index - 1];
    if (value && looksLikeProjectHash(value)) return value;
  }
  return undefined;
}

function looksLikeProjectHash(value: string): boolean {
  return /^[a-f\d]{64}$/i.test(value);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed || value;
}

function lastPathSegment(value: string): string | undefined {
  return value.split(/[\\/]+/).filter(Boolean).at(-1);
}

function finish(state: MutableParseState): GeminiParseResult {
  const calls = [...state.keyedCalls.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const unsupported = calls.filter((call) => (
    call.usageSupport === "unsupported_token_shape"
  )).length;
  if (unsupported > 0) state.diagnostics.add("unsupported_token_shape", unsupported);
  return {
    calls,
    diagnostics: state.diagnostics.values()
  };
}

function extensionOf(filePath: string): string {
  const basename = filePath.split(/[\\/]+/).at(-1) ?? "";
  const index = basename.lastIndexOf(".");
  return index >= 0 ? basename.slice(index).toLowerCase() : "";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = nonEmptyString(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function firstIsoTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = isoTimestamp(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
