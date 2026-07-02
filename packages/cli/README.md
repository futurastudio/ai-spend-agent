# ai-spend-agent

**Your AI spend in one view, in 90 seconds — local-first, no signup.**

```bash
npx ai-spend-agent
```

If you use **Claude Code or Codex**, that one command reads the session logs
already on your machine and shows your real usage: total dollars *estimated at
API-equivalent rates*, where the money goes, a ranked "where to cut" list, a
subscription-vs-API **plan check**, and the **dead context** you pay for but
never use (tools/skills/MCP servers loaded on every turn and never invoked).

No logs? You get an instant, clearly-labeled demo on sample data.

## Connect real billing (optional, ~2 min)

```bash
ai-spend-agent connect openai      # org-owner Admin key
ai-spend-agent connect anthropic   # Admin key
```

Billing-API numbers from OpenAI/Anthropic are tagged `verified`; local-log
numbers are always `estimated`; the beta Cursor/Copilot connectors are
`estimated` until reconciled against a real invoice. Every figure carries its
confidence label — that's the product.

## Privacy

Local-first: nothing is uploaded, there is no telemetry, secrets are
redacted from all output and persisted state, and provider keys are only ever
referenced as `env:NAME` — never stored.

## Docs

Full README, MCP server, and connector guides:
**https://github.com/futurastudio/ai-spend-agent#readme**

MIT licensed.
