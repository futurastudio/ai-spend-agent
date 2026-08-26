import { describe, expect, it } from "vitest";
import {
  canPriceTokenUsageAtScope,
  estimateTokenCostUsd,
  estimateTokenCostsUsd,
  findPricingRule,
  usesPromptTieredPricing
} from "./modelPricing.js";

const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };

describe("model pricing coverage", () => {
  it("uses current published prices for Claude 5 model IDs", () => {
    expect(estimateTokenCostUsd("claude-fable-5", usage)).toBe(15);
    expect(estimateTokenCostUsd("claude-mythos-5", usage)).toBe(15);
    expect(estimateTokenCostUsd("claude-opus-5", usage)).toBe(7.5);
    expect(estimateTokenCostUsd("claude-sonnet-5", usage)).toBe(3);
    expect(estimateTokenCostUsd("claude-mythos-preview", usage)).toBeUndefined();
  });

  it("prices the major non-Anthropic/OpenAI model families", () => {
    // Gemini Pro: the 1M-token prompt selects the >200k rate for all tokens.
    expect(estimateTokenCostUsd("gemini-2.5-pro", usage)).toBeCloseTo(4, 2);
    // DeepSeek
    expect(estimateTokenCostUsd("deepseek-chat", usage)).toBeCloseTo(0.38, 2);
    expect(estimateTokenCostUsd("deepseek-reasoner", usage)).toBeCloseTo(0.769, 2);
    // Kimi / Moonshot — official list prices (platform.kimi.ai/docs/pricing/*,
    // fetched 2026-08-25). Input + output pinned per model.
    expect(estimateTokenCostUsd("kimi-k3", usage)).toBeCloseTo(4.5, 4);
    expect(estimateTokenCostUsd("kimi-k3[1m]", usage)).toBeCloseTo(4.5, 4);
    expect(estimateTokenCostUsd("kimi-k2.7-code", usage)).toBeCloseTo(1.35, 4);
    expect(estimateTokenCostUsd("kimi-k2.7-code-highspeed", usage)).toBeCloseTo(2.7, 4);
    expect(estimateTokenCostUsd("kimi-k2.6", usage)).toBeCloseTo(1.35, 4);
    // Published cache-hit input rates (1M cache-read tokens, nothing else).
    const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 };
    expect(estimateTokenCostUsd("kimi-k3", cacheOnly)).toBeCloseTo(0.3, 4);
    expect(estimateTokenCostUsd("kimi-k2.7-code", cacheOnly)).toBeCloseTo(0.19, 4);
    expect(estimateTokenCostUsd("kimi-k2.7-code-highspeed", cacheOnly)).toBeCloseTo(0.38, 4);
    expect(estimateTokenCostUsd("kimi-k2.6", cacheOnly)).toBeCloseTo(0.16, 4);
    // Legacy K2 family + moonshot-v1 (sunsets 2026-08-31) keep the old rates.
    expect(estimateTokenCostUsd("kimi-k2-instruct", usage)).toBeCloseTo(0.85, 2);
    expect(estimateTokenCostUsd("kimi-k2", usage)).toBeCloseTo(0.85, 2);
    expect(estimateTokenCostUsd("moonshot-v1-8k", usage)).toBeCloseTo(0.85, 2);
    // Grok
    expect(estimateTokenCostUsd("grok-4", usage)).toBeCloseTo(4.5, 2);
    expect(estimateTokenCostUsd("grok-3-mini", usage)).toBeCloseTo(0.35, 2);
  });

  it("selects Gemini 2.5 Pro rates from inclusive per-request prompt size", () => {
    const atThreshold = {
      inputTokens: 150_000,
      cacheReadTokens: 40_000,
      toolTokens: 10_000,
      outputTokens: 10_000,
      thoughtTokens: 2_000
    };
    const aboveThreshold = { ...atThreshold, inputTokens: 150_001 };

    expect(usesPromptTieredPricing("gemini-2.5-pro")).toBe(true);
    expect(estimateTokenCostUsd("gemini-2.5-pro", atThreshold)).toBe(0.325);
    expect(estimateTokenCostUsd("gemini-2.5-pro", aboveThreshold)).toBe(0.59);
  });

  it("prices Gemini 2.5 Pro calls before aggregation", () => {
    const request = { inputTokens: 150_000, outputTokens: 10_000 };
    expect(estimateTokenCostsUsd("gemini-2.5-pro", [request, request])).toBe(0.575);
    expect(estimateTokenCostUsd("gemini-2.5-pro", {
      inputTokens: 300_000,
      outputTokens: 20_000
    })).toBe(1.05);
  });

  it("kimi-k2.7-code no longer falls through to the old K2 rule (0.9.3 mispricing bug)", () => {
    // 0.9.3's `^kimi-k2` prefix swallowed the k2.7/k2.6 dot families and
    // priced them ~40% low ($0.60/$2.50 vs the real $0.95/$4.00) — wrong
    // numbers presented as estimates. The dot families must resolve to
    // their own published rates, never the legacy K2 rule.
    for (const model of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]) {
      const rule = findPricingRule(model);
      expect(rule, model).toBeDefined();
      expect(rule!.inputPerM, model).not.toBe(0.6);
      expect(rule!.outputPerM, model).not.toBe(2.5);
    }
    expect(findPricingRule("kimi-k2.7-code")!.inputPerM).toBe(0.95);
    expect(findPricingRule("kimi-k2.7-code")!.outputPerM).toBe(4);
    expect(findPricingRule("kimi-k2.7-code-highspeed")!.inputPerM).toBe(1.9);
    expect(findPricingRule("kimi-k2.7-code-highspeed")!.outputPerM).toBe(8);
    expect(findPricingRule("kimi-k2.6")!.inputPerM).toBe(0.95);
    expect(findPricingRule("kimi-k2.6")!.outputPerM).toBe(4);
    expect(findPricingRule("kimi-k3")!.inputPerM).toBe(3);
    expect(findPricingRule("kimi-k3")!.outputPerM).toBe(15);
    // The legacy rule still owns exactly the models it is true for.
    expect(findPricingRule("kimi-k2")!.inputPerM).toBe(0.6);
    expect(findPricingRule("kimi-k2-instruct")!.inputPerM).toBe(0.6);
  });

  it("current DeepSeek v4 models stay honestly unpriced — time-of-day rates are never flattened", () => {
    // deepseek-v4-* pricing is time-of-day (off-peak = half price); a flat
    // number would be wrong by up to 2x. Deferred to timestamp-aware
    // pricing — until then these flow to the missing/unpriced path.
    for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
      expect(findPricingRule(model), model).toBeUndefined();
    }
  });

  it("returns undefined for open-weight models with no canonical price — never invents a number", () => {
    for (const model of [
      "llama-4-maverick",
      "qwen3-coder",
      "mistral-large",
      "glm-4.5",
      "totally-unknown-model",
      "codex-auto-review",
      "my-codex-wrapper",
      "gemini-2.5-pro-future-enterprise",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-preview",
      "gemini-2.5-flash-lite-001"
    ]) {
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
      expect(findPricingRule(model), model).toBeUndefined();
    }
  });

  it("uses current published prices for recent GPT families before fallbacks", () => {
    const belowTier = { inputTokens: 100_000, outputTokens: 10_000 };
    // developers.openai.com/api/docs/pricing cross-checked against each model's
    // own doc page, both fetched 2026-08-25. Short-context (<=272K) rates.
    expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier)!).toBeCloseTo(0.6, 4);
    expect(estimateTokenCostUsd("gpt-5.6-terra", belowTier)!).toBeCloseTo(0.32, 4);
    expect(estimateTokenCostUsd("gpt-5.6-luna", belowTier)!).toBeCloseTo(0.032, 4);
    expect(estimateTokenCostUsd("gpt-5.5", belowTier)!).toBeCloseTo(0.8, 4);
    expect(estimateTokenCostUsd("gpt-5.4", belowTier)!).toBeCloseTo(0.4, 4);
    expect(estimateTokenCostUsd("gpt-5.5-codex", usage)!).toBeCloseTo(8, 2);
    expect(estimateTokenCostUsd("gpt-5.4-mini", usage)!).toBeCloseTo(1.2, 2);
    expect(estimateTokenCostUsd("gpt-5.4-nano", usage)!).toBeCloseTo(0.325, 3);
    expect(estimateTokenCostUsd("gpt-5.3-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.2-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.1-codex", usage)!).toBeCloseTo(2.25, 2);
  });

  it("pins published cached-input rates for the current GPT families", () => {
    // 100K cache-read tokens only, keeping the request under the 272K tier.
    const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 };
    expect(estimateTokenCostUsd("gpt-5.6-sol", cacheOnly)!).toBeCloseTo(0.04, 5);
    expect(estimateTokenCostUsd("gpt-5.6-terra", cacheOnly)!).toBeCloseTo(0.02, 5);
    expect(estimateTokenCostUsd("gpt-5.6-luna", cacheOnly)!).toBeCloseTo(0.002, 5);
    expect(estimateTokenCostUsd("gpt-5.5", cacheOnly)!).toBeCloseTo(0.05, 5);
    expect(estimateTokenCostUsd("gpt-5.4", cacheOnly)!).toBeCloseTo(0.025, 5);
    expect(estimateTokenCostUsd("gpt-5-nano", cacheOnly)!).toBeCloseTo(0.0005, 5);
  });

  it("prices the founder-observed Codex model ids exactly", () => {
    // The two model ids that appear in real Codex transcripts. gpt-5.6-sol
    // carried GPT-5.5's numbers ($5/$30) until 0.9.6, overstating input 25% and
    // output 50% on every OpenAI record.
    const oneM = { inputTokens: 1_000_000, outputTokens: 0 };
    const oneMOut = { inputTokens: 0, outputTokens: 1_000_000 };
    expect(estimateTokenCostUsd("gpt-5.6-sol", oneM)).toBe(8);
    expect(estimateTokenCostUsd("gpt-5.6-terra", oneM)).toBe(4);
    // Output-only requests never cross the prompt-size tier, so these are the
    // published short-context output rates.
    expect(estimateTokenCostUsd("gpt-5.6-sol", oneMOut)).toBe(20);
    expect(estimateTokenCostUsd("gpt-5.6-terra", oneMOut)).toBe(12);
  });

  it("prices gpt-5-nano off its own rule, not the gpt-5 fallback", () => {
    // Pre-0.9.6 this fell through to ^gpt-5 and billed $1.25/$10 — 25x high.
    expect(estimateTokenCostUsd("gpt-5-nano", usage)!).toBeCloseTo(0.09, 4);
    expect(estimateTokenCostUsd("gpt-5-mini", usage)!).toBeCloseTo(0.45, 4);
    // The GPT-5 base rule still covers the base id and its dated snapshots.
    expect(estimateTokenCostUsd("gpt-5", usage)!).toBeCloseTo(2.25, 4);
    expect(estimateTokenCostUsd("gpt-5-2025-08-07", usage)!).toBeCloseTo(2.25, 4);
  });

  it("leaves unverified and future GPT siblings honestly unpriced", () => {
    // Rule ordering must not let a neighbour's rate leak onto a model we have
    // not verified — the 0.9.4 `^kimi-k2` bug, one family up.
    for (const model of [
      // Future family / variant that does not exist yet.
      "gpt-5.7-sol",
      "gpt-5.6-unknownvariant",
      "gpt-5.6-sol-2026-08-01",
      // Not an OpenAI model id: GPT-5.6 ships sol/terra/luna only.
      "gpt-5.6",
      "gpt-5.6-codex",
      "gpt-5.5-mini",
      // Canonical sources disagree on cyber's >272K tier; Daybreak-gated.
      "gpt-5.6-cyber",
      "gpt-5.5-cyber",
      // Listed as long-context capable but no per-model rate published.
      "gpt-5.5-pro",
      "gpt-5.4-pro",
      // Pricing page quotes only a $1.25-$1.75 range for this group.
      "gpt-5.1",
      "gpt-5.3"
    ]) {
      expect(findPricingRule(model), model).toBeUndefined();
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
    }
  });

  it("uses the current per-request long-context tiers above 272K tokens", () => {
    const atThreshold = { inputTokens: 272_000, outputTokens: 10_000 };
    const aboveThreshold = { inputTokens: 272_001, outputTokens: 10_000 };

    // Published on every 5.6 page plus 5.5/5.4: ">272K input tokens are priced
    // at 2x input and 1.5x output for the full request."
    expect(usesPromptTieredPricing("gpt-5.6-sol")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.6-terra")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.6-luna")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.5")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.4")).toBe(true);
    // gpt-5.5-codex is absent from the published long-context list.
    expect(usesPromptTieredPricing("gpt-5.5-codex")).toBe(false);
    expect(usesPromptTieredPricing("gpt-5-nano")).toBe(false);

    expect(estimateTokenCostUsd("gpt-5.6-sol", atThreshold)).toBe(1.288);
    expect(estimateTokenCostUsd("gpt-5.6-sol", aboveThreshold)).toBe(2.476);
    expect(estimateTokenCostUsd("gpt-5.6-terra", atThreshold)).toBe(0.664);
    expect(estimateTokenCostUsd("gpt-5.6-terra", aboveThreshold)).toBe(1.268);
    expect(estimateTokenCostUsd("gpt-5.6-luna", atThreshold)).toBe(0.0664);
    expect(estimateTokenCostUsd("gpt-5.6-luna", aboveThreshold)).toBe(0.1268);
    expect(estimateTokenCostUsd("gpt-5.5", atThreshold)).toBe(1.66);
    expect(estimateTokenCostUsd("gpt-5.5", aboveThreshold)).toBe(3.17);
    expect(estimateTokenCostUsd("gpt-5.4", atThreshold)).toBe(0.83);
    expect(estimateTokenCostUsd("gpt-5.4", aboveThreshold)).toBe(1.585);
  });

  it("fails closed for ambiguous tiered aggregates above the request threshold", () => {
    expect(canPriceTokenUsageAtScope(
      "gpt-5.6-sol",
      { inputTokens: 200_000, outputTokens: 1 },
      "aggregate"
    )).toBe(true);
    expect(canPriceTokenUsageAtScope(
      "gpt-5.6-sol",
      { inputTokens: 300_000, outputTokens: 1 },
      "aggregate"
    )).toBe(false);
    expect(canPriceTokenUsageAtScope(
      "gpt-5.6-sol",
      { inputTokens: 300_000, outputTokens: 1 },
      "request"
    )).toBe(true);
  });

  it("prices a large tiered aggregate at the base tier when request evidence proves no request crossed the threshold", () => {
    // A session-cumulative slice whose own prompt total (300K) clears the 272K
    // per-request threshold, but whose largest single request stayed at/below
    // it. No request qualified for the above-tier rate, so the whole sum is
    // base-tier and prices exactly there — not 2x.
    const cumulative = { inputTokens: 300_000, outputTokens: 10_000 };
    // Base: 300000*4/1e6 + 10000*20/1e6.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [200_000])).toBe(1.4);
    // Threshold is inclusive on the base side (<=272K stays base).
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [272_000])).toBe(1.4);
    // Without evidence the slice's own 300K prompt still selects the 2x tier:
    // 300000*8/1e6 + 10000*30/1e6. Turn-scoped callers are unchanged.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative])).toBe(2.7);
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [undefined])).toBe(2.7);
    // Evidence that a single request DID cross the threshold keeps the 2x tier.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [272_001])).toBe(2.7);
  });

  it("gates request-evidence tier pricing exactly at the inclusive threshold", () => {
    const aggregate = { inputTokens: 300_000, outputTokens: 1 };
    // Largest request at/below the threshold makes the aggregate priceable...
    expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", 200_000)).toBe(true);
    expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", 272_000)).toBe(true);
    // ...one token over, and it fails closed to honest "missing".
    expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", 272_001)).toBe(false);
    // No evidence keeps the pre-fix conservative behaviour (unchanged).
    expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate")).toBe(false);
    expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", undefined)).toBe(false);
  });

  it("prices a real cache-heavy Codex session at base tier instead of voiding it (founder's #1 complaint)", () => {
    // Shape of one of the founder's real gpt-5.6-sol days: a 1.26B-token
    // cumulative dominated by cache reads, whose largest single request was
    // 252,970 tokens (< 272K, capped by the model context window). Before the
    // fix the cumulative cleared the tier check and voided to null/"missing";
    // it must now price at the base tier, and pricing the whole sum there is
    // exact because every request was base-tier.
    const session = {
      inputTokens: 30_186_579,
      outputTokens: 2_896_454,
      cacheReadTokens: 1_226_450_816
    };
    const maxRequestPromptTokens = 252_970;
    expect(canPriceTokenUsageAtScope(
      "gpt-5.6-sol", session, "aggregate", maxRequestPromptTokens
    )).toBe(true);
    // 30_186_579*4 + 2_896_454*20 + 1_226_450_816*0.4, all per million.
    expect(estimateTokenCostsUsd(
      "gpt-5.6-sol", [session], [maxRequestPromptTokens]
    )).toBeCloseTo(669.2557, 4);
    // Left ungated (no evidence) it would have priced ~2x on the above tier —
    // the dishonest outcome this fix avoids.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [session])).toBe(1309.5469);
  });
});
