import { basename, dirname } from "node:path";
import type { LocalAgentFormatDescriptor, LocalAgentFormatId } from "./types.js";

const descriptors = [
  {
    schemaVersion: 1,
    id: "claude-code",
    order: 10,
    label: "Claude Code",
    provider: "anthropic",
    defaultHomeRelative: [".claude", "projects"],
    legacyDirectoryOption: "claudeProjectsDir",
    discovery: { extension: ".jsonl" },
    confidenceDefaults: {
      validationCoverage: "live_verified",
      pricedFinancialEvidence: "estimated",
      unpricedFinancialEvidence: "missing",
      sourceConfidence: "estimated"
    },
    sourceRecord: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      observedFrom: "claude-code transcript JSONL (this machine)",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate",
      operation: "claude-code sessions"
    },
    capabilities: {
      actionPlanning: true,
      activity: true,
      contextHealth: true,
      financialFastPath: true,
      glance: true,
      invocationEvidence: false,
      planContext: true,
      rateLimits: false,
      statuslineSnapshot: true
    },
    financialRead: "full_jsonl",
    validationNote: "Local transcript parsing is exercised against live logs; dollar values remain API-rate estimates.",
    docs: {
      format: "JSON Lines under ~/.claude/projects/**/*.jsonl",
      howRead: [
        "Read one JSON object per line and keep assistant records with message.usage.",
        "Ignore <synthetic> placeholder models and deduplicate streaming/retry rewrites by message and request identity.",
        "Treat each retained assistant usage record as turn-scoped evidence."
      ],
      fieldsRead: [
        "timestamp, model, and token-usage components",
        "session and working-directory metadata for local deduplication and attribution",
        "human-prompt and tool metadata for privacy-reduced local activity summaries"
      ],
      verified: [
        "The reader and its failure paths have been exercised against live local Claude Code logs.",
        "Synthetic recorded fixtures lock the supported JSONL shapes and normalized output."
      ],
      estimated: [
        "Supported token components are priced at published API rates as API-equivalent value."
      ],
      notVerified: [
        "API-equivalent value is not billed spend, subscription cost, savings, or ROI.",
        "Claude Code transcripts do not provide account-plan headroom; missing limits are not inferred."
      ],
      privacy: [
        "Parsing and aggregation run locally; raw prompts and responses are not returned by the parser registry.",
        "aibill never sits in the inference path and never stores, prints, or proxies provider credentials."
      ],
      limitations: [
        "Malformed lines are skipped and reported.",
        "Incomplete token shapes remain unpriced with missing financial evidence instead of becoming $0."
      ]
    },
    fixtures: ["claude-code-v1"]
  },
  {
    schemaVersion: 1,
    id: "codex",
    order: 20,
    label: "Codex",
    provider: "openai",
    defaultHomeRelative: [".codex", "sessions"],
    legacyDirectoryOption: "codexSessionsDir",
    discovery: { extension: ".jsonl", basenamePrefix: "rollout-" },
    confidenceDefaults: {
      validationCoverage: "live_verified",
      pricedFinancialEvidence: "estimated",
      unpricedFinancialEvidence: "missing",
      sourceConfidence: "estimated"
    },
    sourceRecord: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      observedFrom: "codex transcript JSONL (this machine)",
      providerCostType: "local_agent_logs",
      usageGranularity: "daily_aggregate",
      operation: "codex sessions"
    },
    capabilities: {
      actionPlanning: true,
      activity: true,
      contextHealth: true,
      financialFastPath: true,
      glance: true,
      invocationEvidence: true,
      planContext: true,
      rateLimits: true,
      statuslineSnapshot: true
    },
    financialRead: "bounded_event_jsonl",
    validationNote: "Local parsing was replayed against live logs; total-only token shapes and unknown aliases remain missing rather than becoming estimated $0.",
    docs: {
      format: "JSON Lines under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
      howRead: [
        "Read the Codex event stream and retain the root session identity, model, and latest cumulative event_msg/token_count evidence.",
        "Never sum earlier running token counters; forked sessions subtract a supported inherited cumulative baseline.",
        "Use a bounded proof-based financial reader for init/cache while the full reader retains privacy-reduced activity and optional invocation evidence."
      ],
      fieldsRead: [
        "session metadata, timestamps, model, and cumulative/last-turn token usage",
        "transcript-reported rate-limit windows when present",
        "tool-call metadata for local attribution and optional privacy-safe invocation counts"
      ],
      verified: [
        "The full and optimized financial readers have been replayed against live local Codex logs.",
        "Synthetic recorded fixtures lock cumulative, last-turn, and rate-limit normalization."
      ],
      estimated: [
        "Supported token components are priced at published API rates as API-equivalent value."
      ],
      notVerified: [
        "API-equivalent value is not billed spend, subscription cost, savings, or ROI.",
        "A transcript-reported limit is plan-capacity evidence, not a provider invoice."
      ],
      privacy: [
        "Parsing and aggregation run locally; raw prompts and responses are not returned by the parser registry.",
        "aibill never sits in the inference path and never stores, prints, or proxies provider credentials."
      ],
      limitations: [
        "Only rollout-*.jsonl files are parsed as Codex sessions.",
        "Incomplete, regressing, or total-only token shapes remain unpriced with missing financial evidence."
      ]
    },
    fixtures: ["codex-v1"]
  },
  {
    schemaVersion: 1,
    id: "gemini-cli",
    order: 30,
    label: "Gemini CLI",
    provider: "google",
    defaultHomeRelative: [".gemini", "tmp"],
    legacyDirectoryOption: "geminiSessionsDir",
    discovery: {
      extensions: [".json", ".jsonl"],
      ancestorBasename: "chats",
      detectionBasename: "logs.json"
    },
    confidenceDefaults: {
      validationCoverage: "fixture_verified",
      pricedFinancialEvidence: "estimated",
      unpricedFinancialEvidence: "missing",
      sourceConfidence: "estimated"
    },
    sourceRecord: {
      id: "local-agent-logs",
      name: "Local agent session logs",
      providerCostType: "local_agent_logs",
      observedFrom: "gemini-cli chats session JSON/JSONL (this machine)",
      usageGranularity: "daily_aggregate",
      operation: "gemini-cli sessions"
    },
    capabilities: {
      actionPlanning: false,
      activity: false,
      contextHealth: false,
      financialFastPath: true,
      glance: false,
      invocationEvidence: false,
      planContext: false,
      rateLimits: false,
      statuslineSnapshot: false
    },
    financialRead: "full_session_files",
    validationNote: "Gemini CLI session support is experimental and fixture-verified; evolving, incomplete, or modality-ambiguous token shapes remain missing rather than becoming estimated $0.",
    docs: {
      format: "JSON and JSON Lines under ~/.gemini/tmp/<opaque-project-id>/chats/**/*.{json,jsonl}",
      howRead: [
        "Read supported Gemini response records from chats session JSON or JSONL files, including nested subagent sessions.",
        "For repeated JSONL message ids, retain the last token-bearing version so streaming updates are not double-counted.",
        "Use logs.json only to detect that Gemini CLI is present; it never enters the financial parser or creates a financial row."
      ],
      fieldsRead: [
        "timestamp, model, and explicit input, output, cached, thought, tool, and total token components",
        "session identity and usable session-carried project metadata when present",
        "Gemini CLI version metadata when the session format reports it"
      ],
      verified: [
        "Synthetic recorded fixtures lock supported legacy JSON and current JSONL shapes, including cache-overlap and duplicate-message handling."
      ],
      estimated: [
        "Complete, internally consistent Gemini 2.5 Pro token components are priced at published API rates as API-equivalent value only when the request's pricing tier is unambiguous.",
        "Thought tokens are output-priced and tool tokens input-priced only when the explicit split is supported."
      ],
      notVerified: [
        "Gemini CLI chat files are evolving and this reader is experimental, not live-verified.",
        "API-equivalent value is not billed spend, subscription cost, savings, or ROI.",
        "Session token counters do not establish authentication billing mode, free-tier coverage, subscription coverage, grounding/search fees, tool-specific fees, or context-cache storage duration charges.",
        "Unknown models, missing components, and inconsistent totals remain missing financial evidence rather than estimated $0.",
        "Gemini 2.5 Flash and Flash-Lite rows remain missing because chats summaries omit token modality while published audio and non-audio rates differ."
      ],
      privacy: [
        "Parsing and aggregation run locally; raw prompts and responses are not returned by the parser registry.",
        "Opaque project hashes are never reversed, guessed, or exposed; an opaque local alias is used when no usable project field exists.",
        "aibill never sits in the inference path and never stores, prints, or proxies provider credentials."
      ],
      limitations: [
        "The <opaque-project-id> directory is not treated as a readable project path.",
        "logs.json contains prompt-history/resume metadata, not financial token evidence.",
        "Normalized inputTokens/outputTokens are inclusive headline totals; cached/tool/thought fields are component subsets and must not be added again.",
        "A Gemini 2.5 Pro request remains unpriced when separate prompt and tool-token counts straddle the published 200k pricing threshold.",
        "Rewound JSONL turns still represent incurred usage; this reader does not reconstruct a cost-free final conversation."
      ]
    },
    fixtures: ["gemini-cli-v1"]
  }
] as const satisfies readonly LocalAgentFormatDescriptor[];

export const localAgentFormatDescriptors: readonly LocalAgentFormatDescriptor[] =
  Object.freeze(
    [...descriptors]
      .sort((left, right) => left.order - right.order)
      .map(freezeDescriptor)
  );

export function localAgentFormatDescriptor(
  id: LocalAgentFormatId
): LocalAgentFormatDescriptor | undefined {
  return localAgentFormatDescriptors.find((descriptor) => descriptor.id === id);
}

export function localAgentFormatLabel(id: LocalAgentFormatId): string {
  return localAgentFormatDescriptor(id)?.label ?? id;
}

export function localAgentFormatSupports(
  id: string | undefined,
  capability: keyof LocalAgentFormatDescriptor["capabilities"]
): boolean {
  return localAgentFormatDescriptors.some((descriptor) => (
    descriptor.id === id && descriptor.capabilities[capability] === true
  ));
}

export function matchesLocalAgentFormatFile(
  descriptor: LocalAgentFormatDescriptor,
  filePath: string
): boolean {
  const name = basename(filePath);
  const extensions = descriptor.discovery.extensions ?? (
    descriptor.discovery.extension ? [descriptor.discovery.extension] : []
  );
  if (extensions.length > 0 && !extensions.some((extension) => name.endsWith(extension))) return false;
  if (descriptor.discovery.basename && name !== descriptor.discovery.basename) return false;
  if (descriptor.discovery.basenamePrefix && !name.startsWith(descriptor.discovery.basenamePrefix)) return false;
  if (descriptor.discovery.ancestorBasename && !hasAncestorBasename(
    filePath,
    descriptor.discovery.ancestorBasename
  )) return false;
  return true;
}

export function matchesLocalAgentDetectionFile(
  descriptor: LocalAgentFormatDescriptor,
  filePath: string
): boolean {
  return Boolean(
    descriptor.discovery.detectionBasename &&
    basename(filePath) === descriptor.discovery.detectionBasename
  );
}

export function validateLocalAgentFormatDescriptors(
  registry: readonly LocalAgentFormatDescriptor[] = localAgentFormatDescriptors
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const descriptor of registry) {
    if (descriptor.schemaVersion !== 1) throw new Error(`Unsupported local-agent format schema for ${descriptor.id}.`);
    if (!descriptor.id || !descriptor.label || !descriptor.provider) throw new Error("Local-agent format identity is incomplete.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.id) ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.provider)) {
      throw new Error(`Unsafe local-agent format identity for ${descriptor.id}.`);
    }
    if (ids.has(descriptor.id)) throw new Error(`Duplicate local-agent format id: ${descriptor.id}.`);
    if (orders.has(descriptor.order)) throw new Error(`Duplicate local-agent format order: ${descriptor.order}.`);
    if (descriptor.defaultHomeRelative.length === 0 || descriptor.defaultHomeRelative.some((part) => (
      !part || part === "." || part === ".." || /[\\/\u0000]/.test(part)
    ))) {
      throw new Error(`Unsafe default local-agent root for ${descriptor.id}.`);
    }
    const discovery = descriptor.discovery;
    if (!discovery.extension && !discovery.extensions?.length &&
        !discovery.basename && !discovery.basenamePrefix) {
      throw new Error(`Local-agent format ${descriptor.id} must declare a bounded file rule.`);
    }
    for (const extension of [
      ...(discovery.extension ? [discovery.extension] : []),
      ...(discovery.extensions ?? [])
    ]) {
      if (!/^\.[A-Za-z0-9]+$/.test(extension)) {
        throw new Error(`Unsafe discovery extension for ${descriptor.id}.`);
      }
    }
    for (const value of [
      discovery.basename,
      discovery.basenamePrefix,
      discovery.ancestorBasename,
      discovery.detectionBasename
    ]) {
      if (value && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || /[\\/\u0000]/.test(value))) {
        throw new Error(`Unsafe discovery filename rule for ${descriptor.id}.`);
      }
    }
    if (descriptor.confidenceDefaults.pricedFinancialEvidence !== "estimated" ||
        descriptor.confidenceDefaults.unpricedFinancialEvidence !== "missing" ||
        descriptor.confidenceDefaults.sourceConfidence !== "estimated") {
      throw new Error(`Local transcript format ${descriptor.id} must default to estimated/missing financial evidence.`);
    }
    if (descriptor.fixtures.length === 0 || descriptor.fixtures.some((fixture) => (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(fixture)
    ))) {
      throw new Error(`Local-agent format ${descriptor.id} has an unsafe or missing recorded fixture.`);
    }
    ids.add(descriptor.id);
    orders.add(descriptor.order);
  }
}

function freezeDescriptor(
  descriptor: LocalAgentFormatDescriptor
): LocalAgentFormatDescriptor {
  Object.freeze(descriptor.defaultHomeRelative);
  if (descriptor.discovery.extensions) Object.freeze(descriptor.discovery.extensions);
  Object.freeze(descriptor.discovery);
  Object.freeze(descriptor.confidenceDefaults);
  Object.freeze(descriptor.sourceRecord);
  Object.freeze(descriptor.capabilities);
  for (const values of Object.values(descriptor.docs)) {
    if (Array.isArray(values)) Object.freeze(values);
  }
  Object.freeze(descriptor.docs);
  Object.freeze(descriptor.fixtures);
  return Object.freeze(descriptor);
}

function hasAncestorBasename(filePath: string, expected: string): boolean {
  let current = dirname(filePath);
  while (true) {
    if (basename(current) === expected) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
