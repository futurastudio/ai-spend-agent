import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findDeveloperPathLeaks,
  isForbiddenPublicPath
} from "./public-boundary-rules.mjs";

describe("public-boundary path rules", () => {
  const privatePaths = [
    "docs/MONETIZATION.md",
    "docs/monetization/tier-strategy.md",
    "planning/PRICING_STRATEGY.md",
    "planning/TEAM_TIERS.md",
    "planning/REVENUE_MODEL_2026.md",
    "planning/UNIT_ECONOMICS.md",
    "INVESTOR_P0_BUILD_2026-08-08.md",
    "GTM_STRATEGY_2026.md",
    "LAUNCH_GTM.md",
    "USER_RESEARCH_2026-08.md",
    "COMPETITIVE_INTELLIGENCE_2026.md",
    "PAIN_POINTS.md",
    "planning/CODEX_BUILD_SPEC_2026-08-08.md",
    "planning/CODEX_CLOUD_SPEC_2026-08-08.md",
    "planning/BUILD_SPEC_2026-08-08.md",
    "planning/TILDEN_BUILD_SPEC.md",
    "build-specs/demo-receipt.md",
    "docs/PRIVATE_SPEC_2026-08.md",
    "docs/ARTIFACT_ROADMAP.md",
    "docs/INTERNAL_ROADMAP_2026-09.md",
    "docs/research/interviews.md",
    "docs/gtm/private-launch.md",
    "investor/deck.pdf",
    "specs/investor-demo.md",
    "specs/demo-investor.md",
    "docs/investor-materials/meeting-notes.md",
    "docs/PITCH_DECK_2026-08.pptx",
    ".claude/settings.json"
  ];
  for (const path of privatePaths) {
    it(`rejects private path ${path}`, () => {
      assert.equal(isForbiddenPublicPath(path), true);
    });
  }

  const publicPaths = [
    "ROADMAP.md",
    "docs/product/ROADMAP.md",
    "docs/blog/investor-audience.md",
    "docs/api/specs/receipt-contract.md",
    "docs/product/SPECIFICATION.md",
    "benchmarks/research-method.md",
    "docs/presentations/product-demo.md",
    ".env.example"
  ];
  for (const path of publicPaths) {
    it(`allows deliberately public path ${path}`, () => {
      assert.equal(isForbiddenPublicPath(path), false);
    });
  }
});

describe("public-boundary developer-path rules", () => {
  it("rejects concrete macOS home and legacy checkout paths", () => {
    const concreteHome = ["", "Users", "alice", "work", "ai-spend-agent"].join("/");
    const founderHome = ["", "Users", "jose", "work", "ai-spend-agent"].join("/");
    const linuxHome = ["", "home", "alice", "work", "ai-spend-agent"].join("/");
    const windowsHome = ["C:", "Users", "alice", "work", "ai-spend-agent"].join("\\");
    const legacyCheckout = ["~", "agent-finops", "packages", "cli"].join("/");
    const legacySwiftFallback = [
      ".appendingPathComponent(",
      '"agent-finops"',
      ")"
    ].join("");

    assert.deepEqual(findDeveloperPathLeaks(
      `${concreteHome}\n${founderHome}\n${linuxHome}\n${windowsHome}\n${legacyCheckout}\n${legacySwiftFallback}`
    ), [
      concreteHome,
      founderHome,
      linuxHome,
      windowsHome,
      `${["~", "agent-finops"].join("/")}/`,
      legacySwiftFallback
    ]);
  });

  it("allows generic, portable documentation examples", () => {
    const examples = [
      "/path/to/workspace",
      "~/projects/ai-spend-agent",
      "/Users/<username>/project",
      "/Users/$USER/project",
      "/home/<username>/project",
      String.raw`C:\Users\<username>\project`,
      "$HOME/projects/ai-spend-agent"
    ].join("\n");

    assert.deepEqual(findDeveloperPathLeaks(examples), []);
  });
});
