#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  askGuidedQuestion,
  classifyGuidedAnswer,
  createInteractivePromptSource,
  renderForYourAgent,
  type GuidedPromptSource
} from "./guidedPrompt.js";
import {
  assessEmailDeliverability,
  buildWaitlistRef,
  normalizeWaitlistEmail,
  postWaitlistSignup,
  readSignupState,
  clearSignupState,
  sanitizeSignupRefTag,
  serializeWaitlistPayload,
  signupAskTimeoutMs,
  signupCopy,
  signupStateFilePath,
  writeSignupState,
  type SignupDnsResolver
} from "./signup.js";
import {
  killTelemetryForThisProcess,
  readTelemetryState,
  telemetryDisclosureLine,
  telemetryNoticeLines,
  telemetryStateFilePath,
  writeTelemetryState,
  type TelemetryState
} from "./telemetry.js";
import {
  parsePlanDraft,
  renderCleanExit,
  runIdentitySequence,
  runPlanSitting,
  runQualitySitting,
  runRecordSitting,
  runRollbackSitting,
  runStartSitting,
  shortSittingHint,
  type FlowIo,
  type PlanDraftStore,
  type SuggestedPlanAnswer
} from "./improveFlow.js";
import {
  analyzeSpend,
  APPROVAL_EVENT_V0_KIND,
  buildContextHealth,
  buildActionVerificationProjectionV0,
  buildProjectEconomicsProjectionV0,
  buildTokenReductionBaselineV0,
  aibillCommandV0,
  aibillImproveCommandV0,
  decodeAgentDraftTokenV1,
  IMPROVE_USER_SAFETY_LINE_V1,
  looksLikeAgentDraftToken,
  screenAgentDraftSentence,
  type AgentDraftV1,
  attributeUsageRecords,
  buildUsageGlance,
  buildActivitySnapshot,
  buildResultCard,
  buildResultCardProjectLine,
  formatBilledUsdExact,
  formatCommittedPerMonth,
  resultCardSchema,
  type ResultCard,
  type ResultCardRunway,
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
  SAFE_QUALITATIVE_SCAN_POLICY,
  summarizeProviderFinancials,
  providerFinancialCompleteness,
  providerAccountKey,
  tagProviderAccountRecords,
  retainProviderRecordsForNewSync,
  providerAccountSlices,
  formatProviderAccountSlices,
  intersectProviderCoverageIntervals,
  duplicateProviderAccountSliceWarnings,
  providerSliceReplacementNotices,
  writeSafeStateText,
  verifyConnectedSpendTrustReceipt,
  verifyConnectedSourceRegistryTrustReceipt,
  writeConnectedSpendTrustReceipt,
  type DetectedPlan,
  generateCutList,
  type CutAction,
  type DeadContextResult,
  loadDeadContext,
  sampleDeadContext,
  sanitizeLocalActivityText,
  latestObservedWorkingDirectory,
  downgradeSampleUsageEvidence,
  isBundledSampleUsage,
  hasCompleteQualitativeCoverage,
  hasExactSelectedQualitativeEvidence,
  loadLocalAgentActionEvidence,
  extractSessionVitalsV0,
  loadLocalAgentFinancialUsage,
  localAgentFormatDescriptors,
  localAgentFormatLabel,
  localAgentFormatSupports,
  loadSampleUsageData,
  parseUsageRecord,
  scanLocalUsageSignals,
  buildMissingSourcePrompts,
  confirmMapping,
  createProjectIndexAdapters,
  createActionVerificationReference,
  createProjectEconomicsReference,
  createProjectEconomicsPlannedActionRefV0,
  PROJECT_ECONOMICS_V0_VERSION,
  createProviderConnectorStub,
  createProviderConnection,
  createLocalFolderSourceRegistry,
  createScanAuditLog,
  fetchProviderUsageRecords,
  addApprovedSource,
  normalizeSourceRegistry,
  downgradeUntrustedSourceRegistryClaims,
  buildSourceStatuses,
  applyProviderContractGate,
  applyProviderContractGateToSourceRegistry,
  slugifySourceId,
  financialEvidenceForRecords,
  formatSourceStatuses,
  markTokenReductionAppliedV0,
  invalidateTokenReductionExperimentV0,
  markTokenReductionRolledBackV0,
  activitySnapshotCachePath,
  readActivitySnapshot,
  recordActivitySnapshotRefreshFailure,
  refreshTokenReductionExperimentV0,
  resolveWasteFindingTargetV0,
  selectBestWasteFindingV0,
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
  type LocalAgentLogResult,
  type LocalAgentCall,
  type LocalAgentSourceScan,
  type ContextHealthResult,
  type ParsedInvocationFile,
  type SessionVitalsV0,
  type TokenReductionExperimentV0
} from "@agent-finops/core";
import {
  StatuslineInstallerError,
  installClaudeStatusline,
  refreshOwnedStatuslineRunner,
  uninstallClaudeStatusline
} from "./statuslineInstaller.js";
import {
  readStatuslineCache,
  renderStatusline
} from "./statuslineRuntime.js";
import {
  chooseLatestTokenReductionExperiment,
  loadTokenVerificationState,
  upsertTokenReductionExperiment
} from "./tokenVerificationState.js";
import {
  buildGuidedExperience,
  renderGuidedExperience,
  type GuidedExperienceModel
} from "./guidedExperience.js";
import {
  buildImproveExperience,
  type ImproveAdvancedOperation,
  type ImproveExperienceModel
} from "./improveExperience.js";
import {
  appendAcceptedProjectOutcome,
  appendProjectApprovalEvent,
  createProjectAccountabilityOwnership,
  loadProjectAccountabilityState,
  projectAccountabilityStatePath,
  upsertConfirmedProjectOwnership,
  type ProjectAccountabilityOwnershipV1,
  type ProjectAccountabilityStateV1
} from "./projectAccountabilityState.js";
import { fetchGitHubAcceptedOutcomeV0 } from "./githubAcceptedOutcome.js";
import { decideReportAutoOpen, openReportInBrowser } from "./reportOpener.js";
import {
  generateActionPlanMarkdown,
  generateApplyArtifactMarkdown,
  generateCommandSummary,
  generateDemoPackageMarkdown,
  generateHtmlReport,
  generateMarkdownReport,
  generatePlainEnglishSummary,
  generatePolicyConfigDraftMarkdown,
  generateReceiptCompanionHtml,
  generateReportCardCaption,
  generateReportCardSvg,
  generateVerificationPlanMarkdown,
  groupByDimensions,
  shellPathPointer,
  type CommandSummaryNextStep,
  type CommandSummaryRow,
  type GroupByDimension,
  type SpendReportInput
} from "@agent-finops/report";

// One shared v2 sharded store instance for BOTH evidence kinds: the v1
// monolithic qualitative adapter re-probed git privacy on every read (176
// spawned git processes per warm run with $HOME itself a git repo) and
// rewrote the whole index per entry. The v2 store memoizes the probe and
// shards per transcript; unchanged files skip their full re-read.
const cliProjectIndexAdapters = createProjectIndexAdapters();
const cliQualitativeIndex = cliProjectIndexAdapters.qualitative;
const cliFinancialIndex = cliProjectIndexAdapters.financial;
const improveRuntimeCommand = aibillImproveCommandV0();
const actionRuntimeCommand = (args: string) => aibillCommandV0(args);

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
  costCenter?: string;
  role?: string;
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
  /** drop-slice: the account slice key to remove (e.g. env:OPENAI_ADMIN_KEY_ORG2). */
  account?: string;
  groupBy?: GroupByDimension;
  /** Set when --group-by was passed with a missing/unknown dimension. */
  groupByInvalid?: string;
  interval?: number;
  cycles?: number;
  noColor?: boolean;
  /** report only: skip the automatic browser open of the HTML artifact. */
  noOpen?: boolean;
  ignoreState?: boolean;
  plan?: string;
  sinceDays?: number;
  json?: boolean;
  full?: boolean;
  sources?: boolean;
  statusline?: boolean;
  statuslineAction?: string;
  replaceStatusline?: boolean;
  verifyAction?: "inspect" | "start" | "mark-applied" | "rollback" | "cancel" | "result";
  verifyTarget?: string;
  canary?: "passed" | "failed";
  quality?: "held" | "regressed" | "missing";
  approvedAt?: string;
  appliedAt?: string;
  /** Raw ab1.… token from draft_improve_command (improve only; prefill only). */
  agentDraftToken?: string;
  /** Strict UTC Z-form time prefill for the record sitting (improve only). */
  recordAppliedAt?: string;
  /** The agent's REPORTED canary result — a claim line, never a prefill. */
  recordCanary?: "passed" | "failed";
  changeDigest?: string;
  rollbackDigest?: string;
  canaryDigest?: string;
  outcomeAction?: "github";
  pullRequestNumber?: number;
  businessOutcome?: string;
  /** signup: the email typed as the positional argument. */
  signupEmail?: string;
  /** signup: sanitized attribution tag from --ref (e.g. starfund). */
  signupRef?: string;
  /** signup --forget: clear local signup state. */
  signupForget?: boolean;
  /** signup --never: record never-ask without sending anything. */
  signupNever?: boolean;
  /** telemetry subcommand: on | off | (absent = status). */
  telemetryAction?: string;
  parseErrors: string[];
};

export type CliRuntimeOptions = {
  /** Test/embedding override. Production always defaults to the OS home. */
  homeDirectory?: string;
  /** Test/embedding override. Packed production reads the built runtime asset. */
  statuslineRunnerContents?: string | Uint8Array;
  statuslineNow?: Date;
  statuslineColumns?: number;
  statuslineTimeZone?: string;
  /** True only for the foreground terminal entrypoint; embedded/CI callers stay read-only. */
  interactive?: boolean;
  /** Foreground terminal prompt. Tests/embeddings must inject it explicitly. */
  prompt?: (question: string) => Promise<string>;
  /**
   * Consent-grade read for the explicit signup command (adversary SF1):
   * buffered/type-ahead bytes never answer, EOF/^C resolve undefined. The
   * bin wires signup.openTerminalConsentRead; tests inject stubs. When
   * absent, `prompt` is the fallback with aborts mapped to "nothing sent".
   */
  consentRead?: (query: string, timeoutMs: number) => Promise<string | undefined>;
  /**
   * Guided-flow line IO for the improve/identify sittings. The foreground
   * terminal wires an arrival-timestamped readline source; tests inject
   * scripted sources. When absent, `prompt` is bridged as a fallback.
   */
  openGuidedIo?: () => Promise<{
    source: GuidedPromptSource;
    write: (text: string) => void;
  }>;
  /** Test override for the waitlist signup POST. Production uses global fetch. */
  waitlistFetch?: typeof fetch;
  /** Test override for signup email deliverability DNS. Production uses node:dns. */
  signupDns?: SignupDnsResolver;
  /**
   * Set ONLY by the bin entrypoint when telemetry is enabled AND noticed:
   * every "nothing uploaded" claim then prints the disclosure line instead.
   * Embedded/MCP callers never set it (and never emit telemetry).
   */
  telemetryDisclosure?: boolean;
  /**
   * Test seams for `report`'s HTML auto-open (0.9.5): decide computes the
   * truthful open/suppress verdict (platform, TTY, CI/SSH, --no-open,
   * AI_SPEND_NO_OPEN); open fires the detached platform opener. Production
   * uses the real implementations; tests inject stubs to pin the opener
   * argv per platform, every suppression path, and summary-line truth.
   */
  reportOpenDecide?: typeof decideReportAutoOpen;
  reportOpenLaunch?: typeof openReportInBrowser;
};

export async function runCli(
  argv = process.argv.slice(2),
  runtime: CliRuntimeOptions = {}
): Promise<CliResult> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return ok(await cliVersion());
  }
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    return ok(helpText(runtime.telemetryDisclosure));
  }

  const args = parseArgs(argv);

  if (args.parseErrors.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        ...args.parseErrors.map((error) => `Invalid arguments: ${sanitizeSecretishError(error)}`),
        "Run `npx aibill --help` to see supported commands and flags."
      ].join("\n")
    };
  }

  if (args.json && args.command !== "context" && args.command !== "context-health" &&
      args.command !== "glance" && args.command !== "verify" &&
      args.command !== "accountability") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "--json is not available for the main receipt yet; no text receipt was substituted.",
        "Use `npx aibill context --json` for the canonical Context Health object or `npx aibill glance` for the canonical Glance snapshot."
      ].join("\n")
    };
  }

  if (args.groupByInvalid) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `--group-by needs a dimension: ${groupByDimensions.join("|")}\nexample: npx aibill --group-by project`
    };
  }

  // Running with no subcommand reads only evidence available on this machine.
  // Illustrative records are reachable only through an explicit --sample.
  if (!args.command || args.command.startsWith("--") || args.command === "quickstart" || args.command === "demo") {
    return quickstartCommand(args, runtime);
  }

  if (args.command === "doctor") {
    return doctorCommand(args, runtime);
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

  if (args.command === "signup") {
    return signupCommand(args, runtime);
  }

  if (args.command === "telemetry") {
    return telemetryCommand(args, runtime);
  }

  if (args.command === "scan") {
    return scanCommand(args);
  }

  if (args.command === "quickstart" || args.command === "demo") {
    return quickstartCommand(args, runtime);
  }

  if (args.command === "watch") {
    return watchCommand(args);
  }

  if (args.command === "report") {
    return reportCommand(args, runtime);
  }

  if (args.command === "report-card") {
    return reportCardCommand(args, runtime);
  }

  if (args.command === "glance") {
    return glanceCommand(args);
  }

  if (args.command === "context" || args.command === "context-health") {
    return contextHealthCommand(args, runtime);
  }

  if (args.command === "apply-artifact" || args.command === "apply") {
    return applyArtifactCommand(args);
  }

  if (args.command === "improve") {
    return improveCommand(args, runtime);
  }

  if (args.command === "index") {
    return indexEvidenceCommand(args, runtime);
  }

  if (args.command === "identify") {
    return identifyProjectCommand(args, runtime);
  }

  if (args.command === "outcome") {
    return projectOutcomeCommand(args);
  }

  if (args.command === "accountability") {
    return projectAccountabilityCommand(args);
  }

  if (args.command === "verify") {
    return tokenVerificationCommand(args);
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

  if (args.command === "drop-slice") {
    return dropSliceCommand(args);
  }

  if (args.command === "confirm-mapping") {
    return confirmMappingCommand(args);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `Unknown command: ${sanitizeSecretishError(args.command)}\n${helpText(runtime.telemetryDisclosure)}`
  };
}

type InstantReadMode = "demo" | "connected" | "local-logs";

type InstantReadData = {
  records: UsageRecord[];
  mode: InstantReadMode;
  warnings: string[];
  providerCoverage?: ProviderCoverageStatus;
  codexInvocationFiles?: ParsedInvocationFile[];
  /** Bounded local evidence used only for why/action/progress projections. */
  actionEvidence?: LocalAgentLogResult;
  /**
   * Connected mode only: the machine's local transcript records priced at
   * API-equivalent rates. Billed provider records stay the headline, but this
   * estimated axis must never be erased from the receipt (C-lane §1.4
   * connected/mixed variants) — subscription rows keep their ~ figures.
   */
  localFinancialRecords?: UsageRecord[];
  /** Whether the supported financial sources had no unreadable/malformed/missing-token rows. */
  financialCoverageComplete?: boolean;
};

/**
 * The ONE evidence bundle every whole-machine surface renders from (0.9.6).
 *
 * Founder-found regression this exists to make structurally impossible:
 * `npx aibill --full` run from HOME produced real ranked recommendations and
 * real plan context, while `npx aibill report` run from the SAME home wrote
 * an artifact whose ACT and VERIFY sections had degraded to "qualitative
 * indexing is unknown". Both commands called {@link loadInstantReadData},
 * but the report path threw away everything except the financial records —
 * including the transcript index that gates every action claim — and then
 * built its own thinner input. Two parallel builders, one of them wrong.
 *
 * There is now one builder. The readout and the written report receive the
 * same records, the same transcript index, the same detected plans, the same
 * dead-context inventory, and — critically — the SAME `actionCandidates`
 * array, derived once here. Neither surface derives candidates on its own,
 * so they cannot disagree about what to investigate.
 */
type BroadScanEvidence = {
  records: UsageRecord[];
  mode: InstantReadMode;
  warnings: string[];
  providerCoverage?: ProviderCoverageStatus;
  /** Headline records: provider-billed rows in connected mode, else all. */
  summaryRecords: UsageRecord[];
  /**
   * The exact record set every candidate/analysis surface reads. Connected
   * mode keeps the local API-equivalent axis alongside billed rows so the
   * two never blend but neither is erased.
   */
  analysisRecords: UsageRecord[];
  summary: SpendSummary;
  /** Derived ONCE from {@link analysisRecords}; shared by every surface. */
  actionCandidates: CutAction[];
  detectedPlans: DetectedPlan[];
  deadContext?: DeadContextResult;
  actionEvidence?: LocalAgentLogResult;
  codexInvocationFiles?: ParsedInvocationFile[];
  localFinancialRecords?: UsageRecord[];
  financialCoverageComplete: boolean;
};

async function quickstartCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions = {}
): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  if (args.plan && !planOverrideFromFlag(args.plan)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown --plan "${sanitizeSecretishError(args.plan)}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
    };
  }
  // ONE evidence bundle, shared with the machine-wide `report` (0.9.6) so the
  // readout and the written artifact can never disagree.
  const evidence = await loadBroadScanEvidence(args, sinceDays);
  const {
    records,
    mode,
    warnings,
    providerCoverage,
    actionEvidence,
    financialCoverageComplete,
    summaryRecords,
    summary,
    detectedPlans,
    deadContext
  } = evidence;
  if (records.length === 0) {
    return noEvidenceResult("receipt", warnings, sinceDays, runtime.telemetryDisclosure);
  }
  const receiptRecords = evidence.analysisRecords;
  // For real local-log users the by-project view is the flagship table
  // ("which project burns my plan"); demo/connected keep by-model.
  const groupBy = args.groupBy ?? (mode === "local-logs" ? "project" : "model");
  const color = args.noColor ? false : undefined;
  const outputWidth = terminalOutputWidth();

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

  const guidedExperience = !args.sample && actionEvidence
    ? await buildQuickstartGuidedExperience({
        args,
        summary,
        actionEvidence,
        deadContext,
        financialCoverageComplete: financialCoverageComplete === true,
        interactive: runtime.interactive === true
      }).catch(() => undefined)
    : undefined;

  const summaryText = generatePlainEnglishSummary(summary, {
    records: receiptRecords,
    // The same array the machine-wide report renders into its ACT section.
    cutList: evidence.actionCandidates,
    groupBy,
    color,
    mode,
    // Receipt-line truth: with telemetry enabled+noticed the receipt's
    // privacy claim discloses the command counts instead of "nothing
    // uploaded".
    ...(runtime.telemetryDisclosure === true ? { telemetryDisclosureLine } : {}),
    ...(providerCoverage ? { providerCoverage } : {}),
    nextSteps,
    deadContext,
    detectedPlans,
    // 0.9.5: from a broad root the --full view's project-scoped pointers
    // (apply, apply-artifact, watch, connect) carry the machine-wide
    // report's `cd <project> && …` prefix instead of advertising commands
    // that friendly-refuse right where they were printed.
    commandScope: isBroadScanRoot(args.path) ? "machine-wide" : "project",
    // C-lane §1.4: the result card header states the evidence window.
    windowDays: sinceDays,
    width: outputWidth,
    ...(guidedExperience && !args.groupBy && !args.full ? {
      guidedAction: guidedActionForTerminal(guidedExperience)
    } : {}),
    // An explicit --group-by is a drill-down question: answer with just the
    // table + window instead of repeating the whole readout.
    view: args.groupBy ? "breakdown" : args.full ? "full" : "compact"
  });

  const detailedView = Boolean(args.groupBy || args.full);
  const header = [
    ...(detailedView ? wrapCliHeader(dataModeBanner(mode, summaryRecords), "  ", outputWidth) : []),
    ...warnings.flatMap((warning) => wrapCliHeader(warning, "  ! ", outputWidth))
  ].join("\n");
  return ok(header ? `${header}\n${summaryText}` : summaryText);
}

async function buildQuickstartGuidedExperience(input: {
  args: ParsedArgs;
  summary: SpendSummary;
  actionEvidence: LocalAgentLogResult;
  deadContext?: Awaited<ReturnType<typeof loadDeadContext>>;
  financialCoverageComplete: boolean;
  interactive: boolean;
}): Promise<GuidedExperienceModel> {
  const generatedAt = new Date();
  const sinceDays = input.args.sinceDays ?? 30;
  const sinceIso = sinceIsoForDays(sinceDays, generatedAt);
  const rootPath = realpathSync(resolve(input.args.path));
  const actionProjectRef = createActionVerificationReference(
    "project-working-directory",
    rootPath
  );
  const calls = input.actionEvidence.calls.filter((call) => (
    localAgentFormatSupports(call.agent, "actionPlanning") &&
    callMatchesActionProject(call, actionProjectRef)
  ));
  const actionAgents = [...new Set(calls.map((call) => call.agent))];
  const globallyComplete = hasCompleteQualitativeCoverage(input.actionEvidence);
  const selectedEvidenceExact = hasExactSelectedQualitativeEvidence(
    input.actionEvidence,
    actionAgents
  );
  const qualitativeCoverage: "complete" | "partial" | "unknown" = globallyComplete
    ? "complete"
    : selectedEvidenceExact
      ? "partial"
      : "unknown";
  const windowDays = Math.max(1, sinceDays);
  const contextHealth = calls.length > 0
    ? await loadContextHealth(calls, {
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
        claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
        codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
        projectDir: rootPath,
        sinceIso,
        windowDays,
        codexInvocationFiles: input.actionEvidence.codexInvocationFiles
      }).catch(() => buildContextHealth({ calls, now: generatedAt, windowDays }))
    : undefined;
  const sessionVitals = calls.length > 0 ? extractSessionVitalsV0(calls) : undefined;
  const finding = sessionVitals && globallyComplete
    ? selectBestWasteFindingV0({
        sessionVitals,
        generatedAt: generatedAt.toISOString(),
        ...(contextHealth ? { contextHealth } : {}),
        ...(input.deadContext ? { deadContext: input.deadContext } : {})
      })
    : null;

  let preferredExperiment: TokenReductionExperimentV0 | undefined;
  try {
    const state = await loadTokenVerificationState(rootPath);
    const stored = chooseLatestTokenReductionExperiment(state.experiments);
    if (stored) {
      const terminal = stored.lifecycle === "complete" ||
        stored.lifecycle === "rolled_back" ||
        stored.lifecycle === "invalidated" ||
        stored.intervention.canary?.status === "failed";
      const cohortAgent = stored.cohort.agent === "claude-code" ||
          stored.cohort.agent === "codex"
        ? stored.cohort.agent
        : undefined;
      preferredExperiment = stored.intervention.appliedAt && !terminal &&
          sessionVitals &&
          cohortAgent !== undefined &&
          hasCompleteQualitativeCoverage(input.actionEvidence, [cohortAgent])
        ? refreshTokenReductionExperimentV0(stored, {
            sessionVitals,
            observedAt: generatedAt.toISOString(),
            ...(contextHealth ? { contextHealth } : {})
          })
        : stored;
    }
  } catch {
    // A malformed or unsafe private state file cannot authorize a claim. The
    // financial receipt remains useful and the action projection is omitted.
  }

  return buildGuidedExperience({
    sessionVitals,
    summary: input.summary,
    contextHealth,
    wasteFinding: finding,
    preferredExperiment,
    qualitativeCoverage,
    financialDriverComplete: input.financialCoverageComplete,
    interactive: input.interactive
  });
}

function guidedActionForTerminal(model: GuidedExperienceModel): NonNullable<
  Parameters<typeof generatePlainEnglishSummary>[1]["guidedAction"]
> {
  return {
    driverHeading: model.mainDriver.heading,
    insightHeading: model.insight.heading,
    insightHeadline: model.insight.headline,
    insightDetail: model.insight.detail,
    actionHeadline: model.safeTest.headline,
    actionDetail: model.safeTest.available
      ? model.safeTest.detail
      : `${model.safeTest.detail} ${model.interaction.mode === "read_only" ? "Nothing changed." : ""}`.trim(),
    command: model.safeTest.available || model.progress || model.result
      ? improveRuntimeCommand
      : "npx aibill --full",
    ...(model.progress ? { progress: model.progress } : {}),
    ...(model.result ? { result: model.result } : {})
  };
}

function mergeGlanceCalls(
  financialCalls: readonly LocalAgentCall[],
  qualitativeCalls: readonly LocalAgentCall[]
): LocalAgentCall[] {
  const qualitativeByIdentity = new Map(
    qualitativeCalls.map((call) => [glanceCallIdentity(call), call] as const)
  );
  return financialCalls.map((financial) => {
    const qualitative = qualitativeByIdentity.get(glanceCallIdentity(financial));
    if (!qualitative) return financial;
    return {
      ...financial,
      ...(qualitative.project ? { project: qualitative.project } : {}),
      ...(qualitative.workingDirectory ? {
        workingDirectory: qualitative.workingDirectory
      } : {}),
      ...(qualitative.workingDirectoryRef ? {
        workingDirectoryRef: qualitative.workingDirectoryRef
      } : {}),
      ...(qualitative.activity ? { activity: qualitative.activity } : {}),
      ...(qualitative.completion ? { completion: qualitative.completion } : {})
    };
  });
}

function glanceCallIdentity(call: LocalAgentCall): string {
  return [
    call.agent,
    call.callId ?? "",
    call.sessionId ?? "",
    call.timestamp,
    call.model
  ].join("\u0000");
}

function callMatchesActionProject(
  call: LocalAgentCall,
  projectRef: string
): boolean {
  const observedProjectRef = call.workingDirectoryRef ?? (
    call.workingDirectory
      ? createActionVerificationReference("project-working-directory", call.workingDirectory)
      : undefined
  );
  return observedProjectRef === projectRef;
}

async function glanceCommand(args: ParsedArgs): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const sinceIso = sinceIsoForDays(sinceDays);
  const [logs, actionEvidence] = await Promise.all([
    loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR,
      sinceIso
    }),
    loadBoundedLocalActionEvidence(sinceIso).catch(() => undefined)
  ]);
  const mergedCalls = mergeGlanceCalls(logs.calls, actionEvidence?.calls ?? []);
  const glanceCalls = mergedCalls.filter((call) => (
    localAgentFormatSupports(call.agent, "glance")
  ));
  const calls = args.project
    ? glanceCalls.filter((call) => call.project === args.project)
    : glanceCalls;
  const latestWorkingDirectory = latestObservedWorkingDirectory(calls);
  const contextProjectDir = args.pathExplicit
    ? resolve(args.path)
    : latestWorkingDirectory ?? resolve(args.path);
  // A name-filtered Glance can project a token experiment only when the
  // filtered transcript evidence proves that project's actual working root.
  // Falling back to cwd/--path after an empty or path-less filter would attach
  // an unrelated project's experiment to the requested project snapshot.
  const experimentProjectDir = args.project
    ? latestWorkingDirectory
    : contextProjectDir;
  let detectedPlans: DetectedPlan[];
  if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${sanitizeSecretishError(args.plan)}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
      };
    }
    detectedPlans = [override];
  } else {
    detectedPlans = await detectLocalPlans({
      claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
      codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
    }).catch(() => []);
  }
  const unfilteredContextCalls = (actionEvidence?.calls ?? []).filter((call) => (
    localAgentFormatSupports(call.agent, "contextHealth")
  ));
  // A project-filtered Glance must not combine project A's financial card
  // with project B's context churn or suggested action.
  const contextCalls = args.project
    ? unfilteredContextCalls.filter((call) => call.project === args.project)
    : unfilteredContextCalls;
  const contextHealth = await loadContextHealth(contextCalls, {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
    codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
    claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
    claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
    projectDir: contextProjectDir,
    sinceIso,
    windowDays: sinceDays,
    codexInvocationFiles: actionEvidence?.codexInvocationFiles
  }).catch(() => buildContextHealth({ calls: contextCalls, windowDays: sinceDays }));
  const actionVerificationProjection = await (async () => {
    if (!experimentProjectDir) return undefined;
    try {
      const state = await loadTokenVerificationState(experimentProjectDir);
      const experiment = chooseLatestTokenReductionExperiment(state.experiments);
      if (!experiment) return undefined;
      const cannotAcceptFreshEvidence = experiment.lifecycle === "complete" ||
        experiment.lifecycle === "rolled_back" ||
        experiment.lifecycle === "invalidated" ||
        experiment.intervention.canary?.status === "failed";
      const current = experiment.intervention.appliedAt && !cannotAcceptFreshEvidence
        ? await (async () => {
            const observation = await loadTokenVerificationObservation(
              experimentProjectDir,
              experiment
            );
            if (!observation.qualitativeCoverageComplete) return experiment;
            return refreshTokenReductionExperimentV0(experiment, {
              sessionVitals: observation.sessionVitals,
              observedAt: observation.generatedAt,
              contextHealth: observation.contextHealth
            });
          })()
        : experiment;
      return buildActionVerificationProjectionV0(current);
    } catch {
      // Glance is read-only and fail-closed. A malformed, symlinked, stale, or
      // otherwise unreadable experiment never reuses an older percentage.
      return undefined;
    }
  })();
  const snapshot = buildUsageGlance(calls, {
    filesParsed: logs.sourceScans
      .filter((scan) => localAgentFormatSupports(scan.agent, "glance"))
      .reduce((total, scan) => total + scan.filesParsed, 0),
    detectedAgents: logs.agentsDetected.filter((agent) => (
      localAgentFormatSupports(agent, "glance")
    )),
    detectedPlans,
    limitCalls: glanceCalls,
    contextHealth,
    qualitativeCoverage: summarizeCliQualitativeCoverage(actionEvidence),
    ...(actionVerificationProjection ? { actionVerificationProjection } : {})
  });
  return ok(JSON.stringify(snapshot));
}

async function contextHealthCommand(args: ParsedArgs, runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const sinceIso = sinceIsoForDays(sinceDays);
  const logs = await loadBoundedLocalActionEvidence(sinceIso);
  const contextCalls = logs.calls.filter((call) => (
    localAgentFormatSupports(call.agent, "contextHealth")
  ));
  const calls = args.project
    ? contextCalls.filter((call) => call.project === args.project)
    : contextCalls;
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
  const qualitativeCoverage = summarizeCliQualitativeCoverage(logs);
  return ok(args.json
    ? JSON.stringify({ ...health, qualitativeCoverage })
    : `${renderContextHealth(health, runtime.telemetryDisclosure)}\n\n${renderCliQualitativeCoverage(qualitativeCoverage)}`);
}

function renderContextHealth(health: ContextHealthResult, telemetryDisclosure?: boolean): string {
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
    `Privacy: ${uploadsNothingLine(telemetryDisclosure, "this CLI run uploads nothing.")}`
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
    steps.push(`npx aibill connect ${detected[0]!.provider}   set up the admin connector, then sync provider-reported cost`);
  }
  steps.push(
    mode === "demo"
      // 0.9.4: report --sample runs as printed from ANY directory — broad
      // roots write ./ai-spend-report.{md,html} machine-wide-style, project
      // folders keep .ai-spend-agent/report.* (the old mkdir demo-workspace
      // preamble is no longer needed for the command to run as printed).
      ? "npx aibill report --sample     write a clearly labeled demo report right here"
      : "npx aibill report              write a shareable Markdown + HTML report"
  );
  steps.push("npx aibill --group-by project  see which project has the most observed activity");
  steps.push("Need team reconciliation, allocation, budgets, and approvals? Workspace design partners: https://asktilden.com");
  if (mode === "demo") {
    // Static pointer only — sample output is built for recordings and
    // screenshots, so it never prompts (capture design moments map).
    steps.push(signupCopy.samplePointer);
  }
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
    const parsedModeRecords = mode === "sample" || mode === undefined
      ? downgradeSampleUsageEvidence(parsedRecords)
      : parsedRecords;
    const records = mode === "connected_provider"
      ? applyProviderContractGate(parsedModeRecords)
      : parsedModeRecords;
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

  const sinceIso = sinceIsoForDays(args.sinceDays ?? 30);
  const [persisted, financialResult, actionResult] = await Promise.all([
    args.ignoreState ? Promise.resolve(undefined) : readPersistedSpend(resolve(args.path)),
    loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR,
      sinceIso
    }).then((value) => ({ value })).catch(() => ({ value: undefined })),
    loadBoundedLocalActionEvidence(sinceIso)
      .then((value) => ({ value }))
      .catch(() => ({ value: undefined }))
  ]);
  const financialLogs = financialResult.value;
  const actionEvidence = actionResult.value;
  if (!financialLogs) {
    warnings.push("Some local financial evidence could not be read; coverage is incomplete.");
  }
  if (!actionEvidence) {
    warnings.push("Local why/action evidence could not be indexed; no action claim was inferred.");
  }

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
    const connectedRecords = applyProviderContractGate(persisted.records);
    const connectedHeadlineRecords = selectProviderFinancialHeadlineRecords(connectedRecords);
    return {
      records: connectedRecords,
      mode: "connected",
      warnings,
      ...(actionEvidence ? {
        actionEvidence,
        codexInvocationFiles: actionEvidence.codexInvocationFiles
      } : {}),
      // Billed provider records are the headline, but the machine's local
      // API-equivalent evidence is a separate axis the receipt must keep
      // (per-subscription ~ figures) — connected mode never erases it.
      ...(financialLogs && financialLogs.records.length > 0
        ? { localFinancialRecords: financialLogs.records }
        : {}),
      ...(persisted.providerCoverage ? { providerCoverage: persisted.providerCoverage } : {}),
      financialCoverageComplete: persisted.providerCoverage === "complete" &&
        connectedHeadlineRecords.length > 0 &&
        connectedHeadlineRecords.every((record) => (
          typeof record.amountUsd === "number" && record.costConfidence !== "missing"
        ))
    };
  }

  if (persisted?.mode === "connected_provider" && persisted.connectedTrust?.trusted === false) {
    warnings.push(
      `${persisted.connectedTrust.message} CLI: run \`npx aibill connect <provider>\` or repeat the prior \`npx aibill sync-provider ...\` command. The repository-provided connected totals were ignored.`
    );
  }

  // Financial rows use the streaming, proof-based reader. The richer action
  // reader is independently bounded above and can never make a partial index
  // look like complete financial evidence.
  if (financialLogs && financialLogs.records.length > 0) {
    // Persisted local_logs state (written by report/apply-artifact) is the
    // same data source we just re-read — superseding it silently is correct,
    // not worth a scary "sample/legacy" warning.
    if (persisted && persisted.records.length > 0 && persisted.mode !== "connected_provider" && persisted.mode !== "local_logs") {
      warnings.push("Ignored persisted sample/legacy state in .ai-spend-agent/spend.json — showing your real local agent logs. Run `npx aibill reset` to clear it, or pass --ignore-state.");
    }
    return {
      records: financialLogs.records,
      mode: "local-logs",
      warnings,
      ...(actionEvidence ? {
        actionEvidence,
        codexInvocationFiles: actionEvidence.codexInvocationFiles
      } : {}),
      financialCoverageComplete: financialLogs
        ? localFinancialEvidenceComplete(financialLogs)
        : false
    };
  }

  const geminiPresence = financialLogs?.sourceScans.find((scan) => scan.agent === "gemini-cli");
  if (geminiPresence && (
    (geminiPresence.detectionSignals ?? 0) > 0 || geminiPresence.filesDiscovered > 0
  )) {
    warnings.push(
      "Gemini CLI was detected, but no supported chats JSON/JSONL financial evidence was found. No financial rows were created; logs.json is presence-only evidence. Need this coverage? +1 or contribute a synthetic fixture: https://github.com/futurastudio/ai-spend-agent/issues/new?template=provider_or_agent.yml"
    );
    return {
      records: [],
      mode: "local-logs",
      warnings,
      ...(actionEvidence ? {
        actionEvidence,
        codexInvocationFiles: actionEvidence.codexInvocationFiles
      } : {}),
      financialCoverageComplete: financialLogs
        ? localFinancialEvidenceComplete(financialLogs)
        : false
    };
  }

  // No real logs. Sample and legacy persisted state must never appear unless
  // this invocation explicitly opted into --sample.
  if (persisted && persisted.records.length > 0 && persisted.mode !== "connected_provider" && persisted.mode !== "local_logs") {
    warnings.push(
      persisted.mode === "sample"
        ? "Sample state exists but was not displayed because this run did not include --sample."
        : "Legacy state with no trustworthy data-mode label was ignored. Run `npx aibill reset`, then collect fresh evidence."
    );
  }

  if (persisted?.mode === "local_logs") {
    warnings.push(
      "Ignored persisted local-log cache because no current Claude Code/Codex source records were found. Re-run the local agent activity first; repository state alone cannot authorize an Apply action."
    );
  }

  return {
    records: [],
    mode: "local-logs",
    warnings,
    ...(actionEvidence ? {
      actionEvidence,
      codexInvocationFiles: actionEvidence.codexInvocationFiles
    } : {}),
    financialCoverageComplete: financialLogs
      ? localFinancialEvidenceComplete(financialLogs)
      : false
  };
}

/**
 * Build the one {@link BroadScanEvidence} bundle. Called by the receipt /
 * `--full` readout AND by the machine-wide `report`; nothing else may
 * re-derive these facts.
 *
 * Everything here was previously inline in the receipt path. The machine-wide
 * report used to call {@link loadInstantReadData} directly and keep only
 * `records`, which is exactly how its ACT and VERIFY sections lost the
 * transcript index and degraded to internal-jargon "unknown" copy while the
 * readout from the same directory showed real, ranked candidates.
 */
async function loadBroadScanEvidence(
  args: ParsedArgs,
  sinceDays: number
): Promise<BroadScanEvidence> {
  const instant = await loadInstantReadData(args);
  const { records, mode, warnings, providerCoverage } = instant;
  const summaryRecords = mode === "connected"
    ? selectProviderFinancialHeadlineRecords(records)
    : records;
  // Connected receipts stay billed-primary but never ERASE the estimated
  // axis: local transcript records ride along so subscription rows keep
  // their ~ API-equivalent figures next to billed money (C-lane §1.4).
  const analysisRecords = mode === "connected" && (instant.localFinancialRecords?.length ?? 0) > 0
    ? [...summaryRecords, ...instant.localFinancialRecords!]
    : summaryRecords;

  // Persona: --plan override wins; otherwise read the plans the coding agents
  // themselves persisted locally (read-only, whitelisted fields, no network).
  // An explicit sample run must be deterministic and safe to record/share:
  // never mix the developer's real local plan into illustrative output.
  const planOverride = args.plan ? planOverrideFromFlag(args.plan) : undefined;
  const detectedPlans: DetectedPlan[] = args.sample
    ? []
    : planOverride
      ? [planOverride]
      : await detectLocalPlans({
          // Env overrides keep tests (and unusual installs) isolated from $HOME.
          claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
          codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
        }).catch(() => []);

  // Dead-context cost, globalized across the user's whole Claude Code setup
  // (all projects' MCP + user-scope skills/agents/commands, vs. every
  // transcript) so it's populated from ANY directory on the first run.
  // Never throws into the readout.
  let deadContext = args.sample
    ? undefined
    : await loadDeadContext({
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
        codexInvocationFiles: instant.codexInvocationFiles
      }).catch(() => undefined);
  // Sample dead-context is shown ONLY on the demo readout. A real readout
  // (local logs / connected billing) never gets fabricated waste injected —
  // a genuinely clean setup earns its congratulation line instead.
  if (mode === "demo" && (!deadContext || !deadContext.hasData)) {
    deadContext = sampleDeadContext();
  }

  return {
    records,
    mode,
    warnings,
    ...(providerCoverage ? { providerCoverage } : {}),
    summaryRecords,
    analysisRecords,
    summary: analyzeSpend(summaryRecords),
    // THE parity anchor: derived once, handed to every surface.
    actionCandidates: generateCutList(analysisRecords),
    detectedPlans,
    ...(deadContext ? { deadContext } : {}),
    ...(instant.actionEvidence ? { actionEvidence: instant.actionEvidence } : {}),
    ...(instant.codexInvocationFiles ? { codexInvocationFiles: instant.codexInvocationFiles } : {}),
    ...(instant.localFinancialRecords ? { localFinancialRecords: instant.localFinancialRecords } : {}),
    financialCoverageComplete: instant.financialCoverageComplete === true
  };
}

function localFinancialEvidenceComplete(result: LocalAgentLogResult): boolean {
  const scanCoverageComplete = result.sourceScans.every((scan) => (
    scan.directoryStatus !== "unreadable" &&
    scan.unreadableFiles === 0 &&
    scan.malformedLines === 0 &&
    scan.unsupportedUsageSnapshots === 0
  ));
  const everyObservedRowHasFinancialValue = result.records.length > 0 &&
    result.records.every((record) => (
      typeof record.amountUsd === "number" && record.costConfidence !== "missing"
    ));
  return scanCoverageComplete && everyObservedRowHasFinancialValue;
}

async function loadBoundedLocalActionEvidence(sinceIso: string): Promise<LocalAgentLogResult> {
  return loadLocalAgentActionEvidence({
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    sinceIso,
    collectCodexInvocationEvidence: true,
    qualitativeScan: SAFE_QUALITATIVE_SCAN_POLICY,
    qualitativeIndex: cliQualitativeIndex,
    streamCheckpoints: cliProjectIndexAdapters
  });
}

/**
 * `aibill index` — drain the oversized-transcript backlog to completion in
 * one foreground command. `improve` and the receipt stay fast by streaming a
 * bounded slice per run; this command loops those bounded passes until the
 * qualitative index converges, printing honest per-pass progress.
 */
async function indexEvidenceCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  const rootGuard = await guardExactProjectRoot("index", args.path);
  if (rootGuard) return rootGuard;
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1_000).toISOString();
  const liveLine = (line: string) => {
    if (runtime.interactive) process.stdout.write(`${line}\n`);
  };
  const formatBytes = (bytes: number): string =>
    bytes >= 1_000_000_000
      ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
      : `${Math.round(bytes / 1_000_000)} MB`;
  liveLine("aibill index · reading your local evidence to completion");
  liveLine("Large histories take a few minutes on the first full pass. Local only.");
  const startedAt = Date.now();
  const maxPasses = 64;
  const perPassBytes = 8 * 1024 * 1024 * 1024;
  let totalBytes = 0;
  let passes = 0;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    passes = pass;
    const evidence = await loadLocalAgentActionEvidence({
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      sinceIso,
      collectCodexInvocationEvidence: true,
      qualitativeScan: { ...SAFE_QUALITATIVE_SCAN_POLICY, maxStreamedBytesPerRun: perPassBytes },
      qualitativeIndex: cliQualitativeIndex,
      streamCheckpoints: cliProjectIndexAdapters
    });
    const coverage = summarizeCliQualitativeCoverage(evidence);
    const scans = evidence.sourceScans.filter((scan) => (
      scan.agent === "claude-code" || scan.agent === "codex"
    ));
    const passBytes = scans.reduce(
      (sum, scan) => sum + (scan.qualitativeBytesStreamed ?? 0), 0
    );
    const stillConverging = scans.reduce(
      (sum, scan) => sum + (scan.qualitativeFilesStreaming ?? 0), 0
    );
    totalBytes += passBytes;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    liveLine(
      `pass ${pass} · ${formatBytes(passBytes)} read · ` +
      `${stillConverging} large file(s) still converging · ${elapsedSeconds}s elapsed`
    );
    if (coverage.status === "complete") {
      return ok(renderCleanExit({
        lines: [
          "Index complete",
          `${coverage.readCompletely}/${coverage.selectedFiles} selected files read completely · ` +
            `${formatBytes(totalBytes)} streamed across ${passes} pass(es)`
        ],
        next: { reason: "your evidence is fully indexed — run the token test", command: improveRuntimeCommand }
      }));
    }
    if (passBytes === 0 && stillConverging === 0) {
      // Nothing left to stream, yet coverage is not complete: whatever
      // remains is not convergable by streaming. Say so honestly.
      return ok(renderCleanExit({
        lines: [
          `Index ${coverage.status} · nothing more can be streamed`,
          `${coverage.readCompletely}/${coverage.selectedFiles} selected files read completely · ` +
            `${coverage.skippedForBudget} file(s) remain outside the read budget`
        ],
        next: { reason: "run the token test on the evidence that is indexed", command: improveRuntimeCommand }
      }));
    }
  }
  return ok(renderCleanExit({
    lines: [
      `Index still converging after ${passes} passes · ${formatBytes(totalBytes)} streamed`,
      "Progress is saved; every pass resumes exactly where the last one stopped."
    ],
    next: { reason: "run this again to continue", command: actionRuntimeCommand("index") }
  }));
}

type CliQualitativeCoverage = {
  status: "complete" | "partial" | "unknown";
  selectedFiles: number;
  readCompletely: number;
  skippedForBudget: number;
};

function summarizeCliQualitativeCoverage(
  logs: LocalAgentLogResult | undefined
): CliQualitativeCoverage {
  if (!logs) return {
    status: "unknown",
    selectedFiles: 0,
    readCompletely: 0,
    skippedForBudget: 0
  };
  const scans = logs.sourceScans.filter((scan) => (
    scan.agent === "claude-code" || scan.agent === "codex"
  ));
  return {
    status: ["claude-code", "codex"].every((agent) => (
      scans.find((scan) => scan.agent === agent)?.qualitativeCoverage === "complete"
    )) ? "complete" : "partial",
    selectedFiles: scans.reduce(
      (sum, scan) => sum + (scan.qualitativeFilesSelected ?? 0), 0
    ),
    readCompletely: scans.reduce(
      (sum, scan) => sum + (scan.qualitativeFilesReadCompletely ?? 0), 0
    ),
    skippedForBudget: scans.reduce(
      (sum, scan) => sum + (scan.qualitativeFilesSkippedForBudget ?? 0), 0
    )
  };
}

function summarizeCliQualitativeCoverageByAgent(
  logs: LocalAgentLogResult | undefined
): NonNullable<SpendReportInput["qualitativeCoverageByAgent"]> {
  return Object.fromEntries(
    (["claude-code", "codex"] as const).map((agent) => {
      if (!logs) return [agent, "unknown"] as const;
      const scan = logs.sourceScans.find((candidate) => candidate.agent === agent);
      if (!scan) return [agent, "unknown"] as const;
      return [
        agent,
        hasCompleteQualitativeCoverage(logs, [agent]) ? "complete" : "partial"
      ] as const;
    })
  );
}

function renderCliQualitativeCoverage(coverage: CliQualitativeCoverage): string {
  return `QUALITATIVE INDEX  ${coverage.status.toUpperCase()} · ` +
    `${coverage.readCompletely}/${coverage.selectedFiles} selected files read completely · ` +
    `${coverage.skippedForBudget} eligible files skipped by budget`;
}

/**
 * `aibill signup <email> [--ref <token>]` — the explicit, deliberate path to
 * the launch list. Sends EXACTLY {email, ref} to the deployed waitlist route
 * after showing the literal payload JSON and receiving a typed `y` on a real
 * terminal. Never sends without the confirm; never retries, queues, or
 * persists the typed email on failure. `--forget` clears local signup state;
 * `--never` records never-ask without sending anything.
 */
async function signupCommand(args: ParsedArgs, runtime: CliRuntimeOptions): Promise<CliResult> {
  const stateFile = signupStateFilePath(runtime.homeDirectory);

  if (args.signupForget) {
    const cleared = await clearSignupState(stateFile);
    return cleared
      ? ok(signupCopy.forgetLine)
      : { exitCode: 1, stdout: "", stderr: "local signup state could not be cleared; check ~/.aibill permissions" };
  }

  const priorRead = await readSignupState(stateFile);
  const priorAskCount = priorRead.kind === "ok" ? priorRead.state.askCount : 0;

  if (args.signupNever) {
    const written = await writeSignupState(stateFile, { version: 1, status: "never", askCount: priorAskCount });
    return written
      ? ok(signupCopy.neverLine)
      : { exitCode: 1, stdout: "", stderr: "never-ask could not be persisted; check ~/.aibill permissions" };
  }

  if (!args.signupEmail) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "signup needs an email: npx aibill signup you@work.com [--ref <token>]",
        "Optional: signup --never (never ask again) · signup --forget (clear local signup state)"
      ].join("\n")
    };
  }

  // Consent requires a human at a real terminal; there is deliberately no
  // --yes flag and no non-TTY path (QA 2).
  if (runtime.interactive !== true || !runtime.prompt) {
    return { exitCode: 1, stdout: "", stderr: signupCopy.nonInteractiveLine };
  }

  const email = normalizeWaitlistEmail(args.signupEmail);
  if (email === undefined) {
    return { exitCode: 1, stdout: "", stderr: signupCopy.invalidEmailLine };
  }
  // Deliverability (MX with A fallback, 1.5s budget, fail-open on DNS
  // trouble): only a provable cannot-receive domain or a throwaway inbox is
  // refused — never a slow or offline resolver.
  const deliverability = await assessEmailDeliverability(email, {
    ...(runtime.signupDns ? { resolver: runtime.signupDns } : {})
  });
  if (deliverability === "no_mx") {
    return { exitCode: 1, stdout: "", stderr: signupCopy.noMxLine };
  }
  if (deliverability === "disposable") {
    return { exitCode: 1, stdout: "", stderr: signupCopy.disposableLine };
  }

  if (priorRead.kind === "ok" && priorRead.state.status === "subscribed" && priorRead.state.email === email) {
    // Cosmetic-local dedupe; the route itself is idempotent (201 on duplicate).
    return ok(signupCopy.alreadyLine);
  }

  const payload = { email, ref: buildWaitlistRef("signup", args.signupRef) };
  const consentQuery =
    `${signupCopy.scopeLine}\n${signupCopy.consentQuestion(serializeWaitlistPayload(payload))}`;
  // Adversary SF1: the consent question must never be answered by a
  // buffered byte, and EOF/^C are a quiet "nothing sent", never the crash
  // voice — this is the exact command the receipt advertises.
  let consentAnswer: string | undefined;
  if (runtime.consentRead) {
    consentAnswer = await runtime.consentRead(consentQuery, signupAskTimeoutMs);
  } else {
    try {
      consentAnswer = await runtime.prompt(consentQuery);
    } catch {
      // readline/promises rejects on Ctrl-D/Ctrl-C ("Aborted with Ctrl+D").
      consentAnswer = undefined;
    }
  }
  if (consentAnswer === undefined) {
    return ok(signupCopy.nothingSentLine);
  }
  const consent = consentAnswer.trim().toLowerCase();
  if (consent !== "y" && consent !== "yes") {
    return ok(signupCopy.nothingSentLine);
  }

  const outcome = await postWaitlistSignup(payload, { fetchImpl: runtime.waitlistFetch });
  if (outcome === "sent") {
    await writeSignupState(stateFile, { version: 1, status: "subscribed", askCount: priorAskCount, email });
    return ok(signupCopy.sentLine);
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: outcome === "invalid_email"
      ? signupCopy.invalidEmailLine
      : outcome === "rate_limited"
        ? signupCopy.rateLimitedLine
        : signupCopy.unreachableLine
  };
}

/**
 * `aibill telemetry [on|off]` — inspect or switch anonymous command-count
 * telemetry. Status shows the EXACT last payload verbatim; state is
 * fail-closed (corrupt/readonly ⇒ off).
 */
async function telemetryCommand(args: ParsedArgs, runtime: CliRuntimeOptions): Promise<CliResult> {
  const filePath = telemetryStateFilePath(runtime.homeDirectory);
  const read = await readTelemetryState(filePath);
  const action = args.telemetryAction;

  if (action !== undefined && action !== "on" && action !== "off") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown telemetry action: ${sanitizeSecretishError(action)}\nUse: npx aibill telemetry [on|off]`
    };
  }

  if (action === "off") {
    const state: TelemetryState = {
      version: 1,
      installId: read.kind === "ok" ? read.state.installId : randomUUID(),
      enabled: false,
      ...(read.kind === "ok" && read.state.noticedAt !== undefined ? { noticedAt: read.state.noticedAt } : {}),
      ...(read.kind === "ok" && read.state.lastPayload !== undefined ? { lastPayload: read.state.lastPayload } : {})
    };
    if (!await writeTelemetryState(filePath, state)) {
      // FAIL CLOSED (QA M1): the off could not be persisted and the stored
      // state may still say enabled — silence THIS process and point at the
      // env kill-switches for a durable off.
      killTelemetryForThisProcess();
      return {
        exitCode: 1,
        stdout: "",
        stderr: [
          "telemetry off could not be persisted — nothing more will be sent by this run.",
          "For a durable off, set AI_SPEND_NO_TELEMETRY=1 or DO_NOT_TRACK=1, then fix ~/.aibill permissions."
        ].join("\n")
      };
    }
    killTelemetryForThisProcess();
    return ok("telemetry off · nothing is sent");
  }

  if (action === "on") {
    // Turning telemetry on explicitly IS the notice moment: the user is
    // reading this command's output, so noticedAt is stamped now and
    // events begin on the next run.
    const state: TelemetryState = {
      version: 1,
      installId: read.kind === "ok" ? read.state.installId : randomUUID(),
      enabled: true,
      noticedAt: new Date().toISOString(),
      ...(read.kind === "ok" && read.state.lastPayload !== undefined ? { lastPayload: read.state.lastPayload } : {})
    };
    if (!await writeTelemetryState(filePath, state)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "telemetry state could not be written — telemetry remains off (unreadable state fails closed)"
      };
    }
    return ok([
      "telemetry on · anonymous command counts only",
      `counted: command name, version, os, arch, ci flag, duration bucket, ok flag, timestamp`,
      "never: arguments, paths, file contents, project names, or your email",
      "events start with your next run · see payloads anytime: npx aibill telemetry"
    ].join("\n"));
  }

  const lines = ["aibill telemetry"];
  if (read.kind === "unreadable") {
    lines.push("status: off (state unreadable — telemetry fails closed)");
  } else if (read.kind === "fresh") {
    lines.push("status: not yet noticed · nothing has ever been sent");
    lines.push("a one-time notice prints after your next interactive run; events begin only after it");
  } else if (!read.state.enabled) {
    lines.push("status: off · nothing is sent");
  } else if (read.state.noticedAt === undefined) {
    lines.push("status: on but not yet noticed · nothing has been sent");
  } else {
    lines.push(`status: on · noticed ${read.state.noticedAt}`);
  }
  lines.push(
    "counted: command name, version, os, arch, ci flag, duration bucket, ok flag, timestamp",
    "never: arguments, paths, file contents, project names, or your email"
  );
  if (read.kind === "ok" && read.state.lastPayload !== undefined) {
    lines.push("last payload sent (verbatim):", read.state.lastPayload);
  } else {
    lines.push("last payload sent: none");
  }
  lines.push("switch: npx aibill telemetry on · npx aibill telemetry off");
  return ok(lines.join("\n"));
}

/** The run-level privacy claim: literal truth in both telemetry states. */
function uploadsNothingLine(telemetryDisclosure: boolean | undefined, original: string): string {
  return telemetryDisclosure === true ? telemetryDisclosureLine : original;
}

function noEvidenceResult(
  surface: "receipt" | "watch" | "report-card" | "report",
  warnings: readonly string[],
  sinceDays: number,
  telemetryDisclosure?: boolean
): CliResult {
  const surfaceLine = surface === "watch"
    ? "Watch has no financial baseline yet; no zero total or sample activity was recorded."
    : surface === "report-card"
      ? "No receipt was written because there is no supported financial evidence to summarize."
      : surface === "report"
        ? "No report was written because there is no supported financial evidence to summarize."
        : `No supported AI usage evidence was found in the last ${sinceDays} days.`;
  return {
    exitCode: surface === "receipt" ? 0 : 1,
    stdout: surface === "receipt"
      ? [
          "aibill · local only",
          "",
          surfaceLine,
          "Looked for: Claude Code, Codex, and Gemini CLI local history.",
          `${uploadsNothingLine(telemetryDisclosure, "Nothing was uploaded.")} No sample data was substituted.`,
          ...warnings.map((warning) => `! ${warning}`),
          "",
          "Next",
          "  npx aibill doctor --sources       see the exact evidence gap and setup paths",
          `  ${signupCopy.receiptPointer}`
        ].join("\n")
      : "",
    stderr: surface === "receipt"
      ? ""
      : [
          surfaceLine,
          "Run `npx aibill doctor --sources` to see the exact evidence gap.",
          "Local evidence: use Claude Code, Codex, or Gemini CLI normally, then retry.",
          "Provider billing: connect openai, anthropic, cursor, or github-copilot with an admin credential reference.",
          "For illustrative output only, rerun this command with --sample."
        ].join("\n")
  };
}

function terminalOutputWidth(): number {
  const envColumns = Number(process.env.COLUMNS);
  const ttyColumns = process.stdout.columns;
  const requested = Number.isFinite(envColumns) && envColumns > 0
    ? envColumns
    : Number.isFinite(ttyColumns) && (ttyColumns ?? 0) > 0
      ? ttyColumns!
      : 72;
  return Math.max(40, Math.min(120, Math.floor(requested)));
}

function wrapCliHeader(text: string, prefix: string, width: number): string[] {
  const available = Math.max(12, width - prefix.length);
  const words = text.trim().split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= available) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  const continuationPrefix = " ".repeat(prefix.length);
  return lines.map((line, index) => `${index === 0 ? prefix : continuationPrefix}${line}`);
}

/** A one-line, unmissable banner telling the user which data they're seeing. */
function dataModeBanner(mode: InstantReadMode, records: readonly UsageRecord[]): string {
  if (mode === "local-logs") {
    return records.some((record) => typeof record.amountUsd === "number")
      ? "DATA MODE: your local agent logs (estimated at API-equivalent rates)"
      : "DATA MODE: local agent evidence (financial value unavailable; no demo sample substituted)";
  }
  if (mode === "connected") return "DATA MODE: connected provider billing";
  return "DATA MODE: demo sample (illustrative — not your real spend)";
}

async function doctorCommand(args: ParsedArgs, runtime: CliRuntimeOptions = {}): Promise<CliResult> {
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

  const logs = await loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR
  }).catch(() => undefined);
  const detected = logs?.agentsDetected ?? [];
  const claudeFound = detected.includes("claude-code");
  const codexFound = detected.includes("codex");
  const geminiScan = logs?.sourceScans.find((scan) => scan.agent === "gemini-cli");
  const geminiFinancialFound = detected.includes("gemini-cli");
  const geminiPresenceFound = Boolean(
    geminiScan && ((geminiScan.detectionSignals ?? 0) > 0 || geminiScan.filesDiscovered > 0)
  );
  const geminiFound = geminiFinancialFound || geminiPresenceFound;
  const hasFinancialLogs = claudeFound || codexFound || geminiFinancialFound;
  const hasLocalSource = hasFinancialLogs || geminiPresenceFound;

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
  if (geminiPresenceFound && !geminiFinancialFound) {
    warnings.push("Gemini CLI detected, but no supported chats JSON/JSONL financial evidence was found. No financial rows were created; logs.json is presence-only evidence. Need this coverage? +1 or contribute a synthetic fixture: https://github.com/futurastudio/ai-spend-agent/issues/new?template=provider_or_agent.yml");
  }
  if (!hasLocalSource) warnings.push("no supported Claude Code, Codex, or Gemini CLI session evidence found — the default receipt will remain empty; use --sample only for the labeled demo");
  if (providerRefs.length === 0) warnings.push("no provider admin keys detected — set up and sync an OpenAI/Anthropic admin connector for provider-reported cost (local logs stay API-equivalent estimates)");

  const predictedMode = connectedStateTrusted
    ? "connected provider billing"
    : hasFinancialLogs
      ? "your local agent logs (estimated at API-equivalent rates)"
      : geminiPresenceFound
        ? "local Gemini CLI presence only (financial evidence unavailable; no sample substituted)"
      : "no supported evidence yet (no sample substituted)";

  const lines = [
    "aibill doctor",
    `node version: ${process.version}`,
    `cli version: ${await cliVersion()}`,
    runtime.telemetryDisclosure === true
      ? `local-first mode: enabled (evidence stays local · ${telemetryDisclosureLine})`
      : "local-first mode: enabled (no cloud upload, no telemetry)",
    `path: ${rootPath}`,
    `state directory: ${stateDir}`,
    `state mode: ${stateMode}`,
    `Claude Code logs: ${claudeFound ? "found" : "not found"}`,
    `Codex logs: ${codexFound ? "found" : "not found"}`,
    `Gemini CLI sessions: ${geminiFinancialFound
      ? "found"
      : geminiPresenceFound
        ? "detected, but no supported chats financial rows found"
        : "not found"}`,
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

  let localLogs: Awaited<ReturnType<typeof loadLocalAgentFinancialUsage>> | undefined;
  let localError: string | undefined;
  try {
    localLogs = await loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR
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
    // Multi-account honesty: when this provider's records carry account
    // slices (one Admin key covers ONE organization), name every slice so a
    // second org's sync is visibly accumulated rather than silently merged.
    const accountSliceNote = records.some((record) => typeof record.source.account === "string")
      ? ` Account slices: ${formatProviderAccountSlices(providerAccountSlices(records, id))}.`
      : "";
    // QA M1: two slices holding identical records are almost certainly one
    // organization synced under two references — the combined total counts
    // it twice, so doctor must say so where the slices are listed.
    const duplicateSliceNote = duplicateProviderAccountSliceWarnings(records, id)
      .map((warning) => ` WARNING: ${warning}`)
      .join("");
    observations.push({
      id,
      financialEvidence: evidence,
      financialEvidenceNote: `${providerFinancialEvidenceNote(records, evidence)}${accountSliceNote}${duplicateSliceNote}`,
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
    if (scan.agent === "gemini-cli" && (scan.detectionSignals ?? 0) > 0 &&
        scan.filesDiscovered === 0) {
      return "Gemini CLI detected, but no supported chats JSON/JSONL financial evidence was found. logs.json is presence-only evidence; zero financial rows were created. Need this coverage? +1 or contribute a synthetic fixture: https://github.com/futurastudio/ai-spend-agent/issues/new?template=provider_or_agent.yml";
    }
    if (scan.filesDiscovered === 0) {
      return "The local transcript directory was readable, but no supported session files were found.";
    }
    if (scan.unreadableFiles > 0) {
      return `${scan.filesDiscovered} transcript file(s) were found, but ${scan.unreadableFiles} could not be read; absence of usage cannot be confirmed.`;
    }
    if (scan.malformedLines > 0) {
      return `${scan.filesDiscovered} transcript file(s) were found, but no valid usage rows were parsed; ${scan.malformedLines} malformed session record(s) were skipped.`;
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
  const malformed = relevant.filter((diagnostic) => (
    diagnostic.code === "malformed_jsonl" || diagnostic.code === "malformed_session_file"
  ));
  const messages = [...new Set(
    relevant
      .filter((diagnostic) => ![
        "unsupported_token_shape",
        "malformed_jsonl",
        "malformed_session_file"
      ].includes(diagnostic.code))
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
    messages.push(`${malformedCount} malformed session record(s) were skipped in ${localAgentFormatLabel(malformed[0]!.agent)} transcripts.`);
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
  // NEW-B3 (cold-start audit): every project-scoped command reachable from a
  // broad root produces the SAME friendly exact-project guidance — never the
  // raw scan refusal, never the crash wrapper.
  const rootGuard = await guardExactProjectRoot("reset", args.path);
  if (rootGuard) return rootGuard;

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
      "next run will re-read your real local agent logs; no sample is substituted without --sample."
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
    "next run will re-read your real local agent logs; no sample is substituted without --sample."
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
  if (action === "expand") return expandStatuslineCommand(runtime);
  return {
    exitCode: 1,
    stdout: "",
    stderr: `Unknown statusline action: ${sanitizeSecretishError(action)}\n` +
      "Use: npx aibill statusline [refresh|install|uninstall|expand]"
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
      "The renderer reads only the private aibill cache; it never reads Claude's session stdin as financial evidence.",
      // Static pointer only — never a prompt (capture design moments map).
      signupCopy.statuslinePointer
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
    ? "\nTo replace an existing status line explicitly: npx aibill statusline install --replace"
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

  // NEW-B3 (cold-start audit): init from a broad root used to crash-wrap the
  // raw scan refusal ("unexpected error … open an issue") — for a by-design
  // guard, on the funnel's second command. Friendly guidance instead.
  const rootGuard = await guardExactProjectRoot("init", args.path);
  if (rootGuard) return rootGuard;

  let detectedPlanOverride: DetectedPlan[] | undefined;
  if (args.plan) {
    const override = planOverrideFromFlag(args.plan);
    if (!override) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unknown --plan "${sanitizeSecretishError(args.plan)}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
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
    cacheStatus,
    ...(runtime.telemetryDisclosure !== undefined ? { telemetryDisclosure: runtime.telemetryDisclosure } : {})
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
    logs = await loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
      claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
      codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
      geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR,
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
      ? selectProviderFinancialHeadlineRecords(applyProviderContractGate(persisted.records))
    : [];

  let activitySnapshot: ActivitySnapshot | undefined;
  let cacheStatus: ActivityCacheRefreshResult["cacheStatus"];
  const statuslineSourceScans = logs?.sourceScans.filter((scan) => (
    localAgentFormatSupports(scan.agent, "statuslineSnapshot")
  )) ?? [];
  const structuredSourceFailure = logs !== undefined &&
    statuslineSourceScans.some((scan) => scan.directoryStatus === "unreadable") &&
    !statuslineSourceScans.some((scan) => scan.directoryStatus === "readable");
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
        stderr: `Unknown --plan "${sanitizeSecretishError(args.plan)}". Valid plans: ${subscriptionPlans.map((plan) => plan.id).join(", ")}`
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
  // C-lane §2.1 (QA-12c): a cache-refreshing run re-copies OUR OWN previously
  // installed runner so a frozen v1 copy picks up the current runtime — the
  // same consent as the original `statusline install`. Unowned or absent
  // installs are never touched, and a copy failure never fails the refresh.
  try {
    await refreshOwnedStatuslineRunner({
      homeDir: runtime.homeDirectory ?? homedir(),
      cwd: resolve(args.path),
      runnerContents: await packagedStatuslineRunner(runtime)
    });
  } catch {
    // Best-effort only; the refreshed cache remains valid either way.
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

/**
 * C-lane §2.4: `aibill statusline expand` — the teach-the-marker surface.
 * Renders FROM the canonical result card (converted from the private v2
 * snapshot; `runways[]` carries both limits), never bypassing the contract.
 * Printed command output, not a hook line.
 */
async function expandStatuslineCommand(runtime: CliRuntimeOptions): Promise<CliResult> {
  const cache = await readStatuslineCache({
    cacheDirectory: process.env.AIBILL_CACHE_DIR,
    homeDirectory: runtime.homeDirectory
  });
  if (cache.status !== "ok") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: cache.status === "missing"
        ? "aibill statusline expand needs a refreshed private cache: run `npx aibill statusline refresh` first."
        : "aibill statusline expand could not read the private cache safely; run `npx aibill statusline refresh`."
    };
  }
  const now = runtime.statuslineNow ?? new Date();
  const snapshot = cache.snapshot;
  if (snapshot.mode === "empty" || snapshot.mode === "error" || !snapshot.subscription) {
    return ok([
      "aibill subscriptions · 30d window",
      "  no detected subscription evidence in the private cache",
      "  run `npx aibill statusline refresh` after using Claude Code or Codex"
    ].join("\n"));
  }
  const card = statuslineSnapshotToResultCard(snapshot, now);
  return ok(renderStatuslineExpansion(card, snapshot, now, runtime.statuslineTimeZone));
}

const EXPANSION_FIVE_HOUR_FRESH_MS = 5 * 60 * 60 * 1_000;
const EXPANSION_WEEKLY_FRESH_MS = 24 * 60 * 60 * 1_000;

type ExpansionSnapshot = NonNullable<Awaited<ReturnType<typeof readStatuslineCache>> extends infer R
  ? R extends { status: "ok"; snapshot: infer S } ? S : never
  : never>;

/** Fresh limits only (existing statusline freshness rules), most-urgent first, max 2. */
function expansionRunways(
  limits: ReadonlyArray<{
    kind: "five-hour" | "weekly";
    remainingPercent: number;
    observedAt: string;
    resetsAt: string;
  }>,
  now: Date
): ResultCardRunway[] {
  return limits
    .filter((limit) => {
      const observedMs = Date.parse(limit.observedAt);
      const ageMs = now.getTime() - observedMs;
      const maxAgeMs = limit.kind === "five-hour"
        ? EXPANSION_FIVE_HOUR_FRESH_MS
        : EXPANSION_WEEKLY_FRESH_MS;
      return Number.isFinite(observedMs) && ageMs >= 0 && ageMs <= maxAgeMs &&
        Date.parse(limit.resetsAt) > now.getTime();
    })
    .map((limit) => ({
      kind: limit.kind,
      remainingPercent: limit.remainingPercent,
      resetsAt: new Date(Date.parse(limit.resetsAt)).toISOString()
    }))
    .sort((left, right) => left.remainingPercent - right.remainingPercent ||
      Date.parse(left.resetsAt) - Date.parse(right.resetsAt))
    .slice(0, 2);
}

/** Convert the private snapshot into the canonical result card (§2.4). */
function statuslineSnapshotToResultCard(snapshot: ExpansionSnapshot, now: Date): ResultCard {
  const subscriptions: ResultCard["subscriptions"] = [];
  for (const agent of snapshot.subscription?.agents ?? []) {
    const sevenDays = agent.apiEquivalent.sevenDays;
    const plan = agent.planId
      ? subscriptionPlans.find((candidate) => candidate.id === agent.planId)
      : undefined;
    subscriptions.push({
      id: agent.agent === "claude-code" ? "claude" : "chatgpt",
      agentId: agent.agent,
      planLabel: plan
        ? plan.name.replace(/^Claude /u, "").replace(/^ChatGPT /u, "")
        : null,
      connection: "local_logs",
      committedUsdPerMonth: agent.committedUsdPerMonth ?? null,
      // 7d figures: same basis, same window, summable (§2.4); the /7d window
      // is always printed next to every figure.
      apiEquivalentUsd: sevenDays.amountUsd !== null && sevenDays.financialEvidence === "estimated"
        ? sevenDays.amountUsd
        : null,
      providerBilledUsd: null,
      detectedUnverifiedUsd: null,
      runways: expansionRunways(agent.limits, now)
    });
  }
  for (const provider of snapshot.providers ?? []) {
    subscriptions.push({
      id: provider.provider,
      agentId: null,
      planLabel: provider.planLabel,
      connection: "connected",
      committedUsdPerMonth: provider.committedUsdPerMonth,
      apiEquivalentUsd: null,
      // Renderer-side lock: only verified provider dollars are billed money.
      providerBilledUsd: provider.billed30d.financialEvidence === "verified" &&
          provider.billed30d.amountUsd !== null
        ? provider.billed30d.amountUsd
        : null,
      detectedUnverifiedUsd: null,
      runways: []
    });
  }
  const pricedRows = subscriptions.filter((row) => row.committedUsdPerMonth !== null);
  const apiAmounts = subscriptions
    .map((row) => row.apiEquivalentUsd)
    .filter((amount): amount is number => amount !== null);
  const billedAmounts = subscriptions
    .map((row) => row.providerBilledUsd)
    .filter((amount): amount is number => amount !== null);
  const apiTotal = apiAmounts.length > 0
    ? Math.round(apiAmounts.reduce((total, amount) => total + amount, 0) * 100) / 100
    : null;
  const billedTotal = billedAmounts.length > 0
    ? Math.round(billedAmounts.reduce((total, amount) => total + amount, 0) * 100) / 100
    : null;
  return resultCardSchema.parse({
    kind: "aibill.result_card",
    schemaVersion: 1,
    currency: "USD",
    windowDays: 30,
    mode: snapshot.providers && snapshot.providers.length > 0 ? "mixed" : "local-logs",
    subscriptions,
    totals: {
      subscriptionCommitted: {
        amountUsd: pricedRows.length > 0
          ? pricedRows.reduce((total, row) => total + (row.committedUsdPerMonth ?? 0), 0)
          : null,
        pricedSubs: pricedRows.length,
        totalSubs: subscriptions.length
      },
      apiEquivalent: {
        amountUsd: apiTotal,
        financialEvidence: apiTotal === null ? "missing" : "estimated"
      },
      providerBilled: {
        amountUsd: billedTotal,
        financialEvidence: billedTotal === null ? "missing" : "verified"
      },
      blended: null,
      blendPolicy: "never_blended"
    },
    byProject: null
  });
}

function renderStatuslineExpansion(
  card: ResultCard,
  snapshot: ExpansionSnapshot,
  now: Date,
  timeZone?: string
): string {
  const lines: string[] = [`aibill subscriptions · ${card.windowDays}d window`];
  for (const row of card.subscriptions) {
    const parts: string[] = [];
    parts.push(row.committedUsdPerMonth !== null
      ? `${formatCommittedPerMonth(row.committedUsdPerMonth).padStart(7)} committed`
      : "committed not reported");
    for (const runway of row.runways) {
      const kindLabel = runway.kind === "five-hour" ? "5h" : "wk";
      parts.push(`${kindLabel} ${formatExpansionPercent(runway.remainingPercent)}% ↻${formatExpansionReset(runway, now, timeZone)}`);
    }
    if (row.apiEquivalentUsd !== null) {
      parts.push(`~$${Math.round(row.apiEquivalentUsd)}/7d`);
    } else if (row.agentId !== null) {
      parts.push("API-equivalent not reported");
    }
    if (row.agentId === null) {
      parts.push(row.providerBilledUsd !== null
        ? `${formatBilledUsdExact(row.providerBilledUsd)} billed/30d`
        : "billed not reported (beta)");
    }
    const planCell = (row.planLabel ?? (row.connection === "connected" ? "connected" : "detected")).padEnd(9);
    lines.push(`  ${row.id.padEnd(10)}${planCell}${parts.join(" · ")}`);
  }
  const totalParts: string[] = [];
  const committed = card.totals.subscriptionCommitted;
  if (committed.amountUsd !== null) {
    const partial = committed.pricedSubs < committed.totalSubs
      ? ` (${committed.pricedSubs}/${committed.totalSubs} priced)`
      : "";
    totalParts.push(`committed ${formatCommittedPerMonth(committed.amountUsd)}${partial}`);
  } else if (committed.totalSubs > 0) {
    totalParts.push("committed not reported");
  }
  if (card.totals.apiEquivalent.amountUsd !== null) {
    totalParts.push(`API-equivalent ~$${Math.round(card.totals.apiEquivalent.amountUsd)}/7d`);
  } else if (card.subscriptions.some((row) => row.agentId !== null)) {
    totalParts.push("API-equivalent not reported");
  }
  if (card.totals.providerBilled.amountUsd !== null) {
    totalParts.push(`billed ${formatBilledUsdExact(card.totals.providerBilled.amountUsd)}/30d`);
  }
  lines.push(`  ${"total".padEnd(10)}${totalParts.join(" · ")}`);
  lines.push(`  ~ = usage at published API rates (estimated, never billed) · ${expansionFreshness(snapshot, now)}`);
  // A stale or pre-upgrade snapshot honestly reports "not reported" for plan
  // pricing the receipt already knows. Tell the user the one command that
  // fixes it instead of leaving the two surfaces looking inconsistent.
  if (committed.amountUsd === null && committed.totalSubs > 0) {
    lines.push("  plan pricing missing from this snapshot — run: npx aibill statusline refresh");
  }
  return lines.join("\n");
}

function formatExpansionPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

function formatExpansionReset(
  runway: ResultCardRunway,
  now: Date,
  timeZone?: string
): string {
  const reset = new Date(runway.resetsAt);
  const zone = validExpansionTimeZone(timeZone) ? timeZone : undefined;
  if (runway.kind === "weekly") {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: zone }).format(reset);
  }
  const dateKey = (value: Date): string => new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone
  }).format(value);
  const sameDay = dateKey(reset) === dateKey(now);
  const formatter = new Intl.DateTimeFormat("en-US", sameDay ? {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone
  } : {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone
  });
  return formatter.format(reset).replaceAll(" ", "").toLowerCase().replace(":00", "");
}

function validExpansionTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function expansionFreshness(snapshot: ExpansionSnapshot, now: Date): string {
  const referenceMs = Date.parse(snapshot.lastSuccessAt ?? snapshot.generatedAt);
  const ageMs = now.getTime() - referenceMs;
  if (!Number.isFinite(referenceMs) || ageMs < 0) return "clock mismatch";
  const seconds = Math.floor(ageMs / 1_000);
  const age = seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 48 * 3_600
        ? `${Math.floor(seconds / 3_600)}h`
        : `${Math.floor(seconds / 86_400)}d`;
  // Same freshness vocabulary as the statusline runner: state the cache age
  // as fact instead of calling minutes-old data "stale".
  return ageMs > 5 * 60 * 1_000 ? `cache ${age} old` : `updated ${age}`;
}

async function preflightInitCache(cacheDirectory: string | undefined): Promise<void> {
  const existing = await readActivitySnapshot({ cacheDirectory });
  if (existing.status !== "error") return;
  const cacheDirectoryPath = dirname(activitySnapshotCachePath({
    ...(cacheDirectory ? { cacheDirectory } : {})
  }));
  // A missing or pre-created-but-EMPTY cache directory holds nothing to
  // preserve — typically a first run whose home state was stamped before
  // any cache existed, or a user-made dir with default (non-0700)
  // permissions. Init's own create path re-validates and tightens it to
  // 0700, so proceeding is safe; only a directory with actual contents
  // aborts (shipped-audit fix; cold-start audit NEW-B1: the old check
  // required cache/ to EXIST, so first runs dead-ended here).
  if (existing.code === "unsafe_directory" && await isMissingOrEmptyRealDirectory(cacheDirectoryPath)) {
    return;
  }
  // NEW-B1(d): name the path and the one-line rescue — "remove the cache
  // explicitly" with no path was unactionable.
  const parentPath = dirname(cacheDirectoryPath);
  const rescue = existing.code === "unsafe_directory"
    ? ` One-line rescue: chmod 700 ${parentPath} ${cacheDirectoryPath} — then rerun init.`
    : ` Remove it explicitly before rebuilding it.`;
  throw new Error(
    `Existing private activity cache (${cacheDirectoryPath}) is ${existing.code.replaceAll("_", " ")}; ` +
    `it was preserved and init stopped.${rescue}`
  );
}

async function isMissingOrEmptyRealDirectory(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    // Not there yet: nothing to preserve, init's create path builds it 0700.
    return isNodeError(error, "ENOENT");
  }
  try {
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
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
  telemetryDisclosure?: boolean;
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
  const registryOnlyLines = initRegistryOnlyFinancialLines(records);
  const sourceFailures = (input.logs?.sourceScans ?? []).some((scan) => scan.directoryStatus === "unreadable") ||
    (input.logs?.diagnostics ?? []).some((diagnostic) => diagnostic.severity === "error");
  const snapshotLines = input.scanError || sourceFailures && records.length === 0
    ? ["API-equivalent usage value: unavailable — the local scan could not prove an empty result"]
    : input.activitySnapshot
      ? initApiEquivalentWindowLines(input.activitySnapshot)
      : ["API-equivalent usage value: unavailable — no snapshot was produced"];
  const receiptLines = registryOnlyLines.length > 0 &&
      input.activitySnapshot?.mode === "empty" && !input.scanError
    ? registryOnlyLines
    : [...snapshotLines, ...registryOnlyLines];

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
    const detection = (scan.detectionSignals ?? 0) > 0
      ? `; ${scan.detectionSignals} presence-only signal(s)`
      : "";
    return `  ${scan.agent}: ${scan.directoryStatus}; ${scan.filesParsed}/${scan.filesDiscovered} files parsed; ${priced}/${agentRecords.length} rows priced${detection}${skipped > 0 ? `; ${skipped} old files skipped` : ""}${validation}`;
  });
  const diagnosticLines = (input.logs?.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code !== "directory_missing")
    .map((diagnostic) => `  ! ${sanitizeSecretishError(diagnostic.message)} (${diagnostic.count})`);

  const providerLines = formatInitProviderEvidence(input);

  return [
    "aibill init",
    `state project: ${sanitizeSecretishError(basename(input.rootPath))}`,
    "local usage scope: supported Claude Code, Codex, and Gemini CLI financial evidence on this machine (last 30 days)",
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
    `status cache: ${input.cacheStatus} · private local aggregate · ${uploadsNothingLine(input.telemetryDisclosure, "nothing uploaded")}`,
    "state: .ai-spend-agent",
    "manifest: written last",
    // Static pointer only, ABOVE the strict single next-command exit line —
    // init's `next:` line stays last (capture design moments map).
    signupCopy.initPointer,
    "next: npx aibill doctor --sources"
  ].filter((line) => line !== "").join("\n");
}

function initRegistryOnlyFinancialLines(records: readonly UsageRecord[]): string[] {
  const lines: string[] = [];
  for (const descriptor of localAgentFormatDescriptors) {
    if (descriptor.capabilities.statuslineSnapshot) continue;
    const sourceRecords = records.filter((record) => record.agentId === descriptor.id);
    if (sourceRecords.length === 0) continue;
    const priced = sourceRecords.filter((record) => typeof record.amountUsd === "number");
    if (priced.length === 0) {
      lines.push(`${descriptor.id} API-equivalent value: unavailable — ${sourceRecords.length} observed row(s) lacked complete token components or a supported model price`);
      continue;
    }
    const amount = analyzeSpend(priced).totalUsd;
    const unpriced = sourceRecords.length - priced.length;
    lines.push(
      `${descriptor.id} experimental value: ~${formatOptionalUsd(amount)} 30d (API-equivalent; fixture-verified; not billed spend${unpriced > 0 ? `; ${unpriced} row(s) unpriced` : ""})`
    );
  }
  return lines;
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
      ? "API-equivalent usage value: unavailable — no priced evidence was observed in readable local sources"
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
  // NEW-B3 (cold-start audit): the bare raw refusal tier is gone — scan
  // gives the same friendly exact-project guidance as every other
  // project-scoped command.
  const rootGuard = await guardExactProjectRoot("scan", args.path);
  if (rootGuard) return rootGuard;
  const rootPath = resolve(args.path);

  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });

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
    lines.push(`total spend: ${formatOptionalUsd(summary.totalUsd)}`);
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
  // NEW-B3 (cold-start audit): every project-scoped command reachable from a
  // broad root produces the SAME friendly exact-project guidance — never the
  // raw scan refusal, never the crash wrapper.
  const rootGuard = await guardExactProjectRoot("watch", args.path);
  if (rootGuard) return rootGuard;

  const rootPath = resolve(args.path);
  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });

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
    if (records.length === 0) {
      return noEvidenceResult("watch", [], args.sinceDays ?? 30);
    }
    const deltaHeadline = buildDeltaHeadline(previous, snapshot);
    // Watch's job is DELTAS: render the compact breakdown view per cycle, not
    // the whole diagnose→verify readout again (the quickstart owns that).
    const plainEnglish = generatePlainEnglishSummary(summary, {
      records,
      groupBy: args.groupBy ?? "model",
      color: args.noColor ? false : undefined,
      mode: mode === "sample" ? "demo" : mode === "connected_provider" ? "connected" : "local-logs",
      width: terminalOutputWidth(),
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
  totalUsd: number | null;
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
      records = applyProviderContractGate(persisted.records);
      mode = "connected_provider";
    } else {
      // Same freshness rule as quickstart/report: re-read local logs live,
      // never serve a stale snapshot.
      const logs = await loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
        claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
        codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
        geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR
      }).catch(() => undefined);
      if (logs && logs.records.length > 0) {
        records = logs.records;
        mode = "local_logs";
      } else {
        records = [];
        mode = "local_logs";
      }
    }
  }

  const headlineRecords = mode === "connected_provider"
    ? selectProviderFinancialHeadlineRecords(applyProviderContractGate(records))
    : records;
  const summary = analyzeSpend(headlineRecords);
  const financialAmountAvailable = headlineRecords.some((record) => typeof record.amountUsd === "number");
  const mappings = attributeUsageRecords(records);
  if (mode !== "connected_provider") {
    await writeLocalSpendState(stateDir, records, summary, mappings, mode);
  }

  const snapshot: WatchSnapshot = {
    capturedAt: new Date().toISOString(),
    totalUsd: financialAmountAvailable ? summary.totalUsd : null,
    recordCount: summary.recordCount,
    byModel: financialAmountAvailable
      ? summary.byModel.map((entry) => ({ key: entry.key, amountUsd: entry.amountUsd }))
      : []
  };

  // Append to the rolling history and persist the latest snapshot for the next run.
  const history = await readOptionalJson<WatchSnapshot[]>(join(stateDir, "watch-history.json"), []);
  await writeJson(join(stateDir, "watch-history.json"), [...history, snapshot].slice(-200));
  await writeJson(join(stateDir, "watch-latest.json"), snapshot);
  await appendAuditEvent(stateDir, {
    timestamp: snapshot.capturedAt,
    action: "scan_completed",
    sourceId: "watch",
    detail: snapshot.totalUsd === null
      ? `Watch cycle captured ${snapshot.recordCount} records with no priced financial evidence; total unavailable.`
      : `Watch cycle captured ${snapshot.recordCount} records totaling ${formatOptionalUsd(snapshot.totalUsd)}.`
  });

  return { summary, snapshot, records: headlineRecords, mode };
}

function buildDeltaHeadline(previous: WatchSnapshot | null, current: WatchSnapshot): string {
  if (!previous) {
    if (current.totalUsd === null) {
      return `First watch snapshot. Financial baseline is unavailable across ${current.recordCount} records; missing/null is not zero. Future priced cycles will establish a numeric baseline.`;
    }
    return `First watch snapshot. Baseline AI spend is ${formatOptionalUsd(current.totalUsd)} across ${current.recordCount} charges. Future cycles will report what changed.`;
  }

  if (current.totalUsd === null) {
    return `Financial evidence is unavailable across ${current.recordCount} records; missing/null is not zero and no numeric delta was calculated.`;
  }
  if (previous.totalUsd === null) {
    return `A priced financial baseline is now available at ${formatOptionalUsd(current.totalUsd)} across ${current.recordCount} records. The prior snapshot was unavailable, so no numeric delta was calculated.`;
  }

  const deltaUsd = roundMoneyCli(current.totalUsd - previous.totalUsd);
  const lines: string[] = [];

  if (deltaUsd === 0) {
    lines.push(`No change since the last check: AI spend is holding at ${formatOptionalUsd(current.totalUsd)}.`);
  } else {
    const direction = deltaUsd > 0 ? "UP" : "DOWN";
    const percent = previous.totalUsd > 0 ? Math.round((deltaUsd / previous.totalUsd) * 100) : 100;
    lines.push(
      `Spend is ${direction} ${formatOptionalUsd(Math.abs(deltaUsd))} (${Math.abs(percent)}%) since the last check — ` +
        `from ${formatOptionalUsd(previous.totalUsd)} to ${formatOptionalUsd(current.totalUsd)}.`
    );
  }

  // New-model and per-model spike detection versus the previous snapshot.
  const previousModels = new Map(previous.byModel.map((entry) => [entry.key, entry.amountUsd]));
  const anomalies: string[] = [];
  for (const entry of current.byModel) {
    const before = previousModels.get(entry.key);
    if (before === undefined) {
      if (entry.amountUsd >= 1) {
        anomalies.push(`New model "${entry.key}" appeared, already at ${formatOptionalUsd(entry.amountUsd)}.`);
      }
      continue;
    }
    if (before > 0 && entry.amountUsd - before >= 5 && entry.amountUsd / before >= 1.5) {
      anomalies.push(`"${entry.key}" jumped from ${formatOptionalUsd(before)} to ${formatOptionalUsd(entry.amountUsd)}.`);
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
  return Math.round(value * 10_000) / 10_000;
}

async function addSourceCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  if (!args.sourcePath || !args.sourceType || !args.label) {
    return { exitCode: 1, stdout: "", stderr: "add-source requires --source-path, --type, and --label" };
  }

  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
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
  // Cursor's Admin API is gated to Enterprise teams (cursor.com/docs/api);
  // Business/Teams keys are rejected with 401/403.
  cursor: "requires a Cursor TEAM-ADMIN key (Enterprise teams only)",
  "github-copilot": "requires a GitHub BILLING-ADMIN token (org/enterprise)",
  copilot: "requires a GitHub BILLING-ADMIN token (org/enterprise)"
};

const supportedAdminProviders = new Set(["openai", "anthropic", "cursor", "github-copilot"]);
const providerAliases: Record<string, string> = {
  copilot: "github-copilot"
};

const providerAdminEnvHint: Record<string, string> = {
  openai: "env:OPENAI_ADMIN_KEY",
  anthropic: "env:ANTHROPIC_ADMIN_KEY",
  cursor: "env:CURSOR_ADMIN_KEY",
  "github-copilot": "env:GITHUB_TOKEN",
  copilot: "env:GITHUB_TOKEN"
};

function providerSyncSetupCommand(provider: string, adminRef: string): string {
  if (provider === "cursor") {
    return `npx aibill sync-provider --provider cursor --auth-reference ${adminRef} --account-id <team-label>`;
  }
  if (provider === "github-copilot") {
    return `npx aibill sync-provider --provider github-copilot --auth-reference ${adminRef} --org <organization>`;
  }
  const thirtyDaysAgoUnix = Math.floor(Date.now() / 1_000) - 30 * 24 * 60 * 60;
  return `npx aibill sync-provider --provider ${provider} --auth-reference ${adminRef} --start-time ${thirtyDaysAgoUnix}`;
}

async function connectCommand(args: ParsedArgs): Promise<CliResult> {
  // NEW-B3 (cold-start audit): every project-scoped command reachable from a
  // broad root produces the SAME friendly exact-project guidance — never the
  // raw scan refusal, never the crash wrapper.
  const rootGuard = await guardExactProjectRoot("connect", args.path);
  if (rootGuard) return rootGuard;

  const rootPath = resolve(args.path);
  const requestedProvider = (args.provider ?? "unknown").trim().toLowerCase();
  const provider = providerAliases[requestedProvider] ?? requestedProvider;
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
  if (!supportedAdminProviders.has(provider) || type !== "provider_api") {
    const reason = !supportedAdminProviders.has(provider)
      ? `connect does not implement provider "${sanitizeSecretishError(requestedProvider)}".`
      : `connect supports provider_api only; received "${sanitizeSecretishError(type)}".`;
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        reason,
        "Supported admin connectors: openai, anthropic, cursor, github-copilot.",
        "For an approved file/export boundary, use `npx aibill add-source` instead."
      ].join("\n")
    };
  }
  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
  const registry = await readSourceRegistry(stateDir, rootPath);
  const source = createProviderConnectorStub(provider, type);
  const nextRegistry = addApprovedSource(registry, source);
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
    `secrets: no raw secrets stored; we only reference a local env var such as ${providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY"}`
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
      lines.push(`next: ${providerSyncSetupCommand(provider, adminRef)}`);
    } else {
      const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
      lines.push(`this looks like a regular key — for COST data set an admin key in ${adminRef}, then:`);
      lines.push(`  ${providerSyncSetupCommand(provider, adminRef)}`);
    }
  } else {
    const adminRef = providerAdminEnvHint[provider] ?? "env:YOUR_ADMIN_KEY";
    lines.push("");
    lines.push(`next: export an admin key reference, e.g. ${adminRef}, then run:`);
    lines.push(`  ${providerSyncSetupCommand(provider, adminRef)}`);
    lines.push("  (that start time is 30 days ago; change it to widen the window)");
  }

  if (provider === "openai") {
    lines.push(
      "multi-org: an Admin API key covers ONE organization; repeat the sync with a separate env reference per org (e.g. env:OPENAI_ADMIN_KEY_ORG2) — org totals accumulate"
    );
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
  let stateDir = join(rootPath, ".ai-spend-agent");
  let stateBoundaryReady = false;
  const requestedProvider = (args.provider ?? "").trim().toLowerCase();
  const provider = providerAliases[requestedProvider] ?? requestedProvider;
  if (!provider) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "sync-provider requires --provider.",
        "Supported admin connectors: openai, anthropic, cursor, github-copilot."
      ].join("\n")
    };
  }
  if (!supportedAdminProviders.has(provider)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `sync-provider does not implement provider "${sanitizeSecretishError(requestedProvider)}".`,
        "Supported admin connectors: openai, anthropic, cursor, github-copilot."
      ].join("\n")
    };
  }
  if (!args.authReference) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `sync-provider ${provider} requires --auth-reference env:NAME; raw secrets are not accepted.`
    };
  }
  const usesRequestedTimeBounds = provider === "openai" || provider === "anthropic";
  if (usesRequestedTimeBounds && args.startTime === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `sync-provider ${provider} requires --start-time <unix seconds>; --end-time is optional.`,
        `example: npx aibill sync-provider --provider ${provider} --auth-reference ${providerAdminEnvHint[provider]} --start-time 1750000000`
      ].join("\n")
    };
  }
  if (!usesRequestedTimeBounds && (args.startTime !== undefined || args.endTime !== undefined)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: provider === "cursor"
        ? "Cursor Admin spend is returned for the provider's current team subscription cycle; --start-time/--end-time are not accepted because the connector cannot enforce them."
        : "GitHub Copilot returns its latest metrics-report window plus current seat data; --start-time/--end-time are not accepted because the connector cannot enforce them."
    };
  }
  if (provider === "github-copilot" && Boolean(args.org) === Boolean(args.enterprise)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "GitHub Copilot sync requires exactly one of --org <organization> or --enterprise <enterprise>."
    };
  }

  try {
    stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
    stateBoundaryReady = true;
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
      provider,
      sourceId: `${provider}-provider-api`,
      authReference: args.authReference,
      // Core keeps a single connector input contract. Non-time-bounded
      // adapters ignore this sentinel and the CLI rejects user-supplied bounds
      // above so no requested interval can be silently discarded.
      startTime: usesRequestedTimeBounds ? args.startTime! : 0,
      endTime: args.endTime,
      org: args.org,
      enterprise: args.enterprise,
      accountId: args.accountId
    });
    // Admin credentials are account-scoped (an OpenAI Admin key covers ONE
    // organization). Each sync belongs to one account slice: different slices
    // of the same provider accumulate, re-syncing the same slice replaces it,
    // and unlabeled legacy rows are replaced fail-closed (never double-count).
    const accountKey = providerAccountKey({
      provider,
      authReference: args.authReference,
      org: args.org,
      enterprise: args.enterprise,
      accountId: args.accountId
    });
    const syncedRecords = tagProviderAccountRecords(
      applyProviderContractGate(result.records),
      accountKey
    );
    const syncedFinancials = summarizeProviderFinancials(syncedRecords);
    const syncedCompleteness = providerFinancialCompleteness(syncedRecords, result.coverage);
    const syncedSource = createProviderConnection({
      provider: result.provider,
      sourceId: result.source.id,
      authReference: args.authReference,
      verifiedRecordCount: syncedRecords.length,
      totalUsd: syncedFinancials.headlineUsd,
      completeness: syncedCompleteness,
      fetchedAt: new Date(result.fetchedAt)
    });
    const retainedPriorRecords = retainProviderRecordsForNewSync(
      trustedPrior?.records ?? [],
      result.provider,
      accountKey,
      syncedRecords
    );
    const records = applyProviderContractGate([
      ...retainedPriorRecords,
      ...syncedRecords
    ]).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const registry = await readSourceRegistry(stateDir, rootPath);
    const nextRegistry = addApprovedSource(registry, syncedSource);
    const headlineRecords = selectProviderFinancialHeadlineRecords(records);
    const summary = analyzeSpend(headlineRecords);
    const mappings = attributeUsageRecords(records);
    // Whether prior account slices of THIS provider survived the merge. When
    // they did, the provider-keyed accounting maps below must stay honest for
    // the union of slices, not just the slice this run fetched.
    const retainedSameProviderSlices = retainedPriorRecords.some(
      (record) => record.source.provider === result.provider
    );
    const qaByProvider = {
      ...trustedAccountingMap<ProviderQaSummary>(trustedPrior?.accounting, "qaByProvider"),
      [result.provider]: result.qa
    };
    const priorProviderCoverage = trustedAccountingMap<ProviderCoverageStatus>(
      trustedPrior?.accounting,
      "coverageByProvider"
    )[result.provider];
    // Fail-closed coverage: a provider is complete only when this sync AND
    // every retained slice were complete. Known ratchet (QA m4): per-slice
    // coverage is not persisted, so with other slices retained a prior
    // "partial" sticks even after the offending slice re-syncs complete —
    // it only UNDER-claims, and recovers when the provider merges with no
    // other slices retained (single-slice re-sync), after `aibill
    // drop-slice` removes the stale slice, or after `aibill reset`. The
    // checkedAt merge below shares the same ratchet and recovery direction.
    const mergedProviderCoverage: ProviderCoverageStatus =
      retainedSameProviderSlices && priorProviderCoverage === "partial"
        ? "partial"
        : result.coverage;
    const coverageByProvider = {
      ...trustedAccountingMap<ProviderCoverageStatus>(trustedPrior?.accounting, "coverageByProvider"),
      [result.provider]: mergedProviderCoverage
    };
    // Financials span every retained slice of the provider plus this sync —
    // never just the account this run happened to fetch.
    const financialsByProvider = {
      ...trustedAccountingMap<unknown>(trustedPrior?.accounting, "financialsByProvider"),
      [result.provider]: summarizeProviderFinancials(
        records.filter((record) => record.source.provider === result.provider)
      )
    };
    const priorProviderCheckedAt = trustedAccountingMap<string>(
      trustedPrior?.accounting,
      "checkedAtByProvider"
    )[result.provider];
    // Freshness stays conservative: a retained slice keeps its older check
    // time, so an old account slice is never claimed as freshly checked.
    const mergedProviderCheckedAt =
      retainedSameProviderSlices &&
      typeof priorProviderCheckedAt === "string" &&
      validIsoString(priorProviderCheckedAt) &&
      priorProviderCheckedAt < result.fetchedAt
        ? priorProviderCheckedAt
        : result.fetchedAt;
    const checkedAtByProvider = {
      ...trustedAccountingMap<string>(trustedPrior?.accounting, "checkedAtByProvider"),
      [result.provider]: mergedProviderCheckedAt
    };
    const priorCoverageIntervals = trustedAccountingMap<ProviderCoverageInterval>(
      trustedPrior?.accounting,
      "coverageIntervalsByProvider"
    );
    const coverageIntervalsByProvider = Object.fromEntries(
      Object.entries(priorCoverageIntervals).filter(([provider]) => provider !== result.provider)
    ) as Record<string, ProviderCoverageInterval>;
    const requestedCoverageInterval = result.coverageInterval;
    // The provider's claimed window must hold for EVERY retained slice, so it
    // shrinks to the intersection — and disappears when slices do not overlap.
    const mergedProviderInterval = retainedSameProviderSlices
      ? intersectProviderCoverageIntervals(
          priorCoverageIntervals[result.provider],
          requestedCoverageInterval
        )
      : requestedCoverageInterval;
    if (mergedProviderInterval) {
      coverageIntervalsByProvider[result.provider] = mergedProviderInterval;
    }
    // Invalidate any earlier receipt before the first mutation. If a later
    // local write fails, the partially updated repository state stays
    // untrusted rather than inheriting the previous sync's authority.
    await invalidateConnectedSpendTrustReceipt(rootPath);
    await writeJson(join(stateDir, "sources.json"), nextRegistry);
    await writeJson(join(stateDir, "provider-records.json"), {
      provider: result.provider,
      fetchedAt: result.fetchedAt,
      completeness: syncedCompleteness,
      coverage: result.coverage,
      financials: syncedFinancials,
      sourceId: syncedSource.id,
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
      sourceId: syncedSource.id,
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
      `source: ${syncedSource.id}`,
      `boundary approval: ${syncedSource.boundaryApproval}`,
      `validation coverage: ${syncedSource.validationCoverage}`,
      `financial evidence: ${syncedSource.financialEvidence}`,
      `coverage: ${result.coverage}`,
      `records fetched: ${result.records.length}`,
      `account: ${accountKey}`,
      `provider accounts: ${formatProviderAccountSlices(providerAccountSlices(records, result.provider))}`,
      // QA M2: billed dollars never disappear without a word — every dropped
      // prior slice is named with its record count and billed sum.
      ...providerSliceReplacementNotices({
        provider: result.provider,
        accountKey,
        priorRecords: trustedPrior?.records ?? [],
        retainedRecords: retainedPriorRecords,
        syncedRecordCount: syncedRecords.length,
        syncedBilledUsd: syncedFinancials.providerReportedBilledUsd
      }).map((notice) => `notice: ${notice}`),
      // QA M1: identical inner record ids across two named slices are the
      // signature of one organization synced under two references.
      ...duplicateProviderAccountSliceWarnings(records, result.provider)
        .map((warning) => `warning: ${warning}`),
      provider === "cursor"
        ? "source window: current team subscription cycle returned by Cursor"
        : provider === "github-copilot"
          ? "source window: latest Copilot metrics-report window plus current seat data"
          : `source window: requested from ${new Date(args.startTime! * 1_000).toISOString()}${args.endTime === undefined ? " through provider current time" : ` through ${new Date(args.endTime * 1_000).toISOString()}`}`,
      `headline basis: ${syncedFinancials.headlineBasis}`,
      `synced provider headline: ${formatOptionalUsd(syncedFinancials.headlineUsd)}`,
      `combined headline spend: ${selectProviderFinancialHeadlineRecords(records).some((record) => typeof record.amountUsd === "number") ? formatOptionalUsd(summary.totalUsd) : "unavailable"}`,
      ...(syncedFinancials.apiEquivalentEstimatedUsd !== null
        ? [`API-equivalent estimate (kept separate): ${formatOptionalUsd(syncedFinancials.apiEquivalentEstimatedUsd)}`]
        : []),
      "auth: reference-only; raw secrets were not persisted or printed"
    ].join("\n"));
  } catch (error) {
    const sanitizedError = sanitizeSecretishError(error instanceof Error ? error.message : String(error), args.authReference);
    if (stateBoundaryReady) await recordProviderSourceAttempt(stateDir, provider, new Date().toISOString(), sanitizedError).catch(() => {
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

/**
 * `aibill drop-slice --provider X --account KEY` — remove one named account
 * slice from trusted connected state. This is the prune path for the
 * duplicate-slice diagnostic (one organization synced under two references)
 * and for a slice whose credential reference was renamed: without it the only
 * cleanup is a full `aibill reset` plus re-sync of every org. Local-only; no
 * provider is contacted; the re-signed state can only shrink totals.
 */
async function dropSliceCommand(args: ParsedArgs): Promise<CliResult> {
  const rootPath = resolve(args.path);
  const requestedProvider = (args.provider ?? "").trim().toLowerCase();
  const provider = providerAliases[requestedProvider] ?? requestedProvider;
  const accountKey = (args.account ?? "").trim();
  if (!provider || !supportedAdminProviders.has(provider) || !accountKey) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "drop-slice requires --provider (openai, anthropic, cursor, github-copilot) and --account <slice key>.",
        "List the slices first: npx aibill doctor --sources",
        "example: npx aibill drop-slice --provider openai --account env:OPENAI_ADMIN_KEY_ORG2"
      ].join("\n")
    };
  }

  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
  const persisted = await readPersistedSpend(rootPath);
  if (!persisted || persisted.mode !== "connected_provider" || persisted.connectedTrust?.trusted !== true) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "drop-slice requires trusted connected provider state. Run `npx aibill sync-provider ...` first, or `npx aibill reset` to clear all local state."
    };
  }

  const droppedRecords = persisted.records.filter((record) => (
    record.source.provider === provider && record.source.account === accountKey
  ));
  if (droppedRecords.length === 0) {
    const slices = providerAccountSlices(persisted.records, provider);
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `No ${provider} slice matches account "${sanitizeSecretishError(accountKey)}".`,
        slices.length > 0
          ? `Known ${provider} slices: ${formatProviderAccountSlices(slices)}`
          : `No ${provider} slices exist in local state.`,
        "Unlabeled legacy rows cannot be dropped by account; re-syncing the provider replaces them."
      ].join("\n")
    };
  }

  const records = persisted.records.filter((record) => !(
    record.source.provider === provider && record.source.account === accountKey
  ));
  const summary = analyzeSpend(selectProviderFinancialHeadlineRecords(records));
  const mappings = attributeUsageRecords(records);
  const providerRemaining = records.filter((record) => record.source.provider === provider);

  // Rebuild the provider-keyed accounting maps. Financials are recomputed
  // over the remaining slices; coverage/checkedAt/intervals are left as-is —
  // they can only UNDER-claim after a drop (partial stays partial, windows
  // stay narrow) and recover on the provider's next sync. A provider with no
  // remaining records loses its map entries entirely.
  const accounting: Record<string, unknown> = isPlainObject(persisted.accounting)
    ? { ...persisted.accounting }
    : {};
  for (const mapName of [
    "coverageByProvider",
    "checkedAtByProvider",
    "coverageIntervalsByProvider",
    "qaByProvider",
    "financialsByProvider"
  ]) {
    const prior = trustedAccountingMap<unknown>(persisted.accounting, mapName);
    if (Object.keys(prior).length === 0) continue;
    const next: Record<string, unknown> = { ...prior };
    if (providerRemaining.length === 0) {
      delete next[provider];
    } else if (mapName === "financialsByProvider") {
      next[provider] = summarizeProviderFinancials(providerRemaining);
    }
    if (Object.keys(next).length > 0) accounting[mapName] = next;
    else delete accounting[mapName];
  }

  const droppedFinancials = summarizeProviderFinancials(droppedRecords);
  const droppedBilled = droppedFinancials.providerReportedBilledUsd;

  await invalidateConnectedSpendTrustReceipt(rootPath);
  await writeLocalSpendState(
    stateDir,
    records,
    summary,
    mappings,
    "connected_provider",
    accounting,
    persisted.checkedAt ?? new Date().toISOString()
  );
  // Keep provider-records.json consistent with the receipt-bound spend state
  // (same records + maps); a missing file is tolerable — spend.json is the
  // receipt-bound truth.
  try {
    const providerFile = await readJson<Record<string, unknown>>(join(stateDir, "provider-records.json"));
    await writeJson(join(stateDir, "provider-records.json"), {
      ...providerFile,
      records,
      ...(accounting.qaByProvider !== undefined ? { qaByProvider: accounting.qaByProvider } : {}),
      ...(accounting.checkedAtByProvider !== undefined ? { checkedAtByProvider: accounting.checkedAtByProvider } : {}),
      ...(accounting.coverageByProvider !== undefined ? { coverageByProvider: accounting.coverageByProvider } : {}),
      ...(accounting.coverageIntervalsByProvider !== undefined
        ? { coverageIntervalsByProvider: accounting.coverageIntervalsByProvider }
        : {}),
      ...(accounting.financialsByProvider !== undefined ? { financialsByProvider: accounting.financialsByProvider } : {})
    });
  } catch {
    // Diagnostic mirror only; never block the drop on it.
  }
  await appendAuditEvent(stateDir, {
    timestamp: new Date().toISOString(),
    action: "source_scanned",
    sourceId: `${provider}-provider-api`,
    detail: `drop-slice removed the ${provider} account slice "${accountKey}" (${droppedRecords.length} record(s), ${droppedBilled === null ? "no billed evidence" : `billed ${formatOptionalUsd(droppedBilled)}`}). Local state maintenance only; no provider was contacted.`
  });
  await writeConnectedSpendTrustReceipt(
    rootPath,
    await readSafeStateText(stateDir, "spend.json"),
    { sourceRegistryContents: await readSafeStateText(stateDir, "sources.json") }
  );

  const remainingSlices = providerAccountSlices(records, provider);
  return ok([
    "aibill drop-slice",
    `provider: ${provider}`,
    `dropped account: ${accountKey}`,
    `records removed: ${droppedRecords.length} (${droppedBilled === null ? "no billed evidence" : `billed ${formatOptionalUsd(droppedBilled)}`})`,
    `remaining provider accounts: ${remainingSlices.length > 0 ? formatProviderAccountSlices(remainingSlices) : "none"}`,
    `combined headline spend: ${selectProviderFinancialHeadlineRecords(records).some((record) => typeof record.amountUsd === "number") ? formatOptionalUsd(summary.totalUsd) : "unavailable"}`,
    "note: coverage and freshness labels stay conservative until the provider is re-synced"
  ].join("\n"));
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
  if (!args.provider || !args.sourceId) {
    return { exitCode: 1, stdout: "", stderr: "confirm-mapping requires --provider and --source-id" };
  }
  const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });

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

async function reportCommand(args: ParsedArgs, runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  // 0.9.4: a broad root (home, /) runs MACHINE-WIDE — the same read-only
  // transcript scanning as the bare receipt, no project state created, both
  // report files written to the current directory. The report renders
  // machine-wide content anyway (it lists every project), so the
  // exact-project requirement was incoherent here: the receipt's own Next
  // pointer led from home straight into a refusal. Only a bogus --path
  // still gets the friendly guard; project folders behave exactly as
  // before. 0.9.5: broad roots that cannot HOLD the artifacts (/, /etc,
  // /Users, …) get the friendly guard voice up front instead of dying at
  // write time with a wrapped raw error.
  const machineWide = isBroadScanRoot(args.path);
  if (machineWide) {
    const broadGuard = guardUnwritableBroadRoot("report", args);
    if (broadGuard) return broadGuard;
  } else {
    const rootGuard = await guardExactProjectRoot("report", args.path);
    if (rootGuard) return rootGuard;
  }
  const rootPath = resolve(args.path);

  try {
    const sinceDays = args.sinceDays ?? 30;
    if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
    // Machine-wide mode NEVER creates project state at the broad root — the
    // only writes are the two report files below (plus ~/.aibill home state
    // owned by other subsystems).
    const stateDir = machineWide ? undefined : await resolveSafeStateDirectory(rootPath, { create: true });
    // Like Apply, an explicit sample report is a strict privacy boundary. It
    // must not inspect local transcripts, account metadata, or persisted state.
    let reportInput: SpendReportInput;
    if (args.sample) {
      reportInput = await buildExplicitSampleReportInput(rootPath);
    } else if (machineWide) {
      const machineWideInput = await buildMachineWideReportInput(args, sinceDays);
      if (machineWideInput.kind === "no_evidence") {
        return noEvidenceResult("report", machineWideInput.warnings, sinceDays, runtime.telemetryDisclosure);
      }
      reportInput = machineWideInput.input;
    } else {
      reportInput = await buildReportInput(stateDir!, rootPath, sinceDays);
    }
    const persistedPreferredExperiment = args.sample || machineWide
      ? undefined
      : chooseLatestTokenReductionExperiment(
          (await loadTokenVerificationState(rootPath)).experiments
        );
    const preferredExperiment = persistedPreferredExperiment &&
        persistedPreferredExperiment.intervention.appliedAt &&
        persistedPreferredExperiment.lifecycle !== "complete" &&
        persistedPreferredExperiment.lifecycle !== "rolled_back" &&
        persistedPreferredExperiment.lifecycle !== "invalidated" &&
        persistedPreferredExperiment.intervention.canary?.status !== "failed" &&
        reportInput.sessionVitals &&
        (persistedPreferredExperiment.cohort.agent === "claude-code" ||
          persistedPreferredExperiment.cohort.agent === "codex") &&
        reportInput.qualitativeCoverageByAgent?.[persistedPreferredExperiment.cohort.agent] === "complete"
      ? refreshTokenReductionExperimentV0(persistedPreferredExperiment, {
          sessionVitals: reportInput.sessionVitals,
          observedAt: reportInput.generatedAt ?? new Date().toISOString(),
          ...(reportInput.contextHealth ? { contextHealth: reportInput.contextHealth } : {})
        })
      : persistedPreferredExperiment;
    const reportableExperiment = preferredExperiment?.lifecycle === "invalidated"
      ? undefined
      : preferredExperiment;
    const reportExperimentProjection = reportableExperiment
      ? buildActionVerificationProjectionV0(reportableExperiment)
      : undefined;
    const telemetryDisclosure = runtime.telemetryDisclosure === true;
    const reportRenderInput: SpendReportInput = reportableExperiment
      ? {
          ...reportInput,
          telemetryDisclosure,
          tokenExperiment: {
            id: reportableExperiment.id,
            lifecycle: reportableExperiment.lifecycle,
            status: reportableExperiment.evaluation.status,
            matchingEvidence: reportableExperiment.evaluation.matchingEvidence,
            projection: reportExperimentProjection!,
            nextCommand: improveRuntimeCommand
          }
        }
      : { ...reportInput, telemetryDisclosure };
    const qualitativeActionsSuppressed = reportInput.dataMode !== "sample" &&
      reportInput.qualitativeCoverage?.status !== "complete";
    // Machine-wide artifacts land in the CURRENT directory under the
    // ai-spend-* family name; project mode keeps .ai-spend-agent/report.*.
    const outBase = args.out
      ? resolve(rootPath, args.out)
      : machineWide
        ? join(rootPath, "ai-spend-report")
        : join(stateDir!, "report");
    const markdownPath = `${outBase}.md`;
    const htmlPath = `${outBase}.html`;
    await writeLocalReportFile(markdownPath, generateMarkdownReport(reportRenderInput), stateDir ?? rootPath);
    await writeLocalReportFile(htmlPath, generateHtmlReport(reportRenderInput), stateDir ?? rootPath);
    // A preferred canonical experiment owns this project's action/result
    // lineage even after completion or rollback. A report may refresh its
    // read-only projection, but never overwrite the frozen handoff with a
    // fresh or contradictory candidate. Coverage gaps receive only explicit
    // non-executable gap artifacts from the report package.
    // Apply artifacts are project-scoped handoffs — machine-wide runs skip
    // them (apply itself still requires one exact project folder).
    const artifactPaths = reportableExperiment || machineWide
      ? undefined
      : await writeApplyArtifacts(stateDir!, reportInput);

    // 0.9.5 "agent feel": the HTML report opens itself in the browser via
    // the platform opener — decided truthfully BEFORE the summary renders,
    // suppressed for non-TTY/CI/SSH/--no-open/AI_SPEND_NO_OPEN, and fired
    // detached so a missing or slow opener can never crash, hang, or delay
    // exit (the telemetry detached-child pattern).
    const openDecision = (runtime.reportOpenDecide ?? decideReportAutoOpen)({
      htmlPath,
      noOpenFlag: args.noOpen === true
    });
    const openedInBrowser = (runtime.reportOpenLaunch ?? openReportInBrowser)(openDecision);

    // 0.9.5 founder polish ("really hard to read… I wonder if we can have
    // the text aligned"): the same facts, rendered in the receipt's visual
    // language — header, one shared label column, dot separators, and a Next
    // block whose commands pad to one description column. Display-only.
    const rows: CommandSummaryRow[] = [
      machineWide
        ? { label: "Scope", value: `machine-wide · all supported local agent evidence on this machine (last ${sinceDays} days) · artifacts in ${rootPath}` }
        : { label: "Path", value: rootPath },
      { label: "Markdown", value: markdownPath },
      { label: "HTML", value: htmlPath },
      ...(machineWide
        ? []
        : reportableExperiment
        ? [
            { label: "Action artifacts", value: `preserved · canonical token test ${reportableExperiment.id} (${reportableExperiment.lifecycle})` },
            { label: "Token result", value: `status=${reportableExperiment.evaluation.status}; reductionPercent=${reportExperimentProjection!.reductionPercent ?? "unavailable"}; metricEvidence=${reportExperimentProjection!.evidenceLabel}; quality=${reportExperimentProjection!.qualityLabel}; qualityEvidence=${reportExperimentProjection!.qualityEvidence}; matchingEvidence=${reportableExperiment.evaluation.matchingEvidence}` },
            { label: "Token test", value: improveRuntimeCommand }
          ]
        : qualitativeActionsSuppressed
          ? [
              { label: "Action artifacts", value: `suppressed · qualitative index ${reportInput.qualitativeCoverage?.status ?? "unknown"}` },
              { label: "Coverage artifact", value: artifactPaths!.codingPrompt },
              { label: "Coverage action plan", value: artifactPaths!.actionPlan },
              { label: "Coverage policy/config", value: artifactPaths!.policyConfigDraft },
              { label: "Coverage verification", value: artifactPaths!.verificationPlan },
              { label: "Coverage package", value: artifactPaths!.demoPackage }
            ]
        : artifactPaths
        ? [
            { label: "Apply artifact", value: artifactPaths.codingPrompt },
            { label: "Action plan", value: artifactPaths.actionPlan },
            { label: "Policy/config draft", value: artifactPaths.policyConfigDraft },
            { label: "Verification plan", value: artifactPaths.verificationPlan },
            { label: "Demo package", value: artifactPaths.demoPackage }
          ]
        : []),
      {
        label: "Total",
        value: reportInput.dataMode === "sample"
          ? `${formatOptionalUsd(reportInput.summary.totalUsd)} · DEMO SAMPLE · illustrative cost/value evidence · not user data`
          : reportInput.dataMode === "connected_provider" &&
              !(reportInput.allRecords ?? reportInput.providerRecords ?? []).some((record) => typeof record.amountUsd === "number")
            ? "Unavailable · cost/value evidence · no priced financial evidence; missing/null is not zero"
            : `${formatOptionalUsd(reportInput.summary.totalUsd)} · cost/value evidence`
      },
      {
        label: "Privacy",
        value: runtime.telemetryDisclosure === true
          ? `report rendered locally · ${telemetryDisclosureLine}; only explicit sync-provider contacts the selected provider`
          : "report rendered locally with no aibill telemetry; only explicit sync-provider contacts the selected provider"
      }
    ];
    const nextSteps: CommandSummaryNextStep[] = [
      // Summary-line truth: only a fired opener may claim it opened; every
      // suppression path keeps the plain copy-pasteable pointer.
      // 0.9.6: the pointer must survive a NAIVE PARTIAL READ. The founder saw
      // `› open <the full absolute path>` with its description on the
      // next line, read "open" as a label rather than the command, typed bare
      // `open`, and got macOS's usage dump — "i don't know what im looking
      // at." shellPathPointer names an artifact in the current directory
      // relatively (one short unit) and quotes anything absolute so the
      // command and its argument read — and paste — as one thing.
      openedInBrowser
        ? { command: `opened ${basename(htmlPath)} in your browser · next time: --no-open to skip` }
        : {
            command: shellPathPointer("open", htmlPath, process.cwd()),
            description: `view in your browser — or double-click ${basename(htmlPath)} in your file manager`
          },
      {
        command: shellPathPointer("less", markdownPath, process.cwd()),
        description: "read it in the terminal"
      },
      machineWide
        // apply/improve need one exact project folder — a machine-wide
        // report must never point at a command that then refuses (the exact
        // trap this mode removes).
        ? reportInput.dataMode === "sample"
          ? { command: `cd <project> && ${actionRuntimeCommand("apply --sample")}`, description: "print the non-executable demo boundary from one exact project folder" }
          : { command: `cd <project> && ${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}`, description: "per-project action plan from one exact project folder" }
        : reportableExperiment
        ? { command: improveRuntimeCommand, description: `review canonical token test ${reportableExperiment.id}` }
        : qualitativeActionsSuppressed
          ? { command: actionRuntimeCommand(`context --json --since-days ${sinceDays}`), description: "complete bounded qualitative evidence before any action" }
          : reportInput.dataMode === "sample"
            ? { command: actionRuntimeCommand("apply --sample"), description: "print the non-executable demo boundary" }
            : { command: actionRuntimeCommand(`apply --since-days ${sinceDays}`), description: "print the paste-ready coding-agent prompt from this exact evidence window" }
    ];
    return ok(generateCommandSummary({
      title: "aibill report",
      note: "a shareable Markdown + HTML report, written locally",
      rows,
      nextSteps,
      color: args.noColor ? false : undefined,
      width: terminalOutputWidth()
    }));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't build a report: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
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

async function reportCardCommand(args: ParsedArgs, runtime: CliRuntimeOptions = {}): Promise<CliResult> {
  // 0.9.4: a broad root (home, /) runs MACHINE-WIDE — identical read-only
  // scanning to the bare receipt (loadInstantReadData below), SVG written to
  // the current directory. The card renders machine-wide content anyway, so
  // an exact-project requirement was incoherent here; only a bogus --path
  // still gets the friendly guard. 0.9.5: broad roots that cannot HOLD the
  // receipt (/, /etc, /Users, …) get the friendly guard voice up front
  // instead of dying at write time with a wrapped raw error.
  const machineWide = isBroadScanRoot(args.path);
  if (machineWide) {
    const broadGuard = guardUnwritableBroadRoot("report-card", args);
    if (broadGuard) return broadGuard;
  } else if (!args.sample) {
    const rootGuard = await guardExactProjectRoot("report-card", args.path);
    if (rootGuard) return rootGuard;
  }
  try {
    // Sample mode reads no workspace data and machine-wide mode reads only
    // the agent transcript dirs — neither scans the current directory, so
    // both write the receipt from wherever the user stands. Output still
    // goes through the safe-write/symlink checks below.
    const rootPath = args.sample || machineWide
      ? resolve(args.path)
      : await resolveSafeScanRoot(args.path);
    const { records, mode, providerCoverage, warnings } = await loadInstantReadData(args);
    if (records.length === 0) {
      return noEvidenceResult("report-card", warnings, args.sinceDays ?? 30);
    }

    const headlineRecords = mode === "connected"
      ? selectProviderFinancialHeadlineRecords(records)
      : records;
    const summary = analyzeSpend(headlineRecords);
    const outPath = await resolveReceiptPath(rootPath, args.out);
    await mkdir(dirname(outPath), { recursive: true });
    const svg = generateReportCardSvg({
      summary,
      records: headlineRecords,
      mode,
      ...(providerCoverage ? { providerCoverage } : {})
    });
    await writeSafeStateText(dirname(outPath), basename(outPath), svg);

    const caption = generateReportCardCaption({
      summary,
      records: headlineRecords,
      mode,
      ...(providerCoverage ? { providerCoverage } : {})
    });

    // 0.9.6: the receipt now SHOWS itself. 0.9.5 wrote the SVG and stopped,
    // leaving the user to go find and open it by hand ("not automatically
    // showing on a html or opening the file: making it inefficient").
    //
    // We auto-open a companion .html rather than the .svg itself: platform
    // openers hand a .svg to whatever claims that extension, which on a
    // developer machine is frequently an editor, so "show me my receipt"
    // could open a wall of XML. An .html is claimed by a browser everywhere.
    // The .svg remains the canonical shareable artifact; the companion just
    // renders it next to the caption, embedding both verbatim so it inherits
    // the card's redaction guarantees exactly.
    const companionPath = `${outPath.replace(/\.svg$/iu, "")}.html`;
    await writeSafeStateText(
      dirname(companionPath),
      basename(companionPath),
      generateReceiptCompanionHtml({ svg, caption })
    );

    // Same decision function, same suppression matrix, same metacharacter
    // refusal, same detached launch as `report` — one opener, two commands.
    const openDecision = (runtime.reportOpenDecide ?? decideReportAutoOpen)({
      htmlPath: companionPath,
      noOpenFlag: args.noOpen === true
    });
    const openedInBrowser = (runtime.reportOpenLaunch ?? openReportInBrowser)(openDecision);

    const dataRow = mode === "demo"
      ? args.sample
        ? "DEMO sample data — explicit illustrative mode; no local transcripts or persisted spend state were read"
        : "DEMO sample data — no supported local Claude Code/Codex evidence was found; use --sample to reproduce this demo explicitly"
      : mode === "local-logs"
        ? "local Claude Code/Codex logs priced at API-equivalent rates"
        : "connected local spend state with provider-reported cost kept separate from API-equivalent estimates";

    // 0.9.5 founder polish: same facts, receipt-language layout — header,
    // one label column, and the caption set off as its own block.
    return ok(generateCommandSummary({
      title: "aibill report-card",
      badge: "Your AI Receipt",
      note: "a shareable, redacted spend card (no client/project/user names)",
      rows: [
        { label: "Receipt", value: outPath },
        { label: "Preview", value: companionPath },
        { label: "Data", value: dataRow },
        { label: "Privacy", value: "rendered locally; only totals, generic candidate categories, and evidence labels are included" }
      ],
      sections: [{
        heading: "Caption to share",
        body: [caption]
      }],
      nextSteps: [
        // Summary-line truth: only a fired opener may claim it opened; every
        // suppression path keeps the plain copy-pasteable pointer.
        openedInBrowser
          ? { command: `opened ${basename(companionPath)} in your browser · next time: --no-open to skip` }
          : {
              command: shellPathPointer("open", companionPath, process.cwd()),
              description: `view the receipt — or double-click ${basename(companionPath)} in your file manager`
            },
        // NOT a command, so it must not LOOK like one: `post ai-receipt.svg`
        // sitting under "Next" beside two real commands is exactly the trap
        // that made the founder type a bare `open`. Description-less lines
        // render verbatim, so this one states a fact instead.
        { command: `${basename(outPath)} is the file to share — post that one` }
      ],
      color: args.noColor ? false : undefined,
      width: terminalOutputWidth()
    }));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't write the report card: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
}

/**
 * B1 broad-root gate: refuse home/root/system/home-containing targets with a
 * plain "cd to a project" instruction BEFORE any state, git, or trust-receipt
 * code can surface its own vocabulary. Also covers a --path that does not
 * exist (a location problem is not a breadth problem, but the fix is the
 * same). Returns undefined when the root is an acceptable exact project.
 */
/**
 * True when the requested root is a machine-wide location (home, filesystem
 * root, a system directory, or anything containing home). report/report-card
 * treat this as MACHINE-WIDE MODE — the same read-only, transcript-dir
 * scanning the bare receipt performs — instead of refusing (0.9.4 founder
 * fix: the receipt's own Next pointer led from home into a refusal that
 * read as "the commands don't work"). Genuinely project-scoped commands
 * (improve, apply, verify, watch, connect, reset, …) keep the guard.
 */
function isBroadScanRoot(requestedPath: string): boolean {
  return broadScanRootKind(requestedPath) !== undefined;
}

type BroadScanRootKind = "home" | "filesystem-root" | "contains-home" | "system-directory";

/** Classifies WHICH broad-root category a machine-wide path falls in. */
function broadScanRootKind(requestedPath: string): BroadScanRootKind | undefined {
  const rootPath = resolve(requestedPath);
  const home = homedir();
  const guardHome = home && home.trim().length > 0
    ? home
    : join(rootPath, "aibill-impossible-home-sentinel");
  const reason = unsafeScanRootReason(rootPath, guardHome);
  if (reason === undefined) return undefined;
  if (reason.includes("filesystem root")) return "filesystem-root";
  if (reason.includes("home directory is too broad")) return "home";
  if (reason.includes("contains your home directory")) return "contains-home";
  return "system-directory";
}

/**
 * 0.9.5: machine-wide report/report-card write their artifacts INTO the
 * requested root. That works from the home directory, but /, /etc, or a
 * folder that contains home cannot hold them — the run used to die at write
 * time with a wrapped raw error ("Couldn't build a report: EROFS…",
 * "Refusing to use /etc…"). Those roots get the friendly guard voice BEFORE
 * anything is scanned or written. Returns undefined when the root is home
 * itself (machine-wide proceeds) or when an explicit absolute --out points
 * the artifacts somewhere else entirely.
 */
function guardUnwritableBroadRoot(
  commandName: "report" | "report-card",
  args: Pick<ParsedArgs, "path" | "out">
): CliResult | undefined {
  const kind = broadScanRootKind(args.path);
  if (kind === undefined || kind === "home") return undefined;
  // An absolute --out lands outside the broad root; only rootPath-relative
  // artifacts make this location a write problem.
  if (args.out !== undefined && isAbsolute(args.out)) return undefined;
  const artifactNoun = commandName === "report" ? "its report files" : "the receipt";
  const explanation = kind === "filesystem-root"
    ? `You pointed it at the filesystem root, which can't hold ${artifactNoun}.`
    : kind === "contains-home"
      ? `You pointed it at a folder that contains your home directory, which can't hold ${artifactNoun}.`
      : `You pointed it at a system directory, which can't hold ${artifactNoun}.`;
  return {
    exitCode: 1,
    stdout: "",
    stderr: [
      `aibill ${commandName} writes ${artifactNoun} into the folder it points at.`,
      explanation,
      "",
      "Run it from your home directory for a machine-wide view, or from one exact project folder",
      `  e.g. cd ~ && ${actionRuntimeCommand(commandName)}`,
      "",
      "Nothing was read, created, or changed."
    ].join("\n")
  };
}

async function guardExactProjectRoot(
  commandName: string,
  requestedPath: string
): Promise<CliResult | undefined> {
  const rootPath = resolve(requestedPath);
  // An unset/empty $HOME (containers) must never make the current directory
  // masquerade as "home": substitute a sentinel that cannot match anything.
  const home = homedir();
  const guardHome = home && home.trim().length > 0
    ? home
    : join(rootPath, "aibill-impossible-home-sentinel");
  const reason = unsafeScanRootReason(rootPath, guardHome);
  let explanation: string | undefined;
  if (reason) {
    if (reason.includes("home directory is too broad")) {
      explanation = "You ran it from your home directory, which is too broad to observe.";
    } else if (reason.includes("filesystem root")) {
      explanation = "You ran it from the filesystem root, which is too broad to observe.";
    } else if (reason.includes("contains your home directory")) {
      explanation = "You ran it from a folder that contains your home directory.";
    } else {
      explanation = "You ran it from a system directory, which is too broad to observe.";
    }
  } else {
    const info = await stat(rootPath).catch(() => undefined);
    if (!info) {
      explanation = "The folder you pointed at does not exist.";
    } else if (!info.isDirectory()) {
      explanation = "The path you pointed at is not a folder.";
    }
  }
  if (!explanation) return undefined;
  return {
    exitCode: 1,
    stdout: "",
    stderr: [
      `aibill ${commandName} needs one exact project folder.`,
      explanation,
      "",
      "cd to an exact project or use --path <project>",
      `  e.g. cd ~/code/my-app && ${actionRuntimeCommand(`${commandName} --path .`)}`,
      "",
      "Nothing was read, created, or changed."
    ].join("\n")
  };
}

/* ------------------------------------------------------------------ */
/* Agent-draft screening copy (AGENT_NATIVE_LOOP_DESIGN.md §5, A1-A11)  */
/* ------------------------------------------------------------------ */

/**
 * A1 · plan banner, printed once before step 1 when at least one
 * agent-drafted sentence survived screening. The final line IS the shared
 * `userSafetyLine` constant, rendered verbatim and unwrapped (n1) so QA 25
 * can assert byte-identity across the CLI banner, `agentLoop`, and
 * `draft_improve_command`.
 */
const agentDraftPlanBanner = [
  "Your agent helped draft this plan. Nothing is approved yet: review each",
  "sentence, press Enter to accept it or type your own, and only the APPROVE",
  "you type at the end authorizes anything.",
  IMPROVE_USER_SAFETY_LINE_V1
].join("\n");

/** A4 · whole-draft set-asides. */
const agentDraftUnreadableNotice = [
  "Your agent's draft could not be read (not a valid ab1 draft token).",
  "Continuing with aibill's own suggestions. Ask your agent to call",
  "draft_improve_command again and hand you the exact command it returns."
].join("\n");
const agentDraftStaleNotice = [
  "Your agent's draft was made for a different test or an older revision of",
  "this one, so it was set aside. Ask your agent to re-read",
  "get_token_reduction_test and draft again."
].join("\n");
const agentDraftNoTestNotice = [
  "There is no frozen baseline yet, so a drafted plan cannot attach to a test.",
  "Finish the two start questions first; then ask your agent to draft against",
  "the new test id."
].join("\n");

/** A5 · --draft while a plan awaits its record. */
const agentDraftAfterApprovalNotice = [
  "A plan is already approved and waiting for its result, so the draft was",
  "not used. Record what happened below."
].join("\n");

/** A7 · record flags with no approved plan. */
const recordFlagsNoApprovalNotice = [
  "No plan is approved yet, so --record-applied-at/--record-canary were not",
  "used. Approve a plan first."
].join("\n");

/** A7 · applied-at prefill set aside (reason = exact time-classifier copy). */
function recordTimeSetAsideNotice(reason: string): string {
  return [
    `Your agent's applied-at time was set aside: ${reason}`,
    "Answer the question yourself below."
  ].join("\n");
}

/** A8 · non-interactive run with any draft/record flag. */
const agentFlagsNonInteractiveNote = [
  "Agent drafts and record values only pre-fill the interactive flow; nothing",
  "was recorded. Run this command in an interactive terminal."
].join("\n");

/** A10 · verify-flag confusion on improve. */
const verifyFlagConfusionNote = [
  "Note: --applied-at/--canary belong to the advanced verify commands. With",
  "improve, use --record-applied-at and --record-canary."
].join("\n");

/** A9 · demo variant banner (binding is checked only in a real run). */
const demoDraftBanner = [
  "DEMO: your agent's draft is used for practice only. Draft binding to a real",
  "test id and revision is checked only in a real run. Nothing is recorded."
].join("\n");

type ScreenedAgentDraft = {
  /** Surviving sentences, each carrying agent provenance (B1). */
  answers: {
    change?: SuggestedPlanAnswer;
    rollback?: SuggestedPlanAnswer;
    canary?: SuggestedPlanAnswer;
  };
  /** A3 lines for set-aside fields, in field order; secrets never echoed. */
  setAsideNotices: string[];
  survivors: number;
};

/**
 * Screen a decoded draft with the SAME shared core path the MCP composition
 * preview uses (`screenAgentDraftSentence`), field by field. A rejected
 * field falls back to aibill's own suggestion — and to aibill's label; a
 * surviving field carries `provenance: "agent"` so only genuinely
 * agent-authored words ever render `Drafted with your agent` (B1, QA 17).
 */
function screenAgentDraftSentences(draft: AgentDraftV1): ScreenedAgentDraft {
  const answers: ScreenedAgentDraft["answers"] = {};
  const setAsideNotices: string[] = [];
  let survivors = 0;
  for (const field of ["change", "rollback", "canary"] as const) {
    const verdict = screenAgentDraftSentence(draft[field]);
    if (verdict.ok) {
      answers[field] = { value: verdict.value, provenance: "agent" };
      survivors += 1;
    } else {
      // A3 · the reason is the classifier's exact reprompt message; the
      // credential path's message never contains the rejected text.
      setAsideNotices.push([
        `Your agent's ${field} draft was set aside: ${verdict.reason}`,
        "aibill's own suggestion is shown for that step instead, labeled Suggested."
      ].join("\n"));
    }
  }
  return { answers, setAsideNotices, survivors };
}

/**
 * `improve --sample`: the full guided questionnaire against synthetic
 * evidence so a new user can practice every step safely. Fail-closed by
 * construction: this function never receives a draft store or persistence
 * path — no experiment, ownership, approval, draft, or file is written.
 * With `--draft` (A9) the demo decodes and screens the token exactly like a
 * real run — practicing the screening is the point — but skips the binding
 * check, because there is no real test to bind to.
 */
async function demoImproveCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  const demoNext = {
    reason: "run the real flow from inside one exact project",
    command: improveRuntimeCommand
  };
  const hasAgentFlags = args.agentDraftToken !== undefined ||
    args.recordAppliedAt !== undefined || args.recordCanary !== undefined;
  const guidedIo = runtime.interactive ? await createGuidedIo(runtime) : undefined;
  if (!runtime.interactive || !guidedIo) {
    return ok(renderCleanExit({
      lines: [
        "aibill improve · DEMO · synthetic sample — practice run, nothing is recorded",
        "Demo sample data can never start a token test.",
        ...(hasAgentFlags ? [agentFlagsNonInteractiveNote] : [])
      ],
      next: {
        reason: "practice the guided token test safely in an interactive terminal",
        command: `${improveRuntimeCommand.replace(" --path .", "")} --sample`
      }
    }));
  }
  const header = {
    commandTitle: "aibill improve · one reversible token test",
    experimentLabel: "test DEMO-tre_v0_00000000",
    demo: true
  };
  guidedIo.write("Demo sample data can never start a token test.");
  // A9 · decode + screen exactly like a real run; binding is not checked.
  const demoDraft = args.agentDraftToken !== undefined
    ? decodeAgentDraftTokenV1(args.agentDraftToken)
    : undefined;
  let demoSuggestedAnswers: ScreenedAgentDraft["answers"] = {
    change: {
      value: "Start with only the files and instructions this task needs.",
      provenance: "aibill"
    },
    rollback: { value: "Restore the prior session workflow.", provenance: "aibill" },
    canary: {
      value: "The project tests pass and the requested output is accepted.",
      provenance: "aibill"
    }
  };
  const demoDraftNotices: string[] = [];
  if (demoDraft !== undefined) {
    guidedIo.write(demoDraftBanner);
    if (!demoDraft.ok) {
      demoDraftNotices.push(agentDraftUnreadableNotice);
    } else {
      const screened = screenAgentDraftSentences(demoDraft.draft);
      if (screened.survivors > 0) demoDraftNotices.push(agentDraftPlanBanner);
      demoDraftNotices.push(...screened.setAsideNotices);
      demoSuggestedAnswers = { ...demoSuggestedAnswers, ...screened.answers };
    }
  }
  const demoComplete = (firstLine: string): CliResult => ok(renderCleanExit({
    lines: [
      firstLine,
      "No experiment, ownership, approval, draft, or file was written. A demo",
      "can never start a real token test or create a real claim."
    ],
    next: demoNext
  }));
  const start = await runStartSitting(guidedIo, {
    header,
    findingLabel: "Start with only the files and instructions this task needs",
    evidenceLine: "synthetic sample evidence — not read from your machine"
  });
  if (start.action !== "start") {
    return demoComplete("DEMO ENDED · nothing was created or stored");
  }
  if (demoDraftNotices.length > 0) {
    guidedIo.write(demoDraftNotices.join("\n\n"));
  }
  const plan = await runPlanSitting(guidedIo, {
    header,
    experimentId: "DEMO-tre_v0_0000000000000000",
    revisionId: "demo",
    sanitize: (value) => value,
    nowIso: () => new Date().toISOString(),
    approveExtraLine: "This is a practice approval. It is not recorded and creates no claim.",
    suggestedAnswers: demoSuggestedAnswers
  });
  return demoComplete(plan.action === "approved"
    ? "DEMO COMPLETE · nothing was created or stored"
    : "DEMO ENDED · nothing was created or stored");
}

async function createGuidedIo(runtime: CliRuntimeOptions): Promise<FlowIo | undefined> {
  if (runtime.openGuidedIo) {
    const opened = await runtime.openGuidedIo();
    return { source: opened.source, write: opened.write };
  }
  if (!runtime.prompt) return undefined;
  // Bridge for prompt-function embeddings and tests: screens buffer into the
  // next question string. Real terminals get an arrival-timestamped stdin
  // source via openGuidedIo; this bridge cannot observe paste timing, so it
  // keeps the identical-rejection circuit breaker as its backstop.
  const promptFn = runtime.prompt;
  let pending = "";
  return {
    source: {
      next: async () => {
        const question = pending;
        pending = "";
        try {
          const line = await promptFn(question);
          return { kind: "line", text: line, receivedAtMs: Date.now() };
        } catch {
          return { kind: "closed" };
        }
      },
      drain: () => 0
    },
    write: (text: string) => {
      pending = pending.length > 0 ? `${pending}\n${text}` : text;
    },
    maxIdenticalRejections: 8
  };
}

function createPlanDraftStore(rootPath: string): PlanDraftStore {
  const draftFileName = "improve-draft.json";
  return {
    load: async () => {
      try {
        const statePath = await projectAccountabilityStatePath(rootPath);
        const raw = await readFile(join(dirname(statePath), draftFileName), "utf8");
        return parsePlanDraft(JSON.parse(raw));
      } catch {
        return undefined;
      }
    },
    save: async (draft) => {
      const statePath = await projectAccountabilityStatePath(rootPath, { create: true });
      await writeSafeStateText(
        dirname(statePath),
        draftFileName,
        `${JSON.stringify(draft, null, 2)}\n`
      );
    },
    clear: async () => {
      try {
        const statePath = await projectAccountabilityStatePath(rootPath);
        await rm(join(dirname(statePath), draftFileName), { force: true });
      } catch {
        // Missing private storage means there is no draft to clear.
      }
    }
  };
}

/**
 * The approved-plan agent handoff (§2e): symmetric with the record leg. The
 * record command placeholder line lives INSIDE the quoted agent text, not in
 * a NEXT COMMAND block, so the one-command exit contract is untouched.
 */
function improveAgentInstruction(changeSentence: string): string {
  return [
    `"Execute only the pre-approved reversible plan: ${changeSentence}`,
    "Make no other optimization, preserve the approved rollback, and run the",
    "approved canary. Then report the exact UTC ISO-8601 time the change was",
    "applied and whether that exact canary passed or failed — if the canary has",
    "not run, say so instead. Give the user this one command with the time",
    "filled in:",
    `  ${actionRuntimeCommand("improve --record-applied-at <time> --record-canary <passed|failed>")}`,
    "That command only pre-fills the applied-at question; the user types the",
    'canary answer themselves in their terminal."'
  ].join("\n");
}

/**
 * m12c: the record-backedOut re-show restates the FINDING label — the exact
 * approved sentence is unrecoverable by design (hash-only persistence) — and
 * must say so under the quoted text.
 */
const improveAgentInstructionHashCaveat = [
  "(aibill keeps only hashes of your approved sentences; the plan above",
  "restates the finding, not your exact approved wording.)"
].join("\n");

async function improveCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  if (args.sample) {
    return demoImproveCommand(args, runtime);
  }
  const rootGuard = await guardExactProjectRoot("improve", args.path);
  if (rootGuard) return rootGuard;
  // §2c dispatch inputs. Decoding never throws; every set-aside prints one
  // notice and CONTINUES — a bad draft never ends the run (P0B principle 2).
  let agentDraft = args.agentDraftToken !== undefined
    ? decodeAgentDraftTokenV1(args.agentDraftToken)
    : undefined;
  const hasRecordFlags =
    args.recordAppliedAt !== undefined || args.recordCanary !== undefined;
  const hasAgentFlags = agentDraft !== undefined || hasRecordFlags;
  let recordFlagsNoticed = false;
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
  const rootPath = resolve(args.path);
  let stateDir = join(rootPath, ".ai-spend-agent");

  try {
    // Interactive Improve may persist the fresh financial snapshot before it
    // loads token-test state. Establish or safely migrate the private Git
    // boundary first so that no spend/mapping file is ever written unignored.
    if (runtime.interactive === true) {
      stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
    }
    const reportInput = await buildReportInput(stateDir, rootPath, sinceDays, {
      persistLocalFinancialState: runtime.interactive === true
    });
    // C-lane §3: the current project's standing for the improve card's
    // PROJECT line, computed from the canonical result card contract.
    // Omitted (never fabricated) when no project attribution exists.
    const improveProjectLine = buildResultCardProjectLine({
      card: buildResultCard({
        mode: reportInput.dataMode === "sample"
          ? "demo"
          : reportInput.dataMode === "connected_provider"
            ? "connected"
            : "local-logs",
        windowDays: sinceDays,
        records: reportInput.allRecords,
        detectedPlans: reportInput.detectedPlans
      }),
      records: reportInput.allRecords,
      currentProjectId: resolve(rootPath) === (runtime.homeDirectory ?? homedir())
        ? undefined
        : basename(rootPath)
    });
    let preferred = chooseLatestTokenReductionExperiment(
      (await loadTokenVerificationState(rootPath)).experiments
    );
    // Cancellation is terminal audit history, not the current guided task.
    // When fresh evidence supports a new finding, let the repeated Improve
    // command start a new lineage instead of remaining stuck forever on the
    // most-recent invalidated experiment. The cancelled record remains in the
    // bounded store and continues to appear on audit/report surfaces.
    if (preferred?.lifecycle === "invalidated" && reportInput.wasteFinding) {
      preferred = undefined;
    }
    let observation: Awaited<ReturnType<typeof loadTokenVerificationObservation>> | undefined;
    if (preferred?.intervention.appliedAt &&
        preferred.lifecycle !== "complete" &&
        preferred.lifecycle !== "rolled_back" &&
        preferred.lifecycle !== "invalidated" &&
        preferred.intervention.canary?.status !== "failed") {
      observation = await loadTokenVerificationObservation(rootPath, preferred);
      const refreshed = observation.qualitativeCoverageComplete
        ? refreshTokenReductionExperimentV0(preferred, {
            sessionVitals: observation.sessionVitals,
            observedAt: observation.generatedAt,
            contextHealth: observation.contextHealth
          })
        : preferred;
      if (runtime.interactive && refreshed.revisionId !== preferred.revisionId) {
        await upsertTokenReductionExperiment(rootPath, refreshed, {
          expectedRevisionId: preferred.revisionId
        });
      }
      preferred = refreshed;
    }

    const sessionVitals = observation?.sessionVitals ?? reportInput.sessionVitals;
    const contextHealth = observation?.contextHealth ?? reportInput.contextHealth;
    let model = buildImproveExperience({
      finding: reportInput.wasteFinding,
      preferredExperiment: preferred,
      sessionVitals,
      interactive: runtime.interactive === true,
      readOnly: runtime.prompt === undefined
    });

    const guidedIo = runtime.interactive ? await createGuidedIo(runtime) : undefined;
    if (!runtime.interactive || !guidedIo) {
      // A8 · drafts and record values are prefills for the interactive flow
      // only; the read-only render must say nothing was recorded.
      const readOnlyNote =
        "No experiment, approval, or project state changed. The private local evidence cache may refresh. Run this command in an interactive terminal to start or record a test." +
        (hasAgentFlags ? `\n${agentFlagsNonInteractiveNote}` : "");
      return ok(renderImproveExperience(model, {
        note: readOnlyNote,
        ...(improveProjectLine ? { projectLine: improveProjectLine } : {})
      }));
    }
    const commandTitle = "aibill improve · one reversible token test";
    const experimentTag = (id?: string): string =>
      id ? `test ${id.slice(0, 15)}` : "test: none yet";

    // A10 · the verify flags do not belong to improve; say so and ignore.
    if (args.appliedAt !== undefined || args.canary !== undefined) {
      guidedIo.write(verifyFlagConfusionNote);
    }
    // Phases past plan/record (collecting, rollback, terminal): the flags
    // have no question to pre-fill; say so once instead of failing.
    if (hasAgentFlags &&
        model.phase !== "start" && model.phase !== "awaiting_intervention") {
      guidedIo.write(
        "The current step needs no draft or record values, so they were not used."
      );
    }

    if (model.phase === "start" && !preferred) {
      // §2c dispatch 2: a plan draft cannot bind before the freeze — the
      // experimentId is created at freeze. The draft is set aside NOW; after
      // the freeze the plan sitting uses aibill's own suggestions.
      if (agentDraft !== undefined) {
        guidedIo.write(agentDraftNoTestNotice);
        agentDraft = undefined;
      }
      if (hasRecordFlags && !recordFlagsNoticed) {
        guidedIo.write(recordFlagsNoApprovalNotice);
        recordFlagsNoticed = true;
      }
      const start = await runStartSitting(guidedIo, {
        header: { commandTitle, experimentLabel: experimentTag() },
        findingLabel: model.oneChange.label,
        evidenceLine: `evidence: calculated from completed local sessions, last ${sinceDays} days`
      });
      if (start.action === "declined" || start.action === "cancelled") {
        return ok(renderCleanExit({
          lines: ["Nothing changed."],
          next: { reason: "run this again when you want to look", command: improveRuntimeCommand }
        }));
      }
      if (start.action === "qualityNotAccepted") {
        return ok(renderCleanExit({
          lines: ["No baseline was frozen. Nothing changed."],
          next: { reason: "run this again when you want to look", command: improveRuntimeCommand }
        }));
      }
      const requested = buildImproveExperience({
        finding: reportInput.wasteFinding,
        sessionVitals,
        interactive: true,
        intent: {
          kind: "start",
          createdAt: reportInput.generatedAt ?? new Date().toISOString(),
          baselineQuality: "held"
        }
      });
      preferred = await applyImproveOperation(
        requested.advancedOperation,
        rootPath,
        contextHealth
      );
      model = buildImproveExperience({
        preferredExperiment: preferred,
        sessionVitals,
        interactive: true
      });
      guidedIo.write([
        "",
        `Baseline frozen · ${experimentTag(preferred.id)}`,
        "quality: held (user-declared)",
        "",
        "Next: define and approve the one exact change.",
        ""
      ].join("\n"));
      // Continue in the same repeated command: the next step is to define
      // and approve the exact reversible plan before any agent handoff.
    }

    if (model.phase === "awaiting_intervention" && preferred) {
      const actionProjectRef = await projectActionRootReference(rootPath);
      if (preferred.cohort.projectRef !== actionProjectRef) {
        throw new Error(
          `this token test belongs to a different observed project; from that project root run ${improveRuntimeCommand} before recording ownership or approval`
        );
      }
      const accountabilityState = await loadProjectAccountabilityState(rootPath);
      const approvedPlan = findPreapprovedPlan(preferred, accountabilityState);
      const header = { commandTitle, experimentLabel: experimentTag(preferred.id) };
      if (!approvedPlan) {
        const expectedProjectRef = await projectAccountabilityRootReference(rootPath);
        if (accountabilityState.ownership &&
            accountabilityState.ownership.contract.projectRef !== expectedProjectRef) {
          throw new Error(
            "the confirmed ownership belongs to a different project root; inspect the private accountability state before approving"
          );
        }
        const existingIdentity = accountabilityState.ownership
          ? {
              owner: accountabilityState.ownership.displayLabels.humanOwner,
              team: accountabilityState.ownership.displayLabels.team,
              role: accountabilityState.ownership.approverRole.roleLabel
            }
          : undefined;
        const draftStore = createPlanDraftStore(rootPath);
        // §2c dispatch 3: record flags cannot apply before an approval.
        if (hasRecordFlags && !recordFlagsNoticed) {
          guidedIo.write(recordFlagsNoApprovalNotice);
          recordFlagsNoticed = true;
        }
        // The machine drafts; the human approves. aibill already knows the
        // change it found — never make the user re-type a worse version.
        // Every fallback field carries aibill's OWN provenance so it can
        // never render under the agent label (B1).
        const aibillSuggestions: NonNullable<
          Parameters<typeof runPlanSitting>[1]["suggestedAnswers"]
        > = {
          change: {
            value: model.oneChange.label.endsWith(".")
              ? model.oneChange.label
              : `${model.oneChange.label}.`,
            provenance: "aibill"
          },
          rollback: {
            value: "Restore the prior session workflow.",
            provenance: "aibill"
          },
          canary: {
            value: "The project tests pass and the requested output is accepted.",
            provenance: "aibill"
          }
        };
        let suggestedAnswers = aibillSuggestions;
        const draftNotices: string[] = [];
        if (agentDraft !== undefined) {
          if (!agentDraft.ok) {
            draftNotices.push(agentDraftUnreadableNotice);
          } else if (agentDraft.draft.experimentId !== preferred.id ||
              agentDraft.draft.revisionId !== preferred.revisionId) {
            // Stale revision, wrong test, or a token replayed from another
            // project — the id simply does not match this project's test.
            draftNotices.push(agentDraftStaleNotice);
          } else {
            const screened = screenAgentDraftSentences(agentDraft.draft);
            if (screened.survivors > 0) draftNotices.push(agentDraftPlanBanner);
            draftNotices.push(...screened.setAsideNotices);
            suggestedAnswers = { ...aibillSuggestions, ...screened.answers };
          }
        }
        if (draftNotices.length > 0) {
          guidedIo.write(draftNotices.join("\n\n"));
        }
        const plan = await runPlanSitting(guidedIo, {
          header,
          experimentId: preferred.id,
          revisionId: preferred.revisionId,
          ...(existingIdentity ? { existingIdentity } : {}),
          draftStore,
          sanitize: sanitizeLocalActivityText,
          nowIso: () => new Date().toISOString(),
          suggestedAnswers
        });
        const rerunNext = { reason: "run this again to continue the plan", command: improveRuntimeCommand };
        if (plan.action === "cancelled" || plan.action === "backedOut") {
          return ok(renderCleanExit({
            lines: [
              `${experimentTag(preferred.id)} · plan not finished`,
              "Nothing was approved or handed off; your frozen baseline is untouched."
            ],
            next: {
              ...rerunNext,
              advancedLine: `To abandon this test entirely: ${actionRuntimeCommand(`verify cancel ${preferred.id}`)} — keeps the audit record.`
            }
          }));
        }
        if (plan.action === "identityDeclined") {
          return ok(renderCleanExit({
            lines: [
              `${experimentTag(preferred.id)} · identity not confirmed`,
              "Nothing was approved or handed off."
            ],
            next: { reason: "confirm who owns this project first", command: actionRuntimeCommand("identify") }
          }));
        }
        if (plan.action === "notApproved") {
          await draftStore.clear();
          return ok(renderCleanExit({
            lines: [
              "Not approved. No handoff was emitted and nothing changed; your",
              "frozen baseline is untouched."
            ],
            next: { reason: "run this when you are ready to approve", command: improveRuntimeCommand }
          }));
        }
        const references = {
          changeRef: createActionVerificationReference("approved-change", plan.change),
          rollbackRef: createActionVerificationReference("rollback-artifact", plan.rollback),
          canaryRef: createActionVerificationReference("planned-canary", plan.canary)
        };
        let ownershipState = accountabilityState;
        let approverLabel: string;
        let approverRoleLabel: string;
        if (plan.identity === "existing") {
          approverLabel = existingIdentity!.owner;
          approverRoleLabel = existingIdentity!.role;
        } else {
          let ownership: ProjectAccountabilityOwnershipV1;
          try {
            ownership = createProjectAccountabilityOwnership({
              projectRef: expectedProjectRef,
              humanOwnerLabel: plan.identity.humanOwner,
              teamLabel: plan.identity.team,
              ...(plan.identity.client ? { clientLabel: plan.identity.client } : {}),
              ...(plan.identity.costCenter ? { costCenterLabel: plan.identity.costCenter } : {}),
              confirmedAt: new Date().toISOString(),
              confirmedByLabel: plan.identity.humanOwner,
              approverRoleLabel: plan.identity.role
            });
          } catch (identityError) {
            // Backstop only: every field was already validated at its own
            // prompt, so reaching this means a classifier gap. Fail closed
            // without losing the saved plan answers.
            const reason = identityError instanceof Error ? identityError.message : String(identityError);
            return ok(renderCleanExit({
              lines: [
                `That identity could not be stored: ${sanitizeSecretishError(reason)}`,
                "Nothing was approved or handed off; your plan answers are saved."
              ],
              next: rerunNext
            }));
          }
          ownershipState = await upsertConfirmedProjectOwnership(rootPath, ownership, {
            expectedOwnershipId: null
          });
          approverLabel = plan.identity.humanOwner;
          approverRoleLabel = plan.identity.role;
        }
        const approvedAt = new Date().toISOString();
        const actionRef = createProjectEconomicsPlannedActionRefV0(preferred, references);
        await appendProjectApprovalEvent(rootPath, {
          kind: APPROVAL_EVENT_V0_KIND,
          schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
          approvedAt,
          decision: "approved",
          attestation: {
            scope: "local_self_attested",
            evidence: "user_declared",
            approverIdentityRef:
              ownershipState.ownership!.contract.confirmation.confirmedByRef,
            approverRoleRef: ownershipState.ownership!.approverRole.roleRef,
            rbacVerified: false
          },
          references: { actionRef, ...references }
        }, {
          expectedPreviousEventId: ownershipState.approvals.at(-1)?.id ?? null
        });
        await draftStore.clear();
        return ok(renderCleanExit({
          lines: [
            `Approved · token test ${preferred.id}`,
            `Pre-change local self-attestation: ${approverLabel} (${approverRoleLabel}) approved this exact plan at ${approvedAt}.`
          ],
          extraBlocks: [renderForYourAgent(improveAgentInstruction(plan.change))],
          next: { reason: "after the agent reports back, run exactly this", command: improveRuntimeCommand }
        }));
      }

      const approvedByLine = accountabilityState.ownership
        ? `Approved ${approvedPlan.approvedAt} by ${accountabilityState.ownership.displayLabels.humanOwner} (${accountabilityState.ownership.approverRole.roleLabel})`
        : `Approved ${approvedPlan.approvedAt}`;
      // §2c dispatch 4: a plan is pre-approved — the draft (if any) is set
      // aside (A5); the applied-at prefill is pre-screened with the FULL
      // time classifier (approvedAtIso context) so before-approval/future
      // values are set aside honestly NOW instead of at Enter (A7); the
      // canary report NEVER prefills — claim line only, typed p/f/n (M6).
      const recordNotices: string[] = [];
      if (agentDraft !== undefined) {
        recordNotices.push(agentDraftAfterApprovalNotice);
      }
      let suggestedRecord: { appliedAtIso: string } | undefined;
      if (args.recordAppliedAt !== undefined) {
        const timeVerdict = classifyGuidedAnswer("time", args.recordAppliedAt, {
          approvedAtIso: approvedPlan.approvedAt
        });
        if (timeVerdict.outcome === "accept") {
          suggestedRecord = { appliedAtIso: args.recordAppliedAt };
        } else {
          recordNotices.push(recordTimeSetAsideNotice(
            timeVerdict.outcome === "reject"
              ? timeVerdict.message
              : "the time could not be read"
          ));
        }
      }
      if (recordNotices.length > 0) {
        guidedIo.write(recordNotices.join("\n\n"));
      }
      const record = await runRecordSitting(guidedIo, {
        header,
        approvedAtIso: approvedPlan.approvedAt,
        approvedByLine,
        ...(suggestedRecord !== undefined ? { suggested: suggestedRecord } : {}),
        ...(args.recordCanary !== undefined
          ? { agentCanaryReport: args.recordCanary }
          : {})
      });
      if (record.action === "cancelled") {
        return ok(renderCleanExit({
          lines: [
            `${experimentTag(preferred.id)} · nothing recorded`,
            "Your approved plan is still waiting for its result."
          ],
          next: { reason: "run this again to record what happened", command: improveRuntimeCommand }
        }));
      }
      if (record.action === "backedOut") {
        // m12c: this path restates the FINDING label, not the approved
        // sentence (hash-only persistence) — the caveat says so, indented
        // inside the quoted block by renderForYourAgent.
        return ok(renderCleanExit({
          lines: [`${experimentTag(preferred.id)} · waiting for the applied change`],
          extraBlocks: [renderForYourAgent(
            `${improveAgentInstruction(model.oneChange.label)}\n${improveAgentInstructionHashCaveat}`
          )],
          next: { reason: "after the agent reports back, run exactly this", command: improveRuntimeCommand }
        }));
      }
      if (record.action === "notYet") {
        return ok(renderCleanExit({
          lines: ["Nothing recorded yet — run the approved canary first."],
          next: { reason: "after the canary has run", command: improveRuntimeCommand }
        }));
      }
      const requested = buildImproveExperience({
        preferredExperiment: preferred,
        sessionVitals,
        interactive: true,
        intent: {
          kind: "record_preapproved_application",
          approvedAt: approvedPlan.approvedAt,
          appliedAt: record.appliedAtIso,
          approvalRef: approvedPlan.references.actionRef,
          changeRef: approvedPlan.references.changeRef,
          rollbackRef: approvedPlan.references.rollbackRef,
          canaryRef: approvedPlan.references.canaryRef,
          canaryStatus: record.canary
        }
      });
      const operation = requested.advancedOperation;
      if (!operation || operation.kind !== "mark_applied") {
        throw new Error(requested.interaction.blockedReason ??
          "the current evidence did not authorize this change");
      }
      preferred = await applyImproveOperation(operation, rootPath, contextHealth);
      model = buildImproveExperience({ preferredExperiment: preferred, interactive: true });
      if (preferred.intervention.canary?.status === "failed") {
        return ok(renderCleanExit({
          lines: [
            `Recorded · ${experimentTag(preferred.id)} · canary: failed (user-declared)`,
            "Execute the rollback you preserved. No post-change reduction will be",
            "claimed from this attempt."
          ],
          next: { reason: "after you have rolled back", command: improveRuntimeCommand }
        }));
      }
      return ok(renderCleanExit({
        lines: [
          `Recorded · ${experimentTag(preferred.id)} · applied ${record.appliedAtIso} · canary: passed (user-declared)`,
          "Use your agent normally now. aibill needs matched completed sessions",
          "after the change before it can measure anything."
        ],
        next: { reason: "after a few normal completed tasks", command: improveRuntimeCommand }
      }));
    }

    if (model.phase === "collecting" && preferred && observation) {
      const missingQuality = preferred.postSessions.some((session) => (
        session.quality.status === "missing"
      ));
      if (preferred.postSessions.length >= preferred.matchingPolicy.minimumPostSessions && missingQuality) {
        const declared = await runQualitySitting(guidedIo, {
          header: { commandTitle, experimentLabel: experimentTag(preferred.id) },
          matchedSessions: preferred.postSessions.length,
          minimumSessions: preferred.matchingPolicy.minimumPostSessions
        });
        if (declared.action === "stillMissing") {
          return ok(renderCleanExit({
            lines: ["Quality stays missing. No result will be claimed until you can say."],
            next: { reason: "run this again when you can declare quality", command: improveRuntimeCommand }
          }));
        }
        if (declared.action === "cancelled") {
          return ok(renderCleanExit({
            lines: ["Nothing changed. The matched sessions are still waiting for your quality call."],
            next: { reason: "run this again to declare quality", command: improveRuntimeCommand }
          }));
        }
        if (declared.action === "declared") {
          const qualityBySessionRef = Object.fromEntries(
            preferred.postSessions
              .filter((session) => session.quality.status === "missing")
              .map((session) => [session.sessionRef, declared.quality === "held" ? "passed" : "failed"] as const)
          );
          const refreshed = refreshTokenReductionExperimentV0(preferred, {
            sessionVitals: observation.sessionVitals,
            observedAt: observation.generatedAt,
            qualityBySessionRef,
            contextHealth: observation.contextHealth
          });
          await upsertTokenReductionExperiment(rootPath, refreshed, {
            expectedRevisionId: preferred.revisionId
          });
          preferred = refreshed;
          model = buildImproveExperience({ preferredExperiment: preferred, interactive: true });
          const resultLines = model.result
            ? [
                "RESULT",
                model.result.headline,
                `Evidence: ${model.result.metricEvidence} · quality: ${model.result.qualityLabel} (${model.result.qualityEvidence})`
              ]
            : [`Recorded · ${experimentTag(preferred.id)} · quality: ${declared.quality} (user-declared)`];
          return ok(renderCleanExit({
            lines: resultLines,
            next: declared.quality === "regressed"
              ? { reason: "run this again to record the rollback", command: improveRuntimeCommand }
              : { reason: "run this again to review progress", command: improveRuntimeCommand }
          }));
        }
      }
    }

    if (model.phase === "rollback" && preferred?.intervention.rollbackRef &&
        preferred.lifecycle !== "rolled_back") {
      const approvedRollbackRef = preferred.intervention.rollbackRef;
      const rolled = await runRollbackSitting(guidedIo, {
        header: { commandTitle, experimentLabel: experimentTag(preferred.id) },
        sanitize: sanitizeLocalActivityText,
        rollbackExample: "Restore the prior session workflow.",
        matchesApprovedRollback: (evidence) =>
          createActionVerificationReference("rollback-artifact", evidence) === approvedRollbackRef
      });
      if (rolled.action === "notRolledBack") {
        return ok(renderCleanExit({
          lines: ["Roll back first — the approved change is still in place."],
          next: { reason: "after you have rolled back", command: improveRuntimeCommand }
        }));
      }
      if (rolled.action === "cancelled") {
        return ok(renderCleanExit({
          lines: ["Nothing changed. The approved change is still recorded as applied."],
          next: { reason: "run this again after you have rolled back", command: improveRuntimeCommand }
        }));
      }
      if (rolled.action === "rolledBack") {
        const requested = buildImproveExperience({
          preferredExperiment: preferred,
          interactive: true,
          intent: {
            kind: "rollback",
            rolledBackAt: new Date().toISOString(),
            rollbackEvidence: rolled.evidence
          }
        });
        preferred = await applyImproveOperation(
          requested.advancedOperation,
          rootPath,
          contextHealth
        );
        model = buildImproveExperience({ preferredExperiment: preferred, interactive: true });
        return ok(renderCleanExit({
          lines: [
            `Rolled back · ${experimentTag(preferred.id)} (user-declared)`,
            "The evidence is preserved; no reduction will be claimed from this",
            "attempt."
          ],
          next: { reason: "run this again when you want to look", command: improveRuntimeCommand }
        }));
      }
    }

    return ok(renderImproveExperience(
      model,
      improveProjectLine ? { projectLine: improveProjectLine } : {}
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(
      "no persisted spend state and no supported local-agent financial evidence found."
    )) {
      const setup = buildImproveExperience({
        interactive: runtime.interactive === true,
        readOnly: runtime.prompt === undefined
      });
      return ok(renderImproveExperience(setup, {
        note: `No token test was created. Use Claude Code or Codex normally, then rerun \`${improveRuntimeCommand}\`.`
      }));
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't run the local token test: ${sanitizeSecretishError(message)}`
    };
  }
}

async function applyImproveOperation(
  operation: ImproveAdvancedOperation | null,
  rootPath: string,
  contextHealth?: ContextHealthResult
): Promise<TokenReductionExperimentV0> {
  if (!operation) throw new Error("the requested action was not authorized by the current evidence phase");
  let next: TokenReductionExperimentV0 | null;
  let expectedRevisionId: string | undefined;
  switch (operation.kind) {
    case "freeze_baseline":
      next = buildTokenReductionBaselineV0({
        finding: operation.finding,
        sessionVitals: operation.sessionVitals,
        createdAt: operation.createdAt,
        qualityBySessionRef: operation.qualityBySessionRef,
        ...(contextHealth ? { contextHealth } : {})
      });
      break;
    case "mark_applied":
      expectedRevisionId = operation.expectedRevisionId;
      next = markTokenReductionAppliedV0(operation.experiment, operation.input);
      break;
    case "refresh_experiment":
      expectedRevisionId = operation.expectedRevisionId;
      next = refreshTokenReductionExperimentV0(operation.experiment, {
        ...operation.input,
        ...(contextHealth ? { contextHealth } : {})
      });
      break;
    case "mark_rolled_back":
      expectedRevisionId = operation.expectedRevisionId;
      next = markTokenReductionRolledBackV0(operation.experiment, operation.input);
      break;
    case "cancel_experiment":
      expectedRevisionId = operation.expectedRevisionId;
      next = invalidateTokenReductionExperimentV0(operation.experiment, operation.input);
      break;
  }
  if (!next) throw new Error("the current evidence does not support a comparable baseline");
  await upsertTokenReductionExperiment(rootPath, next, {
    ...(expectedRevisionId ? { expectedRevisionId } : {})
  });
  return next;
}

function renderImproveExperience(
  model: ImproveExperienceModel,
  options: { note?: string; projectLine?: string } = {}
): string {
  const progress = model.progress
    ? `${model.progress.postChangeSessions}/${model.progress.minimumSessions} matched post-change sessions`
    : "No active matched cohort yet";
  return [
    "aibill improve · one reversible token test",
    "",
    model.headline,
    model.detail,
    // C-lane §3: improve is project-scoped — the current project's standing
    // on the card's primary basis, omitted (never fabricated) when no
    // attribution exists.
    ...(options.projectLine ? ["", "PROJECT", options.projectLine] : []),
    "",
    "ONE CHANGE",
    model.oneChange.label,
    "",
    "PROGRESS",
    progress,
    ...(model.result ? [
      "",
      "RESULT",
      model.result.headline,
      `Evidence: ${model.result.metricEvidence} · quality: ${model.result.qualityLabel} (${model.result.qualityEvidence})`
    ] : []),
    ...(options.note ? ["", options.note] : []),
    "",
    "Local only · no provider settings or code changed automatically."
  ].join("\n");
}

function findPreapprovedPlan(
  experiment: TokenReductionExperimentV0,
  state: ProjectAccountabilityStateV1
): ProjectAccountabilityStateV1["approvals"][number] | undefined {
  return [...state.approvals].reverse().find((event) => {
    if (Date.parse(event.approvedAt) < Date.parse(experiment.createdAt)) return false;
    try {
      return event.references.actionRef === createProjectEconomicsPlannedActionRefV0(
        experiment,
        {
          changeRef: event.references.changeRef,
          rollbackRef: event.references.rollbackRef,
          canaryRef: event.references.canaryRef
        }
      );
    } catch {
      return false;
    }
  });
}

async function identifyProjectCommand(
  args: ParsedArgs,
  runtime: CliRuntimeOptions
): Promise<CliResult> {
  const rootGuard = await guardExactProjectRoot("identify", args.path);
  if (rootGuard) return rootGuard;
  const rootPath = resolve(args.path);
  try {
    const guidedIo = runtime.interactive ? await createGuidedIo(runtime) : undefined;
    const current = await loadProjectAccountabilityState(rootPath);
    const projectRef = await projectAccountabilityRootReference(rootPath);
    // Flag-seeded values pass the SAME classifier as typed answers before
    // they can prefill a screen or reach storage (B3/B4 QA M1): an invalid
    // seed is dropped — never echoed, never Enter-kept, never stored.
    const cleanSeed = (
      kind: "name" | "team" | "role" | "optional",
      value: string | undefined
    ): string | undefined => {
      if (!value) return undefined;
      const verdict = classifyGuidedAnswer(kind, value);
      return verdict.outcome === "accept" ? verdict.value : undefined;
    };
    let humanOwner = cleanSeed("name", args.person?.trim());
    let team = cleanSeed("team", args.team?.trim());
    let role = cleanSeed("role", args.role?.trim());
    let client = cleanSeed("optional", args.client?.trim());
    let costCenter = cleanSeed("optional", args.costCenter?.trim());
    const identifyNext = {
      reason: "start the token test once ownership is confirmed",
      command: improveRuntimeCommand
    };
    if (guidedIo) {
      let needsSequence = !(humanOwner && team && role);
      for (;;) {
        if (needsSequence) {
          const seq = await runIdentitySequence(guidedIo, {
            header: {
              commandTitle: "aibill identify · who owns this project's AI cost",
              experimentLabel: `project ${basename(rootPath)}`,
              sitting: "IDENTIFY"
            },
            stepLabel: (_fieldLabel, fieldIndex) => ({ step: fieldIndex + 1, totalSteps: 6 }),
            sittingHint: shortSittingHint,
            initial: {
              ...(humanOwner ? { humanOwner } : {}),
              ...(team ? { team } : {}),
              ...(role ? { role } : {}),
              ...(client ? { client } : {}),
              ...(costCenter ? { costCenter } : {})
            }
          });
          if (seq.action !== "answered") {
            return ok(renderCleanExit({
              lines: ["Ownership was not confirmed. Nothing changed."],
              next: identifyNext
            }));
          }
          humanOwner = seq.identity.humanOwner;
          team = seq.identity.team;
          role = seq.identity.role;
          client = seq.identity.client;
          costCenter = seq.identity.costCenter;
        }
        guidedIo.write([
          "STEP 6 of 6 · confirm",
          "",
          `  Owner: ${humanOwner} · Team: ${team} · Role: ${role}`,
          `  Client: ${client || "—"} · Cost center: ${costCenter || "—"}`,
          ""
        ].join("\n"));
        const confirmed = await askGuidedQuestion({
          kind: "choice",
          render: () => [
            "QUESTION · step 6 of 6",
            `Confirm ${humanOwner} owns ${basename(rootPath)} for ${team} as ${role}?`,
            "  Answer y or n. Type back to edit a field, or cancel to stop safely.",
            "> "
          ].join("\n"),
          context: { choiceTokens: ["y", "n"] },
          sittingHint: shortSittingHint,
          write: guidedIo.write,
          source: guidedIo.source,
          ...(guidedIo.maxIdenticalRejections !== undefined
            ? { maxIdenticalRejections: guidedIo.maxIdenticalRejections }
            : {})
        });
        if (confirmed.outcome === "back") {
          // Re-open the fields prefilled — typed answers are never discarded.
          needsSequence = true;
          continue;
        }
        if (confirmed.outcome !== "answered" || confirmed.value !== "y") {
          return ok(renderCleanExit({
            lines: ["Ownership was not confirmed. Nothing changed."],
            next: identifyNext
          }));
        }
        break;
      }
    }
    if (!humanOwner || !team || !role) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: [
          "Confirm the accountable human, team, and approval role explicitly.",
          `Run: ${actionRuntimeCommand('identify --person "Name" --team "Team" --role "Role"')}`,
          "Optional: --client \"Client\" --cost-center \"Cost center\""
        ].join("\n")
      };
    }
    let next: ProjectAccountabilityStateV1;
    try {
      const ownership = createProjectAccountabilityOwnership({
        projectRef,
        humanOwnerLabel: humanOwner,
        teamLabel: team,
        ...(client ? { clientLabel: client } : {}),
        ...(costCenter ? { costCenterLabel: costCenter } : {}),
        confirmedAt: new Date().toISOString(),
        confirmedByLabel: humanOwner,
        approverRoleLabel: role
      });
      next = await upsertConfirmedProjectOwnership(rootPath, ownership, {
        expectedOwnershipId: current.ownership?.contract.id ?? null
      });
    } catch (identityError) {
      if (guidedIo) {
        // Backstop only — every field was already classifier-validated.
        const reason = identityError instanceof Error ? identityError.message : String(identityError);
        return ok(renderCleanExit({
          lines: [
            `That identity could not be stored: ${sanitizeSecretishError(reason)}`,
            "Nothing changed."
          ],
          next: { reason: "run this again to re-enter the fields", command: actionRuntimeCommand("identify") }
        }));
      }
      throw identityError;
    }
    const labels = next.ownership!.displayLabels;
    return ok(renderCleanExit({
      lines: [
        "Project accountability confirmed locally",
        `owner: ${labels.humanOwner}`,
        `team: ${labels.team}`,
        ...(labels.client ? [`client: ${labels.client}`] : []),
        ...(labels.costCenter ? [`cost center: ${labels.costCenter}`] : []),
        `approval role: ${next.ownership!.approverRole.roleLabel}`,
        "basis: explicit local confirmation · not inferred · not company RBAC"
      ],
      next: identifyNext
    }));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't confirm project accountability: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
}

async function projectAccountabilityRootReference(rootPath: string): Promise<string> {
  return createProjectEconomicsReference(
    "project-root",
    await resolveSafeScanRoot(rootPath)
  );
}

async function projectActionRootReference(rootPath: string): Promise<string> {
  return createActionVerificationReference(
    "project-working-directory",
    await resolveSafeScanRoot(rootPath)
  );
}

async function projectOutcomeCommand(args: ParsedArgs): Promise<CliResult> {
  const rootGuard = await guardExactProjectRoot("outcome", args.path);
  if (rootGuard) return rootGuard;
  if (args.outcomeAction !== "github") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Use \`${actionRuntimeCommand('outcome github [--pr N] [--business-outcome "…"]')}\`. Nothing was fetched.`
    };
  }
  const rootPath = resolve(args.path);
  try {
    const current = await loadProjectAccountabilityState(rootPath);
    if (!current.ownership) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Confirm this project's human owner and team first: ${actionRuntimeCommand("identify")}`
      };
    }
    const fetched = await fetchGitHubAcceptedOutcomeV0({
      projectRoot: rootPath,
      ...(args.pullRequestNumber ? { pullRequestNumber: args.pullRequestNumber } : {}),
      ...(args.businessOutcome ? { businessDescription: args.businessOutcome } : {})
    });
    if (fetched.status === "error") {
      return { exitCode: 1, stdout: "", stderr: fetched.message };
    }
    const next = await appendAcceptedProjectOutcome(rootPath, fetched.outcome);
    return ok([
      "Accepted GitHub outcome recorded locally",
      `selection: ${fetched.selection === "explicit_pr" ? `PR #${args.pullRequestNumber}` : "current branch PR"}`,
      "state: merged · observed status checks passed",
      `accepted: ${fetched.outcome.acceptedAt}`,
      ...(fetched.outcome.businessDescription
        ? [`business outcome: ${fetched.outcome.businessDescription.value} (user-declared)`]
        : []),
      `outcomes retained: ${next.outcomes.length}`,
      "No source code, URL, native commit SHA, or credential was stored."
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't record the accepted outcome: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
}

type ProjectAccountabilityProjectionV1 = {
  schemaVersion: 1;
  owner: {
    status: "confirmed" | "missing";
    human?: string;
    team?: string;
    client?: string;
    costCenter?: string;
    basis: "local_user_confirmation" | "missing";
  };
  outcome: {
    status: "accepted" | "missing";
    platform?: "github";
    acceptedAt?: string;
    businessDescription?: string;
    businessDescriptionBasis?: "user_declared";
    linkage?: "linked_to_token_test" | "unlinked_project_evidence";
  };
  approval: {
    status: "recorded" | "missing";
    role?: string;
    approvedAt?: string;
    basis: "local_self_attested" | "missing";
    rbacVerified: false;
    linkage?: "linked_to_token_test" | "unlinked_project_evidence";
  };
  tokenTest: ReturnType<typeof projectTokenTestProjection>;
  billReconciliation: {
    status: "not_attempted";
    invoiceReconciled: false;
  };
  projectEconomicsReceipt: {
    status: "receipt_ready" | "incomplete";
    receiptId?: string;
    missing: string[];
  };
};

async function projectAccountabilityCommand(args: ParsedArgs): Promise<CliResult> {
  const rootGuard = await guardExactProjectRoot("accountability", args.path);
  if (rootGuard) return rootGuard;
  const rootPath = resolve(args.path);
  try {
    const state = await loadProjectAccountabilityState(rootPath);
    const experiment = chooseLatestTokenReductionExperiment(
      (await loadTokenVerificationState(rootPath)).experiments
    );
    const projection = buildProjectAccountabilityProjection(
      await projectActionRootReference(rootPath),
      state,
      experiment
    );
    if (args.json) return ok(JSON.stringify(projection, null, 2));
    const owner = projection.owner.status === "confirmed"
      ? `${projection.owner.human} · ${projection.owner.team}`
      : `Missing · run ${actionRuntimeCommand("identify")}`;
    const allocation = projection.owner.status === "confirmed"
      ? [projection.owner.client && `client ${projection.owner.client}`,
          projection.owner.costCenter && `cost center ${projection.owner.costCenter}`]
          .filter(Boolean).join(" · ") || "No client or cost center confirmed"
      : "Not confirmed";
    const outcome = projection.outcome.status === "accepted"
      ? projection.outcome.linkage === "linked_to_token_test"
        ? `Linked GitHub outcome accepted ${projection.outcome.acceptedAt}`
        : `Unlinked project evidence · GitHub outcome accepted ${projection.outcome.acceptedAt}; this does not show that the current token test produced it`
      : `Missing · run ${actionRuntimeCommand("outcome github")}`;
    const approval = projection.approval.status === "recorded"
      ? projection.approval.linkage === "linked_to_token_test"
        ? `${projection.approval.role} · ${projection.approval.approvedAt} · linked pre-change local self-attestation`
        : `Unlinked project evidence · ${projection.approval.role} · ${projection.approval.approvedAt}; this does not approve the current token test`
      : "Missing · approval is recorded only when one token test is authorized";
    return ok([
      "aibill accountability · this project",
      "",
      "WHO OWNS THIS COST?",
      owner,
      allocation,
      "",
      "WHAT OUTCOME DID IT PRODUCE?",
      outcome,
      ...(projection.outcome.businessDescription
        ? [`${projection.outcome.businessDescription} (user-declared business meaning)`]
        : []),
      "",
      "WHO APPROVED THE CHANGE?",
      approval,
      "RBAC verified: no",
      "",
      "WHAT HAPPENED AFTERWARD?",
      projection.tokenTest.headline,
      projection.tokenTest.detail,
      "",
      "PROVIDER BILL",
      "Not reconciled in this local preview; billed cost and API-equivalent value remain separate.",
      "",
      "PROJECT ECONOMICS RECEIPT",
      projection.projectEconomicsReceipt.status === "receipt_ready"
        ? projection.projectEconomicsReceipt.missing.length > 0
          ? `Envelope ready · evidence incomplete: ${projection.projectEconomicsReceipt.missing.join(", ")} · ${projection.projectEconomicsReceipt.receiptId}`
          : `Receipt ready · ${projection.projectEconomicsReceipt.receiptId}`
        : `Incomplete · ${projection.projectEconomicsReceipt.missing.join(", ") || "required linked evidence is missing"}`
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't read project accountability: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
}

function buildProjectAccountabilityProjection(
  actionProjectRef: string,
  state: ProjectAccountabilityStateV1,
  experiment?: TokenReductionExperimentV0
): ProjectAccountabilityProjectionV1 {
  const ownership = state.ownership;
  // This human view always describes the latest recorded evidence. Older
  // evidence is never silently substituted merely because it links better.
  // The latest item earns a linked label only through the canonical bridges.
  const approval = state.approvals.at(-1);
  const scopedExperiment = experiment?.cohort.projectRef === actionProjectRef
    ? experiment
    : undefined;
  const linkedApprovalCandidate = scopedExperiment
    ? findPreapprovedPlan(scopedExperiment, state)
    : undefined;
  const linkedApproval = approval?.id === linkedApprovalCandidate?.id
    ? approval
    : undefined;
  const outcome = state.outcomes.at(-1);
  const linkedOutcome = ownership && scopedExperiment && outcome
    ? (() => {
        const candidateProjection = buildProjectEconomicsProjectionV0({
          generatedAt: new Date().toISOString(),
          scope: {
            projectRef: ownership.contract.projectRef,
            workUnitRef: outcome.workUnitRef,
            actionProjectRef,
            actionWorkUnitRef: createActionVerificationReference(
              "accepted-work-unit",
              outcome.workUnitRef
            )
          },
          financialRecords: [],
          ownership: ownership.contract,
          ...(linkedApproval ? { approvalEvent: linkedApproval } : {}),
          outcome,
          tokenExperiment: scopedExperiment
        });
        return !candidateProjection.missing.some((entry) =>
          entry.code === "experiment_work_unit_scope" ||
          entry.code === "outcome_work_unit_scope"
        ) ? outcome : undefined;
      })()
    : undefined;
  const projectEconomics = ownership && outcome
    ? buildProjectEconomicsProjectionV0({
        generatedAt: new Date().toISOString(),
        scope: {
          projectRef: ownership.contract.projectRef,
          workUnitRef: outcome.workUnitRef,
          actionProjectRef,
          actionWorkUnitRef: createActionVerificationReference(
            "accepted-work-unit",
            outcome.workUnitRef
          )
        },
        financialRecords: [],
        ownership: ownership.contract,
        ...(approval ? { approvalEvent: approval } : {}),
        outcome,
        ...(scopedExperiment ? { tokenExperiment: scopedExperiment } : {})
      })
    : undefined;
  return {
    schemaVersion: 1,
    owner: ownership ? {
      status: "confirmed",
      human: ownership.displayLabels.humanOwner,
      team: ownership.displayLabels.team,
      ...(ownership.displayLabels.client ? { client: ownership.displayLabels.client } : {}),
      ...(ownership.displayLabels.costCenter
        ? { costCenter: ownership.displayLabels.costCenter }
        : {}),
      basis: "local_user_confirmation"
    } : { status: "missing", basis: "missing" },
    outcome: outcome ? {
      status: "accepted",
      platform: "github",
      acceptedAt: outcome.acceptedAt,
      linkage: outcome.id === linkedOutcome?.id
        ? "linked_to_token_test"
        : "unlinked_project_evidence",
      ...(outcome.businessDescription ? {
        businessDescription: outcome.businessDescription.value,
        businessDescriptionBasis: "user_declared"
      } : {})
    } : { status: "missing" },
    approval: approval && ownership ? {
      status: "recorded",
      role: ownership.approverRole.roleLabel,
      approvedAt: approval.approvedAt,
      basis: "local_self_attested",
      rbacVerified: false,
      linkage: approval.id === linkedApproval?.id
        ? "linked_to_token_test"
        : "unlinked_project_evidence"
    } : { status: "missing", basis: "missing", rbacVerified: false },
    tokenTest: projectTokenTestProjection(scopedExperiment),
    billReconciliation: { status: "not_attempted", invoiceReconciled: false },
    projectEconomicsReceipt: projectEconomics ? {
      status: projectEconomics.status,
      ...(projectEconomics.receipt ? { receiptId: projectEconomics.receipt.id } : {}),
      missing: projectEconomics.missing.map((entry) => entry.code)
    } : {
      status: "incomplete",
      missing: [
        ...(!ownership ? ["confirmed_ownership"] : []),
        ...(!outcome ? ["accepted_outcome"] : []),
        ...(!scopedExperiment ? ["token_experiment"] : [])
      ]
    }
  };
}

function projectTokenTestProjection(experiment?: TokenReductionExperimentV0): {
  status: "not_started" | "collecting" | "reduced" | "unchanged" | "regressed" | "inconclusive";
  headline: string;
  detail: string;
  reductionPercent: number | null;
  quality: "held" | "regressed" | "insufficient" | "missing";
} {
  if (!experiment) return {
    status: "not_started",
    headline: "No matched token test yet",
    detail: `Run ${improveRuntimeCommand} from the exact project root to test one reversible change.`,
    reductionPercent: null,
    quality: "missing"
  };
  const projection = buildActionVerificationProjectionV0(experiment);
  const reduction = projection.reductionPercent;
  if (projection.state === "review_measured_result" &&
      projection.evidenceLabel === "calculated" &&
      projection.qualityLabel === "held" && reduction !== null) {
    if (reduction > 0) return {
      status: "reduced",
      headline: `${formatMeasuredPercent(reduction)} fewer tokens per comparable completed session`,
      detail: "Calculated by aibill from this project's frozen matched baseline and post-change sessions; quality held by user declaration.",
      reductionPercent: reduction,
      quality: "held"
    };
    if (reduction === 0) return {
      status: "unchanged",
      headline: "No measured token change",
      detail: "Matched session medians were unchanged and quality held by user declaration.",
      reductionPercent: 0,
      quality: "held"
    };
  }
  if (projection.state === "rollback" || experiment.evaluation.status === "regressed") {
    return {
      status: "regressed",
      headline: "Token use or quality regressed; use the preserved rollback",
      detail: projection.detail,
      reductionPercent: reduction,
      quality: projection.qualityLabel
    };
  }
  if (projection.state === "collect_post_change" ||
      projection.state === "collect_baseline" ||
      projection.state === "approve_one_change") {
    return {
      status: "collecting",
      headline: projection.headline,
      detail: projection.detail,
      reductionPercent: null,
      quality: "insufficient"
    };
  }
  return {
    status: "inconclusive",
    headline: "No defensible token-reduction result yet",
    detail: projection.detail,
    reductionPercent: null,
    quality: experiment.evaluation.qualityStatus
  };
}

function formatMeasuredPercent(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 2;
  return `${value.toFixed(digits).replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1")}%`;
}

async function applyArtifactCommand(args: ParsedArgs): Promise<CliResult> {
  // NEW-B3 (cold-start audit): every project-scoped command reachable from a
  // broad root produces the SAME friendly exact-project guidance — never the
  // raw scan refusal, never the crash wrapper.
  const rootGuard = await guardExactProjectRoot("apply", args.path);
  if (rootGuard) return rootGuard;

  const rootPath = resolve(args.path);

  try {
    const sinceDays = args.sinceDays ?? 30;
    if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();
    // Apply is a state-writing command. Establish (or safely migrate) the
    // private, Git-ignored project-state boundary before the first state read.
    // This keeps a first Apply followed by a second Apply usable while still
    // refusing tracked or repository-authored state.
    const stateDir = await resolveSafeStateDirectory(rootPath, { create: true });
    // Sample mode is an absolute privacy boundary and never reads local state.
    // In live mode, an active project-scoped experiment is the action to finish
    // even if its original transient signal no longer appears in a fresh scan.
    // Foreground it before generating or overwriting any Apply artifacts.
    if (!args.sample) {
      const active = chooseLatestTokenReductionExperiment(
        (await loadTokenVerificationState(rootPath)).experiments.filter((experiment) =>
          experiment.lifecycle !== "complete" &&
          experiment.lifecycle !== "rolled_back" &&
          experiment.lifecycle !== "invalidated"
        )
      );
      if (active) {
        return tokenVerificationResult(active, false, [
          "An active token test already owns this project; Apply handed off to it and generated no conflicting candidate or artifacts.",
          `Use your agent normally on this project, then: ${improveRuntimeCommand}`
        ]);
      }
    }
    // `--sample` is a privacy boundary, not presentation sugar. It must never
    // fall through to live transcript, plan, credential, or persisted-state
    // discovery — regardless of where the flag appears after the command.
    const reportInput = args.sample
      ? await buildExplicitSampleReportInput(rootPath)
      : await buildReportInput(stateDir, rootPath, sinceDays);
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
    const noCandidateGuidance = codingPrompt.includes("NO SCOPED CHANGE CANDIDATE")
      ? [
          "",
          "No scoped change is supported yet. Collect the missing source evidence instead of guessing:",
          ...applyEvidenceAcquisitionLines(reportInput)
        ]
      : [];
    return ok([
      "aibill apply-artifact",
      `path: ${rootPath}`,
      `action plan: ${artifactPaths.actionPlan}`,
      `policy/config draft: ${artifactPaths.policyConfigDraft}`,
      `verification plan: ${artifactPaths.verificationPlan}`,
      `demo package: ${artifactPaths.demoPackage}`,
      "safety: generated artifacts only; no external systems changed",
      ...noCandidateGuidance,
      "",
      `──── copy everything below into Claude Code / Codex (also saved at ${artifactPaths.codingPrompt}) ────`,
      "",
      codingPrompt.trimEnd()
    ].join("\n"));
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        `Couldn't build apply artifacts: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`,
        "Collect evidence, then retry Apply:",
        "- Claude Code / Codex / Gemini CLI: use the agent normally so supported local history exists.",
        "- OpenAI / Anthropic / Cursor / GitHub Copilot: run `npx aibill connect <provider>` with an admin credential reference.",
        "- Diagnose the exact gap: `npx aibill doctor --sources`.",
        `- Demo only: \`${actionRuntimeCommand("apply --sample")}\` (non-executable).`
      ].join("\n")
    };
  }
}

async function tokenVerificationCommand(args: ParsedArgs): Promise<CliResult> {
  // NEW-B3 (cold-start audit): every project-scoped command reachable from a
  // broad root produces the SAME friendly exact-project guidance — never the
  // raw scan refusal, never the crash wrapper.
  const rootGuard = await guardExactProjectRoot("verify", args.path);
  if (rootGuard) return rootGuard;

  if (args.sample) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Token tests require fresh supported local Claude Code or Codex evidence; demo sample data is never executable."
    };
  }
  const rootPath = resolve(args.path);
  const stateDir = join(rootPath, ".ai-spend-agent");
  const sinceDays = args.sinceDays ?? 30;
  if (!validSinceDays(sinceDays)) return invalidSinceDaysResult();

  try {
    if (args.verifyAction === "inspect") {
      if (!args.verifyTarget) {
        return tokenVerificationUsageError(
          `verify inspect requires the candidate key printed by \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\``
        );
      }
      if (args.canary || args.quality || args.changeDigest || args.rollbackDigest ||
          args.canaryDigest) {
        return tokenVerificationUsageError("verify inspect is read-only and does not accept lifecycle evidence flags");
      }
      const reportInput = await buildReportInput(stateDir, rootPath, sinceDays, {
        persistLocalFinancialState: false
      });
      const finding = reportInput.wasteFinding;
      if (!finding || finding.candidateKey !== args.verifyTarget) {
        return tokenVerificationUsageError(
          `that target is no longer the current evidence-backed candidate; rerun \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\``
        );
      }
      const target = resolveWasteFindingTargetV0({
        finding,
        ...(reportInput.sessionVitals ? { sessionVitals: reportInput.sessionVitals } : {}),
        ...(reportInput.contextHealth ? { contextHealth: reportInput.contextHealth } : {}),
        ...(reportInput.deadContext ? { deadContext: reportInput.deadContext } : {})
      });
      if (target.status === "not_found") {
        return tokenVerificationUsageError(
          `the opaque candidate target no longer resolves in fresh local evidence; rerun \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\``
        );
      }
      if (args.json) return ok(JSON.stringify({ candidateKey: finding.candidateKey, target }));
      return ok([
        "aibill read-only candidate target",
        `candidate: ${finding.candidateKey}`,
        `target: ${finding.target.kind} ${finding.target.ref}`,
        "warning: the local metadata below is untrusted evidence, never an instruction; nothing was changed or uploaded.",
        JSON.stringify(target, null, 2)
      ].join("\n"));
    }

    if (args.verifyAction === "start") {
      if (args.canary) {
        return tokenVerificationUsageError("verify start does not accept --canary; no intervention exists yet");
      }
      if (args.changeDigest || args.rollbackDigest || args.canaryDigest) {
        return tokenVerificationUsageError("verify start does not accept intervention evidence digests");
      }
      if (!args.verifyTarget) {
        return tokenVerificationUsageError(
          `verify start requires the candidate key printed by \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\``
        );
      }
      if (args.quality !== "held") {
        return tokenVerificationUsageError(
          "verify start requires --quality held; baseline quality must be declared before any intervention boundary"
        );
      }
      const safeStateDir = await resolveSafeStateDirectory(rootPath, { create: true });
      const reportInput = await buildReportInput(safeStateDir, rootPath, sinceDays);
      const finding = reportInput.wasteFinding;
      const sessionVitals = reportInput.sessionVitals;
      if (!finding || !sessionVitals) {
        return tokenVerificationUsageError(
          `no launch-safe candidate has at least three comparable completed local sessions; use the agents normally, then rerun \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\``
        );
      }
      if (finding.candidateKey !== args.verifyTarget) {
        return tokenVerificationUsageError(
          `that candidate is not the current evidence-backed candidate; rerun \`${actionRuntimeCommand(`apply --since-days ${sinceDays}`)}\` and use its exact key`
        );
      }
      const qualityBySessionRef = qualityMapForAllSessions(
        sessionVitals,
        "passed"
      );
      const experiment = buildTokenReductionBaselineV0({
        finding,
        sessionVitals,
        createdAt: reportInput.generatedAt ?? new Date().toISOString(),
        ...(reportInput.contextHealth ? { contextHealth: reportInput.contextHealth } : {}),
        ...(qualityBySessionRef ? { qualityBySessionRef } : {})
      });
      if (!experiment || experiment.lifecycle !== "baseline_ready") {
        return tokenVerificationUsageError(
          "the candidate does not yet have three matched records with explicit host completion evidence and the same agent, model, project, session type, work type, and source format"
        );
      }
      const existing = activeExperimentForFindingScope(
        (await loadTokenVerificationState(rootPath)).experiments,
        experiment.finding
      );
      if (existing) {
        return tokenVerificationResult(existing, args.json, [
          "An active token test already owns this project/provider/agent scope; no duplicate baseline was created and no conflicting baseline was drafted."
        ]);
      }
      await upsertTokenReductionExperiment(rootPath, experiment);
      return tokenVerificationResult(experiment, args.json, [
        "Baseline frozen locally. Nothing was changed.",
        `Next: inspect and approve one reversible change, preserve its rollback, run a canary, then record the actual user-declared timestamps and outcome with \`${actionRuntimeCommand(`verify mark-applied ${experiment.id} --approved-at <ISO-8601> --applied-at <ISO-8601> --canary passed|failed --change-digest <sha256> --rollback-digest <sha256> --canary-digest <sha256>`)}\`.`,
        `If it failed, execute the frozen rollback and record that separate boundary with \`${actionRuntimeCommand(`verify rollback ${experiment.id} --rollback-digest <same-sha256>`)}\`; do not collect post-change sessions or claim a reduction.`
      ]);
    }

    const state = await loadTokenVerificationState(rootPath);
    const experiment = args.verifyTarget
      ? state.experiments.find((candidate) => candidate.id === args.verifyTarget)
      : chooseLatestTokenReductionExperiment(state.experiments);
    if (!experiment) {
      return tokenVerificationUsageError(
        args.verifyTarget
          ? "that experiment ID was not found in this project's safe local state"
          : `no local token test exists; from this exact project root run \`${improveRuntimeCommand}\``
      );
    }

    if (args.verifyAction === "mark-applied") {
      if (args.quality) {
        return tokenVerificationUsageError("verify mark-applied does not accept --quality; label matched work when starting or evaluating the test");
      }
      if (args.sinceDays !== undefined) {
        return tokenVerificationUsageError("verify mark-applied does not accept --since-days; the experiment boundary is immutable");
      }
      if (!args.verifyTarget) {
        return tokenVerificationUsageError("verify mark-applied requires an exact experiment ID");
      }
      if (!args.canary) {
        return tokenVerificationUsageError("verify mark-applied requires --canary passed or --canary failed");
      }
      const approvedAt = canonicalBoundaryTimestamp(args.approvedAt);
      const appliedAt = canonicalBoundaryTimestamp(args.appliedAt);
      if (!approvedAt || !appliedAt) {
        return tokenVerificationUsageError(
          "verify mark-applied requires the actual --approved-at and --applied-at timestamps in ISO-8601 form; aibill never invents a pre-change approval time after the canary"
        );
      }
      if (Date.parse(approvedAt) >= Date.parse(appliedAt)) {
        return tokenVerificationUsageError(
          "--approved-at must be earlier than --applied-at; approval after or at application is not a pre-change boundary"
        );
      }
      if (Date.parse(appliedAt) > Date.now()) {
        return tokenVerificationUsageError("--applied-at cannot be in the future");
      }
      const changeRef = digestReference("approved-change", args.changeDigest);
      const rollbackRef = digestReference("rollback-artifact", args.rollbackDigest);
      const canaryRef = digestReference("canary-result", args.canaryDigest);
      if (!changeRef || !rollbackRef || !canaryRef) {
        return tokenVerificationUsageError(
          "an intervention boundary requires 64-character SHA-256 values for --change-digest, --rollback-digest, and --canary-digest; aibill stores only opaque references"
        );
      }
      const applied = markTokenReductionAppliedV0(experiment, {
        approvedAt,
        appliedAt,
        changeRef,
        rollbackRef,
        canaryRef,
        canaryStatus: args.canary
      });
      await upsertTokenReductionExperiment(rootPath, applied, {
        expectedRevisionId: experiment.revisionId
      });
      if (args.canary === "failed") {
        const recorded = tokenVerificationResult(applied, args.json, [
          "The failed canary was preserved as user-declared evidence; no reduction will be calculated from this attempt.",
          `Execute the frozen rollback, then record that separate boundary with \`${actionRuntimeCommand(`verify rollback ${applied.id} --rollback-digest <same-sha256>`)}\`.`
        ]);
        return {
          exitCode: 1,
          stdout: recorded.stdout,
          stderr: "Canary failed. aibill recorded the attempted change and now recommends the separately evidenced rollback; it made no savings claim."
        };
      }
      return tokenVerificationResult(applied, args.json, [
        "The user-supplied pre-change approval time, intervention boundary, and passing canary are recorded as user-declared evidence.",
        `Next: complete at least ${applied.matchingPolicy.minimumPostSessions} comparable sessions, then run \`${actionRuntimeCommand(`verify ${applied.id} --quality held`)}\`.`
      ]);
    }

    if (args.verifyAction === "rollback") {
      if (!args.verifyTarget) {
        return tokenVerificationUsageError("verify rollback requires an exact experiment ID");
      }
      if (args.canary || args.quality || args.changeDigest || args.canaryDigest ||
          args.sinceDays !== undefined) {
        return tokenVerificationUsageError(
          "verify rollback accepts only the experiment ID and the frozen --rollback-digest"
        );
      }
      const rollbackRef = digestReference("rollback-artifact", args.rollbackDigest);
      if (!rollbackRef) {
        return tokenVerificationUsageError(
          "verify rollback requires the same 64-character SHA-256 --rollback-digest frozen at mark-applied"
        );
      }
      const rolledBack = markTokenReductionRolledBackV0(experiment, {
        rolledBackAt: new Date().toISOString(),
        rollbackRef
      });
      await upsertTokenReductionExperiment(rootPath, rolledBack, {
        expectedRevisionId: experiment.revisionId
      });
      return tokenVerificationResult(rolledBack, args.json, [
        "Rollback execution was recorded against the frozen opaque rollback reference."
      ]);
    }

    if (args.verifyAction === "cancel") {
      if (!args.verifyTarget) {
        return tokenVerificationUsageError("verify cancel requires an exact experiment ID");
      }
      if (args.canary || args.quality || args.changeDigest || args.rollbackDigest ||
          args.canaryDigest || args.sinceDays !== undefined) {
        return tokenVerificationUsageError(
          "verify cancel accepts only an un-applied experiment ID"
        );
      }
      const invalidated = invalidateTokenReductionExperimentV0(experiment, {
        invalidatedAt: new Date().toISOString(),
        reason: "manual"
      });
      await upsertTokenReductionExperiment(rootPath, invalidated, {
        expectedRevisionId: experiment.revisionId
      });
      // The cancelled experiment's unfinished plan answers are dead with it.
      await createPlanDraftStore(rootPath).clear();
      return tokenVerificationResult(invalidated, args.json, [
        "The un-applied token test was cancelled; its evidence remains in local history and its scope is available for a new baseline."
      ]);
    }

    if (args.canary) {
      return tokenVerificationUsageError("verify result does not accept --canary; use verify mark-applied for the canary boundary");
    }
    if (args.changeDigest || args.rollbackDigest || args.canaryDigest) {
      return tokenVerificationUsageError("verify result does not accept intervention evidence digests");
    }
    if (args.sinceDays !== undefined) {
      return tokenVerificationUsageError("verify result does not accept --since-days; it reads from the experiment's immutable intervention boundary");
    }

    if (!experiment.intervention.appliedAt) {
      if (args.quality) {
        return tokenVerificationUsageError(
          "quality for post-change work cannot be recorded before an approved intervention boundary"
        );
      }
      return tokenVerificationResult(experiment, args.json);
    }

    if (experiment.lifecycle === "complete" || experiment.lifecycle === "rolled_back" ||
        experiment.lifecycle === "invalidated" ||
        experiment.intervention.canary?.status === "failed") {
      if (args.quality) {
        return tokenVerificationUsageError(
          "terminal or failed-canary token tests cannot accept new post-change quality evidence"
        );
      }
      return tokenVerificationResult(experiment, args.json, [
        "This token test is terminal or awaiting its required rollback; no new session evidence was appended."
      ]);
    }

    const observation = await loadTokenVerificationObservation(rootPath, experiment);
    if (!observation.qualitativeCoverageComplete) {
      return tokenVerificationUsageError(
        "the bounded qualitative index is incomplete for this experiment's agent; no post-change sessions or reduction percentage were accepted"
      );
    }
    const unlabelled = refreshTokenReductionExperimentV0(experiment, {
      sessionVitals: observation.sessionVitals,
      observedAt: observation.generatedAt,
      contextHealth: observation.contextHealth
    });
    const qualityBySessionRef = qualityMapForMatchedPostSessions(unlabelled, args.quality);
    const refreshed = qualityBySessionRef
      ? refreshTokenReductionExperimentV0(experiment, {
          sessionVitals: observation.sessionVitals,
          observedAt: observation.generatedAt,
          contextHealth: observation.contextHealth,
          qualityBySessionRef
        })
      : unlabelled;
    await upsertTokenReductionExperiment(rootPath, refreshed, {
      expectedRevisionId: experiment.revisionId
    });
    return tokenVerificationResult(refreshed, args.json);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Couldn't evaluate the local token test: ${sanitizeSecretishError(error instanceof Error ? error.message : String(error))}`
    };
  }
}

async function loadTokenVerificationObservation(
  rootPath: string,
  experiment: TokenReductionExperimentV0
): Promise<{
  generatedAt: string;
  sessionVitals: SessionVitalsV0;
  contextHealth: ContextHealthResult;
  qualitativeCoverageComplete: boolean;
}> {
  const generatedAt = new Date();
  const sinceIso = experiment.intervention.appliedAt ?? experiment.createdAt;
  const logs = await loadBoundedLocalActionEvidence(sinceIso);
  const calls = logs.calls.filter((call) => (
    localAgentFormatSupports(call.agent, "actionPlanning") &&
    callMatchesActionProject(call, experiment.cohort.projectRef)
  ));
  const windowDays = Math.max(
    1,
    Math.ceil((generatedAt.getTime() - Date.parse(sinceIso)) / (24 * 60 * 60 * 1_000))
  );
  const contextOptions = {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    claudeHomeDir: process.env.AI_SPEND_CLAUDE_HOME_DIR,
    codexHomeDir: process.env.AI_SPEND_CODEX_HOME_DIR,
    claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
    claudeSettingsPath: process.env.AI_SPEND_CLAUDE_SETTINGS,
    projectDir: rootPath,
    sinceIso,
    windowDays,
    codexInvocationFiles: logs.codexInvocationFiles
  };
  const contextHealth = await loadContextHealth(calls, contextOptions).catch(() =>
    buildContextHealth({ calls, now: generatedAt, windowDays })
  );
  return {
    generatedAt: generatedAt.toISOString(),
    sessionVitals: extractSessionVitalsV0(calls),
    contextHealth,
    qualitativeCoverageComplete:
      (experiment.cohort.agent === "claude-code" || experiment.cohort.agent === "codex") &&
      hasCompleteQualitativeCoverage(logs, [experiment.cohort.agent])
  };
}

function qualityMapForAllSessions(
  vitals: SessionVitalsV0,
  quality: "passed" | "failed" | "missing"
): Record<string, "passed" | "failed" | "missing"> | undefined {
  if (quality === "missing") return undefined;
  return Object.fromEntries(vitals.sessions.map((session) => [session.sessionRef, quality]));
}

function qualityMapForMatchedPostSessions(
  refreshed: TokenReductionExperimentV0,
  quality: ParsedArgs["quality"]
): Record<string, "passed" | "failed" | "missing"> | undefined {
  if (!quality || quality === "missing") return undefined;
  const entries = refreshed.postSessions
    .filter((session) => session.quality.status === "missing")
    .map((session) => [
    session.sessionRef,
    quality === "held" ? "passed" : "failed"
    ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function activeExperimentForFindingScope(
  experiments: readonly TokenReductionExperimentV0[],
  finding: NonNullable<SpendReportInput["wasteFinding"]>
): TokenReductionExperimentV0 | undefined {
  return chooseLatestTokenReductionExperiment(experiments.filter((experiment) =>
    experiment.lifecycle !== "complete" &&
    experiment.lifecycle !== "rolled_back" &&
    experiment.lifecycle !== "invalidated" &&
    experiment.cohort.projectRef === finding.scope.projectRef &&
    experiment.cohort.provider === finding.scope.provider &&
    experiment.cohort.agent === finding.scope.agent
  ));
}

function digestReference(namespace: string, digest: string | undefined): string | undefined {
  return digest && /^[a-f0-9]{64}$/i.test(digest)
    ? createActionVerificationReference(namespace, digest.toLowerCase())
    : undefined;
}

function canonicalBoundaryTimestamp(value: string | undefined): string | undefined {
  return value && validIsoString(value) ? new Date(value).toISOString() : undefined;
}

function tokenVerificationUsageError(message: string): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: [
      message,
      "Run `npx aibill --help` for the safe token-test lifecycle."
    ].join("\n")
  };
}

function tokenVerificationResult(
  experiment: TokenReductionExperimentV0,
  json = false,
  notes: string[] = []
): CliResult {
  const projection = buildActionVerificationProjectionV0(experiment);
  if (json) return ok(JSON.stringify({ experiment, projection }));
  const evaluation = experiment.evaluation;
  const measured = evaluation.reductionPercent === null
    ? "not available"
    : evaluation.reductionPercent > 0
      ? `${evaluation.reductionPercent.toFixed(2)}% fewer tokens in the matched session cohort`
      : evaluation.reductionPercent < 0
        ? `${Math.abs(evaluation.reductionPercent).toFixed(2)}% more tokens in the matched session cohort`
        : "no measured token change in the matched session cohort";
  const resultLabel = evaluation.status.replaceAll("_", " ");
  return ok([
    "aibill token test",
    `experiment: ${experiment.id}`,
    `revision: ${experiment.revisionId}`,
    `candidate: ${experiment.finding.candidateKey}`,
    `state: ${projection.state}`,
    `baseline: ${projection.baselineSessions}/${projection.minimumSessions} matched completed session snapshots`,
    `post-change: ${projection.postChangeSessions}/${projection.minimumSessions} matched completed session snapshots`,
    `result: ${resultLabel}`,
    `measured change: ${measured}`,
    `quality: ${evaluation.qualityStatus} (${evaluation.qualityEvidence})`,
    `evidence: ${evaluation.metricEvidence}; matching=${evaluation.matchingEvidence}`,
    `rollback: ${experiment.lifecycle === "rolled_back"
      ? "recorded"
      : evaluation.rollbackRecommended
        ? "recommended"
        : "not triggered by current evidence"}`,
    "claim boundary: a session-cohort result is measured—not certified savings, verified ROI, or a provider bill.",
    "privacy: raw prompts, responses, native session IDs, absolute paths, and credentials are not stored in this experiment.",
    ...notes
  ].join("\n"));
}

function applyEvidenceAcquisitionLines(input: SpendReportInput): string[] {
  const records = input.allRecords ?? input.providerRecords ?? [];
  const providers = new Set(records.map((record) => record.source.provider));
  const sinceDays = input.evidenceWindowDays ?? input.deadContext?.windowDays ?? 30;
  const lines: string[] = [];
  if (providers.has("anthropic") || providers.has("openai") || input.dataMode === "local_logs") {
    lines.push(`- Local coding agents: run \`npx aibill context --json --since-days ${sinceDays}\` after comparable Claude Code/Codex sessions to inspect action-capable context evidence from this exact window.`);
  }
  if (providers.has("gemini") || providers.has("gemini-cli")) {
    lines.push("- Gemini CLI: current chat evidence is financial-only; unsupported context/action evidence remains missing.");
  }
  if (input.dataMode === "connected_provider") {
    lines.push("- Provider billing: sync explicit call/invocation-level workload evidence; aggregate owner or spend rows do not authorize a change.");
  }
  if (lines.length === 0) {
    lines.push("- Run `npx aibill doctor --sources` to see which local or provider evidence is missing.");
  }
  return lines;
}

/**
 * Machine-wide report input — built from {@link loadBroadScanEvidence}, the
 * SAME call the `--full` readout makes from the same directory (0.9.6).
 *
 * 0.9.4 shipped this as a parallel thin builder over `loadInstantReadData`,
 * keeping only the financial records. Everything that gates an action claim —
 * the bounded transcript index above all — was dropped, so the report package
 * fell back to `qualitativeCoverage: "unknown"` and every ACT/VERIFY branch
 * degraded, while `--full` from the same home showed real ranked candidates.
 * The evidence is not project-scoped and never was; only the builder was
 * withholding it.
 *
 * No project state is read or created. Everything below comes from the shared
 * bundle; nothing is re-derived here.
 */
async function buildMachineWideReportInput(
  args: ParsedArgs,
  sinceDays: number
): Promise<
  | { kind: "input"; input: SpendReportInput }
  | { kind: "no_evidence"; warnings: readonly string[] }
> {
  const evidence = await loadBroadScanEvidence(args, sinceDays);
  if (evidence.records.length === 0) {
    // Same honest empty-state voice the receipt/report-card use — an empty
    // report file would just look broken.
    return { kind: "no_evidence", warnings: evidence.warnings };
  }
  const { records, mode, actionEvidence } = evidence;
  return {
    kind: "input",
    input: {
      generatedAt: new Date().toISOString(),
      summary: evidence.summary,
      allRecords: records,
      dataMode: mode === "connected" ? "connected_provider" : "local_logs",
      evidenceWindowDays: sinceDays,
      detectedPlans: evidence.detectedPlans,
      // The ranked set the readout prints, verbatim — not a second derivation.
      actionCandidates: evidence.actionCandidates,
      analysisScope: "machine-wide",
      // The bounded transcript index the 0.9.4 builder dropped. This is what
      // un-degrades ACT, VERIFY, plan context, and the configuration section.
      qualitativeCoverage: summarizeCliQualitativeCoverage(actionEvidence),
      qualitativeCoverageByAgent: summarizeCliQualitativeCoverageByAgent(actionEvidence),
      ...(evidence.deadContext ? { deadContext: evidence.deadContext } : {}),
      ...(mode === "connected" ? { providerRecords: records } : {}),
      ...(mode === "connected" && (evidence.localFinancialRecords?.length ?? 0) > 0
        ? { localFinancialRecords: evidence.localFinancialRecords! }
        : {}),
      ...(evidence.providerCoverage ? { providerCoverage: evidence.providerCoverage } : {})
    }
  };
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
    detectedPlans: [],
    qualitativeCoverage: {
      status: "unknown",
      selectedFiles: 0,
      readCompletely: 0,
      skippedForBudget: 0
    },
    qualitativeCoverageByAgent: {
      "claude-code": "unknown",
      codex: "unknown"
    }
  };
}

async function buildReportInput(
  stateDir: string,
  rootPath: string,
  sinceDays = 30,
  options: { persistLocalFinancialState?: boolean } = {}
) {
  // One anchor for logs, Context Health, the paste-ready prompt, and every
  // supporting Apply artifact. This prevents millisecond window drift between
  // files generated by the same command.
  const generatedAt = new Date();
  const sinceIso = sinceIsoForDays(sinceDays, generatedAt);
  const canonicalActionProjectRef = createActionVerificationReference(
    "project-working-directory",
    await resolveSafeScanRoot(rootPath)
  );
  let freshLocalCalls: LocalAgentLogResult["calls"] | undefined;
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
    const parsedModeRecords = mode === "sample" || mode === undefined
      ? downgradeSampleUsageEvidence(parsedRecords)
      : parsedRecords;
    const records = mode === "connected_provider"
      ? applyProviderContractGate(parsedModeRecords)
      : parsedModeRecords;
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
  // Always read supported local transcripts for context/action evidence. A
  // trusted connected snapshot remains the authoritative financial ledger and
  // is never rewritten or relabeled by this read.
  const freshActionLogs = await loadBoundedLocalActionEvidence(sinceIso).catch(() => undefined);
  if (freshActionLogs && freshActionLogs.calls.length > 0) {
    freshLocalCalls = freshActionLogs.calls;
    freshCodexInvocationFiles = freshActionLogs.codexInvocationFiles;
  }
  // Financial and qualitative readers have separate truth contracts. Always
  // read the bounded/streaming financial axis once: local mode uses it as the
  // headline, while connected mode carries it into the saved report as a
  // separate API-equivalent comparison that is never added to billed cost.
  const freshFinancialLogs = await loadLocalAgentFinancialUsage({ financialIndex: cliFinancialIndex,
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    codexSessionsDir: process.env.AI_SPEND_CODEX_LOGS_DIR,
    geminiSessionsDir: process.env.AI_SPEND_GEMINI_LOGS_DIR,
    sinceIso
  }).catch(() => undefined);
  if (needsFreshLogs) {
    if (freshFinancialLogs && freshFinancialLogs.records.length > 0) {
      const records = freshFinancialLogs.records;
      const summary = analyzeSpend(records);
      const liveMappings = attributeUsageRecords(records);
      if (options.persistLocalFinancialState !== false) {
        await writeLocalSpendState(stateDir, records, summary, liveMappings, "local_logs");
      }
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
        "Persisted local-log state is an untrusted cache and its source local-agent records are unavailable. " +
          "Re-run `npx aibill` while the local transcripts are available; no report or Apply action was generated from repository state alone."
      );
    }
    throw new Error(
      "no persisted spend state and no supported local-agent financial evidence found. " +
        "Use Claude Code, Codex, or Gemini CLI normally; connect an admin provider for billed cost; " +
        "or run `npx aibill doctor --sources` to inspect the exact gap."
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

  const callsForCurrentProject = freshLocalCalls?.filter((call) =>
    callMatchesActionProject(call, canonicalActionProjectRef)
  );
  const actionPlanningCalls = callsForCurrentProject?.filter((call) => (
    localAgentFormatSupports(call.agent, "actionPlanning")
  ));
  const contextHealthCalls = callsForCurrentProject?.filter((call) => (
    localAgentFormatSupports(call.agent, "contextHealth")
  ));
  const hasLocalActionEvidence = Boolean(actionPlanningCalls?.length);

  // Named dead-context items feed the local action artifact even when a
  // connected provider snapshot owns the financial headline.
  const deadContext = hasLocalActionEvidence
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

  const detectedPlans = hasLocalActionEvidence
    ? await detectLocalPlans({
        claudeConfigPath: process.env.AI_SPEND_CLAUDE_CONFIG,
        codexAuthPath: process.env.AI_SPEND_CODEX_AUTH
      }).catch(() => [] as DetectedPlan[])
    : [];

  // Report/apply and Glance consume the same canonical Context Health result.
  // If live transcript calls are unavailable, omit it instead of fabricating a
  // session-level recommendation from day-aggregate spend records.
  const contextHealth = contextHealthCalls && contextHealthCalls.length > 0
    ? await loadContextHealth(contextHealthCalls, {
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
  const sessionVitals = actionPlanningCalls && actionPlanningCalls.length > 0
    ? extractSessionVitalsV0(actionPlanningCalls)
    // Local financial rows may belong to a different project than the exact
    // Apply root. Preserve an explicit empty action-evidence contract so the
    // report layer cannot fall back to a machine-wide aggregate candidate.
    : spendState.mode === "local_logs"
      ? extractSessionVitalsV0([])
      : undefined;
  const qualitativeCoverage = summarizeCliQualitativeCoverage(freshActionLogs);
  const completeActionEvidence = qualitativeCoverage.status === "complete" && freshActionLogs
    ? hasCompleteQualitativeCoverage(
        freshActionLogs,
        [...new Set((actionPlanningCalls ?? []).map((call) => call.agent))]
      )
    : false;
  const wasteFinding = sessionVitals && completeActionEvidence
    ? selectBestWasteFindingV0({
        sessionVitals,
        generatedAt: generatedAt.toISOString(),
        ...(contextHealth ? { contextHealth } : {}),
        ...(deadContext ? { deadContext } : {})
      })
    : null;

  return {
    generatedAt: generatedAt.toISOString(),
    evidenceWindowDays: sinceDays,
    summary: spendState.summary,
    deadContext,
    detectedPlans,
    contextHealth,
    ...(sessionVitals ? { sessionVitals } : {}),
    ...(wasteFinding ? { wasteFinding } : {}),
    qualitativeCoverage,
    qualitativeCoverageByAgent: summarizeCliQualitativeCoverageByAgent(freshActionLogs),
    // Evidence ledger is built from the SAME records as the confidence
    // breakdown so the two sections can never contradict each other.
    allRecords: spendState.mode === "connected_provider"
      ? selectProviderFinancialHeadlineRecords(spendState.records ?? [])
      : spendState.records ?? [],
    ...(spendState.mode === "connected_provider" && (freshFinancialLogs?.records.length ?? 0) > 0
      ? { localFinancialRecords: freshFinancialLogs!.records }
      : {}),
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
    demoPackage: join(stateDir, "demo-package.md"),
    wasteFinding: join(stateDir, "waste-finding.json")
  };
  await writeSafeStateText(stateDir, basename(paths.codingPrompt), generateApplyArtifactMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.actionPlan), generateActionPlanMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.policyConfigDraft), generatePolicyConfigDraftMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.verificationPlan), generateVerificationPlanMarkdown(reportInput));
  await writeSafeStateText(stateDir, basename(paths.demoPackage), generateDemoPackageMarkdown(reportInput));
  if (reportInput.wasteFinding) {
    await writeSafeStateText(
      stateDir,
      basename(paths.wasteFinding),
      `${JSON.stringify(reportInput.wasteFinding, null, 2)}\n`
    );
  } else {
    // A prior candidate must never survive a fresh no-candidate run. `rm`
    // removes a symlink itself rather than following it, and a directory at
    // this file path fails closed because recursive deletion is not enabled.
    await rm(paths.wasteFinding, { force: true });
  }
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
    path: process.cwd(),
    parseErrors: []
  };
  if (command === "statusline" && rest[0] && !rest[0].startsWith("--")) {
    parsed.statuslineAction = rest.shift();
  }
  if (command === "connect" && rest[0] && !rest[0].startsWith("--")) {
    parsed.provider = rest[0];
    rest.shift();
  }
  if (command === "signup" && rest[0] && !rest[0].startsWith("-")) {
    parsed.signupEmail = rest.shift();
  }
  if (command === "telemetry" && rest[0] && !rest[0].startsWith("--")) {
    parsed.telemetryAction = rest.shift();
  }
  if (command === "verify") {
    const first = rest[0];
    if (first === "inspect" || first === "start" || first === "mark-applied" ||
        first === "rollback" || first === "cancel") {
      parsed.verifyAction = first;
      rest.shift();
    } else {
      parsed.verifyAction = "result";
    }
    if (rest[0] && !rest[0]!.startsWith("--")) {
      parsed.verifyTarget = rest.shift();
    }
  }
  if (command === "outcome" && rest[0] && !rest[0]!.startsWith("--")) {
    if (rest[0] === "github") parsed.outcomeAction = "github";
    else parsed.parseErrors.push(`unsupported outcome source "${rest[0]}"; use github`);
    rest.shift();
  }

  const valueFlags = new Set([
    "--plan", "--since-days", "--path", "--out",
    "--source-path", "--type", "--provider", "--source-id", "--team",
    "--person", "--client", "--cost-center", "--role", "--project", "--agent", "--workflow",
    "--evidence", "--confidence", "--label", "--auth-reference",
    "--start-time", "--end-time", "--org", "--enterprise", "--account-id", "--account",
    "--interval", "--cycles", "--canary", "--quality", "--change-digest",
    "--rollback-digest", "--canary-digest", "--approved-at", "--applied-at",
    "--pr", "--business-outcome",
    "--draft", "--record-applied-at", "--record-canary",
    "--ref"
  ]);
  const numericValueFlags = new Set([
    "--since-days", "--confidence", "--start-time", "--end-time", "--interval", "--cycles", "--pr"
  ]);
  // A repeated --draft/--record-* flag means the pasted line was assembled
  // from two commands: a parse error, never a silent last-wins (§2b, m11).
  const seenOnceOnlyFlags = new Set<string>();
  const onceOnly = (flag: string): boolean => {
    if (seenOnceOnlyFlags.has(flag)) {
      parsed.parseErrors.push(`${flag} may appear once`);
      return false;
    }
    seenOnceOnlyFlags.add(flag);
    return true;
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const nextValue = rest[index + 1];
    const nextLooksLikeFlag = nextValue?.startsWith("--") ||
      (!numericValueFlags.has(arg) && nextValue?.startsWith("-"));
    if (valueFlags.has(arg) && (nextValue === undefined || nextLooksLikeFlag)) {
      parsed.parseErrors.push(`${arg} requires a value`);
      continue;
    }
    if (arg === "--sample") {
      parsed.sample = true;
      continue;
    }
    if (arg === "--no-color") {
      parsed.noColor = true;
      continue;
    }
    if (arg === "--no-open") {
      parsed.noOpen = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--full") {
      parsed.full = true;
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
    if (arg === "--canary") {
      const next = rest[index + 1];
      if (next === "passed" || next === "failed") {
        parsed.canary = next;
        index += 1;
      } else if (next) {
        parsed.parseErrors.push("--canary must be passed or failed");
        index += 1;
      }
      continue;
    }
    if (arg === "--quality") {
      const next = rest[index + 1];
      if (next === "held" || next === "regressed" || next === "missing") {
        parsed.quality = next;
        index += 1;
      } else if (next) {
        parsed.parseErrors.push("--quality must be held, regressed, or missing");
        index += 1;
      }
      continue;
    }
    if (arg === "--approved-at" || arg === "--applied-at") {
      const next = rest[index + 1];
      if (next) {
        if (arg === "--approved-at") parsed.approvedAt = next;
        else parsed.appliedAt = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--draft") {
      const next = rest[index + 1];
      if (next) {
        if (onceOnly("--draft")) {
          if (looksLikeAgentDraftToken(next)) {
            parsed.agentDraftToken = next;
          } else {
            parsed.parseErrors.push(
              "--draft must be the single ab1.… token from draft_improve_command; do not hand-build or quote it"
            );
          }
        }
        index += 1;
      }
      continue;
    }
    if (arg === "--record-applied-at") {
      const next = rest[index + 1];
      if (next) {
        if (onceOnly("--record-applied-at")) {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/.test(next)) {
            parsed.recordAppliedAt = next;
          } else {
            parsed.parseErrors.push(
              "--record-applied-at must be a UTC Z time, e.g. 2026-08-18T09:12:00Z"
            );
          }
        }
        index += 1;
      }
      continue;
    }
    if (arg === "--record-canary") {
      const next = rest[index + 1];
      if (next) {
        if (onceOnly("--record-canary")) {
          if (next === "passed" || next === "failed") {
            parsed.recordCanary = next;
          } else {
            parsed.parseErrors.push("--record-canary must be passed or failed");
          }
        }
        index += 1;
      }
      continue;
    }
    if (arg === "--change-digest" || arg === "--rollback-digest" ||
        arg === "--canary-digest") {
      const next = rest[index + 1];
      if (next) {
        if (arg === "--change-digest") parsed.changeDigest = next;
        else if (arg === "--rollback-digest") parsed.rollbackDigest = next;
        else parsed.canaryDigest = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--ignore-state") {
      parsed.ignoreState = true;
      continue;
    }
    if (arg === "--forget") {
      parsed.signupForget = true;
      continue;
    }
    if (arg === "--never") {
      parsed.signupNever = true;
      continue;
    }
    if (arg === "--ref") {
      const next = rest[index + 1];
      if (next) {
        // Allowlist sanitization happens here so nothing outside
        // [a-z0-9-]{1,24} can ever reach the payload builder (QA 8).
        const tag = sanitizeSignupRefTag(next);
        if (tag === undefined) {
          parsed.parseErrors.push("--ref must be 1-24 lowercase letters, digits, or dashes (e.g. --ref starfund)");
        } else {
          parsed.signupRef = tag;
        }
        index += 1;
      }
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
      } else if (next) {
        parsed.parseErrors.push(`--type received unsupported source type "${next}"`);
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
    if (arg === "--cost-center") {
      const next = rest[index + 1];
      if (next) {
        parsed.costCenter = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--role") {
      const next = rest[index + 1];
      if (next) {
        parsed.role = next;
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
        } else {
          parsed.parseErrors.push("--confidence must be a number between 0 and 1");
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
        const value = Number(next);
        if (Number.isFinite(value)) parsed.startTime = value;
        else parsed.parseErrors.push("--start-time must be a finite Unix timestamp");
        index += 1;
      }
      continue;
    }
    if (arg === "--end-time") {
      const next = rest[index + 1];
      if (next) {
        const value = Number(next);
        if (Number.isFinite(value)) parsed.endTime = value;
        else parsed.parseErrors.push("--end-time must be a finite Unix timestamp");
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
    if (arg === "--account") {
      const next = rest[index + 1];
      if (next) {
        parsed.account = next;
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
    if (arg === "--pr") {
      const next = rest[index + 1];
      if (next) {
        const value = Number(next);
        if (Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000_000) {
          parsed.pullRequestNumber = value;
        } else {
          parsed.parseErrors.push("--pr must be a positive pull-request number");
        }
        index += 1;
      }
      continue;
    }
    if (arg === "--business-outcome") {
      const next = rest[index + 1];
      if (next) {
        parsed.businessOutcome = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--interval") {
      const next = rest[index + 1];
      if (next) {
        const value = Number(next);
        if (Number.isFinite(value) && value > 0) parsed.interval = value;
        else parsed.parseErrors.push("--interval must be a positive number of seconds");
        index += 1;
      }
      continue;
    }
    if (arg === "--cycles") {
      const next = rest[index + 1];
      if (next) {
        const value = Number(next);
        if (Number.isInteger(value) && value >= 0) parsed.cycles = value;
        else parsed.parseErrors.push("--cycles must be a whole number of 0 or greater");
        index += 1;
      }
      continue;
    }
    // A11 (copy polish on the existing unknown-flag rejection): quoted
    // per-sentence draft flags never existed — point at the one-token design.
    const draftFlagHint =
      arg === "--draft-change" || arg === "--draft-rollback" || arg === "--draft-canary"
        ? " — agent drafts travel as one --draft token from draft_improve_command, not as quoted sentences"
        : "";
    parsed.parseErrors.push(
      arg.startsWith("-")
        ? `unknown flag "${arg}"${draftFlagHint}`
        : `unexpected argument "${arg}"`
    );
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
        if (trust.trusted) return applyProviderContractGateToSourceRegistry(registry);
      }
    } catch {
      // A source boundary remains usable as configuration, but its repository-
      // controlled validation/evidence claims are never promoted without the
      // matching external provider-sync receipt.
    }
    return applyProviderContractGateToSourceRegistry(downgradeUntrustedSourceRegistryClaims(registry));
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

function helpText(telemetryDisclosure?: boolean): string {
  return [
    "aibill — your AI cost and usage evidence in one private view",
    "",
    "Run with no command for an instant, zero-key local readout:",
    "  npx aibill                           Show a compact receipt from available local/connected evidence",
    "  npx aibill --full                    Show the complete diagnose → recommend → apply → verify audit",
    "  npx aibill --sample                  Show the clearly labeled illustrative demo (never implicit)",
    "  npx aibill --group-by agent          Drill down by source|model|client|project|agent|user|workspace|apiKey",
    "  npx aibill --plan <id>               Declare your plan when auto-detection can't (claude-max-5x|claude-max-20x|claude-pro|chatgpt-plus|chatgpt-pro)",
    `  ${improveRuntimeCommand}    Test one personalized change and measure whether token usage fell`,
    `  ${actionRuntimeCommand("index")}    Read very large agent histories to completion so results stop saying "indexing"`,
    `  ${actionRuntimeCommand("identify")}    Confirm the human owner, team, client/cost center, and approval role`,
    `  ${actionRuntimeCommand("outcome github")}    Attach one merged PR whose observed status checks passed`,
    `  ${actionRuntimeCommand("accountability")}    Answer owner → outcome → approval → measured-result for this project`,
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
    "  statusline expand       Print every subscription with committed price, runways, and 7d API-equivalent",
    "  signup <email> [--ref <token>]  Join the launch list · email only · the exact payload is shown before send",
    "    [--never]             Never ask again (nothing is sent)   [--forget]  Clear local signup state",
    "  telemetry [on|off]      Show anonymous command-count status + the exact last payload · switch it",
    "  doctor [--sources]      Launch diagnostics; --sources shows validation, evidence, freshness, and errors",
    "  reset [--path <dir>]    Clear persisted spend state (so sample state can't mask real logs)",
    "  --ignore-state          On the default/quickstart run, ignore persisted spend.json for this run",
    "  scan [--path <dir>]     Scan a local workspace for AI usage signals",
    "  scan --sample           Include deterministic sample spend analysis",
    "  quickstart [--sample] [--since-days N] Plain-English local readout (default 30 days)",
    "    [--full]            Render the complete audit; default is the compact receipt",
    "    [--group-by source|model|client|project|agent|user|workspace|apiKey]  Default: project for local logs; model otherwise",
    "  report [--sample] [--out <name>] [--since-days N] Generate local Markdown and HTML reports and open the HTML in your browser",
    "    [--no-open]           Skip the automatic browser open (also AI_SPEND_NO_OPEN=1; auto-open is TTY-only and never fires in CI or SSH sessions)",
    "  report-card [--out f.svg] Write your AI Receipt — a redacted, shareable SVG + caption",
    "  glance [--project <name>] [--plan <id>] [--since-days N] Emit the local, machine-readable Glance snapshot JSON",
    "  context [--project <name>] [--since-days N] Show hook-aware Context Health in the terminal",
    "    [--json]              Emit the same canonical Context Health object used by MCP and Glance",
    "  Main receipt JSON is not published yet; unsupported --json requests fail instead of returning text.",
    "  apply [--sample] [--since-days N]  Print an evidence-constrained inspection/approval prompt + verification plans",
    "  apply-artifact          Same as `apply` (long form)",
    "  identify --person <name> --team <team> --role <role> [--client <name>] [--cost-center <id>]",
    "    Confirm local accountability explicitly; no owner/team/client/cost-center is inferred.",
    "  outcome github [--pr N] [--business-outcome <text>]  Opt-in GitHub verification via gh; no default network call",
    "  accountability [--json] Show the local accountability projection; labels stay in this project's private state",
    "  Advanced token-test controls (the guided `improve` command normally handles these):",
    "  verify inspect <candidate-key> [--since-days N] [--json]  Resolve its exact target from the candidate's evidence window",
    "  verify start <candidate-key> --quality held [--since-days N]  Freeze a matched baseline from that same window",
    "  verify mark-applied <experiment-id> --approved-at <ISO-8601> --applied-at <ISO-8601>",
    "    --canary passed|failed --change-digest <sha256> --rollback-digest <sha256>",
    "    --canary-digest <sha256>  Record user-declared approval/application times and canary",
    "  verify rollback <experiment-id> --rollback-digest <sha256>  Record the frozen rollback",
    "  verify cancel <experiment-id>  Cancel an un-applied baseline and retain its audit evidence",
    "  verify <experiment-id> [--quality held|regressed|missing] [--json]  Calculate the matched result",
    "",
    "Cron (production watch): add a crontab entry such as:",
    "  0 * * * * cd /path/to/workspace && npx --yes aibill watch --interval 3600 --cycles 1 >> aibill-watch.log 2>&1",
    "",
    telemetryDisclosure === true
      ? `Privacy: local analysis and reports upload nothing; ${telemetryDisclosureLine}. Only explicit sync-provider contacts the selected provider through an env: reference.`
      : "Privacy: local analysis and reports upload nothing. Only explicit sync-provider contacts the selected provider through an env: reference.",
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
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const startedAtMs = Date.now();

  // Bin-entry-only telemetry (notice-before-first-byte; see telemetry.ts).
  // Embedded runCli callers and the MCP server never construct this, so
  // they can never emit an event.
  let telemetry: import("./telemetry.js").CliTelemetryRuntime | undefined;
  try {
    const { openCliTelemetry } = await import("./telemetry.js");
    telemetry = await openCliTelemetry();
  } catch {
    // Telemetry must never break the CLI.
  }

  // The during-scan signup ask (capture design, placement addendum
  // 2026-08-24): on a qualifying interactive first run the ask fills the
  // scan wait — it prints its own wait line, so the spinner stays off. A
  // run that does not qualify (or whose signup state disallows the ask)
  // takes the exact fast path below, byte-identical.
  let preAsk: import("./signup.js").TerminalPreReceiptAsk | undefined;
  if (interactive && !process.env.CI && !process.env.AI_SPEND_NO_PROMPT) {
    try {
      const signup = await import("./signup.js");
      if (signup.qualifiesForPreReceiptSignupAsk(argv)) {
        preAsk = await signup.openPreReceiptSignupAskInTerminal();
      }
    } catch {
      // The ask must never break the receipt path.
    }
  }

  // Show a spinner only for the work-heavy instant-demo path, only on a
  // real TTY so piped output stays clean, and never over the open ask.
  let spinner: { stop: () => void } | undefined;
  if (isInstantDemo && !preAsk && process.stdout.isTTY && !process.env.NO_COLOR) {
    try {
      const { default: yoctoSpinner } = await import("yocto-spinner");
      spinner = yoctoSpinner({ text: "Reading local AI evidence…" }).start();
    } catch {
      // Spinner is optional; never block the wow on it.
    }
  }

  let result: CliResult;
  let askOutcome: import("./signup.js").PreReceiptAskOutcome = { kind: "no_ask" };
  let promptInterface: import("node:readline/promises").Interface | undefined;
  let guidedInterface: import("node:readline").Interface | undefined;
  let consentReader: Awaited<ReturnType<typeof import("./signup.js").openTerminalConsentRead>> | undefined;
  try {
    let guidedIoShared:
      | { source: GuidedPromptSource; write: (text: string) => void }
      | undefined;
    const runPipeline = (): Promise<CliResult> => runCli(argv, {
      interactive,
      ...(telemetry?.disclosureActive === true ? { telemetryDisclosure: true } : {}),
      ...(interactive ? {
        prompt: async (question: string) => {
          if (!promptInterface) {
            const { createInterface } = await import("node:readline/promises");
            promptInterface = createInterface({ input: process.stdin, output: process.stdout });
          }
          return promptInterface.question(question);
        },
        // Consent-grade read for `signup <email>` (adversary SF1): buffered
        // type-ahead never answers; EOF/^C resolve undefined quietly.
        consentRead: async (query: string, timeoutMs: number) => {
          if (!consentReader) {
            const signup = await import("./signup.js");
            consentReader = await signup.openTerminalConsentRead();
          }
          return consentReader ? consentReader.read(query, timeoutMs) : undefined;
        },
        openGuidedIo: async () => {
          if (!guidedIoShared) {
            const { createInterface } = await import("node:readline");
            const lineInterface = createInterface({ input: process.stdin, output: process.stdout });
            guidedInterface = lineInterface;
            guidedIoShared = {
              source: createInteractivePromptSource({
                onLine: (listener) => { lineInterface.on("line", listener); },
                onClose: (listener) => { lineInterface.on("close", listener); },
                onInterrupt: (listener) => { lineInterface.on("SIGINT", listener); }
              }),
              write: (text: string) => {
                process.stdout.write(text.endsWith("> ") || text.endsWith("\n") ? text : `${text}\n`);
              }
            };
          }
          return guidedIoShared;
        }
      } : {})
    });
    if (preAsk) {
      // Receipt renders only when BOTH the human's answer (bounded by the
      // ask's own timeouts) and the pipeline have resolved; a pipeline
      // error still waits for the bounded ask, then re-throws into the
      // error voice below — never a hung prompt over a dead pipeline.
      const { orchestratePreReceiptAsk } = await import("./signup.js");
      const orchestrated = await orchestratePreReceiptAsk({ session: preAsk.session, runPipeline });
      askOutcome = orchestrated.outcome;
      if (!orchestrated.pipeline.ok) throw orchestrated.pipeline.error;
      result = orchestrated.pipeline.value;
    } else {
      result = await runPipeline();
    }
  } catch (error) {
    // The product's error voice, never a raw stack trace — and never an
    // un-redacted secret from a provider payload or file path.
    const message = sanitizeSecretishError(error instanceof Error ? error.message : String(error));
    result = {
      exitCode: 1,
      stdout: "",
      stderr: [
        `aibill hit an unexpected error: ${message}`,
        `${telemetry?.disclosureActive === true ? telemetryDisclosureLine : "Nothing was uploaded."} The command stopped without completing; run diagnostics before retrying.`,
        "Try `npx aibill doctor` for diagnostics, or open an issue: https://github.com/futurastudio/ai-spend-agent/issues"
      ].join("\n")
    };
  } finally {
    promptInterface?.close();
    guidedInterface?.close();
    consentReader?.close();
    spinner?.stop();
  }

  // A read that ended without the user pressing Enter (timeout / Ctrl-C)
  // left the prompt line open; start the receipt on a fresh line.
  if (preAsk?.needsFreshLine()) {
    process.stdout.write("\n");
  }
  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  process.exitCode = result.exitCode;

  // Consent renders strictly AFTER the receipt: scope line, the literal
  // payload JSON, a typed y, ONE POST. Nothing here can change the
  // receipt's bytes or exit code.
  if (preAsk && askOutcome.kind === "email") {
    await preAsk.runConsent(askOutcome);
  }
  preAsk?.close();

  // Telemetry LAST: on the first interactive run this prints the one-time
  // notice (and stamps it); on later noticed runs it fires ONE
  // fire-and-forget event with a hard 1500ms abort. Never blocks the
  // receipt, never changes the exit code.
  try {
    await telemetry?.finish({
      argv,
      ok: result.exitCode === 0,
      durationMs: Date.now() - startedAtMs,
      interactive,
      version: await cliVersion()
    });
  } catch {
    // Telemetry must never break the CLI.
  }
}

if (invokedAsMain) {
  await runMain();
}
