import {
  buildActionVerificationProjectionV0,
  createActionVerificationReference,
  createProjectEconomicsPlannedActionRefV0,
  type ActionVerificationProjectionV0,
  type SessionVitalsV0,
  type TokenReductionExperimentV0,
  type UserDeclaredQualityV0,
  type WasteFindingV0
} from "@agent-finops/core";

/**
 * Public, one-command orchestration for the existing action-verification APIs.
 *
 * This module is intentionally pure. It does not read transcripts, prompt,
 * execute a change, or persist experiment state. The CLI entrypoint may carry
 * out the returned advanced operation only after the user made the explicit
 * interactive choice represented by `intent`.
 */
export type ImprovePhase =
  | "setup"
  | "start"
  | "awaiting_intervention"
  | "collecting"
  | "result"
  | "rollback"
  | "cancelled";

export type ImproveIntent =
  | { kind: "observe" }
  | {
      kind: "start";
      createdAt: string;
      /** A direct user assertion, never inferred from tests or agent output. */
      baselineQuality: "held";
    }
  | {
      kind: "apply";
      approvedAt: string;
      appliedAt: string;
      approved: true;
      /** Exact human/agent evidence strings. Only their opaque hashes leave this adapter. */
      approvalEvidence: string;
      changeEvidence: string;
      rollbackEvidence: string;
      canaryEvidence: string;
      canaryStatus: "passed" | "failed";
    }
  | {
      /** Record execution only after an earlier append-only approval exists. */
      kind: "record_preapproved_application";
      approvedAt: string;
      appliedAt: string;
      approvalRef: string;
      changeRef: string;
      rollbackRef: string;
      canaryRef: string;
      canaryStatus: "passed" | "failed";
    }
  | {
      kind: "refresh";
      observedAt: string;
      /** Missing quality stays missing; it is never treated as held. */
      quality: "held" | "failed" | "missing";
    }
  | {
      kind: "rollback";
      rolledBackAt: string;
      /** Must describe the same rollback artifact frozen at application. */
      rollbackEvidence: string;
    }
  | {
      kind: "cancel";
      cancelledAt: string;
      confirmed: true;
    };

export type ImproveExperienceInput = {
  finding?: WasteFindingV0 | null;
  preferredExperiment?: TokenReductionExperimentV0 | null;
  /** Read-only callers may carry only the canonical compact projection. */
  projection?: ActionVerificationProjectionV0 | null;
  sessionVitals?: SessionVitalsV0 | null;
  /** False for pipes, captured output, hooks, MCP reads, and statusline reads. */
  interactive: boolean;
  /** An additional caller-controlled safety latch, even when attached to a TTY. */
  readOnly?: boolean;
  intent?: ImproveIntent;
};

export type ImproveAdvancedOperation =
  | {
      kind: "freeze_baseline";
      finding: WasteFindingV0;
      sessionVitals: SessionVitalsV0;
      createdAt: string;
      qualityBySessionRef: Readonly<Record<string, UserDeclaredQualityV0>>;
    }
  | {
      kind: "mark_applied";
      experiment: TokenReductionExperimentV0;
      expectedRevisionId: string;
      /** Retained for the approval/audit adapter; V0 core approval is user-declared. */
      approvalRef: string;
      input: {
        approvedAt: string;
        appliedAt: string;
        changeRef: string;
        rollbackRef: string;
        canaryRef: string;
        canaryStatus: "passed" | "failed";
      };
    }
  | {
      kind: "refresh_experiment";
      experiment: TokenReductionExperimentV0;
      expectedRevisionId: string;
      input: {
        sessionVitals: SessionVitalsV0;
        observedAt: string;
        qualityBySessionRef?: Readonly<Record<string, UserDeclaredQualityV0>>;
      };
    }
  | {
      kind: "mark_rolled_back";
      experiment: TokenReductionExperimentV0;
      expectedRevisionId: string;
      input: { rolledBackAt: string; rollbackRef: string };
    }
  | {
      kind: "cancel_experiment";
      experiment: TokenReductionExperimentV0;
      expectedRevisionId: string;
      input: { invalidatedAt: string; reason: "manual" };
    };

export type ImproveExperienceModel = {
  schemaVersion: 0;
  phase: ImprovePhase;
  headline: string;
  detail: string;
  oneChange: {
    available: boolean;
    action: WasteFindingV0["candidateAction"]["kind"] | null;
    label: string;
  };
  progress: {
    baselineSessions: number;
    postChangeSessions: number;
    minimumSessions: number;
  } | null;
  result: {
    status: "reduced" | "unchanged" | "regressed" | "inconclusive";
    reductionPercent: number | null;
    headline: string;
    /** Exact canonical labels; the CLI must not detach a percentage from them. */
    metricEvidence: ActionVerificationProjectionV0["evidenceLabel"];
    qualityLabel: ActionVerificationProjectionV0["qualityLabel"];
    qualityEvidence: ActionVerificationProjectionV0["qualityEvidence"];
  } | null;
  interaction: {
    mode: "interactive" | "read_only";
    requestedIntent: ImproveIntent["kind"];
    blockedReason: string | null;
  };
  /** Null is a hard guarantee that the caller has nothing to persist. */
  advancedOperation: ImproveAdvancedOperation | null;
};

/** Build one deterministic public flow and, when authorized, one exact operation. */
export function buildImproveExperience(
  input: ImproveExperienceInput
): ImproveExperienceModel {
  const experiment = input.preferredExperiment ?? null;
  // A full canonical experiment always wins over a separately supplied view.
  const projection = experiment
    ? buildActionVerificationProjectionV0(experiment)
    : input.projection ?? null;
  const finding = input.finding ?? experiment?.finding ?? null;
  const phase = phaseFor(experiment, projection, finding);
  const intent = input.intent ?? { kind: "observe" };
  const writable = input.interactive && input.readOnly !== true;
  const attemptedMutation = intent.kind !== "observe";
  const operationResult = !attemptedMutation
    ? { operation: null, blockedReason: null }
    : !writable
      ? {
          operation: null,
          blockedReason: "Read-only or non-interactive output cannot change token-test state."
        }
      : operationFor({ input, experiment, finding, phase, intent });

  return {
    schemaVersion: 0,
    phase,
    ...phaseCopy(phase, projection),
    oneChange: {
      available: finding !== null,
      action: finding?.candidateAction.kind ?? null,
      label: finding ? actionLabel(finding.candidateAction.kind) : "No supported change yet"
    },
    progress: projection ? {
      baselineSessions: projection.baselineSessions,
      postChangeSessions: projection.postChangeSessions,
      minimumSessions: projection.minimumSessions
    } : null,
    result: resultFor(projection),
    interaction: {
      mode: writable ? "interactive" : "read_only",
      requestedIntent: intent.kind,
      blockedReason: operationResult.blockedReason
    },
    advancedOperation: operationResult.operation
  };
}

type OperationContext = {
  input: ImproveExperienceInput;
  experiment: TokenReductionExperimentV0 | null;
  finding: WasteFindingV0 | null;
  phase: ImprovePhase;
  intent: Exclude<ImproveIntent, { kind: "observe" }>;
};

type OperationResult = {
  operation: ImproveAdvancedOperation | null;
  blockedReason: string | null;
};

function operationFor(context: OperationContext): OperationResult {
  const { input, experiment, finding, phase, intent } = context;
  switch (intent.kind) {
    case "start": {
      if (phase !== "start" || experiment) {
        return blocked("A new baseline can start only when no active token test exists.");
      }
      if (!finding || !input.sessionVitals) {
        return blocked("A finding and completed-session evidence are required to start the test.");
      }
      if (!validTimestamp(intent.createdAt)) return blocked("The start time is invalid.");
      const qualityBySessionRef = qualityMap(input.sessionVitals, "passed");
      if (Object.keys(qualityBySessionRef).length === 0) {
        return blocked("No completed session is available for the user-declared quality baseline.");
      }
      return {
        blockedReason: null,
        operation: {
          kind: "freeze_baseline",
          finding,
          sessionVitals: input.sessionVitals,
          createdAt: normalizedTimestamp(intent.createdAt),
          qualityBySessionRef
        }
      };
    }
    case "apply": {
      if (phase !== "awaiting_intervention" || !experiment) {
        return blocked("One change can be recorded only after the comparable baseline is ready.");
      }
      if (!intent.approved || !validTimestamp(intent.approvedAt) ||
          !validTimestamp(intent.appliedAt)) {
        return blocked("Explicit approval and valid approval/application times are required.");
      }
      if (Date.parse(intent.appliedAt) <= Date.parse(intent.approvedAt)) {
        return blocked("The application time must be after its pre-change approval time.");
      }
      const refs = interventionReferences(intent);
      if (!refs) {
        return blocked("Approval, change, rollback, and canary evidence must all be supplied.");
      }
      return {
        blockedReason: null,
        operation: {
          kind: "mark_applied",
          experiment,
          expectedRevisionId: experiment.revisionId,
          approvalRef: refs.approvalRef,
          input: {
            approvedAt: normalizedTimestamp(intent.approvedAt),
            appliedAt: normalizedTimestamp(intent.appliedAt),
            changeRef: refs.changeRef,
            rollbackRef: refs.rollbackRef,
            canaryRef: refs.canaryRef,
            canaryStatus: intent.canaryStatus
          }
        }
      };
    }
    case "record_preapproved_application": {
      if (phase !== "awaiting_intervention" || !experiment) {
        return blocked("A pre-approved change can be recorded only after the comparable baseline is ready.");
      }
      if (!validTimestamp(intent.approvedAt) || !validTimestamp(intent.appliedAt) ||
          Date.parse(intent.appliedAt) <= Date.parse(intent.approvedAt)) {
        return blocked("The recorded application must follow its valid pre-change approval time.");
      }
      if (![intent.approvalRef, intent.changeRef, intent.rollbackRef, intent.canaryRef]
        .every((reference) => /^avref_[a-f0-9]{64}$/.test(reference))) {
        return blocked("The pre-approved action and its change, rollback, and canary references must be exact.");
      }
      if (intent.approvalRef !== createProjectEconomicsPlannedActionRefV0(
        experiment,
        {
          changeRef: intent.changeRef,
          rollbackRef: intent.rollbackRef,
          canaryRef: intent.canaryRef
        }
      )) {
        return blocked(
          "The application references do not match the exact pre-change approved plan."
        );
      }
      return {
        blockedReason: null,
        operation: {
          kind: "mark_applied",
          experiment,
          expectedRevisionId: experiment.revisionId,
          approvalRef: intent.approvalRef,
          input: {
            approvedAt: normalizedTimestamp(intent.approvedAt),
            appliedAt: normalizedTimestamp(intent.appliedAt),
            changeRef: intent.changeRef,
            rollbackRef: intent.rollbackRef,
            canaryRef: intent.canaryRef,
            canaryStatus: intent.canaryStatus
          }
        }
      };
    }
    case "refresh": {
      if (phase !== "collecting" || !experiment || !input.sessionVitals) {
        return blocked("Matched evidence can be collected only for an applied token test.");
      }
      if (!validTimestamp(intent.observedAt)) return blocked("The observation time is invalid.");
      const qualityBySessionRef = intent.quality === "missing"
        ? undefined
        : qualityMap(input.sessionVitals, intent.quality === "held" ? "passed" : "failed");
      return {
        blockedReason: null,
        operation: {
          kind: "refresh_experiment",
          experiment,
          expectedRevisionId: experiment.revisionId,
          input: {
            sessionVitals: input.sessionVitals,
            observedAt: normalizedTimestamp(intent.observedAt),
            ...(qualityBySessionRef && Object.keys(qualityBySessionRef).length > 0
              ? { qualityBySessionRef }
              : {})
          }
        }
      };
    }
    case "rollback": {
      if (!experiment?.intervention.appliedAt ||
          experiment.lifecycle === "rolled_back" || experiment.lifecycle === "invalidated") {
        return blocked("Only a currently applied change can be rolled back.");
      }
      if (!validTimestamp(intent.rolledBackAt)) return blocked("The rollback time is invalid.");
      const rollbackRef = evidenceReference("rollback-artifact", intent.rollbackEvidence);
      if (!rollbackRef) return blocked("The exact rollback evidence must be supplied.");
      return {
        blockedReason: null,
        operation: {
          kind: "mark_rolled_back",
          experiment,
          expectedRevisionId: experiment.revisionId,
          input: {
            rolledBackAt: normalizedTimestamp(intent.rolledBackAt),
            rollbackRef
          }
        }
      };
    }
    case "cancel": {
      if (!experiment || experiment.intervention.appliedAt ||
          (experiment.lifecycle !== "draft" && experiment.lifecycle !== "baseline_ready")) {
        return blocked("Only an un-applied token test can be cancelled.");
      }
      if (!intent.confirmed || !validTimestamp(intent.cancelledAt)) {
        return blocked("Explicit cancellation and a valid time are required.");
      }
      return {
        blockedReason: null,
        operation: {
          kind: "cancel_experiment",
          experiment,
          expectedRevisionId: experiment.revisionId,
          input: {
            invalidatedAt: normalizedTimestamp(intent.cancelledAt),
            reason: "manual"
          }
        }
      };
    }
  }
}

function phaseFor(
  experiment: TokenReductionExperimentV0 | null,
  projection: ActionVerificationProjectionV0 | null,
  finding: WasteFindingV0 | null
): ImprovePhase {
  if (!experiment && !projection) return finding ? "start" : "setup";
  const state = projection?.state;
  switch (state) {
    case "collect_baseline": return "start";
    case "approve_one_change": return "awaiting_intervention";
    case "collect_post_change": return "collecting";
    case "review_measured_result":
    case "resolve_evidence": return "result";
    case "rollback":
    case "rolled_back": return "rollback";
    case "cancelled": return "cancelled";
    default:
      return finding ? "start" : "setup";
  }
}

function phaseCopy(
  phase: ImprovePhase,
  projection: ActionVerificationProjectionV0 | null
): Pick<ImproveExperienceModel, "headline" | "detail"> {
  if (projection) return { headline: projection.headline, detail: projection.detail };
  switch (phase) {
    case "setup": return {
      headline: "Use aibill normally to build a comparable baseline",
      detail: "No supported waste signal is ready, so aibill will not invent a change."
    };
    case "start": return {
      headline: "One reversible token test is ready to set up",
      detail: "Freeze the observed baseline first; no agent configuration changes yet."
    };
    default: return {
      headline: "Token test status is available",
      detail: "Review the recorded evidence before taking the next action."
    };
  }
}

function resultFor(
  projection: ActionVerificationProjectionV0 | null
): ImproveExperienceModel["result"] {
  if (!projection || (projection.state !== "review_measured_result" &&
      projection.state !== "resolve_evidence" && projection.state !== "rollback" &&
      projection.state !== "rolled_back")) return null;
  const reduction = projection.reductionPercent;
  if (projection.state === "review_measured_result" &&
      projection.evidenceLabel === "calculated" &&
      projection.qualityLabel === "held" && reduction !== null) {
    if (reduction > 0) return {
      status: "reduced",
      reductionPercent: reduction,
      headline: `${formatPercent(reduction)} fewer tokens per comparable completed session`,
      metricEvidence: projection.evidenceLabel,
      qualityLabel: projection.qualityLabel,
      qualityEvidence: projection.qualityEvidence
    };
    if (reduction === 0) return {
      status: "unchanged",
      reductionPercent: 0,
      headline: "No measured token change in comparable completed sessions",
      metricEvidence: projection.evidenceLabel,
      qualityLabel: projection.qualityLabel,
      qualityEvidence: projection.qualityEvidence
    };
    return {
      status: "regressed",
      reductionPercent: reduction,
      headline: `${formatPercent(Math.abs(reduction))} more tokens per comparable completed session`,
      metricEvidence: projection.evidenceLabel,
      qualityLabel: projection.qualityLabel,
      qualityEvidence: projection.qualityEvidence
    };
  }
  if (projection.state === "rollback" && projection.evidenceLabel === "calculated" &&
      reduction !== null && reduction < 0) return {
    status: "regressed",
    reductionPercent: reduction,
    headline: `${formatPercent(Math.abs(reduction))} more tokens; undo the approved change`,
    metricEvidence: projection.evidenceLabel,
    qualityLabel: projection.qualityLabel,
    qualityEvidence: projection.qualityEvidence
  };
  return {
    status: "inconclusive",
    reductionPercent: null,
    headline: "No defensible token-reduction result yet",
    metricEvidence: projection.evidenceLabel,
    qualityLabel: projection.qualityLabel,
    qualityEvidence: projection.qualityEvidence
  };
}

function qualityMap(
  vitals: SessionVitalsV0,
  quality: UserDeclaredQualityV0
): Readonly<Record<string, UserDeclaredQualityV0>> {
  return Object.fromEntries(vitals.sessions
    .filter((session) => session.completion.status === "completed")
    .map((session) => [session.sessionRef, quality]));
}

function interventionReferences(
  intent: Extract<ImproveIntent, { kind: "apply" }>
): {
  approvalRef: string;
  changeRef: string;
  rollbackRef: string;
  canaryRef: string;
} | null {
  const approvalRef = evidenceReference("approval-evidence", intent.approvalEvidence);
  const changeRef = evidenceReference("approved-change", intent.changeEvidence);
  const rollbackRef = evidenceReference("rollback-artifact", intent.rollbackEvidence);
  const canaryRef = evidenceReference("canary-result", intent.canaryEvidence);
  return approvalRef && changeRef && rollbackRef && canaryRef
    ? { approvalRef, changeRef, rollbackRef, canaryRef }
    : null;
}

function evidenceReference(namespace: string, evidence: string): string | null {
  if (evidence.trim().length === 0) return null;
  try {
    return createActionVerificationReference(namespace, evidence);
  } catch {
    return null;
  }
}

function blocked(blockedReason: string): OperationResult {
  return { operation: null, blockedReason };
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizedTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "")}%`;
}

function actionLabel(action: WasteFindingV0["candidateAction"]["kind"]): string {
  switch (action) {
    case "inspect_scope": return "Review one always-loaded item before changing it";
    case "lazy_load": return "Load the item only when the task needs it";
    case "disable": return "Disable one unused item for a canary task";
    case "remove": return "Remove one unused item with a rollback preserved";
    case "start_fresh": return "Start one comparable task in a fresh session";
    case "reduce_repeated_reads": return "Reuse one already-read context result";
    case "trim_context": return "Start with only the files and instructions this task needs";
  }
}
