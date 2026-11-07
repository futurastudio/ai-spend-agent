import { describe, expect, it } from "vitest";
import {
  canPriceTokenUsageAtScope,
  estimateTokenCostUsd,
  estimateTokenCostsUsd,
  findPricingRule,
  promptTierThreshold,
  usesPromptTieredPricing,
  type TokenUsage
} from "./modelPricing.js";

const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
// GPT-5.6 Sol has dated rates, so a usage date is part of every price; this one is inside the promotion.
const solPromotion = "2026-11-06";

describe("model pricing coverage", () => {
  it("uses current published prices for Claude 5 model IDs", () => {
    expect(estimateTokenCostUsd("claude-fable-5", usage)).toBe(15);
    expect(estimateTokenCostUsd("claude-mythos-5", usage)).toBe(15);
    expect(estimateTokenCostUsd("claude-opus-5", usage)).toBe(7.5);
    expect(estimateTokenCostUsd("claude-opus-5-5", usage)).toBe(6);
    expect(estimateTokenCostUsd("claude-opus-5-5", {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000
    })).toBe(0.2);
    expect(estimateTokenCostUsd("claude-opus-5-5", {
      inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000
    })).toBe(5);
    expect(estimateTokenCostUsd("claude-opus-5-5", {
      inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000
    })).toBe(8);
    expect(estimateTokenCostUsd("claude-sonnet-5", usage)).toBe(3);
    expect(estimateTokenCostUsd("claude-mythos-preview", usage)).toBeUndefined();
  });

  // Official Anthropic pricing reviewed 2026-10-08:
  // https://platform.claude.com/docs/en/about-claude/pricing
  // The dated ID is synthetic: it exercises snapshot matching, not availability.
  it.each(["claude-sonnet-5-5", "claude-sonnet-5-5-20261001", "CLAUDE-SONNET-5-5"])(
    "%s uses Sonnet 5.5 cache reads without changing base or write prices",
    (model) => {
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.1);
      expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(10);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 })).toBe(2.5);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBe(4);
      expect(estimateTokenCostUsd(model, {
        inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000
      })).toBe(18.6);
    }
  );

  // Official Anthropic pricing reviewed 2026-11-06. The dated IDs are the ones its deprecations
  // page lists; Opus 4.5 and later keep their own rule, and an unknown suffix stays unpriced.
  it.each(["claude-opus-4", "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-20250514", "claude-opus-4-1-20250805"])(
    "%s uses the published Opus 4 and 4.1 prices",
    (model) => {
      expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(15);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(75);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 })).toBe(18.75);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBe(30);
      expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(1.5);
    }
  );

  it("does not stretch the Opus 4 and 4.1 prices to other IDs", () => {
    expect(estimateTokenCostUsd("claude-opus-4-5-20251101", usage)).toBe(7.5);
    expect(estimateTokenCostUsd("claude-opus-4-2", usage)).toBeUndefined();
    expect(estimateTokenCostUsd("claude-opus-4-1-preview", usage)).toBeUndefined();
    expect(estimateTokenCostUsd("claude-opus-4-1-2025", usage)).toBeUndefined();
  });

  it.each([
    ["claude-sonnet-5", 0.2],
    ["claude-sonnet-5-20261001", 0.2],
    ["claude-sonnet-4-6", 0.3],
    ["claude-opus-5", 0.5],
    ["claude-opus-5-5", 0.2]
  ])("%s retains its cache-read price", (model, expected) => {
    expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(expected);
  });

  it.each(["claude-sonnet-5-50", "claude-sonnet-5-5-preview", "claude-sonnet-5-5-20261001-extra"])(
    "%s does not inherit the Sonnet 5.5 discount",
    (model) => {
      // Preserve the existing fallback; do not broaden the new version-specific rule.
      expect(findPricingRule(model)).toBe(findPricingRule("claude-sonnet-5"));
    }
  );

  // Official Anthropic pricing reviewed 2026-10-18:
  // https://platform.claude.com/docs/en/about-claude/pricing
  // "A request's prompt length counts all of its input tokens, including cache
  // reads and cache writes. Each request is priced on its own."
  // The dated ID is synthetic: it exercises snapshot matching, not availability.
  describe("Claude Haiku 5.5 prompt-length pricing", () => {
    // Exactly 100,000 prompt tokens: 20K input + 50K cache read + 20K 5m write + 10K 1h write.
    const atThreshold = {
      inputTokens: 20_000,
      outputTokens: 20_000,
      cacheReadTokens: 50_000,
      cacheWrite5mTokens: 20_000,
      cacheWrite1hTokens: 10_000
    };

    it.each(["claude-haiku-5-5", "claude-haiku-5-5-20261001", "CLAUDE-HAIKU-5-5"])(
      "%s uses the published rates for prompts up to 100,000 tokens",
      (model) => {
        expect(usesPromptTieredPricing(model)).toBe(true);
        expect(estimateTokenCostUsd(model, { inputTokens: 100_000, outputTokens: 0 })).toBe(0.01);
        expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(0.5);
        expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 })).toBe(0.001);
        expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 100_000 })).toBe(0.0125);
        expect(estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 100_000 })).toBe(0.02);
        // 20K*0.10 + 20K*0.50 + 50K*0.01 + 20K*0.125 + 10K*0.20, per million.
        expect(estimateTokenCostUsd(model, atThreshold)).toBe(0.017);
      }
    );

    it("uses the published rates for prompts over 100,000 tokens", () => {
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.5);
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.05);
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 })).toBe(0.625);
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBe(1);
      // Output is repriced with the rest of the request: 1M*0.50 + 1M*2.50.
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3);
    });

    it.each([
      ["input", { inputTokens: 20_001 }],
      ["cache read", { cacheReadTokens: 50_001 }],
      ["5-minute cache write", { cacheWrite5mTokens: 20_001 }],
      ["1-hour cache write", { cacheWrite1hTokens: 10_001 }]
    ])("one more %s token moves the whole request over the 100,000-token threshold", (_component, extra) => {
      // 20K*0.50 + 20K*2.50 + 50K*0.05 + 20K*0.625 + 10K*1, plus one token, per million.
      expect(estimateTokenCostUsd("claude-haiku-5-5", { ...atThreshold, ...extra })).toBe(0.085);
    });

    it("never counts output tokens toward the prompt", () => {
      // 100K*0.10 + 50K*0.50; counting output would select the higher rates.
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 50_000 })).toBe(0.035);
    });

    it("prices each request on its own, and fails closed for an ambiguous aggregate", () => {
      const request = { inputTokens: 60_000, outputTokens: 10_000 };
      // Two base-rate requests, not one 120K request at the higher rates (0.11).
      expect(estimateTokenCostsUsd("claude-haiku-5-5", [request, request])).toBe(0.022);
      expect(estimateTokenCostUsd("claude-haiku-5-5", { inputTokens: 120_000, outputTokens: 20_000 })).toBe(0.11);
      expect(canPriceTokenUsageAtScope("claude-haiku-5-5", { inputTokens: 120_000, outputTokens: 20_000 }, "aggregate")).toBe(false);
      expect(canPriceTokenUsageAtScope("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 20_000 }, "aggregate")).toBe(true);
      expect(canPriceTokenUsageAtScope("claude-haiku-5-5", { inputTokens: 120_000, outputTokens: 20_000 }, "request")).toBe(true);
    });

    it("keeps an earlier request's rates when a later, mostly cached request crosses the threshold", () => {
      const earlier = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 80_000 };
      const later = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 100_000 };
      // Earlier (90K): 10K*0.10 + 1K*0.50 + 80K*0.01.
      // Later (110K): 10K*0.50 + 1K*2.50 + 100K*0.05.
      expect(estimateTokenCostsUsd("claude-haiku-5-5", [earlier, later])).toBe(0.0148);
    });

    it.each([
      "claude-haiku-5",
      "claude-haiku-5-50",
      "claude-haiku-5-6",
      "claude-haiku-5-5-preview",
      "claude-haiku-5-5-20261001-extra"
    ])("%s stays unpriced instead of inheriting Haiku 5.5 rates", (model) => {
      expect(findPricingRule(model)).toBeUndefined();
      expect(estimateTokenCostUsd(model, usage)).toBeUndefined();
    });
  });

  it("prices the major non-Anthropic/OpenAI model families", () => {
    // Gemini Pro: the 1M-token prompt selects the >200k rate for all tokens
    // (dated before its 2026-12-01 re-billing; see the dated-rates tests).
    expect(estimateTokenCostUsd("gemini-2.5-pro", usage, "2026-11-30")).toBeCloseTo(4, 2);
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
    expect(estimateTokenCostUsd("gemini-2.5-pro", atThreshold, "2026-11-30")).toBe(0.325);
    expect(estimateTokenCostUsd("gemini-2.5-pro", aboveThreshold, "2026-11-30")).toBe(0.59);
  });

  it("prices Gemini 2.5 Pro calls before aggregation", () => {
    const request = { inputTokens: 150_000, outputTokens: 10_000 };
    expect(estimateTokenCostsUsd("gemini-2.5-pro", [request, request], undefined, "2026-11-30")).toBe(0.575);
    expect(estimateTokenCostUsd("gemini-2.5-pro", {
      inputTokens: 300_000,
      outputTokens: 20_000
    }, "2026-11-30")).toBe(1.05);
  });

  // Official Gemini API pricing reviewed 2026-10-18:
  // https://ai.google.dev/gemini-api/docs/pricing
  // "$2.00 through November 30, 2026. $4.00 starting December 1, 2026."
  describe("Gemini 4 Argon dated rates", () => {
    // 100K fresh input, 50K cached, 2K tool prompt, 10K output, 5K thinking.
    const request = {
      inputTokens: 100_000,
      cacheReadTokens: 50_000,
      toolTokens: 2_000,
      outputTokens: 10_000,
      thoughtTokens: 5_000
    };

    it("uses $2 / $10 / $0.10 through 2026-11-30 and $4 / $20 / $0.20 from 2026-12-01 (UTC)", () => {
      // 100K*2 + 50K*0.10 + 2K*2 + 10K*10 + 5K*10, per million; doubled from December.
      expect(estimateTokenCostUsd("gemini-4-argon", request, "2026-10-14T09:00:00.000Z")).toBe(0.359);
      expect(estimateTokenCostUsd("gemini-4-argon", request, "2026-11-30T23:59:59.999Z")).toBe(0.359);
      expect(estimateTokenCostUsd("gemini-4-argon", request, "2026-12-01T00:00:00.000Z")).toBe(0.718);
      expect(estimateTokenCostUsd("gemini-4-argon", request, "2026-12-01")).toBe(0.718);
      expect(estimateTokenCostUsd("GEMINI-4-ARGON", request, "2027-06-01T12:00:00.000Z")).toBe(0.718);
      expect(estimateTokenCostsUsd("gemini-4-argon", [request, request], undefined, "2026-11-30")).toBe(0.718);
    });

    it("bills thinking tokens as output and tool prompt tokens as input, with no prompt-size tier", () => {
      expect(estimateTokenCostUsd("gemini-4-argon", { inputTokens: 0, outputTokens: 0, thoughtTokens: 1_000_000 }, "2026-11-30")).toBe(10);
      expect(estimateTokenCostUsd("gemini-4-argon", { inputTokens: 0, outputTokens: 0, toolTokens: 1_000_000 }, "2026-11-30")).toBe(2);
      expect(usesPromptTieredPricing("gemini-4-argon")).toBe(false);
      expect(estimateTokenCostUsd("gemini-4-argon", { inputTokens: 1_000_000, outputTokens: 0 }, "2026-11-30")).toBe(2);
    });

    it.each([undefined, "", "not-a-date", "11/30/2026"])("never guesses a rate for usage dated %j", (usageAt) => {
      expect(estimateTokenCostUsd("gemini-4-argon", request, usageAt)).toBeUndefined();
      expect(estimateTokenCostsUsd("gemini-4-argon", [request], undefined, usageAt)).toBeUndefined();
      // The model is still known, so it is not reported as missing from the price table.
      expect(findPricingRule("gemini-4-argon")).toBeDefined();
    });

    it.each(["gemini-4", "gemini-4-argon-preview", "gemini-4-argon-001", "gemini-4.1-argon", "models/gemini-4-argon"])(
      "%s stays unpriced",
      (model) => {
        expect(findPricingRule(model)).toBeUndefined();
        expect(estimateTokenCostUsd(model, request, "2026-11-30")).toBeUndefined();
      }
    );

    it.each(["claude-haiku-5-5", "gpt-5.6-terra"])(
      "%s keeps the same price whatever the usage date",
      (model) => {
        const undated = estimateTokenCostUsd(model, usage);
        expect(undated).toBeDefined();
        expect(estimateTokenCostUsd(model, usage, "2026-11-30")).toBe(undated);
        expect(estimateTokenCostUsd(model, usage, "2026-12-01")).toBe(undated);
        expect(estimateTokenCostUsd(model, usage, "not-a-date")).toBe(undated);
      }
    );
  });

  // https://developers.openai.com/api/docs/models/gpt-5.6-sol. Reviewed 2026-11-06;
  // evidence in provider-contracts/model-pricing-2026-11-06.json. "GPT-5.6 Sol's
  // promotional pricing is available until November 30, 2026." OpenAI names no rate
  // for afterwards; the schedule returns to the rates published before the promotion.
  describe("GPT-5.6 Sol dated rates", () => {
    const belowTier = { inputTokens: 100_000, outputTokens: 10_000 };
    const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 };
    const aboveTier = { inputTokens: 272_001, outputTokens: 10_000 };

    it("keeps the promotional $4 / $0.40 / $20 and its long-context tier through 2026-11-30 (UTC)", () => {
      expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, "2026-08-25T09:00:00.000Z")).toBe(0.6);
      expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, "2026-11-30T23:59:59.999Z")).toBe(0.6);
      expect(estimateTokenCostUsd("gpt-5.6-sol", cacheOnly, "2026-11-30")).toBe(0.04);
      // 272,001*8 + 10K*30, per million.
      expect(estimateTokenCostUsd("gpt-5.6-sol", aboveTier, "2026-11-30")).toBe(2.476);
    });

    it("returns to $5 / $0.50 / $30 and $10 / $1 / $45 above 272K from 2026-12-01 (UTC)", () => {
      // 100K*5 + 10K*30, per million.
      expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, "2026-12-01T00:00:00.000Z")).toBe(0.8);
      expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, "2026-12-01")).toBe(0.8);
      expect(estimateTokenCostUsd("GPT-5.6-SOL", belowTier, "2027-06-01T12:00:00.000Z")).toBe(0.8);
      expect(estimateTokenCostUsd("gpt-5.6-sol", cacheOnly, "2026-12-01")).toBe(0.05);
      // 272,001*10 + 10K*45, per million.
      expect(estimateTokenCostUsd("gpt-5.6-sol", aboveTier, "2026-12-01")).toBe(3.17);
      expect(estimateTokenCostsUsd("gpt-5.6-sol", [belowTier, belowTier], undefined, "2026-12-01")).toBe(1.6);
    });

    it("keeps the 272K request tier and its evidence rule on both sides of the change", () => {
      const aggregate = { inputTokens: 300_000, outputTokens: 1 };
      for (const day of ["2026-11-30", "2026-12-01"]) {
        expect(usesPromptTieredPricing("gpt-5.6-sol", day)).toBe(true);
        expect(promptTierThreshold("gpt-5.6-sol", day)).toBe(272_000);
        expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", undefined, day)).toBe(false);
        expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", 272_000, day)).toBe(true);
        expect(canPriceTokenUsageAtScope("gpt-5.6-sol", aggregate, "aggregate", 272_001, day)).toBe(false);
      }
      // A cumulative slice whose largest request stayed base-tier prices at the base rate of its day.
      const cumulative = { inputTokens: 300_000, outputTokens: 10_000 };
      expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [200_000], "2026-11-30")).toBe(1.4);
      expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [200_000], "2026-12-01")).toBe(1.8);
    });

    it.each([undefined, "", "not-a-date", "11/30/2026"])("never guesses a rate for usage dated %j", (usageAt) => {
      expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, usageAt)).toBeUndefined();
      expect(estimateTokenCostsUsd("gpt-5.6-sol", [belowTier], undefined, usageAt)).toBeUndefined();
      // The model is still known, so it is not reported as missing from the price table.
      expect(findPricingRule("gpt-5.6-sol")).toBeDefined();
    });

    it("does not touch the other GPT-5.6 models, which have no promotion", () => {
      for (const model of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
        const undated = estimateTokenCostUsd(model, belowTier);
        expect(undated, model).toBeDefined();
        expect(estimateTokenCostUsd(model, belowTier, "2026-12-01"), model).toBe(undated);
      }
    });
  });

  // https://aistudio.google.com/docs/pricing.md (the Gemini Developer API docs moved
  // there from ai.google.dev). Reviewed 2026-11-04; evidence in
  // provider-contracts/model-pricing-2026-11-04.json. Google deprecated Gemini 2.5
  // Pro: from 2026-12-01 every request to it routes to Gemini 3.8 Flash and bills
  // at 3.8 Flash rates, which have no prompt-size tier and double on 2027-01-01.
  describe("Gemini 2.5 Pro dated rates", () => {
    const small = { inputTokens: 150_000, outputTokens: 10_000 };
    const large = { inputTokens: 300_000, outputTokens: 20_000 };

    it("keeps the published 2.5 Pro rates and its >200K request tier through 2026-11-30 (UTC)", () => {
      expect(estimateTokenCostUsd("gemini-2.5-pro", small, "2026-10-14T09:00:00.000Z")).toBe(0.2875);
      expect(estimateTokenCostUsd("gemini-2.5-pro", large, "2026-11-30T23:59:59.999Z")).toBe(1.05);
      expect(usesPromptTieredPricing("gemini-2.5-pro", "2026-11-30")).toBe(true);
      expect(promptTierThreshold("gemini-2.5-pro", "2026-11-30")).toBe(200_000);
    });

    it("bills at flat Gemini 3.8 Flash rates from 2026-12-01 and at their doubled rates from 2027-01-01", () => {
      // $0.75 / $3.75 / $0.075 per MTok with no tier: the 300K prompt no longer moves the request.
      expect(estimateTokenCostUsd("gemini-2.5-pro", small, "2026-12-01T00:00:00.000Z")).toBe(0.15);
      expect(estimateTokenCostUsd("gemini-2.5-pro", large, "2026-12-01")).toBe(0.3);
      expect(estimateTokenCostUsd("gemini-2.5-pro", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, "2026-12-15")).toBe(0.075);
      expect(estimateTokenCostUsd("gemini-2.5-pro", { inputTokens: 0, outputTokens: 0, thoughtTokens: 1_000_000 }, "2026-12-15")).toBe(3.75);
      expect(usesPromptTieredPricing("gemini-2.5-pro", "2026-12-01")).toBe(false);
      expect(promptTierThreshold("gemini-2.5-pro", "2026-12-01")).toBeUndefined();
      // $1.50 / $7.50 / $0.15 per MTok from 2027-01-01.
      expect(estimateTokenCostUsd("gemini-2.5-pro", small, "2026-12-31T23:59:59.999Z")).toBe(0.15);
      expect(estimateTokenCostUsd("gemini-2.5-pro", small, "2027-01-01T00:00:00.000Z")).toBe(0.3);
      expect(estimateTokenCostUsd("gemini-2.5-pro", large, "2027-01-01")).toBe(0.6);
    });

    it("prices a large aggregate at scope once the tier is gone, and stays conservative when undated", () => {
      expect(canPriceTokenUsageAtScope("gemini-2.5-pro", large, "aggregate")).toBe(false);
      expect(canPriceTokenUsageAtScope("gemini-2.5-pro", large, "aggregate", undefined, "2026-11-30")).toBe(false);
      expect(canPriceTokenUsageAtScope("gemini-2.5-pro", large, "aggregate", undefined, "2026-12-01")).toBe(true);
      expect(usesPromptTieredPricing("gemini-2.5-pro")).toBe(true);
      expect(estimateTokenCostsUsd("gemini-2.5-pro", [small, small], [150_000, 150_000], "2026-12-01")).toBe(0.3);
    });

    it.each([undefined, "", "not-a-date", "11/30/2026"])("never guesses a rate for usage dated %j", (usageAt) => {
      expect(estimateTokenCostUsd("gemini-2.5-pro", small, usageAt)).toBeUndefined();
      expect(estimateTokenCostsUsd("gemini-2.5-pro", [small], undefined, usageAt)).toBeUndefined();
      expect(findPricingRule("gemini-2.5-pro")).toBeDefined();
    });
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
    expect(estimateTokenCostUsd("gpt-5.6-sol", belowTier, solPromotion)!).toBeCloseTo(0.6, 4);
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
    expect(estimateTokenCostUsd("gpt-5.6-sol", cacheOnly, solPromotion)!).toBeCloseTo(0.04, 5);
    expect(estimateTokenCostUsd("gpt-5.6-terra", cacheOnly)!).toBeCloseTo(0.02, 5);
    expect(estimateTokenCostUsd("gpt-5.6-luna", cacheOnly)!).toBeCloseTo(0.002, 5);
    expect(estimateTokenCostUsd("gpt-5.5", cacheOnly)!).toBeCloseTo(0.05, 5);
    expect(estimateTokenCostUsd("gpt-5.4", cacheOnly)!).toBeCloseTo(0.025, 5);
    expect(estimateTokenCostUsd("gpt-5-nano", cacheOnly)!).toBeCloseTo(0.0005, 5);
  });

  it("prices the founder-observed Codex model ids exactly", () => {
    // The two model ids that appear in real Codex transcripts. gpt-5.6-sol
    // carried GPT-5.5's numbers ($5/$30) until 0.9.6, overstating input 25% and
    // output 50% on every OpenAI record during its promotion.
    const oneM = { inputTokens: 1_000_000, outputTokens: 0 };
    const oneMOut = { inputTokens: 0, outputTokens: 1_000_000 };
    expect(estimateTokenCostUsd("gpt-5.6-sol", oneM, solPromotion)).toBe(8);
    expect(estimateTokenCostUsd("gpt-5.6-terra", oneM)).toBe(4);
    // Output-only requests never cross the prompt-size tier, so these are the
    // published short-context output rates.
    expect(estimateTokenCostUsd("gpt-5.6-sol", oneMOut, solPromotion)).toBe(20);
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
      // The pricing page has no row for it.
      "gpt-5.3"
    ]) {
      expect(findPricingRule(model), model).toBeUndefined();
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
    }
  });

  // https://developers.openai.com/api/docs/pricing.md. Reviewed 2026-11-07; evidence in
  // provider-contracts/model-pricing-2026-11-07.json, whose release test checks every row
  // of the two standard tables. These pin what each correction changed.
  describe("OpenAI rows corrected on 2026-11-07", () => {
    const oneM = (component: Partial<TokenUsage>): TokenUsage => ({ inputTokens: 0, outputTokens: 0, ...component });

    it.each([
      ["gpt-5-pro", 15, 120],
      // The dated snapshot OpenAI lists; it took the GPT-5 fallback too.
      ["gpt-5-pro-2025-10-06", 15, 120],
      ["GPT-5-PRO", 15, 120],
      ["gpt-5.2-pro", 21, 168],
      // The dated snapshot OpenAI lists; it took the gpt-5.2 prefix too.
      ["gpt-5.2-pro-2025-12-11", 21, 168],
      ["o3-pro", 20, 80]
    ])("%s uses its own published input and output rates, with no prompt-size tier", (model, input, output) => {
      expect(estimateTokenCostUsd(model, oneM({ inputTokens: 1_000_000 }))).toBe(input);
      expect(estimateTokenCostUsd(model, oneM({ outputTokens: 1_000_000 }))).toBe(output);
      expect(usesPromptTieredPricing(model)).toBe(false);
    });

    it("leaves the rules those rows used to fall through to as they were", () => {
      expect(estimateTokenCostUsd("gpt-5", oneM({ inputTokens: 1_000_000 }))).toBe(1.25);
      expect(estimateTokenCostUsd("gpt-5-2025-08-07", oneM({ outputTokens: 1_000_000 }))).toBe(10);
      expect(estimateTokenCostUsd("gpt-5.2", oneM({ inputTokens: 1_000_000 }))).toBe(1.75);
      expect(estimateTokenCostUsd("gpt-5.2-codex", oneM({ outputTokens: 1_000_000 }))).toBe(14);
      expect(estimateTokenCostUsd("o3", oneM({ inputTokens: 1_000_000 }))).toBe(2);
      expect(estimateTokenCostUsd("o3", oneM({ outputTokens: 1_000_000 }))).toBe(8);
    });

    it.each([
      ["gpt-4o", 1.25],
      ["gpt-4o-mini", 0.075],
      ["gpt-4.1-mini", 0.1],
      ["o3", 0.5]
    ])("%s prices cached input at its published rate, not the 0.1x default", (model, cached) => {
      expect(estimateTokenCostUsd(model, oneM({ cacheReadTokens: 1_000_000 }))).toBe(cached);
    });

    it("prices gpt-5.1 at its published rates, and its -codex and -mini variants keep their own rules", () => {
      expect(estimateTokenCostUsd("gpt-5.1", oneM({ inputTokens: 1_000_000 }))).toBe(1.25);
      expect(estimateTokenCostUsd("gpt-5.1", oneM({ outputTokens: 1_000_000 }))).toBe(10);
      expect(estimateTokenCostUsd("gpt-5.1", oneM({ cacheReadTokens: 1_000_000 }))).toBe(0.125);
      expect(estimateTokenCostUsd("gpt-5.1-codex", usage)).toBeCloseTo(2.25, 2);
      expect(estimateTokenCostUsd("gpt-5.1-mini", usage)).toBeCloseTo(0.45, 2);
    });

    // Both sides of the 272K request tier: a prompt of exactly 272,000 tokens stays on the base
    // rates, and one more token moves the whole request.
    it.each([
      // model, at the threshold, one token over, cached 100K, cached one token over
      // 272000*1 + 10000*5, then 272001*2 + 10000*7.5; 100000*0.05, then 272001*0.10, all per million.
      ["gpt-6.1-terra", 0.322, 0.619, 0.005, 0.0272],
      // 272000*30 + 10000*180, then 272001*60 + 10000*270; cached tokens bill as input: 100000*30, then 272001*60.
      ["gpt-5.5-pro", 9.96, 19.0201, 3, 16.3201]
    ])("%s selects its rates from the 272K request tier, cached tokens included", (model, at, above, cached, cachedAbove) => {
      expect(usesPromptTieredPricing(model)).toBe(true);
      expect(promptTierThreshold(model)).toBe(272_000);
      expect(estimateTokenCostUsd(model, { inputTokens: 272_000, outputTokens: 10_000 })).toBe(at);
      expect(estimateTokenCostUsd(model, { inputTokens: 272_001, outputTokens: 10_000 })).toBe(above);
      expect(estimateTokenCostUsd(model, oneM({ cacheReadTokens: 100_000 }))).toBe(cached);
      expect(estimateTokenCostUsd(model, oneM({ cacheReadTokens: 272_001 }))).toBe(cachedAbove);
    });

    it("selects gpt-5.4-pro's rates from the 272K request tier", () => {
      expect(promptTierThreshold("gpt-5.4-pro")).toBe(272_000);
      // 272000*30 + 10000*180, then 272001*60 + 10000*270, per million.
      expect(estimateTokenCostUsd("gpt-5.4-pro", { inputTokens: 272_000, outputTokens: 10_000 })).toBe(9.96);
      expect(estimateTokenCostUsd("gpt-5.4-pro", { inputTokens: 272_001, outputTokens: 10_000 })).toBe(19.0201);
    });

    it.each(["gpt-6.1-terra", "gpt-5.5-pro", "gpt-5.4-pro"])("%s keeps the evidence rule for aggregates over the tier", (model) => {
      const aggregate = { inputTokens: 300_000, outputTokens: 1 };
      expect(canPriceTokenUsageAtScope(model, aggregate, "aggregate")).toBe(false);
      expect(canPriceTokenUsageAtScope(model, aggregate, "aggregate", 272_000)).toBe(true);
      expect(canPriceTokenUsageAtScope(model, aggregate, "aggregate", 272_001)).toBe(false);
      expect(canPriceTokenUsageAtScope(model, aggregate, "request")).toBe(true);
    });

    // These four rows print a dash for cached input and their pages say nothing more, so the
    // 0.1x default would be a rate nobody published.
    describe.each(["gpt-5-pro", "gpt-5-pro-2025-10-06", "gpt-5.2-pro", "gpt-5.4-pro", "o3-pro"])("%s with no cached rate", (model) => {
      it("is unpriced when usage reports cached tokens, and known to the table", () => {
        const cached = { inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 1 };
        expect(estimateTokenCostUsd(model, cached)).toBeUndefined();
        expect(estimateTokenCostsUsd(model, [{ inputTokens: 1_000, outputTokens: 1_000 }, cached])).toBeUndefined();
        expect(findPricingRule(model)).toBeDefined();
      });

      it("prices usage whose cached count is zero or absent", () => {
        const fresh = { inputTokens: 1_000_000, outputTokens: 0 };
        const rate = estimateTokenCostUsd(model, fresh);
        expect(rate).toBeGreaterThan(0);
        expect(estimateTokenCostUsd(model, { ...fresh, cacheReadTokens: 0 })).toBe(rate);
      });
    });

    it("keeps gpt-5.4-pro unpriced with cached tokens above the tier as well", () => {
      expect(estimateTokenCostUsd("gpt-5.4-pro", { inputTokens: 300_000, outputTokens: 1, cacheReadTokens: 1 })).toBeUndefined();
      expect(estimateTokenCostsUsd("gpt-5.4-pro", [{ inputTokens: 300_000, outputTokens: 1 }], [272_001])).toBe(18.0003);
    });

    it.each([
      // Dated snapshots of the rows that used to be unpriced stay unpriced, as gpt-5.5's and gpt-5.4's do.
      "gpt-5.5-pro-2026-04-23",
      "gpt-5.4-pro-2026-03-05",
      "gpt-5.1-2025-11-13",
      "o3-pro-2025-06-10",
      "gpt-5.5-2026-04-23",
      // Siblings nobody publishes.
      "gpt-6.1-terra-preview",
      "gpt-6.2-terra",
      "gpt-5.5-pro-preview",
      "gpt-5.4-pro-future",
      "gpt-5.1-future",
      "gpt-5.6-pro",
      "gpt-5.3-pro",
      "o3-pro-future",
      "o4-pro"
    ])("%s stays unpriced", (model) => {
      expect(findPricingRule(model)).toBeUndefined();
      expect(estimateTokenCostUsd(model, usage)).toBeUndefined();
    });
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

    expect(estimateTokenCostUsd("gpt-5.6-sol", atThreshold, solPromotion)).toBe(1.288);
    expect(estimateTokenCostUsd("gpt-5.6-sol", aboveThreshold, solPromotion)).toBe(2.476);
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
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [200_000], solPromotion)).toBe(1.4);
    // Threshold is inclusive on the base side (<=272K stays base).
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [272_000], solPromotion)).toBe(1.4);
    // Without evidence the slice's own 300K prompt still selects the 2x tier:
    // 300000*8/1e6 + 10000*30/1e6. Turn-scoped callers are unchanged.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], undefined, solPromotion)).toBe(2.7);
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [undefined], solPromotion)).toBe(2.7);
    // Evidence that a single request DID cross the threshold keeps the 2x tier.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [cumulative], [272_001], solPromotion)).toBe(2.7);
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
      "gpt-5.6-sol", [session], [maxRequestPromptTokens], solPromotion
    )).toBeCloseTo(669.2557, 4);
    // The same day of usage after the promotion: 30_186_579*5 + 2_896_454*30 + 1_226_450_816*0.5.
    expect(estimateTokenCostsUsd(
      "gpt-5.6-sol", [session], [maxRequestPromptTokens], "2026-12-01"
    )).toBeCloseTo(851.0519, 4);
    // Left ungated (no evidence) it would have priced ~2x on the above tier —
    // the dishonest outcome this fix avoids.
    expect(estimateTokenCostsUsd("gpt-5.6-sol", [session], undefined, solPromotion)).toBe(1309.5469);
  });
});
