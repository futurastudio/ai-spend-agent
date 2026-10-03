import { createHash } from "node:crypto";
import { waitlistConfirmation } from "../../emails/waitlist-confirmation";

type ConfirmationResult =
  | { status: "disabled" | "unconfigured" | "failed" }
  | { status: "accepted"; id: string };

// Bare mailbox addresses only. Display name is controlled here, not by input.
const MAILBOX_RE = /^[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i;
function validMailbox(value: string): boolean {
  return value.length <= 254 && MAILBOX_RE.test(value);
}

/** Called only after a new durable signup. No sends for duplicates or local TSV.
 * Bounded, awaited attempt; acceptance is not proof of inbox delivery.
 * A failure never reverses registration. There is no automatic retry/outbox.
 */
export async function sendWaitlistConfirmation(email: string): Promise<ConfirmationResult> {
  if (process.env.WAITLIST_CONFIRMATION_ENABLED !== "true") {
    return { status: "disabled" };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.WAITLIST_EMAIL_FROM?.trim() ?? "";
  const replyTo = process.env.WAITLIST_EMAIL_REPLY_TO?.trim() ?? "";
  if (!apiKey || !validMailbox(from) || !validMailbox(replyTo)) {
    console.error("[waitlist-confirmation] enabled but sender configuration is incomplete");
    return { status: "unconfigured" };
  }

  try {
    const recipientKey = createHash("sha256").update(email).digest("hex");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `waitlist-confirmation-v1/${recipientKey}`,
      },
      body: JSON.stringify({
        from: `Tilden <${from}>`,
        to: [email],
        reply_to: replyTo,
        ...waitlistConfirmation,
      }),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) {
      // Provider responses may contain recipient data. Log only status.
      console.error(`[waitlist-confirmation] provider rejected request: ${response.status}`);
      return { status: "failed" };
    }
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("id" in result)
      || typeof result.id !== "string" || !result.id) {
      console.error("[waitlist-confirmation] provider acceptance was not confirmed");
      return { status: "failed" };
    }
    console.info("[waitlist-confirmation] accepted", { id: result.id });
    return { status: "accepted", id: result.id };
  } catch {
    console.error("[waitlist-confirmation] request failed or timed out; signup is retained");
    return { status: "failed" };
  }
}
