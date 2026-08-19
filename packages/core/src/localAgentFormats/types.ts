import type {
  LocalAgentCall,
  LocalAgentLogDiagnostic,
  LocalAgentSourceScan
} from "../localAgentLogs.js";
import type {
  ParsedInvocationFile,
  ParsedInvocationWindowProof
} from "../toolInvocations.js";

/**
 * Public format identity contract. Add future parser IDs here as part of the
 * registry-owned change so existing exhaustive consumers do not see an
 * unbounded `string` in a patch release.
 */
export type LocalAgentFormatId = "claude-code" | "codex" | "gemini-cli";

export type LocalAgentFormatDescriptor = {
  readonly schemaVersion: 1;
  readonly id: LocalAgentFormatId;
  readonly order: number;
  readonly label: string;
  readonly provider: string;
  readonly defaultHomeRelative: readonly string[];
  readonly legacyDirectoryOption?:
    | "claudeProjectsDir"
    | "codexSessionsDir"
    | "geminiSessionsDir";
  readonly discovery: {
    readonly extension?: string;
    readonly extensions?: readonly string[];
    readonly basename?: string;
    readonly basenamePrefix?: string;
    /** Required directory name somewhere above a financial evidence file. */
    readonly ancestorBasename?: string;
    /** Presence signal only. This file must never reach a financial parser. */
    readonly detectionBasename?: string;
  };
  readonly confidenceDefaults: {
    readonly validationCoverage: "live_verified" | "fixture_verified" | "untested" | "failed";
    readonly pricedFinancialEvidence: "estimated";
    readonly unpricedFinancialEvidence: "missing";
    readonly sourceConfidence: "estimated";
  };
  readonly sourceRecord: {
    readonly id: "local-agent-logs";
    readonly name: "Local agent session logs";
    readonly observedFrom: string;
    readonly providerCostType: "local_agent_logs";
    readonly usageGranularity: "daily_aggregate";
    readonly operation: string;
  };
  readonly capabilities: {
    /** May local rows from this source feed recommendation or Apply logic? */
    readonly actionPlanning: boolean;
    readonly activity: boolean;
    readonly contextHealth: boolean;
    readonly financialFastPath: boolean;
    readonly glance: boolean;
    readonly invocationEvidence: boolean;
    readonly planContext: boolean;
    readonly rateLimits: boolean;
    /** Whether this source is allowed into the fixed Glance/statusline cache. */
    readonly statuslineSnapshot: boolean;
  };
  readonly financialRead: "full_jsonl" | "bounded_event_jsonl" | "full_session_files";
  readonly validationNote: string;
  readonly docs: {
    readonly format: string;
    readonly howRead: readonly string[];
    readonly fieldsRead: readonly string[];
    readonly verified: readonly string[];
    readonly estimated: readonly string[];
    readonly notVerified: readonly string[];
    readonly privacy: readonly string[];
    readonly limitations: readonly string[];
  };
  readonly fixtures: readonly string[];
};

export type LocalAgentFormatParseContext = {
  content: string;
  filePath: string;
  sinceMs?: number;
  collectInvocationEvidence: boolean;
  onDiagnostic: (diagnostic: {
    code: "malformed_jsonl" | "malformed_session_file" | "unsupported_token_shape";
    count: number;
  }) => void;
};

export type LocalAgentFormatParseResult = {
  calls: LocalAgentCall[];
  invocationFile?: ParsedInvocationFile;
  invocationWindowProof?: ParsedInvocationWindowProof;
};

export type LocalAgentFormatFinancialFileContext = {
  filePath: string;
  sinceMs?: number;
  scan: LocalAgentSourceScan;
  diagnostics: LocalAgentLogDiagnostic[];
};

export type LocalAgentFormatRuntime = {
  descriptor: LocalAgentFormatDescriptor;
  parseFull: (context: LocalAgentFormatParseContext) => LocalAgentFormatParseResult;
  parseFinancialFile: (
    context: LocalAgentFormatFinancialFileContext
  ) => Promise<LocalAgentCall[]>;
};
