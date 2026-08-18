import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createActionVerificationReference,
  parseTokenReductionExperimentV0,
  type TokenReductionExperimentV0
} from "./actionVerification.js";
import {
  MAX_PROJECT_COST_LINES_V0,
  PROJECT_ECONOMICS_RECEIPT_V0_KIND,
  PROJECT_ECONOMICS_V0_VERSION,
  createProjectEconomicsReceiptV0,
  createProjectEconomicsReference,
  parseAcceptedOutcomeV0,
  parseApprovalEventV0,
  parseConfirmedOwnershipV0,
  projectEconomicsReferenceSchema,
  type AcceptedOutcomeV0,
  type ApprovalEventV0,
  type ConfirmedOwnershipV0,
  type ProjectEconomicsReceiptV0
} from "./projectEconomics.js";
import { usageRecordSchema, type UsageRecord } from "./schema.js";

const utcTimestampSchema = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const actionVerificationReferenceSchema = z.string()
  .regex(/^avref_[a-f0-9]{64}$/);
const attributionEvidenceSchema = z.enum([
  "verified",
  "observed",
  "user_declared",
  "missing"
]);

const API_EQUIVALENT_COST_TYPES = new Set([
  "local_agent_logs",
  "anthropic_claude_code_usage",
  "anthropic_claude_code_api_equivalent"
]);

export const projectEconomicsProjectionMissingValues = [
  "confirmed_ownership",
  "ownership_project_scope",
  "token_experiment",
  "experiment_project_scope",
  "experiment_work_unit_scope",
  "intervention_application",
  "approval_event",
  "approval_experiment_link",
  "accepted_outcome",
  "outcome_work_unit_scope",
  "financial_project_attribution",
  "financial_work_unit_attribution",
  "financial_cost_evidence",
  "financial_line_limit",
  "measured_token_result",
  "provider_bill_reconciliation"
] as const;

export type ProjectEconomicsProjectionMissingCodeV0 =
  typeof projectEconomicsProjectionMissingValues[number];

export type ProjectEconomicsProjectionMissingV0 = {
  code: ProjectEconomicsProjectionMissingCodeV0;
  evidence: "missing";
  blocksReceipt: boolean;
};

export type ProjectEconomicsScopeV0 = {
  /** Receipt/accountability reference for the exact project. */
  projectRef: string;
  /** Receipt/accountability reference for the exact accepted work unit. */
  workUnitRef: string;
  /** Action-verification reference for the same exact project. */
  actionProjectRef: string;
  /** Action-verification reference for the same exact accepted work unit. */
  actionWorkUnitRef: string;
};

/**
 * Explicit attribution bridge for one candidate financial record.
 *
 * The builder never hashes or guesses `UsageRecord.projectId` into receipt
 * scope. The caller must supply the already-confirmed opaque references and
 * their evidence labels; unknown attribution remains null + missing.
 */
export type ProjectEconomicsUsageBindingV0 = {
  record: UsageRecord;
  projectRef: string | null;
  projectEvidence: "verified" | "observed" | "user_declared" | "missing";
  workUnitRef: string | null;
  workUnitEvidence: "verified" | "observed" | "user_declared" | "missing";
};

export type BuildProjectEconomicsProjectionV0Input = {
  generatedAt: string;
  scope: ProjectEconomicsScopeV0;
  financialRecords: readonly ProjectEconomicsUsageBindingV0[];
  ownership?: ConfirmedOwnershipV0;
  approvalEvent?: ApprovalEventV0;
  outcome?: AcceptedOutcomeV0;
  tokenExperiment?: TokenReductionExperimentV0;
};

export type ProjectEconomicsProjectionV0 = {
  schemaVersion: 0;
  status: "receipt_ready" | "incomplete";
  generatedAt: string;
  scope: ProjectEconomicsScopeV0;
  costs: ProjectEconomicsReceiptV0["costs"];
  action: {
    wasteFindingRef: string | null;
    tokenExperimentRef: string | null;
    tokenExperimentRevisionRef: string | null;
  };
  measuredTokenResult: ProjectEconomicsReceiptV0["measuredTokenResult"];
  billReconciliation: ProjectEconomicsReceiptV0["billReconciliation"];
  claims: ProjectEconomicsReceiptV0["claims"];
  missing: ProjectEconomicsProjectionMissingV0[];
  receipt: ProjectEconomicsReceiptV0 | null;
};

type ParsedUsageBinding = Omit<ProjectEconomicsUsageBindingV0, "record"> & {
  record: UsageRecord;
};
type CostLine = ProjectEconomicsReceiptV0["costs"]["lines"][number];
type MeasuredTokenResult = ProjectEconomicsReceiptV0["measuredTokenResult"];

export type ProjectEconomicsPlannedActionRefsV0 = {
  changeRef: string;
  rollbackRef: string;
  canaryRef: string;
};

/**
 * Stable pre-change reference for one exact reversible plan. Approval binds
 * the immutable experiment lineage plus the opaque change, rollback, and
 * canary descriptions before the plan is handed to an agent. Timestamps and
 * the eventual canary outcome are deliberately excluded: they are execution
 * evidence, not part of what the human approved.
 */
export function createProjectEconomicsPlannedActionRefV0(
  tokenExperiment: TokenReductionExperimentV0,
  references: ProjectEconomicsPlannedActionRefsV0
): string {
  // This constructor binds only canonical lineage IDs and opaque plan refs.
  // The receipt builder still parses the complete experiment before making
  // any linkage claim; requiring unrelated future experiment fields here
  // would make a pre-change reference depend on post-change evidence.
  const experiment = tokenExperiment;
  if (!/^tre_v0_[a-f0-9]{64}$/.test(experiment.id) ||
      !/^wf_v0_[a-f0-9]{64}$/.test(experiment.finding?.id ?? "")) {
    throw new TypeError(
      "A planned-action reference requires canonical experiment and finding lineage."
    );
  }
  if (experiment.lifecycle !== "baseline_ready" && !hasAppliedIntervention(experiment)) {
    throw new TypeError(
      "A planned-action reference requires a complete baseline or its applied continuation."
    );
  }
  for (const reference of [
    references.changeRef,
    references.rollbackRef,
    references.canaryRef
  ]) {
    if (!/^avref_[a-f0-9]{64}$/.test(reference)) {
      throw new TypeError(
        "A planned-action reference requires opaque change, rollback, and canary references."
      );
    }
  }
  return createActionVerificationReference(
    "project-economics-approved-action",
    JSON.stringify({
      experimentId: experiment.id,
      findingId: experiment.finding.id,
      changeRef: references.changeRef,
      rollbackRef: references.rollbackRef,
      canaryRef: references.canaryRef
    })
  );
}

/**
 * Resolve the same pre-change action reference from its later applied form.
 * Post-change evidence may advance the experiment revision without rewriting
 * the human's earlier approval boundary.
 */
export function createProjectEconomicsApprovalActionRefV0(
  tokenExperiment: TokenReductionExperimentV0
): string {
  const experiment = parseTokenReductionExperimentV0(tokenExperiment);
  if (!hasAppliedIntervention(experiment)) {
    throw new TypeError(
      "An approval action reference requires one explicitly approved, applied intervention."
    );
  }
  return createProjectEconomicsPlannedActionRefV0(experiment, {
    changeRef: experiment.intervention.changeRef!,
    rollbackRef: experiment.intervention.rollbackRef!,
    canaryRef: experiment.intervention.canary!.evidenceRef!
  });
}

/**
 * Build the smallest read-only project-economics view.
 *
 * Invalid or forged supplied contracts throw. Absent evidence and valid but
 * unlinked evidence return an incomplete projection with stable missing codes.
 * No state is written, no native identity is returned, and no ROI, complete
 * invoice reconciliation, or RBAC claim is created.
 */
export function buildProjectEconomicsProjectionV0(
  input: BuildProjectEconomicsProjectionV0Input
): ProjectEconomicsProjectionV0 {
  const generatedAt = utcTimestampSchema.parse(input.generatedAt);
  const scope = parseScope(input.scope);
  const bindings = parseUsageBindings(input.financialRecords);
  const missing = new Set<ProjectEconomicsProjectionMissingCodeV0>();

  const ownership = input.ownership === undefined
    ? undefined
    : parseConfirmedOwnershipV0(input.ownership);
  if (!ownership) missing.add("confirmed_ownership");
  else if (ownership.projectRef !== scope.projectRef) {
    missing.add("ownership_project_scope");
  }

  const experiment = input.tokenExperiment === undefined
    ? undefined
    : parseTokenReductionExperimentV0(input.tokenExperiment);
  if (!experiment) missing.add("token_experiment");

  const experimentProjectExact = experiment?.cohort.projectRef === scope.actionProjectRef;
  if (experiment && !experimentProjectExact) {
    missing.add("experiment_project_scope");
  }
  const experimentWorkUnitExact = experiment
    ? hasExactExperimentWorkUnit(experiment, scope.actionWorkUnitRef)
    : false;
  if (experiment && !experimentWorkUnitExact) {
    missing.add("experiment_work_unit_scope");
  }
  if (experiment && !hasAppliedIntervention(experiment)) {
    missing.add("intervention_application");
  }

  const approvalEvent = input.approvalEvent === undefined
    ? undefined
    : parseApprovalEventV0(input.approvalEvent);
  if (!approvalEvent) missing.add("approval_event");
  else if (!experiment || !approvalLinksExactRevision(approvalEvent, experiment)) {
    missing.add("approval_experiment_link");
  }

  const outcome = input.outcome === undefined
    ? undefined
    : parseAcceptedOutcomeV0(input.outcome);
  if (!outcome) missing.add("accepted_outcome");
  else if (outcome.workUnitRef !== scope.workUnitRef) {
    missing.add("outcome_work_unit_scope");
  }

  const costProjection = buildCostProjection(bindings, scope);
  for (const code of costProjection.missing) missing.add(code);
  if (costProjection.costs.lines.length > MAX_PROJECT_COST_LINES_V0) {
    missing.add("financial_line_limit");
  }

  const exactExperimentScope = Boolean(experimentProjectExact && experimentWorkUnitExact);
  const measuredTokenResult = experiment
    ? projectMeasuredTokenResult(experiment, exactExperimentScope)
    : inconclusiveTokenResult(0, 0);
  if (measuredTokenResult.status === "inconclusive") {
    missing.add("measured_token_result");
  }
  missing.add("provider_bill_reconciliation");

  const billReconciliation = {
    status: "not_attempted" as const,
    evidence: "missing" as const
  };
  const claims = {
    roi: "not_claimed" as const,
    invoiceReconciled: false as const,
    rbacVerified: false as const
  };

  const blocksReceipt = [...missing].some((code) => missingBlocksReceipt(code));
  const canCreateReceipt = !blocksReceipt && ownership !== undefined &&
    experiment !== undefined && approvalEvent !== undefined && outcome !== undefined;
  const receipt = canCreateReceipt
    ? createProjectEconomicsReceiptV0({
        kind: PROJECT_ECONOMICS_RECEIPT_V0_KIND,
        schemaVersion: PROJECT_ECONOMICS_V0_VERSION,
        generatedAt,
        scope: {
          projectRef: scope.projectRef,
          workUnitRef: scope.workUnitRef
        },
        ownership,
        costs: costProjection.costs,
        action: {
          wasteFindingRef: experiment.finding.id,
          tokenExperimentRef: experiment.id,
          tokenExperimentRevisionRef: experiment.revisionId,
          approvalEvent
        },
        outcome,
        measuredTokenResult,
        billReconciliation,
        claims
      })
    : null;

  return {
    schemaVersion: 0,
    status: receipt ? "receipt_ready" : "incomplete",
    generatedAt,
    scope,
    costs: costProjection.costs,
    action: {
      wasteFindingRef: experiment?.finding.id ?? null,
      tokenExperimentRef: experiment?.id ?? null,
      tokenExperimentRevisionRef: experiment?.revisionId ?? null
    },
    measuredTokenResult,
    billReconciliation,
    claims,
    missing: projectEconomicsProjectionMissingValues
      .filter((code) => missing.has(code))
      .map((code) => ({
        code,
        evidence: "missing" as const,
        blocksReceipt: missingBlocksReceipt(code)
      })),
    receipt
  };
}

function parseScope(scope: ProjectEconomicsScopeV0): ProjectEconomicsScopeV0 {
  return {
    projectRef: projectEconomicsReferenceSchema.parse(scope.projectRef),
    workUnitRef: projectEconomicsReferenceSchema.parse(scope.workUnitRef),
    actionProjectRef: actionVerificationReferenceSchema.parse(scope.actionProjectRef),
    actionWorkUnitRef: actionVerificationReferenceSchema.parse(scope.actionWorkUnitRef)
  };
}

function parseUsageBindings(
  bindings: readonly ProjectEconomicsUsageBindingV0[]
): ParsedUsageBinding[] {
  const parsed = bindings.map((binding) => {
    const record = usageRecordSchema.parse(binding.record);
    const projectRef = binding.projectRef === null
      ? null
      : projectEconomicsReferenceSchema.parse(binding.projectRef);
    const workUnitRef = binding.workUnitRef === null
      ? null
      : projectEconomicsReferenceSchema.parse(binding.workUnitRef);
    const projectEvidence = attributionEvidenceSchema.parse(binding.projectEvidence);
    const workUnitEvidence = attributionEvidenceSchema.parse(binding.workUnitEvidence);
    requireReferenceEvidencePair(projectRef, projectEvidence, "project");
    requireReferenceEvidencePair(workUnitRef, workUnitEvidence, "work unit");
    return { record, projectRef, projectEvidence, workUnitRef, workUnitEvidence };
  });
  const ids = new Set<string>();
  for (const binding of parsed) {
    if (ids.has(binding.record.id)) {
      throw new TypeError("Duplicate financial usage record IDs are not allowed.");
    }
    ids.add(binding.record.id);
  }
  return parsed.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

function requireReferenceEvidencePair(
  reference: string | null,
  evidence: ParsedUsageBinding["projectEvidence"],
  label: string
): void {
  if ((reference === null) !== (evidence === "missing")) {
    throw new TypeError(
      `A ${label} reference and non-missing attribution evidence must be present together.`
    );
  }
}

function hasExactExperimentWorkUnit(
  experiment: TokenReductionExperimentV0,
  actionWorkUnitRef: string
): boolean {
  if (experiment.matchingPolicy.basis !== "accepted_work_unit") return false;
  const excludedPostSessions = new Set(experiment.evaluation.exclusions
    .filter((entry) => entry.phase === "post_change")
    .map((entry) => entry.sessionRef));
  // Accepted-work-unit cohorts compare successful tasks, not one PR against
  // itself. Link the receipt's exact accepted outcome to one included post
  // session while allowing the other matched baseline/post outcomes to retain
  // their own opaque work-unit references.
  return experiment.postSessions.some((session) =>
    session.workUnitRef === actionWorkUnitRef &&
    !excludedPostSessions.has(session.sessionRef));
}

function hasAppliedIntervention(experiment: TokenReductionExperimentV0): boolean {
  return experiment.intervention.approval.status === "explicit" &&
    experiment.intervention.approval.evidence !== "missing" &&
    experiment.intervention.approval.approvedAt !== undefined &&
    experiment.intervention.appliedAt !== undefined &&
    experiment.intervention.changeRef !== undefined &&
    experiment.intervention.rollbackRef !== undefined &&
    experiment.intervention.canary?.status !== "missing" &&
    experiment.intervention.canary?.evidenceRef !== undefined;
}

function approvalLinksExactRevision(
  approval: ApprovalEventV0,
  experiment: TokenReductionExperimentV0
): boolean {
  const intervention = experiment.intervention;
  return hasAppliedIntervention(experiment) &&
    approval.references.actionRef === createProjectEconomicsApprovalActionRefV0(experiment) &&
    approval.references.changeRef === intervention.changeRef &&
    approval.references.rollbackRef === intervention.rollbackRef &&
    approval.references.canaryRef === intervention.canary?.evidenceRef &&
    approval.approvedAt === intervention.approval.approvedAt;
}

function buildCostProjection(
  bindings: readonly ParsedUsageBinding[],
  scope: ProjectEconomicsScopeV0
): {
  costs: ProjectEconomicsReceiptV0["costs"];
  missing: Set<ProjectEconomicsProjectionMissingCodeV0>;
} {
  const missing = new Set<ProjectEconomicsProjectionMissingCodeV0>();
  const groups = new Map<string, CostLine & { records: number }>();
  let coveredRecords = 0;

  for (const binding of bindings) {
    const projectExact = binding.projectRef === scope.projectRef;
    const workUnitExact = binding.workUnitRef === scope.workUnitRef;
    if (!projectExact) missing.add("financial_project_attribution");
    if (!workUnitExact) missing.add("financial_work_unit_attribution");

    const classification = projectExact && workUnitExact
      ? classifyFinancialRecord(binding.record)
      : missingCostLine(binding.record);
    if (classification.basis === "missing") {
      missing.add("financial_cost_evidence");
    } else {
      coveredRecords += 1;
    }

    const key = `${classification.sourceRef}\u0000${classification.basis}\u0000${classification.evidence}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...classification, records: 1 });
      continue;
    }
    if (classification.amountUsd === null || current.amountUsd === null) {
      if (classification.amountUsd !== current.amountUsd) {
        throw new TypeError("A financial cost group cannot mix missing and present amounts.");
      }
      current.records += 1;
      continue;
    }
    const amountUsd = current.amountUsd + classification.amountUsd;
    if (!Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new TypeError("A financial cost line total must remain finite and non-negative.");
    }
    current.amountUsd = Object.is(amountUsd, -0) ? 0 : amountUsd;
    current.records += 1;
  }

  if (bindings.length === 0 || coveredRecords === 0) {
    missing.add("financial_cost_evidence");
  }
  const status = bindings.length === 0 || coveredRecords === 0
    ? "missing" as const
    : coveredRecords === bindings.length ? "complete" as const : "partial" as const;
  return {
    costs: {
      lines: [...groups.values()]
        .map(({ records: _records, ...line }) => line)
        .sort((left, right) => costLineKey(left).localeCompare(costLineKey(right))),
      coverage: {
        status,
        coveredRecords,
        eligibleRecords: bindings.length,
        evidence: status === "missing" ? "missing" : "calculated"
      }
    },
    missing
  };
}

function classifyFinancialRecord(record: UsageRecord): CostLine {
  const sourceRef = costSourceRef(record);
  if (isBundledSampleRecord(record) || record.amountUsd === null ||
      record.costConfidence === "missing" ||
      record.costConfidence === "detected_unverified" ||
      record.source.confidence === "missing" ||
      record.source.confidence === "detected_unverified") {
    return { sourceRef, basis: "missing", amountUsd: null, evidence: "missing" };
  }
  if (record.costConfidence === "verified" &&
      record.source.confidence === "verified" &&
      !API_EQUIVALENT_COST_TYPES.has(record.providerCostType ?? "") &&
      record.usageGranularity === "billing_bucket") {
    return {
      sourceRef,
      basis: "provider_billed",
      amountUsd: record.amountUsd,
      evidence: "verified"
    };
  }
  if (record.costConfidence === "estimated" &&
      API_EQUIVALENT_COST_TYPES.has(record.providerCostType ?? "")) {
    return {
      sourceRef,
      basis: "api_equivalent_estimate",
      amountUsd: record.amountUsd,
      evidence: "calculated"
    };
  }
  return { sourceRef, basis: "missing", amountUsd: null, evidence: "missing" };
}

function missingCostLine(record: UsageRecord): CostLine {
  return {
    sourceRef: costSourceRef(record),
    basis: "missing",
    amountUsd: null,
    evidence: "missing"
  };
}

function isBundledSampleRecord(record: UsageRecord): boolean {
  return record.source.observedFrom === "sample_csv" &&
    /(?:^|-)sample$/i.test(record.source.id);
}

function costSourceRef(record: UsageRecord): string {
  const sourceIdentity = JSON.stringify([
    record.source.id,
    record.source.name,
    record.source.provider,
    record.source.observedFrom,
    record.providerCostType ?? null,
    record.usageGranularity ?? null
  ]);
  const digest = createHash("sha256").update(sourceIdentity).digest("hex");
  return createProjectEconomicsReference("cost-source", digest);
}

function costLineKey(line: CostLine): string {
  return `${line.sourceRef}\u0000${line.basis}\u0000${line.evidence}\u0000${line.amountUsd ?? ""}`;
}

function projectMeasuredTokenResult(
  experiment: TokenReductionExperimentV0,
  exactScope: boolean
): MeasuredTokenResult {
  const evaluation = experiment.evaluation;
  if (!exactScope || !isConclusiveReceiptStatus(evaluation.status) ||
      evaluation.metricEvidence !== "calculated" ||
      evaluation.baseline.medianTotalTokens === null ||
      evaluation.postChange.medianTotalTokens === null ||
      evaluation.reductionPercent === null ||
      evaluation.matchingEvidence === "missing" ||
      evaluation.qualityEvidence === "missing") {
    return inconclusiveTokenResult(
      evaluation.baseline.includedSessions,
      evaluation.postChange.includedSessions
    );
  }
  return {
    status: evaluation.status,
    baselineMedianTokens: evaluation.baseline.medianTotalTokens,
    postChangeMedianTokens: evaluation.postChange.medianTotalTokens,
    baselineSessions: evaluation.baseline.includedSessions,
    postChangeSessions: evaluation.postChange.includedSessions,
    reductionPercent: evaluation.reductionPercent,
    metricEvidence: "calculated",
    matchingEvidence: evaluation.matchingEvidence,
    qualityStatus: evaluation.qualityStatus,
    qualityEvidence: evaluation.qualityEvidence
  };
}

function isConclusiveReceiptStatus(
  status: TokenReductionExperimentV0["evaluation"]["status"]
): status is Exclude<MeasuredTokenResult["status"], "inconclusive"> {
  return status === "measured_token_reduction" ||
    status === "no_measured_change" || status === "regressed";
}

function inconclusiveTokenResult(
  baselineSessions: number,
  postChangeSessions: number
): MeasuredTokenResult {
  return {
    status: "inconclusive",
    baselineMedianTokens: null,
    postChangeMedianTokens: null,
    baselineSessions,
    postChangeSessions,
    reductionPercent: null,
    metricEvidence: "missing",
    matchingEvidence: "missing",
    qualityStatus: "insufficient",
    qualityEvidence: "missing"
  };
}

function missingBlocksReceipt(code: ProjectEconomicsProjectionMissingCodeV0): boolean {
  switch (code) {
    case "confirmed_ownership":
    case "ownership_project_scope":
    case "token_experiment":
    case "experiment_project_scope":
    case "experiment_work_unit_scope":
    case "intervention_application":
    case "approval_event":
    case "approval_experiment_link":
    case "accepted_outcome":
    case "outcome_work_unit_scope":
    case "financial_line_limit":
      return true;
    case "financial_project_attribution":
    case "financial_work_unit_attribution":
    case "financial_cost_evidence":
    case "measured_token_result":
    case "provider_bill_reconciliation":
      return false;
  }
}
