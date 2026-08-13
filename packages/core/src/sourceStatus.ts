import type { CostConfidence, UsageRecord } from "./schema.js";
import type { SourceRegistry } from "./sourceRegistry.js";
import { localAgentFormatDescriptors } from "./localAgentFormats/registry.js";
import type { LocalAgentFormatId } from "./localAgentFormats/types.js";
import { generatedProviderContractStates } from "./providerContractStates.generated.js";

/**
 * How thoroughly an ingestion path itself has been exercised.
 *
 * This is deliberately separate from financial evidence quality. A connector
 * can be live-verified while a particular record is still only an estimate.
 */
export const sourceValidationCoverageValues = [
  "live_verified",
  "fixture_verified",
  "untested",
  "failed"
] as const;

export type SourceValidationCoverage = typeof sourceValidationCoverageValues[number];

/** The existing aibill financial-evidence vocabulary, named for this contract. */
export type FinancialEvidenceStatus = CostConfidence;

export const sourceFreshnessStatusValues = ["fresh", "stale", "not_checked"] as const;
export type SourceFreshnessStatus = typeof sourceFreshnessStatusValues[number];

export const providerContractStateValues = ["current", "stale_contract"] as const;
export type ProviderContractState = typeof providerContractStateValues[number];

export type SourceStatusId =
  | LocalAgentFormatId
  | "openai"
  | "anthropic"
  | "cursor"
  | "github-copilot";

export type SourceStatusDefinition = {
  id: SourceStatusId;
  label: string;
  validationCoverage: SourceValidationCoverage;
  validationNote: string;
  staleAfterHours: number;
  /** Review state of the provider/parser financial semantics used by this source. */
  contractState?: ProviderContractState;
};

export type SourceStatusObservation = {
  id: SourceStatusId;
  financialEvidence: FinancialEvidenceStatus;
  financialEvidenceNote: string;
  /** When this source was last read or synced, even if it returned no records. */
  checkedAt?: string;
  /** Timestamp of the newest evidence row, which may precede the sync time. */
  latestEvidenceAt?: string;
  /** A sanitized error from the latest recorded attempt, if one exists. */
  lastError?: string;
  /** Runtime failures may override the shipped validation baseline. */
  validationCoverage?: SourceValidationCoverage;
  /** A drift monitor or reviewed contract update may fail this source closed. */
  contractState?: ProviderContractState;
};

export type SourceStatusFreshness = {
  status: SourceFreshnessStatus;
  checkedAt?: string;
  latestEvidenceAt?: string;
  staleAfterHours: number;
};

export type SourceStatus = {
  id: SourceStatusId;
  label: string;
  validationCoverage: SourceValidationCoverage;
  validationNote: string;
  financialEvidence: FinancialEvidenceStatus;
  financialEvidenceNote: string;
  contractState?: ProviderContractState;
  freshness: SourceStatusFreshness;
  lastError?: string;
};

/**
 * Shipped validation matrix. Keep these claims proof-conservative: a live
 * authentication check is not the same as a non-empty end-to-end billing
 * reconciliation.
 */
export const sourceStatusDefinitions: readonly SourceStatusDefinition[] = [
  ...localAgentFormatDescriptors.map((descriptor) => ({
    id: descriptor.id,
    label: `${descriptor.label} local logs`,
    validationCoverage: descriptor.confidenceDefaults.validationCoverage,
    validationNote: descriptor.validationNote,
    staleAfterHours: 72,
    ...(descriptor.id === "gemini-cli"
      ? { contractState: generatedProviderContractStates["gemini-cli"] }
      : {})
  })),
  {
    id: "openai",
    label: "OpenAI Costs and Usage API",
    validationCoverage: "live_verified",
    validationNote: "Product connector QA exercised non-empty Admin cost and usage API paths; the tested Costs total reconciled to invoiced API credits less the provider-UI balance with $0.00 variance. This does not reconcile the current user's account; final invoices, tax, discounts, and later adjustments remain separate.",
    staleAfterHours: 48,
    contractState: generatedProviderContractStates.openai
  },
  {
    id: "anthropic",
    label: "Anthropic Cost Report and Claude Code Analytics",
    validationCoverage: "live_verified",
    validationNote: "Admin cost and Claude Code usage paths are exercised with non-empty live records.",
    staleAfterHours: 48,
    contractState: generatedProviderContractStates.anthropic
  },
  {
    id: "cursor",
    label: "Cursor Admin API",
    validationCoverage: "fixture_verified",
    validationNote: "Canonical teamMemberSpend envelopes, totalPages pagination, completeness failures, and malformed responses pass recorded fixtures; live account QA is pending.",
    staleAfterHours: 48,
    contractState: generatedProviderContractStates.cursor
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot organization APIs",
    validationCoverage: "fixture_verified",
    validationNote: "The 2026-03-10 signed-NDJSON metrics workflow, seat pagination, per-seat plan types, and failure paths pass recorded fixtures; live account QA is pending.",
    staleAfterHours: 48,
    contractState: generatedProviderContractStates["github-copilot"]
  }
];

export function buildSourceStatuses(
  observations: readonly SourceStatusObservation[] = [],
  now = new Date(),
  definitions: readonly SourceStatusDefinition[] = sourceStatusDefinitions
): SourceStatus[] {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  return definitions.map((definition) => {
    const observation = byId.get(definition.id);
    const observedContractState = observation?.contractState;
    const contractState = definition.contractState === "stale_contract" || observedContractState === "stale_contract"
      ? "stale_contract"
      : definition.contractState;
    const observedFinancialEvidence = observation?.financialEvidence ?? "missing";
    const financialEvidence = contractState === "stale_contract" && observedFinancialEvidence === "verified"
      ? "missing"
      : observedFinancialEvidence;
    const financialEvidenceNote = contractState === "stale_contract" && observedFinancialEvidence === "verified"
      ? "Provider contract drift is unresolved; the verified financial headline is withheld pending human review."
      : observation?.financialEvidenceNote ?? "No current financial evidence was observed on this machine.";
    return {
      id: definition.id,
      label: definition.label,
      validationCoverage: observation?.validationCoverage ?? definition.validationCoverage,
      validationNote: definition.validationNote,
      financialEvidence,
      financialEvidenceNote,
      ...(contractState ? { contractState } : {}),
      freshness: sourceFreshness(definition, observation, now),
      ...(observation?.lastError ? { lastError: observation.lastError } : {})
    };
  });
}

/**
 * Reduce one source's current rows to the evidence label used for its headline.
 * Verified billed cost wins; otherwise estimates win over an unpriced signal.
 */
export function financialEvidenceForRecords(records: readonly UsageRecord[]): FinancialEvidenceStatus {
  if (records.some((record) => record.costConfidence === "verified" && typeof record.amountUsd === "number")) {
    return "verified";
  }
  if (records.some((record) => record.costConfidence === "estimated" && typeof record.amountUsd === "number")) {
    return "estimated";
  }
  if (records.some((record) => record.costConfidence === "detected_unverified")) {
    return "detected_unverified";
  }
  return "missing";
}

/**
 * Apply the reviewed provider-contract gate before any connected financial
 * calculation. Local transcript evidence is unchanged. When a provider's
 * financial semantics are stale, its priced rows remain present for audit and
 * attribution but cannot carry a dollar amount or proof-level confidence.
 */
export function applyProviderContractGate(
  records: readonly UsageRecord[],
  definitions: readonly SourceStatusDefinition[] = sourceStatusDefinitions
): UsageRecord[] {
  const contractStates = new Map(
    definitions
      .filter((definition) => definition.contractState !== undefined)
      .map((definition) => [definition.id, definition.contractState!])
  );
  return records.map((record) => {
    if (record.providerCostType === "local_agent_logs") return record;
    const sourceId = providerStatusIdForRecord(record);
    if (!sourceId || contractStates.get(sourceId) !== "stale_contract") return record;
    return {
      ...record,
      source: { ...record.source, confidence: "missing" },
      amountUsd: null,
      costConfidence: "missing"
    };
  });
}

/**
 * Project persisted source metadata through the same fail-closed contract
 * gate as records. This is read-time only: the signed local receipt remains
 * byte-exact, while an upgraded release cannot repeat an obsolete verified
 * claim from an older sources.json.
 */
export function applyProviderContractGateToSourceRegistry(
  registry: SourceRegistry,
  definitions: readonly SourceStatusDefinition[] = sourceStatusDefinitions
): SourceRegistry {
  const states = new Map(
    definitions
      .filter((definition) => definition.contractState !== undefined)
      .map((definition) => [definition.id, definition.contractState!])
  );
  return {
    ...registry,
    approvedSources: registry.approvedSources.map((source) => {
      if (source.type !== "provider_api") return source;
      const statusId = providerStatusIdForProvider(source.provider);
      if (!statusId || states.get(statusId) !== "stale_contract") return source;
      const baseScope = source.scope.split(" Last successful pull produced ")[0]?.trim() || source.scope;
      return {
        ...source,
        financialEvidence: "missing",
        fieldsMissing: Array.from(new Set([
          ...source.fieldsMissing,
          "provider financial headline (contract review required)"
        ])),
        scope: `${baseScope} Provider contract drift is unresolved; prior financial evidence and headline are withheld.`
      };
    })
  };
}

function providerStatusIdForRecord(record: UsageRecord): SourceStatusId | undefined {
  if (record.source.provider === "google" && record.agentId === "gemini-cli") return "gemini-cli";
  return providerStatusIdForProvider(record.source.provider);
}

function providerStatusIdForProvider(provider: string | undefined): SourceStatusId | undefined {
  if (provider === "openai") return "openai";
  if (provider === "anthropic") return "anthropic";
  if (provider === "cursor") return "cursor";
  if (provider === "github" || provider === "github-copilot" || provider === "copilot") return "github-copilot";
  if (provider === "google" || provider === "gemini") return "gemini-cli";
  return undefined;
}

/** Stable, plain-text formatter shared by terminal surfaces. */
export function formatSourceStatuses(statuses: readonly SourceStatus[]): string {
  return statuses.map((status) => {
    const freshness = formatFreshness(status.freshness);
    return [
      `${status.label} (${status.id})`,
      `  validation coverage: ${status.validationCoverage}`,
      ...(status.contractState ? [`  provider contract: ${status.contractState}`] : []),
      `  financial evidence: ${status.financialEvidence}`,
      `  freshness: ${freshness}`,
      `  last error: ${status.lastError ? singleLineStatusText(status.lastError) : "none recorded"}`,
      `  validation proof: ${status.validationNote}`,
      `  evidence note: ${status.financialEvidenceNote}`
    ].join("\n");
  }).join("\n\n");
}

function sourceFreshness(
  definition: SourceStatusDefinition,
  observation: SourceStatusObservation | undefined,
  now: Date
): SourceStatusFreshness {
  const checkedAt = validIso(observation?.checkedAt);
  const latestEvidenceAt = validIso(observation?.latestEvidenceAt);
  if (!checkedAt) {
    return {
      status: "not_checked",
      staleAfterHours: definition.staleAfterHours,
      ...(latestEvidenceAt ? { latestEvidenceAt } : {})
    };
  }
  const ageHours = (now.getTime() - Date.parse(checkedAt)) / 3_600_000;
  return {
    status: ageHours > definition.staleAfterHours ? "stale" : "fresh",
    checkedAt,
    ...(latestEvidenceAt ? { latestEvidenceAt } : {}),
    staleAfterHours: definition.staleAfterHours
  };
}

function validIso(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function formatFreshness(freshness: SourceStatusFreshness): string {
  if (freshness.status === "not_checked") return "not_checked (no local check recorded)";
  const latest = freshness.latestEvidenceAt
    ? `; latest evidence ${freshness.latestEvidenceAt}`
    : "; no evidence rows observed";
  return `${freshness.status} (checked ${freshness.checkedAt}${latest}; stale after ${freshness.staleAfterHours}h)`;
}

function singleLineStatusText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "invalid empty error";
}
