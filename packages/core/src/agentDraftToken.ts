/**
 * The `ab1.` agent-draft token: how a conversationally drafted improve plan
 * travels from `draft_improve_command` (MCP, read-only) to `aibill improve
 * --draft` (terminal, human-approved) as ONE argv token.
 *
 * Design: AGENT_NATIVE_LOOP_DESIGN.md §2a (REV 2, QA-PASSED). The base64url
 * alphabet contains no shell metacharacter, quote, or whitespace, so the
 * token cannot break out of its argv slot in sh/bash/zsh/fish/pwsh and
 * cannot be mangled by smart quotes, wrapping, or locale. Decoding NEVER
 * throws — every failure is a tagged reason so a bad draft is set aside
 * with copy, not a crash.
 */

import { classifyGuidedAnswer } from "./guidedAnswer.js";
import { sanitizeLocalActivityText } from "./localAgentLogs.js";

/** `ab1` = aibill draft v1; `.` is outside base64url so the prefix is unambiguous. */
const TOKEN_PREFIX = "ab1.";
/**
 * AUTHORITATIVE bound (m11): the whole token is at most 20,000 characters,
 * which implies decoded JSON ≤ ~15,000 bytes. There is no separate
 * decoded-byte cap.
 */
export const MAX_AGENT_DRAFT_TOKEN_CHARS = 20_000;
const TOKEN_SHAPE = /^ab1\.[A-Za-z0-9_-]{16,}$/;
const EXPERIMENT_ID_SHAPE = /^tre_v0_[a-f0-9]{64}$/;
const REVISION_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** Single-line plain text: no C0/C1 controls (same refine the MCP schema uses). */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;
const MAX_SENTENCE_CHARS = 1_000;

const EXPECTED_KEYS = [
  "canary", "change", "experimentId", "revisionId", "rollback", "v"
] as const;

export type AgentDraftV1 = {
  v: 1;
  experimentId: string;
  revisionId: string;
  change: string;
  rollback: string;
  canary: string;
};

export type AgentDraftDecodeFailureReason =
  | "not_a_token"
  | "token_too_long"
  | "not_base64url_json"
  | "not_a_plain_object"
  | "unexpected_keys"
  | "unsupported_version"
  | "invalid_experiment_id"
  | "invalid_revision_id"
  | "invalid_sentence";

export type AgentDraftDecodeResult =
  | { ok: true; draft: AgentDraftV1 }
  | { ok: false; reason: AgentDraftDecodeFailureReason };

/** Cheap argv-time shape check shared with parseArgs (full decode comes later). */
export function looksLikeAgentDraftToken(value: string): boolean {
  return value.length <= MAX_AGENT_DRAFT_TOKEN_CHARS && TOKEN_SHAPE.test(value);
}

function validSentence(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_SENTENCE_CHARS &&
    !CONTROL_CHARACTERS.test(value);
}

/**
 * Decode and structurally validate an `ab1.` token. Hardening (m11, exact
 * spec): the payload must JSON.parse to a plain object; keys are compared
 * as a strict SET against the six expected keys (`Object.keys` DOES surface
 * `__proto__` as an own key after JSON.parse, so `__proto__`/`constructor`/
 * any extra key fails the set check); values are copied field-by-field onto
 * a fresh null-prototype object before any further use. JSON duplicate keys
 * are last-win in JSON.parse and undetectable post-parse: the decoded
 * object is declared authoritative, and every value still passes the
 * classifier gate afterwards.
 */
export function decodeAgentDraftTokenV1(token: string): AgentDraftDecodeResult {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "not_a_token" };
  }
  if (token.length > MAX_AGENT_DRAFT_TOKEN_CHARS) {
    return { ok: false, reason: "token_too_long" };
  }
  if (!TOKEN_SHAPE.test(token)) {
    return { ok: false, reason: "not_a_token" };
  }
  let parsed: unknown;
  try {
    const payload = Buffer.from(token.slice(TOKEN_PREFIX.length), "base64url");
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_base64url_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not_a_plain_object" };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== EXPECTED_KEYS.length ||
      keys.some((key, index) => key !== EXPECTED_KEYS[index])) {
    return { ok: false, reason: "unexpected_keys" };
  }
  // Field-by-field copy onto a null-prototype object; the parsed object is
  // never spread or merged into a prototyped object.
  const record = parsed as Record<string, unknown>;
  const draft: AgentDraftV1 = Object.assign(Object.create(null), {
    v: 1 as const,
    experimentId: "",
    revisionId: "",
    change: "",
    rollback: "",
    canary: ""
  });
  if (record.v !== 1) return { ok: false, reason: "unsupported_version" };
  if (typeof record.experimentId !== "string" ||
      !EXPERIMENT_ID_SHAPE.test(record.experimentId)) {
    return { ok: false, reason: "invalid_experiment_id" };
  }
  if (typeof record.revisionId !== "string" ||
      !REVISION_ID_SHAPE.test(record.revisionId)) {
    return { ok: false, reason: "invalid_revision_id" };
  }
  if (!validSentence(record.change) || !validSentence(record.rollback) ||
      !validSentence(record.canary)) {
    return { ok: false, reason: "invalid_sentence" };
  }
  draft.experimentId = record.experimentId;
  draft.revisionId = record.revisionId;
  draft.change = record.change;
  draft.rollback = record.rollback;
  draft.canary = record.canary;
  return { ok: true, draft };
}

export type AgentDraftEncodeResult =
  | { ok: true; token: string }
  | { ok: false; reason: AgentDraftDecodeFailureReason };

/**
 * Compose an `ab1.` token from validated fields. The only sanctioned caller
 * is `draft_improve_command`; encoding enforces the same structural rules as
 * decoding so a composing bug cannot emit an undecodable token.
 */
export function encodeAgentDraftTokenV1(
  draft: Omit<AgentDraftV1, "v">
): AgentDraftEncodeResult {
  if (!EXPERIMENT_ID_SHAPE.test(draft.experimentId)) {
    return { ok: false, reason: "invalid_experiment_id" };
  }
  if (!REVISION_ID_SHAPE.test(draft.revisionId)) {
    return { ok: false, reason: "invalid_revision_id" };
  }
  if (!validSentence(draft.change) || !validSentence(draft.rollback) ||
      !validSentence(draft.canary)) {
    return { ok: false, reason: "invalid_sentence" };
  }
  const payload = JSON.stringify({
    v: 1,
    experimentId: draft.experimentId,
    revisionId: draft.revisionId,
    change: draft.change,
    rollback: draft.rollback,
    canary: draft.canary
  });
  const token = TOKEN_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
  if (token.length > MAX_AGENT_DRAFT_TOKEN_CHARS) {
    return { ok: false, reason: "token_too_long" };
  }
  return { ok: true, token };
}

/* ------------------------------------------------------------------ */
/* Shared sentence screening (MCP composition + CLI Enter-accept)      */
/* ------------------------------------------------------------------ */

export type AgentDraftSentenceVerdict =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * The ONE screening path a drafted plan sentence takes, used verbatim by
 * `draft_improve_command` at composition and by `improve --draft` before a
 * prefill can render: sanitize exactly like typed input, then classify with
 * the shared hardened prose classifier. Because both surfaces call this
 * function, MCP-preview and CLI-gate verdicts cannot diverge (QA 12).
 *
 * Rejection reasons are the terminal's own reprompt copy; credential
 * rejections never echo the text.
 */
export function screenAgentDraftSentence(sentence: string): AgentDraftSentenceVerdict {
  // Sanitize FIRST (§2c): a credential-shaped fragment is dropped before it
  // can reach classification output, so no rejection reason can echo it. An
  // over-long sentence is rejected by the classifier's own length rule, with
  // its own copy — never silently truncated.
  const sanitized = sanitizeLocalActivityText(sentence).trim();
  const verdict = classifyGuidedAnswer("prose", sanitized);
  if (verdict.outcome === "accept") {
    // `keep` is a terminal-only escape hatch, meaningless in a draft.
    if (verdict.value === "keep") {
      return {
        ok: false,
        reason: "That is aibill's own reserved vocabulary, not a plan sentence."
      };
    }
    return { ok: true, value: verdict.value };
  }
  if (verdict.outcome === "reject") {
    return { ok: false, reason: verdict.message };
  }
  // navigate/skip: the sentence collided with reserved navigation words.
  return {
    ok: false,
    reason: "That is aibill's own navigation vocabulary (back/cancel), not a plan sentence."
  };
}
