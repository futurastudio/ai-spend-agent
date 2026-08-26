import { mkdtemp, chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectIndexAdapters,
  projectIndexMaxWindowedVariants,
  projectIndexFinancialParserVersion,
  type ProjectIndexFinancialKey
} from "./projectIndexStore.js";
import { localAgentQualitativeParserVersion } from "./localAgentLogs.js";
import type {
  LocalAgentQualitativeIndexKey,
  LocalAgentQualitativeIndexValue
} from "./localAgentLogs.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function isolatedStore() {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-index-v2-"));
  cleanups.push(() => rm(cacheDirectory, { recursive: true, force: true }));
  return {
    cacheDirectory,
    adapters: createProjectIndexAdapters({ cacheDirectory })
  };
}

const pathHash = "a".repeat(64);

function qualitativeKey(
  overrides: Partial<LocalAgentQualitativeIndexKey> = {}
): LocalAgentQualitativeIndexKey {
  return {
    schemaVersion: 1,
    parserVersion: localAgentQualitativeParserVersion,
    agent: "codex",
    pathHash,
    fileIdentity: "1:2:3:4:5:6",
    sinceIso: null,
    collectInvocationEvidence: true,
    ...overrides
  };
}

function callValue(model: string): LocalAgentQualitativeIndexValue {
  return {
    calls: [{
      agent: "codex",
      model,
      timestamp: "2026-08-17T12:00:00.000Z",
      usage: { inputTokens: 10, outputTokens: 5 }
    }],
    diagnostics: []
  } as unknown as LocalAgentQualitativeIndexValue;
}

function financialKey(
  overrides: Partial<ProjectIndexFinancialKey> = {}
): ProjectIndexFinancialKey {
  return {
    schemaVersion: 2,
    section: "financial",
    agent: "codex",
    pathHash,
    fileIdentity: "1:2:3:4:5:6",
    financialParserVersion: projectIndexFinancialParserVersion,
    ...overrides
  };
}

describe("projectIndexStore", () => {
  it("round-trips per-request tier evidence instead of rejecting the entry", async () => {
    // `maxRequestPromptTokens` must be part of the strict value contract. When
    // it was missing, every write failed with `unrecognized_keys`, the caller
    // swallowed the failure, and the cache never populated — turning the warm
    // sub-second path back into a full multi-GB re-parse on EVERY run.
    const { adapters } = await isolatedStore();
    const value = {
      calls: [{
        agent: "codex",
        model: "gpt-5.6-sol",
        timestamp: "2026-08-17T12:00:00.000Z",
        usageScope: "session_cumulative",
        usageSupport: "complete",
        maxRequestPromptTokens: 250_000,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 400_000 }
      }],
      diagnostics: []
    } as unknown as LocalAgentQualitativeIndexValue;

    await adapters.financial.write(financialKey(), value);
    const hit = await adapters.financial.read(financialKey());
    expect(hit?.calls[0]?.maxRequestPromptTokens).toBe(250_000);

    await adapters.qualitative.write(qualitativeKey(), value);
    expect((await adapters.qualitative.read(qualitativeKey()))?.calls[0]?.maxRequestPromptTokens)
      .toBe(250_000);
  });

  it("round-trips a qualitative entry and misses on identity change", async () => {
    const { adapters } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("gpt-5.6"));
    const hit = await adapters.qualitative.read(qualitativeKey());
    expect(hit?.calls[0]?.model).toBe("gpt-5.6");
    const miss = await adapters.qualitative.read(
      qualitativeKey({ fileIdentity: "9:9:9:9:9:9" })
    );
    expect(miss).toBeUndefined();
  });

  it("reuses a wider cached window for a narrower request (v1 narrowing rules)", async () => {
    const { adapters } = await isolatedStore();
    await adapters.qualitative.write(
      qualitativeKey({ sinceIso: null, collectInvocationEvidence: false }),
      callValue("gpt-5.6")
    );
    const narrowed = await adapters.qualitative.read(
      qualitativeKey({ sinceIso: "2026-08-10T00:00:00.000Z", collectInvocationEvidence: false })
    );
    expect(narrowed?.calls[0]?.model).toBe("gpt-5.6");
  });

  it("supersedes every stale-identity variant when the file changes", async () => {
    const { adapters } = await isolatedStore();
    await adapters.qualitative.write(
      qualitativeKey({ sinceIso: "2026-08-01T00:00:00.000Z" }),
      callValue("old-window")
    );
    await adapters.qualitative.write(
      qualitativeKey({ fileIdentity: "2:2:2:2:2:2", sinceIso: null }),
      callValue("new-identity")
    );
    const staleWindow = await adapters.qualitative.read(
      qualitativeKey({ sinceIso: "2026-08-01T00:00:00.000Z" })
    );
    expect(staleWindow).toBeUndefined();
  });

  it("bounds windowed variants, keeping the null window plus the newest windows", async () => {
    const { adapters } = await isolatedStore();
    await adapters.qualitative.write(
      qualitativeKey({ sinceIso: null, collectInvocationEvidence: false }),
      callValue("null-window")
    );
    for (let day = 1; day <= projectIndexMaxWindowedVariants + 1; day += 1) {
      await adapters.qualitative.write(
        qualitativeKey({ sinceIso: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z` }),
        callValue(`window-${day}`)
      );
    }
    expect(await adapters.qualitative.read(
      qualitativeKey({ sinceIso: null, collectInvocationEvidence: false })
    )).toBeDefined();
    // The oldest bounded window was evicted...
    const oldestExact = await adapters.qualitative.read(
      qualitativeKey({ sinceIso: "2026-08-01T00:00:00.000Z", collectInvocationEvidence: false })
    );
    // ...but the null-window variant still answers it by narrowing.
    expect(oldestExact?.calls[0]?.model).toBe("null-window");
  });

  it("keeps financial and qualitative sections independent", async () => {
    const { adapters } = await isolatedStore();
    await adapters.financial.write(financialKey(), callValue("financial-row"));
    await adapters.qualitative.write(qualitativeKey(), callValue("qualitative-row"));
    expect((await adapters.financial.read(financialKey()))?.calls[0]?.model)
      .toBe("financial-row");
    expect((await adapters.qualitative.read(qualitativeKey()))?.calls[0]?.model)
      .toBe("qualitative-row");
    const financialMiss = await adapters.financial.read(
      financialKey({ fileIdentity: "9:9:9:9:9:9" })
    );
    expect(financialMiss).toBeUndefined();
  });

  it("financial reads return clones — caller mutation never reaches the memo", async () => {
    const { adapters } = await isolatedStore();
    await adapters.financial.write(financialKey(), callValue("pristine"));
    const first = await adapters.financial.read(financialKey());
    (first!.calls[0] as Record<string, unknown>).workingDirectory = "/leaked/raw/path";
    const second = await adapters.financial.read(financialKey());
    expect((second!.calls[0] as Record<string, unknown>).workingDirectory).toBeUndefined();
  });

  it("rejects financial values carrying invocation evidence", async () => {
    const { adapters } = await isolatedStore();
    const poisoned = {
      ...callValue("x"),
      invocationWindowProof: { allCountedEventsTimestamped: true }
    } as unknown as LocalAgentQualitativeIndexValue;
    await expect(adapters.financial.write(financialKey(), poisoned)).rejects.toThrow();
  });

  it("treats a corrupt document as a miss, never as poison", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("gpt-5.6"));
    const shard = join(
      cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2), `${pathHash}.json`
    );
    await writeFile(shard, "{ torn", { mode: 0o600 });
    const fresh = createProjectIndexAdapters({ cacheDirectory });
    expect(await fresh.qualitative.read(qualitativeKey())).toBeUndefined();
    // And a rewrite repairs it.
    await fresh.qualitative.write(qualitativeKey(), callValue("repaired"));
    expect((await fresh.qualitative.read(qualitativeKey()))?.calls[0]?.model).toBe("repaired");
  });

  it("fails closed on a symlinked entry document", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("gpt-5.6"));
    const shardDirectory = join(
      cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2)
    );
    const shard = join(shardDirectory, `${pathHash}.json`);
    const target = join(cacheDirectory, "outside.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await rm(shard);
    await symlink(target, shard);
    const fresh = createProjectIndexAdapters({ cacheDirectory });
    await expect(fresh.qualitative.read(qualitativeKey())).rejects.toThrow();
  });

  it("stores ownership evidence and returns it only for the owning agent", async () => {
    const { adapters } = await isolatedStore();
    await adapters.writeOwnership("codex", pathHash, {
      status: "unknown",
      fileIdentity: "1:2:3:4:5:6",
      projectRefs: []
    });
    expect((await adapters.readOwnership("codex", pathHash))?.status).toBe("unknown");
    expect(await adapters.readOwnership("claude-code", pathHash)).toBeUndefined();
  });

  it("garbage-collects only unretained path hashes under the writer lock", async () => {
    const { adapters } = await isolatedStore();
    const otherHash = "b".repeat(64);
    await adapters.qualitative.write(qualitativeKey(), callValue("keep"));
    await adapters.qualitative.write(
      qualitativeKey({ pathHash: otherHash }),
      callValue("drop")
    );
    const { removed } = await adapters.collectGarbage({
      retainPathHashes: new Set([pathHash]),
      graceMs: 0
    });
    expect(removed).toBe(1);
    expect((await adapters.qualitative.read(qualitativeKey()))?.calls[0]?.model).toBe("keep");
    expect(await adapters.qualitative.read(qualitativeKey({ pathHash: otherHash })))
      .toBeUndefined();
  });

  it("writes private files and directories only", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("gpt-5.6"));
    const storeRoot = join(cacheDirectory, "project-index-v2");
    const shard = join(storeRoot, "entries", pathHash.slice(0, 2), `${pathHash}.json`);
    for (const path of [storeRoot, join(storeRoot, "entries"), shard]) {
      const info = await lstat(path);
      expect(info.mode & 0o077).toBe(0);
    }
    const contents = await readFile(shard, "utf8");
    expect(contents).not.toContain("workingDirectory\":");
  });

  it("strips raw working directories to refs on write", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    const value = callValue("gpt-5.6");
    const syntheticRoot = join(tmpdir(), "synthetic-project-root");
    (value.calls[0] as Record<string, unknown>).workingDirectory = syntheticRoot;
    await adapters.qualitative.write(qualitativeKey(), value);
    const shard = join(
      cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2), `${pathHash}.json`
    );
    const contents = await readFile(shard, "utf8");
    expect(contents).not.toContain(syntheticRoot);
    expect(contents).toContain("workingDirectoryRef");
  });

  it("last writer wins without tearing when two adapters race on one key", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    const second = createProjectIndexAdapters({ cacheDirectory });
    await Promise.all([
      adapters.qualitative.write(qualitativeKey(), callValue("writer-one")),
      second.qualitative.write(qualitativeKey(), callValue("writer-two"))
    ]);
    const fresh = createProjectIndexAdapters({ cacheDirectory });
    const winner = await fresh.qualitative.read(qualitativeKey());
    expect(["writer-one", "writer-two"]).toContain(winner?.calls[0]?.model);
    const shardDirectory = join(cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2));
    const litter = (await readdir(shardDirectory)).filter((name) => name.endsWith(".tmp"));
    expect(litter).toHaveLength(0);
  });

  it("treats a zero-length crash artifact as a miss and repairs on rewrite", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("gpt-5.6"));
    const shard = join(cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2), `${pathHash}.json`);
    await writeFile(shard, "", { mode: 0o600 });
    const fresh = createProjectIndexAdapters({ cacheDirectory });
    expect(await fresh.qualitative.read(qualitativeKey())).toBeUndefined();
    await fresh.qualitative.write(qualitativeKey(), callValue("repaired"));
    expect((await fresh.qualitative.read(qualitativeKey()))?.calls[0]?.model).toBe("repaired");
  });

  it("GC never removes an entry fresher than the grace window even when unretained", async () => {
    const { adapters } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("fresh"));
    const { removed } = await adapters.collectGarbage({ retainPathHashes: new Set(["b".repeat(64)]) });
    expect(removed).toBe(0);
    expect((await adapters.qualitative.read(qualitativeKey()))?.calls[0]?.model).toBe("fresh");
  });

  it("a write never clobbers a variant another process persisted since this process last read", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    const external = createProjectIndexAdapters({ cacheDirectory });
    await adapters.qualitative.write(qualitativeKey(), callValue("mine"));
    await adapters.qualitative.read(qualitativeKey());
    await external.qualitative.write(qualitativeKey({ sinceIso: "2026-08-10T00:00:00.000Z" }), callValue("theirs"));
    await adapters.qualitative.write(qualitativeKey({ sinceIso: "2026-08-12T00:00:00.000Z" }), callValue("refresh"));
    expect((await external.qualitative.read(
      qualitativeKey({ sinceIso: "2026-08-10T00:00:00.000Z" })
    ))?.calls[0]?.model).toBe("theirs");
  });

  it("rejects qualitative calls that do not belong to the keyed agent", async () => {
    const { adapters } = await isolatedStore();
    const foreign = callValue("x");
    (foreign.calls[0] as Record<string, unknown>).agent = "claude-code";
    await expect(adapters.qualitative.write(qualitativeKey(), foreign)).rejects.toThrow();
  });

  it("never serves ownership recorded for a superseded file identity", async () => {
    const { adapters } = await isolatedStore();
    await adapters.writeOwnership("codex", pathHash, {
      status: "resolved",
      fileIdentity: "1:2:3:4:5:6",
      projectRefs: [`avref_${"c".repeat(64)}`]
    });
    await adapters.qualitative.write(qualitativeKey({ fileIdentity: "7:7:7:7:7:7" }), callValue("rotated"));
    expect(await adapters.readOwnership("codex", pathHash)).toBeUndefined();
  });

  it("prefers the exact windowed variant over a compatible wider one", async () => {
    const { adapters } = await isolatedStore();
    const windowed = qualitativeKey({ sinceIso: "2026-08-10T00:00:00.000Z", collectInvocationEvidence: false });
    await adapters.qualitative.write(qualitativeKey({ sinceIso: null, collectInvocationEvidence: false }), callValue("wide"));
    await adapters.qualitative.write(windowed, callValue("exact"));
    expect((await adapters.qualitative.read(windowed))?.calls[0]?.model).toBe("exact");
  });

  it("refuses to narrow a wider invocation-bearing variant without a window proof", async () => {
    const { adapters } = await isolatedStore();
    const value = {
      ...callValue("wide"),
      invocationFile: {
        invocations: [{ name: "shell", count: 2 }],
        invokedMcpTools: [], invokedSkills: [], invokedSubagents: [], invokedCommands: [],
        assistantTurns: 3,
        contextSignal: {
          agent: "codex", compactionEvents: 0, fileReads: [], repeatedFileReads: [],
          isSubagent: false, readCoverage: "explicit_read_tools_only"
        }
      }
    } as unknown as LocalAgentQualitativeIndexValue;
    await adapters.qualitative.write(qualitativeKey({ sinceIso: null }), value);
    expect(await adapters.qualitative.read(qualitativeKey({ sinceIso: "2026-08-10T00:00:00.000Z" }))).toBeUndefined();
  });

  it("sweeps crash-orphaned tmp litter during GC and tolerates non-entry litter", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("keep"));
    const shardDirectory = join(cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2));
    await writeFile(join(shardDirectory, `${pathHash}.json.999.dead.tmp`), "{ torn", { mode: 0o600 });
    await mkdir(join(shardDirectory, "litter.json"), { mode: 0o700 });
    await adapters.collectGarbage({ retainPathHashes: new Set([pathHash]), graceMs: 0 });
    expect((await readdir(shardDirectory)).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    expect((await adapters.qualitative.read(qualitativeKey()))?.calls[0]?.model).toBe("keep");
  });

  it("leaves the v1 qualitative index untouched", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    const v1Path = join(cacheDirectory, "qualitative-index-v1.json");
    await writeFile(v1Path, `${JSON.stringify({ kind: "aibill.qualitative_index", schemaVersion: 1, entries: [] })}\n`, { mode: 0o600 });
    await adapters.qualitative.write(qualitativeKey(), callValue("x"));
    await adapters.collectGarbage({ retainPathHashes: new Set() });
    expect(await readFile(v1Path, "utf8")).toContain("aibill.qualitative_index");
  });

  it("fails closed on a document written by a newer store version", async () => {
    const { adapters, cacheDirectory } = await isolatedStore();
    await adapters.qualitative.write(qualitativeKey(), callValue("current"));
    const shard = join(cacheDirectory, "project-index-v2", "entries", pathHash.slice(0, 2), `${pathHash}.json`);
    await writeFile(shard, `${JSON.stringify({ kind: "aibill.project_index_file", schemaVersion: 3 })}\n`, { mode: 0o600 });
    const fresh = createProjectIndexAdapters({ cacheDirectory });
    await expect(fresh.qualitative.read(qualitativeKey())).rejects.toThrow();
  });

  it("refuses an unsafe cache directory", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-index-loose-"));
    cleanups.push(() => rm(cacheDirectory, { recursive: true, force: true }));
    await mkdir(join(cacheDirectory, "keep"), { recursive: true });
    await chmod(cacheDirectory, 0o755);
    const adapters = createProjectIndexAdapters({ cacheDirectory });
    if (process.platform !== "win32") {
      await expect(
        adapters.qualitative.write(qualitativeKey(), callValue("x"))
      ).rejects.toThrow();
    }
  });
});
