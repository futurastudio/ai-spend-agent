import { NextResponse } from "next/server";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

// Pragmatic email check — good enough to reject obvious junk without
// rejecting valid-but-unusual addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
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

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 422 },
    );
  }

  console.log(`[waitlist] new signup: ${email}`);

  const stored = await storeInSupabase(email);
  if (stored === "stored" || stored === "duplicate") {
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

  // Supabase not configured (local dev): append to a local file so no
  // signup is lost while developing.
  const entry = `${new Date().toISOString()}\t${email}\n`;
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
async function storeInSupabase(email: string): Promise<"stored" | "duplicate" | "error" | "skipped"> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return "skipped";
  }
  try {
    const response = await fetch(`${url}/rest/v1/waitlist`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ email }),
    });
    if (response.ok) {
      return "stored";
    }
    if (response.status === 409) {
      return "duplicate";
    }
    console.error(`[waitlist] supabase insert failed: ${response.status} ${await response.text()}`);
    return "error";
  } catch (err) {
    console.error("[waitlist] supabase unreachable:", err);
    return "error";
  }
}
