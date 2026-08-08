# aibill

The short npm command for
[ai-spend-agent](https://github.com/futurastudio/ai-spend-agent).

```bash
npx aibill
```

It runs the exact same local-first financial-accountability CLI as
`npx ai-spend-agent`: connect supported coding-agent work to cost evidence,
attribution, runway, and one next action. See the repository
[README](https://github.com/futurastudio/ai-spend-agent#readme) for data
semantics, supported providers, privacy boundaries, and limitations.

Connector validation (`live_verified`, `fixture_verified`, `untested`, or
`failed`) and each number's financial evidence (`verified`, `estimated`,
`detected_unverified`, or `missing`) are separate status axes. Run `npx aibill
doctor --sources` to see both. aibill never sits in the inference path and never stores, prints, or proxies provider credentials.

MIT licensed.
