import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { buildActivitySnapshot, type ActivitySnapshotAgent } from "../activitySnapshot.js";
import {
  aggregateCallsForFormats,
  loadLocalAgentFinancialUsageWithFormats,
  loadLocalAgentUsageWithFormats,
  type LocalAgentCall,
  type LocalAgentLogDiagnostic,
  type LocalAgentSourceScan
} from "../localAgentLogs.js";
import type { SourceStatusId } from "../sourceStatus.js";
import {
  localAgentFormatDescriptors,
  matchesLocalAgentDetectionFile,
  matchesLocalAgentFormatFile,
  validateLocalAgentFormatDescriptors
} from "./registry.js";
import {
  localAgentFormatRuntimeRegistry,
  validateLocalAgentFormatRuntimeRegistry
} from "./runtimeRegistry.js";
import type {
  LocalAgentFormatDescriptor,
  LocalAgentFormatRuntime
} from "./types.js";

describe("localAgentFormatDescriptors", () => {
  it("keeps the released source order and separates validation from financial evidence", () => {
    expectTypeOf<LocalAgentCall["agent"]>()
      .toEqualTypeOf<"claude-code" | "codex" | "gemini-cli">();
    expectTypeOf<ActivitySnapshotAgent>()
      .toEqualTypeOf<"claude-code" | "codex">();
    expectTypeOf<SourceStatusId>().toEqualTypeOf<
      "claude-code" | "codex" | "gemini-cli" | "openai" | "anthropic" | "cursor" | "github-copilot"
    >();
    expect(localAgentFormatDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "claude-code",
      "codex",
      "gemini-cli"
    ]);
    expect(() => validateLocalAgentFormatDescriptors()).not.toThrow();
    expect(() => validateLocalAgentFormatRuntimeRegistry()).not.toThrow();
    expect(Object.isFrozen(localAgentFormatDescriptors)).toBe(true);
    expect(Object.isFrozen(localAgentFormatDescriptors[0])).toBe(true);
    expect(Object.isFrozen(localAgentFormatDescriptors[0]!.confidenceDefaults)).toBe(true);
    expect(localAgentFormatDescriptors.map((descriptor) => ({
      id: descriptor.id,
      validation: descriptor.confidenceDefaults.validationCoverage,
      priced: descriptor.confidenceDefaults.pricedFinancialEvidence,
      unpriced: descriptor.confidenceDefaults.unpricedFinancialEvidence
    }))).toEqual([
      { id: "claude-code", validation: "live_verified", priced: "estimated", unpriced: "missing" },
      { id: "codex", validation: "live_verified", priced: "estimated", unpriced: "missing" },
      { id: "gemini-cli", validation: "fixture_verified", priced: "estimated", unpriced: "missing" }
    ]);
  });

  it("keeps discovery rules in descriptors", () => {
    const claude = localAgentFormatDescriptors[0]!;
    const codex = localAgentFormatDescriptors[1]!;
    const gemini = localAgentFormatDescriptors[2]!;
    expect(matchesLocalAgentFormatFile(claude, "/safe/session.jsonl")).toBe(true);
    expect(matchesLocalAgentFormatFile(codex, "/safe/rollout-synthetic.jsonl")).toBe(true);
    expect(matchesLocalAgentFormatFile(codex, "/safe/other.jsonl")).toBe(false);
    expect(matchesLocalAgentFormatFile(gemini, "/safe/opaque/chats/session.json")).toBe(true);
    expect(matchesLocalAgentFormatFile(gemini, "/safe/opaque/chats/nested/session.jsonl")).toBe(true);
    expect(matchesLocalAgentFormatFile(gemini, "/safe/opaque/session.json")).toBe(false);
    expect(matchesLocalAgentFormatFile(gemini, "/safe/opaque/logs.json")).toBe(false);
    expect(matchesLocalAgentDetectionFile(gemini, "/safe/opaque/logs.json")).toBe(true);
  });

  it("rejects duplicate or financially unsafe descriptor defaults", () => {
    const duplicate = [localAgentFormatDescriptors[0]!, localAgentFormatDescriptors[0]!];
    expect(() => validateLocalAgentFormatDescriptors(duplicate)).toThrow(/Duplicate/);
    const unsafe = {
      ...localAgentFormatDescriptors[0]!,
      id: "unsafe-format",
      order: 999,
      confidenceDefaults: {
        ...localAgentFormatDescriptors[0]!.confidenceDefaults,
        pricedFinancialEvidence: "verified"
      }
    } as unknown as LocalAgentFormatDescriptor;
    expect(() => validateLocalAgentFormatDescriptors([unsafe])).toThrow(/estimated\/missing/);

    const traversal = {
      ...localAgentFormatDescriptors[0]!,
      id: "traversal-format",
      order: 998,
      defaultHomeRelative: ["../.ssh"]
    } as unknown as LocalAgentFormatDescriptor;
    expect(() => validateLocalAgentFormatDescriptors([traversal])).toThrow(/Unsafe default/);

    const broadScan = {
      ...localAgentFormatDescriptors[0]!,
      id: "broad-format",
      order: 997,
      discovery: {}
    } as unknown as LocalAgentFormatDescriptor;
    expect(() => validateLocalAgentFormatDescriptors([broadScan])).toThrow(/bounded file rule/);

    const unsafeFixture = {
      ...localAgentFormatDescriptors[0]!,
      id: "unsafe-fixture-format",
      order: 996,
      fixtures: ["../../private-v1"]
    } as unknown as LocalAgentFormatDescriptor;
    expect(() => validateLocalAgentFormatDescriptors([unsafeFixture])).toThrow(/unsafe or missing/);
  });
});

describe("registry-driven ingestion extension", () => {
  it("discovers, parses, aggregates, and scans a third format without engine changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-format-extension-"));
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "session.jsonl"), "{\"synthetic\":true}\n", "utf8");

    const descriptor = {
      schemaVersion: 1,
      id: "fixture-agent",
      order: 30,
      label: "Fixture Agent",
      provider: "fixture-provider",
      defaultHomeRelative: [".fixture-agent", "sessions"],
      discovery: { extension: ".jsonl" },
      confidenceDefaults: {
        validationCoverage: "fixture_verified",
        pricedFinancialEvidence: "estimated",
        unpricedFinancialEvidence: "missing",
        sourceConfidence: "estimated"
      },
      sourceRecord: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        observedFrom: "fixture-agent transcript JSONL (this machine)",
        providerCostType: "local_agent_logs",
        usageGranularity: "daily_aggregate",
        operation: "fixture-agent sessions"
      },
      capabilities: {
        actionPlanning: false,
        activity: false,
        contextHealth: false,
        financialFastPath: true,
        glance: false,
        invocationEvidence: false,
        planContext: false,
        rateLimits: false
      },
      financialRead: "full_jsonl",
      validationNote: "Synthetic extension canary only.",
      docs: {
        format: "Synthetic JSONL",
        howRead: ["Read the fixture event."],
        fieldsRead: ["usage"],
        verified: ["Fixture shape only."],
        estimated: ["API-equivalent value."],
        notVerified: ["Billed cost."],
        privacy: ["Synthetic data only."],
        limitations: ["Test-only format."]
      },
      fixtures: ["fixture-agent-v1"]
    } as unknown as LocalAgentFormatDescriptor;
    const call = {
      agent: descriptor.id,
      model: "gpt-5.1-codex",
      timestamp: "2026-08-10T12:00:00.000Z",
      project: "sample-project",
      usageScope: "turn" as const,
      usage: { inputTokens: 100, outputTokens: 20 }
    };
    const runtime: LocalAgentFormatRuntime = {
      descriptor,
      parseFull: () => ({ calls: [call] }),
      parseFinancialFile: async ({ scan }) => {
        scan.filesParsed += 1;
        return [call];
      }
    };

    expect(() => validateLocalAgentFormatRuntimeRegistry([runtime], [descriptor])).not.toThrow();
    const options = { sourceDirectories: { [descriptor.id]: root } };
    const full = await loadLocalAgentUsageWithFormats([runtime], options);
    const financial = await loadLocalAgentFinancialUsageWithFormats([runtime], options);

    expect(JSON.stringify(financial.records)).toBe(JSON.stringify(full.records));
    expect(full.sourceScans).toEqual([expect.objectContaining({
      agent: "fixture-agent",
      directoryStatus: "readable",
      filesDiscovered: 1,
      filesParsed: 1
    })]);
    expect(full.records).toEqual([expect.objectContaining({
      source: expect.objectContaining({
        provider: "fixture-provider",
        confidence: "estimated",
        observedFrom: "fixture-agent transcript JSONL (this machine)"
      }),
      agentId: "fixture-agent",
      projectId: "sample-project",
      costConfidence: "estimated",
      providerCostType: "local_agent_logs"
    })]);
  });

  it("refuses calls that spoof another registered format's provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-format-spoof-"));
    await writeFile(join(root, "session.jsonl"), "{\"synthetic\":true}\n", "utf8");
    const descriptor = {
      ...localAgentFormatDescriptors[0]!,
      id: "fixture-agent",
      order: 30,
      label: "Fixture Agent",
      provider: "fixture-provider",
      defaultHomeRelative: [".fixture-agent", "sessions"],
      legacyDirectoryOption: undefined,
      confidenceDefaults: {
        ...localAgentFormatDescriptors[0]!.confidenceDefaults,
        validationCoverage: "fixture_verified"
      },
      sourceRecord: {
        ...localAgentFormatDescriptors[0]!.sourceRecord,
        observedFrom: "fixture-agent transcript JSONL (this machine)",
        operation: "fixture-agent sessions"
      },
      fixtures: ["fixture-agent-v1"]
    } as unknown as LocalAgentFormatDescriptor;
    const spoofedCall: LocalAgentCall = {
      agent: "codex",
      model: "gpt-5.1-codex",
      timestamp: "2026-08-10T12:00:00.000Z",
      usageScope: "turn" as const,
      usage: { inputTokens: 100, outputTokens: 20 }
    };
    const runtime: LocalAgentFormatRuntime = {
      descriptor,
      parseFull: () => ({ calls: [spoofedCall] }),
      parseFinancialFile: async ({ scan }) => {
        scan.filesParsed += 1;
        return [spoofedCall];
      }
    };
    const options = { sourceDirectories: { [descriptor.id]: root } };

    await expect(loadLocalAgentUsageWithFormats([runtime], options))
      .rejects.toThrow(/different source/);
    await expect(loadLocalAgentFinancialUsageWithFormats([runtime], options))
      .rejects.toThrow(/different source/);

    const ownedCall: LocalAgentCall = {
      ...spoofedCall,
      agent: descriptor.id
    };
    const metadataSpoof: LocalAgentFormatRuntime = {
      descriptor,
      parseFull: () => ({ calls: [ownedCall] }),
      parseFinancialFile: async ({ scan, diagnostics }) => {
        scan.filesParsed += 1;
        scan.agent = "codex";
        diagnostics.push({
          agent: "codex",
          code: "malformed_jsonl",
          severity: "warning",
          message: "Synthetic mismatch.",
          count: 1
        });
        return [ownedCall];
      }
    };
    await expect(loadLocalAgentFinancialUsageWithFormats([metadataSpoof], options))
      .rejects.toThrow(/financial metadata for a different source/);

    const invocationSpoof: LocalAgentFormatRuntime = {
      descriptor,
      parseFull: () => ({
        calls: [ownedCall],
        invocationFile: {
          invocations: [],
          invokedMcpTools: [],
          invokedSkills: [],
          invokedSubagents: [],
          invokedCommands: [],
          assistantTurns: 0,
          contextSignal: {
            agent: "codex",
            compactionEvents: 0,
            fileReads: [],
            repeatedFileReads: [],
            isSubagent: false,
            readCoverage: "explicit_read_tools_only"
          }
        }
      }),
      parseFinancialFile: async () => [ownedCall]
    };
    await expect(loadLocalAgentUsageWithFormats([invocationSpoof], {
      ...options,
      collectCodexInvocationEvidence: true
    })).rejects.toThrow(/invocation evidence for a different source/);
  });
});

describe("built-in runtime registry", () => {
  it("is descriptor-complete and ordered", () => {
    expect(localAgentFormatRuntimeRegistry.map((entry) => entry.descriptor.id)).toEqual([
      "claude-code",
      "codex",
      "gemini-cli"
    ]);
    expect(Object.isFrozen(localAgentFormatRuntimeRegistry)).toBe(true);
    expect(() => validateLocalAgentFormatRuntimeRegistry(
      localAgentFormatRuntimeRegistry.slice(0, 1)
    )).toThrow(/exactly match/);
  });

  it("declares every recorded fixture directory exactly once", async () => {
    const fixtureRoot = resolve(import.meta.dirname, "../fixtures/local-agent-formats");
    const declared = localAgentFormatRuntimeRegistry
      .flatMap((runtime) => runtime.descriptor.fixtures)
      .sort();
    const directories = (await readdir(fixtureRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(new Set(declared).size).toBe(declared.length);
    expect(directories).toEqual(declared);
  });

  it("matches every declared fixture to exact full and financial-reader goldens", async () => {
    const fixtureRoot = resolve(import.meta.dirname, "../fixtures/local-agent-formats");
    for (const runtime of localAgentFormatRuntimeRegistry) {
      for (const fixtureId of runtime.descriptor.fixtures) {
        if (runtime.descriptor.id === "gemini-cli") continue;
        const fixtureDirectory = join(fixtureRoot, fixtureId);
        const rawFiles = (await readdir(fixtureDirectory))
          .filter((name) => matchesLocalAgentFormatFile(runtime.descriptor, name))
          .sort();
        expect(rawFiles, `${fixtureId} must contain one discovered source file`).toHaveLength(1);

        const rawPath = join(fixtureDirectory, rawFiles[0]!);
        const [content, expectedFull, expectedFinancial] = await Promise.all([
          readFile(rawPath, "utf8"),
          readFile(join(fixtureDirectory, "expected-full.json"), "utf8")
            .then((raw) => JSON.parse(raw) as unknown),
          readFile(join(fixtureDirectory, "expected-financial.json"), "utf8")
            .then((raw) => JSON.parse(raw) as unknown)
        ]);
        const fullDiagnostics: Array<{
          code: "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape";
          count: number;
        }> = [];
        const full = runtime.parseFull({
          content,
          filePath: rawPath,
          collectInvocationEvidence: false,
          onDiagnostic: (diagnostic) => fullDiagnostics.push(diagnostic)
        });

        expect({ calls: full.calls, diagnostics: fullDiagnostics }).toEqual(expectedFull);

        const financialScan = financialFixtureScan(runtime.descriptor);
        const financialDiagnostics: LocalAgentLogDiagnostic[] = [];
        const financialCalls = await runtime.parseFinancialFile({
          filePath: rawPath,
          scan: financialScan,
          diagnostics: financialDiagnostics
        });
        const financial = {
          calls: financialCalls,
          scan: financialScan,
          diagnostics: financialDiagnostics
        };

        expect(financial).toEqual(expectedFinancial);
        expect(aggregateCallsForFormats(financialCalls, [runtime.descriptor])).toEqual(
          aggregateCallsForFormats(full.calls, [runtime.descriptor])
        );
      }
    }
  });

  it("parses the bounded Gemini JSON/JSONL corpus and keeps logs.json detection-only", async () => {
    const fixtureRoot = resolve(
      import.meta.dirname,
      "../fixtures/local-agent-formats/gemini-cli-v1"
    );
    const runtime = localAgentFormatRuntimeRegistry.find((entry) => (
      entry.descriptor.id === "gemini-cli"
    ));
    expect(runtime).toBeDefined();
    const options = { sourceDirectories: { "gemini-cli": fixtureRoot } };
    const full = await loadLocalAgentUsageWithFormats([runtime!], options);
    const financial = await loadLocalAgentFinancialUsageWithFormats([runtime!], options);

    expect(financial.records).toEqual(full.records);
    expect(full.filesParsed).toBe(7);
    expect(full.calls).toHaveLength(7);
    expect(full.sourceScans).toEqual([expect.objectContaining({
      agent: "gemini-cli",
      filesDiscovered: 7,
      filesParsed: 7,
      detectionSignals: 1,
      malformedLines: 1,
      unsupportedUsageSnapshots: 2
    })]);
    expect(full.records.filter((record) => record.costConfidence === "estimated"))
      .toHaveLength(3);
    expect(full.records.filter((record) => record.costConfidence === "missing"))
      .toHaveLength(4);
    expect(full.records.some((record) => record.model === "gemini-2.5-flash" &&
      record.amountUsd === null && record.costConfidence === "missing")).toBe(true);
    expect(full.records.some((record) => record.model === "gemini-future-synthetic-unknown" &&
      record.amountUsd === null)).toBe(true);
    expect(full.records.filter((record) => record.agentId === "gemini-cli").every((record) => (
      record.inputTokens >= (record.cacheReadTokens ?? 0) + (record.toolTokens ?? 0) &&
      record.outputTokens >= (record.thoughtTokens ?? 0)
    ))).toBe(true);
    expect(full.records.every((record) => record.agentId === "gemini-cli")).toBe(true);
    expect(JSON.stringify(full)).not.toContain("8888888888888888");
    expect(JSON.stringify(full.records)).not.toContain("logs.json");

    const statuslineSnapshot = buildActivitySnapshot({
      asOf: "2026-08-11T00:00:00.000Z",
      generatedAt: "2026-08-11T00:00:00.000Z",
      records: full.records,
      calls: full.calls,
      sourceScans: full.sourceScans,
      sampleData: false
    });
    expect(statuslineSnapshot.mode).toBe("empty");
    expect(statuslineSnapshot.coverage.agents).toEqual([]);
    expect(statuslineSnapshot.coverage.recordsParsed).toBe(0);
    expect(JSON.stringify(statuslineSnapshot)).not.toContain("gemini-cli");
  });

  it("deduplicates the same stable Gemini session message across copied chat files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-gemini-copy-dedupe-"));
    const chats = join(root, "opaque-project", "chats");
    await mkdir(chats, { recursive: true });
    const content = [
      JSON.stringify({
        sessionId: "stable-session",
        projectHash: "opaque-project",
        geminiCliVersion: "0.56.0-nightly"
      }),
      JSON.stringify({
        id: "stable-message",
        timestamp: "2026-08-10T12:00:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
      })
    ].join("\n");
    await Promise.all([
      writeFile(join(chats, "first.jsonl"), content, "utf8"),
      writeFile(join(chats, "copied.jsonl"), content, "utf8")
    ]);
    const runtime = localAgentFormatRuntimeRegistry.find((entry) => (
      entry.descriptor.id === "gemini-cli"
    ));

    const result = await loadLocalAgentUsageWithFormats([runtime!], {
      sourceDirectories: { "gemini-cli": root }
    });

    expect(result.sourceScans[0]?.filesParsed).toBe(2);
    expect(result.calls).toHaveLength(1);
    expect(result.records).toEqual([
      expect.objectContaining({
        agentId: "gemini-cli",
        quantity: 1,
        sourceVersions: ["0.56.0-nightly"]
      })
    ]);
  });
});

function financialFixtureScan(
  descriptor: LocalAgentFormatDescriptor
): LocalAgentSourceScan {
  return {
    agent: descriptor.id,
    directoryStatus: "readable",
    filesDiscovered: 1,
    filesParsed: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0,
    filesSkippedBeforeWindow: 0,
    ...(descriptor.financialRead === "bounded_event_jsonl"
      ? {
          filesReadFinancially: 0,
          bytesSkippedAsNonFinancialHistory: 0,
          nonFinancialLinesPrefiltered: 0,
          nonFinancialBytesPrefiltered: 0
        }
      : {}),
    jsonlValidationCoverage: "complete"
  };
}
