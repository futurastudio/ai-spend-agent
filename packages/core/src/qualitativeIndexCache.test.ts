import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalAgentUsage,
  localAgentQualitativeParserVersion,
  type LocalAgentCall,
  type LocalAgentQualitativeIndexKey,
  type LocalAgentQualitativeIndexValue
} from "./localAgentLogs.js";
import { selectBestWasteFindingV0 } from "./actionPlanner.js";
import { extractSessionVitalsV0 } from "./sessionVitals.js";
import {
  createQualitativeIndexCacheAdapter,
  qualitativeIndexCacheEnvironmentVariable,
  qualitativeIndexCacheFileName,
  qualitativeIndexCacheLockFileName,
  qualitativeIndexCachePath
} from "./qualitativeIndexCache.js";

const execFile = promisify(execFileCallback);

const originalCacheEnvironment = process.env[qualitativeIndexCacheEnvironmentVariable];
const syntheticPrivateRoot = join(tmpdir(), "aibill-private-fixture");
const syntheticSecretProjectDirectory = join(syntheticPrivateRoot, "secret-project");
const syntheticAgentFinopsDirectory = join(syntheticPrivateRoot, "agent-finops");

afterEach(() => {
  if (originalCacheEnvironment === undefined) {
    delete process.env[qualitativeIndexCacheEnvironmentVariable];
  } else {
    process.env[qualitativeIndexCacheEnvironmentVariable] = originalCacheEnvironment;
  }
});

function key(
  pathHashCharacter = "a",
  overrides: Partial<LocalAgentQualitativeIndexKey> = {}
): LocalAgentQualitativeIndexKey {
  return {
    schemaVersion: 1,
    parserVersion: localAgentQualitativeParserVersion,
    agent: "codex",
    pathHash: pathHashCharacter.repeat(64),
    fileIdentity: "1:2:300:400.5:500.5:600.5",
    sinceIso: "2026-08-01T00:00:00.000Z",
    collectInvocationEvidence: false,
    ...overrides
  };
}

function value(overrides: Partial<LocalAgentQualitativeIndexValue> = {}): LocalAgentQualitativeIndexValue {
  return {
    calls: [{
      agent: "codex",
      callId: "turn-1",
      model: "gpt-5.6-sol",
      timestamp: "2026-08-15T12:00:00.000Z",
      project: "agent-finops",
      workingDirectory: syntheticSecretProjectDirectory,
      usageScope: "turn",
      usageSupport: "complete",
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 400
      },
      activity: {
        summary: "Refining aibill prompt",
        kind: "task",
        action: "refining",
        source: "user_prompts",
        promptCount: 2,
        toolCallCount: 1,
        files: ["index.ts"],
        isSubagent: false
      }
    }],
    diagnostics: [],
    ...overrides
  };
}

function invocationValue(): LocalAgentQualitativeIndexValue {
  return value({
    invocationFile: {
      invocations: [{ name: "Read", count: 2 }],
      invokedMcpTools: [],
      invokedSkills: [],
      invokedSubagents: [],
      invokedCommands: [],
      assistantTurns: 1,
      contextSignal: {
        agent: "codex",
        sessionId: "session-1",
        lastActivityAt: "2026-08-15T12:00:00.000Z",
        compactionEvents: 0,
        fileReads: [{ name: "index.ts", count: 2 }],
        repeatedFileReads: [{ name: "index.ts", count: 2 }],
        isSubagent: false,
        readCoverage: "explicit_read_tools_only"
      }
    },
    invocationWindowProof: {
      earliestCountedAt: "2026-08-15T12:00:00.000Z",
      allCountedEventsTimestamped: true
    }
  });
}

function plannerCall(
  sessionId: string,
  timestamp: string,
  inputTokens: number
): LocalAgentCall {
  return {
    agent: "codex",
    callId: `turn-${sessionId}`,
    model: "gpt-5.6-sol",
    timestamp,
    startedAt: timestamp,
    project: "agent-finops",
    workingDirectory: syntheticAgentFinopsDirectory,
    usageScope: "turn",
    usageSupport: "complete",
    usage: {
      inputTokens,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0
    },
    tokenComponentEvidence: {
      inputTokens: "observed",
      outputTokens: "observed",
      cacheReadTokens: "observed",
      cacheWriteTokens: "observed",
      thoughtTokens: "not_separately_reported",
      toolTokens: "not_separately_reported",
      calculatedTotalTokens: "calculated_complete",
      reportedTotalTokens: "not_reported"
    },
    sessionId,
    sourceVersion: "2.1.170",
    completion: {
      status: "completed",
      evidence: "codex_task_complete",
      observedAt: timestamp
    },
    activity: {
      summary: "Refining launch flow",
      kind: "task",
      action: "refining",
      source: "user_prompts",
      promptCount: 1,
      toolCallCount: 1,
      files: ["index.ts"],
      isSubagent: false
    }
  };
}

describe("private qualitative index cache", () => {
  it("uses AIBILL_CACHE_DIR, writes private atomic state, and never persists raw paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-env-"));
    process.env[qualitativeIndexCacheEnvironmentVariable] = directory;
    const adapter = createQualitativeIndexCacheAdapter();

    expect(qualitativeIndexCachePath()).toBe(join(directory, qualitativeIndexCacheFileName));
    await adapter.write(key(), value());

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const file = join(directory, qualitativeIndexCacheFileName);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(file, "utf8");
    expect(persisted).not.toContain(syntheticPrivateRoot);
    expect(persisted).not.toContain("\"workingDirectory\":");
    expect(persisted).not.toContain("prompt\":");

    await expect(adapter.read(key())).resolves.toMatchObject({
      calls: [{ agent: "codex", project: "agent-finops" }]
    });
    expect((await adapter.read(key()))?.calls[0]?.workingDirectory).toBeUndefined();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("round-trips subagent run identity and host completion records through the strict schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-subagent-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const claudeKey = key("a", { agent: "claude-code" });
    await adapter.write(claudeKey, value({
      calls: [{
        agent: "claude-code",
        callId: "sub-call-1",
        model: "claude-sonnet-5",
        timestamp: "2026-08-15T12:00:00.000Z",
        project: "agent-finops",
        usageScope: "turn",
        usage: { inputTokens: 10, outputTokens: 5 },
        sessionId: "parent-session",
        subagentId: "a1234567890abcdef",
        subagentCompletions: [
          { subagentId: "a1234567890abcdef", observedAt: "2026-08-15T12:05:00.000Z" }
        ]
      }]
    }));

    // An index miss here would count as an index error and stall coverage, so
    // the split-run identity must survive the persistence boundary exactly.
    await expect(adapter.read(claudeKey)).resolves.toMatchObject({
      calls: [{
        subagentId: "a1234567890abcdef",
        subagentCompletions: [
          { subagentId: "a1234567890abcdef", observedAt: "2026-08-15T12:05:00.000Z" }
        ]
      }]
    });
  });

  it("binds hits to path hash, complete stat identity, parser, compatible window, and invocation mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-key-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const exact = key();
    await adapter.write(exact, value());

    await expect(adapter.read(exact)).resolves.toBeDefined();
    await expect(adapter.read(key("b"))).resolves.toBeUndefined();
    await expect(adapter.read(key("a", { fileIdentity: "1:2:301:400.5:500.5:600.5" })))
      .resolves.toBeUndefined();
    await expect(adapter.read(key("a", { sinceIso: "2026-08-02T00:00:00.000Z" })))
      .resolves.toBeDefined();
    await expect(adapter.read(key("a", { sinceIso: "2026-07-31T00:00:00.000Z" })))
      .resolves.toBeUndefined();
    await expect(adapter.read(key("a", { collectInvocationEvidence: true })))
      .resolves.toBeUndefined();

    await expect(adapter.read({
      ...exact,
      parserVersion: localAgentQualitativeParserVersion + 1
    } as unknown as LocalAgentQualitativeIndexKey))
      .rejects.toMatchObject({ code: "invalid_key" });
  });

  it("reuses a wider complete-file parse at a later exact cutoff and post-filters identically", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qual-index-moving-window-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    const cacheDirectory = join(root, "cache");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const transcriptLine = (timestamp: string, suffix: string) => JSON.stringify({
      type: "assistant",
      timestamp,
      sessionId: `session-${suffix}`,
      requestId: `request-${suffix}`,
      message: {
        id: `message-${suffix}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000, output_tokens: 100 }
      }
    });
    await writeFile(join(claudeDir, "session.jsonl"), [
      transcriptLine("2026-08-01T12:00:00.000Z", "old"),
      transcriptLine("2026-08-03T12:00:00.000Z", "new")
    ].join("\n"), "utf8");
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory });
    const base = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      qualitativeScan: { maxFileBytes: 64 * 1_024, maxSourceBytes: 128 * 1_024 }
    };

    const wider = await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-01T00:00:00.000Z",
      qualitativeIndex: adapter
    });
    const later = await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-02T00:00:00.000Z",
      qualitativeIndex: adapter
    });
    const laterWithoutIndex = await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-02T00:00:00.000Z"
    });

    expect(wider.calls.map((call) => call.sessionId)).toEqual(["session-old", "session-new"]);
    expect(later.calls).toEqual(laterWithoutIndex.calls);
    expect(later.records).toEqual(laterWithoutIndex.records);
    expect(later.calls.map((call) => call.sessionId)).toEqual(["session-new"]);
    expect(later.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({
        qualitativeIndexHits: 1,
        qualitativeBytesRead: 0,
        qualitativeFilesReadCompletely: 1,
        qualitativeCoverage: "complete"
      });
  });

  it("reuses a wider Codex parse when timestamped invocation evidence proves the later window", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qual-index-codex-window-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    const cacheDirectory = join(root, "cache");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    await writeFile(join(codexDir, "rollout-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-10T12:00:00.000Z",
        payload: {
          id: "codex-window-session",
          timestamp: "2026-08-10T12:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-10T12:00:01.000Z",
        payload: { model: "gpt-5.6-sol" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-10T12:00:02.000Z",
        payload: {
          type: "function_call",
          name: "Read",
          arguments: JSON.stringify({ file_path: "index.ts" })
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-10T12:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 500,
              output_tokens: 100
            }
          }
        }
      })
    ].join("\n"), "utf8");
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory });
    const base = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      collectCodexInvocationEvidence: true,
      qualitativeScan: { maxFileBytes: 64 * 1_024, maxSourceBytes: 128 * 1_024 }
    };

    await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-01T00:00:00.000Z",
      qualitativeIndex: adapter
    });
    const later = await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-09T00:00:00.000Z",
      qualitativeIndex: adapter
    });
    const laterWithoutIndex = await loadLocalAgentUsage({
      ...base,
      sinceIso: "2026-08-09T00:00:00.000Z"
    });

    expect(later.calls).toEqual(laterWithoutIndex.calls);
    expect(later.codexInvocationFiles).toEqual(laterWithoutIndex.codexInvocationFiles);
    expect(later.sourceScans.find((scan) => scan.agent === "codex"))
      .toMatchObject({
        qualitativeIndexHits: 1,
        qualitativeBytesRead: 0,
        qualitativeFilesReadCompletely: 1,
        qualitativeCoverage: "complete"
      });
  });

  it("strictly rejects leak fields, mismatched ownership, and invocation evidence outside its keyed mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-strict-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const leaked = value();
    (leaked.calls[0] as unknown as Record<string, unknown>).prompt = "raw private prompt";
    await expect(adapter.write(key(), leaked)).rejects.toMatchObject({ code: "invalid_value" });

    const wrongOwner = value({ calls: [{ ...value().calls[0]!, agent: "claude-code" }] });
    await expect(adapter.write(key(), wrongOwner)).rejects.toMatchObject({ code: "invalid_value" });

    await expect(adapter.write(key(), invocationValue()))
      .rejects.toMatchObject({ code: "invalid_value" });
    const invocationKey = key("a", { collectInvocationEvidence: true });
    await expect(adapter.write(invocationKey, invocationValue())).resolves.toBeUndefined();
    await expect(adapter.read(invocationKey)).resolves.toMatchObject({
      invocationFile: { contextSignal: { agent: "codex" } }
    });
  });

  it("reuses aggregated Codex invocation evidence only with an exact in-window start proof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-invocation-window-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const storedKey = key("a", {
      collectInvocationEvidence: true,
      sinceIso: "2026-08-01T00:00:00.000Z"
    });
    const storedValue = invocationValue();
    storedValue.calls = [{
      ...storedValue.calls[0]!,
      startedAt: "2026-08-10T00:00:00.000Z"
    }];
    await adapter.write(storedKey, storedValue);

    await expect(adapter.read(key("a", {
      collectInvocationEvidence: true,
      sinceIso: "2026-08-09T00:00:00.000Z"
    }))).resolves.toBeDefined();
    await expect(adapter.read(key("a", {
      collectInvocationEvidence: true,
      sinceIso: "2026-08-16T00:00:00.000Z"
    }))).resolves.toBeUndefined();
  });

  it("fails closed on future versions, unknown fields, malformed JSON, and oversized state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-invalid-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory, maxBytes: 1_024 });
    const file = join(directory, qualitativeIndexCacheFileName);

    await writeFile(file, JSON.stringify({
      kind: "aibill.qualitative_index",
      schemaVersion: 2,
      entries: []
    }), { mode: 0o600 });
    await expect(adapter.read(key())).rejects.toMatchObject({ code: "unsupported_version" });
    await expect(adapter.write(key(), value())).rejects.toMatchObject({ code: "unsupported_version" });

    await writeFile(file, JSON.stringify({
      kind: "aibill.qualitative_index",
      schemaVersion: 1,
      entries: [],
      prompt: "raw-private-text"
    }), { mode: 0o600 });
    await expect(adapter.read(key())).rejects.toMatchObject({ code: "malformed" });

    await writeFile(file, "{", { mode: 0o600 });
    await expect(adapter.read(key())).rejects.toMatchObject({ code: "malformed" });

    await writeFile(file, "x".repeat(1_025), { mode: 0o600 });
    await expect(adapter.read(key())).rejects.toMatchObject({ code: "oversized" });
  });

  it("refuses symlinked, non-regular, and non-private cache paths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aibill-qual-index-outside-"));
    const parent = await mkdtemp(join(tmpdir(), "aibill-qual-index-link-"));
    const linkedDirectory = join(parent, "cache");
    await symlink(outside, linkedDirectory);
    const linkedAdapter = createQualitativeIndexCacheAdapter({ cacheDirectory: linkedDirectory });
    await expect(linkedAdapter.read(key())).rejects.toMatchObject({ code: "unsafe_directory" });
    await expect(linkedAdapter.write(key(), value())).rejects.toMatchObject({ code: "unsafe_directory" });

    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-file-link-"));
    const target = join(outside, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, join(directory, qualitativeIndexCacheFileName));
    const fileLinkAdapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    await expect(fileLinkAdapter.read(key())).rejects.toMatchObject({ code: "unsafe_file" });
    await expect(fileLinkAdapter.write(key(), value())).rejects.toMatchObject({ code: "unsafe_file" });

    const publicDirectory = await mkdtemp(join(tmpdir(), "aibill-qual-index-public-dir-"));
    await chmod(publicDirectory, 0o755);
    const publicAdapter = createQualitativeIndexCacheAdapter({ cacheDirectory: publicDirectory });
    await expect(publicAdapter.read(key())).rejects.toMatchObject({ code: "unsafe_directory" });
    await expect(publicAdapter.write(key(), value())).rejects.toMatchObject({ code: "unsafe_directory" });
    expect((await lstat(publicDirectory)).mode & 0o777).toBe(0o755);

    const publicFileDirectory = await mkdtemp(join(tmpdir(), "aibill-qual-index-public-file-"));
    await writeFile(join(publicFileDirectory, qualitativeIndexCacheFileName), "{}", { mode: 0o644 });
    await expect(createQualitativeIndexCacheAdapter({ cacheDirectory: publicFileDirectory }).read(key()))
      .rejects.toMatchObject({ code: "unsafe_file" });

    const nonRegularDirectory = await mkdtemp(join(tmpdir(), "aibill-qual-index-nonregular-"));
    await mkdir(join(nonRegularDirectory, qualitativeIndexCacheFileName));
    await expect(createQualitativeIndexCacheAdapter({ cacheDirectory: nonRegularDirectory }).read(key()))
      .rejects.toMatchObject({ code: "unsafe_file" });
  });

  it("refuses a symlinked default ~/.aibill ancestor", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-qual-index-home-"));
    const outside = await mkdtemp(join(tmpdir(), "aibill-qual-index-home-outside-"));
    await mkdir(join(outside, "cache"));
    await symlink(outside, join(syntheticHome, ".aibill"));
    const adapter = createQualitativeIndexCacheAdapter({ homeDirectory: syntheticHome });

    await expect(adapter.read(key())).rejects.toMatchObject({ code: "unsafe_directory" });
    await expect(adapter.write(key(), value())).rejects.toMatchObject({ code: "unsafe_directory" });
  });

  it("keeps the default cache ignored when the user's home is itself a Git worktree", async () => {
    const syntheticHome = await mkdtemp(join(tmpdir(), "aibill-qual-index-git-home-"));
    await execFile("git", ["-C", syntheticHome, "init", "--quiet"]);
    const adapter = createQualitativeIndexCacheAdapter({ homeDirectory: syntheticHome });

    await adapter.write(key(), value());

    expect(await readFile(join(syntheticHome, ".aibill", ".gitignore"), "utf8"))
      .toBe("*\n");
    const { stdout } = await execFile("git", [
      "-C", syntheticHome, "status", "--short", "--", ".aibill"
    ], { encoding: "utf8" });
    expect(stdout).toBe("");
  });

  it("evicts old entries to the configured bounded count while retaining the new entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-evict-"));
    const adapter = createQualitativeIndexCacheAdapter({
      cacheDirectory: directory,
      maxEntries: 2
    });
    await adapter.write(key("a"), value());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    await adapter.write(key("b"), value());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    await adapter.write(key("c"), value());

    await expect(adapter.read(key("a"))).resolves.toBeUndefined();
    await expect(adapter.read(key("b"))).resolves.toBeDefined();
    await expect(adapter.read(key("c"))).resolves.toBeDefined();
    const raw = JSON.parse(await readFile(join(directory, qualitativeIndexCacheFileName), "utf8"));
    expect(raw.entries).toHaveLength(2);
  });

  it("recovers a stale lock only when its recorded process is no longer alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-stale-lock-"));
    const lockPath = join(directory, qualitativeIndexCacheLockFileName);
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-owner-token-123456789"
    }), { mode: 0o600 });
    await utimes(lockPath, new Date(0), new Date(0));

    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    await expect(adapter.write(key(), value())).resolves.toBeUndefined();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.read(key())).resolves.toBeDefined();
  });

  it("serializes concurrent writers without losing either entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-concurrent-"));
    const first = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const second = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });

    await Promise.all([
      first.write(key("a"), value()),
      second.write(key("b"), value())
    ]);

    await expect(first.read(key("a"))).resolves.toBeDefined();
    await expect(first.read(key("b"))).resolves.toBeDefined();
    expect((await readdir(directory)).some((name) => name.endsWith(".lock"))).toBe(false);
  });

  it("preserves cold and warm project refs and waste-candidate identity without persisting cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-qual-index-cold-warm-"));
    const adapter = createQualitativeIndexCacheAdapter({ cacheDirectory: directory });
    const calls = [
      plannerCall("session-1", "2026-08-14T10:00:00.000Z", 1_000),
      plannerCall("session-2", "2026-08-15T10:00:00.000Z", 1_100),
      plannerCall("session-3", "2026-08-16T10:00:00.000Z", 4_000)
    ];
    const keys = [key("a"), key("b"), key("c")];
    for (const [index, call] of calls.entries()) {
      await adapter.write(keys[index]!, { calls: [call!], diagnostics: [] });
    }
    const warmCalls = (await Promise.all(keys.map((item) => adapter.read(item))))
      .flatMap((cached) => cached?.calls ?? []);
    expect(warmCalls).toHaveLength(3);
    expect(warmCalls.every((call) => !call.workingDirectory && call.workingDirectoryRef)).toBe(true);

    const coldVitals = extractSessionVitalsV0(calls);
    const warmVitals = extractSessionVitalsV0(warmCalls);
    expect(warmVitals).toEqual(coldVitals);
    expect(coldVitals.sessions.every((session) => /^avref_[a-f0-9]{64}$/.test(session.projectRef ?? "")))
      .toBe(true);

    const generatedAt = "2026-08-16T12:00:00.000Z";
    const coldFinding = selectBestWasteFindingV0({ sessionVitals: coldVitals, generatedAt });
    const warmFinding = selectBestWasteFindingV0({ sessionVitals: warmVitals, generatedAt });
    expect(coldFinding).not.toBeNull();
    expect(warmFinding).toEqual(coldFinding);
    expect(warmFinding?.candidateKey).toBe(coldFinding?.candidateKey);

    const persisted = await readFile(join(directory, qualitativeIndexCacheFileName), "utf8");
    expect(persisted).not.toContain(syntheticPrivateRoot);
  });
});
