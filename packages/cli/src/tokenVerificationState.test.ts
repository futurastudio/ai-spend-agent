import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
  TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
  WASTE_FINDING_V0_KIND,
  WASTE_FINDING_V0_VERSION,
  UnsafeStateDirectoryError,
  UnsafeStateFileError,
  createActionVerificationReference,
  createTokenReductionExperimentV0,
  createWasteFindingV0,
  invalidateTokenReductionExperimentV0,
  markTokenReductionAppliedV0,
  markTokenReductionRolledBackV0,
  type TokenExperimentSessionV0Input,
  type TokenReductionExperimentV0,
  type TokenReductionExperimentV0DraftInput
} from "@agent-finops/core";
import {
  MAX_TOKEN_VERIFICATION_STATE_BYTES,
  MAX_TOKEN_REDUCTION_EXPERIMENTS,
  TOKEN_VERIFICATION_STATE_FILE,
  TOKEN_VERIFICATION_STATE_KIND,
  TOKEN_VERIFICATION_STATE_VERSION,
  TokenVerificationStateError,
  chooseLatestTokenReductionExperiment,
  loadLatestTokenReductionExperiment,
  loadTokenVerificationState,
  upsertTokenReductionExperiment
} from "./tokenVerificationState.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aibill-token-verification-")));
  temporaryRoots.push(root);
  return root;
}

function experiment(
  label: string,
  createdAt = "2026-08-03T12:00:00.000Z",
  scopeLabel = label
): TokenReductionExperimentV0 {
  const projectRef = /^avref_[a-f0-9]{64}$/u.test(scopeLabel)
    ? scopeLabel
    : createActionVerificationReference("project", scopeLabel);
  const workTypeRef = createActionVerificationReference("work-type", "fix-and-test");
  const sourceVersionRef = createActionVerificationReference(
    "source-version",
    "claude-code-2.1.170"
  );
  const finding = createWasteFindingV0({
    kind: WASTE_FINDING_V0_KIND,
    schemaVersion: WASTE_FINDING_V0_VERSION,
    generatedAt: "2026-08-03T00:00:00.000Z",
    window: {
      start: "2026-07-03T00:00:00.000Z",
      end: "2026-08-02T00:00:00.000Z"
    },
    findingType: "high_context_relative_to_baseline",
    objective: {
      metric: "total_tokens_per_matched_session",
      direction: "reduce",
      guard: "user_declared_quality_must_hold"
    },
    caveats: ["signal_not_cause", "no_cash_claim", "missing_outcome_evidence"],
    candidateAction: {
      kind: "trim_context",
      provider: "anthropic",
      surface: "local_agent_configuration",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: {
      kind: "session",
      ref: createActionVerificationReference("session", `${label}:target`)
    },
    scope: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef
    },
    source: {
      id: "claude-code-local",
      validationCoverage: "live_verified",
      freshness: "fresh"
    },
    metric: {
      name: "input_context_tokens",
      unit: "tokens",
      value: 120_000,
      sampleCount: 3,
      evidence: "calculated"
    },
    evidenceRefs: [createActionVerificationReference("evidence", label)],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });

  return createTokenReductionExperimentV0({
    kind: TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
    schemaVersion: TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
    createdAt,
    finding,
    cohort: {
      agent: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-5",
      projectRef,
      sessionType: "parent",
      workTypeRef,
      workTypeEvidence: "observed",
      sourceVersionRef
    },
    matchingPolicy: {
      basis: "session_cohort",
      minimumBaselineSessions: 3,
      minimumPostSessions: 3,
      requireExactSourceVersion: true
    },
    qualityGuard: {
      required: true,
      minimumEvidence: "observed",
      rollbackOnRegression: true
    },
    baselineSessions: [],
    intervention: { approval: { status: "pending", evidence: "missing" } },
    postSessions: []
  });
}

function experimentBody(
  value: TokenReductionExperimentV0
): TokenReductionExperimentV0DraftInput {
  const { id: _id, revisionId: _revisionId, lifecycle: _lifecycle,
    evaluation: _evaluation, ...body } = value;
  return body;
}

function baselineSession(
  baseline: TokenReductionExperimentV0,
  label: string,
  startedAt: string,
  totalTokens: number
): TokenExperimentSessionV0Input {
  return {
    sessionRef: createActionVerificationReference("session", label),
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 30 * 60 * 1_000).toISOString(),
    agent: baseline.cohort.agent,
    provider: baseline.cohort.provider,
    model: baseline.cohort.model,
    projectRef: baseline.cohort.projectRef,
    sessionType: baseline.cohort.sessionType,
    workTypeRef: baseline.cohort.workTypeRef,
    sourceVersionRef: baseline.cohort.sourceVersionRef,
    sourceValidationCoverage: "live_verified",
    tokens: {
      uncachedInputTokens: totalTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      calculatedTotalTokens: totalTokens,
      reportedTotalTokens: null,
      componentEvidence: {
        uncachedInputTokens: "observed",
        cacheReadTokens: "observed",
        cacheWriteTokens: "observed",
        toolTokens: "observed",
        outputTokens: "observed",
        thoughtTokens: "observed",
        calculatedTotalTokens: "calculated_complete",
        reportedTotalTokens: "not_reported"
      }
    },
    quality: {
      status: "passed",
      evidence: "observed",
      evidenceRef: createActionVerificationReference("quality", label)
    }
  };
}

function readyExperiment(
  label: string,
  createdAt = "2026-08-03T12:00:00.000Z",
  scopeLabel = label
): TokenReductionExperimentV0 {
  const draft = experiment(label, createdAt, scopeLabel);
  return createTokenReductionExperimentV0({
    ...experimentBody(draft),
    baselineSessions: [
      baselineSession(draft, `${label}:baseline-1`, "2026-08-01T10:00:00.000Z", 100),
      baselineSession(draft, `${label}:baseline-2`, "2026-08-02T10:00:00.000Z", 120),
      baselineSession(draft, `${label}:baseline-3`, "2026-08-03T10:00:00.000Z", 140)
    ]
  });
}

function appliedExperiment(
  baseline: TokenReductionExperimentV0,
  label: string,
  canaryStatus: "passed" | "failed" = "passed"
): TokenReductionExperimentV0 {
  return markTokenReductionAppliedV0(baseline, {
    approvedAt: "2026-08-04T09:55:00.000Z",
    appliedAt: "2026-08-04T10:00:00.000Z",
    changeRef: createActionVerificationReference("change", label),
    rollbackRef: createActionVerificationReference("rollback", label),
    canaryRef: createActionVerificationReference("canary", label),
    canaryStatus
  });
}

function completeExperiment(
  baseline: TokenReductionExperimentV0,
  label: string
): TokenReductionExperimentV0 {
  const applied = appliedExperiment(baseline, label);
  return createTokenReductionExperimentV0({
    ...experimentBody(applied),
    postSessions: [
      baselineSession(applied, `${label}:post-1`, "2026-08-05T10:00:00.000Z", 80),
      baselineSession(applied, `${label}:post-2`, "2026-08-06T10:00:00.000Z", 90),
      baselineSession(applied, `${label}:post-3`, "2026-08-07T10:00:00.000Z", 100)
    ]
  });
}

async function writeRawState(root: string, value: unknown): Promise<string> {
  const stateDir = join(root, ".ai-spend-agent");
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(
    join(stateDir, TOKEN_VERIFICATION_STATE_FILE),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
  return stateDir;
}

function envelope(root: string, experiments: TokenReductionExperimentV0[]) {
  return {
    kind: TOKEN_VERIFICATION_STATE_KIND,
    schemaVersion: TOKEN_VERIFICATION_STATE_VERSION,
    rootRef: createActionVerificationReference("token-experiment-state-root", root),
    experiments
  };
}

function actionProjectRef(root: string): string {
  return createActionVerificationReference("project-working-directory", root);
}

describe("token verification state", () => {
  it("atomically creates, exactly upserts, reloads, and chooses the latest experiment", async () => {
    const root = await fixtureRoot();
    const olderDraft = experiment("older", undefined, actionProjectRef(root));
    const older = invalidateTokenReductionExperimentV0(olderDraft, {
      invalidatedAt: "2026-08-03T13:00:00.000Z",
      reason: "manual"
    });
    const newer = experiment("newer", "2026-08-04T12:00:00.000Z", actionProjectRef(root));

    expect(await loadTokenVerificationState(root)).toEqual(envelope(root, []));
    await upsertTokenReductionExperiment(root, older);
    await upsertTokenReductionExperiment(root, newer);
    const state = await upsertTokenReductionExperiment(root, older);

    expect(state.experiments).toHaveLength(2);
    expect(state.experiments.map((item) => item.id)).toEqual([older.id, newer.id]);
    expect(chooseLatestTokenReductionExperiment(state.experiments)?.id).toBe(newer.id);
    expect((await loadLatestTokenReductionExperiment(root))?.id).toBe(newer.id);
    expect(await loadTokenVerificationState(root)).toEqual(state);

    const stored = await readFile(
      join(root, ".ai-spend-agent", TOKEN_VERIFICATION_STATE_FILE),
      "utf8"
    );
    expect(stored.endsWith("\n")).toBe(true);
    expect(stored).not.toContain("/private/customer");
  });

  it("fails closed on malformed envelopes and tampered experiments", async () => {
    const malformedRoot = await fixtureRoot();
    await writeRawState(malformedRoot, "{not-json");
    await expect(loadTokenVerificationState(malformedRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const oversizedRoot = await fixtureRoot();
    await writeRawState(
      oversizedRoot,
      "x".repeat(MAX_TOKEN_VERIFICATION_STATE_BYTES + 1)
    );
    await expect(loadTokenVerificationState(oversizedRoot)).rejects.toThrow(
      /exceeds 1000000 bytes/u
    );

    const extraKeyRoot = await fixtureRoot();
    await writeRawState(extraKeyRoot, { ...envelope(extraKeyRoot, []), unexpected: true });
    await expect(loadTokenVerificationState(extraKeyRoot)).rejects.toBeInstanceOf(
      TokenVerificationStateError
    );

    const tamperedRoot = await fixtureRoot();
    const valid = experiment("tamper-target", undefined, actionProjectRef(tamperedRoot));
    await writeRawState(tamperedRoot, envelope(tamperedRoot, [{
      ...valid,
      evaluation: { ...valid.evaluation, reductionPercent: 99 }
    }] as TokenReductionExperimentV0[]));
    await expect(loadTokenVerificationState(tamperedRoot)).rejects.toMatchObject({
      code: "malformed_state"
    });

    const inputRoot = await fixtureRoot();
    await expect(upsertTokenReductionExperiment(inputRoot, {
      ...valid,
      lifecycle: "complete"
    })).rejects.toMatchObject({ code: "invalid_experiment" });
  });

  it("rejects duplicate IDs and refuses to evict evidence past the 100-entry bound", async () => {
    const duplicateRoot = await fixtureRoot();
    const duplicate = experiment("duplicate", undefined, actionProjectRef(duplicateRoot));
    await writeRawState(duplicateRoot, envelope(duplicateRoot, [duplicate, duplicate]));
    await expect(loadTokenVerificationState(duplicateRoot)).rejects.toMatchObject({
      code: "duplicate_experiment_id"
    });

    const fullRoot = await fixtureRoot();
    const full = Array.from({ length: MAX_TOKEN_REDUCTION_EXPERIMENTS }, (_, index) => {
      const draft = experiment(`bounded-${index}`, undefined, actionProjectRef(fullRoot));
      return invalidateTokenReductionExperimentV0(draft, {
        invalidatedAt: "2026-08-04T13:00:00.000Z",
        reason: "manual"
      });
    });
    await writeRawState(fullRoot, envelope(fullRoot, full));
    await expect(upsertTokenReductionExperiment(fullRoot, full[0])).resolves.toMatchObject({
      experiments: expect.arrayContaining([expect.objectContaining({ id: full[0]!.id })])
    });
    await expect(upsertTokenReductionExperiment(
      fullRoot,
      experiment("bounded-overflow", undefined, actionProjectRef(fullRoot))
    )).rejects.toMatchObject({ code: "experiment_limit_exceeded" });

    const oversizedRoot = await fixtureRoot();
    await writeRawState(oversizedRoot, envelope(oversizedRoot, [
      ...full,
      experiment("stored-overflow", undefined, actionProjectRef(oversizedRoot))
    ]));
    await expect(loadTokenVerificationState(oversizedRoot)).rejects.toMatchObject({
      code: "experiment_limit_exceeded"
    });
  });

  it("rejects a persisted envelope with two active experiments in one scope", async () => {
    const root = await fixtureRoot();
    const scope = actionProjectRef(root);
    const first = experiment("active-envelope-first", undefined, scope);
    const second = experiment(
      "active-envelope-second",
      "2026-08-04T12:00:00.000Z",
      scope
    );
    await writeRawState(root, envelope(root, [first, second]));

    await expect(loadTokenVerificationState(root)).rejects.toMatchObject({
      code: "active_scope_conflict"
    });
  });

  it("refuses symlinked state directories and state files", async () => {
    const linkedDirectoryRoot = await fixtureRoot();
    const outside = await fixtureRoot();
    await symlink(outside, join(linkedDirectoryRoot, ".ai-spend-agent"));
    await expect(loadTokenVerificationState(linkedDirectoryRoot)).rejects.toBeInstanceOf(
      UnsafeStateDirectoryError
    );

    const linkedFileRoot = await fixtureRoot();
    const stateDir = join(linkedFileRoot, ".ai-spend-agent");
    await mkdir(stateDir, { mode: 0o700 });
    const target = join(outside, "target.json");
    await writeFile(target, `${JSON.stringify(envelope(linkedFileRoot, []))}\n`, "utf8");
    await symlink(target, join(stateDir, TOKEN_VERIFICATION_STATE_FILE));
    await expect(loadTokenVerificationState(linkedFileRoot)).rejects.toBeInstanceOf(
      UnsafeStateFileError
    );
  });

  it("recovers abandoned owned and legacy locks but never evicts a live owner", async () => {
    const deadRoot = await fixtureRoot();
    const deadStateDir = await writeRawState(deadRoot, envelope(deadRoot, []));
    const deadLock = join(deadStateDir, ".token-reduction-experiments.lock");
    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(deadLock, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      createdAt: oldIso,
      token: "a".repeat(48)
    })}\n`, { mode: 0o600 });
    const oldTime = new Date(Date.now() - 10 * 60_000);
    await utimes(deadLock, oldTime, oldTime);
    await expect(upsertTokenReductionExperiment(
      deadRoot,
      experiment("dead-lock", undefined, actionProjectRef(deadRoot))
    ))
      .resolves.toMatchObject({ experiments: [expect.objectContaining({ lifecycle: "draft" })] });
    await expect(lstat(deadLock)).rejects.toMatchObject({ code: "ENOENT" });

    const liveRoot = await fixtureRoot();
    const liveStateDir = await writeRawState(liveRoot, envelope(liveRoot, []));
    const liveLock = join(liveStateDir, ".token-reduction-experiments.lock");
    const liveContents = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: oldIso,
      token: "b".repeat(48)
    })}\n`;
    await writeFile(liveLock, liveContents, { mode: 0o600 });
    await utimes(liveLock, oldTime, oldTime);
    await expect(upsertTokenReductionExperiment(
      liveRoot,
      experiment("live-lock", undefined, actionProjectRef(liveRoot))
    ))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(liveLock, "utf8")).toBe(liveContents);

    const legacyRoot = await fixtureRoot();
    const legacyStateDir = await writeRawState(legacyRoot, envelope(legacyRoot, []));
    const legacyLock = join(legacyStateDir, ".token-reduction-experiments.lock");
    await mkdir(legacyLock, { mode: 0o700 });
    await utimes(legacyLock, oldTime, oldTime);
    await expect(upsertTokenReductionExperiment(
      legacyRoot,
      experiment("legacy-lock", undefined, actionProjectRef(legacyRoot))
    ))
      .resolves.toMatchObject({ experiments: [expect.objectContaining({ lifecycle: "draft" })] });
    await expect(lstat(legacyLock)).rejects.toMatchObject({ code: "ENOENT" });

    const interruptedRoot = await fixtureRoot();
    const interruptedStateDir = await writeRawState(
      interruptedRoot,
      envelope(interruptedRoot, [])
    );
    const interruptedLock = join(
      interruptedStateDir,
      ".token-reduction-experiments.lock"
    );
    // Exact SIGKILL window: O_EXCL created the private file but the owner
    // record was never written.
    await writeFile(interruptedLock, "", { mode: 0o600 });
    await utimes(interruptedLock, oldTime, oldTime);
    await expect(upsertTokenReductionExperiment(
      interruptedRoot,
      experiment("interrupted-lock", undefined, actionProjectRef(interruptedRoot))
    )).resolves.toMatchObject({
      experiments: [expect.objectContaining({ lifecycle: "draft" })]
    });
    await expect(lstat(interruptedLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails busy on fresh, malformed, or symlinked lock ownership", async () => {
    const freshRoot = await fixtureRoot();
    const freshStateDir = await writeRawState(freshRoot, envelope(freshRoot, []));
    const freshLock = join(freshStateDir, ".token-reduction-experiments.lock");
    await mkdir(freshLock, { mode: 0o700 });
    await expect(upsertTokenReductionExperiment(
      freshRoot,
      experiment("fresh-lock", undefined, actionProjectRef(freshRoot))
    ))
      .rejects.toMatchObject({ code: "state_busy" });

    const malformedRoot = await fixtureRoot();
    const malformedStateDir = await writeRawState(
      malformedRoot,
      envelope(malformedRoot, [])
    );
    const malformedLock = join(malformedStateDir, ".token-reduction-experiments.lock");
    await writeFile(malformedLock, "unknown owner\n", { mode: 0o600 });
    await expect(upsertTokenReductionExperiment(
      malformedRoot,
      experiment("malformed-lock", undefined, actionProjectRef(malformedRoot))
    ))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(malformedLock, "utf8")).toBe("unknown owner\n");

    const linkedRoot = await fixtureRoot();
    const linkedStateDir = await writeRawState(linkedRoot, envelope(linkedRoot, []));
    const outside = await fixtureRoot();
    const target = join(outside, "unrelated-lock-target");
    await writeFile(target, "do not remove\n", { mode: 0o600 });
    await symlink(target, join(linkedStateDir, ".token-reduction-experiments.lock"));
    await expect(upsertTokenReductionExperiment(
      linkedRoot,
      experiment("linked-lock", undefined, actionProjectRef(linkedRoot))
    ))
      .rejects.toMatchObject({ code: "state_busy" });
    expect(await readFile(target, "utf8")).toBe("do not remove\n");
  });

  it("enforces compare-and-swap and rejects lifecycle regression without changing stored evidence", async () => {
    const root = await fixtureRoot();
    const baseline = readyExperiment("cas", undefined, actionProjectRef(root));
    const applied = appliedExperiment(baseline, "cas");
    await upsertTokenReductionExperiment(root, baseline);

    await expect(upsertTokenReductionExperiment(root, applied, {
      expectedRevisionId: "trev_v0_" + "f".repeat(64)
    })).rejects.toMatchObject({ code: "stale_revision" });
    expect((await loadTokenVerificationState(root)).experiments[0]?.revisionId)
      .toBe(baseline.revisionId);

    await upsertTokenReductionExperiment(root, applied, {
      expectedRevisionId: baseline.revisionId
    });
    await expect(upsertTokenReductionExperiment(root, baseline, {
      expectedRevisionId: applied.revisionId
    })).rejects.toMatchObject({ code: "lifecycle_regression" });
    expect((await loadTokenVerificationState(root)).experiments[0]?.revisionId)
      .toBe(applied.revisionId);
  });

  it("blocks a second active experiment in one exact scope until the first is cancelled", async () => {
    const root = await fixtureRoot();
    const first = readyExperiment(
      "active-first",
      "2026-08-03T12:00:00.000Z",
      actionProjectRef(root)
    );
    const second = readyExperiment(
      "active-second",
      "2026-08-04T12:00:00.000Z",
      actionProjectRef(root)
    );
    expect(first.id).not.toBe(second.id);
    expect(first.cohort).toMatchObject({
      projectRef: second.cohort.projectRef,
      provider: second.cohort.provider,
      agent: second.cohort.agent
    });

    await upsertTokenReductionExperiment(root, first);
    await expect(upsertTokenReductionExperiment(root, second)).rejects.toMatchObject({
      code: "active_scope_conflict"
    });
    const cancelled = invalidateTokenReductionExperimentV0(first, {
      invalidatedAt: "2026-08-04T13:00:00.000Z",
      reason: "manual"
    });
    await upsertTokenReductionExperiment(root, cancelled, {
      expectedRevisionId: first.revisionId
    });
    await expect(upsertTokenReductionExperiment(root, second)).resolves.toMatchObject({
      experiments: expect.arrayContaining([
        expect.objectContaining({ id: first.id, lifecycle: "invalidated" }),
        expect.objectContaining({ id: second.id, lifecycle: "baseline_ready" })
      ])
    });
  });

  it("persists a failed canary, requires the frozen rollback, and makes rollback immutable", async () => {
    const root = await fixtureRoot();
    const baseline = readyExperiment(
      "rollback-state",
      undefined,
      actionProjectRef(root)
    );
    const failed = appliedExperiment(baseline, "rollback-state", "failed");
    await upsertTokenReductionExperiment(root, baseline);
    await upsertTokenReductionExperiment(root, failed, {
      expectedRevisionId: baseline.revisionId
    });

    const persistedFailed = (await loadTokenVerificationState(root)).experiments[0]!;
    expect(persistedFailed).toMatchObject({
      id: baseline.id,
      lifecycle: "applied",
      intervention: { canary: { status: "failed", evidence: "user_declared" } },
      evaluation: { rollbackRecommended: true, reductionPercent: null }
    });
    expect(persistedFailed.intervention.rolledBackAt).toBeUndefined();
    expect(() => markTokenReductionRolledBackV0(persistedFailed, {
      rolledBackAt: "2026-08-04T10:10:00.000Z",
      rollbackRef: createActionVerificationReference("rollback", "wrong")
    })).toThrow(/does not match/);
    expect((await loadTokenVerificationState(root)).experiments[0]?.revisionId)
      .toBe(failed.revisionId);

    const rolledBack = markTokenReductionRolledBackV0(persistedFailed, {
      rolledBackAt: "2026-08-04T10:10:00.000Z",
      rollbackRef: persistedFailed.intervention.rollbackRef!
    });
    await upsertTokenReductionExperiment(root, rolledBack, {
      expectedRevisionId: failed.revisionId
    });
    expect((await loadTokenVerificationState(root)).experiments[0]).toMatchObject({
      lifecycle: "rolled_back",
      intervention: { rolledBackAt: "2026-08-04T10:10:00.000Z" },
      evaluation: { status: "inconclusive", reductionPercent: null }
    });
    expect(() => markTokenReductionRolledBackV0(rolledBack, {
      rolledBackAt: "2026-08-04T10:20:00.000Z",
      rollbackRef: rolledBack.intervention.rollbackRef!
    })).toThrow(/terminal.*another rollback boundary/i);

    const rewrittenRollback = createTokenReductionExperimentV0({
      ...experimentBody(rolledBack),
      intervention: {
        ...rolledBack.intervention,
        rolledBackAt: "2026-08-04T10:20:00.000Z"
      }
    });
    await expect(upsertTokenReductionExperiment(root, rewrittenRollback, {
      expectedRevisionId: rolledBack.revisionId
    })).rejects.toMatchObject({ code: "immutable_evidence_changed" });
    expect((await loadTokenVerificationState(root)).experiments[0]?.revisionId)
      .toBe(rolledBack.revisionId);
  });

  it("prioritizes an active applied experiment over newer draft and terminal history", () => {
    const active = appliedExperiment(readyExperiment("priority-active"), "priority-active");
    const newerDraft = experiment("priority-draft", "2026-08-10T12:00:00.000Z");
    const terminalBase = readyExperiment("priority-terminal", "2026-08-11T12:00:00.000Z");
    const terminal = invalidateTokenReductionExperimentV0(terminalBase, {
      invalidatedAt: "2026-08-11T13:00:00.000Z",
      reason: "manual"
    });

    expect(chooseLatestTokenReductionExperiment([newerDraft, terminal, active])?.id)
      .toBe(active.id);
  });

  it("freezes a completed result and permits only its exact recorded rollback", async () => {
    const root = await fixtureRoot();
    const complete = completeExperiment(
      readyExperiment("complete-freeze", undefined, actionProjectRef(root)),
      "complete-freeze"
    );
    expect(complete.lifecycle).toBe("complete");
    await upsertTokenReductionExperiment(root, complete);

    const appended = createTokenReductionExperimentV0({
      ...experimentBody(complete),
      postSessions: [
        ...complete.postSessions,
        baselineSession(
          complete,
          "complete-freeze:late-post",
          "2026-08-08T10:00:00.000Z",
          70
        )
      ]
    });
    await expect(upsertTokenReductionExperiment(root, appended, {
      expectedRevisionId: complete.revisionId
    })).rejects.toMatchObject({ code: "lifecycle_regression" });

    expect(() => createTokenReductionExperimentV0({
      ...experimentBody(complete),
      invalidation: { reason: "manual", invalidatedAt: "2026-08-08T11:00:00.000Z" }
    })).toThrow(/applied intervention cannot be invalidated.*rolled back/i);
    expect((await loadTokenVerificationState(root)).experiments[0]?.revisionId)
      .toBe(complete.revisionId);

    const rolledBack = markTokenReductionRolledBackV0(complete, {
      rolledBackAt: "2026-08-08T12:00:00.000Z",
      rollbackRef: complete.intervention.rollbackRef!
    });
    await expect(upsertTokenReductionExperiment(root, rolledBack, {
      expectedRevisionId: complete.revisionId
    })).resolves.toMatchObject({
      experiments: expect.arrayContaining([
        expect.objectContaining({ id: complete.id, lifecycle: "rolled_back" })
      ])
    });
  });
});
