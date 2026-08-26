import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import {
  canPriceTokenUsageAtScope,
  estimateTokenCostUsd,
  estimateTokenCostsUsd,
  promptTierThreshold,
  usesPromptTieredPricing,
  type TokenUsage
} from "./modelPricing.js";
import type { UsageRecord } from "./schema.js";
import { redactSecrets } from "./discovery.js";
import {
  createCodexInvocationCollector,
  isCodexInvocationCollectorSnapshot,
  type CodexInvocationCollectorSnapshot,
  type ParsedInvocationFile,
  type ParsedInvocationWindowProof
} from "./toolInvocations.js";
import {
  localAgentFormatDescriptor,
  localAgentFormatDescriptors,
  localAgentFormatLabel,
  matchesLocalAgentDetectionFile,
  matchesLocalAgentFormatFile,
  validateLocalAgentFormatDescriptors
} from "./localAgentFormats/registry.js";
import type {
  LocalAgentFormatDescriptor,
  LocalAgentFormatFinancialFileContext,
  LocalAgentFormatId,
  LocalAgentFormatRuntime
} from "./localAgentFormats/types.js";
import {
  parseGeminiSession,
  type GeminiParseDiagnostic
} from "./localAgentFormats/gemini.js";

/**
 * Local agent-session log ingestion: turns the transcript files that coding
 * agents already write on this machine into UsageRecords, priced at
 * API-equivalent rates ("estimated" confidence).
 *
 * Why this exists: subscription usage (Claude Max, ChatGPT plans) has NO
 * billing API — local logs are the only place that spend is visible. This is
 * also what makes the zero-key first run show REAL numbers.
 *
 * Supported agents:
 *  - Claude Code: ~/.claude/projects/** /*.jsonl — one JSON object per line;
 *    assistant messages carry message.usage token counts.
 *  - Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — event stream;
 *    the LAST event_msg/token_count carries the session's cumulative
 *    total_token_usage (earlier ones are running updates — never summed).
 */

export type LocalAgentCall = {
  agent: LocalAgentFormatId;
  /** Stable source call/message identity when the format safely exposes one. */
  callId?: string;
  model: string;
  /** ISO timestamp of this call, or the latest cumulative usage event. */
  timestamp: string;
  /** ISO session start when the transcript format reports it separately. */
  startedAt?: string;
  /** Project attribution derived from the session's working directory. */
  project?: string;
  /**
   * Internal absolute working directory observed in the local transcript.
   * Renderers must not expose it; adapters use it only to scope local inventory
   * reads to the same repository as the active session.
   */
  workingDirectory?: string;
  /**
   * Stable privacy-safe identity for `workingDirectory`. Warm indexes retain
   * this opaque reference while deliberately omitting the absolute path.
   */
  workingDirectoryRef?: string;
  /**
   * Numeric-only usage for the latest observed model turn. Codex reports this
   * separately from cumulative `total_token_usage`; Claude assistant-message
   * usage is already turn-scoped. Context Health uses this field so a long
   * session lifetime is never compared with a short session's final turn.
   */
  latestTurnUsage?: LocalAgentTurnUsage;
  /** Whether `usage` is one model turn or the session's cumulative financial total. */
  usageScope?: "turn" | "session_cumulative";
  /**
   * Largest single-request prompt (effective input, cache reads included)
   * observed within a `session_cumulative` `usage`. Tiered per-request pricing
   * is selected per request, never from a cumulative sum: a cache-heavy session
   * routinely clears a per-request tier threshold in aggregate while no single
   * request did. This evidence lets pricing keep such a total on the base tier
   * (exact) instead of failing closed to "missing". Absent for turn-scoped
   * calls, which are already a single request.
   */
  maxRequestPromptTokens?: number;
  /**
   * Whether the transcript exposed the input/output components required for
   * pricing. A total-only snapshot is still usage evidence, but pricing it as
   * zero would be false precision.
   */
  usageSupport?: "complete" | "unsupported_token_shape";
  /** Provider-reported total retained when component fields are unavailable. */
  reportedTotalTokens?: number;
  /**
   * Parser evidence for whether each disjoint token component was actually
   * present in the source. Numeric zeroes alone cannot distinguish a reported
   * zero from a field that the parser had to omit/default.
   */
  tokenComponentEvidence?: LocalAgentTokenComponentEvidence;
  /** Optional parser/source version when the evolving session format reports it. */
  sourceVersion?: string;
  /**
   * Explicit host completion evidence for the current session snapshot. This proves only that the
   * latest observed Claude turn or Codex task reached its host completion
   * marker; it does not claim that a resumable transcript is permanently
   * closed.
   */
  completion?: LocalAgentCompletionEvidence;
  /** Raw Gemini token split retained for evidence/debugging, never prompt content. */
  geminiTokenEvidence?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
    cacheAccounting: "included" | "none" | "unknown";
  };
  usage: TokenUsage;
  sessionId?: string;
  /**
   * Distinct subagent-run identity when the host shares one `sessionId`
   * across transcript files. Claude Code stores each subagent transcript
   * under `<sessionId>/subagents/agent-<agentId>.jsonl` with the parent's
   * `sessionId` on every line; without this identity a parent session and
   * all of its subagent runs would collapse into one untruthful session row.
   * Codex subagent rollouts carry their own sessionId and never set this.
   */
  subagentId?: string;
  /**
   * Host-recorded completions of subagent runs owned by this session, taken
   * from the parent transcript's Task tool results (`toolUseResult.agentId`
   * with `status: "completed"`). Subagent transcript files carry no
   * completion marker of their own, so this is the only explicit completion
   * evidence for a subagent run. Attached to one call per session; the
   * session-vitals join reads it across transcript files.
   */
  subagentCompletions?: LocalAgentSubagentCompletion[];
  /** Provider-reported plan windows embedded in the transcript, when present. */
  rateLimits?: LocalAgentRateLimitSnapshot;
  /**
   * Privacy-conscious work summary derived locally from prompt/tool metadata.
   * Raw prompt text never leaves the parser or enters the Glance snapshot.
   */
  activity?: LocalAgentActivity;
};

export type LocalAgentTokenComponentEvidence = {
  inputTokens: "observed";
  outputTokens: "observed";
  cacheReadTokens: "observed" | "not_separately_reported";
  cacheWriteTokens: "observed" | "partial" | "not_separately_reported";
  thoughtTokens: "observed" | "not_separately_reported";
  toolTokens: "observed" | "not_separately_reported";
  /** Complete means the parser can form a disjoint source-faithful total. */
  calculatedTotalTokens: "calculated_complete" | "calculated_partial";
  reportedTotalTokens: "provider_reported" | "not_reported";
};

export type LocalAgentCompletionEvidence = {
  status: "completed";
  evidence: "claude_turn_duration" | "codex_task_complete";
  observedAt: string;
};

/** One host-recorded subagent completion (see LocalAgentCall.subagentCompletions). */
export type LocalAgentSubagentCompletion = {
  subagentId: string;
  observedAt: string;
};

/**
 * Resolve the repository root most recently observed in transcript metadata.
 *
 * CLI, MCP, and Glance use this only to scope read-only project inventory when
 * the caller did not explicitly choose a path. Absolute working directories
 * never enter rendered output.
 */
export function latestObservedWorkingDirectory(
  calls: readonly LocalAgentCall[]
): string | undefined {
  return calls
    .filter((call) => call.workingDirectory)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0]
    ?.workingDirectory;
}

export type LocalAgentTurnUsage = TokenUsage & {
  /** Input-side context observed for this turn, including cached/write tokens. */
  contextTokens: number;
  /** Context plus output tokens for this turn. */
  totalTokens: number;
  source: "assistant_message_usage" | "transcript_last_token_usage" | "call_usage";
};

export type LocalAgentActivity = {
  summary: string;
  kind: "task" | "automation" | "agent" | "file" | "project";
  action:
    | "building"
    | "refining"
    | "fixing"
    | "testing"
    | "auditing"
    | "researching"
    | "configuring"
    | "publishing"
    | "running"
    | "working";
  source: "agent_title" | "user_prompts" | "file_activity" | "project";
  promptCount: number;
  toolCallCount: number;
  /** Basenames only, ordered by observed tool activity. */
  files: string[];
  isSubagent: boolean;
  parentSessionId?: string;
};

export type LocalAgentRateLimitWindow = {
  kind: "five-hour" | "weekly" | "custom";
  name: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type LocalAgentRateLimitSnapshot = {
  observedAt: string;
  limitId?: string;
  planType?: string;
  windows: LocalAgentRateLimitWindow[];
};

export type LocalAgentLogOptions = {
  /** Default: ~/.claude/projects */
  claudeProjectsDir?: string;
  /** Default: ~/.codex/sessions */
  codexSessionsDir?: string;
  /** Default: ~/.gemini/tmp (financial evidence is bounded to chats files). */
  geminiSessionsDir?: string;
  /** Registry-native source-root overrides, keyed by format id. */
  sourceDirectories?: Readonly<Partial<Record<LocalAgentFormatId, string>>>;
  /** Only include calls at/after this ISO timestamp. */
  sinceIso?: string;
  /** Collect privacy-safe Codex invocation summaries during the same JSON pass. */
  collectCodexInvocationEvidence?: boolean;
  /**
   * Optional fail-closed limits for qualitative/action reads. The financial
   * loader has its own proof-based fast path; these limits protect the richer
   * prompt/tool/activity pass from multi-gigabyte transcript histories.
   *
   * Files are considered newest-first within each source. A file is parsed
   * only when it fits both limits in full. Skipped files never contribute
   * calls, findings, invocation evidence, or zero-valued placeholders, and
   * the returned source scan is explicitly marked partial.
   */
  qualitativeScan?: LocalAgentQualitativeScanPolicy;
  /**
   * Optional trusted private index backing warm qualitative scans. The adapter
   * owns storage permissions/validation; keys contain a path hash and file
   * identity, never a raw local path or transcript content.
   */
  qualitativeIndex?: LocalAgentQualitativeIndexAdapter;
  /**
   * Optional per-file cache for financial parse results. Unchanged files skip
   * their full financial re-read; the newest file per source always parses
   * fresh so the active session's evidence (including its raw working
   * directory for context inference) is never served stale from a cache.
   */
  financialIndex?: LocalAgentFinancialIndexAdapter;
  /**
   * Optional ownership section of the private project index. When present,
   * budget-skipped Codex files receive a bounded first-line header probe whose
   * proven/unknown attribution is persisted and feeds the per-project coverage
   * ledger. Claude transcripts get no header shortcut: their cwd is per-entry
   * and can change mid-file.
   */
  ownershipIndex?: LocalAgentOwnershipIndexAdapter;
  /**
   * Optional checkpoint section of the private project index. When present
   * together with `qualitativeIndex`, oversized Codex rollouts are parsed in
   * bounded resumable slices instead of being skipped outright: each run
   * advances at least one slice, and the file joins the index (and the
   * per-project ledger) once its stream completes. Absent, oversized files
   * keep today's skip-plus-header-pass behavior.
   */
  streamCheckpoints?: LocalAgentStreamCheckpointAdapter;
  /**
   * Requested project ref (`avref_…`) for the per-project coverage ledger.
   * Only files proven to belong to a DIFFERENT ref are excluded from the
   * blocking set; a file proven to belong to this exact ref keeps blocking
   * until indexed — it is the oversized relevant transcript. Absent or
   * malformed refs disable proven-foreign exclusion entirely (fail closed).
   */
  coverageProjectRef?: string;
};

export type LocalAgentQualitativeScanPolicy = {
  /** Maximum UTF-8 bytes allowed for one qualitative transcript file. */
  maxFileBytes: number;
  /** Maximum UTF-8 bytes parsed per registered source in one scan. */
  maxSourceBytes: number;
  /**
   * Byte allowance for the checkpointed streaming pass over oversized Codex
   * rollouts in one run (default 512 MiB, roughly 4-5 s at measured
   * throughput). Deliberately byte-metered rather than wall-clock so runs
   * and tests are deterministic; the first scheduled file always advances by
   * at least one complete line even at a smaller remaining allowance, which
   * guarantees convergence.
   */
  maxStreamedBytesPerRun?: number;
};

export type LocalAgentQualitativeIndexKey = {
  schemaVersion: 1;
  parserVersion: typeof localAgentQualitativeParserVersion;
  agent: LocalAgentFormatId;
  /** SHA-256 of the normalized private path; the path itself is never stored. */
  pathHash: string;
  /** Opaque stat identity including ctime so in-place edits invalidate a hit. */
  fileIdentity: string;
  sinceIso: string | null;
  collectInvocationEvidence: boolean;
};

export type LocalAgentQualitativeIndexValue = {
  calls: LocalAgentCall[];
  invocationFile?: ParsedInvocationFile;
  /** Exact narrowing proof for cached aggregated invocation evidence. */
  invocationWindowProof?: ParsedInvocationWindowProof;
  diagnostics: Array<{
    code: "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape";
    count: number;
  }>;
};

export type LocalAgentQualitativeIndexAdapter = {
  read: (
    key: Readonly<LocalAgentQualitativeIndexKey>
  ) => Promise<LocalAgentQualitativeIndexValue | undefined>;
  write: (
    key: Readonly<LocalAgentQualitativeIndexKey>,
    value: Readonly<LocalAgentQualitativeIndexValue>
  ) => Promise<void>;
};

export type LocalAgentFinancialIndexKey = {
  schemaVersion: 2;
  section: "financial";
  agent: LocalAgentFormatId;
  pathHash: string;
  fileIdentity: string;
  financialParserVersion: number;
};

/**
 * Per-file cache for financial parse results. The stored value reuses the
 * privacy-reduced qualitative value contract (calls + parse diagnostics; no
 * invocation evidence). An entry's existence means the file had financial
 * content under this exact identity and parser version.
 */
export type LocalAgentFinancialIndexAdapter = {
  read: (
    key: Readonly<LocalAgentFinancialIndexKey>
  ) => Promise<LocalAgentQualitativeIndexValue | undefined>;
  write: (
    key: Readonly<LocalAgentFinancialIndexKey>,
    value: Readonly<LocalAgentQualitativeIndexValue>
  ) => Promise<void>;
};

/**
 * Ownership evidence for one transcript file in the private project index.
 * "unknown" is a first-class state: ownership is never guessed from hashes,
 * basenames, or absence. Structurally identical to the project-index store's
 * ownership document (the loader cannot import the store without a cycle).
 */
export type LocalAgentOwnershipRecord = {
  /** Body-derived ownership; header-only records stay "unknown". */
  status: "resolved" | "no_calls" | "unknown";
  /** Ownership binds to one exact file identity; rotation supersedes it. */
  fileIdentity: string;
  /** Distinct `avref_…` refs observed in parsed calls (empty until parsed). */
  projectRefs: string[];
  /**
   * Bounded Codex header-pass attribution. "proven" is asserted only when the
   * header cwd would short-circuit `dominantCodexCwd` exactly as a full parse
   * would; every other header stays "unknown" and is never assumed foreign.
   */
  headerAttribution?: {
    status: "proven" | "unknown";
    projectRef?: string;
    /**
     * Subagent marker from the same bounded header read — reused to order
     * the streaming schedule without re-probing. A scheduling hint only,
     * never ownership evidence.
     */
    isSubagent?: boolean;
  };
};

/**
 * Ownership section of the private project index. `createProjectIndexAdapters`
 * satisfies this structurally; the adapter owns storage validation and
 * rotation-superseding semantics.
 */
export type LocalAgentOwnershipIndexAdapter = {
  readOwnership: (
    agent: LocalAgentFormatId,
    pathHash: string
  ) => Promise<LocalAgentOwnershipRecord | undefined>;
  writeOwnership: (
    agent: LocalAgentFormatId,
    pathHash: string,
    ownership: Readonly<LocalAgentOwnershipRecord>
  ) => Promise<void>;
};

/**
 * Resumable stream checkpoint for one oversized transcript (design section
 * e). The identity pin is deliberately append-tolerant (dev/ino/birthtime
 * survive appends); truncation, rotation, edits inside the 64 KiB prefix
 * probe window, and parser contract changes all fail the resume proof and
 * force a restart. Documented residual (QA-confirmed): an in-place edit of
 * bytes BEFORE the probe window on the same inode is indistinguishable from
 * untouched history and resumes — the same local trust extended to the
 * source files themselves (design section e). The reducer/collector payloads
 * are opaque to the store and re-validated by the loader on every resume
 * (fail closed: invalid state is discarded, never partially reused).
 */
export type LocalAgentStreamCheckpointRecord = {
  /** Append-tolerant identity pin for the checkpointed inode. */
  pin: { dev: number; ino: number; birthtimeMs: number };
  parserVersion: number;
  collectInvocationEvidence: boolean;
  /** Window the stream's invocation collector was created with. */
  sinceIso: string | null;
  /** Bytes consumed through the end of the last complete line. */
  offset: number;
  /** Content proof over the up-to-64 KiB immediately before `offset`. */
  prefixProbe: { bytes: number; sha256: string };
  /** Privacy-reduced Codex reducer state; raw paths and prompt text never appear. */
  reducerState: unknown;
  /** Invocation collector snapshot when evidence collection was requested. */
  collectorState?: unknown;
};

/**
 * Checkpoint section of the private project index; structurally satisfied by
 * `createProjectIndexAdapters`.
 */
export type LocalAgentStreamCheckpointAdapter = {
  readStreamCheckpoint: (
    agent: LocalAgentFormatId,
    pathHash: string
  ) => Promise<LocalAgentStreamCheckpointRecord | undefined>;
  writeStreamCheckpoint: (
    agent: LocalAgentFormatId,
    pathHash: string,
    checkpoint: Readonly<LocalAgentStreamCheckpointRecord>
  ) => Promise<void>;
  deleteStreamCheckpoint: (
    agent: LocalAgentFormatId,
    pathHash: string
  ) => Promise<void>;
};

// Bumped to 2 when session-cumulative Codex calls gained `maxRequestPromptTokens`
// (largest single request in the session). Financial caches written by v1 lack
// this per-request tier evidence, so a >272K-cumulative Codex session would
// stay voided to "missing" on reuse; a version mismatch re-parses instead.
// Bumped to 3 when user forks (`forked_from_id`) started resetting their
// inherited baseline: v2 entries priced a fork's replayed parent history as
// the child's own usage, so those cached amounts are overstated and must not
// be reused.
export const localAgentFinancialParserVersion = 3;

/**
 * Qualitative parser contract version. Bumped to 2 with the checkpointed
 * streaming path (A4b): entries and checkpoints written by the pre-streaming
 * parser are never reinterpreted — a version mismatch is a miss (entries) or
 * a discard (checkpoints), and the store schema pins this exact literal so
 * both sides fail closed together. Bumped to 4 when Claude Code subagent
 * transcripts gained their own session identity (`subagentId`) and
 * cross-file completion evidence (`subagentCompletions`, from both Task tool
 * results and background task-notifications): entries persisted by the
 * collapsing parser must re-parse rather than silently keep merging subagent
 * runs into their parent session. Bumped to 5 when Codex reducer checkpoints
 * gained `maxTurnPromptTokens` (largest single request): a checkpoint written
 * by v4 lacks the running per-request maximum, so restoring it could under-read
 * the tier evidence for a cumulative session that crossed the boundary — a
 * version mismatch discards it and re-parses from scratch instead. Bumped to 6
 * with the user-fork inherited-baseline fix: v5 entries and checkpoints treated
 * a fork's replayed parent history as the child's own usage and activity.
 */
export const localAgentQualitativeParserVersion = 6;

/**
 * Conservative launch defaults for action-capable qualitative evidence.
 * Callers must still inspect `qualitativeCoverage` before deriving a finding:
 * the limits protect responsiveness; they do not turn a partial scan into a
 * representative sample.
 */
export const SAFE_QUALITATIVE_SCAN_POLICY: Readonly<LocalAgentQualitativeScanPolicy> =
  Object.freeze({
    maxFileBytes: 64 * 1024 * 1024,
    maxSourceBytes: 256 * 1024 * 1024
  });

/**
 * Options accepted by the financial-only loader. Invocation collection is
 * intentionally unavailable: this path reads only the evidence needed for a
 * financial snapshot and transcript-reported plan limits.
 */
export type LocalAgentFinancialLogOptions = Omit<
  LocalAgentLogOptions,
  | "collectCodexInvocationEvidence"
  | "qualitativeScan"
  | "qualitativeIndex"
  | "ownershipIndex"
  | "coverageProjectRef"
>;

export type LocalAgentLogDiagnosticCode =
  | "directory_missing"
  | "directory_unreadable"
  | "file_unreadable"
  | "malformed_jsonl"
  | "malformed_session_file"
  | "unsupported_token_shape"
  | "qualitative_scan_incomplete"
  | "qualitative_index_error";

export type LocalAgentLogDiagnostic = {
  agent: LocalAgentCall["agent"];
  code: LocalAgentLogDiagnosticCode;
  severity: "info" | "warning" | "error";
  /** Privacy-safe summary; absolute local paths and transcript text are omitted. */
  message: string;
  count: number;
};

export type LocalAgentSourceScan = {
  agent: LocalAgentCall["agent"];
  directoryStatus: "readable" | "missing" | "unreadable";
  filesDiscovered: number;
  filesParsed: number;
  /** Malformed lines observed inside `jsonlValidationCoverage`. */
  malformedLines: number;
  unreadableFiles: number;
  unsupportedUsageSnapshots: number;
  /** Presence-only files such as Gemini CLI logs.json; never financial rows. */
  detectionSignals?: number;
  /** Regular files safely excluded because their metadata predates `sinceIso`. */
  filesSkippedBeforeWindow?: number;
  /** Codex files resolved from bounded head/tail financial evidence. */
  filesReadFinancially?: number;
  /** Bytes not replayed as events after the required Codex financial state was proved. */
  bytesSkippedAsNonFinancialHistory?: number;
  /** JSONL lines classified from their envelope and skipped before JSON decoding. */
  nonFinancialLinesPrefiltered?: number;
  /** Bytes covered by the non-financial event prefilter. */
  nonFinancialBytesPrefiltered?: number;
  /** Whether JSON syntax was checked for every line or financial events only. */
  jsonlValidationCoverage?: "complete" | "financial_events_only";
  /**
   * Coverage for an explicitly bounded qualitative/action scan. Omitted for
   * the legacy unbounded loader and for the financial-only loader.
   */
  qualitativeCoverage?: "complete" | "partial";
  /** Files inside the requested time window considered by the bounded scan. */
  qualitativeFilesEligible?: number;
  /** Eligible files omitted because a configured byte limit would be crossed. */
  qualitativeFilesSkippedForBudget?: number;
  /** Eligible files selected for a complete bounded read. */
  qualitativeFilesSelected?: number;
  /** Selected files that were read and parsed completely. */
  qualitativeFilesReadCompletely?: number;
  /** Eligible files whose evidence is present in the private index (hit or fresh parse). */
  qualitativeFilesIndexed?: number;
  /**
   * Eligible files proven by a bounded header pass to belong to a project
   * other than the requested `coverageProjectRef`. Always zero when no ref
   * was requested: proven ownership never unblocks an unnamed project.
   */
  qualitativeFilesForeignProven?: number;
  /**
   * Eligible files that still block the requested project: not indexed and
   * not proven foreign. A file proven to belong to the requested project
   * itself stays in this count until indexed — it is exactly the oversized
   * relevant transcript that must be parsed, never excluded.
   */
  qualitativeFilesOwnershipUnknown?: number;
  /**
   * Per-project qualitative coverage for the requested project. "indexing"
   * whenever any eligible file's ownership is unknown, any scan-level failure
   * occurred, or a file proven to belong to the requested project is not yet
   * indexed — the honest no-claim state while the index converges.
   */
  qualitativeProjectCoverage?: "complete" | "indexing";
  /** Sum of eligible regular-file sizes observed before reading. */
  qualitativeBytesEligible?: number;
  /** Sum of metadata sizes reserved for selected complete-file reads. */
  qualitativeBytesSelected?: number;
  /** Bytes actually accepted into full-file qualitative parsing. */
  qualitativeBytesRead?: number;
  /** Selected bytes reused from a trusted warm index instead of reread. */
  qualitativeBytesReused?: number;
  /** Bytes consumed by the checkpointed streaming pass this run. */
  qualitativeBytesStreamed?: number;
  /** Oversized files with an in-progress (unconverged) stream this run. */
  qualitativeFilesStreaming?: number;
  qualitativeIndexHits?: number;
  /** Index read/write failures; source parsing falls back to disk. */
  qualitativeIndexErrors?: number;
  /**
   * Emitted calls always come from complete files, even when global source
   * coverage is partial. This lets cohort experiments use exact selected
   * evidence while global/main-driver claims remain gated on coverage.
   */
  qualitativeSelectedEvidence?: "complete_files_only";
};

export type LocalAgentLogResult = {
  records: UsageRecord[];
  /** Per-call entries before aggregation (for drill-down/debugging). */
  calls: LocalAgentCall[];
  filesParsed: number;
  /** Which agents actually had data on this machine. */
  agentsDetected: Array<LocalAgentCall["agent"]>;
  /** Per-source scan outcome, including honest empty and unsupported states. */
  sourceScans: LocalAgentSourceScan[];
  /** Structured, privacy-safe failures/warnings encountered during the scan. */
  diagnostics: LocalAgentLogDiagnostic[];
  /** Present only when requested; contains counts/basenames, never raw text. */
  codexInvocationFiles?: ParsedInvocationFile[];
};

/**
 * True only when every requested source was scanned under an explicit bounded
 * policy without omitting an eligible file. Legacy unbounded results return
 * false so an action caller cannot accidentally treat unknown coverage as a
 * complete launch-safe scan.
 */
export function hasCompleteQualitativeCoverage(
  result: Pick<LocalAgentLogResult, "sourceScans">,
  agents: readonly LocalAgentFormatId[] = ["claude-code", "codex"]
): boolean {
  return agents.every((agent) => (
    result.sourceScans.find((scan) => scan.agent === agent)?.qualitativeCoverage === "complete"
  ));
}

/**
 * Whether a bounded result contains exact calls from at least one completely
 * parsed selected file for every requested source. This is deliberately
 * weaker than global coverage: it can support a clearly scoped experiment,
 * never a claim about the source's overall/main driver.
 */
export function hasExactSelectedQualitativeEvidence(
  result: Pick<LocalAgentLogResult, "calls" | "sourceScans">,
  agents?: readonly LocalAgentFormatId[]
): boolean {
  const requested = agents ?? [...new Set(result.calls
    .filter((call) => localAgentFormatDescriptor(call.agent)?.capabilities.actionPlanning)
    .map((call) => call.agent))];
  return requested.length > 0 && requested.every((agent) => {
    const scan = result.sourceScans.find((entry) => entry.agent === agent);
    return scan?.qualitativeSelectedEvidence === "complete_files_only" &&
      (scan.qualitativeFilesReadCompletely ?? 0) > 0 &&
      result.calls.some((call) => call.agent === agent);
  });
}

type TranscriptParseDiagnostic = {
  code: "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape";
  count: number;
};

type TranscriptParseDiagnosticHandler = (diagnostic: TranscriptParseDiagnostic) => void;

/**
 * Codex rollout/compaction files can repeat the same session's cumulative
 * token counter. Keep only the latest snapshot per session so financial value,
 * Glance, and project totals never add cumulative checkpoints together.
 * Turn-scoped calls with a stable session+call identity are also deduplicated
 * across copied/checkpointed files. Calls without that proof are retained.
 */
export function dedupeCumulativeSessionCalls(
  calls: LocalAgentCall[],
  onStableTurnConflict?: (agent: LocalAgentFormatId) => void
): LocalAgentCall[] {
  const retained: LocalAgentCall[] = [];
  const cumulative = new Map<string, LocalAgentCall>();
  const stableTurns = new Map<string, LocalAgentCall>();
  for (const call of calls) {
    if (call.usageScope === "turn" && call.sessionId && call.callId) {
      const key = `${call.agent}:${call.sessionId}:${call.callId}`;
      const prior = stableTurns.get(key);
      if (!prior) {
        stableTurns.set(key, call);
      } else if (isStableTurnConflict(prior)) {
        continue;
      } else if (isCompleteStableTurn(prior) && isCompleteStableTurn(call) &&
          stableTurnEvidenceFingerprint(call) !== stableTurnEvidenceFingerprint(prior)) {
        stableTurns.set(key, conflictingStableTurn(prior, call));
        onStableTurnConflict?.(call.agent);
      } else if (!isCompleteStableTurn(prior) && isCompleteStableTurn(call)) {
        // JSONL/checkpoint copies can preserve an early tokenless snapshot
        // beside its later complete update. Complete evidence supersedes only
        // unsupported evidence for the same stable identity.
        stableTurns.set(key, call);
      } else if (!isCompleteStableTurn(call) && isCompleteStableTurn(prior)) {
        continue;
      } else if (isLaterCumulativeSnapshot(call, prior)) {
        stableTurns.set(key, call);
      }
      continue;
    }
    if (call.usageScope !== "session_cumulative" || !call.sessionId) {
      retained.push(call);
      continue;
    }
    const key = `${call.agent}:${call.sessionId}`;
    const prior = cumulative.get(key);
    if (!prior || isLaterCumulativeSnapshot(call, prior)) {
      cumulative.set(key, call);
    }
  }
  return [...retained, ...stableTurns.values(), ...cumulative.values()];
}

function isCompleteStableTurn(call: LocalAgentCall): boolean {
  return call.usageSupport !== "unsupported_token_shape";
}

function stableTurnEvidenceFingerprint(call: LocalAgentCall): string {
  return JSON.stringify({
    timestamp: call.timestamp,
    model: call.model,
    project: call.project ?? null,
    workingDirectoryRef: stableWorkingDirectoryRef(call),
    usageSupport: call.usageSupport ?? null,
    reportedTotalTokens: call.reportedTotalTokens ?? null,
    usage: {
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens ?? null,
      cacheWrite5mTokens: call.usage.cacheWrite5mTokens ?? null,
      cacheWrite1hTokens: call.usage.cacheWrite1hTokens ?? null,
      thoughtTokens: call.usage.thoughtTokens ?? null,
      toolTokens: call.usage.toolTokens ?? null
    },
    geminiTokenEvidence: call.geminiTokenEvidence ?? null
  });
}

function stableWorkingDirectoryRef(call: LocalAgentCall): string | null {
  const supplied = call.workingDirectoryRef;
  const derived = call.workingDirectory
    ? derivedWorkingDirectoryRef(call.workingDirectory)
    : undefined;
  if (supplied && derived && supplied !== derived) return "conflicting-working-directory";
  return supplied ?? derived ?? null;
}

/**
 * The one NUL-separated avref derivation for working directories. Every
 * consumer — stable call refs, the financial probe re-attach, and header-pass
 * attribution — must produce byte-identical refs for the same directory.
 */
function derivedWorkingDirectoryRef(workingDirectory: string): string {
  return `avref_${createHash("sha256")
    .update("project-working-directory")
    .update("\u0000")
    .update(workingDirectory)
    .digest("hex")}`;
}

function isStableTurnConflict(call: LocalAgentCall): boolean {
  return call.model === "conflicting-local-evidence" &&
    call.usageSupport === "unsupported_token_shape";
}

function conflictingStableTurn(
  left: LocalAgentCall,
  right: LocalAgentCall
): LocalAgentCall {
  const call = left.timestamp.localeCompare(right.timestamp) <= 0 ? left : right;
  return {
    agent: call.agent,
    ...(call.callId ? { callId: call.callId } : {}),
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    model: "conflicting-local-evidence",
    timestamp: call.timestamp,
    usageScope: "turn",
    usageSupport: "unsupported_token_shape",
    usage: { inputTokens: 0, outputTokens: 0 }
  };
}

function isLaterCumulativeSnapshot(candidate: LocalAgentCall, prior: LocalAgentCall): boolean {
  const timestampOrder = candidate.timestamp.localeCompare(prior.timestamp);
  if (timestampOrder !== 0) return timestampOrder > 0;
  return totalUsageTokens(candidate.usage) > totalUsageTokens(prior.usage);
}

function totalUsageTokens(usage: TokenUsage): number {
  return usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0) +
    (usage.thoughtTokens ?? 0) +
    (usage.toolTokens ?? 0);
}

type ParsedClaudeFinancialUsage = {
  usage: TokenUsage;
  latestTurnUsage?: LocalAgentTurnUsage;
  usageSupport?: "unsupported_token_shape";
  reportedTotalTokens?: number;
  tokenComponentEvidence?: LocalAgentTokenComponentEvidence;
};

function parseClaudeFinancialUsage(
  value: Record<string, unknown>,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): ParsedClaudeFinancialUsage {
  const inputTokens = tokenComponentOf(value.input_tokens);
  const outputTokens = tokenComponentOf(value.output_tokens);
  const cacheReadField = optionalTokenComponent(value, "cache_read_input_tokens");
  const writeTotalField = optionalTokenComponent(value, "cache_creation_input_tokens");
  const reportedTotalField = optionalTokenComponent(value, "total_tokens");
  const cacheCreationPresent = Object.prototype.hasOwnProperty.call(value, "cache_creation");
  const cacheCreation = isRecord(value.cache_creation) ? value.cache_creation : undefined;
  const write5mField = cacheCreation
    ? optionalTokenComponent(cacheCreation, "ephemeral_5m_input_tokens")
    : { present: false };
  const write1hField = cacheCreation
    ? optionalTokenComponent(cacheCreation, "ephemeral_1h_input_tokens")
    : { present: false };
  const componentsSupported = inputTokens !== undefined &&
    outputTokens !== undefined &&
    (!cacheReadField.present || cacheReadField.value !== undefined) &&
    (!writeTotalField.present || writeTotalField.value !== undefined) &&
    (!reportedTotalField.present || reportedTotalField.value !== undefined) &&
    (!cacheCreationPresent || Boolean(cacheCreation)) &&
    (!write5mField.present || write5mField.value !== undefined) &&
    (!write1hField.present || write1hField.value !== undefined);
  const usage: TokenUsage = {
    // Retain every valid component for partial evidence, but never let a
    // missing/invalid required field become a priceable zero-dollar call.
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadField.value ?? 0,
    // Prefer the 5m/1h breakdown; fall back to the total as 5m (cheaper bound).
    cacheWrite5mTokens: write5mField.value ?? writeTotalField.value ?? 0,
    cacheWrite1hTokens: write1hField.value ?? 0
  };
  if (componentsSupported) {
    const cacheWriteEvidence = writeTotalField.value !== undefined ||
        (write5mField.value !== undefined && write1hField.value !== undefined)
      ? "observed" as const
      : write5mField.value !== undefined || write1hField.value !== undefined
        ? "partial" as const
        : "not_separately_reported" as const;
    const cacheReadEvidence = cacheReadField.value === undefined
      ? "not_separately_reported" as const
      : "observed" as const;
    const componentTotalComplete = cacheReadEvidence === "observed" &&
      cacheWriteEvidence === "observed";
    return {
      usage,
      latestTurnUsage: toTurnUsage(usage, "assistant_message_usage"),
      ...(reportedTotalField.value !== undefined
        ? { reportedTotalTokens: reportedTotalField.value }
        : {}),
      tokenComponentEvidence: {
        inputTokens: "observed",
        outputTokens: "observed",
        cacheReadTokens: cacheReadEvidence,
        cacheWriteTokens: cacheWriteEvidence,
        thoughtTokens: "not_separately_reported",
        toolTokens: "not_separately_reported",
        calculatedTotalTokens: componentTotalComplete
          ? "calculated_complete"
          : "calculated_partial",
        reportedTotalTokens: reportedTotalField.value === undefined
          ? "not_reported"
          : "provider_reported"
      }
    };
  }
  onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  const reportedTotalTokens = reportedTotalField.value;
  return {
    usage,
    usageSupport: "unsupported_token_shape",
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {})
  };
}

type OptionalTokenComponent = {
  present: boolean;
  value?: number;
};

function optionalTokenComponent(
  record: Record<string, unknown>,
  key: string
): OptionalTokenComponent {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false };
  const value = tokenComponentOf(record[key]);
  return value === undefined ? { present: true } : { present: true, value };
}

type ParsedCodexCumulativeUsage = {
  usage: TokenUsage;
  supported: boolean;
  reportedTotalTokens?: number;
  tokenComponentEvidence?: LocalAgentTokenComponentEvidence;
};

function parseCodexCumulativeUsage(
  current: Record<string, unknown>,
  baseline?: Record<string, unknown>
): ParsedCodexCumulativeUsage {
  const rawInput = tokenComponentOf(current.input_tokens);
  const rawOutput = tokenComponentOf(current.output_tokens);
  const currentCachedField = optionalTokenComponent(current, "cached_input_tokens");
  const currentTotalField = optionalTokenComponent(current, "total_tokens");
  const rawCached = currentCachedField.value ?? 0;
  const rawReportedTotal = currentTotalField.value;

  const baselineInput = baseline ? tokenComponentOf(baseline.input_tokens) : undefined;
  const baselineOutput = baseline ? tokenComponentOf(baseline.output_tokens) : undefined;
  const baselineCachedField = baseline
    ? optionalTokenComponent(baseline, "cached_input_tokens")
    : { present: false };
  const baselineTotalField = baseline
    ? optionalTokenComponent(baseline, "total_tokens")
    : { present: false };
  const baselineCached = baselineCachedField.value ?? 0;
  const baselineReportedTotal = baselineTotalField.value;

  const currentSupported = rawInput !== undefined &&
    rawOutput !== undefined &&
    (!currentCachedField.present || currentCachedField.value !== undefined) &&
    (!currentTotalField.present || currentTotalField.value !== undefined) &&
    rawCached <= rawInput &&
    (rawReportedTotal === undefined || rawReportedTotal >= rawInput + rawOutput) &&
    !((rawReportedTotal ?? 0) > 0 && rawInput === 0 && rawOutput === 0);
  const baselineSupported = !baseline || (
    baselineInput !== undefined &&
    baselineOutput !== undefined &&
    (!baselineCachedField.present || baselineCachedField.value !== undefined) &&
    (!baselineTotalField.present || baselineTotalField.value !== undefined) &&
    baselineCached <= baselineInput &&
    (baselineReportedTotal === undefined ||
      baselineReportedTotal >= baselineInput + baselineOutput) &&
    !((baselineReportedTotal ?? 0) > 0 && baselineInput === 0 && baselineOutput === 0)
  );
  const monotonic = !baseline || (
    rawInput !== undefined && baselineInput !== undefined && rawInput >= baselineInput &&
    rawOutput !== undefined && baselineOutput !== undefined && rawOutput >= baselineOutput &&
    rawCached >= baselineCached &&
    rawInput - rawCached >= baselineInput - baselineCached &&
    (rawReportedTotal === undefined ||
      baselineReportedTotal === undefined ||
      rawReportedTotal >= baselineReportedTotal)
  );

  const input = Math.max(0, (rawInput ?? 0) - (baselineInput ?? 0));
  const cached = Math.max(0, rawCached - baselineCached);
  const output = Math.max(0, (rawOutput ?? 0) - (baselineOutput ?? 0));
  const reportedTotalTokens = rawReportedTotal === undefined
    ? undefined
    : Math.max(0, rawReportedTotal - (baselineReportedTotal ?? 0));
  return {
    usage: {
      // Codex input_tokens includes cached input; expose the non-cached split.
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      cacheReadTokens: cached
    },
    supported: currentSupported && baselineSupported && monotonic,
    ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {}),
    ...(currentSupported && baselineSupported && monotonic
      ? {
          tokenComponentEvidence: {
            inputTokens: "observed" as const,
            outputTokens: "observed" as const,
            cacheReadTokens: currentCachedField.value === undefined
              ? "not_separately_reported" as const
              : "observed" as const,
            cacheWriteTokens: "not_separately_reported" as const,
            thoughtTokens: "not_separately_reported" as const,
            toolTokens: "not_separately_reported" as const,
            // Codex input_tokens already contains cached input; subtracting
            // the optional cache split and adding it back preserves the full
            // observed input+output total even when the split is unavailable.
            calculatedTotalTokens: "calculated_complete" as const,
            reportedTotalTokens: reportedTotalTokens === undefined
              ? "not_reported" as const
              : "provider_reported" as const
          }
        }
      : {})
  };
}

function parseCodexTurnUsage(value: Record<string, unknown>): {
  supported: boolean;
  usage?: LocalAgentTurnUsage;
} {
  const rawInput = tokenComponentOf(value.input_tokens);
  const rawOutput = tokenComponentOf(value.output_tokens);
  const cachedField = optionalTokenComponent(value, "cached_input_tokens");
  const totalField = optionalTokenComponent(value, "total_tokens");
  const cached = cachedField.value ?? 0;
  const total = totalField.value;
  const supported = rawInput !== undefined &&
    rawOutput !== undefined &&
    (!cachedField.present || cachedField.value !== undefined) &&
    (!totalField.present || totalField.value !== undefined) &&
    cached <= rawInput &&
    (total === undefined || total >= rawInput + rawOutput);
  if (!supported) return { supported: false };
  return {
    supported: true,
    usage: {
      inputTokens: rawInput - cached,
      outputTokens: rawOutput,
      cacheReadTokens: cached,
      contextTokens: rawInput,
      totalTokens: total ?? rawInput + rawOutput,
      source: "transcript_last_token_usage"
    }
  };
}

/**
 * The tier-relevant prompt size of one Codex `last_token_usage` turn: its full
 * request input (Codex `input_tokens` already includes cached input), which is
 * exactly `effectivePromptTokens` of the parsed turn usage. Returned only when
 * the field parses to a non-negative number, so an unreadable turn never lowers
 * a running maximum. Used to prove whether any single request in a cumulative
 * session crossed a per-request tier threshold.
 */
function codexTurnPromptTokens(turn: Record<string, unknown>): number | undefined {
  const input = tokenComponentOf(turn.input_tokens);
  return input === undefined ? undefined : input;
}

/**
 * Whether a Codex rollout replays another session's history before its own
 * work, so the cumulative counter at its first real task is an inherited
 * baseline rather than this session's usage.
 *
 * TWO kinds of rollout do this, and only the first was recognized before:
 *  - subagent rollouts (`thread_source: "subagent"`, or a `source.subagent`);
 *  - USER FORKS (`forked_from_id`), which carry `thread_source: "user"` and
 *    replay the parent transcript verbatim. Observed: a forked rollout whose
 *    first 9,051 of 9,442 token_count events are byte-identical copies of the
 *    parent's, all with earlier parent timestamps, carrying 1,204,265,192 of
 *    its 1,256,637,395 final cumulative input tokens (95.9%) — parent usage
 *    that was being billed again under the child, and again down each fork
 *    chain.
 *
 * This is deliberately NOT folded into `isSubagent`: that flag also drives
 * activity attribution and checkpoint identity, where a user fork is a normal
 * user session and must not be relabelled a subagent.
 */
function codexHasInheritedHistory(payload: Record<string, unknown>): boolean {
  return stringOf(payload.thread_source) === "subagent" ||
    isRecord(payload.source) && "subagent" in payload.source ||
    stringOf(payload.forked_from_id) !== undefined;
}

/** Parse one Claude Code transcript (JSONL). Exported for tests. */
export function parseClaudeCodeTranscript(
  content: string,
  filePath = "",
  sinceMs?: number,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall[] {
  const calls: LocalAgentCall[] = [];
  const seen = new Set<string>();
  const pendingPrompts: string[] = [];
  const activityEvidence = new Map<string, {
    prompts: string[];
    files: Map<string, number>;
    toolCallCount: number;
  }>();
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let latestActivityKey: string | undefined;
  let isSubagent = filePath.split(sep).includes("subagents");
  // Claude Code writes the parent's sessionId on every subagent line, so the
  // line-level `agentId` (mirrored in the `subagents/agent-<id>.jsonl` file
  // name) is the only truthful per-run identity for a subagent transcript.
  const fileSubagentId = subagentTranscriptFileId(filePath);
  const observedEntryAgentIds = new Set<string>();
  const subagentCompletionsBySession = new Map<string, Map<string, string>>();
  let parentSessionId: string | undefined;
  let malformedLines = 0;
  let entryOrdinal = 0;
  let latestUnscopedWorkOrdinal = -1;
  const latestWorkOrdinalBySession = new Map<string, number>();
  const completionBySession = new Map<string, LocalAgentCompletionEvidence & {
    ordinal: number;
  }>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!isRecord(entry)) continue;
    entryOrdinal += 1;
    const entrySessionId = stringOf(entry.sessionId);
    if (entry.type === "user" || entry.type === "assistant") {
      if (entrySessionId) latestWorkOrdinalBySession.set(entrySessionId, entryOrdinal);
      else latestUnscopedWorkOrdinal = entryOrdinal;
    }
    const durationMs = numberOf(entry.durationMs);
    if (entry.type === "system" && entry.subtype === "turn_duration" &&
        entrySessionId && Number.isSafeInteger(durationMs) && durationMs! >= 0) {
      const observedAt = toIso(stringOf(entry.timestamp));
      if (observedAt) {
        completionBySession.set(entrySessionId, {
          status: "completed",
          evidence: "claude_turn_duration",
          observedAt,
          ordinal: entryOrdinal
        });
      }
    }
    if (entry.type === "ai-title") {
      title = stringOf(entry.aiTitle) ?? title;
    }
    if (entry.type === "last-prompt") {
      lastPrompt = stringOf(entry.lastPrompt) ?? lastPrompt;
    }
    if (entry.isSidechain === true) isSubagent = true;
    const entryAgentId = stringOf(entry.agentId);
    if (entryAgentId) {
      // Line-level agentId only appears on sidechain lines; it is subagent
      // evidence even when the sidechain flag or path marker is missing.
      isSubagent = true;
      observedEntryAgentIds.add(entryAgentId);
    }
    parentSessionId = stringOf(entry.parentSessionId) ?? parentSessionId;
    // The host records each finished subagent run in the owning transcript:
    // synchronous runs as a Task tool result, background runs as a
    // task-notification queue operation. Subagent files carry no completion
    // marker of their own, so these are the explicit completion evidence for
    // those runs. Only an explicit "completed" status counts; failed, killed,
    // or merely launched runs never read as comparable completed tasks.
    if (entrySessionId) {
      const toolUseResult = isRecord(entry.toolUseResult) ? entry.toolUseResult : undefined;
      let completedSubagentId = toolUseResult && toolUseResult.status === "completed"
        ? stringOf(toolUseResult.agentId)
        : undefined;
      if (!completedSubagentId && entry.type === "queue-operation") {
        const notification = parseTaskNotification(stringOf(entry.content));
        if (notification?.status === "completed") completedSubagentId = notification.taskId;
      }
      const completionObservedAt = completedSubagentId
        ? toIso(stringOf(entry.timestamp))
        : undefined;
      if (completedSubagentId && completionObservedAt) {
        const bySubagent = subagentCompletionsBySession.get(entrySessionId) ??
          new Map<string, string>();
        const prior = bySubagent.get(completedSubagentId);
        if (!prior || Date.parse(completionObservedAt) > Date.parse(prior)) {
          bySubagent.set(completedSubagentId, completionObservedAt);
        }
        subagentCompletionsBySession.set(entrySessionId, bySubagent);
      }
    }

    const message = isRecord(entry.message) ? entry.message : undefined;
    if (entry.type === "user" && message) {
      for (const prompt of textValues(message.content)) {
        if (isHumanPrompt(prompt)) pendingPrompts.push(prompt);
      }
    }
    if (entry.type !== "assistant") continue;
    const usage = message && isRecord(message.usage) ? message.usage : undefined;
    if (!message || !usage) continue;
    // "<synthetic>" marks Claude Code internal placeholder messages, not API calls.
    if (stringOf(message.model) === "<synthetic>") continue;
    // Streaming/retries can write the same API response on multiple lines.
    const nativeResponse = claudeNativeResponseIdentity(message, entry);
    if (nativeResponse && seen.has(nativeResponse.localDedupeKey)) continue;
    if (nativeResponse) seen.add(nativeResponse.localDedupeKey);
    const timestamp = toIso(stringOf(entry.timestamp)) ?? new Date(0).toISOString();
    if (typeof sinceMs === "number" && Date.parse(timestamp) < sinceMs) {
      // These prompts led to a call outside the selected evidence window. Do
      // not let them become the focus of a later in-window project/call.
      pendingPrompts.length = 0;
      continue;
    }
    const parsedUsage = parseClaudeFinancialUsage(usage, onDiagnostic);
    const workingDirectory = absoluteWorkingDirectory(stringOf(entry.cwd));
    const project = projectFromCwd(workingDirectory) ?? projectFromTranscriptPath(filePath);
    const sessionId = stringOf(entry.sessionId);
    const call: LocalAgentCall = {
      agent: "claude-code",
      ...(nativeResponse ? { callId: nativeResponse.callId } : {}),
      model: stringOf(message.model) ?? "claude-code",
      timestamp,
      project,
      workingDirectory,
      sessionId,
      ...(entryAgentId ? { subagentId: entryAgentId } : {}),
      ...(stringOf(entry.version) ? { sourceVersion: stringOf(entry.version) } : {}),
      ...(parsedUsage.latestTurnUsage
        ? { latestTurnUsage: parsedUsage.latestTurnUsage }
        : {}),
      usageScope: "turn",
      ...(parsedUsage.usageSupport ? { usageSupport: parsedUsage.usageSupport } : {}),
      ...(parsedUsage.reportedTotalTokens !== undefined
        ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
        : {}),
      ...(parsedUsage.tokenComponentEvidence
        ? { tokenComponentEvidence: parsedUsage.tokenComponentEvidence }
        : {}),
      usage: parsedUsage.usage
    };
    calls.push(call);

    const activityKey = localActivityScopeKey(sessionId, workingDirectory, project);
    const evidence = activityEvidence.get(activityKey) ?? {
      prompts: [],
      files: new Map<string, number>(),
      toolCallCount: 0
    };
    evidence.prompts.push(...pendingPrompts);
    pendingPrompts.length = 0;
    for (const item of recordValues(message.content)) {
      if (item.type !== "tool_use") continue;
      evidence.toolCallCount += 1;
      collectToolFiles(item.input, evidence.files);
    }
    activityEvidence.set(activityKey, evidence);
    latestActivityKey = activityKey;
  }
  // One subagent transcript is one run: calls whose lines omitted agentId
  // still belong to the file's single run identity (content agentId when one
  // was observed, else the `subagents/` file name). Never invented for
  // parent transcripts.
  const defaultSubagentId = observedEntryAgentIds.size === 1
    ? [...observedEntryAgentIds][0]
    : fileSubagentId;
  if (isSubagent && defaultSubagentId) {
    for (const call of calls) call.subagentId ??= defaultSubagentId;
  }
  for (const [completionSessionId, bySubagent] of subagentCompletionsBySession) {
    let target: LocalAgentCall | undefined;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (calls[index]!.sessionId === completionSessionId) {
        target = calls[index];
        break;
      }
    }
    if (!target) continue;
    target.subagentCompletions = [...bySubagent.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([subagentId, observedAt]) => ({ subagentId, observedAt }));
  }
  const fallbackPrompt = lastPrompt && isHumanPrompt(lastPrompt) ? lastPrompt : undefined;
  const activities = new Map<string, LocalAgentActivity>();
  for (const [activityKey, evidence] of activityEvidence) {
    const matchingCall = calls.find((call) => (
      localActivityScopeKey(call.sessionId, call.workingDirectory, call.project) === activityKey
    ));
    const isLatest = activityKey === latestActivityKey;
    const activity = buildLocalAgentActivity({
      title: isLatest ? title : undefined,
      prompts: evidence.prompts.length > 0
        ? evidence.prompts
        : isLatest && fallbackPrompt
          ? [fallbackPrompt]
          : [],
      files: evidence.files,
      toolCallCount: evidence.toolCallCount,
      project: matchingCall?.project ?? projectFromTranscriptPath(filePath),
      isSubagent,
      parentSessionId
    });
    if (activity) activities.set(activityKey, activity);
  }
  for (const call of calls) {
    call.activity = activities.get(
      localActivityScopeKey(call.sessionId, call.workingDirectory, call.project)
    );
    const completion = call.sessionId
      ? completionBySession.get(call.sessionId)
      : undefined;
    const latestWorkOrdinal = call.sessionId
      ? latestWorkOrdinalBySession.get(call.sessionId) ?? -1
      : -1;
    if (completion && completion.ordinal >= latestWorkOrdinal &&
        completion.ordinal >= latestUnscopedWorkOrdinal &&
        Date.parse(completion.observedAt) >= Date.parse(call.timestamp)) {
      const { ordinal: _ordinal, ...evidence } = completion;
      call.completion = evidence;
    }
  }
  if (malformedLines > 0) {
    onDiagnostic?.({ code: "malformed_jsonl", count: malformedLines });
  }
  return calls;
}

/**
 * Explicit per-line reducer state for one Codex rollout (design section e).
 * The whole-file parser and the checkpointed streaming path share this exact
 * reducer, so their outputs are identical by construction. The `restored*`
 * fields exist only for streams resumed from a privacy-reduced checkpoint;
 * they are never populated on the whole-file path.
 */
type CodexRolloutParserState = {
  model?: string;
  rootCwd?: string;
  /** Privacy-reduced root-cwd decision restored from a stream checkpoint. */
  restoredRootCwd?: RestoredCodexRootCwd;
  toolWorkdirs: Map<string, number>;
  /** Hashed cross-run workdir tally restored from a stream checkpoint. */
  restoredWorkdirs?: RestoredCodexWorkdirTally[];
  sessionId?: string;
  sourceVersion?: string;
  rootSessionMetaSeen: boolean;
  startedAt?: string;
  rootStartedAtMs?: number;
  rootTaskStarted: boolean;
  /**
   * Whether this rollout replays another session's history (subagent OR user
   * fork), so its pre-boundary cumulative is an inherited baseline. Tracked
   * separately from `isSubagent`, which also drives attribution.
   */
  hasInheritedHistory: boolean;
  inheritedUsageBaseline?: Record<string, unknown>;
  lastActivityAt?: string;
  lastTotal?: Record<string, unknown>;
  lastTurn?: Record<string, unknown>;
  /** Largest single-request prompt seen since the (post-fork) session root. */
  maxTurnPromptTokens?: number;
  lastRateLimits?: LocalAgentRateLimitSnapshot;
  prompts: string[];
  /** Sanitized prompt survivors dropped from a checkpoint beyond the last 12. */
  restoredPromptOverflow: number;
  fileCounts: Map<string, number>;
  toolCallCount: number;
  isSubagent: boolean;
  parentSessionId?: string;
  pendingTaskTurnId?: string;
  completedTask?: LocalAgentCompletionEvidence;
  malformedLines: number;
};

/**
 * Root session cwd carried across runs without its raw path. `shortCircuits`
 * records the exact `dominantCodexCwd` short-circuit outcome computed on the
 * raw cwd before it was dropped; the resolved ref/project reproduce the
 * emitted call fields byte-for-byte when the session cwd wins.
 */
type RestoredCodexRootCwd = {
  /** Whether any session cwd was observed before the checkpoint. */
  present: boolean;
  shortCircuits: boolean;
  resolvedRef?: string;
  resolvedProject?: string;
};

/**
 * One observed tool workdir carried across runs as hashes plus the metadata
 * `dominantCodexCwd` needs: subtree rollup via ancestor refs, depth, basename
 * and home-exclusion. The raw path never touches disk (req 1); the final
 * full-path localeCompare tie-break is therefore unreachable for restored
 * entries — divergence is possible only on exact score+depth ties that span
 * a checkpoint boundary, and is pinned by fixtures (QA cases 27/28).
 */
type RestoredCodexWorkdirTally = {
  ref: string;
  ancestorRefs: string[];
  depth: number;
  base: string;
  isHome: boolean;
  count: number;
};

function createCodexRolloutParserState(): CodexRolloutParserState {
  return {
    toolWorkdirs: new Map<string, number>(),
    rootSessionMetaSeen: false,
    rootTaskStarted: false,
    prompts: [],
    restoredPromptOverflow: 0,
    fileCounts: new Map<string, number>(),
    toolCallCount: 0,
    isSubagent: false,
    hasInheritedHistory: false,
    malformedLines: 0
  };
}

/** One line of the shared Codex rollout reducer (blank/malformed included). */
function consumeCodexRolloutLine(
  state: CodexRolloutParserState,
  line: string,
  onEntry?: (entry: Record<string, unknown>) => void
): void {
  if (!line.trim()) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    state.malformedLines += 1;
    return;
  }
  if (!isRecord(entry)) return;
  onEntry?.(entry);
  const payload = isRecord(entry.payload) ? entry.payload : undefined;
  if (entry.type === "session_meta" && payload && !state.rootSessionMetaSeen) {
    // A forked/subagent rollout can embed the parent transcript, including
    // many later session_meta records. The first metadata record belongs to
    // this rollout file; later records are nested/history evidence and must
    // never replace the financial session identity or root cwd.
    state.rootSessionMetaSeen = true;
    state.sessionId = stringOf(payload.id);
    state.sourceVersion = stringOf(payload.cli_version);
    state.rootCwd = stringOf(payload.cwd);
    state.startedAt = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp));
    state.rootStartedAtMs = timestampMilliseconds(payload.timestamp ?? entry.timestamp);
    state.isSubagent = stringOf(payload.thread_source) === "subagent" ||
      isRecord(payload.source) && "subagent" in payload.source;
    state.hasInheritedHistory = codexHasInheritedHistory(payload);
    state.parentSessionId = stringOf(payload.parent_thread_id);
  }
  if (entry.type === "turn_context" && payload) {
    state.model = stringOf(payload.model) ?? state.model;
    // The restored checkpoint already carries the session cwd decision when
    // one was observed; the turn_context fallback applies only when neither
    // a raw nor a restored session cwd exists (same ??= semantics).
    if (state.rootCwd === undefined && !state.restoredRootCwd?.present) {
      state.rootCwd = stringOf(payload.cwd);
    }
  }
  if (
    state.hasInheritedHistory &&
    !state.rootTaskStarted &&
    payload?.type === "task_started" &&
    isRootSpecificTaskStart(payload.started_at, state.rootStartedAtMs)
  ) {
    // Forked Codex rollouts copy the parent's complete event history after
    // the child's root session_meta. The cumulative counter immediately
    // before the child's first task is the inherited baseline, not child
    // usage. Reset qualitative evidence at the same boundary so parent
    // prompts/files cannot become the child's focus. Restored checkpoint
    // evidence predating the boundary is parent history too and resets with
    // it (the raw session cwd deliberately survives, exactly as rootCwd).
    //
    // Replayed task_started events keep the PARENT's original started_at, so
    // `isRootSpecificTaskStart` rejects them and the first accepted task is
    // this session's own — which is why the boundary lands exactly at the end
    // of the replay.
    state.inheritedUsageBaseline = state.lastTotal;
    state.lastTotal = undefined;
    state.rootTaskStarted = true;
    state.prompts.length = 0;
    state.restoredPromptOverflow = 0;
    state.fileCounts.clear();
    state.toolWorkdirs.clear();
    state.restoredWorkdirs = undefined;
    state.toolCallCount = 0;
    state.model = undefined;
    state.lastTurn = undefined;
    state.maxTurnPromptTokens = undefined;
    state.lastRateLimits = undefined;
    state.lastActivityAt = toIso(stringOf(entry.timestamp)) ?? state.startedAt;
  }
  if (payload?.type === "task_started" && (!state.hasInheritedHistory || state.rootTaskStarted)) {
    state.pendingTaskTurnId = stringOf(payload.turn_id);
    state.completedTask = undefined;
  }
  if (entry.type === "event_msg" && payload?.type === "task_complete") {
    const completedTurnId = stringOf(payload.turn_id);
    const observedAt = toIso(stringOf(entry.timestamp));
    if (state.pendingTaskTurnId && completedTurnId === state.pendingTaskTurnId && observedAt) {
      state.completedTask = {
        status: "completed",
        evidence: "codex_task_complete",
        observedAt
      };
      state.pendingTaskTurnId = undefined;
    } else {
      state.completedTask = undefined;
      state.pendingTaskTurnId = undefined;
    }
  }
  if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
    state.toolCallCount += 1;
    const args = jsonRecord(stringOf(payload.arguments));
    const workdir = stringOf(args?.workdir) ?? stringOf(args?.cwd);
    if (workdir && isAbsolute(workdir)) {
      const normalized = resolve(workdir);
      state.toolWorkdirs.set(normalized, (state.toolWorkdirs.get(normalized) ?? 0) + 1);
    }
    // Current Codex Desktop records the orchestration wrapper as a custom
    // `exec` call whose input is JavaScript containing nested tool calls.
    // Extract only quoted absolute workdir/cwd values; never evaluate it.
    if (payload.type === "custom_tool_call" && stringOf(payload.name) === "exec") {
      collectEmbeddedToolWorkdirs(stringOf(payload.input), state.toolWorkdirs);
    }
    collectToolFiles(args, state.fileCounts);
    collectPatchFiles(
      stringOf(args?.patch) ?? stringOf(args?.input) ?? stringOf(payload.input),
      state.fileCounts
    );
  }
  if (payload?.type === "message" && payload.role === "user") {
    for (const prompt of textValues(payload.content)) {
      if (isHumanPrompt(prompt)) state.prompts.push(prompt);
    }
  }
  if (entry.type === "event_msg" && payload?.type === "token_count") {
    const eventTimestamp = toIso(stringOf(entry.timestamp)) ?? state.lastActivityAt ?? state.startedAt;
    const info = isRecord(payload.info) ? payload.info : undefined;
    const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
    const turn = info && isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
    if (total) {
      state.lastTotal = total;
      state.lastActivityAt = eventTimestamp;
    }
    if (turn) {
      state.lastTurn = turn;
      state.lastActivityAt = eventTimestamp;
      const turnPrompt = codexTurnPromptTokens(turn);
      if (turnPrompt !== undefined) {
        state.maxTurnPromptTokens = Math.max(state.maxTurnPromptTokens ?? 0, turnPrompt);
      }
    }
    const rateLimits = parseCodexRateLimits(payload.rate_limits, eventTimestamp);
    if (rateLimits) {
      state.lastRateLimits = rateLimits;
    }
  }
}

/** Terminal step of the shared Codex rollout reducer. */
function finishCodexRolloutParse(
  state: CodexRolloutParserState,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall[] {
  // A fork without a recognized root-task boundary is ambiguous: older Codex
  // formats may contain only inherited parent history. Omitting that child is
  // safer than charging the parent cumulative counter again. Likewise, a
  // recognized boundary with no later total_token_usage is not a financial
  // call yet.
  if (state.malformedLines > 0) {
    onDiagnostic?.({ code: "malformed_jsonl", count: state.malformedLines });
  }
  if (!state.lastTotal || state.hasInheritedHistory && !state.rootTaskStarted) return [];
  const parsedUsage = parseCodexCumulativeUsage(state.lastTotal, state.inheritedUsageBaseline);
  const parsedTurn = state.lastTurn
    ? parseCodexTurnUsage(state.lastTurn)
    : { supported: true as const };
  const usageSupport = parsedUsage.supported && parsedTurn.supported
    ? "complete" as const
    : "unsupported_token_shape" as const;
  if (usageSupport === "unsupported_token_shape") {
    onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  }
  const hasRestoredEvidence = state.restoredRootCwd !== undefined ||
    (state.restoredWorkdirs !== undefined && state.restoredWorkdirs.length > 0);
  let workingDirectory: string | undefined;
  let workingDirectoryRef: string | undefined;
  let project: string | undefined;
  if (!hasRestoredEvidence) {
    workingDirectory = absoluteWorkingDirectory(dominantCodexCwd(state.rootCwd, state.toolWorkdirs));
    project = projectFromCwd(workingDirectory);
  } else {
    const dominant = resolveStreamedDominantCwd(state);
    workingDirectory = dominant.workingDirectory;
    workingDirectoryRef = dominant.workingDirectoryRef;
    project = dominant.project;
  }
  const activity = buildLocalAgentActivity({
    prompts: state.prompts,
    files: state.fileCounts,
    toolCallCount: state.toolCallCount,
    project,
    isSubagent: state.isSubagent,
    parentSessionId: state.parentSessionId,
    ...(state.restoredPromptOverflow > 0
      ? { priorPromptCount: state.restoredPromptOverflow }
      : {})
  });
  return [{
    agent: "codex",
    model: state.model ?? "codex",
    timestamp: state.lastActivityAt ?? state.startedAt ?? new Date(0).toISOString(),
    startedAt: state.startedAt,
    project,
    workingDirectory,
    ...(workingDirectoryRef ? { workingDirectoryRef } : {}),
    sessionId: state.sessionId,
    ...(state.sourceVersion ? { sourceVersion: state.sourceVersion } : {}),
    ...(state.completedTask && !state.pendingTaskTurnId &&
        Date.parse(state.completedTask.observedAt) >=
          Date.parse(state.lastActivityAt ?? state.startedAt ?? "")
      ? { completion: state.completedTask }
      : {}),
    rateLimits: state.lastRateLimits,
    activity,
    ...(usageSupport === "complete" && parsedTurn.usage
      ? { latestTurnUsage: parsedTurn.usage }
      : {}),
    usageScope: "session_cumulative",
    usageSupport,
    ...(usageSupport === "complete" && state.maxTurnPromptTokens !== undefined
      ? { maxRequestPromptTokens: state.maxTurnPromptTokens }
      : {}),
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    ...(usageSupport === "complete" && parsedUsage.tokenComponentEvidence
      ? { tokenComponentEvidence: parsedUsage.tokenComponentEvidence }
      : {}),
    usage: parsedUsage.usage
  }];
}

/**
 * `dominantCodexCwd` over evidence that partially crossed a checkpoint
 * boundary as hashes. Scores and depths reproduce the raw computation
 * exactly (ancestor refs encode the descendant relation over resolved
 * paths); only the terminal tie-break degrades from full-path localeCompare
 * to basename-then-ref order when a restored entry is involved — the
 * documented QA 27/28 divergence. A winner restored from hashes yields a
 * ref-only working directory, matching warm cache-hit call shape.
 */
function resolveStreamedDominantCwd(state: CodexRolloutParserState): {
  workingDirectory?: string;
  workingDirectoryRef?: string;
  project?: string;
} {
  if (state.rootCwd !== undefined) {
    const sessionProject = projectFromCwd(state.rootCwd);
    if (sessionProject && sessionProject !== "(home)") {
      const workingDirectory = absoluteWorkingDirectory(state.rootCwd);
      return { workingDirectory, project: projectFromCwd(workingDirectory) };
    }
  } else if (state.restoredRootCwd?.present && state.restoredRootCwd.shortCircuits) {
    return {
      ...(state.restoredRootCwd.resolvedRef
        ? { workingDirectoryRef: state.restoredRootCwd.resolvedRef }
        : {}),
      ...(state.restoredRootCwd.resolvedProject
        ? { project: state.restoredRootCwd.resolvedProject }
        : {})
    };
  }
  const merged = mergeCodexWorkdirTallies(state);
  if (merged.length === 0) {
    if (state.rootCwd !== undefined) {
      const workingDirectory = absoluteWorkingDirectory(state.rootCwd);
      return { workingDirectory, project: projectFromCwd(workingDirectory) };
    }
    if (state.restoredRootCwd?.present) {
      return {
        ...(state.restoredRootCwd.resolvedRef
          ? { workingDirectoryRef: state.restoredRootCwd.resolvedRef }
          : {}),
        ...(state.restoredRootCwd.resolvedProject
          ? { project: state.restoredRootCwd.resolvedProject }
          : {})
      };
    }
    return {};
  }
  const scored = merged.map((candidate) => ({
    candidate,
    score: merged.reduce((total, entry) => (
      entry.ref === candidate.ref || entry.ancestorRefs.includes(candidate.ref)
        ? total + entry.count
        : total
    ), 0)
  }));
  scored.sort((left, right) => (
    right.score - left.score ||
    left.candidate.depth - right.candidate.depth ||
    (left.candidate.rawPath !== undefined && right.candidate.rawPath !== undefined
      ? left.candidate.rawPath.localeCompare(right.candidate.rawPath)
      : left.candidate.base.localeCompare(right.candidate.base) ||
        left.candidate.ref.localeCompare(right.candidate.ref))
  ));
  const winner = scored[0]!.candidate;
  if (winner.rawPath !== undefined) {
    return { workingDirectory: winner.rawPath, project: projectFromCwd(winner.rawPath) };
  }
  return {
    workingDirectoryRef: winner.ref,
    ...(winner.base.length > 0 ? { project: winner.base } : {})
  };
}

type MergedCodexWorkdirTally = RestoredCodexWorkdirTally & { rawPath?: string };

/** Merge restored hashed workdir tallies with this slice's raw observations. */
function mergeCodexWorkdirTallies(state: CodexRolloutParserState): MergedCodexWorkdirTally[] {
  const home = resolve(homedir());
  const byRef = new Map<string, MergedCodexWorkdirTally>();
  for (const restored of state.restoredWorkdirs ?? []) {
    if (restored.isHome) continue;
    const existing = byRef.get(restored.ref);
    if (existing) existing.count += restored.count;
    else byRef.set(restored.ref, { ...restored, ancestorRefs: [...restored.ancestorRefs] });
  }
  for (const [rawPath, count] of state.toolWorkdirs) {
    if (resolve(rawPath) === home) continue;
    const tally = hashedWorkdirTally(rawPath, count, home);
    const existing = byRef.get(tally.ref);
    if (existing) {
      existing.count += count;
      existing.rawPath = rawPath;
    } else {
      byRef.set(tally.ref, { ...tally, rawPath });
    }
  }
  return [...byRef.values()];
}

/** Hashed tally row for one observed (already resolved) tool workdir. */
function hashedWorkdirTally(
  path: string,
  count: number,
  home: string
): RestoredCodexWorkdirTally {
  return {
    ref: derivedWorkingDirectoryRef(path),
    ancestorRefs: properAncestorPaths(path).map(derivedWorkingDirectoryRef),
    depth: path.split(sep).length,
    base: basename(path),
    isHome: resolve(path) === home,
    count
  };
}

/**
 * Proper ancestors of a normalized absolute path, excluding the filesystem
 * root: `dominantCodexCwd`'s descendant test (`startsWith(candidate + sep)`)
 * never matches the bare root, so the root must not appear as an ancestor.
 */
function properAncestorPaths(path: string): string[] {
  const ancestors: string[] = [];
  const segments = path.split(sep).filter(Boolean);
  let current = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    current += `${sep}${segments[index]!}`;
    ancestors.push(current);
  }
  return ancestors;
}

/** Parse one Codex rollout file (JSONL event stream). Exported for tests. */
export function parseCodexRollout(
  content: string,
  onEntry?: (entry: Record<string, unknown>) => void,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall[] {
  const state = createCodexRolloutParserState();
  for (const line of content.split("\n")) {
    consumeCodexRolloutLine(state, line, onEntry);
  }
  return finishCodexRolloutParse(state, onDiagnostic);
}

function collectEmbeddedToolWorkdirs(
  input: string | undefined,
  toolWorkdirs: Map<string, number>
): void {
  if (!input) return;
  const fieldPattern = /(?:^|[^A-Za-z0-9_])["']?(?:workdir|cwd)["']?\s*:\s*("(?:\\.|[^"\\])*")/g;
  for (const match of input.matchAll(fieldPattern)) {
    let value: unknown;
    try {
      value = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    if (typeof value !== "string" || !isAbsolute(value)) continue;
    const normalized = resolve(value);
    toolWorkdirs.set(normalized, (toolWorkdirs.get(normalized) ?? 0) + 1);
  }
}

function parseCodexRateLimits(
  value: unknown,
  observedAt: string | undefined
): LocalAgentRateLimitSnapshot | undefined {
  if (!isRecord(value) || !observedAt) return undefined;
  const windows = [value.primary, value.secondary]
    .map((window) => parseCodexRateLimitWindow(window))
    .filter((window): window is LocalAgentRateLimitWindow => Boolean(window));
  if (windows.length === 0) return undefined;
  return {
    observedAt,
    limitId: stringOf(value.limit_id),
    planType: stringOf(value.plan_type),
    windows
  };
}

function parseCodexRateLimitWindow(value: unknown): LocalAgentRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberOf(value.used_percent);
  const windowMinutes = numberOf(value.window_minutes);
  const resetsAtSeconds = numberOf(value.resets_at);
  if (
    usedPercent === undefined ||
    windowMinutes === undefined ||
    windowMinutes <= 0 ||
    resetsAtSeconds === undefined
  ) {
    return undefined;
  }
  const resetMs = resetsAtSeconds < 1_000_000_000_000
    ? resetsAtSeconds * 1_000
    : resetsAtSeconds;
  const resetsAt = toIso(new Date(resetMs).toISOString());
  if (!resetsAt) return undefined;
  const kind = windowMinutes === 300
    ? "five-hour"
    : windowMinutes === 10_080
      ? "weekly"
      : "custom";
  return {
    kind,
    name: kind === "custom" ? `${windowMinutes}-minute` : kind,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt
  };
}

/** Scan this machine's agent logs and return aggregated UsageRecords. */
export async function loadLocalAgentUsage(options: LocalAgentLogOptions = {}): Promise<LocalAgentLogResult> {
  return loadLocalAgentUsageWithFormats(await localAgentFormatRuntimes(), options);
}

/**
 * Read only formats whose registry contract supports action planning.
 *
 * The launch action loop currently has truthful session/completion semantics
 * for Claude Code and Codex. Keeping this entrypoint registry-driven avoids an
 * unnecessary Gemini history walk and prevents presence-only/experimental
 * formats from silently entering a matched token experiment.
 */
export async function loadLocalAgentActionEvidence(
  options: LocalAgentLogOptions = {}
): Promise<LocalAgentLogResult> {
  const runtimes = await localAgentFormatRuntimes();
  return loadLocalAgentUsageWithFormats(
    runtimes.filter((runtime) => runtime.descriptor.capabilities.actionPlanning),
    options
  );
}

/**
 * Registry-driven ingestion engine. Exported from this module for registry
 * contract tests and format modules, but intentionally omitted from the
 * package-root API.
 */
export async function loadLocalAgentUsageWithFormats(
  registry: readonly LocalAgentFormatRuntime[],
  options: LocalAgentLogOptions = {}
): Promise<LocalAgentLogResult> {
  validateLocalAgentFormatDescriptors(registry.map((entry) => entry.descriptor));
  const qualitativePolicy = options.qualitativeScan
    ? validateQualitativeScanPolicy(options.qualitativeScan)
    : undefined;
  const home = homedir();
  const calls: LocalAgentCall[] = [];
  const codexInvocationFiles = options.collectCodexInvocationEvidence
    ? [] as ParsedInvocationFile[]
    : undefined;
  let filesParsed = 0;
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;
  const diagnostics: LocalAgentLogDiagnostic[] = [];
  const sourceScans: LocalAgentSourceScan[] = [];
  // One bounded header-pass budget per run. A malformed coverage ref is
  // dropped rather than compared: proven files then keep blocking (fail
  // closed) instead of reading as foreign to a garbage project.
  const headerPass: CodexHeaderPassState | undefined = options.ownershipIndex
    ? {
        ownershipIndex: options.ownershipIndex,
        ...(options.coverageProjectRef &&
          /^avref_[a-f0-9]{64}$/.test(options.coverageProjectRef)
          ? { coverageProjectRef: options.coverageProjectRef }
          : {}),
        probesRemaining: codexHeaderProbesPerScan
      }
    : undefined;

  for (const runtime of registry) {
    const { descriptor } = runtime;
    const scan = emptySourceScan(descriptor.id);
    if (qualitativePolicy) initializeQualitativeCoverage(scan);
    sourceScans.push(scan);
    const root = localAgentFormatRoot(descriptor, options, home);
    const discoveredFiles = await listFormatCandidateFiles(root, descriptor, scan, diagnostics);
    const files: BoundedQualitativeFile[] = qualitativePolicy
      ? await selectBoundedQualitativeFiles(
          discoveredFiles,
          descriptor,
          sinceMs,
          qualitativePolicy,
          // Must match the loop's per-file derivation exactly (key alignment).
          Boolean(options.collectCodexInvocationEvidence) && descriptor.id === "codex" &&
            descriptor.capabilities.invocationEvidence,
          scan,
          diagnostics,
          options.qualitativeIndex,
          headerPass,
          options.streamCheckpoints
        )
      : discoveredFiles.map((filePath) => ({ filePath }));
    for (const selected of files) {
      const file = selected.filePath;
      if (!matchesLocalAgentFormatFile(descriptor, file)) continue;
      const collectInvocationEvidence = Boolean(codexInvocationFiles) &&
        descriptor.id === "codex" && descriptor.capabilities.invocationEvidence;
      let indexed: LocalAgentQualitativeIndexValue | undefined;
      if (qualitativePolicy && selected.streamedValue) {
        // A checkpointed stream completed this run; its index entry is
        // already persisted. Consume the value like a fresh complete read.
        indexed = selected.streamedValue;
        scan.qualitativeFilesReadCompletely =
          (scan.qualitativeFilesReadCompletely ?? 0) + 1;
      } else if (qualitativePolicy && options.qualitativeIndex && selected.indexKey) {
        try {
          const candidate = await options.qualitativeIndex.read(selected.indexKey);
          if (candidate && await qualitativeIndexKeyStillCurrent(file, selected.indexKey)) {
            if (isQualitativeIndexValue(candidate, descriptor, collectInvocationEvidence)) {
              indexed = candidate;
              scan.qualitativeIndexHits = (scan.qualitativeIndexHits ?? 0) + 1;
              scan.qualitativeBytesReused =
                (scan.qualitativeBytesReused ?? 0) + (selected.fileSize ?? 0);
              scan.qualitativeFilesReadCompletely =
                (scan.qualitativeFilesReadCompletely ?? 0) + 1;
            } else {
              scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
            }
          }
          // A candidate whose file identity moved on mid-scan is a benign
          // change, not an index failure; the fresh-read path fails it closed.
        } catch {
          if (!selected.probeErrored) {
            scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
          }
        }
      }
      // A file admitted only because a validated selection-time hit exempted
      // it from the byte budget must never fall through to an unbudgeted
      // fresh read when the loop probe misses (concurrent GC, transient FS
      // error). Fail closed: record the skip, coverage stays "indexing", and
      // the next scan re-probes.
      if (!indexed && selected.budgetExempt) {
        recordQualitativeBudgetSkip(scan);
        continue;
      }

      let parsed: LocalAgentQualitativeIndexValue;
      if (indexed) {
        parsed = indexed;
      } else {
        let content: string;
        try {
          if (qualitativePolicy) {
            const bounded = await readBoundedUtf8File(
              file,
              selected.maxReadBytes!,
              selected.indexKey!.fileIdentity
            );
            content = bounded.content;
            scan.qualitativeBytesRead = (scan.qualitativeBytesRead ?? 0) + bounded.bytesRead;
            scan.qualitativeFilesReadCompletely =
              (scan.qualitativeFilesReadCompletely ?? 0) + 1;
          } else {
            content = await readFile(file, "utf8");
          }
        } catch (error) {
          if (qualitativePolicy && error instanceof QualitativeReadLimitError) {
            recordQualitativeBudgetSkip(scan);
            continue;
          }
          recordUnreadableFile(descriptor.id, scan, diagnostics, error);
          if (qualitativePolicy) scan.qualitativeCoverage = "partial";
          continue;
        }
        if (!content) continue;
        const fileDiagnostics: TranscriptParseDiagnostic[] = [];
        const fresh = runtime.parseFull({
          content,
          filePath: file,
          sinceMs,
          collectInvocationEvidence,
          onDiagnostic: (diagnostic) => fileDiagnostics.push(diagnostic)
        });
        parsed = {
          calls: fresh.calls,
          ...(fresh.invocationFile ? { invocationFile: fresh.invocationFile } : {}),
          ...(fresh.invocationWindowProof
            ? { invocationWindowProof: fresh.invocationWindowProof }
            : {}),
          diagnostics: fileDiagnostics
        };
        // Never persist a registry ownership violation, even through a
        // caller-supplied adapter. Preserve the legacy fail-fast contract.
        assertFormatCallOwnership(descriptor, parsed.calls);
        assertInvocationOwnership(descriptor, parsed.invocationFile, collectInvocationEvidence);
        if (qualitativePolicy && options.qualitativeIndex && selected.indexKey) {
          try {
            await options.qualitativeIndex.write(selected.indexKey, parsed);
          } catch {
            // One broken store document should read as one failure: the
            // selection probe already counted it when it errored there.
            if (!selected.probeErrored) {
              scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
            }
          }
        }
      }

      filesParsed += 1;
      scan.filesParsed += 1;
      for (const diagnostic of parsed.diagnostics) {
        recordParseDiagnostic(descriptor.id, scan, diagnostics, diagnostic);
      }
      assertFormatCallOwnership(descriptor, parsed.calls);
      assertInvocationOwnership(descriptor, parsed.invocationFile, collectInvocationEvidence);
      calls.push(...parsed.calls);
      if (codexInvocationFiles && collectInvocationEvidence && parsed.invocationFile) {
        codexInvocationFiles.push(parsed.invocationFile);
      }
    }
    if (qualitativePolicy) finishQualitativeCoverage(scan, diagnostics);
  }

  const normalizedCalls = dedupeCumulativeSessionCalls(calls, (agent) => {
    const scan = sourceScans.find((entry) => entry.agent === agent);
    if (scan) {
      recordParseDiagnostic(agent, scan, diagnostics, {
        code: "unsupported_token_shape",
        count: 1
      });
    }
  });
  const filtered = typeof sinceMs === "number"
    ? normalizedCalls.filter((call) => Date.parse(call.timestamp) >= sinceMs)
    : normalizedCalls;

  return {
    records: aggregateCallsForFormats(filtered, registry.map((entry) => entry.descriptor)),
    calls: filtered,
    filesParsed,
    agentsDetected: [...new Set(filtered.map((call) => call.agent))],
    sourceScans,
    diagnostics,
    ...(codexInvocationFiles ? { codexInvocationFiles } : {})
  };
}

type StreamedJsonlResult = {
  hadContent: boolean;
  malformedLines: number;
};

type CodexFinancialFileResult = StreamedJsonlResult & {
  entries: Record<string, unknown>[];
  bytesSkipped: number;
  prefilteredLines: number;
  prefilteredBytes: number;
};

type CodexFinancialStreamState = {
  model?: string;
  rootCwd?: string;
  sessionId?: string;
  sourceVersion?: string;
  rootSessionMetaSeen: boolean;
  startedAt?: string;
  rootStartedAtMs?: number;
  rootTaskStarted: boolean;
  isSubagent: boolean;
  /** Replays another session's history (subagent OR user fork). See
   * `codexHasInheritedHistory`. */
  hasInheritedHistory: boolean;
  inheritedUsageBaseline?: Record<string, unknown>;
  lastActivityAt?: string;
  lastTotal?: Record<string, unknown>;
  lastTurn?: Record<string, unknown>;
  /** Largest single-request prompt seen since the (post-fork) session root. */
  maxTurnPromptTokens?: number;
  lastRateLimits?: LocalAgentRateLimitSnapshot;
};

/**
 * Stream only the financial evidence required by init/status snapshots.
 *
 * Unlike `loadLocalAgentUsage`, this path never derives prompts, file focus,
 * tool activity, or invocation evidence. It deliberately returns the same
 * result contract so callers can preserve the existing evidence and
 * diagnostics vocabulary without maintaining a second loader schema. Codex
 * project attribution intentionally uses only root metadata; home-launched
 * tool-workdir inference remains exclusive to the full qualitative loader.
 */
export async function loadLocalAgentFinancialUsage(
  options: LocalAgentFinancialLogOptions = {}
): Promise<LocalAgentLogResult> {
  return loadLocalAgentFinancialUsageWithFormats(await localAgentFormatRuntimes(), options);
}

/** Registry-driven financial-only engine; package-root exports stay unchanged. */
export async function loadLocalAgentFinancialUsageWithFormats(
  registry: readonly LocalAgentFormatRuntime[],
  options: LocalAgentFinancialLogOptions = {}
): Promise<LocalAgentLogResult> {
  validateLocalAgentFormatDescriptors(registry.map((entry) => entry.descriptor));
  const home = homedir();
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;
  const scanned = await Promise.all(registry.map(async (runtime) => {
    const { descriptor } = runtime;
    const diagnostics: LocalAgentLogDiagnostic[] = [];
    const scan = financialSourceScan(descriptor);
    const calls: LocalAgentCall[] = [];
    const root = localAgentFormatRoot(descriptor, options, home);
    const candidateFiles = (await listFormatCandidateFiles(root, descriptor, scan, diagnostics))
      .filter((file) => matchesLocalAgentFormatFile(descriptor, file));

    // Per-file financial cache (req 5's financial half). The newest file per
    // source always parses fresh: the active session's evidence — including
    // its raw working directory for downstream context inference — must never
    // come from a privacy-reduced cache entry.
    const financialKeys = new Map<string, LocalAgentFinancialIndexKey>();
    let newestFile: string | undefined;
    if (options.financialIndex) {
      let newestRecency = Number.NEGATIVE_INFINITY;
      for (const file of candidateFiles) {
        const metadata = await lstat(file).catch(() => undefined);
        if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) continue;
        financialKeys.set(file, {
          schemaVersion: 2,
          section: "financial",
          agent: descriptor.id,
          pathHash: createHash("sha256").update(resolve(file)).digest("hex"),
          fileIdentity: qualitativeFileIdentity(metadata),
          financialParserVersion: localAgentFinancialParserVersion
        });
        const recency = Math.max(metadata.mtimeMs, metadata.ctimeMs, metadata.birthtimeMs);
        if (recency > newestRecency) {
          newestRecency = recency;
          newestFile = file;
        }
      }
    }

    for (const file of candidateFiles) {
      const financialKey = financialKeys.get(file);
      // Any newest file may reuse its cache when its identity is
      // byte-unchanged — cached evidence is then exact. Codex additionally
      // recovers its root working directory from the bounded session_meta
      // first line; Claude reuse serves refs only and context inference
      // falls back to the requested project path. An actively growing
      // session changes identity and always parses fresh.
      if (options.financialIndex && financialKey) {
        try {
          const cached = await options.financialIndex.read(financialKey);
          if (cached && file === newestFile &&
              !await financialIdentityStillCurrent(file, financialKey)) {
            throw new Error("stale newest identity");
          }
          if (cached) {
            if (file === newestFile && descriptor.id === "codex") {
              await attachProbedRootCwd(
                file,
                cached.calls as LocalAgentCall[],
                financialKey.fileIdentity
              );
            }
            const cachedCalls = cached.calls as LocalAgentCall[];
            assertFormatCallOwnership(descriptor, cachedCalls);
            scan.filesParsed += 1;
            for (const diagnostic of cached.diagnostics) {
              recordParseDiagnostic(descriptor.id, scan, diagnostics, diagnostic);
            }
            calls.push(...cachedCalls);
            continue;
          }
        } catch {
          // A failing cache never blocks the authoritative fresh parse.
        }
      }
      const diagnosticsBefore = diagnostics.length;
      const unreadableBefore = scan.unreadableFiles;
      const filesParsedBefore = scan.filesParsed;
      const parsedCalls = await runtime.parseFinancialFile({
        filePath: file,
        sinceMs,
        scan,
        diagnostics
      });
      assertFormatCallOwnership(descriptor, parsedCalls);
      assertFinancialSourceOwnership(descriptor, scan, diagnostics);
      calls.push(...parsedCalls);
      // Cache only clean, content-bearing parses under the identity captured
      // BEFORE the read: a file that changed mid-parse fails the next
      // identity check instead of serving mixed evidence.
      if (options.financialIndex && financialKey &&
          scan.filesParsed === filesParsedBefore + 1 &&
          scan.unreadableFiles === unreadableBefore) {
        const parseDiagnostics = diagnostics.slice(diagnosticsBefore)
          .filter((entry) => (
            entry.code === "malformed_jsonl" ||
            entry.code === "malformed_session_file" ||
            entry.code === "unsupported_token_shape"
          ))
          .map((entry) => ({ code: entry.code as
            "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape",
            count: entry.count }));
        await options.financialIndex.write(financialKey, {
          calls: parsedCalls,
          diagnostics: parseDiagnostics
        }).catch(() => undefined);
      }
    }
    return { calls, scan, diagnostics };
  }));

  // Sources scan concurrently, but flatten in registry order to preserve the
  // long-standing Claude-then-Codex output and diagnostic contract.
  const calls = scanned.flatMap((entry) => entry.calls);
  const normalizedCalls = dedupeCumulativeSessionCalls(calls, (agent) => {
    const source = scanned.find((entry) => entry.scan.agent === agent);
    if (source) {
      recordParseDiagnostic(agent, source.scan, source.diagnostics, {
        code: "unsupported_token_shape",
        count: 1
      });
    }
  });
  const filtered = typeof sinceMs === "number"
    ? normalizedCalls.filter((call) => Date.parse(call.timestamp) >= sinceMs)
    : normalizedCalls;

  return {
    records: aggregateCallsForFormats(filtered, registry.map((entry) => entry.descriptor)),
    calls: filtered,
    filesParsed: scanned.reduce((total, entry) => total + entry.scan.filesParsed, 0),
    agentsDetected: [...new Set(filtered.map((call) => call.agent))],
    sourceScans: scanned.map((entry) => entry.scan),
    diagnostics: scanned.flatMap((entry) => entry.diagnostics)
  };
}

/** Whether a financial cache key still matches the file's on-disk identity. */
async function financialIdentityStillCurrent(
  filePath: string,
  key: LocalAgentFinancialIndexKey
): Promise<boolean> {
  const metadata = await lstat(filePath).catch(() => undefined);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) return false;
  return qualitativeFileIdentity(metadata) === key.fileIdentity;
}

/**
 * Recover the newest Codex rollout's root working directory from its bounded
 * session_meta first line and re-attach it to cached calls whose privacy-
 * reduced ref matches. Reads at most 256 KiB; never guesses on mismatch.
 */
async function attachProbedRootCwd(
  filePath: string,
  calls: LocalAgentCall[],
  expectedIdentity?: string
): Promise<void> {
  const header = await probeCodexRolloutHeader(filePath, expectedIdentity);
  const cwd = header?.cwd;
  if (!cwd) return;
  const ref = derivedWorkingDirectoryRef(cwd);
  for (const call of calls) {
    if (call.workingDirectoryRef === ref && !call.workingDirectory) {
      call.workingDirectory = cwd;
    }
  }
}

type CodexRolloutHeader = {
  /** Absolute session cwd from the root session_meta record, when present. */
  cwd?: string;
  /** Subagent/fork lineage markers: scheduling hints only, never ownership. */
  isSubagent: boolean;
  parentSessionId?: string;
  forkedFromId?: string;
};

const codexHeaderProbeBytes = 256 * 1024;

/**
 * Bounded Codex rollout header probe (design section c). Opens the exact
 * inode (O_NOFOLLOW), binds both boundary stats to `expectedIdentity` when
 * one is supplied, reads at most the first 256 KiB, and abstractly parses
 * only the first complete line as a root `session_meta` record. Every
 * failure — oversized first line, non-session_meta first line, malformed
 * JSON, identity drift mid-probe — returns undefined: unknown, never an
 * error and never a guess. The raw cwd never escapes its callers beyond
 * deriving an avref or re-attaching evidence that already carried the
 * byte-identical ref.
 */
async function probeCodexRolloutHeader(
  filePath: string,
  expectedIdentity?: string
): Promise<CodexRolloutHeader | undefined> {
  let firstLine: Buffer | undefined;
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() ||
          expectedIdentity !== undefined &&
            qualitativeFileIdentity(before) !== expectedIdentity) {
        return undefined;
      }
      const probe = Buffer.allocUnsafe(codexHeaderProbeBytes);
      let bytesRead = 0;
      let sawEof = false;
      while (bytesRead < probe.length) {
        const read = await handle.read(probe, bytesRead, probe.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) {
          sawEof = true;
          break;
        }
        bytesRead += read.bytesRead;
        if (probe.subarray(0, bytesRead).includes(0x0a)) break;
      }
      const window = probe.subarray(0, bytesRead);
      const newlineAt = window.indexOf(0x0a);
      if (newlineAt > 0) {
        firstLine = Buffer.from(window.subarray(0, newlineAt));
      } else if (newlineAt === -1 && sawEof && bytesRead > 0) {
        // EOF inside the window: the whole file is one complete first line.
        firstLine = Buffer.from(window);
      }
      const after = await handle.stat();
      if (!after.isFile() ||
          expectedIdentity !== undefined &&
            qualitativeFileIdentity(after) !== expectedIdentity) {
        return undefined;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
  if (!firstLine) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(firstLine.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) {
    return undefined;
  }
  const payload = record.payload;
  const cwd = stringOf(payload.cwd);
  const parentSessionId = stringOf(payload.parent_thread_id);
  const forkedFromId = stringOf(payload.forked_from_id);
  return {
    ...(cwd && isAbsolute(cwd) ? { cwd } : {}),
    isSubagent: stringOf(payload.thread_source) === "subagent" ||
      isRecord(payload.source) && "subagent" in payload.source,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(forkedFromId ? { forkedFromId } : {})
  };
}

/**
 * MINOR-5 attribution parity: "proven" requires exactly the condition under
 * which `dominantCodexCwd` short-circuits to the session cwd — an absolute
 * path whose `projectFromCwd` label is a real project (not "(home)"; cwd "/"
 * has an empty basename and falls through to body evidence, QA case 36). A
 * full parse of such a rollout is guaranteed to emit this same directory as
 * its only call's working directory, so the derived ref matches byte-for-
 * byte. Everything else — home, "/", relative, absent, unparseable — stays
 * unknown and keeps blocking; unknown is never treated as foreign.
 */
function codexHeaderAttribution(
  header: CodexRolloutHeader | undefined
): NonNullable<LocalAgentOwnershipRecord["headerAttribution"]> {
  const marker = header ? { isSubagent: header.isSubagent } : {};
  const cwd = header?.cwd;
  if (!cwd || !isAbsolute(cwd)) return { status: "unknown", ...marker };
  const project = projectFromCwd(cwd);
  if (!project || project === "(home)") return { status: "unknown", ...marker };
  // Refs derive from the resolved directory: `absoluteWorkingDirectory`
  // resolves the short-circuited session cwd before the call is emitted.
  return {
    status: "proven",
    projectRef: derivedWorkingDirectoryRef(resolve(cwd)),
    ...marker
  };
}

/** @internal Runtime hook owned by the Claude Code registry entry. */
export async function readClaudeCodeFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "claude-code", scan, diagnostics)) {
    return [];
  }
  const calls: LocalAgentCall[] = [];
  const fileDiagnostics: TranscriptParseDiagnostic[] = [];
  const seen = new Set<string>();
  let streamed: StreamedJsonlResult;
  try {
    streamed = await streamJsonlRecords(filePath, (entry) => {
      const call = parseClaudeFinancialEntry(
        entry,
        filePath,
        // Window-blind on purpose: cached values must contain the complete
        // file so a narrow-window run can never truncate a wider one. The
        // loader's final timestamp filter performs all narrowing.
        undefined,
        seen,
        (diagnostic) => fileDiagnostics.push(diagnostic)
      );
      if (call) calls.push(call);
    });
  } catch (error) {
    recordUnreadableFile("claude-code", scan, diagnostics, error);
    return [];
  }
  if (!streamed.hadContent) return [];
  scan.filesParsed += 1;
  for (const diagnostic of fileDiagnostics) {
    recordParseDiagnostic("claude-code", scan, diagnostics, diagnostic);
  }
  if (streamed.malformedLines > 0) {
    recordParseDiagnostic("claude-code", scan, diagnostics, {
      code: "malformed_jsonl",
      count: streamed.malformedLines
    });
  }
  return calls;
}

/** @internal Runtime hook owned by the Codex registry entry. */
export async function readCodexFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "codex", scan, diagnostics)) {
    return [];
  }
  let financialFile: CodexFinancialFileResult;
  try {
    financialFile = await readCodexFinancialFile(filePath);
  } catch (error) {
    recordUnreadableFile("codex", scan, diagnostics, error);
    return [];
  }
  if (!financialFile.hadContent) return [];
  scan.filesParsed += 1;
  scan.filesReadFinancially = (scan.filesReadFinancially ?? 0) + 1;
  scan.bytesSkippedAsNonFinancialHistory =
    (scan.bytesSkippedAsNonFinancialHistory ?? 0) + financialFile.bytesSkipped;
  scan.nonFinancialLinesPrefiltered =
    (scan.nonFinancialLinesPrefiltered ?? 0) + financialFile.prefilteredLines;
  scan.nonFinancialBytesPrefiltered =
    (scan.nonFinancialBytesPrefiltered ?? 0) + financialFile.prefilteredBytes;
  if (financialFile.bytesSkipped > 0 || financialFile.prefilteredLines > 0) {
    scan.jsonlValidationCoverage = "financial_events_only";
  }
  if (financialFile.malformedLines > 0) {
    recordParseDiagnostic("codex", scan, diagnostics, {
      code: "malformed_jsonl",
      count: financialFile.malformedLines
    });
  }
  const state = createCodexFinancialStreamState();
  for (const entry of financialFile.entries) {
    consumeCodexFinancialEntry(state, entry);
  }
  const call = finishCodexFinancialStream(state, (diagnostic) => {
    recordParseDiagnostic("codex", scan, diagnostics, diagnostic);
  });
  return call ? [call] : [];
}

/** @internal Runtime hook owned by the Gemini CLI registry entry. */
export async function readGeminiFinancialFileForRegistry(
  context: LocalAgentFormatFinancialFileContext
): Promise<LocalAgentCall[]> {
  const { filePath, sinceMs, scan, diagnostics } = context;
  if (!await shouldStreamFile(filePath, sinceMs, "gemini-cli", scan, diagnostics)) {
    return [];
  }
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    recordUnreadableFile("gemini-cli", scan, diagnostics, error);
    return [];
  }
  if (!content) return [];
  scan.filesParsed += 1;
  const parsed = parseGeminiSession(content, { filePath, ...(sinceMs !== undefined ? { sinceMs } : {}) });
  for (const diagnostic of parsed.diagnostics) {
    recordParseDiagnostic(
      "gemini-cli",
      scan,
      diagnostics,
      normalizeGeminiDiagnostic(diagnostic)
    );
  }
  return parsed.calls;
}

function normalizeGeminiDiagnostic(
  diagnostic: GeminiParseDiagnostic
): TranscriptParseDiagnostic {
  if (diagnostic.code === "malformed_jsonl") {
    return { code: "malformed_jsonl", count: diagnostic.count };
  }
  if (diagnostic.code === "unsupported_token_shape") {
    return { code: "unsupported_token_shape", count: diagnostic.count };
  }
  return { code: "malformed_session_file", count: diagnostic.count };
}

async function localAgentFormatRuntimes(): Promise<readonly LocalAgentFormatRuntime[]> {
  const module = await import("./localAgentFormats/runtimeRegistry.js");
  return module.localAgentFormatRuntimeRegistry;
}

function localAgentFormatRoot(
  descriptor: LocalAgentFormatDescriptor,
  options: LocalAgentLogOptions,
  home: string
): string {
  const registryOverride = options.sourceDirectories?.[descriptor.id];
  if (registryOverride) return registryOverride;
  if (descriptor.legacyDirectoryOption === "claudeProjectsDir" && options.claudeProjectsDir) {
    return options.claudeProjectsDir;
  }
  if (descriptor.legacyDirectoryOption === "codexSessionsDir" && options.codexSessionsDir) {
    return options.codexSessionsDir;
  }
  if (descriptor.legacyDirectoryOption === "geminiSessionsDir" && options.geminiSessionsDir) {
    return options.geminiSessionsDir;
  }
  const canonicalHome = resolve(home);
  const root = resolve(canonicalHome, ...descriptor.defaultHomeRelative);
  const fromHome = relative(canonicalHome, root);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error(`Local-agent format ${descriptor.id} resolved outside the home boundary.`);
  }
  return root;
}

function assertFormatCallOwnership(
  descriptor: LocalAgentFormatDescriptor,
  calls: readonly LocalAgentCall[]
): void {
  if (calls.some((call) => call.agent !== descriptor.id)) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted a call for a different source.`
    );
  }
}

function assertFinancialSourceOwnership(
  descriptor: LocalAgentFormatDescriptor,
  scan: LocalAgentSourceScan,
  diagnostics: readonly LocalAgentLogDiagnostic[]
): void {
  if (scan.agent !== descriptor.id || diagnostics.some((entry) => entry.agent !== descriptor.id)) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted financial metadata for a different source.`
    );
  }
}

function assertInvocationOwnership(
  descriptor: LocalAgentFormatDescriptor,
  invocationFile: ParsedInvocationFile | undefined,
  collectionAllowed: boolean
): void {
  if (!invocationFile) return;
  if (!collectionAllowed || descriptor.id !== "codex" ||
      invocationFile.contextSignal.agent !== descriptor.id) {
    throw new Error(
      `Local-agent format ${descriptor.id} emitted invocation evidence for a different source.`
    );
  }
}

type BoundedQualitativeFile = {
  filePath: string;
  maxReadBytes?: number;
  fileSize?: number;
  indexKey?: LocalAgentQualitativeIndexKey;
  /**
   * A selection-time index probe validated this file's cached evidence, so it
   * was admitted without consuming any byte budget (req 5). The parse loop
   * still performs its own probe and identity re-validation.
   */
  budgetExempt?: boolean;
  /** The selection-time probe already counted one index error for this file. */
  probeErrored?: boolean;
  /**
   * Complete evidence produced by a checkpointed stream that finished this
   * run. The entry is already persisted; the parse loop consumes the value
   * exactly like a fresh complete read.
   */
  streamedValue?: LocalAgentQualitativeIndexValue;
};

type QualitativeFileMetadata = {
  filePath: string;
  size: number;
  recencyMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

class QualitativeReadLimitError extends Error {
  constructor() {
    super("Qualitative transcript changed beyond the configured byte limit while being read.");
    this.name = "QualitativeReadLimitError";
  }
}

function validateQualitativeScanPolicy(
  policy: LocalAgentQualitativeScanPolicy
): LocalAgentQualitativeScanPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer byte limit.`);
    }
  }
  return policy;
}

function initializeQualitativeCoverage(scan: LocalAgentSourceScan): void {
  scan.filesSkippedBeforeWindow = 0;
  scan.qualitativeCoverage = "complete";
  scan.qualitativeFilesEligible = 0;
  scan.qualitativeFilesSkippedForBudget = 0;
  scan.qualitativeFilesSelected = 0;
  scan.qualitativeFilesReadCompletely = 0;
  scan.qualitativeBytesEligible = 0;
  scan.qualitativeBytesSelected = 0;
  scan.qualitativeBytesRead = 0;
  scan.qualitativeBytesReused = 0;
  scan.qualitativeIndexHits = 0;
  scan.qualitativeIndexErrors = 0;
  scan.qualitativeFilesIndexed = 0;
  scan.qualitativeFilesForeignProven = 0;
  scan.qualitativeFilesOwnershipUnknown = 0;
  scan.qualitativeSelectedEvidence = "complete_files_only";
}

/**
 * Select complete files, never byte ranges. A partial session can make a
 * cumulative counter look like a turn or make inherited Codex history look
 * like child usage, so a file that does not fit is omitted as a whole.
 */
async function selectBoundedQualitativeFiles(
  discoveredFiles: readonly string[],
  descriptor: LocalAgentFormatDescriptor,
  sinceMs: number | undefined,
  policy: LocalAgentQualitativeScanPolicy,
  collectInvocationEvidence: boolean,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  qualitativeIndex?: LocalAgentQualitativeIndexAdapter,
  headerPass?: CodexHeaderPassState,
  streamCheckpoints?: LocalAgentStreamCheckpointAdapter
): Promise<BoundedQualitativeFile[]> {
  const eligible: QualitativeFileMetadata[] = [];
  for (const filePath of discoveredFiles) {
    if (!matchesLocalAgentFormatFile(descriptor, filePath)) continue;
    let metadata;
    try {
      metadata = await lstat(filePath);
    } catch (error) {
      recordUnreadableFile(descriptor.id, scan, diagnostics, error);
      scan.qualitativeCoverage = "partial";
      continue;
    }
    // Discovery accepts regular files only. Re-check immediately before the
    // read so a path replacement cannot redirect a local scan through a link.
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      recordUnreadableFile(descriptor.id, scan, diagnostics, newErrorWithCode("EINVAL"));
      scan.qualitativeCoverage = "partial";
      continue;
    }
    // Match the financial reader's conservative proof: ctime catches a path
    // whose mtime was restored after replacement, and birthtime catches a
    // recent copy that preserved an older mtime.
    const newestFileEvidence = Math.max(
      metadata.mtimeMs,
      metadata.ctimeMs,
      metadata.birthtimeMs
    );
    if (typeof sinceMs === "number" && Number.isFinite(newestFileEvidence) &&
        newestFileEvidence < sinceMs) {
      scan.filesSkippedBeforeWindow = (scan.filesSkippedBeforeWindow ?? 0) + 1;
      continue;
    }
    scan.qualitativeFilesEligible = (scan.qualitativeFilesEligible ?? 0) + 1;
    scan.qualitativeBytesEligible = (scan.qualitativeBytesEligible ?? 0) + metadata.size;
    eligible.push({
      filePath,
      size: metadata.size,
      recencyMs: newestFileEvidence,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      birthtimeMs: metadata.birthtimeMs
    });
  }

  // Recent evidence is the most useful bounded prefix. Path order breaks
  // equal-mtime ties so repeated scans of an unchanged tree are deterministic.
  eligible.sort((left, right) => (
    right.recencyMs - left.recencyMs || left.filePath.localeCompare(right.filePath)
  ));

  const selected: BoundedQualitativeFile[] = [];
  const streamCandidates: QualitativeFileMetadata[] = [];
  let remaining = policy.maxSourceBytes;
  for (const file of eligible) {
    let probeErrored = false;
    // Probe the private index before any budget decision (req 5): a file with
    // validated cached evidence is admitted regardless of size and consumes
    // no byte budget. The probe is trusted for budget exemption only after
    // the same identity re-check the parse loop performs.
    if (qualitativeIndex) {
      const candidateKey = qualitativeIndexKey(
        descriptor.id, file.filePath, file, sinceMs, collectInvocationEvidence
      );
      let cachedHit = false;
      try {
        const candidate = await qualitativeIndex.read(candidateKey);
        cachedHit = Boolean(
          candidate &&
          await qualitativeIndexKeyStillCurrent(file.filePath, candidateKey) &&
          isQualitativeIndexValue(candidate, descriptor, collectInvocationEvidence)
        );
      } catch {
        probeErrored = true;
        scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
      }
      if (cachedHit) {
        selected.push({
          filePath: file.filePath,
          maxReadBytes: file.size,
          fileSize: file.size,
          indexKey: candidateKey,
          budgetExempt: true,
          probeErrored
        });
        scan.qualitativeFilesSelected = (scan.qualitativeFilesSelected ?? 0) + 1;
        continue;
      }
    }
    // Oversized Codex rollouts route to the bounded streaming pass instead
    // of a permanent skip whenever both index sections are available; they
    // never consume the whole-file byte budget (req 5).
    if (streamCheckpoints && qualitativeIndex && descriptor.id === "codex" &&
        file.size > policy.maxFileBytes) {
      streamCandidates.push(file);
      continue;
    }
    if (file.size > policy.maxFileBytes || file.size > remaining) {
      recordQualitativeBudgetSkip(scan);
      // A budget-skipped Codex file still gets a bounded header pass so a
      // proven-foreign attribution can honestly narrow the requested
      // project's blocking set without ever reading the body. Claude files
      // get no header shortcut (their cwd can change mid-file).
      if (headerPass && descriptor.id === "codex") {
        await recordBudgetSkippedCodexHeader(file, headerPass, scan);
      }
      continue;
    }
    selected.push({
      filePath: file.filePath,
      // Bind the read to the selected metadata snapshot. Growth is treated as
      // incomplete coverage rather than silently consuming another file's
      // reserved source budget.
      maxReadBytes: file.size,
      fileSize: file.size,
      indexKey: qualitativeIndexKey(
        descriptor.id,
        file.filePath,
        file,
        sinceMs,
        collectInvocationEvidence
      ),
      probeErrored: probeErrored || undefined
    });
    scan.qualitativeFilesSelected = (scan.qualitativeFilesSelected ?? 0) + 1;
    scan.qualitativeBytesSelected = (scan.qualitativeBytesSelected ?? 0) + file.size;
    remaining -= file.size;
  }
  if (streamCandidates.length > 0 && streamCheckpoints && qualitativeIndex) {
    const streamed = await runCodexStreamingPass(streamCandidates, {
      descriptor,
      qualitativeIndex,
      streamCheckpoints,
      ...(headerPass ? { ownershipIndex: headerPass.ownershipIndex } : {}),
      collectInvocationEvidence,
      sinceMs,
      scan,
      remainingBytes: policy.maxStreamedBytesPerRun ?? defaultStreamedBytesPerRun
    });
    for (const file of streamCandidates) {
      const value = streamed.get(file.filePath);
      if (value) {
        selected.push({
          filePath: file.filePath,
          fileSize: file.size,
          streamedValue: value
        });
        scan.qualitativeFilesSelected = (scan.qualitativeFilesSelected ?? 0) + 1;
        continue;
      }
      // Unconverged this run: same honest accounting as a budget skip (the
      // body was not fully parsed), plus explicit stream-progress counters
      // and the A4a header-pass ownership classification.
      recordQualitativeBudgetSkip(scan);
      scan.qualitativeFilesStreaming = (scan.qualitativeFilesStreaming ?? 0) + 1;
      if (headerPass) {
        await recordBudgetSkippedCodexHeader(file, headerPass, scan);
      }
    }
  }
  return selected;
}

type CodexHeaderPassState = {
  ownershipIndex: LocalAgentOwnershipIndexAdapter;
  /** Validated `avref_…` requested by the caller, if any. */
  coverageProjectRef?: string;
  /** Fresh header reads left this run; persisted results carry over honestly. */
  probesRemaining: number;
};

/**
 * Fresh bounded header reads allowed per scan. Files beyond the cap simply
 * stay ownership-unknown ("indexing") this run — never claimed either way —
 * and are reached on a later run once earlier probes persist their results.
 */
export const codexHeaderProbesPerScan = 64;

/**
 * Classify one budget-skipped Codex file from its persisted or freshly probed
 * header attribution. Only a "proven" attribution to a project OTHER than the
 * requested coverage ref counts as foreign; proven-owned and unknown files
 * keep blocking. Store failures count as index errors, which already force
 * the fail-closed "indexing" state.
 */
async function recordBudgetSkippedCodexHeader(
  file: QualitativeFileMetadata,
  headerPass: CodexHeaderPassState,
  scan: LocalAgentSourceScan
): Promise<void> {
  const pathHash = createHash("sha256").update(resolve(file.filePath)).digest("hex");
  const fileIdentity = qualitativeFileIdentity(file);
  let attribution: LocalAgentOwnershipRecord["headerAttribution"];
  try {
    const stored = await headerPass.ownershipIndex.readOwnership("codex", pathHash);
    if (stored && stored.fileIdentity === fileIdentity) {
      attribution = stored.headerAttribution;
    }
  } catch {
    scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
    return;
  }
  if (!attribution) {
    // Honest carry-over: past the cap the file simply stays unknown this run.
    if (headerPass.probesRemaining <= 0) return;
    headerPass.probesRemaining -= 1;
    attribution = codexHeaderAttribution(
      await probeCodexRolloutHeader(file.filePath, fileIdentity)
    );
    try {
      await headerPass.ownershipIndex.writeOwnership("codex", pathHash, {
        // Body-derived ownership is still unknown: only the header was read.
        status: "unknown",
        fileIdentity,
        projectRefs: [],
        headerAttribution: attribution
      });
    } catch {
      scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
      return;
    }
  }
  if (attribution.status === "proven" && attribution.projectRef &&
      headerPass.coverageProjectRef &&
      attribution.projectRef !== headerPass.coverageProjectRef) {
    scan.qualitativeFilesForeignProven = (scan.qualitativeFilesForeignProven ?? 0) + 1;
  }
}

const codexStreamChunkBytes = 8 * 1_024 * 1_024;
/** A single JSONL line above this bound is skipped as malformed (design e). */
const codexStreamMaxLineBytes = 32 * 1_024 * 1_024;
const codexStreamPrefixProbeBytes = 64 * 1_024;
/**
 * Default per-run byte allowance for the streaming pass. Sized from measured
 * end-to-end throughput (~99 MB/s on the reference machine, QA probe8): 512
 * MiB keeps one slice at roughly 4-5 seconds of wall clock inside the cold
 * budget. Callers with different budgets tune `maxStreamedBytesPerRun`.
 */
export const defaultStreamedBytesPerRun = 512 * 1_024 * 1_024;
/** Bounded per-run header probes used only to order the streaming schedule. */
const codexStreamSchedulingProbesPerScan = 256;

/** Persisted privacy-reduced Codex reducer state (checkpoint payload). */
type PersistedCodexReducerState = {
  model?: string;
  sessionId?: string;
  sourceVersion?: string;
  rootSessionMetaSeen: boolean;
  startedAt?: string;
  rootStartedAtMs?: number;
  rootTaskStarted: boolean;
  isSubagent: boolean;
  hasInheritedHistory?: boolean;
  parentSessionId?: string;
  pendingTaskTurnId?: string;
  completedTask?: LocalAgentCompletionEvidence;
  malformedLines: number;
  lastActivityAt?: string;
  lastTotal?: Record<string, unknown>;
  lastTurn?: Record<string, unknown>;
  maxTurnPromptTokens?: number;
  inheritedUsageBaseline?: Record<string, unknown>;
  lastRateLimits?: LocalAgentRateLimitSnapshot;
  rootCwd: RestoredCodexRootCwd;
  workdirs: RestoredCodexWorkdirTally[];
  promptOverflow: number;
  recentPrompts: string[];
  fileCounts: Array<[string, number]>;
  toolCallCount: number;
};

/** Documented retention caps for the privacy-reduced checkpoint state. */
const checkpointRecentPromptLimit = 12;
const checkpointPromptCharLimit = 4_096;
const checkpointFileCountLimit = 256;
const checkpointWorkdirLimit = 128;

/**
 * Reduce live reducer state to its persistable form: prompts pass through
 * `sanitizeLocalActivityText` and keep only the last 12 survivors (earlier
 * survivors persist as a count); file basename tallies and hashed workdir
 * tallies are capped deterministically; the raw session cwd collapses to its
 * short-circuit decision plus resolved ref/project. Raw absolute paths and
 * raw prompt text never reach disk.
 */
function serializeCodexReducerState(state: CodexRolloutParserState): PersistedCodexReducerState {
  // Path spans are stripped BEFORE sanitization so persisted survivors carry
  // the same privacy guarantee as entries: raw absolute paths (including
  // home-anchored ones) never reach disk. Topic derivation is unaffected
  // (topicTokens strips the same spans); the residual divergence is that
  // inferAction can no longer see action words embedded inside path segments
  // of checkpoint-crossing prompts, and path-only prompts stop counting —
  // pinned by the streaming privacy fixture.
  const survivors = state.prompts
    .map((prompt) => sanitizeLocalActivityText(stripAbsolutePathSpans(prompt)))
    .filter(isHumanPrompt)
    .map((prompt) => prompt.length > checkpointPromptCharLimit
      ? prompt.slice(0, checkpointPromptCharLimit)
      : prompt);
  const recentPrompts = survivors.slice(-checkpointRecentPromptLimit);
  const promptOverflow = state.restoredPromptOverflow +
    Math.max(0, survivors.length - checkpointRecentPromptLimit);
  let rootCwd: RestoredCodexRootCwd;
  if (state.rootCwd !== undefined) {
    const sessionProject = projectFromCwd(state.rootCwd);
    const resolved = absoluteWorkingDirectory(state.rootCwd);
    rootCwd = {
      present: true,
      shortCircuits: Boolean(sessionProject && sessionProject !== "(home)"),
      ...(resolved !== undefined
        ? {
            resolvedRef: derivedWorkingDirectoryRef(resolved),
            ...(projectFromCwd(resolved) !== undefined
              ? { resolvedProject: projectFromCwd(resolved) }
              : {})
          }
        : {})
    };
  } else if (state.restoredRootCwd) {
    rootCwd = state.restoredRootCwd;
  } else {
    rootCwd = { present: false, shortCircuits: false };
  }
  const workdirs = mergeCodexWorkdirTallies(state)
    .map(({ rawPath: _rawPath, ...tally }) => tally)
    .sort((left, right) => right.count - left.count || left.ref.localeCompare(right.ref))
    .slice(0, checkpointWorkdirLimit);
  const fileCounts = [...state.fileCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, checkpointFileCountLimit);
  return {
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    ...(state.sourceVersion !== undefined ? { sourceVersion: state.sourceVersion } : {}),
    rootSessionMetaSeen: state.rootSessionMetaSeen,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.rootStartedAtMs !== undefined ? { rootStartedAtMs: state.rootStartedAtMs } : {}),
    rootTaskStarted: state.rootTaskStarted,
    isSubagent: state.isSubagent,
    hasInheritedHistory: state.hasInheritedHistory,
    ...(state.parentSessionId !== undefined ? { parentSessionId: state.parentSessionId } : {}),
    ...(state.pendingTaskTurnId !== undefined ? { pendingTaskTurnId: state.pendingTaskTurnId } : {}),
    ...(state.completedTask !== undefined ? { completedTask: state.completedTask } : {}),
    malformedLines: state.malformedLines,
    ...(state.lastActivityAt !== undefined ? { lastActivityAt: state.lastActivityAt } : {}),
    ...(state.lastTotal !== undefined ? { lastTotal: state.lastTotal } : {}),
    ...(state.lastTurn !== undefined ? { lastTurn: state.lastTurn } : {}),
    ...(state.maxTurnPromptTokens !== undefined
      ? { maxTurnPromptTokens: state.maxTurnPromptTokens }
      : {}),
    ...(state.inheritedUsageBaseline !== undefined
      ? { inheritedUsageBaseline: state.inheritedUsageBaseline }
      : {}),
    ...(state.lastRateLimits !== undefined ? { lastRateLimits: state.lastRateLimits } : {}),
    rootCwd,
    workdirs,
    promptOverflow,
    recentPrompts,
    fileCounts,
    toolCallCount: state.toolCallCount
  };
}

/** Fail-closed structural check for a restored reducer state. */
function isPersistedCodexReducerState(value: unknown): value is PersistedCodexReducerState {
  if (!isRecord(value)) return false;
  const optionalString = (input: unknown): boolean =>
    input === undefined || typeof input === "string";
  const optionalRecord = (input: unknown): boolean =>
    input === undefined || isRecord(input) && !Array.isArray(input);
  const optionalFinite = (input: unknown): boolean =>
    input === undefined || typeof input === "number" && Number.isFinite(input);
  const nonnegativeInt = (input: unknown): boolean =>
    Number.isSafeInteger(input) && Number(input) >= 0;
  const rootCwd = value.rootCwd;
  const validRootCwd = isRecord(rootCwd) &&
    typeof rootCwd.present === "boolean" &&
    typeof rootCwd.shortCircuits === "boolean" &&
    optionalString(rootCwd.resolvedRef) &&
    optionalString(rootCwd.resolvedProject);
  const validWorkdirs = Array.isArray(value.workdirs) && value.workdirs.every((entry) => (
    isRecord(entry) &&
    typeof entry.ref === "string" &&
    Array.isArray(entry.ancestorRefs) &&
    entry.ancestorRefs.every((ref) => typeof ref === "string") &&
    nonnegativeInt(entry.depth) &&
    typeof entry.base === "string" &&
    typeof entry.isHome === "boolean" &&
    nonnegativeInt(entry.count)
  ));
  const validCompletion = value.completedTask === undefined || (
    isRecord(value.completedTask) &&
    value.completedTask.status === "completed" &&
    value.completedTask.evidence === "codex_task_complete" &&
    typeof value.completedTask.observedAt === "string"
  );
  const validRateLimits = value.lastRateLimits === undefined || (
    isRecord(value.lastRateLimits) &&
    typeof value.lastRateLimits.observedAt === "string" &&
    Array.isArray(value.lastRateLimits.windows)
  );
  return typeof value.rootSessionMetaSeen === "boolean" &&
    typeof value.rootTaskStarted === "boolean" &&
    typeof value.isSubagent === "boolean" &&
    (value.hasInheritedHistory === undefined ||
      typeof value.hasInheritedHistory === "boolean") &&
    optionalString(value.model) &&
    optionalString(value.sessionId) &&
    optionalString(value.sourceVersion) &&
    optionalString(value.startedAt) &&
    optionalFinite(value.rootStartedAtMs) &&
    optionalString(value.parentSessionId) &&
    optionalString(value.pendingTaskTurnId) &&
    validCompletion &&
    nonnegativeInt(value.malformedLines) &&
    optionalString(value.lastActivityAt) &&
    optionalRecord(value.lastTotal) &&
    optionalRecord(value.lastTurn) &&
    optionalFinite(value.maxTurnPromptTokens) &&
    optionalRecord(value.inheritedUsageBaseline) &&
    validRateLimits &&
    validRootCwd &&
    validWorkdirs &&
    nonnegativeInt(value.promptOverflow) &&
    Array.isArray(value.recentPrompts) &&
    value.recentPrompts.every((prompt) => typeof prompt === "string") &&
    Array.isArray(value.fileCounts) &&
    value.fileCounts.every((pair) => (
      Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === "string" && nonnegativeInt(pair[1])
    )) &&
    nonnegativeInt(value.toolCallCount);
}

function restoreCodexReducerState(persisted: PersistedCodexReducerState): CodexRolloutParserState {
  const state = createCodexRolloutParserState();
  state.model = persisted.model;
  state.sessionId = persisted.sessionId;
  state.sourceVersion = persisted.sourceVersion;
  state.rootSessionMetaSeen = persisted.rootSessionMetaSeen;
  state.startedAt = persisted.startedAt;
  state.rootStartedAtMs = persisted.rootStartedAtMs;
  state.rootTaskStarted = persisted.rootTaskStarted;
  state.isSubagent = persisted.isSubagent;
  // Pre-fork-fix checkpoints carry no flag; fall back to the subagent bit so a
  // restored subagent keeps its boundary (a restored user fork re-parses, its
  // parser version having changed).
  state.hasInheritedHistory = persisted.hasInheritedHistory ?? persisted.isSubagent;
  state.parentSessionId = persisted.parentSessionId;
  state.pendingTaskTurnId = persisted.pendingTaskTurnId;
  state.completedTask = persisted.completedTask;
  state.malformedLines = persisted.malformedLines;
  state.lastActivityAt = persisted.lastActivityAt;
  state.lastTotal = persisted.lastTotal;
  state.lastTurn = persisted.lastTurn;
  state.maxTurnPromptTokens = persisted.maxTurnPromptTokens;
  state.inheritedUsageBaseline = persisted.inheritedUsageBaseline;
  state.lastRateLimits = persisted.lastRateLimits;
  state.restoredRootCwd = persisted.rootCwd;
  state.restoredWorkdirs = persisted.workdirs;
  state.prompts = [...persisted.recentPrompts];
  state.restoredPromptOverflow = persisted.promptOverflow;
  state.fileCounts = new Map(persisted.fileCounts);
  state.toolCallCount = persisted.toolCallCount;
  return state;
}

type CodexStreamCandidate = {
  file: QualitativeFileMetadata;
  pathHash: string;
  checkpoint?: LocalAgentStreamCheckpointRecord;
  /** undefined = header unknown; scheduled after known-mainline files. */
  isSubagent?: boolean;
};

type CodexStreamingRunContext = {
  descriptor: LocalAgentFormatDescriptor;
  qualitativeIndex: LocalAgentQualitativeIndexAdapter;
  streamCheckpoints: LocalAgentStreamCheckpointAdapter;
  /** Reused for persisted subagent markers so scheduling avoids re-probing. */
  ownershipIndex?: LocalAgentOwnershipIndexAdapter;
  collectInvocationEvidence: boolean;
  sinceMs: number | undefined;
  scan: LocalAgentSourceScan;
  remainingBytes: number;
};

/**
 * One run's bounded streaming pass over oversized Codex rollouts. Candidates
 * are ordered mainline-first (checkpoint or bounded header probe supplies the
 * subagent marker) so the 326-subagent reverse-scan pathology can never
 * starve mainline files, then newest-first within each class. Returns the
 * evidence of every file whose stream completed this run; everything else
 * advanced by at least its checkpoint and stays honestly unconverged.
 */
async function runCodexStreamingPass(
  files: readonly QualitativeFileMetadata[],
  context: CodexStreamingRunContext
): Promise<Map<string, LocalAgentQualitativeIndexValue>> {
  const scan = context.scan;
  const candidates: CodexStreamCandidate[] = [];
  let schedulingProbes = codexStreamSchedulingProbesPerScan;
  for (const file of files) {
    const pathHash = createHash("sha256").update(resolve(file.filePath)).digest("hex");
    let checkpoint: LocalAgentStreamCheckpointRecord | undefined;
    try {
      checkpoint = await context.streamCheckpoints.readStreamCheckpoint("codex", pathHash);
    } catch {
      scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
    }
    let isSubagent: boolean | undefined;
    if (checkpoint && isPersistedCodexReducerState(checkpoint.reducerState) &&
        checkpoint.reducerState.rootSessionMetaSeen) {
      isSubagent = checkpoint.reducerState.isSubagent;
    } else {
      if (context.ownershipIndex) {
        try {
          const stored = await context.ownershipIndex.readOwnership("codex", pathHash);
          if (stored && stored.fileIdentity === qualitativeFileIdentity(file)) {
            isSubagent = stored.headerAttribution?.isSubagent;
          }
        } catch {
          // Scheduling is a hint; the ledger's own ownership reads count
          // store failures and force the fail-closed coverage state.
        }
      }
      if (isSubagent === undefined && schedulingProbes > 0) {
        schedulingProbes -= 1;
        const header = await probeCodexRolloutHeader(file.filePath, qualitativeFileIdentity(file));
        isSubagent = header?.isSubagent;
      }
    }
    candidates.push({
      file,
      pathHash,
      ...(checkpoint ? { checkpoint } : {}),
      ...(isSubagent !== undefined ? { isSubagent } : {})
    });
  }
  const classOf = (candidate: CodexStreamCandidate): number =>
    candidate.isSubagent === false ? 0 : candidate.isSubagent === undefined ? 1 : 2;
  candidates.sort((left, right) => (
    classOf(left) - classOf(right) ||
    right.file.recencyMs - left.file.recencyMs ||
    left.file.filePath.localeCompare(right.file.filePath)
  ));
  const completed = new Map<string, LocalAgentQualitativeIndexValue>();
  const budget = { remainingBytes: context.remainingBytes };
  for (const candidate of candidates) {
    // The policy validator guarantees a positive allowance, so the first
    // scheduled candidate always streams; later candidates run only while
    // allowance remains (mainline-first order makes this starvation-safe).
    if (budget.remainingBytes <= 0) break;
    const value = await streamCodexRolloutSlice(candidate, context, budget);
    if (value) completed.set(candidate.file.filePath, value);
  }
  return completed;
}

/**
 * Advance one oversized rollout by a bounded slice; complete it when EOF is
 * reached with a stable identity. Every failure path degrades to "no claim
 * this run": a broken resume proof restarts from byte zero, a mid-stream
 * append keeps the checkpoint and withholds the entry (design edge 4), and
 * store errors surface as index errors that force the fail-closed
 * "indexing" coverage state.
 */
async function streamCodexRolloutSlice(
  candidate: CodexStreamCandidate,
  context: CodexStreamingRunContext,
  budget: { remainingBytes: number }
): Promise<LocalAgentQualitativeIndexValue | undefined> {
  const scan = context.scan;
  const selectionIdentity = qualitativeFileIdentity(candidate.file);
  const runSinceIso = typeof context.sinceMs === "number"
    ? new Date(context.sinceMs).toISOString()
    : null;
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidate.file.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() ||
        before.dev !== candidate.file.dev ||
        before.ino !== candidate.file.ino ||
        before.birthtimeMs !== candidate.file.birthtimeMs) {
      return undefined;
    }

    // Resume proof: pinned identity, monotonic size, matching prefix bytes,
    // matching contract, and structurally valid restored state. Anything
    // less discards the checkpoint and restarts from byte zero.
    let state = createCodexRolloutParserState();
    let collector = context.collectInvocationEvidence
      ? createCodexInvocationCollector(context.sinceMs)
      : undefined;
    let offset = 0;
    let entrySinceIso = context.collectInvocationEvidence ? runSinceIso : null;
    const checkpoint = candidate.checkpoint;
    if (checkpoint) {
      let resumable = checkpoint.parserVersion === localAgentQualitativeParserVersion &&
        checkpoint.collectInvocationEvidence === context.collectInvocationEvidence &&
        checkpoint.pin.dev === candidate.file.dev &&
        checkpoint.pin.ino === candidate.file.ino &&
        checkpoint.pin.birthtimeMs === candidate.file.birthtimeMs &&
        checkpoint.offset <= candidate.file.size &&
        checkpoint.prefixProbe.bytes === Math.min(codexStreamPrefixProbeBytes, checkpoint.offset) &&
        isPersistedCodexReducerState(checkpoint.reducerState) &&
        (!context.collectInvocationEvidence ||
          isCodexInvocationCollectorSnapshot(checkpoint.collectorState));
      if (resumable && checkpoint.offset > 0) {
        const probeBytes = Math.min(codexStreamPrefixProbeBytes, checkpoint.offset);
        const probe = Buffer.allocUnsafe(probeBytes);
        let probeRead = 0;
        while (probeRead < probeBytes) {
          const read = await handle.read(
            probe, probeRead, probeBytes - probeRead, checkpoint.offset - probeBytes + probeRead
          );
          if (read.bytesRead === 0) break;
          probeRead += read.bytesRead;
        }
        resumable = probeRead === probeBytes &&
          createHash("sha256").update(probe).digest("hex") === checkpoint.prefixProbe.sha256;
      }
      if (resumable) {
        state = restoreCodexReducerState(checkpoint.reducerState as PersistedCodexReducerState);
        if (context.collectInvocationEvidence) {
          const pinnedSinceMs = checkpoint.sinceIso === null
            ? undefined
            : Date.parse(checkpoint.sinceIso);
          collector = createCodexInvocationCollector(
            pinnedSinceMs,
            checkpoint.collectorState as CodexInvocationCollectorSnapshot
          );
          entrySinceIso = checkpoint.sinceIso;
        }
        offset = checkpoint.offset;
      } else {
        await context.streamCheckpoints.deleteStreamCheckpoint("codex", candidate.pathHash)
          .catch(() => undefined);
      }
    }

    // Bounded chunked line consumption from the resume offset.
    const collectorConsume = collector?.consume;
    let consumed = offset;
    let position = offset;
    let carry = Buffer.alloc(0);
    let skippingOversizedLine = false;
    let linesConsumed = 0;
    let sawEof = false;
    while (true) {
      // A candidate that was scheduled always consumes at least one complete
      // line (or reaches EOF/an oversized-line skip) before yielding to the
      // byte allowance — this is what guarantees convergence across runs.
      if (budget.remainingBytes <= 0 && linesConsumed > 0) break;
      const readLength = budget.remainingBytes > 0
        ? Math.min(codexStreamChunkBytes, budget.remainingBytes)
        : codexStreamChunkBytes;
      const chunk = Buffer.allocUnsafe(readLength);
      const read = await handle.read(chunk, 0, readLength, position);
      if (read.bytesRead === 0) {
        sawEof = true;
        break;
      }
      budget.remainingBytes -= read.bytesRead;
      scan.qualitativeBytesStreamed = (scan.qualitativeBytesStreamed ?? 0) + read.bytesRead;
      const dataStart = position - carry.length;
      position += read.bytesRead;
      const data = carry.length > 0
        ? Buffer.concat([carry, chunk.subarray(0, read.bytesRead)])
        : chunk.subarray(0, read.bytesRead);
      let lineStart = 0;
      while (true) {
        const newlineAt = data.indexOf(0x0a, lineStart);
        if (newlineAt === -1) break;
        if (skippingOversizedLine) {
          // The oversized line just terminated; count it once, exactly when
          // its bytes are durably consumed past the checkpoint offset.
          skippingOversizedLine = false;
          state.malformedLines += 1;
        } else if (newlineAt - lineStart > codexStreamMaxLineBytes) {
          // Exact bound: chunk alignment can let a just-over-cap line
          // accumulate fully before its newline arrives; it is still skipped
          // as malformed, matching the documented >32 MiB rule.
          state.malformedLines += 1;
        } else {
          consumeCodexRolloutLine(
            state,
            data.subarray(lineStart, newlineAt).toString("utf8"),
            collectorConsume
          );
        }
        lineStart = newlineAt + 1;
        linesConsumed += 1;
        consumed = dataStart + lineStart;
      }
      if (skippingOversizedLine) {
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.from(data.subarray(lineStart));
        if (carry.length > codexStreamMaxLineBytes) {
          skippingOversizedLine = true;
          carry = Buffer.alloc(0);
        }
      }
    }

    // A crashed or kill-9'd session leaves a final line with no trailing
    // newline, and that file never changes again. When the post-slice
    // identity still equals the selection identity, the tail is provably not
    // an in-flight append: consume it as the final complete line, exactly as
    // the whole-file parser's split("\\n") treats the same bytes. A torn tail
    // degrades to the malformed_jsonl diagnostic both paths share.
    if (sawEof && !skippingOversizedLine && carry.length > 0) {
      const settled = await handle.stat();
      if (settled.isFile() && settled.size === consumed + carry.length &&
          qualitativeFileIdentity(settled) === selectionIdentity) {
        if (carry.length > codexStreamMaxLineBytes) {
          state.malformedLines += 1;
        } else {
          consumeCodexRolloutLine(state, carry.toString("utf8"), collectorConsume);
        }
        consumed += carry.length;
        carry = Buffer.alloc(0);
      }
    }
    if (sawEof && !skippingOversizedLine && carry.length === 0 && consumed > 0) {
      const after = await handle.stat();
      if (after.isFile() && after.size === consumed &&
          qualitativeFileIdentity(after) === selectionIdentity) {
        return await completeStreamedRollout(
          candidate, context, state, collector, consumed, entrySinceIso, runSinceIso
        );
      }
      // The rollout changed while streaming (an active append): keep the
      // checkpoint at the last complete line and withhold the entry.
    }
    if (consumed > offset || (consumed > 0 && !candidate.checkpoint)) {
      await writeStreamCheckpointAt(candidate, context, handle, state, collector, consumed, entrySinceIso);
    }
    return undefined;
  } catch {
    // Unreadable mid-stream: no claim this run; selection re-treats the file
    // as skipped and the ledger keeps it blocking.
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeStreamCheckpointAt(
  candidate: CodexStreamCandidate,
  context: CodexStreamingRunContext,
  handle: FileHandle,
  state: CodexRolloutParserState,
  collector: ReturnType<typeof createCodexInvocationCollector> | undefined,
  consumed: number,
  entrySinceIso: string | null
): Promise<void> {
  const scan = context.scan;
  const probeBytes = Math.min(codexStreamPrefixProbeBytes, consumed);
  const probe = Buffer.allocUnsafe(probeBytes);
  let probeRead = 0;
  while (probeRead < probeBytes) {
    const read = await handle.read(
      probe, probeRead, probeBytes - probeRead, consumed - probeBytes + probeRead
    );
    if (read.bytesRead === 0) break;
    probeRead += read.bytesRead;
  }
  if (probeRead !== probeBytes) {
    scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
    return;
  }
  try {
    await context.streamCheckpoints.writeStreamCheckpoint("codex", candidate.pathHash, {
      pin: {
        dev: candidate.file.dev,
        ino: candidate.file.ino,
        birthtimeMs: candidate.file.birthtimeMs
      },
      parserVersion: localAgentQualitativeParserVersion,
      collectInvocationEvidence: context.collectInvocationEvidence,
      sinceIso: entrySinceIso,
      offset: consumed,
      prefixProbe: {
        bytes: probeBytes,
        sha256: createHash("sha256").update(probe).digest("hex")
      },
      reducerState: serializeCodexReducerState(state),
      ...(collector ? { collectorState: collector.snapshot() } : {})
    });
  } catch {
    scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
  }
}

async function completeStreamedRollout(
  candidate: CodexStreamCandidate,
  context: CodexStreamingRunContext,
  state: CodexRolloutParserState,
  collector: ReturnType<typeof createCodexInvocationCollector> | undefined,
  consumed: number,
  entrySinceIso: string | null,
  runSinceIso: string | null
): Promise<LocalAgentQualitativeIndexValue> {
  const scan = context.scan;
  const fileDiagnostics: TranscriptParseDiagnostic[] = [];
  const calls = finishCodexRolloutParse(state, (diagnostic) => fileDiagnostics.push(diagnostic));
  const invocationFile = collector?.finish();
  const invocationWindowProof = collector?.windowProof();
  const stored: LocalAgentQualitativeIndexValue = {
    calls,
    ...(invocationFile ? { invocationFile } : {}),
    ...(collector ? { invocationWindowProof } : {}),
    diagnostics: fileDiagnostics
  };
  assertFormatCallOwnership(context.descriptor, stored.calls);
  assertInvocationOwnership(
    context.descriptor, stored.invocationFile, context.collectInvocationEvidence
  );
  const entryKey: LocalAgentQualitativeIndexKey = {
    schemaVersion: 1,
    parserVersion: localAgentQualitativeParserVersion,
    agent: "codex",
    pathHash: candidate.pathHash,
    fileIdentity: qualitativeFileIdentity(candidate.file),
    sinceIso: entrySinceIso,
    collectInvocationEvidence: context.collectInvocationEvidence
  };
  let entryPersisted = false;
  try {
    await context.qualitativeIndex.write(entryKey, stored);
    entryPersisted = true;
  } catch {
    scan.qualitativeIndexErrors = (scan.qualitativeIndexErrors ?? 0) + 1;
  }
  if (entryPersisted) {
    // Only a durably indexed file may drop its resumable state.
    await context.streamCheckpoints.deleteStreamCheckpoint("codex", candidate.pathHash)
      .catch(() => undefined);
  }
  void consumed;
  // The stored entry carries the pinned collector window. This run may have
  // requested a newer window; aggregated invocation evidence is used in-run
  // only when it narrows exactly, otherwise this run honestly reports
  // partial coverage while the calls (window-blind, filtered by timestamp
  // downstream) remain exact.
  if (stored.invocationFile && entrySinceIso !== runSinceIso &&
      !streamedInvocationNarrowsExactly(entrySinceIso, runSinceIso, stored)) {
    scan.qualitativeCoverage = "partial";
    const { invocationFile: _omitted, invocationWindowProof: _proof, ...rest } = stored;
    return { ...rest };
  }
  return stored;
}

/**
 * In-run mirror of the store's `invocationWindowCanBeNarrowedExactly` for a
 * freshly completed stream whose collector window predates this run's
 * request (the loader cannot import the store module).
 */
function streamedInvocationNarrowsExactly(
  pinnedSinceIso: string | null,
  runSinceIso: string | null,
  value: LocalAgentQualitativeIndexValue
): boolean {
  if (pinnedSinceIso === runSinceIso) return true;
  if (runSinceIso === null) return false;
  if (pinnedSinceIso !== null && Date.parse(pinnedSinceIso) > Date.parse(runSinceIso)) {
    return false;
  }
  const invocation = value.invocationFile;
  if (!invocation) return false;
  const proof = value.invocationWindowProof;
  if (!proof || !proof.allCountedEventsTimestamped) return false;
  const hasCountedEvidence = invocation.assistantTurns > 0 ||
    invocation.contextSignal.compactionEvents > 0 ||
    invocation.invocations.length > 0 ||
    invocation.invokedMcpTools.length > 0 ||
    invocation.invokedSkills.length > 0 ||
    invocation.invokedSubagents.length > 0 ||
    invocation.invokedCommands.length > 0 ||
    invocation.contextSignal.fileReads.length > 0 ||
    invocation.contextSignal.repeatedFileReads.length > 0;
  if (!hasCountedEvidence) return proof.earliestCountedAt === undefined;
  if (proof.earliestCountedAt === undefined) return false;
  return Date.parse(proof.earliestCountedAt) >= Date.parse(runSinceIso);
}

function qualitativeIndexKey(
  agent: LocalAgentFormatId,
  filePath: string,
  metadata: QualitativeFileMetadata,
  sinceMs: number | undefined,
  collectInvocationEvidence: boolean
): LocalAgentQualitativeIndexKey {
  return {
    schemaVersion: 1,
    parserVersion: localAgentQualitativeParserVersion,
    agent,
    pathHash: createHash("sha256").update(resolve(filePath)).digest("hex"),
    fileIdentity: qualitativeFileIdentity(metadata),
    sinceIso: typeof sinceMs === "number" ? new Date(sinceMs).toISOString() : null,
    collectInvocationEvidence
  };
}

function qualitativeFileIdentity(metadata: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
    metadata.birthtimeMs
  ].join(":");
}

async function qualitativeIndexKeyStillCurrent(
  filePath: string,
  key: LocalAgentQualitativeIndexKey
): Promise<boolean> {
  try {
    const current = await lstat(filePath);
    return current.isFile() && !current.isSymbolicLink() &&
      qualitativeFileIdentity(current) === key.fileIdentity;
  } catch {
    return false;
  }
}

function isQualitativeIndexValue(
  value: unknown,
  descriptor: LocalAgentFormatDescriptor,
  collectInvocationEvidence: boolean
): value is LocalAgentQualitativeIndexValue {
  if (!isRecord(value) || !Array.isArray(value.calls) ||
      !Array.isArray(value.diagnostics)) {
    return false;
  }
  const calls = value.calls;
  if (!calls.every((call) => isIndexedLocalAgentCall(call, descriptor.id))) {
    return false;
  }
  const diagnostics = value.diagnostics;
  if (!diagnostics.every((entry) => (
    isRecord(entry) &&
    (entry.code === "malformed_jsonl" ||
      entry.code === "malformed_session_file" ||
      entry.code === "unsupported_token_shape") &&
    Number.isSafeInteger(entry.count) && Number(entry.count) > 0
  ))) {
    return false;
  }
  const invocationFile = value.invocationFile as ParsedInvocationFile | undefined;
  try {
    assertInvocationOwnership(descriptor, invocationFile, collectInvocationEvidence);
  } catch {
    return false;
  }
  return true;
}

function isIndexedLocalAgentCall(value: unknown, agent: LocalAgentFormatId): boolean {
  if (!isRecord(value) || value.agent !== agent ||
      typeof value.model !== "string" || value.model.length === 0 ||
      typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    return false;
  }
  const usage = value.usage;
  if (!isRecord(usage)) return false;
  const tokenFields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWrite5mTokens",
    "cacheWrite1hTokens",
    "thoughtTokens",
    "toolTokens"
  ] as const;
  return tokenFields.every((field) => {
    const tokenValue = usage[field];
    if (field === "inputTokens" || field === "outputTokens") {
      return Number.isSafeInteger(tokenValue) && Number(tokenValue) >= 0;
    }
    return tokenValue === undefined ||
      Number.isSafeInteger(tokenValue) && Number(tokenValue) >= 0;
  });
}

async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number,
  expectedIdentity: string
): Promise<{ content: string; bytesRead: number }> {
  // Open the selected inode itself without following a last-moment link. The
  // metadata snapshot used for selection is then checked on the descriptor,
  // not on the path, both before and after reading. This prevents a path swap
  // from turning an out-of-root or actively rewritten file into "complete"
  // qualitative evidence.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile() || qualitativeFileIdentity(before) !== expectedIdentity) {
      throw newErrorWithCode("ESTALE");
    }
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (true) {
      const remainingWithSentinel = maxBytes - bytesRead + 1;
      const length = Math.min(chunk.length, remainingWithSentinel);
      const read = await handle.read(chunk, 0, length, null);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
      if (bytesRead > maxBytes) {
        throw new QualitativeReadLimitError();
      }
      chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)));
    }
    const after = await handle.stat();
    if (!after.isFile() || qualitativeFileIdentity(after) !== expectedIdentity) {
      throw newErrorWithCode("ESTALE");
    }
  } finally {
    await handle.close();
  }
  return {
    content: Buffer.concat(chunks, bytesRead).toString("utf8"),
    bytesRead
  };
}

function recordQualitativeBudgetSkip(scan: LocalAgentSourceScan): void {
  scan.qualitativeCoverage = "partial";
  scan.qualitativeFilesSkippedForBudget =
    (scan.qualitativeFilesSkippedForBudget ?? 0) + 1;
}

function finishQualitativeCoverage(
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[]
): void {
  if (scan.directoryStatus === "unreadable" || scan.unreadableFiles > 0) {
    scan.qualitativeCoverage = "partial";
  }
  // Per-project ledger (BLOCKER-1 semantics, fail closed). An unparsed
  // eligible file blocks unless the bounded header pass proved it belongs to
  // a project other than the requested one; a file proven to belong to the
  // requested project itself keeps blocking until indexed (design section d:
  // it is the oversized relevant transcript, never an exclusion).
  const eligible = scan.qualitativeFilesEligible ?? 0;
  const indexed = Math.min(eligible, scan.qualitativeFilesReadCompletely ?? 0);
  scan.qualitativeFilesIndexed = indexed;
  const foreignProven = scan.qualitativeFilesForeignProven ?? 0;
  scan.qualitativeFilesOwnershipUnknown = Math.max(0, eligible - indexed - foreignProven);
  // A missing directory is an absent agent, not a failure; only unreadable
  // state, unreadable files, or index errors force the fail-closed state.
  const scanFailure = scan.directoryStatus === "unreadable" || scan.unreadableFiles > 0 ||
    (scan.qualitativeIndexErrors ?? 0) > 0;
  scan.qualitativeProjectCoverage =
    !scanFailure && scan.qualitativeFilesOwnershipUnknown === 0
      ? "complete"
      : "indexing";
  const indexErrors = scan.qualitativeIndexErrors ?? 0;
  if (indexErrors > 0) {
    diagnostics.push({
      agent: scan.agent,
      code: "qualitative_index_error",
      severity: "warning",
      message: `${agentLabel(scan.agent)} private index had ${indexErrors} read/write failure(s); project coverage is rebuilding. If this persists after several runs, a newer aibill version may own the index.`,
      count: indexErrors
    });
  }
  const skipped = scan.qualitativeFilesSkippedForBudget ?? 0;
  if (skipped > 0) {
    diagnostics.push({
      agent: scan.agent,
      code: "qualitative_scan_incomplete",
      severity: "warning",
      message: `${agentLabel(scan.agent)} qualitative coverage is partial: ${skipped} eligible transcript file(s) exceeded the configured scan limits. No omitted file contributed an action finding.`,
      count: skipped
    });
  }
}

function financialSourceScan(descriptor: LocalAgentFormatDescriptor): LocalAgentSourceScan {
  const scan: LocalAgentSourceScan = {
    ...emptySourceScan(descriptor.id),
    filesSkippedBeforeWindow: 0
  };
  if (descriptor.financialRead === "bounded_event_jsonl") {
    scan.filesReadFinancially = 0;
    scan.bytesSkippedAsNonFinancialHistory = 0;
    scan.nonFinancialLinesPrefiltered = 0;
    scan.nonFinancialBytesPrefiltered = 0;
  }
  // Keep this after format-specific metrics: persisted/debug JSON has used
  // this exact insertion order since the optimized financial reader shipped.
  scan.jsonlValidationCoverage = "complete";
  return scan;
}

async function streamJsonlRecords(
  file: string,
  onRecord: (entry: Record<string, unknown>) => void
): Promise<StreamedJsonlResult> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let hadContent = false;
  let malformedLines = 0;
  try {
    for await (const line of lines) {
      hadContent = true;
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      // Parsed event type is checked before any deeper traversal. This keeps
      // qualitative payloads out of the fast path while still validating
      // every JSONL line and reporting malformed coverage honestly.
      if (isRecord(entry)) onRecord(entry);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { hadContent, malformedLines };
}

const FINANCIAL_REVERSE_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Codex token counters are cumulative. Reading the root metadata plus the
 * newest complete financial tail is therefore equivalent to replaying copied
 * prompt/tool history, while avoiding multi-gigabyte inherited histories in
 * compaction and subagent rollouts.
 *
 * The reverse scan has proof-based stopping conditions. A normal rollout must
 * expose the newest total, last-turn usage, model, and rate-limit snapshot.
 * Subagent rollouts always continue to byte zero because the full parser's
 * first qualifying task boundary cannot be proved from timestamps alone. If
 * any normal-session proof is missing, it also continues to byte zero; no
 * byte/line cap silently truncates evidence.
 */
async function readCodexFinancialFile(file: string): Promise<CodexFinancialFileResult> {
  const handle = await open(file, "r");
  try {
    const fileStat = await handle.stat();
    if (fileStat.size === 0) {
      return {
        hadContent: false,
        malformedLines: 0,
        entries: [],
        bytesSkipped: 0,
        prefilteredLines: 0,
        prefilteredBytes: 0
      };
    }
    const rootEntry = await readFirstJsonlRecord(handle, fileStat.size);
    const rootPayload = rootEntry?.type === "session_meta" && isRecord(rootEntry.payload)
      ? rootEntry.payload
      : undefined;
    // A rollout that replays another session's history must be read WHOLE:
    // its inherited-baseline boundary sits mid-file, and a proof-complete tail
    // would never reach it. User forks need this exactly as subagents do.
    const hasInheritedHistory = rootPayload !== undefined &&
      codexHasInheritedHistory(rootPayload);
    const entriesReverse: Record<string, unknown>[] = [];
    let malformedLines = 0;
    let prefilteredLines = 0;
    let prefilteredBytes = 0;
    let position = fileStat.size;
    // Chunks for one cross-boundary line are retained newest-first. Appending
    // is O(1); they are ordered only once when the line's start is found.
    let suffixPartsReverse: Buffer[] = [];
    let stoppedEarly = false;
    let bytesSkipped = 0;
    const proof = createCodexReverseProof(hasInheritedHistory, !rootPayload);

    while (position > 0 && !stoppedEarly) {
      const chunkStart = Math.max(0, position - FINANCIAL_REVERSE_CHUNK_BYTES);
      const length = position - chunkStart;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, chunkStart);
      if (bytesRead !== length) {
        throw newErrorWithCode("EIO");
      }
      const current = chunk.subarray(0, bytesRead);
      let lineEnd = current.length;
      let newline = current.lastIndexOf(0x0a, lineEnd - 1);
      while (newline >= 0) {
        const leadingPart = current.subarray(newline + 1, lineEnd);
        const parts = suffixPartsReverse.length > 0
          ? [leadingPart, ...suffixPartsReverse.slice().reverse()]
          : [leadingPart];
        const observed = parseCodexFinancialLine(parts);
        if (observed.malformed) malformedLines += 1;
        if (observed.prefilteredBytes > 0) {
          prefilteredLines += 1;
          prefilteredBytes += observed.prefilteredBytes;
        }
        if (observed.entry) {
          entriesReverse.push(observed.entry);
          if (observeCodexReverseProof(proof, observed.entry)) {
            stoppedEarly = true;
            bytesSkipped = chunkStart + newline;
            break;
          }
        }
        suffixPartsReverse = [];
        lineEnd = newline;
        newline = current.lastIndexOf(0x0a, lineEnd - 1);
      }
      if (!stoppedEarly) {
        const prefix = current.subarray(0, lineEnd);
        if (prefix.length > 0) suffixPartsReverse.push(prefix);
        position = chunkStart;
      }
    }

    if (!stoppedEarly && suffixPartsReverse.length > 0) {
      const observed = parseCodexFinancialLine(suffixPartsReverse.slice().reverse());
      if (observed.malformed) malformedLines += 1;
      if (observed.prefilteredBytes > 0) {
        prefilteredLines += 1;
        prefilteredBytes += observed.prefilteredBytes;
      }
      if (observed.entry) entriesReverse.push(observed.entry);
    }

    const entries = entriesReverse.reverse();
    // A proof-complete tail does not contain byte-zero root metadata. Inject
    // the separately parsed first record so session identity/start/cwd remain
    // identical to the full parser. A full scan already contains that record.
    if (stoppedEarly && rootEntry) entries.unshift(rootEntry);
    return {
      hadContent: true,
      malformedLines,
      entries,
      bytesSkipped: Math.max(0, bytesSkipped),
      prefilteredLines,
      prefilteredBytes
    };
  } finally {
    await handle.close();
  }
}

async function readFirstJsonlRecord(
  handle: FileHandle,
  fileSize: number
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < fileSize) {
    const length = Math.min(FINANCIAL_REVERSE_CHUNK_BYTES, fileSize - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead <= 0) break;
    const value = chunk.subarray(0, bytesRead);
    const newline = value.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(value.subarray(0, newline));
      break;
    }
    chunks.push(value);
    position += bytesRead;
  }
  if (chunks.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type ParsedCodexFinancialLine = {
  entry?: Record<string, unknown>;
  malformed: boolean;
  prefilteredBytes: number;
};

const CODEX_ENVELOPE_PREFIX_BYTES = 16 * 1024;

function parseCodexFinancialLine(parts: readonly Buffer[]): ParsedCodexFinancialLine {
  const byteLength = parts.reduce((total, part) => total + part.length, 0);
  if (byteLength === 0) return { malformed: false, prefilteredBytes: 0 };
  const prefix = bufferPartsPrefix(parts, CODEX_ENVELOPE_PREFIX_BYTES).toString("utf8");
  const classification = classifyCodexFinancialEnvelope(prefix);
  if (classification === "nonfinancial") {
    return { malformed: false, prefilteredBytes: byteLength };
  }
  const text = Buffer.concat(parts, byteLength).toString("utf8").trim();
  if (!text) return { malformed: false, prefilteredBytes: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { malformed: true, prefilteredBytes: 0 };
  }
  if (!isRecord(parsed)) return { malformed: false, prefilteredBytes: 0 };
  const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
  const financial = parsed.type === "session_meta" ||
    parsed.type === "turn_context" ||
    parsed.type === "event_msg" && (
      payload?.type === "token_count" || payload?.type === "task_started"
    );
  return financial
    ? { entry: parsed, malformed: false, prefilteredBytes: 0 }
    : { malformed: false, prefilteredBytes: byteLength };
}

function bufferPartsPrefix(parts: readonly Buffer[], limit: number): Buffer {
  const selected: Buffer[] = [];
  let remaining = limit;
  for (const part of parts) {
    if (remaining <= 0) break;
    const value = part.subarray(0, Math.min(part.length, remaining));
    if (value.length > 0) selected.push(value);
    remaining -= value.length;
  }
  return selected.length === 1
    ? selected[0]!
    : Buffer.concat(selected, limit - remaining);
}

function classifyCodexFinancialEnvelope(
  prefix: string
): "financial" | "nonfinancial" | "unknown" {
  // JSON property order is not semantic. Scan string/object depth so a nested
  // payload type can never be mistaken for the top-level event type. If the
  // bounded prefix does not prove the envelope, return unknown and let the
  // complete line go through JSON.parse rather than silently prefiltering it.
  const { topLevelType, payloadType } = scanCodexEnvelopeTypes(prefix);
  if (!topLevelType) return "unknown";
  if (topLevelType === "session_meta" || topLevelType === "turn_context") {
    return "financial";
  }
  if (topLevelType !== "event_msg") return "nonfinancial";
  if (!payloadType) return "unknown";
  return payloadType === "token_count" || payloadType === "task_started"
    ? "financial"
    : "nonfinancial";
}

function scanCodexEnvelopeTypes(prefix: string): {
  topLevelType?: string;
  payloadType?: string;
} {
  let objectDepth = 0;
  let payloadDepth: number | undefined;
  let topLevelType: string | undefined;
  let payloadType: string | undefined;
  for (let index = 0; index < prefix.length; index += 1) {
    const character = prefix[index];
    if (character === "{") {
      objectDepth += 1;
      continue;
    }
    if (character === "}") {
      if (payloadDepth === objectDepth) payloadDepth = undefined;
      objectDepth = Math.max(0, objectDepth - 1);
      continue;
    }
    if (character !== '"') continue;
    const token = readJsonStringToken(prefix, index);
    if (!token) break;
    index = token.end;
    let cursor = skipJsonWhitespace(prefix, token.end + 1);
    if (prefix[cursor] !== ":") continue;
    cursor = skipJsonWhitespace(prefix, cursor + 1);
    if (token.value === "payload" && objectDepth === 1 && prefix[cursor] === "{") {
      payloadDepth = objectDepth + 1;
      continue;
    }
    if (token.value !== "type" || prefix[cursor] !== '"') continue;
    const value = readJsonStringToken(prefix, cursor);
    if (!value) break;
    if (objectDepth === 1) topLevelType = value.value;
    if (payloadDepth === objectDepth) payloadType = value.value;
    index = value.end;
  }
  return { topLevelType, payloadType };
}

function readJsonStringToken(
  input: string,
  start: number
): { value: string; end: number } | undefined {
  if (input[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const value: unknown = JSON.parse(input.slice(start, index + 1));
      return typeof value === "string" ? { value, end: index } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function skipJsonWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  return index;
}

type CodexReverseProof = {
  /** Replays another session's history (subagent or user fork): never
   * tail-scan, because the inherited-baseline boundary is mid-file. */
  hasInheritedHistory: boolean;
  forceFullScan: boolean;
  totalSeen: boolean;
  turnSeen: boolean;
  rateLimitsSeen: boolean;
  modelSeen: boolean;
};

function createCodexReverseProof(
  hasInheritedHistory: boolean,
  forceFullScan: boolean
): CodexReverseProof {
  return {
    hasInheritedHistory,
    forceFullScan,
    totalSeen: false,
    turnSeen: false,
    rateLimitsSeen: false,
    modelSeen: false
  };
}

function observeCodexReverseProof(
  proof: CodexReverseProof,
  entry: Record<string, unknown>
): boolean {
  if (proof.forceFullScan || proof.hasInheritedHistory) return false;
  const payload = isRecord(entry.payload) ? entry.payload : undefined;
  const info = payload?.type === "token_count" && isRecord(payload.info)
    ? payload.info
    : undefined;
  const hasTotal = Boolean(info && isRecord(info.total_token_usage));
  if (hasTotal) proof.totalSeen = true;
  if (info && isRecord(info.last_token_usage)) proof.turnSeen = true;
  if (parseCodexRateLimits(payload?.rate_limits, stringOf(entry.timestamp))) {
    proof.rateLimitsSeen = true;
  }
  if (entry.type === "turn_context" && stringOf(payload?.model)) {
    proof.modelSeen = true;
  }
  return !proof.hasInheritedHistory &&
    proof.totalSeen &&
    proof.turnSeen &&
    proof.rateLimitsSeen &&
    proof.modelSeen;
}

async function shouldStreamFile(
  file: string,
  sinceMs: number | undefined,
  agent: LocalAgentCall["agent"],
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[]
): Promise<boolean> {
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch (error) {
    recordUnreadableFile(agent, scan, diagnostics, error);
    return false;
  }
  // Refuse a path swapped to a symlink/non-file after directory discovery.
  if (!fileStat.isFile()) {
    recordUnreadableFile(agent, scan, diagnostics, newErrorWithCode("EINVAL"));
    return false;
  }
  if (typeof sinceMs !== "number") return true;
  // ctime catches a file whose mtime was restored after recent replacement;
  // birthtime catches a newly copied file with a preserved old mtime. Skip
  // only when all available metadata proves the file predates the window.
  const newestFileEvidence = Math.max(
    fileStat.mtimeMs,
    fileStat.ctimeMs,
    fileStat.birthtimeMs
  );
  if (!Number.isFinite(newestFileEvidence) || newestFileEvidence >= sinceMs) {
    return true;
  }
  scan.filesSkippedBeforeWindow = (scan.filesSkippedBeforeWindow ?? 0) + 1;
  return false;
}

function newErrorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

type ClaudeNativeResponseIdentity = {
  /** In-process only; raw provider ids never enter a returned call or cache. */
  localDedupeKey: string;
  /** Stable privacy-safe identity used for cross-file checkpoint deduplication. */
  callId: string;
};

function claudeNativeResponseIdentity(
  message: Record<string, unknown>,
  entry: Record<string, unknown>
): ClaudeNativeResponseIdentity | undefined {
  const rawMessageId = stringOf(message.id);
  const rawRequestId = stringOf(entry.requestId);
  // Never weaken a two-part native identity by silently dropping one
  // attacker-sized component; without the exact bounded pair there is no
  // cross-file deduplication proof.
  if ((rawMessageId && rawMessageId.length > 4_096) ||
      (rawRequestId && rawRequestId.length > 4_096)) {
    return undefined;
  }
  const messageId = rawMessageId || undefined;
  const requestId = rawRequestId || undefined;
  if (!messageId && !requestId) return undefined;
  const localDedupeKey = JSON.stringify([messageId ?? null, requestId ?? null]);
  return {
    localDedupeKey,
    callId: `callref_${createHash("sha256")
      .update("claude-native-response-v1")
      .update("\u0000")
      .update(localDedupeKey)
      .digest("hex")}`
  };
}

function parseClaudeFinancialEntry(
  entry: Record<string, unknown>,
  filePath: string,
  sinceMs: number | undefined,
  seen: Set<string>,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall | undefined {
  if (entry.type !== "assistant") return undefined;
  const message = isRecord(entry.message) ? entry.message : undefined;
  const usage = message && isRecord(message.usage) ? message.usage : undefined;
  if (!message || !usage || stringOf(message.model) === "<synthetic>") return undefined;
  const nativeResponse = claudeNativeResponseIdentity(message, entry);
  if (nativeResponse && seen.has(nativeResponse.localDedupeKey)) return undefined;
  if (nativeResponse) seen.add(nativeResponse.localDedupeKey);
  const timestamp = toIso(stringOf(entry.timestamp)) ?? new Date(0).toISOString();
  if (typeof sinceMs === "number" && Date.parse(timestamp) < sinceMs) return undefined;
  const parsedUsage = parseClaudeFinancialUsage(usage, onDiagnostic);
  const workingDirectory = absoluteWorkingDirectory(stringOf(entry.cwd));
  return {
    agent: "claude-code",
    ...(nativeResponse ? { callId: nativeResponse.callId } : {}),
    model: stringOf(message.model) ?? "claude-code",
    timestamp,
    project: projectFromCwd(workingDirectory) ?? projectFromTranscriptPath(filePath),
    workingDirectory,
    sessionId: stringOf(entry.sessionId),
    ...(stringOf(entry.version) ? { sourceVersion: stringOf(entry.version) } : {}),
    ...(parsedUsage.latestTurnUsage
      ? { latestTurnUsage: parsedUsage.latestTurnUsage }
      : {}),
    usageScope: "turn",
    ...(parsedUsage.usageSupport ? { usageSupport: parsedUsage.usageSupport } : {}),
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    ...(parsedUsage.tokenComponentEvidence
      ? { tokenComponentEvidence: parsedUsage.tokenComponentEvidence }
      : {}),
    usage: parsedUsage.usage
  };
}

function createCodexFinancialStreamState(): CodexFinancialStreamState {
  return {
    rootSessionMetaSeen: false,
    rootTaskStarted: false,
    isSubagent: false,
    hasInheritedHistory: false
  };
}

function consumeCodexFinancialEntry(
  state: CodexFinancialStreamState,
  entry: Record<string, unknown>
): void {
  const payload = isRecord(entry.payload) ? entry.payload : undefined;
  if (entry.type === "session_meta" && payload && !state.rootSessionMetaSeen) {
    state.rootSessionMetaSeen = true;
    state.sessionId = stringOf(payload.id);
    state.sourceVersion = stringOf(payload.cli_version);
    state.rootCwd = stringOf(payload.cwd);
    state.startedAt = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp));
    state.rootStartedAtMs = timestampMilliseconds(payload.timestamp ?? entry.timestamp);
    state.isSubagent = stringOf(payload.thread_source) === "subagent" ||
      isRecord(payload.source) && "subagent" in payload.source;
    state.hasInheritedHistory = codexHasInheritedHistory(payload);
  }
  if (entry.type === "turn_context" && payload) {
    state.model = stringOf(payload.model) ?? state.model;
    state.rootCwd ??= stringOf(payload.cwd);
  }
  if (
    state.hasInheritedHistory &&
    !state.rootTaskStarted &&
    payload?.type === "task_started" &&
    isRootSpecificTaskStart(payload.started_at, state.rootStartedAtMs)
  ) {
    state.inheritedUsageBaseline = state.lastTotal;
    state.lastTotal = undefined;
    state.rootTaskStarted = true;
    state.model = undefined;
    state.lastTurn = undefined;
    state.maxTurnPromptTokens = undefined;
    state.lastRateLimits = undefined;
    state.lastActivityAt = toIso(stringOf(entry.timestamp)) ?? state.startedAt;
  }
  if (entry.type !== "event_msg" || payload?.type !== "token_count") return;
  const eventTimestamp = toIso(stringOf(entry.timestamp)) ??
    state.lastActivityAt ??
    state.startedAt;
  const info = isRecord(payload.info) ? payload.info : undefined;
  const total = info && isRecord(info.total_token_usage)
    ? info.total_token_usage
    : undefined;
  const turn = info && isRecord(info.last_token_usage)
    ? info.last_token_usage
    : undefined;
  if (total) {
    state.lastTotal = total;
    state.lastActivityAt = eventTimestamp;
  }
  if (turn) {
    state.lastTurn = turn;
    state.lastActivityAt = eventTimestamp;
    const turnPrompt = codexTurnPromptTokens(turn);
    if (turnPrompt !== undefined) {
      state.maxTurnPromptTokens = Math.max(state.maxTurnPromptTokens ?? 0, turnPrompt);
    }
  }
  const rateLimits = parseCodexRateLimits(payload.rate_limits, eventTimestamp);
  if (rateLimits) state.lastRateLimits = rateLimits;
}

function finishCodexFinancialStream(
  state: CodexFinancialStreamState,
  onDiagnostic?: TranscriptParseDiagnosticHandler
): LocalAgentCall | undefined {
  if (!state.lastTotal || state.hasInheritedHistory && !state.rootTaskStarted) return undefined;
  const parsedUsage = parseCodexCumulativeUsage(
    state.lastTotal,
    state.inheritedUsageBaseline
  );
  const parsedTurn = state.lastTurn
    ? parseCodexTurnUsage(state.lastTurn)
    : { supported: true as const };
  const usageSupport = parsedUsage.supported && parsedTurn.supported
    ? "complete" as const
    : "unsupported_token_shape" as const;
  if (usageSupport === "unsupported_token_shape") {
    onDiagnostic?.({ code: "unsupported_token_shape", count: 1 });
  }
  const workingDirectory = absoluteWorkingDirectory(state.rootCwd);
  return {
    agent: "codex",
    model: state.model ?? "codex",
    timestamp: state.lastActivityAt ?? state.startedAt ?? new Date(0).toISOString(),
    startedAt: state.startedAt,
    project: projectFromCwd(workingDirectory),
    workingDirectory,
    sessionId: state.sessionId,
    ...(state.sourceVersion ? { sourceVersion: state.sourceVersion } : {}),
    rateLimits: state.lastRateLimits,
    ...(usageSupport === "complete" && parsedTurn.usage
      ? { latestTurnUsage: parsedTurn.usage }
      : {}),
    usageScope: "session_cumulative",
    usageSupport,
    ...(usageSupport === "complete" && state.maxTurnPromptTokens !== undefined
      ? { maxRequestPromptTokens: state.maxTurnPromptTokens }
      : {}),
    ...(parsedUsage.reportedTotalTokens !== undefined
      ? { reportedTotalTokens: parsedUsage.reportedTotalTokens }
      : {}),
    ...(usageSupport === "complete" && parsedUsage.tokenComponentEvidence
      ? { tokenComponentEvidence: parsedUsage.tokenComponentEvidence }
      : {}),
    usage: parsedUsage.usage
  };
}

/** Aggregate per-call usage into one UsageRecord per day+agent+model+project. */
export function aggregateCalls(calls: LocalAgentCall[]): UsageRecord[] {
  return aggregateCallsForFormats(calls, localAgentFormatDescriptors);
}

/** @internal Registry-aware aggregation used by the extensible ingestion engine. */
export function aggregateCallsForFormats(
  calls: LocalAgentCall[],
  descriptors: readonly LocalAgentFormatDescriptor[]
): UsageRecord[] {
  const formats = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const groups = new Map<string, LocalAgentCall[]>();
  for (const call of dedupeCumulativeSessionCalls(calls)) {
    const day = call.timestamp.slice(0, 10);
    const key = [day, call.agent, call.model, call.project ?? "unattributed"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }

  const records: UsageRecord[] = [];
  for (const [key, groupCalls] of groups) {
    const [day, agent, model, project] = key.split("|") as [string, LocalAgentFormatId, string, string];
    const format = formats.get(agent);
    const usage: TokenUsage = {
      inputTokens: sum(groupCalls, (c) => c.usage.inputTokens),
      outputTokens: sum(groupCalls, (c) => c.usage.outputTokens),
      cacheReadTokens: sum(groupCalls, (c) => c.usage.cacheReadTokens ?? 0),
      cacheWrite5mTokens: sum(groupCalls, (c) => c.usage.cacheWrite5mTokens ?? 0),
      cacheWrite1hTokens: sum(groupCalls, (c) => c.usage.cacheWrite1hTokens ?? 0),
      thoughtTokens: sum(groupCalls, (c) => c.usage.thoughtTokens ?? 0),
      toolTokens: sum(groupCalls, (c) => c.usage.toolTokens ?? 0)
    };
    const usageSupported = groupCalls.every((call) => call.usageSupport !== "unsupported_token_shape");
    const sourceVersions = [...new Set(
      groupCalls.flatMap((call) => call.sourceVersion ? [call.sourceVersion] : [])
    )].sort().slice(0, 8);
    const tieredPricingEvidenceSupported = !usesPromptTieredPricing(model) ||
      groupCalls.every((call) =>
        canPriceTokenUsageAtScope(
          model,
          call.usage,
          call.usageScope === "turn" ? "request" : "aggregate",
          call.maxRequestPromptTokens
        ) && (agent !== "gemini-cli" || hasCompleteGeminiPromptEvidence(call))
      );
    const amountUsd = usageSupported && tieredPricingEvidenceSupported && format
      ? usesPromptTieredPricing(model)
        ? estimateTokenCostsUsd(
            model,
            groupCalls.map((call) => call.usage),
            // Fix each cumulative slice's tier from its largest single request
            // rather than its cache-inflated sum. Turn-scoped slices carry no
            // such evidence and keep selecting their tier from their own prompt.
            groupCalls.map((call) => call.maxRequestPromptTokens)
          )
        : estimateTokenCostUsd(model, usage)
      : undefined;
    const priced = usageSupported && typeof amountUsd === "number";
    records.push({
      id: slug(["local", agent, day, model, project].join("-")),
      timestamp: new Date(`${day}T00:00:00Z`).toISOString(),
      source: {
        id: format?.sourceRecord.id ?? "local-agent-logs",
        name: format?.sourceRecord.name ?? "Local agent session logs",
        provider: format?.provider ?? "unknown",
        confidence: format?.confidenceDefaults.sourceConfidence ?? "estimated",
        observedFrom: format?.sourceRecord.observedFrom ?? "unregistered local transcript (this machine)"
      },
      model,
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) +
        (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0) +
        (usage.toolTokens ?? 0),
      outputTokens: usage.outputTokens + (usage.thoughtTokens ?? 0),
      ...(agent === "gemini-cli"
        ? {
            ...(groupCalls.every((call) => call.usage.cacheReadTokens !== undefined)
              ? { cacheReadTokens: usage.cacheReadTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.usage.thoughtTokens !== undefined)
              ? { thoughtTokens: usage.thoughtTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.usage.toolTokens !== undefined)
              ? { toolTokens: usage.toolTokens ?? 0 }
              : {}),
            ...(groupCalls.every((call) => call.reportedTotalTokens !== undefined)
              ? { reportedTotalTokens: sum(groupCalls, (call) => call.reportedTotalTokens ?? 0) }
              : {}),
            ...(sourceVersions.length > 0 ? { sourceVersions } : {})
          }
        : {}),
      amountUsd: priced ? amountUsd : null,
      costConfidence: priced
        ? format?.confidenceDefaults.pricedFinancialEvidence ?? "estimated"
        : format?.confidenceDefaults.unpricedFinancialEvidence ?? "missing",
      // `(home)` is an attribution fallback, not a real project. Keep it on
      // LocalAgentCall for Glance/session context, but do not promote it to a
      // high-confidence project id in receipts or the attribution engine.
      projectId: project === "unattributed" || project === "(home)" ? undefined : project,
      agentId: agent,
      providerCostType: format?.sourceRecord.providerCostType ?? "local_agent_logs",
      usageGranularity: format?.sourceRecord.usageGranularity ?? "daily_aggregate",
      quantity: groupCalls.length,
      operation: format?.sourceRecord.operation ?? `${agent} sessions`
    });
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function hasCompleteGeminiPromptEvidence(call: LocalAgentCall): boolean {
  const evidence = call.geminiTokenEvidence;
  if (call.usageSupport !== "complete" || !evidence ||
      evidence.cacheAccounting === "unknown") {
    return false;
  }
  const components = [
    evidence.input,
    evidence.output,
    evidence.cached,
    evidence.thoughts,
    evidence.tool,
    evidence.total
  ];
  if (!components.every((value) => Number.isSafeInteger(value) && (value ?? -1) >= 0)) {
    return false;
  }
  const input = evidence.input!;
  const output = evidence.output!;
  const cached = evidence.cached!;
  const thoughts = evidence.thoughts!;
  const tool = evidence.tool!;
  const freshInput = evidence.cacheAccounting === "included"
    ? input - cached
    : input;
  const expectedTotal = input + output + thoughts + tool;
  const threshold = promptTierThreshold(call.model);
  // Gemini exposes promptTokenCount and toolUsePromptTokenCount separately,
  // while the published >200k rule does not resolve which side owns tool
  // prompt tokens. Only price when both interpretations select the same tier.
  const promptTierIsUnambiguous = threshold === undefined ||
    input > threshold || input + tool <= threshold;
  return freshInput >= 0 && Number.isSafeInteger(expectedTotal) &&
    promptTierIsUnambiguous &&
    evidence.total === expectedTotal &&
    call.usage.inputTokens === freshInput &&
    call.usage.outputTokens === output &&
    call.usage.cacheReadTokens === cached &&
    call.usage.thoughtTokens === thoughts &&
    call.usage.toolTokens === tool;
}

async function listFormatCandidateFiles(
  root: string,
  descriptor: LocalAgentFormatDescriptor,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[]
): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      scan.directoryStatus = "missing";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_missing",
        severity: "info",
        message: `${agentLabel(scan.agent)} transcript directory was not found.`,
        count: 1
      });
    } else {
      scan.directoryStatus = "unreadable";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_unreadable",
        severity: "error",
        message: `${agentLabel(scan.agent)} transcript directory could not be read${errorCodeSuffix(error)}.`,
        count: 1
      });
    }
    return [];
  }
  if (!rootStat.isDirectory()) {
    scan.directoryStatus = "unreadable";
    diagnostics.push({
      agent: scan.agent,
      code: "directory_unreadable",
      severity: "error",
      message: `${agentLabel(scan.agent)} transcript path is not a readable directory.`,
      count: 1
    });
    return [];
  }
  scan.directoryStatus = "readable";
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      scan.directoryStatus = "unreadable";
      diagnostics.push({
        agent: scan.agent,
        code: "directory_unreadable",
        severity: "error",
        message: `${agentLabel(scan.agent)} transcript directory could not be read${errorCodeSuffix(error)}.`,
        count: 1
      });
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && matchesLocalAgentDetectionFile(descriptor, path)) {
        scan.detectionSignals = (scan.detectionSignals ?? 0) + 1;
      } else if (entry.isFile() && matchesLocalAgentFormatFile(descriptor, path)) {
        out.push(path);
        scan.filesDiscovered += 1;
      }
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function emptySourceScan(agent: LocalAgentFormatId): LocalAgentSourceScan {
  return {
    agent,
    directoryStatus: "readable",
    filesDiscovered: 0,
    filesParsed: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    unsupportedUsageSnapshots: 0
  };
}

function recordUnreadableFile(
  agent: LocalAgentFormatId,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  error: unknown
): void {
  scan.unreadableFiles += 1;
  diagnostics.push({
    agent,
    code: "file_unreadable",
    severity: "error",
    message: `${agentLabel(agent)} transcript file could not be read${errorCodeSuffix(error)}.`,
    count: 1
  });
}

function recordParseDiagnostic(
  agent: LocalAgentFormatId,
  scan: LocalAgentSourceScan,
  diagnostics: LocalAgentLogDiagnostic[],
  diagnostic: TranscriptParseDiagnostic
): void {
  if (diagnostic.code === "malformed_jsonl" || diagnostic.code === "malformed_session_file") {
    scan.malformedLines += diagnostic.count;
    diagnostics.push({
      agent,
      code: diagnostic.code,
      severity: "warning",
      message: diagnostic.code === "malformed_jsonl"
        ? `${diagnostic.count} malformed JSONL line(s) were skipped in ${agentLabel(agent)} transcripts.`
        : `${diagnostic.count} malformed session file(s) were skipped in ${agentLabel(agent)} transcripts.`,
      count: diagnostic.count
    });
    return;
  }
  scan.unsupportedUsageSnapshots += diagnostic.count;
  diagnostics.push({
    agent,
    code: diagnostic.code,
    severity: "warning",
    message: `${diagnostic.count} ${agentLabel(agent)} token snapshot(s) lacked the complete, internally consistent fields required for safe normalization and pricing.`,
    count: diagnostic.count
  });
}

function agentLabel(agent: LocalAgentFormatId): string {
  return localAgentFormatLabel(agent);
}

function errorCodeSuffix(error: unknown): string {
  const code = error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function projectFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Sessions launched from the home directory aren't a "project" — labeling
  // them with the username reads like a data bug on the by-project table.
  if (resolve(cwd) === resolve(homedir())) return "(home)";
  const name = basename(cwd);
  return name.length > 0 ? name : undefined;
}

function absoluteWorkingDirectory(cwd: string | undefined): string | undefined {
  return cwd && isAbsolute(cwd) ? resolve(cwd) : undefined;
}

/**
 * Codex can be launched from HOME and do nearly all of its work through tools
 * that declare a more specific working directory. Prefer that observed
 * activity only when the session-level cwd is not already a real project.
 * Nested tool directories roll up to the shallowest observed ancestor with
 * the strongest descendant-weighted activity.
 */
function dominantCodexCwd(
  sessionCwd: string | undefined,
  toolWorkdirs: Map<string, number>
): string | undefined {
  const sessionProject = projectFromCwd(sessionCwd);
  if (sessionProject && sessionProject !== "(home)") return sessionCwd;

  const home = resolve(homedir());
  const candidates = [...toolWorkdirs.entries()]
    .filter(([path]) => resolve(path) !== home);
  const scored = candidates.map(([candidate]) => ({
    candidate,
    score: candidates.reduce((total, [path, count]) => (
      path === candidate || path.startsWith(`${candidate}${sep}`)
        ? total + count
        : total
    ), 0)
  }));
  scored.sort((left, right) => (
    right.score - left.score ||
    left.candidate.split(sep).length - right.candidate.split(sep).length ||
    left.candidate.localeCompare(right.candidate)
  ));
  return scored[0]?.candidate ?? sessionCwd;
}

/** Claude Code encodes the project path into the transcript's parent dir name. */
function projectFromTranscriptPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const parent = basename(join(filePath, ".."));
  const tail = parent.split("-").filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/**
 * Parse the host-framed task-notification a background subagent's completion
 * writes into the owning transcript. Only the leading host template tags are
 * read (first match): the trailing `<result>` section is model output and is
 * never trusted or retained. The same task-id may notify more than once for
 * a resumed run; callers keep the latest record and the session-vitals join
 * still requires the record to postdate the run's last observed activity.
 */
function parseTaskNotification(
  content: string | undefined
): { taskId: string; status: string } | undefined {
  if (!content || !content.startsWith("<task-notification>")) return undefined;
  const taskId = /<task-id>([A-Za-z0-9._-]{1,128})<\/task-id>/.exec(content)?.[1];
  const status = /<status>([a-z_-]{1,64})<\/status>/.exec(content)?.[1];
  return taskId && status ? { taskId, status } : undefined;
}

/**
 * Fallback subagent-run identity from the `subagents/agent-<id>.jsonl` file
 * name, for subagent transcripts whose lines omit `agentId`. Never derived
 * for files outside a `subagents` directory, and never a path (one validated
 * basename segment only).
 */
function subagentTranscriptFileId(filePath: string): string | undefined {
  const segments = filePath.split(sep);
  if (!segments.includes("subagents")) return undefined;
  const base = segments.at(-1) ?? "";
  const name = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : undefined;
}

type ActivityInput = {
  title?: string;
  prompts: string[];
  files: Map<string, number>;
  toolCallCount: number;
  project?: string;
  isSubagent: boolean;
  parentSessionId?: string;
  /**
   * Sanitized prompt survivors that a resumed stream checkpoint dropped
   * beyond its last-12 retention. They contribute to the prompt count but
   * can no longer influence topic/action derivation (documented divergence
   * bound of the streaming path; zero for whole-file parses).
   */
  priorPromptCount?: number;
};

function localActivityScopeKey(
  sessionId: string | undefined,
  workingDirectory: string | undefined,
  project: string | undefined
): string {
  // The absolute cwd stays inside this ephemeral parser key and is never
  // persisted or rendered. It prevents one transcript that changes projects
  // from attaching Project A's prompt/file evidence to Project B's calls.
  return [sessionId ?? "unknown-session", workingDirectory ?? project ?? "unattributed"].join("\u0000");
}

const FOCUS_STOP_WORDS = new Set([
  "about", "above", "after", "again", "also", "and", "are", "at", "been", "being", "but",
  "can", "check", "could", "did", "does", "doing", "dont", "every", "from",
  "for", "have", "here", "how", "in", "into", "its", "just", "like", "make", "more",
  "need", "not", "now", "on", "only", "other", "our", "please", "really", "should",
  "earlier", "is", "mentioned", "one", "something", "sure", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "thing", "think", "this", "through", "to", "too", "use", "user",
  "users", "want", "was", "way", "we", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "work", "working", "would", "you", "your",
  "redacted"
]);

const ACTION_WORDS: Array<{
  action: LocalAgentActivity["action"];
  words: Set<string>;
}> = [
  { action: "refining", words: new Set(["adjust", "change", "customize", "design", "edit", "improve", "refine", "revise", "update"]) },
  { action: "fixing", words: new Set(["bug", "debug", "fix", "repair", "resolve"]) },
  { action: "testing", words: new Set(["test", "testing", "validate", "verification", "verify"]) },
  { action: "auditing", words: new Set(["audit", "review", "status"]) },
  { action: "researching", words: new Set(["compare", "find", "investigate", "research"]) },
  { action: "configuring", words: new Set(["configure", "connect", "setup"]) },
  { action: "publishing", words: new Set(["deploy", "launch", "publish", "release"]) },
  { action: "running", words: new Set(["automation", "monitor", "run", "schedule"]) },
  { action: "building", words: new Set(["add", "build", "create", "develop", "implement", "include"]) }
];

function buildLocalAgentActivity(input: ActivityInput): LocalAgentActivity | undefined {
  // Prompt text is never retained, but derived topic tokens can still disclose
  // a credential if redaction happens only at persistence/output boundaries.
  // Sanitize before every title/topic/action derivation and again at output.
  const prompts = input.prompts
    .map(sanitizeLocalActivityText)
    .filter(isHumanPrompt);
  const topic = focusTopic(prompts);
  const title = cleanTitle(sanitizeLocalActivityText(input.title ?? ""));
  const files = [...input.files.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([file]) => sanitizeLocalActivityText(file))
    .filter(Boolean)
    .slice(0, 5);
  const action = inferAction(prompts, title);
  let source: LocalAgentActivity["source"];
  let kind: LocalAgentActivity["kind"];
  let subject: string;

  if (topic) {
    source = "user_prompts";
    kind = inferActivityKind(topic, input.isSubagent);
    subject = topic;
  } else if (title) {
    source = "agent_title";
    kind = inferActivityKind(title, input.isSubagent);
    subject = stripLeadingAction(title);
  } else if (files[0]) {
    source = "file_activity";
    kind = "file";
    subject = files[0];
  } else if (input.project) {
    source = "project";
    kind = "project";
    subject = sanitizeLocalActivityText(input.project);
  } else {
    return undefined;
  }

  if (!subject) return undefined;

  return {
    summary: sanitizeLocalActivityText(activitySummary(action, subject, source)),
    kind,
    action,
    source,
    promptCount: prompts.length + (input.priorPromptCount ?? 0),
    toolCallCount: input.toolCallCount,
    files,
    isSubagent: input.isSubagent,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {})
  };
}

function focusTopic(prompts: string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  const recent = prompts.slice(-12);
  const promptTokenSets = recent.map((prompt) => (
    new Set(topicTokens(prompt).filter((token) => !FOCUS_STOP_WORDS.has(token)))
  ));
  const observedTopicTokens = new Set(promptTokenSets.flatMap((tokens) => [...tokens]));

  // Recognized product/work concepts are meaningful even in one prompt. Generic
  // tokens must repeat across distinct prompts below; that keeps attachment
  // prose and one-off screenshot filenames from becoming a confident topic.
  if (observedTopicTokens.has("aibill") && observedTopicTokens.has("prompt")) {
    return "aibill prompt";
  }
  if (observedTopicTokens.has("glance") && observedTopicTokens.has("hover")) {
    return observedTopicTokens.has("ui") ? "Glance hover UI" : "Glance hover";
  }
  if (
    observedTopicTokens.has("glance") &&
    ["action", "agent", "handoff", "prompt"].some((token) => observedTopicTokens.has(token))
  ) {
    return "Glance agent handoff";
  }
  if (observedTopicTokens.has("landing") && observedTopicTokens.has("page")) return "landing page";
  if (observedTopicTokens.has("hover")) {
    return observedTopicTokens.has("ui") ? "hover UI" : "hover interaction";
  }
  if (observedTopicTokens.has("mcp")) {
    return observedTopicTokens.has("feature") ? "MCP feature" : "MCP";
  }
  if (observedTopicTokens.has("seo")) {
    return observedTopicTokens.has("strategy") ? "SEO strategy" : "SEO";
  }

  const promptOccurrences = new Map<string, number>();
  for (const tokens of promptTokenSets) {
    for (const token of tokens) {
      promptOccurrences.set(token, (promptOccurrences.get(token) ?? 0) + 1);
    }
  }
  const repeatedTokens = new Set(
    [...promptOccurrences.entries()]
      .filter(([, count]) => count >= 2)
      .map(([token]) => token)
  );
  if (repeatedTokens.size === 0) return undefined;

  const tokenScores = new Map<string, number>();
  const pairScores = new Map<string, number>();
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    const tokens = topicTokens(prompt)
      .filter((token) => !FOCUS_STOP_WORDS.has(token) && repeatedTokens.has(token));
    const unique = [...new Set(tokens)];
    for (const token of unique) {
      tokenScores.set(token, (tokenScores.get(token) ?? 0) + weight);
    }
    for (let pairIndex = 0; pairIndex < tokens.length - 1; pairIndex += 1) {
      const pair = `${tokens[pairIndex]} ${tokens[pairIndex + 1]}`;
      pairScores.set(pair, (pairScores.get(pair) ?? 0) + weight);
    }
  });

  const topPairs = [...pairScores.entries()]
    .filter(([, score]) => score >= 2.5)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const topTokens = [...tokenScores.entries()]
    .filter(([token]) => !isActionToken(token))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const candidateTokens = new Set<string>();
  for (const [pair] of topPairs.slice(0, 2)) {
    pair.split(" ").forEach((token) => candidateTokens.add(token));
  }
  for (const [token] of topTokens) {
    if (candidateTokens.size >= 3) break;
    candidateTokens.add(token);
  }
  if (candidateTokens.size === 0) return undefined;

  const tokens = [...candidateTokens].slice(0, 3);
  if (tokens.includes("hover")) {
    return tokens.includes("ui") ? "hover UI" : "hover interaction";
  }
  return tokens.map(displayToken).join(" ");
}

function inferAction(prompts: string[], title: string | undefined): LocalAgentActivity["action"] {
  const scores = new Map<LocalAgentActivity["action"], number>();
  const recent = prompts.slice(-12);
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    for (const token of promptTokens(prompt)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + weight);
        }
      }
    }
  });
  if (title) {
    for (const token of promptTokens(title)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + 0.75);
        }
      }
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "working";
}

function inferActivityKind(subject: string, isSubagent: boolean): LocalAgentActivity["kind"] {
  const tokens = new Set(promptTokens(subject));
  if (tokens.has("automation") || tokens.has("workflow") || tokens.has("schedule")) return "automation";
  if (tokens.has("agent") || tokens.has("subagent") || isSubagent) return "agent";
  return "task";
}

function activitySummary(
  action: LocalAgentActivity["action"],
  subject: string,
  source: LocalAgentActivity["source"]
): string {
  if (source === "project") return `Working in ${subject}`;
  const actionLabel = action[0]!.toUpperCase() + action.slice(1);
  return `${actionLabel} ${subject}`.replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return clean.length >= 3 && clean.length <= 96 ? clean : undefined;
}

function stripLeadingAction(value: string): string {
  const words = value.split(/\s+/);
  return isActionToken(words[0]?.toLowerCase() ?? "") && words.length > 1
    ? words.slice(1).join(" ")
    : value;
}

function isActionToken(token: string): boolean {
  return ACTION_WORDS.some((group) => group.words.has(token)) ||
    ["building", "refining", "fixing", "testing", "auditing", "researching", "configuring", "publishing", "running"].includes(token);
}

function displayToken(token: string): string {
  const acronym = new Map([
    ["api", "API"],
    ["cli", "CLI"],
    ["mcp", "MCP"],
    ["seo", "SEO"],
    ["ui", "UI"],
    ["ux", "UX"]
  ]).get(token);
  return acronym ?? token;
}

function promptTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? [])
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && token !== "cz" && !/^\d+$/.test(token));
}

/**
 * Strip absolute-path spans (including file:// forms) from free text. Shared
 * by topic derivation and by checkpoint prompt persistence: persisted prompt
 * survivors must never carry a raw local path (req 1).
 */
function stripAbsolutePathSpans(value: string): string {
  return value.replace(/(^|[\s("'=:])(?:file:\/\/)?\/[^\s)"']+/g, "$1");
}

function topicTokens(value: string): string[] {
  // Absolute paths often appear in attached-image metadata and tool-oriented
  // prompts. They are machine context, not the user's work topic, and can
  // otherwise outrank meaningful words when only one recent prompt exists.
  const withoutAbsolutePaths = stripAbsolutePathSpans(value)
    .replace(/\b[^\s/\\]+\.(?:png|jpe?g|gif|webp|heic|svg|pdf|mov|mp4)\b/gi, " ")
    .replace(/\b(?:attached|attachment|clipboard|image|images|photo|picture|screenshot|screenshots)\b/gi, " ");
  return promptTokens(sanitizeLocalActivityText(withoutAbsolutePaths));
}

function toTurnUsage(
  usage: TokenUsage,
  source: LocalAgentTurnUsage["source"]
): LocalAgentTurnUsage {
  const contextTokens = usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0);
  return {
    ...usage,
    contextTokens,
    totalTokens: contextTokens + usage.outputTokens,
    source
  };
}

/**
 * Remove known and assignment-shaped credentials from metadata before it can
 * become a topic, title, Glance field, MCP result, or copy-ready handoff.
 * This intentionally favors dropping a suspicious token over displaying it.
 */
export function sanitizeLocalActivityText(value: string): string {
  return redactSecrets(value)
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, " ")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, " ")
    .replace(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)=\[REDACTED\]/g, " ")
    .replace(/\[REDACTED\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHumanPrompt(value: string): boolean {
  const text = value.trim();
  if (text.length < 3) return false;
  return ![
    /^</,
    /^>>>/,
    /^\s*\[\d+\]\s+(tool|assistant|user)\b/i,
    /^#\s*AGENTS\.md/i,
    /^Assess the exact/i,
    /^Planned action JSON/i,
    /^Reviewed Codex/i,
    /^Some conversation/i,
    /^The Codex agent/i,
    /^The following is the Codex/i,
    /^You are .*primary agent/i,
    /^You have \d+ weighted tokens left/i
  ].some((pattern) => pattern.test(text));
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [stringOf(item.text) ?? stringOf(item.content)].filter((text): text is string => Boolean(text));
  });
}

function recordValues(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function collectToolFiles(value: unknown, counts: Map<string, number>): void {
  if (!isRecord(value)) return;
  for (const key of ["file_path", "path", "notebook_path"]) {
    addFile(stringOf(value[key]), counts);
  }
  collectPatchFiles(stringOf(value.patch) ?? stringOf(value.input), counts);
}

function collectPatchFiles(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    addFile(match[1], counts);
  }
}

function addFile(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  const file = basename(value.trim());
  if (!file || file === "." || file === sep) return;
  counts.set(file, (counts.get(file) ?? 0) + 1);
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

const ROOT_TASK_CLOCK_TOLERANCE_MS = 5_000;

function isRootSpecificTaskStart(value: unknown, rootStartedAtMs: number | undefined): boolean {
  const taskStartedAtMs = timestampMilliseconds(value);
  return typeof rootStartedAtMs === "number" &&
    typeof taskStartedAtMs === "number" &&
    taskStartedAtMs >= rootStartedAtMs - ROOT_TASK_CLOCK_TOLERANCE_MS;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sum(calls: LocalAgentCall[], pick: (call: LocalAgentCall) => number): number {
  return calls.reduce((total, call) => total + pick(call), 0);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenComponentOf(value: unknown): number | undefined {
  const parsed = numberOf(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
