---
name: aibill-explain
description: Explain the source, confidence, limitations, and privacy boundary behind aibill session value, limits, focus, anomalies, and Context Health. Use only when the user explicitly asks where an aibill value came from, why it is missing, or whether it is exact.
---

# aibill Explain

Use the aibill MCP only after explicit invocation. Explain evidence before
advice; never fill a missing field with an estimate the contract did not make.

## Workflow

1. Get the absolute project root.
2. Call `get_usage_glance` once with the needed path, project, and history
   inputs. Explain Context Health from its canonical `sessionHealth` field.
   If the user asks only about context and no Glance fields, call
   `get_context_health` instead—never both for one snapshot.
3. Locate the questioned field and cite its structured provenance:
   - session tokens/model/project: root-scoped local transcript usage; supported
     Codex forks subtract inherited parent baselines before child-specific work,
     while ambiguous or unobservable coverage stays missing instead of being
     assigned to a project;
   - session dollars: local token calculation at dated public API list rates;
   - plan: locally detected or user-declared account metadata;
   - limits: transcript-reported percentages/reset times;
   - exhaustion: local pace projection;
   - focus: local prompt/tool activity summary with raw prompts omitted;
   - context recommendation: same-agent session history plus local inventory;
   - hook activation: installed plugin config only, with payload unmeasured.
4. State whether the field is observed, derived, estimated, unmeasured, or
   unavailable.
5. State the practical consequence in one sentence.

## Required Boundaries

- Subscription users are not charged the API-equivalent value shown for a
  session; it is a comparison value, not added spend.
- Claude Code plan headroom stays unavailable when transcripts do not expose
  it.
- “Hook-injected” does not mean aibill knows the hook's emitted token count.
- “No matching invocation” describes the selected transcript window, not
  permanent uselessness or proof that a configured definition was loaded into
  every turn.
- aibill sends no telemetry or transcripts to an aibill service. Explicit
  provider sync contacts the selected provider's official read-only API. An MCP
  result is returned to the invoking AI client under that client's data policy.
