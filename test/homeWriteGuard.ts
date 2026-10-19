import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write trap for the developer's real home directory.
 *
 * On 2026-10-18 Vitest runs wrote project-accountability state into the
 * founder's real ~/.aibill: a test called the CLI without an isolated HOME and
 * the CLI fell back to os.homedir(). The suite now runs with a throwaway HOME
 * (see vitest.globalSetup.ts and vitest.setup.ts), and this trap is the
 * backstop for anything that still reaches the launch-time home (a
 * hard-coded path, os.userInfo(), a path captured before the redirect).
 *
 * Every path-taking fs mutator (sync, callback, and promise forms) refuses a
 * target inside the launch-time home with EACCES and records the attempt.
 * The setup file fails the running test when anything was recorded, so a
 * best-effort write that swallows its error still fails the suite.
 *
 * The repository checkout, the OS temp directory and the suite's own temp
 * root stay writable even when they sit inside the home directory.
 */

declare module "vitest" {
  export interface ProvidedContext {
    /** os.homedir() of the process that launched Vitest, before isolation. */
    aibillLaunchHome: string;
    /** Canonical temp directory holding every throwaway HOME for this run. */
    aibillTestRoot: string;
    /** The Vitest root (repository checkout). */
    aibillRepoRoot: string;
  }
}

interface GuardState {
  protectedRoots: string[];
  allowedRoots: string[];
  violations: string[];
}

type FsOwner = Record<string, unknown>;
type CallStyle = "sync" | "callback" | "promise";

const GUARD_KEY = Symbol.for("aibill.vitest.homeWriteGuard");

// [name, indexes of the path arguments that name a write target]
const PATH_MUTATORS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["appendFile", [0]],
  ["chmod", [0]],
  ["chown", [0]],
  ["copyFile", [1]],
  ["cp", [1]],
  ["lchmod", [0]],
  ["lchown", [0]],
  ["link", [1]],
  ["lutimes", [0]],
  ["mkdir", [0]],
  ["mkdtemp", [0]],
  ["rename", [0, 1]],
  ["rm", [0]],
  ["rmdir", [0]],
  ["symlink", [1]],
  ["truncate", [0]],
  ["unlink", [0]],
  ["utimes", [0]],
  ["writeFile", [0]]
];

const WRITE_OPEN_BITS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT |
  fs.constants.O_TRUNC | fs.constants.O_APPEND;

function guardState(): GuardState | undefined {
  return (globalThis as Record<symbol, GuardState | undefined>)[GUARD_KEY];
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

/** realpath of the deepest existing ancestor, with the missing tail re-joined. */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function toPath(value: unknown): string | undefined {
  if (typeof value === "string") return value.startsWith("file:") ? fileURLToPath(value) : value;
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined; // file descriptors and FileHandles were already opened (and checked) by path
}

function refusedTarget(state: GuardState, value: unknown): string | undefined {
  const path = toPath(value);
  if (path === undefined) return undefined;
  const lexical = resolve(path);
  for (const candidate of new Set([lexical, canonicalPath(lexical)])) {
    if (state.allowedRoots.some((root) => isWithin(candidate, root))) continue;
    if (state.protectedRoots.some((root) => isWithin(candidate, root))) return candidate;
  }
  return undefined;
}

function opensForWrite(flags: unknown): boolean {
  if (typeof flags === "number") return (flags & WRITE_OPEN_BITS) !== 0;
  return typeof flags === "string" && /[wax+]/u.test(flags);
}

function refusal(state: GuardState, operation: string, target: string): NodeJS.ErrnoException {
  state.violations.push(`${operation} ${target}`);
  return Object.assign(
    new Error(
      `aibill test home guard: refused ${operation} inside the real home directory (${target}). ` +
      "Tests must write home state under the isolated HOME (os.homedir()) or an injected homeDirectory."
    ),
    { code: "EACCES", path: target, syscall: operation }
  );
}

function wrap(
  state: GuardState,
  owner: FsOwner,
  name: string,
  style: CallStyle,
  targets: (args: unknown[]) => unknown[]
): void {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function guarded(this: unknown, ...args: unknown[]) {
    for (const value of targets(args)) {
      const target = refusedTarget(state, value);
      if (target === undefined) continue;
      const error = refusal(state, name, target);
      if (style === "promise") return Promise.reject(error);
      const callback = args.at(-1);
      if (style === "callback" && typeof callback === "function") {
        process.nextTick(callback as (error: Error) => void, error);
        return undefined;
      }
      throw error;
    }
    return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
  };
}

/**
 * Install the trap once per worker. Builtins are shared by every test file a
 * worker runs, so a second call only returns the existing state.
 */
export function installHomeWriteGuard(options: {
  launchHome: string;
  allowedRoots: string[];
}): void {
  if (guardState()) return;
  const home = resolve(options.launchHome);
  const protectedRoots = parse(home).root === home
    ? [] // HOME=/ (some containers): nothing narrower than the filesystem to protect
    : [...new Set([home, canonicalPath(home)])];
  const allowedRoots = [...new Set(
    [...options.allowedRoots, tmpdir()].flatMap((root) => [resolve(root), canonicalPath(resolve(root))])
  )];
  const state: GuardState = { protectedRoots, allowedRoots, violations: [] };
  (globalThis as Record<symbol, GuardState>)[GUARD_KEY] = state;

  const callbacks = fs as unknown as FsOwner;
  const promises = fs.promises as unknown as FsOwner;
  for (const [name, indexes] of PATH_MUTATORS) {
    const targets = (args: unknown[]) => indexes.map((index) => args[index]);
    wrap(state, callbacks, name, "callback", targets);
    wrap(state, callbacks, `${name}Sync`, "sync", targets);
    wrap(state, promises, name, "promise", targets);
  }
  const openTargets = (args: unknown[]) => (opensForWrite(args[1]) ? [args[0]] : []);
  wrap(state, callbacks, "open", "callback", openTargets);
  wrap(state, callbacks, "openSync", "sync", openTargets);
  wrap(state, promises, "open", "promise", openTargets);
  wrap(state, callbacks, "createWriteStream", "sync", (args) => [args[0]]);

  // Re-point `import { writeFile } from "node:fs/promises"` style bindings,
  // which ESM consumers (source under test and built dist alike) hold.
  syncBuiltinESMExports();
}

/** Return and clear every refused write recorded since the last call. */
export function takeHomeWriteViolations(): string[] {
  return guardState()?.violations.splice(0) ?? [];
}
