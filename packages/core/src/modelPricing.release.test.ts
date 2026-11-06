import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PRICING_TABLE_AS_OF, canPriceTokenUsageAtScope, estimateTokenCostUsd, estimateTokenCostsUsd, findPricingRule, promptTierThreshold, type TokenUsage } from "./modelPricing.js";

const evidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-07.json", import.meta.url), "utf8"));
const sonnetEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-08.json", import.meta.url), "utf8"));
const reviewedEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-18.json", import.meta.url), "utf8"));
const geminiEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-04.json", import.meta.url), "utf8"));
const solEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-06.json", import.meta.url), "utf8"));

describe("2026-11-06 reviewed GPT-5.6 Sol prices", () => {
  type Rates = {
    from?: string; input: number; output: number; cacheRead: number;
    abovePromptTokens: number; aboveInput: number; aboveOutput: number; aboveCacheRead: number;
  };
  const model = solEvidence.models.find((entry: { id: string }) => entry.id === "gpt-5.6-sol");
  const [change] = model.scheduledRates as Rates[];
  const firstDay = `${change!.from}T00:00:00.000Z`;
  // The last UTC millisecond of the promotion.
  const lastBefore = new Date(Date.parse(firstDay) - 1).toISOString();
  // One million tokens of one component, with the request tier fixed by the given prompt.
  const price = (component: Partial<TokenUsage>, usageAt: string, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens], usageAt);

  it("is the review date of the price table", () => {
    expect(PRICING_TABLE_AS_OF).toBe(solEvidence.retrievedAt);
  });

  it.each([
    ["through", lastBefore, model as Rates],
    ["after", firstDay, change!]
  ])("matches the retained rates and long-context tier %s the promotion", (_side, usageAt, rates) => {
    expect(promptTierThreshold(model.id, usageAt)).toBe(rates.abovePromptTokens);
    const base = rates.abovePromptTokens;
    const above = rates.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, usageAt, base)).toBe(rates.input);
    expect(price({ outputTokens: 1_000_000 }, usageAt, base)).toBe(rates.output);
    expect(price({ cacheReadTokens: 1_000_000 }, usageAt, base)).toBe(rates.cacheRead);
    expect(price({ inputTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveCacheRead);
  });

  it("carries exactly the retained schedule", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM, abovePromptTokens: tier }) => ({
      from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM, abovePromptTokens: tier?.threshold,
      aboveInput: tier?.inputPerM, aboveOutput: tier?.outputPerM, aboveCacheRead: tier?.cacheReadPerM
    }))).toEqual(model.scheduledRates);
  });

  it("holds the published relations the inferred later rates rest on", () => {
    // "a 20% reduction in input pricing and a 33% reduction in output pricing".
    expect(1 - model.input / change!.input).toBeCloseTo(0.2, 5);
    expect(1 - model.output / change!.output).toBeCloseTo(0.33, 2);
    // ">272K input tokens are priced at 2x input and 1.5x output for the full request".
    for (const rates of [model as Rates, change!]) {
      expect(rates.aboveInput).toBe(rates.input * 2);
      expect(rates.aboveOutput).toBe(rates.output * 1.5);
      expect(rates.aboveCacheRead).toBe(rates.cacheRead * 2);
    }
    expect(solEvidence.basis).toContain("has NOT published the rate that follows the promotion");
  });
});

describe("2026-11-04 reviewed Gemini 2.5 Pro prices", () => {
  type Rates = { from?: string; input: number; output: number; cacheRead: number };
  const model = geminiEvidence.models.find((entry: { id: string }) => entry.id === "gemini-2.5-pro");
  const changes = model.scheduledRates as Rates[];
  // The last UTC millisecond before a published change.
  const lastBefore = (from: string) => new Date(Date.parse(`${from}T00:00:00.000Z`) - 1).toISOString();
  // One million tokens of one component, with the request tier fixed by the given prompt.
  const price = (component: Partial<TokenUsage>, usageAt: string, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens], usageAt);

  it("matches the retained official-price evidence before the first change", () => {
    const before = lastBefore(changes[0]!.from!);
    expect(promptTierThreshold(model.id, before)).toBe(model.abovePromptTokens);
    const base = model.abovePromptTokens;
    const above = model.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, before, base)).toBe(model.input);
    expect(price({ outputTokens: 1_000_000 }, before, base)).toBe(model.output);
    expect(price({ cacheReadTokens: 1_000_000 }, before, base)).toBe(model.cacheRead);
    expect(price({ inputTokens: 1_000_000 }, before, above)).toBe(model.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, before, above)).toBe(model.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, before, above)).toBe(model.aboveCacheRead);
  });

  it.each(changes.map((change): [string, Rates] => [change.from!, change]))(
    "matches the retained flat rates in force from %s, whatever the prompt size",
    (from, change) => {
      const usageAt = `${from}T00:00:00.000Z`;
      expect(promptTierThreshold(model.id, usageAt)).toBeUndefined();
      expect(price({ inputTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.input);
      expect(price({ outputTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.output);
      expect(price({ cacheReadTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.cacheRead);
    }
  );

  it("switches on each published date and not before", () => {
    expect(price({ inputTokens: 1_000_000 }, lastBefore(changes[1]!.from!), 1_000_000)).toBe(changes[0]!.input);
  });

  it("carries exactly the retained schedule, with no tier after the first change", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM, abovePromptTokens }) =>
      ({ from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM, tiered: abovePromptTokens !== undefined })))
      .toEqual(changes.map((change) => ({ ...change, tiered: false })));
  });
});

describe("2026-10-18 reviewed Haiku 5.5 prices", () => {
  const model = reviewedEvidence.models.find((entry: { id: string }) => entry.id === "claude-haiku-5-5");
  // One million tokens of one component, with the request tier fixed by a
  // prompt exactly at, or one token over, the published threshold.
  const price = (component: Partial<TokenUsage>, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens]);

  it("matches the retained official-price evidence", () => {
    expect(promptTierThreshold(model.id)).toBe(model.abovePromptTokens);
    const base = model.abovePromptTokens;
    const above = model.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, base)).toBe(model.input);
    expect(price({ outputTokens: 1_000_000 }, base)).toBe(model.output);
    expect(price({ cacheReadTokens: 1_000_000 }, base)).toBe(model.cacheRead);
    expect(price({ cacheWrite5mTokens: 1_000_000 }, base)).toBe(model.cacheWrite5m);
    expect(price({ cacheWrite1hTokens: 1_000_000 }, base)).toBe(model.cacheWrite1h);
    expect(price({ inputTokens: 1_000_000 }, above)).toBe(model.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, above)).toBe(model.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, above)).toBe(model.aboveCacheRead);
    expect(price({ cacheWrite5mTokens: 1_000_000 }, above)).toBe(model.aboveCacheWrite5m);
    expect(price({ cacheWrite1hTokens: 1_000_000 }, above)).toBe(model.aboveCacheWrite1h);
  });
});

describe("2026-10-18 reviewed Gemini 4 Argon prices", () => {
  type Rates = { from?: string; input: number; output: number; cacheRead: number };
  const model = reviewedEvidence.models.find((entry: { id: string }) => entry.id === "gemini-4-argon");
  const [change] = model.scheduledRates as Rates[];
  // The last UTC millisecond before the published change.
  const lastBefore = new Date(Date.parse(`${change!.from}T00:00:00.000Z`) - 1).toISOString();

  it.each([
    ["before", lastBefore, model as Rates],
    ["from", `${change!.from}T00:00:00.000Z`, change!]
  ])("matches the retained official-price evidence %s its published change", (_side, usageAt, rates) => {
    expect(estimateTokenCostUsd(model.id, { inputTokens: 1_000_000, outputTokens: 0 }, usageAt)).toBe(rates.input);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 1_000_000 }, usageAt)).toBe(rates.output);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, usageAt)).toBe(rates.cacheRead);
  });

  it("carries exactly the retained schedule", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM }) =>
      ({ from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM }))).toEqual(model.scheduledRates);
    expect(rule.abovePromptTokens).toBeUndefined();
  });
});

describe("0.9.13 reviewed Sonnet 5.5 prices", () => {
  it("matches the retained official-price evidence", () => {
    const model = sonnetEvidence.models[0];
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
