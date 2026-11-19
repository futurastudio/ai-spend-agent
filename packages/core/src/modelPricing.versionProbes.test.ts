import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { estimateTokenCostUsd, findPricingRule } from "./modelPricing.js";

/**
 * No rule may price a model version nobody reviewed.
 *
 * A rule written as a family prefix prices every later version of the family at
 * the rates of the version it was written for. That is silent: the estimate
 * looks like any other. It happened three times by 2026-11-15. `^claude-fable-5`
 * priced Claude Fable 5.2 at Claude Fable 5's rates, `^grok-4` priced every Grok
 * 4.x model at the rates of a model xAI no longer lists, and `^kimi-k3` priced
 * kimi-k3.1-pro at Kimi K3's.
 *
 * So for every model the retained evidence names and the table prices, this builds the versions
 * next to it (the next minor, a first minor where it has none, the next major)
 * and requires each one to be either an ID the evidence also names, or unpriced.
 * A later version then shows as missing, which a person sees and fixes, never as
 * a wrong price.
 *
 * A rule that takes any text after an ID it names is a second way in. Those that
 * remain are listed below with why, and the list has to match the table exactly,
 * so a new one cannot be added without saying so here.
 */
const evidenceDir = new URL("../../../provider-contracts/", import.meta.url);
const named = new Set<string>();
for (const file of readdirSync(evidenceDir).filter((name) => /^model-pricing-\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
  const evidence = JSON.parse(readFileSync(new URL(file, evidenceDir), "utf8")) as Record<string, unknown>;
  for (const key of ["models", "modelPageRows", "stillOnThisPage", "anthropicModelTable", "notPricedOnPurpose"]) {
    for (const row of (evidence[key] as { id?: unknown }[] | undefined) ?? []) {
      if (typeof row?.id === "string") named.add(row.id.toLowerCase());
    }
  }
  for (const id of (evidence.namedIds as string[] | undefined) ?? []) named.add(id.toLowerCase());
}
const namedIds = [...named].sort();

/**
 * The versions next to an ID's own. "claude-fable-5-2" gives claude-fable-5-3 and
 * claude-fable-6; "gpt-5.6-sol" gives gpt-5.7-sol and gpt-6-sol; "claude-opus-5"
 * gives claude-opus-5-1 and claude-opus-6. A date after the version stays where
 * it is: eight digits, or more than two, are never read as a minor version.
 */
function laterVersions(named: string): string[] {
  // A later version carries its own date, so the date of this one is left off first.
  const id = named.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  const parts = id.match(/^([^0-9]*)(\d+)(?:([.-])(\d{1,2})(?!\d))?(.*)$/);
  if (!parts) return [];
  const [, family, major, separator, minor, rest] = parts;
  const nextMajor = `${family}${Number(major) + 1}${rest}`;
  if (minor !== undefined) return [`${family}${major}${separator}${Number(minor) + 1}${rest}`, nextMajor];
  // "gpt-4o" is one name, not version 4 with a suffix: no first minor is put inside it.
  if (/^[a-z]/.test(rest)) return [nextMajor];
  return [`${family}${major}${id.startsWith("claude-") ? "-" : "."}1${rest}`, nextMajor];
}

/**
 * Rules that still take any text after an ID they name, each for a reason. They
 * price variants and dated snapshots of one version, never a later version: the
 * version is inside the part they anchor. The key is an ID the evidence names.
 */
const TAKES_ANY_SUFFIX: Record<string, string> = {
  "gpt-4.1": "OpenAI's dated snapshots (gpt-4.1-2025-04-14) bill at the alias's rates",
  "gpt-4.1-2025-04-14": "the same rule, reached through its dated snapshot",
  "gpt-4.1-mini": "dated snapshots of the same model",
  "gpt-4.1-mini-2025-04-14": "the same rule, reached through its dated snapshot",
  "gpt-4.1-nano": "dated snapshots of the same model",
  "gpt-4.1-nano-2025-04-14": "the same rule, reached through its dated snapshot",
  "gpt-5-nano": "dated snapshots of the same model",
  "gpt-5-nano-2025-08-07": "the same rule, reached through its dated snapshot",
  "gpt-5-pro": "dated snapshots of the same model",
  "gpt-5-pro-2025-10-06": "the same rule, reached through its dated snapshot",
  "gpt-5.2-pro": "dated snapshots of the same model",
  "gpt-5.2-pro-2025-12-11": "the same rule, reached through its dated snapshot",
  "gpt-5.3-codex": "dated snapshots of the same model",
  "gpt-5.4-mini": "dated snapshots of the same model",
  "gpt-5.4-mini-2026-03-17": "the same rule, reached through its dated snapshot",
  "gpt-5.4-nano": "dated snapshots of the same model",
  "gpt-5.4-nano-2026-03-17": "the same rule, reached through its dated snapshot",
  "kimi-k2": "the retired K2 family names its variants after a hyphen (kimi-k2-instruct)",
  "kimi-k2-instruct": "the same rule, reached through a variant",
  "claude-3-5-haiku": "a retired family, known by dated IDs and a -latest alias",
  "claude-3-5-sonnet": "a retired family, known by dated IDs and a -latest alias",
  "claude-3-7-sonnet": "a retired family, known by dated IDs and a -latest alias"
};

describe("a model version no review named is never priced", () => {
  it("reads the evidence: an empty list must not pass this check", () => {
    expect(namedIds.length).toBeGreaterThan(80);
    for (const id of ["claude-fable-5-2", "gpt-5.6-sol", "gemini-4-argon", "grok-4.7", "kimi-k3.1-pro"]) expect(namedIds).toContain(id);
  });

  it("builds the next versions the way a provider names them", () => {
    expect(laterVersions("claude-fable-5-2")).toEqual(["claude-fable-5-3", "claude-fable-6"]);
    expect(laterVersions("claude-opus-5")).toEqual(["claude-opus-5-1", "claude-opus-6"]);
    expect(laterVersions("claude-opus-4-20250514")).toEqual(["claude-opus-4-1", "claude-opus-5"]);
    expect(laterVersions("gpt-5.6-sol")).toEqual(["gpt-5.7-sol", "gpt-6-sol"]);
    expect(laterVersions("gpt-4.1-2025-04-14")).toEqual(["gpt-4.2", "gpt-5"]);
    expect(laterVersions("gpt-4o-mini")).toEqual(["gpt-5o-mini"]);
    expect(laterVersions("gemini-4-argon")).toEqual(["gemini-4.1-argon", "gemini-5-argon"]);
    expect(laterVersions("grok-4.7")).toEqual(["grok-4.8", "grok-5"]);
    expect(laterVersions("kimi-k3.1-pro")).toEqual(["kimi-k3.2-pro", "kimi-k4-pro"]);
    expect(laterVersions("o3")).toEqual(["o3.1", "o4"]);
  });

  // The versions next to each model the table prices. An ID the evidence names as unpriced has no rule to inherit from.
  const probes = [...new Set(namedIds.filter((id) => findPricingRule(id) !== undefined).flatMap((id) => laterVersions(id)))].filter((probe) => !named.has(probe)).sort();

  it("has versions to try", () => {
    expect(probes.length).toBeGreaterThan(100);
    // The three that were priced wrongly, and the next one of each family.
    for (const probe of ["claude-fable-5-3", "claude-opus-5-6", "claude-sonnet-5-6", "claude-opus-4-9", "claude-sonnet-4-7", "claude-haiku-4-6", "grok-4.8", "kimi-k3.2-pro", "gemini-4.1-argon"]) {
      expect(probes).toContain(probe);
    }
  });

  it.each(probes)("%s counts as missing", (probe) => {
    expect(findPricingRule(probe)?.match.source, `${probe} is a version no evidence names, and this rule prices it`).toBeUndefined();
    expect(estimateTokenCostUsd(probe, { inputTokens: 1_000, outputTokens: 1_000 }, "2026-11-15")).toBeUndefined();
  });

  it("lists every rule that takes any text after an ID it names, and only those", () => {
    const open = namedIds.filter((id) => findPricingRule(id) !== undefined && findPricingRule(`${id}-zz9`) === findPricingRule(id));
    expect(open).toEqual(Object.keys(TAKES_ANY_SUFFIX).sort());
  });

  it.each(["claude-opus-5-5[1m]", "claude-fable-5-2[1m]", "claude-sonnet-5[1m]", "kimi-k3[1m]", "kimi-k3.1-pro[1M]"])("%s is priced as the model before the context suffix", (model) => {
    const id = model.replace(/\[1m\]$/i, "");
    expect(findPricingRule(model)).toBeDefined();
    expect(findPricingRule(model)).toBe(findPricingRule(id));
  });

  it.each([
    // model, the ID whose rule prices it, input and output per million tokens
    ["claude-opus-5-5-20261001", "claude-opus-5-5", 4, 20],
    ["claude-fable-5-1-20260901", "claude-fable-5-1", 10, 50],
    ["claude-opus-4-8-20260601", "claude-opus-4-8", 5, 25],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5", 3, 15],
    ["claude-sonnet-4-20250514", "claude-sonnet-4", 3, 15],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5", 1, 5]
  ])("%s, a dated snapshot, is priced as %s and not as the version before it", (model, id, input, output) => {
    // The first three dates are synthetic: they exercise snapshot matching, not availability.
    expect(findPricingRule(model)).toBe(findPricingRule(id));
    expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(input);
    expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(output);
  });

  it.each(["claude-fable-5-3[1m]", "claude-opus-5-5[2m]", "claude-opus-5-5[1m]-x"])("%s is still missing: the suffix names no version", (model) => {
    expect(findPricingRule(model)).toBeUndefined();
  });
});
