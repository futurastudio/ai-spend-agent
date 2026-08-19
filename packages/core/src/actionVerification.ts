import { createHash } from "node:crypto";
import { z } from "zod";
import { sourceValidationCoverageValues } from "./sourceStatus.js";

export const WASTE_FINDING_V0_KIND = "aibill.waste_finding" as const;
export const WASTE_FINDING_V0_VERSION = "0.1.0" as const;
export const TOKEN_REDUCTION_EXPERIMENT_V0_KIND =
  "aibill.token_reduction_experiment" as const;
export const TOKEN_REDUCTION_EXPERIMENT_V0_VERSION = "0.1.0" as const;
export const MAX_WASTE_FINDING_EVIDENCE_REFS_V0 = 256;
export const MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0 = 256;

export const wasteFindingTypeValues = [
  "configured_not_observed",
  "repeated_context_read",
  "compaction_pressure",
  "high_context_relative_to_baseline",
  "cumulative_context_exposure"
] as const;
export type WasteFindingType = typeof wasteFindingTypeValues[number];

export const wasteCandidateActionValues = [
  "inspect_scope",
  "lazy_load",
  "disable",
  "remove",
  "start_fresh",
  "reduce_repeated_reads",
  "trim_context"
] as const;
export type WasteCandidateAction = typeof wasteCandidateActionValues[number];

export const wasteFindingCaveatValues = [
  "signal_not_cause",
  "no_cash_claim",
  "missing_outcome_evidence"
] as const;
export type WasteFindingCaveat = typeof wasteFindingCaveatValues[number];

export const actionVerificationEvidenceValues = [
  "verified",
  "observed",
  "calculated",
  "user_declared",
  "modeled",
  "missing"
] as const;
export const actionVerificationEvidenceSchema = z.enum(
  actionVerificationEvidenceValues
);
export type ActionVerificationEvidence = z.infer<
  typeof actionVerificationEvidenceSchema
>;

export const tokenExperimentLifecycleValues = [
  "draft",
  "baseline_ready",
  "applied",
  "collecting",
  "complete",
  "rolled_back",
  "invalidated"
] as const;
export type TokenExperimentLifecycle =
  typeof tokenExperimentLifecycleValues[number];

export const tokenExperimentResultValues = [
  "not_evaluated",
  "collecting",
  "measured_token_reduction",
  "no_measured_change",
  "regressed",
  "inconclusive"
] as const;
export type TokenExperimentResult = typeof tokenExperimentResultValues[number];

export const tokenExperimentExclusionReasonValues = [
  "duplicate_session",
  "reused_across_phases",
  "intervention_not_applied",
  "crosses_intervention_boundary",
  "wrong_side_of_intervention",
  "missing_total_tokens",
  "inconsistent_total_tokens",
  "agent_mismatch",
  "provider_mismatch",
  "model_mismatch",
  "project_mismatch",
  "session_type_mismatch",
  "work_type_mismatch",
  "missing_work_unit",
  "source_version_mismatch"
] as const;
export type TokenExperimentExclusionReason =
  typeof tokenExperimentExclusionReasonValues[number];

const finiteNonnegativeSchema = z.number().finite().nonnegative();
const tokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableTokenCountSchema = tokenCountSchema.nullable();
const utcTimestampSchema = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const safeIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Expected a path-free, control-free identifier."
  )
  .superRefine((value, context) => {
    if (/^(?:sk-|sk_|gh[pousr]_|github_pat_|npm_|AIza|xox[baprs]-|glpat-|AKIA)/i.test(value) ||
        /^(?:env|keychain|secret|credential):/i.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Credential-like values are not action-verification identifiers."
      });
    }
  });
const actionVerificationReferenceSchema = z.string()
  .regex(/^avref_[a-f0-9]{64}$/);
const wasteFindingIdSchema = z.string().regex(/^wf_v0_[a-f0-9]{64}$/);
const wasteCandidateKeySchema = z.string().regex(/^wfc_v0_[a-f0-9]{64}$/);
const tokenExperimentIdSchema = z.string().regex(/^tre_v0_[a-f0-9]{64}$/);
const tokenExperimentRevisionIdSchema = z.string().regex(/^trev_v0_[a-f0-9]{64}$/);

const timeWindowSchema = z.object({
  start: utcTimestampSchema,
  end: utcTimestampSchema
}).strict().superRefine((window, context) => {
  if (Date.parse(window.start) >= Date.parse(window.end)) {
    context.addIssue({
      code: "custom",
      path: ["end"],
      message: "The window end must follow its start."
    });
  }
});

const findingScopeSchema = z.object({
  agent: safeIdentifierSchema,
  provider: safeIdentifierSchema,
  model: safeIdentifierSchema.optional(),
  projectRef: actionVerificationReferenceSchema.optional()
}).strict();

const findingMetricSchema = z.object({
  name: z.enum([
    "input_context_tokens",
    "total_tokens",
    "compaction_events",
    "repeated_read_events",
    "configured_items"
  ]),
  unit: z.enum(["tokens", "events", "items", "ratio"]),
  value: finiteNonnegativeSchema.nullable(),
  sampleCount: z.number().int().nonnegative(),
  evidence: z.enum(["observed", "calculated", "missing"])
}).strict().superRefine((metric, context) => {
  if ((metric.value === null) !== (metric.evidence === "missing")) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "A missing finding metric must use null, and a present metric must not."
    });
  }
});

const wasteFindingBodySchema = z.object({
  kind: z.literal(WASTE_FINDING_V0_KIND),
  schemaVersion: z.literal(WASTE_FINDING_V0_VERSION),
  generatedAt: utcTimestampSchema,
  window: timeWindowSchema,
  findingType: z.enum(wasteFindingTypeValues),
  objective: z.object({
    metric: z.literal("total_tokens_per_matched_session"),
    direction: z.literal("reduce"),
    guard: z.literal("user_declared_quality_must_hold")
  }).strict(),
  caveats: z.array(z.enum(wasteFindingCaveatValues)).length(
    wasteFindingCaveatValues.length
  ),
  candidateAction: z.object({
    kind: z.enum(wasteCandidateActionValues),
    provider: safeIdentifierSchema,
    surface: z.enum([
      "local_agent_configuration",
      "session_workflow",
      "provider_workload_configuration"
    ]),
    reversible: z.literal(true),
    canaryRequired: z.literal(true),
    rollbackRequired: z.literal(true)
  }).strict(),
  target: z.object({
    kind: z.enum(["session", "repeated_read_file", "configured_item"]),
    ref: actionVerificationReferenceSchema
  }).strict(),
  scope: findingScopeSchema,
  source: z.object({
    id: safeIdentifierSchema,
    validationCoverage: z.enum(sourceValidationCoverageValues),
    freshness: z.enum(["fresh", "stale", "not_checked"])
  }).strict(),
  metric: findingMetricSchema,
  evidenceRefs: z.array(actionVerificationReferenceSchema)
    .min(1)
    .max(MAX_WASTE_FINDING_EVIDENCE_REFS_V0),
  causalStatus: z.literal("unproven"),
  actionability: z.literal("inspect_only"),
  approvalRequired: z.literal(true)
}).strict().superRefine((finding, context) => {
  if (Date.parse(finding.generatedAt) < Date.parse(finding.window.end)) {
    context.addIssue({
      code: "custom",
      path: ["generatedAt"],
      message: "A finding cannot be generated before its evidence window ends."
    });
  }
  if (finding.candidateAction.provider !== finding.scope.provider) {
    context.addIssue({
      code: "custom",
      path: ["candidateAction", "provider"],
      message: "The action provider must remain inside the finding's provider scope."
    });
  }
  const caveats = new Set(finding.caveats);
  for (const caveat of wasteFindingCaveatValues) {
    if (!caveats.has(caveat)) {
      context.addIssue({
        code: "custom",
        path: ["caveats"],
        message: `WasteFindingV0 requires the ${caveat} caveat.`
      });
    }
  }
});

export type WasteFindingV0DraftInput = z.input<typeof wasteFindingBodySchema>;

const wasteFindingObjectSchema = wasteFindingBodySchema.extend({
  id: wasteFindingIdSchema,
  candidateKey: wasteCandidateKeySchema
});

export type WasteFindingV0 = z.infer<typeof wasteFindingObjectSchema>;

const tokenComponentsSchema = z.object({
  uncachedInputTokens: nullableTokenCountSchema,
  cacheReadTokens: nullableTokenCountSchema,
  cacheWriteTokens: nullableTokenCountSchema,
  toolTokens: nullableTokenCountSchema,
  outputTokens: nullableTokenCountSchema,
  thoughtTokens: nullableTokenCountSchema,
  calculatedTotalTokens: nullableTokenCountSchema,
  reportedTotalTokens: nullableTokenCountSchema,
  componentEvidence: z.object({
    uncachedInputTokens: z.enum(["observed", "not_separately_reported"]),
    cacheReadTokens: z.enum(["observed", "not_separately_reported"]),
    cacheWriteTokens: z.enum(["observed", "partial", "not_separately_reported"]),
    toolTokens: z.enum(["observed", "not_separately_reported"]),
    outputTokens: z.enum(["observed", "not_separately_reported"]),
    thoughtTokens: z.enum(["observed", "not_separately_reported"]),
    calculatedTotalTokens: z.enum([
      "calculated_complete",
      "calculated_partial",
      "missing"
    ]),
    reportedTotalTokens: z.enum(["provider_reported", "not_reported"])
  }).strict()
}).strict().superRefine((tokens, context) => {
  const requireObservedValue = (
    key: "uncachedInputTokens" | "cacheReadTokens" | "cacheWriteTokens" |
      "toolTokens" | "outputTokens" | "thoughtTokens",
    evidence: string
  ): void => {
    const present = tokens[key] !== null;
    if ((evidence === "observed") !== present) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must be present exactly when its component evidence is observed.`
      });
    }
  };
  requireObservedValue("uncachedInputTokens", tokens.componentEvidence.uncachedInputTokens);
  requireObservedValue("cacheReadTokens", tokens.componentEvidence.cacheReadTokens);
  if (tokens.componentEvidence.cacheWriteTokens !== "partial") {
    requireObservedValue("cacheWriteTokens", tokens.componentEvidence.cacheWriteTokens);
  }
  requireObservedValue("toolTokens", tokens.componentEvidence.toolTokens);
  requireObservedValue("outputTokens", tokens.componentEvidence.outputTokens);
  requireObservedValue("thoughtTokens", tokens.componentEvidence.thoughtTokens);
  if ((tokens.calculatedTotalTokens !== null) !==
      (tokens.componentEvidence.calculatedTotalTokens !== "missing")) {
    context.addIssue({
      code: "custom",
      path: ["calculatedTotalTokens"],
      message: "Calculated component evidence must match presence of the calculated total."
    });
  }
  if ((tokens.reportedTotalTokens !== null) !==
      (tokens.componentEvidence.reportedTotalTokens === "provider_reported")) {
    context.addIssue({
      code: "custom",
      path: ["reportedTotalTokens"],
      message: "Provider-reported total evidence must match presence of the reported total."
    });
  }
});

const qualityObservationSchema = z.object({
  status: z.enum(["passed", "failed", "missing"]),
  evidence: z.enum(["verified", "observed", "user_declared", "missing"]),
  evidenceRef: actionVerificationReferenceSchema.optional()
}).strict().superRefine((quality, context) => {
  if ((quality.status === "missing") !== (quality.evidence === "missing")) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "Missing quality must use missing evidence, and present quality must not."
    });
  }
  if ((quality.evidence === "observed" || quality.evidence === "verified") &&
      !quality.evidenceRef) {
    context.addIssue({
      code: "custom",
      path: ["evidenceRef"],
      message: "Observed and verified quality require an opaque evidence reference."
    });
  }
});

const tokenSessionSchema = z.object({
  sessionRef: actionVerificationReferenceSchema,
  startedAt: utcTimestampSchema,
  endedAt: utcTimestampSchema,
  agent: safeIdentifierSchema,
  provider: safeIdentifierSchema,
  model: safeIdentifierSchema,
  projectRef: actionVerificationReferenceSchema.optional(),
  sessionType: z.enum(["parent", "subagent", "unknown"]),
  workTypeRef: actionVerificationReferenceSchema.optional(),
  workUnitRef: actionVerificationReferenceSchema.optional(),
  workUnitEvidence: z.enum(["verified", "observed", "user_declared"]).optional(),
  sourceVersionRef: actionVerificationReferenceSchema.optional(),
  sourceValidationCoverage: z.enum(sourceValidationCoverageValues),
  tokens: tokenComponentsSchema,
  quality: qualityObservationSchema
}).strict().superRefine((session, context) => {
  if (Date.parse(session.startedAt) > Date.parse(session.endedAt)) {
    context.addIssue({
      code: "custom",
      path: ["endedAt"],
      message: "A session cannot end before it starts."
    });
  }
  if (Boolean(session.workUnitRef) !== Boolean(session.workUnitEvidence)) {
    context.addIssue({
      code: "custom",
      path: ["workUnitEvidence"],
      message: "A work-unit reference and its evidence label must be present together."
    });
  }
});

export type TokenExperimentSessionV0 = z.infer<typeof tokenSessionSchema>;
export type TokenExperimentSessionV0Input = z.input<typeof tokenSessionSchema>;

const cohortSchema = z.object({
  agent: safeIdentifierSchema,
  provider: safeIdentifierSchema,
  model: safeIdentifierSchema,
  projectRef: actionVerificationReferenceSchema,
  sessionType: z.enum(["parent", "subagent"]),
  workTypeRef: actionVerificationReferenceSchema,
  workTypeEvidence: z.enum(["verified", "observed", "user_declared"]),
  sourceVersionRef: actionVerificationReferenceSchema.optional()
}).strict();

const matchingPolicySchema = z.object({
  basis: z.enum(["session_cohort", "accepted_work_unit"]),
  minimumBaselineSessions: z.number().int().min(3).max(100).default(3),
  minimumPostSessions: z.number().int().min(3).max(100).default(3),
  requireExactSourceVersion: z.boolean().default(true)
}).strict();

const qualityGuardSchema = z.object({
  required: z.literal(true),
  minimumEvidence: z.enum(["user_declared", "observed", "verified"]),
  rollbackOnRegression: z.literal(true)
}).strict();

const interventionSchema = z.object({
  approval: z.object({
    status: z.enum(["pending", "explicit"]),
    evidence: z.enum(["missing", "user_declared", "verified"]),
    approvedAt: utcTimestampSchema.optional(),
    approvalRef: actionVerificationReferenceSchema.optional()
  }).strict(),
  appliedAt: utcTimestampSchema.optional(),
  changeRef: actionVerificationReferenceSchema.optional(),
  rollbackRef: actionVerificationReferenceSchema.optional(),
  canary: qualityObservationSchema.optional(),
  rolledBackAt: utcTimestampSchema.optional()
}).strict().superRefine((intervention, context) => {
  const explicit = intervention.approval.status === "explicit";
  if (explicit !== (intervention.approval.evidence !== "missing")) {
    context.addIssue({
      code: "custom",
      path: ["approval", "evidence"],
      message: "Explicit approval requires evidence; pending approval must remain missing."
    });
  }
  if (explicit !== Boolean(intervention.approval.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["approval", "approvedAt"],
      message: "Explicit approval requires an approval timestamp."
    });
  }
  if (intervention.approval.evidence === "verified" &&
      !intervention.approval.approvalRef) {
    context.addIssue({
      code: "custom",
      path: ["approval", "approvalRef"],
      message: "Verified approval requires an opaque approval reference."
    });
  }
  if (intervention.appliedAt) {
    if (!explicit || !intervention.changeRef || !intervention.rollbackRef ||
        !intervention.canary || intervention.canary.status === "missing" ||
        !intervention.canary.evidenceRef) {
      context.addIssue({
        code: "custom",
        path: ["appliedAt"],
        message: "An applied intervention requires explicit approval plus opaque change, rollback, and canary evidence references."
      });
    }
  } else if (intervention.changeRef || intervention.rollbackRef || intervention.canary ||
      intervention.rolledBackAt) {
    context.addIssue({
      code: "custom",
      path: ["appliedAt"],
      message: "Change, canary, and rollback evidence require an applied intervention."
    });
  }
  if (intervention.appliedAt && intervention.approval.approvedAt &&
      Date.parse(intervention.appliedAt) <= Date.parse(intervention.approval.approvedAt)) {
    context.addIssue({
      code: "custom",
      path: ["appliedAt"],
      message: "An intervention must be applied after approval."
    });
  }
  if (intervention.rolledBackAt && intervention.appliedAt &&
      Date.parse(intervention.rolledBackAt) <= Date.parse(intervention.appliedAt)) {
    context.addIssue({
      code: "custom",
      path: ["rolledBackAt"],
      message: "Rollback must follow application."
    });
  }
});

const invalidationSchema = z.object({
  reason: z.enum([
    "scope_changed",
    "source_semantics_changed",
    "concurrent_change",
    "manual"
  ]),
  invalidatedAt: utcTimestampSchema
}).strict();

const experimentBodySchema = z.object({
  kind: z.literal(TOKEN_REDUCTION_EXPERIMENT_V0_KIND),
  schemaVersion: z.literal(TOKEN_REDUCTION_EXPERIMENT_V0_VERSION),
  createdAt: utcTimestampSchema,
  finding: wasteFindingObjectSchema,
  cohort: cohortSchema,
  matchingPolicy: matchingPolicySchema,
  qualityGuard: qualityGuardSchema,
  baselineSessions: z.array(tokenSessionSchema)
    .max(MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0),
  intervention: interventionSchema,
  postSessions: z.array(tokenSessionSchema)
    .max(MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0),
  invalidation: invalidationSchema.optional()
}).strict().superRefine((experiment, context) => {
  if (Date.parse(experiment.createdAt) < Date.parse(experiment.finding.generatedAt)) {
    context.addIssue({
      code: "custom",
      path: ["createdAt"],
      message: "An experiment cannot be created before its finding."
    });
  }
  for (const [index, session] of experiment.baselineSessions.entries()) {
    if (Date.parse(session.endedAt) > Date.parse(experiment.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["baselineSessions", index, "endedAt"],
        message: "Frozen baseline evidence cannot end after experiment creation."
      });
    }
  }
  if (experiment.finding.scope.agent !== experiment.cohort.agent ||
      experiment.finding.scope.provider !== experiment.cohort.provider) {
    context.addIssue({
      code: "custom",
      path: ["cohort"],
      message: "The experiment cohort must remain inside the finding's agent/provider scope."
    });
  }
  if (experiment.finding.scope.model &&
      experiment.finding.scope.model !== experiment.cohort.model) {
    context.addIssue({
      code: "custom",
      path: ["cohort", "model"],
      message: "The experiment model must match the finding model."
    });
  }
  if (experiment.finding.scope.projectRef &&
      experiment.finding.scope.projectRef !== experiment.cohort.projectRef) {
    context.addIssue({
      code: "custom",
      path: ["cohort", "projectRef"],
      message: "The experiment project must match the finding project."
    });
  }
  if (experiment.matchingPolicy.requireExactSourceVersion !==
      Boolean(experiment.cohort.sourceVersionRef)) {
    context.addIssue({
      code: "custom",
      path: ["matchingPolicy", "requireExactSourceVersion"],
      message:
        "Exact source-version matching requires observed cohort version evidence; missing versions must remain explicitly unmatched."
    });
  }
  if (experiment.intervention.appliedAt &&
      Date.parse(experiment.intervention.appliedAt) < Date.parse(experiment.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["intervention", "appliedAt"],
      message: "An intervention cannot be applied before its experiment exists."
    });
  }
  if (experiment.intervention.approval.approvedAt &&
      Date.parse(experiment.intervention.approval.approvedAt) <
        Date.parse(experiment.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["intervention", "approval", "approvedAt"],
      message: "A token-test plan cannot be approved before its experiment exists."
    });
  }
  if (experiment.invalidation &&
      Date.parse(experiment.invalidation.invalidatedAt) < Date.parse(experiment.createdAt)) {
    context.addIssue({
      code: "custom",
      path: ["invalidation", "invalidatedAt"],
      message: "Invalidation cannot precede experiment creation."
    });
  }
  if (experiment.invalidation && experiment.intervention.appliedAt) {
    context.addIssue({
      code: "custom",
      path: ["invalidation"],
      message: "An applied intervention cannot be invalidated; it must be rolled back."
    });
  }
  if (experiment.intervention.rolledBackAt) {
    const rolledBackAt = Date.parse(experiment.intervention.rolledBackAt);
    for (const [index, session] of experiment.postSessions.entries()) {
      if (Date.parse(session.endedAt) > rolledBackAt) {
        context.addIssue({
          code: "custom",
          path: ["postSessions", index, "endedAt"],
          message: "Post-change evidence cannot end after the rollback boundary."
        });
      }
    }
  }
  if (experiment.intervention.canary?.status === "failed" &&
      experiment.postSessions.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["postSessions"],
      message: "A failed canary cannot collect or expose post-change token evidence."
    });
  }
});

export type TokenReductionExperimentV0DraftInput = z.input<
  typeof experimentBodySchema
>;

const exclusionSchema = z.object({
  phase: z.enum(["baseline", "post_change"]),
  sessionRef: actionVerificationReferenceSchema,
  reasons: z.array(z.enum(tokenExperimentExclusionReasonValues)).min(1)
}).strict();

const componentMedianSchema = z.object({
  uncachedInputTokens: finiteNonnegativeSchema.nullable(),
  cacheReadTokens: finiteNonnegativeSchema.nullable(),
  cacheWriteTokens: finiteNonnegativeSchema.nullable(),
  toolTokens: finiteNonnegativeSchema.nullable(),
  outputTokens: finiteNonnegativeSchema.nullable(),
  thoughtTokens: finiteNonnegativeSchema.nullable()
}).strict();

const evaluationSchema = z.object({
  status: z.enum(tokenExperimentResultValues),
  metricEvidence: z.enum(["calculated", "missing"]),
  matchingEvidence: z.enum(["verified", "observed", "user_declared", "missing"]),
  qualityStatus: z.enum(["held", "regressed", "insufficient"]),
  qualityEvidence: z.enum(["verified", "observed", "user_declared", "missing"]),
  baseline: z.object({
    includedSessions: z.number().int().nonnegative(),
    medianTotalTokens: finiteNonnegativeSchema.nullable(),
    componentMedians: componentMedianSchema
  }).strict(),
  postChange: z.object({
    includedSessions: z.number().int().nonnegative(),
    medianTotalTokens: finiteNonnegativeSchema.nullable(),
    componentMedians: componentMedianSchema
  }).strict(),
  reductionPercent: z.number().finite().nullable(),
  exclusions: z.array(exclusionSchema).max(512),
  rollbackRecommended: z.boolean()
}).strict();

const experimentObjectSchema = experimentBodySchema.extend({
  id: tokenExperimentIdSchema,
  revisionId: tokenExperimentRevisionIdSchema,
  lifecycle: z.enum(tokenExperimentLifecycleValues),
  evaluation: evaluationSchema
});

export type TokenReductionEvaluationV0 = z.infer<typeof evaluationSchema>;
export type TokenReductionExperimentV0 = z.infer<typeof experimentObjectSchema>;

type ParsedExperimentBody = z.infer<typeof experimentBodySchema>;
type ParsedTokens = z.infer<typeof tokenComponentsSchema>;
type ParsedQuality = z.infer<typeof qualityObservationSchema>;

type EligibleSession = {
  session: TokenExperimentSessionV0;
  totalTokens: number;
};

type PhaseEvaluation = {
  included: EligibleSession[];
  exclusions: TokenReductionEvaluationV0["exclusions"];
};

/**
 * Hash a source-native value into the only reference form accepted by action
 * verification contracts. The original value is never returned or persisted.
 */
export function createActionVerificationReference(
  namespace: string,
  sourceNativeValue: string
): string {
  const safeNamespace = safeIdentifierSchema.parse(namespace);
  if (sourceNativeValue.length < 1 || sourceNativeValue.length > 4_096 ||
      hasUnpairedSurrogate(sourceNativeValue)) {
    throw new TypeError("Action verification references require a bounded valid Unicode source value.");
  }
  return `avref_${createHash("sha256")
    .update(`${safeNamespace}\u0000${sourceNativeValue}`)
    .digest("hex")}`;
}

/** Create a canonical, content-addressed waste finding with no raw paths or prose. */
export function createWasteFindingV0(input: WasteFindingV0DraftInput): WasteFindingV0 {
  const body = canonicalWasteFindingBody(wasteFindingBodySchema.parse(input));
  return wasteFindingObjectSchema.parse({
    ...body,
    id: wasteFindingDigest(body),
    candidateKey: wasteCandidateDigest(body)
  });
}

/** Parse a serialized finding and reject a stale or forged content digest. */
export function parseWasteFindingV0(value: unknown): WasteFindingV0 {
  const finding = wasteFindingObjectSchema.parse(value);
  const { id, candidateKey, ...bodyInput } = finding;
  const body = canonicalWasteFindingBody(wasteFindingBodySchema.parse(bodyInput));
  if (id !== wasteFindingDigest(body) || candidateKey !== wasteCandidateDigest(body)) {
    throw new TypeError("Waste finding ID or candidate key does not match its canonical body.");
  }
  return wasteFindingObjectSchema.parse({ ...body, id, candidateKey });
}

/**
 * Build or advance one experiment. Evaluation is pure: every lifecycle label,
 * median, exclusion, percentage, and rollback recommendation is derived from
 * the supplied immutable evidence.
 */
export function createTokenReductionExperimentV0(
  input: TokenReductionExperimentV0DraftInput
): TokenReductionExperimentV0 {
  const body = canonicalExperimentBody(experimentBodySchema.parse(input));
  return experimentObjectSchema.parse({
    ...body,
    id: experimentDigest(body),
    revisionId: experimentRevisionDigest(body),
    ...evaluateExperimentBody(body)
  });
}

/** Parse and recompute an experiment, rejecting tampered derived fields. */
export function parseTokenReductionExperimentV0(
  value: unknown
): TokenReductionExperimentV0 {
  const experiment = experimentObjectSchema.parse(value);
  const { id, revisionId, lifecycle, evaluation, ...bodyInput } = experiment;
  const body = canonicalExperimentBody(experimentBodySchema.parse(bodyInput));
  const expectedId = experimentDigest(body);
  const expectedRevisionId = experimentRevisionDigest(body);
  const expected = evaluateExperimentBody(body);
  if (id !== expectedId || revisionId !== expectedRevisionId ||
      canonicalJson({ lifecycle, evaluation }) !== canonicalJson(expected)) {
    throw new TypeError("Token reduction experiment identity, revision, or derived evaluation is invalid.");
  }
  return experimentObjectSchema.parse({ ...body, id, revisionId, ...expected });
}

/** Pure evaluator for callers that already have a validated experiment body. */
export function evaluateTokenReductionExperimentV0(
  input: TokenReductionExperimentV0DraftInput
): Pick<TokenReductionExperimentV0, "lifecycle" | "evaluation"> {
  return evaluateExperimentBody(canonicalExperimentBody(experimentBodySchema.parse(input)));
}

function evaluateExperimentBody(
  experiment: ParsedExperimentBody
): Pick<TokenReductionExperimentV0, "lifecycle" | "evaluation"> {
  const referenceCounts = sessionReferenceCounts(experiment);
  const baseline = evaluatePhase(experiment, "baseline", referenceCounts);
  const postChange = evaluatePhase(experiment, "post_change", referenceCounts);
  const baselineEnough =
    baseline.included.length >= experiment.matchingPolicy.minimumBaselineSessions;
  const postEnough =
    postChange.included.length >= experiment.matchingPolicy.minimumPostSessions;
  const baselineMedian = median(baseline.included.map((entry) => entry.totalTokens));
  const postMedian = median(postChange.included.map((entry) => entry.totalTokens));
  const calculatedReductionPercent = baselineEnough && postEnough && baselineMedian !== null &&
      postMedian !== null && baselineMedian > 0
    ? roundPercent(100 * (baselineMedian - postMedian) / baselineMedian)
    : null;
  const quality = evaluateQuality(experiment, baseline.included, postChange.included);
  const matchingEvidence = evaluateMatchingEvidence(
    experiment,
    baseline.included,
    postChange.included
  );

  let lifecycle: TokenExperimentLifecycle;
  if (experiment.invalidation) lifecycle = "invalidated";
  else if (experiment.intervention.rolledBackAt) lifecycle = "rolled_back";
  else if (!experiment.intervention.appliedAt) {
    lifecycle = baselineEnough ? "baseline_ready" : "draft";
  } else if (postChange.included.length === 0) lifecycle = "applied";
  else if (!postEnough || quality.status === "insufficient") lifecycle = "collecting";
  else lifecycle = "complete";

  // The arithmetic is not a public result until comparable post evidence and
  // its required quality guard are both complete. Terminal/cancelled attempts
  // retain their audit evidence without continuing to expose a reduction.
  const reductionPercent = lifecycle === "complete" && quality.status === "held"
    ? calculatedReductionPercent
    : null;

  let status: TokenExperimentResult;
  if (lifecycle === "draft" || lifecycle === "baseline_ready") status = "not_evaluated";
  else if (experiment.intervention.canary?.status === "failed" ||
      lifecycle === "invalidated" || lifecycle === "rolled_back") {
    status = "inconclusive";
  } else if (!postEnough) status = "collecting";
  else if (calculatedReductionPercent === null || quality.status === "insufficient") {
    status = "inconclusive";
  } else if (quality.status === "regressed" || calculatedReductionPercent < 0) {
    status = "regressed";
  } else if (calculatedReductionPercent === 0) status = "no_measured_change";
  else status = "measured_token_reduction";

  const exclusions = [...baseline.exclusions, ...postChange.exclusions]
    .sort(compareExclusions);
  return {
    lifecycle,
    evaluation: {
      status,
      metricEvidence: reductionPercent === null ? "missing" : "calculated",
      matchingEvidence,
      qualityStatus: quality.status,
      qualityEvidence: quality.evidence,
      baseline: {
        includedSessions: baseline.included.length,
        medianTotalTokens: baselineMedian,
        componentMedians: componentMedians(baseline.included)
      },
      postChange: {
        includedSessions: postChange.included.length,
        medianTotalTokens: postMedian,
        componentMedians: componentMedians(postChange.included)
      },
      reductionPercent,
      exclusions,
      rollbackRecommended: experiment.intervention.canary?.status === "failed" ||
        quality.status === "regressed" ||
        (calculatedReductionPercent !== null && calculatedReductionPercent < 0)
    }
  };
}

function evaluateMatchingEvidence(
  experiment: ParsedExperimentBody,
  baseline: EligibleSession[],
  post: EligibleSession[]
): "verified" | "observed" | "user_declared" | "missing" {
  if (baseline.length === 0 || post.length === 0) return "missing";
  const labels: Array<"verified" | "observed" | "user_declared"> = [
    experiment.cohort.workTypeEvidence
  ];
  if (experiment.matchingPolicy.basis === "accepted_work_unit") {
    for (const entry of [...baseline, ...post]) {
      if (!entry.session.workUnitEvidence) return "missing";
      labels.push(entry.session.workUnitEvidence);
    }
  } else {
    // Agent/project/model/session metadata is locally observed, so a session
    // cohort can never become verified solely from an asserted work-type label.
    labels.push("observed");
  }
  return labels.sort((left, right) => matchingEvidenceRank(left) - matchingEvidenceRank(right))[0]!;
}

function matchingEvidenceRank(
  evidence: "verified" | "observed" | "user_declared"
): number {
  switch (evidence) {
    case "verified": return 3;
    case "observed": return 2;
    case "user_declared": return 1;
  }
}

function evaluatePhase(
  experiment: ParsedExperimentBody,
  phase: "baseline" | "post_change",
  referenceCounts: Map<string, { baseline: number; post: number }>
): PhaseEvaluation {
  const sessions = phase === "baseline"
    ? experiment.baselineSessions
    : experiment.postSessions;
  const included: EligibleSession[] = [];
  const exclusions: TokenReductionEvaluationV0["exclusions"] = [];
  for (const session of sessions) {
    const reasons = exclusionReasons(experiment, session, phase, referenceCounts);
    const total = totalTokens(session.tokens);
    if (total.reason) reasons.push(total.reason);
    const uniqueReasons = [...new Set(reasons)].sort();
    if (uniqueReasons.length > 0 || total.value === null) {
      exclusions.push({
        phase,
        sessionRef: session.sessionRef,
        reasons: uniqueReasons as TokenExperimentExclusionReason[]
      });
    } else {
      included.push({ session, totalTokens: total.value });
    }
  }
  return { included, exclusions };
}

function exclusionReasons(
  experiment: ParsedExperimentBody,
  session: TokenExperimentSessionV0,
  phase: "baseline" | "post_change",
  counts: Map<string, { baseline: number; post: number }>
): TokenExperimentExclusionReason[] {
  const reasons: TokenExperimentExclusionReason[] = [];
  const count = counts.get(session.sessionRef);
  if (count && count.baseline > 0 && count.post > 0) reasons.push("reused_across_phases");
  else if ((phase === "baseline" ? count?.baseline : count?.post) !== 1) {
    reasons.push("duplicate_session");
  }
  const cohort = experiment.cohort;
  if (session.agent !== cohort.agent) reasons.push("agent_mismatch");
  if (session.provider !== cohort.provider) reasons.push("provider_mismatch");
  if (session.model !== cohort.model) reasons.push("model_mismatch");
  if (session.projectRef !== cohort.projectRef) reasons.push("project_mismatch");
  if (session.sessionType !== cohort.sessionType) reasons.push("session_type_mismatch");
  if (session.workTypeRef !== cohort.workTypeRef) reasons.push("work_type_mismatch");
  if (experiment.matchingPolicy.basis === "accepted_work_unit" && !session.workUnitRef) {
    reasons.push("missing_work_unit");
  }
  if (!experiment.matchingPolicy.requireExactSourceVersion ||
      !cohort.sourceVersionRef ||
      session.sourceVersionRef !== cohort.sourceVersionRef) {
    reasons.push("source_version_mismatch");
  }
  const appliedAt = experiment.intervention.appliedAt;
  if (phase === "post_change" && !appliedAt) {
    reasons.push("intervention_not_applied");
  } else if (appliedAt) {
    const applied = Date.parse(appliedAt);
    const started = Date.parse(session.startedAt);
    const ended = Date.parse(session.endedAt);
    if (started < applied && ended > applied) reasons.push("crosses_intervention_boundary");
    else if (phase === "baseline" && ended > applied) reasons.push("wrong_side_of_intervention");
    else if (phase === "post_change" && started < applied) reasons.push("wrong_side_of_intervention");
  }
  return reasons;
}

function totalTokens(tokens: ParsedTokens): {
  value: number | null;
  reason?: Extract<TokenExperimentExclusionReason,
    "missing_total_tokens" | "inconsistent_total_tokens">;
} {
  const components = [
    tokens.uncachedInputTokens,
    tokens.cacheReadTokens,
    tokens.cacheWriteTokens,
    tokens.toolTokens,
    tokens.outputTokens,
    tokens.thoughtTokens
  ];
  const calculated = tokens.calculatedTotalTokens;
  const calculatedComplete =
    tokens.componentEvidence.calculatedTotalTokens === "calculated_complete";
  const componentBreakdownObserved =
    tokens.componentEvidence.uncachedInputTokens === "observed" &&
    tokens.componentEvidence.cacheReadTokens === "observed" &&
    tokens.componentEvidence.cacheWriteTokens === "observed" &&
    tokens.componentEvidence.toolTokens === "observed" &&
    tokens.componentEvidence.outputTokens === "observed" &&
    tokens.componentEvidence.thoughtTokens === "observed";
  if (components.every((value): value is number => value !== null)) {
    const componentTotal = components.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(componentTotal)) {
      return { value: null, reason: "inconsistent_total_tokens" };
    }
    if (calculated !== null && calculated !== componentTotal) {
      return { value: null, reason: "inconsistent_total_tokens" };
    }
    if (componentBreakdownObserved && tokens.reportedTotalTokens !== null &&
        tokens.reportedTotalTokens !== componentTotal) {
      return { value: null, reason: "inconsistent_total_tokens" };
    }
    if (tokens.reportedTotalTokens !== null) return { value: tokens.reportedTotalTokens };
    return calculatedComplete
      ? { value: componentTotal }
      : { value: null, reason: "missing_total_tokens" };
  }
  if (calculatedComplete && calculated !== null && tokens.reportedTotalTokens !== null &&
      calculated !== tokens.reportedTotalTokens) {
    return { value: null, reason: "inconsistent_total_tokens" };
  }
  if (tokens.reportedTotalTokens !== null) return { value: tokens.reportedTotalTokens };
  if (calculatedComplete && calculated !== null) return { value: calculated };
  return { value: null, reason: "missing_total_tokens" };
}

function evaluateQuality(
  experiment: ParsedExperimentBody,
  baseline: EligibleSession[],
  post: EligibleSession[]
): { status: "held" | "regressed" | "insufficient"; evidence: "verified" | "observed" | "user_declared" | "missing" } {
  const all = [...baseline, ...post].map((entry) => entry.session.quality);
  if (post.some((entry) => entry.session.quality.status === "failed")) {
    return { status: "regressed", evidence: weakestQualityEvidence(all) };
  }
  const minimum = qualityEvidenceRank(experiment.qualityGuard.minimumEvidence);
  if (all.length === 0 || all.some((quality) =>
    quality.status !== "passed" || qualityEvidenceRank(quality.evidence) < minimum)) {
    return { status: "insufficient", evidence: weakestQualityEvidence(all) };
  }
  return { status: "held", evidence: weakestQualityEvidence(all) };
}

function qualityEvidenceRank(evidence: ParsedQuality["evidence"]): number {
  switch (evidence) {
    case "verified": return 3;
    case "observed": return 2;
    case "user_declared": return 1;
    case "missing": return 0;
  }
}

function weakestQualityEvidence(
  qualities: ParsedQuality[]
): "verified" | "observed" | "user_declared" | "missing" {
  if (qualities.length === 0) return "missing";
  return qualities
    .map((quality) => quality.evidence)
    .sort((left, right) => qualityEvidenceRank(left) - qualityEvidenceRank(right))[0]!;
}

function componentMedians(included: EligibleSession[]): z.infer<typeof componentMedianSchema> {
  return {
    uncachedInputTokens: completeComponentMedian(included, "uncachedInputTokens"),
    cacheReadTokens: completeComponentMedian(included, "cacheReadTokens"),
    cacheWriteTokens: completeComponentMedian(included, "cacheWriteTokens"),
    toolTokens: completeComponentMedian(included, "toolTokens"),
    outputTokens: completeComponentMedian(included, "outputTokens"),
    thoughtTokens: completeComponentMedian(included, "thoughtTokens")
  };
}

function completeComponentMedian(
  included: EligibleSession[],
  key: Exclude<keyof ParsedTokens,
    "calculatedTotalTokens" | "reportedTotalTokens" | "componentEvidence">
): number | null {
  const values = included.map((entry) => entry.session.tokens[key]);
  return values.length > 0 && values.every((value): value is number => value !== null)
    ? median(values)
    : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function roundPercent(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sessionReferenceCounts(experiment: ParsedExperimentBody): Map<
  string,
  { baseline: number; post: number }
> {
  const counts = new Map<string, { baseline: number; post: number }>();
  for (const session of experiment.baselineSessions) {
    const count = counts.get(session.sessionRef) ?? { baseline: 0, post: 0 };
    count.baseline += 1;
    counts.set(session.sessionRef, count);
  }
  for (const session of experiment.postSessions) {
    const count = counts.get(session.sessionRef) ?? { baseline: 0, post: 0 };
    count.post += 1;
    counts.set(session.sessionRef, count);
  }
  return counts;
}

function canonicalWasteFindingBody(
  finding: z.infer<typeof wasteFindingBodySchema>
): z.infer<typeof wasteFindingBodySchema> {
  return {
    ...finding,
    caveats: [...finding.caveats].sort(compareText),
    evidenceRefs: [...finding.evidenceRefs].sort(compareText)
  };
}

function canonicalExperimentBody(experiment: ParsedExperimentBody): ParsedExperimentBody {
  return {
    ...experiment,
    finding: parseWasteFindingV0(experiment.finding),
    baselineSessions: canonicalSessions(experiment.baselineSessions),
    postSessions: canonicalSessions(experiment.postSessions)
  };
}

function canonicalSessions(
  sessions: TokenExperimentSessionV0[]
): TokenExperimentSessionV0[] {
  return [...sessions].sort((left, right) => {
    const byRef = compareText(left.sessionRef, right.sessionRef);
    return byRef !== 0 ? byRef : compareText(canonicalJson(left), canonicalJson(right));
  });
}

function wasteFindingDigest(
  finding: z.infer<typeof wasteFindingBodySchema>
): string {
  return `wf_v0_${createHash("sha256").update(canonicalJson(finding)).digest("hex")}`;
}

function wasteCandidateDigest(
  finding: z.infer<typeof wasteFindingBodySchema>
): string {
  const identity = {
    findingType: finding.findingType,
    scope: finding.scope,
    candidateAction: finding.candidateAction,
    target: finding.target
  };
  return `wfc_v0_${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

function experimentDigest(experiment: ParsedExperimentBody): string {
  // Experiment identity deliberately excludes post-change evidence so the same
  // ID survives lifecycle updates. Baseline references and policy remain fixed.
  const identity = {
    kind: experiment.kind,
    schemaVersion: experiment.schemaVersion,
    createdAt: experiment.createdAt,
    findingId: experiment.finding.id,
    cohort: experiment.cohort,
    matchingPolicy: experiment.matchingPolicy,
    qualityGuard: experiment.qualityGuard,
    baselineSessionRefs: experiment.baselineSessions.map((session) => session.sessionRef)
  };
  return `tre_v0_${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

function experimentRevisionDigest(experiment: ParsedExperimentBody): string {
  return `trev_v0_${createHash("sha256")
    .update(canonicalJson(experiment))
    .digest("hex")}`;
}

function compareExclusions(
  left: TokenReductionEvaluationV0["exclusions"][number],
  right: TokenReductionEvaluationV0["exclusions"][number]
): number {
  return compareText(
    `${left.phase}\u0000${left.sessionRef}`,
    `${right.phase}\u0000${right.sessionRef}`
  );
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
