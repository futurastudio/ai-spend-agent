-- ============================================================================
-- telemetry_events — CLI usage telemetry for aibill (disclosed opt-out model)
-- ============================================================================
-- HOW TO APPLY: the founder pastes this whole file into the Supabase SQL
-- editor (Dashboard -> SQL Editor -> New query -> Run). Safe to re-run:
-- everything is IF NOT EXISTS, and the saved queries below are comments.
--
-- Writes come only from POST /api/telemetry (apps/web/app/api/telemetry/
-- route.ts) using the server-side service-role key. There is deliberately
-- NO public-insert RLS policy: RLS is enabled with zero policies, which
-- blocks the anon/publishable key entirely while the service-role key
-- bypasses RLS. Do not add an insert policy for anon.
--
-- AGGREGATE-ONLY INVARIANT (enforced by the route, mirrored here): every
-- column is an enum-like short string, a uuid, a boolean, or a timestamp.
-- The route allowlists `command` (unknown values arrive as 'other') and
-- pattern-checks `version` (x.y.z) and `ts` (ISO-8601). No free-text
-- column may be added to this table.

create table if not exists public.telemetry_events (
  id bigint generated always as identity primary key,
  install_id uuid not null,          -- random per-install uuid v4; never an email or a hash of one
  command text not null,             -- server-side allowlisted; unknown -> 'other'
  version text not null,             -- CLI version, x.y.z
  os text not null,                  -- darwin | linux | win32 | other
  arch text not null,                -- arm64 | x64 | other
  ci boolean not null,               -- ran inside CI?
  duration_bucket text not null,     -- lt1s | lt5s | lt30s | gte30s
  ok boolean not null,               -- command exited successfully?
  ts timestamptz not null,           -- client-reported time (clock-skew possible)
  received_at timestamptz not null default now()  -- server truth; use this for day buckets
);

alter table public.telemetry_events enable row level security;
-- No policies on purpose: anon key blocked, service-role key bypasses RLS.

create index if not exists telemetry_events_received_at_idx
  on public.telemetry_events (received_at);
create index if not exists telemetry_events_command_idx
  on public.telemetry_events (command);
create index if not exists telemetry_events_install_id_idx
  on public.telemetry_events (install_id);

-- ============================================================================
-- LAUNCH-WEEK SAVED QUERIES (commented out — copy one block at a time)
-- All bucket by received_at (server clock); client ts can be skewed.
-- ============================================================================

-- 1) Daily unique installs
--
-- select
--   received_at::date as day,
--   count(distinct install_id) as unique_installs,
--   count(*) as events
-- from public.telemetry_events
-- group by 1
-- order by 1 desc;

-- 2) Runs per command per day
--
-- select
--   received_at::date as day,
--   command,
--   count(*) as runs,
--   count(distinct install_id) as installs
-- from public.telemetry_events
-- group by 1, 2
-- order by 1 desc, runs desc;

-- 3) Day-1 return rate — share of installs seen on 2+ distinct days
--
-- with install_days as (
--   select
--     install_id,
--     min(received_at::date) as first_day,
--     count(distinct received_at::date) as active_days
--   from public.telemetry_events
--   group by install_id
-- )
-- select
--   count(*) as installs,
--   count(*) filter (where active_days >= 2) as returned_installs,
--   round(
--     100.0 * count(*) filter (where active_days >= 2) / nullif(count(*), 0),
--     1
--   ) as return_rate_pct
-- from install_days;

-- 3b) Same, cohorted by first-seen day (watch the launch-day cohort on its own)
--
-- with install_days as (
--   select
--     install_id,
--     min(received_at::date) as first_day,
--     count(distinct received_at::date) as active_days
--   from public.telemetry_events
--   group by install_id
-- )
-- select
--   first_day as cohort,
--   count(*) as installs,
--   count(*) filter (where active_days >= 2) as returned_installs,
--   round(
--     100.0 * count(*) filter (where active_days >= 2) / nullif(count(*), 0),
--     1
--   ) as return_rate_pct
-- from install_days
-- group by 1
-- order by 1 desc;

-- 4) Version distribution
--
-- select
--   version,
--   count(distinct install_id) as installs,
--   count(*) as runs
-- from public.telemetry_events
-- group by version
-- order by string_to_array(version, '.')::int[] desc;
