import { createHash } from "node:crypto";
import { z } from "zod";

export const OWNERSHIP_SUGGESTION_V0_KIND = "aibill.ownership_suggestion" as const;
export const CONFIRMED_OWNERSHIP_V0_KIND = "aibill.confirmed_ownership" as const;
export const APPROVAL_EVENT_V0_KIND = "aibill.approval_event" as const;
export const ACCEPTED_OUTCOME_V0_KIND = "aibill.accepted_outcome" as const;
export const PROJECT_ECONOMICS_RECEIPT_V0_KIND =
  "aibill.project_economics_receipt" as const;
export const PROJECT_ECONOMICS_V0_VERSION = "0.1.0" as const;

export const MAX_APPROVAL_EVENTS_V0 = 256;
export const MAX_OUTCOME_CHECK_REFS_V0 = 64;
export const MAX_PROJECT_COST_LINES_V0 = 32;

const utcTimestampSchema = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const finiteUsdSchema = z.number().finite().nonnegative()
  .transform((value) => Object.is(value, -0) ? 0 : value);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percentageSchema = z.number().finite().min(0).max(100)
  .transform((value) => roundPercent(value));
const boundedIdentifierSchema = z.string()
  .min(1)
  .max(96)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Expected a path-free, control-free identifier."
  )
  .superRefine((value, context) => {
    if (/^(?:sk-|sk_|gh[pousr]_|github_pat_|npm_|AIza|xox[baprs]-|glpat-|AKIA)/i
      .test(value) || /^(?:env|keychain|secret|credential):/i.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Credential-like values are not project-economics identifiers."
      });
    }
  });

/** Opaque privacy-reduced reference; the source-native value is never persisted. */
export const projectEconomicsReferenceSchema = z.string()
  .regex(/^peref_[a-f0-9]{64}$/);
const actionVerificationReferenceSchema = z.string()
  .regex(/^avref_[a-f0-9]{64}$/);
const wasteFindingReferenceSchema = z.string()
  .regex(/^wf_v0_[a-f0-9]{64}$/);
const tokenExperimentReferenceSchema = z.string()
  .regex(/^tre_v0_[a-f0-9]{64}$/);
const tokenExperimentRevisionReferenceSchema = z.string()
  .regex(/^trev_v0_[a-f0-9]{64}$/);
const ownershipSuggestionIdSchema = z.string()
  .regex(/^owns_v0_[a-f0-9]{64}$/);
const confirmedOwnershipIdSchema = z.string()
  .regex(/^ownc_v0_[a-f0-9]{64}$/);
const approvalEventIdSchema = z.string()
  .regex(/^ape_v0_[a-f0-9]{64}$/);
const acceptedOutcomeIdSchema = z.string()
  .regex(/^aco_v0_[a-f0-9]{64}$/);
const projectEconomicsReceiptIdSchema = z.string()
  .regex(/^per_v0_[a-f0-9]{64}$/);

export const projectEconomicsEvidenceValues = [
  "verified",
  "observed",
  "calculated",
  "user_declared",
  "modeled",
  "missing"
] as const;
export const projectEconomicsEvidenceSchema = z.enum(
  projectEconomicsEvidenceValues
);
export type ProjectEconomicsEvidence = z.infer<
  typeof projectEconomicsEvidenceSchema
>;

const ownershipSuggestionBodySchema = z.object({
  kind: z.literal(OWNERSHIP_SUGGESTION_V0_KIND),
  schemaVersion: z.literal(PROJECT_ECONOMICS_V0_VERSION),
  status: z.literal("suggested"),
  generatedAt: utcTimestampSchema,
  projectRef: projectEconomicsReferenceSchema,
  suggestedHumanRef: projectEconomicsReferenceSchema.optional(),
  suggestedTeamRef: projectEconomicsReferenceSchema.optional(),
  suggestedClientRef: projectEconomicsReferenceSchema.optional(),
  suggestedCostCenterRef: projectEconomicsReferenceSchema.optional(),
  source: z.enum(["git_metadata", "codeowners", "repository_metadata"]),
  evidence: z.literal("observed"),
  requiresUserConfirmation: z.literal(true)
}).strict().superRefine((suggestion, context) => {
  if (!suggestion.suggestedHumanRef && !suggestion.suggestedTeamRef &&
      !suggestion.suggestedClientRef && !suggestion.suggestedCostCenterRef) {
    context.addIssue({
      code: "custom",
      message: "An ownership suggestion must contain at least one suggested reference."
    });
  }
});

export type OwnershipSuggestionV0DraftInput = z.input<
  typeof ownershipSuggestionBodySchema
>;
export const ownershipSuggestionV0Schema = ownershipSuggestionBodySchema.extend({
  id: ownershipSuggestionIdSchema
});
export type OwnershipSuggestionV0 = z.infer<typeof ownershipSuggestionV0Schema>;

const confirmedOwnershipBodySchema = z.object({
  kind: z.literal(CONFIRMED_OWNERSHIP_V0_KIND),
  schemaVersion: z.literal(PROJECT_ECONOMICS_V0_VERSION),
  status: z.literal("confirmed"),
  projectRef: projectEconomicsReferenceSchema,
  humanOwnerRef: projectEconomicsReferenceSchema,
  teamRef: projectEconomicsReferenceSchema,
  clientRef: projectEconomicsReferenceSchema.optional(),
  costCenterRef: projectEconomicsReferenceSchema.optional(),
  confirmation: z.object({
    evidence: z.literal("user_declared"),
    confirmedAt: utcTimestampSchema,
    confirmedByRef: projectEconomicsReferenceSchema,
    locallyStored: z.literal(true)
  }).strict()
}).strict();

export type ConfirmedOwnershipV0DraftInput = z.input<
  typeof confirmedOwnershipBodySchema
>;
export const confirmedOwnershipV0Schema = confirmedOwnershipBodySchema.extend({
  id: confirmedOwnershipIdSchema
});
export type ConfirmedOwnershipV0 = z.infer<typeof confirmedOwnershipV0Schema>;

const approvalEventBodySchema = z.object({
  kind: z.literal(APPROVAL_EVENT_V0_KIND),
  schemaVersion: z.literal(PROJECT_ECONOMICS_V0_VERSION),
  sequence: z.number().int().min(0).max(MAX_APPROVAL_EVENTS_V0 - 1),
  previousEventId: approvalEventIdSchema.nullable(),
  approvedAt: utcTimestampSchema,
  decision: z.literal("approved"),
  attestation: z.object({
    scope: z.literal("local_self_attested"),
    evidence: z.literal("user_declared"),
    approverIdentityRef: projectEconomicsReferenceSchema,
    approverRoleRef: projectEconomicsReferenceSchema,
    rbacVerified: z.literal(false)
  }).strict(),
  references: z.object({
    actionRef: actionVerificationReferenceSchema,
    changeRef: actionVerificationReferenceSchema,
    rollbackRef: actionVerificationReferenceSchema,
    canaryRef: actionVerificationReferenceSchema
  }).strict()
}).strict().superRefine((event, context) => {
  if ((event.sequence === 0) !== (event.previousEventId === null)) {
    context.addIssue({
      code: "custom",
      path: ["previousEventId"],
      message: "Only the first approval event may omit a previous event ID."
    });
  }
});

export type ApprovalEventV0DraftInput = z.input<typeof approvalEventBodySchema>;
export const approvalEventV0Schema = approvalEventBodySchema.extend({
  id: approvalEventIdSchema
});
export type ApprovalEventV0 = z.infer<typeof approvalEventV0Schema>;

const businessDescriptionSchema = z.object({
  value: z.string().trim().min(1).max(240)
    .refine(
      (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
        !hasUnpairedSurrogate(value),
      "Business descriptions must be bounded, control-free valid Unicode."
    ),
  evidence: z.literal("user_declared")
}).strict();

const acceptedOutcomeBodySchema = z.object({
  kind: z.literal(ACCEPTED_OUTCOME_V0_KIND),
  schemaVersion: z.literal(PROJECT_ECONOMICS_V0_VERSION),
  platform: z.literal("github"),
  outcomeType: z.enum(["pull_request", "task"]),
  repositoryRef: projectEconomicsReferenceSchema,
  workUnitRef: projectEconomicsReferenceSchema,
  state: z.enum(["merged", "accepted"]),
  stateEvidence: z.enum(["verified", "observed", "user_declared"]),
  acceptedAt: utcTimestampSchema,
  commit: z.object({
    commitRef: projectEconomicsReferenceSchema,
    evidence: z.enum(["verified", "observed"])
  }).strict(),
  // `passed` means every status check represented by these evidence refs
  // passed. It does not assert that branch-protection requirements were read.
  checks: z.object({
    status: z.literal("passed"),
    evidence: z.enum(["verified", "observed"]),
    evidenceRefs: z.array(projectEconomicsReferenceSchema)
      .min(1)
      .max(MAX_OUTCOME_CHECK_REFS_V0)
  }).strict(),
  businessDescription: businessDescriptionSchema.optional()
}).strict().superRefine((outcome, context) => {
  if (outcome.outcomeType === "pull_request" && outcome.state !== "merged") {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "An accepted GitHub pull-request outcome must be merged."
    });
  }
  if (outcome.outcomeType === "task" && outcome.state !== "accepted") {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "An accepted GitHub task outcome must be accepted."
    });
  }
  if (outcome.outcomeType === "pull_request" &&
      outcome.stateEvidence === "user_declared") {
    context.addIssue({
      code: "custom",
      path: ["stateEvidence"],
      message: "A merged pull request requires observed or verified GitHub state."
    });
  }
});

export type AcceptedOutcomeV0DraftInput = z.input<
  typeof acceptedOutcomeBodySchema
>;
export const acceptedOutcomeV0Schema = acceptedOutcomeBodySchema.extend({
  id: acceptedOutcomeIdSchema
});
export type AcceptedOutcomeV0 = z.infer<typeof acceptedOutcomeV0Schema>;

export const projectCostBasisValues = [
  "provider_billed",
  "subscription_included",
  "api_equivalent_estimate",
  "user_declared",
  "missing"
] as const;
export const projectCostBasisSchema = z.enum(projectCostBasisValues);
export type ProjectCostBasis = z.infer<typeof projectCostBasisSchema>;

const costLineSchema = z.object({
  sourceRef: projectEconomicsReferenceSchema,
  basis: projectCostBasisSchema,
  amountUsd: finiteUsdSchema.nullable(),
  evidence: projectEconomicsEvidenceSchema
}).strict().superRefine((line, context) => {
  if ((line.basis === "missing") !== (line.amountUsd === null)) {
    context.addIssue({
      code: "custom",
      path: ["amountUsd"],
      message: "Only a missing cost basis may omit its amount."
    });
  }
  const allowed: Record<ProjectCostBasis, readonly ProjectEconomicsEvidence[]> = {
    provider_billed: ["verified"],
    subscription_included: ["observed", "user_declared"],
    api_equivalent_estimate: ["calculated", "modeled"],
    user_declared: ["user_declared"],
    missing: ["missing"]
  };
  if (!allowed[line.basis].includes(line.evidence)) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: `Evidence ${line.evidence} cannot support the ${line.basis} cost basis.`
    });
  }
});

const costCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "missing"]),
  coveredRecords: countSchema,
  eligibleRecords: countSchema,
  evidence: z.enum(["verified", "observed", "calculated", "missing"])
}).strict().superRefine((coverage, context) => {
  if (coverage.coveredRecords > coverage.eligibleRecords) {
    context.addIssue({
      code: "custom",
      path: ["coveredRecords"],
      message: "Covered records cannot exceed eligible records."
    });
  }
  const expectedStatus = coverage.eligibleRecords === 0 || coverage.coveredRecords === 0
    ? "missing"
    : coverage.coveredRecords === coverage.eligibleRecords ? "complete" : "partial";
  if (coverage.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Coverage status must be derived from covered and eligible records."
    });
  }
  if ((coverage.status === "missing") !== (coverage.evidence === "missing")) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "Missing coverage must use missing evidence, and present coverage must not."
    });
  }
});

const measuredTokenResultSchema = z.object({
  status: z.enum([
    "measured_token_reduction",
    "no_measured_change",
    "regressed",
    "inconclusive"
  ]),
  baselineMedianTokens: z.number().finite().nonnegative().nullable(),
  postChangeMedianTokens: z.number().finite().nonnegative().nullable(),
  baselineSessions: countSchema,
  postChangeSessions: countSchema,
  reductionPercent: z.number().finite().nullable(),
  metricEvidence: z.enum(["calculated", "missing"]),
  matchingEvidence: z.enum(["verified", "observed", "user_declared", "missing"]),
  qualityStatus: z.enum(["held", "regressed", "insufficient"]),
  qualityEvidence: z.enum(["verified", "observed", "user_declared", "missing"])
}).strict().superRefine((result, context) => {
  const measured = result.status !== "inconclusive";
  const numeric = result.baselineMedianTokens !== null &&
    result.postChangeMedianTokens !== null && result.reductionPercent !== null;
  if (measured !== numeric || measured !== (result.metricEvidence === "calculated")) {
    context.addIssue({
      code: "custom",
      message: "A conclusive token result requires calculated baseline, post-change, and percentage evidence."
    });
    return;
  }
  if (!measured) {
    if (result.matchingEvidence !== "missing" || result.qualityStatus !== "insufficient" ||
        result.qualityEvidence !== "missing") {
      context.addIssue({
        code: "custom",
        message: "An inconclusive result must not imply matching or quality evidence."
      });
    }
    return;
  }
  const baselineMedianTokens = result.baselineMedianTokens;
  const postChangeMedianTokens = result.postChangeMedianTokens;
  const reductionPercent = result.reductionPercent;
  if (baselineMedianTokens === null || postChangeMedianTokens === null ||
      reductionPercent === null) return;
  if (result.baselineSessions < 1 || result.postChangeSessions < 1 ||
      result.matchingEvidence === "missing" || result.qualityEvidence === "missing") {
    context.addIssue({
      code: "custom",
      message: "A conclusive result requires matched sessions and non-missing quality evidence."
    });
  }
  const expected = baselineMedianTokens === 0
    ? null
    : roundPercent(100 *
      (baselineMedianTokens - postChangeMedianTokens) /
      baselineMedianTokens);
  if (expected === null || reductionPercent !== expected) {
    context.addIssue({
      code: "custom",
      path: ["reductionPercent"],
      message: "The token reduction percentage must match the supplied medians."
    });
  }
  if (result.status === "measured_token_reduction" &&
      (!(reductionPercent > 0) || result.qualityStatus !== "held")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "A reduction claim requires a positive measured percentage and held quality."
    });
  }
  if (result.status === "no_measured_change" &&
      (reductionPercent !== 0 || result.qualityStatus !== "held")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "No measured change requires zero reduction and held quality."
    });
  }
  if (result.status === "regressed" &&
      !(reductionPercent < 0 || result.qualityStatus === "regressed")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "A regression requires higher token use or regressed quality."
    });
  }
});

const billReconciliationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("not_attempted"),
    evidence: z.literal("missing")
  }).strict(),
  z.object({
    status: z.literal("partial"),
    evidence: z.literal("verified"),
    providerBillRef: projectEconomicsReferenceSchema,
    coveragePercent: percentageSchema,
    matchedAmountUsd: finiteUsdSchema,
    varianceUsd: z.number().finite().optional()
  }).strict().superRefine((reconciliation, context) => {
    if (reconciliation.coveragePercent >= 100) {
      context.addIssue({
        code: "custom",
        path: ["coveragePercent"],
        message: "Receipt V0 only represents partial provider-bill matching below complete coverage."
      });
    }
  })
]);

const projectEconomicsReceiptBodySchema = z.object({
  kind: z.literal(PROJECT_ECONOMICS_RECEIPT_V0_KIND),
  schemaVersion: z.literal(PROJECT_ECONOMICS_V0_VERSION),
  generatedAt: utcTimestampSchema,
  scope: z.object({
    projectRef: projectEconomicsReferenceSchema,
    workUnitRef: projectEconomicsReferenceSchema
  }).strict(),
  ownership: confirmedOwnershipV0Schema,
  costs: z.object({
    lines: z.array(costLineSchema).max(MAX_PROJECT_COST_LINES_V0),
    coverage: costCoverageSchema
  }).strict(),
  action: z.object({
    wasteFindingRef: wasteFindingReferenceSchema,
    tokenExperimentRef: tokenExperimentReferenceSchema,
    tokenExperimentRevisionRef: tokenExperimentRevisionReferenceSchema,
    approvalEvent: approvalEventV0Schema
  }).strict(),
  outcome: acceptedOutcomeV0Schema,
  measuredTokenResult: measuredTokenResultSchema,
  billReconciliation: billReconciliationSchema,
  claims: z.object({
    roi: z.literal("not_claimed"),
    invoiceReconciled: z.literal(false),
    rbacVerified: z.literal(false)
  }).strict()
}).strict().superRefine((receipt, context) => {
  if (receipt.ownership.projectRef !== receipt.scope.projectRef) {
    context.addIssue({
      code: "custom",
      path: ["ownership", "projectRef"],
      message: "Confirmed ownership must belong to the receipt project."
    });
  }
  if (receipt.outcome.workUnitRef !== receipt.scope.workUnitRef) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "workUnitRef"],
      message: "The accepted outcome must belong to the receipt work unit."
    });
  }
  if (receipt.action.approvalEvent.approvedAt > receipt.generatedAt ||
      receipt.outcome.acceptedAt > receipt.generatedAt) {
    context.addIssue({
      code: "custom",
      path: ["generatedAt"],
      message: "A receipt cannot predate its approval or accepted outcome."
    });
  }
  if (receipt.costs.coverage.status !== "missing" && receipt.costs.lines.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["costs", "lines"],
      message: "Present cost coverage requires at least one classified cost line."
    });
  }
});

export type ProjectEconomicsReceiptV0DraftInput = z.input<
  typeof projectEconomicsReceiptBodySchema
>;
export const projectEconomicsReceiptV0Schema = projectEconomicsReceiptBodySchema.extend({
  id: projectEconomicsReceiptIdSchema
});
export type ProjectEconomicsReceiptV0 = z.infer<
  typeof projectEconomicsReceiptV0Schema
>;

export function createProjectEconomicsReference(
  namespace: string,
  sourceNativeValue: string
): string {
  const safeNamespace = boundedIdentifierSchema.parse(namespace);
  if (sourceNativeValue.length < 1 || sourceNativeValue.length > 4_096 ||
      hasUnpairedSurrogate(sourceNativeValue)) {
    throw new TypeError(
      "Project economics references require bounded valid Unicode source values."
    );
  }
  return `peref_${createHash("sha256")
    .update(`${safeNamespace}\u0000${sourceNativeValue}`)
    .digest("hex")}`;
}

export function createOwnershipSuggestionV0(
  input: OwnershipSuggestionV0DraftInput
): OwnershipSuggestionV0 {
  const body = ownershipSuggestionBodySchema.parse(input);
  return ownershipSuggestionV0Schema.parse({
    ...body,
    id: digest("owns_v0", body)
  });
}

export function parseOwnershipSuggestionV0(value: unknown): OwnershipSuggestionV0 {
  return parseContentAddressed(
    value,
    ownershipSuggestionV0Schema,
    ownershipSuggestionBodySchema,
    "owns_v0",
    "Ownership suggestion"
  );
}

export function createConfirmedOwnershipV0(
  input: ConfirmedOwnershipV0DraftInput
): ConfirmedOwnershipV0 {
  const body = confirmedOwnershipBodySchema.parse(input);
  return confirmedOwnershipV0Schema.parse({
    ...body,
    id: digest("ownc_v0", body)
  });
}

export function parseConfirmedOwnershipV0(value: unknown): ConfirmedOwnershipV0 {
  return parseContentAddressed(
    value,
    confirmedOwnershipV0Schema,
    confirmedOwnershipBodySchema,
    "ownc_v0",
    "Confirmed ownership"
  );
}

export function createApprovalEventV0(
  input: ApprovalEventV0DraftInput
): ApprovalEventV0 {
  const body = approvalEventBodySchema.parse(input);
  return approvalEventV0Schema.parse({ ...body, id: digest("ape_v0", body) });
}

export function parseApprovalEventV0(value: unknown): ApprovalEventV0 {
  return parseContentAddressed(
    value,
    approvalEventV0Schema,
    approvalEventBodySchema,
    "ape_v0",
    "Approval event"
  );
}

/**
 * Append one event without mutating history. Sequence, previous digest, and
 * monotonic time are derived from the already-validated append-only chain.
 */
export function appendApprovalEventV0(
  history: readonly ApprovalEventV0[],
  input: Omit<ApprovalEventV0DraftInput, "sequence" | "previousEventId">
): ApprovalEventV0[] {
  if (history.length >= MAX_APPROVAL_EVENTS_V0) {
    throw new TypeError("Approval history exceeds the V0 event limit.");
  }
  const parsedHistory = history.map(parseApprovalEventV0);
  for (let index = 0; index < parsedHistory.length; index += 1) {
    const event = parsedHistory[index]!;
    if (event.sequence !== index || event.previousEventId !==
      (index === 0 ? null : parsedHistory[index - 1]!.id)) {
      throw new TypeError("Approval history is not one append-only digest chain.");
    }
  }
  const previous = parsedHistory.at(-1);
  const next = createApprovalEventV0({
    ...input,
    sequence: parsedHistory.length,
    previousEventId: previous?.id ?? null
  });
  if (previous && Date.parse(next.approvedAt) < Date.parse(previous.approvedAt)) {
    throw new TypeError("An appended approval event cannot predate its predecessor.");
  }
  return [...parsedHistory, next];
}

export function createAcceptedOutcomeV0(
  input: AcceptedOutcomeV0DraftInput
): AcceptedOutcomeV0 {
  const body = canonicalOutcomeBody(acceptedOutcomeBodySchema.parse(input));
  return acceptedOutcomeV0Schema.parse({ ...body, id: digest("aco_v0", body) });
}

export function parseAcceptedOutcomeV0(value: unknown): AcceptedOutcomeV0 {
  const parsed = acceptedOutcomeV0Schema.parse(value);
  const { id, ...bodyInput } = parsed;
  const body = canonicalOutcomeBody(acceptedOutcomeBodySchema.parse(bodyInput));
  if (id !== digest("aco_v0", body)) {
    throw new TypeError("Accepted outcome ID does not match its canonical body.");
  }
  return acceptedOutcomeV0Schema.parse({ ...body, id });
}

export function createProjectEconomicsReceiptV0(
  input: ProjectEconomicsReceiptV0DraftInput
): ProjectEconomicsReceiptV0 {
  const body = canonicalReceiptBody(projectEconomicsReceiptBodySchema.parse(input));
  return projectEconomicsReceiptV0Schema.parse({
    ...body,
    id: digest("per_v0", body)
  });
}

export function parseProjectEconomicsReceiptV0(
  value: unknown
): ProjectEconomicsReceiptV0 {
  const parsed = projectEconomicsReceiptV0Schema.parse(value);
  const { id, ...bodyInput } = parsed;
  const body = canonicalReceiptBody(projectEconomicsReceiptBodySchema.parse(bodyInput));
  if (id !== digest("per_v0", body)) {
    throw new TypeError("Project economics receipt ID does not match its canonical body.");
  }
  return projectEconomicsReceiptV0Schema.parse({ ...body, id });
}

/** Stable one-line JSON for local persistence or transport. */
export function serializeProjectEconomicsReceiptV0(
  receipt: ProjectEconomicsReceiptV0
): string {
  return canonicalJson(parseProjectEconomicsReceiptV0(receipt));
}

export function deserializeProjectEconomicsReceiptV0(
  serialized: string
): ProjectEconomicsReceiptV0 {
  if (serialized.length < 2 || serialized.length > 1_000_000 ||
      hasUnpairedSurrogate(serialized)) {
    throw new TypeError("Serialized project economics receipts must be bounded valid JSON.");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TypeError("Serialized project economics receipt is not valid JSON.");
  }
  return parseProjectEconomicsReceiptV0(value);
}

function canonicalOutcomeBody(
  outcome: z.infer<typeof acceptedOutcomeBodySchema>
): z.infer<typeof acceptedOutcomeBodySchema> {
  return {
    ...outcome,
    checks: {
      ...outcome.checks,
      evidenceRefs: [...outcome.checks.evidenceRefs].sort(compareText)
    }
  };
}

function canonicalReceiptBody(
  receipt: z.infer<typeof projectEconomicsReceiptBodySchema>
): z.infer<typeof projectEconomicsReceiptBodySchema> {
  return {
    ...receipt,
    ownership: parseConfirmedOwnershipV0(receipt.ownership),
    action: {
      ...receipt.action,
      approvalEvent: parseApprovalEventV0(receipt.action.approvalEvent)
    },
    outcome: parseAcceptedOutcomeV0(receipt.outcome),
    costs: {
      ...receipt.costs,
      lines: [...receipt.costs.lines].sort((left, right) =>
        compareText(canonicalJson(left), canonicalJson(right)))
    }
  };
}

function parseContentAddressed<
  TObject extends { id: string },
  TBody extends object
>(
  value: unknown,
  objectSchema: z.ZodType<TObject>,
  bodySchema: z.ZodType<TBody>,
  prefix: string,
  label: string
): TObject {
  const parsed = objectSchema.parse(value);
  const { id, ...bodyInput } = parsed;
  const body = bodySchema.parse(bodyInput);
  if (id !== digest(prefix, body)) {
    throw new TypeError(`${label} ID does not match its canonical body.`);
  }
  return objectSchema.parse({ ...body, id });
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function roundPercent(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical values must be finite.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical values must be JSON data.");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
