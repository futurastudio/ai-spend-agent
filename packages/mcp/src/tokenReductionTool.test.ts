import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
  TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
  WASTE_FINDING_V0_KIND,
  WASTE_FINDING_V0_VERSION,
  buildActionVerificationProjectionV0,
  createActionPlanningSourceVersionReferenceV0,
  createActionVerificationReference,
  createTokenReductionExperimentV0,
  createWasteFindingV0,
  extractSessionVitalsV0,
  loadLocalAgentUsage,
  refreshTokenReductionExperimentV0,
  type TokenReductionExperimentV0
} from "@agent-finops/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTokenReductionTestTool } from "./index.js";
import { createServer } from "./server.js";
import { MALFORMED_LOCAL_STATE_MESSAGE } from "./errors.js";
import { runCli } from "../../cli/src/index.js";

const createdAt = "2026-08-10T20:00:00.000Z";
const appliedAt = "2026-08-11T12:00:00.000Z";
const project = "token-lab";
const model = "claude-opus-4-8";
const workTypeRef = createActionVerificationReference(
  "coarse-work-type",
  "project:working"
);
const hostVersion = "2.1.170";
const sourceVersionRef = createActionPlanningSourceVersionReferenceV0(
  "claude-code",
  hostVersion
)!;

beforeEach(async () => {
  vi.stubEnv("AIBILL_CACHE_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-read-only-cache-")));
});

async function tokenStateEnvelope(
  root: string,
  experiments: TokenReductionExperimentV0[]
) {
  const canonicalRoot = await realpath(root);
  return {
    kind: "aibill.token_reduction_experiment_store",
    schemaVersion: 1,
    rootRef: createActionVerificationReference(
      "token-experiment-state-root",
      canonicalRoot
    ),
    experiments
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("get_token_reduction_test", () => {
  it.each([
    { name: "collecting", totals: [70], quality: "missing", status: "collecting" },
    {
      name: "measured",
      totals: [70, 75, 80],
      quality: "passed",
      status: "measured_token_reduction"
    },
    {
      name: "regressed",
      totals: [130, 140, 150],
      quality: "passed",
      status: "regressed"
    },
    {
      name: "inconclusive",
      totals: [70, 75, 80],
      quality: "missing",
      status: "inconclusive"
    }
  ])("refreshes a $name result through the canonical evaluator", async ({
    totals,
    quality,
    status
  }) => {
    const fixture = await resultFixture(totals, quality as "passed" | "missing");

    const result = await getTokenReductionTestTool({ path: fixture.root });

    expect(result.status).toBe("available");
    expect(result.experiment).toEqual(fixture.expected);
    expect(result.experiment?.evaluation.status).toBe(status);
    expect(result.projection).toEqual(
      buildActionVerificationProjectionV0(fixture.expected)
    );
    const frozen = fixture.expected.lifecycle === "complete";
    expect(result.coverage).toMatchObject({
      supportedAgents: ["claude-code", "codex"],
      sessionsObserved: frozen ? 0 : totals.length,
      sessionsWithObservedTokens: frozen ? 0 : totals.length
    });
    expect(result.provenance).toEqual({
      state: frozen
        ? "persisted_experiment_store"
        : "persisted_experiment_plus_fresh_local_transcripts",
      readOnly: true,
      uploaded: false
    });
    expect(await readFile(fixture.statePath, "utf8")).toBe(fixture.beforeRead);
  });

  it("returns an honest empty result for missing state and a safe not-found result", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-mcp-token-empty-"));
    const empty = await getTokenReductionTestTool({ path: root });
    expect(empty).toMatchObject({
      status: "no_test",
      experiment: null,
      projection: null,
      provenance: { state: "missing", readOnly: true, uploaded: false }
    });
    expect(empty.nextStep).toBe(
      "The guided test is source-preview-only: from the built checkout root run `npx aibill improve`."
    );

    const fixture = await resultFixture([70], "missing");
    const missingId = `tre_v0_${"f".repeat(64)}`;
    const notFound = await getTokenReductionTestTool({
      path: fixture.root,
      experimentId: missingId
    });
    expect(notFound).toMatchObject({
      status: "not_found",
      experiment: null,
      projection: null,
      provenance: { state: "persisted_experiment_store" }
    });
  });

  it("never creates or updates the private qualitative cache", async () => {
    const fixture = await resultFixture([70], "missing");
    await getTokenReductionTestTool({ path: fixture.root });

    await expect(lstat(join(
      process.env.AIBILL_CACHE_DIR!,
      "qualitative-index-v1.json"
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("foregrounds an older active test over newer terminal history like CLI and Glance", async () => {
    const fixture = await resultFixture([70, 75, 80], "passed");
    const projectRef = createActionVerificationReference(
      "project-working-directory",
      fixture.root
    );
    const active = appliedExperiment(
      projectRef,
      "2026-08-09T20:00:00.000Z",
      "2026-08-10T12:00:00.000Z"
    );
    const terminal = fixture.expected;
    expect(terminal.lifecycle).toBe("complete");
    await writeFile(
      fixture.statePath,
      `${JSON.stringify(await tokenStateEnvelope(
        fixture.root,
        [terminal, active]
      ), null, 2)}\n`
    );

    const result = await getTokenReductionTestTool({ path: fixture.root });

    expect(result.status).toBe("available");
    expect(result.experiment?.id).toBe(active.id);
    expect(result.experiment?.createdAt).toBe("2026-08-09T20:00:00.000Z");
  });

  it("excludes the current active session from the matched post-change cohort", async () => {
    const fixture = await resultFixture([70, 75], "passed");
    await writeClaudeSession(
      join(fixture.claudeLogs, "active.jsonl"),
      fixture.root,
      "active-session",
      new Date().toISOString(),
      10
    );

    const result = await getTokenReductionTestTool({ path: fixture.root });

    expect(result.coverage.sessionsObserved).toBe(3);
    expect(result.experiment?.evaluation).toMatchObject({
      status: "collecting",
      postChange: { includedSessions: 2 }
    });
  });

  it("keeps same-basename projects isolated by opaque working-directory identity", async () => {
    const fixture = await resultFixture([70, 75], "passed");
    const otherRoot = await mkdtemp(join(tmpdir(), "aibill-mcp-same-basename-other-"));
    for (let index = 0; index < 3; index += 1) {
      await writeClaudeSession(
        join(fixture.claudeLogs, `other-project-${index}.jsonl`),
        join(otherRoot, project),
        `other-project-session-${index}`,
        new Date(Date.parse(appliedAt) + (index + 1) * 90 * 60 * 1_000).toISOString(),
        900 + index * 100
      );
    }

    const result = await getTokenReductionTestTool({ path: fixture.root });

    expect(result.coverage.sessionsObserved).toBe(2);
    expect(result.experiment).toEqual(fixture.expected);
    expect(result.experiment?.evaluation.postChange.includedSessions).toBe(2);
    expect(result.experiment?.evaluation.reductionPercent).toBe(
      fixture.expected.evaluation.reductionPercent
    );
  });

  it("returns the exact canonical experiment and projection emitted by CLI JSON", async () => {
    const container = await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-root-"));
    const root = join(container, project);
    await mkdir(root);
    const claudeLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-claude-"));
    const codexLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-codex-"));
    const geminiLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-gemini-"));
    vi.stubEnv("AI_SPEND_CLAUDE_LOGS_DIR", claudeLogs);
    vi.stubEnv("AI_SPEND_CODEX_LOGS_DIR", codexLogs);
    vi.stubEnv("AI_SPEND_GEMINI_LOGS_DIR", geminiLogs);
    vi.stubEnv("AI_SPEND_CLAUDE_HOME_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-home-")));
    vi.stubEnv("AI_SPEND_CODEX_HOME_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-cli-equality-codex-home-")));
    vi.stubEnv("AI_SPEND_CLAUDE_CONFIG", join(process.env.AI_SPEND_CLAUDE_HOME_DIR!, "missing.json"));
    vi.stubEnv("AI_SPEND_CLAUDE_SETTINGS", join(process.env.AI_SPEND_CLAUDE_HOME_DIR!, "missing-settings.json"));
    vi.stubEnv("AI_SPEND_CODEX_AUTH", join(process.env.AI_SPEND_CODEX_HOME_DIR!, "missing-auth.json"));
    const cwd = await realpath(root);

    for (const [index, hoursAgo] of [72, 48, 24].entries()) {
      await writeClaudeSession(
        join(claudeLogs, `baseline-${index}.jsonl`),
        cwd,
        `cli-baseline-${index}`,
        new Date(Date.now() - hoursAgo * 60 * 60 * 1_000).toISOString(),
        100 + index * 10
      );
    }
    await writeClaudeSession(
      join(claudeLogs, "active-high.jsonl"),
      cwd,
      "cli-active-high",
      new Date(Date.now() - 2 * 60 * 1_000).toISOString(),
      500
    );

    const apply = await runCli(["apply", "--path", root]);
    expect(apply.exitCode).toBe(0);
    const candidateKey = apply.stdout.match(/Candidate key: (wfc_v0_[a-f0-9]{64})/)?.[1];
    expect(candidateKey).toBeTruthy();
    const started = await runCli([
      "verify", "start", candidateKey!, "--quality", "held", "--path", root
    ]);
    const experimentId = started.stdout.match(/experiment: (tre_v0_[a-f0-9]{64})/)?.[1];
    expect(started.exitCode).toBe(0);
    expect(experimentId).toBeTruthy();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
    const approvedAt = new Date().toISOString();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
    const interventionAppliedAt = new Date().toISOString();
    const applied = await runCli([
      "verify", "mark-applied", experimentId!,
      "--approved-at", approvedAt,
      "--applied-at", interventionAppliedAt,
      "--canary", "passed",
      "--change-digest", "a".repeat(64),
      "--rollback-digest", "b".repeat(64),
      "--canary-digest", "c".repeat(64),
      "--path", root
    ]);
    expect(applied.exitCode).toBe(0);

    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      await writeClaudeSession(
        join(claudeLogs, `post-cli-${index}.jsonl`),
        cwd,
        `cli-post-${index}`,
        new Date().toISOString(),
        50 + index
      );
    }
    const cli = await runCli([
      "verify", experimentId!, "--quality", "held", "--json", "--path", root
    ]);
    expect(cli.exitCode).toBe(0);
    const cliContract = JSON.parse(cli.stdout) as {
      experiment: TokenReductionExperimentV0;
      projection: unknown;
    };
    const statePath = join(root, ".ai-spend-agent", "token-reduction-experiments.json");
    const beforeMcpRead = await readFile(statePath, "utf8");
    const stored = JSON.parse(beforeMcpRead) as {
      experiments: TokenReductionExperimentV0[];
    };
    expect(stored.experiments).toHaveLength(1);
    expect(stored.experiments[0]?.id).toBe(experimentId);

    const mcp = await getTokenReductionTestTool({
      path: root,
      experimentId
    });

    expect(mcp.experiment).toEqual(cliContract.experiment);
    expect(mcp.projection).toEqual(cliContract.projection);
    expect(mcp.experiment?.evaluation.status).toBe("measured_token_reduction");
    expect(JSON.stringify(mcp)).not.toContain(root);
    expect(JSON.stringify(mcp)).not.toContain(cwd);
    expect(await readFile(statePath, "utf8")).toBe(beforeMcpRead);
  }, 15_000);

  it("keeps CLI and MCP equal for post sessions older than the receipt's 30-day default", async () => {
    const container = await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-root-"));
    const root = join(container, project);
    await mkdir(root);
    const claudeLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-claude-"));
    const codexLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-codex-"));
    vi.stubEnv("AI_SPEND_CLAUDE_LOGS_DIR", claudeLogs);
    vi.stubEnv("AI_SPEND_CODEX_LOGS_DIR", codexLogs);
    vi.stubEnv("AI_SPEND_GEMINI_LOGS_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-gemini-")));
    vi.stubEnv("AI_SPEND_CLAUDE_HOME_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-home-")));
    vi.stubEnv("AI_SPEND_CODEX_HOME_DIR", await mkdtemp(join(tmpdir(), "aibill-mcp-aged-equality-codex-home-")));
    vi.stubEnv("AI_SPEND_CLAUDE_CONFIG", join(process.env.AI_SPEND_CLAUDE_HOME_DIR!, "missing.json"));
    vi.stubEnv("AI_SPEND_CLAUDE_SETTINGS", join(process.env.AI_SPEND_CLAUDE_HOME_DIR!, "missing-settings.json"));
    vi.stubEnv("AI_SPEND_CODEX_AUTH", join(process.env.AI_SPEND_CODEX_HOME_DIR!, "missing-auth.json"));
    const cwd = await realpath(root);
    const agedCreatedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
    const agedAppliedAt = new Date(Date.now() - 44 * 24 * 60 * 60 * 1_000).toISOString();
    const aged = appliedExperiment(
      createActionVerificationReference("project-working-directory", cwd),
      agedCreatedAt,
      agedAppliedAt
    );

    for (let index = 0; index < 3; index += 1) {
      await writeClaudeSession(
        join(claudeLogs, `aged-post-${index}.jsonl`),
        cwd,
        `aged-post-session-${index}`,
        new Date(Date.parse(agedAppliedAt) + (index + 1) * 24 * 60 * 60 * 1_000).toISOString(),
        70 + index * 5
      );
    }
    const logs = await loadLocalAgentUsage({
      claudeProjectsDir: claudeLogs,
      codexSessionsDir: codexLogs,
      geminiSessionsDir: undefined,
      sinceIso: agedAppliedAt,
      collectCodexInvocationEvidence: true
    });
    const vitals = extractSessionVitalsV0(logs.calls);
    const qualityBySessionRef = Object.fromEntries(
      vitals.sessions.map((session) => [session.sessionRef, "passed"])
    );
    const completed = refreshTokenReductionExperimentV0(aged, {
      sessionVitals: vitals,
      observedAt: new Date().toISOString(),
      qualityBySessionRef
    });
    const stateDir = join(root, ".ai-spend-agent");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(
      join(stateDir, "token-reduction-experiments.json"),
      `${JSON.stringify(await tokenStateEnvelope(root, [completed]), null, 2)}\n`
    );

    const cli = await runCli(["verify", completed.id, "--json", "--path", root]);
    const mcp = await getTokenReductionTestTool({ path: root, experimentId: completed.id });

    expect(cli.exitCode).toBe(0);
    const cliContract = JSON.parse(cli.stdout) as {
      experiment: TokenReductionExperimentV0;
      projection: unknown;
    };
    expect(cliContract.experiment.evaluation.postChange.includedSessions).toBe(3);
    expect(mcp.experiment).toEqual(cliContract.experiment);
    expect(mcp.projection).toEqual(cliContract.projection);
  }, 15_000);

  it("rejects malformed, tampered, duplicate, and symlinked state without leaking content", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-mcp-token-hostile-"));
    const stateDir = join(root, ".ai-spend-agent");
    const statePath = join(stateDir, "token-reduction-experiments.json");
    const secret = "npm_synthetic_token_must_not_survive";
    const privatePath = "/workspace/private/.ssh/id_ed25519";
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(statePath, `{not-json ${secret} ${privatePath}\n`);
    await expect(getTokenReductionTestTool({ path: root })).rejects.toThrow(
      MALFORMED_LOCAL_STATE_MESSAGE
    );

    await writeFile(statePath, "x".repeat(1_000_001));
    await expect(getTokenReductionTestTool({ path: root })).rejects.toThrow(
      /exceeds 1000000 bytes/u
    );

    const fixture = await resultFixture([70], "missing");
    const envelope = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      experiments: Array<Record<string, unknown>>;
    };
    envelope.experiments[0]!.evaluation = { status: "measured_token_reduction" };
    await writeFile(fixture.statePath, JSON.stringify(envelope));
    await expect(getTokenReductionTestTool({ path: fixture.root })).rejects.toThrow(
      MALFORMED_LOCAL_STATE_MESSAGE
    );

    const duplicateFixture = await resultFixture([70], "missing");
    const duplicate = JSON.parse(await readFile(duplicateFixture.statePath, "utf8")) as {
      experiments: unknown[];
    };
    duplicate.experiments.push(duplicate.experiments[0]);
    await writeFile(duplicateFixture.statePath, JSON.stringify(duplicate));
    await expect(getTokenReductionTestTool({ path: duplicateFixture.root })).rejects.toThrow(
      MALFORMED_LOCAL_STATE_MESSAGE
    );

    const activeConflictFixture = await resultFixture([70], "missing");
    const activeConflictProjectRef = createActionVerificationReference(
      "project-working-directory",
      activeConflictFixture.root
    );
    const activeConflict = JSON.parse(
      await readFile(activeConflictFixture.statePath, "utf8")
    ) as { experiments: TokenReductionExperimentV0[] };
    activeConflict.experiments.push(appliedExperiment(
      activeConflictProjectRef,
      "2026-08-09T20:00:00.000Z",
      "2026-08-10T12:00:00.000Z"
    ));
    await writeFile(
      activeConflictFixture.statePath,
      `${JSON.stringify(activeConflict, null, 2)}\n`
    );
    await expect(
      getTokenReductionTestTool({ path: activeConflictFixture.root })
    ).rejects.toThrow(MALFORMED_LOCAL_STATE_MESSAGE);

    const symlinkRoot = await mkdtemp(join(tmpdir(), "aibill-mcp-token-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "aibill-mcp-token-link-outside-"));
    await writeFile(join(outside, "private.json"), `${secret} ${privatePath}`);
    await mkdir(join(symlinkRoot, ".ai-spend-agent"), { mode: 0o700 });
    await symlink(
      join(outside, "private.json"),
      join(symlinkRoot, ".ai-spend-agent", "token-reduction-experiments.json")
    );
    let symlinkMessage = "";
    try {
      await getTokenReductionTestTool({ path: symlinkRoot });
    } catch (error) {
      symlinkMessage = error instanceof Error ? error.message : String(error);
    }
    expect(symlinkMessage).toMatch(/symbolic link/i);
    expect(symlinkMessage).not.toContain(secret);
    expect(symlinkMessage).not.toContain(privatePath);
  });

  it("rejects unsafe roots before reading state", async () => {
    await expect(getTokenReductionTestTool({ path: homedir() })).rejects.toThrow(/too broad/i);
  });

  it("returns exact text/structured parity and generic privacy-safe errors over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-mcp-token-wire-"));
    const stateDir = join(root, ".ai-spend-agent");
    const secret = "ghp_synthetic_secret_must_not_survive";
    const privatePath = "/workspace/private/company/agent-secret.json";
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(
      join(stateDir, "token-reduction-experiments.json"),
      `{bad ${secret} ${privatePath}\n`
    );
    const server = createServer();
    const client = new Client({ name: "aibill-token-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport)
    ]);

    const result = await client.callTool({
      name: "get_token_reduction_test",
      arguments: { path: root }
    });
    const textResult = result.content.find((item) => item.type === "text");
    expect(result.isError).toBe(true);
    expect(textResult).toEqual({ type: "text", text: MALFORMED_LOCAL_STATE_MESSAGE });
    expect(result.structuredContent).toEqual({
      status: "error",
      error: { code: "malformed_state", message: MALFORMED_LOCAL_STATE_MESSAGE }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privatePath);

    await client.close();
    await server.close();
  });
});

async function resultFixture(
  postTotals: number[],
  quality: "passed" | "missing"
): Promise<{
  root: string;
  claudeLogs: string;
  statePath: string;
  beforeRead: string;
  expected: TokenReductionExperimentV0;
}> {
  const container = await mkdtemp(join(tmpdir(), "aibill-mcp-token-result-"));
  const rootPath = join(container, project);
  await mkdir(rootPath);
  const root = await realpath(rootPath);
  const claudeLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-token-claude-"));
  const codexLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-token-codex-"));
  const geminiLogs = await mkdtemp(join(tmpdir(), "aibill-mcp-token-gemini-"));
  vi.stubEnv("AI_SPEND_CLAUDE_LOGS_DIR", claudeLogs);
  vi.stubEnv("AI_SPEND_CODEX_LOGS_DIR", codexLogs);
  vi.stubEnv("AI_SPEND_GEMINI_LOGS_DIR", geminiLogs);

  for (const [index, total] of postTotals.entries()) {
    const timestamp = new Date(Date.parse(appliedAt) + (index + 1) * 60 * 60 * 1_000)
      .toISOString();
    await writeClaudeSession(
      join(claudeLogs, `post-${index}.jsonl`),
      root,
      `post-session-${index}`,
      timestamp,
      total
    );
  }

  const logs = await loadLocalAgentUsage({
    claudeProjectsDir: claudeLogs,
    codexSessionsDir: codexLogs,
    geminiSessionsDir: undefined,
    sinceIso: createdAt,
    collectCodexInvocationEvidence: false
  });
  const sessionVitals = extractSessionVitalsV0(logs.calls);
  const qualityBySessionRef = Object.fromEntries(
    sessionVitals.sessions.map((session) => [session.sessionRef, quality])
  );
  const fixtureProjectRef = createActionVerificationReference(
    "project-working-directory",
    root
  );
  const applied = appliedExperiment(fixtureProjectRef);
  const expected = refreshTokenReductionExperimentV0(applied, {
    sessionVitals,
    observedAt: "2026-08-14T00:00:00.000Z",
    qualityBySessionRef
  });
  const stateDir = join(root, ".ai-spend-agent");
  const statePath = join(stateDir, "token-reduction-experiments.json");
  await mkdir(stateDir, { mode: 0o700 });
  const beforeRead = `${JSON.stringify(
    await tokenStateEnvelope(root, [expected]),
    null,
    2
  )}\n`;
  await writeFile(statePath, beforeRead);
  return { root, claudeLogs, statePath, beforeRead, expected };
}

function appliedExperiment(
  projectRef: string,
  experimentCreatedAt = createdAt,
  experimentAppliedAt = appliedAt
): TokenReductionExperimentV0 {
  const createdMs = Date.parse(experimentCreatedAt);
  const finding = createWasteFindingV0({
    kind: WASTE_FINDING_V0_KIND,
    schemaVersion: WASTE_FINDING_V0_VERSION,
    generatedAt: new Date(createdMs - 60 * 60 * 1_000).toISOString(),
    window: {
      start: new Date(createdMs - 4 * 24 * 60 * 60 * 1_000).toISOString(),
      end: new Date(createdMs - 2 * 60 * 60 * 1_000).toISOString()
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
      surface: "session_workflow",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: {
      kind: "session",
      ref: createActionVerificationReference("session", "mcp-candidate-target")
    },
    scope: {
      agent: "claude-code",
      provider: "anthropic",
      model,
      projectRef
    },
    source: {
      id: "session-vitals-v0",
      validationCoverage: "live_verified",
      freshness: "fresh"
    },
    metric: {
      name: "total_tokens",
      unit: "ratio",
      value: 2,
      sampleCount: 3,
      evidence: "calculated"
    },
    evidenceRefs: [
      createActionVerificationReference("session", "baseline-1"),
      createActionVerificationReference("session", "baseline-2"),
      createActionVerificationReference("session", "baseline-3")
    ],
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });
  return createTokenReductionExperimentV0({
    kind: TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
    schemaVersion: TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
    createdAt: experimentCreatedAt,
    finding,
    cohort: {
      agent: "claude-code",
      provider: "anthropic",
      model,
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
      minimumEvidence: "user_declared",
      rollbackOnRegression: true
    },
    baselineSessions: [100, 100, 100].map((total, index) => ({
      sessionRef: createActionVerificationReference("session", `baseline-${index + 1}`),
      startedAt: new Date(createdMs - (3 - index) * 24 * 60 * 60 * 1_000).toISOString(),
      endedAt: new Date(createdMs - (3 - index) * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000).toISOString(),
      agent: "claude-code",
      provider: "anthropic",
      model,
      projectRef,
      sessionType: "parent" as const,
      workTypeRef,
      sourceVersionRef,
      sourceValidationCoverage: "live_verified" as const,
      tokens: {
        uncachedInputTokens: total - 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolTokens: null,
        outputTokens: 20,
        thoughtTokens: null,
        calculatedTotalTokens: total,
        reportedTotalTokens: total,
        componentEvidence: {
          uncachedInputTokens: "observed" as const,
          cacheReadTokens: "observed" as const,
          cacheWriteTokens: "observed" as const,
          toolTokens: "not_separately_reported" as const,
          outputTokens: "observed" as const,
          thoughtTokens: "not_separately_reported" as const,
          calculatedTotalTokens: "calculated_complete" as const,
          reportedTotalTokens: "provider_reported" as const
        }
      },
      quality: { status: "passed" as const, evidence: "user_declared" as const }
    })),
    intervention: {
      approval: {
        status: "explicit",
        evidence: "user_declared",
        approvedAt: new Date(Date.parse(experimentAppliedAt) - 60_000).toISOString()
      },
      appliedAt: experimentAppliedAt,
      changeRef: createActionVerificationReference("change", "trim-context-canary"),
      rollbackRef: createActionVerificationReference("rollback", "trim-context-canary"),
      canary: {
        status: "passed",
        evidence: "user_declared",
        evidenceRef: createActionVerificationReference("canary", "trim-context-canary")
      }
    },
    postSessions: []
  });
}

async function writeClaudeSession(
  path: string,
  cwd: string,
  sessionId: string,
  timestamp: string,
  totalTokens: number
): Promise<void> {
  await writeFile(path, `${[
    JSON.stringify({
      type: "assistant",
      timestamp,
      cwd,
      sessionId,
      version: hostVersion,
      requestId: `request-${sessionId}`,
      message: {
        id: `message-${sessionId}`,
        model,
        usage: {
          input_tokens: totalTokens - 20,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0
          },
          total_tokens: totalTokens
        }
      }
    }),
    JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      timestamp: new Date(Date.parse(timestamp) + 1).toISOString(),
      sessionId,
      durationMs: 1
    })
  ].join("\n")}\n`);
}
