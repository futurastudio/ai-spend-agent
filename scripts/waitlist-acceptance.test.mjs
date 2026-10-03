import test from "node:test";
import assert from "node:assert/strict";
import { acceptWaitlist } from "./waitlist-acceptance.mjs";

const options = { base: "https://asktilden.com", inbox: " Approved@Example.test ", ref: "acceptance-20261003", execute: true };
const env = { SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-storage-key", RESEND_READ_API_KEY: "fixture-provider-key", WAITLIST_EMAIL_FROM: "team@example.test", WAITLIST_EMAIL_REPLY_TO: "replies@example.test" };
const row = { email: "approved@example.test", source_ref: options.ref };

function queuedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(responses.length, "Unexpected network request");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return Response.json(next.body, { status: next.status ?? 200 });
  };
  return { fetchImpl, calls };
}

test("dry run performs no network calls, reads no credentials, and omits the address", async () => {
  const mock = queuedFetch([]);
  const result = await acceptWaitlist({ ...options, execute: false }, { ...mock, env: {} });
  assert.equal(result.status, "dry_run");
  assert.equal(mock.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /approved@example\.test/i);
});

test("refuses a credential destination outside the intended Supabase project host", async () => {
  const mock = queuedFetch([]);
  await assert.rejects(acceptWaitlist(options, { ...mock, env: { ...env, SUPABASE_URL: "https://supabase.co.attacker.test" } }), /intended HTTPS Supabase/);
  assert.equal(mock.calls.length, 0);
});

test("an existing row stops acceptance without a signup or send", async () => {
  const mock = queuedFetch([{ body: [row] }]);
  await assert.rejects(acceptWaitlist(options, { ...mock, env }), /already has a row/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].init.method, undefined);
});

test("checks durable attribution and normalized duplicate using only two public writes", async () => {
  const mock = queuedFetch([{ body: [] }, { status: 201, body: { ok: true } }, { body: [row] }, { status: 201, body: { ok: true } }, { body: [row] }]);
  const result = await acceptWaitlist(options, { ...mock, env });
  assert.equal(result.status, "storage_verified_email_pending");
  assert.equal(result.duplicate_preserved_original_ref, true);
  assert.equal(result.durable_row.count, 1);
  const posts = mock.calls.filter(call => call.init.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(call => call.url), ["https://asktilden.com/api/waitlist", "https://asktilden.com/api/waitlist"]);
  assert.deepEqual(JSON.parse(posts[0].init.body), { email: "approved@example.test", ref: options.ref });
  assert.deepEqual(JSON.parse(posts[1].init.body), { email: " APPROVED@EXAMPLE.TEST ", ref: `${options.ref}-repeat` });
  assert.ok(posts.every(call => call.init.headers["x-tilden-confirmation"] === "waitlist-v1"));
  assert.ok(mock.calls.every(call => call.init.redirect === "error"));
  assert.doesNotMatch(JSON.stringify(result), /approved@example\.test|fixture-storage-key|fixture-provider-key/i);
});

test("missing durable referral stops before the duplicate write", async () => {
  const mock = queuedFetch([{ body: [] }, { status: 201, body: { ok: true } }, { body: [{ ...row, source_ref: "direct" }] }]);
  await assert.rejects(acceptWaitlist(options, { ...mock, env }), /exactly one normalized durable row/);
  assert.equal(mock.calls.filter(call => call.init.method === "POST").length, 1);
});

test("an ambiguous signup timeout is not retried and raw network errors are withheld", async () => {
  const mock = queuedFetch([{ body: [] }, new Error("approved@example.test private-network-detail")]);
  await assert.rejects(acceptWaitlist(options, { ...mock, env }), error => {
    assert.match(error.message, /No automatic retry/);
    assert.doesNotMatch(error.message, /approved@example|private-network/);
    return true;
  });
  assert.equal(mock.calls.length, 2);
});

async function verifyFixture(recipient = "approved@example.test") {
  const dry = await acceptWaitlist({ ...options, execute: false }, { env: {} });
  const now = new Date().toISOString();
  const proof = { ...dry, status: "storage_verified_email_pending", started_at: now, finished_at: now };
  const providerId = "11111111-2222-4333-8444-555555555555";
  const mock = queuedFetch([{ body: [row] }, { body: {
    id: providerId, to: [recipient], subject: "You’re on the Tilden waitlist", from: "Tilden <team@example.test>",
    reply_to: ["replies@example.test"], created_at: now, last_event: "delivered",
  } }]);
  return { mock, result: acceptWaitlist({ ...options, phase: "verify", proof, providerId }, { ...mock, env }) };
}

test("provider verification correlates a single message and durable row without sending", async () => {
  const { mock, result } = await verifyFixture();
  const receipt = await result;
  assert.equal(receipt.status, "provider_correlated");
  assert.equal(receipt.provider_event, "delivered");
  assert.equal(receipt.sender_matches, true);
  assert.match(receipt.inbox_receipt, /Requires the approved recipient/);
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(call => !call.init.method || call.init.method === "GET"));
  assert.doesNotMatch(JSON.stringify(receipt), /approved@example\.test|fixture-storage-key|fixture-provider-key/i);
});

test("provider ID cannot be used as evidence for a different recipient", async () => {
  const { result } = await verifyFixture("someone-else@example.test");
  await assert.rejects(result, /does not match the approved recipient/);
});
