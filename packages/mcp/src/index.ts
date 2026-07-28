import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  addApprovedSource,
  analyzeSpend,
  assertSafeScanRoot,
  attributeUsageRecords,
  createLocalFolderSourceRegistry,
  createProviderConnectorStub,
  createScanAuditLog,
  fetchProviderUsageRecords,
  loadLocalAgentUsage,
  loadSampleUsageData,
  scanLocalUsageSignals,
  type Fetcher,
  type LocalDiscoveryResult,
  type ScanAuditEvent,
  type ScanAuditLog,
  type SourceRegistry,
  type SpendSummary,
  type TokenResolver,
  type UsageRecord
} from "@agent-finops/core";

export type ScanAiSpendInput = {
  path: string;
  sample?: boolean;
};

export type RegistryPathInput = {
  path: string;
};

export type SyncProviderSpendInput = RegistryPathInput & {
  provider: "openai" | "anthropic" | "github-copilot" | "cursor";
  authReference: string;
  startTime: number;
  endTime?: number;
  org?: string;
  enterprise?: string;
  accountId?: string;
};

export type SyncLocalAgentSpendInput = RegistryPathInput & {
  sinceDays?: number;
  project?: string;
};

type SyncProviderOverrides = {
  fetcher?: Fetcher;
  tokenResolver?: TokenResolver;
};

type PersistedSpendState = {
  mode?: "sample" | "local_logs" | "connected_provider";
  records: UsageRecord[];
  summary: SpendSummary;
};

type ProviderRecordsState = {
  records: UsageRecord[];
  qa?: unknown;
  qaByProvider?: Record<string, unknown>;
};

export async function scanAiSpendTool(input: ScanAiSpendInput): Promise<{
  registry: SourceRegistry;
  auditLog: ScanAuditLog;
  discovery: LocalDiscoveryResult;
}> {
  const rootPath = resolve(input.path);
  // Same unsafe-root policy as the CLI `scan` command (shared core guard):
  // an MCP client — possibly prompt-injected — must not be able to walk the
  // home directory, the filesystem root, or system directories.
  assertSafeScanRoot(rootPath);
  const stateDir = join(rootPath, ".ai-spend-agent");
  await mkdir(stateDir, { recursive: true });

  const registry = createLocalFolderSourceRegistry(rootPath);
  const discovery = await scanLocalUsageSignals(rootPath);
  const events: ScanAuditEvent[] = [
    {
      timestamp: registry.updatedAt,
      action: "source_registered",
      sourceId: "local-root",
      path: rootPath,
      detail: "Explicit local folder source approved through MCP scan_ai_spend."
    },
    {
      timestamp: new Date().toISOString(),
      action: "scan_started",
      sourceId: "local-root",
      path: rootPath,
      detail: "MCP local scan started with cloud upload disabled."
    },
    {
      timestamp: new Date().toISOString(),
      action: "source_scanned",
      sourceId: "local-root",
      path: rootPath,
      detail: `${discovery.scannedFiles} files scanned; ${discovery.signals.length} signals found.`
    },
    ...discovery.secretsDetected.map((secretName): ScanAuditEvent => ({
      timestamp: new Date().toISOString(),
      action: "secret_redacted",
      sourceId: "local-root",
      reason: `${secretName} was redacted before persistence/output.`
    })),
    {
      timestamp: new Date().toISOString(),
      action: "scan_completed",
      sourceId: "local-root",
      path: rootPath,
      detail: "MCP local scan completed without cloud upload."
    }
  ];
  const auditLog = createScanAuditLog(events);

  await writeJson(join(stateDir, "sources.json"), registry);
  await writeJson(join(stateDir, "audit-log.json"), auditLog);
  await writeJson(join(stateDir, "discovery.json"), discovery);

  if (input.sample) {
    const records = await loadSampleUsageData();
    const summary = analyzeSpend(records);
    const mappings = attributeUsageRecords(records);
    await writeJson(join(stateDir, "spend.json"), { records, summary });
    await writeJson(join(stateDir, "mappings.json"), mappings);
  }

  return { registry, auditLog, discovery };
}

export async function listSourcesTool(input: RegistryPathInput): Promise<SourceRegistry> {
  return readRegistry(input.path);
}

export async function getSpendReportTool(input: RegistryPathInput): Promise<unknown> {
  const rootPath = resolve(input.path);
  assertSafeScanRoot(rootPath);
  const stateDir = join(rootPath, ".ai-spend-agent");
  return readJson(join(stateDir, "spend.json"));
}

export async function recommendCutsTool(input: RegistryPathInput): Promise<{
  source: "spend_report" | "scanner";
  recommendations: string[];
}> {
  const rootPath = resolve(input.path);
  assertSafeScanRoot(rootPath);
  const spendState = await readJson<PersistedSpendState>(
    join(rootPath, ".ai-spend-agent", "spend.json")
  ).catch(() => undefined);
  const analyzedRecommendations = spendState?.summary.recommendations.map(
    (recommendation) => `${recommendation.title}: ${recommendation.nextAction}`
  ) ?? [];
  if (analyzedRecommendations.length > 0) {
    return { source: "spend_report", recommendations: analyzedRecommendations };
  }

  const discovery = await readDiscovery(input.path);
  const providers = Array.from(new Set(discovery.signals.map((signal) => signal.provider))).sort();
  const recommendations = providers.length === 0
    ? ["Connect or import an AI provider usage export before recommending cuts."]
    : providers.map((provider) => `Review ${provider} usage signals for model downgrade, prompt/context trimming, caching, or batching opportunities.`);
  return { source: "scanner", recommendations };
}

export async function syncProviderSpendTool(
  input: SyncProviderSpendInput,
  overrides: SyncProviderOverrides = {}
): Promise<{
  provider: string;
  sourceId: string;
  fetchedAt: string;
  completeness: string;
  syncedRecordCount: number;
  combinedRecordCount: number;
  syncedTotalUsd: number;
  combinedSummary: SpendSummary;
  qa: unknown;
}> {
  const rootPath = resolve(input.path);
  assertSafeScanRoot(rootPath);
  if (!/^env:[A-Z_][A-Z0-9_]*$/.test(input.authReference)) {
    throw new Error("authReference must be an environment reference such as env:OPENAI_ADMIN_KEY; raw provider keys are never accepted.");
  }

  const stateDir = join(rootPath, ".ai-spend-agent");
  const result = await fetchProviderUsageRecords({
    provider: input.provider,
    sourceId: `${input.provider}-provider-api`,
    authReference: input.authReference,
    startTime: input.startTime,
    endTime: input.endTime,
    org: input.org,
    enterprise: input.enterprise,
    accountId: input.accountId,
    fetcher: overrides.fetcher,
    tokenResolver: overrides.tokenResolver
  });
  const priorProviderState = await readJson<ProviderRecordsState>(
    join(stateDir, "provider-records.json")
  ).catch((): ProviderRecordsState => ({ records: [] }));
  const records = [
    ...priorProviderState.records.filter((record) => record.source.provider !== result.provider),
    ...result.records
  ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const combinedSummary = analyzeSpend(records);
  const mappings = attributeUsageRecords(records);
  const registry = await readRegistryOrCreate(rootPath);
  const nextRegistry = addApprovedSource(registry, result.source);
  const qaByProvider = {
    ...(priorProviderState.qaByProvider ?? {}),
    [result.provider]: result.qa
  };

  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "sources.json"), nextRegistry);
  await writeJson(join(stateDir, "provider-records.json"), {
    provider: result.provider,
    fetchedAt: result.fetchedAt,
    completeness: result.completeness,
    sourceId: result.source.id,
    records,
    qa: result.qa,
    qaByProvider
  });
  await writeJson(join(stateDir, "spend.json"), {
    mode: "connected_provider",
    records,
    summary: combinedSummary
  });
  await writeJson(join(stateDir, "mappings.json"), mappings);
  await appendAuditEvent(stateDir, {
    timestamp: result.fetchedAt,
    action: "source_scanned",
    sourceId: result.source.id,
    path: rootPath,
    detail: `${result.provider} MCP provider sync read ${result.records.length} records through a reference-only credential; no raw secret was persisted.`
  });

  return {
    provider: result.provider,
    sourceId: result.source.id,
    fetchedAt: result.fetchedAt,
    completeness: result.completeness,
    syncedRecordCount: result.records.length,
    combinedRecordCount: records.length,
    syncedTotalUsd: analyzeSpend(result.records).totalUsd,
    combinedSummary,
    qa: result.qa
  };
}

export async function syncLocalAgentSpendTool(input: SyncLocalAgentSpendInput): Promise<{
  agentsDetected: string[];
  filesParsed: number;
  recordCount: number;
  projectFilter?: string;
  summary: SpendSummary;
}> {
  const rootPath = resolve(input.path);
  assertSafeScanRoot(rootPath);
  const sinceDays = input.sinceDays ?? 30;
  const logs = await loadLocalAgentUsage({
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    sinceIso: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  });
  const records = input.project
    ? logs.records.filter((record) => record.projectId === input.project)
    : logs.records;
  if (records.length === 0) {
    throw new Error(
      input.project
        ? `No local Claude Code or Codex usage records matched project ${input.project}.`
        : "No local Claude Code or Codex usage records were found for the requested window."
    );
  }

  const stateDir = join(rootPath, ".ai-spend-agent");
  const summary = analyzeSpend(records);
  const mappings = attributeUsageRecords(records);
  const registry = await readRegistryOrCreate(rootPath);
  const localSource = {
    ...createProviderConnectorStub("local-agent-logs", "local_tool_detection"),
    verification: "estimated" as const,
    fieldsEstimated: ["input/output/cache token counts", "API-equivalent model cost"],
    fieldsMissing: ["provider-billed amount", "subscription quota state"]
  };
  const nextRegistry = addApprovedSource(registry, localSource);
  const timestamp = new Date().toISOString();

  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "sources.json"), nextRegistry);
  await writeJson(join(stateDir, "spend.json"), {
    mode: "local_logs",
    records,
    summary
  });
  await writeJson(join(stateDir, "mappings.json"), mappings);
  await appendAuditEvent(stateDir, {
    timestamp,
    action: "source_scanned",
    sourceId: localSource.id,
    path: rootPath,
    detail: `MCP local-log sync parsed ${logs.filesParsed} Claude Code/Codex files and persisted ${records.length} aggregate records.`
  });

  return {
    agentsDetected: logs.agentsDetected,
    filesParsed: logs.filesParsed,
    recordCount: records.length,
    ...(input.project ? { projectFilter: input.project } : {}),
    summary
  };
}

async function readRegistry(rootPath: string): Promise<SourceRegistry> {
  const resolvedRoot = resolve(rootPath);
  assertSafeScanRoot(resolvedRoot);
  const stateDir = join(resolvedRoot, ".ai-spend-agent");
  return readJson<SourceRegistry>(join(stateDir, "sources.json"));
}

async function readRegistryOrCreate(rootPath: string): Promise<SourceRegistry> {
  return readRegistry(rootPath).catch(() => createLocalFolderSourceRegistry(rootPath));
}

async function readDiscovery(rootPath: string): Promise<LocalDiscoveryResult> {
  const resolvedRoot = resolve(rootPath);
  assertSafeScanRoot(resolvedRoot);
  const stateDir = join(resolvedRoot, ".ai-spend-agent");
  return readJson<LocalDiscoveryResult>(join(stateDir, "discovery.json"));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendAuditEvent(stateDir: string, event: ScanAuditEvent): Promise<void> {
  const auditLog = await readJson<ScanAuditLog>(join(stateDir, "audit-log.json"))
    .catch(() => createScanAuditLog());
  await writeJson(join(stateDir, "audit-log.json"), {
    ...auditLog,
    events: [...auditLog.events, event]
  });
}
