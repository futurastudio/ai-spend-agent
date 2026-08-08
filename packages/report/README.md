# @agent-finops/report

Terminal, Markdown, HTML, and redacted receipt renderers for
[aibill](https://github.com/futurastudio/ai-spend-agent).

The package renders contracts from `@agent-finops/core`; it does not parse
agent transcripts or invent a second cost model. It keeps source/connector
validation (`live_verified`, `fixture_verified`, `untested`, or `failed`)
separate from a number's financial evidence (`verified`, `estimated`,
`detected_unverified`, or `missing`). Modeled opportunities are not money
already saved; they remain estimates until a user verifies quality and matched
future provider evidence.

Most users should run `npx aibill`. MIT licensed.
