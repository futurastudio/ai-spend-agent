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
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
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

const execFile = promisify(execFileCallback);

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
    await writeFile(file, JSON.stringify({ kind: "aibill.activity_snapshot", schemaVersion: 3 }), { mode: 0o600 });
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

  it("keeps a fresh default snapshot cache ignored when HOME is a Git worktree", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-cache-git-home-"));
    await execFile("git", ["-C", syntheticHome, "init", "--quiet"]);

    await writeActivitySnapshot(snapshot(), { homeDirectory: syntheticHome });

    expect(await readFile(join(syntheticHome, ".aibill", ".gitignore"), "utf8"))
      .toBe("*\n");
    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toMatchObject({
      status: "ok"
    });
    const { stdout } = await execFile("git", [
      "-C", syntheticHome, "status", "--short", "--", ".aibill"
    ], { encoding: "utf8" });
    expect(stdout).toBe("");
  });

  it("does not impose the default Git marker on an explicit cache override", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-cache-git-custom-home-"));
    await execFile("git", ["-C", syntheticHome, "init", "--quiet"]);
    const customDirectory = join(syntheticHome, "caller-owned-cache");
    await mkdir(customDirectory, { mode: 0o700 });

    await writeActivitySnapshot(snapshot(), {
      homeDirectory: syntheticHome,
      cacheDirectory: customDirectory
    });

    await expect(lstat(join(syntheticHome, ".aibill"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(customDirectory, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readActivitySnapshot({ cacheDirectory: customDirectory })).resolves.toMatchObject({
      status: "ok"
    });
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

/** C-lane §2.1 fleet back-compat: every v2 write dual-writes a v1 payload. */
describe("activity snapshot cache dual-write (C-lane §2.1/QA-12b)", () => {
  it("writes the v2 cache and a v1 payload side by side", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-dual-write-"));
    const written = await writeActivitySnapshot(snapshot(), { cacheDirectory: directory });
    expect(written.status).toBe("written");

    const v2Raw = JSON.parse(await readFile(join(directory, "statusline-v2.json"), "utf8")) as {
      schemaVersion: number;
      committedTotal: unknown;
    };
    expect(v2Raw.schemaVersion).toBe(2);
    expect(v2Raw.committedTotal).toEqual({ amountUsd: null, pricedSubs: 0, totalSubs: 0 });

    // The legacy file keeps today's EXACT v1 shape so an installed v1 runner
    // stays fresh instead of decaying into permanent staleness.
    const v1Raw = JSON.parse(await readFile(join(directory, "statusline-v1.json"), "utf8")) as Record<string, unknown>;
    expect(v1Raw.schemaVersion).toBe(1);
    expect(Object.keys(v1Raw).sort()).toEqual([
      "asOf", "coverage", "currency", "generatedAt", "kind", "lastAttemptAt",
      "lastSuccessAt", "metered", "mode", "networkUploaded", "overage",
      "refresh", "schemaVersion", "subscription", "unresolved"
    ]);
    const v1Info = await stat(join(directory, "statusline-v1.json"));
    expect(v1Info.mode & 0o077).toBe(0);
  });

  it("keeps the v1 payload fresh on refresh-failure writes too", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-cache-dual-fail-"));
    await writeActivitySnapshot(snapshot(), { cacheDirectory: directory });
    const failed = await recordActivitySnapshotRefreshFailure(
      "2026-08-09T19:00:00.000Z",
      "scan_failed",
      { cacheDirectory: directory }
    );
    expect(failed.status).toBe("written");
    const v1Raw = JSON.parse(await readFile(join(directory, "statusline-v1.json"), "utf8")) as {
      schemaVersion: number;
      lastAttemptAt: string;
      refresh: { status: string };
    };
    expect(v1Raw.schemaVersion).toBe(1);
    expect(v1Raw.lastAttemptAt).toBe("2026-08-09T19:00:00.000Z");
    expect(v1Raw.refresh.status).toBe("error");
  });
});

describe("~/.aibill 755 self-heal (cold-start audit NEW-B1)", () => {
  // 0.9.2's signup/telemetry writers created ~/.aibill without a mode; under
  // the default umask the guard then refused it forever. A directory holding
  // ONLY aibill's own state files is provably ours: tighten to 0700, proceed.
  it("heals a 755 directory containing only aibill state files and proceeds", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-heal-home-"));
    const aibillDirectory = join(syntheticHome, ".aibill");
    await mkdir(aibillDirectory, { mode: 0o755 });
    await chmod(aibillDirectory, 0o755); // explicit: unaffected by the test umask
    await writeFile(join(aibillDirectory, "signup.json"), "{}\n", "utf8");
    await writeFile(join(aibillDirectory, "telemetry.json"), "{}\n", "utf8");

    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toEqual({
      status: "missing"
    });
    const healed = await lstat(aibillDirectory);
    expect(healed.mode & 0o077).toBe(0);
  });

  it("still refuses a 755 directory holding anything that is not ours", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-noheal-home-"));
    const aibillDirectory = join(syntheticHome, ".aibill");
    await mkdir(aibillDirectory, { mode: 0o755 });
    await chmod(aibillDirectory, 0o755);
    await writeFile(join(aibillDirectory, "signup.json"), "{}\n", "utf8");
    await writeFile(join(aibillDirectory, "keep.txt"), "not ours\n", "utf8");

    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toEqual({
      status: "error",
      code: "unsafe_directory"
    });
    const untouched = await lstat(aibillDirectory);
    expect(untouched.mode & 0o777).toBe(0o755);
  });

  it("refuses when a subdirectory exists even if named like our files", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-subdir-home-"));
    const aibillDirectory = join(syntheticHome, ".aibill");
    await mkdir(aibillDirectory, { mode: 0o755 });
    await chmod(aibillDirectory, 0o755);
    await mkdir(join(aibillDirectory, "signup.json"));

    await expect(readActivitySnapshot({ homeDirectory: syntheticHome })).resolves.toEqual({
      status: "error",
      code: "unsafe_directory"
    });
  });
});
