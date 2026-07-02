import { homedir } from "node:os";
import { resolve, sep } from "node:path";

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

export function unsafeScanRootReason(rootPath: string, home: string = homedir()): string | undefined {
  const resolved = resolve(rootPath);
  const resolvedHome = resolve(home);

  if (resolved === "/" || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
    return "the filesystem root is too broad for approved-source scanning";
  }
  if (resolved === resolvedHome) {
    return "the home directory is too broad for approved-source scanning";
  }
  if (isAncestorPath(resolved, resolvedHome)) {
    return "this directory contains your home directory and is too broad for approved-source scanning";
  }
  if (systemRootDirectories.has(resolved)) {
    return "system directories are not valid approved-source scan targets";
  }
  return undefined;
}

/** Throws a typed error when the root is unsafe; callers map it to their UX. */
export function assertSafeScanRoot(rootPath: string, home: string = homedir()): void {
  const reason = unsafeScanRootReason(rootPath, home);
  if (reason) {
    throw new UnsafeScanRootError(resolve(rootPath), reason);
  }
}

function isAncestorPath(candidateAncestor: string, path: string): boolean {
  const normalizedAncestor = candidateAncestor.endsWith(sep) ? candidateAncestor : candidateAncestor + sep;
  return path.startsWith(normalizedAncestor);
}
