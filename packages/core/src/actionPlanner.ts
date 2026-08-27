import { createHash } from "node:crypto";
import type { ContextHealthResult } from "./contextHealth.js";
import type { DeadContextResult } from "./deadContext.js";
import { localAgentFormatDescriptor } from "./localAgentFormats/registry.js";
import type { SessionVitalV0, SessionVitalsV0 } from "./sessionVitals.js";
import {
  MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0,
  MAX_WASTE_FINDING_EVIDENCE_REFS_V0,
  TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
  TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
  WASTE_FINDING_V0_KIND,
  WASTE_FINDING_V0_VERSION,
  createActionVerificationReference,
  createTokenReductionExperimentV0,
  createWasteFindingV0,
  type TokenExperimentSessionV0Input,
  type TokenReductionExperimentV0,
  type TokenReductionExperimentV0DraftInput,
  type WasteFindingV0,
  type WasteFindingV0DraftInput
} from "./actionVerification.js";
import { safeUntrustedLabel, WITHHELD_FILE_LABEL } from "./untrustedLabel.js";

const MINIMUM_SESSIONS = 3;
const CONTEXT_RATIO_THRESHOLD = 1.5;
const FRESH_MS = 72 * 60 * 60 * 1_000;
const AV_REF = /^avref_[a-f0-9]{64}$/;

export type UserDeclaredQualityV0 = "passed" | "failed" | "missing";

export type ActionPlannerInputV0 = {
  sessionVitals: SessionVitalsV0;
  generatedAt: string;
  contextHealth?: ContextHealthResult;
  deadContext?: DeadContextResult;
  /** Optional user assertion. Absence remains missing rather than inferred. */
  qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>;
};

export type TokenReductionActionPlanV0 = {
  finding: WasteFindingV0;
  experiment: TokenReductionExperimentV0;
};

export type ApplyTokenReductionExperimentV0Input = {
  approvedAt: string;
  appliedAt: string;
  /** Opaque AV references to the exact change, rollback, and canary evidence. */
  changeRef: string;
  rollbackRef: string;
  canaryRef: string;
  canaryStatus: "passed" | "failed";
};

export type RollBackTokenReductionExperimentV0Input = {
  rolledBackAt: string;
  rollbackRef: string;
};

export type InvalidateTokenReductionExperimentV0Input = {
  invalidatedAt: string;
  reason: "manual";
};

export type RefreshTokenReductionExperimentV0Input = {
  sessionVitals: SessionVitalsV0;
  observedAt: string;
  /** Current-session evidence prevents an in-progress session entering the post cohort. */
  contextHealth?: ContextHealthResult;
  qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>;
};

export type ActionVerificationProjectionV0 = {
  schemaVersion: 0;
  experimentId: string;
  findingId: string;
  candidateKey: string;
  state:
    | "collect_baseline"
    | "approve_one_change"
    | "collect_post_change"
    | "review_measured_result"
    | "rollback"
    | "rolled_back"
    | "cancelled"
    | "resolve_evidence";
  tone: "neutral" | "attention" | "positive" | "negative";
  headline: string;
  detail: string;
  evidenceLabel: "calculated" | "missing";
  qualityLabel: "held" | "regressed" | "insufficient";
  qualityEvidence: "verified" | "observed" | "user_declared" | "missing";
  baselineSessions: number;
  postChangeSessions: number;
  minimumSessions: number;
  reductionPercent: number | null;
};

/**
 * Select the experiment every read-only surface should foreground.
 *
 * Active work outranks newer terminal history so CLI, MCP, and Glance cannot
 * silently hand the user different tests. Creation time and stable lineage ID
 * are deterministic tie-breakers only within the same lifecycle priority.
 */
export function selectPreferredTokenReductionExperimentV0(
  experiments: readonly TokenReductionExperimentV0[]
): TokenReductionExperimentV0 | undefined {
  return experiments.reduce<TokenReductionExperimentV0 | undefined>((preferred, candidate) => {
    if (!preferred) return candidate;
    const candidatePriority = experimentSelectionPriority(candidate);
    const preferredPriority = experimentSelectionPriority(preferred);
    if (candidatePriority !== preferredPriority) {
      return candidatePriority > preferredPriority ? candidate : preferred;
    }
    const candidateTime = Date.parse(candidate.createdAt);
    const preferredTime = Date.parse(preferred.createdAt);
    if (candidateTime !== preferredTime) {
      return candidateTime > preferredTime ? candidate : preferred;
    }
    return candidate.id.localeCompare(preferred.id) > 0 ? candidate : preferred;
  }, undefined);
}

function experimentSelectionPriority(experiment: TokenReductionExperimentV0): number {
  switch (experiment.lifecycle) {
    case "applied":
    case "collecting": return 4;
    case "baseline_ready":
    case "draft": return 3;
    case "complete": return 2;
    case "rolled_back":
    case "invalidated": return 1;
  }
}

export type ResolvedWasteFindingTargetV0 =
  | {
      status: "resolved";
      kind: "session";
      ref: string;
      agent: "claude-code" | "codex";
      sessionType: "parent" | "subagent" | "unknown";
      observedFrom: string;
      observedTo: string;
      localOnly: true;
    }
  | {
      status: "resolved";
      kind: "repeated_read_file";
      ref: string;
      file: string;
      readCount: number;
      localOnly: true;
    }
  | {
      status: "resolved";
      kind: "configured_item";
      ref: string;
      name: string;
      itemKind: string;
      path?: string;
      localOnly: true;
    }
  | {
      status: "not_found";
      kind: WasteFindingV0["target"]["kind"];
      ref: string;
      localOnly: true;
    };

type PlannerSession = {
  vital: SessionVitalV0;
  agent: "claude-code" | "codex";
  provider: "anthropic" | "openai";
  model: string;
  projectRef: string;
  sessionType: "parent" | "subagent";
  workTypeRef: string;
  /** Present only when one exact host/source version was observed. */
  sourceVersionRef?: string;
  startedAt: string;
  endedAt: string;
};

type PlannerGroup = {
  key: string;
  agent: PlannerSession["agent"];
  provider: PlannerSession["provider"];
  model: string;
  projectRef: string;
  project?: string;
  sessionType: PlannerSession["sessionType"];
  workTypeRef: string;
  sourceVersionRef?: string;
  sessions: PlannerSession[];
};

/**
 * Return at most one launch-safe candidate. Signal priority is explicit
 * compaction, explicit repeated reads, a calculated context ratio, then
 * measured configured-not-observed inventory. No prompt, path, or item name is
 * carried into the finding.
 */
export function selectBestWasteFindingV0(
  input: ActionPlannerInputV0
): WasteFindingV0 | null {
  const generatedAt = timestamp(input.generatedAt, "generatedAt");
  const groups = comparableGroups(input.sessionVitals, generatedAt, input.contextHealth)
    .filter((group) => group.sessions.length >= MINIMUM_SESSIONS);
  if (groups.length === 0) return null;

  const currentSession = activePlannerSession(
    input.sessionVitals.sessions,
    input.contextHealth,
    generatedAt
  );
  const currentGroup = currentSession
    ? groupForActiveSession(groups, currentSession)
    : undefined;
  const currentSessionRef = currentSession?.vital.sessionRef;
  const churn = input.contextHealth?.contextChurn;
  if (currentGroup && currentSessionRef && churn?.currentSessionEvidence === "matched") {
    if ((churn.compactionEvents ?? 0) > 0) {
      return findingForGroup(currentGroup, generatedAt, {
        findingType: "compaction_pressure",
        action: "start_fresh",
        sourceId: "context-health-v1",
        metric: {
          name: "compaction_events",
          unit: "events",
          value: churn.compactionEvents!,
          sampleCount: 1,
          evidence: "observed"
        },
        signalRef: createActionVerificationReference(
          "context-signal",
          `compaction:${churn.compactionEvents}`
        ),
        target: { kind: "session", ref: currentSessionRef }
      });
    }
    if (churn.readCoverage === "explicit_read_tools_only" &&
        (churn.repeatedReadEvents ?? 0) > 0) {
      const repeated = [...churn.repeatedFiles].sort((left, right) =>
        right.readCount - left.readCount || left.file.localeCompare(right.file)
      )[0];
      if (!repeated) return null;
      return findingForGroup(currentGroup, generatedAt, {
        findingType: "repeated_context_read",
        action: "reduce_repeated_reads",
        sourceId: "context-health-v1",
        metric: {
          name: "repeated_read_events",
          unit: "events",
          value: churn.repeatedReadEvents!,
          sampleCount: 1,
          evidence: "observed"
        },
        signalRef: createActionVerificationReference(
          "context-signal",
          `repeated-read:${churn.repeatedReadEvents}`
        ),
        target: {
          kind: "repeated_read_file",
          ref: repeatedReadTargetRef(repeated.file)
        }
      });
    }
    const current = input.contextHealth?.currentSession;
    if (current && current.ratioToMedian !== null &&
        current.ratioToMedian >= CONTEXT_RATIO_THRESHOLD &&
        current.comparisonSessions >= 2 &&
        current.comparisonBasis !== "not_available" &&
        current.usageSource !== "not_available") {
      return findingForGroup(currentGroup, generatedAt, {
        findingType: "high_context_relative_to_baseline",
        action: "trim_context",
        sourceId: "context-health-v1",
        metric: {
          name: "input_context_tokens",
          unit: "ratio",
          value: round(current.ratioToMedian),
          sampleCount: current.comparisonSessions,
          evidence: "calculated"
        },
        signalRef: createActionVerificationReference(
          "context-signal",
          `context-ratio:${round(current.ratioToMedian)}:${current.comparisonSessions}`
        ),
        target: { kind: "session", ref: currentSessionRef }
      });
    }
  }

  const dead = measuredDeadInventory(input.deadContext);
  if (dead) {
    const group = groups.find((candidate) => candidate.agent === dead.host) ??
      (!dead.host ? groups[0] : undefined);
    if (group) {
      const scopedItems = dead.items.filter((item) => !item.host || item.host === group.agent)
        .sort((left, right) =>
          right.alwaysLoadedTokens - left.alwaysLoadedTokens ||
          left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name) ||
          (left.path ?? "").localeCompare(right.path ?? "")
        );
      const count = scopedItems.length;
      if (count > 0) {
        const item = scopedItems[0]!;
        return findingForGroup(group, generatedAt, {
          findingType: "configured_not_observed",
          action: "inspect_scope",
          sourceId: "dead-context-v1",
          surface: "local_agent_configuration",
          metric: {
            name: "configured_items",
            unit: "items",
            value: count,
            sampleCount: input.deadContext!.sessions,
            evidence: "observed"
          },
          signalRef: createActionVerificationReference(
            "inventory-signal",
            `${group.agent}:${count}:${input.deadContext!.windowDays}`
          ),
          target: {
            kind: "configured_item",
            ref: configuredItemTargetRef(item)
          }
        });
      }
    }
  }

  for (const group of groups) {
    const ordered = [...group.sessions].sort(comparePlannerSessions);
    const latest = ordered.at(-1)!;
    if (Date.parse(generatedAt) - Date.parse(latest.endedAt) > FRESH_MS) continue;
    const previous = ordered.slice(0, -1)
      .map((session) => totalTokens(session.vital))
      .filter((value): value is number => value !== null);
    const latestTotal = totalTokens(latest.vital);
    const comparisonMedian = median(previous);
    if (latestTotal === null || comparisonMedian === null || comparisonMedian <= 0 ||
        previous.length < 2) continue;
    const ratio = latestTotal / comparisonMedian;
    if (ratio < CONTEXT_RATIO_THRESHOLD) continue;
    return findingForGroup(group, generatedAt, {
      findingType: "high_context_relative_to_baseline",
      action: "trim_context",
      sourceId: "session-vitals-v0",
      metric: {
        name: "total_tokens",
        unit: "ratio",
        value: round(ratio),
        sampleCount: previous.length,
        evidence: "calculated"
      },
      signalRef: latest.vital.sessionRef,
      target: { kind: "session", ref: latest.vital.sessionRef }
    });
  }
  return null;
}

/** Resolve an opaque candidate only from fresh local evidence supplied by the caller. */
export function resolveWasteFindingTargetV0(input: {
  finding: WasteFindingV0;
  sessionVitals?: SessionVitalsV0;
  contextHealth?: ContextHealthResult;
  deadContext?: DeadContextResult;
}): ResolvedWasteFindingTargetV0 {
  const { finding } = input;
  if (finding.target.kind === "repeated_read_file") {
    const match = input.contextHealth?.contextChurn.repeatedFiles.find((item) =>
      repeatedReadTargetRef(item.file) === finding.target.ref
    );
    return match
      ? {
          status: "resolved",
          kind: "repeated_read_file",
          ref: finding.target.ref,
          // Already neutralized upstream; re-applied because a resolved target
          // is written into the Apply artifact an agent reads.
          file: safeUntrustedLabel(match.file, WITHHELD_FILE_LABEL),
          readCount: match.readCount,
          localOnly: true
        }
      : { status: "not_found", kind: finding.target.kind, ref: finding.target.ref, localOnly: true };
  }
  if (finding.target.kind === "configured_item") {
    const match = input.deadContext?.deadItems.find((item) =>
      configuredItemTargetRef(item) === finding.target.ref
    );
    return match
      ? {
          status: "resolved",
          kind: "configured_item",
          ref: finding.target.ref,
          name: match.name,
          itemKind: match.kind,
          ...(match.path ? { path: match.path } : {}),
          localOnly: true
        }
      : { status: "not_found", kind: finding.target.kind, ref: finding.target.ref, localOnly: true };
  }
  const matches = input.sessionVitals?.sessions.filter((session) =>
    session.sessionRef === finding.target.ref &&
    session.agent === finding.scope.agent &&
    (!finding.scope.projectRef || session.projectRef === finding.scope.projectRef) &&
    (!finding.scope.model ||
      session.models.length === 1 &&
      safeOutputIdentifier("model", session.models[0]!) === finding.scope.model)
  ) ?? [];
  const session = matches.length === 1 ? matches[0] : undefined;
  const observedFrom = session ? normalizedTimestamp(session.observedFrom) : null;
  const observedTo = session ? normalizedTimestamp(session.observedTo) : null;
  if (!session || !observedFrom || !observedTo ||
      (session.agent !== "claude-code" && session.agent !== "codex") ||
      !["parent", "subagent", "unknown"].includes(session.sessionType)) {
    return { status: "not_found", kind: "session", ref: finding.target.ref, localOnly: true };
  }
  return {
    status: "resolved",
    kind: "session",
    ref: finding.target.ref,
    agent: session.agent,
    sessionType: session.sessionType,
    observedFrom,
    observedTo,
    localOnly: true
  };
}

/** Build one immutable pre-change cohort. Fewer than three sessions fails closed. */
export function buildTokenReductionBaselineV0(input: {
  finding: WasteFindingV0;
  sessionVitals: SessionVitalsV0;
  createdAt: string;
  contextHealth?: ContextHealthResult;
  qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>;
}): TokenReductionExperimentV0 | null {
  const createdAt = timestamp(input.createdAt, "createdAt");
  if (input.finding.source.freshness !== "fresh" ||
      input.finding.source.validationCoverage !== "live_verified") return null;
  const groups = comparableGroups(input.sessionVitals, createdAt, input.contextHealth)
    .filter((group) =>
      group.sessions.length >= MINIMUM_SESSIONS &&
      group.agent === input.finding.scope.agent &&
      group.provider === input.finding.scope.provider &&
      group.model === input.finding.scope.model &&
      group.projectRef === input.finding.scope.projectRef
    )
    .sort((left, right) => {
      const overlap = findingOverlap(input.finding, right) - findingOverlap(input.finding, left);
      return overlap || compareGroups(left, right);
    });
  const group = groups[0];
  if (!group) return null;
  const boundedBaseline = group.sessions.slice(
    -MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0
  );

  return createTokenReductionExperimentV0({
    kind: TOKEN_REDUCTION_EXPERIMENT_V0_KIND,
    schemaVersion: TOKEN_REDUCTION_EXPERIMENT_V0_VERSION,
    createdAt,
    finding: input.finding,
    cohort: {
      agent: group.agent,
      provider: group.provider,
      model: group.model,
      projectRef: group.projectRef,
      sessionType: group.sessionType,
      workTypeRef: group.workTypeRef,
      workTypeEvidence: "observed",
      ...(group.sourceVersionRef ? { sourceVersionRef: group.sourceVersionRef } : {})
    },
    matchingPolicy: {
      basis: "session_cohort",
      minimumBaselineSessions: MINIMUM_SESSIONS,
      minimumPostSessions: MINIMUM_SESSIONS,
      requireExactSourceVersion: group.sourceVersionRef !== undefined
    },
    qualityGuard: {
      required: true,
      minimumEvidence: "user_declared",
      rollbackOnRegression: true
    },
    baselineSessions: boundedBaseline.map((session) =>
      experimentSession(session, input.qualityBySessionRef)
    ),
    intervention: {
      approval: { status: "pending", evidence: "missing" }
    },
    postSessions: []
  });
}

/** Select one finding and prepare its baseline, or return null without guessing. */
export function planTokenReductionActionV0(
  input: ActionPlannerInputV0
): TokenReductionActionPlanV0 | null {
  const finding = selectBestWasteFindingV0(input);
  if (!finding) return null;
  const experiment = buildTokenReductionBaselineV0({
    finding,
    sessionVitals: input.sessionVitals,
    createdAt: input.generatedAt,
    contextHealth: input.contextHealth,
    qualityBySessionRef: input.qualityBySessionRef
  });
  return experiment ? { finding, experiment } : null;
}

/** Record explicit approval, an applied reversible change, and the actual canary outcome. */
export function markTokenReductionAppliedV0(
  experiment: TokenReductionExperimentV0,
  input: ApplyTokenReductionExperimentV0Input
): TokenReductionExperimentV0 {
  if (!AV_REF.test(input.changeRef)) {
    throw new TypeError("A change must be represented by an opaque action-verification reference.");
  }
  if (!AV_REF.test(input.rollbackRef)) {
    throw new TypeError("A rollback must be represented by an opaque action-verification reference.");
  }
  if (!AV_REF.test(input.canaryRef)) {
    throw new TypeError("A canary must be represented by an opaque action-verification reference.");
  }
  const approvedAt = timestamp(input.approvedAt, "approvedAt");
  const appliedAt = timestamp(input.appliedAt, "appliedAt");
  if (experiment.lifecycle !== "baseline_ready") {
    throw new TypeError("A complete comparable baseline is required before application.");
  }
  if (experiment.baselineSessions.some((session) =>
    session.quality.status !== "passed" ||
    qualityEvidenceRank(session.quality.evidence) <
      qualityEvidenceRank(experiment.qualityGuard.minimumEvidence)
  )) {
    throw new TypeError("Baseline quality must be recorded before the intervention boundary.");
  }
  return createTokenReductionExperimentV0({
    ...experimentBody(experiment),
    intervention: {
      approval: {
        status: "explicit",
        evidence: "user_declared",
        approvedAt
      },
      appliedAt,
      changeRef: input.changeRef,
      rollbackRef: input.rollbackRef,
      canary: {
        status: input.canaryStatus,
        evidence: "user_declared",
        evidenceRef: input.canaryRef
      }
    }
  });
}

/** Record execution of the rollback already frozen at the application boundary. */
export function markTokenReductionRolledBackV0(
  experiment: TokenReductionExperimentV0,
  input: RollBackTokenReductionExperimentV0Input
): TokenReductionExperimentV0 {
  if (experiment.lifecycle === "rolled_back" || experiment.lifecycle === "invalidated" ||
      experiment.intervention.rolledBackAt) {
    throw new TypeError("A terminal token test cannot record another rollback boundary.");
  }
  if (!experiment.intervention.appliedAt || !experiment.intervention.rollbackRef) {
    throw new TypeError("Only an applied token test can be rolled back.");
  }
  if (input.rollbackRef !== experiment.intervention.rollbackRef) {
    throw new TypeError("The rollback evidence does not match the frozen rollback reference.");
  }
  const rolledBackAt = timestamp(input.rolledBackAt, "rolledBackAt");
  return createTokenReductionExperimentV0({
    ...experimentBody(experiment),
    intervention: {
      ...experiment.intervention,
      rolledBackAt
    }
  });
}

/** Cancel an un-applied baseline so its scope can be used by a future test. */
export function invalidateTokenReductionExperimentV0(
  experiment: TokenReductionExperimentV0,
  input: InvalidateTokenReductionExperimentV0Input
): TokenReductionExperimentV0 {
  if (experiment.intervention.appliedAt ||
      (experiment.lifecycle !== "draft" && experiment.lifecycle !== "baseline_ready")) {
    throw new TypeError(
      "Only an un-applied draft or baseline can be cancelled; applied changes require rollback."
    );
  }
  return createTokenReductionExperimentV0({
    ...experimentBody(experiment),
    invalidation: {
      reason: input.reason,
      invalidatedAt: timestamp(input.invalidatedAt, "invalidatedAt")
    }
  });
}

/**
 * Add matched completed session snapshots after the application boundary, then delegate every
 * median, exclusion, quality guard, and result label to the canonical evaluator.
 */
export function refreshTokenReductionExperimentV0(
  experiment: TokenReductionExperimentV0,
  input: RefreshTokenReductionExperimentV0Input
): TokenReductionExperimentV0 {
  if (experiment.lifecycle === "complete" || experiment.lifecycle === "rolled_back" ||
      experiment.lifecycle === "invalidated" ||
      experiment.intervention.canary?.status === "failed") {
    throw new TypeError(
      "A complete, terminal, or failed-canary token test cannot collect new evidence."
    );
  }
  const observedAt = timestamp(input.observedAt, "observedAt");
  const appliedAt = experiment.intervention.appliedAt;
  if (!appliedAt) throw new TypeError("An experiment must be applied before post-change refresh.");

  // The baseline and its quality evidence are immutable after the intervention
  // boundary. One native session reference contributes at most one frozen
  // snapshot in the entire experiment. A resumed cumulative session is never
  // converted into a synthetic delta or a second sample.
  const baselineSessions = experiment.baselineSessions;
  const baselineRefs = new Set(baselineSessions.map((session) => session.sessionRef));
  const observedPostSessions = structurallyEligibleSessions(
    input.sessionVitals,
    observedAt,
    input.contextHealth
  )
    // Keep the persisted experiment project-scoped. Unrelated sessions are
    // neither evidence nor useful exclusions, and a busy machine must not be
    // able to overflow another project's bounded experiment envelope.
    .filter((session) => sessionMatchesCohort(experiment, session))
    .filter((session) => Date.parse(session.startedAt) >= Date.parse(appliedAt))
    .filter((session) => !baselineRefs.has(session.vital.sessionRef))
    .sort(comparePlannerSessions);
  const postByRef = new Map(
    experiment.postSessions.map((session) => [session.sessionRef, session] as const)
  );
  for (const observed of observedPostSessions) {
    const prior = postByRef.get(observed.vital.sessionRef);
    if (prior) {
      const requested = input.qualityBySessionRef?.[prior.sessionRef];
      if (prior.quality.status === "missing" && requested && requested !== "missing") {
        postByRef.set(prior.sessionRef, {
          ...prior,
          quality: qualityFor(prior.sessionRef, input.qualityBySessionRef)
        });
      }
      continue;
    }
    if (postByRef.size >= MAX_TOKEN_EXPERIMENT_SESSIONS_PER_PHASE_V0) continue;
    const next = experimentSession(observed, input.qualityBySessionRef);
    postByRef.set(next.sessionRef, next);
  }
  const postSessions = [...postByRef.values()];
  return createTokenReductionExperimentV0({
    ...experimentBody(experiment),
    baselineSessions,
    postSessions,
    intervention: experiment.intervention
  });
}

/** One safe cross-surface projection for CLI, MCP, and Glance adapters. */
export function buildActionVerificationProjectionV0(
  experiment: TokenReductionExperimentV0
): ActionVerificationProjectionV0 {
  const evaluation = experiment.evaluation;
  let state: ActionVerificationProjectionV0["state"];
  let tone: ActionVerificationProjectionV0["tone"];
  let headline: string;
  let detail: string;

  if (experiment.lifecycle === "rolled_back") {
    state = "rolled_back";
    tone = "neutral";
    headline = "Token test rolled back";
    detail = "The rollback boundary is recorded; this attempt cannot support a reduction claim.";
  } else if (experiment.lifecycle === "invalidated") {
    state = "cancelled";
    tone = "neutral";
    headline = "Token test cancelled";
    detail = "The un-applied baseline remains in local history; start a new test from fresh evidence.";
  } else if (evaluation.rollbackRecommended) {
    state = "rollback";
    tone = "negative";
    headline = "Quality or token use regressed";
    detail = "Roll back the one approved change and keep the evidence.";
  } else if (experiment.lifecycle === "draft") {
    state = "collect_baseline";
    tone = "neutral";
    headline = "Collect three comparable completed session snapshots";
    detail = "Only explicit Claude turn or Codex task completion markers count; resumed native sessions do not become a second sample.";
  } else if (experiment.lifecycle === "baseline_ready") {
    state = "approve_one_change";
    tone = "attention";
    headline = "One reversible token test is ready";
    detail = "Define and approve one exact change, rollback, and canary before any handoff.";
  } else if (experiment.lifecycle === "applied" || experiment.lifecycle === "collecting") {
    state = "collect_post_change";
    tone = "neutral";
    headline = "Collect three matched post-change sessions";
    detail = "Record whether quality passed, failed, or is still missing.";
  } else if (evaluation.status === "measured_token_reduction") {
    state = "review_measured_result";
    tone = "positive";
    headline = "A measured token reduction is ready to review";
    detail = "This is a matched session result, not verified outcome ROI or cash savings.";
  } else if (evaluation.status === "no_measured_change") {
    state = "review_measured_result";
    tone = "neutral";
    headline = "No measured token change";
    detail = "The matched session medians were unchanged; do not claim a reduction.";
  } else {
    state = "resolve_evidence";
    tone = "attention";
    headline = "The token test is inconclusive";
    detail = "Resolve missing quality or matching evidence before making a claim.";
  }

  return {
    schemaVersion: 0,
    experimentId: experiment.id,
    findingId: experiment.finding.id,
    candidateKey: experiment.finding.candidateKey,
    state,
    tone,
    headline,
    detail,
    evidenceLabel: evaluation.metricEvidence,
    qualityLabel: evaluation.qualityStatus,
    qualityEvidence: evaluation.qualityEvidence,
    baselineSessions: evaluation.baseline.includedSessions,
    postChangeSessions: evaluation.postChange.includedSessions,
    minimumSessions: experiment.matchingPolicy.minimumPostSessions,
    reductionPercent: evaluation.reductionPercent
  };
}

function comparableGroups(
  vitals: SessionVitalsV0,
  asOf: string,
  contextHealth?: ContextHealthResult
): PlannerGroup[] {
  const sessions = structurallyEligibleSessions(vitals, asOf, contextHealth);
  const groups = new Map<string, PlannerGroup>();
  for (const session of sessions) {
    const project = session.vital.project;
    const key = [
      session.agent,
      session.provider,
      session.model,
      session.projectRef,
      session.sessionType,
      session.workTypeRef,
      session.sourceVersionRef ?? "source-version-missing"
    ].join("\u0000");
    const group = groups.get(key) ?? {
      key,
      agent: session.agent,
      provider: session.provider,
      model: session.model,
      projectRef: session.projectRef,
      ...(project ? { project } : {}),
      sessionType: session.sessionType,
      workTypeRef: session.workTypeRef,
      ...(session.sourceVersionRef ? { sourceVersionRef: session.sourceVersionRef } : {}),
      sessions: []
    };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sessions: group.sessions.sort(comparePlannerSessions) }))
    .sort(compareGroups);
}

function structurallyEligibleSessions(
  vitals: SessionVitalsV0,
  asOf: string,
  contextHealth?: ContextHealthResult
): PlannerSession[] {
  const asOfMs = Date.parse(asOf);
  const duplicateRefs = new Set<string>();
  const refCounts = new Map<string, number>();
  for (const vital of vitals.sessions) {
    refCounts.set(vital.sessionRef, (refCounts.get(vital.sessionRef) ?? 0) + 1);
  }
  for (const [ref, count] of refCounts) if (count > 1) duplicateRefs.add(ref);
  const activeRef = activeSessionRef(vitals.sessions, contextHealth, asOf);

  return vitals.sessions.flatMap((vital): PlannerSession[] => {
    if (duplicateRefs.has(vital.sessionRef) || vital.sessionRef === activeRef ||
        !AV_REF.test(vital.sessionRef) || vital.tokenEvidence.status !== "observed" ||
        vital.completion.status !== "completed" ||
        vital.sessionType === "unknown" || !vital.activity ||
        vital.models.length !== 1 ||
        vital.sourceVersions.length > 1 ||
        !vital.projectRef || !AV_REF.test(vital.projectRef)) return [];
    const startedAt = normalizedTimestamp(vital.observedFrom);
    const endedAt = normalizedTimestamp(vital.observedTo);
    if (!startedAt || !endedAt || Date.parse(startedAt) > Date.parse(endedAt) ||
        Date.parse(endedAt) > asOfMs) return [];
    const provider = providerFor(vital.agent);
    const sourceVersionRef = createActionPlanningSourceVersionReferenceV0(
      vital.agent,
      vital.sourceVersions[0]
    );
    if (!provider || !sourceVersionRef || totalTokens(vital) === null) return [];
    return [{
      vital,
      agent: vital.agent,
      provider,
      model: safeOutputIdentifier("model", vital.models[0]!),
      projectRef: vital.projectRef,
      sessionType: vital.sessionType,
      workTypeRef: createActionVerificationReference(
        "coarse-work-type",
        `${vital.activity.kind}:${vital.activity.action}`
      ),
      // Missing host versions remain explicitly labeled inside the opaque
      // reference. Every cohort is still bound to the parser contract so a
      // parser update cannot silently compare old and new semantics.
      sourceVersionRef,
      startedAt,
      endedAt
    }];
  });
}

function activeSessionRef(
  sessions: readonly SessionVitalV0[],
  contextHealth?: ContextHealthResult,
  asOf?: string
): string | undefined {
  return activePlannerSession(sessions, contextHealth, asOf)?.vital.sessionRef;
}

function activePlannerSession(
  sessions: readonly SessionVitalV0[],
  contextHealth?: ContextHealthResult,
  asOf?: string
): PlannerSession | undefined {
  const current = contextHealth?.currentSession;
  if (!current || current.status !== "active" || !safeProject(current.project)) return undefined;
  const scope = contextHealth?.contextChurn.currentSessionScope;
  const refCounts = new Map<string, number>();
  for (const session of sessions) {
    refCounts.set(session.sessionRef, (refCounts.get(session.sessionRef) ?? 0) + 1);
  }
  const asOfMs = asOf ? Date.parse(asOf) : Number.POSITIVE_INFINITY;
  return sessions
    .filter((session) =>
      session.agent === current.agent &&
      session.project === current.project &&
      (scope !== "parent" && scope !== "subagent" || session.sessionType === scope) &&
      refCounts.get(session.sessionRef) === 1
    )
    .flatMap((vital): PlannerSession[] => {
      if (!AV_REF.test(vital.sessionRef) || vital.sessionType === "unknown" ||
          !vital.activity || vital.models.length !== 1 || vital.sourceVersions.length > 1 ||
          !vital.projectRef || !AV_REF.test(vital.projectRef)) return [];
      const startedAt = normalizedTimestamp(vital.observedFrom);
      const endedAt = normalizedTimestamp(vital.observedTo);
      if (!startedAt || !endedAt || Date.parse(startedAt) > Date.parse(endedAt) ||
          Date.parse(endedAt) > asOfMs) return [];
      const provider = providerFor(vital.agent);
      const sourceVersionRef = createActionPlanningSourceVersionReferenceV0(
        vital.agent,
        vital.sourceVersions[0]
      );
      if (!provider || !sourceVersionRef) return [];
      return [{
        vital,
        agent: vital.agent,
        provider,
        model: safeOutputIdentifier("model", vital.models[0]!),
        projectRef: vital.projectRef,
        sessionType: vital.sessionType,
        workTypeRef: createActionVerificationReference(
          "coarse-work-type",
          `${vital.activity.kind}:${vital.activity.action}`
        ),
        sourceVersionRef,
        startedAt,
        endedAt
      }];
    })
    .sort((left, right) =>
      Date.parse(right.endedAt) - Date.parse(left.endedAt) ||
      left.vital.sessionRef.localeCompare(right.vital.sessionRef)
    )[0];
}

function groupForActiveSession(
  groups: PlannerGroup[],
  active: PlannerSession
): PlannerGroup | undefined {
  return groups.find((group) =>
    group.agent === active.agent &&
    group.provider === active.provider &&
    group.model === active.model &&
    group.projectRef === active.projectRef &&
    group.sessionType === active.sessionType &&
    group.workTypeRef === active.workTypeRef &&
    group.sourceVersionRef === active.sourceVersionRef
  );
}

function findingForGroup(
  group: PlannerGroup,
  generatedAt: string,
  signal: {
    findingType: WasteFindingV0DraftInput["findingType"];
    action: WasteFindingV0DraftInput["candidateAction"]["kind"];
    sourceId: string;
    surface?: WasteFindingV0DraftInput["candidateAction"]["surface"];
    metric: WasteFindingV0DraftInput["metric"];
    signalRef: string;
    target: WasteFindingV0DraftInput["target"];
  }
): WasteFindingV0 {
  const first = group.sessions[0]!;
  const last = group.sessions.at(-1)!;
  const sourceObservedAt = signal.sourceId === "session-vitals-v0"
    ? last.endedAt
    : generatedAt;
  return createWasteFindingV0({
    kind: WASTE_FINDING_V0_KIND,
    schemaVersion: WASTE_FINDING_V0_VERSION,
    generatedAt,
    window: {
      start: first.startedAt,
      // Context Health and inventory signals are observed at generation time,
      // so their evidence window must include that observation rather than
      // ending at the last historical baseline session.
      end: signal.sourceId === "session-vitals-v0" ? last.endedAt : generatedAt
    },
    findingType: signal.findingType,
    objective: {
      metric: "total_tokens_per_matched_session",
      direction: "reduce",
      guard: "user_declared_quality_must_hold"
    },
    caveats: ["signal_not_cause", "no_cash_claim", "missing_outcome_evidence"],
    candidateAction: {
      kind: signal.action,
      provider: group.provider,
      surface: signal.surface ?? "session_workflow",
      reversible: true,
      canaryRequired: true,
      rollbackRequired: true
    },
    target: signal.target,
    scope: {
      agent: group.agent,
      provider: group.provider,
      model: group.model,
      projectRef: group.projectRef
    },
    source: {
      id: signal.sourceId,
      validationCoverage: "live_verified",
      freshness: Date.parse(generatedAt) - Date.parse(sourceObservedAt) <= FRESH_MS
        ? "fresh"
        : "stale"
    },
    metric: signal.metric,
    evidenceRefs: boundedEvidenceRefs(
      group.sessions.map((session) => session.vital.sessionRef),
      signal.signalRef
    ),
    causalStatus: "unproven",
    actionability: "inspect_only",
    approvalRequired: true
  });
}

function measuredDeadInventory(result?: DeadContextResult): {
  host?: "claude-code" | "codex";
  items: DeadContextResult["deadItems"];
} | null {
  if (!result?.hasData || result.isSample || result.measuredDeadCount <= 0) return null;
  const items = result.deadItems.filter((item) =>
    item.weightConfidence === "estimated" &&
    item.alwaysLoadedTokens > 0 &&
    item.kind !== "mcp_server" &&
    item.kind !== "mcp_tool"
  );
  if (items.length === 0) return null;
  const byHost = new Map<"claude-code" | "codex", number>();
  for (const item of items) if (item.host) {
    byHost.set(item.host, (byHost.get(item.host) ?? 0) + 1);
  }
  const host = [...byHost.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  )[0]?.[0];
  return { ...(host ? { host } : {}), items };
}

function repeatedReadTargetRef(file: string): string {
  return createActionVerificationReference("repeated-read-file", file);
}

function configuredItemTargetRef(item: DeadContextResult["deadItems"][number]): string {
  return createActionVerificationReference(
    "configured-item",
    JSON.stringify({
      kind: item.kind,
      name: item.name,
      scope: item.scope,
      host: item.host ?? null,
      path: item.path ?? null,
      ownerDirs: [...(item.ownerDirs ?? [])].sort()
    })
  );
}

function experimentSession(
  session: PlannerSession,
  qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>
): TokenExperimentSessionV0Input {
  const evidence = session.vital.tokenEvidence;
  if (evidence.status !== "observed") throw new TypeError("Planner session lost token evidence.");
  const cacheWriteTokens = evidence.componentEvidence.cacheWriteTokens === "observed" &&
      evidence.cacheWrite5mTokens !== undefined &&
      evidence.cacheWrite1hTokens !== undefined
    ? evidence.cacheWrite5mTokens + evidence.cacheWrite1hTokens
    : null;
  return {
    sessionRef: session.vital.sessionRef,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    agent: session.agent,
    provider: session.provider,
    model: session.model,
    projectRef: session.projectRef,
    sessionType: session.sessionType,
    workTypeRef: session.workTypeRef,
    ...(session.sourceVersionRef ? { sourceVersionRef: session.sourceVersionRef } : {}),
    sourceValidationCoverage: "live_verified",
    tokens: {
      uncachedInputTokens: evidence.inputTokens,
      cacheReadTokens: evidence.componentEvidence.cacheReadTokens === "observed"
        ? evidence.cacheReadTokens ?? null
        : null,
      cacheWriteTokens,
      toolTokens: evidence.componentEvidence.toolTokens === "observed"
        ? evidence.toolTokens ?? null
        : null,
      outputTokens: evidence.outputTokens,
      thoughtTokens: evidence.componentEvidence.thoughtTokens === "observed"
        ? evidence.thoughtTokens ?? null
        : null,
      calculatedTotalTokens: evidence.componentTotalTokens,
      reportedTotalTokens: evidence.reportedTotalTokens ?? null,
      componentEvidence: {
        uncachedInputTokens: evidence.componentEvidence.inputTokens,
        cacheReadTokens: evidence.componentEvidence.cacheReadTokens,
        cacheWriteTokens: evidence.componentEvidence.cacheWriteTokens,
        toolTokens: evidence.componentEvidence.toolTokens,
        outputTokens: evidence.componentEvidence.outputTokens,
        thoughtTokens: evidence.componentEvidence.thoughtTokens,
        calculatedTotalTokens: evidence.componentEvidence.componentTotalTokens,
        reportedTotalTokens: evidence.componentEvidence.reportedTotalTokens
      }
    },
    quality: qualityFor(session.vital.sessionRef, qualityBySessionRef)
  };
}

function sessionMatchesCohort(
  experiment: TokenReductionExperimentV0,
  session: PlannerSession
): boolean {
  const cohort = experiment.cohort;
  return session.agent === cohort.agent &&
    session.provider === cohort.provider &&
    session.model === cohort.model &&
    session.projectRef === cohort.projectRef &&
    session.sessionType === cohort.sessionType &&
    session.workTypeRef === cohort.workTypeRef &&
    experiment.matchingPolicy.requireExactSourceVersion &&
    cohort.sourceVersionRef !== undefined &&
    session.sourceVersionRef === cohort.sourceVersionRef;
}

function qualityFor(
  sessionRef: string,
  qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>
): TokenExperimentSessionV0Input["quality"] {
  const status = qualityBySessionRef?.[sessionRef] ?? "missing";
  return status === "missing"
    ? { status: "missing", evidence: "missing" }
    : { status, evidence: "user_declared" };
}

function qualityEvidenceRank(
  evidence: TokenExperimentSessionV0Input["quality"]["evidence"]
): number {
  switch (evidence) {
    case "verified": return 3;
    case "observed": return 2;
    case "user_declared": return 1;
    case "missing": return 0;
  }
}

function experimentBody(
  experiment: TokenReductionExperimentV0
): TokenReductionExperimentV0DraftInput {
  const {
    id: _id,
    revisionId: _revisionId,
    lifecycle: _lifecycle,
    evaluation: _evaluation,
    ...body
  } = experiment;
  return body;
}

function findingOverlap(finding: WasteFindingV0, group: PlannerGroup): number {
  const evidence = new Set(finding.evidenceRefs);
  return group.sessions.filter((session) => evidence.has(session.vital.sessionRef)).length;
}

function boundedEvidenceRefs(sessionRefs: readonly string[], signalRef: string): string[] {
  const otherRefs = [...new Set(sessionRefs)]
    .filter((reference) => reference !== signalRef)
    .sort();
  return [
    ...otherRefs.slice(0, MAX_WASTE_FINDING_EVIDENCE_REFS_V0 - 1),
    signalRef
  ].sort();
}

function totalTokens(vital: SessionVitalV0): number | null {
  if (vital.tokenEvidence.status !== "observed") return null;
  if (vital.tokenEvidence.reportedTotalTokens !== undefined &&
      Number.isSafeInteger(vital.tokenEvidence.reportedTotalTokens)) {
    return vital.tokenEvidence.reportedTotalTokens;
  }
  return vital.tokenEvidence.componentEvidence.componentTotalTokens ===
      "calculated_complete" && Number.isSafeInteger(vital.tokenEvidence.componentTotalTokens)
    ? vital.tokenEvidence.componentTotalTokens
    : null;
}

function providerFor(agent: string): "anthropic" | "openai" | undefined {
  if (agent === "claude-code") return "anthropic";
  if (agent === "codex") return "openai";
  return undefined;
}

function parserFormatVersionRef(agent: "claude-code" | "codex"): string | undefined {
  const descriptor = localAgentFormatDescriptor(agent);
  if (!descriptor || descriptor.capabilities.actionPlanning !== true) return undefined;
  const semanticDigest = createHash("sha256")
    .update(canonicalDescriptorJson(descriptor))
    .digest("hex");
  return createActionVerificationReference(
    "parser-format-version",
    `${descriptor.id}:schema-${descriptor.schemaVersion}:semantics-${semanticDigest}`
  );
}

/**
 * Produce the opaque source-semantics identity used by every action cohort.
 * Exported so adapters and contract fixtures cannot reimplement a stale
 * descriptor fingerprint. The host version remains inside the hash.
 */
export function createActionPlanningSourceVersionReferenceV0(
  agent: "claude-code" | "codex",
  hostVersion: string | undefined
): string | undefined {
  // Parser semantics alone are not an observed host version. Without the
  // source-native host version there is no exact before/after cohort, so fail
  // closed instead of hashing an "unknown" sentinel into apparent evidence.
  if (!hostVersion) return undefined;
  const parserFormatRef = parserFormatVersionRef(agent);
  if (!parserFormatRef) return undefined;
  return createActionVerificationReference(
    "host-source-and-parser-version",
    `${agent}:${hostVersion}:${parserFormatRef}`
  );
}

function canonicalDescriptorJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Parser descriptor values must be finite.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalDescriptorJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDescriptorJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Parser descriptor contains an unsupported semantic value.");
}

function safeProject(value: string | undefined): value is string {
  return Boolean(value && value !== "(home)" && value.length <= 120 &&
    !/[\\/\u0000-\u001f\u007f]/.test(value));
}

function safeOutputIdentifier(namespace: string, value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
      !/^(?:sk-|sk_|gh[pousr]_|github_pat_|npm_|AIza|xox[baprs]-|glpat-|AKIA)/i.test(value)
    ? value
    : createActionVerificationReference(namespace, value);
}

function timestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid timestamp.`);
  return new Date(milliseconds).toISOString();
}

function normalizedTimestamp(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function comparePlannerSessions(left: PlannerSession, right: PlannerSession): number {
  return Date.parse(left.endedAt) - Date.parse(right.endedAt) ||
    left.vital.sessionRef.localeCompare(right.vital.sessionRef);
}

function compareGroups(left: PlannerGroup, right: PlannerGroup): number {
  const leftLatest = Date.parse(left.sessions.at(-1)!.endedAt);
  const rightLatest = Date.parse(right.sessions.at(-1)!.endedAt);
  return rightLatest - leftLatest || left.key.localeCompare(right.key);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
