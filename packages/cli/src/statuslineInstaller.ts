import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { dirname, posix, win32, type PlatformPath } from "node:path";
import { TextDecoder } from "node:util";

const RECEIPT_KIND = "aibill.statusline_install_receipt";
const RECEIPT_VERSION = 1;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_RUNNER_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 100_000;
const LOCK_STALE_AFTER_MS = 30 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const aibillStatuslineRefreshIntervalSeconds = 30;

export type StatuslinePlatform = "darwin" | "linux" | "win32";

export type StatuslinePaths = {
  settingsPath: string;
  runnerPath: string;
  receiptPath: string;
  backupDirectory: string;
  lockPath: string;
  projectSettingsPath: string;
  localSettingsPath: string;
  managedSettingsPath: string;
  managedDropInDirectory: string;
};

export type AibillStatusLineSetting = {
  type: "command";
  command: string;
  refreshInterval: 30;
};

type InstallerTestHooks = {
  /** Runs only after every replacement file has been fully prepared and checked. */
  afterPrepare?: () => void | Promise<void>;
  /** Backward-compatible name used by the first installer fixtures. */
  beforeSettingsCommit?: () => void | Promise<void>;
  /** Tests can exercise a race between ordered transaction commit points. */
  afterMutationCommit?: (path: string, index: number) => void | Promise<void>;
};

export type InstallStatuslineOptions = InstallerTestHooks & {
  homeDir: string;
  cwd: string;
  /** Integration can pass a packaged asset path without importing renderer code. */
  runnerSourcePath?: string;
  /** Or pass the exact standalone runner bytes produced by the renderer lane. */
  runnerContents?: string | Uint8Array;
  platform?: StatuslinePlatform;
  replace?: boolean;
  now?: Date;
  /** Windows only: the locally visible Program Files root. */
  programFilesDir?: string;
  /** Narrow fixture/embedding overrides; unspecified paths keep platform defaults. */
  pathOverrides?: Partial<StatuslinePaths>;
  /** Tests and embedding callers can supply explicit locally visible managed files. */
  managedSettingsPaths?: string[];
};

export type UninstallStatuslineOptions = InstallerTestHooks & {
  homeDir: string;
  cwd: string;
  platform?: StatuslinePlatform;
  programFilesDir?: string;
  pathOverrides?: Partial<StatuslinePaths>;
};

export type StatuslineInstallResult = {
  action: "installed" | "unchanged";
  settingsPath: string;
  runnerPath: string;
  receiptPath: string;
  backupPath?: string;
};

export type StatuslineUninstallResult = {
  action: "uninstalled";
  settingsPath: string;
  runnerPath: string;
  runnerRemoved: boolean;
  runnerAction: "removed" | "restored" | "preserved-modified" | "already-missing";
  statusLineAction: "removed" | "restored-prior";
  warnings: string[];
};

export type StatuslineInstallerErrorCode =
  | "concurrent-edit"
  | "hooks-disabled"
  | "installer-busy"
  | "invalid-receipt"
  | "invalid-settings-json"
  | "missing-ownership"
  | "ownership-mismatch"
  | "settings-shadowed"
  | "statusline-conflict"
  | "unsafe-runner-source"
  | "unsafe-settings-file";

export class StatuslineInstallerError extends Error {
  readonly code: StatuslineInstallerErrorCode;

  constructor(code: StatuslineInstallerErrorCode, message: string) {
    super(message);
    this.name = "StatuslineInstallerError";
    this.code = code;
  }
}

class IncompleteStatuslineTransactionError extends StatuslineInstallerError {
  readonly retainRecoveryBackups = true;

  constructor() {
    super(
      "concurrent-edit",
      "The installer transaction was interrupted by a concurrent edit and exact rollback was not possible; recovery backups were retained."
    );
    this.name = "IncompleteStatuslineTransactionError";
  }
}

type JsonObject = Record<string, unknown>;

type FileSnapshot = {
  exists: boolean;
  bytes: Uint8Array;
  mode?: number;
  dev?: number;
  ino?: number;
};

type SettingsRead = FileSnapshot & {
  raw: string;
  value: JsonObject;
};

type StatuslineInstallReceipt = {
  kind: typeof RECEIPT_KIND;
  version: typeof RECEIPT_VERSION;
  installedAt: string;
  receiptPath: string;
  settingsPath: string;
  runnerPath: string;
  backupPath: string;
  settingsBackupDigest: string;
  priorFileExisted: boolean;
  priorHadStatusLine: boolean;
  priorStatusLine?: unknown;
  priorRunnerExisted: boolean;
  runnerBackupPath?: string;
  priorRunnerDigest?: string;
  priorRunnerMode?: number;
  installedStatusLine: AibillStatusLineSetting;
  installedStatusLineDigest: string;
  installedRunnerDigest: string;
};

type ReceiptRead = {
  receipt: StatuslineInstallReceipt;
  snapshot: FileSnapshot;
};

type PreparedMutation = {
  path: string;
  before: FileSnapshot;
  after?: Uint8Array;
  mode?: number;
  privateParent: boolean;
  mismatchCode: StatuslineInstallerErrorCode;
  temporaryPath?: string;
  committed: boolean;
};

type LockRecord = {
  version: 1;
  pid: number;
  createdAt: string;
  token: string;
};

type InstallerLock = {
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

export function resolveStatuslinePaths(
  homeDir: string,
  cwd: string,
  platform: StatuslinePlatform = normalizePlatform(hostPlatform()),
  options: { programFilesDir?: string } = {}
): StatuslinePaths {
  const path = pathFor(platform);
  const stateDirectory = path.join(homeDir, ".aibill");
  const programFilesDirectory = options.programFilesDir
    ?? (platform === "win32" && normalizePlatform(hostPlatform()) === "win32" ? process.env.ProgramFiles : undefined)
    ?? "C:\\Program Files";
  const managedDirectory = platform === "darwin"
    ? path.join(path.parse(homeDir).root, "Library", "Application Support", "ClaudeCode")
    : platform === "win32"
      ? path.join(programFilesDirectory, "ClaudeCode")
      : path.join(path.parse(homeDir).root, "etc", "claude-code");

  return {
    settingsPath: path.join(homeDir, ".claude", "settings.json"),
    runnerPath: path.join(stateDirectory, "bin", "statusline.mjs"),
    receiptPath: path.join(stateDirectory, "statusline-install-receipt.json"),
    backupDirectory: path.join(stateDirectory, "backups"),
    lockPath: path.join(stateDirectory, "statusline-install.lock"),
    projectSettingsPath: path.join(cwd, ".claude", "settings.json"),
    localSettingsPath: path.join(cwd, ".claude", "settings.local.json"),
    managedSettingsPath: path.join(managedDirectory, "managed-settings.json"),
    managedDropInDirectory: path.join(managedDirectory, "managed-settings.d")
  };
}

export function buildAibillStatusLineSetting(_platform: StatuslinePlatform = normalizePlatform(hostPlatform())): AibillStatusLineSetting {
  return {
    type: "command",
    command: "node ~/.aibill/bin/statusline.mjs",
    refreshInterval: aibillStatuslineRefreshIntervalSeconds
  };
}

export function manualStatuslineConfigSnippet(platform?: StatuslinePlatform): string {
  return `${JSON.stringify({ statusLine: buildAibillStatusLineSetting(platform) }, null, 2)}\n`;
}

export async function installClaudeStatusline(options: InstallStatuslineOptions): Promise<StatuslineInstallResult> {
  const platform = options.platform ?? normalizePlatform(hostPlatform());
  const path = pathFor(platform);
  const paths = {
    ...resolveStatuslinePaths(options.homeDir, options.cwd, platform, { programFilesDir: options.programFilesDir }),
    ...options.pathOverrides
  };
  await ensurePrivateDirectory(dirname(paths.lockPath));
  const installerLock = await acquireInstallerLock(paths.lockPath, new Date());

  try {
    const desired = buildAibillStatusLineSetting(platform);
    const desiredDigest = digestJson(desired);
    const sourceRunner = await resolveRunnerSource(options);
    const sourceRunnerDigest = digestBytes(sourceRunner);
    const existing = await readSettings(paths.settingsPath);
    const runnerBefore = await readFileSnapshot(paths.runnerPath, MAX_RUNNER_BYTES, "unsafe-runner-source", true);
    const receiptRead = await readReceiptIfPresent(paths, platform);

    await assertNoEffectiveConflict(
      paths,
      existing.value,
      options.homeDir,
      options.cwd,
      platform,
      options.managedSettingsPaths
    );

    const existingStatusLine = existing.value.statusLine;
    if (receiptRead) {
      const receipt = receiptRead.receipt;
      await verifyReceiptBackups(receipt, paths, platform);
      if (existingStatusLine === undefined || digestJson(existingStatusLine) !== receipt.installedStatusLineDigest) {
        throw new StatuslineInstallerError(
          "ownership-mismatch",
          "Claude statusLine changed after aibill installed it; refusing to overwrite the user's current value."
        );
      }
      if (runnerBefore.exists && digestBytes(runnerBefore.bytes) !== receipt.installedRunnerDigest) {
        throw new StatuslineInstallerError(
          "ownership-mismatch",
          "The installed aibill runner changed after installation; refusing an owned update."
        );
      }
      if (receipt.installedStatusLineDigest !== desiredDigest) {
        throw new StatuslineInstallerError("invalid-receipt", "The ownership receipt does not describe the supported aibill command.");
      }

      if (runnerBefore.exists && sourceRunnerDigest === receipt.installedRunnerDigest) {
        return {
          action: "unchanged",
          settingsPath: paths.settingsPath,
          runnerPath: paths.runnerPath,
          receiptPath: paths.receiptPath,
          backupPath: receipt.backupPath
        };
      }

      const updatedReceipt: StatuslineInstallReceipt = {
        ...receipt,
        installedRunnerDigest: sourceRunnerDigest
      };
      const mutations = [
        mutation(paths.runnerPath, runnerBefore, sourceRunner, runnerBefore.mode ?? 0o600, true, "ownership-mismatch")
      ];
      if (sourceRunnerDigest !== receipt.installedRunnerDigest) {
        const receiptBytes = serializeBoundedJson(updatedReceipt, MAX_RECEIPT_BYTES, "invalid-receipt", "ownership receipt");
        mutations.push(mutation(paths.receiptPath, receiptRead.snapshot, receiptBytes, 0o600, true, "invalid-receipt"));
      }
      await applyMutations(
        mutations,
        options,
        [{ path: paths.settingsPath, before: existing, code: "ownership-mismatch" }],
        [installerLock.assertOwned]
      );

      return {
        action: "installed",
        settingsPath: paths.settingsPath,
        runnerPath: paths.runnerPath,
        receiptPath: paths.receiptPath,
        backupPath: receipt.backupPath
      };
    }

    if (existingStatusLine !== undefined && !options.replace) {
      throw new StatuslineInstallerError(
        "statusline-conflict",
        "Claude user settings already contain an unowned statusLine; rerun with explicit replacement enabled."
      );
    }
    if (runnerBefore.exists && !options.replace) {
      throw new StatuslineInstallerError(
        "statusline-conflict",
        "The aibill runner path already contains an unowned file; rerun with explicit replacement enabled."
      );
    }

    const now = options.now ?? new Date();
    const backupPath = backupFilePath(paths.backupDirectory, existing.bytes, now, path);
    const runnerBackupPath = runnerBefore.exists
      ? runnerBackupFilePath(paths.backupDirectory, runnerBefore.bytes, now, path)
      : undefined;
    const nextSettings = cloneJson(existing.value);
    nextSettings.statusLine = desired;
    const nextSettingsBytes = serializeBoundedJson(nextSettings, MAX_SETTINGS_BYTES, "unsafe-settings-file", "Claude settings");
    const installReceipt: StatuslineInstallReceipt = {
      kind: RECEIPT_KIND,
      version: RECEIPT_VERSION,
      installedAt: validIso(now),
      receiptPath: paths.receiptPath,
      settingsPath: paths.settingsPath,
      runnerPath: paths.runnerPath,
      backupPath,
      settingsBackupDigest: digestBytes(existing.bytes),
      priorFileExisted: existing.exists,
      priorHadStatusLine: existingStatusLine !== undefined,
      ...(existingStatusLine !== undefined ? { priorStatusLine: cloneJson(existingStatusLine) } : {}),
      priorRunnerExisted: runnerBefore.exists,
      ...(runnerBefore.exists && runnerBackupPath
        ? {
            runnerBackupPath,
            priorRunnerDigest: digestBytes(runnerBefore.bytes),
            priorRunnerMode: runnerBefore.mode ?? 0o600
          }
        : {}),
      installedStatusLine: desired,
      installedStatusLineDigest: desiredDigest,
      installedRunnerDigest: sourceRunnerDigest
    };
    const receiptBytes = serializeBoundedJson(installReceipt, MAX_RECEIPT_BYTES, "invalid-receipt", "ownership receipt");

    const createdBackups: Array<{ path: string; digest: string }> = [];
    try {
      await installerLock.assertOwned();
      await createExactBackup(backupPath, existing.bytes);
      createdBackups.push({ path: backupPath, digest: digestBytes(existing.bytes) });
      if (runnerBefore.exists && runnerBackupPath) {
        await createExactBackup(runnerBackupPath, runnerBefore.bytes);
        createdBackups.push({ path: runnerBackupPath, digest: digestBytes(runnerBefore.bytes) });
      }

      await applyMutations([
        mutation(paths.runnerPath, runnerBefore, sourceRunner, 0o600, true, "concurrent-edit"),
        mutation(paths.receiptPath, missingSnapshot(), receiptBytes, 0o600, true, "concurrent-edit"),
        mutation(paths.settingsPath, existing, nextSettingsBytes, existing.mode ?? 0o600, false, "concurrent-edit")
      ], options, [], [installerLock.assertOwned]);
    } catch (error) {
      if (!(error instanceof IncompleteStatuslineTransactionError)) {
        for (const backup of createdBackups.reverse()) {
          await removeOwnedFile(backup.path, backup.digest).catch(() => undefined);
        }
      }
      throw error;
    }

    return {
      action: "installed",
      settingsPath: paths.settingsPath,
      runnerPath: paths.runnerPath,
      receiptPath: paths.receiptPath,
      backupPath
    };
  } finally {
    await installerLock.release();
  }
}

/**
 * C-lane §2.1 (QA-12c): a cache-refreshing CLI run re-copies the CURRENT
 * compiled runtime over our own previously installed runner — an update of an
 * install the user already consented to. Without an ownership receipt there
 * is no aibill install, and nothing is created or touched.
 */
export async function refreshOwnedStatuslineRunner(
  options: InstallStatuslineOptions
): Promise<"refreshed" | "unchanged" | "not-installed"> {
  const platform = options.platform ?? normalizePlatform(hostPlatform());
  const paths = {
    ...resolveStatuslinePaths(options.homeDir, options.cwd, platform, { programFilesDir: options.programFilesDir }),
    ...options.pathOverrides
  };
  let receiptRead: ReceiptRead | undefined;
  try {
    receiptRead = await readReceiptIfPresent(paths, platform);
  } catch {
    return "not-installed";
  }
  if (!receiptRead) return "not-installed";
  const result = await installClaudeStatusline(options);
  return result.action === "unchanged" ? "unchanged" : "refreshed";
}

export async function uninstallClaudeStatusline(options: UninstallStatuslineOptions): Promise<StatuslineUninstallResult> {
  const platform = options.platform ?? normalizePlatform(hostPlatform());
  const paths = {
    ...resolveStatuslinePaths(options.homeDir, options.cwd, platform, { programFilesDir: options.programFilesDir }),
    ...options.pathOverrides
  };
  await ensurePrivateDirectory(dirname(paths.lockPath));
  const installerLock = await acquireInstallerLock(paths.lockPath, new Date());

  try {
    const receiptRead = await readRequiredReceipt(paths, platform);
    const receipt = receiptRead.receipt;
    const backups = await verifyReceiptBackups(receipt, paths, platform);
    const existing = await readSettings(paths.settingsPath);
    if (existing.value.statusLine === undefined) {
      throw new StatuslineInstallerError("ownership-mismatch", "Claude user settings no longer contain the statusLine owned by aibill.");
    }
    if (digestJson(existing.value.statusLine) !== receipt.installedStatusLineDigest) {
      throw new StatuslineInstallerError(
        "ownership-mismatch",
        "Claude statusLine changed after aibill installed it; refusing to overwrite the user's current value."
      );
    }

    const runnerCurrent = await readFileSnapshot(paths.runnerPath, MAX_RUNNER_BYTES, "ownership-mismatch", true);
    const runnerStillOwned = runnerCurrent.exists && digestBytes(runnerCurrent.bytes) === receipt.installedRunnerDigest;
    if (!runnerStillOwned && receipt.priorRunnerExisted) {
      throw new StatuslineInstallerError(
        "ownership-mismatch",
        "The installed runner changed; refusing to overwrite it with the pre-installation runner."
      );
    }

    const nextSettings = cloneJson(existing.value);
    if (receipt.priorHadStatusLine) {
      nextSettings.statusLine = cloneJson(receipt.priorStatusLine);
    } else {
      delete nextSettings.statusLine;
    }
    const removeSettingsFile = !receipt.priorFileExisted && Object.keys(nextSettings).length === 0;
    let exactSettingsBackup: Uint8Array | undefined;
    if (receipt.priorFileExisted) {
      const priorRaw = decodeUtf8Strict(
        backups.settings.bytes,
        "invalid-receipt",
        "The exact settings backup is not valid UTF-8."
      );
      const priorSettings = parseJson(
        priorRaw,
        "invalid-receipt",
        "The exact settings backup is not strict finite JSON."
      );
      if (!isJsonObject(priorSettings)) throw invalidReceiptShape();
      const expectedInstalledSettings = cloneJson(priorSettings);
      expectedInstalledSettings.statusLine = cloneJson(receipt.installedStatusLine);
      const expectedInstalledBytes = serializeBoundedJson(
        expectedInstalledSettings,
        MAX_SETTINGS_BYTES,
        "invalid-receipt",
        "installed Claude settings"
      );
      if (bytesEqual(existing.bytes, expectedInstalledBytes)) {
        exactSettingsBackup = backups.settings.bytes;
      }
    }
    const nextSettingsBytes = removeSettingsFile
      ? undefined
      : exactSettingsBackup ??
        serializeBoundedJson(nextSettings, MAX_SETTINGS_BYTES, "unsafe-settings-file", "Claude settings");

    const settingsMutation = mutation(
      paths.settingsPath,
      existing,
      nextSettingsBytes,
      existing.mode ?? 0o600,
      false,
      "concurrent-edit"
    );
    let runnerMutation: PreparedMutation | undefined;
    let runnerRemoved = false;
    let runnerAction: StatuslineUninstallResult["runnerAction"];
    const warnings: string[] = [];
    if (runnerStillOwned) {
      if (receipt.priorRunnerExisted) {
        runnerMutation = mutation(
          paths.runnerPath,
          runnerCurrent,
          backups.runner?.bytes,
          receipt.priorRunnerMode ?? 0o600,
          true,
          "ownership-mismatch"
        );
        runnerAction = "restored";
      } else {
        runnerMutation = mutation(paths.runnerPath, runnerCurrent, undefined, undefined, true, "ownership-mismatch");
        runnerRemoved = true;
        runnerAction = "removed";
      }
    } else if (runnerCurrent.exists) {
      warnings.push("The installed runner changed after installation and was preserved.");
      runnerAction = "preserved-modified";
    } else {
      warnings.push("The installed runner is missing; no runner file was removed.");
      runnerAction = "already-missing";
    }
    const mutations: PreparedMutation[] = [
      settingsMutation,
      mutation(paths.receiptPath, receiptRead.snapshot, undefined, undefined, true, "invalid-receipt")
    ];
    if (runnerMutation) mutations.push(runnerMutation);

    await applyMutations(mutations, options, [], [installerLock.assertOwned]);
    await removeOwnedFile(receipt.backupPath, receipt.settingsBackupDigest).catch(() => undefined);
    if (receipt.priorRunnerExisted && receipt.runnerBackupPath && receipt.priorRunnerDigest) {
      await removeOwnedFile(receipt.runnerBackupPath, receipt.priorRunnerDigest).catch(() => undefined);
    }

    return {
      action: "uninstalled",
      settingsPath: paths.settingsPath,
      runnerPath: paths.runnerPath,
      runnerRemoved,
      runnerAction,
      statusLineAction: receipt.priorHadStatusLine ? "restored-prior" : "removed",
      warnings
    };
  } finally {
    await installerLock.release();
  }
}

async function assertNoEffectiveConflict(
  paths: StatuslinePaths,
  userSettings: JsonObject,
  homeDir: string,
  cwd: string,
  platform: StatuslinePlatform,
  explicitManagedPaths?: string[]
): Promise<void> {
  const managedPaths = explicitManagedPaths ?? await discoverManagedSettingsFiles(paths, platform);
  const managedSettings = await readSettingsLayers(managedPaths);
  const projectPaths = await discoverProjectSettingsFiles(paths, homeDir, cwd, platform);
  const projectSettings = await readSettingsLayers(projectPaths.project);
  const localSettings = await readSettingsLayers(projectPaths.local);

  const shadow = firstStatusLineScope([
    ["locally visible managed", managedSettings],
    ["local", localSettings],
    ["project", projectSettings]
  ]);
  if (shadow) {
    throw new StatuslineInstallerError(
      "settings-shadowed",
      `Claude ${shadow} settings define statusLine and would shadow the user-scope aibill installation.`
    );
  }

  const effectiveDisableAllHooks = firstDefinedBoolean([
    ...managedSettings.slice().reverse(),
    ...localSettings,
    ...projectSettings,
    userSettings
  ], "disableAllHooks");
  if (effectiveDisableAllHooks === true) {
    throw new StatuslineInstallerError("hooks-disabled", "Claude's effective disableAllHooks setting is true, so a status line cannot run.");
  }
}

async function discoverProjectSettingsFiles(
  paths: StatuslinePaths,
  homeDir: string,
  cwd: string,
  platform: StatuslinePlatform
): Promise<{ project: string[]; local: string[] }> {
  const path = pathFor(platform);
  const project: string[] = [];
  const local: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], candidate: string) => {
    const key = normalizedPathKey(candidate, platform);
    if (key === normalizedPathKey(paths.settingsPath, platform) || seen.has(key)) return;
    seen.add(key);
    list.push(candidate);
  };

  add(local, paths.localSettingsPath);
  add(project, paths.projectSettingsPath);
  const resolvedHome = path.resolve(homeDir);
  let current = path.resolve(cwd);
  while (true) {
    if (normalizedPathKey(current, platform) === normalizedPathKey(resolvedHome, platform)) break;
    add(local, path.join(current, ".claude", "settings.local.json"));
    add(project, path.join(current, ".claude", "settings.json"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { project, local };
}

async function discoverManagedSettingsFiles(paths: StatuslinePaths, platform: StatuslinePlatform): Promise<string[]> {
  const files: string[] = [];
  if (await fileExists(paths.managedSettingsPath)) files.push(paths.managedSettingsPath);
  try {
    const entries = await readdir(paths.managedDropInDirectory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      files.push(pathFor(platform).join(paths.managedDropInDirectory, entry.name));
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return files;
}

async function readSettingsLayers(paths: string[]): Promise<JsonObject[]> {
  const layers: JsonObject[] = [];
  for (const path of paths) {
    const read = await readOptionalSettings(path);
    if (read) layers.push(read);
  }
  return layers;
}

async function readOptionalSettings(path: string): Promise<JsonObject | undefined> {
  if (!await fileExists(path)) return undefined;
  return (await readSettings(path)).value;
}

function firstStatusLineScope(layers: Array<[string, JsonObject[]]>): string | undefined {
  for (const [scope, settings] of layers) {
    if (settings.some((value) => value.statusLine !== undefined)) return scope;
  }
  return undefined;
}

function firstDefinedBoolean(settings: JsonObject[], key: string): boolean | undefined {
  for (const value of settings) {
    if (typeof value[key] === "boolean") return value[key] as boolean;
  }
  return undefined;
}

async function readSettings(path: string): Promise<SettingsRead> {
  const snapshot = await readFileSnapshot(path, MAX_SETTINGS_BYTES, "unsafe-settings-file", true);
  if (!snapshot.exists) return { ...snapshot, raw: "", value: {} };
  const raw = decodeUtf8Strict(snapshot.bytes, "invalid-settings-json", "Claude settings are not valid UTF-8; no changes were made.");
  const parsed = parseJson(raw, "invalid-settings-json", "Claude settings are not strict finite JSON; no changes were made.");
  if (!isJsonObject(parsed)) {
    throw new StatuslineInstallerError("invalid-settings-json", "Claude settings must contain one JSON object; no changes were made.");
  }
  return { ...snapshot, raw, value: parsed };
}

async function readFileSnapshot(
  path: string,
  maxBytes: number,
  code: StatuslineInstallerErrorCode,
  allowMissing: boolean
): Promise<FileSnapshot> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (allowMissing && isMissing(error)) return missingSnapshot();
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new StatuslineInstallerError(code, "Refusing a non-regular or symbolic-link file.");
  }
  if (before.size > maxBytes) {
    throw new StatuslineInstallerError(code, "A file exceeds the installer's safe size limit.");
  }

  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.dev !== before.dev || openedBefore.ino !== before.ino) {
      throw new StatuslineInstallerError(code, "A file changed identity while it was being read.");
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) {
      throw new StatuslineInstallerError(code, "A file exceeds the installer's safe size limit.");
    }
    const bytes = buffer.subarray(0, offset);
    const openedAfter = await handle.stat();
    const after = await lstat(path);
    if (bytes.byteLength > maxBytes
      || openedAfter.dev !== openedBefore.dev
      || openedAfter.ino !== openedBefore.ino
      || openedAfter.mode !== openedBefore.mode
      || openedAfter.size !== bytes.byteLength
      || after.dev !== openedBefore.dev
      || after.ino !== openedBefore.ino
      || after.mode !== openedBefore.mode) {
      throw new StatuslineInstallerError(code, "A file changed while it was being read.");
    }
    return {
      exists: true,
      bytes,
      mode: openedAfter.mode & 0o777,
      dev: openedAfter.dev,
      ino: openedAfter.ino
    };
  } finally {
    await handle.close();
  }
}

async function readSafeRunnerSource(path: string): Promise<Uint8Array> {
  try {
    const snapshot = await readFileSnapshot(path, MAX_RUNNER_BYTES, "unsafe-runner-source", false);
    if (snapshot.bytes.byteLength === 0) {
      throw new StatuslineInstallerError("unsafe-runner-source", "The statusline runner source is empty.");
    }
    return snapshot.bytes;
  } catch (error) {
    if (error instanceof StatuslineInstallerError) throw error;
    throw new StatuslineInstallerError("unsafe-runner-source", "The statusline runner source could not be read safely.");
  }
}

async function resolveRunnerSource(options: InstallStatuslineOptions): Promise<Uint8Array> {
  if (options.runnerContents !== undefined && options.runnerSourcePath !== undefined) {
    throw new StatuslineInstallerError("unsafe-runner-source", "Provide either statusline runner bytes or a runner source path, not both.");
  }
  if (options.runnerContents !== undefined) {
    const bytes = typeof options.runnerContents === "string"
      ? Buffer.from(options.runnerContents, "utf8")
      : Uint8Array.from(options.runnerContents);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUNNER_BYTES) {
      throw new StatuslineInstallerError("unsafe-runner-source", "The statusline runner is empty or exceeds its safe size limit.");
    }
    return bytes;
  }
  if (options.runnerSourcePath !== undefined) return readSafeRunnerSource(options.runnerSourcePath);
  throw new StatuslineInstallerError("unsafe-runner-source", "No standalone statusline runner was provided.");
}

async function readReceiptIfPresent(
  paths: StatuslinePaths,
  platform: StatuslinePlatform
): Promise<ReceiptRead | undefined> {
  try {
    const snapshot = await readFileSnapshot(paths.receiptPath, MAX_RECEIPT_BYTES, "invalid-receipt", true);
    if (!snapshot.exists) return undefined;
    const raw = decodeUtf8Strict(snapshot.bytes, "invalid-receipt", "The aibill ownership receipt is not valid UTF-8.");
    return { receipt: parseReceipt(raw, paths, platform), snapshot };
  } catch (error) {
    if (error instanceof StatuslineInstallerError) throw error;
    throw new StatuslineInstallerError("invalid-receipt", "The aibill statusline ownership receipt could not be read safely.");
  }
}

async function readRequiredReceipt(paths: StatuslinePaths, platform: StatuslinePlatform): Promise<ReceiptRead> {
  const receipt = await readReceiptIfPresent(paths, platform);
  if (!receipt) {
    throw new StatuslineInstallerError("missing-ownership", "No aibill statusline ownership receipt exists; refusing to uninstall.");
  }
  return receipt;
}

function parseReceipt(raw: string, paths: StatuslinePaths, platform: StatuslinePlatform): StatuslineInstallReceipt {
  const value = parseJson(raw, "invalid-receipt", "The aibill statusline ownership receipt is malformed.");
  if (!isJsonObject(value)) throw invalidReceiptShape();

  const required = [
    "kind", "version", "installedAt", "receiptPath", "settingsPath", "runnerPath", "backupPath",
    "settingsBackupDigest", "priorFileExisted", "priorHadStatusLine", "priorRunnerExisted",
    "installedStatusLine", "installedStatusLineDigest", "installedRunnerDigest"
  ];
  const optional: string[] = [];
  if (value.priorHadStatusLine === true) optional.push("priorStatusLine");
  if (value.priorRunnerExisted === true) optional.push("runnerBackupPath", "priorRunnerDigest", "priorRunnerMode");
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidReceiptShape();
  }

  if (value.kind !== RECEIPT_KIND
    || value.version !== RECEIPT_VERSION
    || !isIsoTimestamp(value.installedAt)
    || typeof value.receiptPath !== "string"
    || typeof value.settingsPath !== "string"
    || typeof value.runnerPath !== "string"
    || typeof value.backupPath !== "string"
    || !isDigest(value.settingsBackupDigest)
    || typeof value.priorFileExisted !== "boolean"
    || typeof value.priorHadStatusLine !== "boolean"
    || typeof value.priorRunnerExisted !== "boolean"
    || !isAibillStatusLineSetting(value.installedStatusLine)
    || !isDigest(value.installedStatusLineDigest)
    || !isDigest(value.installedRunnerDigest)) {
    throw invalidReceiptShape();
  }
  if (value.priorHadStatusLine !== ("priorStatusLine" in value)
    || (!value.priorFileExisted && value.priorHadStatusLine)) {
    throw new StatuslineInstallerError("invalid-receipt", "The ownership receipt has incoherent prior-settings flags.");
  }
  if (value.priorRunnerExisted) {
    if (typeof value.runnerBackupPath !== "string"
      || !isDigest(value.priorRunnerDigest)
      || !Number.isInteger(value.priorRunnerMode)
      || (value.priorRunnerMode as number) < 0
      || (value.priorRunnerMode as number) > 0o777) {
      throw new StatuslineInstallerError("invalid-receipt", "The ownership receipt has incoherent prior-runner fields.");
    }
  }
  if (!samePath(value.receiptPath, paths.receiptPath, platform)
    || !samePath(value.settingsPath, paths.settingsPath, platform)
    || !samePath(value.runnerPath, paths.runnerPath, platform)
    || !isConfinedPath(value.backupPath, paths.backupDirectory, platform)
    || (value.priorRunnerExisted && !isConfinedPath(value.runnerBackupPath as string, paths.backupDirectory, platform))) {
    throw new StatuslineInstallerError("invalid-receipt", "The ownership receipt contains unexpected or unconfined paths.");
  }
  const desired = buildAibillStatusLineSetting(platform);
  if (digestJson(value.installedStatusLine) !== value.installedStatusLineDigest
    || digestJson(desired) !== value.installedStatusLineDigest
    || canonicalJson(value.installedStatusLine) !== canonicalJson(desired)) {
    throw new StatuslineInstallerError("invalid-receipt", "The ownership receipt failed its command or digest check.");
  }
  return value as StatuslineInstallReceipt;
}

async function verifyReceiptBackups(
  receipt: StatuslineInstallReceipt,
  paths: StatuslinePaths,
  platform: StatuslinePlatform
): Promise<{ settings: FileSnapshot; runner?: FileSnapshot }> {
  await assertSafeDirectory(paths.backupDirectory, "invalid-receipt", false);
  if (!isConfinedPath(receipt.backupPath, paths.backupDirectory, platform)) throw invalidReceiptShape();
  const settings = await readRequiredBackup(receipt.backupPath, MAX_SETTINGS_BYTES);
  if (digestBytes(settings.bytes) !== receipt.settingsBackupDigest) {
    throw new StatuslineInstallerError("invalid-receipt", "The exact settings backup failed its digest check.");
  }
  const path = pathFor(platform);
  const installedAt = new Date(receipt.installedAt);
  if (!samePath(receipt.backupPath, backupFilePath(paths.backupDirectory, settings.bytes, installedAt, path), platform)) {
    throw new StatuslineInstallerError("invalid-receipt", "The settings backup path does not match its timestamp and digest.");
  }
  if (!receipt.priorFileExisted) {
    if (settings.bytes.byteLength !== 0 || receipt.priorHadStatusLine) {
      throw new StatuslineInstallerError("invalid-receipt", "The settings backup conflicts with the prior-file flags.");
    }
  } else {
    const raw = decodeUtf8Strict(settings.bytes, "invalid-receipt", "The exact settings backup is not valid UTF-8.");
    const prior = parseJson(raw, "invalid-receipt", "The exact settings backup is not strict finite JSON.");
    if (!isJsonObject(prior)
      || (prior.statusLine !== undefined) !== receipt.priorHadStatusLine
      || (receipt.priorHadStatusLine && canonicalJson(prior.statusLine) !== canonicalJson(receipt.priorStatusLine))) {
      throw new StatuslineInstallerError("invalid-receipt", "The exact settings backup conflicts with the receipt's prior statusLine.");
    }
  }
  if (!receipt.priorRunnerExisted) return { settings };
  const runner = await readRequiredBackup(receipt.runnerBackupPath as string, MAX_RUNNER_BYTES);
  if (digestBytes(runner.bytes) !== receipt.priorRunnerDigest) {
    throw new StatuslineInstallerError("invalid-receipt", "The exact runner backup failed its digest check.");
  }
  if (!samePath(
    receipt.runnerBackupPath as string,
    runnerBackupFilePath(paths.backupDirectory, runner.bytes, installedAt, path),
    platform
  )) {
    throw new StatuslineInstallerError("invalid-receipt", "The runner backup path does not match its timestamp and digest.");
  }
  return { settings, runner };
}

async function readRequiredBackup(path: string, maxBytes: number): Promise<FileSnapshot> {
  try {
    return await readFileSnapshot(path, maxBytes, "invalid-receipt", false);
  } catch (error) {
    if (error instanceof StatuslineInstallerError) throw error;
    throw new StatuslineInstallerError("invalid-receipt", "A required exact installer backup is missing or unreadable.");
  }
}

function isAibillStatusLineSetting(value: unknown): value is AibillStatusLineSetting {
  return isJsonObject(value)
    && Object.keys(value).length === 3
    && value.type === "command"
    && value.command === "node ~/.aibill/bin/statusline.mjs"
    && value.refreshInterval === aibillStatuslineRefreshIntervalSeconds;
}

function mutation(
  path: string,
  before: FileSnapshot,
  after: Uint8Array | undefined,
  mode: number | undefined,
  privateParent: boolean,
  mismatchCode: StatuslineInstallerErrorCode
): PreparedMutation {
  return { path, before, after, mode, privateParent, mismatchCode, committed: false };
}

async function applyMutations(
  mutations: PreparedMutation[],
  hooks: InstallerTestHooks,
  guards: Array<{ path: string; before: FileSnapshot; code: StatuslineInstallerErrorCode }> = [],
  preCommitChecks: Array<() => Promise<void>> = []
): Promise<void> {
  try {
    for (const item of mutations) {
      if (item.after !== undefined) {
        item.temporaryPath = await prepareReplacement(item.path, item.after, item.mode ?? 0o600, item.privateParent);
      } else {
        await assertSafeDirectory(dirname(item.path), item.mismatchCode, true);
      }
    }
    await hooks.afterPrepare?.();
    await hooks.beforeSettingsCommit?.();
    for (const check of preCommitChecks) await check();
    for (const guard of guards) await assertSnapshotCurrent(guard.path, guard.before, guard.code);

    for (const [index, item] of mutations.entries()) {
      await assertSnapshotCurrent(item.path, item.before, item.mismatchCode);
      if (item.after === undefined) {
        await unlink(item.path);
      } else {
        if (!item.temporaryPath) throw new Error("prepared replacement is missing");
        await assertPreparedReplacement(item.temporaryPath, item.after, item.mode ?? 0o600, item.mismatchCode);
        await rename(item.temporaryPath, item.path);
        item.temporaryPath = undefined;
      }
      item.committed = true;
      await assertCommittedMutation(item);
      await hooks.afterMutationCommit?.(item.path, index);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const item of mutations.slice().reverse()) {
      if (!item.committed) continue;
      try {
        await rollbackMutation(item);
      } catch {
        rollbackFailed = true;
        break;
      }
    }
    if (rollbackFailed) {
      throw new IncompleteStatuslineTransactionError();
    }
    throw error;
  } finally {
    for (const item of mutations) {
      if (item.temporaryPath) await rm(item.temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function prepareReplacement(path: string, bytes: Uint8Array, mode: number, privateParent: boolean): Promise<string> {
  if (privateParent) await ensurePrivateDirectory(dirname(path));
  else await ensureSettingsDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertPreparedReplacement(temporaryPath, bytes, mode, "concurrent-edit");
    return temporaryPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertPreparedReplacement(
  path: string,
  bytes: Uint8Array,
  mode: number,
  code: StatuslineInstallerErrorCode
): Promise<void> {
  const snapshot = await readFileSnapshot(path, Math.max(bytes.byteLength, 1), code, false);
  if (!bytesEqual(snapshot.bytes, bytes) || (process.platform !== "win32" && snapshot.mode !== mode)) {
    throw new StatuslineInstallerError(code, "A prepared installer file failed its byte or mode check.");
  }
}

async function assertCommittedMutation(item: PreparedMutation): Promise<void> {
  const snapshot = await readFileSnapshot(
    item.path,
    Math.max(item.after?.byteLength ?? 1, 1),
    item.mismatchCode,
    item.after === undefined
  );
  if (item.after === undefined) {
    if (snapshot.exists) throw new StatuslineInstallerError(item.mismatchCode, "A deletion did not commit safely.");
    return;
  }
  if (!snapshot.exists
    || !bytesEqual(snapshot.bytes, item.after)
    || (process.platform !== "win32" && snapshot.mode !== (item.mode ?? 0o600))) {
    throw new StatuslineInstallerError(item.mismatchCode, "A replacement did not commit safely.");
  }
}

async function rollbackMutation(item: PreparedMutation): Promise<void> {
  const current = await readFileSnapshot(
    item.path,
    Math.max(item.after?.byteLength ?? item.before.bytes.byteLength, 1),
    item.mismatchCode,
    true
  );
  const stillOurs = item.after === undefined
    ? !current.exists
    : current.exists
      && bytesEqual(current.bytes, item.after)
      && (process.platform === "win32" || current.mode === (item.mode ?? 0o600));
  if (!stillOurs) {
    throw new StatuslineInstallerError(item.mismatchCode, "A committed installer file changed before rollback could restore it.");
  }
  if (!item.before.exists) {
    if (current.exists) await unlink(item.path);
    return;
  }
  const temporaryPath = await prepareReplacement(item.path, item.before.bytes, item.before.mode ?? 0o600, item.privateParent);
  try {
    await assertSnapshotCurrent(item.path, current, item.mismatchCode);
    await rename(temporaryPath, item.path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertSnapshotCurrent(path: string, before: FileSnapshot, code: StatuslineInstallerErrorCode): Promise<void> {
  const after = await readFileSnapshot(path, Math.max(before.bytes.byteLength, 1), code, true);
  const same = after.exists === before.exists
    && (!before.exists || (
      after.dev === before.dev
      && after.ino === before.ino
      && after.mode === before.mode
      && bytesEqual(after.bytes, before.bytes)
    ));
  if (!same) {
    throw new StatuslineInstallerError(code, "A destination changed after preparation; refusing to overwrite the newer file.");
  }
}

async function createExactBackup(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = await prepareReplacement(path, bytes, 0o600, true);
  let linked = false;
  try {
    await link(temporaryPath, path);
    linked = true;
    const backup = await readFileSnapshot(path, Math.max(bytes.byteLength, 1), "concurrent-edit", false);
    if (!bytesEqual(backup.bytes, bytes) || (process.platform !== "win32" && backup.mode !== 0o600)) {
      throw new StatuslineInstallerError("concurrent-edit", "An exact installer backup failed verification.");
    }
  } catch (error) {
    if (linked) await rm(path, { force: true }).catch(() => undefined);
    if (hasCode(error, "EEXIST")) {
      throw new StatuslineInstallerError("concurrent-edit", "The exact installer backup path already exists; refusing to overwrite it.");
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function removeOwnedFile(path: string, expectedDigest: string): Promise<void> {
  const snapshot = await readFileSnapshot(path, Math.max(MAX_SETTINGS_BYTES, MAX_RUNNER_BYTES), "invalid-receipt", true);
  if (snapshot.exists && digestBytes(snapshot.bytes) === expectedDigest) await unlink(path);
}

async function acquireInstallerLock(path: string, now: Date): Promise<InstallerLock> {
  const record: LockRecord = {
    version: 1,
    pid: process.pid,
    createdAt: validIso(now),
    token: randomBytes(24).toString("hex")
  };
  const bytes = serializeBoundedJson(record, MAX_LOCK_BYTES, "installer-busy", "installer lock");
  let recovered = false;

  while (true) {
    let handle;
    let createdIdentity: { dev: number; ino: number } | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      const opened = await handle.stat();
      createdIdentity = { dev: opened.dev, ino: opened.ino };
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
      const info = await handle.stat();
      await handle.close();
      handle = undefined;
      const owned = await readFileSnapshot(path, MAX_LOCK_BYTES, "installer-busy", false);
      if (owned.dev !== info.dev || owned.ino !== info.ino || !bytesEqual(owned.bytes, bytes)) {
        throw installerBusy();
      }
      const assertOwned = async () => {
        const current = await readFileSnapshot(path, MAX_LOCK_BYTES, "installer-busy", true).catch(() => missingSnapshot());
        if (!current.exists
          || current.dev !== owned.dev
          || current.ino !== owned.ino
          || !bytesEqual(current.bytes, bytes)) throw installerBusy();
      };
      return {
        assertOwned,
        release: async () => {
          try {
            await assertOwned();
          } catch {
            return;
          }
          await unlink(path).catch((error) => {
            if (!isMissing(error)) throw error;
          });
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdIdentity) {
        const current = await readFileSnapshot(path, MAX_LOCK_BYTES, "installer-busy", true).catch(() => missingSnapshot());
        if (current.exists && current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) {
          await unlink(path).catch(() => undefined);
        }
      }
      if (!hasCode(error, "EEXIST") || recovered) {
        if (hasCode(error, "EEXIST")) throw installerBusy();
        throw error;
      }
      if (!await recoverStaleLock(path, now)) throw installerBusy();
      recovered = true;
    }
  }
}

async function recoverStaleLock(path: string, now: Date): Promise<boolean> {
  let snapshot: FileSnapshot;
  try {
    snapshot = await readFileSnapshot(path, MAX_LOCK_BYTES, "installer-busy", false);
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = parseJson(
      decodeUtf8Strict(snapshot.bytes, "installer-busy", "The installer lock is not valid UTF-8."),
      "installer-busy",
      "The installer lock is malformed."
    );
  } catch {
    return false;
  }
  if (!isJsonObject(parsed)
    || Object.keys(parsed).sort().join(",") !== "createdAt,pid,token,version"
    || parsed.version !== 1
    || !Number.isSafeInteger(parsed.pid)
    || (parsed.pid as number) <= 0
    || !isIsoTimestamp(parsed.createdAt)
    || typeof parsed.token !== "string"
    || !/^[a-f0-9]{48}$/.test(parsed.token)) return false;
  const age = now.getTime() - Date.parse(parsed.createdAt as string);
  if (!Number.isFinite(age) || age < LOCK_STALE_AFTER_MS || isProcessAlive(parsed.pid as number)) return false;
  try {
    await assertSnapshotCurrent(path, snapshot, "installer-busy");
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new StatuslineInstallerError("unsafe-settings-file", "The private aibill state path is not a regular directory.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new StatuslineInstallerError("unsafe-settings-file", "The private aibill state path could not be created safely.");
    }
  }
  await chmod(path, 0o700);
}

async function ensureSettingsDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new StatuslineInstallerError("unsafe-settings-file", "Claude's settings parent is not a regular directory.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new StatuslineInstallerError("unsafe-settings-file", "Claude's settings parent could not be created safely.");
    }
  }
}

async function assertSafeDirectory(
  path: string,
  code: StatuslineInstallerErrorCode,
  allowMissing: boolean
): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new StatuslineInstallerError(code, "A parent directory is not a regular directory.");
    }
  } catch (error) {
    if (allowMissing && isMissing(error)) return;
    throw error;
  }
}

function backupFilePath(directory: string, bytes: Uint8Array, now: Date, path: PlatformPath): string {
  const timestamp = validIso(now).replace(/[:.]/g, "-");
  const suffix = digestBytes(bytes).slice(0, 12);
  return path.join(directory, `claude-settings-${timestamp}-${suffix}.json`);
}

function runnerBackupFilePath(directory: string, bytes: Uint8Array, now: Date, path: PlatformPath): string {
  const timestamp = validIso(now).replace(/[:.]/g, "-");
  const suffix = digestBytes(bytes).slice(0, 12);
  return path.join(directory, `statusline-runner-${timestamp}-${suffix}.mjs`);
}

function serializeBoundedJson(
  value: unknown,
  maxBytes: number,
  code: StatuslineInstallerErrorCode,
  label: string
): Uint8Array {
  validateJsonTree(value, code, `${label} is not finite JSON.`);
  let raw: string;
  try {
    raw = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new StatuslineInstallerError(code, `${label} could not be serialized safely.`);
  }
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new StatuslineInstallerError(code, `${label} exceeds the installer's safe serialized size limit.`);
  }
  return bytes;
}

function parseJson(raw: string, code: StatuslineInstallerErrorCode, message: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StatuslineInstallerError(code, message);
  }
  validateJsonTree(parsed, code, message);
  return parsed;
}

function validateJsonTree(value: unknown, code: StatuslineInstallerErrorCode, message: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) throw new StatuslineInstallerError(code, message);
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new StatuslineInstallerError(code, message);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (isJsonObject(current.value)) {
      for (const item of Object.values(current.value)) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    throw new StatuslineInstallerError(code, message);
  }
}

function decodeUtf8Strict(bytes: Uint8Array, code: StatuslineInstallerErrorCode, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StatuslineInstallerError(code, message);
  }
}

function cloneJson<T>(value: T): T {
  validateJsonTree(value, "invalid-settings-json", "A JSON value is not finite.");
  return JSON.parse(JSON.stringify(value)) as T;
}

function digestJson(value: unknown): string {
  validateJsonTree(value, "invalid-settings-json", "A JSON value is not finite.");
  return digestBytes(Buffer.from(canonicalJson(value)));
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathFor(platform: StatuslinePlatform): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

function normalizePlatform(platform: NodeJS.Platform): StatuslinePlatform {
  return platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
}

function normalizedPathKey(value: string, platform: StatuslinePlatform): string {
  const resolved = pathFor(platform).resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string, platform: StatuslinePlatform): boolean {
  return normalizedPathKey(left, platform) === normalizedPathKey(right, platform);
}

function isConfinedPath(candidate: string, directory: string, platform: StatuslinePlatform): boolean {
  const path = pathFor(platform);
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new StatuslineInstallerError("invalid-receipt", "The installation time is invalid.");
  return value.toISOString();
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function missingSnapshot(): FileSnapshot {
  return { exists: false, bytes: new Uint8Array() };
}

function invalidReceiptShape(): StatuslineInstallerError {
  return new StatuslineInstallerError("invalid-receipt", "The aibill statusline ownership receipt has an unsupported shape.");
}

function installerBusy(): StatuslineInstallerError {
  return new StatuslineInstallerError("installer-busy", "Another aibill statusline settings operation is already in progress.");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
