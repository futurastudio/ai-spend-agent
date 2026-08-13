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

## Supported library preview

Use Node.js 22+ ESM and import only from the package root:

```ts
import { generatePlainEnglishSummary } from "@agent-finops/report";
```

The supported 0.x renderer subset is `generatePlainEnglishSummary`,
`PlainEnglishSummaryOptions`, `GroupByDimension`, and `groupByDimensions`.
Its function signature and evidence-label semantics are supported; wording,
spacing, color, and table layout are not a byte-stable data contract. Consume
typed `@agent-finops/core` objects instead of parsing terminal text.
The renderer remains local and makes no network or filesystem call. It reads
standard terminal color/TTY state only when `color` is not supplied; set
explicit `color` and `width` options for reproducible presentation.

The renderer preserves the caller's `mode`, provenance, and confidence claims;
it does not authenticate or reconcile them. Use `verified` only for official
provider-reported financial evidence, and never pass a local estimate as
provider-reported spend.

An explicit export map blocks unsupported deep imports such as
`@agent-finops/report/terminal`. Other root renderers remain available for
existing callers but are not stabilized by this narrow preview. See the full
[library contract](https://github.com/futurastudio/ai-spend-agent/blob/main/docs/LIBRARY.md)
for runtime support, privacy, a runnable example, and the 0.x policy.
