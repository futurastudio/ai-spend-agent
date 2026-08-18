import { appendFile, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalAgentFinancialUsage,
  loadLocalAgentUsage,
  localAgentFinancialParserVersion,
  localAgentQualitativeParserVersion
} from "./localAgentLogs.js";
import {
  createProjectIndexAdapters,
  projectIndexFinancialParserVersion
} from "./projectIndexStore.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), "aibill-a2-home-"));
  const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-a2-cache-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  await mkdir(join(home, ".claude", "projects", "p1"), { recursive: true });
  return { home, cacheDirectory };
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

const policy = { maxFileBytes: 512, maxSourceBytes: 1024 } as const;

describe("A2 budget exemption and per-project coverage", () => {
  it("admits an index-hit file that exceeds every byte budget without charging it", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    const giant = join(home, ".claude", "projects", "p1", "giant.jsonl");
    // ~40 lines: far beyond maxFileBytes (512) — unparseable without a hit.
    await writeFile(
      giant,
      claudeTranscriptLine("2026-08-17T10:00:00.000Z").repeat(40),
      { mode: 0o600 }
    );
    const small = join(home, ".claude", "projects", "p1", "small.jsonl");
    await writeFile(small, claudeTranscriptLine("2026-08-17T11:00:00.000Z"), { mode: 0o600 });

    const adapters = createProjectIndexAdapters({ cacheDirectory });

    // Cold: the giant must be skipped for budget and block coverage.
    const cold = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapters.qualitative
    });
    const coldScan = cold.sourceScans.find((scan) => scan.agent === "claude-code")!;
    expect(coldScan.qualitativeFilesSkippedForBudget).toBe(1);
    expect(coldScan.qualitativeCoverage).toBe("partial");
    expect(coldScan.qualitativeProjectCoverage).toBe("indexing");
    expect(coldScan.qualitativeFilesOwnershipUnknown).toBe(1);

    // Seed the index with the giant's evidence under its exact current key.
    const info = await stat(giant);
    const key: import("./localAgentLogs.js").LocalAgentQualitativeIndexKey = {
      schemaVersion: 1 as const,
      parserVersion: localAgentQualitativeParserVersion,
      agent: "claude-code" as const,
      pathHash: createHash("sha256").update(giant).digest("hex"),
      fileIdentity: [
        info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs
      ].join(":"),
      sinceIso: null,
      collectInvocationEvidence: false
    };
    await adapters.qualitative.write(key, {
      calls: [{
        agent: "claude-code",
        model: "claude-fable-5",
        timestamp: "2026-08-17T10:00:00.000Z",
        usage: { inputTokens: 4000, outputTokens: 800 }
      }],
      diagnostics: []
    } as never);

    // Warm: the hit bypasses the budget, coverage completes, nothing charged.
    const warm = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapters.qualitative
    });
    const warmScan = warm.sourceScans.find((scan) => scan.agent === "claude-code")!;
    expect(warmScan.qualitativeFilesSkippedForBudget).toBe(0);
    expect(warmScan.qualitativeCoverage).toBe("complete");
    expect(warmScan.qualitativeProjectCoverage).toBe("complete");
    expect(warmScan.qualitativeIndexHits).toBeGreaterThanOrEqual(1);
    expect(warmScan.qualitativeFilesOwnershipUnknown).toBe(0);
    // The small file still fit its untouched budget alongside the giant.
    expect(warmScan.qualitativeFilesReadCompletely).toBe(2);
    const giantCall = warm.calls.find((call) => call.usage.inputTokens === 4000);
    expect(giantCall).toBeDefined();
  });

  it("keeps project coverage fail-closed on an unreadable source directory", async () => {
    if (process.platform === "win32") return;
    const { home, cacheDirectory } = await isolatedHome();
    const projects = join(home, ".claude", "projects");
    await writeFile(
      join(projects, "p1", "a.jsonl"),
      claudeTranscriptLine("2026-08-17T10:00:00.000Z"),
      { mode: 0o600 }
    );
    await chmod(join(projects, "p1"), 0o000);
    cleanups.push(async () => {
      await chmod(join(projects, "p1"), 0o700);
    });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapters.qualitative
    });
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    expect(scan.qualitativeCoverage).toBe("partial");
  });

  it("fails closed when a selected file changes between selection and its bounded read", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    const target = join(home, ".claude", "projects", "p1", "growing.jsonl");
    await writeFile(target, claudeTranscriptLine("2026-08-17T10:00:00.000Z"), { mode: 0o600 });
    const real = createProjectIndexAdapters({ cacheDirectory }).qualitative;
    let reads = 0;
    const adapter = {
      read: async (key: never) => {
        reads += 1;
        if (reads === 2) await appendFile(target, claudeTranscriptLine("2026-08-17T10:01:00.000Z"));
        return real.read(key);
      },
      write: real.write
    };
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapter as never
    });
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.unreadableFiles).toBe(1);
    expect(scan.qualitativeFilesSkippedForBudget).toBe(0);
    expect(scan.qualitativeCoverage).toBe("partial");
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
  });

  it("re-applies the byte budget when an exempt hit is evicted between probes", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    const giant = join(home, ".claude", "projects", "p1", "giant.jsonl");
    await writeFile(giant, claudeTranscriptLine("2026-08-17T10:00:00.000Z").repeat(40), { mode: 0o600 });
    const real = createProjectIndexAdapters({ cacheDirectory }).qualitative;
    const info = await stat(giant);
    await real.write({
      schemaVersion: 1,
      parserVersion: localAgentQualitativeParserVersion,
      agent: "claude-code",
      pathHash: createHash("sha256").update(giant).digest("hex"),
      fileIdentity: [
        info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.birthtimeMs
      ].join(":"),
      sinceIso: null,
      collectInvocationEvidence: false
    }, {
      calls: [{
        agent: "claude-code",
        model: "claude-fable-5",
        timestamp: "2026-08-17T10:00:00.000Z",
        usage: { inputTokens: 4000, outputTokens: 800 }
      }],
      diagnostics: []
    } as never);
    let reads = 0;
    const evicting = {
      read: async (key: never) => {
        reads += 1;
        return reads === 1 ? real.read(key) : undefined;
      },
      write: real.write
    };
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: evicting as never
    });
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.qualitativeBytesRead ?? 0).toBeLessThanOrEqual(policy.maxSourceBytes);
    expect(scan.qualitativeFilesSkippedForBudget).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
  });

  it("counts an empty eligible file as indexed and keeps project coverage complete", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    await writeFile(join(home, ".claude", "projects", "p1", "empty.jsonl"), "", { mode: 0o600 });
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapters.qualitative
    });
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.qualitativeFilesReadCompletely).toBe(1);
    expect(scan.qualitativeFilesOwnershipUnknown).toBe(0);
    expect(scan.qualitativeProjectCoverage).toBe("complete");
  });

  it("surfaces index failures as a diagnostic, counts them once, and stays fail-closed", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    await writeFile(
      join(home, ".claude", "projects", "p1", "a.jsonl"),
      claudeTranscriptLine("2026-08-17T10:00:00.000Z"),
      { mode: 0o600 }
    );
    void cacheDirectory;
    const throwing = {
      read: async () => {
        throw new Error("store offline");
      },
      // Writes succeed so the assertion isolates read-probe deduplication;
      // a write failure is a legitimate second index error.
      write: async () => undefined
    };
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: throwing as never
    });
    const scan = result.sourceScans.find((entry) => entry.agent === "claude-code")!;
    expect(scan.qualitativeIndexErrors).toBe(1);
    expect(scan.qualitativeProjectCoverage).toBe("indexing");
    const diagnostic = result.diagnostics.find((entry) => entry.code === "qualitative_index_error");
    expect(diagnostic?.count).toBe(1);
  });

  it("a narrow-window warm financial cache never truncates a later wider report", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    const recent = new Date(Date.now() - 1 * 864e5).toISOString();
    await writeFile(
      join(home, ".claude", "projects", "p1", "s.jsonl"),
      claudeTranscriptLine(old) + claudeTranscriptLine(recent),
      { mode: 0o600 }
    );
    const financialIndex = createProjectIndexAdapters({ cacheDirectory }).financial;
    const base = {
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      geminiSessionsDir: join(home, "no-gemini-here"),
      financialIndex
    };
    const narrow = await loadLocalAgentFinancialUsage({
      ...base,
      sinceIso: new Date(Date.now() - 7 * 864e5).toISOString()
    });
    expect(narrow.calls).toHaveLength(1);
    const wide = await loadLocalAgentFinancialUsage(base);
    expect(wide.calls).toHaveLength(2);
  });

  it("warm financial runs equal cold on records, calls, and diagnostics", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    await writeFile(
      join(home, ".claude", "projects", "p1", "a.jsonl"),
      claudeTranscriptLine("2026-08-16T10:00:00.000Z") + "not json\n" +
        claudeTranscriptLine("2026-08-16T11:00:00.000Z"),
      { mode: 0o600 }
    );
    await writeFile(
      join(home, ".claude", "projects", "p1", "b.jsonl"),
      claudeTranscriptLine("2026-08-16T12:00:00.000Z"),
      { mode: 0o600 }
    );
    const financialIndex = createProjectIndexAdapters({ cacheDirectory }).financial;
    const base = {
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      geminiSessionsDir: join(home, "no-gemini-here"),
      financialIndex
    };
    const cold = await loadLocalAgentFinancialUsage(base);
    const warm = await loadLocalAgentFinancialUsage(base);
    expect(warm.records).toEqual(cold.records);
    expect(warm.calls.map(({ workingDirectory: _w, workingDirectoryRef: _r, ...call }) => call))
      .toEqual(cold.calls.map(({ workingDirectory: _w, workingDirectoryRef: _r, ...call }) => call));
    expect(warm.diagnostics).toEqual(cold.diagnostics);
    expect(warm.filesParsed).toBe(cold.filesParsed);
  });

  it("keeps the loader and store financial parser versions in lockstep", () => {
    expect(localAgentFinancialParserVersion).toBe(projectIndexFinancialParserVersion);
  });

  it("treats an absent agent directory as complete, never as a failure", async () => {
    const { home, cacheDirectory } = await isolatedHome();
    // No codex directory exists at all in this home.
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(home, ".claude", "projects"),
      codexSessionsDir: join(home, "no-codex-here"),
      qualitativeScan: policy,
      qualitativeIndex: adapters.qualitative
    });
    const codexScan = result.sourceScans.find((entry) => entry.agent === "codex")!;
    expect(codexScan.directoryStatus).toBe("missing");
    expect(codexScan.qualitativeProjectCoverage).toBe("complete");
    expect(codexScan.qualitativeFilesOwnershipUnknown).toBe(0);
  });
});
