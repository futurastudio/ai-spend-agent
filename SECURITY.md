# Security policy

aibill reads sensitive local metadata and can connect to provider billing APIs.
Security and data-labeling failures are treated as release-critical.

## Supported versions

Security fixes target the latest published release. If a fix cannot be safely
backported, the advisory will identify the first patched version.

## Report a vulnerability privately

Do not open a public issue containing a credential, raw transcript, private
path, exploit, or other sensitive material.

Use GitHub's private vulnerability reporting flow:

<https://github.com/futurastudio/ai-spend-agent/security/advisories/new>

Include the affected version, operating system, reproduction steps, impact,
and the smallest redacted evidence needed to understand the problem. Never
attach a real provider key or an unredacted transcript.

If private reporting is unavailable, open a minimal issue stating that you
need a private security contact. Do not include exploit details in that issue.

## Security boundaries

- CLI and Glance analysis run locally: transcripts, prompts, file names, and
  dollar amounts are never uploaded. The CLI separately counts which commands
  run — anonymous, disclosed by a printed first-run notice, and ended by
  `aibill telemetry off` (or `DO_NOT_TRACK`/`CI`/`AI_SPEND_NO_TELEMETRY`). See
  [`docs/TELEMETRY.md`](docs/TELEMETRY.md). The MCP server sends none.
- Explicit MCP results are returned to the AI client that invoked them and then
  follow that client's data policy.
- Provider credentials must be passed by environment-variable reference. Raw
  keys are rejected and must never be persisted, logged, committed, or placed
  in fixtures.
- Local transcript estimates are not provider-verified bills. Confidence,
  source, freshness, and coverage are part of the security and trust model.
- Broad filesystem roots are rejected. A scanner or connector expansion must
  preserve the approved-path and redaction controls.

## Public disclosure

Please allow time to reproduce, patch, test, and coordinate a release before
public disclosure. We will credit reporters who want attribution once a fix is
available.
