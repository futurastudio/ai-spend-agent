# Context Health fixture benchmark

This is a deterministic regression benchmark for aibill's Context Health
decision contract. It is not a claim about universal token savings, coding
speed, code quality, or model performance.

## What it tests

The fixture matrix covers:

- insufficient evidence;
- a normal same-agent session;
- a session at least 1.5× its same-agent token median;
- installed hook metadata whose runtime payload was not executed;
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
- “Never invoked” is bounded to the selected transcript window and does not
  establish that an item is permanently useless.
- Any future public savings, speed, or comprehension claim requires a separate
  preregistered study with a baseline, raw anonymized results, and failure-case
  reporting.
