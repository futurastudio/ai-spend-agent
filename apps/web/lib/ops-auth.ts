import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret auth for the /api/ops/* health endpoints.
 *
 * WHY A SHARED SECRET AND NOT THE SUPABASE KEY: this repo is PUBLIC and the
 * alerting workflow runs in GitHub Actions. Putting SUPABASE_SERVICE_ROLE_KEY
 * into an Actions secret would place full read/write DB credentials one
 * workflow-injection away from the world. Instead the service key stays
 * server-side in Vercel, the ops endpoints expose ONLY aggregate counts, and
 * Actions holds a narrow token whose worst-case leak reveals row counts.
 *
 * The ops endpoints are reachable by anyone who can guess the token, so the
 * token must be long and random. A short or unset token is treated as
 * "not configured" — it never authenticates anything.
 */

/** Header the workflow sends the token in. */
export const OPS_TOKEN_HEADER = "x-ops-token";

/**
 * Refuse to authenticate against a token this short. Guards the two ways a
 * misconfiguration turns into an open endpoint: an unset env var (empty
 * string) and a placeholder like "changeme".
 */
export const MIN_OPS_TOKEN_LENGTH = 16;

export type OpsAuthResult =
  /** Token present and correct. */
  | "ok"
  /** Token absent or wrong. */
  | "unauthorized"
  /** Server has no usable OPS_HEALTH_TOKEN — nothing can authenticate. */
  | "not-configured";

/**
 * Compare two secrets without leaking, through timing, WHERE they first
 * differ.
 *
 * Both sides are hashed to a fixed 32-byte digest first. That matters for two
 * reasons: crypto.timingSafeEqual THROWS on a length mismatch (so comparing
 * raw strings would turn "attacker sent a short token" into an exception, a
 * loud oracle), and a fixed length makes the comparison cost independent of
 * the inputs. Hashing itself costs time proportional to the attacker's own
 * input length, which the attacker already knows — no secret leaks there.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Check the ops token on a request. `configured` defaults to the live env so
 * tests can stub it; read at call time, never at module load, so a serverless
 * instance picks up a rotated value on its next cold start.
 */
export function checkOpsToken(
  request: Request,
  configured: string | undefined = process.env.OPS_HEALTH_TOKEN,
): OpsAuthResult {
  const expected = configured?.trim() ?? "";
  if (expected.length < MIN_OPS_TOKEN_LENGTH) {
    return "not-configured";
  }
  const presented = request.headers.get(OPS_TOKEN_HEADER) ?? "";
  return constantTimeEquals(presented, expected) ? "ok" : "unauthorized";
}
