import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createClaudeCodeUsageTally,
  tallyClaudeCodeTranscriptLines,
  type ClaudeCodeUsageTally,
  type ClaudeCodeUsageTallyLine
} from "@agent-finops/core";
import {
  guardCacheDirectory,
  guardRepositoryKey,
  listTranscripts,
  writePrivateJson,
  type GuardPathOptions,
  type TranscriptFile,
  type TranscriptListing
} from "./guardStamp.js";
import { resolveRepositoryRoot } from "./repositoryRoot.js";

/**
 * Today's Claude Code usage for one repository, read from the local
 * transcripts under ~/.claude/projects and nothing else: no network, no
 * provider call. The hook runs on every prompt (and every tool call when a
 * policy opts in), so the work per run is bounded by the bytes transcripts
 * gained since the last run: a private cache keeps, per transcript file, the
 * byte offset already folded in, probes of the consumed bytes that prove the
 * file was not rewritten underneath, and the kept-line tally
 * (`tallyClaudeCodeTranscriptLines`). A warm run re-reads only the appended
 * tail of the active session.
 *
 * Attribution is per repository, never per person: a line counts when the
 * checkout its recorded cwd belongs to (the main checkout for a linked
 * worktree) is the repository asked about. Lines whose token shape the parser
 * does not support contribute only the components present, so every total is
 * a lower bound and a block on it is never an overstatement.
 */

export const GUARD_USAGE_CACHE_KIND = "aibill.guard_usage_cache";
const CACHE_MAX_BYTES = 32 * 1_024 * 1_024;
const READ_CHUNK_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_READ_BUDGET_BYTES = 256 * 1_024 * 1_024;
/** Bytes hashed at the start and at the end of the consumed prefix. */
const PROBE_BYTES = 64 * 1_024;
/** Bytes hashed at each of the sampled offsets inside the consumed prefix. */
const SAMPLE_BYTES = 4 * 1_024;
/** Where inside the consumed prefix the samples sit (fractions of the offset). */
const SAMPLE_POSITIONS = [0.25, 0.5, 0.75] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Kept lines older than this (from the day start) can no longer change a verdict. */
const RETAIN_LINES_MS = DAY_MS;
/** Cache rewrite throttle: skip a rewrite this soon after the last one... */
const PERSIST_INTERVAL_MS = 60 * 1_000;
/** ...unless this many new bytes were folded in or a budget is this close. */
const PERSIST_BYTES = 1_024 * 1_024;
const PERSIST_MARGIN = 0.8;

export type GuardBudget = { tokens?: number; outputTokens?: number; sessions?: number };

export type GuardUsageOptions = GuardPathOptions & {
  /** The checkout the policy belongs to, as `resolveRepositoryRoot` returns it. */
  repositoryRoot: string;
  now?: Date;
  /** Default: ~/.claude/projects (the CLI passes AI_SPEND_CLAUDE_LOGS_DIR when set). */
  claudeProjectsDir?: string;
  /** A listing the caller already took for today's window, to avoid a second walk. */
  listing?: TranscriptListing;
  /** New transcript bytes one run may read before deferring the rest to the next run. */
  readBudgetBytes?: number;
  /** The daily budget, so a run far from it can skip rewriting the cache. */
  budget?: GuardBudget;
  resolveRepositoryRoot?: typeof resolveRepositoryRoot;
};

export type GuardUsageResult = {
  /** UTC day the figures describe, YYYY-MM-DD. */
  dayKey: string;
  dayStartMs: number;
  dayEndMs: number;
  /** Input + output + cache read + cache write tokens of the day's attributed calls. */
  tokens: number;
  /** Output tokens of the same calls. */
  outputTokens: number;
  /** Distinct session ids with an attributed call today. Internal: never printed. */
  sessionIds: string[];
  calls: number;
  /** Calls whose token shape was unsupported; the token figures are then lower bounds. */
  incompleteCalls: number;
  transcripts: "readable" | "missing" | "unreadable";
  /** Changes whenever a transcript touched today grows, is rewritten, appears or disappears. */
  signature: string;
  filesConsidered: number;
  filesRead: number;
  filesUnreadable: number;
  bytesRead: number;
  /** False when the read budget ran out before every changed transcript was folded in. */
  complete: boolean;
  /** `deferred`: nothing worth a rewrite yet (far from the budget, few new bytes). */
  cache: "hit" | "updated" | "deferred" | "unavailable";
  durationMs: number;
};

type PersistedLine = ClaudeCodeUsageTallyLine & { attributed?: boolean };

type PersistedTally = Omit<ClaudeCodeUsageTally, "responses"> & {
  responses: Record<string, PersistedLine>;
};

type CachedFile = {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  offset: number;
  /** sha256 of the first min(PROBE_BYTES, offset) consumed bytes. */
  headSha256: string;
  /** sha256 of the last min(PROBE_BYTES, offset) consumed bytes. */
  tailSha256: string;
  /** sha256 of SAMPLE_BYTES at each SAMPLE_POSITIONS fraction of the offset. */
  sampleSha256: string;
  tally: PersistedTally;
};

type GuardUsageCache = {
  kind: typeof GUARD_USAGE_CACHE_KIND;
  version: 1;
  repositoryRoot: string;
  writtenAt: string;
  files: Record<string, CachedFile>;
};

/** The private cache file for one repository (no transcript paths inside). */
export function guardUsageCachePath(repositoryRoot: string, options: GuardPathOptions = {}): string {
  return join(guardCacheDirectory(options), `${guardRepositoryKey(repositoryRoot)}.json`);
}

export function utcDayWindow(now: Date): { dayKey: string; dayStartMs: number; dayEndMs: number } {
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { dayKey: new Date(dayStartMs).toISOString().slice(0, 10), dayStartMs, dayEndMs: dayStartMs + DAY_MS };
}

export async function computeGuardUsage(options: GuardUsageOptions): Promise<GuardUsageResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const { dayKey, dayStartMs, dayEndMs } = utcDayWindow(now);
  const repositoryRoot = resolve(options.repositoryRoot);
  const projectsDir = options.claudeProjectsDir ?? join(options.homeDirectory ?? homedir(), ".claude", "projects");
  const readBudget = options.readBudgetBytes ?? DEFAULT_READ_BUDGET_BYTES;
  const findRoot = options.resolveRepositoryRoot ?? resolveRepositoryRoot;
  const cachePath = guardUsageCachePath(repositoryRoot, options);
  const attribution = createAttribution(repositoryRoot, findRoot);

  const result: GuardUsageResult = {
    dayKey,
    dayStartMs,
    dayEndMs,
    tokens: 0,
    outputTokens: 0,
    sessionIds: [],
    calls: 0,
    incompleteCalls: 0,
    transcripts: "readable",
    signature: "",
    filesConsidered: 0,
    filesRead: 0,
    filesUnreadable: 0,
    bytesRead: 0,
    complete: true,
    cache: "hit",
    durationMs: 0
  };

  const listing = options.listing ?? listTranscripts(projectsDir, dayStartMs);
  result.signature = listing.signature;
  if (listing.status !== "readable") {
    result.transcripts = listing.status;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const cache = readCache(cachePath, repositoryRoot);
  const next: GuardUsageCache = {
    kind: GUARD_USAGE_CACHE_KIND,
    version: 1,
    repositoryRoot,
    writtenAt: cache?.writtenAt ?? new Date(0).toISOString(),
    files: {}
  };
  let structureChanged = false;

  for (const file of listing.files) {
    result.filesConsidered += 1;
    const key = guardRepositoryKey(file.path);
    const cached = cache?.files[key];
    if (cached && unchanged(cached, file)) {
      next.files[key] = cached;
      continue;
    }
    let resume: CachedFile | undefined;
    try {
      resume = cached && resumable(cached, file) ? cached : undefined;
    } catch {
      result.filesUnreadable += 1;
      if (cached) next.files[key] = cached;
      continue;
    }
    const pending = file.size - (resume?.offset ?? 0);
    if (result.bytesRead > 0 && result.bytesRead + pending > readBudget) {
      // Defer the rest to the next run rather than risk the hook's timeout;
      // the caller sees `complete: false` and lets the developer continue.
      result.complete = false;
      if (cached) next.files[key] = cached;
      continue;
    }
    const tally: PersistedTally = resume ? resume.tally : createClaudeCodeUsageTally();
    let folded: FoldResult;
    try {
      folded = foldAppendedLines(file.path, resume?.offset ?? 0, file.size, tally, resume);
    } catch {
      result.filesUnreadable += 1;
      if (cached) next.files[key] = cached;
      continue;
    }
    attribution.apply(tally, dayStartMs - RETAIN_LINES_MS);
    result.filesRead += 1;
    result.bytesRead += folded.bytes;
    structureChanged = true;
    next.files[key] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      dev: file.dev,
      ino: file.ino,
      offset: folded.offset,
      headSha256: folded.headSha256,
      tailSha256: folded.tailSha256,
      sampleSha256: folded.sampleSha256,
      tally
    };
  }
  if (cache && Object.keys(cache.files).some((key) => !(key in next.files))) structureChanged = true;

  aggregate(next, dayStartMs, dayEndMs, result);
  if (!cache || structureChanged) {
    if (shouldPersist(cache, result, options.budget, now)) {
      next.writtenAt = now.toISOString();
      result.cache = writePrivateJson(cachePath, next) ? "updated" : "unavailable";
    } else {
      result.cache = "deferred";
    }
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function unchanged(cached: CachedFile, file: TranscriptFile): boolean {
  return cached.size === file.size && cached.mtimeMs === file.mtimeMs &&
    cached.dev === file.dev && cached.ino === file.ino;
}

/**
 * Resume proof: same inode, a size that grew (an append always grows the
 * file, so the same size with a newer mtime is a rewrite), and a consumed
 * prefix that still reads the same at its head, its tail and three sampled
 * offsets in between. Anything less is read from byte zero again. Throws when
 * the file cannot be read.
 */
function resumable(cached: CachedFile, file: TranscriptFile): boolean {
  if (cached.dev !== file.dev || cached.ino !== file.ino) return false;
  if (file.size < cached.offset) return false;
  if (file.size === cached.size && file.mtimeMs !== cached.mtimeMs) return false;
  if (cached.offset === 0) return true;
  const probes = probeConsumedPrefix(file.path, cached.offset);
  return probes.headSha256 === cached.headSha256 &&
    probes.tailSha256 === cached.tailSha256 &&
    probes.sampleSha256 === cached.sampleSha256;
}

type Probes = { headSha256: string; tailSha256: string; sampleSha256: string };

type FoldResult = { offset: number; bytes: number } & Probes;

/**
 * Read the complete lines a transcript gained since `offset` and fold them
 * into the tally. A trailing partial line stays unread; its bytes are folded
 * in by the run that sees the file change again. Returns the new offset and
 * the probes of the consumed prefix.
 */
function foldAppendedLines(
  path: string,
  offset: number,
  size: number,
  tally: PersistedTally,
  resume: CachedFile | undefined
): FoldResult {
  const descriptor = openSync(path, "r");
  try {
    const appended = readRange(descriptor, offset, size);
    const lastNewline = appended.lastIndexOf(0x0a);
    const consumed = lastNewline < 0 ? 0 : lastNewline + 1;
    if (consumed > 0) tallyClaudeCodeTranscriptLines(appended.subarray(0, consumed).toString("utf8"), tally);
    const nextOffset = offset + consumed;
    if (nextOffset === 0) return { offset: 0, bytes: 0, headSha256: "", tailSha256: "", sampleSha256: "" };
    return { offset: nextOffset, bytes: consumed, ...probesAt(descriptor, nextOffset, resume) };
  } finally {
    closeSync(descriptor);
  }
}

function probeConsumedPrefix(path: string, offset: number): Probes {
  const descriptor = openSync(path, "r");
  try {
    return probesAt(descriptor, offset, undefined);
  } finally {
    closeSync(descriptor);
  }
}

function probesAt(descriptor: number, offset: number, resume: CachedFile | undefined): Probes {
  // Head: unchanged by appends once the first PROBE_BYTES are consumed, so a
  // cached value stands; otherwise hash what is on disk now.
  const headSha256 = resume && resume.offset >= PROBE_BYTES
    ? resume.headSha256
    : sha256(readRange(descriptor, 0, Math.min(PROBE_BYTES, offset)));
  const tailSha256 = sha256(readRange(descriptor, Math.max(0, offset - PROBE_BYTES), offset));
  const samples = createHash("sha256");
  for (const position of SAMPLE_POSITIONS) {
    const start = Math.floor(offset * position);
    samples.update(readRange(descriptor, start, Math.min(offset, start + SAMPLE_BYTES)));
  }
  return { headSha256, tailSha256, sampleSha256: samples.digest("hex") };
}

function readRange(descriptor: number, start: number, end: number): Buffer {
  const chunks: Buffer[] = [];
  let position = start;
  while (position < end) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - position));
    const read = readSync(descriptor, chunk, 0, chunk.length, position);
    if (read <= 0) break;
    chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
    position += read;
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
}

function aggregate(cache: GuardUsageCache, dayStartMs: number, dayEndMs: number, result: GuardUsageResult): void {
  // One native response can appear in two files (a sub-agent transcript opens
  // with the parent turn it was forked from); the first file in cache-key
  // order keeps it. Lines without a native identity are per file.
  const seen = new Set<string>();
  const sessions = new Set<string>();
  for (const [fileKey, file] of Object.entries(cache.files).sort(([left], [right]) => left.localeCompare(right))) {
    for (const [key, line] of Object.entries(file.tally.responses)) {
      const globalKey = key.startsWith("line:") ? `${fileKey}:${key}` : key;
      if (seen.has(globalKey)) continue;
      seen.add(globalKey);
      if (!line.attributed) continue;
      const at = Date.parse(line.timestamp);
      if (!Number.isFinite(at) || at < dayStartMs || at >= dayEndMs) continue;
      // A zeroed copy Claude Code writes after a response's final line carries
      // no work of its own; when it is the only line kept for a response (its
      // final line fell outside today), it must not conjure a call or session.
      if (line.tokens === 0 && line.outputTokens <= 0) continue;
      result.calls += 1;
      result.tokens += line.tokens;
      result.outputTokens += Math.max(0, line.outputTokens);
      if (!line.complete) result.incompleteCalls += 1;
      if (line.sessionId) sessions.add(line.sessionId);
    }
  }
  result.sessionIds = [...sessions].sort();
}

/**
 * A rewrite costs a few milliseconds, but a run far from every budget with
 * few new bytes gains nothing from it: the next run folds the same tail in
 * again. Close to a budget, or once enough new bytes accumulated, persist.
 */
function shouldPersist(cache: GuardUsageCache | undefined, result: GuardUsageResult, budget: GuardBudget | undefined, now: Date): boolean {
  if (!cache || !budget || !result.complete) return true;
  if (result.bytesRead >= PERSIST_BYTES) return true;
  const writtenAt = Date.parse(cache.writtenAt);
  if (!Number.isFinite(writtenAt) || now.getTime() - writtenAt >= PERSIST_INTERVAL_MS) return true;
  const close = (used: number, limit: number | undefined) => limit !== undefined && used >= limit * PERSIST_MARGIN;
  return close(result.tokens, budget.tokens) ||
    close(result.outputTokens, budget.outputTokens) ||
    close(result.sessionIds.length, budget.sessions);
}

function createAttribution(repositoryRoot: string, findRoot: typeof resolveRepositoryRoot) {
  const target = canonical(repositoryRoot);
  const memo = new Map<string, boolean>();
  const belongs = (workingDirectory: string): boolean => {
    const known = memo.get(workingDirectory);
    if (known !== undefined) return known;
    let verdict = false;
    try {
      const root = findRoot(workingDirectory);
      verdict = root !== undefined && canonical(root) === target;
    } catch {
      verdict = false;
    }
    memo.set(workingDirectory, verdict);
    return verdict;
  };
  return {
    /**
     * Resolve attribution for lines the reducer just (re)wrote, drop their raw
     * cwd so no transcript path persists, and prune lines too old to matter.
     * Yesterday's lines are kept one more day so a copy written after midnight
     * still meets the final line it must not outrank.
     */
    apply(tally: PersistedTally, retainFromMs: number): void {
      for (const [key, line] of Object.entries(tally.responses)) {
        if (line.workingDirectory !== undefined) {
          line.attributed = belongs(line.workingDirectory);
          delete line.workingDirectory;
        } else if (line.attributed === undefined) {
          line.attributed = false;
        }
        const at = Date.parse(line.timestamp);
        if (!Number.isFinite(at) || at < retainFromMs) delete tally.responses[key];
      }
    }
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readCache(path: string, repositoryRoot: string): GuardUsageCache | undefined {
  let text: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > CACHE_MAX_BYTES) return undefined;
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.kind !== GUARD_USAGE_CACHE_KIND || value.version !== 1) return undefined;
  if (value.repositoryRoot !== repositoryRoot || !isRecord(value.files)) return undefined;
  if (typeof value.writtenAt !== "string") return undefined;
  const files: Record<string, CachedFile> = {};
  for (const [key, entry] of Object.entries(value.files)) {
    if (!isCachedFile(entry)) return undefined;
    files[key] = entry;
  }
  return { kind: GUARD_USAGE_CACHE_KIND, version: 1, repositoryRoot, writtenAt: value.writtenAt, files };
}

function isCachedFile(value: unknown): value is CachedFile {
  if (!isRecord(value)) return false;
  if (!isCount(value.size) || typeof value.mtimeMs !== "number" || !isCount(value.offset)) return false;
  if (typeof value.dev !== "number" || typeof value.ino !== "number") return false;
  if (typeof value.headSha256 !== "string" || typeof value.tailSha256 !== "string" || typeof value.sampleSha256 !== "string") return false;
  if (value.offset > value.size) return false;
  const tally = value.tally;
  if (!isRecord(tally) || tally.version !== 1 || !isRecord(tally.responses)) return false;
  if (!isCount(tally.unidentifiedLines) || !isCount(tally.malformedLines)) return false;
  return Object.values(tally.responses).every(isPersistedLine);
}

function isPersistedLine(value: unknown): value is PersistedLine {
  return isRecord(value) &&
    isCount(value.tokens) &&
    typeof value.final === "boolean" &&
    typeof value.outputTokens === "number" &&
    typeof value.timestamp === "string" &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    typeof value.complete === "boolean" &&
    typeof value.attributed === "boolean" &&
    value.workingDirectory === undefined;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
