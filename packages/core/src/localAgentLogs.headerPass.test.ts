import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexHeaderProbesPerScan,
  loadLocalAgentUsage,
  parseCodexRollout,
  type LocalAgentLogOptions,
  type LocalAgentOwnershipIndexAdapter,
  type LocalAgentOwnershipRecord
} from "./localAgentLogs.js";
import { createProjectIndexAdapters } from "./projectIndexStore.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function isolatedFixture() {
  const home = await mkdtemp(join(tmpdir(), "aibill-a4a-home-"));
  const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-a4a-cache-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  const codexDir = join(home, ".codex", "sessions");
  await mkdir(codexDir, { recursive: true });
  return { home, cacheDirectory, codexDir };
}

/** Byte-identical to the loader's NUL-separated working-directory avref. */
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

function sessionMetaLine(cwd: string): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-17T10:00:00.000Z",
    payload: {
      id: "77777777-7777-4777-8777-777777777777",
      cwd,
      timestamp: "2026-08-17T10:00:00.000Z"
    }
  });
}

function tokenCountLine(timestamp: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_000,
          cached_input_tokens: 100,
          output_tokens: 50
        }
      }
    }
  });
}

function smallRollout(cwd: string): string {
  return [
    sessionMetaLine(cwd),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
    tokenCountLine("2026-08-17T10:30:00.000Z")
  ].join("\n") + "\n";
}

/** Exceeds every policy in this file, so it is always budget-skipped. */
function giantRollout(firstLine: string): string {
  const filler: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    filler.push(tokenCountLine(`2026-08-17T10:${String(10 + index)}:00.000Z`));
  }
  return [firstLine, ...filler].join("\n") + "\n";
}

function claudeTranscriptLine(timestamp: string): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp,
    cwd: "/tmp/example-project",
    sessionId: "11111111-1111-4111-8111-111111111111",
    message: {
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 20 }
    }
  })}\n`;
}

const policy = { maxFileBytes: 1_024, maxSourceBytes: 8_192 } as const;

function loaderOptions(
  home: string,
  codexDir: string,
  ownershipIndex: LocalAgentOwnershipIndexAdapter,
  adapters: ReturnType<typeof createProjectIndexAdapters>,
  extra: Partial<LocalAgentLogOptions> = {}
): LocalAgentLogOptions {
  return {
    claudeProjectsDir: join(home, ".claude", "projects"),
    codexSessionsDir: codexDir,
    geminiSessionsDir: join(home, "no-gemini-here"),
    qualitativeScan: policy,
    qualitativeIndex: adapters.qualitative,
    ownershipIndex,
    ...extra
  };
}

function countingOwnership(adapters: ReturnType<typeof createProjectIndexAdapters>) {
  const counters = { reads: 0, writes: 0 };
  const adapter: LocalAgentOwnershipIndexAdapter = {
    readOwnership: async (agent, pathHash) => {
      counters.reads += 1;
      return adapters.readOwnership(agent, pathHash);
    },
    writeOwnership: async (agent, pathHash, ownership: Readonly<LocalAgentOwnershipRecord>) => {
      counters.writes += 1;
      return adapters.writeOwnership(agent, pathHash, ownership);
    }
  };
  return { counters, adapter };
}

describe("A4a Codex header pass and coverage ledger", () => {
  it("unblocks an unrelated project's coverage with a proven-foreign header", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    await writeFile(
      join(codexDir, "rollout-small.jsonl"),
      smallRollout("/private/tmp/aibill-header-a"),
      { mode: 0o600 }
    );
    const giant = join(codexDir, "rollout-giant.jsonl");
    await writeFile(
      giant,
      giantRollout(sessionMetaLine("/private/tmp/aibill-header-b")),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const requestedRef = avref("/private/tmp/aibill-header-a");

    const cold = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: requestedRef
    }));
    const coldScan = cold.sourceScans.find((scan) => scan.agent === "codex")!;
    expect(coldScan.qualitativeFilesEligible).toBe(2);
    expect(coldScan.qualitativeFilesSkippedForBudget).toBe(1);
    expect(coldScan.qualitativeFilesIndexed).toBe(1);
    expect(coldScan.qualitativeFilesForeignProven).toBe(1);
    expect(coldScan.qualitativeFilesOwnershipUnknown).toBe(0);
    expect(coldScan.qualitativeProjectCoverage).toBe("complete");
    // The global claim never weakens: the foreign body was still not parsed.
    expect(coldScan.qualitativeCoverage).toBe("partial");
    // The requested project's own evidence still flowed from the parsed file.
    expect(cold.calls.some((call) =>
      call.agent === "codex" &&
      call.workingDirectory === "/private/tmp/aibill-header-a"
    )).toBe(true);

    // The attribution is persisted: proven, foreign ref, no body ownership.
    const ownership = await adapters.readOwnership("codex", pathHashOf(giant));
    expect(ownership?.status).toBe("unknown");
    expect(ownership?.projectRefs).toEqual([]);
    expect(ownership?.headerAttribution).toEqual({
      status: "proven",
      projectRef: avref("/private/tmp/aibill-header-b"),
      isSubagent: false
    });

    // Warm run: the stored attribution is reused, never re-probed/rewritten.
    const { counters, adapter } = countingOwnership(adapters);
    const warm = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapter, adapters, {
      coverageProjectRef: requestedRef
    }));
    const warmScan = warm.sourceScans.find((scan) => scan.agent === "codex")!;
    expect(warmScan.qualitativeFilesForeignProven).toBe(1);
    expect(warmScan.qualitativeProjectCoverage).toBe("complete");
    expect(counters.writes).toBe(0);
  });

  it("keeps a proven-owned unparsed giant blocking its own project (QA 24)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const giant = join(codexDir, "rollout-owned-giant.jsonl");
    await writeFile(
      giant,
      giantRollout(sessionMetaLine("/private/tmp/aibill-header-a")),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const requestedRef = avref("/private/tmp/aibill-header-a");

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: requestedRef
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    // The header still proved ownership — to the requested project itself.
    const ownership = await adapters.readOwnership("codex", pathHashOf(giant));
    expect(ownership?.headerAttribution).toEqual({
      status: "proven",
      projectRef: requestedRef,
      isSubagent: false
    });
  });

  it("treats a home-launched header as unknown, never foreign", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const giant = join(codexDir, "rollout-home-giant.jsonl");
    await writeFile(giant, giantRollout(sessionMetaLine(homedir())), { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: avref("/private/tmp/aibill-header-a")
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    const ownership = await adapters.readOwnership("codex", pathHashOf(giant));
    expect(ownership?.headerAttribution).toEqual({ status: "unknown", isSubagent: false });
  });

  it("treats cwd '/' and relative cwds as unknown (QA 36)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const rootGiant = join(codexDir, "rollout-root-giant.jsonl");
    await writeFile(rootGiant, giantRollout(sessionMetaLine("/")), { mode: 0o600 });
    const relativeGiant = join(codexDir, "rollout-relative-giant.jsonl");
    await writeFile(
      relativeGiant,
      giantRollout(sessionMetaLine("relative-project-dir")),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: avref("/private/tmp/aibill-header-a")
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(2);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    for (const filePath of [rootGiant, relativeGiant]) {
      const ownership = await adapters.readOwnership("codex", pathHashOf(filePath));
      expect(ownership?.headerAttribution).toEqual({ status: "unknown", isSubagent: false });
    }
  });

  it("treats oversized and non-session_meta first lines as unknown", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    // A real-project cwd hidden behind a first line larger than the probe.
    const oversized = join(codexDir, "rollout-oversized-giant.jsonl");
    await writeFile(
      oversized,
      giantRollout(JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/private/tmp/aibill-header-b",
          filler: "x".repeat(300 * 1_024)
        }
      })),
      { mode: 0o600 }
    );
    // A first-line turn_context carries a cwd the full parser would accept as
    // a fallback, but the header pass must not claim it.
    const wrongType = join(codexDir, "rollout-turncontext-giant.jsonl");
    await writeFile(
      wrongType,
      giantRollout(JSON.stringify({
        type: "turn_context",
        payload: { cwd: "/private/tmp/aibill-header-b", model: "gpt-5.1-codex" }
      })),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: avref("/private/tmp/aibill-header-a")
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(2);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    for (const filePath of [oversized, wrongType]) {
      const ownership = await adapters.readOwnership("codex", pathHashOf(filePath));
      expect(ownership?.headerAttribution).toEqual({ status: "unknown" });
    }
  });

  it("leaves a parsed home-launched two-project body untouched by headers (QA 34)", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const toolCall = (workdir: string) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ workdir })
      }
    });
    const content = [
      sessionMetaLine(homedir()),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
      toolCall("/private/tmp/aibill-two/alpha"),
      toolCall("/private/tmp/aibill-two/alpha"),
      toolCall("/private/tmp/aibill-two/beta"),
      tokenCountLine("2026-08-17T10:30:00.000Z")
    ].join("\n") + "\n";
    const rollout = join(codexDir, "rollout-two-projects.jsonl");
    await writeFile(rollout, content, { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const { counters, adapter } = countingOwnership(adapters);

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapter, adapters));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(scan.qualitativeFilesSkippedForBudget).toBe(0);
    expect(scan.qualitativeFilesReadCompletely).toBe(1);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(0);
    expect(scan.qualitativeProjectCoverage).toBe("complete");
    // Body evidence decides the dominant directory, identical to a direct
    // full parse; the header pass never touches a parsed file.
    const direct = parseCodexRollout(content);
    expect(direct[0]!.workingDirectory).toBe("/private/tmp/aibill-two/alpha");
    const loaded = result.calls.find((call) => call.agent === "codex")!;
    expect(loaded.workingDirectory).toBe(direct[0]!.workingDirectory);
    expect(counters.writes).toBe(0);
    expect(await adapters.readOwnership("codex", pathHashOf(rollout))).toBeUndefined();
  });

  it("caps fresh probes per run and carries the remainder over honestly", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const total = codexHeaderProbesPerScan + 1;
    for (let index = 0; index < total; index += 1) {
      await writeFile(
        join(codexDir, `rollout-cap-${String(index).padStart(3, "0")}.jsonl`),
        giantRollout(sessionMetaLine("/private/tmp/aibill-header-foreign")),
        { mode: 0o600 }
      );
    }
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const requestedRef = avref("/private/tmp/aibill-header-a");

    const first = countingOwnership(adapters);
    const run1 = await loadLocalAgentUsage(loaderOptions(home, codexDir, first.adapter, adapters, {
      coverageProjectRef: requestedRef
    }));
    const scan1 = run1.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(first.counters.writes).toBe(codexHeaderProbesPerScan);
    expect(scan1.qualitativeFilesForeignProven).toBe(codexHeaderProbesPerScan);
    expect(scan1.qualitativeFilesOwnershipUnknown).toBe(1);
    expect(scan1.qualitativeProjectCoverage).toBe("indexing");

    const second = countingOwnership(adapters);
    const run2 = await loadLocalAgentUsage(loaderOptions(home, codexDir, second.adapter, adapters, {
      coverageProjectRef: requestedRef
    }));
    const scan2 = run2.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(second.counters.writes).toBe(1);
    expect(scan2.qualitativeFilesForeignProven).toBe(total);
    expect(scan2.qualitativeFilesOwnershipUnknown).toBe(0);
    expect(scan2.qualitativeProjectCoverage).toBe("complete");
  });

  it("gives Claude transcripts no header shortcut", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const claudeDir = join(home, ".claude", "projects", "p1");
    await mkdir(claudeDir, { recursive: true });
    const giant = join(claudeDir, "giant.jsonl");
    await writeFile(
      giant,
      claudeTranscriptLine("2026-08-17T10:00:00.000Z").repeat(20),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const { counters, adapter } = countingOwnership(adapters);

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapter, adapters, {
      coverageProjectRef: avref("/tmp/example-project")
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.qualitativeFilesSkippedForBudget).toBe(1);
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    expect(counters.reads).toBe(0);
    expect(counters.writes).toBe(0);
    expect(await adapters.readOwnership("claude-code", pathHashOf(giant))).toBeUndefined();
  });

  it("rejects a malformed coverage ref instead of comparing against it", async () => {
    const { home, cacheDirectory, codexDir } = await isolatedFixture();
    const giant = join(codexDir, "rollout-badref-giant.jsonl");
    await writeFile(
      giant,
      giantRollout(sessionMetaLine("/private/tmp/aibill-header-b")),
      { mode: 0o600 }
    );
    const adapters = createProjectIndexAdapters({ cacheDirectory });

    const result = await loadLocalAgentUsage(loaderOptions(home, codexDir, adapters, adapters, {
      coverageProjectRef: "not-an-avref"
    }));
    const scan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    // Proven attribution exists, but with no valid requested ref the file can
    // never read as foreign: it keeps blocking (fail closed).
    expect(scan.qualitativeFilesForeignProven).toBe(0);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    const ownership = await adapters.readOwnership("codex", pathHashOf(giant));
    expect(ownership?.headerAttribution).toEqual({
      status: "proven",
      projectRef: avref("/private/tmp/aibill-header-b"),
      isSubagent: false
    });
  });
});
