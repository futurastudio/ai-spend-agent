import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createClaudeCodeUsageTally,
  tallyClaudeCodeTranscriptLines,
  type ClaudeCodeUsageTally,
  type ClaudeCodeUsageTallyLine
} from "@agent-finops/core";
import { resolveRepositoryRoot } from "./repositoryRoot.js";

/**
 * Today's Claude Code usage for one repository, read from the local
 * transcripts under ~/.claude/projects and nothing else: no network, no
 * provider call. `aibill guard check` runs on every prompt and tool call, so
 * the work per run is bounded by the bytes transcripts gained since the last
 * run: a private cache keeps, per transcript file, the byte offset already
 * folded in and the kept-line tally (`tallyClaudeCodeTranscriptLines`), and a
 * warm run re-reads only the appended tail of the active session.
 *
 * Attribution is per repository, never per person: a line counts when the
 * checkout its recorded cwd belongs to (the main checkout for a linked
 * worktree) is the repository asked about. Lines whose token shape the parser
 * does not support contribute only the components present, so the total is a
 * lower bound and a block on it is never an overstatement.
 */

export const GUARD_USAGE_CACHE_DIRECTORY_NAME = "guard-usage-v1";
export const GUARD_USAGE_CACHE_KIND = "aibill.guard_usage_cache";
const CACHE_MAX_BYTES = 32 * 1_024 * 1_024;
const READ_CHUNK_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_READ_BUDGET_BYTES = 256 * 1_024 * 1_024;
const MAX_WALK_DEPTH = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type GuardUsageOptions = {
  /** The checkout the policy belongs to, as `resolveRepositoryRoot` returns it. */
  repositoryRoot: string;
  now?: Date;
  /** Default: ~/.claude/projects (the CLI passes AI_SPEND_CLAUDE_LOGS_DIR when set). */
  claudeProjectsDir?: string;
  /** Default: AIBILL_CACHE_DIR, else ~/.aibill/cache. */
  cacheDirectory?: string;
  homeDirectory?: string;
  /** New transcript bytes one run may read before deferring the rest to the next run. */
  readBudgetBytes?: number;
  resolveRepositoryRoot?: typeof resolveRepositoryRoot;
};

export type GuardUsageResult = {
  /** UTC day the figures describe, YYYY-MM-DD. */
  dayKey: string;
  dayStartMs: number;
  dayEndMs: number;
  /** Input + output + cache read + cache write tokens of the day's attributed calls. */
  tokens: number;
  /** Distinct session ids with an attributed call today. Internal: never printed. */
  sessionIds: string[];
  calls: number;
  /** Calls whose token shape was unsupported; `tokens` is then a lower bound. */
  incompleteCalls: number;
  transcripts: "readable" | "missing" | "unreadable";
  filesConsidered: number;
  filesRead: number;
  filesUnreadable: number;
  bytesRead: number;
  /** False when the read budget ran out before every changed transcript was folded in. */
  complete: boolean;
  cache: "hit" | "updated" | "unavailable";
  durationMs: number;
};

type PersistedLine = ClaudeCodeUsageTallyLine & { attributed?: boolean };

type PersistedTally = Omit<ClaudeCodeUsageTally, "responses"> & {
  responses: Record<string, PersistedLine>;
};

type CachedFile = {
  size: number;
  mtimeMs: number;
  offset: number;
  tally: PersistedTally;
};

type GuardUsageCache = {
  kind: typeof GUARD_USAGE_CACHE_KIND;
  version: 1;
  repositoryRoot: string;
  files: Record<string, CachedFile>;
};

/** The private cache file for one repository (no transcript paths inside). */
export function guardUsageCachePath(repositoryRoot: string, options: Pick<GuardUsageOptions, "cacheDirectory" | "homeDirectory"> = {}): string {
  const configured = options.cacheDirectory?.trim() || process.env.AIBILL_CACHE_DIR?.trim();
  const directory = configured && configured.length > 0
    ? resolve(configured)
    : join(options.homeDirectory ?? homedir(), ".aibill", "cache");
  return join(directory, GUARD_USAGE_CACHE_DIRECTORY_NAME, `${digest(repositoryRoot).slice(0, 32)}.json`);
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
    sessionIds: [],
    calls: 0,
    incompleteCalls: 0,
    transcripts: "readable",
    filesConsidered: 0,
    filesRead: 0,
    filesUnreadable: 0,
    bytesRead: 0,
    complete: true,
    cache: "hit",
    durationMs: 0
  };

  const listing = listTranscriptFiles(projectsDir);
  if (listing.status !== "readable") {
    result.transcripts = listing.status;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const cache = readCache(cachePath, repositoryRoot);
  const next: GuardUsageCache = { kind: GUARD_USAGE_CACHE_KIND, version: 1, repositoryRoot, files: {} };
  let changed = false;

  for (const file of listing.files) {
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      result.filesUnreadable += 1;
      continue;
    }
    if (!stat.isFile()) continue;
    const key = digest(file).slice(0, 32);
    const cached = cache?.files[key];
    const recency = Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs);
    if (!Number.isFinite(recency) || recency < dayStartMs) {
      // Nothing was written to this transcript today; a cached tally for it
      // can only hold earlier days and is dropped.
      if (cached) changed = true;
      continue;
    }
    result.filesConsidered += 1;
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      next.files[key] = cached;
      continue;
    }
    const resume = cached && stat.size >= cached.offset ? cached : undefined;
    const pending = stat.size - (resume?.offset ?? 0);
    if (result.bytesRead > 0 && result.bytesRead + pending > readBudget) {
      // Defer the rest to the next run rather than risk the hook's timeout;
      // the caller sees `complete: false` and lets the developer continue.
      result.complete = false;
      if (cached) next.files[key] = cached;
      continue;
    }
    const tally: PersistedTally = resume ? resume.tally : createClaudeCodeUsageTally();
    let consumed: { offset: number; bytes: number };
    try {
      consumed = foldAppendedLines(file, resume?.offset ?? 0, stat.size, tally);
    } catch {
      result.filesUnreadable += 1;
      if (cached) next.files[key] = cached;
      continue;
    }
    attribution.apply(tally, dayStartMs);
    result.filesRead += 1;
    result.bytesRead += consumed.bytes;
    changed = true;
    next.files[key] = { size: stat.size, mtimeMs: stat.mtimeMs, offset: consumed.offset, tally };
  }
  if (cache && Object.keys(cache.files).some((key) => !(key in next.files))) changed = true;

  aggregate(next, dayStartMs, dayEndMs, result);
  if (changed || !cache) {
    result.cache = writeCache(cachePath, next) ? "updated" : "unavailable";
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function aggregate(cache: GuardUsageCache, dayStartMs: number, dayEndMs: number, result: GuardUsageResult): void {
  // One native response can appear in two files (a sub-agent transcript opens
  // with the parent turn it was forked from); the first file in path order
  // keeps it. Lines without a native identity are per file.
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
      result.calls += 1;
      result.tokens += line.tokens;
      if (!line.complete) result.incompleteCalls += 1;
      if (line.sessionId) sessions.add(line.sessionId);
    }
  }
  result.sessionIds = [...sessions].sort();
}

/**
 * Read the complete lines a transcript gained since `offset` and fold them
 * into the tally. A trailing partial line stays unread; its bytes are folded
 * in by the run that sees the file change again.
 */
function foldAppendedLines(
  file: string,
  offset: number,
  size: number,
  tally: PersistedTally
): { offset: number; bytes: number } {
  if (size <= offset) return { offset, bytes: 0 };
  const descriptor = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - position));
      const read = readSync(descriptor, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
      position += read;
    }
    const appended = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    const lastNewline = appended.lastIndexOf(0x0a);
    if (lastNewline < 0) return { offset, bytes: 0 };
    const complete = appended.subarray(0, lastNewline + 1);
    tallyClaudeCodeTranscriptLines(complete.toString("utf8"), tally);
    return { offset: offset + lastNewline + 1, bytes: lastNewline + 1 };
  } finally {
    closeSync(descriptor);
  }
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
     * cwd so no transcript path persists, and prune lines that cannot belong to
     * today.
     */
    apply(tally: PersistedTally, dayStartMs: number): void {
      for (const [key, line] of Object.entries(tally.responses)) {
        if (line.workingDirectory !== undefined) {
          line.attributed = belongs(line.workingDirectory);
          delete line.workingDirectory;
        } else if (line.attributed === undefined) {
          line.attributed = false;
        }
        const at = Date.parse(line.timestamp);
        if (!Number.isFinite(at) || at < dayStartMs) delete tally.responses[key];
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

function listTranscriptFiles(root: string): { status: "readable"; files: string[] } | { status: "missing" | "unreadable"; files: [] } {
  try {
    const info = statSync(root);
    if (!info.isDirectory()) return { status: "unreadable", files: [] };
  } catch (error) {
    return { status: isCode(error, "ENOENT") ? "missing" : "unreadable", files: [] };
  }
  const files: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  try {
    readdirSync(root);
  } catch {
    return { status: "unreadable", files: [] };
  }
  walk(root, 0);
  files.sort();
  return { status: "readable", files };
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
  const files: Record<string, CachedFile> = {};
  for (const [key, entry] of Object.entries(value.files)) {
    if (!isCachedFile(entry)) return undefined;
    files[key] = entry;
  }
  return { kind: GUARD_USAGE_CACHE_KIND, version: 1, repositoryRoot, files };
}

function isCachedFile(value: unknown): value is CachedFile {
  if (!isRecord(value)) return false;
  if (!isCount(value.size) || typeof value.mtimeMs !== "number" || !isCount(value.offset)) return false;
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

function writeCache(path: string, cache: GuardUsageCache): boolean {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    return false;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
