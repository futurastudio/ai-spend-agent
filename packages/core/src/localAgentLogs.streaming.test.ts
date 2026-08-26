import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateCalls,
  defaultStreamedBytesPerRun,
  loadLocalAgentUsage,
  localAgentQualitativeParserVersion,
  parseCodexRollout,
  sanitizeLocalActivityText,
  type LocalAgentCall,
  type LocalAgentLogOptions,
  type LocalAgentLogResult,
  type LocalAgentQualitativeIndexKey
} from "./localAgentLogs.js";
import { stripRawPaths } from "./qualitativeIndexCache.js";
import { createCodexInvocationCollector } from "./toolInvocations.js";
import { createProjectIndexAdapters } from "./projectIndexStore.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function isolatedFixture() {
  const home = await mkdtemp(join(tmpdir(), "aibill-a4b-home-"));
  const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-a4b-cache-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  const codexDir = join(home, ".codex", "sessions");
  await mkdir(codexDir, { recursive: true });
  return { home, cacheDirectory, codexDir };
}

function avref(directory: string): string {
  return `avref_${createHash("sha256")
    .update("project-working-directory")
    .update(String.fromCharCode(0))
    .update(directory)
    .digest("hex")}`;
}

function pathHashOf(filePath: string): string {
  return createHash("sha256").update(resolve(filePath)).digest("hex");
}

async function fileIdentityOf(filePath: string): Promise<string> {
  const info = await stat(filePath);
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs].join(":");
}

function sessionMetaLine(cwd: string, extra: Record<string, unknown> = {}, id = "codex-stream"): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-17T10:00:00.000Z",
    payload: { id, cwd, timestamp: "2026-08-17T10:00:00.000Z", ...extra }
  });
}

function turnContextLine(minute: number): string {
  return JSON.stringify({
    type: "turn_context",
    timestamp: `2026-08-17T10:${String(minute).padStart(2, "0")}:00.000Z`,
    payload: { model: "gpt-5.1-codex" }
  });
}

function tokenCountLine(minute: number, totals?: Record<string, number>): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: `2026-08-17T10:${String(minute).padStart(2, "0")}:30.000Z`,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: totals ?? { input_tokens: 500, cached_input_tokens: 0, output_tokens: 10 }
      }
    }
  });
}

function userPromptLine(text: string, minute: number): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: `2026-08-17T10:${String(minute).padStart(2, "0")}:10.000Z`,
    payload: { type: "message", role: "user", content: [{ text }] }
  });
}

function toolCallLine(workdir: string, minute: number, name = "shell"): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: `2026-08-17T10:${String(minute).padStart(2, "0")}:20.000Z`,
    payload: { type: "function_call", name, arguments: JSON.stringify({ workdir }) }
  });
}

const policy = {
  maxFileBytes: 512,
  maxSourceBytes: 8_192,
  maxStreamedBytesPerRun: 2_048
} as const;

function loaderOptions(
  home: string,
  codexDir: string,
  adapters: ReturnType<typeof createProjectIndexAdapters>,
  extra: Partial<LocalAgentLogOptions> = {}
): LocalAgentLogOptions {
  return {
    claudeProjectsDir: join(home, ".claude", "projects"),
    codexSessionsDir: codexDir,
    geminiSessionsDir: join(home, "no-gemini-here"),
    qualitativeScan: policy,
    qualitativeIndex: adapters.qualitative,
    streamCheckpoints: adapters,
    ...extra
  };
}

function codexScan(result: LocalAgentLogResult) {
  return result.sourceScans.find((scan) => scan.agent === "codex")!;
}

async function runToConvergence(
  options: LocalAgentLogOptions,
  maxRuns = 10
): Promise<{ runs: LocalAgentLogResult[]; final: LocalAgentLogResult }> {
  const runs: LocalAgentLogResult[] = [];
  for (let index = 0; index < maxRuns; index += 1) {
    const result = await loadLocalAgentUsage(options);
    runs.push(result);
    if (codexScan(result).qualitativeProjectCoverage === "complete") {
      return { runs, final: result };
    }
  }
  throw new Error(`stream did not converge within ${maxRuns} runs`);
}

describe("A4b checkpointed streaming for oversized Codex rollouts", () => {
  it("converges over bounded runs to evidence identical to an unbounded parse", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const filler: string[] = [];
    for (let index = 0; index < 30; index += 1) filler.push(tokenCountLine(11 + (index % 40)));
    const content = [
      sessionMetaLine(homedir()),
      turnContextLine(1),
      userPromptLine("improve the landing page hero copy", 2),
      userPromptLine("refine the landing page hero spacing", 3),
      toolCallLine("/private/tmp/aibill-two/alpha", 4),
      toolCallLine("/private/tmp/aibill-two/alpha", 5),
      toolCallLine("/private/tmp/aibill-two/beta", 6),
      ...filler,
      tokenCountLine(55, { input_tokens: 9_000, cached_input_tokens: 1_000, output_tokens: 333 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-golden.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    expect(content.length).toBeGreaterThan(3 * policy.maxStreamedBytesPerRun);
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters);

    const { runs, final } = await runToConvergence(options);
    expect(runs.length).toBeGreaterThan(1);
    for (const intermediate of runs.slice(0, -1)) {
      const scan = codexScan(intermediate);
      expect(scan.qualitativeProjectCoverage).toBe("indexing");
      expect(scan.qualitativeCoverage).toBe("partial");
      expect(scan.qualitativeFilesStreaming).toBe(1);
      expect(intermediate.calls.filter((call) => call.agent === "codex")).toHaveLength(0);
      expect(scan.qualitativeBytesStreamed ?? 0).toBeGreaterThan(0);
    }

    const finalScan = codexScan(final);
    expect(finalScan.qualitativeCoverage).toBe("complete");
    expect(finalScan.qualitativeFilesReadCompletely).toBe(1);
    expect(finalScan.qualitativeFilesSkippedForBudget).toBe(0);
    const call = final.calls.find((entry) => entry.agent === "codex")!;
    expect(call).toBeDefined();
    // The dominant workdir was observed slices ago and crossed the
    // checkpoint boundary as a hash: the call carries the exact ref and
    // project, never a reconstructed raw path.
    expect(call.workingDirectory).toBeUndefined();
    expect(call.workingDirectoryRef).toBe(avref("/private/tmp/aibill-two/alpha"));
    expect(call.project).toBe("alpha");
    expect(call.usage.inputTokens).toBe(9_000 - 1_000);
    expect(call.activity?.summary).toContain("landing page");
    expect(call.activity?.promptCount).toBe(2);

    // Golden equality: the persisted entry equals the privacy-reduced form
    // of an unbounded whole-file parse.
    const entryKey: LocalAgentQualitativeIndexKey = {
      schemaVersion: 1,
      parserVersion: localAgentQualitativeParserVersion,
      agent: "codex",
      pathHash: pathHashOf(rollout),
      fileIdentity: await fileIdentityOf(rollout),
      sinceIso: null,
      collectInvocationEvidence: false
    };
    const entry = await adapters.qualitative.read(entryKey);
    expect(entry).toBeDefined();
    const expected = stripRawPaths({
      calls: parseCodexRollout(content),
      diagnostics: []
    }) as { calls: LocalAgentCall[] };
    expect(entry!.calls).toEqual(expected.calls);
    expect(entry!.diagnostics).toEqual([]);

    // Converged files are plain index hits afterwards: no re-stream, stable
    // evidence, complete coverage.
    const warm = await loadLocalAgentUsage(options);
    const warmScan = codexScan(warm);
    expect(warmScan.qualitativeIndexHits).toBeGreaterThanOrEqual(1);
    expect(warmScan.qualitativeFilesStreaming ?? 0).toBe(0);
    expect(warmScan.qualitativeBytesStreamed ?? 0).toBe(0);
    expect(warmScan.qualitativeProjectCoverage).toBe("complete");
    expect(warm.calls.find((entry2) => entry2.agent === "codex")).toEqual(call);
  });

  it("carries the largest single request across a checkpoint boundary for tiered pricing", async () => {
    // The tier of a session-cumulative Codex call is fixed by its LARGEST
    // single request, tracked as `maxRequestPromptTokens`. That maximum must
    // survive checkpointing: here the biggest turn (250K, still under the 272K
    // tier) is the FIRST token_count and is streamed away in an early run,
    // while the cumulative later balloons past 272K on cache reads. If the
    // running maximum were not persisted, the restored parse would see only the
    // small later turns and mis-tier (or void) the session.
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const turnContextSol = JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-17T10:01:00.000Z",
      payload: { model: "gpt-5.6-sol" }
    });
    const tokenCountWithTurn = (
      minute: number,
      total: Record<string, number>,
      last: Record<string, number>
    ): string => JSON.stringify({
      type: "event_msg",
      timestamp: `2026-08-17T10:${String(minute).padStart(2, "0")}:30.000Z`,
      payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } }
    });
    const filler: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const cumInput = 260_000 + (index + 1) * 10_000;
      filler.push(tokenCountWithTurn(
        11 + index,
        { input_tokens: cumInput, cached_input_tokens: cumInput - 60_000, output_tokens: 200 + index },
        { input_tokens: 5_000, cached_input_tokens: 0, output_tokens: 10, total_tokens: 5_010 }
      ));
    }
    const content = [
      sessionMetaLine(homedir(), {}, "codex-maxreq"),
      turnContextSol,
      // First and largest request: 250K prompt, under the 272K tier.
      tokenCountWithTurn(
        5,
        { input_tokens: 250_000, cached_input_tokens: 200_000, output_tokens: 100 },
        { input_tokens: 250_000, cached_input_tokens: 200_000, output_tokens: 100, total_tokens: 250_100 }
      ),
      ...filler,
      // Final cumulative: ~660K input, cache-dominated — well past 272K.
      tokenCountWithTurn(
        56,
        { input_tokens: 660_000, cached_input_tokens: 600_000, output_tokens: 2_000 },
        { input_tokens: 5_000, cached_input_tokens: 0, output_tokens: 10, total_tokens: 5_010 }
      )
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-maxreq.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    // Larger than one run's budget so the file must stream over several runs,
    // forcing at least one checkpoint after the large first turn.
    expect(content.length).toBeGreaterThan(policy.maxStreamedBytesPerRun);
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters);

    // Run until the whole file has been streamed and the codex call emerges.
    // Runs before it appears are partial (checkpointed) runs — at least one
    // must precede it, proving the large first turn crossed a boundary.
    let call: LocalAgentCall | undefined;
    let checkpointedRuns = 0;
    for (let attempt = 0; attempt < 10 && !call; attempt += 1) {
      const result = await loadLocalAgentUsage(options);
      call = result.calls.find((entry) => entry.agent === "codex");
      if (!call) checkpointedRuns += 1;
    }
    expect(checkpointedRuns).toBeGreaterThan(0);
    expect(call).toBeDefined();
    expect(call!.model).toBe("gpt-5.6-sol");
    // The pre-checkpoint maximum survived restore; it equals the unbounded
    // whole-file parse and is under the 272K tier threshold. (Other fields such
    // as workingDirectory are deliberately privacy-reduced across checkpoints;
    // only the tier evidence is asserted here.)
    expect(call!.maxRequestPromptTokens).toBe(250_000);
    expect(call!.maxRequestPromptTokens).toBe(parseCodexRollout(content)[0]!.maxRequestPromptTokens);
    // And it prices at the base tier despite a >272K cumulative (660K input).
    const record = aggregateCalls([call!])[0]!;
    expect(record.amountUsd).toBeCloseTo(0.52, 4);
    expect(record.costConfidence).toBe("estimated");
  });

  it("preserves invocation evidence across checkpointed runs", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const filler: string[] = [];
    for (let index = 0; index < 24; index += 1) filler.push(tokenCountLine(11 + (index % 40)));
    const content = [
      sessionMetaLine("/private/tmp/aibill-stream-inv", {}, "codex-stream-inv"),
      turnContextLine(1),
      userPromptLine("/review the changes", 2),
      toolCallLine("/private/tmp/aibill-stream-inv", 3),
      toolCallLine("/private/tmp/aibill-stream-inv", 4),
      turnContextLine(5),
      ...filler,
      tokenCountLine(56, { input_tokens: 4_000, cached_input_tokens: 100, output_tokens: 50 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-inv.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const sinceIso = "2026-08-01T00:00:00.000Z";
    const options = loaderOptions(home, codexDir, adapters, {
      collectCodexInvocationEvidence: true,
      sinceIso
    });

    const { runs, final } = await runToConvergence(options);
    expect(runs.length).toBeGreaterThan(1);
    const streamedInvocation = final.codexInvocationFiles!
      .find((file) => file.contextSignal.sessionId === "codex-stream-inv");
    expect(streamedInvocation).toBeDefined();

    // Expected: one collector over the whole content under the same window.
    const collector = createCodexInvocationCollector(Date.parse(sinceIso));
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      collector.consume(JSON.parse(line) as Record<string, unknown>);
    }
    expect(streamedInvocation).toEqual(collector.finish());
    expect(streamedInvocation!.assistantTurns).toBe(2);
    expect(streamedInvocation!.invokedCommands).toEqual(["review"]);
  });

  it("restarts from byte zero when the checkpointed file is rewritten", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const fillerA: string[] = [];
    for (let index = 0; index < 36; index += 1) fillerA.push(tokenCountLine(11 + (index % 40)));
    const contentA = [
      sessionMetaLine("/private/tmp/aibill-stream-a"),
      turnContextLine(1),
      ...fillerA,
      tokenCountLine(57, { input_tokens: 7_000, cached_input_tokens: 0, output_tokens: 70 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-rewrite.jsonl");
    await writeFile(rollout, contentA, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters);

    // One bounded run leaves a mid-file checkpoint.
    const first = await loadLocalAgentUsage(options);
    expect(codexScan(first).qualitativeFilesStreaming).toBe(1);
    expect(await adapters.readStreamCheckpoint("codex", pathHashOf(rollout))).toBeDefined();

    // Rewrite in place: same inode/birthtime, smaller content, other project.
    const fillerB: string[] = [];
    for (let index = 0; index < 8; index += 1) fillerB.push(tokenCountLine(11 + index));
    const contentB = [
      sessionMetaLine("/private/tmp/aibill-stream-b"),
      turnContextLine(1),
      ...fillerB,
      tokenCountLine(58, { input_tokens: 1_234, cached_input_tokens: 0, output_tokens: 8 })
    ].join("\n") + "\n";
    expect(contentB.length).toBeLessThan(codexScan(first).qualitativeBytesStreamed ?? 0);
    await writeFile(rollout, contentB, { mode: 0o600 });

    const { final } = await runToConvergence(loaderOptions(home, codexDir, adapters, {
      qualitativeScan: { ...policy, maxStreamedBytesPerRun: 64 * 1_024 }
    }));
    const call = final.calls.find((entry) => entry.agent === "codex")!;
    // Only the rewritten content's evidence appears: the stale checkpoint
    // was discarded, never merged.
    expect(call.project).toBe("aibill-stream-b");
    expect(call.workingDirectory).toBe("/private/tmp/aibill-stream-b");
    expect(call.usage.inputTokens).toBe(1_234);
    expect(call.usage.outputTokens).toBe(8);
  });

  it("schedules mainline rollouts before newer subagent rollouts (no starvation)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const fillerMain: string[] = [];
    for (let index = 0; index < 18; index += 1) fillerMain.push(tokenCountLine(11 + index));
    const mainline = [
      sessionMetaLine("/private/tmp/aibill-stream-main", {}, "codex-main"),
      turnContextLine(1),
      ...fillerMain,
      tokenCountLine(50, { input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 20 })
    ].join("\n") + "\n";
    const subagentFiller: string[] = [];
    for (let index = 0; index < 18; index += 1) subagentFiller.push(tokenCountLine(12 + index));
    const subagent = [
      sessionMetaLine("/private/tmp/aibill-stream-sub", {
        thread_source: "subagent",
        parent_thread_id: "codex-main"
      }, "codex-sub"),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-17T10:00:01.000Z",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          started_at: "2026-08-17T10:00:01.000Z"
        }
      }),
      turnContextLine(1),
      ...subagentFiller,
      tokenCountLine(51, { input_tokens: 3_000, cached_input_tokens: 0, output_tokens: 30 })
    ].join("\n") + "\n";
    const mainlinePath = join(codexDir, "rollout-a-mainline.jsonl");
    const subagentPath = join(codexDir, "rollout-b-subagent.jsonl");
    await writeFile(mainlinePath, mainline, { mode: 0o600 });
    // Written second: strictly newer, so recency alone would schedule it first.
    await writeFile(subagentPath, subagent, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters, {
      qualitativeScan: { ...policy, maxStreamedBytesPerRun: mainline.length + 256 }
    });

    const run1 = await loadLocalAgentUsage(options);
    const scan1 = codexScan(run1);
    // The mainline file completed within the first run's allowance; the
    // newer subagent rollout waited and stays honestly unconverged.
    const run1Projects = run1.calls
      .filter((call) => call.agent === "codex")
      .map((call) => call.project);
    expect(run1Projects).toEqual(["aibill-stream-main"]);
    expect(scan1.qualitativeFilesStreaming).toBe(1);
    expect(scan1.qualitativeProjectCoverage).toBe("indexing");

    const { final } = await runToConvergence(options);
    const finalProjects = final.calls
      .filter((call) => call.agent === "codex")
      .map((call) => call.project)
      .sort();
    expect(finalProjects).toEqual(["aibill-stream-main", "aibill-stream-sub"]);
    expect(codexScan(final).qualitativeProjectCoverage).toBe("complete");
  });

  it("documents the cross-checkpoint tie-break divergence (QA 27)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const filler: string[] = [];
    for (let index = 0; index < 30; index += 1) filler.push(tokenCountLine(11 + (index % 40)));
    const content = [
      sessionMetaLine(homedir()),
      turnContextLine(1),
      toolCallLine("/b/alpha", 2),
      toolCallLine("/a/zebra", 3),
      ...filler,
      tokenCountLine(55, { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 10 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-tie.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });

    const { runs, final } = await runToConvergence(loaderOptions(home, codexDir, adapters));
    expect(runs.length).toBeGreaterThan(1);
    // Whole-file parse breaks the exact score+depth tie by full-path order.
    const whole = parseCodexRollout(content)[0]!;
    expect(whole.workingDirectory).toBe("/a/zebra");
    // The streamed parse saw the tie only as hashes and breaks it by
    // basename order — the documented, pinned divergence for ties that span
    // a checkpoint boundary.
    const streamed = final.calls.find((call) => call.agent === "codex")!;
    expect(streamed.workingDirectoryRef).toBe(avref("/b/alpha"));
    expect(streamed.project).toBe("alpha");
  });

  it("fails closed across parser versions for entries and checkpoints", async () => {
    const { cacheDirectory } = await isolatedFixture();
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const pathHash = "ab".repeat(32);

    // Round-trip at the current version.
    await adapters.writeStreamCheckpoint("codex", pathHash, {
      pin: { dev: 1, ino: 2, birthtimeMs: 3 },
      parserVersion: localAgentQualitativeParserVersion,
      collectInvocationEvidence: false,
      sinceIso: null,
      offset: 64,
      prefixProbe: { bytes: 64, sha256: "c".repeat(64) },
      reducerState: { anything: true }
    });
    const roundTrip = await adapters.readStreamCheckpoint("codex", pathHash);
    expect(roundTrip?.offset).toBe(64);

    // A checkpoint claiming any other parser version is rejected at write.
    await expect(adapters.writeStreamCheckpoint("codex", pathHash, {
      pin: { dev: 1, ino: 2, birthtimeMs: 3 },
      parserVersion: localAgentQualitativeParserVersion - 1,
      collectInvocationEvidence: false,
      sinceIso: null,
      offset: 64,
      prefixProbe: { bytes: 64, sha256: "c".repeat(64) },
      reducerState: {}
    })).rejects.toThrow();

    // An on-disk checkpoint from an older parser reads as a miss (restart).
    const storeRoot = join(cacheDirectory, "project-index-v2");
    const staleHash = "cd".repeat(32);
    await mkdir(join(storeRoot, "checkpoints"), { recursive: true, mode: 0o700 });
    const staleCheckpointPath = join(storeRoot, "checkpoints", `${staleHash}.json`);
    await writeFile(
      staleCheckpointPath,
      `${JSON.stringify({
        kind: "aibill.project_index_checkpoint",
        schemaVersion: 2,
        agent: "codex",
        pathHash: staleHash,
        storedAt: new Date().toISOString(),
        checkpoint: {
          pin: { dev: 1, ino: 2, birthtimeMs: 3 },
          parserVersion: localAgentQualitativeParserVersion - 1,
          collectInvocationEvidence: false,
          sinceIso: null,
          offset: 128,
          prefixProbe: { bytes: 128, sha256: "d".repeat(64) },
          reducerState: {}
        }
      })}\n`,
      { mode: 0o600 }
    );
    expect(await adapters.readStreamCheckpoint("codex", staleHash)).toBeUndefined();
    // Invalid (superseded-contract) checkpoints are purged on sight.
    await expect(access(staleCheckpointPath)).rejects.toThrow();

    // A pre-sanitization (schemaVersion 1) checkpoint — real ones exist on
    // disk from runs before the privacy fix and may hold raw prompt paths —
    // is unreadable AND deleted the first time it is looked at.
    const prefixHash = "12".repeat(32);
    const prefixPath = join(storeRoot, "checkpoints", `${prefixHash}.json`);
    await writeFile(
      prefixPath,
      `${JSON.stringify({
        kind: "aibill.project_index_checkpoint",
        schemaVersion: 1,
        agent: "codex",
        pathHash: prefixHash,
        storedAt: new Date().toISOString(),
        checkpoint: {
          pin: { dev: 1, ino: 2, birthtimeMs: 3 },
          parserVersion: localAgentQualitativeParserVersion,
          collectInvocationEvidence: false,
          sinceIso: null,
          offset: 64,
          prefixProbe: { bytes: 64, sha256: "e".repeat(64) },
          reducerState: { recentPrompts: ["/private/tmp/pre-fix-raw-path"] }
        }
      })}\n`,
      { mode: 0o600 }
    );
    expect(await adapters.readStreamCheckpoint("codex", prefixHash)).toBeUndefined();
    await expect(access(prefixPath)).rejects.toThrow();

    // A FUTURE (schemaVersion 3) checkpoint is a miss but is never purged or
    // clobbered by this writer.
    const futureHash = "34".repeat(32);
    const futurePath = join(storeRoot, "checkpoints", `${futureHash}.json`);
    const futureDocument = `${JSON.stringify({
      kind: "aibill.project_index_checkpoint",
      schemaVersion: 3,
      agent: "codex",
      pathHash: futureHash,
      storedAt: new Date().toISOString(),
      checkpoint: { future: true }
    })}\n`;
    await writeFile(futurePath, futureDocument, { mode: 0o600 });
    expect(await adapters.readStreamCheckpoint("codex", futureHash)).toBeUndefined();
    expect(await readFile(futurePath, "utf8")).toBe(futureDocument);
    await expect(adapters.writeStreamCheckpoint("codex", futureHash, {
      pin: { dev: 1, ino: 2, birthtimeMs: 3 },
      parserVersion: localAgentQualitativeParserVersion,
      collectInvocationEvidence: false,
      sinceIso: null,
      offset: 1,
      prefixProbe: { bytes: 1, sha256: "f".repeat(64) },
      reducerState: {}
    })).rejects.toMatchObject({ code: "unsupported_version" });
    expect(await readFile(futurePath, "utf8")).toBe(futureDocument);

    // An on-disk entry keyed by an older parser version reads as a miss.
    const entryHash = "ef".repeat(32);
    const shard = join(storeRoot, "entries", entryHash.slice(0, 2));
    await mkdir(shard, { recursive: true, mode: 0o700 });
    await writeFile(
      join(shard, `${entryHash}.json`),
      `${JSON.stringify({
        kind: "aibill.project_index_file",
        schemaVersion: 2,
        agent: "codex",
        pathHash: entryHash,
        qualitative: [{
          key: {
            schemaVersion: 1,
            parserVersion: localAgentQualitativeParserVersion - 1,
            agent: "codex",
            pathHash: entryHash,
            fileIdentity: "1:2:3:4:5:6",
            sinceIso: null,
            collectInvocationEvidence: false
          },
          storedAt: new Date().toISOString(),
          value: { calls: [], diagnostics: [] }
        }]
      })}\n`,
      { mode: 0o600 }
    );
    const currentKey: LocalAgentQualitativeIndexKey = {
      schemaVersion: 1,
      parserVersion: localAgentQualitativeParserVersion,
      agent: "codex",
      pathHash: entryHash,
      fileIdentity: "1:2:3:4:5:6",
      sinceIso: null,
      collectInvocationEvidence: false
    };
    expect(await adapters.qualitative.read(currentKey)).toBeUndefined();

    // Reading WITH an old-version key is refused outright, never reinterpreted.
    await expect(adapters.qualitative.read({
      ...currentKey,
      parserVersion: localAgentQualitativeParserVersion - 1
    } as unknown as LocalAgentQualitativeIndexKey)).rejects.toThrow();

    // GC sweeps aged, unretained checkpoints.
    await adapters.collectGarbage({ retainPathHashes: new Set(), graceMs: 0 });
    expect(await adapters.readStreamCheckpoint("codex", pathHash)).toBeUndefined();
  });

  it("never lets raw prompt paths reach any store byte (BLOCKER-1)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const secretDir = "/private/tmp/a4qa-privacy-SECRETDIR-zx9/src";
    const homeMarker = join(homedir(), "secret-notes", "todo.txt");
    const filler: string[] = [];
    for (let index = 0; index < 30; index += 1) filler.push(tokenCountLine(11 + (index % 40)));
    const content = [
      sessionMetaLine(homedir()),
      turnContextLine(1),
      userPromptLine(`work inside ${secretDir} please improve the landing page`, 2),
      userPromptLine(`${homeMarker} has the landing page plan`, 3),
      ...filler,
      tokenCountLine(55, { input_tokens: 2_500, cached_input_tokens: 0, output_tokens: 25 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-privacy.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters);

    const sweep = async () => {
      const queue = [cacheDirectory];
      while (queue.length > 0) {
        const directory = queue.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = join(directory, entry.name);
          if (entry.isDirectory()) {
            queue.push(target);
            continue;
          }
          if (!entry.isFile()) continue;
          const bytes = await readFile(target, "utf8").catch(() => "");
          expect(bytes.includes("SECRETDIR"), `raw path leaked into ${entry.name}`).toBe(false);
          expect(bytes.includes(homeMarker), `home path leaked into ${entry.name}`).toBe(false);
        }
      }
    };

    // Every intermediate run's checkpoint and the final entry must be clean.
    const { runs, final } = await (async () => {
      const collected = [] as LocalAgentLogResult[];
      for (let index = 0; index < 10; index += 1) {
        const result = await loadLocalAgentUsage(options);
        collected.push(result);
        await sweep();
        if (codexScan(result).qualitativeProjectCoverage === "complete") {
          return { runs: collected, final: result };
        }
      }
      throw new Error("privacy stream did not converge");
    })();
    expect(runs.length).toBeGreaterThan(1);
    const call = final.calls.find((entry) => entry.agent === "codex")!;
    // Path-stripped survivors still carry the user's actual topic words.
    expect(call.activity?.promptCount).toBe(2);
    expect(call.activity?.summary).toContain("landing page");
  });

  it("converges a rollout whose final line lacks a trailing newline (MAJOR-1)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const filler: string[] = [];
    for (let index = 0; index < 30; index += 1) filler.push(tokenCountLine(11 + (index % 40)));
    // Deliberately NO trailing newline: the kill-9'd session shape.
    const content = [
      sessionMetaLine("/private/tmp/aibill-stream-tail"),
      turnContextLine(1),
      ...filler,
      tokenCountLine(55, { input_tokens: 4_242, cached_input_tokens: 0, output_tokens: 42 })
    ].join("\n");
    const rollout = join(codexDir, "rollout-stream-notail.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters);

    const { runs, final } = await runToConvergence(options);
    expect(runs.length).toBeGreaterThan(1);
    const call = final.calls.find((entry) => entry.agent === "codex")!;
    expect(call.usage.inputTokens).toBe(4_242);
    expect(call.usage.outputTokens).toBe(42);
    // Golden parity with the whole-file parse of the identical bytes.
    const entryKey: LocalAgentQualitativeIndexKey = {
      schemaVersion: 1,
      parserVersion: localAgentQualitativeParserVersion,
      agent: "codex",
      pathHash: pathHashOf(rollout),
      fileIdentity: await fileIdentityOf(rollout),
      sinceIso: null,
      collectInvocationEvidence: false
    };
    const entry = await adapters.qualitative.read(entryKey);
    const expected = stripRawPaths({
      calls: parseCodexRollout(content),
      diagnostics: []
    }) as { calls: LocalAgentCall[] };
    expect(entry!.calls).toEqual(expected.calls);
    // Converged: the checkpoint is gone and the next run is a pure hit.
    expect(await adapters.readStreamCheckpoint("codex", pathHashOf(rollout))).toBeUndefined();
    const warm = await loadLocalAgentUsage(options);
    expect(codexScan(warm).qualitativeIndexHits).toBeGreaterThanOrEqual(1);
    expect(codexScan(warm).qualitativeProjectCoverage).toBe("complete");
  });

  it("skips a single line just over the 32 MiB cap as malformed (MINOR-3)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const oversizedLine = "x".repeat(33 * 1_024 * 1_024);
    const content = [
      sessionMetaLine("/private/tmp/aibill-stream-cap"),
      turnContextLine(1),
      oversizedLine,
      tokenCountLine(55, { input_tokens: 777, cached_input_tokens: 0, output_tokens: 7 })
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-stream-cap.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const options = loaderOptions(home, codexDir, adapters, {
      qualitativeScan: { ...policy, maxStreamedBytesPerRun: 64 * 1_024 * 1_024 }
    });

    const { final } = await runToConvergence(options, 3);
    const call = final.calls.find((entry) => entry.agent === "codex")!;
    expect(call.usage.inputTokens).toBe(777);
    const malformed = final.diagnostics.find((entry) =>
      entry.agent === "codex" && entry.code === "malformed_jsonl"
    );
    expect(malformed?.count).toBe(1);
  });

  it("pins the measured-throughput default streaming allowance (MAJOR-2)", () => {
    expect(defaultStreamedBytesPerRun).toBe(512 * 1_024 * 1_024);
  });

  it("pins the sanitize idempotence the checkpointed prompt path relies on", () => {
    const prompts = [
      "improve the landing page hero copy",
      "api_key: sk-svcacct-superduper-long-token refine the page",
      "  collapse   whitespace   everywhere  ",
      "/review the changes to MCP feature"
    ];
    for (const prompt of prompts) {
      const once = sanitizeLocalActivityText(prompt);
      expect(sanitizeLocalActivityText(once)).toBe(once);
    }
  });
});
