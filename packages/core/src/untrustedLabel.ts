/**
 * ONE place that decides what an untrusted NAME is allowed to become before it
 * is interpolated into a sentence this product wrote.
 *
 * Why it exists at all. Every user-facing string here is built by templating a
 * fragment the user did not author — a folder name off disk, a model id off a
 * provider response, an operation label off an adapter — into prose that a
 * coding agent will later read as instructions. The renderers cannot be the
 * ones to make that safe:
 *
 *  - The `--full` terminal readout does not sanitize at all.
 *  - The Markdown/Apply sanitizers that BLANK on a directive hit delete the
 *    whole string, and the whole string is mostly OUR sentence. In 0.9.7 that
 *    deleted the entire recommendation for 8 of 11 ordinary repo basenames,
 *    because `write-ahead-log` sat 41 characters in front of our own word
 *    "tokens" — and the terminal kept printing the finding, so two surfaces
 *    disagreed about a dollar figure.
 *
 * So the check runs HERE, on the fragment alone, before it reaches any
 * template. A fragment carries only the user's text, so an ordinary name has
 * nothing of ours to pair with; and once the fragment is safe, every surface
 * can render the finished sentence verbatim and they all agree.
 *
 * The rule for anyone adding a producer: if you interpolate a value that came
 * off disk or off the wire into a string a user or an agent will read, wrap it
 * in {@link safeUntrustedLabel} at the point of interpolation. Not at the
 * renderer. Not once per surface. Here.
 */

/**
 * What an untrusted label becomes when the name itself reads like an
 * instruction. Each says WHY, because "withheld" with no reason reads like the
 * product failed rather than declined: `diagnose` still shows the real folder
 * name, so this is only about not REPEATING a name that looked like an
 * instruction inside a sentence an agent will read.
 *
 * Every one of these must survive the report layer's own sanitizer UNCHANGED —
 * a marker in brackets would be stripped there and two surfaces would disagree
 * about a string whose whole job is agreeing. Parentheses survive; brackets do
 * not.
 *
 * The project label sits in appositive and prepositional slots ("X — median day
 * carried…", "the heaviest sessions in X"), so it carries the reason as prose.
 * The rest sit in ATTRIBUTIVE slots ("Cache repeated X calls"), where a clause
 * would not parse, so they carry the short parenthetical form.
 */
export const WITHHELD_PROJECT_LABEL = "a project whose name reads like an instruction";
export const WITHHELD_MODEL_LABEL = "(model name reads like an instruction; withheld)";
export const WITHHELD_OPERATION_LABEL = "(operation name reads like an instruction; withheld)";
export const WITHHELD_AGENT_LABEL = "(agent name reads like an instruction; withheld)";
export const WITHHELD_CLIENT_LABEL = "(client name reads like an instruction; withheld)";
/**
 * For a breakdown key whose dimension is decided at runtime — the same slot
 * holds a client, a project, an agent, a model, or an operation depending on
 * which grouping won.
 */
export const WITHHELD_ENTITY_LABEL = "(name reads like an instruction; withheld)";
export const WITHHELD_FILE_LABEL = "(file name reads like an instruction; withheld)";
export const WITHHELD_PLAN_LABEL = "(plan label reads like an instruction; withheld)";

/** Map a list of untrusted keys for display, keeping order and length. */
export function safeUntrustedLabels(
  values: readonly string[],
  withheld: string = WITHHELD_ENTITY_LABEL
): string[] {
  return values.map((value) => safeUntrustedLabel(value, withheld));
}

/**
 * Neutralize ONE untrusted fragment before it is interpolated into
 * product-authored prose.
 *
 * Over-triggering here is cheap and under-triggering is not: a false positive
 * costs one name while the finding and its dollars survive, so the patterns
 * stay strict.
 */
export function safeUntrustedLabel(value: string, withheld: string): string {
  // Control characters and line breaks are structure, not name: a label that
  // can open a new line can forge a new instruction on every surface at once.
  const collapsed = value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!collapsed) return withheld;
  return looksLikeDirectiveFragment(collapsed) ? withheld : collapsed;
}

/**
 * Characters that are invisible to the reader but split a word for the
 * matcher: zero-width spaces and joiners, bidi controls, variation selectors,
 * the soft hyphen, the BOM. `i\u200Bgnore all previous instructions` reads as
 * an instruction and matched nothing. Stripped for DETECTION ONLY — the label
 * that gets printed is always the original text.
 */
const INVISIBLE_SEPARATORS = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/gu;

/**
 * The eight Latin/Cyrillic confusables that carry the directive verbs we look
 * for: `\u0456gnore`, `d\u0435lete`, `\u0455ystem:` are indistinguishable on screen
 * and invisible to an ASCII pattern. Folded for DETECTION ONLY.
 */
const CONFUSABLE_FOLD: ReadonlyMap<string, string> = new Map([
  ["\u0430", "a"], ["\u0435", "e"], ["\u043E", "o"], ["\u0440", "p"],
  ["\u0441", "c"], ["\u0445", "x"], ["\u0455", "s"], ["\u0456", "i"]
]);

/**
 * The fragment is read TWICE, because a name and an instruction disagree about
 * what a hyphen means.
 *
 * As ONE IDENTIFIER (`-` behaves like `_`): `ignore-list` is a directory, so
 * the blunt single-word patterns cannot fire on it. This is what keeps ordinary
 * repo names whole.
 *
 * As SEPARATED WORDS (`-` and `_` are spaces): `ignore-all-previous-instructions`
 * is an instruction wearing a filename's punctuation. Only the PAIRED patterns
 * run in this pass — each needs a directive verb next to an injection-flavored
 * object — so an ordinary compound name has nothing to pair with. The unpaired
 * verb list and the execute/run pattern deliberately stay out: `run-command-service`
 * is a real directory, and a name-shaped `run-shell` cannot instruct anything.
 */
function looksLikeDirectiveFragment(value: string): boolean {
  const folded = value
    .normalize("NFKC")
    .replace(INVISIBLE_SEPARATORS, "")
    .replace(/[\u0430\u0435\u043E\u0440\u0441\u0445\u0455\u0456]/gu, (char) => CONFUSABLE_FOLD.get(char) ?? char);
  const asIdentifier = folded.replace(/-/gu, "_");
  const asWords = folded.replace(/[-_]+/gu, " ");
  return IDENTIFIER_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(asIdentifier)) ||
    SEPARATED_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(asWords));
}

const IDENTIFIER_DIRECTIVE_PATTERNS = [
  /\b(?:ignore|disregard|override|bypass)\b/i,
  /\b(?:system|developer|assistant)\s*:/i,
  /\b(?:execute|run)\b.{0,80}\b(?:command|shell|bash|powershell)\b/i,
  /\b(?:delete|remove|overwrite|edit|write)\b.{0,60}\b(?:everything|all files?|configs?|credentials?|secrets?|tokens?)\b/i,
  /\b(?:reveal|print|upload|send|exfiltrate)\b.{0,60}\b(?:credentials?|secrets?|tokens?|keys?|files?)\b/i,
  /\b(?:do not|don't)\b.{0,60}\b(?:follow|obey|wait|ask|require)\b.{0,40}\b(?:approval|instructions?|rules?)\b/i
];

const SEPARATED_DIRECTIVE_PATTERNS = [
  /\b(?:ignore|disregard|override|bypass|forget)\b.{0,80}\b(?:previous|prior|above|earlier|preceding|instructions?|approval|rules?|guardrails?|system|developer|prompts?)\b/i,
  /\b(?:delete|remove|overwrite|edit|write)\b.{0,60}\b(?:everything|all files?|configs?|credentials?|secrets?|tokens?)\b/i,
  /\b(?:reveal|print|upload|send|exfiltrate|leak|dump)\b.{0,60}\b(?:credentials?|secrets?|tokens?|keys?|files?|prompts?)\b/i,
  /\b(?:do not|don't|never)\b.{0,60}\b(?:follow|obey|wait|ask|require)\b.{0,40}\b(?:approval|instructions?|rules?)\b/i
];
