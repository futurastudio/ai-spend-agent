import type { UsageSignal } from "./discovery.js";

export type SourceType =
  | "local_folder"
  | "provider_export"
  | "provider_api"
  | "browser_account"
  | "local_tool_detection"
  | "mcp_tool"
  | "internal_system";

export type SourceAccessMethod = "file" | "api" | "browser" | "cli_detection" | "mcp" | "internal" | "manual";

export type ConnectorAuthMode = "oauth" | "api_token_ref" | "browser_session" | "mcp_auth" | "manual_export" | "none";

export type ConnectorTokenStorage = "local_reference_only" | "keychain_reference" | "none";

export type SourceVerificationStatus = "verified" | "estimated" | "detected_unverified" | "missing";

export type IngestionLaneId =
  | "local_files_exports"
  | "provider_apis"
  | "browser_account_ui"
  | "local_cli_tool_detection"
  | "mcp_internal_systems";

export type IngestionLane = {
  id: IngestionLaneId;
  label: string;
  sourceTypes: SourceType[];
  defaultVerification: SourceVerificationStatus;
};

export type ApprovedSource = {
  id: string;
  type: SourceType;
  label: string;
  path?: string;
  provider?: string;
  readOnly: boolean;
  approvedAt: string;
  scope: string;
  lane: IngestionLaneId;
  accessMethod: SourceAccessMethod;
  verification: SourceVerificationStatus;
  fieldsVerified: string[];
  fieldsEstimated: string[];
  fieldsMissing: string[];
  authMode?: ConnectorAuthMode;
  authScopes?: string[];
  tokenStorage?: ConnectorTokenStorage;
  authReference?: string;
};

export type SourceRegistry = {
  version: 1;
  localOnly: true;
  cloudUpload: false;
  approvedSources: ApprovedSource[];
  deniedGlobs: string[];
  ingestionLanes: IngestionLane[];
  supportedSourceTypes: SourceType[];
  updatedAt: string;
};

export type ScanAuditEvent = {
  timestamp: string;
  action:
    | "source_registered"
    | "scan_started"
    | "source_scanned"
    | "source_skipped"
    | "secret_redacted"
    | "scan_completed"
    | "missing_source_prompted"
    | "mapping_confirmed";
  sourceId?: string;
  path?: string;
  reason?: string;
  detail?: string;
};

export type ScanAuditLog = {
  version: 1;
  localOnly: true;
  events: ScanAuditEvent[];
};

export type ProviderCatalogEntry = {
  id: string;
  label: string;
  preferredSourceType: SourceType;
  preferredAccessMethod: SourceAccessMethod;
  verifiedFields: string[];
  missingFields: string[];
  fallbackConnector?: SourceType;
};

export type ProviderConnectorCatalogEntry = {
  provider: string;
  preferredAuthMode: ConnectorAuthMode;
  fallbackAuthModes: ConnectorAuthMode[];
  scopes: string[];
  tokenStorage: ConnectorTokenStorage;
  setupHint: string;
};

export type MissingSourcePrompt = {
  provider: string;
  status: Extract<SourceVerificationStatus, "detected_unverified" | "missing">;
  reason: string;
  detectedEvidence: string[];
  suggestedConnector: string;
  suggestedSourceTypes: SourceType[];
};

export type ConfirmedMapping = {
  id: string;
  provider: string;
  sourceId: string;
  team?: string;
  person?: string;
  client?: string;
  project?: string;
  agent?: string;
  workflow?: string;
  evidence: string[];
  confidence: number;
  status: "confirmed";
  confirmedAt: string;
};

export const ingestionLanes: IngestionLane[] = [
  {
    id: "local_files_exports",
    label: "Local files and provider exports",
    sourceTypes: ["local_folder", "provider_export"],
    defaultVerification: "estimated"
  },
  {
    id: "provider_apis",
    label: "Official provider APIs",
    sourceTypes: ["provider_api"],
    defaultVerification: "verified"
  },
  {
    id: "browser_account_ui",
    label: "Browser Account UI",
    sourceTypes: ["browser_account"],
    defaultVerification: "verified"
  },
  {
    id: "local_cli_tool_detection",
    label: "Local CLI/tool detection path",
    sourceTypes: ["local_tool_detection"],
    defaultVerification: "detected_unverified"
  },
  {
    id: "mcp_internal_systems",
    label: "MCP and internal systems",
    sourceTypes: ["mcp_tool", "internal_system"],
    defaultVerification: "verified"
  }
];

export const supportedSourceTypes: SourceType[] = ingestionLanes.flatMap((lane) => lane.sourceTypes);

export const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: "openai",
    label: "OpenAI / Codex account usage",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["organization costs", "project usage", "model usage", "api key usage"],
    missingFields: ["admin API token reference", "organization id"]
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude / Claude Code",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["organization cost report", "Claude Code usage", "workspace/user usage"],
    missingFields: ["admin API token reference", "organization id"],
    fallbackConnector: "browser_account"
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["Copilot usage metrics", "seat usage", "premium request usage"],
    missingFields: ["GitHub token reference", "organization or enterprise slug"],
    fallbackConnector: "browser_account"
  },
  {
    id: "codex",
    label: "Codex / OpenAI coding tools",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["OpenAI project usage", "OpenAI costs", "tool/project attribution"],
    missingFields: ["OpenAI admin API token reference", "project mapping"],
    fallbackConnector: "browser_account"
  },
  {
    id: "cursor",
    label: "Cursor",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["Cursor Admin API spend", "team usage", "seat usage"],
    missingFields: ["Cursor admin API key reference or approved browser account session"],
    fallbackConnector: "browser_account"
  },
  {
    id: "gemini",
    label: "Google Gemini",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["Google/Vertex billing export", "model usage"],
    missingFields: ["approved billing export or API source"]
  },
  {
    id: "langfuse",
    label: "Langfuse",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["trace usage", "model cost observations"],
    missingFields: ["Langfuse API token reference", "project id"]
  },
  {
    id: "helicone",
    label: "Helicone",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["gateway usage", "model costs", "request metadata"],
    missingFields: ["Helicone API token reference"]
  },
  {
    id: "litellm",
    label: "LiteLLM",
    preferredSourceType: "internal_system",
    preferredAccessMethod: "internal",
    verifiedFields: ["proxy spend logs", "team/user/model spend"],
    missingFields: ["database/API/MCP source"]
  },
  {
    id: "vercel-ai-sdk",
    label: "Vercel AI SDK",
    preferredSourceType: "local_tool_detection",
    preferredAccessMethod: "cli_detection",
    verifiedFields: [],
    missingFields: ["underlying provider source", "project mapping"]
  },
  {
    id: "continue",
    label: "Continue",
    preferredSourceType: "local_tool_detection",
    preferredAccessMethod: "cli_detection",
    verifiedFields: [],
    missingFields: ["underlying provider source"]
  },
  {
    id: "aider",
    label: "Aider",
    preferredSourceType: "local_tool_detection",
    preferredAccessMethod: "cli_detection",
    verifiedFields: [],
    missingFields: ["underlying provider source"]
  }
];

export const providerConnectorCatalog: ProviderConnectorCatalogEntry[] = [
  {
    provider: "openai",
    preferredAuthMode: "oauth",
    fallbackAuthModes: ["api_token_ref", "browser_session"],
    scopes: ["organization:usage:read", "organization:costs:read", "projects:read"],
    tokenStorage: "local_reference_only",
    setupHint: "Prefer OAuth/admin consent for org usage and costs; fallback to a local keychain/token reference or dashboard export."
  },
  {
    provider: "anthropic",
    preferredAuthMode: "oauth",
    fallbackAuthModes: ["api_token_ref", "browser_session"],
    scopes: ["organization:usage:read", "organization:costs:read", "claude_code:usage:read"],
    tokenStorage: "local_reference_only",
    setupHint: "Prefer org/admin OAuth or admin API token reference for Claude cost and Claude Code usage reports."
  },
  {
    provider: "github-copilot",
    preferredAuthMode: "oauth",
    fallbackAuthModes: ["api_token_ref", "browser_session"],
    scopes: ["copilot:usage:read", "enterprise:read", "org:read"],
    tokenStorage: "local_reference_only",
    setupHint: "Prefer GitHub App/OAuth read-only org or enterprise consent for Copilot seats and usage metrics."
  },
  {
    provider: "cursor",
    preferredAuthMode: "api_token_ref",
    fallbackAuthModes: ["browser_session", "manual_export"],
    scopes: ["admin:*", "team:usage:read", "team:spend:read"],
    tokenStorage: "local_reference_only",
    setupHint: "Use Cursor Admin API key reference for Enterprise team usage/spend when available; fallback to Browser Account UI or manual export."
  }
];

export const defaultDeniedGlobs = [
  ".env*",
  "**/.git/**",
  "**/node_modules/**",
  "**/.ssh/**",
  "**/Library/Keychains/**",
  "**/*keychain*",
  "**/*token*",
  "**/*secret*",
  "**/*password*"
];

export function createLocalFolderSourceRegistry(rootPath: string, now = new Date()): SourceRegistry {
  const timestamp = now.toISOString();
  return {
    version: 1,
    localOnly: true,
    cloudUpload: false,
    approvedSources: [
      {
        id: "local-root",
        type: "local_folder",
        label: "Approved local scan root",
        path: rootPath,
        readOnly: true,
        approvedAt: timestamp,
        scope: "Read-only scan of the explicit --path root. No writes outside .ai-spend-agent. No cloud upload.",
        lane: "local_files_exports",
        accessMethod: "file",
        verification: "verified",
        fieldsVerified: ["approved local folder boundary"],
        fieldsEstimated: [],
        fieldsMissing: ["provider account billing data"]
      }
    ],
    deniedGlobs: defaultDeniedGlobs,
    ingestionLanes,
    supportedSourceTypes,
    updatedAt: timestamp
  };
}

export function addApprovedSource(
  registry: SourceRegistry,
  source: Omit<ApprovedSource, "approvedAt" | "readOnly" | "scope" | "lane" | "accessMethod" | "verification" | "fieldsVerified" | "fieldsEstimated" | "fieldsMissing"> &
    Partial<Pick<ApprovedSource, "readOnly" | "scope" | "lane" | "accessMethod" | "verification" | "fieldsVerified" | "fieldsEstimated" | "fieldsMissing" | "authMode" | "authScopes" | "tokenStorage" | "authReference">>,
  now = new Date()
): SourceRegistry {
  const timestamp = now.toISOString();
  const nextSource: ApprovedSource = {
    ...source,
    readOnly: source.readOnly ?? true,
    approvedAt: timestamp,
    scope: source.scope ?? defaultScopeForSource(source.type),
    lane: source.lane ?? laneForSourceType(source.type),
    accessMethod: source.accessMethod ?? accessMethodForSourceType(source.type),
    verification: source.verification ?? ingestionLanes.find((lane) => lane.sourceTypes.includes(source.type))?.defaultVerification ?? "estimated",
    fieldsVerified: source.fieldsVerified ?? [],
    fieldsEstimated: source.fieldsEstimated ?? [],
    fieldsMissing: source.fieldsMissing ?? [],
    authMode: source.authMode,
    authScopes: source.authScopes,
    tokenStorage: source.tokenStorage,
    authReference: source.authReference
  };
  const withoutExisting = registry.approvedSources.filter((candidate) => candidate.id !== nextSource.id);
  return {
    ...registry,
    ingestionLanes: registry.ingestionLanes ?? ingestionLanes,
    supportedSourceTypes: registry.supportedSourceTypes ?? supportedSourceTypes,
    approvedSources: [...withoutExisting, nextSource],
    updatedAt: timestamp
  };
}

export function createProviderConnectorStub(
  provider: string,
  type: SourceType = providerCatalog.find((entry) => entry.id === provider)?.preferredSourceType ?? "provider_api",
  now = new Date()
): ApprovedSource {
  const catalogEntry = providerCatalog.find((entry) => entry.id === provider);
  const connectorEntry = providerConnectorCatalog.find((entry) => entry.provider === provider);
  const id = slugifySourceId(`${provider}-${type}`);
  return {
    id,
    type,
    label: catalogEntry?.label ?? `${provider} connector`,
    provider,
    readOnly: true,
    approvedAt: now.toISOString(),
    scope: defaultScopeForSource(type),
    lane: laneForSourceType(type),
    accessMethod: accessMethodForSourceType(type, catalogEntry),
    verification: "missing",
    fieldsVerified: catalogEntry?.verifiedFields ?? [],
    fieldsEstimated: [],
    fieldsMissing: catalogEntry?.missingFields ?? ["approved account/API/export source"],
    authMode: authModeForConnectorType(type, connectorEntry),
    authScopes: connectorEntry?.scopes ?? [],
    tokenStorage: tokenStorageForConnectorType(type, connectorEntry)
  };
}

export function buildMissingSourcePrompts(signals: UsageSignal[], registry: SourceRegistry): MissingSourcePrompt[] {
  const providerSignals = new Map<string, UsageSignal[]>();
  for (const signal of signals) {
    if (signal.kind === "provider_export" || signal.kind === "invoice") {
      continue;
    }
    providerSignals.set(signal.provider, [...(providerSignals.get(signal.provider) ?? []), signal]);
  }

  const prompts: MissingSourcePrompt[] = [];
  for (const [provider, detectedSignals] of Array.from(providerSignals.entries())) {
    if (hasVerifiedProviderSource(registry, provider)) {
      continue;
    }
    const catalogEntry = providerCatalog.find((entry) => entry.id === provider);
    const preferredType = catalogEntry?.preferredSourceType ?? "provider_api";
    const suggestedSourceTypes = [preferredType, catalogEntry?.fallbackConnector].filter(Boolean) as SourceType[];
    prompts.push({
      provider,
      status: "detected_unverified",
      reason: `${provider} was detected locally, but no verified provider/API/browser/export source is connected.`,
      detectedEvidence: detectedSignals.map((signal) => signal.evidence),
      suggestedConnector: `connect ${provider} --type ${preferredType}`,
      suggestedSourceTypes
    });
  }
  return prompts.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function confirmMapping(input: Omit<ConfirmedMapping, "id" | "status" | "confirmedAt">, now = new Date()): ConfirmedMapping {
  return {
    id: slugifySourceId([
      input.provider,
      input.team,
      input.person,
      input.client,
      input.project,
      input.agent,
      input.workflow
    ].filter(Boolean).join("-")),
    ...input,
    status: "confirmed",
    confirmedAt: now.toISOString()
  };
}

export function createScanAuditLog(events: ScanAuditEvent[] = []): ScanAuditLog {
  return {
    version: 1,
    localOnly: true,
    events
  };
}

export function slugifySourceId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "approved-source";
}

function hasVerifiedProviderSource(registry: SourceRegistry, provider: string): boolean {
  return registry.approvedSources.some((source) => {
    if (source.provider !== provider) {
      return false;
    }
    if (source.verification === "verified" && source.type !== "local_tool_detection") {
      return true;
    }
    return source.type === "provider_export" || source.type === "provider_api" || source.type === "browser_account" || source.type === "internal_system";
  });
}

function authModeForConnectorType(type: SourceType, connectorEntry?: ProviderConnectorCatalogEntry): ConnectorAuthMode {
  if (type === "browser_account") return "browser_session";
  if (type === "provider_export") return "manual_export";
  if (type === "mcp_tool" || type === "internal_system") return "mcp_auth";
  if (type === "local_tool_detection") return "none";
  return connectorEntry?.preferredAuthMode ?? "api_token_ref";
}

function tokenStorageForConnectorType(type: SourceType, connectorEntry?: ProviderConnectorCatalogEntry): ConnectorTokenStorage {
  if (type === "browser_account" || type === "provider_export" || type === "local_tool_detection") return "none";
  return connectorEntry?.tokenStorage ?? "local_reference_only";
}

function defaultScopeForSource(type: SourceType): string {
  if (type === "provider_api") {
    return "Read-only provider API/account usage source. Store token references only; no raw secrets. No billing changes. No cloud upload.";
  }
  if (type === "browser_account") {
    return "Read-only Browser Account UI source. User logs in locally; agent never sees passwords; 2FA/CAPTCHA handoff; audit all page reads/downloads.";
  }
  if (type === "local_tool_detection") {
    return "Read-only local CLI/tool detection path. Detection is not verified spend until account/API/export source is connected.";
  }
  if (type === "mcp_tool" || type === "internal_system") {
    return "Read-only approved MCP/internal-system source. No writes, sends, deletes, or production changes without approval.";
  }
  return "Read-only approved source. No cloud upload.";
}

function laneForSourceType(type: SourceType): IngestionLaneId {
  const lane = ingestionLanes.find((candidate) => candidate.sourceTypes.includes(type));
  return lane?.id ?? "local_files_exports";
}

function accessMethodForSourceType(type: SourceType, catalogEntry?: ProviderCatalogEntry): SourceAccessMethod {
  if (catalogEntry?.preferredSourceType === type) {
    return catalogEntry.preferredAccessMethod;
  }
  if (type === "provider_api") return "api";
  if (type === "browser_account") return "browser";
  if (type === "local_tool_detection") return "cli_detection";
  if (type === "mcp_tool") return "mcp";
  if (type === "internal_system") return "internal";
  return "file";
}
