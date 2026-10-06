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
  `npx aibill apply` to prepare an inspection and approval artifact; it does
  not execute a change or start an experiment. Use `npx aibill improve` for
  the guided token test, with human approval, an actual reversible change,
  matched completed sessions and user-declared quality. It does not prove ROI.
- Local MCP / Codex plugin: configure the local stdio MCP server for a
  compatible AI client, or install this local plugin in Codex. The skills are
  explicit-only and the plugin has no lifecycle hooks. Selected results go to
  the invoking client under its data policy. This is separate from hosted
  read-only Workspace MCP and the private Plugin / ChatGPT Pilot; installing
  it grants access to neither hosted offering.
- Connected CLI: invited Workspace members can pair with `npx aibill workspace
  connect`, authorize sharing in the browser, then explicitly preview and
  confirm `npx aibill workspace push`. Only supported session/token facts and
  project labels are shared, not all CLI data or provider costs. The browser
  need not stay open after setup while the grant and consent remain valid.
- macOS Glance: build the optional source preview for a hover-only compact view.
  It launches a local `aibill glance` subprocess, so it renders the same local
  snapshot rather than maintaining a separate data store. A signed public Mac
  download is not available yet.

## Choosing

- Recommend terminal for the most complete private workflow, including the
  copy-ready Apply plan for an AI coding agent.
- Recommend local MCP for conversational analysis inside a compatible stdio
  client, and this plugin specifically for Codex.
- Recommend Glance for passive awareness of session value, reported limits,
  focus, and one Context Health session handoff on macOS. Its compact Copy
  action is project-aware but is not a replacement for the full Apply plan.
- Users can use more than one surface; their decision and provenance fields
  remain aligned through the shared core contract.
