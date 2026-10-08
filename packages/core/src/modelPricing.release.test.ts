import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PRICING_TABLE_AS_OF, canPriceTokenUsageAtScope, estimateTokenCostUsd, estimateTokenCostsUsd, findPricingRule } from "./modelPricing.js";

const evidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-07.json", import.meta.url), "utf8"));
const sonnetEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-08.json", import.meta.url), "utf8"));

describe("0.9.13 reviewed Sonnet 5.5 prices", () => {
  it("matches the retained official-price evidence and review date", () => {
    const model = sonnetEvidence.models[0];
    expect(PRICING_TABLE_AS_OF).toBe(sonnetEvidence.retrievedAt);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(model.input);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(model.output);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(model.cacheRead);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 })).toBe(model.cacheWrite5m);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBe(model.cacheWrite1h);
  });
});

describe("0.9.12 reviewed standard-price fixtures", () => {
  for (const model of evidence.models) {
    it(`${model.id}: published prices and documented estimator fallbacks match dated evidence`, () => {
      const rule = findPricingRule(model.id)!;
      expect(rule.inputPerM).toBe(model.input);
      expect(rule.outputPerM).toBe(model.output);
      expect(rule.cacheReadPerM ?? rule.inputPerM * 0.1).toBe(model.cacheRead);
      // Each 100K component stays below the prompt tier, tested independently.
      expect(estimateTokenCostUsd(model.id, { inputTokens: 100_000, outputTokens: 0 })).toBeCloseTo(model.input / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 100_000 })).toBeCloseTo(model.output / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 })).toBeCloseTo(model.cacheRead / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 100_000 })).toBeCloseTo((model.cacheWrite ?? model.cacheWrite5m) / 10, 4);
      if (model.cacheWrite1h) expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 100_000 })).toBe(model.cacheWrite1h / 10);
    });
  }
  it.each([
    ["gpt-6-astra", 3.22, 6.19, 6, 7.5],
    ["gpt-6.1-sol", .644, 1.238, 1.2, 1.5],
    ["gpt-6-sol", .644, 1.238, 1.2, 1.5],
    ["gpt-6-luna", .0322, .0619, .06, .075]
  ])("%s: golden threshold and per-request totals", (model, threshold, above, requests, aggregate) => {
    expect(estimateTokenCostUsd(model, { inputTokens: 272_000, outputTokens: 10_000 })).toBe(threshold);
    expect(estimateTokenCostUsd(model, { inputTokens: 272_001, outputTokens: 10_000 })).toBe(above);
    const request = { inputTokens: 200_000, outputTokens: 20_000 };
    expect(estimateTokenCostsUsd(model, [request, request])).toBe(requests);
    // Aggregate cannot establish whether the two requests individually crossed the tier.
    expect(canPriceTokenUsageAtScope(model, { inputTokens: 400_000, outputTokens: 40_000 }, "aggregate")).toBe(false);
    expect(estimateTokenCostUsd(model, { inputTokens: 300_000, outputTokens: 20_000 })).toBe(aggregate);
  });
  it.each(["gpt-6-preview", "gpt-6-astra-future", "gpt-6.2-sol", "codex-auto-review"])("%s has no invented price", model => {
    expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeUndefined();
  });
});
