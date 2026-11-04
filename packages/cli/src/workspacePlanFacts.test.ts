import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPlanFact, LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, isWorkspaceSessionFact, workspaceAgentPlanFactKey, workspaceCanonicalJson, workspaceDomainHash, workspaceFactKey,
  WORKSPACE_ORIGIN, type WorkspaceDevice, type WorkspaceEnvelopeFact, type WorkspaceFact, type WorkspaceState
} from "./workspaceConnect.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../core/src/fixtures/local-agent-formats");
const claudePlanFixture = join(fixtureRoot, "claude-code-plan-v1/claude.json");
const codexPlanFixture = join(fixtureRoot, "codex-plan-v1/auth.json");
const codexPlanTokenParts = join(fixtureRoot, "codex-plan-v1/id-token-parts.json");
const ref = (char: string) => `oref_${char.repeat(43)}`;
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
const now = "2026-09-20T12:00:00.000Z";
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

/** A paired machine whose home also holds the two agents' sign-in files, copied from the gated fixtures. */
async function pairedHome(options: { planFiles: boolean }): Promise<{ home: string; device: WorkspaceDevice; statePath: string }> {
  const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-"));
  const key = generateKeyPairSync("ed25519");
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" };
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null };
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

function pushRuntime(home: string, calls: LocalAgentCall[], requests: string[], messages: string[]) {
  return { homeDirectory: home, interactive: true, workspaceNow: now, workspaceLoadCalls: loaded(calls),
    consentRead: async (message: string) => { messages.push(message); return "y"; },
    workspaceTransport: async (_path: string, body: string) => {
      requests.push(body);
      const envelope = JSON.parse(body) as { batchId: string; manifestHash: string; facts: unknown[] };
      return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
        factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: "2026-09-20T12:01:00.000Z" } };
    } };
}

describe("workspace push carries this machine's plan tiers", () => {
  beforeEach(() => {
    // Other suites point these at missing files; this one reads the fixture home.
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends one exact agent_plan fact per agent beside the session facts, previews it, and keeps it out of the fact ledger", async () => {
    const { home, device, statePath } = await pairedHome({ planFiles: true });
    const requests: string[] = [], messages: string[] = [];
    const result = await runCli(["workspace", "push"], pushRuntime(home, [call()], requests, messages));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("accepted 3 local session facts");

    const envelope = JSON.parse(requests[0]!) as { facts: WorkspaceEnvelopeFact[] };
    const plans = envelope.facts.filter(isWorkspaceAgentPlanFact);
    const sessions = envelope.facts.filter(fact => !isWorkspaceAgentPlanFact(fact)) as WorkspaceFact[];
    expect(sessions).toHaveLength(1);
    expect(plans).toEqual([
      { kind: "agent_plan", agent: "claude_code", tier: "claude_max_20x", tierRaw: "default_claude_max_20x",
        source: "claude_json.oauthAccount.organizationRateLimitTier", observedAt: now, activeUntil: null },
      { kind: "agent_plan", agent: "codex", tier: "chatgpt_pro", tierRaw: "pro",
        source: "codex_auth.id_token.chatgpt_plan_type", observedAt: now, activeUntil: "2026-12-01T00:00:00.000Z" }
    ]);
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
    const state = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    expect(Object.keys(state.facts)).toEqual([workspaceFactKey(sessions[0]!)]);
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe("1");
  });

  it("leaves the tiers out under AIBILL_NO_PLAN_TIER and when the machine has no sign-in files", async () => {
    const withFiles = await pairedHome({ planFiles: true });
    vi.stubEnv("AIBILL_NO_PLAN_TIER", "1");
    const optedOut: string[] = [], optedOutMessages: string[] = [];
    expect((await runCli(["workspace", "push"], pushRuntime(withFiles.home, [call()], optedOut, optedOutMessages))).exitCode).toBe(0);
    expect((JSON.parse(optedOut[0]!) as { facts: WorkspaceEnvelopeFact[] }).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(optedOutMessages[0]).not.toContain("Subscription tier");
    vi.unstubAllEnvs();

    const bare = await pairedHome({ planFiles: false });
    const requests: string[] = [], messages: string[] = [];
    expect((await runCli(["workspace", "push"], pushRuntime(bare.home, [call()], requests, messages))).stdout).toContain("accepted 1 local session facts");
    expect((JSON.parse(requests[0]!) as { facts: WorkspaceEnvelopeFact[] }).facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(messages[0]).not.toContain("Subscription tier");
  });

  it("never sends plan facts alone, and makes room for them inside the 256-fact batch", async () => {
    const { home } = await pairedHome({ planFiles: true });
    const idle: string[] = [], idleMessages: string[] = [];
    const nothing = await runCli(["workspace", "push"], pushRuntime(home, [], idle, idleMessages));
    expect(nothing.stdout).toContain("No changed eligible local session facts to push.");
    expect(idle).toEqual([]);
    expect(idleMessages).toEqual([]);

    const many = Array.from({ length: 300 }, (_, index) => call({ callId: `call-${index}`, model: `gpt-5-variant-${index}` }));
    const requests: string[] = [];
    const result = await runCli(["workspace", "push"], pushRuntime(home, many, requests, []));
    expect(result.exitCode).toBe(0);
    const facts = (JSON.parse(requests[0]!) as { facts: WorkspaceEnvelopeFact[] }).facts;
    expect(facts).toHaveLength(256);
    expect(facts.filter(isWorkspaceAgentPlanFact)).toHaveLength(2);
  });

  it("retries a retained batch with the plan facts it was signed with and reads no files again", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true });
    const requests: string[] = [], messages: string[] = [];
    const lost = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages),
      workspaceTransport: async (_path: string, body: string) => { requests.push(body); throw Error("lost reply"); } });
    expect(lost.stderr).toContain("outcome is unknown");
    expect(JSON.parse(await readFile(statePath, "utf8")).pending.state).toBe("uncertain");

    // The sign-in files change after the batch was signed; the retry must resend the identical envelope.
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_pro" } }));
    const retry = await runCli(["workspace", "push"], { ...pushRuntime(home, [], requests, messages),
      workspaceLoadCalls: async () => { throw Error("unexpected local read"); } });
    expect(retry.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(messages[1]).toContain("Subscription tier included for claude_code (claude_max_20x), codex (chatgpt_pro)");
    expect(messages[1]).toContain("identical retained signed batch");
  });

  /** A Workspace that does not accept agent_plan facts yet: invalid for any batch carrying them, accepting otherwise. */
  const refusingPlans = (requests: string[]) => async (_path: string, body: string) => {
    requests.push(body);
    const envelope = JSON.parse(body) as { batchId: string; manifestHash: string; facts: WorkspaceEnvelopeFact[] };
    if (envelope.facts.some(isWorkspaceAgentPlanFact)) return { status: 409, body: { state: "refused", reason: "invalid" } };
    return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
      factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: "2026-09-20T12:01:00.000Z" } };
  };
  const refusing = (requests: string[], reason: string) => async (_path: string, body: string) => {
    requests.push(body);
    return { status: 409, body: { state: "refused", reason } };
  };

  it("resends the same session facts without plan facts, re-signed, when the Workspace refuses them as invalid", async () => {
    const { home, device, statePath } = await pairedHome({ planFiles: true });
    const requests: string[] = [], messages: string[] = [];
    const result = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages), workspaceTransport: refusingPlans(requests) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Subscription tier facts were not accepted by this Workspace; sent without them.");
    expect(result.stdout).toContain("accepted 1 local session facts");
    expect(messages).toHaveLength(1);

    expect(requests).toHaveLength(2);
    const first = JSON.parse(requests[0]!), second = JSON.parse(requests[1]!);
    expect(first.facts.filter(isWorkspaceAgentPlanFact)).toHaveLength(2);
    expect(second.facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(second.facts).toEqual(first.facts.filter(isWorkspaceSessionFact));
    // Same sequence and time, fresh batch identity, a signature that verifies over the new body.
    expect(second.sequence).toBe(first.sequence);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.deviceKeyId).toBe(first.deviceKeyId);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.manifestHash).not.toBe(first.manifestHash);
    const { signature, ...unsigned } = second;
    expect(verify(null, Buffer.from(workspaceCanonicalJson(unsigned)), createPublicKey(device.privateKeyPem), Buffer.from(signature.value, "base64url"))).toBe(true);
    expect(requests[1]).not.toContain("agent_plan");

    const state = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    expect(Object.keys(state.facts)).toEqual([workspaceFactKey(second.facts[0])]);
    expect(state.pending).toBeNull();
    expect(state.device.sequence).toBe(second.sequence);
  });

  it("does not retry a refused batch that carried no plan facts, nor a non-invalid refusal", async () => {
    const bare = await pairedHome({ planFiles: false });
    const bareRequests: string[] = [];
    const refused = await runCli(["workspace", "push"], { ...pushRuntime(bare.home, [call()], bareRequests, []), workspaceTransport: refusing(bareRequests, "invalid") });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("Workspace refused this batch");
    expect(refused.stderr).not.toContain("Subscription tier");
    expect(bareRequests).toHaveLength(1);
    const bareState = JSON.parse(await readFile(bare.statePath, "utf8")) as WorkspaceState;
    expect(bareState.pending?.state).toBe("refused");
    expect(bareState.pending?.refusal).toBe("invalid");

    const stale = await pairedHome({ planFiles: true });
    const staleRequests: string[] = [];
    const staleResult = await runCli(["workspace", "push"], { ...pushRuntime(stale.home, [call()], staleRequests, []), workspaceTransport: refusing(staleRequests, "stale") });
    expect(staleResult.exitCode).toBe(1);
    expect(staleResult.stderr).not.toContain("Subscription tier");
    expect(staleRequests).toHaveLength(1);
    const staleState = JSON.parse(await readFile(stale.statePath, "utf8")) as WorkspaceState;
    expect(staleState.pending?.state).toBe("refused");
    expect(staleState.pending?.refusal).toBe("stale");
    expect(staleState.pending?.envelope.facts.some(isWorkspaceAgentPlanFact)).toBe(true);
  });

  it("retries once only: a refusal of the plan-free batch is retained as refused", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true });
    const requests: string[] = [];
    const result = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, []), workspaceTransport: refusing(requests, "invalid") });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Subscription tier facts were not accepted by this Workspace; the batch without them was refused too.");
    expect(result.stderr).toContain("Workspace refused this batch");
    expect(requests).toHaveLength(2);
    const state = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    expect(state.pending?.state).toBe("refused");
    expect(state.pending?.envelope.facts.some(isWorkspaceAgentPlanFact)).toBe(false);
    expect(workspaceCanonicalJson(state.pending!.envelope as never)).toBe(requests[1]);
  });

  it("falls back the same way for a retained batch retried later", async () => {
    const { home, statePath } = await pairedHome({ planFiles: true });
    const requests: string[] = [], messages: string[] = [];
    const lost = await runCli(["workspace", "push"], { ...pushRuntime(home, [call()], requests, messages),
      workspaceTransport: async (_path: string, body: string) => { requests.push(body); throw Error("lost reply"); } });
    expect(lost.stderr).toContain("outcome is unknown");
    expect(JSON.parse(await readFile(statePath, "utf8")).pending.state).toBe("uncertain");

    const retry = await runCli(["workspace", "push"], { ...pushRuntime(home, [], requests, messages),
      workspaceLoadCalls: async () => { throw Error("unexpected local read"); }, workspaceTransport: refusingPlans(requests) });
    expect(retry.exitCode).toBe(0);
    expect(retry.stdout).toContain("Subscription tier facts were not accepted by this Workspace; sent without them.");
    expect(requests).toHaveLength(3);
    expect(requests[1]).toBe(requests[0]);
    expect(JSON.parse(requests[2]!).facts).toEqual(JSON.parse(requests[0]!).facts.filter(isWorkspaceSessionFact));
    const state = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    expect(state.pending).toBeNull();
    expect(Object.keys(state.facts)).toHaveLength(1);
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
    return buildWorkspaceEnvelope(device(), [fact, ...plans], now);
  };

  it("accepts the exact shape and refuses every deviation", () => {
    expect(envelopeWith(planFact(), planFact({ agent: "codex", tier: "chatgpt_plus", tierRaw: "plus",
      source: "codex_auth.id_token.chatgpt_plan_type", activeUntil: "2026-12-01T00:00:00.000Z" })).facts).toHaveLength(3);
    expect(envelopeWith(planFact({ tier: "unknown", tierRaw: "default_claude_max_100x" })).facts).toHaveLength(2);

    const refused: Partial<AgentPlanFact>[] = [
      { tier: "chatgpt_pro" },
      { tier: "claude_max_50x" as AgentPlanFact["tier"] },
      { agent: "codex" },
      { source: "codex_auth.id_token.chatgpt_plan_type" },
      { tierRaw: "" },
      { tierRaw: "has space" },
      { observedAt: "2026-09-20" },
      { activeUntil: "soon" },
      { kind: "plan" as AgentPlanFact["kind"] }
    ];
    for (const overrides of refused) expect(() => envelopeWith(planFact(overrides)), JSON.stringify(overrides)).toThrow();
    expect(() => envelopeWith({ ...planFact(), extra: 1 } as unknown as AgentPlanFact)).toThrow();
    const { activeUntil: _dropped, ...missing } = planFact();
    expect(() => envelopeWith(missing as AgentPlanFact)).toThrow();
    // One plan fact per agent and device.
    expect(() => envelopeWith(planFact(), planFact({ tierRaw: "default_claude_max_5x", tier: "claude_max_5x" }))).toThrow("Duplicate Workspace fact key.");
    // Never alone.
    expect(() => buildWorkspaceEnvelope(device(), [planFact()], now)).toThrow("Workspace envelope bounds are invalid.");
  });
});
