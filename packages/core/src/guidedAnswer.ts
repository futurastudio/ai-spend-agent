/**
 * Shared guided-answer classifier for the aibill improve/identify flows.
 *
 * One function, three consumers: the CLI terminal prompts (typed input and
 * Enter-kept prefills), the CLI agent-draft screening lane, and the MCP
 * `draft_improve_command` preview. Keeping a single pure module in core is
 * what makes the "same classifier at composition and at Enter-accept"
 * invariant true by construction rather than by parity discipline.
 *
 * Design: P0B_FLOW_DESIGN.md §2/§3b/§3c and AGENT_NATIVE_LOOP_DESIGN.md §2f
 * (moved here from packages/cli/src/guidedPrompt.ts, verbatim; the path and
 * credential predicates moved with it from projectAccountabilityState.ts so
 * the floor relationship can never drift).
 */

/* ------------------------------------------------------------------ */
/* Floor predicates (accountability backstop)                          */
/* ------------------------------------------------------------------ */

/**
 * Exported as the classification FLOOR for the guided-prompt engine: the
 * per-prompt classifier must reject at least everything these predicates
 * reject, so `parseDisplayLabel` can never abort on an answer the prompt
 * already accepted (the Aug 17 incident class).
 */
export function isPathLike(value: string): boolean {
  return /^(?:~?[\\/]|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u.test(value) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || value.includes("\\");
}

export function isCredentialLike(value: string): boolean {
  return /(?:sk-(?:ant-|proj-)?|sk_|gh[pousr]_|github_pat_|npm_|AIza|xox[baprs]-|glpat-|AKIA)[A-Za-z0-9_-]{8,}/i
      .test(value) ||
    /(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password)\s*[:=]\s*\S+/i
      .test(value);
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

/**
 * §2f rule 2 (AGENT_NATIVE_LOOP_DESIGN.md): a pipe straight into an
 * interpreter, spaced or not — `|sh`, `curl …|bash`, `|python3 -c …`.
 */
const pipeToInterpreterPattern =
  /\|\s*(?:sh|bash|zsh|fish|dash|node|python3?|perl|ruby|pwsh)\b/i;

/** §2f rule 4: free-standing multi-letter short flag (` -rf`), corroboration only. */
const multiLetterShortFlagPattern = /(?:^|\s)-[A-Za-z]{2,}(?=\s|$)/;

function looksLikeShellCommand(answer: string): boolean {
  if (/^[$%#>] ?/.test(answer)) return true;
  if (/&&|\|\||`|\$\(|>>|<<|2>&1| \| | > | < /.test(answer)) return true;
  if (pipeToInterpreterPattern.test(answer)) return true;
  if (/(?:^|\s)--[A-Za-z][\w-]*/.test(answer)) return true;
  if (/(?:^|\s)-[A-Za-z](?=\s|$)/.test(answer)) return true;
  // PowerShell Verb-Noun cmdlet shape (Get-ChildItem, Remove-Item …).
  if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+(?:\s|$)/.test(answer)) return true;
  // §2f rule 1: strip any leading run of whitespace/quote/chain sigils
  // before first-token analysis (covers `"; rm …`, `'; …`, `| sh`, `& …`
  // fragments). If the strip removed a `;`, `|`, or `&`, the text STARTS
  // like a command chain — that is a reject on its own. A plain leading
  // quotation mark followed by words strips harmlessly and never rejects.
  const leadingSigils = /^[\s"'`;|&]+/.exec(answer)?.[0] ?? "";
  if (/[;|&]/.test(leadingSigils)) return true;
  const body = answer.slice(leadingSigils.length);
  const tokens = stripEnvPrefixes(body.split(/\s+/).filter(Boolean));
  // Second signals, shared by first-token ambiguity and §2f rule 3: a
  // path-like token, a file extension, or a multi-letter short flag
  // (`rm -rf …` — rule 4; needs whitespace before the `-`, so hyphenated
  // words like `well-known` or `re-use` can never match).
  const hasPathToken = tokens.some((token) =>
    /^(?:\/|\.\/|\.\.\/|~\/)/.test(token) || token.includes("/"));
  const hasExtension = pathExtensionPattern.test(body);
  const hasShortFlag = multiLetterShortFlagPattern.test(body);
  const first = stripQuotes(tokens[0] ?? "").toLowerCase();
  if (unambiguousBinaries.has(first)) return true;
  if (ambiguousVerbs.has(first)) {
    // Ambiguous English verbs reject only with a second signal: a path-like
    // token, a file extension, a corroborating flag, or a terse
    // all-lowercase fragment that reads like a command line, not a sentence.
    const terseLowercase = tokens.length <= 2 && body === body.toLowerCase();
    if (hasPathToken || hasExtension || hasShortFlag || terseLowercase) return true;
  }
  // §2f rule 3: `;` chained command starts. A `;` followed by an unambiguous
  // binary rejects outright; followed by an ambiguous verb it rejects only
  // with a second signal — English semicolons ("…workflow; keep the earlier
  // settings", "…change; go back to the prior flow") survive.
  for (const chained of body.matchAll(/;\s*([^\s;|&]+)/g)) {
    const chainedFirst = stripQuotes(chained[1]!).toLowerCase();
    if (unambiguousBinaries.has(chainedFirst)) return true;
    if (ambiguousVerbs.has(chainedFirst) &&
        (hasPathToken || hasExtension || hasShortFlag)) {
      return true;
    }
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
