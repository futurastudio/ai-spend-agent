# aibill telemetry — anonymous command counts, notice-before-first-byte

aibill can count **which commands run**. That is the entire scope. It exists
so the team knows which surfaces people actually use; it can never say who
ran them, on what project, or with what data.

## Consent model (disclosed opt-out, notice before the first byte)

1. Your **first interactive run prints a notice and sends nothing**:

   ```
   aibill counts which commands run — anonymous, never your data or content
   turn off: aibill telemetry off
   see payloads: aibill telemetry
   ```

2. Events begin only on runs **after** that notice was shown and recorded.
   A machine that has never shown the notice (CI, scripts, pipes) never
   sends anything — a user who has never seen the notice is never tracked.
3. `aibill telemetry off` turns it off; `aibill telemetry on` turns it back
   on (and counts as your notice). `aibill telemetry` prints the status and
   the **exact last payload sent, verbatim**.
4. Hard kill-switches, honored regardless of saved state: `DO_NOT_TRACK`,
   `CI`, and `AI_SPEND_NO_TELEMETRY` (any non-empty value).
5. State lives in `~/.aibill/telemetry.json` and **fails closed**: a
   corrupt or unreadable state file means telemetry is OFF.

## Receipt-line truth

While telemetry is enabled and noticed, every surface that printed
`nothing uploaded` prints instead:

```
anonymous command counts shared · aibill telemetry off
```

The printed privacy claim always matches what actually leaves the machine,
in both states.

## The event — exactly this, nothing else

```json
{"events":[{"installId":"<uuid v4>","command":"receipt","version":"0.9.2","os":"darwin","arch":"arm64","ci":false,"durationBucket":"lt5s","ok":true,"ts":"2001-01-01T00:00:00.000Z"}]}
```

- `command` comes from a fixed allowlist (`receipt`, `full`, `group-by`,
  `improve`, `improve-sample`, `index`, `identify`, `accountability`,
  `outcome`, `statusline`, `statusline-expand`, `signup`, `connect`,
  `sync-provider`, `doctor`, `report`, `report-card`, `apply`, `watch`,
  `init`, `verify`, `drop-slice`, `telemetry`, `other`). Explicit `--sample`
  demo runs count as `other`, so `receipt` stays a count of real receipts.
- `durationBucket` is one of `lt1s | lt5s | lt30s | gte30s`.
- One batch of one event per run, fire-and-forget: hard 1.5s abort, no
  retry, no queue, total silence on failure (any non-204 = drop).
- Server-side, the ingest endpoint enforces the same schema (enum/pattern
  fields only, unknown fields reject the batch) and rejects any event whose
  `ts` is more than 48 hours in the future or more than 30 days in the past
  of receipt. The example above deliberately carries an ancient `ts` so that
  pasting it verbatim is rejected — a replayed or fabricated timestamp never
  lands in the table.

**The never-list:** arguments, flag values, paths, file contents, project
names, models, dollar amounts, transcripts, your email — none of it is in
the payload, and a CI creep-guard test pins the serialized bytes so adding
a field fails the build.

**Unjoinable to the launch-list signup at the payload layer:** the
telemetry `installId` lives only in `~/.aibill/telemetry.json`; the signup
state (`signup.json`) has no installId and the telemetry state has no
email. No shared field exists in any payload or state file — pinned by
test. (As with any two web requests to one host, transport metadata such
as the source IP is shared at the network layer; the no-join claim stops
at the payload.)

**Embedding:** telemetry is wired only in the `aibill` bin entrypoint.
Library consumers of `runCli` and the MCP server never emit events.
