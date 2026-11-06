import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentPlanFacts, type AgentPlanFact, type LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, isWorkspaceSessionFact, prepareWorkspacePlanFacts, prepareWorkspacePush,
  workspaceCanonicalJson, workspaceDomainHash, workspaceFactKey, WORKSPACE_ORIGIN, WORKSPACE_PLAN_REFRESH_DAYS,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceState, type WorkspaceTransport, type WorkspaceTransportResult
} from "./workspaceConnect.js";

/**
 * One run of `workspace push` gets a machine's subscription tier to the
 * Workspace. The sign-in reader stays real and is wrapped in a spy, so "reads no
 * file" is observed where the command calls it.
 */
vi.mock("@agent-finops/core", async (original) => {
  const actual = await original<typeof import("@agent-finops/core")>();
  return { ...actual, readAgentPlanFacts: vi.fn(actual.readAgentPlanFacts) };
});
const readPlanFiles = vi.mocked(readAgentPlanFacts);

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../core/src/fixtures/local-agent-formats");
const claudePlanFixture = join(fixtureRoot, "claude-code-plan-v1/claude.json");
const codexPlanFixture = join(fixtureRoot, "codex-plan-v1/auth.json");
const codexPlanTokenParts = join(fixtureRoot, "codex-plan-v1/id-token-parts.json");
const ref = (char: string) => `oref_${char.repeat(43)}`;
const now = "2026-09-20T12:00:00.000Z";
const DAY = 86400000;
const later = (from: string, ms: number) => new Date(Date.parse(from) + ms).toISOString();
type TokenParts = { header: Record<string, unknown>; payload: Record<string, unknown>; signature: string };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** The fixture keeps the id token as decoded parts; the assembled token exists only in a throwaway home. */
async function assembledCodexAuth(): Promise<{ auth: { tokens: Record<string, string> }; token: string; parts: TokenParts }> {
  const auth = JSON.parse(await readFile(codexPlanFixture, "utf8")) as { tokens: Record<string, string> };
  const parts = JSON.parse(await readFile(codexPlanTokenParts, "utf8")) as TokenParts;
  const token = `${encode(parts.header)}.${encode(parts.payload)}.${parts.signature}`;
  auth.tokens.id_token = token;
  return { auth, token, parts };
}
/** Every identity or credential string the fixtures carry, to grep against what leaves the sign-in files. */
async function fixtureSecrets(): Promise<string[]> {
  const claude = JSON.parse(await readFile(claudePlanFixture, "utf8")) as { oauthAccount: Record<string, unknown> };
  const { auth: codex, token, parts } = await assembledCodexAuth();
  const payload = parts.payload;
  const authClaims = payload["https://api.openai.com/auth"] as Record<string, unknown>;
  // Field names are checked as JSON keys: the agreed `source` string legitimately names `id_token`.
  const keys = ["accountUuid", "emailAddress", "organizationUuid", "displayName", "id_token", "access_token", "refresh_token", "email",
    "chatgpt_account_id", "chatgpt_user_id"].map(key => `"${key}":`);
  const values = [
    ...["accountUuid", "emailAddress", "organizationUuid", "displayName"].map(key => claude.oauthAccount[key]),
    ...Object.values(codex.tokens), ...token.split("."),
    payload.email, payload.sub, payload.iss, authClaims.chatgpt_account_id, authClaims.chatgpt_user_id,
    ...keys, "fixture-", "eyJ", "@"
  ];
  expect(values.every(value => typeof value === "string" && value.length > 0)).toBe(true);
  return values as string[];
}

const evidence = {
  inputTokens: "observed", outputTokens: "observed", cacheReadTokens: "observed",
  cacheWriteTokens: "not_separately_reported", thoughtTokens: "not_separately_reported", toolTokens: "not_separately_reported",
  calculatedTotalTokens: "calculated_partial", reportedTotalTokens: "not_reported"
} as const;
const call = (overrides: Partial<LocalAgentCall> = {}): LocalAgentCall => ({
  agent: "codex", sessionId: "private-session", callId: "call-one", model: "gpt-5",
  timestamp: "2026-09-18T10:00:00.000Z", startedAt: "2026-09-18T10:00:00.000Z", usageScope: "turn",
  workingDirectory: "/private/repo", project: "repo", usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 },
  tokenComponentEvidence: evidence, ...overrides
});
const nextDay = call({ callId: "call-two", timestamp: "2026-09-19T10:00:00.000Z", startedAt: "2026-09-19T10:00:00.000Z" });
const loaded = (calls: LocalAgentCall[]) => async () => ({
  calls, records: [], diagnostics: [], sourceScans: [], filesParsed: 1, agentsDetected: ["codex" as const]
});
const expectedPlanFacts = (observedAt = now): AgentPlanFact[] => [
  { kind: "agent_plan", agent: "claude_code", tier: "claude_max_20x", tierRaw: "default_claude_max_20x",
    source: "claude_json.oauthAccount.organizationRateLimitTier", observedAt, activeUntil: null },
  { kind: "agent_plan", agent: "codex", tier: "chatgpt_pro", tierRaw: "pro",
    source: "codex_auth.id_token.chatgpt_plan_type", observedAt, activeUntil: "2026-12-01T00:00:00.000Z" }
];
const parse = (body: string) => JSON.parse(body) as WorkspaceEnvelope;

type Scripted = "pass" | "lost_before_commit" | "lost_after_commit" | { refuse: string };
const WORKSPACE_CONTRACT_SOURCES = new Set(["claude_json.oauthAccount.organizationRateLimitTier", "codex_auth.id_token.chatgpt_plan_type"]);

/**
 * The push endpoint as a CLI meets it: the contract's shape check, the device
 * signature, the manifest, idempotent replay before any age or sequence check, a
 * single-use nonce, a monotonic high water that only an ACCEPT moves, the ten-minute
 * age limit, the strict eight-key receipt, and the capability on a response header
 * of an ACCEPT alone. A refusal writes nothing.
 */
function workspaceServer(device: WorkspaceDevice) {
  const publicKey = createPublicKey(device.privateKeyPem);
  const batches = new Map<string, { payload: string; receipt: Record<string, unknown> }>();
  const nonces = new Set<string>(), plans = new Map<string, string>();
  const headers = (announce: string | null): Record<string, string> => ({ "content-type": "application/json", ...(announce === null ? {} : { "x-tilden-push-capabilities": announce }) });
  const refuse = (reason: string): WorkspaceTransportResult => ({ status: 409, body: { state: "refused", reason }, headers: headers(null) });
  const server = {
    requests: [] as string[], highWater: BigInt(device.sequence), clock: now, announce: "agentPlanFacts=1" as string | null, script: [] as Scripted[],
    transport: (async (_path, payload) => {
      server.requests.push(payload);
      const scripted = server.script.shift() ?? "pass";
      if (scripted === "lost_before_commit") throw Error("lost reply");
      if (typeof scripted === "object") return refuse(scripted.refuse);
      const reply = admit(payload);
      if (scripted === "lost_after_commit") throw Error("lost reply");
      return reply;
    }) as WorkspaceTransport
  };
  const admit = (payload: string): WorkspaceTransportResult => {
    const envelope = parse(payload);
    const { signature, ...signed } = envelope, { manifestHash, ...body } = signed;
    const agents = envelope.facts.filter(isWorkspaceAgentPlanFact).map(fact => fact.agent);
    if (new Set(agents).size !== agents.length || envelope.facts.some(fact => isWorkspaceAgentPlanFact(fact) && !WORKSPACE_CONTRACT_SOURCES.has(fact.source))) return refuse("invalid");
    if (!verify(null, Buffer.from(workspaceCanonicalJson(signed as never)), publicKey, Buffer.from(signature.value, "base64url")))
      return { status: 503, body: { state: "unavailable", retry: "same_envelope_only" }, headers: headers(null) };
    if (workspaceDomainHash("tilden:local-session-facts-manifest:v1", body as never) !== manifestHash) return refuse("invalid");
    const prior = batches.get(envelope.idempotencyKey);
    if (prior) return prior.payload === payload ? { status: 200, body: prior.receipt, headers: headers(server.announce) } : refuse("conflict");
    if (BigInt(envelope.sequence) <= server.highWater || nonces.has(envelope.nonce)) return refuse("conflict");
    const age = Date.parse(server.clock) - Date.parse(envelope.generatedAt);
    if (age > 600000 || age < -120000) return refuse("expired");
    let introduced = 0, replaced = 0, unchanged = 0;
    for (const fact of envelope.facts) {
      if (!isWorkspaceAgentPlanFact(fact)) { introduced++; continue; }
      const stored = plans.get(fact.agent);
      if (stored === undefined) introduced++;
      else if (stored >= fact.observedAt) { unchanged++; continue; }
      else replaced++;
      plans.set(fact.agent, fact.observedAt);
    }
    const receipt = { state: "accepted", batchId: envelope.batchId, manifestHash, factCount: envelope.facts.length, introduced, replaced, unchanged, acceptedAt: server.clock };
    batches.set(envelope.idempotencyKey, { payload, receipt });
    nonces.add(envelope.nonce);
    server.highWater = BigInt(envelope.sequence);
    return { status: 200, body: receipt, headers: headers(server.announce) };
  };
  return server;
}

/** A paired machine whose home also holds the two agents' sign-in files, copied from the gated fixtures. */
async function machine(options: { planFiles?: boolean; capability?: boolean; expiresAt?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "aibill-tier-first-"));
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
  if (options.planFiles !== false) {
    await cp(claudePlanFixture, join(home, ".claude.json"));
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify((await assembledCodexAuth()).auth, null, 2));
  }
  const server = workspaceServer(device);
  const push = async (calls: LocalAgentCall[], run: { at?: string; answers?: string[]; load?: () => Promise<never>; transport?: WorkspaceTransport } = {}) => {
    const at = run.at ?? now, before = server.requests.length, messages: string[] = [], answers = run.answers ? [...run.answers] : undefined;
    server.clock = at;
    const result = await runCli(["workspace", "push"], { homeDirectory: home, interactive: true, workspaceNow: at, workspaceLoadCalls: run.load ?? loaded(calls),
      consentRead: async (message: string) => { messages.push(message); return answers ? answers.shift() ?? "n" : "y"; },
      workspaceTransport: run.transport ?? server.transport });
    return { ...result, messages, sent: server.requests.slice(before) };
  };
  const state_ = async () => JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
  const status = async () => (await runCli(["workspace", "status"], { homeDirectory: home })).stdout;
  return { home, device, statePath, server, push, state: state_, status };
}
const setClaudeTier = (home: string, organizationRateLimitTier: string) => writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_max", organizationRateLimitTier } }));
/** A subscription end that parses as a date and reads back as no UTC day: the real reader makes a fact of it, and no batch can carry that fact. */
const UNSIGNABLE_SUBSCRIPTION_END = "+010000-01-01T00:00:00.000Z";
const codexWithSubscriptionEnd = async (home: string, activeUntil: string) => {
  const { auth, parts } = await assembledCodexAuth();
  const claims = { ...parts.payload, "https://api.openai.com/auth": { ...parts.payload["https://api.openai.com/auth"] as Record<string, unknown>, chatgpt_subscription_active_until: activeUntil } };
  auth.tokens.id_token = `${encode(parts.header)}.${encode(claims)}.${parts.signature}`;
  await writeFile(join(home, ".codex", "auth.json"), JSON.stringify(auth));
};
const accepted = (sentAt: string) => ({ claude_code: { tier: "claude_max_20x", tierRaw: "default_claude_max_20x", sentAt }, codex: { tier: "chatgpt_pro", tierRaw: "pro", sentAt } });
const sessionsAcceptedLine = "Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.";
const tierAcceptedLine = "Workspace accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro). This is a plan input, not a billed cost.";
const tierRefusedLine = "Workspace did not accept the subscription tier facts; they were dropped, not retained, and session pushes continue.";
const tierDroppedLine = "Retained subscription tier batch dropped; nothing was sent. If it had already reached the Workspace, the Workspace keeps that tier. The next workspace push sends any changed session facts and offers the tier again; set AIBILL_NO_PLAN_TIER=1 to stop.";
const tierOptedOutLine = "Retained subscription tier batch dropped because AIBILL_NO_PLAN_TIER is set. If it had already reached the Workspace, the Workspace keeps that tier.";
const teamSeatLine = "A Claude Team or Enterprise seat does not report its tier yet: Workspace does not accept that source.";
const idleLine = "No changed eligible local session facts to push.";
const tierWaitsLine = "Subscription tier: not sent yet. It goes right after this machine's next batch of session facts, from a UTC day that has closed, because only an accepted batch tells this CLI that Workspace takes it. No sign-in file was read.";
const unexpectedRead = async (): Promise<never> => { throw Error("unexpected local read"); };

beforeEach(() => {
  // Other suites point these at missing files; this one reads the fixture home.
  delete process.env.AI_SPEND_CLAUDE_CONFIG;
  delete process.env.AI_SPEND_CODEX_AUTH;
  readPlanFiles.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("the first push learns the capability and the same command sends the tier", () => {
  it("sends the session batch, then a previewed tier-only batch at the next sequence, and records only what was accepted", async () => {
    const m = await machine();
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Workspace accepted 1 local session facts.");
    expect(run.stdout).toContain("Workspace accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro).");

    expect(run.sent).toHaveLength(2);
    const [session, tier] = run.sent.map(parse);
    expect(session!.sequence).toBe("1");
    expect(session!.facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(tier!.sequence).toBe("2");
    expect(tier!.facts).toEqual(expectedPlanFacts());
    expect(tier!.nonce).not.toBe(session!.nonce);

    // The session preview names no tier: none was read when it was built. The tier has its own preview of its exact payload.
    expect(run.messages).toHaveLength(2);
    expect(run.messages[0]).not.toContain("Subscription tier");
    expect(run.messages[1]).toContain(run.sent[1]!);
    expect(run.messages[1]).toContain("Workspace accepted that batch and announced it takes subscription tier facts.");
    expect(run.messages[1]).toContain("This batch carries only the subscription tier");
    expect(run.messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro): seven fields each (kind, agent, tier id, raw tier string, where it was read, when, and the subscription's end date if recorded), no account, email or token.");
    expect(run.messages[1]).toContain("Set AIBILL_NO_PLAN_TIER=1 to leave it out.");
    expect(run.messages[1]).not.toContain("Machine tokens");
    expect(run.messages[1]).not.toContain("Excluded calls");
    // A fresh offer drops nothing on a no: that line belongs to a retained batch.
    expect(run.messages[1]).not.toContain("drops this batch");

    expect(readPlanFiles).toHaveBeenCalledTimes(1);
    const state = await m.state();
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("2");
    expect(state.capabilities).toEqual({ agentPlanFacts: true });
    expect(state.agentPlansAccepted).toEqual(accepted(now));
    // Plan facts have no revision: only the session fact enters the acknowledged ledger.
    expect(Object.keys(state.facts)).toEqual([workspaceFactKey(session!.facts.filter(isWorkspaceSessionFact)[0]!)]);
  });

  it("follows up after a retained session batch too: the ACCEPT on its identical resend is what announced the capability", async () => {
    const m = await machine();
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call()]);
    expect(lost.exitCode).toBe(1);
    const resend = await m.push([], { load: async () => { throw Error("unexpected local read"); } });
    expect(resend.exitCode).toBe(0);
    expect(resend.sent[0]).toBe(lost.sent[0]);
    expect(parse(resend.sent[1]!).facts).toEqual(expectedPlanFacts());
    expect(resend.messages[1]).toContain("Exact outgoing subscription tier facts");
    expect(resend.messages[1]).not.toContain("identical retained signed batch");
  });

  it("offers nothing when an announcing ACCEPT finds no sign-in file", async () => {
    const m = await machine({ planFiles: false });
    const run = await m.push([call()]);
    expect(run.stdout).toBe("Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.");
    expect(run.sent).toHaveLength(1);
    expect(run.messages).toHaveLength(1);
    expect((await m.state()).agentPlansAccepted).toBeUndefined();
  });

  it("reports the follow-up's lost reply without taking back the accepted session batch, and resends it identically", async () => {
    const m = await machine();
    m.server.script = ["pass", "lost_after_commit"];
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("Workspace accepted 1 local session facts.");
    expect(run.stdout).not.toContain("accepted the subscription tier");
    expect(run.stderr).toContain("Push outcome is unknown");
    const held = await m.state();
    expect(held.pending?.state).toBe("uncertain");
    expect(held.device.sequence).toBe("1");
    expect(held.agentPlansAccepted).toBeUndefined();

    const resend = await m.push([call()], { load: async () => { throw Error("unexpected local read"); } });
    expect(resend.exitCode).toBe(0);
    expect(resend.sent).toEqual([run.sent[1]]);
    expect(resend.stdout).toContain("accepted the subscription tier");
    expect((await m.state()).agentPlansAccepted).toEqual(accepted(now));
  });

  it("keeps the accepted line when the follow-up cannot start because another command holds the pairing lock, and nothing is lost", async () => {
    const m = await machine();
    const lockPath = join(m.home, ".aibill", ".workspace-device.lock");
    // Another Workspace command takes the lock the moment this one's first batch is answered.
    const contended: WorkspaceTransport = async (path, payload, token) => {
      const reply = await m.server.transport(path, payload, token);
      await rm(lockPath);
      await writeFile(lockPath, "", { mode: 0o600 });
      return reply;
    };
    const run = await m.push([call()], { transport: contended });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.");
    expect(run.stderr).toBe("The subscription tier batch stopped safely. Local state was not reset; run workspace status, then workspace push.");
    expect(run.sent).toHaveLength(1);
    const state = await m.state();
    expect(state).toMatchObject({ pending: null, capabilities: { agentPlanFacts: true } });
    expect(state.device.sequence).toBe("1");

    // The other command finishes; the next push offers the tier.
    await rm(lockPath);
    const next = await m.push([call()]);
    expect(next.exitCode).toBe(0);
    expect(parse(next.sent[0]!).facts).toEqual(expectedPlanFacts());
  });
});

describe("consent", () => {
  it("declining the follow-up keeps the accepted session batch, retains nothing, and the next push offers the tier again", async () => {
    const m = await machine();
    const declined = await m.push([call()], { answers: ["y", "n"] });
    expect(declined.exitCode).toBe(0);
    expect(declined.stdout).toContain("Workspace accepted 1 local session facts.");
    expect(declined.stdout).toContain("Subscription tier not sent. The next workspace push offers it again; set AIBILL_NO_PLAN_TIER=1 to stop.");
    expect(declined.sent).toHaveLength(1);
    expect(declined.messages).toHaveLength(2);
    const after = await m.state();
    expect(after.pending).toBeNull();
    expect(after.device.sequence).toBe("1");
    expect(after.capabilities).toEqual({ agentPlanFacts: true });
    expect(after.agentPlansAccepted).toBeUndefined();

    const againDeclined = await m.push([call()], { answers: ["n"] });
    expect(againDeclined.stdout).toBe("Subscription tier not sent. The next workspace push offers it again; set AIBILL_NO_PLAN_TIER=1 to stop.");
    expect(againDeclined.sent).toEqual([]);
    expect((await m.state()).pending).toBeNull();

    const yes = await m.push([call()]);
    expect(yes.stdout).toBe("Workspace accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro). This is a plan input, not a billed cost.");
    expect(parse(yes.sent[0]!).facts).toEqual(expectedPlanFacts());
    expect(parse(yes.sent[0]!).sequence).toBe("2");
  });

  it("an unanswered prompt is a no: nothing is sent or retained", async () => {
    const m = await machine({ capability: true });
    const run = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceNow: now, workspaceLoadCalls: loaded([]),
      consentRead: async () => undefined, workspaceTransport: m.server.transport });
    expect(run.stdout).toContain("Subscription tier not sent.");
    expect(m.server.requests).toEqual([]);
    expect((await m.state()).pending).toBeNull();
  });
});

describe("a push with no changed session facts", () => {
  it("sends nothing when the tier was accepted and has not changed: the existing message stands and the state file is untouched", async () => {
    const m = await machine();
    await m.push([call()]);
    const before = await readFile(m.statePath, "utf8");
    const idle = await m.push([call()]);
    expect(idle.exitCode).toBe(0);
    expect(idle.stdout).toBe("No changed eligible local session facts to push.");
    expect(idle.sent).toEqual([]);
    expect(idle.messages).toEqual([]);
    expect(await readFile(m.statePath, "utf8")).toBe(before);
  });

  it("sends the tier alone when it was never accepted, and only facts for closed days are session facts", async () => {
    const m = await machine({ capability: true });
    const today = call({ callId: "call-today", timestamp: "2026-09-20T09:00:00.000Z", startedAt: "2026-09-20T09:00:00.000Z" });
    const run = await m.push([today]);
    expect(run.stdout).toBe("Workspace accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro). This is a plan input, not a billed cost.");
    expect(parse(run.sent[0]!).facts).toEqual(expectedPlanFacts());
  });

  it("sends the tier alone when its id or its raw string changed, naming the new tier", async () => {
    const m = await machine();
    await m.push([call()]);
    await setClaudeTier(m.home, "default_claude_max_5x");
    const changed = await m.push([call()], { at: later(now, 60000) });
    expect(changed.sent).toHaveLength(1);
    const facts = parse(changed.sent[0]!).facts;
    expect(facts.every(isWorkspaceAgentPlanFact)).toBe(true);
    expect(facts[0]).toMatchObject({ agent: "claude_code", tier: "claude_max_5x", tierRaw: "default_claude_max_5x" });
    expect(changed.messages[0]).toContain("claude_code (claude_max_5x)");
    expect((await m.state()).agentPlansAccepted?.claude_code).toEqual({ tier: "claude_max_5x", tierRaw: "default_claude_max_5x", sentAt: later(now, 60000) });

    // The same tier id under another raw string is a change too: the Workspace keeps the raw word to add a mapping.
    await setClaudeTier(m.home, "claude_max_5x");
    const raw = await m.push([call()], { at: later(now, 120000) });
    expect(parse(raw.sent[0]!).facts[0]).toMatchObject({ tier: "claude_max_5x", tierRaw: "claude_max_5x" });
    expect(await m.push([call()], { at: later(now, 180000) })).toMatchObject({ sent: [], stdout: "No changed eligible local session facts to push." });
  });

  it("refreshes a tier last accepted more than 14 days ago, inside the device policy's retention, and not before", async () => {
    expect(WORKSPACE_PLAN_REFRESH_DAYS).toBe(14);
    const m = await machine();
    await m.push([call()]);
    expect((await m.push([call()], { at: later(now, 14 * DAY) })).sent).toEqual([]);
    const stale = later(now, 14 * DAY + 1000);
    const refresh = await m.push([call()], { at: stale });
    expect(refresh.sent).toHaveLength(1);
    expect(parse(refresh.sent[0]!).facts).toEqual(expectedPlanFacts(stale));
    expect(refresh.stdout).toContain("Workspace accepted the subscription tier");
    expect((await m.state()).agentPlansAccepted).toEqual(accepted(stale));
    expect((await m.push([call()], { at: later(stale, DAY) })).sent).toEqual([]);
  });

  it("builds no batch at or past the grant's end, where the Workspace answers with no refusal it could be dropped on", async () => {
    const m = await machine({ capability: true, expiresAt: "2026-09-20T12:00:00.000Z" });
    const run = await m.push([]);
    expect(run.stdout).toBe("No changed eligible local session facts to push.");
    expect(run.sent).toEqual([]);
    expect(readPlanFiles).not.toHaveBeenCalled();
  });

  it("fails open: a sign-in reader that throws leaves the existing message, and a session push goes on without a tier", async () => {
    const m = await machine({ capability: true });
    readPlanFiles.mockRejectedValueOnce(Error("unreadable"));
    expect(await m.push([])).toMatchObject({ exitCode: 0, sent: [], stdout: "No changed eligible local session facts to push." });
    readPlanFiles.mockRejectedValueOnce(Error("unreadable"));
    const session = await m.push([call()]);
    expect(session.stdout).toBe("Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.");
    expect(parse(session.sent[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
  });

  it.each([
    ["alone", [] as LocalAgentCall[]],
    ["beside session facts", [call()]]
  ])("fails open on a tier this CLI would refuse to sign, %s: that tier stays out, the other goes, and the push does not stop", async (_case, calls) => {
    const m = await machine({ capability: true });
    await codexWithSubscriptionEnd(m.home, UNSIGNABLE_SUBSCRIPTION_END);
    // The real reader does make a fact of it, so leaving it out is this CLI's doing, not the reader's.
    expect((await readAgentPlanFacts({ now, home: m.home })).find(fact => fact.agent === "codex")?.activeUntil).toBe("+010000-01T00:00:00.000Z");
    const run = await m.push(calls);
    expect(run).toMatchObject({ exitCode: 0, stderr: "" });
    expect(run.sent).toHaveLength(1);
    expect(parse(run.sent[0]!).facts.filter(isWorkspaceAgentPlanFact)).toEqual([expectedPlanFacts()[0]]);
    expect(run.stdout.split("\n").at(-1)).toBe("Workspace accepted the subscription tier for claude_code (claude_max_20x). This is a plan input, not a billed cost.");
    expect(Object.keys((await m.state()).agentPlansAccepted!)).toEqual(["claude_code"]);
  });

  it("fails open the same way on a follow-up, and with no other tier on the machine there is nothing to offer", async () => {
    const m = await machine();
    await codexWithSubscriptionEnd(m.home, UNSIGNABLE_SUBSCRIPTION_END);
    const run = await m.push([call()]);
    expect(run).toMatchObject({ exitCode: 0, stderr: "" });
    expect(run.sent).toHaveLength(2);
    expect(parse(run.sent[1]!).facts).toEqual([expectedPlanFacts()[0]]);

    const alone = await machine({ capability: true });
    await rm(join(alone.home, ".claude.json"));
    await codexWithSubscriptionEnd(alone.home, UNSIGNABLE_SUBSCRIPTION_END);
    expect(await alone.push([])).toMatchObject({ exitCode: 0, stderr: "", sent: [], messages: [], stdout: idleLine });
  });
});

describe("tier facts beside changed session facts", () => {
  it("ride beside them with one preview and no second batch, and the ACCEPT records them so an idle push sends nothing", async () => {
    const m = await machine({ capability: true });
    const run = await m.push([call()]);
    expect(run.sent).toHaveLength(1);
    expect(run.messages).toHaveLength(1);
    const envelope = parse(run.sent[0]!);
    expect(envelope.facts.filter(isWorkspaceSessionFact)).toHaveLength(1);
    expect(envelope.facts.filter(isWorkspaceAgentPlanFact)).toEqual(expectedPlanFacts());
    // One session fact and two tiers: the count is the session facts, and the tiers are named, never counted as session facts.
    expect(run.stdout.split("\n")).toEqual([sessionsAcceptedLine, tierAcceptedLine]);
    expect((await m.state()).agentPlansAccepted).toEqual(accepted(now));
    expect(await m.push([call()])).toMatchObject({ sent: [], stdout: "No changed eligible local session facts to push." });
  });

  it("a refused batch that carries session facts stays retained, as it always has", async () => {
    const m = await machine({ capability: true });
    m.server.script = [{ refuse: "stale" }];
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Its exact envelope and refusal are retained");
    const state = await m.state();
    expect(state.pending).toMatchObject({ state: "refused", refusal: "stale" });
    expect(state.capabilities).toEqual({ agentPlanFacts: true });
    expect((await m.push([call()])).stderr).toContain("A retained batch was refused.");
  });

  it("a lost batch that carries session facts stays retained on a no and under the opt-out: those facts must reconcile, and only the identical resend does", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_after_commit"];
    const lost = await m.push([call()]);
    const held = await m.state();
    const declined = await m.push([call()], { answers: ["n"], load: unexpectedRead });
    expect(declined).toMatchObject({ exitCode: 0, stdout: "Not sent.", sent: [] });
    expect(declined.messages[0]).not.toContain("drops this batch");
    // A retained batch is not rebuilt, so no line offers a way to leave its tier out.
    expect(declined.messages[0]).not.toContain("Set AIBILL_NO_PLAN_TIER=1 to leave it out");
    expect(await m.state()).toEqual(held);
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    const resend = await m.push([call()], { load: unexpectedRead });
    expect(resend.sent).toEqual(lost.sent);
    expect(resend.messages[0]).toContain("The retained batch keeps the subscription tier facts it was signed with; the opt-out applies from the next new batch.");
    expect(resend.stdout.split("\n")).toEqual([sessionsAcceptedLine, tierAcceptedLine]);
    expect((await m.state()).device.sequence).toBe("1");
  });
});

describe("the opt-out", () => {
  it("suppresses the follow-up and the tier-only batch and reads no sign-in file; clearing it makes the tier due again", async () => {
    const m = await machine();
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    const first = await m.push([call()]);
    expect(first.stdout).toBe("Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.");
    expect(first.sent).toHaveLength(1);
    expect(first.messages).toHaveLength(1);
    // The ACCEPT is still remembered: the opt-out says nothing about what the Workspace accepts.
    expect((await m.state()).capabilities).toEqual({ agentPlanFacts: true });

    const idle = await m.push([call()]);
    expect(idle).toMatchObject({ sent: [], messages: [], stdout: "No changed eligible local session facts to push." });
    const session = await m.push([call(), nextDay]);
    expect(parse(session.sent[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(session.messages[0]).not.toContain("Subscription tier");
    expect(readPlanFiles).not.toHaveBeenCalled();
    expect((await m.state()).agentPlansAccepted).toBeUndefined();

    vi.unstubAllEnvs();
    const cleared = await m.push([call(), nextDay]);
    expect(parse(cleared.sent[0]!).facts).toEqual(expectedPlanFacts());
  });

  it.each(["lost_before_commit", "lost_after_commit"] as const)("drops a retained tier-only batch without asking or sending it, and the same push goes on with session facts alone (%s)", async (lostWhen) => {
    const m = await machine({ capability: true });
    m.server.script = [lostWhen];
    const lost = await m.push([]);
    expect((await m.state()).pending?.state).toBe("uncertain");
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    readPlanFiles.mockClear();
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.split("\n")).toEqual([tierOptedOutLine, sessionsAcceptedLine]);
    // The session preview is the only question, and the only batch: the retained one never goes.
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).not.toContain("Subscription tier");
    expect(run.sent).toHaveLength(1);
    expect(run.sent).not.toContain(lost.sent[0]);
    const session = parse(run.sent[0]!);
    expect(session.facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(session.sequence).toBe("2");
    expect(m.server.highWater).toBe(2n);
    expect(readPlanFiles).not.toHaveBeenCalled();
    const state = await m.state();
    expect(state).toMatchObject({ pending: null, capabilities: { agentPlanFacts: true } });
    expect(state.device.sequence).toBe("2");
    expect(state.agentPlansAccepted).toBeUndefined();
  });

  it("says so when the drop leaves nothing else to send, and sends nothing", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_before_commit"];
    await m.push([]);
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    const run = await m.push([]);
    expect(run).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(run.stdout.split("\n")).toEqual([tierOptedOutLine, "No changed eligible local session facts to push."]);
    expect(await m.state()).toMatchObject({ pending: null, device: { sequence: "1" } });
  });
});

describe("with no announced capability", () => {
  it("reads no sign-in file and sends no tier on any path", async () => {
    const m = await machine();
    m.server.announce = null;
    const first = await m.push([call()]);
    expect(first.stdout).toBe("Workspace accepted 1 local session facts. These are attribution inputs, not billed costs.");
    expect(first.sent).toHaveLength(1);
    expect((await m.state()).capabilities).toEqual({ agentPlanFacts: false });
    const idle = await m.push([call()]);
    expect(idle).toMatchObject({ sent: [], messages: [] });
    expect(idle.stdout.split("\n")).toEqual([idleLine, tierWaitsLine]);
    m.server.announce = "agentPlanFacts=0";
    expect((await m.push([call(), nextDay])).sent).toHaveLength(1);
    expect(readPlanFiles).not.toHaveBeenCalled();
    expect(await m.status()).toContain("Subscription tier facts: off until an accepted push announces them; none are read or sent");
    expect(readPlanFiles).not.toHaveBeenCalled();

    // The two entry points themselves, with a reader that would be seen: never called, whatever the facts.
    const reader = vi.fn(async () => expectedPlanFacts());
    const confirm = vi.fn(async () => true);
    expect((await prepareWorkspacePush({ home: m.home, calls: [], generatedAt: now, readAgentPlanFacts: reader, confirm })).state).toBe("unchanged");
    expect((await prepareWorkspacePlanFacts({ home: m.home, generatedAt: now, readAgentPlanFacts: reader, confirm })).state).toBe("unchanged");
    expect(reader).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a push with nothing to send says the tier goes right after the next batch of session facts, reads no file and changes nothing to say it, and the next batch keeps that promise", async () => {
    const m = await machine();
    const before = await readFile(m.statePath, "utf8");
    const nothing = await m.push([]);
    expect(nothing).toMatchObject({ exitCode: 0, stderr: "", sent: [], messages: [] });
    expect(nothing.stdout.split("\n")).toEqual([idleLine, tierWaitsLine]);
    // A machine that only ran today has nothing eligible either, and hears the same.
    const today = call({ callId: "call-today", timestamp: "2026-09-20T09:00:00.000Z", startedAt: "2026-09-20T09:00:00.000Z" });
    expect((await m.push([today])).stdout.split("\n")).toEqual([idleLine, tierWaitsLine]);
    expect(readPlanFiles).not.toHaveBeenCalled();
    expect(await readFile(m.statePath, "utf8")).toBe(before);

    const run = await m.push([call()]);
    expect(run.sent).toHaveLength(2);
    expect(parse(run.sent[1]!).facts).toEqual(expectedPlanFacts());
    expect(run.stdout.split("\n")).toEqual([sessionsAcceptedLine, tierAcceptedLine]);
    // Announced now, so the line has nothing left to say.
    expect(await m.push([call()])).toMatchObject({ sent: [], messages: [], stdout: idleLine });
  });

  it("says nothing under the opt-out, which leaves the tier out whatever comes next, or at the grant's end, where no next batch comes", async () => {
    const out = await machine();
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    expect(await out.push([])).toMatchObject({ exitCode: 0, sent: [], messages: [], stdout: idleLine });
    vi.unstubAllEnvs();
    const ended = await machine({ expiresAt: now });
    expect(await ended.push([])).toMatchObject({ exitCode: 0, sent: [], messages: [], stdout: idleLine });
    expect(readPlanFiles).not.toHaveBeenCalled();
  });

  it("comes back once a refused tier-only batch turns the capability off, because the same is true again", async () => {
    const m = await machine({ capability: true });
    m.server.script = [{ refuse: "invalid" }];
    expect((await m.push([])).stdout).toBe(tierRefusedLine);
    readPlanFiles.mockClear();
    const idle = await m.push([]);
    expect(idle).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(idle.stdout.split("\n")).toEqual([idleLine, tierWaitsLine]);
    expect(readPlanFiles).not.toHaveBeenCalled();
  });
});

describe("older pairing files", () => {
  const stripped = async (statePath: string, keep: (key: string) => boolean) => {
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => keep(key)))), { mode: 0o600 });
  };
  it("reads a file with neither new key (0.9.15), says never for the tier, and adds them on the first ACCEPT", async () => {
    const m = await machine();
    expect(Object.keys(await m.state()).sort()).toEqual(["device", "disconnect", "facts", "lastAcceptedAt", "pending", "version"]);
    expect(await m.status()).toContain("Subscription tier last reported: never");
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(0);
    expect(run.sent).toHaveLength(2);
    expect(Object.keys(await m.state()).sort()).toEqual(["agentPlansAccepted", "capabilities", "device", "disconnect", "facts", "lastAcceptedAt", "pending", "version"]);
  });
  it("treats a file that knows the capability but no accepted tier as never accepted", async () => {
    const m = await machine({ capability: true });
    await m.push([call()]);
    await stripped(m.statePath, key => key !== "agentPlansAccepted");
    const run = await m.push([call()]);
    expect(parse(run.sent[0]!).facts).toEqual(expectedPlanFacts());
  });
  it("refuses a malformed tier record without resetting anything", async () => {
    for (const bad of [{ claude_code: { tier: "claude_max_20x", tierRaw: "x", sentAt: now, email: "a" } }, { other: { tier: "unknown", tierRaw: "x", sentAt: now } },
      { codex: { tier: "chatgpt_ultra", tierRaw: "x", sentAt: now } }, { codex: { tier: "unknown", tierRaw: "x y", sentAt: now } }, { codex: { tier: "unknown", tierRaw: "x", sentAt: "soon" } }]) {
      const m = await machine({ capability: true });
      const state = await m.state();
      const written = JSON.stringify({ ...state, agentPlansAccepted: bad });
      await writeFile(m.statePath, written, { mode: 0o600 });
      const run = await m.push([call()]);
      expect(run.exitCode, JSON.stringify(bad)).toBe(1);
      expect(run.stderr).toContain("Local state was not reset");
      expect(run.sent).toEqual([]);
      expect(await readFile(m.statePath, "utf8")).toBe(written);
    }
  });
});

describe("a refused tier-only batch never strands a machine", () => {
  it.each(["invalid", "conflict", "stale", "expired", "a_reason_this_cli_has_not_met"])("is dropped on 409 %s: one line, the capability false, and the next session push signs past its sequence with a fresh nonce", async (reason) => {
    const m = await machine({ capability: true });
    m.server.script = [{ refuse: reason }];
    const refused = await m.push([]);
    expect(refused.exitCode).toBe(0);
    expect(refused.stderr).toBe("");
    expect(refused.stdout).toBe(tierRefusedLine);
    expect(refused.stdout.split("\n")).toHaveLength(1);
    const dropped = await m.state();
    expect(dropped.pending).toBeNull();
    expect(dropped.capabilities).toEqual({ agentPlanFacts: false });
    expect(dropped.device.sequence).toBe("1");
    expect(dropped.lastAcceptedAt).toBeNull();
    expect(dropped.agentPlansAccepted).toBeUndefined();
    expect(m.server.highWater).toBe(0n);
    const status = await m.status();
    expect(status).toContain("Pending batch: none");
    // The Workspace did announce the capability, on the push before this one: the line must not say it never did.
    expect(status).toContain("Subscription tier facts: off until an accepted push announces them; none are read or sent");

    readPlanFiles.mockClear();
    const session = await m.push([call()]);
    expect(session.exitCode).toBe(0);
    const [next, tier] = session.sent.map(parse);
    const gone = parse(refused.sent[0]!);
    // Its sequence stays spent whatever the Workspace holds, the Workspace admits the gap, and its nonce, batch id and idempotency key are not reused.
    expect(gone.sequence).toBe("1");
    expect(next!.sequence).toBe("2");
    expect(m.server.highWater).toBe(3n);
    expect(next!.nonce).not.toBe(gone.nonce);
    expect(next!.batchId).not.toBe(gone.batchId);
    expect(next!.idempotencyKey).not.toBe(gone.idempotencyKey);
    expect(next!.facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    // That ACCEPT announces the capability again, and the same command offers the tier once more.
    expect(tier!.facts).toEqual(expectedPlanFacts());
    expect(tier!.sequence).toBe("3");
    expect((await m.state()).device.sequence).toBe("3");
  });

  it("a batch the Workspace stored, then refuses on its resend, cannot leave the machine behind: the drop moves the sequence past it", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_after_commit"];
    const lost = await m.push([]);
    expect(m.server.highWater).toBe(1n);
    // The Workspace checks an envelope's shape before it looks for a replay, so a narrower contract would refuse even this identical resend of a batch it holds.
    m.server.script = [{ refuse: "invalid" }];
    const refused = await m.push([], { load: unexpectedRead });
    expect(refused.sent).toEqual(lost.sent);
    expect(refused.stdout).toBe(tierRefusedLine);
    expect(await m.state()).toMatchObject({ pending: null, device: { sequence: "1" }, capabilities: { agentPlanFacts: false } });

    // One sequence behind, this batch would be refused as a conflict, retained, and every later push would halt.
    const session = await m.push([call()]);
    expect(session.exitCode).toBe(0);
    expect(session.stdout).toContain(sessionsAcceptedLine);
    expect(parse(session.sent[0]!).sequence).toBe("2");
    expect((await m.state()).pending).toBeNull();
  });

  it("a refused follow-up leaves the accepted session batch standing, exit 0, and later pushes carry session facts alone until announced", async () => {
    const m = await machine();
    m.server.script = ["pass", { refuse: "invalid" }];
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.split("\n")).toEqual([sessionsAcceptedLine, tierRefusedLine]);
    const state = await m.state();
    expect(state).toMatchObject({ pending: null, capabilities: { agentPlanFacts: false } });
    expect(state.device.sequence).toBe("2");

    // No sign-in file is read until the Workspace announces again; a Workspace that stops announcing gets session facts alone, for ever.
    readPlanFiles.mockClear();
    m.server.announce = null;
    const next = await m.push([call(), nextDay]);
    expect(next.sent).toHaveLength(1);
    expect(parse(next.sent[0]!).sequence).toBe("3");
    expect(parse(next.sent[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(readPlanFiles).not.toHaveBeenCalled();
  });

  it("a Workspace that cannot take a tier-only batch yet refuses it as invalid: each session push shows a second preview and a refusal line, and none halts", async () => {
    const m = await machine();
    // The shape check of a Workspace deployed before tier-only batches: a real 409 before dispatch.
    const older: WorkspaceTransport = async (path, payload, token) => parse(payload).facts.every(isWorkspaceAgentPlanFact)
      ? (m.server.requests.push(payload), { status: 409, body: { state: "refused", reason: "invalid" } }) : m.server.transport(path, payload, token);
    const run = await m.push([call()], { transport: older });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Workspace accepted 1 local session facts.");
    expect(run.stdout).toContain("Workspace did not accept the subscription tier facts");
    const again = await m.push([call(), nextDay], { transport: older });
    expect(again.exitCode).toBe(0);
    expect(parse(again.sent[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    // Its ACCEPT announces the capability again, so the question and the refusal come back with every session push.
    expect(again.messages).toHaveLength(2);
    expect(again.messages[1]).toContain("Exact outgoing subscription tier facts");
    expect(again.stdout.split("\n").slice(-1)).toEqual([tierRefusedLine]);
    expect((await m.state()).pending).toBeNull();
  });

  it("a 409 that is not the Workspace's refusal shape is an unknown outcome, never a drop: the batch may be stored", async () => {
    const m = await machine({ capability: true });
    const proxy: WorkspaceTransport = async () => ({ status: 409, body: { error: "conflict" } });
    const run = await m.push([], { transport: proxy });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Push outcome is unknown");
    expect((await m.state()).pending?.state).toBe("uncertain");
    const notRefused: WorkspaceTransport = async () => ({ status: 409, body: { state: "accepted", reason: "invalid" } });
    expect((await m.push([], { transport: notRefused })).exitCode).toBe(1);
    expect((await m.state()).pending?.state).toBe("uncertain");
  });
});

describe("a lost reply on a tier-only batch", () => {
  it("retains it and resends it identically; the replay receipt reconciles the sequence and the record, and no file is read again", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_after_commit"];
    const lost = await m.push([]);
    expect(lost.exitCode).toBe(1);
    expect(lost.stderr).toContain("Push outcome is unknown");
    expect(lost.stderr).toBe("Push outcome is unknown. The exact signed subscription tier batch is retained. Run workspace push: yes resends this exact batch, no drops it, and AIBILL_NO_PLAN_TIER=1 drops it without asking. Session facts wait only until then.");
    const held = await m.state();
    expect(held.pending?.state).toBe("uncertain");
    expect(held.device.sequence).toBe("0");
    expect(held.agentPlansAccepted).toBeUndefined();
    // The Workspace stored it.
    expect(m.server.highWater).toBe(1n);

    // The sign-in file changes and a day passes: a retained envelope is never rebuilt, and a stored one replays whatever its age.
    await setClaudeTier(m.home, "default_claude_pro");
    readPlanFiles.mockClear();
    const resend = await m.push([call()], { at: later(now, DAY), load: async () => { throw Error("unexpected local read"); } });
    expect(resend.exitCode).toBe(0);
    expect(resend.sent).toEqual(lost.sent);
    expect(resend.messages[0]).toContain(lost.sent[0]!);
    expect(resend.messages[0]).toContain("identical retained signed batch");
    expect(resend.messages[0]).toContain("Exact outgoing subscription tier facts");
    expect(resend.messages[0]).toContain("Answering no, or not answering, drops this batch, and the next workspace push goes on without it.");
    expect(resend.stdout).toContain("accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(readPlanFiles).not.toHaveBeenCalled();
    const state = await m.state();
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
    expect(state.agentPlansAccepted).toEqual(accepted(now));
  });

  it.each(["lost_before_commit", "lost_after_commit"] as const)("a no drops it whether or not the Workspace stored it (%s): nothing waits on a yes, and session facts go on the next push", async (lostWhen) => {
    const m = await machine({ capability: true });
    m.server.script = [lostWhen];
    await m.push([]);
    const declined = await m.push([call()], { answers: ["n"], load: unexpectedRead });
    expect(declined).toMatchObject({ exitCode: 0, sent: [], stdout: tierDroppedLine });
    expect(declined.messages).toHaveLength(1);
    expect(declined.messages[0]).toContain("Answering no, or not answering, drops this batch, and the next workspace push goes on without it.");
    const dropped = await m.state();
    expect(dropped.pending).toBeNull();
    expect(dropped.device.sequence).toBe("1");
    // A no says nothing about what the Workspace accepts.
    expect(dropped.capabilities).toEqual({ agentPlanFacts: true });
    expect(dropped.agentPlansAccepted).toBeUndefined();

    // Whichever way it went, the next batch signs past it and is admitted, and the tier is offered again beside the session fact.
    const next = await m.push([call()]);
    expect(next.exitCode).toBe(0);
    expect(next.stdout.split("\n")).toEqual([sessionsAcceptedLine, tierAcceptedLine]);
    const envelope = parse(next.sent[0]!);
    expect(envelope.sequence).toBe("2");
    expect(envelope.facts.filter(isWorkspaceSessionFact)).toHaveLength(1);
    expect(envelope.facts.filter(isWorkspaceAgentPlanFact)).toEqual(expectedPlanFacts());
    expect(m.server.highWater).toBe(2n);
  });

  it("an unanswered prompt on it is a no", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_before_commit"];
    await m.push([]);
    const run = await runCli(["workspace", "push"], { homeDirectory: m.home, interactive: true, workspaceNow: now, workspaceLoadCalls: unexpectedRead,
      consentRead: async () => undefined, workspaceTransport: m.server.transport });
    expect(run.stdout).toBe(tierDroppedLine);
    expect(await m.state()).toMatchObject({ pending: null, device: { sequence: "1" } });
  });

  it("a yes when it never reached the Workspace and is too old to admit: the refusal drops it, and the session facts go next", async () => {
    const m = await machine({ capability: true });
    m.server.script = ["lost_before_commit"];
    const lost = await m.push([]);
    const tooOld = await m.push([call()], { at: later(now, 11 * 60000), load: unexpectedRead });
    expect(tooOld.sent).toEqual(lost.sent);
    expect(tooOld.stdout).toBe(tierRefusedLine);
    const dropped = await m.state();
    expect(dropped.pending).toBeNull();
    expect(dropped.device.sequence).toBe("1");
    const session = await m.push([call()], { at: later(now, 12 * 60000) });
    expect(session.exitCode).toBe(0);
    expect(parse(session.sent[0]!).sequence).toBe("2");
    expect(parse(session.sent[0]!).facts.filter(isWorkspaceSessionFact)).toHaveLength(1);
  });

  it("a batch consented to and never dispatched, a crash before the send, is treated the same: its own question, and a no drops it", async () => {
    const m = await machine({ capability: true });
    const prepared = await prepareWorkspacePush({ home: m.home, calls: [], generatedAt: now, readAgentPlanFacts: async () => expectedPlanFacts(), confirm: async () => true });
    expect(prepared.state).toBe("prepared");
    expect((await m.state()).pending?.state).toBe("ready");
    const declined = await m.push([call()], { answers: ["n"], load: unexpectedRead });
    expect(declined).toMatchObject({ exitCode: 0, sent: [], stdout: tierDroppedLine });
    expect(declined.messages[0]).toContain("Answering no, or not answering, drops this batch");
    expect(declined.messages[0]).toContain("Send this batch? [y/N]");
    expect(declined.messages[0]).not.toContain("identical retained signed batch");
    expect(await m.state()).toMatchObject({ pending: null, device: { sequence: "1" } });
  });
});

describe("the tier-only envelope", () => {
  it("is signed with the device's Ed25519 key over the JCS body, and bound by its manifest", async () => {
    const m = await machine({ capability: true });
    const run = await m.push([]);
    const envelope = parse(run.sent[0]!);
    expect(envelope.signature).toMatchObject({ algorithm: "ed25519", canonicalization: "jcs-v1" });
    const { signature, ...signed } = envelope, { manifestHash, ...body } = signed;
    const publicKey = createPublicKey(m.device.privateKeyPem);
    const sig = Buffer.from(signature.value, "base64url");
    expect(sig).toHaveLength(64);
    expect(verify(null, Buffer.from(workspaceCanonicalJson(signed as never)), publicKey, sig)).toBe(true);
    expect(workspaceDomainHash("tilden:local-session-facts-manifest:v1", body as never)).toBe(manifestHash);
    // Tamper with the tier and neither survives; another device's key does not verify it either.
    const tampered = { ...signed, facts: [{ ...signed.facts[0]!, tier: "claude_pro" }, signed.facts[1]!] };
    expect(verify(null, Buffer.from(workspaceCanonicalJson(tampered as never)), publicKey, sig)).toBe(false);
    const { manifestHash: _kept, ...tamperedBody } = tampered;
    expect(workspaceDomainHash("tilden:local-session-facts-manifest:v1", tamperedBody as never)).not.toBe(manifestHash);
    expect(verify(null, Buffer.from(workspaceCanonicalJson(signed as never)), generateKeyPairSync("ed25519").publicKey, sig)).toBe(false);
    // One key once: two facts for one agent cannot be built.
    const facts = expectedPlanFacts();
    expect(() => buildWorkspaceEnvelope(m.device, [facts[0]!, { ...facts[0]!, tierRaw: "default_claude_max_5x", tier: "claude_max_5x" }], now)).toThrow("Duplicate Workspace fact key.");
  });

  it("holds exactly the seven fields, and nothing from the sign-in files reaches the wire, the preview, the output, the status or the pairing record", async () => {
    const m = await machine();
    const run = await m.push([call()]);
    for (const fact of parse(run.sent[1]!).facts)
      expect(Object.keys(fact).sort()).toEqual(["activeUntil", "agent", "kind", "observedAt", "source", "tier", "tierRaw"]);
    const state = await m.state();
    for (const plan of Object.values(state.agentPlansAccepted!)) expect(Object.keys(plan).sort()).toEqual(["sentAt", "tier", "tierRaw"]);
    const status = await m.status();
    const surfaces = { wire: run.sent.join("\n"), preview: run.messages.join("\n"), stdout: run.stdout, status, record: JSON.stringify(state.agentPlansAccepted) };
    for (const secret of await fixtureSecrets())
      for (const [surface, text] of Object.entries(surfaces)) expect(text, `${surface}: ${secret}`).not.toContain(secret);
  });
});

describe("a tier source the Workspace does not accept yet", () => {
  const claudeTeam = (home: string) => writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_team", organizationRateLimitTier: "default_claude_max_5x" } }));

  it("stays on the machine: a Team seat beside changed session facts cannot get the batch refused and retained, and the other agent's tier still goes", async () => {
    const m = await machine({ capability: true });
    await claudeTeam(m.home);
    const run = await m.push([call()]);
    expect(run.exitCode).toBe(0);
    const envelope = parse(run.sent[0]!);
    expect(envelope.facts.filter(isWorkspaceAgentPlanFact).map(fact => fact.agent)).toEqual(["codex"]);
    expect(run.messages[0]).not.toContain("claude_code");
    const state = await m.state();
    expect(state.pending).toBeNull();
    expect(Object.keys(state.agentPlansAccepted!)).toEqual(["codex"]);
    // The next push has nothing due: the held tier never makes a prompt of its own.
    expect(await m.push([call()])).toMatchObject({ sent: [], messages: [], stdout: "No changed eligible local session facts to push." });
  });

  it("offers no follow-up when it is the only tier on the machine", async () => {
    const m = await machine({ planFiles: false });
    await claudeTeam(m.home);
    const run = await m.push([call()]);
    expect(run.sent).toHaveLength(1);
    expect(run.messages).toHaveLength(1);
    expect((await m.state()).capabilities).toEqual({ agentPlanFacts: true });
    const status = await m.status();
    expect(status).toContain("Subscription tier last reported: never");
    expect(status).toContain(teamSeatLine);
  });

  it("status says these seats do not report yet whenever no Claude tier has reached the Workspace, and reads no sign-in file to say it", async () => {
    const m = await machine({ capability: true });
    await claudeTeam(m.home);
    await m.push([call()]);
    readPlanFiles.mockClear();
    const status = await m.status();
    expect(status).toContain("Subscription tier last reported for codex: chatgpt_pro");
    expect(status).toContain(teamSeatLine);
    expect(readPlanFiles).not.toHaveBeenCalled();
  });
});

describe("a tier the Workspace accepted and this machine can no longer replace", () => {
  const team = (home: string) => writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_team", organizationRateLimitTier: "default_claude_max_5x" } }));
  const heldLine = (sentAt: string) => `Subscription tier for claude_code: this machine's Claude Team or Enterprise seat does not report yet, so Workspace hears nothing new. A seat plan set from claude_max_20x, last accepted ${sentAt}, stays until the owner changes it in Workspace.`;
  const goneLine = (agent: string, tier: string, sentAt: string) => `Subscription tier for ${agent}: this machine no longer reports one (signed out or on an API key, for example), so Workspace hears nothing new. A seat plan set from ${tier}, last accepted ${sentAt}, stays until the owner changes it in Workspace.`;
  const dayAfter = later(now, DAY);

  it("a seat moved to Team: an idle push asks nothing, sends nothing, moves nothing, and names the agent, the last accepted tier and the date", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    const before = await readFile(m.statePath, "utf8");
    const idle = await m.push([call()], { at: dayAfter });
    expect(idle).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(idle.stdout.split("\n")).toEqual([idleLine, heldLine(now)]);
    expect(await readFile(m.statePath, "utf8")).toBe(before);
    // And when the seat comes back to the tier the Workspace holds, there is nothing to say.
    await setClaudeTier(m.home, "default_claude_max_20x");
    expect(await m.push([call()], { at: dayAfter })).toMatchObject({ sent: [], stdout: idleLine });
  });

  it("a seat moved to Enterprise is named the way a seat moved to Team is", async () => {
    const m = await machine();
    await m.push([call()]);
    await writeFile(join(m.home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_enterprise", organizationRateLimitTier: "default_claude_max_20x" } }));
    const idle = await m.push([call()], { at: dayAfter });
    expect(idle).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(idle.stdout.split("\n")).toEqual([idleLine, heldLine(now)]);
  });

  it.each([
    ["the sign-in file is gone", (home: string) => rm(join(home, ".claude.json"))],
    ["the agent signed out", (home: string) => writeFile(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }))],
    ["the file cannot be parsed", (home: string) => writeFile(join(home, ".claude.json"), "{ not json")],
    ["an organization that is neither a consumer plan nor Team or Enterprise", (home: string) => writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationType: "claude_api", organizationRateLimitTier: "default_claude_max_20x" } }))]
  ])("Claude Code, %s: the same line, without calling it a Team seat", async (_case, change) => {
    const m = await machine();
    await m.push([call()]);
    await change(m.home);
    const idle = await m.push([call()], { at: dayAfter });
    expect(idle).toMatchObject({ exitCode: 0, sent: [], messages: [] });
    expect(idle.stdout.split("\n")).toEqual([idleLine, goneLine("claude_code", "claude_max_20x", now)]);
  });

  it.each([
    ["signed out", (home: string) => rm(join(home, ".codex", "auth.json"))],
    ["on an API key", (home: string) => writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey" }))],
    ["with a tier this CLI would refuse to sign", (home: string) => codexWithSubscriptionEnd(home, UNSIGNABLE_SUBSCRIPTION_END)]
  ])("Codex, %s: its own line, one per agent, each with its own date", async (_case, change) => {
    const m = await machine();
    await m.push([call()]);
    await change(m.home);
    const idle = await m.push([call()], { at: dayAfter });
    expect(idle.stdout.split("\n")).toEqual([idleLine, goneLine("codex", "chatgpt_pro", now)]);
    await team(m.home);
    expect((await m.push([call()], { at: dayAfter })).stdout.split("\n")).toEqual([idleLine, heldLine(now), goneLine("codex", "chatgpt_pro", now)]);
  });

  it("beside changed session facts: the other agent's tier goes, the accepted lines stand, and the line follows them", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    const run = await m.push([call(), nextDay], { at: dayAfter });
    expect(run.exitCode).toBe(0);
    const envelope = parse(run.sent[0]!);
    expect(envelope.facts.filter(isWorkspaceAgentPlanFact).map(fact => fact.agent)).toEqual(["codex"]);
    expect(run.messages).toHaveLength(1);
    expect(run.stdout.split("\n")).toEqual([sessionsAcceptedLine,
      "Workspace accepted the subscription tier for codex (chatgpt_pro). This is a plan input, not a billed cost.", heldLine(now)]);
    const state = await m.state();
    // The record moves only for what was accepted, and it is why the next push can still name the date.
    expect(state.agentPlansAccepted?.claude_code).toEqual({ tier: "claude_max_20x", tierRaw: "default_claude_max_20x", sentAt: now });
    expect(state.agentPlansAccepted?.codex?.sentAt).toBe(dayAfter);
  });

  it("when the other agent's tier is due, the tier-only batch holds that tier alone and the line follows", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    const due = later(now, 15 * DAY);
    const run = await m.push([call()], { at: due });
    expect(parse(run.sent[0]!).facts.map(fact => isWorkspaceAgentPlanFact(fact) && fact.agent)).toEqual(["codex"]);
    expect(run.stdout.split("\n")).toEqual(["Workspace accepted the subscription tier for codex (chatgpt_pro). This is a plan input, not a billed cost.", heldLine(now)]);
  });

  it("stands whatever became of the batch: declined, its reply lost, or refused", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    const declinedSession = await m.push([call(), nextDay], { at: dayAfter, answers: ["n"] });
    expect(declinedSession).toMatchObject({ exitCode: 0, sent: [] });
    expect(declinedSession.stdout.split("\n")).toEqual(["Not sent.", heldLine(now)]);

    const due = later(now, 15 * DAY);
    const declinedTier = await m.push([call()], { at: due, answers: ["n"] });
    expect(declinedTier.stdout.split("\n")).toEqual(["Subscription tier not sent. The next workspace push offers it again; set AIBILL_NO_PLAN_TIER=1 to stop.", heldLine(now)]);

    m.server.script = [{ refuse: "invalid" }];
    const refused = await m.push([call()], { at: due });
    expect(refused.exitCode).toBe(0);
    expect(refused.stdout.split("\n")).toEqual([tierRefusedLine, heldLine(now)]);

    // A batch with session facts that exits 1 keeps its message on stderr, and the line still reaches stdout.
    const held = await machine();
    await held.push([call()]);
    await team(held.home);
    held.server.script = ["lost_before_commit"];
    const lost = await held.push([call(), nextDay], { at: dayAfter });
    expect(lost.exitCode).toBe(1);
    expect(lost.stderr).toContain("Push outcome is unknown");
    expect(lost.stdout).toBe(heldLine(now));

    const refusedAlso = await machine();
    await refusedAlso.push([call()]);
    await team(refusedAlso.home);
    refusedAlso.server.script = [{ refuse: "stale" }];
    const retained = await refusedAlso.push([call(), nextDay], { at: dayAfter });
    expect(retained.exitCode).toBe(1);
    expect(retained.stderr).toContain("Its exact envelope and refusal are retained");
    expect(retained.stdout).toBe(heldLine(now));
  });

  it("a follow-up reads the files too: a capability announced again after a drop names the tier it cannot replace", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    // The Workspace refuses a tier-only batch for Codex: the capability goes false, and the record stays.
    m.server.script = [{ refuse: "invalid" }];
    const due = later(now, 15 * DAY);
    await m.push([call()], { at: due });
    expect((await m.state()).capabilities).toEqual({ agentPlanFacts: false });
    const run = await m.push([call(), nextDay], { at: later(due, 1000) });
    expect(run.exitCode).toBe(0);
    expect(run.sent).toHaveLength(2);
    expect(run.stdout.split("\n")).toEqual([sessionsAcceptedLine,
      "Workspace accepted the subscription tier for codex (chatgpt_pro). This is a plan input, not a billed cost.", heldLine(now)]);
  });

  it("a follow-up that sends nothing, or whose batch fails, says so too", async () => {
    const offAgain = async () => {
      const m = await machine();
      await m.push([call()]);
      await team(m.home);
      await writeFile(m.statePath, workspaceCanonicalJson({ ...await m.state(), capabilities: { agentPlanFacts: false } } as never), { mode: 0o600 });
      return m;
    };
    const due = later(now, 15 * DAY);

    const nothingDue = await (await offAgain()).push([call(), nextDay], { at: dayAfter });
    expect(nothingDue.sent).toHaveLength(1);
    expect(nothingDue.stdout.split("\n")).toEqual([sessionsAcceptedLine, heldLine(now)]);

    const declined = await (await offAgain()).push([call(), nextDay], { at: due, answers: ["y", "n"] });
    expect(declined.stdout.split("\n")).toEqual([sessionsAcceptedLine, "Subscription tier not sent. The next workspace push offers it again; set AIBILL_NO_PLAN_TIER=1 to stop.", heldLine(now)]);

    const refused = await offAgain();
    refused.server.script = ["pass", { refuse: "invalid" }];
    expect((await refused.push([call(), nextDay], { at: due })).stdout.split("\n")).toEqual([sessionsAcceptedLine, tierRefusedLine, heldLine(now)]);

    const lost = await offAgain();
    lost.server.script = ["pass", "lost_before_commit"];
    const unknown = await lost.push([call(), nextDay], { at: due });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Push outcome is unknown");
    expect(unknown.stdout.split("\n")).toEqual([sessionsAcceptedLine, heldLine(now)]);
  });

  it("says nothing it did not read: the opt-out and a capability that is off read no file, a retained batch reads none, and a reader that threw learned nothing", async () => {
    const m = await machine();
    await m.push([call()]);
    await team(m.home);
    readPlanFiles.mockClear();

    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    expect(await m.push([call()], { at: dayAfter })).toMatchObject({ stdout: idleLine, sent: [], messages: [] });
    expect(readPlanFiles).not.toHaveBeenCalled();
    vi.unstubAllEnvs();

    readPlanFiles.mockRejectedValueOnce(Error("unreadable"));
    expect(await m.push([call()], { at: dayAfter })).toMatchObject({ exitCode: 0, sent: [], stdout: idleLine });
    readPlanFiles.mockClear();

    m.server.script = ["lost_before_commit"];
    const lost = await m.push([call(), nextDay], { at: dayAfter });
    expect(lost.exitCode).toBe(1);
    readPlanFiles.mockClear();
    const resend = await m.push([], { at: dayAfter, load: unexpectedRead });
    expect(resend.exitCode).toBe(0);
    expect(resend.stdout).not.toContain("Subscription tier for claude_code");
    expect(readPlanFiles).not.toHaveBeenCalled();

    const state = await m.state();
    await writeFile(m.statePath, workspaceCanonicalJson({ ...state, capabilities: { agentPlanFacts: false } } as never), { mode: 0o600 });
    readPlanFiles.mockClear();
    expect(await m.push([call(), nextDay], { at: dayAfter })).toMatchObject({ stdout: `${idleLine}\n${tierWaitsLine}`, sent: [], messages: [] });
    expect(readPlanFiles).not.toHaveBeenCalled();
  });

  it("a fact this CLI would refuse to sign says nothing about the seat, whatever it claims", async () => {
    const m = await machine();
    await m.push([call()]);
    const unsignable: AgentPlanFact = { kind: "agent_plan", agent: "claude_code", tier: "claude_team", tierRaw: "not a raw tier",
      source: "claude_json.oauthAccount.organizationType", observedAt: dayAfter, activeUntil: null };
    const prepared = await prepareWorkspacePush({ home: m.home, calls: [], generatedAt: dayAfter, confirm: async () => false,
      readAgentPlanFacts: async () => [unsignable, expectedPlanFacts(dayAfter)[1]!] });
    expect(prepared.state).toBe("unchanged");
    expect(prepared.coverage?.unreportedPlans).toEqual([{ agent: "claude_code", tier: "claude_max_20x", sentAt: now, held: false }]);
  });

  it("names no tier that was never accepted, and carries ids and an instant only", async () => {
    const m = await machine({ capability: true });
    await team(m.home);
    await rm(join(m.home, ".codex", "auth.json"));
    expect(await m.push([])).toMatchObject({ sent: [], messages: [], stdout: idleLine });

    const accepted = await machine();
    await accepted.push([call()]);
    await rm(join(accepted.home, ".claude.json"));
    await rm(join(accepted.home, ".codex", "auth.json"));
    const idle = await accepted.push([call()], { at: dayAfter });
    expect(idle.stdout).not.toContain("default_claude_max_20x");
    for (const secret of await fixtureSecrets()) expect(idle.stdout, secret).not.toContain(secret);
  });
});

describe("workspace status", () => {
  it("shows when each agent's tier was last reported, ids only, and reads no sign-in file", async () => {
    const m = await machine();
    expect(await m.status()).toContain("Subscription tier last reported: never");
    expect(await m.status()).toContain(teamSeatLine);
    await m.push([call()]);
    readPlanFiles.mockClear();
    const status = await m.status();
    expect(status).not.toContain(teamSeatLine);
    expect(status).toContain(`Subscription tier last reported for claude_code: claude_max_20x at ${now}`);
    expect(status).toContain(`Subscription tier last reported for codex: chatgpt_pro at ${now}`);
    expect(status).not.toContain("default_claude_max_20x");
    expect(status).not.toContain("Subscription tier last reported: never");
    expect(status).toContain("alone when never accepted, changed or over 14 days old");
    expect(readPlanFiles).not.toHaveBeenCalled();
  });
});
