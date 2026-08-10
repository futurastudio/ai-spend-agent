import { constants } from "node:fs";
import {
  open,
  lstat,
  mkdir,
  chmod,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  activitySnapshotSchema,
  createActivitySnapshotError,
  type ActivitySnapshot,
  type ActivitySnapshotRefreshErrorCode
} from "./activitySnapshot.js";

export const activitySnapshotCacheEnvironmentVariable = "AIBILL_CACHE_DIR";
export const activitySnapshotCacheFileName = "statusline-v1.json";
export const activitySnapshotCacheMaxBytes = 64 * 1_024;

const lockFileName = ".statusline-v1.lock";
const defaultLockTimeoutMs = 2_000;
const staleLockMs = 15_000;
const lockPollMs = 20;
const lockMetadataMaxBytes = 512;

type WriterLockOwner = {
  pid: number;
  token: string;
};

type WriterLockIdentity = WriterLockOwner & {
  dev: number;
  ino: number;
};

export type ActivitySnapshotCacheOptions = {
  /** Test/embedding override. Production defaults to ~/.aibill/cache. */
  cacheDirectory?: string;
  /** Test-only home override for validating the default private path. */
  homeDirectory?: string;
  /** Bounded wait for a concurrent writer. */
  lockTimeoutMs?: number;
};

export type ActivitySnapshotCacheReadErrorCode =
  | "unsafe_directory"
  | "unsafe_file"
  | "oversized"
  | "malformed"
  | "unsupported_version"
  | "permission"
  | "io";

export type ActivitySnapshotCacheReadResult =
  | { status: "ok"; snapshot: ActivitySnapshot }
  | { status: "missing" }
  | { status: "error"; code: ActivitySnapshotCacheReadErrorCode };

export type ActivitySnapshotCacheWriteResult =
  | { status: "written"; snapshot: ActivitySnapshot }
  | { status: "skipped_older"; snapshot: ActivitySnapshot };

export class ActivitySnapshotCacheError extends Error {
  readonly code:
    | ActivitySnapshotCacheReadErrorCode
    | "lock_timeout"
    | "invalid_snapshot";

  constructor(
    code: ActivitySnapshotCacheError["code"],
    message: string
  ) {
    super(message);
    this.name = "ActivitySnapshotCacheError";
    this.code = code;
  }
}

/** Resolve the fixed cache filename without creating or trusting it. */
export function activitySnapshotCachePath(options: ActivitySnapshotCacheOptions = {}): string {
  return join(configuredCacheDirectory(options), activitySnapshotCacheFileName);
}

/**
 * Read at most 64 KiB and validate the complete strict v1 contract. All
 * expected unsafe/malformed states are returned as data so status surfaces can
 * fail closed without printing local filesystem details.
 */
export async function readActivitySnapshot(
  options: ActivitySnapshotCacheOptions = {}
): Promise<ActivitySnapshotCacheReadResult> {
  let directory: string;
  try {
    directory = await resolveCacheDirectory(false, options);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return { status: "error", code: cacheReadErrorCode(error, "unsafe_directory") };
  }
  return readSnapshotFile(directory);
}

/**
 * Atomically publish a valid snapshot. Writers serialize through one bounded
 * private lock; comparison happens while the lock is held so a late, older
 * scan cannot replace newer evidence.
 */
export async function writeActivitySnapshot(
  snapshot: ActivitySnapshot,
  options: ActivitySnapshotCacheOptions = {}
): Promise<ActivitySnapshotCacheWriteResult> {
  let candidate: ActivitySnapshot;
  try {
    candidate = activitySnapshotSchema.parse(snapshot);
  } catch {
    throw new ActivitySnapshotCacheError("invalid_snapshot", "Activity snapshot does not match the strict v1 contract.");
  }
  return withWriterLock(options, async (directory) => {
    const existing = await readSnapshotFile(directory);
    if (existing.status === "ok" && !isNewer(candidate, existing.snapshot)) {
      return { status: "skipped_older", snapshot: existing.snapshot };
    }
    if (existing.status === "error" &&
        (existing.code === "unsafe_file" || existing.code === "permission" ||
         existing.code === "unsupported_version")) {
      throw new ActivitySnapshotCacheError(
        existing.code,
        "Refusing to replace an unsafe or inaccessible activity snapshot cache file."
      );
    }
    await atomicWriteSnapshot(directory, candidate);
    return { status: "written", snapshot: candidate };
  });
}

/**
 * Preserve the last-good financial values after a failed refresh. Only the
 * typed attempt timestamp and sanitized error code change. With no prior good
 * value, write a bounded error snapshot instead of manufacturing data.
 */
export async function recordActivitySnapshotRefreshFailure(
  attemptedAt: string,
  errorCode: ActivitySnapshotRefreshErrorCode,
  options: ActivitySnapshotCacheOptions = {}
): Promise<ActivitySnapshotCacheWriteResult> {
  const parsedAttempt = new Date(attemptedAt);
  if (!Number.isFinite(parsedAttempt.getTime())) {
    throw new ActivitySnapshotCacheError("invalid_snapshot", "Refresh attempt time must be a valid ISO timestamp.");
  }
  const normalizedAttempt = parsedAttempt.toISOString();
  return withWriterLock(options, async (directory) => {
    const existing = await readSnapshotFile(directory);
    if (existing.status === "ok") {
      const newestExistingEvent = Math.max(
        Date.parse(existing.snapshot.lastAttemptAt),
        Date.parse(existing.snapshot.generatedAt)
      );
      if (Date.parse(normalizedAttempt) <= newestExistingEvent) {
        return { status: "skipped_older", snapshot: existing.snapshot };
      }
      const failed = activitySnapshotSchema.parse({
        ...existing.snapshot,
        lastAttemptAt: normalizedAttempt,
        refresh: { status: "error", errorCode }
      });
      await atomicWriteSnapshot(directory, failed);
      return { status: "written", snapshot: failed };
    }
    if (existing.status === "error" &&
        (existing.code === "unsafe_file" || existing.code === "permission" ||
         existing.code === "unsupported_version")) {
      throw new ActivitySnapshotCacheError(
        existing.code,
        "Refusing to replace an unsafe or inaccessible activity snapshot cache file."
      );
    }
    const failed = createActivitySnapshotError(normalizedAttempt, errorCode);
    await atomicWriteSnapshot(directory, failed);
    return { status: "written", snapshot: failed };
  });
}

async function withWriterLock<T>(
  options: ActivitySnapshotCacheOptions,
  operation: (directory: string) => Promise<T>
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
      const candidateInfo = await candidateHandle.stat();
      candidateIdentity = { ...owner, dev: candidateInfo.dev, ino: candidateInfo.ino };
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
          throw new ActivitySnapshotCacheError("unsafe_file", "Activity snapshot writer lock is a symbolic link.");
        }
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() - started >= timeout) {
        throw new ActivitySnapshotCacheError("lock_timeout", "Timed out waiting for the activity snapshot writer lock.");
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

async function readSnapshotFile(directory: string): Promise<ActivitySnapshotCacheReadResult> {
  const filePath = join(directory, activitySnapshotCacheFileName);
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return { status: "error", code: cacheReadErrorCode(error, "io") };
  }
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    return { status: "error", code: "unsafe_file" };
  }
  if (!hasPrivatePermissions(fileInfo.mode)) {
    return { status: "error", code: "unsafe_file" };
  }
  if (fileInfo.size > activitySnapshotCacheMaxBytes) {
    return { status: "error", code: "oversized" };
  }

  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) return { status: "error", code: "unsafe_file" };
    if (!hasPrivatePermissions(openedInfo.mode)) {
      return { status: "error", code: "unsafe_file" };
    }
    if (openedInfo.size > activitySnapshotCacheMaxBytes) {
      return { status: "error", code: "oversized" };
    }
    // Bound the actual read, not only the preceding stat: the file may grow
    // after inspection. One extra byte is enough to detect overflow without
    // ever allocating or reading an attacker-controlled whole file.
    const bounded = Buffer.allocUnsafe(activitySnapshotCacheMaxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(
        bounded,
        bytesRead,
        bounded.length - bytesRead,
        bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > activitySnapshotCacheMaxBytes) {
      return { status: "error", code: "oversized" };
    }
    const contents = bounded.subarray(0, bytesRead).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      return { status: "error", code: "malformed" };
    }
    if (isRecord(value) && value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      return { status: "error", code: "unsupported_version" };
    }
    const parsed = activitySnapshotSchema.safeParse(value);
    return parsed.success
      ? { status: "ok", snapshot: parsed.data }
      : { status: "error", code: "malformed" };
  } catch (error) {
    if (isNodeError(error, "ELOOP")) return { status: "error", code: "unsafe_file" };
    return { status: "error", code: cacheReadErrorCode(error, "io") };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteSnapshot(directory: string, snapshot: ActivitySnapshot): Promise<void> {
  const contents = `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(contents, "utf8") > activitySnapshotCacheMaxBytes) {
    throw new ActivitySnapshotCacheError("invalid_snapshot", "Activity snapshot exceeds the 64 KiB cache limit.");
  }
  const filePath = join(directory, activitySnapshotCacheFileName);
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ActivitySnapshotCacheError("unsafe_file", "Activity snapshot cache path is not a regular file.");
  }

  const temporaryPath = join(
    directory,
    `.${activitySnapshotCacheFileName}.${process.pid}.${randomUUID()}.tmp`
  );
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
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveCacheDirectory(
  create: boolean,
  options: ActivitySnapshotCacheOptions
): Promise<string> {
  const usesDefaultDirectory = !options.cacheDirectory?.trim() &&
    !process.env[activitySnapshotCacheEnvironmentVariable]?.trim();
  if (usesDefaultDirectory) {
    await ensureDefaultParent(options.homeDirectory ?? homedir(), create);
  }
  const requested = configuredCacheDirectory(options);
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
    info = await lstat(requested);
  }
  if (!info) {
    const error = new Error("Activity snapshot cache directory does not exist.") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ActivitySnapshotCacheError("unsafe_directory", "Activity snapshot cache directory is not a real directory.");
  }
  if (!create && !hasPrivatePermissions(info.mode)) {
    throw new ActivitySnapshotCacheError("unsafe_directory", "Activity snapshot cache directory is not private.");
  }
  const canonical = await realpath(requested);
  const confirmed = await lstat(requested);
  if (confirmed.isSymbolicLink() || !confirmed.isDirectory()) {
    throw new ActivitySnapshotCacheError("unsafe_directory", "Activity snapshot cache directory changed during validation.");
  }
  if (create) await chmod(canonical, 0o700);
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
      // Two first-ever writers may both observe ENOENT. The winner creates
      // the directory; the loser must re-validate it rather than fail.
      if (!isNodeError(error, "EEXIST")) throw error;
    });
    info = await lstat(parent);
  }
  if (!info) {
    const error = new Error("The private aibill directory does not exist.") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ActivitySnapshotCacheError("unsafe_directory", "The private aibill directory is not a real directory.");
  }
  if (!create && !hasPrivatePermissions(info.mode)) {
    throw new ActivitySnapshotCacheError("unsafe_directory", "The private aibill directory is not private.");
  }
  if (create) await chmod(parent, 0o700);
}

function configuredCacheDirectory(options: ActivitySnapshotCacheOptions): string {
  const configured = options.cacheDirectory?.trim() ||
    process.env[activitySnapshotCacheEnvironmentVariable]?.trim();
  const value = configured && configured.length > 0
    ? configured
    : join(options.homeDirectory ?? homedir(), ".aibill", "cache");
  return resolve(value);
}

async function removeStaleLock(lockPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || !hasPrivatePermissions(info.mode)) {
      throw new ActivitySnapshotCacheError(
        "unsafe_file",
        "Activity snapshot writer lock is not a private regular file."
      );
    }
    if (Date.now() - info.mtimeMs <= staleLockMs) return;
    const owner = await readLockOwner(handle);
    // Age alone never proves abandonment: a live writer may be paused while
    // holding the lock. Unknown/malformed ownership also fails closed.
    if (!owner || processIsAlive(owner.pid)) return;
    await handle.close();
    handle = undefined;
    await releaseOwnedLock(lockPath, { ...owner, dev: info.dev, ino: info.ino });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    if (isNodeError(error, "ELOOP")) {
      throw new ActivitySnapshotCacheError(
        "unsafe_file",
        "Activity snapshot writer lock is a symbolic link."
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function releaseOwnedLock(
  lockPath: string,
  identity: WriterLockIdentity
): Promise<void> {
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
    // A live owner cannot be legitimately evicted, so once both inode and
    // unguessable token match, unlinking cannot release another writer's lock.
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
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 || typeof value.token !== "string" ||
      value.token.length < 16 || value.token.length > 128) {
    return undefined;
  }
  return { pid: value.pid as number, token: value.token };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync().catch((error: unknown) => {
      if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP")) throw error;
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isNewer(candidate: ActivitySnapshot, existing: ActivitySnapshot): boolean {
  const attemptDifference = Date.parse(candidate.lastAttemptAt) - Date.parse(existing.lastAttemptAt);
  if (attemptDifference !== 0) return attemptDifference > 0;
  const generatedDifference = Date.parse(candidate.generatedAt) - Date.parse(existing.generatedAt);
  if (generatedDifference !== 0) return generatedDifference > 0;
  return false;
}

function boundedLockTimeout(value: number | undefined): number {
  if (value === undefined) return defaultLockTimeoutMs;
  if (!Number.isFinite(value)) return defaultLockTimeoutMs;
  return Math.max(0, Math.min(10_000, Math.floor(value)));
}

function cacheReadErrorCode(
  error: unknown,
  fallback: ActivitySnapshotCacheReadErrorCode
): ActivitySnapshotCacheReadErrorCode {
  if (error instanceof ActivitySnapshotCacheError &&
      (error.code === "unsafe_directory" || error.code === "unsafe_file" ||
       error.code === "oversized" || error.code === "malformed" ||
       error.code === "unsupported_version" || error.code === "permission" ||
       error.code === "io")) {
    return error.code;
  }
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) return "permission";
  return fallback;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function hasPrivatePermissions(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
