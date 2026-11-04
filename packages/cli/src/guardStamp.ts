import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";

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
  | { source: "repository" | "global"; packageDir: string; entry: string; tried: string[] }
  | { source: "none"; reason: string; tried: string[] };

export type GuardHookResolutionOptions = {
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
};

/**
 * Where the committed launcher will find `ai-spend-agent`, mirrored from the
 * launcher's own JavaScript: the checkout's `node_modules` only when its
 * `package.json` declares `ai-spend-agent` or `aibill`, else each global
 * `node_modules` root of `globalNodeModulesRoots`, in order. In every root
 * `ai-spend-agent` may sit at the top (`npm i -g ai-spend-agent`) or nested
 * under `aibill` (`npm i -g aibill`), so both are tried.
 */
export function resolveGuardHookPackage(checkoutRoot: string, options: GuardHookResolutionOptions = {}): GuardHookPackage {
  const declared = checkoutDeclaresAibill(checkoutRoot);
  const tried: string[] = [];
  if (declared) {
    const root = join(checkoutRoot, "node_modules");
    tried.push(root);
    const packageDir = resolvePackageFromRoot(root);
    if (packageDir) return { source: "repository", packageDir, entry: join(packageDir, "dist", "guardHook.js"), tried };
  }
  for (const root of globalNodeModulesRoots(options)) {
    tried.push(root);
    const packageDir = resolvePackageFromRoot(root);
    if (packageDir) return { source: "global", packageDir, entry: join(packageDir, "dist", "guardHook.js"), tried };
  }
  return {
    source: "none",
    reason: declared
      ? "ai-spend-agent is declared in package.json but not installed; run npm install"
      : "package.json does not declare aibill or ai-spend-agent and no global install was found; run npm install --save-dev aibill",
    tried
  };
}

/**
 * The global `node_modules` directories a launcher looks in, most specific
 * first: an npm prefix from the environment, one from `~/.npmrc`, Volta's
 * package images, the prefix the running Node was installed under, and on
 * Windows the per-user `%APPDATA%\npm` tree. Pure: paths are derived, not
 * checked, so a test can pin the shapes.
 */
export function globalNodeModulesRoots(options: GuardHookResolutionOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const execPath = options.execPath ?? process.execPath;
  const path = platform === "win32" ? win32 : posix;
  const prefixRoot = (prefix: string): string => platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
  const roots: string[] = [];
  const envPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (envPrefix && envPrefix.trim()) roots.push(prefixRoot(expandHome(envPrefix.trim(), home, path)));
  const rcPrefix = npmrcPrefix(path.join(home, ".npmrc"));
  if (rcPrefix) roots.push(prefixRoot(expandHome(rcPrefix, home, path)));
  for (const name of ["aibill", "ai-spend-agent"]) {
    roots.push(prefixRoot(path.join(home, ".volta", "tools", "image", "packages", name)));
  }
  roots.push(platform === "win32"
    ? path.join(path.dirname(execPath), "node_modules")
    : path.join(path.dirname(path.dirname(execPath)), "lib", "node_modules"));
  if (platform === "win32" && env.APPDATA) roots.push(path.join(env.APPDATA, "npm", "node_modules"));
  return [...new Set(roots)];
}

/** `~`-relative when the path sits under the home directory, for printing. */
export function displayPath(path: string, home = homedir()): string {
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/** 18720000 ms → 5h12m; 2700000 → 45m; under a minute → <1m. */
export function formatRemaining(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

function resolvePackageFromRoot(root: string): string | undefined {
  const anchor = join(root, "package.json");
  try {
    return dirname(createRequire(anchor).resolve("ai-spend-agent/package.json"));
  } catch {
    // Not at the top of this root.
  }
  try {
    const aibillDir = dirname(createRequire(anchor).resolve("aibill/package.json"));
    return dirname(createRequire(join(aibillDir, "package.json")).resolve("ai-spend-agent/package.json"));
  } catch {
    return undefined;
  }
}

/** The `prefix` an `.npmrc` sets, if any; comments and other keys are ignored. */
function npmrcPrefix(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const match = /^prefix\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function expandHome(value: string, home: string, path: typeof posix | typeof win32): string {
  return value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
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
