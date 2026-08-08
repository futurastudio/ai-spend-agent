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
    for (const model of [
      "llama-4-maverick",
      "qwen3-coder",
      "mistral-large",
      "glm-4.5",
      "totally-unknown-model",
      "codex-auto-review",
      "my-codex-wrapper"
    ]) {
      expect(estimateTokenCostUsd(model, usage), model).toBeUndefined();
      expect(findPricingRule(model), model).toBeUndefined();
    }
  });

  it("uses current published prices for recent GPT families before fallbacks", () => {
    expect(estimateTokenCostUsd("gpt-5.6-sol", usage)!).toBeCloseTo(8, 2);
    expect(estimateTokenCostUsd("gpt-5.6-terra", usage)!).toBeCloseTo(4, 2);
    expect(estimateTokenCostUsd("gpt-5.6-luna", usage)!).toBeCloseTo(1.6, 2);
    expect(estimateTokenCostUsd("gpt-5.5-codex", usage)!).toBeCloseTo(8, 2);
    expect(estimateTokenCostUsd("gpt-5.4", usage)!).toBeCloseTo(4, 2);
    expect(estimateTokenCostUsd("gpt-5.4-mini", usage)!).toBeCloseTo(1.2, 2);
    expect(estimateTokenCostUsd("gpt-5.4-nano", usage)!).toBeCloseTo(0.325, 3);
    expect(estimateTokenCostUsd("gpt-5.3-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.2-codex", usage)!).toBeCloseTo(3.15, 2);
    expect(estimateTokenCostUsd("gpt-5.1-codex", usage)!).toBeCloseTo(2.25, 2);
  });
});
