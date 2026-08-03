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
  `npx aibill context --json` for the canonical structured contract. Use
  `npx aibill apply` for the complete evidence-constrained action plan: verify
  candidates, request approval, make one bounded change, and compare matched
  future sessions before claiming an improvement.
- MCP/plugin: install the aibill plugin when the user wants an AI client to
  fetch the same contract on demand. The skills are explicit-only and the
  plugin has no lifecycle hooks.
- macOS Glance: build the optional source preview for a hover-only compact view.
  It launches a local `aibill glance` subprocess, so it renders the same local
  snapshot rather than maintaining a separate data store. A signed public Mac
  download is not available yet.

## Choosing

- Recommend terminal for the most complete private workflow, including the
  copy-ready Apply plan for an AI coding agent.
- Recommend MCP/plugin for conversational analysis inside a supported AI
  client.
- Recommend Glance for passive awareness of session value, reported limits,
  focus, and one Context Health session handoff on macOS. Its compact Copy
  action is project-aware but is not a replacement for the full Apply plan.
- Users can use more than one surface; their decision and provenance fields
  remain aligned through the shared core contract.
