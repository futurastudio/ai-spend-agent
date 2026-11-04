import { z } from "zod";

/**
 * `.aibill/policy.json`: the committed, per-repository policy for coding
 * agents that `aibill guard` installs into Claude Code project settings and
 * enforces from the local transcripts. One file per checkout; never per
 * person. Version 1 is strict: a misspelled key is refused rather than
 * silently ignored, because a policy that reads "enforced" while a typo
 * disabled it is worse than no policy.
 */
export const AIBILL_POLICY_VERSION = 1;
export const AIBILL_POLICY_RELATIVE_PATH = ".aibill/policy.json";
export const AIBILL_POLICY_MESSAGE_MAX_LENGTH = 240;
export const AIBILL_POLICY_MODEL_LIST_MAX = 64;

/**
 * Model aliases and ids as Claude Code accepts them in `availableModels` /
 * `deniedModels`: `sonnet`, `claude-opus-5-5`, dated ids, provider-prefixed
 * ids such as `us.anthropic.claude-...`, and the `[1m]` context suffix.
 */
const MODEL_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

const modelEntrySchema = z.string().regex(
  MODEL_ENTRY_PATTERN,
  "a model entry is an alias or id such as sonnet or claude-opus-5-5 (letters, digits, . _ : [ ] -)"
);

const modelListSchema = z.array(modelEntrySchema)
  .min(1, "list at least one model or omit the key")
  .max(AIBILL_POLICY_MODEL_LIST_MAX, `at most ${AIBILL_POLICY_MODEL_LIST_MAX} models`);

const positiveCountSchema = z.number()
  .int("must be a whole number")
  .positive("must be greater than zero")
  .max(Number.MAX_SAFE_INTEGER);

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

const messageSchema = z.string()
  .max(AIBILL_POLICY_MESSAGE_MAX_LENGTH, `at most ${AIBILL_POLICY_MESSAGE_MAX_LENGTH} characters`)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !hasControlCharacters(value), "must not contain control characters");

export const aibillPolicySchema = z.object({
  version: z.literal(AIBILL_POLICY_VERSION),
  models: z.object({
    /** Written to Claude Code `availableModels` (project settings or managed). */
    allow: modelListSchema.optional(),
    /** Written to `deniedModels`, a managed-only key; reported at project scope. */
    deny: modelListSchema.optional()
  }).strict().optional(),
  budget: z.object({
    perDay: z.object({
      /** Distinct Claude Code sessions with a call in the repository, per UTC day. */
      sessions: positiveCountSchema.optional(),
      /**
       * Every token component of those sessions per UTC day: input, output,
       * cache read and cache write. Cache reads dominate, so a busy repository
       * measures hundreds of millions a day; run `aibill guard status` first.
       */
      tokens: positiveCountSchema.optional(),
      /** Output tokens only, per UTC day: a few million for a busy repository. */
      outputTokens: positiveCountSchema.optional()
    }).strict().optional()
  }).strict().optional(),
  /** Shown first when the guard blocks. */
  message: messageSchema.optional(),
  /**
   * Also run the hook before every tool call (about a tenth of a second
   * each). Off by default: the prompt-time hook alone bounds a session's
   * budget at every turn boundary.
   */
  perToolCall: z.boolean().optional(),
  /** Codex policy is reported, not enforced, in this version. */
  codex: z.object({
    model: modelEntrySchema.optional()
  }).strict().optional()
}).strict();

export type AibillPolicy = z.infer<typeof aibillPolicySchema>;

export type AibillPolicyIssue = { path: string; message: string };

export type AibillPolicyParseResult =
  | { ok: true; policy: AibillPolicy }
  | { ok: false; issues: AibillPolicyIssue[] };

const POLICY_MAX_BYTES = 64 * 1_024;

/** Parse the text of `.aibill/policy.json`. Never throws. */
export function parseAibillPolicy(text: string): AibillPolicyParseResult {
  if (Buffer.byteLength(text, "utf8") > POLICY_MAX_BYTES) {
    return { ok: false, issues: [{ path: "", message: `the policy file is larger than ${POLICY_MAX_BYTES} bytes` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "", message: `not valid JSON (${error instanceof Error ? error.message : String(error)})` }]
    };
  }
  return validateAibillPolicy(value);
}

/** Validate an already-parsed policy object. Never throws. */
export function validateAibillPolicy(value: unknown): AibillPolicyParseResult {
  const parsed = aibillPolicySchema.safeParse(value);
  if (parsed.success) return { ok: true, policy: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join("."),
      message: issue.code === "unrecognized_keys"
        ? `unknown key${issue.keys.length === 1 ? "" : "s"} ${issue.keys.join(", ")}`
        : issue.message
    }))
  };
}

/** The budget dimensions the hook can evaluate. */
export const AIBILL_POLICY_BUDGET_DIMENSIONS = ["tokens", "outputTokens", "sessions"] as const;
export type AibillPolicyBudgetDimension = typeof AIBILL_POLICY_BUDGET_DIMENSIONS[number];

/** Whether the policy carries a daily budget the guard can enforce. */
export function aibillPolicyHasBudget(policy: AibillPolicy): boolean {
  const perDay = policy.budget?.perDay;
  return perDay !== undefined && AIBILL_POLICY_BUDGET_DIMENSIONS.some((dimension) => perDay[dimension] !== undefined);
}

/**
 * Whether a model id falls under a policy entry, following the documented
 * Claude Code matching: an exact id, a family alias such as `opus` (matched as
 * a whole token of the id), or an id prefix such as `claude-opus-5` that also
 * covers later minor versions and dated spellings. Case-insensitive.
 */
export function modelMatchesPolicyEntry(model: string, entry: string): boolean {
  const candidate = model.trim().toLowerCase();
  const rule = entry.trim().toLowerCase();
  if (!candidate || !rule) return false;
  if (candidate === rule) return true;
  if (candidate.startsWith(`${rule}-`) || candidate.startsWith(`${rule}[`)) return true;
  if (/^[a-z]+$/.test(rule)) {
    return candidate.split(/[^a-z0-9]+/).includes(rule);
  }
  return false;
}

/** The first entry of a list that covers the model, if any. */
export function findMatchingPolicyModel(model: string, entries: readonly string[] | undefined): string | undefined {
  return entries?.find((entry) => modelMatchesPolicyEntry(model, entry));
}
