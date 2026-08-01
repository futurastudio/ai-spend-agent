# aibill plugin

The optional aibill plugin exposes the existing local MCP server and three
explicit-only skills. It adds no lifecycle hooks and injects no always-on
instructions.

## What it provides

- `$aibill-check`: current usage plus the canonical Context Health decision.
- `$aibill-explain`: field-level provenance, confidence, and missing-data
  explanations.
- `$aibill-help`: choose CLI, MCP/plugin, or macOS Glance.
- Eight MCP tools, including `get_usage_glance` and `get_context_health`.

The plugin launches `@agent-finops/mcp@0.5.7` with `npx` when the AI client
starts the MCP server. Node.js 22 or newer is required.

## Install from this repository

Clone the repository, add its repo-local marketplace, then install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/ai-spend-agent
codex plugin add aibill@aibill
```

Start a new Codex task after installation so the MCP tools and explicit skills
are loaded. Use `$aibill-check` only when you want the AI client to read the
local structured result.

## Privacy boundary

The aibill process does not upload files, prompts, credentials, or telemetry.
CLI and Glance stay on the Mac. When a user explicitly invokes an MCP-backed
skill, the selected structured result is returned to that AI client and is
subject to the client's own data-handling policy.
