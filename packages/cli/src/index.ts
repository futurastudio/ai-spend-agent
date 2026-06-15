#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeSpend,
  attributeUsageRecords,
  detectLocalCredentials,
  loadLocalAgentUsage,
  loadSampleUsageData,
  scanLocalUsageSignals,
  buildMissingSourcePrompts,
  confirmMapping,
  createProviderConnectorStub,
  createLocalFolderSourceRegistry,
  createScanAuditLog,
  fetchProviderUsageRecords,
  addApprovedSource,
  slugifySourceId,
  type AttributionMapping,
  type ConfirmedMapping,
  type DetectedCredential,
  type LocalDiscoveryResult,
  type ScanAuditEvent,
  type SourceRegistry,
  type SourceType,
  type SpendSummary,
  type UsageRecord,
  type ProviderQaSummary
} from "@agent-finops/core";
import {
  generateActionPlanMarkdown,
  generateApplyArtifactMarkdown,
  generateDemoPackageMarkdown,
  generateHtmlReport,
  generateMarkdownReport,
  generatePlainEnglishSummary,
  generatePolicyConfigDraftMarkdown,
  generateReportCardCaption,
  generateReportCardSvg,
  generateVerificationPlanMarkdown,
  groupByDimensions,
  type GroupByDimension
} from "@agent-finops/report";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ParsedArgs = {
  command?: string;
  sample: boolean;
  path: string;
  out?: string;
  sourcePath?: string;
  sourceType?: SourceType;
  sourceId?: string;
  team?: string;
  person?: string;
  client?: string;
  project?: string;
  agent?: string;
  workflow?: string;
  evidence?: string;
  confidence?: number;
  provider?: string;
  label?: string;
  authReference?: string;
  startTime?: number;
  endTime?: number;
  org?: string;
  enterprise?: string;
  accountId?: string;
  groupBy?: GroupByDimension;
  interval?: number;
  cycles?: number;
  noColor?: boolean;
};

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return ok(helpText());
  }

  const args = parseArgs(argv);

  // Zero-key instant demo is the DEFAULT first run. Running `ai-spend-agent`
  // with no subcommand (or `npx ai-spend-agent`), or with only flags such as
  // `--group-by agent`, lands the wow immediately on sample / auto-detected
  // local data — no credential required.
  if (!args.command || args.command.startsWith("--") || args.command === "quickstart" || args.command === "demo") {
    return quickstartCommand(args);
  }

  if (args.command === "doctor") {
    return doctorCommand(args);
  }

  if (args.command === "init") {
    return initCommand(args);
  }

  if (args.command === "scan") {
    return scanCommand(args);
  }

  if (args.command === "quickstart" || args.command === "demo") {
    return quickstartCommand(args);
  }

  if (args.command === "watch") {
    return watchCommand(args);
  }

  if (args.command === "report") {
    return reportCommand(args);
  }

  if (args.command === "report-card") {
    return reportCardCommand(args);
  }

  if (args.command === "apply-artifact") {
    return applyArtifactCommand(args);
  }

  if (args.command === "add-source") {
    return addSourceCommand(args);
  }

  if (args.command === "list-sources") {
    return listSourcesCommand(args);
  }

  if (args.command === "connect") {
    return connectCommand(args);
  }

  if (args.command === "sync-provider") {
    return syncProviderCommand(args);
  }

  if (args.command === "confirm-mapping") {
    return confirmMappingCommand(args);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `Unknown command: ${args.command}\n${helpText()}`
  };
}

type InstantReadMode = "demo" | "connected" | "local-logs";

type InstantReadData = {
  records: UsageRecord[];
  mode: InstantReadMode;
};

async function quickstartCommand(args: ParsedArgs): Promise<CliResult> {
  const { records, mode } = await loadInstantReadData(args);
  const summary = analyzeSpend(records);
  const groupBy = args.groupBy ?? "model";
  const color = args.noColor ? false : undefined;

  // Surface auto-detected credentials so the user knows their next 2-min step,
  // without ever printing a raw secret.
  const detection = await detectLocalCredentials({ cwd: resolve(args.path) });
  const nextSteps = quickstartNextSteps(mode, detection.credentials);

  const summaryText = generatePlainEnglishSummary(summary, {
    records,
    groupBy,
    color,
    mode,
    nextSteps
  });

  return ok(summaryText);
}

function quickstartNextSteps(
  mode: "demo" | "connected" | "local-logs",
  detected: DetectedCredential[]
): string[] {
  const steps: string[] = [];
  if (mode === "local-logs") {
    steps.push("These numbers are API-equivalent ESTIMATES from your local Claude Code / Codex logs.");
  }
  if (detected.length > 0) {
    const names = detected.map((credential) => `${credential.provider} (${credential.hint})`).join(", ");
    steps.push(`Found local key${detected.length === 1 ? "" : "s"}: ${names}`);
    steps.push(`ai-spend-agent connect ${detected[0]!.provider}   use it — note: COST data needs an ADMIN/owner key`);
  } else if (mode === "demo" || mode === "local-logs") {
    steps.push("ai-spend-agent connect openai      pull your real OpenAI spend (org-owner admin key, ~2 min)");
    steps.push("ai-spend-agent connect anthropic   pull your real Anthropic spend (admin key, ~2 min)");
  }
  steps.push("ai-spend-agent report              write a shareable Markdown + HTML report");
  steps.push("Want this watched while your laptop is off? Hosted beta waitlist: https://ai-spend-agent.vercel.app");
  return steps;
}

async function readOptionalLocalSpend(rootPath: string): Promise<UsageRecord[] | undefined> {
  const stateDir = join(rootPath, ".ai-spend-agent");
  try {
    const spend = await readJson<{ records: UsageRecord[] }>(join(stateDir, "spend.json"));
    return spend.records;
  } catch {
    return undefined;
  }
}

async function loadInstantReadData(args: ParsedArgs): Promise<InstantReadData> {
  if (args.sample) {
    return { records: await loadSampleUsageData(), mode: "demo" };
  }

  // Real data beats sample data: (1) connected/synced state, then (2) usage
  // mined from this machine's agent logs (Claude Code / Codex — the spend no
  // billing API can see), then (3) the bundled sample so the wow ALWAYS lands.
  const localSpend = await readOptionalLocalSpend(resolve(args.path));
  if (localSpend && localSpend.length > 0) {
    return { records: localSpend, mode: "connected" };
  }

  const logs = await loadLocalAgentUsage({
    // Env overrides keep tests (and unusual installs) isolated from $HOME.
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR
  }).catch(() => undefined);
  if (logs && logs.records.length > 0) {
    return { records: logs.records, mode: "local-logs" };
  }

  // loadSampleUsageData resolves the bundled CSVs relative to the installed
  // package, so this works from ANY directory (true zero-config).
  return { records: await loadSampleUsageData(), mode: "demo" };
}

async function doctorCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  return ok([
    "AI Spend Analyst Agent doctor",
    `path: ${rootPath}`,
    "local-first mode: enabled",
    "subscription check: not wired in this slice",
    "redaction policy: secrets are never printed",
    `state directory: ${stateDir}`
  ].join("\n"));
}

async function initCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  await mkdir(stateDir, { recursive: true });

  const registry = createLocalFolderSourceRegistry(rootPath);
  await writeJson(join(stateDir, "manifest.json"), {
    product: "AI Spend Analyst Agent",
    mode: "local-first-demo",
    cloudUpload: false,
    cronJobsEnabled: false,
    redactionPolicy: "secrets are never printed; detected values are written only as [REDACTED]",
    sourceRegistry: "sources.json",
    auditLog: "audit-log.json",
    nextCommands: [
      "ai-spend-agent doctor",
      `ai-spend-agent scan --sample --path ${rootPath}`,
      `ai-spend-agent report --out ai-spend-report --path ${rootPath}`
    ]
  });
  await writeJson(join(stateDir, "sources.json"), registry);
  await writeJson(join(stateDir, "audit-log.json"), createScanAuditLog([
    {
      timestamp: registry.updatedAt,
      action: "source_registered",
      sourceId: "local-root",
      path: rootPath,
      detail: "Explicit local folder source approved during init."
    }
  ]));

  return ok([
    "AI Spend Analyst Agent init",
    `path: ${rootPath}`,
    "demo mode: local-first sample workflow",
    "cloud upload: disabled",
    "cron jobs: disabled in V0 demo",
    `state directory: ${stateDir}`,
    `next: ai-spend-agent scan --sample --path ${rootPath}`
  ].join("\n"));
}

async function scanCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const unsafeReason = unsafeScanRootReason(rootPath);
  if (unsafeReason) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Refusing to scan ${rootPath}: ${unsafeReason}. Choose a narrower approved folder with --path.`
    };
  }

  const stateDir = join(rootPath, ".ai-spend-agent");
  await mkdir(stateDir, { recursive: true });

  const registry = createLocalFolderSourceRegistry(rootPath);
  const startedAt = new Date().toISOString();
  const auditEvents: ScanAuditEvent[] = [
    {
      timestamp: registry.updatedAt,
      action: "source_registered",
      sourceId: "local-root",
      path: rootPath,
      detail: "Explicit local folder source approved for read-only scan."
    },
    {
      timestamp: startedAt,
      action: "scan_started",
      sourceId: "local-root",
      path: rootPath,
      detail: "Local scan started with cloud upload disabled."
    }
  ];

  const discovery = await scanLocalUsageSignals(rootPath);
  const missingSourcePrompts = buildMissingSourcePrompts(discovery.signals, registry);
  auditEvents.push({
    timestamp: new Date().toISOString(),
    action: "source_scanned",
    sourceId: "local-root",
    path: rootPath,
    detail: `${discovery.scannedFiles} files scanned; ${discovery.signals.length} signals found.`
  });
  for (const skippedDirectory of discovery.skippedDirectories) {
    auditEvents.push({
      timestamp: new Date().toISOString(),
      action: "source_skipped",
      sourceId: "local-root",
      path: skippedDirectory,
      reason: "Denied or heavy directory skipped during local scan."
    });
  }
  for (const secretName of discovery.secretsDetected) {
    auditEvents.push({
      timestamp: new Date().toISOString(),
      action: "secret_redacted",
      sourceId: "local-root",
      reason: `${secretName} was redacted before persistence/output.`
    });
  }
  auditEvents.push({
    timestamp: new Date().toISOString(),
    action: "scan_completed",
    sourceId: "local-root",
    path: rootPath,
    detail: "Local scan completed without cloud upload."
  });

  await writeJson(join(stateDir, "sources.json"), registry);
  await writeJson(join(stateDir, "audit-log.json"), createScanAuditLog(auditEvents));
  await writeJson(join(stateDir, "discovery.json"), discovery);
  await writeJson(join(stateDir, "missing-sources.json"), missingSourcePrompts);

  const lines = [
    "AI Spend Analyst Agent scan",
    `path: ${rootPath}`,
    "source registry: .ai-spend-agent/sources.json",
    "audit log: .ai-spend-agent/audit-log.json",
    `approved sources: ${registry.approvedSources.length}`,
    `discovery signals: ${discovery.signals.length}`,
    `secrets detected: ${discovery.secretsDetected.length}`
  ];

  if (args.sample) {
    const records = await loadSampleUsageData();
    const summary = analyzeSpend(records);
    const mappings = attributeUsageRecords(records);
    await writeLocalSpendState(stateDir, records, summary, mappings);
    lines.push(`sample records: ${records.length}`);
    lines.push(`total spend: $${summary.totalUsd.toFixed(2)}`);
    lines.push(`attribution mappings: ${mappings.length}`);
  }

  if (discovery.signals.length > 0) {
    lines.push("signals:");
    for (const signal of discovery.signals.slice(0, 8)) {
      lines.push(`- ${signal.provider} ${signal.kind} ${signal.filePath} (${Math.round(signal.confidence * 100)}%)`);
    }
  }

  if (missingSourcePrompts.length > 0) {
    lines.push("missing source prompts:");
    for (const prompt of missingSourcePrompts.slice(0, 8)) {
      lines.push(`- ${prompt.provider}: ${prompt.status}; suggested: ${prompt.suggestedConnector}`);
    }
  }

  return ok(lines.join("\n"));
}

async function watchCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  await mkdir(stateDir, { recursive: true });

  const intervalSeconds = Number.isFinite(args.interval) && (args.interval ?? 0) > 0 ? args.interval! : 3600;
  // cycles bounds how many iterations run; default 1 keeps the command testable and
  // cron-friendly (cron itself supplies the schedule). Use a higher value or --cycles 0
  // (unbounded) for a long-running local loop.
  const cycles = Number.isFinite(args.cycles) ? args.cycles! : 1;
  const unbounded = cycles === 0;
  const collected: string[] = [];

  let iteration = 0;
  while (unbounded || iteration < cycles) {
    const previous = await readOptionalJson<WatchSnapshot | null>(join(stateDir, "watch-latest.json"), null);
    const { summary, snapshot, records } = await runWatchCycle(stateDir, args);
    const deltaHeadline = buildDeltaHeadline(previous, snapshot);
    const plainEnglish = generatePlainEnglishSummary(summary, {
      records,
      groupBy: args.groupBy ?? "model",
      color: args.noColor ? false : undefined
    });
    const stamped = [
      `=== watch cycle @ ${snapshot.capturedAt} ===`,
      deltaHeadline,
      plainEnglish
    ].join("\n");
    collected.push(stamped);

    iteration += 1;
    const moreToGo = unbounded || iteration < cycles;
    if (moreToGo) {
      // eslint-disable-next-line no-console
      if (process.env.NODE_ENV !== "test") {
        console.log(stamped);
        console.log(`\n[watch] sleeping ${intervalSeconds}s until next cycle. Press Ctrl+C to stop.\n`);
      }
      await sleep(intervalSeconds * 1000);
    }
  }

  return ok(collected.join("\n\n"));
}

type WatchSnapshot = {
  capturedAt: string;
  totalUsd: number;
  recordCount: number;
  byModel: Array<{ key: string; amountUsd: number }>;
};

async function runWatchCycle(stateDir: string, args: ParsedArgs): Promise<{ summary: SpendSummary; snapshot: WatchSnapshot; records: UsageRecord[] }> {
  let records: UsageRecord[];
  if (args.sample) {
    records = await loadSampleUsageData();
  } else {
    records = await loadLiveRecords(stateDir);
    if (records.length === 0) {
      records = await loadSampleUsageData();
    }
  }

  const summary = analyzeSpend(records);
  const mappings = attributeUsageRecords(records);
  await writeLocalSpendState(stateDir, records, summary, mappings);

  const snapshot: WatchSnapshot = {
    capturedAt: new Date().toISOString(),
    totalUsd: summary.totalUsd,
    recordCount: summary.recordCount,
    byModel: summary.byModel.map((entry) => ({ key: entry.key, amountUsd: entry.amountUsd }))
  };

  // Append to the rolling history and persist the latest snapshot for the next run.
  const history = await readOptionalJson<WatchSnapshot[]>(join(stateDir, "watch-history.json"), []);
  await writeJson(join(stateDir, "watch-history.json"), [...history, snapshot].slice(-200));
  await writeJson(join(stateDir, "watch-latest.json"), snapshot);
  await appendAuditEvent(stateDir, {
    timestamp: snapshot.capturedAt,
    action: "scan_completed",
    sourceId: "watch",
    detail: `Watch cycle captured ${snapshot.recordCount} records totaling $${snapshot.totalUsd.toFixed(2)}.`
  });

  return { summary, snapshot, records };
}

function buildDeltaHeadline(previous: WatchSnapshot | null, current: WatchSnapshot): string {
  if (!previous) {
    return `First watch snapshot. Baseline AI spend is $${current.totalUsd.toFixed(2)} across ${current.recordCount} charges. Future cycles will report what changed.`;
  }

  const deltaUsd = roundMoneyCli(current.totalUsd - previous.totalUsd);
  const lines: string[] = [];

  if (Math.abs(deltaUsd) < 0.01) {
    lines.push(`No change since the last check: AI spend is holding at $${current.totalUsd.toFixed(2)}.`);
  } else {
    const direction = deltaUsd > 0 ? "UP" : "DOWN";
    const percent = previous.totalUsd > 0 ? Math.round((deltaUsd / previous.totalUsd) * 100) : 100;
    lines.push(
      `Spend is ${direction} $${Math.abs(deltaUsd).toFixed(2)} (${Math.abs(percent)}%) since the last check — ` +
        `from $${previous.totalUsd.toFixed(2)} to $${current.totalUsd.toFixed(2)}.`
    );
  }

  // New-model and per-model spike detection versus the previous snapshot.
  const previousModels = new Map(previous.byModel.map((entry) => [entry.key, entry.amountUsd]));
  const anomalies: string[] = [];
  for (const entry of current.byModel) {
    const before = previousModels.get(entry.key);
    if (before === undefined) {
      if (entry.amountUsd >= 1) {
        anomalies.push(`New model "${entry.key}" appeared, already at $${entry.amountUsd.toFixed(2)}.`);
      }
      continue;
    }
    if (before > 0 && entry.amountUsd - before >= 5 && entry.amountUsd / before >= 1.5) {
      anomalies.push(`"${entry.key}" jumped from $${before.toFixed(2)} to $${entry.amountUsd.toFixed(2)}.`);
    }
  }

  if (anomalies.length > 0) {
    lines.push(`Anomalies worth a look: ${anomalies.join(" ")}`);
  }

  return lines.join(" ");
}

async function loadLiveRecords(stateDir: string): Promise<UsageRecord[]> {
  const providerState = await readOptionalJson<{ records: UsageRecord[] }>(
    join(stateDir, "provider-records.json"),
    { records: [] }
  );
  if (providerState.records.length > 0) {
    return providerState.records;
  }
  const spendState = await readOptionalJson<{ records?: UsageRecord[] }>(
    join(stateDir, "spend.json"),
    {}
  );
  return spendState.records ?? [];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function roundMoneyCli(value: number): number {
  return Math.round(value * 100) / 100;
}

async function addSourceCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  if (!args.sourcePath || !args.sourceType || !args.label) {
    return { exitCode: 1, stdout: "", stderr: "add-source requires --source-path, --type, and --label" };
  }

  const registry = await readSourceRegistry(stateDir, rootPath);
  const sourcePath = args.sourceType === "mcp_tool" ? args.sourcePath : resolve(args.sourcePath);
  const id = slugifySourceId(args.label);
  const nextRegistry = addApprovedSource(registry, {
    id,
    type: args.sourceType,
    label: args.label,
    path: sourcePath,
    provider: args.provider
  });
  await writeJson(join(stateDir, "sources.json"), nextRegistry);
  await appendAuditEvent(stateDir, {
    timestamp: nextRegistry.updatedAt,
    action: "source_registered",
    sourceId: id,
    path: sourcePath,
    detail: `${args.sourceType} approved via CLI add-source.`
  });

  return ok([
    "AI Spend Analyst Agent add-source",
    `source added: ${id}`,
    `type: ${args.sourceType}`,
    `path: ${sourcePath}`,
    `provider: ${args.provider ?? "unknown"}`,
    "read-only: true"
  ].join("\n"));
}

async function listSourcesCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  const registry = await readSourceRegistry(stateDir, rootPath);
  const lines = [
    "AI Spend Analyst Agent sources",
    `approved sources: ${registry.approvedSources.length}`
  ];
  for (const source of registry.approvedSources) {
    lines.push(`- ${source.id} | ${source.type} | ${source.label} | ${source.provider ?? "unknown"} | ${source.path ?? "no path"}`);
  }
  return ok(lines.join("\n"));
}

// Connect flow leads with the two providers an org owner can self-serve in
// ~2 minutes. Cursor + Copilot are clearly-labeled team/billing-admin upgrades,
// not first-run blockers.
const selfServeProviders = new Set(["openai", "anthropic"]);
const adminUpgradeProviders: Record<string, string> = {
  cursor: "requires a Cursor TEAM-ADMIN key (Business plan only)",
  "github-copilot": "requires a GitHub BILLING-ADMIN token (org/enterprise)",
  copilot: "requires a GitHub BILLING-ADMIN token (org/enterprise)"
};

const providerAdminEnvHint: Record<string, string> = {
  openai: "env:OPENAI_ADMIN_KEY",
  anthropic: "env:ANTHROPIC_ADMIN_KEY",
  cursor: "env:CURSOR_ADMIN_KEY",
  "github-copilot": "env:GITHUB_TOKEN",
  copilot: "env:GITHUB_TOKEN"
};

async function connectCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  const provider = args.provider ?? "unknown";
  if (!provider || provider === "unknown") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "connect requires a provider. Start with one you can self-serve in ~2 min:",
        "  ai-spend-agent connect openai      (org-owner Admin key)",
        "  ai-spend-agent connect anthropic   (Admin key)",
        "Team/billing-admin upgrades:",
        "  ai-spend-agent connect cursor          (Cursor team-admin key, Business plan)",
        "  ai-spend-agent connect github-copilot  (GitHub billing-admin token)"
      ].join("\n")
    };
  }
  const type = args.sourceType ?? "provider_api";
  const registry = await readSourceRegistry(stateDir, rootPath);
  const source = createProviderConnectorStub(provider, type);
  const nextRegistry = addApprovedSource(registry, source);
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "sources.json"), nextRegistry);
  await appendAuditEvent(stateDir, {
    timestamp: nextRegistry.updatedAt,
    action: "source_registered",
    sourceId: source.id,
    detail: `${provider} ${type} connector stub registered. No raw secrets stored.`
  });

  // Auto-detect a local key for this provider (never prints the raw value).
  const detection = await detectLocalCredentials({ cwd: rootPath });
  const detected = detection.credentials.find((credential) => credential.provider === provider);

  const lines = [
    "AI Spend Analyst Agent connect",
    `connector stub: ${source.id}`,
    `provider: ${provider}`,
    `type: ${type}`,
    `access method: ${source.accessMethod}`,
    `verification: ${source.verification}`,
    "secrets: no raw secrets stored; we only reference a local env var such as env:OPENAI_ADMIN_KEY"
  ];

  if (selfServeProviders.has(provider)) {
    lines.push("tier: self-serve — an org owner can enable this in ~2 minutes");
  } else if (adminUpgradeProviders[provider]) {
    lines.push(`tier: ADMIN UPGRADE — ${adminUpgradeProviders[provider]}`);
  }

  lines.push(
    "IMPORTANT: cost data is ADMIN-gated. A regular API key authenticates but will NOT return spend; use an admin/owner key."
  );

  if (detected) {
    lines.push("");
    lines.push(`auto-detected: a ${provider} key in ${detected.reference} (${detected.hint}) from ${describeOrigin(detected)}`);
    if (detected.isLikelyAdminKey) {
      const adminRef = providerAdminEnvHint[provider] ?? detected.reference;
      lines.push(`next: ai-spend-agent sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
    } else {
      const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
      lines.push(`this looks like a regular key — for COST data set an admin key in ${adminRef}, then:`);
      lines.push(`  ai-spend-agent sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
    }
  } else {
    const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
    lines.push("");
    lines.push(`next: export an admin key reference, e.g. ${adminRef}, then run:`);
    lines.push(`  ai-spend-agent sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
  }

  lines.push(`missing: ${source.fieldsMissing.join(", ")}`);

  return ok(lines.join("\n"));
}

function describeOrigin(credential: DetectedCredential): string {
  if (credential.origin === "process_env") return "your shell environment";
  if (credential.origin === "dotenv") return ".env";
  return "shell rc file";
}

async function syncProviderCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  if (!args.provider || !args.authReference || !args.startTime) {
    return { exitCode: 1, stdout: "", stderr: "sync-provider requires --provider, --auth-reference env:NAME, and --start-time" };
  }

  try {
    const result = await fetchProviderUsageRecords({
      provider: args.provider,
      sourceId: `${args.provider}-provider-api`,
      authReference: args.authReference,
      startTime: args.startTime,
      endTime: args.endTime,
      org: args.org,
      enterprise: args.enterprise,
      accountId: args.accountId
    });
    const registry = await readSourceRegistry(stateDir, rootPath);
    const nextRegistry = addApprovedSource(registry, result.source);
    const summary = analyzeSpend(result.records);
    const mappings = attributeUsageRecords(result.records);
    await mkdir(stateDir, { recursive: true });
    await writeJson(join(stateDir, "sources.json"), nextRegistry);
    await writeJson(join(stateDir, "provider-records.json"), {
      provider: result.provider,
      fetchedAt: result.fetchedAt,
      completeness: result.completeness,
      sourceId: result.source.id,
      records: result.records,
      qa: result.qa
    });
    await writeLocalSpendState(stateDir, result.records, summary, mappings);
    await appendAuditEvent(stateDir, {
      timestamp: result.fetchedAt,
      action: "source_scanned",
      sourceId: result.source.id,
      detail: `${args.provider} provider connector synced ${result.records.length} verified records. Auth reference only; no raw secrets stored.`
    });

    return ok([
      "AI Spend Analyst Agent sync-provider",
      `provider: ${result.provider}`,
      `source: ${result.source.id}`,
      `verification: ${result.source.verification}`,
      `verified records: ${result.records.length}`,
      `total spend: $${summary.totalUsd.toFixed(2)}`,
      "auth: reference-only; raw secrets were not persisted or printed"
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: sanitizeSecretishError(error instanceof Error ? error.message : String(error), args.authReference)
    };
  }
}

async function confirmMappingCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  if (!args.provider || !args.sourceId) {
    return { exitCode: 1, stdout: "", stderr: "confirm-mapping requires --provider and --source-id" };
  }

  const mapping = confirmMapping({
    provider: args.provider,
    sourceId: args.sourceId,
    team: args.team,
    person: args.person,
    client: args.client,
    project: args.project,
    agent: args.agent,
    workflow: args.workflow,
    evidence: args.evidence ? [args.evidence] : [],
    confidence: args.confidence ?? 0.7
  });
  const mappings = await readConfirmedMappings(stateDir);
  const nextMappings = [...mappings.filter((candidate) => candidate.id !== mapping.id), mapping];
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "confirmed-mappings.json"), nextMappings);
  await appendAuditEvent(stateDir, {
    timestamp: mapping.confirmedAt,
    action: "mapping_confirmed",
    sourceId: args.sourceId,
    detail: `${args.provider} mapped to ${[args.team, args.project, args.workflow].filter(Boolean).join(" / ")}`
  });

  return ok([
    "AI Spend Analyst Agent confirm-mapping",
    `mapping confirmed: ${mapping.id}`,
    `provider: ${mapping.provider}`,
    `target: ${[mapping.team, mapping.project, mapping.workflow].filter(Boolean).join(" / ")}`,
    `confidence: ${mapping.confidence}`
  ].join("\n"));
}

async function reportCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");

  try {
    const reportInput = await buildReportInput(stateDir, rootPath);
    const outBase = args.out ? resolve(rootPath, args.out) : join(stateDir, "report");
    const markdownPath = `${outBase}.md`;
    const htmlPath = `${outBase}.html`;
    await writeFile(markdownPath, generateMarkdownReport(reportInput), "utf8");
    await writeFile(htmlPath, generateHtmlReport(reportInput), "utf8");
    const artifactPaths = await writeApplyArtifacts(stateDir, reportInput);

    return ok([
      "AI Spend Analyst Agent report",
      `path: ${rootPath}`,
      `markdown: ${markdownPath}`,
      `html: ${htmlPath}`,
      `apply artifact: ${artifactPaths.codingPrompt}`,
      `action plan: ${artifactPaths.actionPlan}`,
      `policy/config draft: ${artifactPaths.policyConfigDraft}`,
      `verification plan: ${artifactPaths.verificationPlan}`,
      `demo package: ${artifactPaths.demoPackage}`,
      `total spend: $${reportInput.summary.totalUsd.toFixed(2)}`,
      "privacy: local files only; no cloud upload performed"
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `No local spend state found at ${stateDir}. Run scan --sample --path <dir> first. ${error instanceof Error ? error.message : ""}`
    };
  }
}

async function reportCardCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const { records, mode } = await loadInstantReadData(args);

  const summary = analyzeSpend(records);
  const outPath = args.out ? resolve(rootPath, args.out) : join(rootPath, "ai-spend-card.svg");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, generateReportCardSvg({ summary, records }), "utf8");

  const dataLine = mode === "demo"
    ? "data: DEMO sample data — run without --sample on a machine with Claude Code/Codex logs for your own numbers."
    : mode === "local-logs"
      ? "data: local Claude Code/Codex logs priced at API-equivalent rates."
      : "data: connected local spend state.";

  return ok([
    "Shareable AI spend report card written (redacted — no client/project/user names).",
    `card: ${outPath}`,
    dataLine,
    "",
    "Caption to share:",
    generateReportCardCaption({ summary, records }),
    "",
    "privacy: rendered locally; only totals, savings, and model-level cuts are included."
  ].join("\n"));
}

async function applyArtifactCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");

  try {
    const reportInput = await buildReportInput(stateDir, rootPath);
    const artifactPaths = await writeApplyArtifacts(stateDir, reportInput);
    return ok([
      "AI Spend Analyst Agent apply-artifact",
      `path: ${rootPath}`,
      `coding prompt: ${artifactPaths.codingPrompt}`,
      `action plan: ${artifactPaths.actionPlan}`,
      `policy/config draft: ${artifactPaths.policyConfigDraft}`,
      `verification plan: ${artifactPaths.verificationPlan}`,
      `demo package: ${artifactPaths.demoPackage}`,
      "safety: generated artifacts only; no external systems changed"
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `No local spend state found at ${stateDir}. Run scan --sample --path <dir> first. ${error instanceof Error ? error.message : ""}`
    };
  }
}

async function buildReportInput(stateDir: string, rootPath: string) {
  const [spendState, discovery, mappings, sourceRegistry, missingSourcePrompts, confirmedMappings, providerRecordsState] = await Promise.all([
    readJson<{ summary: SpendSummary }>(join(stateDir, "spend.json")),
    readJson<LocalDiscoveryResult>(join(stateDir, "discovery.json")),
    readJson<AttributionMapping[]>(join(stateDir, "mappings.json")),
    readSourceRegistry(stateDir, rootPath),
    readOptionalJson(join(stateDir, "missing-sources.json"), []),
    readConfirmedMappings(stateDir),
    readOptionalJson<{ records: UsageRecord[]; qa?: ProviderQaSummary }>(join(stateDir, "provider-records.json"), { records: [] })
  ]);

  return {
    summary: spendState.summary,
    discovery,
    mappings,
    sourceRegistry,
    missingSourcePrompts,
    confirmedMappings,
    providerRecords: providerRecordsState.records,
    providerQa: providerRecordsState.qa ? [providerRecordsState.qa] : []
  };
}

async function writeApplyArtifacts(stateDir: string, reportInput: Awaited<ReturnType<typeof buildReportInput>>) {
  const paths = {
    codingPrompt: join(stateDir, "ai-spend-coding-agent-prompt.md"),
    actionPlan: join(stateDir, "ai-spend-action-plan.md"),
    policyConfigDraft: join(stateDir, "ai-spend-policy-config-draft.md"),
    verificationPlan: join(stateDir, "ai-spend-verify-plan.md"),
    demoPackage: join(stateDir, "demo-package.md")
  };
  await writeFile(paths.codingPrompt, generateApplyArtifactMarkdown(reportInput), "utf8");
  await writeFile(paths.actionPlan, generateActionPlanMarkdown(reportInput), "utf8");
  await writeFile(paths.policyConfigDraft, generatePolicyConfigDraftMarkdown(reportInput), "utf8");
  await writeFile(paths.verificationPlan, generateVerificationPlanMarkdown(reportInput), "utf8");
  await writeFile(paths.demoPackage, generateDemoPackageMarkdown(reportInput), "utf8");
  return paths;
}

function parseArgs(argv: string[]): ParsedArgs {
  // If the first token is a flag (e.g. `ai-spend-agent --group-by agent`),
  // there is no subcommand: parse the whole argv as flags for the default
  // instant-demo command.
  const hasCommand = argv.length > 0 && !argv[0]!.startsWith("-");
  const command = hasCommand ? argv[0] : undefined;
  const rest = hasCommand ? argv.slice(1) : argv;
  const parsed: ParsedArgs = {
    command,
    sample: false,
    path: process.cwd()
  };
  if (command === "connect" && rest[0] && !rest[0].startsWith("--")) {
    parsed.provider = rest[0];
    rest.shift();
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--sample") {
      parsed.sample = true;
      continue;
    }
    if (arg === "--no-color") {
      parsed.noColor = true;
      continue;
    }
    if (arg === "--group-by") {
      const next = rest[index + 1];
      if (isGroupByDimension(next)) {
        parsed.groupBy = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--path") {
      const next = rest[index + 1];
      if (next) {
        parsed.path = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--out") {
      const next = rest[index + 1];
      if (next) {
        parsed.out = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--source-path") {
      const next = rest[index + 1];
      if (next) {
        parsed.sourcePath = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--type") {
      const next = rest[index + 1];
      if (isSourceType(next)) {
        parsed.sourceType = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--provider") {
      const next = rest[index + 1];
      if (next) {
        parsed.provider = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--source-id") {
      const next = rest[index + 1];
      if (next) {
        parsed.sourceId = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--team") {
      const next = rest[index + 1];
      if (next) {
        parsed.team = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--person") {
      const next = rest[index + 1];
      if (next) {
        parsed.person = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--client") {
      const next = rest[index + 1];
      if (next) {
        parsed.client = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--project") {
      const next = rest[index + 1];
      if (next) {
        parsed.project = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--agent") {
      const next = rest[index + 1];
      if (next) {
        parsed.agent = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--workflow") {
      const next = rest[index + 1];
      if (next) {
        parsed.workflow = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--evidence") {
      const next = rest[index + 1];
      if (next) {
        parsed.evidence = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--confidence") {
      const next = rest[index + 1];
      if (next) {
        parsed.confidence = Number(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--label") {
      const next = rest[index + 1];
      if (next) {
        parsed.label = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--auth-reference") {
      const next = rest[index + 1];
      if (next) {
        parsed.authReference = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--start-time") {
      const next = rest[index + 1];
      if (next) {
        parsed.startTime = Number(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--end-time") {
      const next = rest[index + 1];
      if (next) {
        parsed.endTime = Number(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--org") {
      const next = rest[index + 1];
      if (next) {
        parsed.org = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--enterprise") {
      const next = rest[index + 1];
      if (next) {
        parsed.enterprise = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--account-id") {
      const next = rest[index + 1];
      if (next) {
        parsed.accountId = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--group-by") {
      const next = rest[index + 1];
      if (isGroupByDimension(next)) {
        parsed.groupBy = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--interval") {
      const next = rest[index + 1];
      if (next) {
        parsed.interval = Number(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--cycles") {
      const next = rest[index + 1];
      if (next) {
        parsed.cycles = Number(next);
        index += 1;
      }
      continue;
    }
  }
  return parsed;
}

function sanitizeSecretishError(message: string, authReference?: string): string {
  let sanitized = message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (authReference && !authReference.startsWith("env:")) {
    sanitized = sanitized.split(authReference).join("[REDACTED]");
  }
  return sanitized;
}

function unsafeScanRootReason(rootPath: string): string | undefined {
  const homePath = resolve(homedir());
  if (rootPath === homePath) {
    return "the home directory is too broad for V0 approved-source scanning";
  }
  if (rootPath === "/") {
    return "the filesystem root is too broad for V0 approved-source scanning";
  }
  return undefined;
}

async function writeLocalSpendState(
  stateDir: string,
  records: UsageRecord[],
  summary: SpendSummary,
  mappings: AttributionMapping[]
): Promise<void> {
  await writeJson(join(stateDir, "spend.json"), { records, summary });
  await writeJson(join(stateDir, "mappings.json"), mappings);
}

async function readSourceRegistry(stateDir: string, rootPath: string): Promise<SourceRegistry> {
  try {
    return await readJson<SourceRegistry>(join(stateDir, "sources.json"));
  } catch {
    return createLocalFolderSourceRegistry(rootPath);
  }
}

async function readConfirmedMappings(stateDir: string): Promise<ConfirmedMapping[]> {
  try {
    return await readJson<ConfirmedMapping[]>(join(stateDir, "confirmed-mappings.json"));
  } catch {
    return [];
  }
}

function isGroupByDimension(value: string | undefined): value is GroupByDimension {
  return value !== undefined && (groupByDimensions as string[]).includes(value);
}

function isSourceType(value: string | undefined): value is SourceType {
  return value === "local_folder" ||
    value === "provider_export" ||
    value === "provider_api" ||
    value === "browser_account" ||
    value === "local_tool_detection" ||
    value === "mcp_tool" ||
    value === "internal_system";
}

async function appendAuditEvent(stateDir: string, event: ScanAuditEvent): Promise<void> {
  let auditLog = createScanAuditLog();
  try {
    auditLog = await readJson<ReturnType<typeof createScanAuditLog>>(join(stateDir, "audit-log.json"));
  } catch {
    // Create a fresh local-only audit log if init has not run yet.
  }
  await writeJson(join(stateDir, "audit-log.json"), createScanAuditLog([...auditLog.events, event]));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function helpText(): string {
  return [
    "AI Spend Analyst — your AI spend in one view in 90 seconds",
    "",
    "Run with no command for an instant, zero-key demo:",
    "  ai-spend-agent                       Show where your AI money goes (sample/auto-detected data)",
    "  ai-spend-agent --group-by agent      Drill down by source|model|client|project|agent|user|workspace|apiKey",
    "",
    "Connect your real spend (cost data is ADMIN/owner-gated):",
    "  ai-spend-agent connect openai        Self-serve in ~2 min with an org-owner Admin key",
    "  ai-spend-agent connect anthropic     Self-serve in ~2 min with an Admin key",
    "  ai-spend-agent connect cursor        Upgrade: requires a Cursor team-admin key (Business plan)",
    "  ai-spend-agent connect github-copilot Upgrade: requires a GitHub billing-admin token",
    "  ai-spend-agent sync-provider ...     Pull verified cost via a local env: reference (never a raw key)",
    "",
    "Watch continuously (deltas + anomalies):",
    "  watch [--interval N]    Re-run analysis on an interval and report deltas/anomalies",
    "    [--cycles N] [--group-by ...]  --cycles 0 runs forever; default 1 (cron-friendly)",
    "",
    "Other commands:",
    "  init [--path <dir>]     Initialize local state",
    "  doctor                  Check local runtime and safety posture",
    "  scan [--path <dir>]     Scan a local workspace for AI usage signals",
    "  scan --sample           Include deterministic sample spend analysis",
    "  quickstart [--sample]   Plain-English 90-second readout (alias of the default run)",
    "    [--group-by source|model|client|project|agent|user|workspace|apiKey]  Default: model",
    "  report [--out <name>]   Generate local Markdown and HTML reports",
    "  report-card [--out f.svg] Write a redacted, shareable SVG spend card + caption",
    "  apply-artifact          Generate coding prompt, action plan, policy/config, verification, demo package",
    "",
    "Cron (production watch): add a crontab entry such as:",
    "  0 * * * * cd /path/to/workspace && ai-spend-agent watch --interval 3600 --cycles 1 >> ai-spend-watch.log 2>&1",
    "",
    "Privacy: local-first. No files, credentials, or spend data are uploaded. Secrets are never printed."
  ].join("\n");
}

// Main-module check that survives npm's bin SYMLINKS: argv[1] is
// node_modules/.bin/ai-spend-agent (a symlink), so resolve it to the real
// file before comparing. A naive `file://${argv[1]}` match silently no-ops
// for every npx/global-install user.
const invokedAsMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  // Fail with a clear message on old Node instead of a cryptic module/syntax
  // error deep in a dependency. npm warns on engines but never blocks install.
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 22) {
    console.error(
      `ai-spend-agent needs Node 22 or newer (you have ${process.versions.node}).\n` +
        "Upgrade Node, then run: npx ai-spend-agent"
    );
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const command = argv[0];
  const isInstantDemo = !command || command === "quickstart" || command === "demo";

  // Show a spinner only for the work-heavy instant-demo path, and only on a
  // real TTY so piped output stays clean.
  let spinner: { stop: () => void } | undefined;
  if (isInstantDemo && process.stdout.isTTY && !process.env.NO_COLOR) {
    try {
      const { default: yoctoSpinner } = await import("yocto-spinner");
      spinner = yoctoSpinner({ text: "Analyzing your AI spend…" }).start();
    } catch {
      // Spinner is optional; never block the wow on it.
    }
  }

  let result: CliResult;
  try {
    result = await runCli(argv);
  } finally {
    spinner?.stop();
  }

  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  process.exitCode = result.exitCode;
}
