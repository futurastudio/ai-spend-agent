/**
 * Published per-token API prices used to estimate the
 * API-equivalent dollar value of locally observed usage (e.g. Claude Code /
 * Codex session logs, where the provider never reports a price).
 *
 * Estimates only — always surfaced with costConfidence "estimated". Rules are
 * matched top-down; first match wins. Unknown models return undefined so
 * callers can label the record "missing" instead of inventing a number.
 */
export const PRICING_TABLE_AS_OF = "2026-11-07";

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

type PricingRates = {
  /** USD per million tokens. */
  inputPerM: number;
  outputPerM: number;
  /**
   * Defaults: cache read 0.1x input; 5m cache write 1.25x; 1h write 2x.
   * `null` on cache read: the provider publishes no cached rate for the model and
   * does not say how cached tokens bill, so usage that reports any is unpriced. It
   * never takes the default, which would be a rate nobody published.
   */
  cacheReadPerM?: number | null;
  cacheWrite5mPerM?: number;
  cacheWrite1hPerM?: number;
};

/** Some providers select one rate for the whole request from prompt size. */
type PromptTier = PricingRates & { threshold: number };

/**
 * A published price change. Its rates replace the rule's own for usage on or
 * after `from`, a UTC date (`YYYY-MM-DD`). It carries its own prompt tier, or
 * none when the new rates are flat: a tier never outlives the rates it was
 * published with.
 */
type ScheduledRates = PricingRates & { from: string; abovePromptTokens?: PromptTier };

type PricingRule = PricingRates & {
  match: RegExp;
  abovePromptTokens?: PromptTier;
  /**
   * Published price changes, oldest first. Usage with no date is never priced
   * under a rule that has any.
   */
  scheduledRates?: readonly ScheduledRates[];
};

const pricingRules: PricingRule[] = [
  // Anthropic
  // Reviewed 2026-09-20: platform.claude.com/docs/en/about-claude/pricing.
  // Fable/Mythos 5.1 keep base/write rates; cache reads are $0.25 per MTok.
  { match: /^claude-(?:fable|mythos)-5-1$/i, inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25 },
  { match: /^claude-fable-5/i, inputPerM: 10, outputPerM: 50 },
  { match: /^claude-mythos-5/i, inputPerM: 10, outputPerM: 50 },
  // Reviewed 2026-10-06: platform.claude.com/docs/en/about-claude/pricing.
  // Opus 5.5 has lower base/write rates and a 5% cache-read rate.
  { match: /^claude-opus-5-5$/i, inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 },
  { match: /^claude-opus-5/i, inputPerM: 5, outputPerM: 25 },
  // Reviewed 2026-10-08: https://platform.claude.com/docs/en/about-claude/pricing.
  // Retained evidence: provider-contracts/model-pricing-2026-10-08.json.
  // Sonnet 5.5 keeps base/write rates; exact and dated IDs use 5% cache reads.
  { match: /^claude-sonnet-5-5(?:-\d{8})?$/i, inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 },
  { match: /^claude-sonnet-5/i, inputPerM: 2, outputPerM: 10 },
  // Reviewed 2026-10-18: https://platform.claude.com/docs/en/about-claude/pricing.
  // Retained evidence: provider-contracts/model-pricing-2026-10-18.json.
  // Haiku 5.5 is priced per request by prompt length: a prompt over 100,000
  // tokens, counting cache reads and writes, moves the whole request to the
  // higher rates. Exact and dated IDs only; other Haiku 5 IDs stay unpriced.
  {
    match: /^claude-haiku-5-5(?:-\d{8})?$/i,
    inputPerM: 0.1, outputPerM: 0.5,
    cacheReadPerM: 0.01, cacheWrite5mPerM: 0.125, cacheWrite1hPerM: 0.2,
    abovePromptTokens: {
      threshold: 100_000,
      inputPerM: 0.5, outputPerM: 2.5,
      cacheReadPerM: 0.05, cacheWrite5mPerM: 0.625, cacheWrite1hPerM: 1
    }
  },
  { match: /^claude-opus-4-[5-9]/i, inputPerM: 5, outputPerM: 25 },
  // Exact and dated IDs of Opus 4 and 4.1: the deprecations page lists claude-opus-4-20250514
  // and claude-opus-4-1-20250805. Both models are retired; older transcripts still carry them.
  { match: /^claude-opus-4(-[01])?(-\d{8})?$/i, inputPerM: 15, outputPerM: 75 },
  { match: /^claude-sonnet-4/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-haiku-4/i, inputPerM: 1, outputPerM: 5 },
  { match: /^claude-3-7-sonnet|^claude-3-5-sonnet/i, inputPerM: 3, outputPerM: 15 },
  { match: /^claude-3-5-haiku/i, inputPerM: 0.8, outputPerM: 4 },
  // Standard API-equivalent prices reviewed 2026-10-07. Evidence and scope:
  // provider-contracts/model-pricing-2026-10-07.json. Exact IDs only.
  {
    match: /^gpt-6-astra$/i,
    inputPerM: 10, outputPerM: 50, cacheReadPerM: 1,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 20, outputPerM: 75, cacheReadPerM: 2
    }
  },
  {
    match: /^gpt-6\.1-sol$/i,
    inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.2
    }
  },
  // Reviewed 2026-11-07: developers.openai.com/api/docs/pricing.md. Retained
  // evidence: provider-contracts/model-pricing-2026-11-07.json.
  {
    match: /^gpt-6\.1-terra$/i,
    inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.05,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 2, outputPerM: 7.5, cacheReadPerM: 0.1
    }
  },
  {
    match: /^gpt-6-sol$/i,
    inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 4, outputPerM: 15, cacheReadPerM: 0.4
    }
  },
  {
    match: /^gpt-6-luna$/i,
    inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 0.2, outputPerM: 0.75, cacheReadPerM: 0.02
    }
  },
  // OpenAI (newer and more specific families must precede the GPT-5 fallback).
  // Rates from developers.openai.com/api/docs/pricing cross-checked against each
  // model's own doc page, both fetched 2026-08-25.
  //
  // GPT-5.6 ships exactly three API models — sol, terra, luna
  // (developers.openai.com/api/docs/models, 2026-08-25). Each 5.6/5.5/5.4 rule
  // below is END-ANCHORED on purpose: an undocumented or future sibling
  // (gpt-5.6-cyber, gpt-5.7-sol) must fall through to
  // honest-unpriced rather than inherit a neighbour's rate. That is the 0.9.4
  // `^kimi-k2` mistake one family up, and it is the expensive direction here —
  // the pre-0.9.6 `^gpt-5.6(?:-sol)?$` rule carried GPT-5.5's numbers, so every
  // gpt-5.6-sol record was overstated by 25% on input and 50% on output.
  //
  // Long context, published identically on all three 5.6 pages plus 5.5/5.4:
  // "Prompts with >272K input tokens are priced at 2x input and 1.5x output for
  // the full request." Cached input scales with the 2x input leg.
  {
    // developers.openai.com/api/docs/models/gpt-5.6-sol, 2026-08-25.
    // Reviewed 2026-11-06. Retained evidence:
    // provider-contracts/model-pricing-2026-11-06.json. $4 / $0.40 / $20 are
    // promotional: "available until November 30, 2026" (it read "at least
    // through November 21" until November 2026). OpenAI names no rate for
    // afterwards, so the schedule returns to the rates published before the
    // promotion, $5 / $0.50 / $30, which are also what its stated 20% input and
    // 33% output reductions give. OpenAI names no time zone and "until" does not
    // settle November 30 itself: that day stays promotional, and the change
    // applies from the next UTC day, as usage is bucketed. The later rates are an
    // inference, not a published price: the evidence names a re-check by
    // 2026-12-01, and a release test goes red the next day until it is done.
    match: /^gpt-5\.6-sol$/i,
    inputPerM: 4,
    outputPerM: 20,
    cacheReadPerM: 0.4,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 8,
      outputPerM: 30,
      cacheReadPerM: 0.8
    },
    scheduledRates: [
      {
        from: "2026-12-01",
        inputPerM: 5,
        outputPerM: 30,
        cacheReadPerM: 0.5,
        abovePromptTokens: {
          threshold: 272_000,
          inputPerM: 10,
          outputPerM: 45,
          cacheReadPerM: 1
        }
      }
    ]
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
  {
    // developers.openai.com/api/docs/pricing.md, reviewed 2026-11-07. The cached
    // column is a dash, and the model page says "does not offer a cached input
    // discount": a cached token costs what an uncached one costs, in either tier.
    match: /^gpt-5\.5-pro$/i,
    inputPerM: 30,
    outputPerM: 180,
    cacheReadPerM: 30,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 60,
      outputPerM: 270,
      cacheReadPerM: 60
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
  {
    // developers.openai.com/api/docs/pricing.md, reviewed 2026-11-07. This row and
    // gpt-5.2-pro, gpt-5-pro and o3-pro print a dash for cached input, and their
    // pages say nothing more, so no cached rate is assumed (see `cacheReadPerM`).
    match: /^gpt-5\.4-pro$/i,
    inputPerM: 30,
    outputPerM: 180,
    cacheReadPerM: null,
    abovePromptTokens: {
      threshold: 272_000,
      inputPerM: 60,
      outputPerM: 270,
      cacheReadPerM: null
    }
  },
  { match: /^gpt-5\.3-codex/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  // Before the gpt-5.2 prefix below, which priced this model and its dated snapshot
  // at 1/12 of the published rates until the 2026-11-07 review.
  { match: /^gpt-5\.2-pro(?:-|$)/i, inputPerM: 21, outputPerM: 168, cacheReadPerM: null },
  { match: /^gpt-5\.2(?:-codex)?/i, inputPerM: 1.75, outputPerM: 14, cacheReadPerM: 0.175 },
  { match: /^gpt-5\.1$/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  // developers.openai.com/api/docs/models/gpt-5.1-codex-mini, reviewed 2026-11-07. A prefix
  // on the rule below priced this model at 5x its published rates until that review.
  { match: /^gpt-5\.1-codex-mini$/i, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  // The IDs OpenAI prices at these rates, and no others: gpt-5-codex-mini is named on the
  // deprecations page and no page prints a rate for it, so it counts as missing.
  { match: /^gpt-5-codex$|^gpt-5\.1-codex(?:-max)?$/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-5(?:\.1)?-mini/i, inputPerM: 0.25, outputPerM: 2, cacheReadPerM: 0.025 },
  // developers.openai.com/api/docs/models/gpt-5-nano, 2026-08-25. Before 0.9.6
  // this fell through to the ^gpt-5 fallback and billed at $1.25/$10 — 25x the
  // real rate in both directions. No published long-context tier.
  { match: /^gpt-5-nano/i, inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },
  // Before the fallback below, which priced this model and its dated snapshot at
  // 1/12 of the published rates until the 2026-11-07 review.
  { match: /^gpt-5-pro(?:-|$)/i, inputPerM: 15, outputPerM: 120, cacheReadPerM: null },
  // GPT-5 base, its snapshot and the two variants OpenAI prices at the same rates. Named IDs
  // only, so this cannot swallow a family it knows nothing about: gpt-5.7-*, gpt-5.6-cyber,
  // any future gpt-5.6-<variant> and any other gpt-5-<variant> return undefined -> "missing"
  // instead of silently billing at GPT-5's $1.25/$10.
  { match: /^gpt-5(?:-2025-08-07|-chat-latest|-search-api)?$/i, inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.125 },
  { match: /^gpt-4\.1-nano/i, inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.025 },
  { match: /^gpt-4\.1-mini/i, inputPerM: 0.4, outputPerM: 1.6, cacheReadPerM: 0.1 },
  { match: /^gpt-4\.1/i, inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  // developers.openai.com/api/docs/pricing.md, reviewed 2026-11-07. These two rules were
  // prefixes, so they also priced IDs OpenAI bills differently or prints no such rate for:
  // realtime at 2x to 4x these rates, gpt-4o-mini-tts and -transcribe, and the audio and
  // search previews. Those count as missing now. So does gpt-4o-2024-05-13, the snapshot
  // the page no longer lists: OpenAI's pricing page of 2026-04-26 printed it at $5 / $15
  // with no cached rate, not at these rates.
  { match: /^gpt-4o-mini(?:-2024-07-18)?$/i, inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },
  { match: /^gpt-4o(?:-2024-08-06|-2024-11-20)?$/i, inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25 },
  { match: /^o3-pro$/i, inputPerM: 20, outputPerM: 80, cacheReadPerM: null },
  { match: /^o3$/i, inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5 },
  // developers.openai.com/api/docs/models/o4-mini, reviewed 2026-11-07. Named IDs only:
  // o4-mini-deep-research bills at other rates and counts as missing.
  { match: /^o4-mini(?:-2025-04-16)?$/i, inputPerM: 1.1, outputPerM: 4.4, cacheReadPerM: 0.275 },
  // Google (Gemini API list prices)
  // Reviewed 2026-10-18: https://ai.google.dev/gemini-api/docs/pricing.
  // Retained evidence: provider-contracts/model-pricing-2026-10-18.json.
  // Gemini 4 Argon is paid-tier only, with one input rate for every modality
  // and no prompt-size tier. Thinking tokens bill as output; caching is
  // implicit only. Google doubles every rate from 2026-12-01 without naming
  // a time zone, so the change applies from that UTC day, as usage is bucketed.
  {
    match: /^gemini-4-argon$/i,
    inputPerM: 2,
    outputPerM: 10,
    cacheReadPerM: 0.1,
    scheduledRates: [{ from: "2026-12-01", inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2 }]
  },
  // Reviewed 2026-11-04: https://aistudio.google.com/docs/pricing.md (the Gemini
  // Developer API docs moved there from ai.google.dev). Retained evidence:
  // provider-contracts/model-pricing-2026-11-04.json. Gemini 2.5 Pro is
  // deprecated: effective 2026-12-01 every request to it routes to Gemini 3.8
  // Flash and is billed at 3.8 Flash rates, which have no prompt-size tier and
  // double on 2027-01-01. Google names no time zone, so each change applies
  // from its UTC day, as usage is bucketed. Through 2026-11-30 the published
  // 2.5 Pro rates and its >200K-token request tier still apply.
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
    },
    scheduledRates: [
      { from: "2026-12-01", inputPerM: 0.75, outputPerM: 3.75, cacheReadPerM: 0.075 },
      { from: "2027-01-01", inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 }
    ]
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
  // - bare gpt-5.3: the pricing page has no row for it. Its -codex and -mini
  //   variants keep their own verified rules above.
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
 *
 * @param usageAt ISO timestamp or UTC date of the usage. A model whose
 *   published rates change on a date is priced only when this is given.
 */
export function estimateTokenCostUsd(
  model: string,
  usage: TokenUsage,
  usageAt?: string
): number | undefined {
  const usd = rawTokenCostUsd(model, usage, undefined, usageAt);
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
 *
 * `usageAt`, the ISO timestamp or UTC date shared by every slice, selects the
 * rates in force that day for a model whose published prices change on a
 * date; such a model is unpriced without it.
 */
export function estimateTokenCostsUsd(
  model: string,
  usages: readonly TokenUsage[],
  tierPromptTokens?: readonly (number | undefined)[],
  usageAt?: string
): number | undefined {
  let total = 0;
  for (let index = 0; index < usages.length; index += 1) {
    const usd = rawTokenCostUsd(model, usages[index], tierPromptTokens?.[index], usageAt);
    if (usd === undefined) return undefined;
    total += usd;
  }
  return roundUsd(total);
}

/**
 * Whether this model's rate selection depends on each request's prompt size.
 * `usageAt` selects the rates in force on the usage's UTC day; without it, a
 * model whose published tier ends on a date is still treated as tiered.
 */
export function usesPromptTieredPricing(model: string, usageAt?: string): boolean {
  return promptTierThreshold(model, usageAt) !== undefined;
}

/**
 * Prompt-size threshold for tiered request pricing, when one is published for
 * the usage's day (see `usesPromptTieredPricing`).
 */
export function promptTierThreshold(model: string, usageAt?: string): number | undefined {
  const rule = findPricingRule(model);
  return rule ? promptTierOn(rule, usageAt)?.threshold : undefined;
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
  maxRequestPromptTokens?: number,
  usageAt?: string
): boolean {
  const threshold = promptTierThreshold(model, usageAt);
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
 * @param usageAt ISO timestamp or UTC date of the usage; selects scheduled rates.
 */
function rawTokenCostUsd(
  model: string,
  usage: TokenUsage,
  tierPromptTokens?: number,
  usageAt?: string
): number | undefined {
  const rule = findPricingRule(model);
  if (!rule) {
    return undefined;
  }
  const dated = ratesOn(rule, usageAt);
  if (!dated) {
    return undefined;
  }
  const promptTokens = tierPromptTokens ?? effectivePromptTokens(usage);
  const tier = dated.abovePromptTokens;
  const rates: PricingRates = tier && promptTokens > tier.threshold ? tier : dated;
  if (rates.cacheReadPerM === null && (usage.cacheReadTokens ?? 0) > 0) {
    return undefined;
  }
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

/**
 * The rule's rates in force on the usage's UTC date. A rule with scheduled
 * price changes returns undefined without a usable date, so a rate is never
 * guessed across a published change.
 */
function ratesOn(rule: PricingRule, usageAt: string | undefined): PricingRule | ScheduledRates | undefined {
  if (!rule.scheduledRates) return rule;
  // ISO timestamps here are UTC; this is the same day the report buckets by.
  const day = usageAt?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  let rates: PricingRule | ScheduledRates = rule;
  for (const change of rule.scheduledRates) {
    if (day >= change.from) rates = change;
  }
  return rates;
}

/**
 * The prompt tier in force on the usage's day: a dated change's own tier once
 * one applies, otherwise the rule's. Without a usable date the rule's tier
 * stands, so undated aggregate checks stay conservative.
 */
function promptTierOn(rule: PricingRule, usageAt: string | undefined): PromptTier | undefined {
  const dated = ratesOn(rule, usageAt);
  return dated ? dated.abovePromptTokens : rule.abovePromptTokens;
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
