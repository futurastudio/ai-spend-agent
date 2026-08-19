import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { join } from "node:path";
import {
  createActionVerificationReference,
  parseTokenReductionExperimentV0,
  readSafeStateText,
  resolveSafeScanRoot,
  resolveSafeStateDirectory,
  selectPreferredTokenReductionExperimentV0,
  writeSafeStateText,
  type TokenReductionExperimentV0
} from "@agent-finops/core";

export const TOKEN_VERIFICATION_STATE_FILE = "token-reduction-experiments.json";
export const TOKEN_VERIFICATION_STATE_KIND =
  "aibill.token_reduction_experiment_store" as const;
export const TOKEN_VERIFICATION_STATE_VERSION = 1 as const;
export const MAX_TOKEN_REDUCTION_EXPERIMENTS = 100;
export const MAX_TOKEN_VERIFICATION_STATE_BYTES = 1_000_000;

const TOKEN_VERIFICATION_LOCK_FILE = ".token-reduction-experiments.lock";
const TOKEN_VERIFICATION_LOCK_MAX_BYTES = 512;
const TOKEN_VERIFICATION_LOCK_STALE_MS = 15_000;
// Releases before this action loop used an ownerless empty directory as the
// lock. It cannot prove abandonment, so recover it only after a deliberately
// conservative delay. New locks carry a PID and recover much sooner when that
// exact owner is gone.
const LEGACY_TOKEN_VERIFICATION_LOCK_STALE_MS = 5 * 60_000;

type TokenVerificationLockOwner = {
  version: 1;
  pid: number;
  createdAt: string;
  token: string;
};

type TokenVerificationLockIdentity = TokenVerificationLockOwner & {
  dev: number;
  ino: number;
};

export type TokenVerificationStateV1 = {
  kind: typeof TOKEN_VERIFICATION_STATE_KIND;
  schemaVersion: typeof TOKEN_VERIFICATION_STATE_VERSION;
  rootRef: string;
  experiments: TokenReductionExperimentV0[];
};

export class TokenVerificationStateError extends Error {
  readonly code:
    | "invalid_experiment"
    | "malformed_state"
    | "duplicate_experiment_id"
    | "experiment_limit_exceeded"
    | "state_busy"
    | "stale_revision"
    | "lifecycle_regression"
    | "immutable_evidence_changed"
    | "active_scope_conflict";

  constructor(code: TokenVerificationStateError["code"], message: string) {
    super(message);
    this.name = "TokenVerificationStateError";
    this.code = code;
  }
}

/** Read and fully revalidate the local experiment envelope. Missing state is empty. */
export async function loadTokenVerificationState(
  rootPath: string
): Promise<TokenVerificationStateV1> {
  const rootRef = await tokenVerificationStateRootRef(rootPath);
  const actionProjectRef = await tokenVerificationActionProjectRef(rootPath);
  let stateDir: string;
  try {
    stateDir = await resolveSafeStateDirectory(rootPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState(rootRef);
    throw error;
  }
  return readStateDirectory(stateDir, rootRef, actionProjectRef);
}

/** Bind private experiment state to one canonical local project root. */
export async function tokenVerificationStateRootRef(rootPath: string): Promise<string> {
  return createActionVerificationReference(
    "token-experiment-state-root",
    await resolveSafeScanRoot(rootPath)
  );
}

/** Exact action-project identity for the canonical state root. */
export async function tokenVerificationActionProjectRef(rootPath: string): Promise<string> {
  return createActionVerificationReference(
    "project-working-directory",
    await resolveSafeScanRoot(rootPath)
  );
}

/**
 * Validate and atomically upsert one stable experiment lineage by exact ID.
 * Each mutable lifecycle body carries its own separately validated revision ID.
 * A new ID never evicts older evidence when the bounded store is full.
 */
export async function upsertTokenReductionExperiment(
  rootPath: string,
  value: unknown,
  options: { expectedRevisionId?: string } = {}
): Promise<TokenVerificationStateV1> {
  const experiment = parseExperiment(value);
  const rootRef = await tokenVerificationStateRootRef(rootPath);
  const actionProjectRef = await tokenVerificationActionProjectRef(rootPath);
  if (experiment.cohort.projectRef !== actionProjectRef ||
      experiment.finding.scope.projectRef !== actionProjectRef) {
    throw new TokenVerificationStateError(
      "invalid_experiment",
      "The token-reduction experiment belongs to a different project root."
    );
  }
  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
  const release = await acquireStateLock(stateDir);
  try {
    const current = await readStateDirectory(stateDir, rootRef, actionProjectRef);
    const existingIndex = current.experiments.findIndex((item) => item.id === experiment.id);
    const experiments = current.experiments.slice();

    if (existingIndex >= 0) {
      const existing = experiments[existingIndex]!;
      validateExperimentAdvance(existing, experiment, options.expectedRevisionId);
      experiments[existingIndex] = experiment;
    } else {
      const conflict = experiments.find((item) => sameActiveScope(item, experiment));
      if (conflict) {
        throw new TokenVerificationStateError(
          "active_scope_conflict",
          "One active token test already owns this project/provider/agent scope."
        );
      }
      if (experiments.length >= MAX_TOKEN_REDUCTION_EXPERIMENTS) {
        throw new TokenVerificationStateError(
          "experiment_limit_exceeded",
          `Token-reduction experiment state is limited to ${MAX_TOKEN_REDUCTION_EXPERIMENTS} entries.`
        );
      }
      experiments.push(experiment);
    }

    const next: TokenVerificationStateV1 = {
      kind: TOKEN_VERIFICATION_STATE_KIND,
      schemaVersion: TOKEN_VERIFICATION_STATE_VERSION,
      rootRef,
      experiments
    };
    await writeSafeStateText(
      stateDir,
      TOKEN_VERIFICATION_STATE_FILE,
      `${JSON.stringify(next, null, 2)}\n`
    );
    return next;
  } finally {
    await release();
  }
}

/** Select newest creation time, with the content-addressed ID as a stable tie-breaker. */
export function chooseLatestTokenReductionExperiment(
  experiments: readonly TokenReductionExperimentV0[]
): TokenReductionExperimentV0 | undefined {
  return selectPreferredTokenReductionExperimentV0(experiments);
}

async function acquireStateLock(stateDir: string): Promise<() => Promise<void>> {
  const lockPath = join(stateDir, TOKEN_VERIFICATION_LOCK_FILE);
  const owner: TokenVerificationLockOwner = {
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomBytes(24).toString("hex")
  };
  const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  let recovered = false;

  while (true) {
    let handle: FileHandle | undefined;
    let createdIdentity: { dev: number; ino: number } | undefined;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        0o600
      );
      const info = await handle.stat();
      if (!info.isFile()) throw stateBusy();
      createdIdentity = { dev: info.dev, ino: info.ino };
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      const identity: TokenVerificationLockIdentity = {
        ...owner,
        dev: info.dev,
        ino: info.ino
      };
      if (!await lockStillOwned(lockPath, identity)) throw stateBusy();
      return async () => {
        await releaseOwnedStateLock(lockPath, identity);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (createdIdentity) {
        await unlinkIfSameRegularFile(lockPath, createdIdentity).catch(() => undefined);
      }
      const collision = isNodeError(error, "EEXIST") || isNodeError(error, "EISDIR");
      if (!collision || recovered) {
        if (collision ||
            isNodeError(error, "ELOOP") ||
            error instanceof TokenVerificationStateError) {
          throw stateBusy();
        }
        throw error;
      }
      if (!await recoverAbandonedStateLock(lockPath)) throw stateBusy();
      recovered = true;
    }
  }
}

async function recoverAbandonedStateLock(lockPath: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    return isNodeError(error, "ENOENT");
  }
  if (info.isSymbolicLink()) return false;

  if (info.isDirectory()) {
    // Compatibility with the former ownerless mkdir lock. `rmdir` succeeds
    // only if it is still the same empty directory at removal time.
    if (Date.now() - info.mtimeMs < LEGACY_TOKEN_VERIFICATION_LOCK_STALE_MS) return false;
    const entries = await readdir(lockPath).catch(() => undefined);
    if (!entries || entries.length !== 0) return false;
    const confirmed = await lstat(lockPath).catch(() => undefined);
    if (!confirmed || !confirmed.isDirectory() || confirmed.isSymbolicLink() ||
        confirmed.dev !== info.dev || confirmed.ino !== info.ino) return false;
    try {
      await rmdir(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  if (!info.isFile() || (info.mode & 0o077) !== 0 ||
      Date.now() - info.mtimeMs < TOKEN_VERIFICATION_LOCK_STALE_MS) return false;
  const snapshot = await readStateLock(lockPath);
  if (!snapshot || snapshot.dev !== info.dev || snapshot.ino !== info.ino) return false;
  const owner = parseStateLockOwner(snapshot.bytes);
  if (!owner) {
    // A SIGKILL can land between O_EXCL creation and writing the owner record.
    // Such an unowned/malformed private file gets the same conservative grace
    // period as the legacy directory lock, never immediate eviction.
    if (Date.now() - info.mtimeMs < LEGACY_TOKEN_VERIFICATION_LOCK_STALE_MS) return false;
    return unlinkIfSameRegularFile(lockPath, snapshot);
  }
  const createdAge = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(createdAge) || createdAge < TOKEN_VERIFICATION_LOCK_STALE_MS ||
      processIsAlive(owner.pid)) return false;
  return unlinkIfSameRegularFile(lockPath, snapshot);
}

async function releaseOwnedStateLock(
  lockPath: string,
  identity: TokenVerificationLockIdentity
): Promise<void> {
  if (!await lockStillOwned(lockPath, identity)) return;
  await unlinkIfSameRegularFile(lockPath, identity).catch(() => undefined);
}

async function lockStillOwned(
  lockPath: string,
  identity: TokenVerificationLockIdentity
): Promise<boolean> {
  const snapshot = await readStateLock(lockPath);
  if (!snapshot || snapshot.dev !== identity.dev || snapshot.ino !== identity.ino) return false;
  const owner = parseStateLockOwner(snapshot.bytes);
  return owner?.version === identity.version &&
    owner.pid === identity.pid &&
    owner.createdAt === identity.createdAt &&
    owner.token === identity.token;
}

async function readStateLock(
  lockPath: string
): Promise<{ dev: number; ino: number; bytes: Buffer } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) return undefined;
    const buffer = Buffer.alloc(TOKEN_VERIFICATION_LOCK_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // Preserve the inode snapshot even when the owner write was interrupted or
    // oversized. Parsing will fail, but conservative stale recovery can still
    // prove it is the same abandoned private file before unlinking it.
    return { dev: info.dev, ino: info.ino, bytes: buffer.subarray(0, bytesRead) };
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP") ||
        isNodeError(error, "EISDIR")) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseStateLockOwner(bytes: Buffer): TokenVerificationLockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["createdAt", "pid", "token", "version"]) ||
      value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      typeof value.createdAt !== "string" ||
      typeof value.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token)) {
    return undefined;
  }
  const parsedCreatedAt = Date.parse(value.createdAt);
  if (!Number.isFinite(parsedCreatedAt) ||
      new Date(parsedCreatedAt).toISOString() !== value.createdAt) return undefined;
  return {
    version: 1,
    pid: value.pid as number,
    createdAt: value.createdAt,
    token: value.token
  };
}

async function unlinkIfSameRegularFile(
  lockPath: string,
  identity: { dev: number; ino: number }
): Promise<boolean> {
  const current = await lstat(lockPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!current || !current.isFile() || current.isSymbolicLink() ||
      current.dev !== identity.dev || current.ino !== identity.ino) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function stateBusy(): TokenVerificationStateError {
  return new TokenVerificationStateError(
    "state_busy",
    "Another aibill process is updating token-test state; retry after it finishes."
  );
}

function validateExperimentAdvance(
  prior: TokenReductionExperimentV0,
  next: TokenReductionExperimentV0,
  expectedRevisionId: string | undefined
): void {
  if (prior.revisionId === next.revisionId) return;
  if (expectedRevisionId !== prior.revisionId) {
    throw new TokenVerificationStateError(
      "stale_revision",
      "Token-test state changed after it was read; reload before updating it."
    );
  }
  if (JSON.stringify(immutableExperimentEvidence(prior)) !==
      JSON.stringify(immutableExperimentEvidence(next))) {
    throw new TokenVerificationStateError(
      "immutable_evidence_changed",
      "An existing token test cannot rewrite its finding, cohort, policy, or baseline."
    );
  }
  if (!allowedLifecycleAdvance(prior.lifecycle, next.lifecycle)) {
    throw new TokenVerificationStateError(
      "lifecycle_regression",
      `Token-test lifecycle cannot move from ${prior.lifecycle} to ${next.lifecycle}.`
    );
  }
  if (prior.intervention.appliedAt &&
      JSON.stringify({ ...prior.intervention, rolledBackAt: undefined }) !==
      JSON.stringify({ ...next.intervention, rolledBackAt: undefined })) {
    throw new TokenVerificationStateError(
      "immutable_evidence_changed",
      "An applied intervention boundary cannot be rewritten."
    );
  }
  if (prior.intervention.rolledBackAt &&
      prior.intervention.rolledBackAt !== next.intervention.rolledBackAt) {
    throw new TokenVerificationStateError(
      "immutable_evidence_changed",
      "An executed rollback boundary cannot be rewritten."
    );
  }
  const nextPost = new Map(next.postSessions.map((session) => [session.sessionRef, session]));
  for (const session of prior.postSessions) {
    const candidate = nextPost.get(session.sessionRef);
    if (!candidate || !allowedPostSessionAdvance(session, candidate)) {
      throw new TokenVerificationStateError(
        "immutable_evidence_changed",
        "Previously recorded post-change evidence cannot be removed or rewritten."
      );
    }
  }
}

function immutableExperimentEvidence(experiment: TokenReductionExperimentV0): unknown {
  return {
    kind: experiment.kind,
    schemaVersion: experiment.schemaVersion,
    createdAt: experiment.createdAt,
    finding: experiment.finding,
    cohort: experiment.cohort,
    matchingPolicy: experiment.matchingPolicy,
    qualityGuard: experiment.qualityGuard,
    baselineSessions: experiment.baselineSessions
  };
}

function allowedPostSessionAdvance(
  prior: TokenReductionExperimentV0["postSessions"][number],
  next: TokenReductionExperimentV0["postSessions"][number]
): boolean {
  const { quality: priorQuality, ...priorEvidence } = prior;
  const { quality: nextQuality, ...nextEvidence } = next;
  if (JSON.stringify(priorEvidence) !== JSON.stringify(nextEvidence)) return false;
  if (JSON.stringify(priorQuality) === JSON.stringify(nextQuality)) return true;
  return priorQuality.status === "missing" && nextQuality.status !== "missing";
}

function allowedLifecycleAdvance(
  prior: TokenReductionExperimentV0["lifecycle"],
  next: TokenReductionExperimentV0["lifecycle"]
): boolean {
  const allowed: Record<TokenReductionExperimentV0["lifecycle"], Set<TokenReductionExperimentV0["lifecycle"]>> = {
    draft: new Set(["draft", "baseline_ready", "invalidated"]),
    baseline_ready: new Set(["baseline_ready", "applied", "collecting", "complete", "rolled_back", "invalidated"]),
    applied: new Set(["applied", "collecting", "complete", "rolled_back"]),
    collecting: new Set(["collecting", "complete", "rolled_back"]),
    // A completed result is historical evidence. Its only permitted revision
    // is the separately evidenced execution of the rollback frozen at apply.
    complete: new Set(["rolled_back"]),
    rolled_back: new Set(["rolled_back"]),
    invalidated: new Set(["invalidated"])
  };
  return allowed[prior].has(next);
}

function isActive(experiment: TokenReductionExperimentV0): boolean {
  return experiment.lifecycle !== "complete" && experiment.lifecycle !== "rolled_back" &&
    experiment.lifecycle !== "invalidated";
}

function sameActiveScope(
  left: TokenReductionExperimentV0,
  right: TokenReductionExperimentV0
): boolean {
  return isActive(left) && isActive(right) &&
    left.cohort.projectRef === right.cohort.projectRef &&
    left.cohort.provider === right.cohort.provider &&
    left.cohort.agent === right.cohort.agent;
}

export async function loadLatestTokenReductionExperiment(
  rootPath: string
): Promise<TokenReductionExperimentV0 | undefined> {
  return chooseLatestTokenReductionExperiment(
    (await loadTokenVerificationState(rootPath)).experiments
  );
}

async function readStateDirectory(
  stateDir: string,
  expectedRootRef: string,
  expectedActionProjectRef: string
): Promise<TokenVerificationStateV1> {
  let contents: string;
  try {
    contents = await readSafeStateText(stateDir, TOKEN_VERIFICATION_STATE_FILE, {
      maxBytes: MAX_TOKEN_VERIFICATION_STATE_BYTES
    });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState(expectedRootRef);
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw malformedState();
  }
  return parseEnvelope(value, expectedRootRef, expectedActionProjectRef);
}

function parseEnvelope(
  value: unknown,
  expectedRootRef: string,
  expectedActionProjectRef: string
): TokenVerificationStateV1 {
  if (!isRecord(value) ||
      value.kind !== TOKEN_VERIFICATION_STATE_KIND ||
      value.schemaVersion !== TOKEN_VERIFICATION_STATE_VERSION ||
      value.rootRef !== expectedRootRef ||
      !Array.isArray(value.experiments) ||
      !hasExactKeys(value, ["experiments", "kind", "rootRef", "schemaVersion"])) {
    throw malformedState();
  }
  if (value.experiments.length > MAX_TOKEN_REDUCTION_EXPERIMENTS) {
    throw new TokenVerificationStateError(
      "experiment_limit_exceeded",
      `Token-reduction experiment state exceeds ${MAX_TOKEN_REDUCTION_EXPERIMENTS} entries.`
    );
  }

  const experiments = value.experiments.map(parseStoredExperiment);
  const ids = new Set<string>();
  const activeExperiments: TokenReductionExperimentV0[] = [];
  for (const experiment of experiments) {
    if (experiment.cohort.projectRef !== expectedActionProjectRef ||
        experiment.finding.scope.projectRef !== expectedActionProjectRef) {
      throw malformedState();
    }
    if (ids.has(experiment.id)) {
      throw new TokenVerificationStateError(
        "duplicate_experiment_id",
        "Token-reduction experiment state contains a duplicate experiment ID."
      );
    }
    ids.add(experiment.id);
    if (activeExperiments.some((active) => sameActiveScope(active, experiment))) {
      throw new TokenVerificationStateError(
        "active_scope_conflict",
        "Token-reduction experiment state contains conflicting active scopes."
      );
    }
    if (isActive(experiment)) activeExperiments.push(experiment);
  }
  return {
    kind: TOKEN_VERIFICATION_STATE_KIND,
    schemaVersion: TOKEN_VERIFICATION_STATE_VERSION,
    rootRef: expectedRootRef,
    experiments
  };
}

function parseExperiment(value: unknown): TokenReductionExperimentV0 {
  try {
    return parseTokenReductionExperimentV0(value);
  } catch {
    throw new TokenVerificationStateError(
      "invalid_experiment",
      "The token-reduction experiment is invalid or has been modified."
    );
  }
}

function parseStoredExperiment(value: unknown): TokenReductionExperimentV0 {
  try {
    return parseTokenReductionExperimentV0(value);
  } catch {
    throw malformedState();
  }
}

function emptyState(rootRef: string): TokenVerificationStateV1 {
  return {
    kind: TOKEN_VERIFICATION_STATE_KIND,
    schemaVersion: TOKEN_VERIFICATION_STATE_VERSION,
    rootRef,
    experiments: []
  };
}

function malformedState(): TokenVerificationStateError {
  return new TokenVerificationStateError(
    "malformed_state",
    "Token-reduction experiment state is malformed or has been modified."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
