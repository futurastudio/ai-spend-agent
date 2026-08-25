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
    label: "Browser Account UI (schema scaffold; ingestion unavailable)",
    sourceTypes: ["browser_account"],
    defaultFinancialEvidence: "missing"
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

const browserAccountScaffoldMissingField = "browser-account ingestion is a schema scaffold and is not implemented";

export const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: "openai",
    label: "OpenAI / Codex account usage",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["organization costs", "completions usage by project, user, model, API key, and service tier"],
    missingFields: [
      "OpenAI Admin API key reference",
      "non-completions usage families",
      "ChatGPT/Codex workspace seats, credits, and final invoice settlement"
    ]
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude / Claude Code",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["organization cost report", "Claude Code analytics by workspace and user"],
    missingFields: [
      "Anthropic Admin API key reference",
      "Messages Usage API detail",
      "Claude Enterprise Analytics and final invoice settlement"
    ]
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    // AI-credit billing (gross/discount/net) is implemented and shipped;
    // billed dollars stay estimated until an AI_SPEND_COPILOT_RECONCILE_*
    // reconciliation matches the billing page figure. Legacy premium-request
    // billing is deliberately never fetched.
    verifiedFields: [
      "Copilot usage metrics",
      "seat assignments and reported plan types",
      "AI-credit gross, discount, and net billing usage report"
    ],
    missingFields: [
      "GitHub admin token reference and organization or enterprise slug",
      "license invoice settlement"
    ]
  },
  {
    id: "codex",
    label: "Codex / OpenAI coding tools",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["OpenAI organization costs", "OpenAI completions usage"],
    missingFields: [
      "OpenAI Admin API key reference",
      "ChatGPT/Codex workspace seats, credits, and subscription billing",
      "workspace-to-local-project mapping"
    ]
  },
  {
    id: "cursor",
    label: "Cursor",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: ["Cursor Admin API team-member spend aggregate"],
    missingFields: [
      "Cursor team Admin API key reference",
      "filtered usage-event detail and aggregate reconciliation",
      "seat contract and final invoice settlement"
    ]
  },
  {
    id: "gemini",
    label: "Google Gemini",
    preferredSourceType: "provider_api",
    preferredAccessMethod: "api",
    verifiedFields: [],
    missingFields: [
      "Google Cloud Billing export or approved billing API source",
      "Gemini CLI authentication and billing mode",
      "provider-reported billed money"
    ]
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
    preferredAuthMode: "api_token_ref",
    fallbackAuthModes: [],
    scopes: ["Organization Admin API usage read", "Organization Admin API costs read"],
    tokenStorage: "local_reference_only",
    setupHint: "Use a local env reference to an OpenAI Organization Admin API key with usage and costs access; raw keys are never accepted on the command line."
  },
  {
    provider: "anthropic",
    preferredAuthMode: "api_token_ref",
    fallbackAuthModes: [],
    scopes: ["Claude Console Admin cost report read", "Claude Code analytics read"],
    tokenStorage: "local_reference_only",
    setupHint: "Use a local env reference to a Claude Console organization Admin API key; Claude Enterprise Analytics requires a different key and is not implemented."
  },
  {
    provider: "github-copilot",
    preferredAuthMode: "api_token_ref",
    fallbackAuthModes: [],
    scopes: ["fine-grained Administration: read", "organization or enterprise billing access"],
    tokenStorage: "local_reference_only",
    setupHint: "Use a local env reference to a GitHub token with read-only organization or enterprise Copilot metrics, seat, and AI-credit billing usage access; billed AI-credit dollars stay estimated until an AI_SPEND_COPILOT_RECONCILE_* reconciliation matches the billing page figure."
  },
  {
    provider: "cursor",
    preferredAuthMode: "api_token_ref",
    fallbackAuthModes: [],
    scopes: ["Cursor team Admin API spend read"],
    tokenStorage: "local_reference_only",
    setupHint: "Use a local env reference to a Cursor team Admin API key for the team spend aggregate; filtered usage-event and invoice reconciliation are not implemented."
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
  const browserScaffold = source.type === "browser_account";
  const nextSource: ApprovedSource = {
    id: source.id,
    type: source.type,
    label: source.label,
    ...(source.path ? { path: source.path } : {}),
    ...(source.provider ? { provider: source.provider } : {}),
    readOnly: true,
    approvedAt: timestamp,
    scope: browserScaffold ? defaultScopeForSource(source.type) : (source.scope ?? defaultScopeForSource(source.type)),
    lane: source.lane ?? laneForSourceType(source.type),
    accessMethod: source.accessMethod ?? accessMethodForSourceType(source.type),
    boundaryApproval: source.boundaryApproval ?? "approved",
    validationCoverage: browserScaffold ? "untested" : (source.validationCoverage ?? "untested"),
    financialEvidence: source.type === "local_folder" || browserScaffold ? "missing" : (source.financialEvidence ?? "missing"),
    fieldsVerified: browserScaffold ? [] : (source.fieldsVerified ?? []),
    fieldsEstimated: browserScaffold ? [] : (source.fieldsEstimated ?? []),
    fieldsMissing: browserScaffold
      ? Array.from(new Set([...(source.fieldsMissing ?? []), browserAccountScaffoldMissingField]))
      : (source.fieldsMissing ?? []),
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
  const browserScaffold = type === "browser_account";
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
    fieldsVerified: browserScaffold ? [] : (catalogEntry?.verifiedFields ?? []),
    fieldsEstimated: [],
    fieldsMissing: browserScaffold
      ? Array.from(new Set([
          ...(catalogEntry?.missingFields ?? []),
          browserAccountScaffoldMissingField
        ]))
      : (catalogEntry?.missingFields ?? ["approved account/API/export source"]),
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
  const browserScaffold = value.type === "browser_account";
  return {
    id: value.id,
    type: value.type,
    label: value.label,
    ...(path ? { path } : {}),
    ...(provider ? { provider } : {}),
    readOnly: true,
    approvedAt: value.approvedAt,
    scope: browserScaffold ? defaultScopeForSource(value.type) : value.scope,
    lane: value.lane,
    accessMethod: value.accessMethod,
    boundaryApproval: "approved",
    validationCoverage: browserScaffold
      ? "untested"
      : isValidationCoverage(value.validationCoverage)
      ? value.validationCoverage
      : "untested",
    financialEvidence: value.type === "local_folder" || browserScaffold ? "missing" : migratedEvidence,
    fieldsVerified: browserScaffold ? [] : [...value.fieldsVerified],
    fieldsEstimated: browserScaffold ? [] : [...value.fieldsEstimated],
    fieldsMissing: browserScaffold
      ? Array.from(new Set([...value.fieldsMissing, browserAccountScaffoldMissingField]))
      : [...value.fieldsMissing],
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
      reason: `${provider} was detected locally, but no approved implemented source has current financial evidence. Connector validation is reported separately.`,
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
      source.type !== "local_tool_detection" &&
      // browser_account is reserved in the schema but has no ingestion
      // implementation. Repository state cannot promote the scaffold.
      source.type !== "browser_account";
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
    return "Schema scaffold only. Browser-account ingestion is not implemented and cannot produce financial evidence or satisfy a missing-source prompt.";
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
