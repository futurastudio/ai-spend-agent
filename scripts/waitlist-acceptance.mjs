#!/usr/bin/env node
// Operator-only acceptance. Dry run by default; no env-file or credential discovery.
// Signup makes exactly two public form requests for ONE explicitly approved inbox.
// The database and Resend calls are read-only. Nothing is retried or deleted.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const hash = value => createHash("sha256").update(value).digest("hex");
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const normalize = value => typeof value === "string" ? value.trim().toLowerCase() : "";

export async function acceptWaitlist(options, { fetchImpl = fetch, env = process.env } = {}) {
  const phase = options.phase ?? "signup";
  const email = normalize(options.inbox);
  const ref = options.ref;
  requireCondition(phase === "signup" || phase === "verify", "Phase must be signup or verify.");
  requireCondition(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254, "Provide --approved-inbox with the explicitly approved test recipient.");
  requireCondition(typeof ref === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(ref), "Provide a lowercase --test-ref (1–64 letters, digits, hyphens or underscores).");
  let base;
  try { base = new URL(options.base); } catch { throw new Error("Provide --base-url with the intended HTTPS deployment origin."); }
  requireCondition(base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "The deployment must be an HTTPS origin without a path, credentials or query.");
  const receipt = { phase, deployment: base.origin, recipient_sha256: hash(email), test_ref: ref };
  if (!options.execute) return {
    ...receipt, status: "dry_run", network_requests: 0,
    planned: phase === "signup"
      ? ["Confirm the approved recipient has no existing row.", "Submit the marked form once; verify one durable row and test attribution.", "Submit a case-normalized duplicate; verify one unchanged row."]
      : ["Read the durable row and supplied provider message ID; compare recipient, send time, sender and reply inbox."],
    required_environment: phase === "signup"
      ? ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
      : ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_READ_API_KEY", "WAITLIST_EMAIL_FROM", "WAITLIST_EMAIL_REPLY_TO"],
    note: "No secrets are printed. --execute is required for any network request. Inbox receipt and duplicate-send suppression require separate operator checks.",
  };

  let storage;
  try { storage = new URL(env.SUPABASE_URL); } catch { throw new Error("SUPABASE_URL must be supplied by the operator."); }
  requireCondition(storage.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/.test(storage.hostname) && !storage.username && !storage.password && !storage.search && !storage.hash && storage.pathname === "/", "SUPABASE_URL must be the intended HTTPS Supabase project origin.");
  requireCondition(Boolean(env.SUPABASE_SERVICE_ROLE_KEY), "Operator-supplied SUPABASE_SERVICE_ROLE_KEY is required for the read-only row check.");
  const getJson = async (url, init, label) => {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new Error(`${label}: request failed or timed out. No automatic retry; inspect the recorded state before continuing.`); }
    requireCondition(response.ok, `${label}: HTTP ${response.status}; response body withheld.`);
    try { return { status: response.status, body: await response.json() }; }
    catch { throw new Error(`${label}: unreadable response. No automatic retry.`); }
  };
  const rowUrl = new URL("/rest/v1/waitlist", storage);
  rowUrl.searchParams.set("select", "email,source_ref");
  rowUrl.searchParams.set("email", `eq.${email}`);
  rowUrl.searchParams.set("limit", "2");
  const readRows = async () => {
    const { body } = await getJson(rowUrl, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }, "Durable row read");
    requireCondition(Array.isArray(body), "Durable row read did not return a row array.");
    return body;
  };
  const assertRow = rows => {
    requireCondition(rows.length === 1 && rows[0].email === email && rows[0].source_ref === ref, "Expected exactly one normalized durable row with the approved test referral.");
    return { count: 1, recipient_sha256: hash(rows[0].email), source_ref: rows[0].source_ref };
  };
  const started = new Date().toISOString();
  if (phase === "signup") {
    requireCondition((await readRows()).length === 0, "The approved inbox already has a row. Stopped without sending; use verify for an existing acceptance receipt.");
    const submit = async (address, source) => {
      const result = await getJson(new URL("/api/waitlist", base), {
        method: "POST", headers: { "Content-Type": "application/json", "x-tilden-confirmation": "waitlist-v1" },
        body: JSON.stringify({ email: address, ref: source }),
      }, "Public signup");
      requireCondition(result.status === 201 && result.body?.ok === true, "Public signup was not acknowledged. Inspect storage before retrying.");
      return result.status;
    };
    const first = await submit(email, ref);
    assertRow(await readRows());
    const duplicate = await submit(` ${email.toUpperCase()} `, `${ref.slice(0, 57)}-repeat`);
    return {
      ...receipt, started_at: started, finished_at: new Date().toISOString(),
      status: "storage_verified_email_pending", durable_row: assertRow(await readRows()),
      first_response: first, duplicate_response: duplicate, duplicate_preserved_original_ref: true,
      email: { status: "unverified", next: "Copy the accepted provider message ID from this request's server log, then run verify with this receipt. Confirm only one send in provider logs and actual inbox receipt separately." },
      acquisition: "Exclude this exact test_ref from launch signup metrics; retain the row as acceptance evidence.",
    };
  }

  const proof = options.proof;
  requireCondition(proof?.status === "storage_verified_email_pending" && proof.recipient_sha256 === receipt.recipient_sha256 && proof.test_ref === ref && proof.deployment === base.origin, "Provide the matching signup receipt with --proof; no new registration will be sent.");
  requireCondition(typeof options.providerId === "string" && /^[a-z0-9-]{10,80}$/i.test(options.providerId), "Provide the provider message ID from the accepted-send log.");
  requireCondition(Boolean(env.RESEND_READ_API_KEY && env.WAITLIST_EMAIL_FROM && env.WAITLIST_EMAIL_REPLY_TO), "Operator-supplied RESEND_READ_API_KEY and expected sender/reply inbox are required. A sending-only key cannot retrieve acceptance evidence.");
  const durable = assertRow(await readRows());
  const { body: sent } = await getJson(`https://api.resend.com/emails/${options.providerId}`, { headers: { Authorization: `Bearer ${env.RESEND_READ_API_KEY}` } }, "Provider email read");
  requireCondition(sent.id === options.providerId && Array.isArray(sent.to) && sent.to.length === 1 && normalize(sent.to[0]) === email, "Provider message does not match the approved recipient.");
  requireCondition(sent.subject === "You’re on the Tilden waitlist", "Provider message is not the expected waitlist confirmation.");
  requireCondition(sent.from === `Tilden <${env.WAITLIST_EMAIL_FROM.trim()}>` && Array.isArray(sent.reply_to) && sent.reply_to.length === 1 && normalize(sent.reply_to[0]) === normalize(env.WAITLIST_EMAIL_REPLY_TO), "Provider sender or reply inbox differs from the intended configuration.");
  const created = Date.parse(sent.created_at);
  requireCondition(Number.isFinite(created) && created >= Date.parse(proof.started_at) - 60_000 && created <= Date.parse(proof.finished_at) + 60_000, "Provider send time falls outside this acceptance run.");
  return {
    ...receipt, started_at: started, finished_at: new Date().toISOString(), status: "provider_correlated",
    durable_row: durable, provider_message_id: sent.id, provider_created_at: new Date(created).toISOString(),
    provider_event: ["sent", "delivered", "bounced", "complained", "delivery_delayed", "failed"].includes(sent.last_event) ? sent.last_event : "other_or_unavailable",
    sender_matches: true, reply_inbox_matches: true,
    inbox_receipt: "Requires the approved recipient to confirm actual receipt and a working reply path.",
    duplicate_email_count: "Requires the operator to confirm exactly one send in provider logs for this acceptance run.",
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    phase: { type: "string" }, "base-url": { type: "string" }, "approved-inbox": { type: "string" },
    "test-ref": { type: "string" }, execute: { type: "boolean", default: false },
    "provider-id": { type: "string" }, proof: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Dry run: node scripts/waitlist-acceptance.mjs --base-url https://asktilden.com --approved-inbox APPROVED_ADDRESS --test-ref acceptance-YYYYMMDD\nExecute signup: add --execute --out /absolute/path/signup-receipt.json (operator-provided Supabase env required).\nVerify only: add --phase verify --proof /absolute/path/signup-receipt.json --provider-id ACCEPTED_ID; add --execute --out /absolute/path/provider-receipt.json to perform read-only checks.\nNo env files are loaded. Never put API keys on this command line. Existing output files are never overwritten. All receipts omit the full email and secrets.");
    return;
  }
  requireCondition(!values.execute || Boolean(values.out), "--execute requires --out for retained acceptance evidence.");
  const options = { phase: values.phase, base: values["base-url"], inbox: values["approved-inbox"], ref: values["test-ref"], execute: values.execute, providerId: values["provider-id"] };
  if (values.proof) {
    try { options.proof = JSON.parse(await readFile(values.proof, "utf8")); }
    catch { throw new Error("The signup receipt could not be read or parsed."); }
  }
  const plan = await acceptWaitlist({ ...options, execute: false });
  const context = { phase: plan.phase, deployment: plan.deployment, recipient_sha256: plan.recipient_sha256, test_ref: plan.test_ref, started_at: new Date().toISOString() };
  if (values.execute) await writeFile(values.out, JSON.stringify({ ...context, status: "started" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    const result = await acceptWaitlist(options);
    if (values.execute) await writeFile(values.out, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (values.execute) await writeFile(values.out, JSON.stringify({ ...context, status: "incomplete_inspect_before_retry", finished_at: new Date().toISOString(), error: error.message }, null, 2) + "\n", { mode: 0o600 });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
