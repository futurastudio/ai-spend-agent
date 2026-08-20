/**
 * Guided sittings for `aibill improve` and `aibill identify`.
 *
 * Each sitting renders QUESTION screens through the guidedPrompt engine and
 * returns a semantic result; the caller owns persistence and composes the
 * clean-exit frame. Nothing in this module writes project or provider state.
 *
 * Design: P0B_FLOW_DESIGN.md §3a/§3c (state machine, drafts, exit contract).
 */

import {
  askGuidedQuestion,
  renderGuidedHeader,
  renderGuidedQuestion,
  renderNextCommand,
  guidedFooter,
  type AskOutcome,
  type ClassifyContext,
  type GuidedFieldKind,
  type GuidedPromptSource,
  type NextCommandBlock
} from "./guidedPrompt.js";

export type FlowIo = {
  source: GuidedPromptSource;
  /** Mid-flow screens only; clean-exit frames are RETURNED, never written. */
  write: (text: string) => void;
  nowMs?: () => number;
  /** Non-TTY circuit breaker forwarded to every question. */
  maxIdenticalRejections?: number;
};

export type SittingHeader = {
  commandTitle: string;
  experimentLabel: string;
  sitting: string;
  demo?: boolean;
};

export const planSittingHint =
  "Stuck? back returns one step · cancel stops safely · nothing is recorded until the APPROVE step.";
export const recordSittingHint =
  "Stuck? back returns one step · cancel stops safely · nothing is recorded until both answers are in.";
export const shortSittingHint =
  "Stuck? cancel stops safely and you can rerun this command later.";

/* ------------------------------------------------------------------ */
/* Exit frame                                                          */
/* ------------------------------------------------------------------ */

export function renderCleanExit(options: {
  lines: string[];
  next: NextCommandBlock;
  extraBlocks?: string[];
}): string {
  return [
    ...options.lines,
    "",
    ...(options.extraBlocks ?? []).flatMap((block) => [block, ""]),
    renderNextCommand(options.next),
    "",
    guidedFooter
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Question helper                                                     */
/* ------------------------------------------------------------------ */

type AskSpec = {
  kind: GuidedFieldKind;
  step: number;
  totalSteps: number;
  question: string;
  guidance?: string;
  wordsNotCommands?: boolean;
  example?: string;
  navigationHint?: string;
  context?: ClassifyContext;
  sittingHint: string;
  /** Prefill: empty input keeps this value (revisits of answered steps). */
  emptyKeepsValue?: string;
  /** "Current answer" for revisits, "Suggested" for machine drafts. */
  emptyKeepsLabel?: string;
  /**
   * Navigation default: Enter answers this token. ONLY for questions that
   * mint no user-declared evidence (start/resume/identity-confirm) — the
   * testimony answers (baseline quality, canary, quality, APPROVE) must
   * always be typed deliberately.
   */
  enterDefault?: string;
};

async function ask(io: FlowIo, header: SittingHeader, spec: AskSpec): Promise<AskOutcome> {
  const render = () => {
    const parts = [
      renderGuidedHeader({
        commandTitle: header.commandTitle,
        experimentLabel: header.experimentLabel,
        sitting: header.sitting,
        step: spec.step,
        totalSteps: spec.totalSteps,
        ...(header.demo ? { demo: true } : {})
      }),
      ""
    ];
    if (spec.emptyKeepsValue !== undefined && spec.enterDefault === undefined) {
      const label = spec.emptyKeepsLabel ?? "Current answer";
      parts.push(`${label}: "${spec.emptyKeepsValue}"`);
      // Any label other than a revisit of the user's own answer is a
      // machine suggestion — "Suggested" (aibill's) or "Drafted with your
      // agent" (B1: the label is computed per field from real provenance,
      // never sitting-wide, so it can never sit over the wrong author).
      parts.push(label === "Current answer"
        ? "Press Enter to keep it, or type a replacement."
        : "Press Enter to accept it, or type your own.");
      parts.push("");
    }
    parts.push(renderGuidedQuestion({
      step: spec.step,
      totalSteps: spec.totalSteps,
      question: spec.question,
      ...(spec.guidance !== undefined ? { guidance: spec.guidance } : {}),
      ...(spec.wordsNotCommands ? { wordsNotCommands: true } : {}),
      ...(spec.example !== undefined ? { example: spec.example } : {}),
      ...(spec.navigationHint !== undefined ? { navigationHint: spec.navigationHint } : {})
    }));
    return parts.join("\n");
  };
  return askGuidedQuestion({
    kind: spec.kind,
    render,
    ...(spec.context !== undefined ? { context: spec.context } : {}),
    sittingHint: spec.sittingHint,
    // Reprompt frames restate the experiment/DEMO tag so every screen a
    // user sees carries its context, not only full question screens.
    frameTag: `${header.experimentLabel}${header.demo ? " · DEMO" : ""}`,
    write: io.write,
    source: io.source,
    ...(io.maxIdenticalRejections !== undefined
      ? { maxIdenticalRejections: io.maxIdenticalRejections }
      : {}),
    ...(io.nowMs !== undefined ? { nowMs: io.nowMs } : {}),
    ...(spec.enterDefault !== undefined
      ? { emptyKeepsValue: spec.enterDefault }
      : spec.emptyKeepsValue !== undefined
        ? { emptyKeepsValue: spec.emptyKeepsValue }
        : {})
  });
}

/* ------------------------------------------------------------------ */
/* START sitting                                                       */
/* ------------------------------------------------------------------ */

export type StartResult =
  | { action: "declined" }
  | { action: "cancelled" }
  | { action: "qualityNotAccepted" }
  | { action: "start" };

export async function runStartSitting(
  io: FlowIo,
  options: {
    header: Omit<SittingHeader, "sitting">;
    findingLabel: string;
    evidenceLine: string;
  }
): Promise<StartResult> {
  const header: SittingHeader = { ...options.header, sitting: "START" };
  io.write([
    renderGuidedHeader({ ...header, step: 1, totalSteps: 2 }),
    "",
    "aibill found one reversible test in your local evidence:",
    `  ${options.findingLabel}`,
    `  (${options.evidenceLine})`,
    "",
    "Starting freezes today's baseline numbers. It does not touch your agent,",
    "settings, or code.",
    ""
  ].join("\n"));
  for (;;) {
    const first = await ask(io, header, {
      kind: "choice",
      step: 1,
      totalSteps: 2,
      question: "Start this token test?",
      guidance: "Enter = y · n stops · cancel stops safely.",
      context: { choiceTokens: ["y", "n"] },
      enterDefault: "y",
      sittingHint: shortSittingHint
    });
    if (first.outcome === "cancelled" || first.outcome === "back") return { action: "cancelled" };
    if (first.outcome !== "answered" || first.value !== "y") return { action: "declined" };
    const second = await ask(io, header, {
      kind: "choice",
      step: 2,
      totalSteps: 2,
      question: "Did the baseline tasks in this window produce output you accepted?",
      guidance: "Answer y or n. n stops here: a baseline you did not accept cannot support a token-reduction claim.",
      context: { choiceTokens: ["y", "n"] },
      sittingHint: shortSittingHint
    });
    if (second.outcome === "cancelled") return { action: "cancelled" };
    if (second.outcome === "back") continue;
    if (second.outcome !== "answered" || second.value !== "y") {
      return { action: "qualityNotAccepted" };
    }
    return { action: "start" };
  }
}

/* ------------------------------------------------------------------ */
/* Identity sequence (improve step 4 + standalone identify)            */
/* ------------------------------------------------------------------ */

export type IdentityAnswers = {
  humanOwner: string;
  team: string;
  role: string;
  client?: string;
  costCenter?: string;
};

export type IdentityResult =
  | { action: "cancelled" }
  | { action: "backedOut" }
  | { action: "answered"; identity: IdentityAnswers };

type IdentityField = "owner" | "team" | "role" | "client" | "costCenter";

const identityFields: Array<{
  field: IdentityField;
  kind: GuidedFieldKind;
  label: string;
  question: string;
  guidance?: string;
  example: string;
}> = [
  {
    field: "owner", kind: "name", label: "owner",
    question: "Who is the accountable human owner of this project's AI cost?",
    example: "Jose Artigas"
  },
  {
    field: "team", kind: "team", label: "team",
    question: "What team does this cost belong to?",
    example: "Futura Studio"
  },
  {
    field: "role", kind: "role", label: "role",
    question: "What is your approval role for this project?",
    guidance: "(A job role — not aibill's held/passed quality vocabulary.)",
    example: "Founder"
  },
  {
    field: "client", kind: "optional", label: "client",
    question: "Client to allocate this cost to? Press Enter to skip.",
    example: "Acme Corp"
  },
  {
    field: "costCenter", kind: "optional", label: "cost center",
    question: "Cost center? Press Enter to skip.",
    example: "R&D"
  }
];

export async function runIdentitySequence(
  io: FlowIo,
  options: {
    header: SittingHeader;
    stepLabel: (fieldLabel: string, fieldIndex: number) => { step: number; totalSteps: number };
    sittingHint: string;
    /** Previous answers for prefilled revisits. */
    initial?: Partial<IdentityAnswers>;
  }
): Promise<IdentityResult> {
  const answers: Partial<IdentityAnswers> = { ...options.initial };
  let index = 0;
  while (index < identityFields.length) {
    const field = identityFields[index]!;
    const numbering = options.stepLabel(field.label, index);
    const existing = valueOf(answers, field.field);
    const outcome = await ask(io, options.header, {
      kind: field.kind,
      step: numbering.step,
      totalSteps: numbering.totalSteps,
      question: field.question,
      ...(field.guidance !== undefined ? { guidance: field.guidance } : {}),
      wordsNotCommands: field.kind !== "optional",
      example: field.example,
      context: { example: field.example },
      sittingHint: options.sittingHint,
      ...(existing !== undefined && field.kind !== "optional"
        ? { emptyKeepsValue: existing }
        : {})
    });
    if (outcome.outcome === "cancelled") return { action: "cancelled" };
    if (outcome.outcome === "back") {
      if (index === 0) return { action: "backedOut" };
      index -= 1;
      continue;
    }
    if (outcome.outcome === "skipped") {
      setValue(answers, field.field, undefined);
    } else {
      setValue(answers, field.field, outcome.value);
    }
    index += 1;
  }
  return {
    action: "answered",
    identity: {
      humanOwner: answers.humanOwner!,
      team: answers.team!,
      role: answers.role!,
      ...(answers.client ? { client: answers.client } : {}),
      ...(answers.costCenter ? { costCenter: answers.costCenter } : {})
    }
  };
}

function valueOf(answers: Partial<IdentityAnswers>, field: IdentityField): string | undefined {
  switch (field) {
    case "owner": return answers.humanOwner;
    case "team": return answers.team;
    case "role": return answers.role;
    case "client": return answers.client;
    case "costCenter": return answers.costCenter;
  }
}

function setValue(
  answers: Partial<IdentityAnswers>,
  field: IdentityField,
  value: string | undefined
): void {
  switch (field) {
    case "owner": answers.humanOwner = value ?? ""; break;
    case "team": answers.team = value ?? ""; break;
    case "role": answers.role = value ?? ""; break;
    case "client":
      if (value === undefined) delete answers.client; else answers.client = value;
      break;
    case "costCenter":
      if (value === undefined) delete answers.costCenter; else answers.costCenter = value;
      break;
  }
}

/* ------------------------------------------------------------------ */
/* PLAN & APPROVE sitting                                              */
/* ------------------------------------------------------------------ */

export type PlanDraftV1 = {
  schemaVersion: 1;
  experimentId: string;
  revisionId: string;
  answers: { change?: string; rollback?: string; canary?: string };
  savedAt: string;
};

export type PlanDraftStore = {
  load: () => Promise<PlanDraftV1 | undefined>;
  save: (draft: PlanDraftV1) => Promise<void>;
  clear: () => Promise<void>;
};

export function parsePlanDraft(value: unknown): PlanDraftV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const draft = value as Record<string, unknown>;
  if (draft.schemaVersion !== 1) return undefined;
  if (typeof draft.experimentId !== "string" || typeof draft.revisionId !== "string") {
    return undefined;
  }
  if (typeof draft.savedAt !== "string") return undefined;
  const answers = draft.answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const bounded = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 && v.length <= 1000 ? v : undefined;
  const record = answers as Record<string, unknown>;
  const parsed: PlanDraftV1 = {
    schemaVersion: 1,
    experimentId: draft.experimentId,
    revisionId: draft.revisionId,
    savedAt: draft.savedAt,
    answers: {}
  };
  const change = bounded(record.change);
  const rollback = bounded(record.rollback);
  const canary = bounded(record.canary);
  if (change) parsed.answers.change = change;
  if (rollback) parsed.answers.rollback = rollback;
  if (canary) parsed.answers.canary = canary;
  return parsed;
}

export type SuggestedPlanAnswer = {
  value: string;
  /**
   * Who actually wrote this suggestion. Drives the per-field prefill label:
   * "agent" renders `Drafted with your agent`, "aibill" renders `Suggested`.
   * Acceptance converts provenance (m9): the moment the user Enter-accepts
   * or types a sentence it is the USER'S answer — revisits show
   * `Current answer:` and no provenance is stored anywhere.
   */
  provenance: "aibill" | "agent";
};

export type PlanResult =
  | { action: "cancelled" }
  | { action: "backedOut" }
  | { action: "notApproved" }
  | { action: "identityDeclined" }
  | {
      action: "approved";
      change: string;
      rollback: string;
      canary: string;
      identity: IdentityAnswers | "existing";
    };

const planProse: Array<{
  key: "change" | "rollback" | "canary";
  question: string;
  example: string;
}> = [
  {
    key: "change",
    question: "In one short sentence: what exact reversible change should the agent make?",
    example: "Start the next task with only its required files and instructions."
  },
  {
    key: "rollback",
    question: "In one short sentence: how must the agent undo that exact change?",
    example: "Restore the prior session workflow."
  },
  {
    key: "canary",
    question: "What exact check decides whether the canary passes?",
    example: "The project tests pass and the requested output is accepted."
  }
];

export async function runPlanSitting(
  io: FlowIo,
  options: {
    header: Omit<SittingHeader, "sitting">;
    experimentId: string;
    revisionId: string;
    existingIdentity?: { owner: string; team: string; role: string };
    draftStore?: PlanDraftStore;
    sanitize: (value: string) => string;
    nowIso: () => string;
    /** Extra line rendered on the review screen (demo practice note). */
    approveExtraLine?: string;
    /**
     * Machine-drafted plan sentences, accepted with Enter. The human still
     * approves the exact recorded plan; a saved draft (the user's own words)
     * always outranks a suggestion. Provenance travels WITH each value so
     * the on-screen label is derived per field at render — there is no
     * sitting-wide label option, so a mixed sitting (agent change + aibill
     * rollback fallback) can never mislabel (B1, QA 17).
     */
    suggestedAnswers?: {
      change?: SuggestedPlanAnswer;
      rollback?: SuggestedPlanAnswer;
      canary?: SuggestedPlanAnswer;
    };
  }
): Promise<PlanResult> {
  const header: SittingHeader = { ...options.header, sitting: "PLAN & APPROVE" };
  const totalSteps = 5;
  const answers: { change?: string; rollback?: string; canary?: string } = {};
  let identity: IdentityAnswers | "existing" | undefined;
  let identityDraft: Partial<IdentityAnswers> = {};

  // Draft resume — only when it matches this experiment AND revision.
  if (options.draftStore) {
    const draft = await options.draftStore.load();
    const matches = draft &&
      draft.experimentId === options.experimentId &&
      draft.revisionId === options.revisionId &&
      (draft.answers.change ?? draft.answers.rollback ?? draft.answers.canary) !== undefined;
    if (draft && !matches) {
      await options.draftStore.clear();
    } else if (draft && matches) {
      const answered = ["change", "rollback", "canary"]
        .filter((key) => draft.answers[key as keyof typeof draft.answers]).length;
      io.write([
        renderGuidedHeader({ ...header, step: 1, totalSteps }),
        "",
        `Unfinished answers for this test were saved ${draft.savedAt}`,
        `(steps 1-${answered} of ${totalSteps} answered).`,
        ""
      ].join("\n"));
      const resume = await ask(io, header, {
        kind: "choice",
        step: 1,
        totalSteps,
        question: "Resume where you left off? Enter = y · n starts the plan over (saved answers are discarded).",
        context: { choiceTokens: ["y", "n"] },
        enterDefault: "y",
        sittingHint: planSittingHint
      });
      if (resume.outcome === "cancelled" || resume.outcome === "back") {
        // Back is not a decline: leave the draft intact for next time.
        return { action: "cancelled" };
      }
      if (resume.outcome === "answered" && resume.value === "y") {
        Object.assign(answers, draft.answers);
      } else {
        await options.draftStore.clear();
      }
    }
  }

  type PlanStep = "change" | "rollback" | "canary" | "identity" | "review";
  const order: PlanStep[] = ["change", "rollback", "canary", "identity", "review"];
  let stepIndex = order.findIndex((step) =>
    step === "change" && !answers.change ||
    step === "rollback" && !answers.rollback ||
    step === "canary" && !answers.canary ||
    step === "identity"
  );
  if (stepIndex < 0) stepIndex = 0;

  for (;;) {
    const step = order[stepIndex]!;
    if (step === "change" || step === "rollback" || step === "canary") {
      const prose = planProse[stepIndex]!;
      const existing = answers[prose.key];
      const suggested = options.suggestedAnswers?.[prose.key];
      const prefill = existing ?? suggested?.value;
      const outcome = await ask(io, header, {
        kind: "prose",
        step: stepIndex + 1,
        totalSteps,
        question: prose.question,
        wordsNotCommands: true,
        // The prefill IS the example when one is shown.
        ...(prefill === undefined ? { example: prose.example } : {}),
        context: { example: prose.example },
        navigationHint: "Type back to return, or cancel to stop safely.",
        sittingHint: planSittingHint,
        ...(prefill !== undefined ? { emptyKeepsValue: prefill } : {}),
        // A saved/typed answer outranks any suggestion and shows the
        // default "Current answer" revisit label; a suggestion's label is
        // computed from ITS OWN provenance, per field (B1, m9).
        ...(prefill !== undefined && existing === undefined && suggested !== undefined
          ? {
              emptyKeepsLabel: suggested.provenance === "agent"
                ? "Drafted with your agent"
                : "Suggested"
            }
          : {})
      });
      if (outcome.outcome === "cancelled") return { action: "cancelled" };
      if (outcome.outcome === "back") {
        if (stepIndex === 0) return { action: "backedOut" };
        stepIndex -= 1;
        continue;
      }
      if (outcome.outcome !== "answered") continue;
      answers[prose.key] = options.sanitize(outcome.value).trim().slice(0, 1000);
      if (options.draftStore) {
        await options.draftStore.save({
          schemaVersion: 1,
          experimentId: options.experimentId,
          revisionId: options.revisionId,
          answers: { ...answers },
          savedAt: options.nowIso()
        });
      }
      stepIndex += 1;
      continue;
    }

    if (step === "identity") {
      if (options.existingIdentity && identity === undefined) {
        io.write([
          renderGuidedHeader({ ...header, step: 4, totalSteps }),
          "",
          "STEP 4 of 5 · who approves",
          `Already confirmed for this project: ${options.existingIdentity.owner} · ` +
            `${options.existingIdentity.team} · ${options.existingIdentity.role}`,
          ""
        ].join("\n"));
        const confirm = await ask(io, header, {
          kind: "choice",
          step: 4,
          totalSteps,
          question: "Approve as this identity? Enter = y · n stops here so you can run identify again first.",
          context: { choiceTokens: ["y", "n"] },
          enterDefault: "y",
          sittingHint: planSittingHint
        });
        if (confirm.outcome === "cancelled") return { action: "cancelled" };
        if (confirm.outcome === "back") { stepIndex -= 1; continue; }
        if (confirm.outcome === "answered" && confirm.value === "y") {
          identity = "existing";
          stepIndex += 1;
          continue;
        }
        return { action: "identityDeclined" };
      }
      io.write([
        renderGuidedHeader({ ...header, step: 4, totalSteps }),
        "",
        "STEP 4 of 5 · who approves — recorded locally, never inferred",
        ""
      ].join("\n"));
      const result = await runIdentitySequence(io, {
        header,
        stepLabel: () => ({ step: 4, totalSteps }),
        sittingHint: planSittingHint,
        initial: identityDraft
      });
      if (result.action === "cancelled") return { action: "cancelled" };
      if (result.action === "backedOut") { stepIndex -= 1; continue; }
      identity = result.identity;
      identityDraft = { ...result.identity };
      stepIndex += 1;
      continue;
    }

    // review + approve
    const approver = identity === "existing"
      ? `${options.existingIdentity!.owner} (${options.existingIdentity!.role})`
      : `${(identity as IdentityAnswers).humanOwner} (${(identity as IdentityAnswers).role})`;
    const team = identity === "existing"
      ? options.existingIdentity!.team
      : (identity as IdentityAnswers).team;
    io.write([
      renderGuidedHeader({ ...header, step: 5, totalSteps }),
      "",
      "STEP 5 of 5 · review, then approve",
      "",
      `  Change:   ${answers.change}`,
      `  Rollback: ${answers.rollback}`,
      `  Canary:   ${answers.canary}`,
      `  Approver: ${approver} · ${team}`,
      "",
      "Approval is recorded before any change as a local self-attestation",
      "(user-declared, not company RBAC). aibill stores opaque hashes of the",
      "three sentences above, never the text.",
      ...(options.approveExtraLine ? ["", options.approveExtraLine] : []),
      ""
    ].join("\n"));
    const approval = await ask(io, header, {
      kind: "approve",
      step: 5,
      totalSteps,
      question: "Type APPROVE (all capitals) to authorize exactly this plan.\nType back to edit, or cancel to stop without approving.",
      sittingHint: planSittingHint
    });
    if (approval.outcome === "back") {
      // Re-open the identity step: a confirmed "existing" identity must be
      // re-confirmed after editing, and typed answers stay prefilled.
      identity = undefined;
      stepIndex -= 1;
      continue;
    }
    if (approval.outcome === "answered" && approval.value === "APPROVE") {
      if (options.draftStore) await options.draftStore.clear();
      return {
        action: "approved",
        change: answers.change!,
        rollback: answers.rollback!,
        canary: answers.canary!,
        identity: identity!
      };
    }
    // cancel, EOF, decline words — all are a decline, never an error.
    return { action: "notApproved" };
  }
}

/* ------------------------------------------------------------------ */
/* RECORD sitting                                                      */
/* ------------------------------------------------------------------ */

export type RecordResult =
  | { action: "cancelled" }
  | { action: "backedOut" }
  | { action: "notYet" }
  | { action: "recorded"; appliedAtIso: string; canary: "passed" | "failed" };

export async function runRecordSitting(
  io: FlowIo,
  options: {
    header: Omit<SittingHeader, "sitting">;
    approvedAtIso: string;
    approvedByLine: string;
    /**
     * Agent-drafted applied-at prefill. Enter-keep re-classifies it with
     * the approvedAtIso context (defense in depth), so a time before the
     * approval or in the future can never be Enter-accepted.
     */
    suggested?: { appliedAtIso?: string };
    /**
     * The agent's REPORTED canary result. Renders only as a claim line
     * above the unchanged p/f/n question — it never prefills anything, and
     * Enter on an empty line reprompts exactly as today (M6, QA 18). The
     * most fakeable financial input in the loop keeps a mandatory human
     * keystroke.
     */
    agentCanaryReport?: "passed" | "failed";
  }
): Promise<RecordResult> {
  const header: SittingHeader = { ...options.header, sitting: "RECORD WHAT HAPPENED" };
  io.write([
    renderGuidedHeader({ ...header, step: 1, totalSteps: 2 }),
    "",
    "Your approved plan is waiting for its result.",
    `  ${options.approvedByLine}`,
    ""
  ].join("\n"));
  for (;;) {
    const time = await ask(io, header, {
      kind: "time",
      step: 1,
      totalSteps: 2,
      question: "When was the approved change applied? Paste the UTC time the agent reported, or type now if it finished moments ago.",
      example: "2026-08-17T14:03:00Z",
      navigationHint: "Type back if the change has not been applied yet, or cancel to stop safely.",
      context: { example: "2026-08-17T14:03:00Z", approvedAtIso: options.approvedAtIso },
      sittingHint: recordSittingHint,
      ...(options.suggested?.appliedAtIso !== undefined
        ? {
            emptyKeepsValue: options.suggested.appliedAtIso,
            emptyKeepsLabel: "Drafted with your agent"
          }
        : {})
    });
    if (time.outcome === "cancelled") return { action: "cancelled" };
    if (time.outcome === "back") return { action: "backedOut" };
    if (time.outcome !== "answered") return { action: "cancelled" };
    const outcome = await ask(io, header, {
      kind: "choice",
      step: 2,
      totalSteps: 2,
      question: options.agentCanaryReport !== undefined
        ? `Your agent reports: canary ${options.agentCanaryReport} — not yet recorded; your\nanswer below is what counts.\nDid the approved canary pass?`
        : "Did the approved canary pass?",
      guidance: "Answer p (passed) · f (failed) · n (not run yet)",
      context: { choiceTokens: ["p", "f", "n"] },
      sittingHint: recordSittingHint
    });
    if (outcome.outcome === "cancelled") return { action: "cancelled" };
    if (outcome.outcome === "back") continue;
    if (outcome.outcome !== "answered" || outcome.value === "n") return { action: "notYet" };
    return {
      action: "recorded",
      appliedAtIso: time.value,
      canary: outcome.value === "p" ? "passed" : "failed"
    };
  }
}

/* ------------------------------------------------------------------ */
/* DECLARE QUALITY sitting                                             */
/* ------------------------------------------------------------------ */

export type QualityResult =
  | { action: "cancelled" }
  | { action: "stillMissing" }
  | { action: "declared"; quality: "held" | "regressed" };

export async function runQualitySitting(
  io: FlowIo,
  options: {
    header: Omit<SittingHeader, "sitting">;
    matchedSessions: number;
    minimumSessions: number;
  }
): Promise<QualityResult> {
  const header: SittingHeader = { ...options.header, sitting: "DECLARE QUALITY" };
  io.write([
    renderGuidedHeader({ ...header, step: 1, totalSteps: 1 }),
    "",
    `${options.matchedSessions}/${options.minimumSessions} matched post-change sessions are in.`,
    ""
  ].join("\n"));
  const outcome = await ask(io, header, {
    kind: "choice",
    step: 1,
    totalSteps: 1,
    question: "Did the accepted output quality of those sessions hold?",
    guidance: "Answer h (held) · r (regressed) · m (still cannot say) — your own declaration, recorded as user-declared",
    context: { choiceTokens: ["h", "r", "m"] },
    sittingHint: shortSittingHint
  });
  if (outcome.outcome === "cancelled" || outcome.outcome === "back") {
    return { action: "cancelled" };
  }
  if (outcome.outcome !== "answered" || outcome.value === "m") {
    return { action: "stillMissing" };
  }
  return { action: "declared", quality: outcome.value === "h" ? "held" : "regressed" };
}

/* ------------------------------------------------------------------ */
/* ROLLBACK sitting                                                    */
/* ------------------------------------------------------------------ */

export type RollbackResult =
  | { action: "cancelled" }
  | { action: "notRolledBack" }
  | { action: "rolledBack"; evidence: string };

export async function runRollbackSitting(
  io: FlowIo,
  options: {
    header: Omit<SittingHeader, "sitting">;
    sanitize: (value: string) => string;
    rollbackExample: string;
    /** Returns true when the typed sentence matches the approved rollback hash. */
    matchesApprovedRollback?: (evidence: string) => boolean;
  }
): Promise<RollbackResult> {
  const header: SittingHeader = { ...options.header, sitting: "ROLLBACK" };
  io.write([
    renderGuidedHeader({ ...header, step: 1, totalSteps: 2 }),
    "",
    "Quality or token use regressed. Undo the one approved change and keep",
    "the evidence.",
    ""
  ].join("\n"));
  confirm: for (;;) {
    const confirmed = await ask(io, header, {
      kind: "choice",
      step: 1,
      totalSteps: 2,
      question: "Have you executed the preserved rollback? Answer y or n.",
      context: { choiceTokens: ["y", "n"] },
      sittingHint: shortSittingHint
    });
    if (confirmed.outcome === "cancelled" || confirmed.outcome === "back") {
      return { action: "cancelled" };
    }
    if (confirmed.outcome !== "answered" || confirmed.value !== "y") {
      return { action: "notRolledBack" };
    }
    for (;;) {
      const evidence = await ask(io, header, {
        kind: "prose",
        step: 2,
        totalSteps: 2,
        question: "Repeat the short rollback sentence you approved. It must match exactly; aibill kept only its hash.",
        wordsNotCommands: true,
        example: options.rollbackExample,
        context: { example: options.rollbackExample },
        sittingHint: shortSittingHint
      });
      if (evidence.outcome === "cancelled") return { action: "cancelled" };
      if (evidence.outcome === "back") continue confirm;
      if (evidence.outcome !== "answered") continue;
      const sanitized = options.sanitize(evidence.value).trim().slice(0, 1000);
      if (options.matchesApprovedRollback && !options.matchesApprovedRollback(sanitized)) {
        io.write(
          "That does not match the rollback you approved. Type the exact sentence you approved, or cancel to stop safely.\n> "
        );
        continue;
      }
      return { action: "rolledBack", evidence: sanitized };
    }
  }
}
