---
name: aibill-help
description: Choose and explain the correct aibill delivery path—terminal CLI, on-demand MCP skill, or macOS Glance. Use only when the user explicitly asks how to install, run, customize, or choose an aibill interface.
---

# aibill Help

Recommend one path based on the user's goal. Do not call aibill tools unless
the user also asks for their current data.

## Delivery Paths

- Terminal: use `npx aibill` for the spend readout,
  `npx aibill context` for human-readable Context Health, and
  `npx aibill context --json` for the canonical structured contract.
- MCP/plugin: install the aibill plugin when the user wants an AI client to
  fetch the same contract on demand. The skills are explicit-only and the
  plugin has no lifecycle hooks.
- macOS Glance: use the optional native app for a hover-only compact view. It
  shells out to `aibill glance`, so it renders the same local snapshot rather
  than maintaining a separate data store.

## Choosing

- Recommend terminal for private, scriptable inspection with no AI-client
  handoff.
- Recommend MCP/plugin for conversational analysis inside a supported AI
  client.
- Recommend Glance for passive awareness of session value, reported limits,
  focus, and one Context Health action on macOS.
- Users can install more than one surface; their decision and provenance fields
  remain aligned through the shared core contract.
