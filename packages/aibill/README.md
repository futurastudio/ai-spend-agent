# aibill

The short npm command for
[ai-spend-agent](https://github.com/futurastudio/ai-spend-agent).

```bash
npx aibill
npx aibill init
npx aibill statusline install # optional Claude Code cache-only status line
```

It runs the exact same local-first financial-accountability CLI as
`npx ai-spend-agent`: connect supported coding-agent work to cost evidence,
attribution, runway, and one next action. See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) for data
semantics, supported providers, privacy boundaries, and limitations.

The optional status line uses the same plan-aware evidence vocabulary while
reading only a private aggregate cache. Bare init does not change Claude
settings, and `npx aibill statusline uninstall` restores the prior user value.

Connector validation (`live_verified`, `fixture_verified`, `untested`, or
`failed`) and each number's financial evidence (`verified`, `estimated`,
`detected_unverified`, or `missing`) are separate status axes. Run `npx aibill
doctor --sources` to see both. aibill never sits in the inference path and never stores, prints, or proxies provider credentials.

**Telemetry: anonymous command counts, disclosed at first run.** Your
transcripts, prompts, file names, and dollar amounts stay on your machine. The
CLI separately counts *which* commands run — anonymous, never your arguments,
paths, content, or your email — and only after a one-time notice has been
printed on an interactive run. One command turns it off: `aibill telemetry off`
(or `DO_NOT_TRACK`, `CI`, or `AI_SPEND_NO_TELEMETRY`). Full scope:
[`docs/TELEMETRY.md`](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/TELEMETRY.md).

MIT licensed.
