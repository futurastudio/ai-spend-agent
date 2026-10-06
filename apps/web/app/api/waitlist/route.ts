import { NextResponse } from "next/server";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sendWaitlistConfirmation } from "../../../lib/server/waitlist-confirmation";

export const runtime = "nodejs";

// Pragmatic email check — good enough to reject obvious junk without
// rejecting valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STORAGE_TIMEOUT_MS = 5_000;

function normalizeSourceRef(value: unknown): string {
  if (typeof value !== "string") return "direct";
  const normalized = value.trim().toLowerCase();
  return REF_RE.test(normalized) ? normalized : "direct";
}

// Never log the full address — signups are PII and server logs stick around.
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

// Best-effort per-IP rate limit. In-memory, so it is per serverless instance
// and resets on cold start — enough to blunt naive floods and form spam, not
// a substitute for edge-level protection.
const RATE_LIMIT = 5;
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

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a minute." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email =
    typeof body === "object" && body !== null && "email" in body
      ? String((body as { email: unknown }).email).trim().toLowerCase()
      : "";
  const sourceRef = normalizeSourceRef(
    typeof body === "object" && body !== null && "ref" in body
      ? (body as { ref: unknown }).ref
      : new URL(request.url).searchParams.get("ref"),
  );

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 422 },
    );
  }

  console.log(`[waitlist] new signup: ${maskEmail(email)} (${sourceRef})`);

  const stored = await storeInSupabase(email, sourceRef);
  if (stored === "stored" || stored === "duplicate") {
    // The new landing form requests its own acknowledgment. This marker routes
    // copy, not authorization: existing CLI/study surfaces retain their promises
    // and never wait on the email provider, even if a caller adds the marker.
    const requestConfirmation = request.headers.get("x-tilden-confirmation") === "waitlist-v1"
      && !sourceRef.startsWith("cli-")
      && !sourceRef.includes("glance-study");
    if (stored === "stored" && requestConfirmation) {
      await sendWaitlistConfirmation(email);
    }
    // Same acknowledgment for new/duplicate signups and email failures.
    // We confirm registration, never claim inbox delivery here.
    return NextResponse.json({ ok: true }, { status: 201 });
  }
  if (stored === "error") {
    // Supabase is configured but rejected the write — surface it rather than
    // silently dropping a launch signup.
    return NextResponse.json(
      { error: "Could not save your signup. Please try again." },
      { status: 503 },
    );
  }

  // Supabase not configured. In production that means signups would go to
  // ephemeral disk and vanish on the next deploy — fail loudly instead of
  // pretending the signup was saved.
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[waitlist] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured in production — refusing signup",
    );
    return NextResponse.json(
      { error: "Signups are temporarily unavailable. Please try again soon." },
      { status: 503 },
    );
  }

  // Local dev: append to a local file so no signup is lost while developing.
  const entry = `${new Date().toISOString()}\t${email}\t${sourceRef}\n`;
  try {
    const dir = join(process.cwd(), ".data");
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "waitlist.tsv"), entry, "utf8");
  } catch (err) {
    console.warn("[waitlist] could not persist to file:", err);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}

/**
 * Insert via Supabase PostgREST using the service-role key (server-only).
 * Returns "skipped" when env is not configured, "duplicate" when the email
 * already exists (unique index) — both are fine outcomes for the user.
 */
async function storeInSupabase(email: string, sourceRef: string): Promise<"stored" | "duplicate" | "error" | "skipped"> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return "skipped";
  }
  // Bound the complete storage attempt, including the legacy-column fallback.
  // An uncertain write is never retried automatically or treated as saved.
  const signal = AbortSignal.timeout(STORAGE_TIMEOUT_MS);
  const insert = (payload: Record<string, string>) =>
    fetch(`${url}/rest/v1/waitlist`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
      signal,
      cache: "no-store",
    });

  try {
    let response = await insert({ email, source_ref: sourceRef });
    let detail = response.ok ? null : await storageError(response);
    if (response.status === 400) {
      // Older waitlist tables predate the source_ref column (PGRST204).
      // A signup with lost attribution beats a lost signup — retry bare.
      if (detail?.code === "PGRST204" && detail.message.includes("source_ref")) {
        console.error(
          "[waitlist] waitlist table is missing the source_ref column — storing signup without attribution. Run: alter table waitlist add column source_ref text not null default 'direct';",
        );
        response = await insert({ email });
        detail = response.ok ? null : await storageError(response);
      }
    }
    if (response.ok) {
      return "stored";
    }
    // PostgREST also uses 409 for foreign-key violations. Only a unique
    // constraint conflict is the duplicate path; the live email constraint
    // must be verified at release acceptance.
    if (response.status === 409 && detail?.code === "23505") {
      return "duplicate";
    }
    // Error details can contain the submitted address; retain only status/code.
    console.error(`[waitlist] supabase insert failed: ${response.status} ${detail?.code ?? "unknown"}`);
    return "error";
  } catch {
    console.error("[waitlist] supabase request failed or timed out; storage outcome unconfirmed");
    return "error";
  }
}

async function storageError(response: Response): Promise<{ code: string; message: string } | null> {
  const value: unknown = await response.json().catch(() => null);
  if (typeof value !== "object" || value === null) return null;
  const error = value as Record<string, unknown>;
  return {
    code: typeof error.code === "string" && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(error.code) ? error.code : "unknown",
    message: typeof error.message === "string" ? error.message : "",
  };
}
