import { homedir } from "node:os";
import { constants, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";

/**
 * Shared unsafe-scan-root policy for EVERY scan entrypoint (CLI `scan`, MCP
 * `scan_ai_spend`, and any future surface). Scanning the home directory, the
 * filesystem root, or a system directory is refused: the product's consent
 * model is "one explicitly approved project folder", and anything broader can
 * pull unrelated personal files into evidence output.
 *
 * Keep this the ONLY implementation — a CLI/MCP divergence here is exactly the
 * class of bug that let MCP scan `~` while the CLI refused.
 */

const systemRootDirectories = new Set([
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/opt",
  "/private",
  "/Library",
  "/System",
  "/Applications",
  "/Volumes",
  "/proc",
  "/sys",
  "/dev"
]);

export class UnsafeScanRootError extends Error {
  readonly rootPath: string;

  constructor(rootPath: string, reason: string) {
    super(`Refusing to scan ${rootPath}: ${reason}. Choose a narrower approved folder.`);
    this.name = "UnsafeScanRootError";
    this.rootPath = rootPath;
  }
}

export class UnsafeStateDirectoryError extends Error {
  readonly statePath: string;

  constructor(statePath: string, reason: string) {
    super(`Refusing to use ${statePath}: ${reason}. Remove the link or choose another approved folder.`);
    this.name = "UnsafeStateDirectoryError";
    this.statePath = statePath;
  }
}

export class UnsafeStateFileError extends Error {
  readonly filePath: string;

  constructor(filePath: string, reason: string) {
    super(`Refusing to use ${filePath}: ${reason}. Recreate the local aibill state instead of following repository-provided links.`);
    this.name = "UnsafeStateFileError";
    this.filePath = filePath;
  }
}

export function unsafeScanRootReason(rootPath: string, home: string = homedir()): string | undefined {
  const requested = resolve(rootPath);
  const resolved = bestEffortRealpathSync(requested);
  const requestedHome = resolve(home);
  const resolvedHome = bestEffortRealpathSync(requestedHome);
  const rootCandidates = new Set([requested, resolved]);
  const homeCandidates = new Set([requestedHome, resolvedHome]);

  if (Array.from(rootCandidates).some((candidate) => candidate === "/" || /^[A-Za-z]:[\\/]?$/.test(candidate))) {
    return "the filesystem root is too broad for approved-source scanning";
  }
  if (Array.from(rootCandidates).some((candidate) => homeCandidates.has(candidate))) {
    return "the home directory is too broad for approved-source scanning";
  }
  if (Array.from(rootCandidates).some((candidate) =>
    Array.from(homeCandidates).some((candidateHome) => isAncestorPath(candidate, candidateHome)))) {
    return "this directory contains your home directory and is too broad for approved-source scanning";
  }
  if (Array.from(rootCandidates).some((candidate) => systemRootDirectories.has(candidate))) {
    return "system directories are not valid approved-source scan targets";
  }
  return undefined;
}

/** Throws a typed error when the root is unsafe; callers map it to their UX. */
export function assertSafeScanRoot(rootPath: string, home: string = homedir()): void {
  const reason = unsafeScanRootReason(rootPath, home);
  if (reason) {
    throw new UnsafeScanRootError(bestEffortRealpathSync(resolve(rootPath)), reason);
  }
}

/**
 * Resolves an approved root through the filesystem before applying the broad-
 * root policy. This prevents a harmless-looking symlink such as
 * `/tmp/project` from approving a scan of `$HOME` or a system directory.
 * Callers should persist and use the returned canonical path.
 */
export async function resolveSafeScanRoot(rootPath: string, home: string = homedir()): Promise<string> {
  const requested = resolve(rootPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requested);
  } catch {
    throw new UnsafeScanRootError(requested, "the approved scan root does not resolve to an existing directory");
  }

  let canonicalHome = resolve(home);
  try {
    canonicalHome = await realpath(canonicalHome);
  } catch {
    // A synthetic/nonexistent home is useful in tests. The lexical path still
    // preserves the same policy when there is nothing to canonicalize.
  }

  const reason = unsafeScanRootReason(canonicalRoot, canonicalHome);
  if (reason) {
    throw new UnsafeScanRootError(canonicalRoot, reason);
  }

  const rootInfo = await stat(canonicalRoot);
  if (!rootInfo.isDirectory()) {
    throw new UnsafeScanRootError(canonicalRoot, "the approved scan root is not a directory");
  }
  return canonicalRoot;
}

/**
 * Returns a validated local state directory, creating it only when requested.
 * The state path must be a real directory directly under the canonical scan
 * root; symbolic links are refused for both reads and writes.
 */
export async function resolveSafeStateDirectory(
  rootPath: string,
  options: { create?: boolean } = {}
): Promise<string> {
  const canonicalRoot = await resolveSafeScanRoot(rootPath);
  const statePath = join(canonicalRoot, ".ai-spend-agent");

  let stateInfo = await lstat(statePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });

  if (!stateInfo && options.create) {
    try {
      await mkdir(statePath, { mode: 0o700 });
    } catch (error) {
      // A concurrent creator is safe only after the same lstat checks below.
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    stateInfo = await lstat(statePath);
  }

  if (!stateInfo) {
    const error = new Error(`State directory does not exist: ${statePath}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (stateInfo.isSymbolicLink()) {
    throw new UnsafeStateDirectoryError(statePath, ".ai-spend-agent is a symbolic link");
  }
  if (!stateInfo.isDirectory()) {
    throw new UnsafeStateDirectoryError(statePath, ".ai-spend-agent is not a directory");
  }

  const canonicalState = await realpath(statePath);
  if (canonicalState !== statePath) {
    throw new UnsafeStateDirectoryError(statePath, ".ai-spend-agent does not resolve directly inside the approved root");
  }
  if (options.create) {
    await chmod(statePath, 0o700);
  }
  return statePath;
}

/**
 * Read one regular child file without following a symbolic link. State can sit
 * inside a cloned repository, so validating only the parent directory is not
 * enough: a committed child symlink must never expose an arbitrary local file.
 */
export async function readSafeStateText(stateDir: string, fileName: string): Promise<string> {
  const filePath = await resolveSafeStateChild(stateDir, fileName, false);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new UnsafeStateFileError(filePath, "the state entry is not a regular file");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new UnsafeStateFileError(filePath, "the state entry is a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Atomically replace one regular child file. The temporary file is created
 * exclusively with mode 0600, and rename replaces a last-moment symlink
 * itself rather than writing through to its target.
 */
export async function writeSafeStateText(
  stateDir: string,
  fileName: string,
  contents: string
): Promise<void> {
  const filePath = await resolveSafeStateChild(stateDir, fileName, true);
  const temporaryName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(stateDir, temporaryName);
  let handle;
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
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveSafeStateChild(
  stateDir: string,
  fileName: string,
  allowMissing: boolean
): Promise<string> {
  if (!fileName || basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new UnsafeStateFileError(join(stateDir, fileName), "state filenames must be one direct child name");
  }

  const requestedState = resolve(stateDir);
  const stateInfo = await lstat(requestedState);
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    throw new UnsafeStateDirectoryError(requestedState, "the state path is not a real directory");
  }

  const filePath = join(requestedState, fileName);
  const childInfo = await lstat(filePath).catch((error: unknown) => {
    if (allowMissing && isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (childInfo?.isSymbolicLink()) {
    throw new UnsafeStateFileError(filePath, "the state entry is a symbolic link");
  }
  if (childInfo && !childInfo.isFile()) {
    throw new UnsafeStateFileError(filePath, "the state entry is not a regular file");
  }
  return filePath;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function bestEffortRealpathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isAncestorPath(candidateAncestor: string, path: string): boolean {
  const normalizedAncestor = candidateAncestor.endsWith(sep) ? candidateAncestor : candidateAncestor + sep;
  return path.startsWith(normalizedAncestor);
}
