import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_OUTCOME_V0_KIND,
  APPROVAL_EVENT_V0_KIND,
  PROJECT_ECONOMICS_V0_VERSION,
  UnsafeStateFileError,
  appendApprovalEventV0,
  createActionVerificationReference,
  createAcceptedOutcomeV0,
  createProjectEconomicsReference,
  type AcceptedOutcomeV0DraftInput,
  type ApprovalEventV0DraftInput
} from "@agent-finops/core";
import {
  MAX_PROJECT_ACCOUNTABILITY_OUTCOMES,
  MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES,
  PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV,
  PROJECT_ACCOUNTABILITY_STATE_FILE,
  PROJECT_ACCOUNTABILITY_STATE_KIND,
  PROJECT_ACCOUNTABILITY_STATE_VERSION,
  ProjectAccountabilityStateError,
  appendAcceptedProjectOutcome,
  appendProjectApprovalEvent,
  createProjectAccountabilityOwnership,
  loadProjectAccountabilityState,
  projectAccountabilityStatePath,
  upsertConfirmedProjectOwnership
} from "./projectAccountabilityState.js";

const temporaryRoots: string[] = [];
const privateStateRoot = join(
  tmpdir(),
  `aibill-project-accountability-private-${process.pid}`
);
process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV] = privateStateRoot;
const CONFIRMED_AT = "2026-08-16T14:00:00.000Z";
const APPROVED_AT = "2026-08-16T15:00:00.000Z";
const ACCEPTED_AT = "2026-08-16T16:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
  await rm(privateStateRoot, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV];
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(
    join(tmpdir(), "aibill-project-accountability-")
  ));
  temporaryRoots.push(root);
  return root;
}

function ownership(
  root: string,
  role = "Engineering lead",
  labels: {
    humanOwner?: string;
    team?: string;
    client?: string;
    costCenter?: string;
  } = {}
) {
  return createProjectAccountabilityOwnership({
    projectRef: createProjectEconomicsReference("project-root", root),
    humanOwnerLabel: labels.humanOwner ?? "Jose Artigas",
    teamLabel: labels.team ?? "Developer Experience",
    clientLabel: labels.client ?? "Futura Studio",
    costCenterLabel: labels.costCenter ?? "R&D",
    confirmedAt: CONFIRMED_AT,
    approverRoleLabel: role
  });
}

function approval(
  roleRef: string,
  label = "first",
  approvedAt = APPROVED_AT
): Omit<ApprovalEventV0DraftInput, "sequence" | "previousEventId"> {
  return {
    kind: APPROVAL_EVENT_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    approvedAt,
    decision: "approved",
    attestation: {
      scope: "local_self_attested",
      evidence: "user_declared",
      approverIdentityRef: createProjectEconomicsReference("person", "Jose Artigas"),
      approverRoleRef: roleRef,
      rbacVerified: false
    },
    references: {
      actionRef: createActionVerificationReference("action", label),
      changeRef: createActionVerificationReference("change", label),
      rollbackRef: createActionVerificationReference("rollback", label),
      canaryRef: createActionVerificationReference("canary", label)
    }
  };
}

function outcomeDraft(label = "42"): AcceptedOutcomeV0DraftInput {
  return {
    kind: ACCEPTED_OUTCOME_V0_KIND,
    schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
    platform: "github",
    outcomeType: "pull_request",
    repositoryRef: createProjectEconomicsReference(
      "repository",
      "futurastudio/ai-spend-agent"
    ),
    workUnitRef: createProjectEconomicsReference(
      "github-pr",
      `futurastudio/ai-spend-agent#${label}`
    ),
    state: "merged",
    stateEvidence: "verified",
    acceptedAt: ACCEPTED_AT,
    commit: {
      commitRef: createProjectEconomicsReference("commit", label.padStart(40, "0")),
      evidence: "verified"
    },
    checks: {
      status: "passed",
      evidence: "verified",
      evidenceRefs: [createProjectEconomicsReference("check", `ci:${label}`)]
    },
    businessDescription: {
      value: "Shipped the accepted launch change.",
      evidence: "user_declared"
    }
  };
}

async function writeRawState(root: string, value: unknown): Promise<string> {
  const statePath = await projectAccountabilityStatePath(root, { create: true });
  const stateDir = dirname(statePath);
  await writeFile(
    statePath,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
  return stateDir;
}

function emptyEnvelope() {
  return {
    kind: PROJECT_ACCOUNTABILITY_STATE_KIND,
    schemaVersion: PROJECT_ACCOUNTABILITY_STATE_VERSION,
    ownership: null,
    approvals: [],
    outcomes: []
  };
}

describe("project accountability state", () => {
  it("explicitly confirms local ownership and preserves only opaque refs in its contract", async () => {
    const root = await fixtureRoot();
    expect(await loadProjectAccountabilityState(root)).toEqual(emptyEnvelope());

    const entry = ownership(root);
    const state = await upsertConfirmedProjectOwnership(root, entry, {
      expectedOwnershipId: null
    });

    expect(state.ownership).toEqual(entry);
    expect(state.ownership?.contract).toMatchObject({
      status: "confirmed",
      humanOwnerRef: expect.stringMatching(/^peref_[a-f0-9]{64}$/),
      teamRef: expect.stringMatching(/^peref_[a-f0-9]{64}$/),
      confirmation: { evidence: "user_declared", locallyStored: true }
    });
    expect(state.ownership?.contract).not.toHaveProperty("humanOwnerLabel");
    expect(state.ownership?.displayLabels).toEqual({
      humanOwner: "Jose Artigas",
      team: "Developer Experience",
      client: "Futura Studio",
      costCenter: "R&D"
    });
    expect(await loadProjectAccountabilityState(root)).toEqual(state);

    const stateFile = await projectAccountabilityStatePath(root);
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(stateFile))).mode & 0o777).toBe(0o700);
    const pathFromProject = relative(root, stateFile);
    expect(pathFromProject === ".." || pathFromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)).toBe(true);
    expect(isAbsolute(stateFile)).toBe(true);
    expect(stateFile).not.toContain("Jose Artigas");
    expect(stateFile).not.toContain("Developer Experience");
    await expect(lstat(join(root, ".ai-spend-agent"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("ignores repository-authored legacy accountability files instead of trusting or migrating them", async () => {
    const root = await fixtureRoot();
    const legacyDir = join(root, ".ai-spend-agent");
    await mkdir(legacyDir, { mode: 0o700 });
    await writeFile(
      join(legacyDir, PROJECT_ACCOUNTABILITY_STATE_FILE),
      `${JSON.stringify({
        ...emptyEnvelope(),
        ownership: ownership(root)
      })}\n`,
      { mode: 0o600 }
    );

    expect(await loadProjectAccountabilityState(root)).toEqual(emptyEnvelope());
    await expect(projectAccountabilityStatePath(root)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("refuses a private-state override inside any Git worktree before creating storage", async () => {
    const root = await fixtureRoot();
    const otherRepository = await fixtureRoot();
    await mkdir(join(otherRepository, ".git"), { mode: 0o700 });
    const prior = process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV];
    process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV] = join(
      otherRepository,
      "private"
    );
    try {
      await expect(upsertConfirmedProjectOwnership(root, ownership(root)))
        .rejects.toMatchObject({ code: "malformed_state" });
      await expect(lstat(join(otherRepository, "private"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      if (prior === undefined) {
        delete process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV];
      } else {
        process.env[PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV] = prior;
      }
    }
  });

  it("rejects path-like, control, unpaired, oversized, and credential-like labels", () => {
    const base = {
      projectRef: createProjectEconomicsReference("project", "agent-finops"),
      humanOwnerLabel: "Jose",
      teamLabel: "Platform",
      confirmedAt: CONFIRMED_AT,
      approverRoleLabel: "Engineering lead"
    };
    for (const value of [
      "../secrets",
      "/absolute/private-root",
      "C:\\private\\owner",
      "bad\u0000label",
      "\ud800",
      `npm_${"a".repeat(32)}`,
      `Platform npm_${"b".repeat(32)}`,
      "api_key=sk-secret-value",
      "x".repeat(193)
    ]) {
      expect(() => createProjectAccountabilityOwnership({
        ...base,
        humanOwnerLabel: value
      })).toThrow(ProjectAccountabilityStateError);
    }
    // A business label is not treated as a filesystem path merely for using '/'.
    expect(createProjectAccountabilityOwnership({
      ...base,
      costCenterLabel: "R&D"
    }).displayLabels.costCenter).toBe("R&D");
  });

  it("fails closed on malformed, extra-keyed, forged, oversized, and ownerless evidence", async () => {
    const malformedRoot = await fixtureRoot();
    await writeRawState(malformedRoot, "{bad-json");
    await expect(loadProjectAccountabilityState(malformedRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const extraRoot = await fixtureRoot();
    await writeRawState(extraRoot, { ...emptyEnvelope(), token: "must-not-pass" });
    await expect(loadProjectAccountabilityState(extraRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const forgedRoot = await fixtureRoot();
    await writeRawState(forgedRoot, {
      ...emptyEnvelope(),
      ownership: {
        ...ownership(forgedRoot),
        displayLabels: {
          ...ownership(forgedRoot).displayLabels,
          humanOwner: "Different human"
        }
      }
    });
    await expect(loadProjectAccountabilityState(forgedRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const ownerlessRoot = await fixtureRoot();
    await writeRawState(ownerlessRoot, {
      ...emptyEnvelope(),
      outcomes: [createAcceptedOutcomeV0(outcomeDraft())]
    });
    await expect(loadProjectAccountabilityState(ownerlessRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const oversizedRoot = await fixtureRoot();
    await writeRawState(
      oversizedRoot,
      " ".repeat(MAX_PROJECT_ACCOUNTABILITY_STATE_BYTES + 1)
    );
    await expect(loadProjectAccountabilityState(oversizedRoot)).rejects.toMatchObject({
      code: "state_too_large"
    });
  });

  it("refuses symlinked state directories and child state files", async () => {
    const linkedDirectoryRoot = await fixtureRoot();
    const outside = await fixtureRoot();
    const linkedStatePath = await projectAccountabilityStatePath(
      linkedDirectoryRoot,
      { create: true }
    );
    const linkedStateDir = dirname(linkedStatePath);
    await rm(linkedStateDir, { recursive: true, force: true });
    await symlink(outside, linkedStateDir);
    await expect(loadProjectAccountabilityState(linkedDirectoryRoot))
      .rejects.toMatchObject({ code: "malformed_state" });

    const linkedFileRoot = await fixtureRoot();
    const linkedFilePath = await projectAccountabilityStatePath(
      linkedFileRoot,
      { create: true }
    );
    const stateDir = dirname(linkedFilePath);
    const outsideFile = join(outside, "outside.json");
    await writeFile(outsideFile, `${JSON.stringify(emptyEnvelope())}\n`);
    await symlink(outsideFile, linkedFilePath);
    await expect(loadProjectAccountabilityState(linkedFileRoot))
      .rejects.toBeInstanceOf(UnsafeStateFileError);
  });

  it("fails closed when valid accountability state is copied to another project root", async () => {
    const sourceRoot = await fixtureRoot();
    const copiedRoot = await fixtureRoot();
    const source = await upsertConfirmedProjectOwnership(
      sourceRoot,
      ownership(sourceRoot)
    );
    await writeRawState(copiedRoot, source);

    await expect(loadProjectAccountabilityState(copiedRoot)).rejects.toMatchObject({
      code: "root_binding_mismatch"
    });
    await expect(appendAcceptedProjectOutcome(copiedRoot, outcomeDraft()))
      .rejects.toMatchObject({ code: "root_binding_mismatch" });
  });

  it("uses compare-and-swap and cannot move existing evidence to another project", async () => {
    const root = await fixtureRoot();
    const first = ownership(root);
    await upsertConfirmedProjectOwnership(root, first, {
      expectedOwnershipId: null
    });
    await expect(upsertConfirmedProjectOwnership(root, ownership(root), {
      expectedOwnershipId: "ownc_v0_" + "f".repeat(64)
    })).rejects.toMatchObject({ code: "stale_ownership" });

    await appendAcceptedProjectOutcome(root, outcomeDraft());
    await expect(upsertConfirmedProjectOwnership(root, ownership(`${root}-other`)))
      .rejects.toMatchObject({ code: "ownership_scope_conflict" });
    for (const changed of [
      ownership(root, "Engineering lead", { humanOwner: "Another owner" }),
      ownership(root, "Engineering lead", { team: "Finance" }),
      ownership(root, "Engineering lead", { client: "Another client" }),
      ownership(root, "Engineering lead", { costCenter: "AI-200" })
    ]) {
      await expect(upsertConfirmedProjectOwnership(root, changed))
        .rejects.toMatchObject({ code: "ownership_scope_conflict" });
    }
    await expect(upsertConfirmedProjectOwnership(root, first)).resolves.toMatchObject({
      ownership: expect.objectContaining({
        contract: expect.objectContaining({ id: first.contract.id })
      })
    });
    expect((await loadProjectAccountabilityState(root)).ownership?.contract.id)
      .toBe(first.contract.id);

    const approvedRoot = await fixtureRoot();
    const approvedOwnership = ownership(approvedRoot);
    await upsertConfirmedProjectOwnership(approvedRoot, approvedOwnership);
    await appendProjectApprovalEvent(
      approvedRoot,
      approval(approvedOwnership.approverRole.roleRef)
    );
    await expect(upsertConfirmedProjectOwnership(
      approvedRoot,
      ownership(approvedRoot, "Finance lead")
    )).rejects.toMatchObject({ code: "ownership_scope_conflict" });
    await expect(upsertConfirmedProjectOwnership(
      approvedRoot,
      ownership(approvedRoot, "Engineering lead", { humanOwner: "Another owner" })
    )).rejects.toMatchObject({ code: "ownership_scope_conflict" });
  });

  it("appends a monotonic approval digest chain and enforces the confirmed role", async () => {
    const root = await fixtureRoot();
    const entry = ownership(root);
    await upsertConfirmedProjectOwnership(root, entry);
    const roleRef = entry.approverRole.roleRef;

    const first = await appendProjectApprovalEvent(
      root,
      approval(roleRef),
      { expectedPreviousEventId: null }
    );
    expect(first.approvals[0]).toMatchObject({ sequence: 0, previousEventId: null });
    const second = await appendProjectApprovalEvent(
      root,
      approval(roleRef, "second", "2026-08-16T15:01:00.000Z"),
      { expectedPreviousEventId: first.approvals[0]!.id }
    );
    expect(second.approvals[1]).toMatchObject({
      sequence: 1,
      previousEventId: first.approvals[0]!.id
    });
    await expect(appendProjectApprovalEvent(
      root,
      approval(roleRef, "stale"),
      { expectedPreviousEventId: null }
    )).rejects.toMatchObject({ code: "stale_approval_chain" });

    const wrongRole = createProjectEconomicsReference("role", "Finance lead");
    await expect(appendProjectApprovalEvent(root, approval(wrongRole, "wrong-role")))
      .rejects.toMatchObject({ code: "approver_role_mismatch" });
    const wrongIdentityApproval = approval(roleRef, "wrong-identity");
    await expect(appendProjectApprovalEvent(root, {
      ...wrongIdentityApproval,
      attestation: {
        ...wrongIdentityApproval.attestation,
        approverIdentityRef: createProjectEconomicsReference("person", "Another approver")
      }
    })).rejects.toMatchObject({ code: "approver_identity_mismatch" });
    await expect(appendProjectApprovalEvent(
      root,
      approval(roleRef, "predates", "2026-08-16T14:59:00.000Z")
    )).rejects.toMatchObject({ code: "invalid_approval" });
    expect((await loadProjectAccountabilityState(root)).approvals).toHaveLength(2);
  });

  it("detects tampered or broken stored approval chains", async () => {
    const root = await fixtureRoot();
    const entry = ownership(root);
    await upsertConfirmedProjectOwnership(root, entry);
    const state = await appendProjectApprovalEvent(
      root,
      approval(entry.approverRole.roleRef)
    );
    const statePath = await projectAccountabilityStatePath(root);
    await writeFile(statePath, JSON.stringify({
      ...state,
      approvals: [{ ...state.approvals[0], sequence: 1 }]
    }));
    await expect(loadProjectAccountabilityState(root)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const wrongIdentityRoot = await fixtureRoot();
    const wrongIdentityOwner = ownership(wrongIdentityRoot);
    const wrongIdentityInput = approval(wrongIdentityOwner.approverRole.roleRef);
    const validButMisattributed = appendApprovalEventV0([], {
      ...wrongIdentityInput,
      attestation: {
        ...wrongIdentityInput.attestation,
        approverIdentityRef: createProjectEconomicsReference(
          "person",
          "Another approver"
        )
      }
    });
    await writeRawState(wrongIdentityRoot, {
      ...emptyEnvelope(),
      ownership: wrongIdentityOwner,
      approvals: validButMisattributed
    });
    await expect(loadProjectAccountabilityState(wrongIdentityRoot))
      .rejects.toMatchObject({ code: "malformed_state" });
  });

  it("content-addresses outcomes and idempotently deduplicates exact replays", async () => {
    const root = await fixtureRoot();
    await upsertConfirmedProjectOwnership(root, ownership(root));
    const draft = outcomeDraft();
    const first = await appendAcceptedProjectOutcome(root, draft);
    const second = await appendAcceptedProjectOutcome(root, draft);
    const canonical = createAcceptedOutcomeV0(draft);

    expect(first.outcomes).toEqual([canonical]);
    expect(second.outcomes).toEqual([canonical]);
    expect(second.outcomes[0]?.id).toMatch(/^aco_v0_[a-f0-9]{64}$/);
    await expect(appendAcceptedProjectOutcome(root, {
      ...canonical,
      acceptedAt: "2026-08-17T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "invalid_outcome" });
    await expect(appendAcceptedProjectOutcome(root, {
      ...outcomeDraft("43"),
      businessDescription: {
        value: `Rotated npm_${"c".repeat(32)}`,
        evidence: "user_declared"
      }
    })).rejects.toMatchObject({ code: "invalid_outcome" });
    expect((await loadProjectAccountabilityState(root)).outcomes).toEqual([canonical]);
  });

  it("bounds outcomes and refuses fresh, permissive, or symlinked lock entries", async () => {
    const overflowRoot = await fixtureRoot();
    await writeRawState(overflowRoot, {
      ...emptyEnvelope(),
      ownership: ownership(overflowRoot),
      outcomes: Array.from(
        { length: MAX_PROJECT_ACCOUNTABILITY_OUTCOMES + 1 },
        (_, index) => createAcceptedOutcomeV0(outcomeDraft(String(index + 1)))
      )
    });
    await expect(loadProjectAccountabilityState(overflowRoot)).rejects.toMatchObject({
      code: "outcome_limit_exceeded"
    });

    const lockedRoot = await fixtureRoot();
    const stateDir = await writeRawState(lockedRoot, emptyEnvelope());
    const lockPath = join(stateDir, ".project-accountability.lock");
    await writeFile(lockPath, "other writer\n", { mode: 0o600 });
    await expect(upsertConfirmedProjectOwnership(lockedRoot, ownership(lockedRoot)))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(lockPath, "utf8")).toBe("other writer\n");

    const permissiveRoot = await fixtureRoot();
    const permissiveStateDir = await writeRawState(permissiveRoot, emptyEnvelope());
    const permissiveLock = join(permissiveStateDir, ".project-accountability.lock");
    await writeFile(permissiveLock, "do not replace\n", { mode: 0o666 });
    await chmod(permissiveLock, 0o666);
    await expect(upsertConfirmedProjectOwnership(permissiveRoot, ownership(permissiveRoot)))
      .rejects.toMatchObject({ code: "state_busy" });

    const linkedRoot = await fixtureRoot();
    const linkedStateDir = await writeRawState(linkedRoot, emptyEnvelope());
    const outside = await fixtureRoot();
    const target = join(outside, "lock-target");
    await writeFile(target, "do not remove\n", { mode: 0o600 });
    await symlink(target, join(linkedStateDir, ".project-accountability.lock"));
    await expect(upsertConfirmedProjectOwnership(linkedRoot, ownership(linkedRoot)))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(target, "utf8")).toBe("do not remove\n");
  });

  it("recovers dead-owner and empty SIGKILL locks only after bounded grace", async () => {
    const oldTime = new Date(Date.now() - 10 * 60_000);
    const oldIso = oldTime.toISOString();

    const deadRoot = await fixtureRoot();
    const deadStateDir = await writeRawState(deadRoot, emptyEnvelope());
    const deadLock = join(deadStateDir, ".project-accountability.lock");
    await writeFile(deadLock, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      createdAt: oldIso,
      token: "a".repeat(48)
    })}\n`, { mode: 0o600 });
    await utimes(deadLock, oldTime, oldTime);
    await expect(upsertConfirmedProjectOwnership(deadRoot, ownership(deadRoot)))
      .resolves.toMatchObject({ ownership: expect.objectContaining({
        contract: expect.objectContaining({ status: "confirmed" })
      }) });
    await expect(lstat(deadLock)).rejects.toMatchObject({ code: "ENOENT" });

    const liveRoot = await fixtureRoot();
    const liveStateDir = await writeRawState(liveRoot, emptyEnvelope());
    const liveLock = join(liveStateDir, ".project-accountability.lock");
    const liveContents = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: oldIso,
      token: "b".repeat(48)
    })}\n`;
    await writeFile(liveLock, liveContents, { mode: 0o600 });
    await utimes(liveLock, oldTime, oldTime);
    await expect(upsertConfirmedProjectOwnership(liveRoot, ownership(liveRoot)))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(liveLock, "utf8")).toBe(liveContents);

    const emptyRoot = await fixtureRoot();
    const emptyStateDir = await writeRawState(emptyRoot, emptyEnvelope());
    const emptyLock = join(emptyStateDir, ".project-accountability.lock");
    await writeFile(emptyLock, "", { mode: 0o600 });
    await utimes(emptyLock, oldTime, oldTime);
    await expect(upsertConfirmedProjectOwnership(emptyRoot, ownership(emptyRoot)))
      .resolves.toMatchObject({ ownership: expect.objectContaining({
        contract: expect.objectContaining({ status: "confirmed" })
      }) });
    await expect(lstat(emptyLock)).rejects.toMatchObject({ code: "ENOENT" });

    const freshEmptyRoot = await fixtureRoot();
    const freshStateDir = await writeRawState(freshEmptyRoot, emptyEnvelope());
    const freshLock = join(freshStateDir, ".project-accountability.lock");
    await writeFile(freshLock, "", { mode: 0o600 });
    await expect(upsertConfirmedProjectOwnership(freshEmptyRoot, ownership(freshEmptyRoot)))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(freshLock, "utf8")).toBe("");
  });
});
