import { describe, expect, it } from "vitest";
import { estimateTokenCostUsd, findPricingRule } from "./modelPricing.js";

const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };

describe("model pricing coverage", () => {
  it("prices the major non-Anthropic/OpenAI model families", () => {
    // Gemini: 1.25 + 0.1×10 = $2.25
    expect(estimateTokenCostUsd("gemini-2.5-pro", usage)).toBeCloseTo(2.25, 2);
    expect(estimateTokenCostUsd("gemini-2.5-flash", usage)).toBeCloseTo(0.55, 2);
    // DeepSeek
    expect(estimateTokenCostUsd("deepseek-chat", usage)).toBeCloseTo(0.38, 2);
    expect(estimateTokenCostUsd("deepseek-reasoner", usage)).toBeCloseTo(0.769, 2);
    // Kimi / Moonshot
    expect(estimateTokenCostUsd("kimi-k2-instruct", usage)).toBeCloseTo(0.85, 2);
    // Grok
    expect(estimateTokenCostUsd("grok-4", usage)).toBeCloseTo(4.5, 2);
    expect(estimateTokenCostUsd("grok-3-mini", usage)).toBeCloseTo(0.35, 2);
  });

  it("returns undefined for open-weight models with no canonical price — never invents a number", () => {
    for (const model of ["llama-4-maverick", "qwen3-coder", "mistral-large", "glm-4.5", "totally-unknown-model"]) {
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
      expect(findPricingRule(model), model).toBeUndefined();
    }
  });

  it("keeps codex fallback below the specific families (rule order)", () => {
    // "codex" substring must not shadow specific model matches.
    expect(estimateTokenCostUsd("gpt-5.5-codex", usage)!).toBeCloseTo(2.25, 2);
  });
});
