/**
 * Published per-token API prices (mid-2026) used to estimate the
 * API-equivalent dollar value of locally observed usage (e.g. Claude Code /
 * Codex session logs, where the provider never reports a price).
 *
 * Estimates only — always surfaced with costConfidence "estimated". Rules are
 * matched top-down; first match wins. Unknown models return undefined so
 * callers can label the record "missing" instead of inventing a number.
 */
export type TokenUsage = {
  /** Billable, uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
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
};

const pricingRules: PricingRule[] = [
  // Anthropic
  { match: /^claude-fable-5/i, inputPerM: 10, outputPerM: 50 },
  { match: /^claude-opus-4-[5-9]/i, inputPerM: 5, outputPerM: 25 },
  { match: /^claude-opus-4(-[01])?$/i, inputPerM: 15, outputPerM: 75 },
  { match: /^claude-sonnet-4/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-haiku-4/i, inputPerM: 1, outputPerM: 5 },
  { match: /^claude-3-7-sonnet|^claude-3-5-sonnet/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-3-5-haiku/i, inputPerM: 0.8, outputPerM: 4 },
  // OpenAI (codex CLI models first — more specific)
  { match: /^gpt-5(\.\d+)?-codex/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-5(\.\d+)?-mini/i, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  { match: /^gpt-5/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-4\.1-nano/i, inputPerM: 0.1, outputPerM: 0.4 },
  { match: /^gpt-4\.1-mini/i, inputPerM: 0.4, outputPerM: 1.6 },
  { match: /^gpt-4\.1/i, inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  { match: /^gpt-4o-mini/i, inputPerM: 0.15, outputPerM: 0.6 },
  { match: /^gpt-4o/i, inputPerM: 2.5, outputPerM: 10 },
  { match: /^o3$/i, inputPerM: 2, outputPerM: 8 },
  { match: /^o4-mini/i, inputPerM: 1.1, outputPerM: 4.4 },
  { match: /codex/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 }
];

export function findPricingRule(model: string): PricingRule | undefined {
  return pricingRules.find((rule) => rule.match.test(model));
}

/**
 * API-equivalent USD for a usage slice, or undefined when the model has no
 * published price we recognize.
 */
export function estimateTokenCostUsd(model: string, usage: TokenUsage): number | undefined {
  const rule = findPricingRule(model);
  if (!rule) {
    return undefined;
  }
  const cacheRead = rule.cacheReadPerM ?? rule.inputPerM * 0.1;
  const write5m = rule.cacheWrite5mPerM ?? rule.inputPerM * 1.25;
  const write1h = rule.cacheWrite1hPerM ?? rule.inputPerM * 2;
  const usd =
    (usage.inputTokens * rule.inputPerM +
      usage.outputTokens * rule.outputPerM +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWrite5mTokens ?? 0) * write5m +
      (usage.cacheWrite1hTokens ?? 0) * write1h) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}
