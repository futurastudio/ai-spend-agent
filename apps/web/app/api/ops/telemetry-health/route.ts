import { checkOpsToken } from "../../../../lib/ops-auth";
import { normalizeCommand } from "../../../../lib/telemetry-commands";
import {
  SHORT_WINDOW_MINUTES,
  SILENCE_BASELINE_MINUTES,
  SILENCE_WINDOW_MINUTES,
  evaluateTelemetryAlerts,
  ratePct,
  type CommandCount,
  type TelemetrySnapshot,
} from "../../../../lib/telemetry-alerts";

// Relative imports, not the "@/" alias the marketing pages use: these modules
// are exercised by vitest as well as Next, and relative paths resolve
// identically in both without extra resolver config.

export const runtime = "nodejs";
// Counts must be read at request time; a cached response would report a stale
// world and could keep the alert green through an outage.
export const dynamic = "force-dynamic";

// GET /api/ops/telemetry-health — AGGREGATE-ONLY error monitor for the launch
// alerting workflow (.github/workflows/launch-alerts.yml).
//
// WHY THIS EXISTS: telemetry already records ok:false per command, but nobody
// is watching it. GitHub already emails repo watchers when a scheduled
// workflow fails. This endpoint is the bridge: it turns "the database knows"
// into "a workflow can fail", with no new infrastructure and no notification
// vendor.
//
// WHY IT IS NOT A DIRECT DB QUERY FROM ACTIONS: the repo is PUBLIC. The
// Supabase service-role key must never enter GitHub secrets. It stays in
// Vercel; Actions holds only OPS_HEALTH_TOKEN, and the worst a leak of that
// token can expose is the row counts below.
//
// PRIVACY CONTRACT — THE RESPONSE IS COUNTS ONLY:
// no installId, no email, no version-per-install, no free text, no paths, no
// stack traces. Command labels are re-normalized through the server allowlist
// on the way OUT (not just on the way in), so nothing free-form can escape
// even if a row reached the table by some other route.
//
// Responses:
//   200 { ok, generatedAt, window, commands, baseline, silence, alerts }
//   401 wrong or missing token (bare) · 405 wrong method
//   503 OPS_HEALTH_TOKEN unusable, Supabase unconfigured, or query failed

/** Hard cap on rows pulled for the per-command split. See TRUNCATION below. */
const MAX_WINDOW_ROWS = 5000;
const BASELINE_MINUTES = 24 * 60;
const QUERY_TIMEOUT_MS = 8000;

function minutesAgo(minutes: number, now: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

type SupabaseConfig = { url: string; key: string };

function authHeaders(config: SupabaseConfig): Record<string, string> {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
  };
}

async function supabaseGet(
  config: SupabaseConfig,
  query: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(
    `${config.url}/rest/v1/telemetry_events?${query}`,
    {
      headers: { ...authHeaders(config), ...extraHeaders },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    // Status only — a PostgREST error body can echo the query back.
    throw new Error(`telemetry_events query failed: ${response.status}`);
  }
  return response;
}

/**
 * Exact row count without transferring the rows. PostgREST reports it in
 * Content-Range ("0-0/187") when asked for count=exact; limit=1 keeps the body
 * to a single row instead of the whole window.
 */
async function countRows(config: SupabaseConfig, filters: string): Promise<number> {
  const response = await supabaseGet(config, `select=id&limit=1&${filters}`, {
    Prefer: "count=exact",
  });
  const range = response.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  if (!Number.isFinite(total)) {
    throw new Error("telemetry_events count query returned no Content-Range");
  }
  return total;
}

/**
 * Per-command split of the short window. One request returns the window's
 * runs, failures, and per-command breakdown together.
 *
 * TRUNCATION: capped at MAX_WINDOW_ROWS. If a launch hour ever exceeds it the
 * counts below are a floor, not a total — which cannot hide a problem, only
 * understate one, and the flag is reported so the runbook can say so.
 */
async function readWindow(
  config: SupabaseConfig,
  sinceIso: string,
): Promise<{ events: number; errors: number; commands: CommandCount[]; truncated: boolean }> {
  const response = await supabaseGet(
    config,
    `select=command,ok&received_at=gte.${encodeURIComponent(sinceIso)}` +
      `&limit=${MAX_WINDOW_ROWS + 1}`,
  );
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("telemetry_events window query returned a non-array");
  }
  const truncated = rows.length > MAX_WINDOW_ROWS;
  const counted = truncated ? rows.slice(0, MAX_WINDOW_ROWS) : rows;

  const byCommand = new Map<string, CommandCount>();
  let errors = 0;
  for (const row of counted) {
    const record = (row ?? {}) as Record<string, unknown>;
    // Re-normalize on the way out: the response can only ever contain
    // allowlisted labels, whatever the row actually holds.
    const command = normalizeCommand(record.command);
    // Anything that is not explicitly ok === true counts as a failure, so a
    // null or malformed value fails safe (visible) rather than silently clean.
    const failed = record.ok !== true;
    if (failed) errors += 1;
    const entry = byCommand.get(command) ?? { command, runs: 0, errors: 0 };
    entry.runs += 1;
    if (failed) entry.errors += 1;
    byCommand.set(command, entry);
  }

  return {
    events: counted.length,
    errors,
    commands: [...byCommand.values()].sort((a, b) => b.runs - a.runs),
    truncated,
  };
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}

export function POST(): Response {
  return methodNotAllowed();
}

export function PUT(): Response {
  return methodNotAllowed();
}

export function PATCH(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

export async function GET(request: Request): Promise<Response> {
  const auth = checkOpsToken(request);
  if (auth === "not-configured") {
    console.error(
      "[ops/telemetry-health] OPS_HEALTH_TOKEN missing or shorter than the minimum length — refusing to authenticate anyone",
    );
    // Bare body: this branch is reachable pre-auth, so it must say nothing
    // beyond "unavailable".
    return new Response(null, { status: 503 });
  }
  if (auth === "unauthorized") {
    return new Response(null, { status: 401 });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "[ops/telemetry-health] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured — cannot read telemetry",
    );
    return json({ ok: false, error: "supabase_not_configured" }, 503);
  }
  const config: SupabaseConfig = { url, key };

  const now = Date.now();
  const windowSince = minutesAgo(SHORT_WINDOW_MINUTES, now);
  const baselineSince = minutesAgo(BASELINE_MINUTES, now);
  const silenceSince = minutesAgo(SILENCE_WINDOW_MINUTES, now);
  const silencePriorSince = minutesAgo(
    SILENCE_WINDOW_MINUTES + SILENCE_BASELINE_MINUTES,
    now,
  );

  let window: Awaited<ReturnType<typeof readWindow>>;
  let baselineEvents: number;
  let baselineErrors: number;
  let silenceEvents: number;
  let silencePriorEvents: number;
  try {
    [window, baselineEvents, baselineErrors, silenceEvents, silencePriorEvents] =
      await Promise.all([
        readWindow(config, windowSince),
        countRows(config, `received_at=gte.${encodeURIComponent(baselineSince)}`),
        countRows(
          config,
          `received_at=gte.${encodeURIComponent(baselineSince)}&ok=is.false`,
        ),
        countRows(config, `received_at=gte.${encodeURIComponent(silenceSince)}`),
        // Baseline for silence ENDS where the silent window begins — see
        // SILENCE_BASELINE_MINUTES for why it must not include the silence.
        countRows(
          config,
          `received_at=gte.${encodeURIComponent(silencePriorSince)}` +
            `&received_at=lt.${encodeURIComponent(silenceSince)}`,
        ),
      ]);
  } catch (err) {
    // A failure HERE is itself an outage signal: the alerting path cannot see
    // the data. 503 makes the workflow red rather than silently green.
    console.error("[ops/telemetry-health] query failed:", err);
    return json({ ok: false, error: "telemetry_query_failed" }, 503);
  }

  const snapshot: TelemetrySnapshot = {
    window: {
      minutes: SHORT_WINDOW_MINUTES,
      events: window.events,
      errors: window.errors,
    },
    commands: window.commands,
    baseline: {
      minutes: BASELINE_MINUTES,
      events: baselineEvents,
      errors: baselineErrors,
    },
    silence: {
      minutes: SILENCE_WINDOW_MINUTES,
      events: silenceEvents,
      priorMinutes: SILENCE_BASELINE_MINUTES,
      priorEvents: silencePriorEvents,
    },
  };

  const alerts = evaluateTelemetryAlerts(snapshot);

  return json(
    {
      ok: alerts.length === 0,
      generatedAt: new Date(now).toISOString(),
      window: {
        ...snapshot.window,
        errorRatePct: ratePct(window.errors, window.events),
        truncated: window.truncated,
      },
      commands: window.commands,
      baseline: {
        ...snapshot.baseline,
        errorRatePct: ratePct(baselineErrors, baselineEvents),
      },
      silence: snapshot.silence,
      alerts,
    },
    200,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
