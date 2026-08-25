export const runtime = "nodejs";

// POST /api/telemetry — ingest endpoint for the CLI's disclosed opt-out usage
// telemetry (model: aggregate only, no content, no paths, no PII; the CLI
// discloses on the receipt line and honors DO_NOT_TRACK — user-facing
// contract in docs/TELEMETRY.md).
//
// AGGREGATE-ONLY INVARIANT — ENFORCED SERVER-SIDE, IN THIS FILE:
// every stored field is an enum, a bounded pattern (uuid v4 / x.y.z version /
// ISO timestamp), or a boolean. No free-text field exists in the schema.
// Unknown commands collapse to "other" (the raw string is never stored);
// unknown fields reject the whole batch with 422. Do not add a field here
// without an allowlist or pattern — a free-text column would break the
// product's "no content uploaded" promise.
//
// Request contract:
//   POST { "events": [TelemetryEvent, ...] }   1–20 events, body <= 4 KB
//   TelemetryEvent = {
//     installId: uuid-v4 string, command: string (allowlisted, else "other"),
//     version: "x.y.z", os: darwin|linux|win32|other, arch: arm64|x64|other,
//     ci: boolean, durationBucket: lt1s|lt5s|lt30s|gte30s, ok: boolean,
//     ts: ISO-8601 string, sane relative to received time (see TS window)
//   }
// Responses (failures carry NO body detail — telemetry clients fire-and-forget):
//   204 stored (or accepted-and-dropped in dev without Supabase)
//   400 malformed JSON · 405 wrong method · 413 body over 4 KB
//   422 schema violation (whole batch rejected) · 429 rate limited
//   503 storage unavailable

// Every CLI command that may report usage. Anything else — typos, plugins,
// injection attempts — is stored as the literal string "other".
const COMMAND_ALLOWLIST = new Set([
  "receipt",
  "full",
  "group-by",
  "improve",
  "improve-sample",
  "index",
  "identify",
  "accountability",
  "outcome",
  "statusline",
  "statusline-expand",
  "signup",
  "connect",
  "sync-provider",
  "doctor",
  "report",
  "report-card",
  "apply",
  "watch",
  "init",
  "verify",
  "drop-slice",
  "telemetry",
  "other",
]);

const OS_VALUES = new Set(["darwin", "linux", "win32", "other"]);
const ARCH_VALUES = new Set(["arm64", "x64", "other"]);
const DURATION_BUCKETS = new Set(["lt1s", "lt5s", "lt30s", "gte30s"]);

const MAX_EVENTS = 20;
// Byte cap before JSON.parse. Note: 20 maximal events (longest command +
// offset timestamps) can brush this limit — the CLI should flush at ~10
// events; the cap is an abuse guard, not a capacity target.
const MAX_BODY_BYTES = 4096;
// Length caps on every string field, checked before any regex work.
const MAX_COMMAND_LENGTH = 64;
const MAX_VERSION_LENGTH = 32;
const MAX_TS_LENGTH = 40;

// TS window — sanity clamp against received time. The CLI stamps ts moments
// before flushing, so anything far off is a replayed, fabricated, or
// copy-pasted-from-docs event (a curl of the documented example once landed
// six far-future rows). Rejection, not silent clamping, keeps the route's
// whole-batch 422 contract: >48h ahead tolerates clock skew, >30d behind
// tolerates nothing useful — telemetry is fire-and-forget, never queued
// that long.
const MAX_TS_FUTURE_MS = 48 * 60 * 60 * 1000;
const MAX_TS_PAST_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// ISO-8601 with required seconds and an explicit zone (Z or ±hh:mm) — the
// shape Date.prototype.toISOString emits; Date.parse then confirms validity.
const ISO_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const EVENT_KEYS = [
  "installId",
  "command",
  "version",
  "os",
  "arch",
  "ci",
  "durationBucket",
  "ok",
  "ts",
] as const;
const EVENT_KEY_SET = new Set<string>(EVENT_KEYS);

// Best-effort per-IP rate limit, mirroring the waitlist route: in-memory, so
// per serverless instance and reset on cold start — blunts naive floods, not
// a substitute for edge-level protection. Looser than the waitlist's 5/min
// because offices behind one NAT legitimately flush batches concurrently,
// and dropped telemetry is loss-tolerant by design.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const RATE_MAP_MAX = 10_000;
const recentByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (recentByIp.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_LIMIT) {
    recentByIp.set(ip, hits);
    return true;
  }
  hits.push(now);
  if (recentByIp.size >= RATE_MAP_MAX && !recentByIp.has(ip)) {
    recentByIp.clear();
  }
  recentByIp.set(ip, hits);
  return false;
}

// Snake_case row exactly matching apps/web/supabase/telemetry_events.sql.
type TelemetryRow = {
  install_id: string;
  command: string;
  version: string;
  os: string;
  arch: string;
  ci: boolean;
  duration_bucket: string;
  ok: boolean;
  ts: string;
};

/**
 * Validate one event against the exact schema. Returns the storable row, or
 * null when anything is outside the schema (missing field, unknown field,
 * wrong type, over a length cap, off-pattern). Deliberately no error detail:
 * the whole batch gets a bare 422 either way.
 */
function parseEvent(value: unknown): TelemetryRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  // Exactly the nine known keys: rejects unknown AND missing fields at once.
  if (keys.length !== EVENT_KEYS.length) return null;
  for (const key of keys) {
    if (!EVENT_KEY_SET.has(key)) return null;
  }

  const { installId, command, version, os, arch, ci, durationBucket, ok, ts } =
    record;

  if (typeof installId !== "string" || !UUID_V4_RE.test(installId)) return null;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > MAX_COMMAND_LENGTH
  ) {
    return null;
  }
  if (
    typeof version !== "string" ||
    version.length > MAX_VERSION_LENGTH ||
    !VERSION_RE.test(version)
  ) {
    return null;
  }
  if (typeof os !== "string" || !OS_VALUES.has(os)) return null;
  if (typeof arch !== "string" || !ARCH_VALUES.has(arch)) return null;
  if (typeof ci !== "boolean") return null;
  if (typeof durationBucket !== "string" || !DURATION_BUCKETS.has(durationBucket)) {
    return null;
  }
  if (typeof ok !== "boolean") return null;
  if (typeof ts !== "string" || ts.length > MAX_TS_LENGTH || !ISO_TS_RE.test(ts)) {
    return null;
  }
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return null;
  // Sanity window relative to received time — see the TS window constants.
  const skewMs = tsMs - Date.now();
  if (skewMs > MAX_TS_FUTURE_MS || skewMs < -MAX_TS_PAST_MS) return null;

  return {
    install_id: installId.toLowerCase(),
    // The allowlist is the invariant: a command string outside it is never
    // stored raw — it becomes the literal "other".
    command: COMMAND_ALLOWLIST.has(command) ? command : "other",
    version,
    os,
    arch,
    ci,
    duration_bucket: durationBucket,
    ok,
    ts,
  };
}

function reject(status: number): Response {
  // Failures carry no body detail by contract.
  return new Response(null, { status });
}

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    return reject(429);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return reject(400);
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return reject(413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(400);
  }

  // Envelope: exactly { events: [...] } — no other top-level keys.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return reject(422);
  }
  const envelope = body as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope);
  if (envelopeKeys.length !== 1 || envelopeKeys[0] !== "events") {
    return reject(422);
  }
  const events = envelope.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS) {
    return reject(422);
  }

  const rows: TelemetryRow[] = [];
  for (const event of events) {
    const row = parseEvent(event);
    if (row === null) {
      // One bad event rejects the whole batch — keeps the invariant simple
      // and gives a hostile client nothing to probe with partial acceptance.
      return reject(422);
    }
    rows.push(row);
  }

  const stored = await storeInSupabase(rows);
  if (stored === "stored") {
    return new Response(null, { status: 204 });
  }
  if (stored === "error") {
    return reject(503);
  }

  // Supabase not configured. In production that is a misconfiguration — fail
  // loudly (the CLI fires-and-forgets, so nobody's run breaks), mirroring the
  // waitlist route's stance.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[telemetry] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured in production — refusing events",
    );
    return reject(503);
  }

  // Local dev: telemetry is loss-tolerant, unlike signups — accept and drop.
  console.log(`[telemetry] supabase not configured — dropped ${rows.length} event(s) (dev)`);
  return new Response(null, { status: 204 });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function GET() {
  return methodNotAllowed();
}

export function PUT() {
  return methodNotAllowed();
}

export function PATCH() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}

/**
 * Bulk insert via Supabase PostgREST using the service-role key (server-only),
 * same transport as the waitlist route. The table has RLS enabled with zero
 * policies, so only this server-side key can write. Returns "skipped" when the
 * env is not configured. Logs never include event contents — status codes only.
 */
async function storeInSupabase(
  rows: TelemetryRow[],
): Promise<"stored" | "error" | "skipped"> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return "skipped";
  }
  try {
    const response = await fetch(`${url}/rest/v1/telemetry_events`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (response.ok) {
      return "stored";
    }
    console.error(`[telemetry] supabase insert failed: ${response.status}`);
    return "error";
  } catch (err) {
    console.error("[telemetry] supabase unreachable:", err);
    return "error";
  }
}
