/**
 * Copy gate for the public landing surface (asktilden.com).
 *
 * The Sep 19, 2026 Workspace launch-readiness review found the live landing
 * claiming things the product does not do: four "VERIFIED" chips, "proven,
 * never modeled", "billed dollars only ever appear verified", an FAQ about
 * proving ROI, "white-label client reports" (not built), "spend alerts" (only
 * budgets you evaluate by hand exist) and a "Monday briefing" (no schedule and
 * no email route exist). This test keeps that copy from coming back.
 *
 * Scope is the marketing surface only. The /docs and /blog pages document the
 * CLI's literal label vocabulary (`live_verified`, `fixture_verified`,
 * `detected_unverified`) and are not covered here: renaming a machine-readable
 * label in prose that describes it would make the docs wrong, not truer.
 *
 * Truthful vocabulary to use instead: "provider-reported", "what your
 * providers billed", "estimated" (with the ~ marker where a symbol is shown),
 * "reported, estimated, or missing", "briefing on demand". Missing is never
 * zero.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..");

/** Every file that renders copy on the public marketing surface. */
const LANDING_FILES = [
  "app/page.tsx",
  "app/layout.tsx",
  "app/thanks/page.tsx",
  "components/PageShell.tsx",
  "components/WaitlistForm.tsx",
  "lib/workspace-entry.ts",
] as const;

/**
 * "unverified" is the opposite of a claim: it is the CLI's own
 * `detected_unverified` label, shown so a number that has NOT been read from a
 * provider says so. It is masked before the scan rather than banned.
 */
function scannable(source: string): string {
  return source.replace(/unverified/gi, "«not-reported-label»");
}

const FORBIDDEN_WORDS: ReadonlyArray<[string, RegExp]> = [
  ["verified", /verified/gi],
  ["proven", /\bproven\b/gi],
  ["saves", /\bsaves\b/gi],
  ["savings", /\bsavings\b/gi],
  ["ROI", /\broi\b/gi],
  ["ask anything", /ask\s+anything/gi],
];

/** Claims about features that are not live for a pilot today. */
const FORBIDDEN_CLAIMS: ReadonlyArray<[string, RegExp]> = [
  ["white-label client reports", /white[-\s]?label/gi],
  ["spend alerts", /spend\s+alerts?/gi],
  ["alerts of any kind", /\balerts?\b/gi],
  ["Monday briefing", /monday\s+briefing/gi],
  ["continuous monitoring", /continuous\s+monitoring/gi],
];

function read(file: string): string {
  return readFileSync(join(APP_ROOT, file), "utf8");
}

describe("landing copy gate", () => {
  it.each(LANDING_FILES)("%s carries no forbidden word", (file) => {
    const text = scannable(read(file));
    const hits = FORBIDDEN_WORDS.filter(([, re]) => {
      re.lastIndex = 0;
      return re.test(text);
    }).map(([word]) => word);
    expect(hits, `${file} must not claim: ${hits.join(", ")}`).toEqual([]);
  });

  it.each(LANDING_FILES)("%s claims no feature that is not live", (file) => {
    const text = read(file);
    const hits = FORBIDDEN_CLAIMS.filter(([, re]) => {
      re.lastIndex = 0;
      return re.test(text);
    }).map(([claim]) => claim);
    expect(hits, `${file} must not promise: ${hits.join(", ")}`).toEqual([]);
  });

  it.each(LANDING_FILES)("%s uses no em-dash", (file) => {
    // The lone exception is the receipt illustration's "missing" marker, a
    // standalone glyph in its own element, not prose.
    const text = read(file).replace(/>—</g, "><");
    expect(text).not.toContain("—");
  });

  it("labels the provider chips by basis, not by a verification claim", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("LIVE · PROVIDER-REPORTED");
    expect(page).toContain("BETA · FIXTURE ONLY");
  });

  it("says the Workspace is not launched publicly", () => {
    expect(read("lib/workspace-entry.ts")).toContain(
      "Workspace is not launched publicly.",
    );
  });

  it("keeps the waitlist form and its ref attribution intact", () => {
    const form = read("components/WaitlistForm.tsx");
    expect(form).toContain('fetch("/api/waitlist"');
    expect(form).toContain("JSON.stringify({ email, ref })");
  });
});
