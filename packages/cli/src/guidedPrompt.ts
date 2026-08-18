/**
 * Guided-prompt engine for the aibill improve/identify questionnaires.
 *
 * Everything here is pure or injected: screen rendering returns strings, the
 * classifier is a table-tested function, and terminal I/O arrives through an
 * injectable prompt source that carries line arrival timestamps so pasted-
 * ahead input can never answer a question that had not rendered yet.
 *
 * Design: P0B_FLOW_DESIGN.md §2/§3b/§3c with every P0B_QA_VERDICT.md
 * amendment (two-tier shell classifier with corroboration + `keep` override,
 * drain on every answer, exact-token choices, strict ISO times, reserved
 * vocabulary, Unicode format-character rejection, byte-honest length copy).
 */

import {
  classifyGuidedAnswer,
  type ClassifyContext,
  type ClassifyResult,
  type GuidedFieldKind,
  type RejectCode
} from "@agent-finops/core";

// The classifier lives in core (guidedAnswer.ts) so the terminal lane, the
// agent-draft screening lane, and the MCP draft_improve_command preview
// share ONE function by construction. Re-exported for existing consumers.
export {
  classifyGuidedAnswer,
  type ClassifyContext,
  type ClassifyResult,
  type GuidedFieldKind,
  type RejectCode
};

const PROMPT_MARKER = "> ";

/* ------------------------------------------------------------------ */
/* Prompt source                                                       */
/* ------------------------------------------------------------------ */

export type PromptSourceEvent =
  | { kind: "line"; text: string; receivedAtMs: number }
  | { kind: "closed" }
  | { kind: "interrupted" };

export interface GuidedPromptSource {
  /** Next event. `promptRenderedAtMs` gates pasted-ahead lines. */
  next: (promptRenderedAtMs: number) => Promise<PromptSourceEvent>;
  /** Discard buffered lines; returns how many were thrown away. */
  drain: () => number;
}

/**
 * Scripted source for tests and non-interactive callers. Exhaustion THROWS:
 * a miscounted answer script must fail fast, never hang a reprompt loop.
 */
export function createScriptedPromptSource(
  answers: readonly string[]
): GuidedPromptSource {
  const remaining = [...answers];
  return {
    next: async () => {
      if (remaining.length === 0) {
        throw new Error(
          "Scripted prompt source exhausted: the answer script is shorter than the flow."
        );
      }
      return { kind: "line", text: remaining.shift()!, receivedAtMs: Date.now() };
    },
    drain: () => 0
  };
}

/**
 * Real terminal source over a readline-style line emitter. The caller owns
 * readline construction; this wrapper owns buffering, arrival timestamps,
 * drain, and close/SIGINT mapping.
 */
export function createInteractivePromptSource(emitter: {
  onLine: (listener: (line: string) => void) => void;
  onClose: (listener: () => void) => void;
  onInterrupt: (listener: () => void) => void;
}): GuidedPromptSource {
  type Buffered = { text: string; receivedAtMs: number };
  const buffered: Buffered[] = [];
  let closed = false;
  let interrupted = false;
  let purged = 0;
  let wake: (() => void) | undefined;
  let burstStartMs: number | undefined;
  let lastArrivalMs: number | undefined;
  // Terminal pastes over ~1KB arrive as multiple PTY chunks a few ms apart.
  // Lines arriving within this window inherit the burst's FIRST timestamp,
  // so a late paste chunk can never answer a question rendered mid-burst.
  // No human types two separate lines this fast.
  const burstWindowMs = 75;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  emitter.onLine((line) => {
    const arrivedAt = Date.now();
    if (lastArrivalMs === undefined || arrivedAt - lastArrivalMs > burstWindowMs) {
      burstStartMs = arrivedAt;
    }
    lastArrivalMs = arrivedAt;
    buffered.push({ text: line, receivedAtMs: burstStartMs ?? arrivedAt });
    notify();
  });
  emitter.onClose(() => {
    closed = true;
    notify();
  });
  emitter.onInterrupt(() => {
    interrupted = true;
    notify();
  });
  return {
    next: async (promptRenderedAtMs) => {
      for (;;) {
        if (interrupted) return { kind: "interrupted" };
        // Pasted-ahead protection for every step: lines whose burst began at
        // or before this prompt's render are discarded, never used as
        // answers. The purge is counted so the drain notice stays truthful.
        while (buffered.length > 0 && buffered[0]!.receivedAtMs <= promptRenderedAtMs) {
          buffered.shift();
          purged += 1;
        }
        const head = buffered.shift();
        if (head) return { kind: "line", text: head.text, receivedAtMs: head.receivedAtMs };
        if (closed) return { kind: "closed" };
        await new Promise<void>((resolvePromise) => {
          wake = resolvePromise;
        });
      }
    },
    drain: () => {
      const discarded = purged + buffered.length;
      purged = 0;
      buffered.length = 0;
      return discarded;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Screen rendering                                                    */
/* ------------------------------------------------------------------ */

export type GuidedScreenHeader = {
  commandTitle: string;
  experimentLabel: string;
  sitting: string;
  step: number;
  totalSteps: number;
  demo?: boolean;
};

export function renderGuidedHeader(header: GuidedScreenHeader): string {
  const demoPrefix = header.demo
    ? "DEMO · synthetic sample — practice run, nothing is recorded\n"
    : "";
  return `${demoPrefix}${header.commandTitle}\n` +
    `${header.experimentLabel} · ${header.sitting} · step ${header.step} of ${header.totalSteps}` +
    `${header.demo ? " · DEMO" : ""}`;
}

export type GuidedQuestion = {
  step: number;
  totalSteps: number;
  question: string;
  guidance?: string;
  wordsNotCommands?: boolean;
  example?: string;
  navigationHint?: string;
};

export function renderGuidedQuestion(question: GuidedQuestion): string {
  const lines = [
    `QUESTION · step ${question.step} of ${question.totalSteps}` +
      (question.wordsNotCommands ? " · answer in words — do not paste a shell command" : "")
  ];
  lines.push(question.question);
  if (question.example) lines.push(`  e.g. ${question.example}`);
  if (question.guidance) lines.push(`  ${question.guidance}`);
  if (question.navigationHint) lines.push(question.navigationHint);
  lines.push(PROMPT_MARKER);
  return lines.join("\n");
}

export function renderRepromptFrame(
  reason: string,
  example: string | undefined,
  consecutiveRejections: number,
  sittingHint: string
): string {
  const lines = [reason];
  if (example) lines.push(`  e.g. ${example}`);
  if (consecutiveRejections >= 2 && sittingHint) lines.push(sittingHint);
  lines.push(PROMPT_MARKER);
  return lines.join("\n");
}

export function renderDrainNotice(discarded: number): string {
  return discarded > 0 ? `( ${discarded} more pasted line(s) were discarded )` : "";
}

export type NextCommandBlock = {
  reason: string;
  command: string;
  advancedLine?: string;
};

/**
 * Exactly one NEXT COMMAND per clean exit. The optional advanced line is the
 * PLAN-cancel parenthetical, excluded from the one-command lint by its
 * "(Advanced:" prefix.
 */
export function renderNextCommand(block: NextCommandBlock): string {
  const lines = [
    `NEXT COMMAND · ${block.reason}`,
    `  ${block.command}`
  ];
  if (block.advancedLine) lines.push(`(Advanced: ${block.advancedLine})`);
  return lines.join("\n");
}

export function renderForYourAgent(text: string): string {
  return [
    "FOR YOUR AGENT · paste this text into your coding agent — not into this terminal",
    ...text.split("\n").map((line) => `  ${line}`)
  ].join("\n");
}

export const guidedFooter =
  "Local only · no provider settings or code changed automatically.";

/* ------------------------------------------------------------------ */
/* Ask loop                                                            */
/* ------------------------------------------------------------------ */

export type AskOutcome =
  | { outcome: "answered"; value: string }
  | { outcome: "skipped" }
  | { outcome: "back" }
  | { outcome: "cancelled" };

export type AskOptions = {
  kind: GuidedFieldKind;
  render: () => string;
  context?: ClassifyContext;
  /** Shown after two consecutive rejections; per-sitting truthful copy. */
  sittingHint: string;
  write: (text: string) => void;
  source: GuidedPromptSource;
  /**
   * Circuit breaker for non-TTY callers: cancel after this many consecutive
   * IDENTICAL rejections (same code and same text; credential rejections
   * compare by code only, so the raw secret is never retained).
   */
  maxIdenticalRejections?: number;
  nowMs?: () => number;
  /**
   * Prefill for revisited steps: an empty line keeps this value instead of
   * triggering the empty-answer reprompt. The kept value is re-classified
   * before acceptance — a value that would not pass the field's own
   * classifier can never be Enter-kept. Ignored for optional fields, where
   * an empty line always means skip.
   */
  emptyKeepsValue?: string;
  /** Restated context line (experiment/DEMO tag) prefixed to reprompt frames. */
  frameTag?: string;
};

/**
 * One question: render, read, classify, reprompt in place (never abort on
 * bad input), drain buffered paste lines on every answer, and map close and
 * interrupt to a clean cancel.
 */
export async function askGuidedQuestion(options: AskOptions): Promise<AskOutcome> {
  const now = options.nowMs ?? (() => Date.now());
  let consecutiveRejections = 0;
  let identicalRejections = 0;
  let shellRejections = 0;
  let lastFingerprint: string | undefined;
  let lastShellText: string | undefined;
  options.write(options.render());
  for (;;) {
    const renderedAt = now();
    const event = await options.source.next(renderedAt);
    if (event.kind === "closed" || event.kind === "interrupted") {
      return { outcome: "cancelled" };
    }
    const discarded = options.source.drain();
    const notice = renderDrainNotice(discarded);
    if (notice) options.write(notice);

    let verdict = classifyGuidedAnswer(options.kind, event.text, {
      ...options.context,
      nowMs: now(),
      priorShellRejections: shellRejections
    });
    if (verdict.outcome === "navigate") {
      return verdict.action === "back" ? { outcome: "back" } : { outcome: "cancelled" };
    }
    if (verdict.outcome === "skip") return { outcome: "skipped" };
    if (
      verdict.outcome === "reject" &&
      verdict.code === "empty" &&
      options.emptyKeepsValue !== undefined
    ) {
      // Defense in depth: the kept value passes the field's own classifier
      // or it cannot be kept — Enter is never a validation bypass.
      const kept = classifyGuidedAnswer(options.kind, options.emptyKeepsValue, {
        ...options.context,
        nowMs: now()
      });
      if (kept.outcome === "accept") {
        return { outcome: "answered", value: kept.value };
      }
      if (kept.outcome === "reject") verdict = kept;
    }
    if (verdict.outcome === "accept") {
      // The keep override substitutes only the last SHELL-rejected line —
      // never a credential (excluded from arming) and never a path.
      if (options.kind === "prose" && verdict.value === "keep" && lastShellText) {
        return { outcome: "answered", value: lastShellText };
      }
      return { outcome: "answered", value: verdict.value };
    }

    consecutiveRejections += 1;
    const trimmed = event.text.trim();
    const fingerprint = verdict.code === "credential"
      ? "credential"
      : `${verdict.code} ${trimmed}`;
    identicalRejections = fingerprint === lastFingerprint ? identicalRejections + 1 : 1;
    lastFingerprint = fingerprint;
    if (verdict.code === "shell") {
      // Any consecutive shell rejections arm keep, identical or not — the
      // hint's promise must match when keep actually works.
      shellRejections += 1;
      lastShellText = trimmed;
    } else {
      shellRejections = 0;
    }

    const keepHint =
      options.kind === "prose" && verdict.code === "shell" && shellRejections >= 2
        ? " Type keep to record exactly what you typed as words."
        : "";
    const frame = renderRepromptFrame(
      verdict.message + keepHint,
      options.context?.example,
      consecutiveRejections,
      options.sittingHint
    );
    options.write(options.frameTag ? `${options.frameTag}\n${frame}` : frame);

    // Floored at 3 so the keep hint (offered at 2) can never be shown in the
    // same iteration the breaker cancels. Varied rejections trip the breaker
    // at 3x the identical cap so a looping embedding can never spin forever.
    if (options.maxIdenticalRejections !== undefined) {
      const identicalCap = Math.max(3, options.maxIdenticalRejections);
      if (identicalRejections >= identicalCap || consecutiveRejections >= identicalCap * 3) {
        return { outcome: "cancelled" };
      }
    }
  }
}
