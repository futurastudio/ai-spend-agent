#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeSpend,
  attributeUsageRecords,
  buildUsageGlance,
  buildActivitySnapshot,
  loadContextHealth,
  detectLocalCredentials,
  detectLocalPlans,
  redactSecrets,
  readSafeStateText,
  invalidateConnectedSpendTrustReceipt,
  resolveSafeScanRoot,
  resolveSafeStateDirectory,
  subscriptionPlans,
  unsafeScanRootReason,
  selectProviderFinancialHeadlineRecords,
  writeSafeStateText,
  verifyConnectedSpendTrustReceipt,
  verifyConnectedSourceRegistryTrustReceipt,
  writeConnectedSpendTrustReceipt,
  type DetectedPlan,
  loadDeadContext,
  sampleDeadContext,
  latestObservedWorkingDirectory,
  downgradeSampleUsageEvidence,
  isBundledSampleUsage,
  loadLocalAgentUsage,
  loadLocalAgentFinancialUsage,
  localAgentFormatDescriptors,
  localAgentFormatLabel,
  loadSampleUsageData,
  parseUsageRecord,
  scanLocalUsageSignals,
  buildMissingSourcePrompts,
  confirmMapping,
  createProviderConnectorStub,
  createLocalFolderSourceRegistry,
  createScanAuditLog,
  fetchProviderUsageRecords,
  addApprovedSource,
  normalizeSourceRegistry,
  downgradeUntrustedSourceRegistryClaims,
  buildSourceStatuses,
  slugifySourceId,
  financialEvidenceForRecords,
  formatSourceStatuses,
  readActivitySnapshot,
  recordActivitySnapshotRefreshFailure,
  sourceStatusDefinitions,
  writeActivitySnapshot,
  type ActivitySnapshot,
  type ActivitySnapshotApiEquivalentWindows,
  type ActivitySnapshotProvider,
  type ActivitySnapshotProviderCoverageInput,
  type ActivitySnapshotRefreshErrorCode,
  type AttributionMapping,
  type ConfirmedMapping,
  type DetectedCredential,
  type LocalDiscoveryResult,
  type ScanAuditEvent,
  type SourceRegistry,
  type SourceType,
  type SpendSummary,
  type UsageRecord,
  type ProviderCoverageStatus,
  type ProviderCoverageInterval,
  type ProviderQaSummary,
  type SourceStatusObservation,
  type LocalAgentLogDiagnostic,
  type LocalAgentSourceScan,
  type ContextHealthResult,
  type ParsedInvocationFile
} from "@agent-finops/core";
import {
  StatuslineInstallerError,
  installClaudeStatusline,
  uninstallClaudeStatusline
} from "./statuslineInstaller.js";
import {
  readStatuslineCache,
  renderStatusline
} from "./statuslineRuntime.js";
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
  type GroupByDimension,
  type SpendReportInput
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
  pathExplicit?: boolean;
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
  /** Set when --group-by was passed with a missing/unknown dimension. */
  groupByInvalid?: string;
  interval?: number;
  cycles?: number;
  noColor?: boolean;
  ignoreState?: boolean;
  plan?: string;
  sinceDays?: number;
  json?: boolean;
  sources?: boolean;
  statusline?: boolean;
  statuslineAction?: string;
  replaceStatusline?: boolean;
};

export type CliRuntimeOptions = {
  /** Test/embedding override. Production always defaults to the OS home. */
  homeDirectory?: string;
  /** Test/embedding override. Packed production reads the built runtime asset. */
  statuslineRunnerContents?: string | Uint8Array;
  statuslineNow?: Date;
  statuslineColumns?: number;
  statuslineTimeZone?: string;
};

export async function runCli(
  argv = process.argv.slice(2),
  runtime: CliRuntimeOptions = {}
): Promise<CliResult> {
  if (argv.includes("--version") || argv.includes("-v")) {
    return ok(await cliVersion());
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return ok(helpText());
  }

  const args = parseArgs(argv);

  if (args.groupByInvalid) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `--group-by needs a dimension: ${groupByDimensions.join("|")}\nexample: npx aibill --group-by project`
    };
  }

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

  if (args.command === "reset") {
    return resetCommand(args);
  }

  if (args.command === "init") {
    return initCommand(args, runtime);
  }

  if (args.command === "statusline") {
    return statuslineCommand(args, runtime);
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

  if (args.command === "glance") {
    return glanceCommand(args);
  }

  if (args.command === "context" || args.command === "context-health") {
    return contextHealthCommand(args);
  }

  if (args.command === "apply-artifact" || args.command === "apply") {
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
  warnings: string[];
  providerCoverage?: ProviderCoverageStatus;
  codexInvocationFiles?: ParsedInvocationFile[];
};

async function quickstartCommand(args: ParsedArgs): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const { records, mode, warnings, providerCoverage, codexInvocationFiles } = await loadInstantReadData(args);
  const summaryRecords = mode === "connected"
    ? selectProviderFinancialHeadlineRecords(records)
    : records;
  const summary = analyzeSpend(summaryRecords);
  // For real local-log users the by-project view is the flagship table
  // ("which project burns my plan"); demo/connected keep by-model.
  const groupBy = args.groupBy ?? (mode === "local-logs" ? "project" : "model");
  const color = args.noColor ? false : undefined;

  // Persona: --plan override wins; otherwise read the plans the coding agents
  // themselves persisted locally (read-only, whitelisted fields, no network).
  let detectedPlans: DetectedPlan[];
  if (args.sample) {
    // An explicit sample run must be deterministic and safe to record/share.
    // Never mix the developer's real local plan into illustrative output.
    detectedPlans = [];
  } else if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${args.plan}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
      };
    }
    detectedPlans = [override];
  } else {
    detectedPlans = await detectLocalPlans({
      // Env overrides keep tests (and unusual installs) isolated from $HOME.
      claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
      codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
    }).catch(() => []);
  }

  // Surface auto-detected credentials so the user knows their next 2-min step,
  // without ever printing a raw secret.
  // Sample output is designed for demos, docs, and screenshots. Keeping local
  // credential discovery out of that path prevents even redacted machine-
  // specific hints from leaking into a recording.
  const detection = args.sample
    ? { credentials: [] as DetectedCredential[], scannedFiles: [] as string[] }
    : await detectLocalCredentials({
        cwd: resolve(args.path),
        home: process.env.AI_SPEND_CLAUDE_HOME_DIR
      });
  const nextSteps = quickstartNextSteps(mode, detection.credentials);

  // Dead-context cost, globalized across the user's whole Claude Code setup
  // (all projects' MCP + user-scope skills/agents/commands, vs. every
  // transcript) so it's populated from ANY directory on the first run.
  // Never throws into the readout.
  let deadContext = args.sample
    ? undefined
    : await loadDeadContext({
        // Env overrides keep tests (and unusual installs) isolated from $HOME.
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
        claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
        codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
        projectDir: resolve(args.path),
        includeAllProjectMcp: true,
        sinceIso: sinceIsoForDays(sinceDays),
        windowDays: sinceDays,
        codexInvocationFiles
      }).catch(() => undefined);
  // Sample dead-context is shown ONLY on the demo readout. A real readout
  // (local logs / connected billing) never gets fabricated waste injected —
  // a genuinely clean setup earns its congratulation line instead.
  if (mode === "demo" && (!deadContext || !deadContext.hasData)) {
    deadContext = sampleDeadContext();
  }

  const summaryText = generatePlainEnglishSummary(summary, {
    records: summaryRecords,
    groupBy,
    color,
    mode,
    ...(providerCoverage ? { providerCoverage } : {}),
    nextSteps,
    deadContext,
    detectedPlans,
    // An explicit --group-by is a drill-down question: answer with just the
    // table + window instead of repeating the whole readout.
    view: args.groupBy ? "breakdown" : "full"
  });

  const header = [`  ${dataModeBanner(mode)}`, ...warnings.map((warning) => `  ! ${warning}`)].join("\n");
  return ok(`${header}\n${summaryText}`);
}

async function glanceCommand(args: ParsedArgs): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const logs = await loadLocalAgentUsage({
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    sinceIso: sinceIsoForDays(sinceDays),
    collectCodexInvocationEvidence: true
  });
  const calls = args.project
    ? logs.calls.filter((call) => call.project === args.project)
    : logs.calls;
  const latestWorkingDirectory = latestObservedWorkingDirectory(calls);
  const contextProjectDir = args.pathExplicit
    ? resolve(args.path)
    : latestWorkingDirectory ?? resolve(args.path);
  let detectedPlans: DetectedPlan[];
  if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${args.plan}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
      };
    }
    detectedPlans = [override];
  } else {
    detectedPlans = await detectLocalPlans({
      claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
      codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
    }).catch(() => []);
  }
  const contextHealth = await loadContextHealth(calls, {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
    codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
    claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
    claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
    projectDir: contextProjectDir,
    sinceIso: sinceIsoForDays(sinceDays),
    windowDays: sinceDays,
    codexInvocationFiles: logs.codexInvocationFiles
  });
  const snapshot = buildUsageGlance(calls, {
    filesParsed: logs.filesParsed,
    detectedAgents: logs.agentsDetected,
    detectedPlans,
    limitCalls: logs.calls,
    contextHealth
  });
  return ok(JSON.stringify(snapshot));
}

async function contextHealthCommand(args: ParsedArgs): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const sinceIso = sinceIsoForDays(sinceDays);
  const logs = await loadLocalAgentUsage({
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    sinceIso,
    collectCodexInvocationEvidence: true
  });
  const calls = args.project
    ? logs.calls.filter((call) => call.project === args.project)
    : logs.calls;
  const health = await loadContextHealth(calls, {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
    codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
    claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
    claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
    projectDir: resolve(args.path),
    sinceIso,
    windowDays: sinceDays,
    codexInvocationFiles: logs.codexInvocationFiles
  });
  return ok(args.json ? JSON.stringify(health) : renderContextHealth(health));
}

function renderContextHealth(health: ContextHealthResult): string {
  const status = health.status.replace("_", " ").toUpperCase();
  const activation = health.activation;
  const dead = health.deadContext;
  const lines = [
    `CONTEXT HEALTH  ${status}`,
    health.headline,
    "",
    `Action: ${health.action}`,
    `Confidence: ${health.confidence}`,
    "",
    "Activation",
    `  Discoverable: ${activation.discoverableItems}  Invoked: ${activation.explicitlyInvokedItems}  MCP configured: ${activation.mcpConfiguredItems}`,
    `  MCP always-load requested: ${activation.mcpAlwaysLoadedItems}  Legacy schema-loaded label: ${activation.mcpSchemaLoadedItems}`,
    `  Hook-injected: ${activation.hookInjectedItems}  Other lifecycle hooks: ${activation.lifecycleHooks}  Unmeasured weight: ${activation.unmeasuredItems}`,
    `  Invocation-unobservable: ${activation.invocationUnobservableItems}`,
    "",
    `No matching invocation among observable inventory (${dead.windowDays}d): ${dead.neverInvokedItems}/${dead.loadedItems} ` +
      `(${dead.measuredNeverInvokedItems} measured, ${dead.unmeasuredNeverInvokedItems} unmeasured)`
  ];
  if (health.currentSession) {
    const session = health.currentSession;
    lines.push(
      `Latest turn: ${session.agent}${session.project ? ` · ${session.project}` : ""} · ` +
      (session.usageSource === "not_available"
        ? "input context unavailable; cumulative lifetime usage excluded"
        : `${session.contextTokens.toLocaleString("en-US")} input context tokens · ` +
          (session.ratioToMedian === null
            ? `${session.comparisonSessions} comparable prior session${session.comparisonSessions === 1 ? "" : "s"}; baseline not yet sufficient`
            : `${session.ratioCapped ? "at least " : ""}${session.ratioToMedian}× comparable median (${session.comparisonSessions} prior)`))
    );
  }
  const churn = health.contextChurn;
  if (churn.currentSessionEvidence === "matched") {
    lines.push(
      `Context churn: ${churn.compactionEvents ?? 0} compaction event${churn.compactionEvents === 1 ? "" : "s"} · ` +
      `${churn.repeatedReadEvents ?? 0} repeat explicit read${churn.repeatedReadEvents === 1 ? "" : "s"} · ` +
      `${churn.currentSessionScope ?? "unknown"} session`
    );
  } else {
    lines.push(
      `Context churn: current transcript ${churn.currentSessionEvidence === "not_matched" ? "not matched" : "unavailable"}`
    );
  }
  if (health.evidence.length > 0) {
    lines.push("", "Evidence");
    for (const evidence of health.evidence) {
      lines.push(`  - ${evidence.summary} [${evidence.confidence}; ${evidence.source}]`);
    }
  }
  lines.push(
    "",
    "Data: local agent configuration + local Claude Code/Codex transcripts; hook commands were not run.",
    "Privacy: this CLI run uploads nothing."
  );
  return lines.join("\n");
}

function quickstartNextSteps(
  mode: "demo" | "connected" | "local-logs",
  detected: DetectedCredential[]
): string[] {
  // Connect/verify guidance now lives in the readout's APPLY/VERIFY sections;
  // this footer only carries what those can't know (detected local keys) and
  // the report/waitlist pointers.
  const steps: string[] = [];
  if (detected.length > 0) {
    const names = detected.map((credential) => `${credential.provider} (${credential.hint})`).join(", ");
    steps.push(`Found local key${detected.length === 1 ? "" : "s"}: ${names}`);
    steps.push(`npx aibill connect ${detected[0]!.provider}   add official provider-reported cost (ADMIN/owner key)`);
  }
  steps.push(
    mode === "demo"
      ? "npx aibill report --sample     write a clearly labeled demo Markdown + HTML report"
      : "npx aibill report              write a shareable Markdown + HTML report"
  );
  steps.push("npx aibill --group-by project  see which project has the most observed activity");
  steps.push("Need team reconciliation, allocation, budgets, and approvals? Workspace design partners: https://ai-spend-agent.vercel.app");
  return steps;
}

type PersistedSpend = {
  mode?: PersistedDataMode;
  records: UsageRecord[];
  checkedAt?: string;
  providerCoverage?: ProviderCoverageStatus;
  accounting?: Record<string, unknown>;
  connectedTrust?: Awaited<ReturnType<typeof verifyConnectedSpendTrustReceipt>>;
};

async function readPersistedSpend(
  rootPath: string,
  options: { strict?: boolean } = {}
): Promise<PersistedSpend | undefined> {
  const stateDir = join(rootPath, ".ai-spend-agent");
  try {
    const exactSpendContents = await readSafeStateText(stateDir, "spend.json");
    const spend = JSON.parse(exactSpendContents) as unknown;
    if (!isPlainObject(spend) || !Array.isArray(spend.records)) {
      throw new Error("persisted spend state must contain a records array");
    }
    const parsedRecords = spend.records.map((record) => parseUsageRecord(record));
    const storedMode = isPersistedDataMode(spend.mode) ? spend.mode : undefined;
    // The bundled fixture fingerprint is authoritative over a conflicting mode
    // tag. A copied/tampered sample must never become connected billing merely
    // because `mode` was changed in JSON.
    const mode = isBundledSampleUsage(parsedRecords) ? "sample" : storedMode;
    const records = mode === "sample" || mode === undefined
      ? downgradeSampleUsageEvidence(parsedRecords)
      : parsedRecords;
    if (spend.checkedAt !== undefined && !validIsoString(spend.checkedAt)) {
      throw new Error("persisted spend checkedAt must be an ISO timestamp");
    }
    const providerCoverage = persistedProviderCoverage(spend.accounting);
    const connectedTrust = mode === "connected_provider"
      ? await verifyConnectedSpendTrustReceipt(rootPath, exactSpendContents)
      : undefined;
    return {
      mode,
      records,
      ...(typeof spend.checkedAt === "string" ? { checkedAt: spend.checkedAt } : {}),
      ...(providerCoverage ? { providerCoverage } : {}),
      ...(isPlainObject(spend.accounting) ? { accounting: spend.accounting } : {}),
      ...(connectedTrust ? { connectedTrust } : {})
    };
  } catch (error) {
    if (options.strict && !isNodeError(error, "ENOENT")) {
      throw new Error(
        "Existing .ai-spend-agent/spend.json is invalid or unsafe; it was preserved and init stopped."
      );
    }
    return undefined;
  }
}

function persistedProviderCoverage(accounting: unknown): ProviderCoverageStatus | undefined {
  if (accounting === undefined) return undefined;
  if (!isPlainObject(accounting)) {
    throw new Error("persisted accounting state has an invalid shape");
  }
  if (accounting.coverageByProvider === undefined) return undefined;
  if (!isPlainObject(accounting.coverageByProvider)) {
    throw new Error("persisted provider coverage has an invalid shape");
  }
  const coverage = Object.values(accounting.coverageByProvider);
  if (coverage.some((value) => value !== "complete" && value !== "partial")) {
    throw new Error("persisted provider coverage contains an invalid status");
  }
  if (coverage.length === 0) return undefined;
  return coverage.includes("partial") ? "partial" : "complete";
}

function trustedAccountingMap<T>(
  accounting: Record<string, unknown> | undefined,
  field: string
): Record<string, T> {
  const value = accounting?.[field];
  return isPlainObject(value) ? value as Record<string, T> : {};
}

async function loadInstantReadData(args: ParsedArgs): Promise<InstantReadData> {
  const warnings: string[] = [];
  if (args.sample) {
    return { records: await loadSampleUsageData(), mode: "demo", warnings };
  }

  const persisted = args.ignoreState ? undefined : await readPersistedSpend(resolve(args.path));

  // Only real connected/synced provider state is authoritative enough to serve
  // directly. Sample or legacy persisted state must NEVER mask real local logs.
  // Defense in depth: "connected" is only believed if the records actually
  // came from a provider — local-log records mislabeled connected (a past bug)
  // must never be served as billing data.
  const looksConnected = (persisted?.records ?? []).some(
    (record) => record.providerCostType !== "local_agent_logs"
  );
  if (
    persisted &&
    persisted.records.length > 0 &&
    persisted.mode === "connected_provider" &&
    looksConnected &&
    persisted.connectedTrust?.trusted === true
  ) {
    return {
      records: persisted.records,
      mode: "connected",
      warnings,
      ...(persisted.providerCoverage ? { providerCoverage: persisted.providerCoverage } : {})
    };
  }

  if (persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === false) {
    warnings.push(
      `${persisted.connectedTrust.message} CLI: run \`npx aibill connect <provider>\` or repeat the prior \`npx aibill sync-provider ...\` command. The repository-provided connected totals were ignored.`
    );
  }

  // Real local agent logs (Claude Code / Codex) beat any sample/legacy state.
  const logs = await loadLocalAgentUsage({
    // Env overrides keep tests (and unusual installs) isolated from $HOME.
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    sinceIso: sinceIsoForDays(args.sinceDays ?? 30),
    collectCodexInvocationEvidence: true
  }).catch(() => undefined);
  if (logs && logs.records.length > 0) {
    // Persisted local_logs state (written by report/apply-artifact) is the
    // same data source we just re-read — superseding it silently is correct,
    // not worth a scary "sample/legacy" warning.
    if (persisted && persisted.records.length > 0 && persisted.mode !== "connected_provider" && persisted.mode !== "local_logs") {
      warnings.push("Ignored persisted sample/legacy state in .ai-spend-agent/spend.json — showing your real local agent logs. Run `npx aibill reset` to clear it, or pass --ignore-state.");
    }
    return {
      records: logs.records,
      mode: "local-logs",
      warnings,
      codexInvocationFiles: logs.codexInvocationFiles
    };
  }

  // No real logs. Persisted sample/legacy state may still be shown, but only as
  // DEMO (never as connected), with a warning when its origin is unknown.
  if (persisted && persisted.records.length > 0 && persisted.mode !== "connected_provider" && persisted.mode !== "local_logs") {
    if (persisted.mode === undefined) {
      warnings.push("Persisted state in .ai-spend-agent/spend.json is from an older format with no data-mode tag — treating it as demo. Run `npx aibill reset`, then re-scan to refresh.");
    }
    return { records: persisted.records, mode: "demo", warnings };
  }

  if (persisted?.mode === "local_logs") {
    warnings.push(
      "Ignored persisted local-log cache because no current Claude Code/Codex source records were found. Re-run the local agent activity first; repository state alone cannot authorize an Apply action."
    );
  }

  // loadSampleUsageData resolves the bundled CSVs relative to the installed
  // package, so this works from ANY directory (true zero-config).
  return { records: await loadSampleUsageData(), mode: "demo", warnings };
}

/** A one-line, unmissable banner telling the user which data they're seeing. */
function dataModeBanner(mode: InstantReadMode): string {
  if (mode === "local-logs") return "DATA MODE: your local agent logs (estimated at API-equivalent rates)";
  if (mode === "connected") return "DATA MODE: connected provider billing";
  return "DATA MODE: demo sample (illustrative — not your real spend)";
}

async function doctorCommand(args: ParsedArgs): Promise<CliResult> {
  if (args.sources) {
    return doctorSourcesCommand(args);
  }

  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");

  const persisted = await readPersistedSpend(rootPath);
  const connectedStateTrusted = persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true;
  const stateMode = persisted
    ? persisted.mode === "connected_provider" && !connectedStateTrusted
      ? "connected_provider (UNTRUSTED — ignored)"
      : (persisted.mode ?? "unknown legacy")
    : "no state";

  const logs = await loadLocalAgentUsage({
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR
  }).catch(() => undefined);
  const detected = logs?.agentsDetected ?? [];
  const claudeFound = detected.includes("claude-code");
  const codexFound = detected.includes("codex");
  const hasLogs = claudeFound || codexFound;

  const detection = await detectLocalCredentials({
    cwd: rootPath,
    home: process.env.AI_SPEND_CLAUDE_HOME_DIR
  }).catch(() => ({ credentials: [] as DetectedCredential[] }));
  const providerRefs = detection.credentials.map((credential) => `${credential.provider} (${credential.hint})`);

  const plans = await detectLocalPlans({
    claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
    codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
  }).catch(() => [] as DetectedPlan[]);
  const planLine = plans.length > 0
    ? plans.map((plan) => `${plan.planLabel} (${plan.agent}, ${plan.billing === "api_key" ? "pay per token" : plan.billing})`).join(", ")
    : "none detected (use --plan to declare one)";

  const warnings: string[] = [];
  if (stateMode === "sample") warnings.push("sample state present — it will be shown as DEMO and cannot mask real logs; run `npx aibill reset` to clear it");
  if (stateMode === "unknown legacy") warnings.push("legacy state with no data-mode tag — run `npx aibill reset`, then re-scan");
  if (persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === false) {
    warnings.push(`${persisted.connectedTrust.message} Run \`npx aibill connect <provider>\` or repeat the prior \`npx aibill sync-provider ...\` command.`);
  }
  if (!hasLogs) warnings.push("no real Claude Code / Codex logs found — a first run here will show DEMO sample data");
  if (providerRefs.length === 0) warnings.push("no provider admin keys detected — connect OpenAI/Anthropic to add official provider-reported cost (local logs stay API-equivalent estimates)");

  const predictedMode = connectedStateTrusted
    ? "connected provider billing"
    : hasLogs
      ? "your local agent logs (estimated at API-equivalent rates)"
      : "demo sample (illustrative)";

  const lines = [
    "aibill doctor",
    `node version: ${process.version}`,
    `cli version: ${await cliVersion()}`,
    "local-first mode: enabled (no cloud upload, no telemetry)",
    `path: ${rootPath}`,
    `state directory: ${stateDir}`,
    `state mode: ${stateMode}`,
    `Claude Code logs: ${claudeFound ? "found" : "not found"}`,
    `Codex logs: ${codexFound ? "found" : "not found"}`,
    `provider env references: ${providerRefs.length > 0 ? providerRefs.join(", ") : "none detected"}`,
    `subscription plans: ${planLine}`,
    "redaction policy: secrets are never printed or persisted",
    "plan check: available (subscription vs API-rate math)",
    `data mode you'll get now: ${predictedMode}`,
    warnings.length > 0 ? `launch warnings:\n${warnings.map((warning) => `  - ${warning}`).join("\n")}` : "launch warnings: none"
  ];
  return ok(lines.join("\n"));
}

type PersistedProviderStatusState = {
  provider?: string;
  fetchedAt?: string;
  records?: UsageRecord[];
  qa?: ProviderQaSummary;
  qaByProvider?: Record<string, ProviderQaSummary>;
};

type PersistedSourceAttemptState = {
  version: 1;
  providers: Partial<Record<"openai" | "anthropic" | "cursor" | "github-copilot", {
    checkedAt: string;
    lastError: string | null;
  }>>;
};

const providerStatusIds = ["openai", "anthropic", "cursor", "github-copilot"] as const;
type ProviderStatusId = typeof providerStatusIds[number];

/**
 * Show connector validation maturity and this machine's financial evidence as
 * separate axes. This command reads local state only; it never contacts a
 * provider or treats a connector capability claim as current financial data.
 */
async function doctorSourcesCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  const now = new Date();
  const observations: SourceStatusObservation[] = [];

  let localLogs: Awaited<ReturnType<typeof loadLocalAgentUsage>> | undefined;
  let localError: string | undefined;
  try {
    localLogs = await loadLocalAgentUsage({
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR
    });
  } catch (error) {
    localError = sanitizeSecretishError(error instanceof Error ? error.message : String(error));
  }

  const checkedAt = now.toISOString();
  for (const { id } of localAgentFormatDescriptors) {
    const records = (localLogs?.records ?? []).filter((record) => record.agentId === id);
    const evidence = financialEvidenceForRecords(records);
    const scan = localLogs?.sourceScans.find((entry) => entry.agent === id);
    const diagnostics = (localLogs?.diagnostics ?? []).filter((entry) => entry.agent === id);
    const diagnosticError = localAgentDiagnosticSummary(diagnostics);
    const validationFailed = Boolean(localError) || localDiagnosticsRequireFailure(records, scan, diagnostics);
    const lastError = localError ?? diagnosticError;
    observations.push({
      id,
      financialEvidence: evidence,
      financialEvidenceNote: localFinancialEvidenceNote(records, evidence, scan),
      checkedAt,
      latestEvidenceAt: latestRecordTimestamp(records),
      ...(lastError ? { lastError } : {}),
      ...(validationFailed ? { validationCoverage: "failed" as const } : {})
    });
  }

  let providerState: PersistedProviderStatusState = {};
  let providerStateError: string | undefined;
  const persistedSpend = await readPersistedSpend(rootPath);
  if (persistedSpend?.mode === "connected_provider" && persistedSpend.connectedTrust?.trusted === true) {
    providerState = {
      records: persistedSpend.records,
      qaByProvider: trustedAccountingMap<ProviderQaSummary>(persistedSpend.accounting, "qaByProvider")
    };
  } else if (persistedSpend?.mode === "connected_provider" && persistedSpend.connectedTrust?.trusted === false) {
    providerStateError = `${persistedSpend.connectedTrust.message} Provider financial evidence was ignored.`;
  } else {
    try {
      await readSafeStateText(stateDir, "provider-records.json");
      providerStateError = "provider records have no matching trusted connected spend receipt; financial evidence was ignored";
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        providerStateError = "provider state could not be safely read; financial evidence was ignored";
      }
    }
  }
  const registry = await readSourceRegistry(stateDir, rootPath);
  let attemptState: PersistedSourceAttemptState = { version: 1, providers: {} };
  let attemptStateError: string | undefined;
  try {
    const parsed = parsePersistedSourceAttemptState(
      await readJson<unknown>(join(stateDir, "source-status.json"))
    );
    attemptState = parsed.state;
    attemptStateError = parsed.error;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      attemptStateError = "source attempt state could not be parsed; recorded freshness and errors were ignored";
    }
  }
  const providerRecords = Array.isArray(providerState.records) ? providerState.records : [];

  for (const id of providerStatusIds) {
    const records = providerRecords.filter((record) => record.source?.provider === id);
    const evidence = financialEvidenceForRecords(records);
    const qa = providerState.qaByProvider?.[id]
      ?? (providerState.provider === id ? providerState.qa : undefined);
    const attempt = attemptState.providers?.[id];
    const lastError = providerStateError
      ?? attemptStateError
      ?? sanitizePersistedStatusText(attempt?.lastError ?? undefined)
      ?? providerQaLastError(qa);
    const registeredSource = (Array.isArray(registry.approvedSources) ? registry.approvedSources : [])
      .filter((source) => source && source.provider === id && typeof source.approvedAt === "string")
      .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))[0];
    const stateCheckedAt = attempt?.checkedAt
      ?? (providerState.provider === id ? providerState.fetchedAt : undefined);
    observations.push({
      id,
      financialEvidence: evidence,
      financialEvidenceNote: providerFinancialEvidenceNote(records, evidence),
      // A connector stub is only configuration, not a source check. Older
      // successful syncs predate source-status.json, so their non-missing
      // registry approval time is the conservative migration fallback.
      checkedAt: stateCheckedAt ?? (registeredSource?.financialEvidence !== "missing" ? registeredSource?.approvedAt : undefined),
      latestEvidenceAt: latestRecordTimestamp(records),
      ...(lastError ? { lastError, validationCoverage: "failed" as const } : {})
    });
  }

  const statuses = buildSourceStatuses(observations, now);
  return ok([
    "aibill doctor --sources",
    "local status only: no provider was contacted",
    "status axes (never interchangeable):",
    "  validation coverage: live_verified | fixture_verified | untested | failed",
    "  financial evidence: verified | estimated | detected_unverified | missing",
    "",
    formatSourceStatuses(statuses)
  ].join("\n"));
}

function localFinancialEvidenceNote(
  records: readonly UsageRecord[],
  evidence: ReturnType<typeof financialEvidenceForRecords>,
  scan?: LocalAgentSourceScan
): string {
  if (records.length === 0) {
    if (!scan) return "The local transcript scan did not complete.";
    if (scan.directoryStatus === "missing") {
      return "No local transcript directory was found for this agent; no usage evidence was available.";
    }
    if (scan.directoryStatus === "unreadable") {
      return "The local transcript path could not be read; absence of usage cannot be confirmed.";
    }
    if (scan.filesDiscovered === 0) {
      return "The local transcript directory was readable, but no JSONL files were found.";
    }
    if (scan.unreadableFiles > 0) {
      return `${scan.filesDiscovered} transcript file(s) were found, but ${scan.unreadableFiles} could not be read; absence of usage cannot be confirmed.`;
    }
    if (scan.malformedLines > 0) {
      return `${scan.filesDiscovered} transcript file(s) were found, but no valid usage rows were parsed; ${scan.malformedLines} malformed JSONL line(s) were skipped.`;
    }
    return `${scan.filesDiscovered} transcript file(s) were found, but no supported usage rows were observed.`;
  }
  if (evidence === "estimated") {
    const estimatedRows = records.filter((record) => (
      record.costConfidence === "estimated" && typeof record.amountUsd === "number"
    )).length;
    const missingRows = records.length - estimatedRows;
    if (missingRows > 0 || (scan?.unsupportedUsageSnapshots ?? 0) > 0) {
      const unsupportedCount = scan?.unsupportedUsageSnapshots ?? 0;
      const unsupported = unsupportedCount > 0
        ? `; ${unsupportedCount} token snapshot(s) lacked input/output components and were not priced`
        : "";
      const otherMissing = Math.max(0, missingRows - unsupportedCount);
      const unpricedModels = otherMissing > 0
        ? `; ${otherMissing} other row(s) lacked a supported model price`
        : "";
      return `${estimatedRows} of ${records.length} local aggregate row(s) were priced at published API rates${unsupported}${unpricedModels}; missing rows are excluded, and estimates are not billed subscription spend.`;
    }
    return `${records.length} local aggregate row(s) priced at published API rates; this is not billed subscription spend.`;
  }
  if (evidence === "missing") {
    if ((scan?.unsupportedUsageSnapshots ?? 0) > 0) {
      return `${records.length} local aggregate row(s) were observed, but ${scan!.unsupportedUsageSnapshots} token snapshot(s) lacked input/output components required for pricing.`;
    }
    return `${records.length} local aggregate row(s) were observed, but no supported price basis was available.`;
  }
  return `${records.length} local aggregate row(s) were observed with ${evidence} financial evidence.`;
}

function localAgentDiagnosticSummary(
  diagnostics: readonly LocalAgentLogDiagnostic[]
): string | undefined {
  const relevant = diagnostics.filter((diagnostic) => diagnostic.code !== "directory_missing");
  const unsupported = relevant.filter((diagnostic) => diagnostic.code === "unsupported_token_shape");
  const malformed = relevant.filter((diagnostic) => diagnostic.code === "malformed_jsonl");
  const messages = [...new Set(
    relevant
      .filter((diagnostic) => !["unsupported_token_shape", "malformed_jsonl"].includes(diagnostic.code))
      .map((diagnostic) => diagnostic.message)
  )];
  const unsupportedCount = unsupported
    .reduce((total, diagnostic) => total + diagnostic.count, 0);
  if (unsupportedCount > 0) {
    messages.push(`${unsupportedCount} ${localAgentFormatLabel(unsupported[0]!.agent)} token snapshot(s) lacked the input/output components required for pricing.`);
  }
  const malformedCount = malformed
    .reduce((total, diagnostic) => total + diagnostic.count, 0);
  if (malformedCount > 0) {
    messages.push(`${malformedCount} malformed JSONL line(s) were skipped in ${localAgentFormatLabel(malformed[0]!.agent)} transcripts.`);
  }
  return messages.length > 0 ? messages.join(" ") : undefined;
}

function localDiagnosticsRequireFailure(
  records: readonly UsageRecord[],
  scan: LocalAgentSourceScan | undefined,
  diagnostics: readonly LocalAgentLogDiagnostic[]
): boolean {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return true;
  // A partially malformed active JSONL can still yield supported evidence.
  // If nothing valid survived, however, an empty result is not trustworthy.
  return records.length === 0 && (scan?.malformedLines ?? 0) > 0;
}

function providerFinancialEvidenceNote(
  records: readonly UsageRecord[],
  evidence: ReturnType<typeof financialEvidenceForRecords>
): string {
  if (records.length === 0) return "No provider financial evidence is present in local aibill state.";
  const verifiedRows = records.filter((record) => (
    record.costConfidence === "verified" && typeof record.amountUsd === "number"
  )).length;
  const estimatedRows = records.filter((record) => (
    record.costConfidence === "estimated" && typeof record.amountUsd === "number"
  )).length;
  const detectedRows = records.filter((record) => (
    record.costConfidence === "detected_unverified" && typeof record.amountUsd === "number"
  )).length;
  const missingRows = records.length - verifiedRows - estimatedRows - detectedRows;

  // Keep the concise homogeneous messages, but never let a single verified
  // row promote every mixed provider row to official billed cost.
  if (evidence === "verified" && verifiedRows === records.length) {
    return `${records.length} provider row(s) include official provider-reported cost.`;
  }
  if (evidence === "estimated" && estimatedRows === records.length) {
    return `${records.length} provider row(s) include estimated cost; reconcile before treating it as billed spend.`;
  }
  if (evidence === "detected_unverified" && detectedRows === records.length) {
    return `${records.length} provider row(s) were detected with partial or unreconciled financial coverage.`;
  }
  if (evidence === "missing" && missingRows === records.length) {
    return `${records.length} provider row(s) were observed without a supported cost basis.`;
  }

  const parts: string[] = [];
  if (verifiedRows > 0) {
    parts.push(`${verifiedRows} of ${records.length} provider row(s) include official provider-reported cost`);
  }
  if (estimatedRows > 0) {
    parts.push(`${estimatedRows} provider row(s) include estimated cost`);
  }
  if (detectedRows > 0) {
    parts.push(`${detectedRows} provider row(s) have partial or unreconciled financial coverage`);
  }
  if (missingRows > 0) {
    parts.push(`${missingRows} provider row(s) have no supported cost basis`);
  }
  return `${parts.join("; ")}. Row-level financial evidence remains separate.`;
}

function latestRecordTimestamp(records: readonly UsageRecord[]): string | undefined {
  return records
    .map((record) => record.timestamp)
    .filter((timestamp) => Number.isFinite(Date.parse(timestamp)))
    .sort((left, right) => right.localeCompare(left))[0];
}

function providerQaLastError(qa: ProviderQaSummary | undefined): string | undefined {
  const incompletePage = qa?.pagination.find((entry) => entry.stoppedBecause !== "complete");
  if (incompletePage) {
    const fallback = incompletePage.stoppedBecause === "fetch_error"
      ? "provider fetch failed"
      : incompletePage.stoppedBecause === "max_pages"
        ? "pagination stopped at the connector page safety cap"
        : incompletePage.stoppedBecause === "max_range_days"
          ? "requested range exceeded the connector coverage cap"
          : incompletePage.stoppedBecause === "unsafe_next_link"
            ? "an unsafe pagination link was rejected"
            : "pagination ended before the provider marked it complete";
    return sanitizePersistedStatusText(incompletePage.note
      ? `${incompletePage.label}: ${incompletePage.note}`
      : `${incompletePage.label}: ${fallback}`);
  }
  const drift = qa?.responseDrift[0];
  if (drift) {
    return sanitizePersistedStatusText(`${drift.label}: ${drift.field} ${drift.issue}`);
  }
  if (qa?.coverage === "partial") {
    return sanitizePersistedStatusText(`${qa.provider}: provider returned partial coverage`);
  }
  return undefined;
}

function parsePersistedProviderStatusState(value: unknown): {
  state: PersistedProviderStatusState;
  error?: string;
} {
  if (!isPlainObject(value)) {
    return { state: {}, error: "provider state has an invalid shape; financial evidence was ignored" };
  }
  if (value.provider !== undefined && typeof value.provider !== "string") {
    return { state: {}, error: "provider state has an invalid provider id; financial evidence was ignored" };
  }
  if (value.fetchedAt !== undefined && !validIsoString(value.fetchedAt)) {
    return { state: {}, error: "provider state has an invalid freshness timestamp; financial evidence was ignored" };
  }
  if (value.records !== undefined && !Array.isArray(value.records)) {
    return { state: {}, error: "provider state has invalid financial records; financial evidence was ignored" };
  }

  let records: UsageRecord[] = [];
  try {
    records = (value.records ?? []).map((record) => parseUsageRecord(record));
  } catch {
    return { state: {}, error: "provider state has invalid financial records; financial evidence was ignored" };
  }

  const qa = value.qa === undefined ? undefined : parsePersistedProviderQa(value.qa);
  if (value.qa !== undefined && !qa) {
    return { state: {}, error: "provider state has invalid QA metadata; financial evidence was ignored" };
  }

  const qaByProvider: Record<string, ProviderQaSummary> = {};
  if (value.qaByProvider !== undefined) {
    if (!isPlainObject(value.qaByProvider)) {
      return { state: {}, error: "provider state has invalid QA metadata; financial evidence was ignored" };
    }
    for (const [provider, rawQa] of Object.entries(value.qaByProvider)) {
      // Unknown providers are forward-compatible but irrelevant to this
      // four-provider doctor view. Known providers must pass the full shape.
      if (!isProviderStatusId(provider)) continue;
      const parsedQa = parsePersistedProviderQa(rawQa);
      if (!parsedQa) {
        return { state: {}, error: "provider state has invalid QA metadata; financial evidence was ignored" };
      }
      qaByProvider[provider] = parsedQa;
    }
  }

  return {
    state: {
      ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
      ...(typeof value.fetchedAt === "string" ? { fetchedAt: value.fetchedAt } : {}),
      records,
      ...(qa ? { qa } : {}),
      ...(Object.keys(qaByProvider).length > 0 ? { qaByProvider } : {})
    }
  };
}

function parsePersistedSourceAttemptState(value: unknown): {
  state: PersistedSourceAttemptState;
  error?: string;
} {
  const empty: PersistedSourceAttemptState = { version: 1, providers: {} };
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.providers)) {
    return { state: empty, error: "source attempt state has an invalid shape; recorded freshness and errors were ignored" };
  }

  const providers: PersistedSourceAttemptState["providers"] = {};
  for (const [provider, rawAttempt] of Object.entries(value.providers)) {
    if (!isProviderStatusId(provider) || !isPlainObject(rawAttempt) || !validIsoString(rawAttempt.checkedAt)) {
      return { state: empty, error: "source attempt state has an invalid provider or timestamp; recorded freshness and errors were ignored" };
    }
    if (rawAttempt.lastError !== null && typeof rawAttempt.lastError !== "string") {
      return { state: empty, error: "source attempt state has an invalid error field; recorded freshness and errors were ignored" };
    }
    providers[provider] = {
      checkedAt: rawAttempt.checkedAt,
      lastError: rawAttempt.lastError === null
        ? null
        : (sanitizePersistedStatusText(rawAttempt.lastError) ?? "invalid empty provider error")
    };
  }
  return { state: { version: 1, providers } };
}

function parsePersistedProviderQa(value: unknown): ProviderQaSummary | undefined {
  if (!isPlainObject(value) || typeof value.provider !== "string") return undefined;
  if (value.coverage !== undefined && value.coverage !== "complete" && value.coverage !== "partial") return undefined;
  if (!isStringArray(value.requestedEndpoints) || !Array.isArray(value.pagination) ||
      !Array.isArray(value.rateLimits) || !Array.isArray(value.responseDrift) ||
      !isStringArray(value.instructions)) {
    return undefined;
  }

  const pagination: ProviderQaSummary["pagination"] = [];
  for (const entry of value.pagination) {
    if (!isPlainObject(entry) || typeof entry.label !== "string" ||
        !isFiniteNumber(entry.pagesFetched) || !isFiniteNumber(entry.maxPages) ||
        !isProviderPaginationStop(entry.stoppedBecause) ||
        (entry.limitPerPage !== undefined && !isFiniteNumber(entry.limitPerPage)) ||
        (entry.note !== undefined && typeof entry.note !== "string")) {
      return undefined;
    }
    pagination.push({
      label: entry.label,
      pagesFetched: entry.pagesFetched,
      stoppedBecause: entry.stoppedBecause,
      maxPages: entry.maxPages,
      ...(typeof entry.limitPerPage === "number" ? { limitPerPage: entry.limitPerPage } : {}),
      ...(typeof entry.note === "string" ? { note: sanitizePersistedStatusText(entry.note) ?? "empty provider error" } : {})
    });
  }

  const rateLimits: ProviderQaSummary["rateLimits"] = [];
  for (const entry of value.rateLimits) {
    if (!isPlainObject(entry) || typeof entry.label !== "string" ||
        (entry.remainingRequests !== undefined && !isFiniteNumber(entry.remainingRequests)) ||
        (entry.retryAfterSeconds !== undefined && !isFiniteNumber(entry.retryAfterSeconds))) {
      return undefined;
    }
    rateLimits.push({
      label: entry.label,
      ...(typeof entry.remainingRequests === "number" ? { remainingRequests: entry.remainingRequests } : {}),
      ...(typeof entry.retryAfterSeconds === "number" ? { retryAfterSeconds: entry.retryAfterSeconds } : {})
    });
  }

  const responseDrift: ProviderQaSummary["responseDrift"] = [];
  for (const entry of value.responseDrift) {
    if (!isPlainObject(entry) || typeof entry.label !== "string" ||
        typeof entry.field !== "string" || typeof entry.issue !== "string") {
      return undefined;
    }
    responseDrift.push({
      label: entry.label,
      field: entry.field,
      issue: entry.issue
    });
  }

  return {
    provider: value.provider,
    ...(value.coverage === "complete" || value.coverage === "partial" ? { coverage: value.coverage } : {}),
    requestedEndpoints: value.requestedEndpoints,
    pagination,
    rateLimits,
    responseDrift,
    instructions: value.instructions
  };
}

function sanitizePersistedStatusText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeSecretishError(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return sanitized || undefined;
}

function isProviderStatusId(value: string): value is ProviderStatusId {
  return (providerStatusIds as readonly string[]).includes(value);
}

function isProviderPaginationStop(value: unknown): value is ProviderQaSummary["pagination"][number]["stoppedBecause"] {
  return value === "complete" || value === "missing_cursor" || value === "max_pages" ||
    value === "max_range_days" || value === "fetch_error" || value === "unsafe_next_link";
}

function validIsoString(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cliVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return process.env.npm_package_version ?? "unknown";
  }
}

async function resetCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = await resolveSafeScanRoot(args.path);
  // The trust receipt is deliberately outside the repository. Reset must
  // clear it too so restoring an old spend.json cannot replay prior trust.
  await invalidateConnectedSpendTrustReceipt(rootPath);
  let stateDir: string;
  try {
    stateDir = await resolveSafeStateDirectory(rootPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return ok([
      "aibill reset",
      `path: ${rootPath}`,
      "nothing to clear (no persisted spend state found)",
      "next run will re-read your real local agent logs (or demo sample if none)."
    ].join("\n"));
  }
  // Clear derived spend state so a prior `scan --sample` (or stale provider
  // sync) can never mask the next real local-log read. Leaves sources/audit.
  const targets = ["spend.json", "mappings.json", "provider-records.json", "source-status.json", "watch-latest.json", "watch-history.json"];
  const removed: string[] = [];
  for (const file of targets) {
    try {
      await rm(join(stateDir, file));
      removed.push(file);
    } catch {
      // File not present — nothing to clear for this target.
    }
  }
  return ok([
    "aibill reset",
    `path: ${rootPath}`,
    removed.length > 0 ? `cleared: ${removed.join(", ")}` : "nothing to clear (no persisted spend state found)",
    "next run will re-read your real local agent logs (or demo sample if none)."
  ].join("\n"));
}

async function statuslineCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  const action = args.statuslineAction;
  if (action === undefined) {
    const cache = await readStatuslineCache({
      cacheDirectory: process.env.AIBILL_CACHE_DIR,
      homeDirectory: runtime.homeDirectory
    });
    return ok(renderStatusline(cache, {
      now: runtime.statuslineNow,
      columns: runtime.statuslineColumns,
      timeZone: runtime.statuslineTimeZone
    }));
  }
  if (action === "install") return installStatuslineCommand(args, runtime);
  if (action === "uninstall") return uninstallStatuslineCommand(runtime);
  if (action === "refresh") return refreshStatuslineCommand(args, runtime);
  return {
    exitCode: 1,
    stdout: "",
    stderr: `Unknown statusline action: ${sanitizeSecretishError(action)}\n` +
      "Use: aibill statusline [refresh|install|uninstall]"
  };
}

async function packagedStatuslineRunner(
  runtime: CliRuntimeOptions
): Promise<string | Uint8Array> {
  if (runtime.statuslineRunnerContents !== undefined) {
    return runtime.statuslineRunnerContents;
  }
  return readFile(fileURLToPath(new URL("./statuslineRuntime.js", import.meta.url)));
}

async function installStatuslineCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  try {
    const result = await installClaudeStatusline({
      homeDir: runtime.homeDirectory ?? homedir(),
      cwd: resolve(args.path),
      runnerContents: await packagedStatuslineRunner(runtime),
      replace: args.replaceStatusline
    });
    return ok([
      result.action === "unchanged"
        ? "aibill statusline is already installed in Claude user settings."
        : "aibill statusline installed in Claude user settings.",
      "Claude Code: run /status to verify the active setting and every managed source.",
      "The renderer reads only the private aibill cache; it never reads Claude's session stdin as financial evidence."
    ].join("\n"));
  } catch (error) {
    return statuslineInstallerFailure("install", error);
  }
}

async function uninstallStatuslineCommand(runtime: CliRuntimeOptions): Promise<CliResult> {
  try {
    const result = await uninstallClaudeStatusline({
      homeDir: runtime.homeDirectory ?? homedir(),
      cwd: process.cwd()
    });
    return ok([
      result.statusLineAction === "restored-prior"
        ? "aibill statusline was removed and the prior Claude user statusLine was restored."
        : "aibill statusline was removed from Claude user settings.",
      {
        removed: "The owned standalone runner was removed.",
        restored: "The exact pre-installation runner was restored.",
        "preserved-modified": "The modified runner was preserved because it was no longer owned.",
        "already-missing": "The owned runner was already missing; no runner file was removed."
      }[result.runnerAction],
      ...result.warnings
    ].join("\n"));
  } catch (error) {
    return statuslineInstallerFailure("uninstall", error);
  }
}

function statuslineInstallerFailure(
  action: "install" | "uninstall",
  error: unknown
): CliResult {
  const installerError = error instanceof StatuslineInstallerError
    ? error
    : new StatuslineInstallerError(
        "unsafe-settings-file",
        `The local filesystem operation failed safely${safeFileSystemErrorCode(error)}; no successful settings change was claimed.`
      );
  const replacement = installerError.code === "statusline-conflict"
    ? "\nTo replace an existing status line explicitly: aibill statusline install --replace"
    : "";
  return {
    exitCode: 1,
    stdout: "",
    stderr: [
      `aibill statusline ${action} stopped safely: ${sanitizeSecretishError(installerError.message)}`,
      "No successful settings change was claimed. Resolve the conflict, then verify active sources with /status in Claude Code.",
      replacement.trim()
    ].filter(Boolean).join("\n")
  };
}

function safeFileSystemErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const code = String((error as { code?: unknown }).code ?? "");
  return /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? ` (${code})` : "";
}

async function initCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions = {}
): Promise<CliResult> {
  if (args.sample) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "aibill init only initializes from real local evidence; --sample was not used and no state or cache was changed. Run `npx aibill --sample` for the illustrative demo."
    };
  }

  let detectedPlanOverride: DetectedPlan[] | undefined;
  if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${args.plan}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
      };
    }
    detectedPlanOverride = [override];
  }

  const rootPath = await resolveSafeScanRoot(args.path);
  const cacheDirectory = process.env.AIBILL_CACHE_DIR;
  await preflightInitCache(cacheDirectory);

  let stateDir: string;
  let stateDirectoryExists = true;
  try {
    stateDir = await resolveSafeStateDirectory(rootPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    stateDirectoryExists = false;
    stateDir = join(rootPath, ".ai-spend-agent");
  }
  const statePreparedAt = new Date();

  // Preflight every existing project file before any mutation. Valid files are
  // left byte-for-byte alone so a repeated init cannot erase connector
  // configuration, audit history, provider trust, spend state, or unknown
  // forward-compatible fields. The manifest remains the completion marker and
  // is written last.
  const existingManifest = stateDirectoryExists
    ? await readInitJsonObject(stateDir, "manifest.json", { allowMissing: true })
    : undefined;
  const existingRegistry = stateDirectoryExists
    ? await readInitJsonObject(stateDir, "sources.json", { allowMissing: true })
    : undefined;
  const existingAuditLog = stateDirectoryExists
    ? await readInitJsonObject(stateDir, "audit-log.json", { allowMissing: true })
    : undefined;
  if (existingRegistry) normalizeSourceRegistry(existingRegistry);
  validateInitAuditLog(existingAuditLog);

  const refresh = await collectAndPublishActivitySnapshot({
    rootPath,
    cacheDirectory,
    detectedPlanOverride
  });
  const {
    asOf,
    activitySnapshot,
    logs,
    detectedPlans,
    trustedProviderRecords,
    persisted,
    scanError,
    cacheStatus
  } = refresh;

  if (!stateDirectoryExists) {
    stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
  }
  await preserveOrCreateInitRegistry(stateDir, rootPath, statePreparedAt, existingRegistry);
  await preserveOrCreateInitAuditLog(stateDir, rootPath, statePreparedAt, existingAuditLog);
  const manifest = buildInitManifest(existingManifest, asOf);
  await writeSafeStateText(stateDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const receipt = formatInitReceipt({
    rootPath,
    asOf,
    activitySnapshot,
    logs,
    detectedPlans,
    trustedProviderRecords,
    providerCoverage: persisted?.providerCoverage,
    trustedProviderState: persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true,
    untrustedProviderState: persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted !== true,
    scanError,
    cacheStatus
  });
  if (!args.statusline) {
    return ok(`${receipt}\noptional Claude Code status line: npx aibill statusline install`);
  }
  const installation = await installStatuslineCommand(args, runtime);
  return installation.exitCode === 0
    ? ok(`${receipt}\n${installation.stdout}`)
    : {
        exitCode: installation.exitCode,
        stdout: receipt,
        stderr: installation.stderr
      };
}

type ActivityCacheRefreshResult = {
  asOf: Date;
  activitySnapshot?: ActivitySnapshot;
  logs?: Awaited<ReturnType<typeof loadLocalAgentFinancialUsage>>;
  detectedPlans: DetectedPlan[];
  trustedProviderRecords: UsageRecord[];
  persisted?: PersistedSpend;
  scanError?: string;
  cacheStatus: "refreshed" | "kept newer snapshot" | "refresh failed";
};

async function collectAndPublishActivitySnapshot(input: {
  rootPath: string;
  cacheDirectory?: string;
  detectedPlanOverride?: DetectedPlan[];
}): Promise<ActivityCacheRefreshResult> {
  // One attempt anchor binds every rolling window and cache ordering decision.
  const asOf = new Date();
  const planPromise = input.detectedPlanOverride
    ? Promise.resolve(input.detectedPlanOverride)
    : detectLocalPlans({
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
      }).catch(() => [] as DetectedPlan[]);
  // Attach the rejection handler immediately so a failed transcript scan can
  // never leave an unhandled persisted-state rejection behind.
  const persistedPromise = readPersistedSpend(input.rootPath, { strict: true }).then(
    (persisted) => ({ persisted }),
    (error: unknown) => ({ error })
  );

  let logs: Awaited<ReturnType<typeof loadLocalAgentFinancialUsage>> | undefined;
  let scanError: string | undefined;
  try {
    logs = await loadLocalAgentFinancialUsage({
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      sinceIso: sinceIsoForDays(30, asOf)
    });
  } catch (error) {
    scanError = sanitizeSecretishError(error instanceof Error ? error.message : String(error));
  }
  const [detectedPlans, persistedResult] = await Promise.all([planPromise, persistedPromise]);
  if ("error" in persistedResult) throw persistedResult.error;
  const persisted = persistedResult.persisted;
  const trustedProviderRecords = persisted?.mode === "connected_provider" &&
    persisted.connectedTrust?.trusted === true
    ? selectProviderFinancialHeadlineRecords(persisted.records)
    : [];

  let activitySnapshot: ActivitySnapshot | undefined;
  let cacheStatus: ActivityCacheRefreshResult["cacheStatus"];
  const structuredSourceFailure = logs !== undefined &&
    logs.sourceScans.some((scan) => scan.directoryStatus === "unreadable") &&
    !logs.sourceScans.some((scan) => scan.directoryStatus === "readable");
  if (logs && !structuredSourceFailure) {
    let refreshErrorCode: ActivitySnapshotRefreshErrorCode = "invalid_evidence";
    try {
      activitySnapshot = buildActivitySnapshot({
        asOf: asOf.toISOString(),
        generatedAt: new Date().toISOString(),
        records: [...logs.records, ...trustedProviderRecords],
        calls: logs.calls,
        detectedPlans,
        sourceScans: logs.sourceScans,
        trustedProviderRecordIds: trustedProviderRecords.map((record) => record.id),
        billedOverageRecordIds: [],
        providerCoverage: initProviderCoverage(
          trustedProviderRecords,
          persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true
            ? trustedAccountingMap<ProviderCoverageStatus>(persisted.accounting, "coverageByProvider")
            : {},
          persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true
            ? trustedAccountingMap<string>(persisted.accounting, "checkedAtByProvider")
            : {},
          persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true
            ? trustedAccountingMap<ProviderCoverageInterval>(persisted.accounting, "coverageIntervalsByProvider")
            : {},
          persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === true
            ? persisted.checkedAt ?? persisted.connectedTrust.trustedAt
            : undefined
        ),
        sampleData: false
      });
      refreshErrorCode = "cache_write_failed";
      const written = await writeActivitySnapshot(activitySnapshot, {
        cacheDirectory: input.cacheDirectory
      });
      cacheStatus = written.status === "written" ? "refreshed" : "kept newer snapshot";
    } catch {
      scanError = refreshErrorCode === "invalid_evidence"
        ? "the observed evidence could not produce a valid activity snapshot"
        : "the private activity cache could not be updated";
      const failed = await recordActivitySnapshotRefreshFailure(
        asOf.toISOString(),
        refreshErrorCode,
        { cacheDirectory: input.cacheDirectory }
      );
      activitySnapshot = failed.snapshot;
      cacheStatus = "refresh failed";
    }
  } else {
    const failed = await recordActivitySnapshotRefreshFailure(
      asOf.toISOString(),
      structuredSourceFailure ? "source_unreadable" : "scan_failed",
      { cacheDirectory: input.cacheDirectory }
    );
    activitySnapshot = failed.snapshot;
    cacheStatus = "refresh failed";
  }

  return {
    asOf,
    activitySnapshot,
    logs,
    detectedPlans,
    trustedProviderRecords,
    persisted,
    scanError,
    cacheStatus
  };
}

async function refreshStatuslineCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  if (args.sample) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "aibill statusline refresh only uses real local evidence; --sample was rejected and the cache was not changed."
    };
  }
  let detectedPlanOverride: DetectedPlan[] | undefined;
  if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${args.plan}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
      };
    }
    detectedPlanOverride = [override];
  }

  const rootPath = await resolveSafeScanRoot(args.path);
  const cacheDirectory = process.env.AIBILL_CACHE_DIR;
  await preflightInitCache(cacheDirectory);
  let refresh: ActivityCacheRefreshResult;
  try {
    refresh = await collectAndPublishActivitySnapshot({
      rootPath,
      cacheDirectory,
      detectedPlanOverride
    });
  } catch (error) {
    const attemptedAt = new Date().toISOString();
    await recordActivitySnapshotRefreshFailure(attemptedAt, "invalid_evidence", {
      cacheDirectory
    }).catch(() => undefined);
    const cache = await readStatuslineCache({
      cacheDirectory,
      homeDirectory: runtime.homeDirectory
    });
    return {
      exitCode: 1,
      stdout: renderStatusline(cache, {
        now: runtime.statuslineNow,
        columns: runtime.statuslineColumns,
        timeZone: runtime.statuslineTimeZone
      }),
      stderr: `aibill statusline refresh failed safely: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
  const cache = await readStatuslineCache({
    cacheDirectory,
    homeDirectory: runtime.homeDirectory
  });
  const line = renderStatusline(cache, {
    now: runtime.statuslineNow,
    columns: runtime.statuslineColumns,
    timeZone: runtime.statuslineTimeZone
  });
  return refresh.cacheStatus === "refresh failed"
    ? {
        exitCode: 1,
        stdout: line,
        stderr: `aibill statusline refresh failed safely: ${refresh.scanError ?? "local evidence was unavailable"}`
      }
    : ok(line);
}

async function preflightInitCache(cacheDirectory: string | undefined): Promise<void> {
  const existing = await readActivitySnapshot({ cacheDirectory });
  if (existing.status !== "error") return;
  throw new Error(
    `Existing private activity cache is ${existing.code.replaceAll("_", " ")}; ` +
    "it was preserved and init stopped. Remove the cache explicitly before rebuilding it."
  );
}

async function preserveOrCreateInitRegistry(
  stateDir: string,
  rootPath: string,
  asOf: Date,
  existing: Record<string, unknown> | undefined
): Promise<void> {
  if (existing) {
    // Leave the valid contract byte-for-byte alone. Rewriting would drop
    // unknown future fields and could invalidate a connected-state receipt
    // bound to the exact source-registry bytes.
    return;
  }
  await writeSafeStateText(
    stateDir,
    "sources.json",
    `${JSON.stringify(createLocalFolderSourceRegistry(rootPath, asOf), null, 2)}\n`
  );
}

async function preserveOrCreateInitAuditLog(
  stateDir: string,
  rootPath: string,
  asOf: Date,
  existing: Record<string, unknown> | undefined
): Promise<void> {
  if (existing) return;
  const timestamp = asOf.toISOString();
  await writeSafeStateText(
    stateDir,
    "audit-log.json",
    `${JSON.stringify(createScanAuditLog([{
      timestamp,
      action: "source_registered",
      sourceId: "local-root",
      path: rootPath,
      detail: "Explicit local folder source approved during init."
    }]), null, 2)}\n`
  );
}

function validateInitAuditLog(existing: Record<string, unknown> | undefined): void {
  if (existing && (existing.version !== 1 || existing.localOnly !== true || !Array.isArray(existing.events))) {
    throw new Error("Invalid local audit log: expected the canonical local-only audit shape.");
  }
}

async function readInitJsonObject(
  stateDir: string,
  fileName: string,
  options: { allowMissing: boolean }
): Promise<Record<string, unknown> | undefined> {
  let contents: string;
  try {
    contents = await readSafeStateText(stateDir, fileName);
  } catch (error) {
    if (options.allowMissing && isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Invalid local ${fileName}: expected JSON; the existing file was preserved.`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid local ${fileName}: expected a JSON object; the existing file was preserved.`);
  }
  return parsed;
}

function buildInitManifest(
  existing: Record<string, unknown> | undefined,
  asOf: Date
): Record<string, unknown> {
  const timestamp = asOf.toISOString();
  return {
    ...(existing ?? {}),
    product: "aibill",
    mode: "local-first",
    cloudUpload: false,
    cronJobsEnabled: false,
    redactionPolicy: "secrets are never printed; detected values are written only as [REDACTED]",
    sourceRegistry: "sources.json",
    auditLog: "audit-log.json",
    backfillWindowDays: 30,
    statusSnapshot: {
      schema: "aibill.activity_snapshot/v1",
      storage: "private external cache",
      networkUploaded: false
    },
    initializedAt: typeof existing?.initializedAt === "string" ? existing.initializedAt : timestamp,
    lastInitializedAt: timestamp,
    nextCommands: [
      "npx aibill",
      "npx aibill doctor --sources",
      "npx aibill report"
    ]
  };
}

type InitReceiptInput = {
  rootPath: string;
  asOf: Date;
  activitySnapshot?: ActivitySnapshot;
  logs?: Awaited<ReturnType<typeof loadLocalAgentFinancialUsage>>;
  detectedPlans: DetectedPlan[];
  trustedProviderRecords: UsageRecord[];
  providerCoverage?: ProviderCoverageStatus;
  trustedProviderState: boolean;
  untrustedProviderState: boolean;
  scanError?: string;
  cacheStatus: "refreshed" | "kept newer snapshot" | "refresh failed";
};

function initProviderCoverage(
  records: readonly UsageRecord[],
  coverageByProvider: Readonly<Record<string, ProviderCoverageStatus>>,
  checkedAtByProvider: Readonly<Record<string, string>>,
  coverageIntervalsByProvider: Readonly<Record<string, ProviderCoverageInterval>>,
  fallbackCheckedAt?: string
): ActivitySnapshotProviderCoverageInput[] {
  const providerGroups = new Map<ActivitySnapshotProvider, {
    rawProviders: Set<string>;
    records: UsageRecord[];
  }>();
  for (const record of records) {
    const rawProvider = record.source.provider;
    const provider = activitySnapshotProvider(rawProvider);
    const group = providerGroups.get(provider) ?? {
      rawProviders: new Set<string>(),
      records: []
    };
    group.rawProviders.add(rawProvider);
    group.records.push(record);
    providerGroups.set(provider, group);
  }
  for (const rawProvider of new Set([
    ...Object.keys(coverageByProvider),
    ...Object.keys(checkedAtByProvider),
    ...Object.keys(coverageIntervalsByProvider)
  ])) {
    const provider = activitySnapshotProvider(rawProvider);
    const group = providerGroups.get(provider) ?? {
      rawProviders: new Set<string>(),
      records: []
    };
    group.rawProviders.add(rawProvider);
    providerGroups.set(provider, group);
  }
  return [...providerGroups.entries()].map(([provider, group]) => {
    const coverages = [...group.rawProviders]
      .map((rawProvider) => coverageByProvider[rawProvider] ?? coverageByProvider[provider])
      .filter((coverage): coverage is ProviderCoverageStatus => coverage !== undefined);
    const status: ActivitySnapshotProviderCoverageInput["status"] =
      coverages.length === group.rawProviders.size && coverages.every((coverage) => coverage === "complete")
      ? "complete"
      : coverages.some((coverage) => coverage === "complete" || coverage === "partial")
        ? "partial"
        : "unavailable";
    const checkedValues = [...group.rawProviders]
      .map((rawProvider) => checkedAtByProvider[rawProvider] ?? checkedAtByProvider[provider])
      .filter((value): value is string => validIsoString(value));
    const receiptBoundCheckedAt = checkedValues.length === group.rawProviders.size
      ? checkedValues.sort()[0]
      : providerGroups.size === 1 && validIsoString(fallbackCheckedAt)
        ? fallbackCheckedAt
        : undefined;
    const latestEvidenceAt = group.records
      .map((record) => record.timestamp)
      .filter(validIsoString)
      .sort()
      .at(-1);
    const intervals = [...group.rawProviders]
      .map((rawProvider) => coverageIntervalsByProvider[rawProvider] ?? coverageIntervalsByProvider[provider])
      .filter(validProviderCoverageInterval);
    const coverageStart = intervals.length === group.rawProviders.size
      ? intervals.map((interval) => interval.coverageStart).sort().at(-1)
      : undefined;
    const coverageEnd = intervals.length === group.rawProviders.size
      ? intervals.map((interval) => interval.coverageEnd).sort()[0]
      : undefined;
    return {
      provider,
      status,
      validationCoverage: sourceStatusDefinitions.find((definition) => definition.id === provider)?.validationCoverage
        ?? "untested",
      ...(receiptBoundCheckedAt ? { checkedAt: receiptBoundCheckedAt } : {}),
      ...(receiptBoundCheckedAt && latestEvidenceAt ? { latestEvidenceAt } : {}),
      ...(receiptBoundCheckedAt && coverageStart && coverageEnd && Date.parse(coverageStart) <= Date.parse(coverageEnd)
        ? { coverageStart, coverageEnd }
        : {})
    };
  }).sort((left, right) => left.provider.localeCompare(right.provider));
}

function validProviderCoverageInterval(value: unknown): value is ProviderCoverageInterval {
  return isPlainObject(value) &&
    validIsoString(value.coverageStart) &&
    validIsoString(value.coverageEnd) &&
    Date.parse(value.coverageStart) <= Date.parse(value.coverageEnd);
}

function activitySnapshotProvider(provider: string): ActivitySnapshotProvider {
  if (provider === "openai" || provider === "anthropic" || provider === "cursor" || provider === "github-copilot") {
    return provider;
  }
  return "other";
}

function formatInitReceipt(input: InitReceiptInput): string {
  const records = input.logs?.records ?? [];
  const pricedRecords = records.filter((record) => typeof record.amountUsd === "number");
  const sourceFailures = (input.logs?.sourceScans ?? []).some((scan) => scan.directoryStatus === "unreadable") ||
    (input.logs?.diagnostics ?? []).some((diagnostic) => diagnostic.severity === "error");
  const receiptLines = input.scanError || sourceFailures && records.length === 0
    ? ["API-equivalent usage value: unavailable — the local scan could not prove an empty result"]
    : input.activitySnapshot
      ? initApiEquivalentWindowLines(input.activitySnapshot)
      : ["API-equivalent usage value: unavailable — no snapshot was produced"];

  const planLine = input.detectedPlans.length > 0
    ? input.detectedPlans.map((plan) => {
        const known = plan.planId ?? "unrecognized plan";
        return `${plan.agent}: ${known} (${plan.billing})`;
      }).join("; ")
    : "none detected (billing mode remains unresolved)";

  const sourceLines = (input.logs?.sourceScans ?? localAgentFormatDescriptors.map((descriptor) => (
    emptyInitSourceScan(descriptor.id)
  ))).map((scan) => {
    const agentRecords = records.filter((record) => record.agentId === scan.agent);
    const priced = agentRecords.filter((record) => typeof record.amountUsd === "number").length;
    const skipped = scan.filesSkippedBeforeWindow ?? 0;
    const validation = scan.jsonlValidationCoverage === "financial_events_only"
      ? "; financial-event JSONL validation only"
      : "";
    return `  ${scan.agent}: ${scan.directoryStatus}; ${scan.filesParsed}/${scan.filesDiscovered} files parsed; ${priced}/${agentRecords.length} rows priced${skipped > 0 ? `; ${skipped} old files skipped` : ""}${validation}`;
  });
  const diagnosticLines = (input.logs?.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code !== "directory_missing")
    .map((diagnostic) => `  ! ${sanitizeSecretishError(diagnostic.message)} (${diagnostic.count})`);

  const providerLines = formatInitProviderEvidence(input);

  return [
    "aibill init",
    `state project: ${sanitizeSecretishError(basename(input.rootPath))}`,
    "local usage scope: all Claude Code + Codex activity on this machine (last 30 days)",
    "provider scope: trusted connected billing from this state project only (shown separately)",
    "",
    "FIRST RECEIPT · API-equivalent usage value · last 30 days",
    ...receiptLines,
    `observed records: ${records.length}; priced: ${pricedRecords.length}; unpriced: ${records.length - pricedRecords.length}`,
    ...providerLines,
    `plans: ${planLine}`,
    "",
    "source diagnostics (same backfill scan; no second scan):",
    ...sourceLines,
    ...diagnosticLines,
    input.scanError ? `  ! scan failed: ${input.scanError}` : "",
    "",
    `status cache: ${input.cacheStatus} · private local aggregate · nothing uploaded`,
    "state: .ai-spend-agent",
    "manifest: written last",
    "next: npx aibill doctor --sources"
  ].filter((line) => line !== "").join("\n");
}

function formatInitProviderEvidence(input: InitReceiptInput): string[] {
  const windowStart = input.asOf.getTime() - 30 * 24 * 60 * 60 * 1_000;
  const inWindow = input.trustedProviderRecords.filter((record) => {
    const timestamp = Date.parse(record.timestamp);
    return Number.isFinite(timestamp) && timestamp >= windowStart && timestamp <= input.asOf.getTime();
  });
  const priced = inWindow.filter((record) => typeof record.amountUsd === "number");
  const verified = priced.filter((record) => record.costConfidence === "verified");
  const estimatedApiEquivalent = priced.filter((record) =>
    record.costConfidence === "estimated" &&
    record.providerCostType === "anthropic_claude_code_usage"
  );
  const estimated = priced.filter((record) =>
    record.costConfidence === "estimated" &&
    record.providerCostType !== "anthropic_claude_code_usage"
  );
  const detected = priced.filter((record) => record.costConfidence === "detected_unverified");
  const unpriced = inWindow.length - priced.length;
  const lines: string[] = [];
  if (verified.length > 0) {
    const billedWindow = input.activitySnapshot?.metered?.providerBilled.thirtyDays;
    lines.push(billedWindow?.amountUsd !== null && billedWindow?.amountUsd !== undefined
      ? `provider-billed cost: ${formatOptionalUsd(billedWindow.amountUsd)} verified (kept separate)`
      : "provider-billed cost: unavailable — billed bucket boundaries do not prove an exact 30-day amount");
  }
  if (estimated.length > 0) {
    lines.push(`provider financial estimate: ${formatOptionalUsd(analyzeSpend(estimated).totalUsd)} estimated; not verified billed spend (kept separate)`);
  }
  if (estimatedApiEquivalent.length > 0) {
    lines.push(`provider API-equivalent estimate: ${formatOptionalUsd(analyzeSpend(estimatedApiEquivalent).totalUsd)} estimated value; not verified billed spend (kept separate)`);
  }
  if (detected.length > 0) {
    lines.push(`provider cost: ${formatOptionalUsd(analyzeSpend(detected).totalUsd)} detected_unverified; not billed spend (kept separate)`);
  }
  if (unpriced > 0) {
    lines.push(`provider cost: unavailable — ${unpriced} trusted row(s) lacked a supported cost amount`);
  }
  const provedEmptyBilledWindow = input.activitySnapshot?.metered?.providerBilled.thirtyDays;
  if (verified.length === 0 && provedEmptyBilledWindow?.amountUsd === 0 &&
      provedEmptyBilledWindow.financialEvidence === "verified") {
    lines.push("provider-billed cost: $0.00 verified for the receipt-bound 30-day interval");
  }
  if (lines.length === 0) {
    lines.push(
      input.untrustedProviderState
        ? "provider-billed cost: unavailable — untrusted repository state was ignored"
        : input.trustedProviderRecords.length > 0
          ? "provider cost: unavailable — connected evidence had no supported row in the last 30 days"
          : input.trustedProviderState
            ? "provider-billed cost: unavailable — trusted connected provider evidence exists, but no receipt-bound 30-day amount was proven"
            : "provider-billed cost: not connected"
    );
  }
  if (input.providerCoverage) lines.push(`provider coverage: ${input.providerCoverage}`);
  return lines;
}

function initApiEquivalentWindowLines(snapshot: ActivitySnapshot): string[] {
  if (snapshot.mode === "error") {
    return ["API-equivalent usage value: unavailable — refresh failed"];
  }
  if (snapshot.mode === "empty") {
    const completeZero = snapshot.coverage.recordsParsed === 0 &&
      snapshot.coverage.agents.length > 0 &&
      snapshot.coverage.agents.every((agent) =>
        agent.directoryStatus === "readable" &&
        agent.malformedLines === 0 &&
        agent.unreadableFiles === 0 &&
        agent.unsupportedUsageSnapshots === 0 &&
        agent.jsonlValidationCoverage === "complete"
      );
    return [completeZero
      ? "API-equivalent value: ~$0.00 1d · ~$0.00 7d · ~$0.00 30d (estimated value; not billed spend)"
      : "API-equivalent usage value: unavailable — local source coverage is incomplete; no zero total was inferred"];
  }
  if (snapshot.mode === "unresolved" && snapshot.unresolved) {
    return [formatInitApiWindows("billing unresolved", snapshot.unresolved.apiEquivalent)];
  }

  const lines: string[] = [];
  for (const agent of snapshot.subscription?.agents ?? []) {
    lines.push(formatInitApiWindows(`${agent.agent} subscription value`, agent.apiEquivalent));
  }
  if (snapshot.metered && snapshot.metered.apiEquivalent.thirtyDays.recordCount > 0) {
    lines.push(formatInitApiWindows("metered API-equivalent value", snapshot.metered.apiEquivalent));
  }
  if (snapshot.unresolved && snapshot.unresolved.apiEquivalent.thirtyDays.recordCount > 0) {
    lines.push(formatInitApiWindows("billing unresolved", snapshot.unresolved.apiEquivalent));
  }
  return lines.length > 0
    ? lines
    : ["API-equivalent usage value: unavailable — no priced local value was observed"];
}

function formatInitApiWindows(
  label: string,
  windows: ActivitySnapshotApiEquivalentWindows
): string {
  const amount = (value: number | null) => value === null ? "unavailable" : `~${formatOptionalUsd(value)}`;
  return `${label}: ${amount(windows.oneDay.amountUsd)} 1d · ${amount(windows.sevenDays.amountUsd)} 7d · ${amount(windows.thirtyDays.amountUsd)} 30d (API-equivalent; not billed spend)`;
}

function emptyInitSourceScan(agent: LocalAgentSourceScan["agent"]): LocalAgentSourceScan {
  return {
    agent,
    directoryStatus: "unreadable",
    filesDiscovered: 0,
    filesParsed: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0
  };
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
    "aibill scan",
    `path: ${rootPath}`,
    "source registry: .ai-spend-agent/sources.json",
    "audit log: .ai-spend-agent/audit-log.json",
    `approved sources: ${registry.approvedSources.length}`,
    `discovery signals: ${discovery.signals.length}`,
    `secrets detected: ${discovery.secretsDetected.length}`
  ];

  if (discovery.unreadablePaths.length > 0) {
    lines.push(`unreadable paths skipped: ${discovery.unreadablePaths.length} (permissions/broken links — scan continued)`);
  }

  if (args.sample) {
    const records = await loadSampleUsageData();
    const summary = analyzeSpend(records);
    const mappings = attributeUsageRecords(records);
    await writeLocalSpendState(stateDir, records, summary, mappings, "sample");
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
    const { summary, snapshot, records, mode } = await runWatchCycle(stateDir, args);
    const deltaHeadline = buildDeltaHeadline(previous, snapshot);
    // Watch's job is DELTAS: render the compact breakdown view per cycle, not
    // the whole diagnose→verify readout again (the quickstart owns that).
    const plainEnglish = generatePlainEnglishSummary(summary, {
      records,
      groupBy: args.groupBy ?? "model",
      color: args.noColor ? false : undefined,
      mode: mode === "sample" ? "demo" : mode === "connected_provider" ? "connected" : "local-logs",
      view: "breakdown"
    });
    const stamped = [
      `=== watch cycle @ ${snapshot.capturedAt} ===`,
      deltaHeadline,
      plainEnglish
    ].join("\n");
    iteration += 1;
    const moreToGo = unbounded || iteration < cycles;
    const streaming = process.env.NODE_ENV !== "test";
    if (moreToGo && streaming) {
      // Stream interim cycles live, but do NOT also include them in the returned
      // output — doing both double-printed the baseline before the no-change
      // cycle. Streamed cycles are shown once here; the final cycle is returned.
      // eslint-disable-next-line no-console
      console.log(stamped);
      // eslint-disable-next-line no-console
      console.log(`\n[watch] sleeping ${intervalSeconds}s until next cycle. Press Ctrl+C to stop.\n`);
    } else {
      collected.push(stamped);
    }
    if (moreToGo) {
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

async function runWatchCycle(stateDir: string, args: ParsedArgs): Promise<{ summary: SpendSummary; snapshot: WatchSnapshot; records: UsageRecord[]; mode: PersistedDataMode }> {
  // The persisted mode must describe where the records ACTUALLY came from.
  // A previous version stamped everything "connected_provider", which made
  // later quickstarts serve stale local-log data as "connected billing" and
  // routed apply/report to the agency artifacts. Never label by assumption.
  let records: UsageRecord[];
  let mode: PersistedDataMode;
  if (args.sample) {
    records = await loadSampleUsageData();
    mode = "sample";
  } else {
    const persisted = await readPersistedSpend(dirname(stateDir));
    if (
      persisted?.mode === "connected_provider" &&
      persisted.connectedTrust?.trusted === true &&
      persisted.records.length > 0
    ) {
      // Watch may observe an already trusted provider snapshot, but it may not
      // mint trust from repository-authored provider-records.json or rewrite
      // connected state. Only an explicit provider sync can do that.
      records = persisted.records;
      mode = "connected_provider";
    } else {
      // Same freshness rule as quickstart/report: re-read local logs live,
      // never serve a stale snapshot.
      const logs = await loadLocalAgentUsage({
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR
      }).catch(() => undefined);
      if (logs && logs.records.length > 0) {
        records = logs.records;
        mode = "local_logs";
      } else {
        records = await loadSampleUsageData();
        mode = "sample";
      }
    }
  }

  const headlineRecords = mode === "connected_provider"
    ? selectProviderFinancialHeadlineRecords(records)
    : records;
  const summary = analyzeSpend(headlineRecords);
  const mappings = attributeUsageRecords(records);
  if (mode !== "connected_provider") {
    await writeLocalSpendState(stateDir, records, summary, mappings, mode);
  }

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

  return { summary, snapshot, records: headlineRecords, mode };
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
  const addedSource = nextRegistry.approvedSources.find((source) => source.id === id)!;
  await writeJson(join(stateDir, "sources.json"), nextRegistry);
  await appendAuditEvent(stateDir, {
    timestamp: nextRegistry.updatedAt,
    action: "source_registered",
    sourceId: id,
    path: sourcePath,
    detail: `${args.sourceType} approved via CLI add-source.`
  });

  return ok([
    "aibill add-source",
    `source added: ${id}`,
    `type: ${args.sourceType}`,
    `path: ${sourcePath}`,
    `provider: ${args.provider ?? "unknown"}`,
    "read-only: true",
    `boundary approval: ${addedSource.boundaryApproval}`,
    `validation coverage: ${addedSource.validationCoverage}`,
    `financial evidence: ${addedSource.financialEvidence}`
  ].join("\n"));
}

async function listSourcesCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  const registry = await readSourceRegistry(stateDir, rootPath);
  const lines = [
    "aibill sources",
    `approved sources: ${registry.approvedSources.length}`
  ];
  for (const source of registry.approvedSources) {
    lines.push(
      `- ${source.id} | ${source.type} | ${source.label} | ${source.provider ?? "unknown"} | ${source.path ?? "no path"}`,
      `  boundary approval: ${source.boundaryApproval}`,
      `  validation coverage: ${source.validationCoverage}`,
      `  financial evidence: ${source.financialEvidence}`
    );
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
        "  npx aibill connect openai      (org-owner Admin credential reference)",
        "  npx aibill connect anthropic   (Admin credential reference)",
        "Team/billing-admin upgrades:",
        "  npx aibill connect cursor          (Cursor team-admin credential reference)",
        "  npx aibill connect github-copilot  (GitHub billing-admin credential reference)"
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
  const detection = await detectLocalCredentials({
    cwd: rootPath,
    home: process.env.AI_SPEND_CLAUDE_HOME_DIR
  });
  const detected = detection.credentials.find((credential) => credential.provider === provider);

  const lines = [
    "aibill connect",
    `connector stub: ${source.id}`,
    `provider: ${provider}`,
    `type: ${type}`,
    `access method: ${source.accessMethod}`,
    `boundary approval: ${source.boundaryApproval}`,
    `validation coverage: ${source.validationCoverage}`,
    `financial evidence: ${source.financialEvidence}`,
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
      lines.push(`next: npx aibill sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
    } else {
      const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
      lines.push(`this looks like a regular key — for COST data set an admin key in ${adminRef}, then:`);
      lines.push(`  npx aibill sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
    }
  } else {
    const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
    lines.push("");
    lines.push(`next: export an admin key reference, e.g. ${adminRef}, then run:`);
    lines.push(`  npx aibill sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time <unix>`);
  }

  lines.push(`missing: ${source.fieldsMissing.join(", ")}`);

  return ok(lines.join("\n"));
}

/** Map a --plan id to a synthetic DetectedPlan (explicit user override). */
function planOverrideFromFlag(planId: string): DetectedPlan | undefined {
  const plan = subscriptionPlans.find((candidate) => candidate.id === planId);
  if (!plan) return undefined;
  return {
    agent: plan.agent,
    provider: plan.provider,
    planId: plan.id,
    planLabel: plan.name,
    billing: "subscription",
    source: "--plan override"
  };
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
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "sync-provider requires --provider, --auth-reference env:NAME, and --start-time <unix seconds>.",
        "example:",
        "  npx aibill sync-provider --provider anthropic --auth-reference env:ANTHROPIC_ADMIN_KEY --start-time 1750000000"
      ].join("\n")
    };
  }

  try {
    // A provider sync may merge only a prior connected snapshot whose exact
    // repository bytes have a matching external machine receipt. A cloned
    // provider-records.json is never allowed to launder fake rows into a new
    // trusted multi-provider snapshot.
    const priorSpend = await readPersistedSpend(rootPath);
    const trustedPrior = priorSpend?.mode === "connected_provider" &&
      priorSpend.connectedTrust?.trusted === true
      ? priorSpend
      : undefined;
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
    const records = [
      ...(trustedPrior?.records ?? []).filter((record) => record.source.provider !== result.provider),
      ...result.records
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const registry = await readSourceRegistry(stateDir, rootPath);
    const nextRegistry = addApprovedSource(registry, result.source);
    const headlineRecords = selectProviderFinancialHeadlineRecords(records);
    const summary = analyzeSpend(headlineRecords);
    const mappings = attributeUsageRecords(records);
    const qaByProvider = {
      ...trustedAccountingMap<ProviderQaSummary>(trustedPrior?.accounting, "qaByProvider"),
      [result.provider]: result.qa
    };
    const coverageByProvider = {
      ...trustedAccountingMap<ProviderCoverageStatus>(trustedPrior?.accounting, "coverageByProvider"),
      [result.provider]: result.coverage
    };
    const financialsByProvider = {
      ...trustedAccountingMap<unknown>(trustedPrior?.accounting, "financialsByProvider"),
      [result.provider]: result.financials
    };
    const checkedAtByProvider = {
      ...trustedAccountingMap<string>(trustedPrior?.accounting, "checkedAtByProvider"),
      [result.provider]: result.fetchedAt
    };
    const priorCoverageIntervals = trustedAccountingMap<ProviderCoverageInterval>(
      trustedPrior?.accounting,
      "coverageIntervalsByProvider"
    );
    const coverageIntervalsByProvider = Object.fromEntries(
      Object.entries(priorCoverageIntervals).filter(([provider]) => provider !== result.provider)
    ) as Record<string, ProviderCoverageInterval>;
    const requestedCoverageInterval = result.coverageInterval;
    if (requestedCoverageInterval) {
      coverageIntervalsByProvider[result.provider] = requestedCoverageInterval;
    }
    // Invalidate any earlier receipt before the first mutation. If a later
    // local write fails, the partially updated repository state stays
    // untrusted rather than inheriting the previous sync's authority.
    await invalidateConnectedSpendTrustReceipt(rootPath);
    await mkdir(stateDir, { recursive: true });
    await writeJson(join(stateDir, "sources.json"), nextRegistry);
    await writeJson(join(stateDir, "provider-records.json"), {
      provider: result.provider,
      fetchedAt: result.fetchedAt,
      completeness: result.completeness,
      coverage: result.coverage,
      financials: result.financials,
      sourceId: result.source.id,
      records,
      qa: result.qa,
      qaByProvider,
      checkedAtByProvider,
      coverageByProvider,
      ...(Object.keys(coverageIntervalsByProvider).length > 0
        ? { coverageIntervalsByProvider }
        : {}),
      financialsByProvider
    });
    await recordProviderSourceAttempt(
      stateDir,
      result.provider,
      result.fetchedAt,
      result.coverage === "partial"
        ? (providerQaLastError(result.qa) ?? `${result.provider}: provider returned partial coverage`)
        : null
    );
    await writeLocalSpendState(
      stateDir,
      records,
      summary,
      mappings,
      "connected_provider",
      {
        policy: "provider_reported_billed_cost_preferred",
        note: "Official provider-reported billed costs are the spend headline. API-equivalent estimates remain separate evidence and are not added to that total.",
        coverageByProvider,
        checkedAtByProvider,
        coverageIntervalsByProvider,
        qaByProvider,
        financialsByProvider
      },
      result.fetchedAt
    );
    await appendAuditEvent(stateDir, {
      timestamp: result.fetchedAt,
      action: "source_scanned",
      sourceId: result.source.id,
      detail: `${args.provider} provider connector synced ${result.records.length} evidence records with ${result.coverage} coverage. Auth reference only; no raw secrets stored.`
    });
    await writeConnectedSpendTrustReceipt(
      rootPath,
      await readSafeStateText(stateDir, "spend.json"),
      { sourceRegistryContents: await readSafeStateText(stateDir, "sources.json") }
    );

    return ok([
      "aibill sync-provider",
      `provider: ${result.provider}`,
      `source: ${result.source.id}`,
      `boundary approval: ${result.source.boundaryApproval}`,
      `validation coverage: ${result.source.validationCoverage}`,
      `financial evidence: ${result.source.financialEvidence}`,
      `coverage: ${result.coverage}`,
      `records fetched: ${result.records.length}`,
      `headline basis: ${result.financials.headlineBasis}`,
      `synced provider headline: ${formatOptionalUsd(result.financials.headlineUsd)}`,
      `combined headline spend: ${selectProviderFinancialHeadlineRecords(records).some((record) => typeof record.amountUsd === "number") ? formatOptionalUsd(summary.totalUsd) : "unavailable"}`,
      ...(result.financials.apiEquivalentEstimatedUsd !== null
        ? [`API-equivalent estimate (kept separate): $${result.financials.apiEquivalentEstimatedUsd.toFixed(2)}`]
        : []),
      "auth: reference-only; raw secrets were not persisted or printed"
    ].join("\n"));
  } catch (error) {
    const sanitizedError = sanitizeSecretishError(error instanceof Error ? error.message : String(error), args.authReference);
    await recordProviderSourceAttempt(stateDir, args.provider, new Date().toISOString(), sanitizedError).catch(() => {
      // Source-status state is diagnostic only. Do not hide the provider's
      // real error if derived-state persistence is unavailable.
    });
    return {
      exitCode: 1,
      stdout: "",
      stderr: sanitizedError
    };
  }
}

function formatOptionalUsd(value: number | null): string {
  if (value === null) return "unavailable";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

async function recordProviderSourceAttempt(
  stateDir: string,
  provider: string,
  checkedAt: string,
  lastError: string | null
): Promise<void> {
  if (!isProviderStatusId(provider) || !validIsoString(checkedAt)) {
    return;
  }
  let prior: PersistedSourceAttemptState = { version: 1, providers: {} };
  try {
    prior = parsePersistedSourceAttemptState(
      await readJson<unknown>(join(stateDir, "source-status.json"))
    ).state;
  } catch {
    // Missing/corrupt derived status state is safe to replace. Provider
    // financial records live in a separate file and are never touched here.
  }
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, "source-status.json"), {
    version: 1,
    providers: {
      ...(prior.providers ?? {}),
      [provider]: {
        checkedAt,
        lastError: lastError === null
          ? null
          : (sanitizePersistedStatusText(lastError) ?? "empty provider error")
      }
    }
  } satisfies PersistedSourceAttemptState);
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
    "aibill confirm-mapping",
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
    const sinceDays = args.sinceDays ?? 30;
    if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
    // Like Apply, an explicit sample report is a strict privacy boundary. It
    // must not inspect local transcripts, account metadata, or persisted state.
    const reportInput = args.sample
      ? await buildExplicitSampleReportInput(rootPath)
      : await buildReportInput(stateDir, rootPath, sinceDays);
    const outBase = args.out ? resolve(rootPath, args.out) : join(stateDir, "report");
    const markdownPath = `${outBase}.md`;
    const htmlPath = `${outBase}.html`;
    await mkdir(stateDir, { recursive: true });
    await writeLocalReportFile(markdownPath, generateMarkdownReport(reportInput), stateDir);
    await writeLocalReportFile(htmlPath, generateHtmlReport(reportInput), stateDir);
    const artifactPaths = await writeApplyArtifacts(stateDir, reportInput);

    return ok([
      "aibill report",
      `path: ${rootPath}`,
      `markdown: ${markdownPath}`,
      `html: ${htmlPath}`,
      `apply artifact: ${artifactPaths.codingPrompt}`,
      `action plan: ${artifactPaths.actionPlan}`,
      `policy/config draft: ${artifactPaths.policyConfigDraft}`,
      `verification plan: ${artifactPaths.verificationPlan}`,
      `demo package: ${artifactPaths.demoPackage}`,
      reportInput.dataMode === "sample"
        ? `DEMO SAMPLE · illustrative cost/value evidence total: $${reportInput.summary.totalUsd.toFixed(2)} · not user data`
        : `cost/value evidence total: $${reportInput.summary.totalUsd.toFixed(2)}`,
      "privacy: report rendered locally with no aibill telemetry; only explicit sync-provider contacts the selected provider",
      "",
      "next:",
      `  open ${htmlPath}       view the full report in your browser`,
      `  less ${markdownPath}       read it in the terminal`,
      reportInput.dataMode === "sample"
        ? "  npx aibill apply --sample  print the non-executable demo boundary"
        : "  npx aibill apply       print the paste-ready coding-agent prompt"
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't build a report: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Resolve where the AI Receipt SVG is written so it is always shareable:
 * no --out -> ai-receipt.svg in cwd; --out a directory -> ai-spend-receipt.svg
 * inside it; --out with no extension -> append .svg; explicit .svg honored.
 */
async function resolveReceiptPath(rootPath: string, out?: string): Promise<string> {
  if (!out) return join(rootPath, "ai-receipt.svg");
  const resolved = resolve(rootPath, out);
  const isDir = await stat(resolved).then((entry) => entry.isDirectory()).catch(() => false);
  if (isDir) return join(resolved, "ai-spend-receipt.svg");
  return extname(resolved) ? resolved : `${resolved}.svg`;
}

async function reportCardCommand(args: ParsedArgs): Promise<CliResult> {
  try {
    // Explicit sample mode reads no workspace data, so a broad-root scan guard
    // would reject a harmless receipt written from the user's home directory.
    // Output still goes through the safe-write/symlink checks below.
    const rootPath = args.sample ? resolve(args.path) : await resolveSafeScanRoot(args.path);
    const { records, mode, providerCoverage } = await loadInstantReadData(args);

    const headlineRecords = mode === "connected"
      ? selectProviderFinancialHeadlineRecords(records)
      : records;
    const summary = analyzeSpend(headlineRecords);
    const outPath = await resolveReceiptPath(rootPath, args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeSafeStateText(
      dirname(outPath),
      basename(outPath),
      generateReportCardSvg({
        summary,
        records: headlineRecords,
        mode,
        ...(providerCoverage ? { providerCoverage } : {})
      })
    );

    const dataLine = mode === "demo"
      ? args.sample
        ? "data: DEMO sample data — explicit illustrative mode; no local transcripts or persisted spend state were read."
        : "data: DEMO sample data — no supported local Claude Code/Codex evidence was found; use --sample to reproduce this demo explicitly."
      : mode === "local-logs"
        ? "data: local Claude Code/Codex logs priced at API-equivalent rates."
        : "data: connected local spend state with provider-reported cost kept separate from API-equivalent estimates.";

    return ok([
      "Your AI Receipt — a shareable, redacted spend card (no client/project/user names).",
      `receipt: ${outPath}`,
      dataLine,
      "",
      "Caption to share:",
      generateReportCardCaption({
        summary,
        records: headlineRecords,
        mode,
        ...(providerCoverage ? { providerCoverage } : {})
      }),
      "",
      "privacy: rendered locally; only totals, generic candidate categories, and evidence labels are included."
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't write the report card: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function applyArtifactCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");

  try {
    const sinceDays = args.sinceDays ?? 30;
    if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
    // `--sample` is a privacy boundary, not presentation sugar. It must never
    // fall through to live transcript, plan, credential, or persisted-state
    // discovery — regardless of where the flag appears after the command.
    const reportInput = args.sample
      ? await buildExplicitSampleReportInput(rootPath)
      : await buildReportInput(stateDir, rootPath, sinceDays);
    await mkdir(stateDir, { recursive: true });
    const artifactPaths = await writeApplyArtifacts(stateDir, reportInput);
    // The prompt IS the product of this command — print it so a terminal
    // user can copy it right here instead of hunting for a file path.
    const codingPrompt = await readFile(artifactPaths.codingPrompt, "utf8");
    if (args.sample) {
      return ok([
        "aibill apply-artifact",
        "data: DEMO sample data (illustrative — not your logs, account, bill, project, or workflow)",
        "artifacts: .ai-spend-agent/ (non-executable demo files)",
        "safety: no live transcripts, account metadata, credentials, or persisted spend state were read",
        "",
        "──── non-executable demo prompt (also saved under .ai-spend-agent/) ────",
        "",
        codingPrompt.trimEnd()
      ].join("\n"));
    }
    return ok([
      "aibill apply-artifact",
      `path: ${rootPath}`,
      `action plan: ${artifactPaths.actionPlan}`,
      `policy/config draft: ${artifactPaths.policyConfigDraft}`,
      `verification plan: ${artifactPaths.verificationPlan}`,
      `demo package: ${artifactPaths.demoPackage}`,
      "safety: generated artifacts only; no external systems changed",
      "",
      `──── copy everything below into Claude Code / Codex (also saved at ${artifactPaths.codingPrompt}) ────`,
      "",
      codingPrompt.trimEnd()
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't build apply artifacts: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function buildExplicitSampleReportInput(rootPath: string): Promise<SpendReportInput> {
  const records = await loadSampleUsageData();
  return {
    // Fixed alongside the bundled fixture so repeated demo runs stay stable
    // and cannot absorb this machine's clock or account state into an asset.
    generatedAt: "2026-05-20T00:00:00.000Z",
    summary: analyzeSpend(records),
    allRecords: records,
    dataMode: "sample",
    discovery: emptyDiscovery(rootPath),
    mappings: attributeUsageRecords(records),
    missingSourcePrompts: [],
    confirmedMappings: [],
    providerRecords: [],
    providerQa: [],
    deadContext: sampleDeadContext(),
    detectedPlans: []
  };
}

async function buildReportInput(stateDir: string, rootPath: string, sinceDays = 30) {
  // One anchor for logs, Context Health, the paste-ready prompt, and every
  // supporting Apply artifact. This prevents millisecond window drift between
  // files generated by the same command.
  const generatedAt = new Date();
  const sinceIso = sinceIsoForDays(sinceDays, generatedAt);
  let freshLocalCalls: Awaited<ReturnType<typeof loadLocalAgentUsage>>["calls"] | undefined;
  let freshCodexInvocationFiles: ParsedInvocationFile[] | undefined;
  let exactSpendContents: string | undefined;
  try {
    exactSpendContents = await readSafeStateText(stateDir, "spend.json");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  let spendState = exactSpendContents === undefined
    ? undefined
    : JSON.parse(exactSpendContents) as {
    summary: SpendSummary;
    records?: UsageRecord[];
    mode?: PersistedDataMode;
    accounting?: unknown;
  };
  let untrustedConnectedStateMessage: string | undefined;
  let unavailablePersistedLocalLogs = false;
  let mappings = await readOptionalJson<AttributionMapping[] | undefined>(join(stateDir, "mappings.json"), undefined);

  // Never trust a persisted summary or an absent mode. Re-parse the records,
  // recover the narrowly identifiable bundled sample written by older
  // releases, and recompute decision output under the current evidence rules.
  // Any other unlabeled state remains unlabeled and therefore non-executable.
  if (spendState?.records && spendState.records.length > 0) {
    const parsedRecords = spendState.records.map((record) => parseUsageRecord(record));
    const storedMode = isPersistedDataMode(spendState.mode) ? spendState.mode : undefined;
    // A bundled sample remains sample even if a conflicting mode was written.
    // This guards report and Apply separately from the quickstart read path.
    const mode = isBundledSampleUsage(parsedRecords) ? "sample" : storedMode;
    const records = mode === "sample" || mode === undefined
      ? downgradeSampleUsageEvidence(parsedRecords)
      : parsedRecords;
    unavailablePersistedLocalLogs = mode === "local_logs";
    const headlineRecords = mode === "connected_provider"
      ? selectProviderFinancialHeadlineRecords(records)
      : records;
    spendState = {
      records,
      mode,
      summary: analyzeSpend(headlineRecords),
      ...(spendState.accounting !== undefined ? { accounting: spendState.accounting } : {})
    };
    if (mode === "connected_provider" && exactSpendContents !== undefined) {
      const trust = await verifyConnectedSpendTrustReceipt(rootPath, exactSpendContents);
      if (!trust.trusted) {
        untrustedConnectedStateMessage = [
          trust.message,
          "CLI: run `npx aibill connect <provider>` or repeat the prior `npx aibill sync-provider ...` command."
        ].join(" ");
        spendState = undefined;
        mappings = undefined;
      } else {
        // Derived attribution is rebuilt from the receipt-bound records. A
        // repository-authored mappings.json cannot steer Apply ownership.
        mappings = attributeUsageRecords(records);
      }
    }
  }

  // Local-log state is a CACHE, not a source of truth: the quickstart always
  // re-reads the logs fresh, so report/apply must too — otherwise yesterday's
  // persisted snapshot makes the artifact's numbers disagree with the screen.
  // Persisted state stays authoritative only for connected/sample data.
  const persistedLooksConnected = (spendState?.records ?? []).some(
    (record) => record.providerCostType !== "local_agent_logs"
  );
  const needsFreshLogs =
    !spendState?.summary ||
    !spendState.records ||
    spendState.records.length === 0 ||
    // Pre-0.5.3 state did not persist a mode. Treat it as a cache and
    // re-detect local logs so report/apply cannot route through the agency
    // artifact path with stale or demo-shaped records.
    spendState.mode === undefined ||
    spendState.mode === "local_logs" ||
    // Mislabeled state (local-log records stamped connected by a past bug)
    // must be superseded by a fresh read, not trusted.
    (spendState.mode === "connected_provider" && !persistedLooksConnected);
  if (needsFreshLogs) {
    const logs = await loadLocalAgentUsage({
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      sinceIso,
      collectCodexInvocationEvidence: true
    }).catch(() => undefined);
    if (logs && logs.records.length > 0) {
      freshLocalCalls = logs.calls;
      freshCodexInvocationFiles = logs.codexInvocationFiles;
      const records = logs.records;
      const summary = analyzeSpend(records);
      const liveMappings = attributeUsageRecords(records);
      await mkdir(stateDir, { recursive: true });
      await writeLocalSpendState(stateDir, records, summary, liveMappings, "local_logs");
      spendState = { summary, records, mode: "local_logs" };
      mappings = liveMappings;
      unavailablePersistedLocalLogs = false;
    } else if (unavailablePersistedLocalLogs) {
      // Persisted local_logs is only a cache. If the source transcripts are no
      // longer present, repository-authored rows cannot become an executable
      // Apply artifact merely by claiming local_logs mode.
      spendState = undefined;
      mappings = undefined;
    }
  }
  if (!spendState?.summary || !spendState.records || spendState.records.length === 0) {
    if (untrustedConnectedStateMessage) {
      throw new Error(`${untrustedConnectedStateMessage} No connected totals or Apply actions were generated.`);
    }
    if (unavailablePersistedLocalLogs) {
      throw new Error(
        "Persisted local-log state is an untrusted cache and its source Claude Code/Codex records are unavailable. " +
          "Re-run `npx aibill` while the local transcripts are available; no report or Apply action was generated from repository state alone."
      );
    }
    throw new Error(
      "no persisted spend state and no local Claude Code/Codex logs found. " +
        "Run `npx aibill` first (or `npx aibill scan --sample --path <dir>` for a demo-data report)."
    );
  }

  const [discovery, sourceRegistry, missingSourcePrompts, confirmedMappings, persistedProviderRecordsState] = await Promise.all([
    readOptionalJson<LocalDiscoveryResult>(join(stateDir, "discovery.json"), emptyDiscovery(rootPath)),
    readSourceRegistry(stateDir, rootPath),
    readOptionalJson(join(stateDir, "missing-sources.json"), []),
    readConfirmedMappings(stateDir),
    readOptionalJson<{
      records: UsageRecord[];
      qa?: ProviderQaSummary;
      qaByProvider?: Record<string, ProviderQaSummary>;
      coverageByProvider?: Record<string, ProviderCoverageStatus>;
    }>(join(stateDir, "provider-records.json"), { records: [] })
  ]);

  const providerRecordsState = spendState.mode === "connected_provider"
    ? {
        records: spendState.records,
        qaByProvider: trustedAccountingMap<ProviderQaSummary>(
          isPlainObject(spendState.accounting) ? spendState.accounting : undefined,
          "qaByProvider"
        ),
        coverageByProvider: trustedAccountingMap<ProviderCoverageStatus>(
          isPlainObject(spendState.accounting) ? spendState.accounting : undefined,
          "coverageByProvider"
        )
      }
    : persistedProviderRecordsState;

  const providerQa = providerRecordsState.qaByProvider
    ? Object.values(providerRecordsState.qaByProvider).sort((left, right) => left.provider.localeCompare(right.provider))
    : providerRecordsState.qa
      ? [providerRecordsState.qa]
      : [];
  const spendProviderCoverage = persistedProviderCoverage(spendState.accounting);
  const coverageStatuses = [
    ...Object.values(providerRecordsState.coverageByProvider ?? {}),
    ...providerQa.map((qa) => qa.coverage).filter((coverage): coverage is ProviderCoverageStatus => coverage === "complete" || coverage === "partial"),
    ...(spendProviderCoverage ? [spendProviderCoverage] : [])
  ];
  const providerCoverage: ProviderCoverageStatus | undefined = coverageStatuses.includes("partial")
    ? "partial"
    : coverageStatuses.includes("complete")
      ? "complete"
      : undefined;

  // Named dead-context items feed the apply artifact for local-log users —
  // the concrete "remove these" list, from the same engine as the readout.
  const deadContext = spendState.mode === "local_logs"
    ? await loadDeadContext({
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
        claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
        codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
        projectDir: rootPath,
        includeAllProjectMcp: true,
        sinceIso,
        windowDays: sinceDays,
        codexInvocationFiles: freshCodexInvocationFiles
      }).catch(() => undefined)
    : undefined;

  const detectedPlans = spendState.mode === "local_logs"
    ? await detectLocalPlans({
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
      }).catch(() => [] as DetectedPlan[])
    : [];

  // Report/apply and Glance consume the same canonical Context Health result.
  // If live transcript calls are unavailable, omit it instead of fabricating a
  // session-level recommendation from day-aggregate spend records.
  const contextHealth = spendState.mode === "local_logs" && freshLocalCalls
    ? await loadContextHealth(freshLocalCalls, {
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
        claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
        codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
        projectDir: rootPath,
        includeAllProjectMcp: true,
        sinceIso,
        windowDays: sinceDays,
        codexInvocationFiles: freshCodexInvocationFiles
      }).catch(() => undefined)
    : undefined;

  return {
    generatedAt: generatedAt.toISOString(),
    summary: spendState.summary,
    deadContext,
    detectedPlans,
    contextHealth,
    // Evidence ledger is built from the SAME records as the confidence
    // breakdown so the two sections can never contradict each other.
    allRecords: spendState.mode === "connected_provider"
      ? selectProviderFinancialHeadlineRecords(spendState.records ?? [])
      : spendState.records ?? [],
    dataMode: spendState.mode,
    discovery,
    mappings: mappings ?? [],
    sourceRegistry,
    missingSourcePrompts,
    // Confirmed mappings are mutable repository state with a different user-
    // approval lifecycle. Until they receive their own receipt, they cannot
    // be promoted into connected-provider Apply actions.
    confirmedMappings: spendState.mode === "connected_provider" ? [] : confirmedMappings,
    providerRecords: providerRecordsState.records,
    providerQa,
    ...(providerCoverage ? { providerCoverage } : {})
  };
}

function validSinceDays(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 365;
}

function sinceIsoForDays(value: number, now = new Date()): string {
  return new Date(now.getTime() - value * 24 * 60 * 60 * 1_000).toISOString();
}

function invalidSinceDaysResult(): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "--since-days must be a whole number between 1 and 365"
  };
}

function emptyDiscovery(rootPath: string): LocalDiscoveryResult {
  return {
    rootPath,
    scannedFiles: 0,
    skippedDirectories: [],
    skippedSymlinks: [],
    unreadablePaths: [],
    signals: [],
    secretsDetected: [],
    redactedEvidence: []
  };
}

async function writeApplyArtifacts(stateDir: string, reportInput: SpendReportInput) {
  const paths = {
    codingPrompt: join(stateDir, "ai-spend-coding-agent-prompt.md"),
    actionPlan: join(stateDir, "ai-spend-action-plan.md"),
    policyConfigDraft: join(stateDir, "ai-spend-policy-config-draft.md"),
    verificationPlan: join(stateDir, "ai-spend-verify-plan.md"),
    demoPackage: join(stateDir, "demo-package.md")
  };
  await writeSafeStateText(stateDir, basename(paths.codingPrompt), generateApplyArtifactMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.actionPlan), generateActionPlanMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.policyConfigDraft), generatePolicyConfigDraftMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.verificationPlan), generateVerificationPlanMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.demoPackage), generateDemoPackageMarkdown(reportInput));
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
  if (command === "statusline" && rest[0] && !rest[0].startsWith("--")) {
    parsed.statuslineAction = rest.shift();
  }
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
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--sources") {
      parsed.sources = true;
      continue;
    }
    if (arg === "--statusline") {
      parsed.statusline = true;
      continue;
    }
    if (arg === "--replace") {
      parsed.replaceStatusline = true;
      continue;
    }
    if (arg === "--ignore-state") {
      parsed.ignoreState = true;
      continue;
    }
    if (arg === "--plan") {
      const next = rest[index + 1];
      if (next) {
        parsed.plan = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--since-days") {
      const next = rest[index + 1];
      if (next) {
        parsed.sinceDays = Number(next);
        index += 1;
      }
      continue;
    }
    if (arg === "--group-by") {
      const next = rest[index + 1];
      if (isGroupByDimension(next)) {
        parsed.groupBy = next;
        index += 1;
      } else {
        // Missing/invalid dimension: surface an error instead of silently
        // rendering the full readout the user didn't ask for. A following
        // flag is NOT the dimension — don't consume it.
        if (next && !next.startsWith("--")) {
          parsed.groupByInvalid = next;
          index += 1;
        } else {
          parsed.groupByInvalid = "(missing)";
        }
      }
      continue;
    }
    if (arg === "--path") {
      const next = rest[index + 1];
      if (next) {
        parsed.path = next;
        parsed.pathExplicit = true;
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
        const value = Number(next);
        // Reject NaN/out-of-range instead of rendering "NaN% confidence".
        if (Number.isFinite(value) && value >= 0 && value <= 1) {
          parsed.confidence = value;
        }
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
  // Core's redactSecrets covers sk-*/ghp_*/github_pat_*/JWT/AIza/xox/AKIA and
  // secret-suffixed env assignments; the sk- fallback keeps short keys covered.
  // Strip terminal controls first so escapes cannot split a secret pattern or
  // forge extra CLI lines, then exact-redact again after normalization.
  const withoutAuthReference = authReference && !authReference.startsWith("env:")
    ? message.split(authReference).join("[REDACTED]")
    : message;
  let sanitized = redactSecrets(stripTerminalControlSequences(withoutAuthReference))
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (authReference && !authReference.startsWith("env:")) {
    sanitized = sanitized.split(authReference).join("[REDACTED]");
  }
  return sanitized.trim();
}

function stripTerminalControlSequences(message: string): string {
  return message
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "")
    .replace(/(?:\u001b(?:P|X|\^|_)|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ");
}

/**
 * How persisted spend state was produced. Stored in spend.json so a prior
 * `scan --sample` can never be silently re-served as if it were real/connected.
 */
type PersistedDataMode = "sample" | "local_logs" | "connected_provider";

function isPersistedDataMode(value: unknown): value is PersistedDataMode {
  return value === "sample" || value === "local_logs" || value === "connected_provider";
}

async function writeLocalSpendState(
  stateDir: string,
  records: UsageRecord[],
  summary: SpendSummary,
  mappings: AttributionMapping[],
  mode: PersistedDataMode,
  accounting?: unknown,
  checkedAt?: string
): Promise<void> {
  if (mode !== "connected_provider") {
    await invalidateConnectedSpendTrustReceipt(dirname(stateDir));
  }
  await writeJson(join(stateDir, "spend.json"), {
    mode,
    ...(checkedAt && validIsoString(checkedAt) ? { checkedAt } : {}),
    records,
    summary,
    ...(accounting ? { accounting } : {})
  });
  await writeJson(join(stateDir, "mappings.json"), mappings);
}

async function readSourceRegistry(stateDir: string, rootPath: string): Promise<SourceRegistry> {
  try {
    const exactSourceRegistryContents = await readSafeStateText(stateDir, "sources.json");
    const registry = normalizeSourceRegistry(JSON.parse(exactSourceRegistryContents));
    try {
      const exactSpendContents = await readSafeStateText(stateDir, "spend.json");
      const parsedSpend = JSON.parse(exactSpendContents) as { mode?: unknown };
      if (parsedSpend.mode === "connected_provider") {
        const trust = await verifyConnectedSourceRegistryTrustReceipt(
          rootPath,
          exactSpendContents,
          exactSourceRegistryContents
        );
        if (trust.trusted) return registry;
      }
    } catch {
      // A source boundary remains usable as configuration, but its repository-
      // controlled validation/evidence claims are never promoted without the
      // matching external provider-sync receipt.
    }
    return downgradeUntrustedSourceRegistryClaims(registry);
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
  // Cap like watch-history: an unbounded log under cron watch grows forever
  // and makes every append an ever-larger rewrite.
  await writeJson(join(stateDir, "audit-log.json"), createScanAuditLog([...auditLog.events, event].slice(-500)));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readSafeStateText(dirname(path), basename(path))) as T;
}

async function readOptionalJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeSafeStateText(dirname(path), basename(path), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeLocalReportFile(path: string, contents: string, _stateDir: string): Promise<void> {
  await writeSafeStateText(dirname(path), basename(path), contents);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function helpText(): string {
  return [
    "aibill — your AI cost and usage evidence in one private view",
    "",
    "Run with no command for an instant, zero-key local readout:",
    "  npx aibill                           Show available AI cost/value evidence (sample or local data)",
    "  npx aibill --group-by agent          Drill down by source|model|client|project|agent|user|workspace|apiKey",
    "  npx aibill --plan <id>               Declare your plan when auto-detection can't (claude-max-5x|claude-max-20x|claude-pro|chatgpt-plus|chatgpt-pro)",
    "",
    "Add official provider-reported cost (ADMIN/owner-gated):",
    "  npx aibill connect openai            Requires an org-owner Admin credential reference",
    "  npx aibill connect anthropic         Requires an Admin credential reference",
    "  npx aibill connect cursor            Beta: requires a Cursor team-admin credential reference",
    "  npx aibill connect github-copilot    Beta: requires a GitHub billing-admin credential reference",
    "  npx aibill sync-provider ...         Pull provider cost/usage evidence via a local env: reference (never a raw credential)",
    "",
    "Watch continuously (deltas + anomalies):",
    "  watch [--interval N]    Re-run analysis on an interval and report deltas/anomalies",
    "    [--cycles N] [--group-by ...]  --cycles 0 runs forever; default 1 (cron-friendly)",
    "",
    "Other commands:",
    "  --version, -v           Print the package version without reading local data",
    "  init [--path <dir>]     Backfill 30 days machine-wide, print the first evidence-labeled receipt, and cache a private snapshot",
    "    [--statusline]        Explicitly install the Claude Code status line after a successful init",
    "  statusline              Render one plan-aware line from the private cache (no scan or network)",
    "  statusline refresh      Foreground refresh from real local evidence, then render the cache",
    "  statusline install      Reversibly add the standalone runner to Claude user settings",
    "    [--replace]           Explicitly replace an existing statusLine while preserving it for uninstall",
    "  statusline uninstall    Remove only the owned setting and restore its preserved predecessor",
    "  doctor [--sources]      Launch diagnostics; --sources shows validation, evidence, freshness, and errors",
    "  reset [--path <dir>]    Clear persisted spend state (so sample state can't mask real logs)",
    "  --ignore-state          On the default/quickstart run, ignore persisted spend.json for this run",
    "  scan [--path <dir>]     Scan a local workspace for AI usage signals",
    "  scan --sample           Include deterministic sample spend analysis",
    "  quickstart [--sample] [--since-days N] Plain-English local readout (default 30 days)",
    "    [--group-by source|model|client|project|agent|user|workspace|apiKey]  Default: project for local logs; model otherwise",
    "  report [--sample] [--out <name>] [--since-days N] Generate local Markdown and HTML reports from the same window",
    "  report-card [--out f.svg] Write your AI Receipt — a redacted, shareable SVG + caption",
    "  glance [--project <name>] [--plan <id>] [--since-days N] Emit the local, machine-readable Glance snapshot JSON",
    "  context [--project <name>] [--since-days N] Show hook-aware Context Health in the terminal",
    "    [--json]              Emit the same canonical Context Health object used by MCP and Glance",
    "  apply [--sample] [--since-days N]  Print an evidence-constrained inspection/approval prompt + verification plans",
    "  apply-artifact          Same as `apply` (long form)",
    "",
    "Cron (production watch): add a crontab entry such as:",
    "  0 * * * * cd /path/to/workspace && npx --yes aibill watch --interval 3600 --cycles 1 >> aibill-watch.log 2>&1",
    "",
    "Privacy: local analysis and reports upload nothing. Only explicit sync-provider contacts the selected provider through an env: reference.",
    "aibill never sits in the inference path and never stores, prints, or proxies provider credentials."
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

/**
 * Full bin entrypoint (node guard, spinner, error voice, exit code).
 * Exported so the thin alias packages (`aispend`, `aireceipt`) run the EXACT
 * same path without duplicating it — one CLI, several names.
 */
export async function runMain(): Promise<void> {
  // Fail with a clear message on old Node instead of a cryptic module/syntax
  // error deep in a dependency. npm warns on engines but never blocks install.
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 22) {
    console.error(
      `aibill needs Node 22 or newer (you have ${process.versions.node}).\n` +
        "Upgrade Node, then run: npx aibill"
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
  } catch (error) {
    // The product's error voice, never a raw stack trace — and never an
    // un-redacted secret from a provider payload or file path.
    const message = sanitizeSecretishError(error instanceof Error ? error.message : String(error));
    result = {
      exitCode: 1,
      stdout: "",
      stderr: [
        `aibill hit an unexpected error: ${message}`,
        "Nothing was uploaded. The command stopped without completing; run diagnostics before retrying.",
        "Try `npx aibill doctor` for diagnostics, or open an issue: https://github.com/futurastudio/ai-spend-agent/issues"
      ].join("\n")
    };
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

if (invokedAsMain) {
  await runMain();
}
