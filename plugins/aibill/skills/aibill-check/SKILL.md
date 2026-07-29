---
name: aibill-check
description: Check current local Claude Code and Codex usage, plan-window availability, recent focus, and hook-aware Context Health through the aibill MCP. Use only when the user explicitly asks to inspect, check, audit, or summarize their aibill usage or context health.
---

# aibill Check

Use the aibill MCP only after the user explicitly invokes this skill. Do not
install hooks, scan broad directories, connect providers, or write local state.

## Workflow

1. Resolve the user's project root. If it is not available from the workspace,
   ask for the absolute path.
2. Call `get_usage_glance` once with that absolute `path`, the requested
   `sinceDays` (default 30), and an exact `project` filter only when the user
   supplied one. Its `sessionHealth` field is the canonical Context Health
   object; do not make a second call that could observe a later active-session
   state.
3. Return one compact answer in this order:
   - current/latest session and API-equivalent value;
   - reported five-hour/weekly windows, explicitly saying when unavailable;
   - Context Health headline and action;
   - main recent focus;
   - the most important caveat or missing source.

## Accuracy Rules

- Label transcript token values as API-equivalent estimates, never invoices or
  incremental subscription spend.
- Only call a limit percentage or reset time exact when its source is
  `transcript_reported`. Never infer a missing five-hour or weekly window.
- Treat hook activation as configuration evidence. Hook commands were not run,
  and hook payload tokens are unmeasured.
- Do not convert “never invoked” into savings without a measured
  counterfactual.
- Do not reveal raw prompts, credentials, or unrelated filesystem paths.
- Say that aibill itself uploads nothing; MCP results are returned to the AI
  client that invoked the tool and follow that client's data policy.
