# ai-spend-agent

The full [aibill](https://github.com/futurastudio/ai-spend-agent) CLI.

```bash
npx aibill init
npx aibill statusline install # optional Claude Code cache-only status line
npx ai-spend-agent
# short alias
npx aibill
```

Run `npx aibill init` from a project to detect machine-wide Claude Code, Codex,
and experimental Gemini CLI financial evidence, print the first
evidence-labeled personal receipt, and seed a private Claude/Codex aggregate
cache under `~/.aibill/cache/`. Gemini financial rows come only from
`~/.gemini/tmp/<opaque-project-id>/chats/**/*.{json,jsonl}`; `logs.json` is a
presence signal and never a financial source. Init never replaces missing personal
evidence with the bundled sample and never overwrites existing connected
source or audit state.

The optional status line is explicit and reversible. It installs a standalone
Node-builtins-only runner at Claude user scope, rereads only the private
aggregate cache, and never scans transcripts or contacts a provider from the
hook. Subscription runway appears only when it was transcript-reported; `~`
means API-equivalent value, and untilded `billed` money requires verified
provider evidence. Remove it with `npx aibill statusline uninstall`.

It reads supported local Claude Code, Codex, and Gemini CLI financial metadata,
labels API-equivalent estimates, and can optionally add official OpenAI or
Anthropic provider-reported cost
through an environment-variable reference. No product telemetry is sent.
aibill never sits in the inference path and never stores, prints, or proxies provider credentials.

Connector validation (`live_verified`, `fixture_verified`, `untested`, or
`failed`) and each number's financial evidence (`verified`, `estimated`,
`detected_unverified`, or `missing`) are separate status axes. Run `npx aibill
doctor --sources` to see both with freshness and the last sanitized error.
The source registry also records read-boundary approval separately; an approved
local folder is permission to scan, not verified financial evidence.

See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) for commands,
privacy boundaries, supported sources, and public-beta limitations.

MIT licensed.
