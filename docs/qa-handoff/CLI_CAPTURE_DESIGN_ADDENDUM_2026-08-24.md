# CLI Capture Design — placement addendum (2026-08-24)

Founder decision, final on placement. This addendum supersedes §2 row 1
("First real receipt exit") of `CLI_CAPTURE_DESIGN.md` and the placement
(Variant A/B) analysis of `CLI_CAPTURE_QA_VERDICT.md`. Every other mechanic
of the design and every B/M fix of the verdict remains binding. (This file
lives beside the code because the original design doc is kept in the private
working tree; paste this block into `CLI_CAPTURE_DESIGN.md` there.)

## Placement: pre-receipt, DURING the first evidence scan

On a qualifying first run (interactive TTY, not CI, no `AI_SPEND_NO_PROMPT`,
real receipt path only — never sample / `--group-by` / `--json` / named
commands — and signup state permits the once-ever ask):

1. The evidence pipeline starts async. The CLI immediately prints
   `reading your local AI evidence…`, a blank line, then the standout ask
   block: a receipt-convention full-width rule, the headline, and
   `type your email, or press Enter to skip`, with a `  > ` prompt.
2. The headline is date-gated: through launch day (until
   `2026-08-29T00:00:00Z`) it reads `aibill launches Friday with Star.fun.`
   / `Get the launch email + what ships next:`; afterwards the evergreen
   `Get product updates:` — the launch line can never go stale.
3. The prompt runs concurrently with the scan. The receipt renders when
   BOTH the answer (or skip / timeout / Ctrl-C) and the pipeline resolve.
   The receipt's own bytes are untouched.
4. READY-NUDGE: if the pipeline resolves while the ask is still open, one
   line prints — `your receipt is ready — type your email, or press Enter
   to see it` — and the same prompt stays open (no timer reset).
5. Consent (scope line `used only for updates · never shared`, the literal
   payload JSON, `[y/N]`, single POST) renders strictly AFTER the receipt;
   it never interleaves mid-receipt.
6. Subsequent runs: no ask, no wait-line change — the fast path is
   byte-identical (state is checked before any output).

## Skip ceiling (non-negotiable floor for the user)

Skip = TWO empty Enters. The first prints exactly one declarative nudge
(`one launch email · Enter again to skip, or type your email`); the second
completes the skip and counts as ONE lifetime skip (two lifetime skips or
`n` = never again, unchanged). Any typed input after the first Enter is
treated as the email answer; `n`/`never` keep their meaning at any point.
Timeout and Ctrl-C consume no skip and still show the receipt.

**This is the founder-approved ceiling: no further skip friction may ever
be added, and removal of skip is refused by design.** The copy kill-list
(no urgency, no confirm-shaming, no hype vocabulary) still binds every
string on this surface and is enforced by test.

## Email deliverability (added with this placement)

After format validation: MX lookup with A-record fallback
(`node:dns/promises`, 1.5s budget). Only a provable cannot-receive domain
(`that domain can't receive email — check the spelling`) or a
disposable-inbox domain from a small static blocklist (`use an address you
actually check`) re-prompts — re-prompts never consume skips, and DNS
timeouts or resolver trouble NEVER block capture (format-only fallback).
Re-prompts are budgeted (6 rejections) and end silently with no skip.
