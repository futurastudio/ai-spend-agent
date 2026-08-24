# v0.9.2 final QA verdict — implementer response (2026-08-24)

Response to `V092_FINAL_QA_VERDICT.md` (PASS conditional on B1). All fixes on
branch `v0.9.2`; tests 1,521 → 1,532; every gate green at HEAD. (This file
lives on the branch because the verdict file itself is kept in the private
working tree; append this section there if a single document is preferred.)

## Blocker

- **B1 — FIXED.** `runtime.telemetryDisclosure` threaded into
  `doctorCommand` and `reportCommand` (same pattern as context); all four
  strings swap: doctor's `local-first mode` line, report stdout's
  `privacy:` line, `report.md` line 5, and the `report.html` privacy
  banner. The eighth-site sweep found and fixed a FIFTH product surface —
  the html **terminal-frame footer belongs to the local-logs html variant**
  while the banner belongs to the sample/connected variant, so both
  variants are now conditional and BOTH are pinned in both directions
  (`telemetry.test.ts`, "doctor and report surfaces disclose in both
  states"). The sweep also scoped three true-but-blanket claims to the
  process that makes them: MCP `--help` ("This MCP server sends no
  telemetry"), `plugins/aibill/README.md`, and the `aibill-explain` skill
  ("The aibill MCP server sends no telemetry…"); `aibill-check`'s line was
  already scoped to the MCP check and stays. No further "telemetry" claim
  exists in any printed or generated surface (`grep -rni "no telemetry|no
  aibill telemetry|sends no telemetry"` over packages/ + plugins/ is clean
  outside tests/docs).

## Majors

- **M1 — FIXED (fail closed).** A failed `telemetry off` persist now calls
  a process-scoped kill switch consumed by `finish()` — the run that
  printed the failure emits nothing, and the copy points at the durable
  kills: "telemetry off could not be persisted — nothing more will be sent
  by this run. / For a durable off, set AI_SPEND_NO_TELEMETRY=1 or
  DO_NOT_TRACK=1, then fix ~/.aibill permissions." A SUCCESSFUL off also
  sets the flag (belt and braces beside the re-read guard). The read path
  already treated unwritable/corrupt state as OFF — verified and pinned.
  New tests: readonly-dir off (no emit, exact copy), successful off (no
  same-process emit).
- **M2 — FIXED (one honest line).** First ^C at the ask prints
  `ok — skipped the ask · your receipt is still being read (Ctrl-C again
  to quit)`; a ^C landing after the ask settled (readline was silently
  swallowing it) prints `still reading your evidence · Ctrl-C again to
  quit` and stands aside so the next ^C gets default kill behavior.
  PTY-verified: ack line, receipt renders, askCount 0. The spinner is not
  resurrected (the simpler honest behavior, per direction).
- **M3 — FIXED (Homebrew model).** Production delivery now runs in a
  detached, unref'd one-shot child (`node -e <sender> <stateFile>`): the
  parent's exit is never held by the socket. The child re-reads the state
  (enabled re-check), takes the ALREADY-CACHED `lastPayload` from the
  state file (the payload never rides on a command line), guards the batch
  shape, and POSTs once with its own 1500ms abort and total silence. The
  URL is baked in from the `telemetryUrl` constant — never
  environment-controlled (pinned). Tests: spawn wiring pins
  (execPath/-e/state-file argv, detached, stdio ignore, unref), child
  E2E byte-exact delivery to a local server + disabled-state no-send, and
  the latency measurement — parent-side call ≤50ms and a real parent
  process exits in <1s against a HANGING endpoint (child's abort is
  1500ms; the parent beats it decisively). In-process fetch remains the
  injected test transport only.
- **M4 — FIXED (guided-engine drain).** The terminal binding now owns a
  persistent line buffer: a line arriving while a read is armed answers
  it; lines landing in the gaps (paste bursts) are buffered and then
  DISCARDED at the next read with the guided engine's standard notice
  (`( N more pasted line(s) were discarded )`) and a fresh prompt — no
  dead air, and pasted input still cannot pre-answer the consent step
  (the verdict's verified holding is preserved by construction, not lost
  to a queue). PTY-verified with `"\r\r"`: nudge, drain notice, fresh
  prompt, real Enter completes one skip.

## Minors — fixed

- **m1:** ready-nudge now fires only on `pipeline.ok` (never over an
  error); pinned in the error-orchestration test.
- **m2:** the exhausted re-prompt budget closes with `moving on · npx
  aibill signup <email> anytime` (no skip consumed); pinned.
- **m3:** MX + A-fallback now share ONE deadline (default 1.5s total);
  pinned with a double-black-hole timing test.
- **m4:** `EBADNAME` now counts as provably undeliverable (no_mx);
  pinned.
- **m5:** disposable blocklist matches subdomains
  (`sub.mailinator.com` blocked, `notmailinator.com` not); pinned.
- **m7:** `--json` runs never print OR stamp the notice (stdout stays
  parseable; the un-stamped user is still never tracked); pinned.
- **m9:** unjoinability claim narrowed in TELEMETRY.md and the module
  header: "no shared field in any payload or state file", with the
  transport-metadata caveat stated.
- **m10:** lifetime ask-stamp cap added (`stampCount`, max 6 openings,
  decided answer or not) — perpetual walk-away users stop being asked
  after six stamps even though timeouts still consume no skip; pinned
  with a six-timeout walk-away test. Cap chosen conservatively; founder
  can raise it, never silently lower the respect floor.

## Minors — rejected with reason

- **m6 (residual scoped claims) — PARTIALLY REJECTED.** Doctor's line is
  fixed under B1. The remaining strings are scoped truths, not run-level
  claims: the no-evidence header `aibill · local only` and index's
  "Large histories take a few minutes on the first full pass. Local
  only." describe the ANALYSIS (and sit beside the run-level disclosure
  line, exactly like the help line's combined form); sourceRegistry's
  "No cloud upload." lives inside approved-source SCOPE text that
  describes the evidence source's data handling and is persisted into
  `sources.json` — making stored state vary with telemetry status would
  couple two unrelated state machines hours before freeze. Revisit
  post-launch if the adversary still reads them as run-level.
- **m8 ("cost/value" in report md/html labels) — REJECTED for 0.9.2.**
  Deliberate §5.2 scoping: the shipped-state audit flagged the
  report-card caption only, which was fixed; the report-file label family
  ("cost/value evidence total:", section headings) is pinned by ~15+
  tests across three packages and embedded in demo artifacts. Renaming it
  hours before freeze risks exactly the churn the freeze exists to
  prevent. Logged as a named fast-follow: unify the report label family
  on basis words in 0.9.3.
- **m11 (disclosure line wraps mid-command) — REJECTED.** Width-dependent
  cosmetic wrapping; the string is intact and the wrap point moves with
  the terminal. Any fix (non-breaking spaces, shorter copy) trades real
  copy quality for a cosmetic at one width band.
- **m12 (hash drift) — EXPLAINED.** `b264dc5` was amended minutes after
  creation to repair a backtick-mangled commit message; `51dcfa7` is the
  amended commit with identical content. Nothing newer was omitted.
