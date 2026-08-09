import type { UsageSignal } from "./discovery.js";
import type { FinancialEvidenceStatus, SourceValidationCoverage } from "./sourceStatus.js";

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

/** @deprecated Use FinancialEvidenceStatus. Kept only for persisted v1 migration. */
export type SourceVerificationStatus = FinancialEvidenceStatus;

export type SourceBoundaryApproval = "approved";

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
  defaultFinancialEvidence: FinancialEvidenceStatus;
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
  /** Permission to read this exact boundary. This is never financial proof. */
  boundaryApproval: SourceBoundaryApproval;
  /** How thoroughly the connector/parser itself has been exercised. */
  validationCoverage: SourceValidationCoverage;
  /** Quality of the financial numbers currently emitted by this source. */
  financialEvidence: FinancialEvidenceStatus;
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
  status: Extract<FinancialEvidenceStatus, "detected_unverified" | "missing">;
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
    defaultFinancialEvidence: "estimated"
  },
  {
    id: "provider_apis",
    label: "Official provider APIs",
    sourceTypes: ["provider_api"],
    defaultFinancialEvidence: "verified"
  },
  {
    id: "browser_account_ui",
    label: "Browser Account UI",
    sourceTypes: ["browser_account"],
    defaultFinancialEvidence: "verified"
  },
  {
    id: "local_cli_tool_detection",
    label: "Local CLI/tool detection path",
    sourceTypes: ["local_tool_detection"],
    defaultFinancialEvidence: "detected_unverified"
  },
  {
    id: "mcp_internal_systems",
    label: "MCP and internal systems",
    sourceTypes: ["mcp_tool", "internal_system"],
    defaultFinancialEvidence: "verified"
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
        boundaryApproval: "approved",
        validationCoverage: "untested",
        financialEvidence: "missing",
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
  source: Omit<ApprovedSource, "approvedAt" | "readOnly" | "scope" | "lane" | "accessMethod" | "boundaryApproval" | "validationCoverage" | "financialEvidence" | "fieldsVerified" | "fieldsEstimated" | "fieldsMissing"> &
    Partial<Pick<ApprovedSource, "readOnly" | "scope" | "lane" | "accessMethod" | "boundaryApproval" | "validationCoverage" | "financialEvidence" | "fieldsVerified" | "fieldsEstimated" | "fieldsMissing" | "authMode" | "authScopes" | "tokenStorage" | "authReference">>,
  now = new Date()
): SourceRegistry {
  const timestamp = now.toISOString();
  const canonicalRegistry = normalizeSourceRegistry(registry);
  if (source.readOnly === false) {
    throw new Error("Approved source boundaries must remain read-only.");
  }
  const nextSource: ApprovedSource = {
    id: source.id,
    type: source.type,
    label: source.label,
    ...(source.path ? { path: source.path } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    readOnly: true,
    approvedAt: timestamp,
    scope: source.scope ?? defaultScopeForSource(source.type),
    lane: source.lane ?? laneForSourceType(source.type),
    accessMethod: source.accessMethod ?? accessMethodForSourceType(source.type),
    boundaryApproval: source.boundaryApproval ?? "approved",
    validationCoverage: source.validationCoverage ?? "untested",
    financialEvidence: source.type === "local_folder" ? "missing" : (source.financialEvidence ?? "missing"),
    fieldsVerified: source.fieldsVerified ?? [],
    fieldsEstimated: source.fieldsEstimated ?? [],
    fieldsMissing: source.fieldsMissing ?? [],
    authMode: source.authMode,
    authScopes: source.authScopes,
    tokenStorage: source.tokenStorage,
    authReference: source.authReference
  };
  const withoutExisting = canonicalRegistry.approvedSources.filter((candidate) => candidate.id !== nextSource.id);
  return {
    ...canonicalRegistry,
    ingestionLanes: canonicalRegistry.ingestionLanes ?? ingestionLanes,
    supportedSourceTypes: canonicalRegistry.supportedSourceTypes ?? supportedSourceTypes,
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
    boundaryApproval: "approved",
    // Registering a read-only boundary is not evidence that a connector ran.
    // A successful provider result promotes this axis explicitly.
    validationCoverage: "untested",
    financialEvidence: "missing",
    fieldsVerified: catalogEntry?.verifiedFields ?? [],
    fieldsEstimated: [],
    fieldsMissing: catalogEntry?.missingFields ?? ["approved account/API/export source"],
    authMode: authModeForConnectorType(type, connectorEntry),
    authScopes: connectorEntry?.scopes ?? [],
    tokenStorage: tokenStorageForConnectorType(type, connectorEntry)
  };
}

/**
 * Read a persisted source registry into the canonical three-axis contract.
 *
 * Version 1 registries used `verification` for several unrelated meanings.
 * It is accepted here only as a migration input for financial evidence and is
 * deliberately omitted from the returned object. A local-folder approval is
 * permission metadata, so even a legacy `verification: "verified"` migrates
 * to `financialEvidence: "missing"`.
 */
export function normalizeSourceRegistry(value: unknown): SourceRegistry {
  if (!isObject(value) || value.version !== 1 || value.localOnly !== true || value.cloudUpload !== false) {
    throw new Error("Invalid local source registry: expected the canonical local-only registry shape.");
  }
  if (
    !Array.isArray(value.approvedSources) ||
    !Array.isArray(value.deniedGlobs) ||
    !Array.isArray(value.ingestionLanes) ||
    !Array.isArray(value.supportedSourceTypes) ||
    !isValidIso(value.updatedAt) ||
    !isStringList(value.deniedGlobs) ||
    !value.supportedSourceTypes.every(isSourceTypeValue)
  ) {
    throw new Error("Invalid local source registry: expected valid source, lane, and deny lists.");
  }

  const normalizedLanes = value.ingestionLanes.map(normalizeIngestionLane);
  const normalizedSources = value.approvedSources.map(normalizeApprovedSource);
  return {
    version: 1,
    localOnly: true,
    cloudUpload: false,
    approvedSources: normalizedSources,
    deniedGlobs: [...value.deniedGlobs],
    ingestionLanes: normalizedLanes,
    supportedSourceTypes: [...value.supportedSourceTypes],
    updatedAt: value.updatedAt
  };
}

function normalizeIngestionLane(value: unknown): IngestionLane {
  if (
    !isObject(value) ||
    !isIngestionLaneId(value.id) ||
    !isNonEmptyString(value.label) ||
    !Array.isArray(value.sourceTypes) ||
    !value.sourceTypes.every(isSourceTypeValue)
  ) {
    throw new Error("Invalid local source registry: an ingestion lane has a malformed shape.");
  }
  if (value.defaultFinancialEvidence !== undefined && !isFinancialEvidence(value.defaultFinancialEvidence)) {
    throw new Error("Invalid local source registry: an ingestion lane has invalid financial evidence.");
  }
  if (value.defaultVerification !== undefined && !isFinancialEvidence(value.defaultVerification)) {
    throw new Error("Invalid local source registry: an ingestion lane has an invalid legacy verification value.");
  }
  const financialEvidence = isFinancialEvidence(value.defaultFinancialEvidence)
    ? value.defaultFinancialEvidence
    : isFinancialEvidence(value.defaultVerification)
      ? value.defaultVerification
      : undefined;
  if (!financialEvidence) {
    throw new Error("Invalid local source registry: an ingestion lane is missing its financial-evidence default.");
  }
  return {
    id: value.id,
    label: value.label,
    sourceTypes: [...value.sourceTypes],
    defaultFinancialEvidence: financialEvidence
  };
}

function normalizeApprovedSource(value: unknown): ApprovedSource {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.id) ||
    !isSourceTypeValue(value.type) ||
    !isNonEmptyString(value.label) ||
    value.readOnly !== true ||
    !isValidIso(value.approvedAt) ||
    !isNonEmptyString(value.scope) ||
    !isIngestionLaneId(value.lane) ||
    !isAccessMethod(value.accessMethod) ||
    !isStringList(value.fieldsVerified) ||
    !isStringList(value.fieldsEstimated) ||
    !isStringList(value.fieldsMissing)
  ) {
    throw new Error("Invalid local source registry: an approved source has a malformed shape.");
  }
  if (value.boundaryApproval !== undefined && value.boundaryApproval !== "approved") {
    throw new Error("Invalid local source registry: an approved source has an invalid boundary approval.");
  }
  if (value.validationCoverage !== undefined && !isValidationCoverage(value.validationCoverage)) {
    throw new Error("Invalid local source registry: an approved source has an invalid validation coverage.");
  }
  if (value.financialEvidence !== undefined && !isFinancialEvidence(value.financialEvidence)) {
    throw new Error("Invalid local source registry: an approved source has invalid financial evidence.");
  }
  if (value.verification !== undefined && !isFinancialEvidence(value.verification)) {
    throw new Error("Invalid local source registry: an approved source has an invalid legacy verification value.");
  }
  const provider = optionalNonEmptyString(value.provider, "provider");
  const path = optionalNonEmptyString(value.path, "path");
  const authReference = optionalNonEmptyString(value.authReference, "auth reference");
  const authMode = optionalEnum(value.authMode, isAuthMode, "auth mode");
  const tokenStorage = optionalEnum(value.tokenStorage, isTokenStorage, "token storage");
  if (value.authScopes !== undefined && !isStringList(value.authScopes)) {
    throw new Error("Invalid local source registry: an approved source has invalid auth scopes.");
  }

  const migratedEvidence = isFinancialEvidence(value.financialEvidence)
    ? value.financialEvidence
    : isFinancialEvidence(value.verification)
      ? value.verification
      : "missing";
  return {
    id: value.id,
    type: value.type,
    label: value.label,
    ...(path ? { path } : {}),
    ...(provider ? { provider } : {}),
    readOnly: true,
    approvedAt: value.approvedAt,
    scope: value.scope,
    lane: value.lane,
    accessMethod: value.accessMethod,
    boundaryApproval: "approved",
    validationCoverage: isValidationCoverage(value.validationCoverage)
      ? value.validationCoverage
      : "untested",
    financialEvidence: value.type === "local_folder" ? "missing" : migratedEvidence,
    fieldsVerified: [...value.fieldsVerified],
    fieldsEstimated: [...value.fieldsEstimated],
    fieldsMissing: [...value.fieldsMissing],
    ...(authMode ? { authMode } : {}),
    ...(value.authScopes ? { authScopes: [...value.authScopes] } : {}),
    ...(tokenStorage ? { tokenStorage } : {}),
    ...(authReference ? { authReference } : {})
  };
}

/**
 * Persisted source registries are repository-controlled configuration. Until
 * an external provider-sync receipt binds their exact bytes, keep only the
 * approved read-only boundary and remove any self-asserted validation or
 * financial-evidence claims.
 */
export function downgradeUntrustedSourceRegistryClaims(registry: SourceRegistry): SourceRegistry {
  const canonical = normalizeSourceRegistry(registry);
  return {
    ...canonical,
    approvedSources: canonical.approvedSources.map((source) => ({
      ...source,
      validationCoverage: "untested",
      financialEvidence: "missing",
      fieldsVerified: source.fieldsVerified.filter((field) =>
        /approved|boundary|read-only|folder/i.test(field)
      ),
      fieldsMissing: Array.from(new Set([
        ...source.fieldsMissing,
        "machine-bound provider validation and financial evidence"
      ]))
    }))
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
    if (hasCurrentProviderFinancialEvidence(registry, provider)) {
      continue;
    }
    const catalogEntry = providerCatalog.find((entry) => entry.id === provider);
    const preferredType = catalogEntry?.preferredSourceType ?? "provider_api";
    const suggestedSourceTypes = [preferredType, catalogEntry?.fallbackConnector].filter(Boolean) as SourceType[];
    prompts.push({
      provider,
      status: "detected_unverified",
      reason: `${provider} was detected locally, but no approved provider/API/browser/export boundary has current financial evidence. Connector validation is reported separately.`,
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

function hasCurrentProviderFinancialEvidence(registry: SourceRegistry, provider: string): boolean {
  return registry.approvedSources.some((source) => {
    if (source.provider !== provider) {
      return false;
    }
    return source.boundaryApproval === "approved" &&
      source.validationCoverage !== "failed" &&
      source.financialEvidence !== "missing" &&
      source.type !== "local_tool_detection";
  });
}

function validationCoverageForSource(provider: string | undefined, type: SourceType): SourceValidationCoverage {
  if (type === "provider_api" && (provider === "openai" || provider === "anthropic")) return "live_verified";
  if (type === "provider_api" && (provider === "cursor" || provider === "github-copilot" || provider === "copilot")) return "fixture_verified";
  if (provider === "local-agent-logs" && type === "local_tool_detection") return "live_verified";
  return "untested";
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
    return "Read-only local CLI/tool detection path. Detection is not official provider-reported cost; connect an account API or export to add that evidence.";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSourceTypeValue(value: unknown): value is SourceType {
  return supportedSourceTypes.includes(value as SourceType);
}

function isIngestionLaneId(value: unknown): value is IngestionLaneId {
  return value === "local_files_exports" ||
    value === "provider_apis" ||
    value === "browser_account_ui" ||
    value === "local_cli_tool_detection" ||
    value === "mcp_internal_systems";
}

function isAccessMethod(value: unknown): value is SourceAccessMethod {
  return value === "file" || value === "api" || value === "browser" || value === "cli_detection" || value === "mcp" || value === "internal" || value === "manual";
}

function isFinancialEvidence(value: unknown): value is FinancialEvidenceStatus {
  return value === "verified" || value === "estimated" || value === "detected_unverified" || value === "missing";
}

function isValidationCoverage(value: unknown): value is SourceValidationCoverage {
  return value === "live_verified" || value === "fixture_verified" || value === "untested" || value === "failed";
}

function isAuthMode(value: unknown): value is ConnectorAuthMode {
  return value === "oauth" || value === "api_token_ref" || value === "browser_session" || value === "mcp_auth" || value === "manual_export" || value === "none";
}

function isTokenStorage(value: unknown): value is ConnectorTokenStorage {
  return value === "local_reference_only" || value === "keychain_reference" || value === "none";
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw new Error(`Invalid local source registry: an approved source has an invalid ${label}.`);
  }
  return value;
}

function optionalEnum<T>(value: unknown, predicate: (candidate: unknown) => candidate is T, label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!predicate(value)) {
    throw new Error(`Invalid local source registry: an approved source has an invalid ${label}.`);
  }
  return value;
}
