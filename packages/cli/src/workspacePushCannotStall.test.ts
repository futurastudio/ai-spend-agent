import { spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentPlanFacts, type LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import { workspaceClock } from "./lib/clock.js";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, isWorkspaceSessionFact, prepareWorkspacePlanFacts, prepareWorkspacePush, workspaceCanonicalJson, workspaceDomainHash, WorkspaceStateLocked, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceFact, type WorkspaceState, type WorkspaceTransport, type WorkspaceTransportResult
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
  const hold = async (kind: "refused" | "uncertain", refusal: "invalid" | "conflict" | "stale" | "expired" | null, signedAt = at(-12 * MINUTE), days?: string[]) => {
    const first = await machineEnvelope(device, signedAt, days);
    await edit(held => { held.pending = { envelope: first, state: kind, refusal }; });
    return first;
  };
  return { home, device, statePath, server, push, raw, read, edit, status, hold };
}
/** One well-formed session fact, signed as a push would sign it. */
async function machineEnvelope(device: WorkspaceDevice, signedAt: string, days: string[] = ["2026-09-18"]): Promise<WorkspaceEnvelope> {
  const refs = [`sha256_${"1".repeat(64)}`];
  return buildWorkspaceEnvelope(device, days.map(day => ({ day, agent: "codex", provider: "openai", model: "gpt-5", projectName: "repo", directoryRef: `sha256_${"0".repeat(64)}`, apiKeyRef: null, workspaceRef: null,
    sessionCount: "1", sessionRefs: refs, tokens: { uncachedInputTokens: "20", cacheReadTokens: "3", cacheWriteTokens: null, outputTokens: "5" },
    sessionsHash: workspaceDomainHash("tilden:local-session-identities:v1", refs), factRevision: "1" })), signedAt);
}

const NOT_STORED = "Workspace did not store it, so nothing was counted, and this machine dropped it.";
const NEXT_PUSH = "Run npx aibill@latest workspace push to rebuild its session facts into a new batch, with a new preview; nothing goes without your yes.";
const lateLines = (signedAt: string) => [`Workspace refused this batch because it was signed at ${signedAt}, more than 10 minutes ago. ${NOT_STORED}`, NEXT_PUSH];
const clockLines = (signedAt: string) => [`Workspace refused this batch as out of date, though this machine signed it under 10 minutes ago, at ${signedAt} by its clock. ${NOT_STORED}`,
  "This machine's clock looks ahead of Workspace's, or more than 10 minutes behind it: check it.", NEXT_PUSH];
const HELD_DROPPED = "A retained batch Workspace had refused as out of date was dropped. Workspace did not store it, so nothing was counted.";
const REFUSED_RETAINED = "Workspace refused this batch. Its exact envelope and refusal are retained; no new nonce was created.";
const REFUSED_STOP = "A retained batch was refused. No new envelope or nonce was created; resolve the refusal before pushing again.";
const UNKNOWN_OUTCOME = "Push outcome is unknown. The exact signed envelope is retained; run npx aibill@latest workspace push to review and explicitly retry this exact batch.";
const SESSIONS_ACCEPTED = "Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.";
const IDLE = "No changed eligible local session facts to push.";
const RECONNECT = "To connect again, run npx aibill@latest workspace disconnect, then npx aibill@latest workspace connect.";
const DISCONNECT_COST = "The disconnect also takes this machine's accepted session facts out of Workspace's projects and receipts; those days' shares move to unattributed cost.";
const CLOCK_FIRST = "If that time has not passed, check this machine's clock first: a disconnect cannot be undone.";
const CLOCK_OFF = "This machine's clock looks ahead of Workspace's, or more than 10 minutes behind it: check it.";
const LOCKED = "Another aibill Workspace command holds ~/.aibill/.workspace-device.lock, or one was killed and left it. If none is running, delete that file and run this command again.";
const LOCKED_STATUS = "Another aibill Workspace command holds ~/.aibill/.workspace-device.lock, or one was killed and left it. If none is running, delete that file before the next connect, push or disconnect.";
const MACHINE_REFUSED = `Workspace answered 403: it will not take a push from this machine right now. Open ${WORKSPACE_ORIGIN}/settings/machines. If it asks for this machine's sharing consent, finish that and push again. If it shows this machine disconnected or expired, run npx aibill@latest workspace disconnect, then npx aibill@latest workspace connect; that disconnect removes this retained batch.`;
const windowLine = (start: string) => `Its days before ${start} have left the 30-day window a push reads and stay out of Workspace.`;
const REBUILD_THE_REST = "Run npx aibill@latest workspace push to rebuild the rest of its session facts into a new batch, with a new preview; nothing goes without your yes.";
const ANYTHING_NEWER = "Run npx aibill@latest workspace push to send anything newer, with a new preview; nothing goes without your yes.";
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
    ["a status that is not a refusal", { status: 503, body: { state: "refused", reason: "expired" } }],
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
    expect(lines(run.stderr)).toEqual([endedLine(now), RECONNECT, DISCONNECT_COST, CLOCK_FIRST]);
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
    expect(lines(run.stderr)).toEqual([endedLine(at(MINUTE)), RETAINED_ENDED, RECONNECT, DISCONNECT_COST, CLOCK_FIRST]);
    expect(await m.raw()).toBe(before);
  });

  it.each(["invalid", "expired"] as const)("wins over a retained %s refusal, and drops nothing", async (refusal) => {
    const m = await machine({ expiresAt: at(MINUTE) });
    await m.hold("refused", refusal);
    const before = await m.raw();
    const run = await m.push([call], { at: at(2 * MINUTE), load: unexpectedRead });
    expect(run).toMatchObject({ exitCode: 1, sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([endedLine(at(MINUTE)), RETAINED_ENDED, RECONNECT, DISCONNECT_COST, CLOCK_FIRST]);
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
    expect(before.stdout).not.toContain(DISCONNECT_COST);

    const after = await m.status(at(MINUTE));
    expect(after.exitCode).toBe(0);
    const printed = lines(after.stdout);
    expect(printed).toContain(`Connection ended: ${at(MINUTE)}`);
    expect(printed).not.toContain(`Connection ends: ${at(MINUTE)}`);
    expect(printed).toContain("Pushes stop there: Workspace refuses every push from this machine after that end.");
    expect(printed).toContain(RECONNECT);
    expect(printed).toContain(DISCONNECT_COST);
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

describe("a command that was killed", { timeout: 60_000 }, () => {
  const lockPath = (home: string) => join(home, ".aibill", ".workspace-device.lock");
  /** A pid no process holds any more: a child that has run and been reaped. */
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
  const owner = (pid: number) => `${pid} ${hostname().replace(/\s+/g, "-")}\n`;

  it("names itself in its lock while it runs, and leaves none behind", async () => {
    const m = await machine();
    let seen = "";
    const run = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceNow: now, workspaceLoadCalls: loaded([call]),
      consentRead: async () => { seen = await readFile(lockPath(m.home), "utf8"); return "n"; } });
    expect(run).toMatchObject({ exitCode: 0, stdout: "Not sent." });
    expect(seen).toBe(owner(process.pid));
    await expect(lstat(lockPath(m.home))).rejects.toThrow();
  });

  it("left a lock whose process is gone: the next push takes it over and goes on to its preview, and status says nothing of it", async () => {
    const m = await machine();
    await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o600 });
    expect((await m.status()).stdout).not.toContain("workspace-device.lock");
    const run = await m.push([call]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(SESSIONS_ACCEPTED);
    expect(run.sent).toHaveLength(1);
    await expect(lstat(lockPath(m.home))).rejects.toThrow();
  });

  it("left a batch uncertain: the next push takes the lock over and asks about that exact batch", async () => {
    const m = await machine();
    m.server.script = ["lost_after_commit"];
    const lost = await m.push([call]);
    await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o600 });
    const run = await m.push([], { load: unexpectedRead });
    expect(run.sent).toEqual(lost.sent);
    expect(run.exitCode).toBe(0);
    expect(m.server.replays).toBe(1);
  });

  it("takes over for a disconnect too, which is the way back from a lapse", async () => {
    const m = await machine({ expiresAt: now });
    await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o600 });
    const run = await runCli(["workspace", "disconnect"], { homeDirectory: m.home, interactive: true, workspaceNow: at(MINUTE), consentRead: async () => "n" });
    expect(run).toMatchObject({ exitCode: 1, stderr: "Pairing kept. Disconnect was not confirmed; no request or key was removed." });
    await expect(lstat(lockPath(m.home))).rejects.toThrow();
  });

  it.each([
    ["this process, still running", () => owner(process.pid)],
    ["a process this user does not own", () => owner(1)],
    ["no owner, as a CLI before this one leaves it", () => ""],
    ["a gone process on another host", () => `${deadPid()} another-host\n`],
    ["a pid that is not one", () => `0 ${hostname().replace(/\s+/g, "-")}\n`],
    ["something else", () => "not a lock this CLI wrote\n"],
  ])("a lock naming %s stops each command with its own line, reads nothing, asks nothing, and is left where it is", async (_name, body) => {
    const m = await machine();
    const text = body();
    await writeFile(lockPath(m.home), text, { mode: 0o600 });
    const before = await m.raw();
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stdout: "", stderr: LOCKED, sent: [], messages: [] });
    const runtime = { homeDirectory: m.home, interactive: true, workspaceNow: now, consentRead: async () => "y" };
    expect(await runCli(["workspace", "disconnect"], runtime)).toMatchObject({ exitCode: 1, stderr: LOCKED });
    expect(await runCli(["workspace", "connect"], runtime)).toMatchObject({ exitCode: 1, stderr: LOCKED });
    expect(lines((await m.status()).stdout)).toContain(LOCKED_STATUS);
    expect(await readFile(lockPath(m.home), "utf8")).toBe(text);
    expect(await m.raw()).toBe(before);

    await rm(lockPath(m.home));
    expect((await m.status()).stdout).not.toContain("workspace-device.lock");
    expect(await m.push([call])).toMatchObject({ exitCode: 0, stdout: SESSIONS_ACCEPTED });
  });

  it("status names a lock on a machine with no pairing, and on an unfinished request", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "aibill-cannot-stall-lock-"));
    const runtime = { homeDirectory: fresh, interactive: true, workspaceNow: now, consentRead: async () => "y" };
    await mkdir(join(fresh, ".aibill"), { mode: 0o700 });
    await writeFile(lockPath(fresh), "", { mode: 0o600 });
    expect(lines((await runCli(["workspace", "status"], runtime)).stdout)).toEqual(["This machine has no completed local Workspace pairing. No logs or network were read.", LOCKED_STATUS]);
    await rm(lockPath(fresh));
    expect((await runCli(["workspace", "connect"], runtime)).exitCode).toBe(0);
    await writeFile(lockPath(fresh), "", { mode: 0o600 });
    expect(lines((await runCli(["workspace", "status"], runtime)).stdout)).toContain(LOCKED_STATUS);
  });

  it("a link or a folder in the lock's place is not followed or removed", async () => {
    const m = await machine();
    const target = join(m.home, "not-the-lock");
    await writeFile(target, owner(deadPid()), { mode: 0o600 });
    await symlink(target, lockPath(m.home));
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: LOCKED });
    expect((await lstat(lockPath(m.home))).isSymbolicLink()).toBe(true);
    await rm(lockPath(m.home));
    await mkdir(lockPath(m.home));
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: LOCKED });
    expect((await lstat(lockPath(m.home))).isDirectory()).toBe(true);
  });

  it("a lock another user could write is not trusted", async () => {
    const m = await machine();
    await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o644 });
    await chmod(lockPath(m.home), 0o644);
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: LOCKED });
  });

  it("many commands racing for a lock whose process is gone: one at a time holds it, and every other says the lock is held", async () => {
    for (let round = 0; round < 12; round++) {
      const m = await machine({ capability: true });
      await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o600 });
      let inside = 0, most = 0, entered = 0;
      const attempt = () => prepareWorkspacePlanFacts({ home: m.home, generatedAt: now, confirm: async () => false,
        readAgentPlanFacts: async () => { inside++; entered++; most = Math.max(most, inside); await new Promise(resolve => setTimeout(resolve, 5)); inside--; return []; } });
      const settled = await Promise.allSettled(Array.from({ length: 16 }, attempt));
      expect(most).toBe(1);
      expect(entered).toBeGreaterThanOrEqual(1);
      for (const result of settled) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(WorkspaceStateLocked);
      expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(entered);
      await expect(lstat(lockPath(m.home))).rejects.toThrow();
      await expect(lstat(`${lockPath(m.home)}.reclaim`)).rejects.toThrow();
    }
  });

  it("a command killed inside the takeover leaves it shut: the lock stays until deleted by hand, and that is enough", async () => {
    const m = await machine();
    await writeFile(lockPath(m.home), owner(deadPid()), { mode: 0o600 });
    await mkdir(`${lockPath(m.home)}.reclaim`, { mode: 0o700 });
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: LOCKED });
    await rm(lockPath(m.home));
    expect(await m.push([call])).toMatchObject({ exitCode: 0, stdout: SESSIONS_ACCEPTED });
  });

  it.runIf(process.getuid?.() !== 0)("a lock that cannot be created is not called held: it keeps the general words", async () => {
    const m = await machine();
    const directory = join(m.home, ".aibill");
    await chmod(directory, 0o500);
    try {
      expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: GENERAL_STOP });
    } finally { await chmod(directory, 0o700); }
  });
});

describe("a heavy machine", { timeout: 90_000 }, () => {
  const MAX_BYTES = 262144;
  /** Days of a closed month, models and sessions per fact: `days` x `models` facts, `days` x `models` x `sessions` session identities. */
  const heavy = (days: number, models: number, sessions: number): LocalAgentCall[] => Array.from({ length: days * models * sessions }, (_, index) => {
    const day = Math.floor(index / (models * sessions)), model = Math.floor(index / sessions) % models;
    const timestamp = `2026-09-${String(day + 1).padStart(2, "0")}T10:00:00.000Z`;
    return { ...call, sessionId: `session-${index}`, callId: `call-${index}`, model: `gpt-5.${model}`, timestamp, startedAt: timestamp };
  });
  const sessionFacts = (body: string) => parse(body).facts.filter(isWorkspaceSessionFact);
  const size = (body: string) => Buffer.byteLength(body);

  it("gets a preview, and the batch stops at the last fact that fits; the next preview carries the rest until none are left", async () => {
    const m = await machine();
    const calls = heavy(19, 9, 25);
    const total = 19 * 9;
    const seen = new Set<string>();
    let pushes = 0, sent = 0, previous = 0;
    for (;;) {
      const run = await m.push(calls);
      pushes++;
      if (!run.sent.length) {
        expect(run.messages).toEqual([]);
        expect(lines(run.stdout)[0]).toBe(IDLE);
        break;
      }
      expect(run.exitCode).toBe(0);
      expect(run.sent).toHaveLength(1);
      expect(run.messages).toHaveLength(1);
      const body = run.sent[0]!, facts = sessionFacts(body);
      expect(size(body)).toBeLessThanOrEqual(MAX_BYTES);
      for (const fact of facts) { expect(seen.has(`${fact.day}/${fact.model}`)).toBe(false); seen.add(`${fact.day}/${fact.model}`); }
      sent += facts.length;
      const waiting = total - sent;
      const accepted = lines(run.stdout);
      expect(accepted[0]).toBe(`Workspace accepted ${facts.length} local session facts. These are attribution inputs, not billed costs.`);
      if (waiting) {
        expect(accepted).toContain(`${waiting} more changed local session facts wait. Run npx aibill@latest workspace push to preview them.`);
        expect(lines(run.messages[0]!)).toContain(`This batch holds ${facts.length} of ${total - previous} changed local session facts, as many as one batch can carry. The next push previews the rest.`);
      } else {
        expect(run.stdout).not.toContain("more changed local session facts wait");
        expect(run.messages[0]).not.toContain("as many as one batch can carry");
      }
      previous = sent;
      expect(pushes).toBeLessThan(10);
    }
    expect(pushes).toBeGreaterThan(2);
    expect(seen.size).toBe(total);
    const state = await m.read();
    expect(Object.keys(state.facts)).toHaveLength(total);
    expect(state.pending).toBeNull();
  });

  it("fills a batch to the last byte the bound allows and not one past it", async () => {
    const m = await machine();
    const calls = heavy(19, 9, 25);
    let held: WorkspaceFact[] = [], body = "";
    await prepareWorkspacePush({ home: m.home, calls, generatedAt: now, confirm: async (payload, coverage) => { body = payload; held = coverage.facts; return false; } });
    const facts = sessionFacts(body);
    expect(facts.length).toBeLessThan(held.length);
    expect(facts).toEqual(held.slice(0, facts.length));
    const next = held[facts.length]!;
    expect(size(body)).toBeLessThanOrEqual(MAX_BYTES);
    expect(size(body) + size(workspaceCanonicalJson(next as never)) + 1).toBeGreaterThan(MAX_BYTES);
  });

  it("counts its bytes exactly, wherever the facts happen to fall against the bound", async () => {
    let tightest = Infinity;
    for (const plans of [false, true]) for (let padding = 1; padding <= 40; padding++) {
      const m = await machine({ capability: plans, planFiles: plans });
      const calls = heavy(19, 9, 25).map(item => ({ ...item, project: "p".repeat(padding * 2) }));
      let body = "", held: WorkspaceFact[] = [];
      const prepared = await prepareWorkspacePush({ home: m.home, calls, generatedAt: now, confirm: async (payload, coverage) => { body = payload; held = coverage.facts; return false; },
        ...(plans ? { readAgentPlanFacts: async () => [{ kind: "agent_plan" as const, agent: "claude_code" as const, tier: "claude_max_20x" as const, tierRaw: "default_claude_max_20x", source: "claude_json.oauthAccount.organizationRateLimitTier" as const, observedAt: now, activeUntil: null }] } : {}) });
      expect(prepared.state).toBe("cancelled");
      const facts = sessionFacts(body);
      expect(size(body)).toBeLessThanOrEqual(MAX_BYTES);
      expect(size(body) + size(workspaceCanonicalJson(held[facts.length]! as never)) + 1).toBeGreaterThan(MAX_BYTES);
      tightest = Math.min(tightest, MAX_BYTES - size(body));
    }
    // The sweep is worth running only if some batch came within a comma per fact of the bound.
    expect(tightest).toBeLessThan(100);
  });

  it("counts the tier facts beside it, in bytes and in number", async () => {
    const m = await machine({ capability: true, planFiles: true });
    const run = await m.push(heavy(19, 9, 25), { answers: ["n"] });
    expect(run.messages).toHaveLength(1);
    const payload = lines(run.messages[0]!).find(line => line.startsWith("{"))!;
    expect(size(payload)).toBeLessThanOrEqual(MAX_BYTES);
    expect(parse(payload).facts.filter(isWorkspaceAgentPlanFact)).toHaveLength(1);

    const many = await machine({ capability: true, planFiles: true });
    const small = Array.from({ length: 300 }, (_, index) => ({ ...call, sessionId: `s-${index}`, callId: `c-${index}`, model: `gpt-5.${index}` }));
    const counted = await many.push(small, { answers: ["n"] });
    const envelope = parse(lines(counted.messages[0]!).find(line => line.startsWith("{"))!);
    expect(envelope.facts).toHaveLength(256);
    expect(envelope.facts.filter(isWorkspaceAgentPlanFact)).toHaveLength(1);
    expect(lines(counted.messages[0]!)).toContain("This batch holds 255 of 300 changed local session facts, as many as one batch can carry. The next push previews the rest.");
  });

  it("a batch that fits whole says nothing about room, whatever its size", async () => {
    const m = await machine();
    const run = await m.push(heavy(19, 1, 20));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("Workspace accepted 19 local session facts. These are attribution inputs, not billed costs.");
    expect(run.messages[0]).not.toContain("as many as one batch can carry");
  });

  const swarm = (count: number, day = "2026-09-18"): LocalAgentCall[] => Array.from({ length: count }, (_, index) => ({ ...call, sessionId: `swarm-${day}-${index}`, callId: `c-${day}-${index}`, timestamp: `${day}T10:00:00.000Z`, startedAt: `${day}T10:00:00.000Z` }));

  it("one fact at the bound of 1024 session identities still goes", async () => {
    const m = await machine();
    const run = await m.push(swarm(1024));
    expect(run.exitCode).toBe(0);
    expect(sessionFacts(run.sent[0]!)[0]!.sessionRefs).toHaveLength(1024);
  });

  it("one fact over it stops the push with its own line, the day and the count, and changes nothing", async () => {
    const m = await machine();
    const before = await m.raw();
    const run = await m.push(swarm(1025));
    expect(run).toMatchObject({ exitCode: 1, stdout: "", sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([
      "No facts were replaced or sent: a local fact holds more session identities than one fact can carry, and a fact cannot be split.",
      "Over the bound of 1024: 2026-09-18 (1025).",
      "Pushes stop here until those days leave the 30-day window a push reads, on 2026-10-19 at the latest. Share these counts for help. Do not delete logs or reconnect this machine."]);
    expect(await m.raw()).toBe(before);
  });

  it("names every day over it, and the date is when the last of them leaves the window a push reads", async () => {
    const m = await machine();
    const run = await m.push([...swarm(1030, "2026-09-10"), ...swarm(1026, "2026-09-18"), { ...call, timestamp: "2026-09-12T10:00:00.000Z", startedAt: "2026-09-12T10:00:00.000Z" }]);
    expect(lines(run.stderr)[1]).toBe("Over the bound of 1024: 2026-09-10 (1030), 2026-09-18 (1026).");
    expect(lines(run.stderr)[2]).toContain("on 2026-10-19 at the latest");
    const window = (at: string) => workspaceClock.daysBefore(at, 30).slice(0, 10);
    expect(window("2026-10-18T23:59:59.000Z")).toBe("2026-09-18");
    expect(window("2026-10-19T00:00:00.000Z")).toBe("2026-09-19");
  });

  it.each([
    ["no working directory", { workingDirectory: undefined }, "directory_identity_missing"],
    ["no session", { sessionId: undefined }, "session_identity_missing"],
    ["a model with a space", { model: "gpt 5" }, "model_invalid"],
    ["an unreadable time", { timestamp: "not a time" }, "timestamp_invalid"],
  ] as [string, Partial<LocalAgentCall>, string][])("a call with %s stops the push with its own line and its count, and changes nothing", async (_name, change, code) => {
    const m = await machine();
    const before = await m.raw();
    const run = await m.push([call, { ...call, callId: "odd-1", ...change }, { ...call, callId: "odd-2", sessionId: change.sessionId === undefined && "sessionId" in change ? undefined : "odd-session", ...change } as LocalAgentCall]);
    expect(run).toMatchObject({ exitCode: 1, stdout: "", sent: [], messages: [] });
    expect(lines(run.stderr)).toEqual([
      "No facts were replaced or sent: some local calls lack a usable day or identity, and a daily fact built without them would undercount its day. Absence is not zero usage.",
      "Excluded calls (counts, without paths or transcript contents):",
      `${code}: 2`,
      "Pushes stop here until those calls leave the 30-day window a push reads. Share these counts for help. Do not delete logs or reconnect this machine."]);
    expect(await m.raw()).toBe(before);
  });

  it("calls lacking different things are counted apart, in order", async () => {
    const m = await machine();
    const run = await m.push([{ ...call, callId: "a", model: "gpt 5" }, { ...call, callId: "b", sessionId: undefined }, { ...call, callId: "c", model: "gpt 6" }] as LocalAgentCall[]);
    expect(lines(run.stderr).slice(2, 4)).toEqual(["model_invalid: 2", "session_identity_missing: 1"]);
  });

  it("neither stop moves a retained expired batch: it goes only once a new batch can be built", async () => {
    for (const calls of [swarm(1025), [{ ...call, callId: "odd", model: "gpt 5" }]]) {
      const m = await machine();
      await m.hold("refused", "expired");
      const before = await m.raw();
      expect((await m.push(calls)).exitCode).toBe(1);
      expect(await m.raw()).toBe(before);
    }
  });

  it("the general words stay for the state file and permissions: nothing a log line can do reaches them", async () => {
    const m = await machine();
    const odd = await m.push([{ ...call, callId: "odd", model: "gpt 5" }]);
    expect(odd.stderr).not.toContain(GENERAL_STOP);
    const over = await m.push(swarm(1025));
    expect(over.stderr).not.toContain(GENERAL_STOP);
    await writeFile(m.statePath, "{ not json", { mode: 0o600 });
    expect((await m.push([call], { load: unexpectedRead })).stderr).toBe(GENERAL_STOP);
  });
});

describe("the days a dropped batch cannot get back", () => {
  // A batch signed 12 minutes before this moment; a push at this moment reads back to 2026-09-05.
  const moment = "2026-10-05T12:00:00.000Z", signed = "2026-10-05T11:48:00.000Z", start = "2026-09-05";
  const resend = async (days: string[], kind: "uncertain" | "refused", refusal: "expired" | null, calls: LocalAgentCall[] = []) => {
    const m = await machine();
    await m.hold(kind, refusal, signed, days);
    m.server.clock = moment;
    return { m, run: await m.push(calls, { at: moment, serverAt: moment, ...(kind === "uncertain" ? { load: unexpectedRead } : {}) }) };
  };

  it("some of them: the line names where the window starts, and the rebuild promises only the rest", async () => {
    const { m, run } = await resend(["2026-09-02", "2026-09-18"], "uncertain", null);
    expect(run.exitCode).toBe(1);
    expect(lines(run.stderr)).toEqual([`Workspace refused this batch because it was signed at ${signed}, more than 10 minutes ago. ${NOT_STORED}`, windowLine(start), REBUILD_THE_REST]);
    expect((await m.read()).pending).toBeNull();
  });

  it("all of them: nothing can be rebuilt, so nothing promises it, and the next push is idle", async () => {
    const { m, run } = await resend(["2026-09-02"], "uncertain", null);
    expect(lines(run.stderr)).toEqual([`Workspace refused this batch because it was signed at ${signed}, more than 10 minutes ago. ${NOT_STORED}`, windowLine(start), ANYTHING_NEWER]);
    const next = await m.push([], { at: moment });
    expect(next).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(lines(next.stdout)[0]).toBe(IDLE);
  });

  it("a day the window still reads, even on its first day, keeps the plain line", async () => {
    const { run } = await resend([start, "2026-09-18"], "uncertain", null);
    expect(lines(run.stderr)).toEqual(lateLines(signed));
  });

  it("the day before the window's first day does not", async () => {
    const { run } = await resend(["2026-09-04", start], "uncertain", null);
    expect(lines(run.stderr)).toEqual([`Workspace refused this batch because it was signed at ${signed}, more than 10 minutes ago. ${NOT_STORED}`, windowLine(start), REBUILD_THE_REST]);
  });

  it("the clock line and the window line can both be true", async () => {
    const m = await machine();
    const signedNow = "2026-10-05T11:59:00.000Z";
    await m.hold("uncertain", null, signedNow, ["2026-09-02", "2026-09-18"]);
    m.server.script = [{ refuse: "expired" }];
    const run = await m.push([], { at: moment, load: unexpectedRead });
    expect(lines(run.stderr)).toEqual([`Workspace refused this batch as out of date, though this machine signed it under 10 minutes ago, at ${signedNow} by its clock. ${NOT_STORED}`, CLOCK_OFF, windowLine(start), REBUILD_THE_REST]);
  });

  it("a batch an earlier CLI held: the preview says what is gone before it says what is new", async () => {
    const m = await machine();
    await m.hold("refused", "expired", signed, ["2026-09-02", "2026-09-18"]);
    const late = { ...call, timestamp: "2026-09-18T10:00:00.000Z", startedAt: "2026-09-18T10:00:00.000Z" };
    const run = await m.push([late], { at: moment, answers: ["n"] });
    expect(lines(run.messages[0]!).slice(0, 4)).toEqual([HELD_DROPPED, windowLine(start), "This is a new batch:", "Exact outgoing local facts (no prompts, paths, session IDs, or amounts):"]);
  });

  it("a batch an earlier CLI held, nothing left to send: the idle line comes after what is gone", async () => {
    const m = await machine({ capability: true });
    await m.hold("refused", "expired", signed, ["2026-09-02"]);
    const run = await m.push([], { at: moment });
    expect(run).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(lines(run.stdout)).toEqual([HELD_DROPPED, windowLine(start), IDLE]);
  });

  it("a batch an earlier CLI held, all inside the window: no line about the window", async () => {
    const { run } = await resend(["2026-09-18"], "refused", "expired", [call]);
    expect(run.messages[0]).not.toContain("30-day window");
    expect(lines(run.messages[0]!).slice(0, 2)).toEqual([HELD_DROPPED, "This is a new batch:"]);
  });
});

describe("what the way back costs", () => {
  it("the disconnect's own question says so, and that it cannot be undone", async () => {
    const m = await machine();
    const asked: string[] = [];
    const run = await runCli(["workspace", "disconnect"], { homeDirectory: m.home, interactive: true, workspaceNow: now, consentRead: async (message: string) => { asked.push(message); return "n"; } });
    expect(run.exitCode).toBe(1);
    expect(asked).toEqual([`Revoke this machine's Workspace grant and remove its local pairing after the accepted receipt? This cannot be undone. ${DISCONNECT_COST} [y/N] `]);
  });

  it("the connection ending while a batch is on its way: the refusal says so, and promises no rebuild it could not land", async () => {
    const m = await machine({ expiresAt: at(MINUTE) });
    m.server.script = [{ refuse: "expired" }];
    const clock = vi.spyOn(workspaceClock, "now").mockReturnValueOnce(now).mockReturnValue(at(MINUTE));
    const asked: string[] = [];
    const run = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceLoadCalls: loaded([call]), consentRead: async (message: string) => { asked.push(message); return "y"; }, workspaceTransport: m.server.transport });
    expect(clock).toHaveBeenCalled();
    expect(asked).toHaveLength(1);
    expect(lines(run.stderr)).toEqual([`Workspace refused this batch as out of date, and this machine's Workspace connection ended at ${at(MINUTE)}. ${NOT_STORED}`, RECONNECT, DISCONNECT_COST, CLOCK_FIRST]);
    expect(run.exitCode).toBe(1);
  });
});

describe("a Workspace that will not take a push from this machine", () => {
  const denied: Scripted = { reply: { status: 403, body: { state: "unavailable", retry: "same_envelope_only" } } };

  it("stays an unknown outcome, retained, and says where to look: consent or a disconnect", async () => {
    const m = await machine();
    m.server.script = [denied];
    const run = await m.push([call]);
    expect(run.exitCode).toBe(1);
    expect(lines(run.stderr)).toEqual([UNKNOWN_OUTCOME, MACHINE_REFUSED]);
    expect((await m.read()).pending?.state).toBe("uncertain");
    m.server.script = [denied];
    const again = await m.push([], { load: unexpectedRead });
    expect(again.sent).toEqual(run.sent);
    expect(lines(again.stderr)).toEqual([UNKNOWN_OUTCOME, MACHINE_REFUSED]);
  });

  it("the Workspace's refusal words on a 403 are not a refusal: the batch stays retained", async () => {
    const m = await machine();
    m.server.script = [{ reply: { status: 403, body: { state: "refused", reason: "expired" } } }];
    const run = await m.push([call]);
    expect(lines(run.stderr)).toEqual([UNKNOWN_OUTCOME, MACHINE_REFUSED]);
    expect((await m.read()).pending?.state).toBe("uncertain");
    expect((await m.read()).device.sequence).toBe("0");
  });

  it("names nothing of the kind on any other answer", async () => {
    for (const reply of [{ status: 503, body: { state: "unavailable", retry: "same_envelope_only" } }, { status: 404, body: { state: "disabled" } }, { status: 401, body: {} }]) {
      const m = await machine();
      m.server.script = [{ reply }];
      expect(await m.push([call])).toMatchObject({ exitCode: 1, stderr: UNKNOWN_OUTCOME });
    }
    const lost = await machine();
    lost.server.script = ["lost_before_commit"];
    expect(await lost.push([call])).toMatchObject({ exitCode: 1, stderr: UNKNOWN_OUTCOME });
  });

  it("says so for a batch of tier facts alone, with the words that batch has", async () => {
    const m = await machine({ capability: true, planFiles: true });
    m.server.script = [denied];
    const run = await m.push([]);
    expect(lines(run.stderr)[1]).toBe(MACHINE_REFUSED);
    expect(run.stderr).toContain("The exact signed subscription tier batch is retained.");
  });
});

describe("a batch of tier facts alone refused as expired", () => {
  it("keeps what the Workspace announced: expired says nothing about what it accepts, and the next push offers the tier again", async () => {
    const m = await machine({ capability: true, planFiles: true });
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([]);
    expect(lost.exitCode).toBe(1);
    const late = await m.push([], { at: at(12 * MINUTE), load: unexpectedRead });
    expect(late.exitCode).toBe(0);
    expect(late.stdout).toBe("Workspace did not accept the subscription tier facts; they were dropped, not retained, and session pushes continue.");
    expect(await m.read()).toMatchObject({ pending: null, device: { sequence: "1" }, capabilities: { agentPlanFacts: true } });
    const next = await m.push([], { at: at(13 * MINUTE) });
    expect(next.exitCode).toBe(0);
    expect(next.sent).toHaveLength(1);
    expect(parse(next.sent[0]!).sequence).toBe("2");
    expect((await m.read()).agentPlansAccepted?.claude_code?.tier).toBeDefined();
  });

  it("signed moments ago: the same line and the clock line, one batch per yes, no loop", async () => {
    const m = await machine({ capability: true, planFiles: true });
    const ahead = at(3 * MINUTE);
    const first = await m.push([], { at: ahead, serverAt: now });
    expect(first.exitCode).toBe(0);
    expect(first.sent).toHaveLength(1);
    expect(first.messages).toHaveLength(1);
    expect(lines(first.stdout)).toEqual(["Workspace did not accept the subscription tier facts; they were dropped, not retained, and session pushes continue.", CLOCK_OFF]);
    expect((await m.read()).capabilities).toEqual({ agentPlanFacts: true });
  });
});

describe("a retained expired batch on a machine that has pushed before", () => {
  it("drops the batch and moves the sequence, keeps the ledger, and rebuilds only what changed, at the next revision", async () => {
    const m = await machine();
    const other: LocalAgentCall = { ...call, callId: "other", sessionId: "other-session", timestamp: "2026-09-17T10:00:00.000Z", startedAt: "2026-09-17T10:00:00.000Z" };
    expect((await m.push([call, other])).exitCode).toBe(0);
    const ledger = (await m.read()).facts;
    expect(Object.keys(ledger)).toHaveLength(2);
    const changed: LocalAgentCall = { ...call, usage: { ...call.usage, outputTokens: 6 } };
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([changed, other], { at: at(MINUTE) });
    expect(lost.exitCode).toBe(1);
    expect(sessionFacts(lost.sent[0]!).map(fact => fact.factRevision)).toEqual(["2"]);
    await m.edit(held => { held.pending.state = "refused"; held.pending.refusal = "expired"; });

    const run = await m.push([changed, other], { at: at(13 * MINUTE) });
    expect(run.exitCode).toBe(0);
    expect(lines(run.messages[0]!)[0]).toBe(HELD_DROPPED);
    const fresh = sessionFacts(run.sent[0]!);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.factRevision).toBe("2");
    expect(parse(run.sent[0]!).sequence).toBe("3");
    const state = await m.read();
    expect(Object.keys(state.facts)).toHaveLength(2);
    expect(Object.keys(state.facts).sort()).toEqual(Object.keys(ledger).sort());
    expect(m.server.highWater).toBe(3n);
  });

  it("on a no, the ledger is what it was", async () => {
    const m = await machine();
    expect((await m.push([call])).exitCode).toBe(0);
    const ledger = (await m.read()).facts;
    const changed: LocalAgentCall = { ...call, usage: { ...call.usage, outputTokens: 6 } };
    m.server.script = ["lost_before_commit"];
    expect((await m.push([changed], { at: at(MINUTE) })).exitCode).toBe(1);
    await m.edit(held => { held.pending.state = "refused"; held.pending.refusal = "expired"; });
    const run = await m.push([changed], { at: at(13 * MINUTE), answers: ["n"] });
    expect(run).toMatchObject({ exitCode: 0, stdout: "Not sent.", sent: [] });
    expect(await m.read()).toMatchObject({ facts: ledger, pending: null, device: { sequence: "2" } });
  });
  const sessionFacts = (body: string) => parse(body).facts.filter(isWorkspaceSessionFact);
});

describe("the instant the Workspace answered with", () => {
  it("is what the ledger keeps, not this machine's clock", async () => {
    const m = await machine({ capability: true, planFiles: true });
    const local = at(-90 * 1000), answered = at(30 * 1000);
    const run = await m.push([call], { at: local, serverAt: answered });
    expect(run.exitCode).toBe(0);
    const state = await m.read();
    expect(state.lastAcceptedAt).toBe(answered);
    expect(state.agentPlansAccepted?.claude_code?.sentAt).toBe(answered);
    expect(lines((await m.status(now)).stdout)).toContain(`Last accepted push: ${answered}`);
  });
});

describe("a state file with one key missing and one this version does not know", () => {
  it("reads as newer: the unknown key is what this version can name, and nothing is changed", async () => {
    const m = await machine();
    await m.edit(state => { delete state.lastAcceptedAt; state.aKeyFromLater = true; });
    const before = await m.raw();
    expect(await m.push([call], { load: unexpectedRead })).toMatchObject({ exitCode: 1, stderr: newerState("push"), sent: [], messages: [] });
    expect(await m.raw()).toBe(before);
  });
});
