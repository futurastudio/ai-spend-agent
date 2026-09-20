# Provider contract review: September 20, 2026

Release candidate `6adcb9ee2e3598c40bfb8fbac0a7fa740bdd80f9` failed the exact-ref documentation gate. All fourteen official resources were fetched and reviewed before updating their full-content and marker-window fingerprints. The checker and its fail-closed behavior are unchanged. Previous full page bodies were not retained, so this review does not classify every hash change as formatting.

## Changes affecting estimates or contract descriptions

- [OpenAI Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) lists estimated API-equivalent rates of $4 input, $0.40 cached input, and $20 output per million tokens. The local pricing rule already matches; the required documentation marker was outdated. The advertised promotion has a limited duration and remains subject to subsequent review.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) lists Fable 5.1 and Mythos 5.1 cache reads at $0.25 per million tokens. An exact model rule now precedes the older family fallback, which otherwise estimated $1. Input, output, and cache-write rates are unchanged. These are estimated API-equivalent amounts, not subscription charges. The rule records this review date separately from the older overall table date.
- [Anthropic Usage and Cost](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) documents additional authentication options and excludes Claude Platform on AWS. The implemented connector still uses a Console organization Admin API key; Enterprise Analytics keys remain separate.
- Enterprise Analytics freshness now records the documented typical four-hour refresh, possible 24-hour delay, and revisions for up to 30 days. Incomplete tails remain incomplete.

## Other reviewed surfaces

OpenAI Usage/Costs and Terra/Luna pricing remain compatible with the implemented fields and estimates. Cursor Admin spending retains provider-reported amounts and its distinction between on-demand and included usage. GitHub organization AI-credit usage retains its organization scope and monetary conversion. Google Cloud billing-export and Gemini session contracts remain compatible; Gemini 2.5 Pro pricing is unchanged. Newly documented models and endpoints do not imply newly implemented coverage.

The complete official resource links, required markers, and reviewed fingerprints are recorded in `provider-contracts/v1.json` and generated in `docs/sources/provider-contracts.md`. No provider account endpoint, credential, or customer record was used for this review.

## Validation

The refreshed remote documentation check reports no failures across fourteen resources. Existing model-pricing tests pass, and direct checks of the production estimator confirm the new cache rate while preserving the older family fallback. The release still requires green ordinary CI and a green exact-ref release gate on the final merged commit before publication.
