import { checkOpsToken } from "../../../../lib/ops-auth";

export const runtime = "nodejs";
// Never cached: a cached "ok" would be the exact silent failure this endpoint
// exists to prevent.
export const dynamic = "force-dynamic";

// POST /api/ops/storage-health — proves the WAITLIST STORAGE PATH actually
// works, end to end, using the same credentials real signups use.
//
// THE GAP THIS CLOSES. The launch canary POSTs `{}` to /api/waitlist and
// asserts 422. That proves the route is alive and enforcing its schema — and
// nothing more, because `{}` is rejected at email validation BEFORE
// storeInSupabase() is ever called. A rotated or expired service-role key
// would therefore make every REAL signup return 503 while the canary stayed
// green: the lead-gen funnel failing silently, on launch day, with the
// founder's dashboard showing all-clear. A probe that cannot detect a bad
// key is worthless.
//
// HOW THIS ONE IS DIFFERENT: it performs a real insert and a real delete
// against the real `waitlist` table through the real service-role key, and
// reports what happened at each stage. If the key is bad, this endpoint is
// the thing that goes red.
//
// WHY IT LEAVES NOTHING BEHIND:
//   1. The address is a FIXED, obviously-synthetic one in a reserved-invalid
//      TLD (RFC 2606 guarantees .invalid can never resolve or receive mail),
//      so it can never collide with a real person's signup.
//   2. Fixed rather than random ON PURPOSE: the unique index on `email` means
//      at most ONE canary row can exist at a time, so even a run that dies
//      mid-probe cannot accumulate rows and inflate signup counts.
//   3. Every run starts by deleting it (self-healing after a crashed run),
//      and ends by deleting it again and VERIFYING it is gone.
// (Corollary of the fixed address: two runs must not overlap. The schedule is
// every 30 minutes and a probe finishes in well under a second, so a collision
// would take a manual dispatch landing inside that window — and would produce
// one red run that self-heals on the next tick, never a stray row.)
//
// NOT A SPAM VECTOR: it needs OPS_HEALTH_TOKEN, it is POST-only, and even
// with the token the worst it can do is write and delete the same one row.
//
// Responses:
//   200 { ok: true, ... }   round trip succeeded
//   401 wrong or missing token (bare) · 405 wrong method
//   503 { ok: false, failedStage, ... }  storage is broken — go read the log

/**
 * The probe address. `.invalid` is reserved by RFC 2606 and can never be a
 * real mailbox. Exclude it from signup counts if you ever query mid-probe:
 *   select count(*) from waitlist where email <> 'aibill-storage-canary@canary.invalid';
 */
const CANARY_EMAIL = "aibill-storage-canary@canary.invalid";
/** Marks the row for what it is in the half-second it exists. */
const CANARY_SOURCE_REF = "canary";
const TABLE = "waitlist";
const STAGE_TIMEOUT_MS = 8000;

type Stage = "preclean" | "insert" | "delete" | "verify";
type StageState = "ok" | "failed" | "skipped";

type SupabaseConfig = { url: string; key: string };

class StageError extends Error {
  constructor(
    readonly stage: Stage,
    readonly reason: string,
  ) {
    super(`${stage}: ${reason}`);
  }
}

function headers(config: SupabaseConfig, extra: Record<string, string> = {}) {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function tableUrl(config: SupabaseConfig, query = ""): string {
  return `${config.url}/rest/v1/${TABLE}${query ? `?${query}` : ""}`;
}

/**
 * Exact-match filter on the canary address. Deliberately `eq` on the full
 * address and never a prefix, domain, or `like` pattern: a broad filter here
 * would be a delete statement pointed at real launch signups.
 */
const canaryFilter = `email=eq.${encodeURIComponent(CANARY_EMAIL)}`;

async function deleteCanary(
  config: SupabaseConfig,
  stage: Stage,
  representation: boolean,
): Promise<unknown[]> {
  let response: Response;
  try {
    response = await fetch(tableUrl(config, canaryFilter), {
      method: "DELETE",
      headers: headers(config, {
        Prefer: representation ? "return=representation" : "return=minimal",
      }),
      signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new StageError(stage, `unreachable (${(err as Error).name})`);
  }
  if (!response.ok) {
    throw new StageError(stage, `http ${response.status}`);
  }
  if (!representation) return [];
  const rows: unknown = await response.json().catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

export async function POST(request: Request): Promise<Response> {
  const auth = checkOpsToken(request);
  if (auth === "not-configured") {
    console.error(
      "[ops/storage-health] OPS_HEALTH_TOKEN missing or shorter than the minimum length — refusing to authenticate anyone",
    );
    return new Response(null, { status: 503 });
  }
  if (auth === "unauthorized") {
    return new Response(null, { status: 401 });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // In production this means real signups are ALREADY being refused with
    // 503 by the waitlist route. Loudest possible failure.
    console.error(
      "[ops/storage-health] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured — real signups are being refused right now",
    );
    return json(
      {
        ok: false,
        failedStage: "preclean",
        reason: "supabase_not_configured",
        stages: allStages("skipped"),
      },
      503,
    );
  }
  const config: SupabaseConfig = { url, key };

  const stages: Record<Stage, StageState> = allStages("skipped");
  let attribution: "ok" | "missing_source_ref" = "ok";
  const startedAt = Date.now();

  try {
    // 1) PRE-CLEAN. Idempotent, and it makes the probe self-healing after a
    //    run that died between insert and delete.
    await deleteCanary(config, "preclean", false);
    stages.preclean = "ok";

    // 2) INSERT through the same transport, table, and credentials a real
    //    signup uses. THIS is the step a rotated key fails.
    attribution = await insertCanary(config);
    stages.insert = "ok";

    // 3) DELETE, asking for the removed rows back. Exactly one row must come
    //    back — which is the proof that step 2 genuinely PERSISTED, rather
    //    than merely returning a hopeful 201.
    const removed = await deleteCanary(config, "delete", true);
    if (removed.length !== 1) {
      throw new StageError(
        "delete",
        `expected to remove exactly 1 canary row, removed ${removed.length}`,
      );
    }
    stages.delete = "ok";

    // 4) VERIFY the table is clean again. Without this the probe could pass
    //    while quietly leaving rows behind — the thing it promises never to do.
    await verifyGone(config);
    stages.verify = "ok";
  } catch (err) {
    const stage = err instanceof StageError ? err.stage : "preclean";
    const reason = err instanceof StageError ? err.reason : "unexpected_error";
    stages[stage] = "failed";
    console.error(`[ops/storage-health] round trip failed at ${stage}: ${reason}`);
    return json(
      {
        ok: false,
        generatedAt: new Date().toISOString(),
        table: TABLE,
        failedStage: stage,
        reason,
        stages,
        roundTripMs: Date.now() - startedAt,
      },
      503,
    );
  }

  if (attribution === "missing_source_ref") {
    // Storage works, but the source_ref column is gone, so the waitlist route
    // is silently falling back to storing signups WITHOUT attribution. That is
    // a real data-quality regression (it has happened before) and it is
    // invisible to users, so it has to be loud here or nowhere.
    console.error(
      "[ops/storage-health] waitlist table is missing the source_ref column — signups are being stored without attribution",
    );
    return json(
      {
        ok: false,
        generatedAt: new Date().toISOString(),
        table: TABLE,
        failedStage: "insert",
        reason: "missing_source_ref",
        stages,
        attribution,
        roundTripMs: Date.now() - startedAt,
      },
      503,
    );
  }

  return json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      table: TABLE,
      stages,
      attribution,
      roundTripMs: Date.now() - startedAt,
    },
    200,
  );
}

/**
 * Insert the canary row, mirroring the waitlist route's legacy-schema
 * fallback exactly so the probe reflects what a real signup would experience
 * rather than a stricter path of its own.
 */
async function insertCanary(
  config: SupabaseConfig,
): Promise<"ok" | "missing_source_ref"> {
  const send = (payload: Record<string, string>) =>
    fetch(tableUrl(config), {
      method: "POST",
      headers: headers(config, { Prefer: "return=minimal" }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
    });

  let response: Response;
  try {
    response = await send({ email: CANARY_EMAIL, source_ref: CANARY_SOURCE_REF });
  } catch (err) {
    throw new StageError("insert", `unreachable (${(err as Error).name})`);
  }

  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (!detail.includes("source_ref")) {
      throw new StageError("insert", "http 400");
    }
    // Same fallback the real route takes — storage itself may still be fine.
    try {
      response = await send({ email: CANARY_EMAIL });
    } catch (err) {
      throw new StageError("insert", `unreachable (${(err as Error).name})`);
    }
    if (!response.ok) {
      throw new StageError("insert", `http ${response.status}`);
    }
    return "missing_source_ref";
  }

  if (!response.ok) {
    // 401/403 here is the rotated-or-expired service-role key — the exact
    // failure the old `{}` canary could never see.
    throw new StageError("insert", `http ${response.status}`);
  }
  return "ok";
}

async function verifyGone(config: SupabaseConfig): Promise<void> {
  let response: Response;
  try {
    response = await fetch(tableUrl(config, `select=id&limit=1&${canaryFilter}`), {
      headers: headers(config),
      signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new StageError("verify", `unreachable (${(err as Error).name})`);
  }
  if (!response.ok) {
    throw new StageError("verify", `http ${response.status}`);
  }
  const rows: unknown = await response.json().catch(() => null);
  if (!Array.isArray(rows)) {
    throw new StageError("verify", "unreadable response");
  }
  if (rows.length !== 0) {
    throw new StageError("verify", "canary row survived cleanup");
  }
}

function allStages(state: StageState): Record<Stage, StageState> {
  return { preclean: state, insert: state, delete: state, verify: state };
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function GET(): Response {
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
