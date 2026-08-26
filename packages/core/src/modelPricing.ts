/**
 * Published per-token API prices used to estimate the
 * API-equivalent dollar value of locally observed usage (e.g. Claude Code /
 * Codex session logs, where the provider never reports a price).
 *
 * Estimates only — always surfaced with costConfidence "estimated". Rules are
 * matched top-down; first match wins. Unknown models return undefined so
 * callers can label the record "missing" instead of inventing a number.
 */
export const PRICING_TABLE_AS_OF = "2026-08-25";

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
  // OpenAI (newer and more specific families must precede the GPT-5 fallback).
  // Rates from developers.openai.com/api/docs/pricing cross-checked against each
  // model's own doc page, both fetched 2026-08-25.
  //
  // GPT-5.6 ships exactly three API models — sol, terra, luna
  // (developers.openai.com/api/docs/models, 2026-08-25). Each 5.6/5.5/5.4 rule
  // below is END-ANCHORED on purpose: an undocumented or future sibling
  // (gpt-5.6-cyber, gpt-5.5-pro, gpt-5.7-sol) must fall through to
  // honest-unpriced rather than inherit a neighbour's rate. That is the 0.9.4
  // `^kimi-k2` mistake one family up, and it is the expensive direction here —
  // the pre-0.9.6 `^gpt-5.6(?:-sol)?$` rule carried GPT-5.5's numbers, so every
  // gpt-5.6-sol record was overstated by 25% on input and 50% on output.
  //
  // Long context, published identically on all three 5.6 pages plus 5.5/5.4:
  // "Prompts with >272K input tokens are priced at 2x input and 1.5x output for
  // the full request." Cached input scales with the 2x input leg.
  {
    // developers.openai.com/api/docs/models/gpt-5.6-sol, 2026-08-25
    match: /^gpt-5\.6-sol$/i,
    inputPerM: 4,
    outputPerM: 20,
    cacheReadPerM: 0.4,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 8,
      outputPerM: 30,
      cacheReadPerM: 0.8
    }
  },
  {
    // developers.openai.com/api/docs/models/gpt-5.6-terra, 2026-08-25
    match: /^gpt-5\.6-terra$/i,
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
    // developers.openai.com/api/docs/models/gpt-5.6-luna, 2026-08-25
    match: /^gpt-5\.6-luna$/i,
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
  {
    // developers.openai.com/api/docs/models/gpt-5.5, 2026-08-25
    match: /^gpt-5\.5$/i,
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
  // gpt-5.5-codex bills at the 5.5 base rate but is absent from the published
  // long-context list, so it deliberately carries no >272K tier.
  { match: /^gpt-5\.5-codex$/i, inputPerM: 5, outputPerM: 30, cacheReadPerM: 0.5 },
  { match: /^gpt-5\.4-mini/i, inputPerM: 0.75, outputPerM: 4.5, cacheReadPerM: 0.075 },
  { match: /^gpt-5\.4-nano/i, inputPerM: 0.2, outputPerM: 1.25, cacheReadPerM: 0.02 },
  {
    // developers.openai.com/api/docs/models/gpt-5.4, 2026-08-25
    match: /^gpt-5\.4$/i,
    inputPerM: 2.5,
    outputPerM: 15,
    cacheReadPerM: 0.25,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 5,
      outputPerM: 22.5,
      cacheReadPerM: 0.5
    }
  },
  { match: /^gpt-5\.3-codex/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  { match: /^gpt-5\.2(?:-codex)?/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  { match: /^gpt-5(?:\.1)?-codex/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-5(?:\.1)?-mini/i, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  // developers.openai.com/api/docs/models/gpt-5-nano, 2026-08-25. Before 0.9.6
  // this fell through to the ^gpt-5 fallback and billed at $1.25/$10 — 25x the
  // real rate in both directions. No published long-context tier.
  { match: /^gpt-5-nano/i, inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
  // GPT-5 base and its dash-suffixed snapshots only. The `-|$` boundary stops
  // this fallback from swallowing dot-minor families it knows nothing about:
  // gpt-5.7-*, gpt-5.6-cyber and any future gpt-5.6-<variant> now return
  // undefined -> "missing" instead of silently billing at GPT-5's $1.25/$10.
  { match: /^gpt-5(?:-|$)/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
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
  // Moonshot / Kimi (official list prices, platform.kimi.ai/docs/pricing/*,
  // fetched 2026-08-25; cache-hit input is a distinct published rate). Order
  // matters: k2.7-code-highspeed before its k2.7-code prefix, dot families
  // before the legacy K2 rule.
  // ^kimi-k3 also covers the Anthropic-style "kimi-k3[1m]" context suffix.
  { match: /^kimi-k3/i, inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
  { match: /^kimi-k2\.7-code-highspeed/i, inputPerM: 1.9, outputPerM: 8, cacheReadPerM: 0.38 },
  { match: /^kimi-k2\.7-code/i, inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.19 },
  { match: /^kimi-k2\.6/i, inputPerM: 0.95, outputPerM: 4, cacheReadPerM: 0.16 },
  // Legacy K2 (kimi-k2, kimi-k2-*) and moonshot-v1-* (sunset 2026-08-31 —
  // still prices past transcripts). Deliberately does NOT match the dot
  // families above: 0.9.3's `^kimi-k2` prefix silently priced kimi-k2.7-code
  // at these old K2 rates (~$0.60/$2.50 vs the real $0.95/$4.00).
  { match: /^kimi-k2(?:$|-)|^moonshot/i, inputPerM: 0.6, outputPerM: 2.5 },
  // xAI / Grok (official API list prices)
  { match: /^grok-4|^grok-3$/i, inputPerM: 3, outputPerM: 15 },
  { match: /^grok-3-mini/i, inputPerM: 0.3, outputPerM: 0.5 },
  // Open-weight models with NO canonical price (llama, qwen, mistral, glm):
  // hosting rates vary several-fold by provider, so we deliberately return
  // undefined -> costConfidence "missing" instead of inventing a number.
  //
  // Deliberate deferrals (2026-08-25 CN-provider review), same honest path:
  // - First-party Qwen commercial models (qwen3.x-max/plus/flash): the
  //   canonical Model Studio price list is console-gated and aggregator
  //   numbers have been wrong for this vendor family before — no rule until
  //   a canonical price is verified.
  // - deepseek-v4-* (api-docs.deepseek.com/quick_start/pricing): published
  //   rates are time-of-day (off-peak = half price, up to 2x swing), so any
  //   flat number here would be dishonest; needs timestamp-aware pricing.
  //
  // Deliberate deferrals (2026-08-25 OpenAI review), same honest path:
  // - gpt-5.6-cyber / gpt-5.5-cyber ($12.50/$1.25/$75 on the pricing page):
  //   the two canonical sources disagree on whether the >272K tier applies —
  //   the pricing page omits cyber from its long-context list while
  //   developers.openai.com/api/docs/models/gpt-5.6-cyber states the 2x/1.5x
  //   rule does apply. Access is gated behind the Daybreak program, so the
  //   cost of leaving it unpriced is near zero and a coin-flip on the tier
  //   would be a real number that is wrong on long requests.
  // - gpt-5.5-pro / gpt-5.4-pro: listed as long-context-capable but no
  //   per-model rate is published on either canonical source.
  // - bare gpt-5.1 / gpt-5.3: the pricing page quotes the 5/5.1/5.2 group as a
  //   RANGE ($1.25-$1.75) and neither has a resolved per-model figure. Their
  //   -codex and -mini variants keep their own verified rules above.
  // - gpt-5.6-codex / gpt-5.5-mini: NOT OpenAI model ids (both 404 on the model
  //   docs and are absent from developers.openai.com/api/docs/models). They
  //   appear only in this repo's fixtures and sample CSVs.
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
 *
 * `tierPromptTokens[i]`, when provided, fixes the tier of `usages[i]` from
 * request-level evidence instead of the slice's own prompt total. A
 * session-cumulative slice is a sum of many requests whose prompt total
 * routinely clears a per-request threshold on cache reads alone, even though no
 * single request did; supplying the largest single request's prompt keeps such
 * a slice on the base tier (and pricing it there is exact, since the base rate
 * distributes over the sum). Omitting the array preserves single-request
 * behaviour: each slice's own prompt selects its tier.
 */
export function estimateTokenCostsUsd(
  model: string,
  usages: readonly TokenUsage[],
  tierPromptTokens?: readonly (number | undefined)[]
): number | undefined {
  let total = 0;
  for (let index = 0; index < usages.length; index += 1) {
    const usd = rawTokenCostUsd(model, usages[index], tierPromptTokens?.[index]);
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
 * crossed it. It is also unambiguous when request-level evidence
 * (`maxRequestPromptTokens`, the largest single request the aggregate contains)
 * proves that no constituent request crossed the threshold: every request was
 * base-tier, so the whole sum is base-tier and prices exactly at the base rate.
 * Larger aggregates without such evidence fail closed to keep an unpriceable
 * total honestly "missing" rather than guessing a tier.
 */
export function canPriceTokenUsageAtScope(
  model: string,
  usage: TokenUsage,
  scope: "request" | "aggregate",
  maxRequestPromptTokens?: number
): boolean {
  const threshold = promptTierThreshold(model);
  if (threshold === undefined || scope === "request") return true;
  if (effectivePromptTokens(usage) <= threshold) return true;
  return maxRequestPromptTokens !== undefined && maxRequestPromptTokens <= threshold;
}

/**
 * @param tierPromptTokens Prompt size used ONLY to select the request tier,
 *   when it differs from the priced slice's own prompt total (e.g. a
 *   session-cumulative slice whose tier is fixed by its largest single
 *   request). Component pricing always uses `usage`; defaults to the slice's
 *   own effective prompt so single-request callers are unchanged.
 */
function rawTokenCostUsd(
  model: string,
  usage: TokenUsage,
  tierPromptTokens?: number
): number | undefined {
  const rule = findPricingRule(model);
  if (!rule) {
    return undefined;
  }
  const promptTokens = tierPromptTokens ?? effectivePromptTokens(usage);
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
