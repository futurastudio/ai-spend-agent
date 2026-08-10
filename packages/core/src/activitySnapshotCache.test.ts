import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  activitySnapshotSchema,
  buildActivitySnapshot,
  type ActivitySnapshot
} from "./activitySnapshot.js";
import {
  activitySnapshotCacheEnvironmentVariable,
  activitySnapshotCacheFileName,
  activitySnapshotCacheMaxBytes,
  activitySnapshotCachePath,
  readActivitySnapshot,
  recordActivitySnapshotRefreshFailure,
  writeActivitySnapshot
} from "./activitySnapshotCache.js";
import type { LocalAgentSourceScan } from "./localAgentLogs.js";
import type { UsageRecord } from "./schema.js";

const AS_OF = "2026-08-09T18:00:00.000Z";
const originalCacheEnvironment = process.env[activitySnapshotCacheEnvironmentVariable];

afterEach(() => {
  if (originalCacheEnvironment === undefined) {
    delete process.env[activitySnapshotCacheEnvironmentVariable];
  } else {
    process.env[activitySnapshotCacheEnvironmentVariable] = originalCacheEnvironment;
  }
});

function localRecord(amountUsd = 2): UsageRecord {
  return {
    id: "local-codex-1",
    timestamp: "2026-08-09T12:00:00.000Z",
    source: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      provider: "openai",
      confidence: "estimated",
      observedFrom: "local transcript"
    },
    model: "gpt-5.6-sol",
    inputTokens: 100,
    outputTokens: 10,
    amountUsd,
    costConfidence: "estimated",
    agentId: "codex",
    providerCostType: "local_agent_logs",
    usageGranularity: "daily_aggregate"
  };
}

function codexScan(): LocalAgentSourceScan {
  return {
    agent: "codex",
    directoryStatus: "readable",
    filesDiscovered: 1,
    filesParsed: 1,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0,
    jsonlValidationCoverage: "complete"
  };
}

function snapshot(amountUsd = 2): ActivitySnapshot {
  return buildActivitySnapshot({
    asOf: AS_OF,
    generatedAt: AS_OF,
    records: [localRecord(amountUsd)],
    detectedPlans: [{
      agent: "codex",
      provider: "openai",
      planLabel: "API key",
      billing: "api_key",
      source: "local config"
    }],
    sourceScans: [codexScan()]
  });
}

function withTimes(
  value: ActivitySnapshot,
  lastAttemptAt: string,
  generatedAt = lastAttemptAt
): ActivitySnapshot {
  return activitySnapshotSchema.parse({
    ...value,
    asOf: lastAttemptAt,
    generatedAt,
    lastAttemptAt,
    lastSuccessAt: lastAttemptAt
  });
}

describe("activity snapshot cache", () => {
  it("uses the isolated environment override and writes private atomic state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-env-"));
    process.env[activitySnapshotCacheEnvironmentVariable] = directory;

    expect(activitySnapshotCachePath()).toBe(join(directory, activitySnapshotCacheFileName));
    await expect(readActivitySnapshot()).resolves.toEqual({ status: "missing" });
    const written = await writeActivitySnapshot(snapshot());
    expect(written.status).toBe("written");
    await expect(readActivitySnapshot()).resolves.toMatchObject({
      status: "ok",
      snapshot: { mode: "metered" }
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, activitySnapshotCacheFileName))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(directory, activitySnapshotCacheFileName), "utf8")).toString())
      .not.toContain("local config");
  });

  it("fails closed on future versions, malformed JSON, oversized files, and leak fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-invalid-"));
    const file = join(directory, activitySnapshotCacheFileName);
    await writeFile(file, JSON.stringify({ kind: "aibill.activity_snapshot", schemaVersion: 2 }), { mode: 0o600 });
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "error",
      code: "unsupported_version"
    });
    await expect(writeActivitySnapshot(snapshot(), { cacheDirectory: directory }))
      .rejects.toMatchObject({ code: "unsupported_version" });
    await expect(recordActivitySnapshotRefreshFailure(
      AS_OF,
      "scan_failed",
      { cacheDirectory: directory }
    )).rejects.toMatchObject({ code: "unsupported_version" });

    await writeFile(file, "{", { mode: 0o600 });
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "error",
      code: "malformed"
    });

    const valid = snapshot();
    const semanticFailures = [
      {
        ...valid,
        coverage: { ...valid.coverage, recordsUnpriced: valid.coverage.recordsUnpriced + 1 }
      },
      {
        ...valid,
        generatedAt: "2026-08-09T17:59:59.000Z"
      },
      {
        ...valid,
        coverage: {
          ...valid.coverage,
          providers: [{
            provider: "openai",
            status: "partial",
            validationCoverage: "live_verified",
            checkedAt: "2026-08-09T18:00:01.000Z",
            latestEvidenceAt: null,
            coverageStart: null,
            coverageEnd: null
          }]
        }
      }
    ];
    for (const invalid of semanticFailures) {
      await writeFile(file, JSON.stringify(invalid), { mode: 0o600 });
      await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
        status: "error",
        code: "malformed"
      });
    }

    await writeFile(file, "x".repeat(activitySnapshotCacheMaxBytes + 1), { mode: 0o600 });
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "error",
      code: "oversized"
    });

    const leaked = {
      ...snapshot(),
      prompt: "private-prompt-marker",
      path: "private-path-marker",
      credential: "private-credential-marker\u0007"
    };
    await writeFile(file, JSON.stringify(leaked), { mode: 0o600 });
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "error",
      code: "malformed"
    });
  });

  it("refuses symlinked, non-regular, and non-private cache paths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aibill-cache-outside-"));
    const parent = await mkdtemp(join(tmpdir(), "aibill-cache-links-"));
    const linkedDirectory = join(parent, "cache");
    await symlink(outside, linkedDirectory);
    await expect(readActivitySnapshot({ cacheDirectory: linkedDirectory })).resolves.toEqual({
      status: "error",
      code: "unsafe_directory"
    });
    await expect(writeActivitySnapshot(snapshot(), { cacheDirectory: linkedDirectory }))
      .rejects.toMatchObject({ code: "unsafe_directory" });

    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-entry-"));
    const file = join(directory, activitySnapshotCacheFileName);
    const target = join(outside, "target.json");
    await writeFile(target, JSON.stringify(snapshot()), { mode: 0o600 });
    await symlink(target, file);
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "error",
      code: "unsafe_file"
    });
    await expect(writeActivitySnapshot(snapshot(), { cacheDirectory: directory }))
      .rejects.toMatchObject({ code: "unsafe_file" });

    const nonRegularDirectory = await mkdtemp(join(tmpdir(), "aibill-cache-nonregular-"));
    await mkdir(join(nonRegularDirectory, activitySnapshotCacheFileName));
    await expect(readActivitySnapshot({ cacheDirectory: nonRegularDirectory })).resolves.toEqual({
      status: "error",
      code: "unsafe_file"
    });

    const publicDirectory = await mkdtemp(join(tmpdir(), "aibill-cache-public-"));
    await chmod(publicDirectory, 0o755);
    await expect(readActivitySnapshot({ cacheDirectory: publicDirectory })).resolves.toEqual({
      status: "error",
      code: "unsafe_directory"
    });

    const publicFileDirectory = await mkdtemp(join(tmpdir(), "aibill-cache-public-file-"));
    await writeFile(
      join(publicFileDirectory, activitySnapshotCacheFileName),
      JSON.stringify(snapshot()),
      { mode: 0o644 }
    );
    await expect(readActivitySnapshot({ cacheDirectory: publicFileDirectory })).resolves.toEqual({
      status: "error",
      code: "unsafe_file"
    });
  });

  it("refuses a symlinked default ~/.aibill ancestor on reads and writes", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-cache-home-"));
    const outside = await mkdtemp(join(tmpdir(), "aibill-cache-home-outside-"));
    await mkdir(join(outside, "cache"));
    await symlink(outside, join(syntheticHome, ".aibill"));

    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toEqual({
      status: "error",
      code: "unsafe_directory"
    });
    await expect(writeActivitySnapshot(snapshot(), { homeDirectory: syntheticHome }))
      .rejects.toMatchObject({ code: "unsafe_directory" });
  });

  it("prevents a slower older writer from replacing a newer snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-newer-"));
    const older = withTimes(snapshot(1), "2026-08-09T18:00:01.000Z");
    const newer = withTimes(snapshot(9), "2026-08-09T18:00:02.000Z");

    await expect(writeActivitySnapshot(newer, { cacheDirectory: directory }))
      .resolves.toMatchObject({ status: "written" });
    await expect(writeActivitySnapshot(older, { cacheDirectory: directory }))
      .resolves.toMatchObject({ status: "skipped_older" });
    const read = await readActivitySnapshot({ cacheDirectory: directory });
    expect(read).toMatchObject({
      status: "ok",
      snapshot: { metered: { apiEquivalent: { sevenDays: { amountUsd: 9 } } } }
    });
  });

  it("retains the last-good values when a newer refresh fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-failure-"));
    const good = withTimes(snapshot(4), "2026-08-09T18:00:01.000Z");
    await writeActivitySnapshot(good, { cacheDirectory: directory });

    const result = await recordActivitySnapshotRefreshFailure(
      "2026-08-09T18:00:02.000Z",
      "scan_failed",
      { cacheDirectory: directory }
    );
    expect(result).toMatchObject({
      status: "written",
      snapshot: {
        lastAttemptAt: "2026-08-09T18:00:02.000Z",
        lastSuccessAt: "2026-08-09T18:00:01.000Z",
        refresh: { status: "error", errorCode: "scan_failed" },
        metered: { apiEquivalent: { sevenDays: { amountUsd: 4 } } }
      }
    });
    expect(result.snapshot.generatedAt).toBe(good.generatedAt);

    await expect(recordActivitySnapshotRefreshFailure(
      "2026-08-09T18:00:00.000Z",
      "timeout",
      { cacheDirectory: directory }
    )).resolves.toMatchObject({
      status: "skipped_older",
      snapshot: { refresh: { errorCode: "scan_failed" } }
    });
  });

  it("skips an overlapping failure that began before a later success finished", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-overlap-"));
    const successful = activitySnapshotSchema.parse({
      ...snapshot(7),
      asOf: "2026-08-09T18:00:00.000Z",
      generatedAt: "2026-08-09T18:00:16.000Z",
      lastAttemptAt: "2026-08-09T18:00:00.000Z",
      lastSuccessAt: "2026-08-09T18:00:16.000Z"
    });
    await writeActivitySnapshot(successful, { cacheDirectory: directory });

    await expect(recordActivitySnapshotRefreshFailure(
      "2026-08-09T18:00:05.000Z",
      "timeout",
      { cacheDirectory: directory }
    )).resolves.toMatchObject({
      status: "skipped_older",
      snapshot: {
        generatedAt: "2026-08-09T18:00:16.000Z",
        refresh: { status: "ok" }
      }
    });
  });

  it("writes a typed no-evidence error when the first refresh fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-first-failure-"));
    await expect(recordActivitySnapshotRefreshFailure(
      AS_OF,
      "source_unreadable",
      { cacheDirectory: directory }
    )).resolves.toMatchObject({
      status: "written",
      snapshot: {
        mode: "error",
        lastSuccessAt: null,
        refresh: { status: "error", errorCode: "source_unreadable" }
      }
    });
  });

  it("serializes concurrent writers and readers without torn JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-concurrent-"));
    await writeActivitySnapshot(
      withTimes(snapshot(0), "2026-08-09T18:00:00.000Z"),
      { cacheDirectory: directory }
    );
    const writers = Array.from({ length: 8 }, (_, index) => writeActivitySnapshot(
      withTimes(
        snapshot(index + 1),
        `2026-08-09T18:00:${String(index + 1).padStart(2, "0")}.000Z`
      ),
      { cacheDirectory: directory }
    ));
    const readers = Array.from({ length: 50 }, () =>
      readActivitySnapshot({ cacheDirectory: directory })
    );
    const results = await Promise.all([...writers, ...readers]);
    for (const result of results.slice(writers.length)) {
      expect(result.status).toBe("ok");
    }
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toMatchObject({
      status: "ok",
      snapshot: { metered: { apiEquivalent: { sevenDays: { amountUsd: 8 } } } }
    });
    expect((await lstat(join(directory, activitySnapshotCacheFileName))).isFile()).toBe(true);
  });

  it("handles concurrent first writes into a clean default home", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-cache-clean-home-"));
    const older = withTimes(snapshot(1), "2026-08-09T18:00:01.000Z");
    const newer = withTimes(snapshot(2), "2026-08-09T18:00:02.000Z");

    await expect(Promise.all([
      writeActivitySnapshot(older, { homeDirectory: syntheticHome }),
      writeActivitySnapshot(newer, { homeDirectory: syntheticHome })
    ])).resolves.toHaveLength(2);
    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toMatchObject({
      status: "ok",
      snapshot: { metered: { apiEquivalent: { sevenDays: { amountUsd: 2 } } } }
    });
    expect((await stat(join(syntheticHome, ".aibill"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(syntheticHome, ".aibill", "cache"))).mode & 0o777).toBe(0o700);
  });

  it("never evicts a stale-looking lock owned by a live process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-live-lock-"));
    const lockPath = join(directory, ".statusline-v1.lock");
    const owner = { pid: process.pid, token: "live-owner-token-0000000000000001" };
    await writeFile(lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(writeActivitySnapshot(snapshot(), {
      cacheDirectory: directory,
      lockTimeoutMs: 25
    })).rejects.toMatchObject({ code: "lock_timeout" });
    await expect(readFile(lockPath, "utf8")).resolves.toContain(owner.token);
    await expect(readActivitySnapshot({ cacheDirectory: directory })).resolves.toEqual({
      status: "missing"
    });
  });

  it("recovers an old lock only when its recorded process is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-dead-lock-"));
    const lockPath = join(directory, ".statusline-v1.lock");
    await writeFile(lockPath, `${JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner-token-0000000000000001"
    })}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    await expect(writeActivitySnapshot(snapshot(), {
      cacheDirectory: directory,
      lockTimeoutMs: 250
    })).resolves.toMatchObject({ status: "written" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps cached read p95 below the 100ms acceptance target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-benchmark-"));
    await writeActivitySnapshot(snapshot(), { cacheDirectory: directory });
    const durations: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const started = performance.now();
      const result = await readActivitySnapshot({ cacheDirectory: directory });
      durations.push(performance.now() - started);
      expect(result.status).toBe("ok");
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    expect(p95).toBeLessThan(100);
  });
});
