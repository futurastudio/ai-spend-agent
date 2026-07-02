import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  analyzeSpend,
  assertSafeScanRoot,
  attributeUsageRecords,
  createLocalFolderSourceRegistry,
  createScanAuditLog,
  loadSampleUsageData,
  scanLocalUsageSignals,
  type LocalDiscoveryResult,
  type ScanAuditEvent,
  type ScanAuditLog,
  type SourceRegistry
} from "@agent-finops/core";

export type ScanAiSpendInput = {
  path: string;
  sample?: boolean;
};

export type RegistryPathInput = {
  path: string;
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
  const stateDir = join(resolve(input.path), ".ai-spend-agent");
  return readJson(join(stateDir, "spend.json"));
}

export async function recommendCutsTool(input: RegistryPathInput): Promise<{ source: "scanner"; recommendations: string[] }> {
  const discovery = await readDiscovery(input.path);
  const providers = Array.from(new Set(discovery.signals.map((signal) => signal.provider))).sort();
  const recommendations = providers.length === 0
    ? ["Connect or import an AI provider usage export before recommending cuts."]
    : providers.map((provider) => `Review ${provider} usage signals for model downgrade, prompt/context trimming, caching, or batching opportunities.`);
  return { source: "scanner", recommendations };
}

async function readRegistry(rootPath: string): Promise<SourceRegistry> {
  const stateDir = join(resolve(rootPath), ".ai-spend-agent");
  return readJson<SourceRegistry>(join(stateDir, "sources.json"));
}

async function readDiscovery(rootPath: string): Promise<LocalDiscoveryResult> {
  const stateDir = join(resolve(rootPath), ".ai-spend-agent");
  return readJson<LocalDiscoveryResult>(join(stateDir, "discovery.json"));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export { createServer } from "./server.js";
