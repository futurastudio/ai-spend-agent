import { constants } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { localAgentQualitativeParserVersion } from "./localAgentLogs.js";
import type {
  LocalAgentQualitativeIndexAdapter,
  LocalAgentQualitativeIndexKey,
  LocalAgentQualitativeIndexValue
} from "./localAgentLogs.js";

export const qualitativeIndexCacheEnvironmentVariable = "AIBILL_CACHE_DIR";
export const qualitativeIndexCacheFileName = "qualitative-index-v1.json";
export const qualitativeIndexCacheLockFileName = ".qualitative-index-v1.lock";
export const qualitativeIndexCacheMaxBytes = 32 * 1_024 * 1_024;
export const qualitativeIndexCacheMaxEntryBytes = 8 * 1_024 * 1_024;
export const qualitativeIndexCacheMaxEntries = 256;

const defaultLockTimeoutMs = 2_000;
const staleLockMs = 30_000;
const lockPollMs = 20;
const lockMetadataMaxBytes = 512;
const execFile = promisify(execFileCallback);

type WriterLockOwner = {
  pid: number;
  token: string;
};

type WriterLockIdentity = WriterLockOwner & {
  dev: number;
  ino: number;
};

/**
 * Storage options for the private warm index. The limit overrides exist for
 * tests and constrained embeddings and can only make the fixed production
 * bounds smaller.
 */
export type QualitativeIndexCacheOptions = {
  cacheDirectory?: string;
  homeDirectory?: string;
  lockTimeoutMs?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
};

export class QualitativeIndexCacheError extends Error {
  readonly code:
    | "unsafe_directory"
    | "unsafe_file"
    | "oversized"
    | "malformed"
    | "unsupported_version"
    | "permission"
    | "lock_timeout"
    | "invalid_key"
    | "invalid_value"
    | "io";

  constructor(code: QualitativeIndexCacheError["code"], message: string) {
    super(message);
    this.name = "QualitativeIndexCacheError";
    this.code = code;
  }
}

const finiteNonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedString = z.string().min(1).max(4_096);
const opaqueIdentifier = z.string().min(1).max(1_024);
const isoTimestamp = z.string().datetime({ offset: true });
const agentSchema = z.enum(["claude-code", "codex", "gemini-cli"]);

const tokenUsageSchema = z.object({
  inputTokens: finiteNonnegativeInteger,
  outputTokens: finiteNonnegativeInteger,
  cacheReadTokens: finiteNonnegativeInteger.optional(),
  cacheWrite5mTokens: finiteNonnegativeInteger.optional(),
  cacheWrite1hTokens: finiteNonnegativeInteger.optional(),
  thoughtTokens: finiteNonnegativeInteger.optional(),
  toolTokens: finiteNonnegativeInteger.optional()
}).strict();

const turnUsageSchema = tokenUsageSchema.extend({
  contextTokens: finiteNonnegativeInteger,
  totalTokens: finiteNonnegativeInteger,
  source: z.enum([
    "assistant_message_usage",
    "transcript_last_token_usage",
    "call_usage"
  ])
}).strict();

const tokenComponentEvidenceSchema = z.object({
  inputTokens: z.literal("observed"),
  outputTokens: z.literal("observed"),
  cacheReadTokens: z.enum(["observed", "not_separately_reported"]),
  cacheWriteTokens: z.enum(["observed", "partial", "not_separately_reported"]),
  thoughtTokens: z.enum(["observed", "not_separately_reported"]),
  toolTokens: z.enum(["observed", "not_separately_reported"]),
  calculatedTotalTokens: z.enum(["calculated_complete", "calculated_partial"]),
  reportedTotalTokens: z.enum(["provider_reported", "not_reported"])
}).strict();

const completionSchema = z.object({
  status: z.literal("completed"),
  evidence: z.enum(["claude_turn_duration", "codex_task_complete"]),
  observedAt: isoTimestamp
}).strict();

const subagentCompletionSchema = z.object({
  subagentId: opaqueIdentifier,
  observedAt: isoTimestamp
}).strict();

const geminiEvidenceSchema = z.object({
  input: finiteNonnegativeInteger.optional(),
  output: finiteNonnegativeInteger.optional(),
  cached: finiteNonnegativeInteger.optional(),
  thoughts: finiteNonnegativeInteger.optional(),
  tool: finiteNonnegativeInteger.optional(),
  total: finiteNonnegativeInteger.optional(),
  cacheAccounting: z.enum(["included", "none", "unknown"])
}).strict();

const rateLimitWindowSchema = z.object({
  kind: z.enum(["five-hour", "weekly", "custom"]),
  name: z.string().min(1).max(128),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: finiteNonnegativeInteger.refine((value) => value > 0),
  resetsAt: isoTimestamp
}).strict();

const rateLimitsSchema = z.object({
  observedAt: isoTimestamp,
  limitId: opaqueIdentifier.optional(),
  planType: z.string().min(1).max(256).optional(),
  windows: z.array(rateLimitWindowSchema).max(16)
}).strict();

const activitySchema = z.object({
  summary: z.string().min(1).max(512),
  kind: z.enum(["task", "automation", "agent", "file", "project"]),
  action: z.enum([
    "building",
    "refining",
    "fixing",
    "testing",
    "auditing",
    "researching",
    "configuring",
    "publishing",
    "running",
    "working"
  ]),
  source: z.enum(["agent_title", "user_prompts", "file_activity", "project"]),
  promptCount: finiteNonnegativeInteger,
  toolCallCount: finiteNonnegativeInteger,
  files: z.array(z.string().min(1).max(512).refine(isBasename)).max(5),
  isSubagent: z.boolean(),
  parentSessionId: opaqueIdentifier.optional()
}).strict();

/**
 * Deliberately omits `workingDirectory`. A cache hit does not need the raw
 * absolute path to reproduce token/action evidence, and persisting it would
 * violate the opaque-path boundary promised by this index.
 */
const callSchema = z.object({
  agent: agentSchema,
  callId: opaqueIdentifier.optional(),
  model: boundedString,
  timestamp: isoTimestamp,
  startedAt: isoTimestamp.optional(),
  project: z.string().min(1).max(512).refine(isBasename).optional(),
  workingDirectoryRef: z.string().regex(/^avref_[a-f0-9]{64}$/).optional(),
  latestTurnUsage: turnUsageSchema.optional(),
  usageScope: z.enum(["turn", "session_cumulative"]).optional(),
  usageSupport: z.enum(["complete", "unsupported_token_shape"]).optional(),
  reportedTotalTokens: finiteNonnegativeInteger.optional(),
  tokenComponentEvidence: tokenComponentEvidenceSchema.optional(),
  sourceVersion: z.string().min(1).max(64).optional(),
  completion: completionSchema.optional(),
  geminiTokenEvidence: geminiEvidenceSchema.optional(),
  usage: tokenUsageSchema,
  sessionId: opaqueIdentifier.optional(),
  subagentId: opaqueIdentifier.optional(),
  subagentCompletions: z.array(subagentCompletionSchema).max(10_000).optional(),
  rateLimits: rateLimitsSchema.optional(),
  activity: activitySchema.optional()
}).strict();

const invocationCountSchema = z.object({
  name: z.string().min(1).max(1_024),
  count: finiteNonnegativeInteger.refine((value) => value > 0)
}).strict();

const nestedSessionSchema = z.object({
  sessionId: opaqueIdentifier.optional(),
  isSubagent: z.boolean(),
  parentSessionId: opaqueIdentifier.optional()
}).strict();

const contextSignalSchema = z.object({
  agent: z.enum(["claude-code", "codex"]),
  sessionId: opaqueIdentifier.optional(),
  lastActivityAt: isoTimestamp.optional(),
  compactionEvents: finiteNonnegativeInteger,
  fileReads: z.array(invocationCountSchema).max(10_000),
  repeatedFileReads: z.array(invocationCountSchema).max(10_000),
  isSubagent: z.boolean(),
  parentSessionId: opaqueIdentifier.optional(),
  nestedSessions: z.array(nestedSessionSchema).max(10_000).optional(),
  readCoverage: z.literal("explicit_read_tools_only")
}).strict();

const invocationFileSchema = z.object({
  invocations: z.array(invocationCountSchema).max(10_000),
  invokedMcpTools: z.array(z.string().min(1).max(1_024)).max(10_000),
  invokedSkills: z.array(z.string().min(1).max(1_024)).max(10_000),
  invokedSubagents: z.array(z.string().min(1).max(1_024)).max(10_000),
  invokedCommands: z.array(z.string().min(1).max(1_024)).max(10_000),
  assistantTurns: finiteNonnegativeInteger,
  contextSignal: contextSignalSchema
}).strict();

const invocationWindowProofSchema = z.object({
  earliestCountedAt: isoTimestamp.optional(),
  allCountedEventsTimestamped: z.boolean()
}).strict();

const diagnosticSchema = z.object({
  code: z.enum([
    "malformed_jsonl",
    "malformed_session_file",
    "unsupported_token_shape"
  ]),
  count: finiteNonnegativeInteger.refine((value) => value > 0)
}).strict();

const keySchema = z.object({
  schemaVersion: z.literal(1),
  // Entries persisted by an older parser contract fail closed as misses —
  // never reinterpreted under the streaming-era parser.
  parserVersion: z.literal(localAgentQualitativeParserVersion),
  agent: agentSchema,
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileIdentity: z.string().min(11).max(256).regex(
    /^\d+(?:\.\d+)?:\d+(?:\.\d+)?:\d+(?:\.\d+)?:\d+(?:\.\d+)?:\d+(?:\.\d+)?:\d+(?:\.\d+)?$/
  ),
  sinceIso: isoTimestamp.nullable(),
  collectInvocationEvidence: z.boolean()
}).strict();

const valueSchema = z.object({
  calls: z.array(callSchema).max(100_000),
  invocationFile: invocationFileSchema.optional(),
  invocationWindowProof: invocationWindowProofSchema.optional(),
  diagnostics: z.array(diagnosticSchema).max(10_000)
}).strict();

const entrySchema = z.object({
  key: keySchema,
  storedAt: isoTimestamp,
  value: valueSchema
}).strict();

const indexSchema = z.object({
  kind: z.literal("aibill.qualitative_index"),
  schemaVersion: z.literal(1),
  entries: z.array(entrySchema).max(qualitativeIndexCacheMaxEntries)
}).strict();

export type PersistedQualitativeKey = z.infer<typeof keySchema>;
export type PersistedQualitativeValue = z.infer<typeof valueSchema>;
type PersistedKey = PersistedQualitativeKey;
type PersistedValue = PersistedQualitativeValue;
type PersistedIndex = z.infer<typeof indexSchema>;
type PersistedEntry = PersistedIndex["entries"][number];

/**
 * Strict v1 entry contracts, exported for the v2 sharded project-index store.
 * The v2 store persists the same privacy-reduced shapes under a different
 * layout; sharing the schemas keeps the two stores provably consistent.
 */
export const qualitativeEntryKeySchema = keySchema;
export const qualitativeEntryValueSchema = valueSchema;

type IndexReadResult =
  | { status: "ok"; index: PersistedIndex }
  | { status: "missing" }
  | {
      status: "error";
      code: "unsafe_file" | "oversized" | "malformed" | "unsupported_version" | "permission" | "io";
    };

/** Resolve the fixed warm-index path without trusting or creating it. */
export function qualitativeIndexCachePath(options: QualitativeIndexCacheOptions = {}): string {
  return join(configuredCacheDirectory(options), qualitativeIndexCacheFileName);
}

/**
 * Build the adapter consumed by `loadLocalAgentUsage({ qualitativeIndex })`.
 * Reads fail closed and writes are serialized, atomic, private, and bounded.
 */
export function createQualitativeIndexCacheAdapter(
  options: QualitativeIndexCacheOptions = {}
): LocalAgentQualitativeIndexAdapter {
  // One command can ask about many selected files. Parse the private index at
  // most once in this process instead of allocating/validating the whole JSON
  // document for every file lookup. Transcript identity is still rechecked by
  // the loader before any cached value is accepted.
  let loadedIndex: Promise<PersistedIndex | undefined> | undefined;
  const index = () => {
    loadedIndex ??= loadCachedIndex(options).catch((error: unknown) => {
      // A caller may repair or replace malformed local state between reads.
      // Share one failing attempt, then permit a fresh safe validation.
      loadedIndex = undefined;
      throw error;
    });
    return loadedIndex;
  };
  return {
    read: async (key) => selectCachedValue(parseKey(key), await index()),
    write: async (key, value) => {
      await writeCachedValue(key, value, options);
      // A second process may have merged another entry while this writer held
      // the lock. Reload once on the next read rather than treating this
      // process's pre-write snapshot as authoritative.
      loadedIndex = undefined;
    }
  };
}

async function loadCachedIndex(
  options: QualitativeIndexCacheOptions
): Promise<PersistedIndex | undefined> {
  let directory: string;
  try {
    directory = await resolveCacheDirectory(false, options);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw normalizeError(error, "unsafe_directory");
  }
  const result = await readIndexFile(directory, options);
  if (result.status === "missing") return undefined;
  if (result.status === "error") {
    throw new QualitativeIndexCacheError(result.code, "The private qualitative index could not be read safely.");
  }
  return result.index;
}

function selectCachedValue(
  candidateKey: PersistedKey,
  index: PersistedIndex | undefined
): LocalAgentQualitativeIndexValue | undefined {
  if (!index) return undefined;
  const fingerprint = keyFingerprint(candidateKey);
  const exact = index.entries.find((candidate) => (
    keyFingerprint(candidate.key) === fingerprint
  ));
  if (exact) return exact.value as LocalAgentQualitativeIndexValue;

  // A normal `last N days` invocation advances its exact cutoff every run.
  // Reuse an older, wider parse only when the immutable file/parser identity
  // matches and the cached evidence can be narrowed to the requested instant
  // without guessing. Calls are filtered again by the loader after cache
  // lookup. Codex invocation counts need an additional proof because their
  // persisted form is aggregated rather than event-level.
  const compatible = index.entries
    .filter((entry) => sameQualitativeFileKey(entry.key, candidateKey))
    .filter((entry) => cachedWindowCoversRequest(entry.key.sinceIso, candidateKey.sinceIso))
    .filter((entry) => invocationWindowCanBeNarrowedExactly(
      entry.key,
      entry.value,
      candidateKey
    ))
    .sort((left, right) => (
      sinceSortValue(right.key.sinceIso) - sinceSortValue(left.key.sinceIso) ||
      right.storedAt.localeCompare(left.storedAt)
    ))[0];
  return compatible?.value as LocalAgentQualitativeIndexValue | undefined;
}

async function writeCachedValue(
  key: Readonly<LocalAgentQualitativeIndexKey>,
  value: Readonly<LocalAgentQualitativeIndexValue>,
  options: QualitativeIndexCacheOptions
): Promise<PersistedIndex> {
  const candidateKey = parseKey(key);
  const candidateValue = parseValue(stripRawPaths(value));
  assertOwnership(candidateKey, candidateValue);
  const candidate: PersistedEntry = {
    key: candidateKey,
    storedAt: new Date().toISOString(),
    value: candidateValue
  };
  const entryBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
  if (entryBytes > boundedEntryBytes(options.maxEntryBytes)) {
    throw new QualitativeIndexCacheError("oversized", "Qualitative index entry exceeds its private cache bound.");
  }

  return withWriterLock(options, async (directory) => {
    const result = await readIndexFile(directory, options);
    if (result.status === "error" && (
      result.code === "unsafe_file" || result.code === "permission" ||
      result.code === "unsupported_version" || result.code === "oversized"
    )) {
      throw new QualitativeIndexCacheError(result.code, "Refusing to replace an unsafe qualitative index.");
    }
    const existing = result.status === "ok" ? result.index.entries : [];
    const fingerprint = keyFingerprint(candidateKey);
    const retained = existing.filter((entry) => keyFingerprint(entry.key) !== fingerprint);
    const bounded = fitIndex([...retained, candidate], candidate, options);
    await atomicWriteIndex(directory, bounded, options);
    return bounded;
  });
}

function fitIndex(
  entries: PersistedEntry[],
  candidate: PersistedEntry,
  options: QualitativeIndexCacheOptions
): PersistedIndex {
  const maxEntries = boundedEntryCount(options.maxEntries);
  const maxBytes = boundedIndexBytes(options.maxBytes);
  const others = entries
    .filter((entry) => entry !== candidate)
    .sort((left, right) => (
      left.storedAt.localeCompare(right.storedAt) ||
      keyFingerprint(left.key).localeCompare(keyFingerprint(right.key))
    ));
  let fitted = [...others, candidate];
  while (fitted.length > maxEntries || serializedIndexBytes(fitted) > maxBytes) {
    if (others.length === 0) {
      throw new QualitativeIndexCacheError("oversized", "Qualitative index entry cannot fit its private cache bound.");
    }
    const oldest = others.shift()!;
    fitted = fitted.filter((entry) => entry !== oldest);
  }
  return indexSchema.parse({
    kind: "aibill.qualitative_index",
    schemaVersion: 1,
    entries: fitted
  });
}

function serializedIndexBytes(entries: PersistedEntry[]): number {
  return Buffer.byteLength(JSON.stringify({
    kind: "aibill.qualitative_index",
    schemaVersion: 1,
    entries
  }), "utf8") + 1;
}

async function readIndexFile(
  directory: string,
  options: QualitativeIndexCacheOptions
): Promise<IndexReadResult> {
  const filePath = join(directory, qualitativeIndexCacheFileName);
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return { status: "error", code: readErrorCode(error, "io") };
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || !hasPrivatePermissions(fileInfo.mode)) {
    return { status: "error", code: "unsafe_file" };
  }
  const maxBytes = boundedIndexBytes(options.maxBytes);
  if (fileInfo.size > maxBytes) return { status: "error", code: "oversized" };

  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || !hasPrivatePermissions(openedInfo.mode)) {
      return { status: "error", code: "unsafe_file" };
    }
    if (openedInfo.size > maxBytes) return { status: "error", code: "oversized" };
    // Allocate for the observed private file plus one growth sentinel, not the
    // entire 32 MiB production ceiling on every command.
    const bounded = Buffer.allocUnsafe(Math.min(maxBytes + 1, openedInfo.size + 1));
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) return { status: "error", code: "oversized" };
    const completedInfo = await handle.stat();
    if (!completedInfo.isFile() || completedInfo.dev !== openedInfo.dev ||
        completedInfo.ino !== openedInfo.ino || completedInfo.size !== openedInfo.size ||
        completedInfo.mtimeMs !== openedInfo.mtimeMs ||
        completedInfo.ctimeMs !== openedInfo.ctimeMs) {
      return { status: "error", code: "io" };
    }
    let value: unknown;
    try {
      value = JSON.parse(bounded.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { status: "error", code: "malformed" };
    }
    if (isRecord(value) && value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      return { status: "error", code: "unsupported_version" };
    }
    const parsed = indexSchema.safeParse(value);
    if (!parsed.success) return { status: "error", code: "malformed" };
    if (parsed.data.entries.length > boundedEntryCount(options.maxEntries)) {
      return { status: "error", code: "oversized" };
    }
    return { status: "ok", index: parsed.data };
  } catch (error) {
    if (isNodeError(error, "ELOOP")) return { status: "error", code: "unsafe_file" };
    return { status: "error", code: readErrorCode(error, "io") };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteIndex(
  directory: string,
  index: PersistedIndex,
  options: QualitativeIndexCacheOptions
): Promise<void> {
  const contents = `${JSON.stringify(index)}\n`;
  if (Buffer.byteLength(contents, "utf8") > boundedIndexBytes(options.maxBytes)) {
    throw new QualitativeIndexCacheError("oversized", "Qualitative index exceeds its private cache bound.");
  }
  const filePath = join(directory, qualitativeIndexCacheFileName);
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new QualitativeIndexCacheError("unsafe_file", "Qualitative index path is not a regular file.");
  }
  if (existing && !hasPrivatePermissions(existing.mode)) {
    throw new QualitativeIndexCacheError("unsafe_file", "Qualitative index file is not private.");
  }

  const temporaryPath = join(
    directory,
    `.${qualitativeIndexCacheFileName}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function withWriterLock<T>(
  options: QualitativeIndexCacheOptions,
  operation: (directory: string) => Promise<T>,
  lockFileName: string = qualitativeIndexCacheLockFileName
): Promise<T> {
  const directory = await resolveCacheDirectory(true, options);
  const lockPath = join(directory, lockFileName);
  const timeout = boundedLockTimeout(options.lockTimeoutMs);
  const started = Date.now();
  let lockHandle: FileHandle | undefined;
  let lockIdentity: WriterLockIdentity | undefined;

  while (!lockHandle) {
    let candidateHandle: FileHandle | undefined;
    let candidateIdentity: WriterLockIdentity | undefined;
    try {
      const owner: WriterLockOwner = { pid: process.pid, token: randomUUID() };
      candidateHandle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600
      );
      const info = await candidateHandle.stat();
      candidateIdentity = { ...owner, dev: info.dev, ino: info.ino };
      await candidateHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await candidateHandle.sync();
      lockHandle = candidateHandle;
      lockIdentity = candidateIdentity;
      candidateHandle = undefined;
      candidateIdentity = undefined;
    } catch (error) {
      await candidateHandle?.close().catch(() => undefined);
      if (candidateIdentity) await releaseOwnedLock(lockPath, candidateIdentity);
      if (!isNodeError(error, "EEXIST")) {
        if (isNodeError(error, "ELOOP")) {
          throw new QualitativeIndexCacheError("unsafe_file", "Qualitative index writer lock is a symbolic link.");
        }
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - started >= timeout) {
        throw new QualitativeIndexCacheError("lock_timeout", "Timed out waiting for the qualitative index writer lock.");
      }
      await delay(lockPollMs);
    }
  }

  try {
    return await operation(directory);
  } finally {
    await lockHandle.close().catch(() => undefined);
    if (lockIdentity) await releaseOwnedLock(lockPath, lockIdentity);
  }
}

export async function resolveCacheDirectory(
  create: boolean,
  options: QualitativeIndexCacheOptions
): Promise<string> {
  const usesDefaultDirectory = !options.cacheDirectory?.trim() &&
    !process.env[qualitativeIndexCacheEnvironmentVariable]?.trim();
  if (usesDefaultDirectory) {
    await ensureDefaultParent(options.homeDirectory ?? homedir(), create);
  }
  const requested = configuredCacheDirectory(options);
  let createdDirectory = false;
  let info = await lstat(requested).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info && create) {
    if (usesDefaultDirectory) {
      await mkdir(requested, { mode: 0o700 }).catch((error: unknown) => {
        if (!isNodeError(error, "EEXIST")) throw error;
      });
    } else {
      await mkdir(requested, { recursive: true, mode: 0o700 });
    }
    createdDirectory = true;
    info = await lstat(requested);
  }
  if (!info) {
    const error = new Error("Private qualitative index directory does not exist.") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private qualitative index directory is not a real directory.");
  }
  if (!hasPrivatePermissions(info.mode)) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private qualitative index directory has unsafe permissions.");
  }
  const canonical = await realpath(requested);
  const confirmed = await lstat(requested);
  if (confirmed.isSymbolicLink() || !confirmed.isDirectory()) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private qualitative index directory changed during validation.");
  }
  // Never chmod an existing caller-supplied directory. A typo such as a repo
  // root or shared folder must fail without changing the host filesystem.
  if (createdDirectory) await chmod(canonical, 0o700);
  return canonical;
}

async function ensureDefaultParent(homeDirectory: string, create: boolean): Promise<void> {
  const parent = join(homeDirectory, ".aibill");
  let info = await lstat(parent).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info && create) {
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error, "EEXIST")) throw error;
    });
    info = await lstat(parent);
  }
  if (!info) {
    const error = new Error("Private aibill directory does not exist.") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill directory is not a real directory.");
  }
  if (!create && !hasPrivatePermissions(info.mode)) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill directory has unsafe permissions.");
  }
  if (create) await chmod(parent, 0o700);
  await ensureDefaultCacheGitPrivacy(parent, create);
}

async function ensureDefaultCacheGitPrivacy(
  aibillDirectory: string,
  create: boolean
): Promise<void> {
  const gitRoot = await findEnclosingGitRoot(aibillDirectory);
  if (!gitRoot) return;
  const marker = join(aibillDirectory, ".gitignore");
  let handle: FileHandle | undefined;
  try {
    handle = await open(marker, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    if (!create) {
      const missing = new Error("Private aibill Git privacy marker does not exist.") as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
    handle = await open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    await handle.writeFile("*\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = await open(marker, constants.O_RDONLY | noFollowFlag());
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !hasPrivatePermissions(info.mode) || info.size !== 2) {
      throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill Git privacy marker is unsafe.");
    }
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    if (bytesRead !== 2 || buffer.toString("utf8") !== "*\n") {
      throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill Git privacy marker is invalid.");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  const relativeDirectory = relative(gitRoot, aibillDirectory);
  const tracked = await execFile("git", ["-C", gitRoot, "ls-files", "--", relativeDirectory], {
    encoding: "utf8",
    maxBuffer: 64 * 1024
  }).then(({ stdout }) => stdout.trim()).catch(() => {
    throw new QualitativeIndexCacheError(
      "unsafe_directory",
      "Private aibill cache tracking status could not be verified."
    );
  });
  if (tracked) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill cache is already tracked by Git.");
  }
  const ignored = await execFile("git", [
    "-C", gitRoot, "check-ignore", "--quiet", "--no-index", "--",
    join(relativeDirectory, "cache", "privacy-probe.json")
  ]).then(() => true).catch(() => false);
  if (!ignored) {
    throw new QualitativeIndexCacheError("unsafe_directory", "Private aibill cache is not proven ignored by Git.");
  }
}

async function findEnclosingGitRoot(path: string): Promise<string | undefined> {
  let current = resolve(path);
  while (true) {
    const gitEntry = await lstat(join(current, ".git")).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
      throw error;
    });
    if (gitEntry) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function configuredCacheDirectory(options: QualitativeIndexCacheOptions): string {
  const configured = options.cacheDirectory?.trim() ||
    process.env[qualitativeIndexCacheEnvironmentVariable]?.trim();
  return resolve(configured && configured.length > 0
    ? configured
    : join(options.homeDirectory ?? homedir(), ".aibill", "cache"));
}

async function removeStaleLock(lockPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || !hasPrivatePermissions(info.mode)) {
      throw new QualitativeIndexCacheError("unsafe_file", "Qualitative index writer lock is not private.");
    }
    if (Date.now() - info.mtimeMs <= staleLockMs) return;
    const owner = await readLockOwner(handle);
    if (!owner || processIsAlive(owner.pid)) return;
    await handle.close();
    handle = undefined;
    await releaseOwnedLock(lockPath, { ...owner, dev: info.dev, ino: info.ino });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    if (isNodeError(error, "ELOOP")) {
      throw new QualitativeIndexCacheError("unsafe_file", "Qualitative index writer lock is a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function releaseOwnedLock(lockPath: string, identity: WriterLockIdentity): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) return;
    const owner = await readLockOwner(handle);
    if (!owner || owner.pid !== identity.pid || owner.token !== identity.token) return;
    await handle.close();
    handle = undefined;
    const confirmed = await lstat(lockPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!confirmed || confirmed.isSymbolicLink() ||
        confirmed.dev !== identity.dev || confirmed.ino !== identity.ino) {
      return;
    }
    await unlink(lockPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ELOOP")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readLockOwner(handle: FileHandle): Promise<WriterLockOwner | undefined> {
  const buffer = Buffer.allocUnsafe(lockMetadataMaxBytes + 1);
  const result = await handle.read(buffer, 0, buffer.length, 0);
  if (result.bytesRead === 0 || result.bytesRead > lockMetadataMaxBytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      typeof value.token !== "string" || value.token.length < 16 || value.token.length > 128) {
    return undefined;
  }
  return { pid: Number(value.pid), token: value.token };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync().catch((error: unknown) => {
      if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP")) throw error;
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function stripRawPaths(value: Readonly<LocalAgentQualitativeIndexValue>): unknown {
  return {
    calls: value.calls.map((call) => {
      const { workingDirectory: _privateWorkingDirectory, ...privacyReduced } = call;
      const workingDirectoryRef = call.workingDirectoryRef ??
        (call.workingDirectory ? projectRefForWorkingDirectory(call.workingDirectory) : undefined);
      return {
        ...privacyReduced,
        ...(workingDirectoryRef ? { workingDirectoryRef } : {})
      };
    }),
    ...(value.invocationFile ? { invocationFile: value.invocationFile } : {}),
    ...(value.invocationWindowProof
      ? { invocationWindowProof: value.invocationWindowProof }
      : {}),
    diagnostics: value.diagnostics
  };
}

function projectRefForWorkingDirectory(directory: string): string {
  return `avref_${createHash("sha256")
    .update("project-working-directory")
    .update("\u0000")
    .update(directory)
    .digest("hex")}`;
}

function parseKey(value: unknown): PersistedKey {
  const result = keySchema.safeParse(value);
  if (!result.success) {
    throw new QualitativeIndexCacheError("invalid_key", "Qualitative index key does not match the strict v1 contract.");
  }
  return result.data;
}

function parseValue(value: unknown): PersistedValue {
  const result = valueSchema.safeParse(value);
  if (!result.success) {
    throw new QualitativeIndexCacheError("invalid_value", "Qualitative index value does not match the privacy-reduced v1 contract.");
  }
  return result.data;
}

function assertOwnership(key: PersistedKey, value: PersistedValue): void {
  if (value.calls.some((call) => call.agent !== key.agent)) {
    throw new QualitativeIndexCacheError("invalid_value", "Qualitative index calls do not belong to the keyed parser.");
  }
  if (value.invocationFile) {
    if (!key.collectInvocationEvidence || key.agent !== "codex" ||
        value.invocationFile.contextSignal.agent !== key.agent) {
      throw new QualitativeIndexCacheError("invalid_value", "Qualitative invocation evidence does not belong to the keyed parser window.");
    }
  }
  if (value.invocationWindowProof && (!value.invocationFile ||
      !key.collectInvocationEvidence || key.agent !== "codex")) {
    throw new QualitativeIndexCacheError(
      "invalid_value",
      "Qualitative invocation window proof does not belong to the keyed parser window."
    );
  }
}

export function qualitativeKeyFingerprint(key: PersistedQualitativeKey): string {
  return keyFingerprint(key);
}

function keyFingerprint(key: PersistedKey): string {
  return createHash("sha256").update(JSON.stringify([
    key.schemaVersion,
    key.parserVersion,
    key.agent,
    key.pathHash,
    key.fileIdentity,
    key.sinceIso,
    key.collectInvocationEvidence
  ])).digest("hex");
}

export function sameQualitativeFileKey(
  left: PersistedKey,
  right: PersistedKey
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.parserVersion === right.parserVersion &&
    left.agent === right.agent &&
    left.pathHash === right.pathHash &&
    left.fileIdentity === right.fileIdentity &&
    left.collectInvocationEvidence === right.collectInvocationEvidence;
}

/** Whether the cached parser window is an exact superset of the request. */
export function cachedWindowCoversRequest(
  cachedSinceIso: string | null,
  requestedSinceIso: string | null
): boolean {
  if (requestedSinceIso === null) return cachedSinceIso === null;
  if (cachedSinceIso === null) return true;
  return Date.parse(cachedSinceIso) <= Date.parse(requestedSinceIso);
}

/**
 * Calls remain exact after the loader's timestamp filter. Aggregated Codex
 * invocation evidence cannot generally be subtracted at a later cutoff, so a
 * cross-window hit is allowed only when the root session started inside the
 * requested window (all counted root events are therefore in-window), or the
 * wider cached window observed no countable invocation evidence at all.
 */
export function invocationWindowCanBeNarrowedExactly(
  cachedKey: PersistedKey,
  value: PersistedValue,
  requestedKey: PersistedKey
): boolean {
  if (!requestedKey.collectInvocationEvidence ||
      cachedKey.sinceIso === requestedKey.sinceIso) {
    return true;
  }
  const requestedSinceIso = requestedKey.sinceIso;
  if (requestedSinceIso === null) return false;
  const invocation = value.invocationFile;
  if (!invocation) return false;
  const proof = value.invocationWindowProof;
  if (!proof || !proof.allCountedEventsTimestamped) return false;
  const hasCountedEvidence = invocation.assistantTurns > 0 ||
    invocation.contextSignal.compactionEvents > 0 ||
    invocation.invocations.length > 0 ||
    invocation.invokedMcpTools.length > 0 ||
    invocation.invokedSkills.length > 0 ||
    invocation.invokedSubagents.length > 0 ||
    invocation.invokedCommands.length > 0 ||
    invocation.contextSignal.fileReads.length > 0 ||
    invocation.contextSignal.repeatedFileReads.length > 0;
  if (!hasCountedEvidence) return proof.earliestCountedAt === undefined;
  if (proof.earliestCountedAt === undefined) return false;
  const requestedSinceMs = Date.parse(requestedSinceIso);
  return Date.parse(proof.earliestCountedAt) >= requestedSinceMs;
}

function sinceSortValue(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}

function boundedIndexBytes(value: number | undefined): number {
  return boundedPositiveInteger(value, qualitativeIndexCacheMaxBytes);
}

function boundedEntryBytes(value: number | undefined): number {
  return boundedPositiveInteger(value, qualitativeIndexCacheMaxEntryBytes);
}

function boundedEntryCount(value: number | undefined): number {
  return boundedPositiveInteger(value, qualitativeIndexCacheMaxEntries);
}

function boundedPositiveInteger(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return maximum;
  return Math.min(maximum, value);
}

function boundedLockTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return defaultLockTimeoutMs;
  return Math.max(0, Math.min(10_000, Math.floor(value)));
}

function normalizeError(
  error: unknown,
  fallback: QualitativeIndexCacheError["code"]
): QualitativeIndexCacheError {
  if (error instanceof QualitativeIndexCacheError) return error;
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
    return new QualitativeIndexCacheError("permission", "Private qualitative index permission was denied.");
  }
  return new QualitativeIndexCacheError(fallback, "Private qualitative index operation failed safely.");
}

function readErrorCode(
  error: unknown,
  fallback: "permission" | "io"
): "permission" | "io" {
  return isNodeError(error, "EACCES") || isNodeError(error, "EPERM") ? "permission" : fallback;
}

export function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

export function hasPrivatePermissions(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function isBasename(value: string): boolean {
  return value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
