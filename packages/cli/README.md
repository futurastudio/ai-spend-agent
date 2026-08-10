# ai-spend-agent

The full [aibill](https://github.com/futurastudio/ai-spend-agent) CLI.

```bash
npx aibill init
npx ai-spend-agent
# short alias
npx aibill
```

Run `npx aibill init` from a project to detect machine-wide local Claude Code
and Codex history, print the first evidence-labeled personal receipt, and seed a private
aggregate cache under `~/.aibill/cache/`. Init never replaces missing personal
evidence with the bundled sample and never overwrites existing connected
source or audit state.

It reads local Claude Code and Codex metadata, labels API-equivalent estimates,
and can optionally add official OpenAI or Anthropic provider-reported cost
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
