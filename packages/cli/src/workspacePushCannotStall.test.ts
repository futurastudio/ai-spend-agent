import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentPlanFacts, type LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import { workspaceClock } from "./lib/clock.js";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, isWorkspaceSessionFact, prepareWorkspacePush, workspaceCanonicalJson, workspaceDomainHash, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceState, type WorkspaceTransport, type WorkspaceTransportResult
} from "./workspaceConnect.js";

/**
 * A push can never silently stall. A batch the Workspace refused as `expired` is dropped and its facts rebuilt under a
 * new consent, a lapsed connection says so and names the way back, and the commands this CLI tells a person to type
 * are ones that can read the state file. The sign-in reader stays real and is wrapped in a spy.
 */
vi.mock("@agent-finops/core", async (original) => {
  const actual = await original<typeof import("@agent-finops/core")>();
  return { ...actual, readAgentPlanFacts: vi.fn(actual.readAgentPlanFacts) };
});
const readPlanFiles = vi.mocked(readAgentPlanFacts);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = join(repoRoot, "packages/core/src/fixtures/local-agent-formats");
const ref = (char: string) => `oref_${char.repeat(43)}`;
const now = "2026-09-20T12:00:00.000Z";
const MINUTE = 60000;
const at = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
const parse = (body: string) => JSON.parse(body) as WorkspaceEnvelope;
const lines = (text: string) => text.split("\n");

const evidence = {
  inputTokens: "observed", outputTokens: "observed", cacheReadTokens: "observed",
  cacheWriteTokens: "not_separately_reported", thoughtTokens: "not_separately_reported", toolTokens: "not_separately_reported",
  calculatedTotalTokens: "calculated_partial", reportedTotalTokens: "not_reported"
} as const;
const call: LocalAgentCall = {
  agent: "codex", sessionId: "private-session", callId: "call-one", model: "gpt-5",
  timestamp: "2026-09-18T10:00:00.000Z", startedAt: "2026-09-18T10:00:00.000Z", usageScope: "turn",
  workingDirectory: "/private/repo", project: "repo", usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 },
  tokenComponentEvidence: evidence
};
const loaded = (calls: LocalAgentCall[]) => async () => ({ calls, records: [], diagnostics: [], sourceScans: [], filesParsed: 1, agentsDetected: ["codex" as const] });
const unexpectedRead = async (): Promise<never> => { throw Error("unexpected local read"); };

type Scripted = "pass" | "lost_before_commit" | "lost_after_commit" | { refuse: string } | { reply: WorkspaceTransportResult };
/** The push endpoint as a CLI meets it: identical replay first, a high water only an ACCEPT moves, then the ten-minute age limit and the two-minute skew limit. A refusal writes nothing. */
function workspaceServer(device: WorkspaceDevice) {
  const publicKey = createPublicKey(device.privateKeyPem);
  const batches = new Map<string, { payload: string; receipt: Record<string, unknown> }>();
  const refuse = (reason: string): WorkspaceTransportResult => ({ status: 409, body: { state: "refused", reason }, headers: {} });
  const server = {
    requests: [] as string[], replays: 0, sessionFacts: new Map<string, string>(), highWater: 0n, clock: now, script: [] as Scripted[],
    transport: (async (_path, payload) => {
      server.requests.push(payload);
      const scripted = server.script.shift() ?? "pass";
      if (scripted === "lost_before_commit") throw Error("lost reply");
      if (typeof scripted === "object") return "refuse" in scripted ? refuse(scripted.refuse) : scripted.reply;
      const reply = admit(payload);
      if (scripted === "lost_after_commit") throw Error("lost reply");
      return reply;
    }) as WorkspaceTransport
  };
  const admit = (payload: string): WorkspaceTransportResult => {
    const envelope = parse(payload);
    const { signature, ...signed } = envelope;
    if (!verify(null, Buffer.from(workspaceCanonicalJson(signed as never)), publicKey, Buffer.from(signature.value, "base64url")))
      return { status: 503, body: { state: "unavailable", retry: "same_envelope_only" } };
    const prior = batches.get(envelope.idempotencyKey);
    if (prior) { if (prior.payload !== payload) return refuse("conflict"); server.replays++; return { status: 200, body: prior.receipt, headers: { "x-tilden-push-capabilities": "agentPlanFacts=1" } }; }
    if (BigInt(envelope.sequence) <= server.highWater) return refuse("conflict");
    const age = Date.parse(server.clock) - Date.parse(envelope.generatedAt);
    if (age > 10 * MINUTE || age < -2 * MINUTE) return refuse("expired");
    for (const fact of envelope.facts.filter(isWorkspaceSessionFact)) server.sessionFacts.set(fact.day, fact.factRevision);
    const receipt = { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash, factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: server.clock };
    batches.set(envelope.idempotencyKey, { payload, receipt });
    server.highWater = BigInt(envelope.sequence);
    return { status: 200, body: receipt, headers: { "x-tilden-push-capabilities": "agentPlanFacts=1" } };
  };
  return server;
}

async function machine(options: { planFiles?: boolean; capability?: boolean; expiresAt?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "aibill-cannot-stall-"));
  const key = generateKeyPairSync("ed25519");
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: options.expiresAt ?? "2027-09-01T00:00:00.000Z" };
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null,
    ...(options.capability === undefined ? {} : { capabilities: { agentPlanFacts: options.capability } }) };
  const privateDir = join(home, ".aibill");
  await mkdir(privateDir, { mode: 0o700 });
  const statePath = join(privateDir, "workspace-device.json");
  await writeFile(statePath, workspaceCanonicalJson(state as never), { mode: 0o600 });
  if (options.planFiles) {
    await cp(join(fixtureRoot, "claude-code-plan-v1/claude.json"), join(home, ".claude.json"));
  }
  const server = workspaceServer(device);
  const push = async (calls: LocalAgentCall[], run: { at?: string; serverAt?: string; answers?: string[]; load?: () => Promise<never>; transport?: WorkspaceTransport } = {}) => {
    const moment = run.at ?? now, before = server.requests.length, messages: string[] = [], answers = run.answers ? [...run.answers] : undefined;
    server.clock = run.serverAt ?? moment;
    const result = await runCli(["workspace", "push"], { homeDirectory: home, interactive: true, workspaceNow: moment, workspaceLoadCalls: run.load ?? loaded(calls),
      consentRead: async (message: string) => { messages.push(message); return answers ? answers.shift() ?? "n" : "y"; },
      workspaceTransport: run.transport ?? server.transport });
    return { ...result, messages, sent: server.requests.slice(before) };
  };
  const raw = () => readFile(statePath, "utf8");
  const read = async () => JSON.parse(await raw()) as WorkspaceState;
  const edit = async (change: (state: Record<string, any>) => void) => { const held = JSON.parse(await raw()) as Record<string, any>; change(held); await writeFile(statePath, JSON.stringify(held), { mode: 0o600 }); };
  const status = (moment = now) => runCli(["workspace", "status"], { homeDirectory: home, workspaceNow: moment });
  /** A batch this machine already holds, as a CLI before this one leaves it. */
  const hold = async (kind: "refused" | "uncertain", refusal: "invalid" | "conflict" | "stale" | "expired" | null, signedAt = at(-12 * MINUTE)) => {
    const first = await machineEnvelope(device, signedAt);
    await edit(held => { held.pending = { envelope: first, state: kind, refusal }; });
    return first;
  };
  return { home, device, statePath, server, push, raw, read, edit, status, hold };
}
/** One well-formed session fact, signed as a push would sign it. */
async function machineEnvelope(device: WorkspaceDevice, signedAt: string): Promise<WorkspaceEnvelope> {
  const refs = [`sha256_${"1".repeat(64)}`];
  return buildWorkspaceEnvelope(device, [{ day: "2026-09-18", agent: "codex", provider: "openai", model: "gpt-5", projectName: "repo", directoryRef: `sha256_${"0".repeat(64)}`, apiKeyRef: null, workspaceRef: null,
    sessionCount: "1", sessionRefs: refs, tokens: { uncachedInputTokens: "20", cacheReadTokens: "3", cacheWriteTokens: null, outputTokens: "5" },
    sessionsHash: workspaceDomainHash("tilden:local-session-identities:v1", refs), factRevision: "1" }], signedAt);
}

const NOT_STORED = "Workspace did not store it, so nothing was counted, and this machine dropped it.";
const NEXT_PUSH = "Run npx aibill@latest workspace push to rebuild its session facts into a new batch, with a new preview; nothing goes without your yes.";
const lateLines = (signedAt: string) => [`Workspace refused this batch because it was signed at ${signedAt}, more than 10 minutes ago. ${NOT_STORED}`, NEXT_PUSH];
const clockLines = (signedAt: string) => [`Workspace refused this batch as out of date, though this machine signed it under 10 minutes ago, at ${signedAt} by its clock. ${NOT_STORED}`,
  "This machine's clock looks ahead of Workspace's, or more than 10 minutes behind it: check it.", NEXT_PUSH];
const HELD_DROPPED = "A retained batch Workspace had refused as too old was dropped. Workspace did not store it, so nothing was counted.";
const REFUSED_RETAINED = "Workspace refused this batch. Its exact envelope and refusal are retained; no new nonce was created.";
const REFUSED_STOP = "A retained batch was refused. No new envelope or nonce was created; resolve the refusal before pushing again.";
const UNKNOWN_OUTCOME = "Push outcome is unknown. The exact signed envelope is retained; run npx aibill@latest workspace push to review and explicitly retry this exact batch.";
const SESSIONS_ACCEPTED = "Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.";
const IDLE = "No changed eligible local session facts to push.";
const RECONNECT = "To connect again, run npx aibill@latest workspace disconnect, then npx aibill@latest workspace connect.";
const CLOCK_FIRST = "If that time has not passed, check this machine's clock first: a disconnect cannot be undone.";
const endedLine = (end: string) => `This machine's Workspace connection ended at ${end}, so no session facts were read or sent.`;
const RETAINED_ENDED = "A retained batch cannot be resent after that end, and the disconnect removes it.";
const newerState = (command: string) => `This machine's Workspace state was written by a newer aibill: it carries keys this version does not know, so this version stopped and nothing was changed. Run npx aibill@latest workspace ${command}.`;
const GENERAL_STOP = "Workspace operation stopped safely. Local state was not reset; inspect pairing status and permissions before continuing.";

beforeEach(() => {
  delete process.env.AI_SPEND_CLAUDE_CONFIG;
  delete process.env.AI_SPEND_CODEX_AUTH;
  readPlanFiles.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("a batch that never landed, resent late", () => {
  it("is refused once, dropped, and moves the sequence past it; the fact ledger does not move and the same command sends nothing else", async () => {
    const m = await machine();
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call]);
    expect(lost).toMatchObject({ exitCode: 1, stderr: UNKNOWN_OUTCOME });
    const signedAt = parse(lost.sent[0]!).generatedAt;
    expect((await m.read()).pending?.state).toBe("uncertain");

    const resend = await m.push([], { at: at(12 * MINUTE), load: unexpectedRead });
    expect(resend.sent).toEqual(lost.sent);
    expect(resend.messages).toHaveLength(1);
    expect(resend.exitCode).toBe(1);
    expect(resend.stdout).toBe("");
    expect(lines(resend.stderr)).toEqual(lateLines(signedAt));
    const state = await m.read();
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
    expect(state.facts).toEqual({});
    expect(state.lastAcceptedAt).toBeNull();
    expect(m.server.highWater).toBe(0n);
  });

  it("rebuilds the same session facts under a fresh preview: a no sends and retains nothing, and only a yes sends them, at a higher sequence with new ids", async () => {
    const m = await machine();
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call]);
    await m.push([], { at: at(12 * MINUTE), load: unexpectedRead });
    const gone = parse(lost.sent[0]!), later = at(13 * MINUTE);

    const before = await m.raw();
    const declined = await m.push([call], { at: later, answers: ["n"] });
    expect(declined).toMatchObject({ exitCode: 0, stdout: "Not sent.", sent: [] });
    expect(declined.messages).toHaveLength(1);
    expect(declined.messages[0]).toContain("Exact outgoing local facts");
    expect(declined.messages[0]).not.toContain("identical retained signed batch");
    expect(await m.raw()).toBe(before);

    const sent = await m.push([call], { at: later });
    expect(sent.exitCode).toBe(0);
    expect(lines(sent.stdout)[0]).toBe(SESSIONS_ACCEPTED);
    const fresh = parse(sent.sent[0]!);
    expect(fresh.facts).toEqual(gone.facts);
    expect(fresh.sequence).toBe("2");
    expect(fresh.generatedAt).toBe(later);
    expect(fresh.nonce).not.toBe(gone.nonce);
    expect(fresh.batchId).not.toBe(gone.batchId);
    expect(fresh.idempotencyKey).not.toBe(gone.idempotencyKey);
    expect(m.server.sessionFacts.get("2026-09-18")).toBe("1");
    const state = await m.read();
    expect(Object.keys(state.facts)).toHaveLength(1);
    expect(state.device.sequence).toBe("2");
    expect(await m.push([call], { at: later })).toMatchObject({ exitCode: 0, sent: [], messages: [] });
  });

  it("keeps what the Workspace announced: the refusal says nothing about it, and the next batch carries the tier beside the same session facts", async () => {
    const m = await machine({ capability: true, planFiles: true });
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call]);
    expect(parse(lost.sent[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(true);
    const resend = await m.push([], { at: at(12 * MINUTE), load: unexpectedRead });
    expect(resend.exitCode).toBe(1);
    expect((await m.read()).capabilities).toEqual({ agentPlanFacts: true });
    const later = at(13 * MINUTE), sent = await m.push([call], { at: later });
    expect(sent.exitCode).toBe(0);
    const fresh = parse(sent.sent[0]!);
    expect(fresh.facts.filter(isWorkspaceSessionFact)).toEqual(parse(lost.sent[0]!).facts.filter(isWorkspaceSessionFact));
    // The tier is read again for the new batch: observedAt is this push's, not the dropped one's.
    expect(fresh.facts.filter(isWorkspaceAgentPlanFact)).toEqual([expect.objectContaining({ agent: "claude_code", observedAt: later })]);
    expect((await m.read()).agentPlansAccepted?.claude_code?.sentAt).toBe(later);
  });

  it("a batch that did land, its reply lost, replays its receipt 12 minutes later: nothing is dropped and no fact is counted twice", async () => {
    const m = await machine();
    m.server.script = ["lost_after_commit"];
    const lost = await m.push([call]);
    expect(lost.exitCode).toBe(1);
    expect(m.server.highWater).toBe(1n);
    const resend = await m.push([], { at: at(12 * MINUTE), load: unexpectedRead });
    expect(resend.sent).toEqual(lost.sent);
    expect(resend.exitCode).toBe(0);
    expect(lines(resend.stdout)[0]).toBe(SESSIONS_ACCEPTED);
    expect(m.server.replays).toBe(1);
    expect(m.server.highWater).toBe(1n);
    const state = await m.read();
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
    expect(Object.keys(state.facts)).toHaveLength(1);
    expect(await m.push([call], { at: at(13 * MINUTE) })).toMatchObject({ exitCode: 0, sent: [], messages: [] });
  });

  it("a no on the late resend leaves it retained, because only the identical resend can reconcile it", async () => {
    const m = await machine();
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call]);
    const before = await m.raw();
    const declined = await m.push([], { at: at(12 * MINUTE), answers: ["n"], load: unexpectedRead });
    expect(declined).toMatchObject({ exitCode: 0, stdout: "Not sent.", sent: [] });
    expect(await m.raw()).toBe(before);
    expect((await m.read()).pending?.envelope.nonce).toBe(parse(lost.sent[0]!).nonce);
  });

  it.each(["invalid", "conflict", "stale"])("%s stays exactly as it was: retained, and every later push stops", async (reason) => {
    const m = await machine();
    m.server.script = [{ refuse: reason }];
    const run = await m.push([call]);
    expect(run).toMatchObject({ exitCode: 1, stdout: "", stderr: REFUSED_RETAINED });
    const held = await m.read();
    expect(held.pending).toMatchObject({ state: "refused", refusal: reason });
    expect(held.device.sequence).toBe("0");
    const next = await m.push([call], { load: unexpectedRead });
    expect(next).toMatchObject({ exitCode: 1, stderr: REFUSED_STOP, sent: [], messages: [] });
    expect(await m.read()).toEqual(held);
  });

  it.each([
    ["an extra key", { status: 409, body: { state: "refused", reason: "expired", from: "a proxy" } }],
    ["no reason", { status: 409, body: { state: "refused" } }],
    ["a reason this CLI has not met", { status: 409, body: { state: "refused", reason: "too_old" } }],
    ["another status", { status: 410, body: { state: "refused", reason: "expired" } }],
  ])("only the Workspace's exact refusal counts: %s stays an unknown outcome and the batch stays retained", async (_name, reply) => {
    const m = await machine();
    m.server.script = [{ reply }];
    const run = await m.push([call]);
    expect(run).toMatchObject({ exitCode: 1, stderr: UNKNOWN_OUTCOME });
    expect((await m.read()).pending?.state).toBe("uncertain");
    expect((await m.read()).device.sequence).toBe("0");
  });
});

describe("a clock that is off gets the same refusal on a first send", () => {
  it("ahead: one batch per command, the clock line, no loop; the same facts land once the clock is right", async () => {
    const m = await machine();
    const ahead = at(3 * MINUTE);
    const first = await m.push([call], { at: ahead, serverAt: now });
    expect(first.sent).toHaveLength(1);
    expect(first.messages).toHaveLength(1);
    expect(first.exitCode).toBe(1);
    expect(lines(first.stderr)).toEqual(clockLines(ahead));
    expect(await m.read()).toMatchObject({ pending: null, device: { sequence: "1" }, facts: {} });

    const second = await m.push([call], { at: ahead, serverAt: now });
    expect(second.sent).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    expect(parse(second.sent[0]!).sequence).toBe("2");
    expect(lines(second.stderr)).toEqual(clockLines(ahead));

    const right = await m.push([call]);
    expect(right.exitCode).toBe(0);
    const fresh = parse(right.sent[0]!);
    expect(fresh.facts).toEqual(parse(first.sent[0]!).facts);
    expect(fresh.sequence).toBe("3");
  });

  it("far behind: the batch was signed moments ago by its own clock, so the line says so too", async () => {
    const m = await machine();
    const behind = at(-12 * MINUTE);
    const run = await m.push([call], { at: behind, serverAt: now });
    expect(run.exitCode).toBe(1);
    expect(lines(run.stderr)).toEqual(clockLines(behind));
    expect(run.sent).toHaveLength(1);
  });

  it("the line turns on 10 minutes by the local clock: just under says check the clock, and 10 minutes or more says the batch is old", async () => {
    const under = await machine();
    under.server.script = ["lost_before_commit", { refuse: "expired" }];
    const lostUnder = await under.push([call]);
    const justUnder = await under.push([], { at: at(10 * MINUTE - 1), load: unexpectedRead });
    expect(lines(justUnder.stderr)).toEqual(clockLines(parse(lostUnder.sent[0]!).generatedAt));

    const over = await machine();
    over.server.script = ["lost_before_commit", { refuse: "expired" }];
    const lostOver = await over.push([call]);
    const exactly = await over.push([], { at: at(10 * MINUTE), load: unexpectedRead });
    expect(lines(exactly.stderr)).toEqual(lateLines(parse(lostOver.sent[0]!).generatedAt));
  });
});

describe("a batch a CLI before this one already retained as refused and expired", () => {
  it("is dropped before anything is read from the network, and a fresh preview offers the same facts", async () => {
    const m = await machine();
    const held = await m.hold("refused", "expired");
    const run = await m.push([call]);
    expect(run.messages).toHaveLength(1);
    expect(lines(run.messages[0]!).slice(0, 3)).toEqual([HELD_DROPPED, "This is a new batch:", "Exact outgoing local facts (no prompts, paths, session IDs, or amounts):"]);
    expect(run.messages[0]).not.toContain("identical retained signed batch");
    expect(run.sent).toHaveLength(1);
    expect(run.sent).not.toContain(workspaceCanonicalJson(held as never));
    const fresh = parse(run.sent[0]!);
    expect(fresh.sequence).toBe("2");
    expect(fresh.nonce).not.toBe(held.nonce);
    expect(fresh.generatedAt).toBe(now);
    expect(run.exitCode).toBe(0);
    expect((await m.read()).pending).toBeNull();
  });

  it("stays dropped on a no, and asks nothing further of the old batch", async () => {
    const m = await machine();
    await m.hold("refused", "expired");
    const run = await m.push([call], { answers: ["n"] });
    expect(run).toMatchObject({ exitCode: 0, stdout: "Not sent.", sent: [] });
    const state = await m.read();
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
    expect(state.facts).toEqual({});
    const next = await m.push([call], { answers: ["n"] });
    expect(next.messages[0]).not.toContain(HELD_DROPPED);
  });

  it("says so when nothing is left to send", async () => {
    const m = await machine({ capability: true });
    await m.hold("refused", "expired");
    const run = await m.push([]);
    expect(run).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(lines(run.stdout)).toEqual([HELD_DROPPED, IDLE]);
    expect((await m.read()).pending).toBeNull();
  });

  it.each(["invalid", "conflict", "stale"] as const)("prepareWorkspacePush keeps a retained %s refusal: only expired is dropped", async (refusal) => {
    const m = await machine();
    await m.hold("refused", refusal);
    const before = await m.raw();
    const confirm = vi.fn(async () => true);
    expect(await prepareWorkspacePush({ home: m.home, calls: [call], generatedAt: now, confirm })).toEqual({ state: "pending" });
    expect(confirm).not.toHaveBeenCalled();
    expect(await m.raw()).toBe(before);
  });

  it("waits for a push that can read the logs: a stop before that changes nothing", async () => {
    const m = await machine();
    await m.hold("refused", "expired");
    const before = await m.raw();
    const blocked = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceNow: now, consentRead: async () => "y", workspaceTransport: m.server.transport,
      workspaceLoadCalls: async () => ({ calls: [], records: [], sourceScans: [], filesParsed: 0, agentsDetected: [], diagnostics: [{ agent: "codex" as const, code: "malformed_jsonl" as const, severity: "warning" as const, count: 1, message: "hidden" }] }) });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("Local source reading is incomplete");
    expect(await m.raw()).toBe(before);
  });
});

describe("a lapsed connection says so", () => {
  it.each([["at its end", now], ["past its end", at(86400000)]])("%s: a push stops with exit 1 before reading anything, asks nothing, sends nothing and changes nothing", async (_name, moment) => {
    const m = await machine({ capability: true, planFiles: true, expiresAt: now });
    const before = await m.raw();
    const run = await m.push([call], { at: moment, load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stdout: "", sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([endedLine(now), RECONNECT, CLOCK_FIRST]);
    expect(readPlanFiles).not.toHaveBeenCalled();
    expect(await m.raw()).toBe(before);
  });

  it("the last moment before the end still pushes", async () => {
    const end = at(1), m = await machine({ expiresAt: end });
    const run = await m.push([call]);
    expect(run.exitCode).toBe(0);
    expect(run.sent).toHaveLength(1);
  });

  it("a retained batch is not resent: Workspace answers every push after the end with 403, before any replay, so a yes could only say the outcome is unknown again", async () => {
    const m = await machine({ expiresAt: at(MINUTE) });
    m.server.script = ["lost_before_commit"];
    await m.push([call]);
    const before = await m.raw();
    const run = await m.push([], { at: at(2 * MINUTE), load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stdout: "", sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([endedLine(at(MINUTE)), RETAINED_ENDED, RECONNECT, CLOCK_FIRST]);
    expect(await m.raw()).toBe(before);
  });

  it.each(["invalid", "expired"] as const)("wins over a retained %s refusal, and drops nothing", async (refusal) => {
    const m = await machine({ expiresAt: at(MINUTE) });
    await m.hold("refused", refusal);
    const before = await m.raw();
    const run = await m.push([call], { at: at(2 * MINUTE), load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([endedLine(at(MINUTE)), RETAINED_ENDED, RECONNECT, CLOCK_FIRST]);
    expect(await m.raw()).toBe(before);
  });

  it("a disconnect already under way keeps its own words", async () => {
    const m = await machine({ expiresAt: now });
    await m.edit(held => { held.disconnect = { state: "uncertain", requestId: ref("r"), revokedAt: null }; });
    const run = await m.push([], { load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stderr: "Disconnect is pending or complete. No session facts were read or sent." });
  });

  it("status names the end before it and after it, always exits 0, and reads nothing but the pairing record", async () => {
    const m = await machine({ expiresAt: at(MINUTE) });
    const before = await m.status(now);
    expect(before.exitCode).toBe(0);
    expect(lines(before.stdout)).toContain(`Connection ends: ${at(MINUTE)}`);
    expect(before.stdout).not.toContain("workspace disconnect");

    const after = await m.status(at(MINUTE));
    expect(after.exitCode).toBe(0);
    const printed = lines(after.stdout);
    expect(printed).toContain(`Connection ended: ${at(MINUTE)}`);
    expect(printed).not.toContain(`Connection ends: ${at(MINUTE)}`);
    expect(printed).toContain("Pushes stop there: Workspace refuses every push from this machine after that end.");
    expect(printed).toContain(RECONNECT);
    expect(printed).toContain(CLOCK_FIRST);
    expect(printed.at(-1)).toBe("Status reads local pairing state only; it does not confirm current server grant authority.");
    expect(readPlanFiles).not.toHaveBeenCalled();
  });

  it("status gives no directions while a disconnect is under way: that command has its own", async () => {
    const m = await machine({ expiresAt: now });
    await m.edit(held => { held.disconnect = { state: "uncertain", requestId: ref("r"), revokedAt: null }; });
    const status = await m.status(now);
    expect(lines(status.stdout)).toContain(`Connection ended: ${now}`);
    expect(status.stdout).not.toContain(RECONNECT);
  });

  it("the commands the line names are the way back: connect alone refuses, disconnect works past the end, and connect then starts a new request", async () => {
    const m = await machine({ expiresAt: now });
    const runtime = { homeDirectory: m.home, interactive: true, workspaceNow: at(MINUTE), consentRead: async () => "y" };
    const refused = await runCli(["workspace", "connect"], runtime);
    expect(refused).toMatchObject({ exitCode: 1, stderr: "This machine is already connected. Disconnect it before starting another connection request." });
    const disconnected = await runCli(["workspace", "disconnect"], { ...runtime, workspaceDisconnectTransport: async (body: string) => {
      const proof = JSON.parse(body) as { grantId: string; connectionEpoch: string };
      return { status: 200, body: { state: "revoked", grantId: proof.grantId, connectionEpoch: String(BigInt(proof.connectionEpoch) + 1n), revokedAt: at(MINUTE) } };
    } });
    expect(disconnected).toMatchObject({ exitCode: 0, stdout: "Workspace revoked this machine grant. Local pairing was removed." });
    await expect(lstat(m.statePath)).rejects.toThrow();
    const request = await runCli(["workspace", "connect"], runtime);
    expect(request.exitCode).toBe(0);
    expect(request.stdout).toContain("New connection request:");
    expect(request.stdout).toContain("Then run: npx aibill@latest workspace connect <response-bundle>");
  });

  it("a follow-up that crosses the end builds no tier batch, and the accepted line stands", async () => {
    const m = await machine({ planFiles: true, expiresAt: at(MINUTE) });
    const clock = vi.spyOn(workspaceClock, "now").mockReturnValueOnce(now).mockReturnValue(at(MINUTE));
    const messages: string[] = [];
    const run = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceLoadCalls: loaded([call]), consentRead: async (message: string) => { messages.push(message); return "y"; }, workspaceTransport: m.server.transport });
    expect(clock).toHaveBeenCalled();
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(SESSIONS_ACCEPTED);
    expect(messages).toHaveLength(1);
    expect(m.server.requests).toHaveLength(1);
    expect(readPlanFiles).not.toHaveBeenCalled();
  });
});

describe("the command this CLI tells a person to type", () => {
  it("the help names every Workspace command with @latest", async () => {
    const help = (await runCli(["--help"])).stdout;
    const named = lines(help).filter(line => /\bworkspace (connect|push|status|disconnect)\b/.test(line));
    expect(named).toHaveLength(7);
    for (const line of named) expect(line.trimStart().startsWith("npx aibill@latest workspace "), line).toBe(true);
  });

  it("no printed string in the CLI, and no doc, names a Workspace command without it", async () => {
    const source = await readFile(join(repoRoot, "packages/cli/src/index.ts"), "utf8");
    expect(source).not.toMatch(/npx aibill workspace/);
    expect(source).not.toMatch(/npx --yes aibill workspace/);
    expect(source).not.toMatch(/[Rr]un workspace (connect|push|status|disconnect)/);
    for (const name of ["README.md", "docs/WORKSPACE.md", "docs/CLI_REFERENCE.md", "packages/cli/README.md", "packages/aibill/README.md"]) {
      const text = await readFile(join(repoRoot, name), "utf8");
      expect(text, name).not.toMatch(/npx (ai-spend-agent|aibill) workspace/);
    }
  });

  it("each way out of a Workspace command says it", async () => {
    const m = await machine();
    const runtime = { homeDirectory: m.home, interactive: true, workspaceNow: now, consentRead: async () => "y" };
    expect((await runCli(["workspace", "nonsense"], runtime)).stderr).toBe("Use npx aibill@latest workspace connect [response-bundle], push, status, or disconnect.");
    expect((await runCli(["workspace", "disconnect", "--retry"], runtime)).stderr).toBe("No uncertain disconnect is retained. Run npx aibill@latest workspace disconnect without --retry to start a new disconnect.");

    const fresh = await mkdtemp(join(tmpdir(), "aibill-cannot-stall-fresh-"));
    const unused = { ...runtime, homeDirectory: fresh };
    expect((await runCli(["workspace", "connect"], unused)).exitCode).toBe(0);
    expect((await runCli(["workspace", "disconnect"], unused)).stdout).toBe("Unused native pairing key removed. No remote revocation was claimed. Run npx aibill@latest workspace connect to start a new request.");
  });
});

describe("a state file a newer aibill wrote", () => {
  const placements: [string, (state: Record<string, any>) => void][] = [
    ["at the top", state => { state.aKeyFromLater = { kept: true }; }],
    ["in the device record", state => { state.device.aKeyFromLater = "x"; }],
    ["in the capabilities", state => { state.capabilities = { agentPlanFacts: true, aKeyFromLater: true }; }],
    ["in an accepted tier", state => { state.agentPlansAccepted = { codex: { tier: "chatgpt_pro", tierRaw: "pro", sentAt: now, aKeyFromLater: 1 } }; }],
    ["under a new agent in the accepted tiers", state => { state.agentPlansAccepted = { later_agent: { tier: "unknown", tierRaw: "x", sentAt: now } }; }],
    ["in a ledger entry", state => { state.facts = { [`sha256_${"2".repeat(64)}`]: { revision: "1", contentHash: `sha256_${"3".repeat(64)}`, aKeyFromLater: 1 } }; }],
    ["in the disconnect record", state => { state.disconnect = { state: "uncertain", requestId: ref("r"), revokedAt: null, aKeyFromLater: 1 }; }],
  ];
  it.each(placements)("a key %s: a push says so, reads nothing, asks nothing, sends nothing and leaves the file byte for byte", async (_where, change) => {
    const m = await machine();
    await m.edit(change);
    const before = await m.raw();
    const run = await m.push([call], { load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stdout: "", stderr: newerState("push"), sent: [], messages: [] });
    expect(await m.raw()).toBe(before);
  });

  it("a key inside a retained batch says so too", async () => {
    for (const change of [(held: Record<string, any>) => { held.pending.aKeyFromLater = 1; }, (held: Record<string, any>) => { held.pending.envelope.aKeyFromLater = 1; }, (held: Record<string, any>) => { held.pending.envelope.facts[0].aKeyFromLater = 1; }]) {
      const fork = await machine();
      await fork.hold("uncertain", null, now);
      await fork.edit(change);
      const before = await fork.raw();
      expect(await fork.push([], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: newerState("push"), sent: [], messages: [] });
      expect(await fork.raw()).toBe(before);
    }
  });

  it("every Workspace command says so and names itself, and a pasted bundle is never echoed", async () => {
    const m = await machine();
    await m.edit(state => { state.aKeyFromLater = true; });
    const before = await m.raw();
    const runtime = { homeDirectory: m.home, interactive: true, workspaceNow: now, consentRead: async () => "y" };
    for (const [args, command] of [[["status"], "status"], [["push"], "push"], [["disconnect"], "disconnect"], [["disconnect", "--retry"], "disconnect --retry"], [["connect"], "connect"], [["connect", "--restart"], "connect --restart"], [["connect", "secret-response-bundle"], "connect <response-bundle>"]] as const) {
      const run = await runCli(["workspace", ...args], runtime);
      expect(run, command).toMatchObject({ exitCode: 1, stdout: "", stderr: newerState(command) });
      expect(run.stderr).not.toContain("secret-response-bundle");
      expect(await m.raw()).toBe(before);
    }
  });

  it("an unused connection request with a key this version does not know says so too", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "aibill-cannot-stall-enrollment-"));
    const runtime = { homeDirectory: fresh, interactive: true, workspaceNow: now, consentRead: async () => "y" };
    expect((await runCli(["workspace", "connect"], runtime)).exitCode).toBe(0);
    const path = join(fresh, ".aibill", "workspace-enrollment.json");
    const held = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const written = JSON.stringify({ ...held, aKeyFromLater: true });
    await writeFile(path, written, { mode: 0o600 });
    expect(await runCli(["workspace", "status"], runtime)).toMatchObject({ exitCode: 1, stderr: newerState("status") });
    expect(await runCli(["workspace", "connect"], runtime)).toMatchObject({ exitCode: 1, stderr: newerState("connect") });
    expect(await readFile(path, "utf8")).toBe(written);
  });

  it.each([
    ["a missing key", (state: Record<string, any>) => { delete state.lastAcceptedAt; }],
    ["a bad value", (state: Record<string, any>) => { state.version = 2; }],
    ["a bad nested value", (state: Record<string, any>) => { state.capabilities = { agentPlanFacts: "yes" }; }],
  ])("%s is not called newer: it keeps the general words and is not changed", async (_name, change) => {
    const m = await machine();
    await m.edit(change);
    const before = await m.raw();
    const run = await m.push([call], { load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stderr: GENERAL_STOP, sent: [], messages: [] });
    expect(await m.raw()).toBe(before);
  });

  it("a file that is not JSON keeps the general words", async () => {
    const m = await machine();
    await writeFile(m.statePath, "{ not json", { mode: 0o600 });
    const run = await m.push([call], { load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, stderr: GENERAL_STOP });
    expect(await m.raw()).toBe("{ not json");
  });

  it("a receipt from the Workspace with a key this version does not know is not a state file: it stays an unknown outcome", async () => {
    const m = await machine();
    m.server.script = [{ reply: { status: 200, body: { state: "accepted", aKeyFromLater: 1 } } }];
    const run = await m.push([call]);
    expect(run).toMatchObject({ exitCode: 1, stderr: UNKNOWN_OUTCOME });
    expect((await m.read()).pending?.state).toBe("uncertain");
  });
});
