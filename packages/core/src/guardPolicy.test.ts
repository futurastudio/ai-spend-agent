import { describe, expect, it } from "vitest";
import {
  AIBILL_POLICY_MESSAGE_MAX_LENGTH,
  aibillPolicyHasBudget,
  findMatchingPolicyModel,
  modelMatchesPolicyEntry,
  parseAibillPolicy,
  validateAibillPolicy
} from "./guardPolicy.js";

const validPolicy = {
  version: 1 as const,
  models: { allow: ["sonnet", "haiku"], deny: ["claude-opus-5-5"] },
  budget: { perDay: { sessions: 20, tokens: 400_000_000, outputTokens: 4_000_000 } },
  message: "Daily agent budget for this repository is spent. Ask in #platform for an exception.",
  perToolCall: true,
  codex: { model: "gpt-5.6" }
};

function issuesOf(value: unknown): string[] {
  const result = validateAibillPolicy(value);
  if (result.ok) throw new Error("expected the policy to be refused");
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe("aibill policy schema", () => {
  it("accepts the documented shape and keeps every field", () => {
    const result = parseAibillPolicy(JSON.stringify(validPolicy));
    expect(result).toEqual({ ok: true, policy: validPolicy });
    expect(aibillPolicyHasBudget(validPolicy)).toBe(true);
  });

  it("accepts a minimal policy and reports that it carries no budget", () => {
    const result = validateAibillPolicy({ version: 1 });
    expect(result.ok).toBe(true);
    expect(aibillPolicyHasBudget({ version: 1 })).toBe(false);
    expect(aibillPolicyHasBudget({ version: 1, budget: { perDay: {} } })).toBe(false);
    expect(aibillPolicyHasBudget({ version: 1, budget: { perDay: { outputTokens: 5 } } })).toBe(true);
    expect(validateAibillPolicy({ version: 1, perToolCall: "yes" }).ok).toBe(false);
  });

  it("refuses an unknown version and unknown keys instead of ignoring them", () => {
    expect(issuesOf({ ...validPolicy, version: 2 })).toEqual([
      expect.stringContaining("version:")
    ]);
    expect(issuesOf({ ...validPolicy, budgets: {} })).toEqual([": unknown key budgets"]);
    expect(issuesOf({ version: 1, budget: { perDay: { token: 5 } } })).toEqual([
      "budget.perDay: unknown key token"
    ]);
    expect(issuesOf({ version: 1, models: { allowed: ["sonnet"] } })).toEqual([
      "models: unknown key allowed"
    ]);
  });

  it("refuses budgets that are not positive whole numbers", () => {
    expect(issuesOf({ version: 1, budget: { perDay: { tokens: 0 } } })[0]).toContain("budget.perDay.tokens");
    expect(issuesOf({ version: 1, budget: { perDay: { sessions: -3 } } })[0]).toContain("budget.perDay.sessions");
    expect(issuesOf({ version: 1, budget: { perDay: { tokens: 1.5 } } })[0]).toContain("whole number");
    expect(issuesOf({ version: 1, budget: { perDay: { tokens: "1M" } } })[0]).toContain("budget.perDay.tokens");
    expect(issuesOf({ version: 1, budget: { perDay: { outputTokens: 0 } } })[0]).toContain("budget.perDay.outputTokens");
  });

  it("refuses model entries that are not aliases or ids, and empty lists", () => {
    expect(issuesOf({ version: 1, models: { allow: [] } })[0]).toContain("models.allow");
    expect(issuesOf({ version: 1, models: { allow: ["sonnet; rm -rf"] } })[0]).toContain("models.allow.0");
    expect(issuesOf({ version: 1, models: { deny: [""] } })[0]).toContain("models.deny.0");
    expect(validateAibillPolicy({
      version: 1,
      models: { allow: ["us.anthropic.claude-sonnet-5-v1:0", "claude-sonnet-5[1m]", "opus"] }
    }).ok).toBe(true);
  });

  it("bounds the blocked message and refuses control characters", () => {
    expect(issuesOf({ version: 1, message: "x".repeat(AIBILL_POLICY_MESSAGE_MAX_LENGTH + 1) })[0])
      .toContain(`at most ${AIBILL_POLICY_MESSAGE_MAX_LENGTH} characters`);
    expect(issuesOf({ version: 1, message: "stop\u001b[31m now" })[0]).toContain("control characters");
    expect(issuesOf({ version: 1, message: "two\nlines" })[0]).toContain("control characters");
    expect(issuesOf({ version: 1, message: "   " })[0]).toContain("must not be blank");
    expect(validateAibillPolicy({ version: 1, message: "x".repeat(AIBILL_POLICY_MESSAGE_MAX_LENGTH) }).ok).toBe(true);
  });

  it("refuses text that is not a JSON object", () => {
    expect(parseAibillPolicy("{ not json")).toMatchObject({ ok: false });
    expect(parseAibillPolicy("[1]")).toMatchObject({ ok: false });
    expect(parseAibillPolicy("null")).toMatchObject({ ok: false });
    expect(parseAibillPolicy(`{"version":1,"message":"${"y".repeat(70_000)}"}`)).toMatchObject({
      ok: false,
      issues: [{ message: expect.stringContaining("larger than") }]
    });
  });
});

describe("model matching", () => {
  it("matches exact ids, family aliases and id prefixes the way Claude Code documents", () => {
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(modelMatchesPolicyEntry("claude-opus-5-5-20261001", "claude-opus-5-5")).toBe(true);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "claude-opus-5")).toBe(true);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "opus")).toBe(true);
    expect(modelMatchesPolicyEntry("us.anthropic.claude-opus-5-5-v1:0", "opus")).toBe(true);
    expect(modelMatchesPolicyEntry("claude-sonnet-5[1m]", "claude-sonnet-5")).toBe(true);
    expect(modelMatchesPolicyEntry("Claude-Opus-5-5", "claude-opus-5-5")).toBe(true);
  });

  it("does not match a different family, a longer alias, or blank input", () => {
    expect(modelMatchesPolicyEntry("claude-sonnet-5", "opus")).toBe(false);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "claude-opus-5-0")).toBe(false);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "claude-opus-5-5-20261001")).toBe(false);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "opusplan")).toBe(false);
    expect(modelMatchesPolicyEntry("", "opus")).toBe(false);
    expect(modelMatchesPolicyEntry("claude-opus-5-5", "")).toBe(false);
  });

  it("returns the first covering entry of a list", () => {
    expect(findMatchingPolicyModel("claude-opus-5-5", ["sonnet", "opus", "claude-opus-5"])).toBe("opus");
    expect(findMatchingPolicyModel("claude-haiku-5-5", ["sonnet", "opus"])).toBeUndefined();
    expect(findMatchingPolicyModel("claude-haiku-5-5", undefined)).toBeUndefined();
  });
});
