import { mkdir, writeFile } from "node:fs/promises";
import { waitlistConfirmation } from "../apps/web/emails/waitlist-confirmation.ts";

// Node 22: node --experimental-strip-types scripts/preview-waitlist-email.mjs
// Writes the actual template for review. No environment access or email sending.
const destination = new URL("../review-2026-10-02/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL("waitlist-confirmation.html", destination), waitlistConfirmation.html);
await writeFile(new URL("waitlist-confirmation.txt", destination), `Subject: ${waitlistConfirmation.subject}\n\n${waitlistConfirmation.text}\n`);
console.log("Email preview saved to review-2026-10-02/waitlist-confirmation.html and .txt. Nothing sent.");
