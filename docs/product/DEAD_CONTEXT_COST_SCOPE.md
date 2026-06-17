# Scope — Dead-context cost ("you pay to load tools your agent never calls")

**Status:** BUILT (2026-06-17) · **Owner:** build side · shipped on branch
`feat/ai-receipt-spend-bars`

## What shipped (resolves the open questions below)
- `core/agentInventory.ts` — enumerates skills/subagents/commands (real
  frontmatter token weights) + MCP servers from `~/.claude.json`.
- `core/toolInvocations.ts` — extracts invoked tools from transcripts
  (`input.skill`, `Agent`+`subagent_type`, `mcp__server__tool`, slash commands).
- `core/deadContext.ts` — compares them and prices the waste cache-aware.
- Surfaced in the terminal **tokens-led** (the screenshot hook) with an honest
  cached-dollar footnote — because caching makes the real dollar cost small.
- **Globalized for first-run visibility:** inventory (all projects' MCP +
  user-scope skills/agents/commands) vs. ALL transcripts, so the dead-context
  line is populated from ANY directory — not just inside a project with tools
  loaded. Priced over total turns, framed "across your Claude Code use ·
  estimated" (`includeAllProjectMcp`). When there's genuinely nothing real
  (fresh user / forced `--sample`), a clearly-labeled `SAMPLE` illustrative
  line shows so the feature is always on the first card (`sampleDeadContext`).
- **MCP weight:** schemas aren't in config, so each MCP server uses a
  conservative floor (`MCP_SERVER_TOKEN_FLOOR = 700`) tagged
  `estimated_understated` — we under-claim, never over-claim.
- Inventory inputs are env-isolatable (`AI_SPEND_CLAUDE_HOME_DIR`,
  `AI_SPEND_CLAUDE_CONFIG`, `AI_SPEND_CLAUDE_LOGS_DIR`) for tests/privacy.

Live example (neutral dir, 4 unused MCP servers across projects): *"4 of 4
loaded tools never invoked (100%) · ~4.3M dead tokens/mo · honest cost
~$1.80/mo across your Claude Code use."*

## Fast-follow (not yet built)
- **Plugin/marketplace skills.** The big global inventory lives under
  `~/.claude/plugins/marketplaces/**/skills/**/SKILL.md`, gated by
  `installed_plugins.json` / `blocklist.json` (only *enabled* plugins load).
  Scanning these — honoring enabled-state — would massively enrich the real
  number. Deferred because the enabled-state logic is Claude-Code-internal and
  easy to over-count; do it carefully, not under launch pressure.

---

## Original scope (for reference)

## Why

skillreaper proved the "half of what your agent loads, it never uses" narrative
is what's hot on Reddit right now. We read the same transcripts. The differentiated
move is to **price that waste in real dollars** — a number nobody else outputs:

> **Dead context: ~$14/mo — you load 29 tools your agent never calls.**

This bridges the viral hook straight into our dollar engine, gives us a fresh
screenshottable line for the AI Receipt, and is honest (we already price tokens).

## What it measures

For each coding agent on the machine, compare the **loaded/installed inventory**
(what sits in context every turn) against the **invoked set** (what transcripts
show was actually called), then price the always-loaded weight of the never-used
items at API-equivalent rates.

## Data sources (all local, read-only)

### Inventory — what's loaded (NEW reader: `core/agentInventory.ts`)
- **Skills:** `~/.claude/skills/*/SKILL.md` + project `.claude/skills/**`. NOTE:
  Claude Code skills use *progressive disclosure* — only the frontmatter
  (name + description) is always loaded; the body loads on invoke. So a dead
  skill's always-on weight is **small** (the metadata line), and we must price
  it that way or we overstate.
- **Subagents:** `~/.claude/agents/*.md`, project `.claude/agents/**`.
- **Slash commands:** `~/.claude/commands/**`, project `.claude/commands/**`.
- **MCP servers + tools:** from `~/.claude.json` / settings MCP config. MCP tool
  **full input schemas** are always loaded — this is the heavy dead weight and
  the bulk of any real number.
- **Exclude built-in tools** (Read/Edit/Bash/etc.) — always loaded, not prunable,
  not "waste."
- Codex: equivalent config (`~/.codex/config.toml`, MCP entries) — phase 2.

### Usage — what's invoked (EXTEND `localAgentLogs.ts`)
- Add `tool_use` extraction to `parseClaudeCodeTranscript`: assistant
  `message.content[]` blocks with `type: "tool_use"` carry `name`.
- Map invoked names → inventory:
  - MCP tools: `mcp__<server>__<tool>` → server + tool.
  - Skills: `Skill`/slash invocations → skill name.
  - Subagents: `Task`/`Agent` calls → `subagent_type`.
- An inventory item is **dead** if it never appears in the invoked set across the
  window (mirror skillreaper's verdicts: REAP=0 uses, REVIEW=too few sessions).

### Token weight per item
- Estimate tokens ≈ chars/4 of the always-loaded definition (MCP: full schema;
  skill: frontmatter only; subagent/command: description line).
- Cross-check against a real measure if available; otherwise label `estimated`.

## Pricing (the honesty-critical part)

Dead tokens live in the cached system/tools context. With prompt caching the real
cost is **not** full input rate every turn — it's a cache *write* once per session
plus a cache *read* per subsequent turn. Compute honestly:

```
dead_cost ≈ Σ_sessions [ dead_tokens × cacheWriteRate(model)
                       + dead_tokens × (turns_in_session − 1) × cacheReadRate(model) ]
```

We already have per-session turn counts and `modelPricing` cache rates. Report a
**range** (no-cache upper bound vs cached realistic) and tag `estimated`.
**Do not** quote the naive `dead_tokens × turns × input_rate` headline — it's the
inflated number, and accuracy = the launch's one non-negotiable (see HERMES §9).

## Output surfaces
1. **Terminal:** one line under "Where your money goes" —
   `Dead context: ~$X/mo · N tools loaded, M never called (K% waste)` + a bar.
2. **Cut list:** a `CutAction` ("trim N unused MCP tools / skills", $/mo, the
   named offenders) so it flows into existing ranking + savings total.
3. **AI Receipt SVG:** optional second stat line (redacted — counts + $, no names).

## Effort & risks
- ~1–1.5 days: inventory reader, tool_use parsing, coster, 1 output line + cut
  entry, tests.
- **MCP schemas may not be enumerable** without the server running → mark those
  "token weight estimated from name/description; may understate." (skillreaper
  hits the same wall — labels Cursor/OpenClaw "inventory only".)
- **Caching nuance** is the credibility lever — ship the range, never the inflated
  single number.
- We **price** waste; we don't prune it (skillreaper's lane). Stay out of mutating
  user config — read-only is the brand.

## Open questions
- Window definition for "never used" — match the spend window, or lifetime?
- Do we attribute dead context per-project (project `.claude/` vs global)?
- Is a real loaded-token measurement reachable from any transcript/init entry, or
  is chars/4 the best we get at launch?
