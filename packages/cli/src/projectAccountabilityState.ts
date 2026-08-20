import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  CONFIRMED_OWNERSHIP_V0_KIND,
  isCredentialLike,
  isPathLike,
  MAX_APPROVAL_EVENTS_V0,
  PROJECT_ECONOMICS_V0_VERSION,
  appendApprovalEventV0,
  createAcceptedOutcomeV0,
  createConfirmedOwnershipV0,
  createProjectEconomicsReference,
  parseAcceptedOutcomeV0,
  parseApprovalEventV0,
  parseConfirmedOwnershipV0,
  readSafeStateText,
  resolveSafeScanRoot,
  UnsafeStateFileError,
  writeSafeStateText,
  type AcceptedOutcomeV0,
  type AcceptedOutcomeV0DraftInput,
  type ApprovalEventV0,
  type ApprovalEventV0DraftInput,
  type ConfirmedOwnershipV0
} from "@agent-finops/core";

export const PROJECT_ACCOUNTABILITY_STATE_FILE = "project-accountability.json";
export const PROJECT_ACCOUNTABILITY_STATE_KIND =
  "aibill.project_accountability_store" as const;
export const PROJECT_ACCOUNTABILITY_STATE_VERSION = 1 as const;
export const MAX_PROJECT_ACCOUNTABILITY_OUTCOMES = 256;
export const MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES = 1_000_000;
export const MAX_PROJECT_ACCOUNTABILITY_LABEL_BYTES = 192;
export const PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV =
  "AI_SPEND_PRIVATE_STATE_DIR" as const;

const PROJECT_ACCOUNTABILITY_LOCK_FILE = ".project-accountability.lock";
const PROJECT_ACCOUNTABILITY_LOCK_MAX_BYTES = 512;
const PROJECT_ACCOUNTABILITY_LOCK_STALE_MS = 15_000;
const PROJECT_ACCOUNTABILITY_UNOWNED_LOCK_STALE_MS = 5 * 60_000;
const execFile = promisify(execFileCallback);

type ProjectAccountabilityLockOwner = {
  version: 1;
  pid: number;
  createdAt: string;
  token: string;
};

type ProjectAccountabilityLockIdentity = ProjectAccountabilityLockOwner & {
  dev: number;
  ino: number;
};

export type ProjectAccountabilityDisplayLabelsV1 = {
  humanOwner: string;
  team: string;
  client?: string;
  costCenter?: string;
};

export type ProjectAccountabilityApproverRoleV1 = {
  roleLabel: string;
  roleRef: string;
};

export type ProjectAccountabilityOwnershipV1 = {
  contract: ConfirmedOwnershipV0;
  displayLabels: ProjectAccountabilityDisplayLabelsV1;
  approverRole: ProjectAccountabilityApproverRoleV1;
};

export type ProjectAccountabilityStateV1 = {
  kind: typeof PROJECT_ACCOUNTABILITY_STATE_KIND;
  schemaVersion: typeof PROJECT_ACCOUNTABILITY_STATE_VERSION;
  ownership: ProjectAccountabilityOwnershipV1 | null;
  approvals: ApprovalEventV0[];
  outcomes: AcceptedOutcomeV0[];
};

export type CreateProjectAccountabilityOwnershipInput = {
  projectRef: string;
  humanOwnerLabel: string;
  teamLabel: string;
  clientLabel?: string;
  costCenterLabel?: string;
  confirmedAt: string;
  confirmedByLabel?: string;
  approverRoleLabel: string;
};

export type UpsertProjectAccountabilityOwnershipOptions = {
  /** Compare-and-swap guard. `null` means the caller expects no ownership yet. */
  expectedOwnershipId?: string | null;
};

export type AppendProjectApprovalOptions = {
  /** Compare-and-swap guard. `null` means the caller expects an empty chain. */
  expectedPreviousEventId?: string | null;
};

export class ProjectAccountabilityStateError extends Error {
  readonly code:
    | "invalid_ownership"
    | "invalid_label"
    | "malformed_state"
    | "state_too_large"
    | "state_busy"
    | "stale_ownership"
    | "stale_approval_chain"
    | "root_binding_mismatch"
    | "ownership_scope_conflict"
    | "ownership_required"
    | "approver_identity_mismatch"
    | "approver_role_mismatch"
    | "approval_limit_exceeded"
    | "invalid_approval"
    | "invalid_outcome"
    | "duplicate_approval_id"
    | "duplicate_outcome_id"
    | "outcome_limit_exceeded";

  constructor(code: ProjectAccountabilityStateError["code"], message: string) {
    super(message);
    this.name = "ProjectAccountabilityStateError";
    this.code = code;
  }
}

/**
 * Build a confirmed local ownership record without persisting source-native
 * labels in the financial contract. Display labels remain local-only in the
 * state envelope; the core contract contains only deterministic opaque refs.
 */
export function createProjectAccountabilityOwnership(
  input: CreateProjectAccountabilityOwnershipInput
): ProjectAccountabilityOwnershipV1 {
  const projectRef = parseProjectRef(input.projectRef);
  const humanOwner = parseDisplayLabel(input.humanOwnerLabel, "human owner");
  const team = parseDisplayLabel(input.teamLabel, "team");
  const client = parseOptionalDisplayLabel(input.clientLabel, "client");
  const costCenter = parseOptionalDisplayLabel(input.costCenterLabel, "cost center");
  const confirmedBy = parseDisplayLabel(
    input.confirmedByLabel ?? humanOwner,
    "confirming human"
  );
  const roleLabel = parseDisplayLabel(input.approverRoleLabel, "approver role");

  const humanOwnerRef = createProjectEconomicsReference("person", humanOwner);
  const teamRef = createProjectEconomicsReference("team", team);
  const clientRef = client
    ? createProjectEconomicsReference("client", client)
    : undefined;
  const costCenterRef = costCenter
    ? createProjectEconomicsReference("cost-center", costCenter)
    : undefined;
  const confirmedByRef = createProjectEconomicsReference("person", confirmedBy);
  const roleRef = createProjectEconomicsReference("role", roleLabel);

  const contract = createConfirmedOwnershipV0({
    kind: CONFIRMED_OWNERSHIP_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    status: "confirmed",
    projectRef,
    humanOwnerRef,
    teamRef,
    ...(clientRef ? { clientRef } : {}),
    ...(costCenterRef ? { costCenterRef } : {}),
    confirmation: {
      evidence: "user_declared",
      confirmedAt: input.confirmedAt,
      confirmedByRef,
      locallyStored: true
    }
  });

  return parseOwnershipEntry({
    contract,
    displayLabels: {
      humanOwner,
      team,
      ...(client ? { client } : {}),
      ...(costCenter ? { costCenter } : {})
    },
    approverRole: { roleLabel, roleRef }
  }, "invalid_ownership");
}

/** Missing state is an empty, versioned envelope; unsafe state fails closed. */
export async function loadProjectAccountabilityState(
  rootPath: string
): Promise<ProjectAccountabilityStateV1> {
  let storage: ProjectAccountabilityStorage;
  try {
    storage = await resolveProjectAccountabilityStorage(rootPath, false);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState();
    throw error;
  }
  const state = await readStateDirectory(storage.stateDir);
  assertStateRootBinding(storage.canonicalRoot, state);
  return state;
}

/**
 * Return the machine-private accountability file for one canonical project.
 * The opaque root hash is only a storage key; the state envelope remains
 * independently bound to the canonical project through its ownership ref.
 *
 * This is exported for embedding and black-box verification. Normal product
 * code should use the load/mutation helpers rather than reading this path.
 */
export async function projectAccountabilityStatePath(
  rootPath: string,
  options: { create?: boolean } = {}
): Promise<string> {
  const storage = await resolveProjectAccountabilityStorage(
    rootPath,
    options.create === true
  );
  return join(storage.stateDir, PROJECT_ACCOUNTABILITY_STATE_FILE);
}

/**
 * Explicitly upsert the confirmed ownership record. Nothing infers or silently
 * changes ownership, and existing evidence cannot be moved to another project.
 */
export async function upsertConfirmedProjectOwnership(
  rootPath: string,
  value: unknown,
  options: UpsertProjectAccountabilityOwnershipOptions = {}
): Promise<ProjectAccountabilityStateV1> {
  const ownership = parseOwnershipEntry(value, "invalid_ownership");
  return mutateState(rootPath, (current) => {
    if (options.expectedOwnershipId !== undefined &&
        (current.ownership?.contract.id ?? null) !== options.expectedOwnershipId) {
      throw new ProjectAccountabilityStateError(
        "stale_ownership",
        "Project ownership changed after it was read; reload before confirming again."
      );
    }
    if (current.ownership &&
        current.ownership.contract.projectRef !== ownership.contract.projectRef &&
        (current.approvals.length > 0 || current.outcomes.length > 0)) {
      throw new ProjectAccountabilityStateError(
        "ownership_scope_conflict",
        "Existing approval or outcome evidence cannot be reassigned to another project."
      );
    }
    if (current.ownership &&
        (current.approvals.length > 0 || current.outcomes.length > 0) &&
        !sameOwnership(current.ownership, ownership)) {
      throw new ProjectAccountabilityStateError(
        "ownership_scope_conflict",
        "Confirmed ownership and display labels cannot be rewritten after approval or outcome evidence exists."
      );
    }
    return { ...current, ownership };
  });
}

/**
 * Append one locally self-attested approval through the core digest-chain
 * constructor. The current confirmed approver role must match the event.
 */
export async function appendProjectApprovalEvent(
  rootPath: string,
  input: Omit<ApprovalEventV0DraftInput, "sequence" | "previousEventId">,
  options: AppendProjectApprovalOptions = {}
): Promise<ProjectAccountabilityStateV1> {
  return mutateState(rootPath, (current) => {
    const ownership = requireOwnership(current);
    const previous = current.approvals.at(-1)?.id ?? null;
    if (options.expectedPreviousEventId !== undefined &&
        options.expectedPreviousEventId !== previous) {
      throw new ProjectAccountabilityStateError(
        "stale_approval_chain",
        "Approval history changed after it was read; reload before appending."
      );
    }
    if (input.attestation?.approverRoleRef !== ownership.approverRole.roleRef) {
      throw new ProjectAccountabilityStateError(
        "approver_role_mismatch",
        "The approval role does not match the locally confirmed approver role."
      );
    }
    if (input.attestation?.approverIdentityRef !==
        ownership.contract.confirmation.confirmedByRef) {
      throw new ProjectAccountabilityStateError(
        "approver_identity_mismatch",
        "The approval identity does not match the locally confirmed approving human."
      );
    }
    let approvals: ApprovalEventV0[];
    try {
      approvals = appendApprovalEventV0(current.approvals, input);
    } catch (error) {
      if (current.approvals.length >= MAX_APPROVAL_EVENTS_V0) {
        throw new ProjectAccountabilityStateError(
          "approval_limit_exceeded",
          `Approval history is limited to ${MAX_APPROVAL_EVENTS_V0} events.`
        );
      }
      throw new ProjectAccountabilityStateError(
        "invalid_approval",
        error instanceof Error ? error.message : "The approval event is invalid."
      );
    }
    return { ...current, approvals };
  });
}

/**
 * Construct and append one canonical GitHub outcome. Replaying the exact same
 * content-addressed outcome is idempotent; no evidence is evicted.
 */
export async function appendAcceptedProjectOutcome(
  rootPath: string,
  value: AcceptedOutcomeV0 | AcceptedOutcomeV0DraftInput
): Promise<ProjectAccountabilityStateV1> {
  const outcome = parseOrCreateOutcome(value);
  return mutateState(rootPath, (current) => {
    requireOwnership(current);
    if (current.outcomes.some((candidate) => candidate.id === outcome.id)) {
      return current;
    }
    if (current.outcomes.length >= MAX_PROJECT_ACCOUNTABILITY_OUTCOMES) {
      throw new ProjectAccountabilityStateError(
        "outcome_limit_exceeded",
        `Accepted outcomes are limited to ${MAX_PROJECT_ACCOUNTABILITY_OUTCOMES} entries.`
      );
    }
    return { ...current, outcomes: [...current.outcomes, outcome] };
  });
}

async function mutateState(
  rootPath: string,
  mutate: (current: ProjectAccountabilityStateV1) => ProjectAccountabilityStateV1
): Promise<ProjectAccountabilityStateV1> {
  const storage = await resolveProjectAccountabilityStorage(rootPath, true);
  const release = await acquireStateLock(storage.stateDir);
  try {
    const current = await readStateDirectory(storage.stateDir);
    assertStateRootBinding(storage.canonicalRoot, current);
    const next = parseEnvelope(mutate(current));
    assertStateRootBinding(storage.canonicalRoot, next);
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES) {
      throw new ProjectAccountabilityStateError(
        "state_too_large",
        "Project accountability state exceeds its local persistence bound."
      );
    }
    await writeSafeStateText(
      storage.stateDir,
      PROJECT_ACCOUNTABILITY_STATE_FILE,
      serialized
    );
    return next;
  } finally {
    await release();
  }
}

async function readStateDirectory(
  stateDir: string
): Promise<ProjectAccountabilityStateV1> {
  let contents: string;
  try {
    contents = await readSafeStateText(
      stateDir,
      PROJECT_ACCOUNTABILITY_STATE_FILE,
      { maxBytes: MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES }
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyState();
    if (error instanceof UnsafeStateFileError &&
        error.message.includes(`exceeds ${MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES} bytes`)) {
      throw new ProjectAccountabilityStateError(
        "state_too_large",
        "Project accountability state exceeds its local persistence bound."
      );
    }
    throw error;
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES) {
    throw new ProjectAccountabilityStateError(
      "state_too_large",
      "Project accountability state exceeds its local persistence bound."
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw malformedState();
  }
  return parseEnvelope(value);
}

function parseEnvelope(value: unknown): ProjectAccountabilityStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "approvals",
    "kind",
    "outcomes",
    "ownership",
    "schemaVersion"
  ]) || value.kind !== PROJECT_ACCOUNTABILITY_STATE_KIND ||
      value.schemaVersion !== PROJECT_ACCOUNTABILITY_STATE_VERSION ||
      !Array.isArray(value.approvals) || !Array.isArray(value.outcomes) ||
      !(value.ownership === null || isRecord(value.ownership))) {
    throw malformedState();
  }
  if (value.approvals.length > MAX_APPROVAL_EVENTS_V0) {
    throw new ProjectAccountabilityStateError(
      "approval_limit_exceeded",
      `Approval history exceeds ${MAX_APPROVAL_EVENTS_V0} events.`
    );
  }
  if (value.outcomes.length > MAX_PROJECT_ACCOUNTABILITY_OUTCOMES) {
    throw new ProjectAccountabilityStateError(
      "outcome_limit_exceeded",
      `Accepted outcomes exceed ${MAX_PROJECT_ACCOUNTABILITY_OUTCOMES} entries.`
    );
  }

  const ownership = value.ownership === null
    ? null
    : parseOwnershipEntry(value.ownership, "malformed_state");
  const approvals = value.approvals.map(parseStoredApproval);
  const outcomes = value.outcomes.map(parseStoredOutcome);

  const approvalIds = new Set<string>();
  for (let index = 0; index < approvals.length; index += 1) {
    const event = approvals[index]!;
    if (approvalIds.has(event.id)) {
      throw new ProjectAccountabilityStateError(
        "duplicate_approval_id",
        "Project accountability state contains a duplicate approval event."
      );
    }
    approvalIds.add(event.id);
    const expectedPrevious = index === 0 ? null : approvals[index - 1]!.id;
    if (event.sequence !== index || event.previousEventId !== expectedPrevious ||
        (index > 0 && Date.parse(event.approvedAt) <
          Date.parse(approvals[index - 1]!.approvedAt))) {
      throw malformedState();
    }
  }

  const outcomeIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcomeIds.has(outcome.id)) {
      throw new ProjectAccountabilityStateError(
        "duplicate_outcome_id",
        "Project accountability state contains a duplicate accepted outcome."
      );
    }
    outcomeIds.add(outcome.id);
  }

  if (!ownership && (approvals.length > 0 || outcomes.length > 0)) {
    throw malformedState();
  }
  if (ownership && approvals.some((event) =>
    event.attestation.approverRoleRef !== ownership.approverRole.roleRef
  )) {
    throw malformedState();
  }
  if (ownership && approvals.some((event) =>
    event.attestation.approverIdentityRef !==
      ownership.contract.confirmation.confirmedByRef
  )) {
    throw malformedState();
  }

  return {
    kind: PROJECT_ACCOUNTABILITY_STATE_KIND,
    schemaVersion: PROJECT_ACCOUNTABILITY_STATE_VERSION,
    ownership,
    approvals,
    outcomes
  };
}

function parseOwnershipEntry(
  value: unknown,
  code: "invalid_ownership" | "malformed_state"
): ProjectAccountabilityOwnershipV1 {
  try {
    if (!isRecord(value) || !hasExactKeys(value, [
      "approverRole",
      "contract",
      "displayLabels"
    ]) || !isRecord(value.displayLabels) || !isRecord(value.approverRole)) {
      throw new Error("Unexpected ownership fields.");
    }
    const labels = parseDisplayLabels(value.displayLabels);
    if (!hasExactKeys(value.approverRole, ["roleLabel", "roleRef"]) ||
        typeof value.approverRole.roleLabel !== "string" ||
        typeof value.approverRole.roleRef !== "string") {
      throw new Error("Unexpected approver-role fields.");
    }
    const roleLabel = parseDisplayLabel(
      value.approverRole.roleLabel,
      "approver role"
    );
    const roleRef = createProjectEconomicsReference("role", roleLabel);
    if (value.approverRole.roleRef !== roleRef) {
      throw new Error("Approver role label does not match its opaque reference.");
    }
    const contract = parseConfirmedOwnershipV0(value.contract);
    if (contract.humanOwnerRef !==
        createProjectEconomicsReference("person", labels.humanOwner) ||
        contract.teamRef !== createProjectEconomicsReference("team", labels.team) ||
        contract.clientRef !== (labels.client
          ? createProjectEconomicsReference("client", labels.client)
          : undefined) ||
        contract.costCenterRef !== (labels.costCenter
          ? createProjectEconomicsReference("cost-center", labels.costCenter)
          : undefined)) {
      throw new Error("Ownership labels do not match the confirmed opaque references.");
    }
    return {
      contract,
      displayLabels: labels,
      approverRole: { roleLabel, roleRef }
    };
  } catch (error) {
    throw new ProjectAccountabilityStateError(
      code,
      code === "malformed_state"
        ? "Project accountability state is malformed or has been modified."
        : error instanceof Error
          ? `Confirmed project ownership is invalid: ${error.message}`
          : "Confirmed project ownership is invalid."
    );
  }
}

function parseDisplayLabels(
  value: Record<string, unknown>
): ProjectAccountabilityDisplayLabelsV1 {
  const keys = Object.keys(value);
  if (!keys.every((key) => ["client", "costCenter", "humanOwner", "team"].includes(key)) ||
      !keys.includes("humanOwner") || !keys.includes("team") ||
      typeof value.humanOwner !== "string" || typeof value.team !== "string" ||
      (value.client !== undefined && typeof value.client !== "string") ||
      (value.costCenter !== undefined && typeof value.costCenter !== "string")) {
    throw new Error("Ownership display labels have unexpected fields.");
  }
  const humanOwner = parseDisplayLabel(value.humanOwner, "human owner");
  const team = parseDisplayLabel(value.team, "team");
  const client = parseOptionalDisplayLabel(value.client, "client");
  const costCenter = parseOptionalDisplayLabel(value.costCenter, "cost center");
  return {
    humanOwner,
    team,
    ...(client ? { client } : {}),
    ...(costCenter ? { costCenter } : {})
  };
}

function parseDisplayLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw invalidLabel(field);
  }
  const normalized = value.trim().normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized, "utf8") >
      MAX_PROJECT_ACCOUNTABILITY_LABEL_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ||
      isPathLike(normalized) || isCredentialLike(normalized)) {
    throw invalidLabel(field);
  }
  return normalized;
}

function parseOptionalDisplayLabel(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : parseDisplayLabel(value, field);
}

function parseProjectRef(value: unknown): string {
  if (typeof value !== "string" || !/^peref_[a-f0-9]{64}$/.test(value)) {
    throw new ProjectAccountabilityStateError(
      "invalid_ownership",
      "Confirmed project ownership requires an opaque project reference."
    );
  }
  return value;
}

function parseStoredApproval(value: unknown): ApprovalEventV0 {
  try {
    return parseApprovalEventV0(value);
  } catch {
    throw malformedState();
  }
}

function parseStoredOutcome(value: unknown): AcceptedOutcomeV0 {
  try {
    const outcome = parseAcceptedOutcomeV0(value);
    if (outcome.businessDescription &&
        isCredentialLike(outcome.businessDescription.value)) {
      throw new Error("Credential-like business description.");
    }
    return outcome;
  } catch {
    throw malformedState();
  }
}

function parseOrCreateOutcome(
  value: AcceptedOutcomeV0 | AcceptedOutcomeV0DraftInput
): AcceptedOutcomeV0 {
  try {
    const outcome = isRecord(value) && "id" in value
      ? parseAcceptedOutcomeV0(value)
      : createAcceptedOutcomeV0(value as AcceptedOutcomeV0DraftInput);
    if (outcome.businessDescription &&
        isCredentialLike(outcome.businessDescription.value)) {
      throw new Error("Business descriptions cannot contain credentials.");
    }
    return outcome;
  } catch (error) {
    throw new ProjectAccountabilityStateError(
      "invalid_outcome",
      error instanceof Error ? error.message : "The accepted outcome is invalid."
    );
  }
}

function requireOwnership(
  state: ProjectAccountabilityStateV1
): ProjectAccountabilityOwnershipV1 {
  if (!state.ownership) {
    throw new ProjectAccountabilityStateError(
      "ownership_required",
      "Confirm the project owner, team, and approver role before recording evidence."
    );
  }
  return state.ownership;
}

function emptyState(): ProjectAccountabilityStateV1 {
  return {
    kind: PROJECT_ACCOUNTABILITY_STATE_KIND,
    schemaVersion: PROJECT_ACCOUNTABILITY_STATE_VERSION,
    ownership: null,
    approvals: [],
    outcomes: []
  };
}

function assertStateRootBinding(
  canonicalRoot: string,
  state: ProjectAccountabilityStateV1
): void {
  if (!state.ownership) return;
  const expected = createProjectEconomicsReference("project-root", canonicalRoot);
  if (state.ownership.contract.projectRef !== expected) {
    throw new ProjectAccountabilityStateError(
      "root_binding_mismatch",
      "Confirmed accountability state belongs to a different canonical project root."
    );
  }
}

type ProjectAccountabilityStorage = {
  canonicalRoot: string;
  stateDir: string;
};

/**
 * Sensitive labels (person, team, client, cost center, business description)
 * must not live in a repository-owned path. Resolve a dedicated private
 * directory outside the approved project and key its direct child by the
 * canonical root digest. `AI_SPEND_PRIVATE_STATE_DIR` is the explicit
 * embedding/test override; the existing trust-directory override is honored
 * as a compatibility fallback so CLI tests remain isolated from real HOME.
 */
async function resolveProjectAccountabilityStorage(
  rootPath: string,
  create: boolean
): Promise<ProjectAccountabilityStorage> {
  const canonicalRoot = await resolveSafeScanRoot(rootPath);
  const privateOverride =
    process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV]?.trim();
  const trustOverride = process.env.AI_SPEND_STATE_TRUST_DIR?.trim();
  const requestedBase = resolve(
    privateOverride
      ? join(privateOverride, "project-accountability")
      : trustOverride
        ? join(trustOverride, "project-accountability")
        : join(homedir(), ".aibill", "private-state", "project-accountability")
  );

  // Refuse before mkdir as well as after realpath so a bad override cannot
  // create even an empty private-state directory inside the repository.
  if (isSameOrDescendant(requestedBase, canonicalRoot)) {
    throw new ProjectAccountabilityStateError(
      "root_binding_mismatch",
      "Private project accountability storage must remain outside the canonical project root."
    );
  }
  const enclosingGitRootBeforeCreate = await findEnclosingGitRoot(requestedBase);
  if (enclosingGitRootBeforeCreate && (privateOverride || trustOverride)) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage cannot be placed inside a Git worktree."
    );
  }
  let baseInfo = await lstat(requestedBase).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!baseInfo && create) {
    await mkdir(requestedBase, { recursive: true, mode: 0o700 });
    baseInfo = await lstat(requestedBase);
  }
  if (!baseInfo) throw missingDirectory(requestedBase);
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage is not a real directory."
    );
  }
  if ((baseInfo.mode & 0o077) !== 0) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage has unsafe permissions."
    );
  }
  const canonicalBase = await realpath(requestedBase);
  if (isSameOrDescendant(canonicalBase, canonicalRoot)) {
    throw new ProjectAccountabilityStateError(
      "root_binding_mismatch",
      "Private project accountability storage resolves inside the canonical project root."
    );
  }
  const enclosingGitRoot = await findEnclosingGitRoot(canonicalBase);
  if (enclosingGitRoot) {
    if (privateOverride || trustOverride) {
      throw new ProjectAccountabilityStateError(
        "malformed_state",
        "Private project accountability storage cannot be placed inside a Git worktree."
      );
    }
    await ensureIgnoredPrivateBoundary(canonicalBase, enclosingGitRoot, create);
  }

  const stateKey = createHash("sha256")
    .update(`aibill-project-accountability-root-v1\0${canonicalRoot}`, "utf8")
    .digest("hex");
  const requestedState = join(canonicalBase, stateKey);
  let stateInfo = await lstat(requestedState).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!stateInfo && create) {
    try {
      await mkdir(requestedState, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    stateInfo = await lstat(requestedState);
  }
  if (!stateInfo) throw missingDirectory(requestedState);
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage entry is not a real directory."
    );
  }
  const canonicalState = await realpath(requestedState);
  if (relative(canonicalBase, canonicalState).split(sep).length !== 1 ||
      relative(canonicalBase, canonicalState) !== stateKey) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage entry does not resolve as its direct opaque child."
    );
  }
  if ((stateInfo.mode & 0o077) !== 0) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage entry has unsafe permissions."
    );
  }
  return { canonicalRoot, stateDir: canonicalState };
}

function missingDirectory(path: string): NodeJS.ErrnoException {
  const error = new Error(`Private project accountability directory does not exist: ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" ||
    (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent));
}

async function findEnclosingGitRoot(path: string): Promise<string | undefined> {
  let current = resolve(path);
  while (true) {
    const gitEntry = await lstat(join(current, ".git")).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
        return undefined;
      }
      throw error;
    });
    if (gitEntry) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function ensureIgnoredPrivateBoundary(
  privateBase: string,
  gitRoot: string,
  create: boolean
): Promise<void> {
  const marker = join(privateBase, ".gitignore");
  let markerContents: string;
  try {
    markerContents = await readSafeStateText(privateBase, ".gitignore", { maxBytes: 16 });
  } catch (error) {
    if (!create || !isNodeError(error, "ENOENT")) throw error;
    await writeSafeStateText(privateBase, ".gitignore", "*\n");
    markerContents = "*\n";
  }
  if (markerContents !== "*\n") {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage has an invalid Git privacy marker."
    );
  }

  const relativeBase = relative(gitRoot, privateBase);
  const tracked = await execFile("git", ["-C", gitRoot, "ls-files", "--", relativeBase], {
    encoding: "utf8",
    maxBuffer: 64 * 1024
  }).then(({ stdout }) => stdout.trim()).catch(() => {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability tracking status could not be verified."
    );
  });
  if (tracked) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage is already tracked by Git."
    );
  }
  const ignored = await execFile("git", [
    "-C", gitRoot, "check-ignore", "--quiet", "--no-index", "--",
    join(relativeBase, "privacy-probe.json")
  ]).then(() => true).catch(() => false);
  if (!ignored) {
    throw new ProjectAccountabilityStateError(
      "malformed_state",
      "Private project accountability storage is not proven ignored by Git."
    );
  }
}

function sameOwnership(
  left: ProjectAccountabilityOwnershipV1,
  right: ProjectAccountabilityOwnershipV1
): boolean {
  return left.contract.id === right.contract.id &&
    left.approverRole.roleRef === right.approverRole.roleRef &&
    left.approverRole.roleLabel === right.approverRole.roleLabel &&
    left.displayLabels.humanOwner === right.displayLabels.humanOwner &&
    left.displayLabels.team === right.displayLabels.team &&
    left.displayLabels.client === right.displayLabels.client &&
    left.displayLabels.costCenter === right.displayLabels.costCenter;
}

async function acquireStateLock(stateDir: string): Promise<() => Promise<void>> {
  const lockPath = join(stateDir, PROJECT_ACCOUNTABILITY_LOCK_FILE);
  const owner: ProjectAccountabilityLockOwner = {
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

      const identity: ProjectAccountabilityLockIdentity = {
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
        if (collision || isNodeError(error, "ELOOP") ||
            error instanceof ProjectAccountabilityStateError) {
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

  // No released version creates directory locks. We still recover a very old,
  // empty legacy-shaped directory conservatively so an interrupted preview
  // cannot permanently brick future ownership writes.
  if (info.isDirectory()) {
    if (Date.now() - info.mtimeMs < PROJECT_ACCOUNTABILITY_UNOWNED_LOCK_STALE_MS) {
      return false;
    }
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
      Date.now() - info.mtimeMs < PROJECT_ACCOUNTABILITY_LOCK_STALE_MS) {
    return false;
  }
  const snapshot = await readStateLock(lockPath);
  if (!snapshot || snapshot.dev !== info.dev || snapshot.ino !== info.ino) return false;
  const owner = parseStateLockOwner(snapshot.bytes);
  if (!owner) {
    // SIGKILL can land between O_EXCL and the owner-record write. An empty,
    // malformed, or oversized private lock receives a five-minute grace;
    // inode equality is rechecked immediately before unlinking.
    if (Date.now() - info.mtimeMs < PROJECT_ACCOUNTABILITY_UNOWNED_LOCK_STALE_MS) {
      return false;
    }
    return unlinkIfSameRegularFile(lockPath, snapshot);
  }
  const createdAge = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(createdAge) ||
      createdAge < PROJECT_ACCOUNTABILITY_LOCK_STALE_MS ||
      processIsAlive(owner.pid)) {
    return false;
  }
  return unlinkIfSameRegularFile(lockPath, snapshot);
}

async function releaseOwnedStateLock(
  lockPath: string,
  identity: ProjectAccountabilityLockIdentity
): Promise<void> {
  if (!await lockStillOwned(lockPath, identity)) return;
  await unlinkIfSameRegularFile(lockPath, identity).catch(() => undefined);
}

async function lockStillOwned(
  lockPath: string,
  identity: ProjectAccountabilityLockIdentity
): Promise<boolean> {
  const snapshot = await readStateLock(lockPath);
  if (!snapshot || snapshot.dev !== identity.dev || snapshot.ino !== identity.ino) {
    return false;
  }
  const owner = parseStateLockOwner(snapshot.bytes);
  return owner?.version === identity.version && owner.pid === identity.pid &&
    owner.createdAt === identity.createdAt && owner.token === identity.token;
}

async function readStateLock(
  lockPath: string
): Promise<{ dev: number; ino: number; bytes: Buffer } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) return undefined;
    const buffer = Buffer.alloc(PROJECT_ACCOUNTABILITY_LOCK_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { dev: info.dev, ino: info.ino, bytes: buffer.subarray(0, bytesRead) };
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP") ||
        isNodeError(error, "EISDIR")) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseStateLockOwner(
  bytes: Buffer
): ProjectAccountabilityLockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) ||
      !hasExactKeys(value, ["createdAt", "pid", "token", "version"]) ||
      value.version !== 1 || !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 || typeof value.createdAt !== "string" ||
      typeof value.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token)) {
    return undefined;
  }
  const parsedCreatedAt = Date.parse(value.createdAt);
  if (!Number.isFinite(parsedCreatedAt) ||
      new Date(parsedCreatedAt).toISOString() !== value.createdAt) {
    return undefined;
  }
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
      current.dev !== identity.dev || current.ino !== identity.ino) {
    return false;
  }
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

/**
 * The classification FLOOR predicates for the guided-prompt engine live in
 * core (`guidedAnswer.ts`) so the CLI classifier, the MCP draft preview,
 * and this accountability backstop can never drift apart. Re-exported here
 * for existing CLI imports.
 */
export { isCredentialLike, isPathLike };

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function invalidLabel(field: string): ProjectAccountabilityStateError {
  return new ProjectAccountabilityStateError(
    "invalid_label",
    `${field} must be a bounded, path-free, credential-free display label.`
  );
}

function malformedState(): ProjectAccountabilityStateError {
  return new ProjectAccountabilityStateError(
    "malformed_state",
    "Project accountability state is malformed or has been modified."
  );
}

function stateBusy(): ProjectAccountabilityStateError {
  return new ProjectAccountabilityStateError(
    "state_busy",
    "Project accountability state is busy; retry after the other local write finishes."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = expected.slice().sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
