# Provider contract review: October 6, 2026

Launch candidate `7bc50efa` failed ordinary CI because the September 20 review exceeded the unchanged fourteen-day cadence. All fourteen registered official resources were fetched successfully and reviewed before refreshing the registry date and fingerprints. The complete URLs and hashes remain in `provider-contracts/v1.json` and the generated contract documentation. Previous page bodies were not retained, so changed full-page hashes are not classified wholesale as formatting changes.

## Corrections supported by the review

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) reordered its table columns. Existing Fable/Mythos 5 and 5.1, Opus 5, and Sonnet 5 prices remain compatible. Opus 5.5 previously matched the broad Opus 5 fallback incorrectly. An exact `claude-opus-5-5` rule now uses $4 input, $20 output, $0.20 cache read, $5 five-minute cache write, and $8 one-hour cache write per million tokens. The [model overview](https://platform.claude.com/docs/en/models/opus-5-5/overview) confirms the identifier. These remain API-equivalent estimates, not subscription charges.
- The [Enterprise Analytics guide](https://platform.claude.com/docs/en/manage-claude/analytics-api) now permits revisions through approximately seven days after calendar-month end. The [organization cost reference](https://platform.claude.com/docs/en/api/http/beta/organization/analytics/cost_report/list) still says approximately thirty days after usage. The registry records this discrepancy and retains provisional status. It also records the documented query bounds and top-100 grouped-result limitation. Enterprise remains contract-only and untested.
- [Claude Code analytics](https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api) freshness is distinguished from the faster Usage/Cost surfaces.
- The [Cursor aggregate implementation](https://cursor.com/docs/account/teams/admin-api) converts cents directly and uses a separate same-cycle dashboard/invoice verification path. The registry no longer implies that unimplemented event-detail reconciliation precedes that conversion.
- GitHub authentication now distinguishes [organization Administration read](https://docs.github.com/en/rest/billing/usage) from [enterprise billing read](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage). This matches the existing connector guidance; no authentication behavior changed.

## Compatible reviewed surfaces

OpenAI's implemented Usage/Costs fields, cursor pagination, inclusive start/exclusive end, and GPT-5.6 Sol/Terra/Luna estimates remain compatible. Sol's pricing promotion is currently documented through at least November 21, 2026; the ordinary review cadence still applies. Newly documented fields do not expand implemented coverage.

The Gemini session page retains its exact prior fingerprint. Supported Gemini 2.5 Pro prices, prompt threshold, and thinking-token treatment remain compatible. Cloud Billing export evidence remains separate from local estimates. Cursor's provider amounts and GitHub's AI-credit amounts retain their existing scope and financial bases. Model, plan, and endpoint additions do not establish additional integration coverage.

## Verification boundary

Only public official documentation was fetched. No provider credentials, account endpoints, customer records, or paid operations were used. Existing validation targets and runtime contract states are unchanged. Structural tests use controlled dates relative to the reviewed date; the release checker still enforces the real clock and unchanged cadence. The exact-model pricing assertions extend the existing Claude 5 test.

The remote documentation check completed at `2026-10-06T05:10:31.482Z` with all fourteen resources current and no failures. All nine contract tests, seventeen model-pricing tests, generated-output checks, core typecheck, and whitespace checks passed. These checks do not establish live provider acceptance or website runtime acceptance.
