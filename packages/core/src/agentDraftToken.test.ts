import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  decodeAgentDraftTokenV1,
  encodeAgentDraftTokenV1,
  looksLikeAgentDraftToken,
  MAX_AGENT_DRAFT_TOKEN_CHARS,
  screenAgentDraftSentence
} from "./agentDraftToken.js";

const execFileAsync = promisify(execFile);

const validExperimentId = `tre_v0_${"1f2a9c3d".repeat(8)}`;
const validDraft = {
  experimentId: validExperimentId,
  revisionId: "r3",
  change: "Start the next task with only its required files and instructions.",
  rollback: "Restore the prior session workflow.",
  canary: "The project tests pass and the requested output is accepted."
};

function tokenFor(payload: unknown): string {
  return `ab1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

describe("agent draft token codec", () => {
  it("round-trips the canonical draft", () => {
    const encoded = encodeAgentDraftTokenV1(validDraft);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.token).toMatch(/^ab1\.[A-Za-z0-9_-]+$/);
    const decoded = decodeAgentDraftTokenV1(encoded.token);
    expect(decoded).toEqual({ ok: true, draft: { v: 1, ...validDraft } });
  });

  it("round-trips José-class non-ASCII and NFD input without mangling (QA 21)", () => {
    const draft = {
      ...validDraft,
      change: "José starts the next task with only the files it needs \u{1F680}.",
      rollback: "Restaurar el flujo de sesión anterior de José."
    };
    const encoded = encodeAgentDraftTokenV1(draft);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeAgentDraftTokenV1(encoded.token);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // Byte-exact round-trip; NFC happens at classification, like typed input.
    expect(decoded.draft.change).toBe(draft.change);
    expect(decoded.draft.rollback).toBe(draft.rollback);
    const screened = screenAgentDraftSentence(decoded.draft.rollback);
    expect(screened.ok).toBe(true);
    if (!screened.ok) return;
    expect(screened.value).toBe(draft.rollback.normalize("NFC"));
  });

  it("emits only the base64url alphabet — no shell metacharacters ever (QA 2 charset leg)", () => {
    const nasty = {
      ...validDraft,
      change: `Use "quotes" & $HOME | backticks \`x\` ; and 'single' <>()!*?~^%#=+, fine.`
    };
    const encoded = encodeAgentDraftTokenV1(nasty);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.token).toMatch(/^ab1\.[A-Za-z0-9_-]+$/);
    expect(encoded.token).not.toMatch(/["'`$;&|\s<>\\]/);
  });

  it("survives an sh -c argv round-trip byte-identically (QA 2 shell leg)", async () => {
    const encoded = encodeAgentDraftTokenV1(validDraft);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { stdout } = await execFileAsync(
      "sh",
      ["-c", 'printf %s "$1"', "_", encoded.token]
    );
    expect(stdout).toBe(encoded.token);
  });

  it("rejects tokens with charset violations as not_a_token (QA 3)", () => {
    for (const bad of [
      "ab1.abc.def0123456789",
      "ab1.abcd+efgh0123456789",
      "ab1.abcd=efgh0123456789",
      "ab1.abcd efgh0123456789",
      'ab1.abcd"efgh0123456789',
      "ab2.abcdefgh0123456789",
      "abcdefgh0123456789"
    ]) {
      const decoded = decodeAgentDraftTokenV1(bad);
      expect(decoded.ok).toBe(false);
    }
  });

  it("rejects an oversized token without decoding it (QA 4)", () => {
    const oversized = `ab1.${"A".repeat(MAX_AGENT_DRAFT_TOKEN_CHARS)}`;
    expect(oversized.length).toBeGreaterThan(MAX_AGENT_DRAFT_TOKEN_CHARS);
    expect(decodeAgentDraftTokenV1(oversized)).toEqual({
      ok: false,
      reason: "token_too_long"
    });
    expect(looksLikeAgentDraftToken(oversized)).toBe(false);
  });

  it("rejects a 1001-char sentence at decode (QA 4)", () => {
    const decoded = decodeAgentDraftTokenV1(tokenFor({
      v: 1,
      ...validDraft,
      change: "long word ".repeat(101)
    }));
    expect(decoded).toEqual({ ok: false, reason: "invalid_sentence" });
  });

  it("rejects non-object payloads (QA 19)", () => {
    for (const payload of ["42", "[]", "null", '"text"'] as const) {
      const token = `ab1.${Buffer.from(payload, "utf8").toString("base64url").padEnd(16, "A")}`;
      const decoded = decodeAgentDraftTokenV1(token);
      expect(decoded.ok).toBe(false);
    }
  });

  it("rejects __proto__/constructor/extra/missing keys; no pollution observable (QA 19)", () => {
    const protoToken = `ab1.${Buffer.from(
      `{"v":1,"experimentId":"${validExperimentId}","revisionId":"r3",` +
      `"change":"a b","rollback":"a b","canary":"a b","__proto__":{"polluted":true}}`,
      "utf8"
    ).toString("base64url")}`;
    expect(decodeAgentDraftTokenV1(protoToken)).toEqual({
      ok: false,
      reason: "unexpected_keys"
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const constructorToken = tokenFor({
      v: 1, ...validDraft, constructor: { prototype: {} }
    });
    expect(decodeAgentDraftTokenV1(constructorToken)).toEqual({
      ok: false,
      reason: "unexpected_keys"
    });

    const extra = tokenFor({ v: 1, ...validDraft, extra: "x" });
    expect(decodeAgentDraftTokenV1(extra)).toEqual({
      ok: false,
      reason: "unexpected_keys"
    });

    const { canary: _dropped, ...missingCanary } = validDraft;
    expect(decodeAgentDraftTokenV1(tokenFor({ v: 1, ...missingCanary })).ok).toBe(false);
  });

  it("treats JSON duplicate keys as last-win and still classifier-gates the value (QA 19)", () => {
    const duplicate = `ab1.${Buffer.from(
      `{"v":1,"experimentId":"${validExperimentId}","revisionId":"r3",` +
      `"change":"first version","change":"second version wins",` +
      `"rollback":"Restore the prior flow.","canary":"Tests pass and output accepted."}`,
      "utf8"
    ).toString("base64url")}`;
    const decoded = decodeAgentDraftTokenV1(duplicate);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.draft.change).toBe("second version wins");
    expect(screenAgentDraftSentence(decoded.draft.change).ok).toBe(true);
  });

  it("rejects wrong version, malformed ids, and control characters", () => {
    expect(decodeAgentDraftTokenV1(tokenFor({ v: 2, ...validDraft }))).toEqual({
      ok: false, reason: "unsupported_version"
    });
    expect(decodeAgentDraftTokenV1(tokenFor({
      v: 1, ...validDraft, experimentId: "tre_v0_1f2a9c3d..."
    }))).toEqual({ ok: false, reason: "invalid_experiment_id" });
    expect(decodeAgentDraftTokenV1(tokenFor({
      v: 1, ...validDraft, revisionId: "bad revision!"
    }))).toEqual({ ok: false, reason: "invalid_revision_id" });
    expect(decodeAgentDraftTokenV1(tokenFor({
      v: 1, ...validDraft, change: "line one\nline two"
    }))).toEqual({ ok: false, reason: "invalid_sentence" });
  });

  it("never throws on fuzzed garbage", () => {
    const samples = [
      "", "ab1.", "ab1", `ab1.${"_".repeat(15)}`,
      `ab1.${Buffer.from("{", "utf8").toString("base64url").padEnd(16, "A")}`,
      `ab1.${"-".repeat(40)}`,
      tokenFor({ v: 1 }),
      tokenFor([1, 2, 3])
    ];
    for (const sample of samples) {
      expect(() => decodeAgentDraftTokenV1(sample)).not.toThrow();
      expect(decodeAgentDraftTokenV1(sample).ok).toBe(false);
    }
  });
});

describe("screenAgentDraftSentence", () => {
  it("accepts plain prose and NFC-normalizes it", () => {
    const verdict = screenAgentDraftSentence("Restore the prior session workflow.");
    expect(verdict).toEqual({ ok: true, value: "Restore the prior session workflow." });
  });

  it("rejects navigation and reserved vocabulary with product copy", () => {
    for (const word of ["back", "cancel", "keep"]) {
      const verdict = screenAgentDraftSentence(word);
      expect(verdict.ok).toBe(false);
    }
  });

  it("never echoes a credential in its rejection reason (QA 6)", () => {
    const secret = "sk-ant-abcdefghijklmnop1234";
    const verdict = screenAgentDraftSentence(`Use the key ${secret} for the canary.`);
    if (!verdict.ok) {
      expect(verdict.reason).not.toContain(secret);
    } else {
      // Sanitizer stripped the secret before classification: the surviving
      // value must not carry it either.
      expect(verdict.value).not.toContain(secret);
    }
  });
});
