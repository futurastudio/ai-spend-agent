# Provider contract review: November 22, 2026

The scheduled provider contract monitor holds eight open issues: #159 to #161 for three Anthropic reference pages, #168 to #171 for four OpenAI pages, and the digest #152. All nineteen registered pages were re-read on November 22 against the copies reviewed on November 18. Twelve changed; seven did not.

No rate, field or rule the CLI depends on moved. Every change is formatting, site navigation, guidance the CLI does not read, or a model the estimator does not price. This review re-pins the twelve pages and replaces one marker on each of the three GPT-5.6 model pages, so that a change to OpenAI's site navigation stops opening pricing alerts. It also adds one marker to OpenAI's pricing page, on the GPT-6.2 Astra row.

## What moved, page by page

### Pages whose marker windows moved

- [Anthropic cost report reference](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve) (#159). The example response is rendered differently: each key now has a space on either side inside its quotation marks, which moves every marker window that covers the example. Of 36 changed passages, 34 differ in spacing only. The other two are a new navigation entry, Claude Code, and one new value in the list of beta headers, `ce-claude-code-managed-settings-2026-10-06`. The result fields and their order are the same.
- [Anthropic messages usage reference](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages) (#160). The same three changes: 46 of 48 changed passages differ in spacing only, plus the navigation entry and the beta header value. The same fields.
- [Anthropic Claude Code usage reference](https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_claude_code) (#161). 102 of 103 changed passages differ in spacing only; the other is the navigation entry. The same fields.
  - The CLI sends `anthropic-version: 2023-06-01` and no beta header, and reads these responses as JSON, where the spacing of a rendered example means nothing.
- GPT-5.6 [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) and [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) model pages (#169, #170, #171). Site navigation only: the header lost its search label, gained a language selector and relabelled its theme control, and a sidebar list of cookbook articles dropped three entries. On each page the rates, the long-context rule (2x input and 1.5x output above 272K input tokens) and the cache-write rule (1.25x) are unchanged. On the Sol page the promotion still reads "promotional pricing is available until November 30, 2026".

### Pages that changed outside every marker window

- [OpenAI usage reference](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) (#168). The same header change as the model pages. No endpoint, field or type changed.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing.md). Every row the estimator prices is unchanged, and so is the GPT-5.6 Sol promotion line. Two changes, neither applied by the estimator:
  - A note under the flex table says flex stays available on the listed models while its beta winds down, will not be added to new models, and has no retirement date yet. The estimator applies standard rates only, never flex.
  - The gpt-live table now has two columns, an active rate and a standby rate, and a new `gpt-live-1.1` row: $0.05 a minute active and $0.02 a minute standby for both `gpt-live-1.1` and `gpt-live-1`, where the table used to give `gpt-live-1` one price of $0.05 a minute. The sentence under it now says only that voice sessions are billed per second. The estimator does not price gpt-live.
- [Gemini Developer API pricing](https://aistudio.google.com/docs/pricing.md). Every reviewed rate and date is unchanged. New, and not priced by the estimator:
  - A Genie 4 section, paid tier only: $1.50 input, $9.00 text output and $17.50 video output per million tokens.
  - A tool retrieval row with no separate charge; the tool list and loaded schemas are charged as input tokens at the model's rate.
- [Cloud Billing export to BigQuery](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery). New guidance on restricting access to exported data by project (authorized views and row-level security), a note that a billing account has one destination dataset per export type, and a new "Last updated" date, 2026-11-19. Every marker window, which is where the reviewed schema and timing claims sit, is unchanged.
- [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api). Usage events gained an optional `pricing.contractedByComponent` object, which splits the contracted cost by meter and sums to `pricing.contracted`. The CLI reads only `POST /teams/spend`, which did not change.
- [Cursor models and pricing](https://cursor.com/docs/models-and-pricing). The model table added Gemini 4 Neon ($3 input, $0.15 cache read, $15 output), and its US data residency column now reads Yes for Gemini 3.8 Flash, Gemini 4 Argon, Gemini 4 Carbon and Gemini 4 Hydrogen. Every reviewed plan, Cursor Token Rate and data residency marker window is unchanged. The CLI keeps Cursor's spend as Cursor reports it and reprices nothing from this table.

### Unchanged pages

The Anthropic Usage and Cost API guide, the Usage and Cost Analytics API guide, Anthropic pricing, the Claude Enterprise Analytics API, the Gemini CLI session page, and the GitHub REST billing and Copilot billing pages all match their November 18 pins.

## Marker replacements on the GPT-5.6 model pages

A marker's claim is the text from 120 characters before its first match to 240 characters after it. The first marker on each GPT-5.6 page was the model's display name, whose first match is the page title at character 0, so its window held the site header and nothing about the model. Each change to OpenAI's navigation therefore opened three pricing alerts, which read at a glance like a real price change.

| Page | Marker before | Marker now | First match (of page length) |
| --- | --- | --- | --- |
| GPT-5.6 Sol | `GPT-5.6 Sol` | `Snapshots gpt-5.6-sol` | 15,852 of 16,481 |
| GPT-5.6 Terra | `GPT-5.6 Terra` | `Snapshots gpt-5.6-terra` | 15,602 of 16,235 |
| GPT-5.6 Luna | `GPT-5.6 Luna` | `Snapshots gpt-5.6-luna` | 15,761 of 16,397 |

Each new marker matches once, in the page body: its window runs from the end of the supported-tools list, through the snapshot list and the cloud provider model ids, to the opening of the rate-limits section. It still identifies the page as that model's, and it moves if OpenAI adds a dated snapshot or a provider model id. None of the new windows differs between the November 18 copies and today's pages, so this navigation change would not have opened the three pricing alerts. The other markers on each page (the rates line, the promotion line on Sol, the long-context rule and the cache-write rule) are unchanged and already sat in the body.

## Marker added on the OpenAI pricing page

The CLI has priced `gpt-6.2-astra` and `gpt-6.2-sol` since #167, but eight of the ten figures on the GPT-6.2 Astra standard row sat outside every marker window: the windows around the table heading and the `gpt-6-astra` row left characters 486 to 656 unwatched, and the row starts at 572. The new marker, `| gpt-6.2-astra | $8.00 | $40.00 | $0.40 |`, matches once, at character 572 in the standard table (the batch, fast and ultrafast tables repeat the model name with other rates), and its window covers both GPT-6.2 rows whole, so all 162 figures in the two standard tables now sit inside a window. The page itself is the copy pinned above; only its semantic fingerprint changes.

## Dated follow-up: GPT-5.6 Sol on December 1, 2026

The GPT-5.6 Sol promotion ends on November 30, 2026, and OpenAI still names no rate for afterwards. The price table schedules $5 input, $0.50 cached input and $30 output per million tokens from 2026-12-01, the rates published before the promotion. That is an inference, not a published price. The model page and the pricing page must be re-read on 2026-12-01, and the table and its evidence corrected if OpenAI prints anything else; a release test fails from 2026-12-02 until that re-check is recorded.

## Re-pin

Twelve pages are re-pinned from fetches on November 22 at about 21:25 UTC, each equal to the copy that was read. Six changed only outside their marker windows. Six have a new semantic fingerprint: the three Anthropic references, whose windows moved, and the three GPT-5.6 pages, whose first marker was replaced. `reviewedAt` is 2026-11-22. No claim text changed. Markers changed on four pages: the three GPT-5.6 pages and, by the one addition, OpenAI's pricing page, whose semantic fingerprint is new for that reason alone.

No connector, rate or estimate changes in this review.
