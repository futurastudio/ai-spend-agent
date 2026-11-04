import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The parts of the guard that must stay cheap enough to run before anything
 * heavy loads: Node built-ins only, no core import. `guardHook.ts` uses them
 * to decide whether a run can reuse its last verdict, and `guardUsage.ts`
 * reuses the same transcript listing so both agree on what "unchanged" means.
 */

/**
 * The Claude Code reader this guard's cached tallies were produced by. It
 * must equal core's `localAgentFinancialParserVersion` (a test pins the two):
 * bump it whenever that version bumps, so a tally kept by an older reader is
 * never trusted by a newer one. The version is part of the cache directory
 * name, which makes an old cache invisible rather than something to migrate.
 */
export const GUARD_READER_VERSION = 4;
export const GUARD_CACHE_DIRECTORY_NAME = `guard-usage-v1-r${GUARD_READER_VERSION}`;
export const GUARD_STAMP_KIND = "aibill.guard_stamp";
const STAMP_MAX_BYTES = 64 * 1_024;
const MAX_WALK_DEPTH = 8;

export type GuardCacheLocation = Pick<GuardPathOptions, "cacheDirectory" | "homeDirectory">;

export type GuardPathOptions = {
  /** Default: AIBILL_CACHE_DIR, else ~/.aibill/cache. */
  cacheDirectory?: string;
  homeDirectory?: string;
};

export function guardCacheDirectory(options: GuardCacheLocation = {}): string {
  const configured = options.cacheDirectory?.trim() || process.env.AIBILL_CACHE_DIR?.trim();
  const base = configured && configured.length > 0
    ? resolve(configured)
    : join(options.homeDirectory ?? homedir(), ".aibill", "cache");
  return join(base, GUARD_CACHE_DIRECTORY_NAME);
}

export function guardRepositoryKey(repositoryRoot: string): string {
  return sha256(resolve(repositoryRoot)).slice(0, 32);
}

export type TranscriptFile = {
  path: string;
  size: number;
  mtimeMs: number;
  /** Newest of mtime, ctime and birthtime: when the file last provably changed. */
  recencyMs: number;
  dev: number;
  ino: number;
};

export type TranscriptListing =
  | { status: "readable"; files: TranscriptFile[]; signature: string }
  | { status: "missing" | "unreadable"; files: TranscriptFile[]; signature: string };

/**
 * Every `.jsonl` transcript under the Claude Code projects directory that
 * changed on or after `sinceMs`, with a signature that changes whenever one
 * of them grows, is rewritten, appears or disappears.
 */
export function listTranscripts(projectsDir: string, sinceMs: number): TranscriptListing {
  try {
    const info = statSync(projectsDir);
    if (!info.isDirectory()) return { status: "unreadable", files: [], signature: "unreadable" };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { status: missing ? "missing" : "unreadable", files: [], signature: missing ? "missing" : "unreadable" };
  }
  try {
    readdirSync(projectsDir);
  } catch {
    return { status: "unreadable", files: [], signature: "unreadable" };
  }
  const files: TranscriptFile[] = [];
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
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const recencyMs = Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs);
      if (!Number.isFinite(recencyMs) || recencyMs < sinceMs) continue;
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, recencyMs, dev: stat.dev, ino: stat.ino });
    }
  };
  walk(projectsDir, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\u0000${file.size}\u0000${file.mtimeMs}\u0000${file.ino}\n`);
  }
  return { status: "readable", files, signature: `${files.length}:${digest.digest("hex").slice(0, 24)}` };
}

/** Size and mtime of the policy file, or "missing"; part of the stamp's validity. */
export function policyIdentity(policyPath: string): string {
  try {
    const stat = lstatSync(policyPath);
    return stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : "not-a-file";
  } catch {
    return "missing";
  }
}

export type GuardStamp = {
  kind: typeof GUARD_STAMP_KIND;
  version: 1;
  dayKey: string;
  policy: string;
  signature: string;
  /** The session the verdict was computed for; the sessions rule depends on it. */
  sessionId: string | null;
  exitCode: 0 | 2;
  stderr: string;
  reason: string;
  writtenAt: string;
};

export function guardStampPath(repositoryRoot: string, options: GuardCacheLocation = {}): string {
  return join(guardCacheDirectory(options), `${guardRepositoryKey(repositoryRoot)}.stamp.json`);
}

export function readGuardStamp(path: string): GuardStamp | undefined {
  let value: unknown;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > STAMP_MAX_BYTES) return undefined;
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const stamp = value as Record<string, unknown>;
  if (stamp.kind !== GUARD_STAMP_KIND || stamp.version !== 1) return undefined;
  if (typeof stamp.dayKey !== "string" || typeof stamp.policy !== "string" || typeof stamp.signature !== "string") return undefined;
  if (stamp.sessionId !== null && typeof stamp.sessionId !== "string") return undefined;
  if (stamp.exitCode !== 0 && stamp.exitCode !== 2) return undefined;
  if (typeof stamp.stderr !== "string" || typeof stamp.reason !== "string" || typeof stamp.writtenAt !== "string") return undefined;
  return stamp as GuardStamp;
}

/** Atomic, private. Returns false when the cache directory is unavailable. */
export function writePrivateJson(path: string, value: unknown): boolean {
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing was left behind.
    }
    return false;
  }
}

export type GuardHookPackage =
  | { source: "repository" | "global"; packageDir: string; entry: string }
  | { source: "none"; reason: string };

/**
 * Where the committed launcher will find `ai-spend-agent`, mirrored from the
 * launcher's own JavaScript: the checkout's `node_modules` only when its
 * `package.json` declares `ai-spend-agent` or `aibill`, else the global
 * install next to the running Node.
 */
export function resolveGuardHookPackage(checkoutRoot: string, execPath = process.execPath, platform = process.platform): GuardHookPackage {
  const declared = checkoutDeclaresAibill(checkoutRoot);
  const anchors: Array<{ source: "repository" | "global"; anchor: string }> = [];
  if (declared) anchors.push({ source: "repository", anchor: join(checkoutRoot, "package.json") });
  anchors.push({ source: "global", anchor: join(globalNodeModules(execPath, platform), "package.json") });
  for (const { source, anchor } of anchors) {
    try {
      const manifest = createRequire(anchor).resolve("ai-spend-agent/package.json");
      const packageDir = dirname(manifest);
      return { source, packageDir, entry: join(packageDir, "dist", "guardHook.js") };
    } catch {
      // Try the next anchor.
    }
  }
  return {
    source: "none",
    reason: declared
      ? "ai-spend-agent is declared in package.json but not installed; run npm install"
      : "package.json does not declare aibill or ai-spend-agent and no global install was found; run npm install --save-dev aibill"
  };
}

export function globalNodeModules(execPath = process.execPath, platform = process.platform): string {
  return platform === "win32"
    ? join(dirname(execPath), "node_modules")
    : join(dirname(dirname(execPath)), "lib", "node_modules");
}

function checkoutDeclaresAibill(checkoutRoot: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(checkoutRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies"].some((group) => {
      const entries = manifest[group];
      return typeof entries === "object" && entries !== null &&
        ("ai-spend-agent" in (entries as object) || "aibill" in (entries as object));
    });
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
