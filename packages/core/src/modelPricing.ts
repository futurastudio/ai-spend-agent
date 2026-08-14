/**
 * Published per-token API prices used to estimate the
 * API-equivalent dollar value of locally observed usage (e.g. Claude Code /
 * Codex session logs, where the provider never reports a price).
 *
 * Estimates only — always surfaced with costConfidence "estimated". Rules are
 * matched top-down; first match wins. Unknown models return undefined so
 * callers can label the record "missing" instead of inventing a number.
 */
export const PRICING_TABLE_AS_OF = "2026-08-14";

export type TokenUsage = {
  /** Billable, uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** Explicit reasoning/thought tokens, priced on the output side when supported. */
  thoughtTokens?: number;
  /** Explicit tool prompt tokens, priced on the input side when supported. */
  toolTokens?: number;
};

type PricingRule = {
  match: RegExp;
  /** USD per million tokens. */
  inputPerM: number;
  outputPerM: number;
  /** Defaults: cache read 0.1x input; 5m cache write 1.25x; 1h write 2x. */
  cacheReadPerM?: number;
  cacheWrite5mPerM?: number;
  cacheWrite1hPerM?: number;
  /** Some providers select one rate for the whole request from prompt size. */
  abovePromptTokens?: {
    threshold: number;
    inputPerM: number;
    outputPerM: number;
    cacheReadPerM?: number;
    cacheWrite5mPerM?: number;
    cacheWrite1hPerM?: number;
  };
};

const pricingRules: PricingRule[] = [
  // Anthropic
  { match: /^claude-fable-5/i, inputPerM: 10, outputPerM: 50 },
  { match: /^claude-mythos-5/i, inputPerM: 10, outputPerM: 50 },
  { match: /^claude-opus-5/i, inputPerM: 5, outputPerM: 25 },
  { match: /^claude-sonnet-5/i, inputPerM: 2, outputPerM: 10 },
  { match: /^claude-opus-4-[5-9]/i, inputPerM: 5, outputPerM: 25 },
  { match: /^claude-opus-4(-[01])?$/i, inputPerM: 15, outputPerM: 75 },
  { match: /^claude-sonnet-4/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-haiku-4/i, inputPerM: 1, outputPerM: 5 },
  { match: /^claude-3-7-sonnet|^claude-3-5-sonnet/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-3-5-haiku/i, inputPerM: 0.8, outputPerM: 4 },
  // OpenAI (newer and more specific families must precede the GPT-5 fallback)
  {
    match: /^gpt-5\.6(?:-sol)?$/i,
    inputPerM: 5,
    outputPerM: 30,
    cacheReadPerM: 0.5,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 10,
      outputPerM: 45,
      cacheReadPerM: 1
    }
  },
  {
    match: /^gpt-5\.6-terra/i,
    inputPerM: 2,
    outputPerM: 12,
    cacheReadPerM: 0.2,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 4,
      outputPerM: 18,
      cacheReadPerM: 0.4
    }
  },
  {
    match: /^gpt-5\.6-luna/i,
    inputPerM: 0.2,
    outputPerM: 1.2,
    cacheReadPerM: 0.02,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 0.4,
      outputPerM: 1.8,
      cacheReadPerM: 0.04
    }
  },
  { match: /^gpt-5\.5(?:-codex)?/i, inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  { match: /^gpt-5\.4-mini/i, inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
  { match: /^gpt-5\.4-nano/i, inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
  { match: /^gpt-5\.4/i, inputPerM: 2.5, outputPerM: 15, cacheReadPerM: 0.25 },
  { match: /^gpt-5\.3-codex/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  { match: /^gpt-5\.2(?:-codex)?/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  { match: /^gpt-5(?:\.1)?-codex/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-5(?:\.1)?-mini/i, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  { match: /^gpt-5/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-4\.1-nano/i, inputPerM: 0.1, outputPerM: 0.4 },
  { match: /^gpt-4\.1-mini/i, inputPerM: 0.4, outputPerM: 1.6 },
  { match: /^gpt-4\.1/i, inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  { match: /^gpt-4o-mini/i, inputPerM: 0.15, outputPerM: 0.6 },
  { match: /^gpt-4o/i, inputPerM: 2.5, outputPerM: 10 },
  { match: /^o3$/i, inputPerM: 2, outputPerM: 8 },
  { match: /^o4-mini/i, inputPerM: 1.1, outputPerM: 4.4 },
  // Google (Gemini API list prices)
  {
    match: /^gemini-2\.5-pro$/i,
    inputPerM: 1.25,
    outputPerM: 10,
    cacheReadPerM: 0.125,
    abovePromptTokens: {
      threshold: 200_000,
      inputPerM: 2.5,
      outputPerM: 15,
      cacheReadPerM: 0.25
    }
  },
  // Gemini CLI's persisted Flash/Flash-Lite summary does not retain token
  // modality, while published audio and non-audio input/cache rates differ.
  // Until modality is explicit, returning undefined is safer than silently
  // applying the text/image/video rate to a potentially multimodal request.
  // DeepSeek (official API list prices)
  { match: /^deepseek-chat|^deepseek-v3/i, inputPerM: 0.27, outputPerM: 1.1 },
  { match: /^deepseek-reasoner|^deepseek-r1/i, inputPerM: 0.55, outputPerM: 2.19 },
  // Moonshot / Kimi (official API list prices)
  { match: /^kimi-k2|^moonshot/i, inputPerM: 0.6, outputPerM: 2.5 },
  // xAI / Grok (official API list prices)
  { match: /^grok-4|^grok-3$/i, inputPerM: 3, outputPerM: 15 },
  { match: /^grok-3-mini/i, inputPerM: 0.3, outputPerM: 0.5 },
  // Open-weight models with NO canonical price (llama, qwen, mistral, glm):
  // hosting rates vary several-fold by provider, so we deliberately return
  // undefined -> costConfidence "missing" instead of inventing a number.
];

export function findPricingRule(model: string): PricingRule | undefined {
  return pricingRules.find((rule) => rule.match.test(model));
}

/**
 * API-equivalent USD for a usage slice, or undefined when the model has no
 * published price we recognize.
 */
export function estimateTokenCostUsd(model: string, usage: TokenUsage): number | undefined {
  const usd = rawTokenCostUsd(model, usage);
  return usd === undefined ? undefined : roundUsd(usd);
}

/**
 * Price request-scoped usage before aggregating it. This is required for
 * models whose entire request moves to a higher rate above a prompt-size
 * threshold; pricing a daily token sum would incorrectly treat many small
 * requests as one large request.
 */
export function estimateTokenCostsUsd(
  model: string,
  usages: readonly TokenUsage[]
): number | undefined {
  let total = 0;
  for (const usage of usages) {
    const usd = rawTokenCostUsd(model, usage);
    if (usd === undefined) return undefined;
    total += usd;
  }
  return roundUsd(total);
}

/** Whether this model's rate selection depends on each request's prompt size. */
export function usesPromptTieredPricing(model: string): boolean {
  return promptTierThreshold(model) !== undefined;
}

/** Prompt-size threshold for tiered request pricing, when one is published. */
export function promptTierThreshold(model: string): number | undefined {
  return findPricingRule(model)?.abovePromptTokens?.threshold;
}

/**
 * Tiered prices are selected per request, never from a multi-request sum.
 * An aggregate is still unambiguous when its entire non-negative prompt-side
 * total is at or below the threshold; then no constituent request can have
 * crossed it. Larger aggregates fail closed until request-level evidence is
 * available.
 */
export function canPriceTokenUsageAtScope(
  model: string,
  usage: TokenUsage,
  scope: "request" | "aggregate"
): boolean {
  const threshold = promptTierThreshold(model);
  if (threshold === undefined || scope === "request") return true;
  return effectivePromptTokens(usage) <= threshold;
}

function rawTokenCostUsd(model: string, usage: TokenUsage): number | undefined {
  const rule = findPricingRule(model);
  if (!rule) {
    return undefined;
  }
  const promptTokens = effectivePromptTokens(usage);
  const rates = rule.abovePromptTokens &&
      promptTokens > rule.abovePromptTokens.threshold
    ? rule.abovePromptTokens
    : rule;
  const cacheRead = rates.cacheReadPerM ?? rates.inputPerM * 0.1;
  const write5m = rates.cacheWrite5mPerM ?? rates.inputPerM * 1.25;
  const write1h = rates.cacheWrite1hPerM ?? rates.inputPerM * 2;
  const usd =
    (usage.inputTokens * rates.inputPerM +
      usage.outputTokens * rates.outputPerM +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWrite5mTokens ?? 0) * write5m +
      (usage.cacheWrite1hTokens ?? 0) * write1h +
      (usage.thoughtTokens ?? 0) * rates.outputPerM +
      (usage.toolTokens ?? 0) * rates.inputPerM) /
    1_000_000;
  return usd;
}

function effectivePromptTokens(usage: TokenUsage): number {
  return usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0) +
    (usage.toolTokens ?? 0);
}

function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
