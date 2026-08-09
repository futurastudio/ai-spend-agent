import type { CostConfidence, UsageRecord } from "./schema.js";

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

export type SourceStatusId =
  | "claude-code"
  | "codex"
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
  freshness: SourceStatusFreshness;
  lastError?: string;
};

/**
 * Shipped validation matrix. Keep these claims proof-conservative: a live
 * authentication check is not the same as a non-empty end-to-end billing
 * reconciliation.
 */
export const sourceStatusDefinitions: readonly SourceStatusDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code local logs",
    validationCoverage: "live_verified",
    validationNote: "Local transcript parsing is exercised against live logs; dollar values remain API-rate estimates.",
    staleAfterHours: 72
  },
  {
    id: "codex",
    label: "Codex local logs",
    validationCoverage: "live_verified",
    validationNote: "Local parsing was replayed against live logs; total-only token shapes and unknown aliases remain missing rather than becoming estimated $0.",
    staleAfterHours: 72
  },
  {
    id: "openai",
    label: "OpenAI Costs and Usage API",
    validationCoverage: "live_verified",
    validationNote: "Product connector QA exercised non-empty Admin cost and usage API paths; the tested Costs total reconciled to invoiced API credits less the provider-UI balance with $0.00 variance. This does not reconcile the current user's account; final invoices, tax, discounts, and later adjustments remain separate.",
    staleAfterHours: 48
  },
  {
    id: "anthropic",
    label: "Anthropic Cost Report and Claude Code Analytics",
    validationCoverage: "live_verified",
    validationNote: "Admin cost and Claude Code usage paths are exercised with non-empty live records.",
    staleAfterHours: 48
  },
  {
    id: "cursor",
    label: "Cursor Admin API",
    validationCoverage: "fixture_verified",
    validationNote: "Canonical teamMemberSpend envelopes, totalPages pagination, completeness failures, and malformed responses pass recorded fixtures; live account QA is pending.",
    staleAfterHours: 48
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot organization APIs",
    validationCoverage: "fixture_verified",
    validationNote: "The 2026-03-10 signed-NDJSON metrics workflow, seat pagination, per-seat plan types, and failure paths pass recorded fixtures; live account QA is pending.",
    staleAfterHours: 48
  }
];

export function buildSourceStatuses(
  observations: readonly SourceStatusObservation[] = [],
  now = new Date()
): SourceStatus[] {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  return sourceStatusDefinitions.map((definition) => {
    const observation = byId.get(definition.id);
    return {
      id: definition.id,
      label: definition.label,
      validationCoverage: observation?.validationCoverage ?? definition.validationCoverage,
      validationNote: definition.validationNote,
      financialEvidence: observation?.financialEvidence ?? "missing",
      financialEvidenceNote: observation?.financialEvidenceNote ?? "No current financial evidence was observed on this machine.",
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

/** Stable, plain-text formatter shared by terminal surfaces. */
export function formatSourceStatuses(statuses: readonly SourceStatus[]): string {
  return statuses.map((status) => {
    const freshness = formatFreshness(status.freshness);
    return [
      `${status.label} (${status.id})`,
      `  validation coverage: ${status.validationCoverage}`,
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
