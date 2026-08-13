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
  it("prices the major non-Anthropic/OpenAI model families", () => {
    // Gemini Pro: the 1M-token prompt selects the >200k rate for all tokens.
    expect(estimateTokenCostUsd("gemini-2.5-pro", usage)).toBeCloseTo(4, 2);
    // DeepSeek
    expect(estimateTokenCostUsd("deepseek-chat", usage)).toBeCloseTo(0.38, 2);
    expect(estimateTokenCostUsd("deepseek-reasoner", usage)).toBeCloseTo(0.769, 2);
    // Kimi / Moonshot
    expect(estimateTokenCostUsd("kimi-k2-instruct", usage)).toBeCloseTo(0.85, 2);
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
