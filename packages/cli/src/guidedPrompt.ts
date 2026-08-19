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

import { isCredentialLike, isPathLike } from "./projectAccountabilityState.js";

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
/* Classifier                                                          */
/* ------------------------------------------------------------------ */

export type GuidedFieldKind =
  | "prose"
  | "name"
  | "team"
  | "role"
  | "optional"
  | "time"
  | "choice"
  | "approve";

export type ClassifyContext = {
  example?: string;
  /** Exact accepted tokens for choice fields, lowercase. */
  choiceTokens?: readonly string[];
  /** ISO instant the plan was approved (time fields). */
  approvedAtIso?: string;
  /** Clock override for tests. */
  nowMs?: number;
  /** Consecutive identical shell-rejections at this step (keep override). */
  priorShellRejections?: number;
};

export type ClassifyResult =
  | { outcome: "accept"; value: string }
  | { outcome: "navigate"; action: "back" | "cancel" }
  | { outcome: "skip" }
  | { outcome: "reject"; code: RejectCode; message: string };

export type RejectCode =
  | "control"
  | "empty"
  | "shell"
  | "path"
  | "credential"
  | "reserved"
  | "timestamp_shaped"
  | "length"
  | "substance"
  | "time_invalid"
  | "time_before_approval"
  | "time_future"
  | "choice"
  | "approve_case";

const unambiguousBinaries = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "tsx", "ts-node",
  "git", "gh", "curl", "wget", "bash", "sh", "zsh", "fish", "pwsh", "powershell",
  "python", "python3", "pip", "pip3", "pipx", "uv", "uvx", "poetry", "pytest",
  "vitest", "jest", "brew", "apt", "docker", "kubectl", "cargo", "rustc",
  "dotnet", "mvn", "gradle", "terraform", "ssh", "scp", "rsync", "sudo",
  "chmod", "chown", "xargs", "grep", "rg", "sed", "awk", "tar", "zip", "unzip",
  "aibill", "ai-spend-agent", "vim", "nano", "code", "dir", "del", "robocopy"
]);

/** Common English verbs that are also binaries: reject only with corroboration. */
const ambiguousVerbs = new Set([
  "make", "open", "find", "go", "date", "kill", "top", "head", "tail", "touch",
  "export", "source", "alias", "echo", "type", "cd", "ls", "cat", "cp", "mv",
  "rm", "printf", "less", "ps", "copy", "move"
]);

const reservedVocabulary = new Set([
  "held", "passed", "failed", "missing", "regressed", "approve", "approved",
  "yes", "no", "y", "n", "p", "f", "h", "r", "m", "now", "skip", "keep"
]);

/**
 * The accountability backstop predicate (`isCredentialLike`) is the FLOOR:
 * this classifier must reject at least everything `parseDisplayLabel` would
 * reject, or a validated answer could still abort later (B2 QA blocker B1).
 * These extra patterns sit on top of the floor.
 */
const extraCredentialPattern =
  /(authorization\s*:\s*(?:bearer|basic)\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[ _-]?key|token|password|secret)\s*[:=]\s*\S+)/i;

function looksLikeCredential(answer: string): boolean {
  return isCredentialLike(answer) || extraCredentialPattern.test(answer);
}

const pathExtensionPattern =
  /\S+\.(?:js|ts|mjs|cjs|jsx|tsx|json|sh|bash|py|rb|go|rs|md|yml|yaml|toml|lock|xml|ps1|bat|cmd|gradle)(?:$|\s)/i;

/** Strict full date-time with zone, mirroring the CLI's validIsoString. */
const strictIsoPattern =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

const futureToleranceMs = 2 * 60 * 1000;

/**
 * Exact non-answer phrases (normalized: lowercase, punctuation stripped).
 * A plan sentence must be actionable later; "i am not sure" passes the
 * two-word substance bar but records a safety net that cannot be executed.
 * Exact match only — a real sentence that merely CONTAINS one still passes.
 */
const nonAnswerPhrases = new Set([
  "i am not sure", "im not sure", "not sure", "unsure", "i am unsure",
  "idk", "i dont know", "dont know", "no idea", "dunno",
  "no se", "no sé", "ni idea",
  "whatever", "anything", "nothing", "none", "na", "tbd",
  "help", "test", "testing", "asdf"
]);

function isNonAnswer(lowered: string): boolean {
  const normalized = lowered.replace(/[.,!?'’]/g, "").replace(/\s+/g, " ").trim();
  return nonAnswerPhrases.has(normalized);
}

const choiceWordAliases: Record<string, string> = {
  yes: "y",
  no: "n",
  passed: "p",
  failed: "f",
  held: "h",
  regressed: "r",
  missing: "m"
};

function stripQuotes(token: string): string {
  return token.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
}

function stripEnvPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (
    index < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(tokens[index]!) ||
      tokens[index] === "sudo" || tokens[index] === "env")
  ) {
    index += 1;
  }
  return tokens.slice(index);
}

function looksLikeShellCommand(answer: string): boolean {
  if (/^[$%#>] ?/.test(answer)) return true;
  if (/&&|\|\||`|\$\(|>>|<<|2>&1| \| | > | < /.test(answer)) return true;
  if (/(?:^|\s)--[A-Za-z][\w-]*/.test(answer)) return true;
  if (/(?:^|\s)-[A-Za-z](?=\s|$)/.test(answer)) return true;
  // PowerShell Verb-Noun cmdlet shape (Get-ChildItem, Remove-Item …).
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+(?:\s|$)/.test(answer)) return true;
  const tokens = stripEnvPrefixes(answer.split(/\s+/).filter(Boolean));
  const first = stripQuotes(tokens[0] ?? "").toLowerCase();
  if (unambiguousBinaries.has(first)) return true;
  if (ambiguousVerbs.has(first)) {
    // Ambiguous English verbs reject only with a second signal: a path-like
    // token, a file extension, or a terse all-lowercase fragment that reads
    // like a command line rather than a sentence.
    const hasPathToken = tokens.some((token) =>
      /^(?:\/|\.\/|\.\.\/|~\/)/.test(token) || token.includes("/"));
    const hasExtension = pathExtensionPattern.test(answer);
    const terseLowercase = tokens.length <= 2 && answer === answer.toLowerCase();
    return hasPathToken || hasExtension || terseLowercase;
  }
  return false;
}

function looksLikePath(answer: string, kind: GuidedFieldKind): boolean {
  // The accountability backstop predicate is the floor: it covers leading
  // slashes and dot-segments, drive letters, backslashes, and bare ".".
  if (isPathLike(answer)) return true;
  if (kind === "prose") {
    if (pathExtensionPattern.test(answer)) return true;
    const slashTokens = answer.split(/\s+/).filter((token) => token.includes("/"));
    return slashTokens.length >= 2;
  }
  // Name-like fields: a slashed token is a path; a bare file-extension token
  // counts only when it IS the whole answer — "Node.js Guild" is a team.
  if (/\S+\/\S+/.test(answer)) return true;
  return pathExtensionPattern.test(answer) && !/\s/.test(answer.trim());
}

function byteLength(value: string): number {
  return Buffer.byteLength(value.normalize("NFC"), "utf8");
}

function hasControlOrFormatCharacters(value: string): boolean {
  // C0/C1 controls including embedded newlines and DEL (tab and trailing
  // CR are normalized earlier), plus the invisible/directional format
  // characters that can spoof what the review screen appears to say.
  // ZWNJ/ZWJ (U+200C/U+200D) are deliberately ALLOWED: they are standard
  // orthography in Persian and other scripts and in emoji families.
  if (/[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/.test(value)) return true;
  return /[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/.test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function classifyGuidedAnswer(
  kind: GuidedFieldKind,
  rawInput: string,
  context: ClassifyContext = {}
): ClassifyResult {
  const normalizedTabs = rawInput.replace(/\t/g, " ").replace(/\r$/, "");
  const answer = normalizedTabs.trim();
  const lowered = answer.toLowerCase();

  const reject = (code: RejectCode, message: string): ClassifyResult => ({
    outcome: "reject", code, message
  });
  const exampleSuffix = context.example ? ` e.g. ${context.example}` : "";

  // Navigation pre-pass (every field).
  if (lowered === "back" || lowered === "b") return { outcome: "navigate", action: "back" };
  if (lowered === "cancel" || lowered === "q" || lowered === "quit" || lowered === "exit") {
    return { outcome: "navigate", action: "cancel" };
  }

  if (kind === "optional" && (answer === "" || lowered === "skip")) {
    return { outcome: "skip" };
  }

  if (hasControlOrFormatCharacters(answer) || hasUnpairedSurrogate(answer)) {
    return reject("control",
      "That answer carried hidden control characters (usually a stray paste). Type it as plain text.");
  }

  if (answer === "") {
    if (kind === "approve") {
      // An empty answer at the approval screen is a decline, not an error.
      return { outcome: "navigate", action: "cancel" };
    }
    return reject("empty", "This step needs an answer in words. Type it, or type back or cancel.");
  }

  if (looksLikeCredential(answer)) {
    // Never echo, never store: callers must discard this input entirely.
    return reject("credential",
      "That looks like it contains a credential. aibill never stores credentials — that answer was discarded. Type it again without the secret.");
  }

  switch (kind) {
    case "approve": {
      if (answer === "APPROVE") return { outcome: "accept", value: answer };
      // Clear approval intent gets the nudge, never a silent decline:
      // APPROVED, aprove, i approve, full-width IME APPROVE, yes/y.
      const folded = answer.normalize("NFKC").toUpperCase();
      if (folded.includes("APPROV") || folded.includes("APROVE") ||
          lowered === "yes" || lowered === "y") {
        return reject("approve_case",
          "Approval must be typed APPROVE, in capitals, so it cannot happen by accident.");
      }
      // Any other answer is a decline — an answer, not an error.
      return { outcome: "navigate", action: "cancel" };
    }
    case "choice": {
      const tokens = context.choiceTokens ?? [];
      if (tokens.includes(lowered)) return { outcome: "accept", value: lowered };
      // Exact full words map to their canonical letter, but only within
      // their own question family: "no" at a p/f/n question must reprompt,
      // never silently become "n". Never prefix-match either — "probably
      // failed" or "not sure" reprompts, not guesses.
      const alias = choiceWordAliases[lowered];
      if (alias !== undefined && tokens.includes(alias)) {
        const applies =
          lowered === "yes" || lowered === "no" ? tokens.includes("y") :
          lowered === "passed" || lowered === "failed" ? tokens.includes("p") :
          tokens.includes("h");
        if (applies) return { outcome: "accept", value: alias };
      }
      if (tokens.includes("p")) {
        return reject("choice", "Answer p (passed), f (failed), or n (not run yet).");
      }
      if (tokens.includes("h")) {
        return reject("choice", "Answer h (held), r (regressed), or m (cannot say).");
      }
      return reject("choice", `Answer one of: ${tokens.join(", ")}.`);
    }
    case "time": {
      if (lowered === "now") {
        return { outcome: "accept", value: new Date(context.nowMs ?? Date.now()).toISOString() };
      }
      if (!strictIsoPattern.test(answer)) {
        return reject("time_invalid",
          "That is not a UTC ISO-8601 time. e.g. 2026-08-17T14:03:00Z — or type now if it just finished.");
      }
      const parsed = Date.parse(answer);
      if (!Number.isFinite(parsed)) {
        return reject("time_invalid",
          "That is not a UTC ISO-8601 time. e.g. 2026-08-17T14:03:00Z — or type now if it just finished.");
      }
      const approvedAt = context.approvedAtIso ? Date.parse(context.approvedAtIso) : undefined;
      if (context.approvedAtIso !== undefined && !Number.isFinite(approvedAt ?? Number.NaN)) {
        // Fail closed: an unreadable approval time must never silently
        // disable the after-approval check.
        return reject("time_invalid",
          "The approval record's own time is unreadable, so this time cannot be checked. Type cancel and rerun this command.");
      }
      if (approvedAt !== undefined && parsed <= approvedAt) {
        return reject("time_before_approval",
          `That time is not after the approval at ${context.approvedAtIso}. A change cannot be applied before it was approved. Paste the time the agent reported.`);
      }
      if (parsed > (context.nowMs ?? Date.now()) + futureToleranceMs) {
        return reject("time_future", "That time is in the future. Paste the actual reported time.");
      }
      return { outcome: "accept", value: new Date(parsed).toISOString() };
    }
    default:
      break;
  }

  if (looksLikeShellCommand(answer)) {
    const message = kind === "prose"
      ? "That looks like a shell command, not an answer. Nothing runs here — describe it in words."
      : "That looks like a shell command, not a name. Answer with the name in words.";
    return reject("shell", message);
  }

  if (kind === "prose" && lowered === "keep" && (context.priorShellRejections ?? 0) >= 2) {
    // After repeated identical shell rejections the user may type `keep` to
    // record their exact text as words. The caller substitutes the last
    // rejected line; this sentinel value never reaches storage.
    return { outcome: "accept", value: "keep" };
  }

  if (looksLikePath(answer, kind)) {
    return reject("path",
      "That looks like a file path. Describe it in words instead — the answer must read as a sentence, not a location.");
  }

  if (kind === "name" || kind === "team" || kind === "role" || kind === "optional") {
    if (reservedVocabulary.has(lowered)) {
      const message = kind === "role"
        ? `"${answer}" is aibill's own vocabulary, not a role. Answer with your real job role, in words.${exampleSuffix}`
        : `That is aibill vocabulary, not a name. Answer in your own words.${exampleSuffix}`;
      return reject("reserved", message);
    }
    if (strictIsoPattern.test(answer)) {
      return reject("timestamp_shaped", `That is a time, not a name.${exampleSuffix}`);
    }
    if (byteLength(answer) > 192) {
      return reject("length", "That name is longer than aibill can store (192 bytes). Use a shorter form.");
    }
    return { outcome: "accept", value: answer.normalize("NFC") };
  }

  // prose
  if (answer.length > 1000) {
    return reject("length", "Keep it to one or two short sentences (under 1,000 characters).");
  }
  if (answer.split(/\s+/).filter(Boolean).length < 2 || isNonAnswer(lowered)) {
    return reject("substance",
      `That is not something aibill can hold you to later. Write what should actually happen — or type back or cancel if you are not ready.${exampleSuffix}`);
  }
  // NFC like the name fields: the rollback sentence is later re-typed and
  // compared by hash, so composition differences must not fail the match.
  return { outcome: "accept", value: answer.normalize("NFC") };
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
