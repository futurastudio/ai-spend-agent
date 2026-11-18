# Provider contract review: November 18, 2026

The scheduled provider contract monitor has reported drift on every run since November 9 and holds twelve open issues (#151, #152, #154 to #163). All nineteen registered pages were re-read on November 18, between 20:30 and 21:30 UTC, against the copies reviewed on November 6. Eighteen changed; the Gemini CLI session page did not.

One claim the estimator depends on moved: Anthropic replaced Claude Fable 5.1 with Claude Fable 5.2 at the top of its model table, at lower rates. The price table follows that page since #164. This review updates the markers that pin the page, so the monitor can see the next change to those lines. Two pricing pages also list new models the estimator did not price at this review; usage on a model with no rule counts as missing, never as another model's price.

## Changes supported by the review

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) (#151). Anthropic released Claude Fable 5.2 and Claude Mythos 5.2 on November 9.
  - Before, top row: "Claude Fable 5.1 For demanding reasoning and long-horizon agentic work $10 / MTok $50 / MTok $12.50 / MTok $20 / MTok $0.25 / MTok".
  - Now, top row: "Claude Fable 5.2 For demanding reasoning and long-horizon agentic work $8 / MTok $40 / MTok $10 / MTok $16 / MTok $0.20 / MTok".
  - Additional models gained "Claude Mythos 5.2 $8 / MTok $40 / MTok $10 / MTok $16 / MTok $0.20 / MTok". Claude Fable 5.1 moved there at the rates it had, beside Claude Mythos 5.1.
  - The cache-hit sentence became a table: "Claude Fable 5.2 and Claude Mythos 5.2 0.025x $0.20 USD", "Claude Fable 5.1 and Claude Mythos 5.1 0.025x $0.25 USD", "Claude Opus 5.5 0.05x $0.20 USD", "Claude Sonnet 5.5 0.05x $0.10 USD", "All other models 0.1x".
  - Batch: Claude Fable 5.2 "$4 / MTok $20 / MTok". Fast mode: "Claude Fable 5.2 $16 USD / MTok $80 USD / MTok", the same for Claude Mythos 5.2, and fast mode is "deprecated for Claude Opus 4.8". The estimator applies neither Batch nor fast mode.
  - All twenty rows of the model table and both Claude Haiku 5.5 prompt-length rows match the estimator for input, output, both cache writes and cache reads.
  - Markers: the Claude Fable 5.1 top row and the cache-hit sentence, both gone from the page, are replaced by the Claude Fable 5.2 row, a Claude Mythos 5.2 marker, a window over Claude Mythos 5.2's rates and the moved Claude Fable 5.1 row, a window over the Claude Mythos 5.1 row, and the two cache-hit table rows for the 5.2 and 5.1 models.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing.md) (#154). The standard table now opens with two new models, above `gpt-6-astra`:
  - "| gpt-6.2-astra | $8.00 | $40.00 | $0.40 | $10.00 | $20.00 | $16.00 | $60.00 | $0.80 | $20.00 | $40.00 |"
  - "| gpt-6.2-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |"
  - Every row the estimator prices is unchanged, including GPT-5.6 Sol's promotion, which still ends November 30, 2026. At this review the estimator did not price `gpt-6.2-astra` or `gpt-6.2-sol`.
  - Also new: ultrafast pricing for the two GPT-6.2 models ("3 times the standard rate through February 28, 2027, and 6 times the standard rate starting March 1, 2027"), lower GPT-6 Rosalind rates ($10.00 / $50.00 / $1.00, was $15.00 / $75.00 / $1.50), long-context rows for `gpt-6-astra-law` and a new `gpt-6.2-astra-law`, and a FedRAMP note for Rosalind. Earlier in the month the specialized models moved into one grouped table, `gpt-5.5-cyber` became `gpt-5.5-cyber-preview`, `gpt-6-cyber` gained a long-context row, and the data-residency sentence lost the words "that are eligible for data residency". None of these is a row the estimator prices.
- [Gemini Developer API pricing](https://aistudio.google.com/docs/pricing.md) (#155). Every reviewed rate and date is unchanged: Gemini 2.5 Pro, Gemini 3.8 Flash and Gemini 4 Argon, with their dated changes. New sections, none priced by the estimator at this review:
  - Gemini 4 Carbon: "$2.00 through November 30, 2026. $4.00 starting December 1, 2026" input, "$10.00" then "$20.00" output, "$0.10" then "$0.20" caching.
  - Gemini 4 Hydrogen: "$1.50" input, "$7.50" output, "$0.075" caching.
  - Gemini 4 Neon (added on November 18): "$3.00" input, "$15.00" output, "$0.15" caching, paid tier only.
  - Gemini Decision 1: "$0.10" input and no output tokens.
  - Contributor-tier tabs were removed from Gemini 3.8 Flash, 3.5 Flash-Lite and 3.1 Pro Preview, and the page's agent-context header lists new links.

## Compatible reviewed surfaces

- [OpenAI usage reference](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) (#156). Re-rendered on November 13: the space before each comma in an object's field list is gone ("{ data , has_more" is now "{ data, has_more"). No endpoint, field or type changed.
- GPT-5.6 Sol, Terra and Luna: prices, the promotion's end date, long-context and cache-write rules are unchanged. Navigation changed.
- [Anthropic Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) (#157). Every heading lost its anchor icon, which moved the marker windows. "The Admin API isn't available to organizations on the Claude.ai Team plan or to individual Claude Console accounts" replaces "unavailable for individual accounts". A new section on Claude Enterprise organizations says they use an Analytics API key with these endpoints; that for them the usage endpoint "leaves out usage from some Claude products, so its totals can be lower than the organization's usage"; and that the cost endpoint, "with a starting_at on or after October 1, 2025", covers usage-based charges across Claude products but not seat fees. The CLI reads the cost report and the Claude Code usage report with a Claude Console organization's Admin API key, and neither endpoint changed for those organizations.
- [Usage and Cost Analytics API](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api) (#158). The migration section now covers Claude Enterprise organizations, for which this API returns null `workspace_id` and `api_key_id` and can count more usage than the legacy usage report. The CLI does not read this API.
- Anthropic cost report, messages usage and Claude Code usage references (#159, #160, #161). Heading icons and navigation; the beta-header list on the first two gained `user-profiles-billing-2026-10-01` and lists deprecated values last. The CLI sends `anthropic-version: 2023-06-01` and no beta header.
- [Claude Enterprise Analytics API](https://platform.claude.com/docs/en/manage-claude/analytics-api) (#162). The key-type paragraph was rewritten: an Analytics API key now works with the Usage and Cost Analytics API and the legacy Usage and Cost API, where it used to say the analytics API was the one exception. The CLI implements no endpoint of this contract.
- [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api) (#163). Additions: a `product` filter and field (`grok-bot` or `cursor`) on filtered usage events, Bugbot fields (`prAuthor`, `repo`, `prNumber`), a new `GET /v2/teams/billing-items` endpoint, and "This endpoint doesn't split spend by product" on `/teams/spend`. The fields the CLI reads from `POST /teams/spend` are unchanged.
- [Cursor models and pricing](https://cursor.com/docs/models-and-pricing). The model table lists Claude Fable 5.2 ($8, $10, $0.2, $40) in place of Claude Fable 5.1, and adds Gemini 4 Carbon and Gemini 4 Hydrogen. Every reviewed plan and Cursor Token Rate marker is present.
- The Cloud Billing export page changed its "Last updated" date and one navigation entry. The GitHub REST billing and Copilot billing pages changed only in navigation.

## Re-pin

Eighteen pages are re-pinned from fetches on November 18, each equal to the copy that was read. Six of them changed only in navigation and were re-pinned under the standing OK for content-only moves; the other twelve moved a marker window or a figure. `reviewedAt` is 2026-11-18. The Anthropic pricing page is the only one whose markers changed.

No connector, rate or estimate changes in this review.
