import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPlanFact, LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, isWorkspaceSessionFact, prepareWorkspacePush, workspaceAgentPlanFactKey,
  workspaceCanonicalJson, workspaceDomainHash, workspaceFactKey, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceEnvelopeFact, type WorkspaceFact, type WorkspaceState
} from "./workspaceConnect.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../core/src/fixtures/local-agent-formats");
const claudePlanFixture = join(fixtureRoot, "claude-code-plan-v1/claude.json");
const codexPlanFixture = join(fixtureRoot, "codex-plan-v1/auth.json");
const codexPlanTokenParts = join(fixtureRoot, "codex-plan-v1/id-token-parts.json");
const ref = (char: string) => `oref_${char.repeat(43)}`;
const now = "2026-09-20T12:00:00.000Z";
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
const loaded = (calls: LocalAgentCall[]) => async () => ({
  calls, records: [], diagnostics: [], sourceScans: [], filesParsed: 1, agentsDetected: ["codex" as const]
});
const planFact = (overrides: Partial<AgentPlanFact> = {}): AgentPlanFact => ({
  kind: "agent_plan", agent: "claude_code", tier: "claude_max_20x", tierRaw: "default_claude_max_20x",
  source: "claude_json.oauthAccount.organizationRateLimitTier", observedAt: now, activeUntil: null, ...overrides
});
const expectedPlanFacts: AgentPlanFact[] = [
  { kind: "agent_plan", agent: "claude_code", tier: "claude_max_20x", tierRaw: "default_claude_max_20x",
    source: "claude_json.oauthAccount.organizationRateLimitTier", observedAt: now, activeUntil: null },
  { kind: "agent_plan", agent: "codex", tier: "chatgpt_pro", tierRaw: "pro",
    source: "codex_auth.id_token.chatgpt_plan_type", observedAt: now, activeUntil: "2026-12-01T00:00:00.000Z" }
];

/**
 * A paired machine whose home also holds the two agents' sign-in files, copied
 * from the gated fixtures. `capability` writes what the Workspace announced in
 * its last accepted push; absent, the machine has not pushed since pairing.
 */
async function pairedHome(options: { planFiles: boolean; capability?: boolean }): Promise<{ home: string; device: WorkspaceDevice; statePath: string }> {
  const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-"));
  const key = generateKeyPairSync("ed25519");
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" };
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null,
    ...(options.capability === undefined ? {} : { capabilities: { agentPlanFacts: options.capability } }) };
  const privateDir = join(home, ".aibill");
  await mkdir(privateDir, { mode: 0o700 });
  const statePath = join(privateDir, "workspace-device.json");
  await writeFile(statePath, workspaceCanonicalJson(state as never), { mode: 0o600 });
  if (options.planFiles) {
    await cp(claudePlanFixture, join(home, ".claude.json"));
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify((await assembledCodexAuth()).auth, null, 2));
  }
  return { home, device, statePath };
}

/** Every identity or credential string the fixtures carry, to grep against the outgoing payload. */
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

/**
 * A Workspace that accepts everything and, unless told otherwise, announces the
 * plan-fact capability the way the deployed one does: on a response header,
 * never in the receipt body a released CLI checks strictly.
 */
const accepting = (requests: string[], options: { header?: string | string[]; bodyExtra?: Record<string, unknown> } = { header: "agentPlanFacts=1" }) =>
  async (_path: string, body: string) => {
    requests.push(body);
    const envelope = JSON.parse(body) as { batchId: string; manifestHash: string; facts: unknown[] };
    return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
      factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: "2026-09-20T12:01:00.000Z",
      ...(options.bodyExtra ?? {}) },
      headers: { "content-type": "application/json", ...(options.header === undefined ? {} : { "x-tilden-push-capabilities": options.header }) } };
  };
const lost = (requests: string[]) => async (_path: string, body: string) => { requests.push(body); throw Error("lost reply"); };
const readState = async (statePath: string) => JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
const parse = (body: string) => JSON.parse(body) as WorkspaceEnvelope;

function pushRuntime(home: string, calls: LocalAgentCall[], requests: string[], messages: string[]) {
  return { homeDirectory: home, interactive: true, workspaceNow: now, workspaceLoadCalls: loaded(calls),
    consentRead: async (message: string) => { messages.push(message); return "y"; }, workspaceTransport: accepting(requests) };
}

describe("workspace push carries this machine's plan tiers once the Workspace accepts them", () => {
  beforeEach(() => {
    // Other suites point these at missing files; this one reads the fixture home.
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends one exact agent_plan fact per agent beside the session facts, previews it, and keeps it out of the fact ledger", async () => {
    const { home, device, statePath } = await pairedHome({ planFiles: true, capability: true });
    const requests: string[] = [], messages: string[] = [];
    const result = await runCli(["workspace", "push"], pushRuntime(home, [call()], requests, messages));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("accepted 1 local session facts");
    expect(result.stdout).toContain("accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro)");

    const envelope = parse(requests[0]!);
    const plans = envelope.facts.filter(isWorkspaceAgentPlanFact);
    const sessions = envelope.facts.filter(isWorkspaceSessionFact);
    expect(sessions).toHaveLength(1);
    expect(plans).toEqual(expectedPlanFacts);
    expect(plans.map(fact => workspaceAgentPlanFactKey(fact, device.keyId))).toEqual([
      `agent_plan:${device.keyId}:claude_code`, `agent_plan:${device.keyId}:codex`
    ]);
    // The preview is the exact payload plus a line naming what the tier line carries and how to leave it out.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(requests[0]!);
    expect(messages[0]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(messages[0]).toContain("AIBILL_NO_PLAN_TIER=1");
    // Nothing from the sign-in files beyond the tier reaches the wire or the terminal.
    for (const secret of await fixtureSecrets()) {
      expect(requests[0], secret).not.toContain(secret);
      expect(messages[0], secret).not.toContain(secret);
    }
    // Plan facts have no revision; only the session fact enters the acknowledged ledger.
    const state = await readState(statePath);
    expect(Object.keys(state.facts)).toEqual([workspaceFactKey(sessions[0]!)]);
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
    expect(state.capabilities).toEqual({ agentPlanFacts: true });
  });

  it("reads and sends nothing about tiers until the Workspace has announced the capability, then sends them in that same command and beside session facts from then on", async () => {
    // Freshly paired: no capability stored, no sign-in file read.
    const reader = vi.fn(async () => expectedPlanFacts);
    const fresh = await pairedHome({ planFiles: true });
    const prepared = await prepareWorkspacePush({ home: fresh.home, calls: [call()], generatedAt: now, readAgentPlanFacts: reader,
      confirm: async (payload, coverage) => { expect(coverage.agentPlanFacts).toEqual([]); expect(payload).not.toContain("agent_plan"); return false; } });
    expect(prepared.state).toBe("cancelled");
    expect(reader).not.toHaveBeenCalled();

    // Push 1: the Workspace accepts and announces the capability; this batch carried no plan facts, and the same command offers them alone.
    const requests: string[] = [], messages: string[] = [];
    const first = await runCli(["workspace", "push"], pushRuntime(fresh.home, [call()], requests, messages));
    expect(first.stdout).toContain("accepted 1 local session facts");
    expect(parse(requests[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(messages[0]).not.toContain("Subscription tier");
    expect(first.stdout).toContain("accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(parse(requests[1]!).facts).toEqual(expectedPlanFacts);
    expect(messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect((await readState(fresh.statePath)).capabilities).toEqual({ agentPlanFacts: true });
    const status = await runCli(["workspace", "status"], { homeDirectory: fresh.home });
    expect(status.stdout).toContain("Subscription tier facts: announced by this Workspace");

    // Push 2: the stored capability admits the plan facts beside the changed session fact.
    const nextDay = call({ callId: "call-two", timestamp: "2026-09-19T10:00:00.000Z", startedAt: "2026-09-19T10:00:00.000Z" });
    const second = await runCli(["workspace", "push"], pushRuntime(fresh.home, [call(), nextDay], requests, messages));
    expect(second.stdout).toContain("accepted 1 local session facts");
    expect(second.stdout).toContain("accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(parse(requests[2]!).facts.filter(isWorkspaceAgentPlanFact)).toEqual(expectedPlanFacts);
    expect(messages[2]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");

    // Push 3: an ACCEPT without the header takes the capability away again.
    const third = await runCli(["workspace", "push"], { ...pushRuntime(fresh.home, [call(), nextDay,
      call({ callId: "call-three", model: "gpt-5-mini" })], requests, messages), workspaceTransport: accepting(requests, {}) });
    expect(third.exitCode).toBe(0);
    expect((await readState(fresh.statePath)).capabilities).toEqual({ agentPlanFacts: false });
    const fourth = await runCli(["workspace", "push"], { ...pushRuntime(fresh.home, [call(), nextDay,
      call({ callId: "call-three", model: "gpt-5-mini" }), call({ callId: "call-four", model: "gpt-5-nano" })], requests, messages),
      workspaceTransport: accepting(requests, {}) });
    expect(fourth.stdout).toContain("accepted 1 local session facts");
    expect(parse(requests[4]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(messages[4]).not.toContain("Subscription tier");
    expect((await runCli(["workspace", "status"], { homeDirectory: fresh.home })).stdout).toContain("off until an accepted push announces them");
  });

  it("leaves the tiers out under AIBILL_NO_PLAN_TIER and when the machine has no sign-in files", async () => {
    const withFiles = await pairedHome({ planFiles: true, capability: true });
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    const optedOut: string[] = [], optedOutMessages: string[] = [];
    expect((await runCli(["workspace", "push"], pushRuntime(withFiles.home, [call()], optedOut, optedOutMessages))).exitCode).toBe(0);
    expect(parse(optedOut[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(optedOutMessages[0]).not.toContain("Subscription tier");
    vi.unstubAllEnvs();

    const bare = await pairedHome({ planFiles: false, capability: true });
    const requests: string[] = [], messages: string[] = [];
    expect((await runCli(["workspace", "push"], pushRuntime(bare.home, [call()], requests, messages))).stdout).toContain("accepted 1 local session facts");
    expect(parse(requests[0]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(messages[0]).not.toContain("Subscription tier");
  });

  it("makes room for the tiers inside the 256-fact batch, and then has nothing to send alone", async () => {
    const { home } = await pairedHome({ planFiles: true, capability: true });
    const many = Array.from({ length: 300 }, (_, index) => call({ callId: `call-${index}`, model: `gpt-5-variant-${index}` }));
    const requests: string[] = [];
    const result = await runCli(["workspace", "push"], pushRuntime(home, many, requests, []));
    expect(result.exitCode).toBe(0);
    const facts = parse(requests[0]!).facts;
    expect(facts).toHaveLength(256);
    expect(facts.filter(isWorkspaceAgentPlanFact)).toHaveLength(2);

    const idle: string[] = [], idleMessages: string[] = [];
    const nothing = await runCli(["workspace", "push"], pushRuntime(home, [], idle, idleMessages));
    expect(nothing.stdout).toContain("No changed eligible local session facts to push.");
    expect(idle).toEqual([]);
    expect(idleMessages).toEqual([]);
  });

  it("treats a 400 unavailable reply like any other unknown outcome: the batch is retained and resent identically", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true, capability: true });
    const requests: string[] = [], messages: string[] = [];
    // The deployed Workspace answers a schema failure this way after marking the mutation dispatched.
    const unavailable = async (_path: string, body: string) => { requests.push(body); return { status: 400, body: { state: "unavailable", retry: "same_envelope_only" } }; };
    const first = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages), workspaceTransport: unavailable });
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain("Push outcome is unknown");
    expect(first.stderr).toContain("resent identically");
    const retained = await readState(statePath);
    expect(retained.pending?.state).toBe("uncertain");
    expect(retained.pending?.envelope.facts.filter(isWorkspaceAgentPlanFact)).toEqual(expectedPlanFacts);

    const second = await runCli(["workspace", "push"], { ...pushRuntime(home, [], requests, messages),
      workspaceLoadCalls: async () => { throw Error("unexpected local read"); } });
    expect(second.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(messages[1]).toContain("identical retained signed batch");
    expect((await readState(statePath)).pending).toBeNull();
  });

  it("resends a committed-but-lost batch identically under the opt-out, and the replay receipt reconciles ledger and sequence", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true, capability: true });
    const requests: string[] = [], messages: string[] = [];
    // The Workspace admits and stores the batch, but the reply never arrives.
    const first = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages), workspaceTransport: lost(requests) });
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain("Push outcome is unknown");
    expect(first.stderr).toContain("keeps the subscription tier facts it was signed with and is resent identically, with or without AIBILL_NO_PLAN_TIER");
    expect((await readState(statePath)).pending?.state).toBe("uncertain");

    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    // A server that already holds this sequence answers the identical envelope with its replay receipt.
    const replay = async (_path: string, body: string) => {
      requests.push(body);
      expect(body).toBe(requests[0]);
      const envelope = parse(body);
      return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
        factCount: envelope.facts.length, introduced: 0, replaced: 0, unchanged: envelope.facts.length, acceptedAt: "2026-09-20T12:00:30.000Z" },
        headers: { "x-tilden-push-capabilities": "agentPlanFacts=1" } };
    };
    const second = await runCli(["workspace", "push"], { ...pushRuntime(home, [], requests, messages),
      workspaceLoadCalls: async () => { throw Error("unexpected local read"); }, workspaceTransport: replay });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("accepted 1 local session facts");
    expect(second.stdout).toContain("accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    // The preview showed the signed envelope, named the tiers it carries, and said the opt-out starts with the next new batch.
    expect(messages[1]).toContain(requests[0]!);
    expect(messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(messages[1]).not.toContain("Set AIBILL_NO_PLAN_TIER=1 to leave it out");
    expect(messages[1]).toContain("The retained batch keeps the subscription tier facts it was signed with; the opt-out applies from the next new batch.");
    expect(messages[1]).toContain("identical retained signed batch");
    const envelope = parse(requests[0]!);
    const state = await readState(statePath);
    expect(state.pending).toBeNull();
    expect(Object.keys(state.facts)).toEqual([workspaceFactKey(envelope.facts.filter(isWorkspaceSessionFact)[0]!)]);
    expect(state.device.sequence).toBe(envelope.sequence);
    expect(state.lastAcceptedAt).toBe("2026-09-20T12:00:30.000Z");
    expect(state.capabilities).toEqual({ agentPlanFacts: true });

    // The opt-out applies from the next new batch.
    const nextDay = call({ callId: "call-two", timestamp: "2026-09-19T10:00:00.000Z", startedAt: "2026-09-19T10:00:00.000Z" });
    const third = await runCli(["workspace", "push"], pushRuntime(home, [call(), nextDay], requests, messages));
    expect(third.stdout).toContain("accepted 1 local session facts");
    expect(parse(requests[2]!).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(messages[2]).not.toContain("Subscription tier");
  });

  it("reads the capability only from the header, advisory: absent, zero, garbage or repeated values leave it off", async () => {
    for (const header of [undefined, "agentPlanFacts=0", "???", "agentPlanFacts", "agentPlanFacts=true", "agentPlanFacts=1=1", "AGENTPLANFACTS=1", "x".repeat(300), ["agentPlanFacts=0", "agentPlanFacts=1"]]) {
      const { home, statePath } = await pairedHome({ planFiles: true, capability: true });
      const requests: string[] = [];
      const result = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, []),
        workspaceTransport: accepting(requests, header === undefined ? {} : { header }) });
      expect(result.exitCode, JSON.stringify(header)).toBe(0);
      expect(result.stdout).toContain("accepted 1 local session facts");
      const state = await readState(statePath);
      expect(state.pending).toBeNull();
      expect(state.device.sequence).toBe("1");
      expect(state.capabilities, JSON.stringify(header)).toEqual({ agentPlanFacts: false });
    }
    for (const header of ["agentPlanFacts=1", "agentPlanFacts=1; other=0", "other=1, agentPlanFacts=1", ["agentPlanFacts=1"]]) {
      const { home, statePath } = await pairedHome({ planFiles: true });
      const requests: string[] = [];
      await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, []), workspaceTransport: accepting(requests, { header }) });
      expect((await readState(statePath)).capabilities, JSON.stringify(header)).toEqual({ agentPlanFacts: true });
    }
  });

  it("keeps 0.9.15 parity on the receipt body: an unexpected key is still receipt_mismatch", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true, capability: true });
    const requests: string[] = [];
    const result = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, []),
      workspaceTransport: accepting(requests, { header: "agentPlanFacts=1", bodyExtra: { capabilities: { agentPlanFacts: true } } }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Push outcome is unknown");
    const state = await readState(statePath);
    expect(state.pending?.state).toBe("uncertain");
    expect(state.device.sequence).toBe("0");
    expect(state.capabilities).toEqual({ agentPlanFacts: true });
  });

  it("keeps a retained batch identical when the opt-out is not set, reading no files again", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true, capability: true });
    const requests: string[] = [], messages: string[] = [];
    await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages), workspaceTransport: lost(requests) });
    // The sign-in files change after the batch was signed; the retry must resend the identical envelope.
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_pro" } }));
    const retry = await runCli(["workspace", "push"], { ...pushRuntime(home, [], requests, messages),
      workspaceLoadCalls: async () => { throw Error("unexpected local read"); } });
    expect(retry.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect((await readState(statePath)).pending).toBeNull();
  });
});

describe("agent plan facts inside the envelope", () => {
  const device = (): WorkspaceDevice => ({ origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"),
    privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" });
  const session = (): WorkspaceFact => ({ day: "2026-09-18", agent: "codex", provider: "openai", model: "gpt-5", projectName: "repo",
    directoryRef: `sha256_${"0".repeat(64)}`, apiKeyRef: null, workspaceRef: null, sessionCount: "1",
    sessionRefs: [`sha256_${"1".repeat(64)}`], tokens: { uncachedInputTokens: "20", cacheReadTokens: "3", cacheWriteTokens: null, outputTokens: "5" },
    sessionsHash: "", factRevision: "1" });
  const envelopeWith = (...plans: AgentPlanFact[]) => {
    const fact = session();
    fact.sessionsHash = workspaceDomainHash("tilden:local-session-identities:v1", fact.sessionRefs);
    return buildWorkspaceEnvelope(device(), [fact, ...plans] as WorkspaceEnvelopeFact[], now);
  };

  it("accepts the exact shape and refuses every deviation", () => {
    expect(envelopeWith(planFact(), planFact({ agent: "codex", tier: "chatgpt_plus", tierRaw: "plus",
      source: "codex_auth.id_token.chatgpt_plan_type", activeUntil: "2026-12-01T00:00:00.000Z" })).facts).toHaveLength(3);
    expect(envelopeWith(planFact({ tier: "unknown", tierRaw: "default_claude_max_100x" })).facts).toHaveLength(2);
    expect(envelopeWith(planFact({ tier: "claude_team", tierRaw: "claude_team", source: "claude_json.oauthAccount.organizationType" })).facts).toHaveLength(2);
    expect(envelopeWith(planFact({ tierRaw: "x".repeat(64) , tier: "unknown" })).facts).toHaveLength(2);

    const refused: Partial<AgentPlanFact>[] = [
      { tier: "chatgpt_pro" },
      { tier: "claude_max_50x" as AgentPlanFact["tier"] },
      { agent: "codex" },
      { source: "codex_auth.id_token.chatgpt_plan_type" },
      { agent: "codex", tier: "chatgpt_pro", tierRaw: "pro", source: "claude_json.oauthAccount.organizationType" },
      { source: "claude_json.oauthAccount.seatTier" as AgentPlanFact["source"] },
      { tierRaw: "" },
      { tierRaw: "has space" },
      { tierRaw: "x".repeat(65) },
      { observedAt: "2026-09-20" },
      { activeUntil: "soon" },
      { activeUntil: "2026-12-01T12:00:00.000Z" },
      { activeUntil: "2026-12-01T00:00:00Z" },
      { kind: "plan" as AgentPlanFact["kind"] }
    ];
    for (const overrides of refused) expect(() => envelopeWith(planFact(overrides)), JSON.stringify(overrides)).toThrow();
    expect(() => envelopeWith({ ...planFact(), extra: 1 } as unknown as AgentPlanFact)).toThrow();
    const { activeUntil: _dropped, ...missing } = planFact();
    expect(() => envelopeWith(missing as AgentPlanFact)).toThrow();
    // One plan fact per agent and device.
    expect(() => envelopeWith(planFact(), planFact({ tierRaw: "default_claude_max_5x", tier: "claude_max_5x" }))).toThrow("Duplicate Workspace fact key.");
    // Alone is well formed, the batch a push sends when no session fact changed; an empty batch never is.
    expect(buildWorkspaceEnvelope(device(), [planFact()], now).facts).toEqual([planFact()]);
    expect(() => buildWorkspaceEnvelope(device(), [], now)).toThrow("Workspace envelope bounds are invalid.");
  });
});
