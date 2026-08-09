import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A connected-provider spend file lives inside a repository and is therefore
 * untrusted by default. A successful provider sync writes this small receipt
 * outside the repository, binding the exact spend.json bytes to this machine
 * and canonical project root. Successful syncs also bind sources.json so a
 * clone cannot forge validation or financial-evidence axes. Merely cloning
 * committed state cannot create the external receipt.
 */
export type ConnectedSpendTrustResult =
  | {
      trusted: true;
      trustedAt: string;
      spendSha256: string;
      sourceRegistrySha256?: string;
    }
  | {
      trusted: false;
      reason: "missing" | "mismatch" | "invalid";
      message: string;
    };

type ConnectedSpendTrustReceipt = {
  version: 1;
  canonicalRoot: string;
  mode: "connected_provider";
  trustedAt: string;
  spendSha256: string;
  sourceRegistrySha256?: string;
  stateDigest: string;
};

const trustDirectoryEnvironmentVariable = "AI_SPEND_STATE_TRUST_DIR";

export type ConnectedSpendTrustOptions = {
  /** Test/embedding override. Production callers normally use user state. */
  trustDirectory?: string;
  /** Exact sources.json bytes written by the same successful provider sync. */
  sourceRegistryContents?: string;
};

export async function writeConnectedSpendTrustReceipt(
  rootPath: string,
  exactSpendContents: string,
  options: ConnectedSpendTrustOptions = {}
): Promise<void> {
  const canonicalRoot = await realpath(resolve(rootPath));
  const trustDirectory = await resolveTrustDirectory(canonicalRoot, true, options.trustDirectory);
  const spendSha256 = sha256(exactSpendContents);
  const sourceRegistrySha256 = options.sourceRegistryContents === undefined
    ? undefined
    : sha256(options.sourceRegistryContents);
  const trustedAt = new Date().toISOString();
  const receipt: ConnectedSpendTrustReceipt = {
    version: 1,
    canonicalRoot,
    mode: "connected_provider",
    trustedAt,
    spendSha256,
    ...(sourceRegistrySha256 ? { sourceRegistrySha256 } : {}),
    stateDigest: connectedStateDigest(canonicalRoot, spendSha256, sourceRegistrySha256)
  };
  await writePrivateFile(
    trustDirectory,
    receiptFileName(canonicalRoot),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

export async function verifyConnectedSpendTrustReceipt(
  rootPath: string,
  exactSpendContents: string,
  options: ConnectedSpendTrustOptions = {}
): Promise<ConnectedSpendTrustResult> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(rootPath));
  } catch {
    return invalidTrust("the project root no longer resolves");
  }

  let trustDirectory: string;
  try {
    trustDirectory = await resolveTrustDirectory(canonicalRoot, false, options.trustDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return missingTrust();
    }
    return invalidTrust(error instanceof Error ? error.message : String(error));
  }

  let rawReceipt: string;
  try {
    rawReceipt = await readPrivateFile(trustDirectory, receiptFileName(canonicalRoot));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return missingTrust();
    return invalidTrust(error instanceof Error ? error.message : String(error));
  }

  let receipt: unknown;
  try {
    receipt = JSON.parse(rawReceipt);
  } catch {
    return invalidTrust("the external provider-sync receipt is not valid JSON");
  }
  if (!isTrustReceipt(receipt)) {
    return invalidTrust("the external provider-sync receipt has an invalid shape");
  }

  const spendSha256 = sha256(exactSpendContents);
  const expectedStateDigest = connectedStateDigest(
    canonicalRoot,
    spendSha256,
    receipt.sourceRegistrySha256
  );
  if (
    receipt.canonicalRoot !== canonicalRoot ||
    receipt.spendSha256 !== spendSha256 ||
    receipt.stateDigest !== expectedStateDigest
  ) {
    return {
      trusted: false,
      reason: "mismatch",
      message: connectedTrustFailureMessage(
        "the exact spend.json contents do not match the last successful provider sync"
      )
    };
  }

  return {
    trusted: true,
    trustedAt: receipt.trustedAt,
    spendSha256,
    ...(receipt.sourceRegistrySha256
      ? { sourceRegistrySha256: receipt.sourceRegistrySha256 }
      : {})
  };
}

/**
 * Provider/source truth axes are trusted only when the same external receipt
 * binds both the connected spend state and the exact persisted sources.json.
 * A repository clone or edit can therefore register a boundary, but cannot
 * self-assert live validation or verified financial evidence.
 */
export async function verifyConnectedSourceRegistryTrustReceipt(
  rootPath: string,
  exactSpendContents: string,
  exactSourceRegistryContents: string,
  options: ConnectedSpendTrustOptions = {}
): Promise<ConnectedSpendTrustResult> {
  const spendTrust = await verifyConnectedSpendTrustReceipt(rootPath, exactSpendContents, options);
  if (!spendTrust.trusted) return spendTrust;
  if (!spendTrust.sourceRegistrySha256) {
    return {
      trusted: false,
      reason: "missing",
      message: connectedTrustFailureMessage(
        "its external provider-sync receipt does not bind the persisted source registry"
      )
    };
  }
  if (spendTrust.sourceRegistrySha256 !== sha256(exactSourceRegistryContents)) {
    return {
      trusted: false,
      reason: "mismatch",
      message: connectedTrustFailureMessage(
        "the exact sources.json contents do not match the last successful provider sync"
      )
    };
  }
  return spendTrust;
}

/** Remove stale trust whenever connected state is reset or replaced locally. */
export async function invalidateConnectedSpendTrustReceipt(
  rootPath: string,
  options: ConnectedSpendTrustOptions = {}
): Promise<void> {
  const canonicalRoot = await realpath(resolve(rootPath));
  let trustDirectory: string;
  try {
    trustDirectory = await resolveTrustDirectory(canonicalRoot, false, options.trustDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  const receiptPath = join(trustDirectory, receiptFileName(canonicalRoot));
  const receiptInfo = await lstat(receiptPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!receiptInfo) return;
  // unlink removes a malicious link itself rather than touching its target.
  if (!receiptInfo.isFile() && !receiptInfo.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-file provider trust receipt: ${receiptPath}`);
  }
  await unlink(receiptPath);
}

export function connectedTrustFailureMessage(reason: string): string {
  return [
    `Connected provider state is not trusted on this machine because ${reason}.`,
    "Re-run the provider sync with the original environment credential reference before using connected totals or Apply actions."
  ].join(" ");
}

async function resolveTrustDirectory(
  canonicalRoot: string,
  create: boolean,
  override?: string
): Promise<string> {
  const configured = override?.trim() || process.env[trustDirectoryEnvironmentVariable]?.trim();
  const requested = resolve(
    configured && configured.length > 0
      ? configured
      : join(homedir(), ".aibill", "state-receipts")
  );

  let info = await lstat(requested).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info && create) {
    await mkdir(requested, { recursive: true, mode: 0o700 });
    info = await lstat(requested);
  }
  if (!info) {
    const error = new Error(`Provider trust directory does not exist: ${requested}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing provider trust directory ${requested}: it is not a real directory.`);
  }

  const canonicalTrustDirectory = await realpath(requested);
  if (isSameOrDescendant(canonicalTrustDirectory, canonicalRoot)) {
    throw new Error(
      `Refusing provider trust directory ${canonicalTrustDirectory}: it must stay outside the approved repository.`
    );
  }
  if (create) await chmod(canonicalTrustDirectory, 0o700);
  return canonicalTrustDirectory;
}

async function readPrivateFile(directory: string, fileName: string): Promise<string> {
  const filePath = directChild(directory, fileName);
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing provider trust receipt ${filePath}: it is not a regular file.`);
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) {
      throw new Error(`Refusing provider trust receipt ${filePath}: it is not a regular file.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close();
  }
}

async function writePrivateFile(directory: string, fileName: string, contents: string): Promise<void> {
  const filePath = directChild(directory, fileName);
  const existing = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Refusing provider trust receipt ${filePath}: it is not a regular file.`);
  }

  const temporaryPath = join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
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

function directChild(directory: string, fileName: string): string {
  if (!fileName || basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new Error("Provider trust receipt filenames must be one direct child name.");
  }
  return join(directory, fileName);
}

function receiptFileName(canonicalRoot: string): string {
  return `${sha256(canonicalRoot)}.json`;
}

function connectedStateDigest(
  canonicalRoot: string,
  spendSha256: string,
  sourceRegistrySha256?: string
): string {
  return sourceRegistrySha256
    ? sha256(`aibill-connected-state-v1\0${canonicalRoot}\0${spendSha256}\0${sourceRegistrySha256}`)
    : sha256(`aibill-connected-state-v1\0${canonicalRoot}\0${spendSha256}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isTrustReceipt(value: unknown): value is ConnectedSpendTrustReceipt {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    value.mode === "connected_provider" &&
    typeof value.canonicalRoot === "string" &&
    typeof value.trustedAt === "string" &&
    Number.isFinite(Date.parse(value.trustedAt)) &&
    isSha256(value.spendSha256) &&
    (value.sourceRegistrySha256 === undefined || isSha256(value.sourceRegistrySha256)) &&
    isSha256(value.stateDigest);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" ||
    (pathFromParent !== ".." && !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(pathFromParent));
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function missingTrust(): ConnectedSpendTrustResult {
  return {
    trusted: false,
    reason: "missing",
    message: connectedTrustFailureMessage("its external provider-sync receipt is missing")
  };
}

function invalidTrust(reason: string): ConnectedSpendTrustResult {
  return {
    trusted: false,
    reason: "invalid",
    message: connectedTrustFailureMessage(`its external provider-sync receipt is invalid (${reason})`)
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
