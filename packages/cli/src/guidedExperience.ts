import {
  buildActionVerificationProjectionV0,
  type ActionVerificationProjectionV0,
  type AgentEconomicsReceiptV0,
  type ContextHealthResult,
  type SessionVitalsV0,
  type SpendSummary,
  type TokenReductionExperimentV0,
  type WasteFindingV0
} from "@agent-finops/core";

/**
 * One compact first-run experience assembled from existing canonical facts.
 *
 * This adapter never scans transcripts, evaluates an experiment, or changes
 * state. The CLI entrypoint owns those operations. Keeping this file pure
 * makes the same words deterministic in interactive and captured output.
 */
export type GuidedExperienceInput = {
  receipt?: Pick<AgentEconomicsReceiptV0, "demoOnly" | "window" | "lines"> | null;
  sessionVitals?: SessionVitalsV0 | null;
  summary?: Pick<SpendSummary, "totalUsd" | "byProject"> | null;
  contextHealth?: ContextHealthResult | null;
  wasteFinding?: WasteFindingV0 | null;
  /** The preferred locally persisted experiment, when the caller has it. */
  preferredExperiment?: TokenReductionExperimentV0 | null;
  /** A canonical read projection for callers that intentionally do not load the full experiment. */
  projection?: ActionVerificationProjectionV0 | null;
  /** Coverage of the qualitative/session reader that produced drivers and findings. */
  qualitativeCoverage: "complete" | "partial" | "unknown";
  /** Financial project aggregation may be complete even when qualitative indexing is partial. */
  financialDriverComplete?: boolean;
  /** True only when both the input and output streams are suitable for a prompt. */
  interactive: boolean;
};

export type GuidedExperienceModel = {
  schemaVersion: 0;
  usage: {
    headline: string;
    detail: string;
    source: "completed_sessions" | "receipt" | "latest_turn" | "not_available";
  };
  mainDriver: {
    heading: "MAIN DRIVER" | "TOP OBSERVED PROJECT";
    headline: string;
    detail: string;
    source: "completed_session_tokens" | "tracked_cost_value" | "not_available";
  };
  insight: {
    heading:
      | "WHY IS IT HIGH?"
      | "WHAT STANDS OUT"
      | "WHAT STANDS OUT IN INDEXED EVIDENCE";
    headline: string;
    detail: string;
  };
  safeTest: {
    available: boolean;
    headline: string;
    detail: string;
  };
  progress: {
    headline: string;
    detail: string;
  } | null;
  result: {
    headline: string;
    detail: string;
    direction: "fewer" | "more" | "unchanged";
  } | null;
  interaction: {
    mode: "interactive" | "read_only";
    startPrompt: {
      key: "enter";
      label: string;
      intent: "set_up_test" | "start_test";
    } | null;
  };
};

type CanonicalProjection = {
  projection: ActionVerificationProjectionV0;
  experiment?: TokenReductionExperimentV0;
};

type CompletedSession = SessionVitalsV0["sessions"][number] & {
  completion: Extract<SessionVitalsV0["sessions"][number]["completion"], {
    status: "completed";
  }>;
  tokenEvidence: Extract<SessionVitalsV0["sessions"][number]["tokenEvidence"], {
    status: "observed";
  }>;
};

type ExactCompletedSession = CompletedSession & {
  tokenEvidence: CompletedSession["tokenEvidence"] & ({
    reportedTotalTokens: number;
    componentEvidence: CompletedSession["tokenEvidence"]["componentEvidence"] & {
      reportedTotalTokens: "provider_reported";
    };
  } | {
    componentTotalTokens: number;
    componentEvidence: CompletedSession["tokenEvidence"]["componentEvidence"] & {
      componentTotalTokens: "calculated_complete";
    };
  });
};

/** Build one launch card without performing I/O or mutating local state. */
export function buildGuidedExperience(
  input: GuidedExperienceInput
): GuidedExperienceModel {
  const sessions = completedSessions(input.sessionVitals);
  const canonical = canonicalProjection(input);
  const finding = input.qualitativeCoverage === "complete"
    ? input.wasteFinding ?? canonical?.experiment?.finding ?? null
    : null;
  const result = canonical ? resultFor(canonical) : null;

  return {
    schemaVersion: 0,
    usage: usageFor(input, sessions),
    mainDriver: mainDriverFor(input, sessions),
    insight: insightFor(finding, input.contextHealth, input.qualitativeCoverage),
    safeTest: safeTestFor(finding, input.contextHealth, input.qualitativeCoverage),
    progress: canonical ? progressFor(canonical.projection) : null,
    result,
    interaction: interactionFor(input.interactive, finding, canonical?.projection)
  };
}

/** Render the model with stable headings and no terminal-control sequences. */
export function renderGuidedExperience(model: GuidedExperienceModel): string {
  const lines = [
    "USAGE",
    model.usage.headline,
    model.usage.detail,
    "",
    model.mainDriver.heading,
    model.mainDriver.headline,
    model.mainDriver.detail,
    "",
    model.insight.heading,
    model.insight.headline,
    model.insight.detail,
    "",
    "HOW DO I REDUCE IT?",
    model.safeTest.headline,
    model.safeTest.detail
  ];

  if (model.progress) {
    lines.push("", "PROGRESS", model.progress.headline, model.progress.detail);
  }
  if (model.result) {
    lines.push("", "RESULT", model.result.headline, model.result.detail);
  }
  if (model.interaction.startPrompt) {
    lines.push("", `[Enter] ${model.interaction.startPrompt.label}   [d] Details   [q] Not now`);
  } else if (model.interaction.mode === "read_only") {
    lines.push(
      "",
      "No experiment, approval, or project state changed. The private local evidence cache may refresh."
    );
  }
  return lines.join("\n");
}

function completedSessions(vitals?: SessionVitalsV0 | null): ExactCompletedSession[] {
  if (!vitals) return [];
  return vitals.sessions.flatMap((session): ExactCompletedSession[] => {
    if (session.completion.status !== "completed" ||
        session.tokenEvidence.status !== "observed") return [];
    const completed = session as CompletedSession;
    const total = exactSessionTokenTotal(completed);
    return Number.isSafeInteger(total) && total! >= 0
      ? [completed as ExactCompletedSession]
      : [];
  });
}

function exactSessionTokenTotal(session: CompletedSession): number | undefined {
  if (session.tokenEvidence.componentEvidence.reportedTotalTokens === "provider_reported" &&
      Number.isSafeInteger(session.tokenEvidence.reportedTotalTokens)) {
    return session.tokenEvidence.reportedTotalTokens;
  }
  return session.tokenEvidence.componentEvidence.componentTotalTokens === "calculated_complete" &&
    Number.isSafeInteger(session.tokenEvidence.componentTotalTokens)
    ? session.tokenEvidence.componentTotalTokens
    : undefined;
}

function sessionTokenTotal(session: ExactCompletedSession): number {
  return exactSessionTokenTotal(session)!;
}

function usageFor(
  input: GuidedExperienceInput,
  sessions: ExactCompletedSession[]
): GuidedExperienceModel["usage"] {
  if (sessions.length > 0) {
    const total = sessions.reduce((sum, session) => sum + sessionTokenTotal(session), 0);
    if (Number.isSafeInteger(total)) {
      return {
        headline: `${formatCount(total)} tokens · ${plural(sessions.length, "completed session")}`,
        detail: input.qualitativeCoverage === "complete"
          ? "Completed local Claude Code and Codex sessions with complete token totals."
          : "Indexed completed sessions with complete token totals; some local evidence may be missing.",
        source: "completed_sessions"
      };
    }
  }

  const receipt = input.receipt;
  if (receipt && !receipt.demoOnly) {
    const tokenLines = receipt.lines.filter((line) => line.kind === "token_usage");
    const total = tokenLines.reduce(
      (sum, line) => sum + line.inputTokens + line.outputTokens,
      0
    );
    if (tokenLines.length > 0 && Number.isSafeInteger(total)) {
      return {
        headline: `${formatCount(total)} input + output tokens`,
        detail: `${plural(tokenLines.length, "receipt record")} in this window.`,
        source: "receipt"
      };
    }
  }

  const current = input.contextHealth?.currentSession;
  if (current && current.usageSource !== "not_available") {
    return {
      headline: `${formatCount(current.contextTokens)} tokens in the latest turn's context`,
      detail: `${agentName(current.agent)}${current.project ? ` · ${safeLabel(current.project)}` : ""}`,
      source: "latest_turn"
    };
  }

  return {
    headline: "No supported token usage yet",
    detail: "Complete a Claude Code or Codex task to create a usable baseline.",
    source: "not_available"
  };
}

function mainDriverFor(
  input: GuidedExperienceInput,
  sessions: ExactCompletedSession[]
): GuidedExperienceModel["mainDriver"] {
  if (sessions.length > 0) {
    const total = sessions.reduce((sum, session) => sum + sessionTokenTotal(session), 0);
    const byProject = new Map<string, number>();
    for (const session of sessions) {
      const project = driverProjectName(session.project);
      byProject.set(project, (byProject.get(project) ?? 0) + sessionTokenTotal(session));
    }
    const top = [...byProject.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0])
    )[0];
    if (top && total > 0) {
      return {
        heading: input.qualitativeCoverage === "complete" ? "MAIN DRIVER" : "TOP OBSERVED PROJECT",
        headline: safeLabel(top[0]),
        detail: `${Math.round(100 * top[1] / total)}% of ${input.qualitativeCoverage === "complete" ? "completed-session" : "indexed completed-session"} tokens with complete totals`,
        source: "completed_session_tokens"
      };
    }
  }

  const topProject = input.summary?.byProject
    .filter((entry) => entry.confidence !== "missing" && entry.amountUsd > 0)
    .sort((left, right) => right.amountUsd - left.amountUsd || left.key.localeCompare(right.key))[0];
  if (topProject && input.summary && input.summary.totalUsd > 0) {
    // Qualitative indexing can explain behavior, but it cannot repair missing
    // prices or incomplete provider/local financial rows. A global financial
    // driver is allowed only when the financial evidence itself is complete.
    const completeDriver = input.financialDriverComplete === true;
    return {
      heading: completeDriver ? "MAIN DRIVER" : "TOP OBSERVED PROJECT",
      headline: driverProjectName(topProject.key),
      detail: `${Math.round(100 * topProject.amountUsd / input.summary.totalUsd)}% of ${completeDriver ? "tracked" : "indexed tracked"} cost/value`,
      source: "tracked_cost_value"
    };
  }

  return {
    heading: input.qualitativeCoverage === "complete" ? "MAIN DRIVER" : "TOP OBSERVED PROJECT",
    headline: "Not enough project evidence",
    detail: "Run tasks from a project folder to make the main driver clear.",
    source: "not_available"
  };
}

function insightFor(
  finding?: WasteFindingV0 | null,
  context?: ContextHealthResult | null,
  coverage: GuidedExperienceInput["qualitativeCoverage"] = "unknown"
): GuidedExperienceModel["insight"] {
  const limited = coverage !== "complete";
  if (!finding) {
    const ratio = context?.currentSession?.ratioToMedian;
    if (ratio !== null && ratio !== undefined && ratio >= 1.5) {
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHY IS IT HIGH?",
        headline: `The latest indexed turn carried ${formatRatio(ratio)}× the usual context.`,
        detail: limited
          ? "This describes the evidence indexed so far, not all local activity."
          : "That is the strongest local signal; it does not prove a universal cause."
      };
    }
    return {
      heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHAT STANDS OUT",
      headline: "No supported waste signal yet.",
      detail: limited
        ? "Some local evidence was not indexed; aibill will not generalize from this view."
        : "aibill needs comparable completed sessions before it recommends a change."
    };
  }

  const count = finding.metric.value;
  switch (finding.findingType) {
    case "compaction_pressure":
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHY IS IT HIGH?",
        headline: `${formatMetric(count, "compaction")} in ${limited ? "the indexed work" : "the current work"}.`,
        detail: limited
          ? "Rebuilding context is the strongest signal in the evidence indexed so far."
          : "Rebuilding context is the strongest observed signal, not a proven universal cause."
      };
    case "repeated_context_read":
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHY IS IT HIGH?",
        headline: `${formatMetric(count, "repeated read")} of context already seen${limited ? " in indexed work" : ""}.`,
        detail: limited
          ? "Repeated reads are the strongest signal in the evidence indexed so far."
          : "Repeated reads are the strongest observed signal, not a proven universal cause."
      };
    case "high_context_relative_to_baseline":
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHY IS IT HIGH?",
        headline: `${limited ? "One indexed session" : "This work"} used ${formatRatio(count)}× the comparable-session baseline.`,
        detail: `Compared with ${plural(finding.metric.sampleCount, "prior completed session")}${limited ? " in indexed evidence" : ""}.`
      };
    case "cumulative_context_exposure":
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHY IS IT HIGH?",
        headline: `Context kept accumulating across ${limited ? "the indexed work" : "the work"}.`,
        detail: limited
          ? "That is the strongest signal in the evidence indexed so far."
          : "That is the strongest supported signal; the exact cause still needs the test."
      };
    case "configured_not_observed":
      return {
        heading: limited ? "WHAT STANDS OUT IN INDEXED EVIDENCE" : "WHAT STANDS OUT",
        headline: `${formatMetric(count, "always-loaded item")} had no matching use.`,
        detail: limited
          ? "No matching use appeared in indexed evidence; review it before changing configuration."
          : "Review the suggested item before changing any configuration."
      };
  }
}

function safeTestFor(
  finding?: WasteFindingV0 | null,
  context?: ContextHealthResult | null,
  qualitativeCoverage: GuidedExperienceInput["qualitativeCoverage"] = "unknown"
): GuidedExperienceModel["safeTest"] {
  const action = finding?.candidateAction.kind;
  const agent = agentName(finding?.scope.agent ?? context?.currentSession?.agent);
  let headline: string | null = null;

  switch (action) {
    case "start_fresh":
      headline = `Start the next independent task in a fresh ${agent} session.`;
      break;
    case "reduce_repeated_reads":
      headline = "Use one short working note instead of rereading the same context.";
      break;
    case "trim_context":
      headline = "Start the next comparable task with only the files and instructions it needs.";
      break;
    case "lazy_load":
      headline = "Load the suggested context only when one comparable task needs it.";
      break;
    case "inspect_scope":
      headline = "Review one unused always-loaded item, then test one task without it.";
      break;
    case "disable":
    case "remove":
      headline = "Disable the suggested unused item for one comparable task.";
      break;
  }

  if (!headline && qualitativeCoverage === "complete" &&
      context?.recommendation === "start_fresh") {
    headline = `Start the next independent task in a fresh ${agent} session.`;
  }
  if (!headline) {
    return {
      available: false,
      headline: "No safe test is ready yet.",
      detail: "Finish enough comparable sessions for aibill to choose one supported change."
    };
  }
  return {
    available: true,
    headline,
    detail: "Try it once, check quality, and undo it if the work gets worse."
  };
}

function canonicalProjection(input: GuidedExperienceInput): CanonicalProjection | null {
  if (input.preferredExperiment) {
    return {
      experiment: input.preferredExperiment,
      projection: buildActionVerificationProjectionV0(input.preferredExperiment)
    };
  }
  return input.projection && safeProjection(input.projection)
    ? { projection: input.projection }
    : null;
}

function safeProjection(projection: ActionVerificationProjectionV0): boolean {
  return projection.schemaVersion === 0 &&
    /^tre_v0_[a-f0-9]{64}$/u.test(projection.experimentId) &&
    /^wf_v0_[a-f0-9]{64}$/u.test(projection.findingId) &&
    /^wfc_v0_[a-f0-9]{64}$/u.test(projection.candidateKey) &&
    Number.isSafeInteger(projection.baselineSessions) && projection.baselineSessions >= 0 &&
    Number.isSafeInteger(projection.postChangeSessions) && projection.postChangeSessions >= 0 &&
    Number.isSafeInteger(projection.minimumSessions) && projection.minimumSessions >= 1 &&
    (projection.reductionPercent === null || (
      Number.isFinite(projection.reductionPercent) && projection.reductionPercent <= 100
    ));
}

function progressFor(
  projection: ActionVerificationProjectionV0
): NonNullable<GuidedExperienceModel["progress"]> {
  switch (projection.state) {
    case "collect_baseline":
      return {
        headline: `${Math.min(projection.baselineSessions, projection.minimumSessions)}/${projection.minimumSessions} baseline sessions ready`,
        detail: "Only comparable completed sessions count."
      };
    case "approve_one_change":
      return {
        headline: "Baseline ready",
        detail: `${projection.baselineSessions} comparable completed sessions are saved.`
      };
    case "collect_post_change":
      return {
        headline: `${Math.min(projection.postChangeSessions, projection.minimumSessions)}/${projection.minimumSessions} test sessions complete`,
        detail: "Keep the task, model, and project comparable."
      };
    case "review_measured_result":
      return { headline: "Test complete", detail: "The matched result is ready below." };
    case "rollback":
      return { headline: "Test complete", detail: "Undo the change and keep the result." };
    case "resolve_evidence":
      return {
        headline: "Result paused",
        detail: "The quality check or session comparison is incomplete."
      };
    case "rolled_back":
      return { headline: "Change undone", detail: "This test cannot support a reduction claim." };
    case "cancelled":
      return { headline: "Test cancelled", detail: "Start a new test from fresh evidence." };
  }
}

function resultFor(canonical: CanonicalProjection): GuidedExperienceModel["result"] {
  const projection = canonical.projection;
  const percent = projection.reductionPercent;
  if (percent === null || !Number.isFinite(percent) ||
      projection.evidenceLabel !== "calculated" ||
      projection.qualityLabel !== "held") return null;

  const supportsReduction = projection.state === "review_measured_result" && percent >= 0;
  const supportsRegression = projection.state === "rollback" && percent < 0;
  if (!supportsReduction && !supportsRegression) return null;

  const medians = canonical.experiment?.evaluation;
  const medianDetail = medians?.baseline.medianTotalTokens !== null &&
      medians?.baseline.medianTotalTokens !== undefined &&
      medians.postChange.medianTotalTokens !== null
    ? `${formatCount(medians.baseline.medianTotalTokens)} → ${formatCount(medians.postChange.medianTotalTokens)} median tokens. `
    : "";
  const quality = qualityWords(projection.qualityEvidence);

  if (percent > 0) {
    return {
      headline: `${formatPercent(percent)}% fewer tokens per comparable completed session`,
      detail: `${medianDetail}${quality}`,
      direction: "fewer"
    };
  }
  if (percent < 0) {
    return {
      headline: `${formatPercent(Math.abs(percent))}% more tokens per comparable completed session`,
      detail: `${medianDetail}${quality} Undo the change.`,
      direction: "more"
    };
  }
  return {
    headline: "No measured token change per comparable completed session",
    detail: `${medianDetail}${quality}`,
    direction: "unchanged"
  };
}

function interactionFor(
  interactive: boolean,
  finding?: WasteFindingV0 | null,
  projection?: ActionVerificationProjectionV0
): GuidedExperienceModel["interaction"] {
  if (!interactive) return { mode: "read_only", startPrompt: null };
  if (finding && projection?.state === "approve_one_change") {
    return {
      mode: "interactive",
      startPrompt: { key: "enter", label: "Start this test", intent: "start_test" }
    };
  }
  if (!projection && finding) {
    return {
      mode: "interactive",
      startPrompt: { key: "enter", label: "Set up this test", intent: "set_up_test" }
    };
  }
  return { mode: "interactive", startPrompt: null };
}

function qualityWords(evidence: ActionVerificationProjectionV0["qualityEvidence"]): string {
  switch (evidence) {
    case "verified": return "The quality check passed.";
    case "observed": return "Quality held in the recorded check.";
    case "user_declared": return "Quality held, confirmed by you.";
    case "missing": return "";
  }
}

function driverProjectName(project?: string): string {
  const normalized = safeLabel(project ?? "").toLowerCase();
  if (!normalized || normalized === "unmapped" || normalized === "unattributed") {
    return "Unattributed sessions";
  }
  if (normalized === "(home)" || normalized === "home") {
    return "Sessions started outside a project folder";
  }
  return safeLabel(project!);
}

function agentName(agent?: string): string {
  if (agent === "claude-code") return "Claude Code";
  if (agent === "codex") return "Codex";
  return agent ? safeLabel(agent) : "coding-agent";
}

function formatMetric(value: number | null, singular: string): string {
  if (value === null || !Number.isFinite(value)) return `A ${singular} signal`;
  return plural(Math.round(value), singular);
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "an unknown amount";
  return formatPercent(value);
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000)}B`;
  if (absolute >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (absolute >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function plural(count: number, singular: string): string {
  return `${count.toLocaleString("en-US")} ${singular}${count === 1 ? "" : "s"}`;
}

function safeLabel(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 96) || "Unattributed sessions";
}
