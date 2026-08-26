# Runbook — launch-week alerts

You are reading this because an email arrived saying a workflow failed. This
page tells you what it means and what to check first. Every alert here is
designed to be worth reading at 6am; if one turns out not to be, tune its
threshold rather than muting the workflow.

## Where alerts come from

Two scheduled workflows, both delivering by GitHub's native "workflow failed"
email to repo watchers. There is no notification vendor and no pager.

| Workflow | File | Runs | Answers |
| --- | --- | --- | --- |
| **Launch canary** | `.github/workflows/launch-canary.yml` | `:00`, `:30` | Does the published package install and do the public endpoints answer? |
| **Launch alerts** | `.github/workflows/launch-alerts.yml` | `:05`, `:35` | Are real users hitting errors, and does storage still work? |

Read the email subject first: it names the **workflow**, not the step.
"Launch canary" = the artifact or a public endpoint. "Launch alerts" = users
or storage. Open the run, read the failing job's log — every failure below
prints its own explanation before exiting.

> **Prerequisite, check this once before launch:** you only get these emails if
> you **Watch → All Activity** (or Custom → Actions) on the repo, and have
> Settings → Notifications → *Send notifications for failed workflows only*
> enabled. No watch, no email, and the alerting is decorative.

## Required configuration

| Variable | Where it goes | Notes |
| --- | --- | --- |
| `OPS_HEALTH_TOKEN` | **Vercel** project env (Production) | Long random string, **at least 16 characters**. Anything shorter is treated as unset and every ops endpoint answers `503`. |
| `OPS_HEALTH_TOKEN` | **GitHub** repo secret (Settings → Secrets and variables → Actions) | **Exactly the same value.** A mismatch shows up as `401`. |
| `SUPABASE_URL` | Vercel project env | Already set — powers the waitlist and telemetry routes. |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel project env | Already set. **Never** put this in a GitHub secret: this repo is public. |

Generate a token with `openssl rand -hex 32`. Rotating it means changing both
places; until both match, the alert jobs fail with `401` — which is loud, not
silent, and therefore safe.

### Setup order matters — do this before merging

The alerts are deliberately loud about their own misconfiguration, so a
half-finished setup emails you every 30 minutes. Do it in this order and that
never happens:

1. **Vercel** → project → Settings → Environment Variables → add
   `OPS_HEALTH_TOKEN` (Production). Don't redeploy yet.
2. **GitHub** → Settings → Secrets and variables → Actions → add
   `OPS_HEALTH_TOKEN` with the identical value.
3. **Merge the branch.** The Vercel deploy that follows ships the
   `/api/ops/*` routes with the env var already in place.
4. **Confirm** with a manual run: Actions → *Launch alerts* → Run workflow.
   Both jobs should go green within a minute.

Doing it in any other order means the workflow exists before the endpoints
or the secret do, and every scheduled run fails with `404` or `401` until you
catch up. Nothing breaks — the emails are just noise you'd have to ignore,
which is the one habit this whole system depends on you not forming.

## Alerts

### `error_rate_high` — the fleet is failing more than usual

**Means:** in the last 60 minutes at least 20 runs happened, at least 25% of
them failed, and (when there is a trustworthy 24h baseline) that is at least
15 points worse than normal. All three conditions must hold, so this is not
"someone got an error" — it is "the product is worse than it was yesterday".

**Check first:**
1. The per-command breakdown printed just above the alert in the job log. If
   one command owns nearly all the failures, treat it as `command_failing`.
2. Whether a release went out in the last hour (`npm view aibill version`
   against the canary's `EXPECTED_MIN_VERSION`). A version bump immediately
   before the spike is the most likely cause.
3. Reproduce on a clean machine the way a new user would:
   `HOME=$(mktemp -d) npx -y aibill@latest` — most launch-day errors are
   first-run-only and invisible on a developer machine.

### `command_failing` — one command is broken

**Means:** a single command failed at least 8 times in the last 60 minutes
**and** failed at least half of its own runs. This fires even when the
fleet-wide rate looks fine, which is the point: 990 healthy `receipt` runs
will happily mask a completely broken `improve`.

**Check first:**
1. The command name in the alert text, and its `runs`/`failures` line in the
   log — a command failing 10 of 10 is a hard break; 8 of 16 is conditional.
2. Run exactly that command on a clean machine (see above). If it passes,
   the failure is environment-shaped — a different OS, no evidence on disk,
   or a permissions case.
3. `git log --oneline -10 packages/cli/src` for a recent change to that
   command's path.

> **Caveat worth knowing at 6am:** telemetry records only *that* a command
> failed, not *why*. Some `ok:false` results are correct behaviour — `report`
> with no financial evidence exits 1 by design. If a command's failures look
> suspiciously steady rather than spiky, suspect an expected non-zero exit
> before suspecting a defect. Closing this gap is what an `errorKind` enum
> would buy; it is deliberately not shipped for launch day.

### `telemetry_silent` — nothing is arriving at all

**Means:** zero telemetry events in the last 180 minutes, after at least 60
events in the 48 hours before that window. **This is the endpoint-down
signature, and it looks like silence rather than errors** — if
`/api/telemetry` starts returning 5xx, the CLI fires-and-forgets and drops the
event, so the table simply stops growing. No error-rate check can ever see it.

The baseline is measured over the period *ending where the silence begins*,
never over a window containing the silence, so a long outage cannot drag its
own baseline to zero and switch the alert off.

**Check first:**
1. Is the site up at all? `curl -sS -o /dev/null -w '%{http_code}\n'
   https://asktilden.com` and the Launch canary's most recent run.
2. `curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type:
   application/json' -d '{}' https://asktilden.com/api/telemetry` — **422 is
   healthy** (schema enforced, nothing stored). `503` means Supabase is
   rejecting writes, most likely a rotated or expired service-role key.
3. Vercel → project → Logs, filtered to `/api/telemetry`, for
   `supabase insert failed` or `supabase unreachable`.

If the answer to (2) is 503, the waitlist is almost certainly broken too — go
straight to the storage alert below, because that is the one that costs money.

### Waitlist storage — `WAITLIST STORAGE IS BROKEN`

**Means:** signups are being lost or refused **right now**. This is the most
expensive alert on the page — every minute it stays red is launch traffic
arriving at a form that cannot save anything.

The `waitlist-storage` job inserts a real row into the real `waitlist` table
through the real service-role key, deletes it, and verifies it is gone. The
failing stage is printed in the log:

| `failedStage` | Means |
| --- | --- |
| `preclean` + `supabase_not_configured` | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing from the Vercel env. Real signups are already being refused with 503. |
| `preclean` / `insert` + `http 401` or `http 403` | **The service-role key is rotated, expired, or wrong.** The single most likely cause. |
| `insert` + `unreachable` | Supabase is down or unreachable from Vercel. |
| `delete` + `removed 0` | The insert reported success but nothing persisted. Suspect the table, the unique index, or an RLS policy change. |
| `verify` + `canary row survived cleanup` | Cleanup failed. See "the canary row" below — remove it by hand. |
| `insert` + `missing_source_ref` | Storage works, but the `source_ref` column is gone, so signups are being stored **without attribution**. Users notice nothing; your launch-channel numbers are quietly wrong. |

**Check first:**
1. **Supabase project status and the service-role key.** Dashboard → Project
   Settings → API. Compare it to `SUPABASE_SERVICE_ROLE_KEY` in Vercel →
   project → Settings → Environment Variables. A key rotation is the most
   common cause and needs a redeploy (or an env change + redeploy) to take.
2. **Try a real signup yourself**, on the real site, with a real address. A
   201 means the funnel is fine and the probe is misconfigured; a 503 means
   the alert is right and every visitor is hitting the same wall.
3. **Vercel → Logs**, filtered to `/api/waitlist`, for
   `supabase insert failed` or `supabase unreachable` — the status code there
   names the cause directly.

For `missing_source_ref` specifically, the fix is one statement:

```sql
alter table waitlist add column if not exists source_ref text not null default 'direct';
```

**The canary row.** The probe writes and deletes
`aibill-storage-canary@canary.invalid` — a fixed address in a reserved-invalid
TLD (RFC 2606), so it can never be a real person and can never receive mail.
Because it is fixed, at most one can ever exist, and each run deletes it
before and after its own write. If a run ever dies mid-probe, the next run
cleans up automatically. To check or clear it by hand:

```sql
select * from waitlist where email = 'aibill-storage-canary@canary.invalid';
delete from waitlist where email = 'aibill-storage-canary@canary.invalid';
```

Exclude it from any signup count taken while a probe is mid-flight:

```sql
select count(*) from waitlist where email <> 'aibill-storage-canary@canary.invalid';
```

## Job-level failures (before any threshold is evaluated)

These come from the workflow itself, not from a threshold, and each prints its
own diagnosis in the log.

| Log line | Means | Do this |
| --- | --- | --- |
| `did not answer at all` | Timeout, DNS, or TLS — the site is unreachable. | Check the Vercel deployment and the Launch canary's `site up` step. |
| `401` | `OPS_HEALTH_TOKEN` differs between GitHub and Vercel. | Set both to one value. Nothing is wrong with the product. |
| `404` | The ops endpoints are not deployed. | The alerting branch has not reached production. |
| `503` | Endpoint is up but cannot reach storage, **or** `OPS_HEALTH_TOKEN` is unset/too short in Vercel. | Check the Vercel env var first (fastest to rule out), then Supabase. |
| `OPS_HEALTH_TOKEN is not set` | The GitHub secret is missing. | Add it under Settings → Secrets and variables → Actions. |

## Checking by hand

```sh
export OPS_HEALTH_TOKEN=...   # same value as Vercel

# Error monitor — aggregate counts only, safe to run any time.
curl -sS -H "x-ops-token: $OPS_HEALTH_TOKEN" \
  https://asktilden.com/api/ops/telemetry-health | jq

# Storage probe — writes and deletes one synthetic row. Safe to run any time,
# but do not run it concurrently with a scheduled run (:05 / :35).
curl -sS -X POST -H "x-ops-token: $OPS_HEALTH_TOKEN" \
  https://asktilden.com/api/ops/storage-health | jq
```

`ok: true` means no threshold tripped. The `alerts` array carries the same
text the failure email would have shown.

## What is deliberately NOT alerted

- **Individual user errors.** One person hitting one error is not an outage
  and must never page — that is what the volume floors are for.
- **Why a command failed.** Telemetry is enum-only by design: no paths, no
  stack traces, no free text. You get *that* something failed and *which*
  command, never the message. Closing that gap needs a bounded `errorKind`
  enum on the event, which is a CLI release plus an ingest-schema change —
  deliberately held until after launch day rather than shipped into the
  freeze.
- **Signup volume.** Nobody is watching for "too few signups"; there is no
  baseline yet to judge it against.
