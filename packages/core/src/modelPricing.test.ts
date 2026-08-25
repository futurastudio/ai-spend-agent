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
    expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier)!).toBeCloseTo(0.8, 2);
    expect(estimateTokenCostUsd("gpt-5.6-terra", belowTier)!).toBeCloseTo(0.32, 2);
    expect(estimateTokenCostUsd("gpt-5.6-luna", belowTier)!).toBeCloseTo(0.032, 3);
    expect(estimateTokenCostUsd("gpt-5.5-codex", usage)!).toBeCloseTo(8, 2);
    expect(estimateTokenCostUsd("gpt-5.4", usage)!).toBeCloseTo(4, 2);
    expect(estimateTokenCostUsd("gpt-5.4-mini", usage)!).toBeCloseTo(1.2, 2);
    expect(estimateTokenCostUsd("gpt-5.4-nano", usage)!).toBeCloseTo(0.325, 3);
    expect(estimateTokenCostUsd("gpt-5.3-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.2-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.1-codex", usage)!).toBeCloseTo(2.25, 2);
  });

  it("uses the current GPT-5.6 per-request long-context tiers", () => {
    const atThreshold = { inputTokens: 272_000, outputTokens: 10_000 };
    const aboveThreshold = { inputTokens: 272_001, outputTokens: 10_000 };

    expect(usesPromptTieredPricing("gpt-5.6-sol")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.6-terra")).toBe(true);
    expect(usesPromptTieredPricing("gpt-5.6-luna")).toBe(true);
    expect(estimateTokenCostUsd("gpt-5.6-sol", atThreshold)).toBe(1.66);
    expect(estimateTokenCostUsd("gpt-5.6-sol", aboveThreshold)).toBe(3.17);
    expect(estimateTokenCostUsd("gpt-5.6-terra", atThreshold)).toBe(0.664);
    expect(estimateTokenCostUsd("gpt-5.6-terra", aboveThreshold)).toBe(1.268);
    expect(estimateTokenCostUsd("gpt-5.6-luna", atThreshold)).toBe(0.0664);
    expect(estimateTokenCostUsd("gpt-5.6-luna", aboveThreshold)).toBe(0.1268);
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
});
