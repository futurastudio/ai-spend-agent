# Context Health fixture benchmark

This is a deterministic regression benchmark for aibill's Context Health
decision contract. It is not a claim about universal token savings, coding
speed, code quality, or model performance.

## What it tests

The fixture matrix covers:

- insufficient evidence;
- a normal same-agent session;
- a session at least 1.5× its same-agent token median;
- an explicitly invoked skill that must not be labeled dead context;
- Ponytail-shaped `SessionStart`, `UserPromptSubmit`, and `SubagentStart`
  context-hook configuration whose runtime payload was not executed;
- a lifecycle-only `PreCompact` hook that must not be mislabeled as injected
  context;
- two explicit compaction markers in the current session;
- repeated explicit file reads with basename-only output;
- parent and subagent transcript evidence kept in separate session scopes;
- discoverable inventory not invoked in the selected transcript window;
- decision precedence when a large session and hook metadata coexist.

Every case also checks three safety invariants: hook payloads remain
`not_executed_or_inferred`, `uploaded` remains false, and the contract does not
invent a savings field.

## Run

```bash
npm run build
node scripts/benchmark-context-health.mjs
```

CI runs the same command after building the packages.

## Controls and limitations

- Inputs are synthetic and fixed; no live user files or network calls are used.
- The cases test classification and contract safety, not human comprehension.
- Same-agent token totals are an observable proxy for session size, not a
  provider's complete context-window accounting.
- Hook configuration proves that a lifecycle source is configured. It does not
  prove the emitted runtime payload or its token size.
- Repeated-read coverage is intentionally limited to explicit `Read`,
  `read_file`, `readFile`, and `view_image` tool calls. Shell command text is
  not parsed or guessed, and returned file identifiers are basenames only.
- Codex's paired `compacted` and `context_compacted` records represent one
  event in the fixture parser; only the top-level `compacted` record counts.
- Claude parent and sidechain/subagent transcript signals are counted
  separately; a child transcript is never merged into the parent's current
  session signal.
- “Never invoked” is bounded to the selected transcript window and does not
  establish that an item is permanently useless.
- Any future public savings, speed, or comprehension claim requires a separate
  preregistered study with a baseline, raw anonymized results, and failure-case
  reporting.
