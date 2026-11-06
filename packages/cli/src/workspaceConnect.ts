/** Native Workspace pairing, transport, and retained facts. No implicit log scan. */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { AGENT_PLAN_FACT_SOURCES, AGENT_PLAN_TIER_IDS, dedupeCumulativeSessionCalls, type AgentPlanFact, type LocalAgentCall } from "@agent-finops/core";

export const WORKSPACE_ORIGIN = "https://app.asktilden.com";
export const WORKSPACE_FACTS_PATH = "/api/workspace/local-session-facts";
const MAX_BYTES = 262144;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FACTS = 256;
const STATE_FILE = "workspace-device.json";
const LOCK_FILE = ".workspace-device.lock";
const REF = /^oref_[A-Za-z0-9_-]{43}$/;
const HASH = /^sha256_[a-f0-9]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,24})$/;
const DAY_FORMAT = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type WorkspaceTokens = { uncachedInputTokens: string | null; cacheReadTokens: string | null; cacheWriteTokens: string | null; outputTokens: string | null };
export type WorkspaceFact = {
  day: string; agent: "claude-code" | "codex"; provider: "anthropic" | "openai";
  model: string; projectName: string | null; directoryRef: string; apiKeyRef: null; workspaceRef: null;
  sessionCount: string; sessionRefs: string[]; tokens: WorkspaceTokens; sessionsHash: string; factRevision: string;
};
/**
 * This machine's subscription tier for one agent, read by core's plan reader
 * and sent once the Workspace has announced it accepts the kind: beside changed
 * session facts, or alone when none changed and the tier is due. The Workspace
 * keys it `agent_plan:<device>:<agent>`; it has no revision and a later
 * observation replaces the earlier one.
 */
export type WorkspaceAgentPlanFact = AgentPlanFact;
/** What the Workspace accepts, as the header on its last ACCEPT announced it; absent until the first accepted push. */
export type WorkspaceCapabilities = { agentPlanFacts: boolean };
/** What the Workspace last accepted for one agent's tier, and when. Written only on an ACCEPT; ids and an instant, no other data. */
export type WorkspaceAcceptedPlan = { tier: WorkspaceAgentPlanFact["tier"]; tierRaw: string; sentAt: string };
export type WorkspaceAcceptedPlans = Partial<Record<WorkspaceAgentPlanFact["agent"], WorkspaceAcceptedPlan>>;
/**
 * A tier the Workspace accepted is sent alone again once that ACCEPT is older
 * than this. The Workspace keeps a plan fact for the device policy's retention,
 * which runs longer than this, so a machine that keeps pushing keeps its tier readable.
 */
export const WORKSPACE_PLAN_REFRESH_DAYS = 14;
export type WorkspaceEnvelopeFact = WorkspaceFact | WorkspaceAgentPlanFact;
export type WorkspaceFactState = Record<string, { revision: string; contentHash: string }>;
/** The fields that form a fact's key. */
export type WorkspaceFactIdentity = Pick<WorkspaceFact, "day" | "agent" | "provider" | "model" | "projectName" | "directoryRef" | "apiKeyRef" | "workspaceRef">;
export type WorkspaceDevice = {
  origin: typeof WORKSPACE_ORIGIN; grantId: string; keyId: string; grantRevision: string;
  connectionEpoch: string; token: string; privateKeyPem: string; sequence: string;
  collectionNotBefore: string; authorityStartsAt: string; expiresAt: string;
};
export type WorkspaceEnvelope = {
  schemaVersion: "1"; deviceGrantId: string; grantRevision: string; deviceKeyId: string;
  sequence: string; nonce: string; batchId: string; idempotencyKey: string; generatedAt: string;
  facts: WorkspaceEnvelopeFact[]; manifestHash: string;
  signature: { algorithm: "ed25519"; canonicalization: "jcs-v1"; value: string };
};
export type WorkspacePending = {
  envelope: WorkspaceEnvelope; state: "ready" | "uncertain" | "refused";
  refusal: "invalid" | "conflict" | "stale" | "expired" | null;
};
export type WorkspaceState = {
  version: 1; device: WorkspaceDevice; facts: WorkspaceFactState;
  pending: WorkspacePending | null; lastAcceptedAt: string | null;
  disconnect: null | { state: "uncertain" | "revoked"; requestId: string; revokedAt: string | null };
  capabilities?: WorkspaceCapabilities;
  agentPlansAccepted?: WorkspaceAcceptedPlans;
};
export type WorkspaceAggregate = {
  facts: WorkspaceFact[]; excludedCalls: number; incompleteComponents: number; reasons: string[];
  /** Plan facts prepared beside the session facts (or signed into a retained batch); absent from a bare aggregate. */
  agentPlanFacts?: WorkspaceAgentPlanFact[];
};

export function workspaceCanonicalJson(value: Json): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw Error("Workspace JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(workspaceCanonicalJson).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw Error("Workspace JSON contains an unsupported value.");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${workspaceCanonicalJson(value[key]!)}`).join(",")}}`;
}
const sha = (value: string) => `sha256_${createHash("sha256").update(value, "utf8").digest("hex")}`;
export const workspaceDomainHash = (domain: string, value: Json): string => {
  if (!/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+:v[1-9][0-9]*$/.test(domain)) throw Error("Workspace hash domain is invalid.");
  return sha(`${domain}\0${workspaceCanonicalJson(value)}`);
};
export function workspaceFactKey(fact: WorkspaceFactIdentity): string {
  const { day, agent, provider, model, projectName, directoryRef, apiKeyRef, workspaceRef } = fact;
  return workspaceDomainHash("tilden:local-session-fact-key:v1", { day, agent, provider, model, projectName, directoryRef, apiKeyRef, workspaceRef });
}
export function workspaceFactContentHash(fact: WorkspaceFact): string {
  const { factRevision: ignored, ...content } = fact;
  return workspaceDomainHash("tilden:local-session-fact-content:v1", content);
}
export function isWorkspaceAgentPlanFact(fact: WorkspaceEnvelopeFact): fact is WorkspaceAgentPlanFact {
  return "kind" in fact && fact.kind === "agent_plan";
}
export function isWorkspaceSessionFact(fact: WorkspaceEnvelopeFact): fact is WorkspaceFact {
  return !isWorkspaceAgentPlanFact(fact);
}
/** The key the Workspace stores a plan fact under; the device is the key the push already signs with. */
export function workspaceAgentPlanFactKey(fact: WorkspaceAgentPlanFact, deviceKeyId: string): string {
  return `agent_plan:${deviceKeyId}:${fact.agent}`;
}
function envelopeFactKey(fact: WorkspaceEnvelopeFact, deviceKeyId: string): string {
  return isWorkspaceAgentPlanFact(fact) ? workspaceAgentPlanFactKey(fact, deviceKeyId) : workspaceFactKey(fact);
}
function utcDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw Error("Local call has no canonical UTC timestamp.");
  const day = DAY_FORMAT.format(Date.parse(value));
  if (day !== value.slice(0, 10)) throw Error("Local call calendar day is invalid.");
  return day;
}
function safeDirectoryRef(call: LocalAgentCall): string {
  let supplied: string | undefined;
  if (call.workingDirectoryRef) {
    if (/^avref_[a-f0-9]{64}$/.test(call.workingDirectoryRef)) supplied = `sha256_${call.workingDirectoryRef.slice(6)}`;
    else if (HASH.test(call.workingDirectoryRef)) supplied = call.workingDirectoryRef;
    else throw Error("directory_identity_invalid");
  }
  const derived = call.workingDirectory && isAbsolute(call.workingDirectory)
    ? sha(`project-working-directory\0${call.workingDirectory}`) : undefined;
  if (supplied && derived && supplied !== derived) throw Error("directory_identity_conflict");
  if (!supplied && !derived) throw Error("directory_identity_missing");
  return supplied ?? derived!;
}
function component(value: number | undefined, supported: boolean): bigint | null {
  return supported && Number.isSafeInteger(value) && value! >= 0 ? BigInt(value!) : null;
}
function tokenComponents(call: LocalAgentCall): Record<keyof WorkspaceTokens, bigint | null> {
  const supported = call.usageSupport !== "unsupported_token_shape";
  const evidence = call.tokenComponentEvidence;
  const cacheWrites = supported && evidence?.cacheWriteTokens === "observed"
    ? [component(call.usage.cacheWrite5mTokens ?? 0, true), component(call.usage.cacheWrite1hTokens ?? 0, true)] : [null, null];
  return {
    uncachedInputTokens: component(call.usage.inputTokens, supported && (call.agent !== "codex" || evidence?.cacheReadTokens === "observed")),
    outputTokens: component(call.usage.outputTokens, supported),
    cacheReadTokens: component(call.usage.cacheReadTokens, supported && evidence?.cacheReadTokens === "observed"),
    cacheWriteTokens: cacheWrites.every(value => value !== null) ? cacheWrites[0]! + cacheWrites[1]! : null,
  };
}

/** The key-forming fields of a call's daily fact. Throws the reason the aggregate reports for an unusable call. */
function workspaceFactIdentity(call: LocalAgentCall): WorkspaceFactIdentity {
  if (call.agent !== "claude-code" && call.agent !== "codex") throw Error("agent_unsupported");
  const day = utcDay(call.timestamp);
  if (!call.sessionId) throw Error("session_identity_missing");
  if (call.usageScope === "session_cumulative") {
    if (!call.startedAt || utcDay(call.startedAt) !== day || Date.parse(call.startedAt) > Date.parse(call.timestamp))
      throw Error("cumulative_day_unresolved");
  } else if (call.usageScope !== "turn") throw Error("call_scope_unresolved");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(call.model)) throw Error("model_invalid");
  let projectName = call.project && call.project !== "(home)" ? call.project : null;
  if (projectName && (projectName.length > 120 || /[/\\\u0000-\u001f\u007f@]/.test(projectName) || [".", ".."].includes(projectName)))
    projectName = null;
  return { day, agent: call.agent, provider: call.agent === "claude-code" ? "anthropic" : "openai",
    model: call.model, projectName, directoryRef: safeDirectoryRef(call), apiKeyRef: null, workspaceRef: null };
}

/**
 * Facts for days this machine has not sent yet name the repository (the main
 * checkout, found from the session folder) instead of the folder itself, so
 * worktrees, sub-folders and clones land in one project. A day already sent
 * keeps its folder names: its facts are keyed on them, and a renamed key
 * would sit beside the old one on the server.
 */
export function collapseRepositoryProjects(calls: readonly LocalAgentCall[], previous: WorkspaceFactState,
  resolveRoot: (directory: string) => string | undefined): LocalAgentCall[] {
  const sentDays = new Set<string>();
  for (const call of calls) {
    try {
      const shape = workspaceFactIdentity(call);
      if (previous[workspaceFactKey(shape)]) sentDays.add(shape.day);
    } catch { /* the aggregate reports unusable calls */ }
  }
  const roots = new Map<string, string | undefined>(), home = resolve(homedir());
  return calls.map(call => {
    if (!call.workingDirectory || !isAbsolute(call.workingDirectory)) return call;
    let day: string;
    try { day = utcDay(call.timestamp); } catch { return call; }
    if (sentDays.has(day)) return call;
    if (!roots.has(call.workingDirectory)) roots.set(call.workingDirectory, resolveRoot(call.workingDirectory));
    const root = roots.get(call.workingDirectory);
    if (!root || resolve(root) === home) return call;
    const name = basename(root);
    return name.length ? { ...call, project: name } : call;
  });
}

/** Caller supplies approved numeric-only calls; this function never opens local logs. */
export function aggregateWorkspaceFacts(calls: readonly LocalAgentCall[], previous: WorkspaceFactState = {}, deviceKeyId?: string): WorkspaceAggregate {
  if (!deviceKeyId || !REF.test(deviceKeyId)) throw Error("A retained device key is required for private session identities.");
  type Group = { fact: WorkspaceFact; sessions: Set<string>; tokens: Record<keyof WorkspaceTokens, bigint | null> };
  const groups = new Map<string, Group>(), reasons = new Set<string>();
  let excludedCalls = 0, incompleteComponents = 0;
  for (const call of dedupeCumulativeSessionCalls([...calls])) {
    if (call.agent !== "claude-code" && call.agent !== "codex") continue;
    try {
      const fact: WorkspaceFact = { ...workspaceFactIdentity(call),
        sessionCount: "1", sessionRefs: [], tokens: { uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null },
        sessionsHash: sha(""), factRevision: "1" };
      const key = workspaceFactKey(fact), tokens = tokenComponents(call), group = groups.get(key);
      if (!call.sessionId) throw Error("session_identity_missing");
      const identity = workspaceDomainHash("tilden:local-session-identity:v1", [deviceKeyId, call.agent, call.sessionId, call.subagentId ?? null]);
      if (group) {
        group.sessions.add(identity);
        for (const name of Object.keys(tokens) as (keyof WorkspaceTokens)[])
          group.tokens[name] = group.tokens[name] === null || tokens[name] === null ? null : group.tokens[name]! + tokens[name]!;
      } else groups.set(key, { fact, sessions: new Set([identity]), tokens });
    } catch (error) {
      excludedCalls++;
      const reason = error instanceof Error ? error.message : "call_invalid";
      reasons.add(/^[a-z_]+$/.test(reason) ? reason : "timestamp_invalid");
    }
  }
  const facts: WorkspaceFact[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fact = group.fact;
    if (group.sessions.size > 1024) throw Error("A local fact exceeds the session identity bound.");
    fact.sessionCount = String(group.sessions.size);
    fact.sessionRefs = [...group.sessions].sort();
    fact.sessionsHash = workspaceDomainHash("tilden:local-session-identities:v1", fact.sessionRefs);
    for (const name of Object.keys(group.tokens) as (keyof WorkspaceTokens)[]) {
      fact.tokens[name] = group.tokens[name]?.toString() ?? null;
      if (fact.tokens[name] === null) incompleteComponents++;
    }
    const prior = previous[key];
    if (prior && prior.contentHash === workspaceFactContentHash(fact)) continue;
    if (prior && !UINT.test(prior.revision)) throw Error("Local fact revision is invalid.");
    fact.factRevision = prior ? String(BigInt(prior.revision) + 1n) : "1";
    if (!UINT.test(fact.factRevision)) throw Error("Local fact revision exceeds its bound.");
    facts.push(fact);
  }
  return { facts, excludedCalls, incompleteComponents, reasons: [...reasons].sort() };
}

function exactKeys(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Workspace state or receipt has an invalid shape.");
  const present = Object.keys(value), allowed = new Set([...keys, ...optional]);
  if (keys.some(key => !present.includes(key)) || present.some(key => !allowed.has(key)))
    throw Error("Workspace state or receipt has an invalid shape.");
}
function bytes(value: unknown, count: number): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === count
    && Buffer.from(value, "base64url").toString("base64url") === value;
}
function validateFact(fact: WorkspaceFact): void {
  exactKeys(fact, ["day", "agent", "provider", "model", "projectName", "directoryRef", "apiKeyRef", "workspaceRef", "sessionCount", "sessionRefs", "tokens", "sessionsHash", "factRevision"]);
  exactKeys(fact.tokens, ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.day) || utcDay(`${fact.day}T00:00:00.000Z`) !== fact.day
    || !["claude-code", "codex"].includes(fact.agent) || fact.provider !== (fact.agent === "claude-code" ? "anthropic" : "openai")
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(fact.model) || !HASH.test(fact.directoryRef)
    || fact.apiKeyRef !== null || fact.workspaceRef !== null || !UINT.test(fact.sessionCount) || fact.sessionCount === "0"
    || !Array.isArray(fact.sessionRefs) || fact.sessionRefs.length < 1 || fact.sessionRefs.length > 1024
    || fact.sessionRefs.some((value, index) => !HASH.test(value) || index > 0 && value <= fact.sessionRefs[index - 1]!)
    || fact.sessionCount !== String(fact.sessionRefs.length)
    || workspaceDomainHash("tilden:local-session-identities:v1", fact.sessionRefs) !== fact.sessionsHash
    || !HASH.test(fact.sessionsHash) || !UINT.test(fact.factRevision)
    || Object.values(fact.tokens).some(value => value !== null && (typeof value !== "string" || !UINT.test(value)))
    || fact.projectName !== null && (typeof fact.projectName !== "string" || !fact.projectName.length || fact.projectName.length > 120
      || /[/\\\u0000-\u001f\u007f@]/.test(fact.projectName) || [".", ".."].includes(fact.projectName)))
    throw Error("Workspace fact shape is invalid.");
}
const PLAN_TIER_IDS = new Set<string>(AGENT_PLAN_TIER_IDS), PLAN_SOURCES = new Set<string>(AGENT_PLAN_FACT_SOURCES);
function validateAgentPlanFact(fact: WorkspaceAgentPlanFact): void {
  exactKeys(fact, ["kind", "agent", "tier", "tierRaw", "source", "observedAt", "activeUntil"]);
  const family = fact.agent === "claude_code" ? "claude_" : "chatgpt_", file = fact.agent === "claude_code" ? "claude_json." : "codex_auth.";
  if (fact.kind !== "agent_plan" || !["claude_code", "codex"].includes(fact.agent)
    || typeof fact.tier !== "string" || !PLAN_TIER_IDS.has(fact.tier) || fact.tier !== "unknown" && !fact.tier.startsWith(family)
    || typeof fact.tierRaw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(fact.tierRaw)
    || typeof fact.source !== "string" || !PLAN_SOURCES.has(fact.source) || !fact.source.startsWith(file)
    || typeof fact.observedAt !== "string"
    || fact.activeUntil !== null && (typeof fact.activeUntil !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(fact.activeUntil)))
    throw Error("Workspace agent plan fact shape is invalid.");
  utcDay(fact.observedAt);
  if (fact.activeUntil !== null) utcDay(fact.activeUntil);
}
function validateEnvelopeFact(fact: WorkspaceEnvelopeFact): void {
  if (isWorkspaceAgentPlanFact(fact)) validateAgentPlanFact(fact); else validateFact(fact);
}
function validateAcceptedPlans(plans: WorkspaceAcceptedPlans): void {
  exactKeys(plans, [], ["claude_code", "codex"]);
  for (const plan of Object.values(plans)) {
    exactKeys(plan, ["tier", "tierRaw", "sentAt"]);
    if (typeof plan.tier !== "string" || !PLAN_TIER_IDS.has(plan.tier) || typeof plan.tierRaw !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(plan.tierRaw) || typeof plan.sentAt !== "string")
      throw Error("Workspace accepted plan state is invalid.");
    utcDay(plan.sentAt);
  }
}
/**
 * The tier sources the Workspace accepts today. Core also reads a Claude Team
 * or Enterprise organization's type, a source the Workspace still refuses as
 * `invalid`. Beside session facts that refusal would retain the whole batch and
 * halt this machine's pushes, so such a fact stays on the machine until the
 * Workspace accepts the source; the other agent's tier is unaffected.
 */
const WORKSPACE_ACCEPTED_PLAN_SOURCES = new Set<string>(["claude_json.oauthAccount.organizationRateLimitTier", "codex_auth.id_token.chatgpt_plan_type"]);
function validateEnvelope(envelope: WorkspaceEnvelope, device: WorkspaceDevice): void {
  exactKeys(envelope, ["schemaVersion", "deviceGrantId", "grantRevision", "deviceKeyId", "sequence", "nonce", "batchId", "idempotencyKey", "generatedAt", "facts", "manifestHash", "signature"]);
  exactKeys(envelope.signature, ["algorithm", "canonicalization", "value"]);
  utcDay(envelope.generatedAt);
  if (envelope.schemaVersion !== "1" || envelope.deviceGrantId !== device.grantId || envelope.deviceKeyId !== device.keyId
    || envelope.grantRevision !== device.grantRevision || !UINT.test(envelope.sequence)
    || envelope.sequence !== String(BigInt(device.sequence) + 1n) || !bytes(envelope.nonce, 16)
    || !REF.test(envelope.batchId) || !REF.test(envelope.idempotencyKey) || !HASH.test(envelope.manifestHash)
    || !Array.isArray(envelope.facts) || envelope.facts.length < 1 || envelope.facts.length > MAX_FACTS
    || envelope.signature.algorithm !== "ed25519" || envelope.signature.canonicalization !== "jcs-v1" || !bytes(envelope.signature.value, 64))
    throw Error("Workspace envelope shape is invalid.");
  envelope.facts.forEach(validateEnvelopeFact);
  if (new Set(envelope.facts.map(fact => envelopeFactKey(fact, envelope.deviceKeyId))).size !== envelope.facts.length) throw Error("Duplicate Workspace fact key.");
  const { signature, manifestHash, ...body } = envelope;
  if (workspaceDomainHash("tilden:local-session-facts-manifest:v1", body) !== manifestHash
    || !verify(null, Buffer.from(workspaceCanonicalJson({ ...body, manifestHash })), createPublicKey(device.privateKeyPem), Buffer.from(signature.value, "base64url"))
    || Buffer.byteLength(workspaceCanonicalJson(envelope)) > MAX_BYTES) throw Error("Workspace envelope binding is invalid.");
}
function validateDevice(device: WorkspaceDevice): void {
  exactKeys(device, ["origin", "grantId", "keyId", "grantRevision", "connectionEpoch", "token", "privateKeyPem", "sequence", "collectionNotBefore", "authorityStartsAt", "expiresAt"]);
  [device.collectionNotBefore, device.authorityStartsAt, device.expiresAt].forEach(utcDay);
  if (device.origin !== WORKSPACE_ORIGIN || !REF.test(device.grantId) || !REF.test(device.keyId)
    || !UINT.test(device.grantRevision) || !UINT.test(device.connectionEpoch) || !UINT.test(device.sequence)
    || !bytes(device.token, 32) || typeof device.privateKeyPem !== "string" || device.privateKeyPem.length > 2048
    || device.authorityStartsAt > device.collectionNotBefore || device.collectionNotBefore >= device.expiresAt
    || createPrivateKey(device.privateKeyPem).asymmetricKeyType !== "ed25519") throw Error("Workspace device state is invalid.");
}
/** Session facts, plan facts, or both; signed and bound the same way whichever it holds. */
export function buildWorkspaceEnvelope(device: WorkspaceDevice, facts: WorkspaceEnvelopeFact[], generatedAt: string): WorkspaceEnvelope {
  validateDevice(device); utcDay(generatedAt); facts.forEach(validateEnvelopeFact);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(generatedAt) || facts.length < 1 || facts.length > MAX_FACTS)
    throw Error("Workspace envelope bounds are invalid.");
  const sequence = String(BigInt(device.sequence) + 1n);
  if (!UINT.test(sequence)) throw Error("Workspace sequence exceeds its bound.");
  const body = { schemaVersion: "1" as const, deviceGrantId: device.grantId, grantRevision: device.grantRevision, deviceKeyId: device.keyId,
    sequence, nonce: randomBytes(16).toString("base64url"), batchId: `oref_${randomBytes(32).toString("base64url")}`,
    idempotencyKey: `oref_${randomBytes(32).toString("base64url")}`, generatedAt, facts };
  const unsigned = { ...body, manifestHash: workspaceDomainHash("tilden:local-session-facts-manifest:v1", body) };
  const envelope: WorkspaceEnvelope = { ...unsigned, signature: { algorithm: "ed25519", canonicalization: "jcs-v1",
    value: sign(null, Buffer.from(workspaceCanonicalJson(unsigned)), device.privateKeyPem).toString("base64url") } };
  if (Buffer.byteLength(workspaceCanonicalJson(envelope)) > MAX_BYTES) throw Error("Workspace envelope exceeds its byte bound.");
  validateEnvelope(envelope, device);
  return envelope;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
async function privateDirectory(home: string, create: boolean): Promise<string> {
  const canonicalHome = await realpath(resolve(home)), path = join(canonicalHome, ".aibill");
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid())
    throw Error("Workspace private directory is unavailable.");
  return path;
}
async function readState(path: string): Promise<WorkspaceState | null> {
  let file;
  try { file = await open(join(path, STATE_FILE), constants.O_RDONLY | noFollow); }
  catch (error) { if (missing(error)) return null; throw Error("Workspace state could not be opened safely."); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > MAX_STATE_BYTES || process.getuid && info.uid !== process.getuid())
      throw Error("Workspace state is not a private regular file.");
    const state = JSON.parse(await file.readFile("utf8")) as WorkspaceState;
    exactKeys(state, ["version", "device", "facts", "pending", "lastAcceptedAt", "disconnect"], ["capabilities", "agentPlansAccepted"]);
    if (state.version !== 1 || !state.facts || typeof state.facts !== "object" || Array.isArray(state.facts)) throw Error("Workspace state is invalid.");
    validateDevice(state.device);
    if (state.capabilities !== undefined) {
      exactKeys(state.capabilities, ["agentPlanFacts"]);
      if (typeof state.capabilities.agentPlanFacts !== "boolean") throw Error("Workspace capability state is invalid.");
    }
    if (state.agentPlansAccepted !== undefined) validateAcceptedPlans(state.agentPlansAccepted);
    if (state.lastAcceptedAt !== null) utcDay(state.lastAcceptedAt);
    for (const [key, value] of Object.entries(state.facts)) {
      exactKeys(value, ["revision", "contentHash"]);
      if (!HASH.test(key) || !UINT.test(value.revision) || !HASH.test(value.contentHash)) throw Error("Workspace fact state is invalid.");
    }
    if (state.pending) {
      exactKeys(state.pending, ["envelope", "state", "refusal"]);
      if (!["ready", "uncertain", "refused"].includes(state.pending.state)) throw Error("Workspace pending state is invalid.");
      if (state.pending.state === "refused" ? !["invalid", "conflict", "stale", "expired"].includes(String(state.pending.refusal)) : state.pending.refusal !== null)
        throw Error("Workspace refusal state is invalid.");
      validateEnvelope(state.pending.envelope, state.device);
    }
    if (state.disconnect !== null) {
      exactKeys(state.disconnect, ["state", "requestId", "revokedAt"]);
      if (!["uncertain", "revoked"].includes(state.disconnect.state) || !REF.test(state.disconnect.requestId)
        || (state.disconnect.state === "uncertain" ? state.disconnect.revokedAt !== null : typeof state.disconnect.revokedAt !== "string"))
        throw Error("Workspace disconnect state is invalid.");
      if (state.disconnect.revokedAt !== null) utcDay(state.disconnect.revokedAt);
    }
    return state;
  } catch { throw Error("Workspace state is unreadable or invalid; it was not reset."); }
  finally { await file.close(); }
}
async function atomicState(path: string, state: WorkspaceState): Promise<void> {
  return atomicPrivateJson(path, STATE_FILE, state as unknown as Json);
}
async function atomicPrivateJson(path: string, name: string, value: Json): Promise<void> {
  const serialized = `${workspaceCanonicalJson(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw Error("Workspace state exceeds its byte bound.");
  const temporary = join(path, `.workspace-device-${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await handle.writeFile(serialized); await handle.sync(); await handle.close();
    await rename(temporary, join(path, name));
    const directory = await open(path, constants.O_RDONLY | noFollow);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
async function withState<T>(home: string, callback: (state: WorkspaceState | null, save: (state: WorkspaceState) => Promise<void>, path: string) => Promise<T>): Promise<T> {
  const path = await privateDirectory(home, true), directory = await lstat(path);
  let lock;
  try { lock = await open(join(path, LOCK_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
  catch { throw Error("Workspace state is locked. Do not remove a lock while another Workspace command is running."); }
  const identity = await lock.stat();
  try {
    return await callback(await readState(path), async state => {
      const current = await lstat(path);
      if (current.dev !== directory.dev || current.ino !== directory.ino || current.isSymbolicLink()) throw Error("Workspace state directory changed.");
      await atomicState(path, state);
    }, path);
  } finally {
    await lock.close();
    const current = await lstat(join(path, LOCK_FILE)).catch(() => null);
    if (current?.dev === identity.dev && current.ino === identity.ino) await unlink(join(path, LOCK_FILE));
  }
}

export type WorkspaceStatus = { state: "not_connected" } | {
  state: "enrollment_pending"; enrollment: "prepared" | "exchange_uncertain"; requestId: string;
} | {
  state: "connected"; origin: string; lastAcceptedAt: string | null; acknowledgedFacts: number;
  disconnect: "uncertain" | "revoked" | null; capabilities: WorkspaceCapabilities; agentPlansAccepted: WorkspaceAcceptedPlans;
  pending: null | { state: WorkspacePending["state"]; factCount: number; generatedAt: string; refusal: WorkspacePending["refusal"] };
};
/** Reads only the private pairing record; never logs, a provider, or the Workspace. */
export async function workspaceStatus(home = homedir()): Promise<WorkspaceStatus> {
  let path: string;
  try { path = await privateDirectory(home, false); } catch (error) { if (missing(error)) return { state: "not_connected" }; throw error; }
  const state = await readState(path);
  if (!state) {
    const enrollment = await readEnrollment(path);
    return enrollment ? { state: "enrollment_pending", enrollment: enrollment.state, requestId: enrollment.request.requestId }
      : { state: "not_connected" };
  }
  return { state: "connected", origin: state.device.origin, lastAcceptedAt: state.lastAcceptedAt,
    acknowledgedFacts: Object.keys(state.facts).length, disconnect: state.disconnect?.state ?? null,
    capabilities: state.capabilities ?? { agentPlanFacts: false }, agentPlansAccepted: state.agentPlansAccepted ?? {},
    pending: state.pending ? { state: state.pending.state,
      factCount: state.pending.envelope.facts.length, generatedAt: state.pending.envelope.generatedAt, refusal: state.pending.refusal } : null };
}

/** Response headers travel lower-cased, as Node delivers them; tests may omit them. */
export type WorkspaceTransportResult = { status: number; body: unknown; headers?: Record<string, string | string[] | undefined> };
/** The Workspace advertises what it accepts on every ACCEPT in this header, never in the receipt body a released CLI checks strictly. */
export const WORKSPACE_PUSH_CAPABILITIES_HEADER = "x-tilden-push-capabilities";
export type WorkspaceTransport = (path: typeof WORKSPACE_FACTS_PATH, payload: string, token: string) => Promise<WorkspaceTransportResult>;
/** HTTPS native transport avoids browser Origin/Sec-Fetch headers and never follows redirects. */
export const workspaceTransport: WorkspaceTransport = (path, payload, token) => workspaceNativeRequest(path, payload, token);
export const WORKSPACE_DISCONNECT_PATH = "/api/workspace/machines/disconnect";
export type WorkspaceDisconnectTransport = (payload: string, token: string) => Promise<WorkspaceTransportResult>;
export const workspaceDisconnectTransport: WorkspaceDisconnectTransport = (payload, token) => workspaceNativeRequest(WORKSPACE_DISCONNECT_PATH, payload, token);
export const WORKSPACE_EXCHANGE_PATH = "/api/workspace/device-enrollment/exchange";
export type WorkspaceExchangeTransport = (payload: string) => Promise<WorkspaceTransportResult>;
export const workspaceExchangeTransport: WorkspaceExchangeTransport = payload => workspaceNativeRequest(WORKSPACE_EXCHANGE_PATH, payload);
function workspaceNativeRequest(path: string, payload: string, token?: string): Promise<WorkspaceTransportResult> {
 return new Promise((resolveResult, reject) => {
  if (![WORKSPACE_FACTS_PATH, WORKSPACE_EXCHANGE_PATH, WORKSPACE_DISCONNECT_PATH].includes(path) || Buffer.byteLength(payload) > MAX_BYTES
    || (path !== WORKSPACE_EXCHANGE_PATH ? !bytes(token, 32) : token !== undefined)) {
    reject(Error("Workspace request is invalid.")); return;
  }
  let settled = false;
  const finish = (error?: Error, result?: WorkspaceTransportResult) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (error) reject(error); else resolveResult(result!);
  };
  const request = httpsRequest(`${WORKSPACE_ORIGIN}${path}`, { method: "POST", headers: {
    "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { authorization: `Device ${token}` } : {}),
  } }, response => {
    const parts: Buffer[] = []; let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) { response.destroy(); request.destroy(); finish(Error("Workspace response exceeded its bound.")); }
      else parts.push(chunk);
    });
    response.on("error", () => finish(Error("Workspace response was interrupted.")));
    response.on("end", () => {
      if (settled) return;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { finish(Error("Workspace redirect refused.")); return; }
      try { finish(undefined, { status, body: JSON.parse(Buffer.concat(parts).toString("utf8")), headers: response.headers }); }
      catch { finish(Error("Workspace response was not valid JSON.")); }
    });
  });
  const timer = setTimeout(() => { request.destroy(); finish(Error("Workspace request timed out; its outcome is unknown.")); }, 30000);
  request.on("error", () => finish(Error("Workspace request failed; its outcome is unknown.")));
  request.end(payload);
 });
}

type WorkspacePlanFactOptions = {
  generatedAt: string;
  confirm: (exactPayload: string, coverage: WorkspaceAggregate) => Promise<boolean>;
  /**
   * Reads this machine's subscription tier per agent. Called only when the
   * Workspace announced `agentPlanFacts` on its last ACCEPT, the opt-out is not
   * set, and a new envelope is being built. Fails open: a reader that throws, or
   * a fact this CLI would refuse to sign, leaves that tier out of the batch.
   */
  readAgentPlanFacts?: () => Promise<readonly WorkspaceAgentPlanFact[]>;
  /**
   * AIBILL_NO_PLAN_TIER: read no plan facts into a new envelope, and drop a retained
   * batch of tier facts alone without asking. A retained batch that holds session
   * facts is never rebuilt: it was dispatched once, the Workspace may hold it, and
   * only the identical resend reconciles through the replay receipt.
   */
  planFactsOptOut?: boolean;
};
async function offerablePlanFacts(state: WorkspaceState, options: WorkspacePlanFactOptions): Promise<WorkspaceAgentPlanFact[]> {
  // Capability gating: a Workspace that has not announced agentPlanFacts on an ACCEPT gets none, and no sign-in file is read for it.
  if (state.capabilities?.agentPlanFacts !== true || options.planFactsOptOut || !options.readAgentPlanFacts) return [];
  let read: readonly WorkspaceAgentPlanFact[];
  try { read = await options.readAgentPlanFacts(); } catch { return []; }
  return read.filter(fact => {
    try { validateAgentPlanFact(fact); } catch { return false; }
    return WORKSPACE_ACCEPTED_PLAN_SOURCES.has(fact.source);
  });
}
/**
 * A batch of tier facts alone, no longer retained. The local sequence moves past
 * it: whatever answer this machine saw, the Workspace may hold that batch, and a
 * machine one sequence behind would have its next batch refused and retained. The
 * Workspace admits the gap this leaves when it does not hold the batch.
 */
function withoutPlanOnlyBatch(state: WorkspaceState, envelope: WorkspaceEnvelope): WorkspaceState {
  return { ...state, device: { ...state.device, sequence: envelope.sequence }, pending: null };
}
function agentPlanFactsDue(facts: readonly WorkspaceAgentPlanFact[], accepted: WorkspaceAcceptedPlans | undefined, now: string): boolean {
  return facts.some(fact => {
    const last = accepted?.[fact.agent];
    return !last || last.tier !== fact.tier || last.tierRaw !== fact.tierRaw
      || Date.parse(now) - Date.parse(last.sentAt) > WORKSPACE_PLAN_REFRESH_DAYS * 86400000;
  });
}
/**
 * A batch of tier facts and nothing else, offered only when the tier was never
 * accepted, changed, or is due a refresh. The same consent path as any batch,
 * and durable only after consent. Past the grant's end the Workspace answers
 * with no refusal a batch could be dropped on, so none is built.
 */
async function offerPlanOnlyBatch(state: WorkspaceState, save: (state: WorkspaceState) => Promise<void>, coverage: WorkspaceAggregate,
  options: WorkspacePlanFactOptions): Promise<{ state: "prepared" | "unchanged" | "cancelled"; coverage: WorkspaceAggregate }> {
  if (Date.parse(options.generatedAt) >= Date.parse(state.device.expiresAt)) return { state: "unchanged", coverage };
  const plans = await offerablePlanFacts(state, options);
  if (!plans.length || !agentPlanFactsDue(plans, state.agentPlansAccepted, options.generatedAt)) return { state: "unchanged", coverage };
  coverage.agentPlanFacts = plans;
  const envelope = buildWorkspaceEnvelope(state.device, plans, options.generatedAt);
  if (!await options.confirm(workspaceCanonicalJson(envelope), coverage)) return { state: "cancelled", coverage };
  await save({ ...state, pending: { envelope, state: "ready", refusal: null } });
  return { state: "prepared", coverage };
}
/**
 * The tier in the same command whose ACCEPT first announced the capability:
 * reads no local logs, and leaves the state as it found it unless consent is given.
 */
export async function prepareWorkspacePlanFacts(options: WorkspacePlanFactOptions & { home?: string }): Promise<{ state: "prepared" | "unchanged" | "cancelled"; coverage?: WorkspaceAggregate }> {
  return withState(options.home ?? homedir(), async (state, save) => {
    if (!state || state.disconnect || state.pending) return { state: "unchanged" };
    return offerPlanOnlyBatch(state, save, { facts: [], excludedCalls: 0, incompleteComponents: 0, reasons: [] }, options);
  });
}

/** Consent precedes durable preparation. A pending batch is never replaced with a fresh nonce. */
export async function prepareWorkspacePush(options: WorkspacePlanFactOptions & {
  home?: string; calls: readonly LocalAgentCall[];
  /** Finds a session folder's checkout; absent, facts keep the folder name. */
  resolveRepositoryRoot?: (directory: string) => string | undefined;
}): Promise<{ state: "prepared" | "pending" | "unchanged" | "cancelled" | "dropped"; coverage?: WorkspaceAggregate }> {
  return withState(options.home ?? homedir(), async (state, save) => {
    if (!state) throw Error("This machine is not connected to a Workspace.");
    if (state.disconnect) throw Error("Disconnect is pending or complete; no facts may be sent.");
    if (state.pending) {
      if (state.pending.state === "refused") return { state: "pending" };
      // A retained batch is resent exactly as signed, plan facts included: it may already
      // sit on the Workspace with its sequence, and only the identical envelope can be
      // reconciled by the replay receipt. It is never rebuilt. Beside session facts the
      // opt-out applies from the next new batch and a no leaves it retained, because the
      // session facts must reconcile. Tier facts alone have nothing to reconcile, so no
      // session fact waits on a yes: the opt-out and a no both drop them.
      const envelope = state.pending.envelope;
      const coverage: WorkspaceAggregate = { facts: envelope.facts.filter(isWorkspaceSessionFact),
        excludedCalls: 0, incompleteComponents: 0, reasons: ["retained_pending_batch"],
        agentPlanFacts: envelope.facts.filter(isWorkspaceAgentPlanFact) };
      const planOnly = envelope.facts.every(isWorkspaceAgentPlanFact);
      if (!(planOnly && options.planFactsOptOut) && await options.confirm(workspaceCanonicalJson(envelope), coverage)) {
        // Explicit consent permits only the identical retained envelope to be attempted again.
        if (state.pending.state === "uncertain") await save({ ...state, pending: { ...state.pending, state: "ready" } });
        return { state: "prepared", coverage };
      }
      if (!planOnly) return { state: "cancelled", coverage };
      await save(withoutPlanOnlyBatch(state, envelope));
      return { state: "dropped", coverage };
    }
    const calls = options.resolveRepositoryRoot
      ? collapseRepositoryProjects(options.calls, state.facts, options.resolveRepositoryRoot) : options.calls;
    const coverage = aggregateWorkspaceFacts(calls, state.facts, state.device.keyId);
    if (coverage.excludedCalls) throw Error("Incomplete source identities cannot replace complete daily facts.");
    const today = utcDay(options.generatedAt), authority = Math.max(Date.parse(state.device.collectionNotBefore), Date.parse(state.device.authorityStartsAt));
    const eligible = coverage.facts.filter(fact => fact.day < today && Date.parse(`${fact.day}T00:00:00.000Z`) >= authority
      && Date.parse(`${fact.day}T00:00:00.000Z`) + 86400000 <= Date.parse(state.device.expiresAt));
    if (eligible.length !== coverage.facts.length) coverage.reasons.push("outside_closed_authorized_days");
    coverage.facts = eligible;
    if (!coverage.facts.length) return offerPlanOnlyBatch(state, save, coverage, options);
    coverage.agentPlanFacts = await offerablePlanFacts(state, options);
    const envelope = buildWorkspaceEnvelope(state.device,
      [...coverage.facts.slice(0, MAX_FACTS - coverage.agentPlanFacts.length), ...coverage.agentPlanFacts], options.generatedAt);
    if (!await options.confirm(workspaceCanonicalJson(envelope), coverage)) return { state: "cancelled", coverage };
    await save({ ...state, pending: { envelope, state: "ready", refusal: null } });
    return { state: "prepared", coverage };
  });
}

/**
 * The capabilities an ACCEPT announces in `x-tilden-push-capabilities`
 * (`agentPlanFacts=0|1`). Advisory: an absent, malformed or `0` header leaves the
 * Workspace at none; it never turns an accepted push into an uncertain one. The
 * receipt body itself stays the strict eight keys 0.9.15 checks.
 */
export function workspacePushCapabilities(headers: WorkspaceTransportResult["headers"]): WorkspaceCapabilities {
  const raw = headers?.[WORKSPACE_PUSH_CAPABILITIES_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length > 256) return { agentPlanFacts: false };
  const pairs = value.split(/[;,\s]+/).filter(Boolean).map(pair => pair.split("="));
  return { agentPlanFacts: pairs.some(([key, flag, ...rest]) => key === "agentPlanFacts" && flag === "1" && rest.length === 0) };
}
/**
 * One attempt. Uncertain and refused session batches remain retained and cannot
 * silently be resubmitted. A batch of tier facts alone must never strand a
 * machine: no session fact waits behind it, so any refusal drops it, and the
 * capability goes false until a later ACCEPT announces it again. A refusal does not
 * prove the Workspace never stored the batch: a reply lost earlier leaves it stored,
 * and a resend the Workspace's shape check turns away never reaches its replay
 * lookup. So the drop moves the local sequence past the batch, as any drop does.
 */
export async function sendWorkspacePending(options: { home?: string; transport?: WorkspaceTransport }): Promise<{
  state: "accepted" | "refused" | "unconfirmed";
  /** The session facts in the accepted batch. Tier facts are not session facts: they are named, never counted here. */
  sessionFactCount?: number;
  /** This ACCEPT turned the stored capability from false to true. */
  capabilityAnnounced?: boolean;
  /** The refused batch held tier facts alone and was dropped, not retained. */
  planOnlyDropped?: boolean;
}> {
  return withState(options.home ?? homedir(), async (state, save) => {
    if (!state?.pending) throw Error("No prepared Workspace batch exists.");
    if (state.disconnect) throw Error("Disconnect is pending or complete; no facts may be sent.");
    if (state.pending.state !== "ready") throw Error("This batch already has a result or an uncertain outcome; reconcile it before another push.");
    const envelope = state.pending.envelope;
    const dispatched: WorkspaceState = { ...state, pending: { ...state.pending, state: "uncertain" } };
    await save(dispatched);
    let result: WorkspaceTransportResult;
    try { result = await (options.transport ?? workspaceTransport)(WORKSPACE_FACTS_PATH, workspaceCanonicalJson(envelope), state.device.token); }
    catch { return { state: "unconfirmed" }; }
    try {
      const receipt = result.body;
      if (result.status === 200) {
        exactKeys(receipt, ["state", "batchId", "manifestHash", "factCount", "introduced", "replaced", "unchanged", "acceptedAt"]);
        if (receipt.state !== "accepted" || receipt.batchId !== envelope.batchId || receipt.manifestHash !== envelope.manifestHash
          || receipt.factCount !== envelope.facts.length || typeof receipt.acceptedAt !== "string") throw Error("receipt_mismatch");
        utcDay(receipt.acceptedAt);
        const counts = [receipt.introduced, receipt.replaced, receipt.unchanged];
        if (counts.some(value => !Number.isSafeInteger(value) || (value as number) < 0)
          || (counts as number[]).reduce((sum, value) => sum + value, 0) !== envelope.facts.length) throw Error("receipt_counts");
        const capabilities = workspacePushCapabilities(result.headers);
        const facts = { ...state.facts }, agentPlansAccepted = { ...state.agentPlansAccepted };
        for (const fact of envelope.facts)
          if (isWorkspaceAgentPlanFact(fact)) agentPlansAccepted[fact.agent] = { tier: fact.tier, tierRaw: fact.tierRaw, sentAt: receipt.acceptedAt };
          else facts[workspaceFactKey(fact)] = { revision: fact.factRevision, contentHash: workspaceFactContentHash(fact) };
        await save({ ...state, device: { ...state.device, sequence: envelope.sequence }, facts, pending: null, lastAcceptedAt: receipt.acceptedAt, capabilities,
          ...(Object.keys(agentPlansAccepted).length ? { agentPlansAccepted } : {}) });
        return { state: "accepted", sessionFactCount: envelope.facts.filter(isWorkspaceSessionFact).length, capabilityAnnounced: capabilities.agentPlanFacts && state.capabilities?.agentPlanFacts !== true };
      }
      if (result.status === 409) {
        exactKeys(receipt, ["state", "reason"]);
        if (receipt.state === "refused" && typeof receipt.reason === "string" && envelope.facts.every(isWorkspaceAgentPlanFact)) {
          await save({ ...withoutPlanOnlyBatch(dispatched, envelope), capabilities: { agentPlanFacts: false } });
          return { state: "refused", planOnlyDropped: true };
        }
        if (receipt.state !== "refused" || !["invalid", "conflict", "stale", "expired"].includes(String(receipt.reason))) throw Error("receipt_refusal");
        await save({ ...dispatched, pending: { envelope, state: "refused", refusal: receipt.reason as WorkspacePending["refusal"] } });
        return { state: "refused" };
      }
    } catch { return { state: "unconfirmed" }; }
    return { state: "unconfirmed" };
  });
}

export type WorkspaceEnrollmentRequest = {
  schemaVersion: "1"; kind: "tilden_machine_enrollment_request"; origin: typeof WORKSPACE_ORIGIN;
  publicKey: string; keyId: string; requestId: string;
};
export type WorkspaceEnrollmentIntent = {
  publicKey: string; keyId: string; requestId: string; localSourceInstanceRef: string;
  policyRevision: string; readerRevision: string; projectAdmissionRevision: string;
  collectionNotBefore: string; authorityStartsAt: string; grantExpiresAt: string;
};
export type WorkspaceEnrollmentResponse = {
  schemaVersion: "1"; kind: "tilden_machine_enrollment_response"; origin: typeof WORKSPACE_ORIGIN;
  intent: WorkspaceEnrollmentIntent;
  binding: { tenantId: string; policy: Record<string, Json>; projectId: string; sourceProjectRef: string };
  receipt: { state: "prepared"; challengeId: string; requestHash: string; grantId: string; deviceId: string;
    policy: Record<string, Json>; projectId: string; projectRevision: string; sourceProjectRef: string;
    collectionNotBefore: string; authorityStartsAt: string; grantExpiresAt: string; nonce: string; pairingCode: string };
  confirmation: { state: "confirmed"; challengeId: string };
};
type WorkspaceEnrollmentState = { version: 1; request: WorkspaceEnrollmentRequest; privateKeyPem: string; state: "prepared" | "exchange_uncertain" };
const ENROLLMENT_FILE = "workspace-enrollment.json";
export function encodeWorkspaceBundle(value: WorkspaceEnrollmentRequest | WorkspaceEnrollmentResponse): string {
  return Buffer.from(workspaceCanonicalJson(value), "utf8").toString("base64url");
}
function parseWorkspaceResponseBundle(code: string): WorkspaceEnrollmentResponse {
  if (code.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(code)) throw Error("The Workspace response bundle is invalid.");
  const decoded = Buffer.from(code, "base64url");
  if (decoded.toString("base64url") !== code) throw Error("The Workspace response bundle is not canonical.");
  let value: unknown;
  try { value = JSON.parse(decoded.toString("utf8")); } catch { throw Error("The Workspace response bundle is invalid."); }
  if (Buffer.from(workspaceCanonicalJson(value as Json)).toString("base64url") !== code) throw Error("The Workspace response bundle is not canonical.");
  exactKeys(value, ["schemaVersion", "kind", "origin", "intent", "binding", "receipt", "confirmation"]);
  if (value.schemaVersion !== "1" || value.kind !== "tilden_machine_enrollment_response" || value.origin !== WORKSPACE_ORIGIN)
    throw Error("The Workspace response bundle has a different origin or purpose.");
  return value as unknown as WorkspaceEnrollmentResponse;
}
async function readEnrollment(path: string): Promise<WorkspaceEnrollmentState | null> {
  let handle;
  try { handle = await open(join(path, ENROLLMENT_FILE), constants.O_RDONLY | noFollow); }
  catch (error) { if (missing(error)) return null; throw Error("Workspace enrollment could not be opened safely."); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 16384 || process.getuid && info.uid !== process.getuid())
      throw Error("Workspace enrollment is not a private regular file.");
    const state = JSON.parse(await handle.readFile("utf8")) as WorkspaceEnrollmentState;
    exactKeys(state, ["version", "request", "privateKeyPem", "state"]);
    exactKeys(state.request, ["schemaVersion", "kind", "origin", "publicKey", "keyId", "requestId"]);
    if (state.version !== 1 || !["prepared", "exchange_uncertain"].includes(state.state)
      || state.request.schemaVersion !== "1" || state.request.kind !== "tilden_machine_enrollment_request"
      || state.request.origin !== WORKSPACE_ORIGIN || !bytes(state.request.publicKey, 32)
      || ![state.request.keyId, state.request.requestId].every(value => REF.test(value))
      || createPublicKey(state.privateKeyPem).export({ format: "jwk" }).x !== state.request.publicKey)
      throw Error("Workspace enrollment state is invalid.");
    return state;
  } catch { throw Error("Workspace enrollment state is unreadable or invalid; it was not reset."); }
  finally { await handle.close(); }
}
export class WorkspaceEnrollmentRefusal extends Error {
  constructor(readonly reason: "connected" | "exchange_uncertain") { super("Workspace enrollment unavailable"); }
}
/** Generates native custody before displaying public enrollment material. No network call. */
export async function beginWorkspaceEnrollment(home = homedir(), options: { restart?: boolean } = {}): Promise<{
  request: WorkspaceEnrollmentRequest; bundle: string; disposition: "created" | "reused" | "restarted";
}> {
  return withState(home, async (device, _save, path) => {
    if (device) throw new WorkspaceEnrollmentRefusal("connected");
    const retained = await readEnrollment(path);
    if (retained?.state === "exchange_uncertain") throw new WorkspaceEnrollmentRefusal("exchange_uncertain");
    if (retained && !options.restart) return { request: retained.request, bundle: encodeWorkspaceBundle(retained.request), disposition: "reused" };
    const pair = generateKeyPairSync("ed25519"), ref = () => `oref_${randomBytes(32).toString("base64url")}`;
    const request: WorkspaceEnrollmentRequest = { schemaVersion: "1", kind: "tilden_machine_enrollment_request", origin: WORKSPACE_ORIGIN,
      publicKey: pair.publicKey.export({ format: "jwk" }).x!, keyId: ref(), requestId: ref() };
    await atomicPrivateJson(path, ENROLLMENT_FILE, { version: 1, request,
      privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), state: "prepared" });
    return { request, bundle: encodeWorkspaceBundle(request), disposition: retained ? "restarted" : "created" };
  });
}
export function validateWorkspaceEnrollmentResponse(request: WorkspaceEnrollmentRequest, response: WorkspaceEnrollmentResponse, now: string): string {
  utcDay(now);
  const { intent, binding, receipt, confirmation } = response;
  exactKeys(intent, ["publicKey", "keyId", "requestId", "localSourceInstanceRef", "policyRevision", "readerRevision", "projectAdmissionRevision", "collectionNotBefore", "authorityStartsAt", "grantExpiresAt"]);
  exactKeys(binding, ["tenantId", "policy", "projectId", "sourceProjectRef"]);
  if (typeof binding.tenantId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(binding.tenantId)) throw Error("The selected tenant reference is invalid.");
  exactKeys(receipt, ["state", "challengeId", "requestHash", "grantId", "deviceId", "policy", "projectId", "projectRevision", "sourceProjectRef", "collectionNotBefore", "authorityStartsAt", "grantExpiresAt", "nonce", "pairingCode"]);
  exactKeys(confirmation, ["state", "challengeId"]);
  for (const key of ["publicKey", "keyId", "requestId"] as const)
    if (intent[key] !== request[key]) throw Error("The response belongs to a different native enrollment request.");
  const refs = [intent.keyId, intent.requestId, intent.localSourceInstanceRef, intent.policyRevision, intent.readerRevision,
    intent.projectAdmissionRevision, receipt.grantId, receipt.deviceId, receipt.projectId, receipt.projectRevision, receipt.sourceProjectRef];
  if (!refs.every(value => REF.test(value)) || !bytes(receipt.nonce, 32) || !bytes(receipt.pairingCode, 16)) throw Error("Enrollment receipt contains invalid references.");
  for (const value of [intent.collectionNotBefore, intent.authorityStartsAt, intent.grantExpiresAt]) utcDay(value);
  const requestHash = workspaceDomainHash("tilden:device-enrollment-request:v1", { ...intent, challengeId: intent.requestId,
    deviceId: receipt.deviceId, grantId: receipt.grantId, nonceHash: sha(receipt.nonce), pairingCodeHash: sha(receipt.pairingCode) });
  if (receipt.state !== "prepared" || confirmation.state !== "confirmed" || receipt.challengeId !== intent.requestId
    || confirmation.challengeId !== receipt.challengeId || receipt.requestHash !== requestHash
    || receipt.policy.active !== true || receipt.policy.consentRevisionRef !== intent.policyRevision
    || workspaceCanonicalJson(receipt.policy) !== workspaceCanonicalJson(binding.policy)
    || receipt.projectId !== binding.projectId || receipt.sourceProjectRef !== binding.sourceProjectRef
    || receipt.projectRevision !== intent.projectAdmissionRevision || receipt.collectionNotBefore !== intent.collectionNotBefore
    || receipt.authorityStartsAt !== intent.authorityStartsAt || receipt.grantExpiresAt !== intent.grantExpiresAt
    || intent.authorityStartsAt > intent.collectionNotBefore || intent.collectionNotBefore >= intent.grantExpiresAt
    || intent.grantExpiresAt <= now) throw Error("The prepared enrollment does not match its native request and browser confirmation.");
  return workspaceCanonicalJson({ purpose: "device_enrollment_v1", challengeId: receipt.challengeId,
    nonce: receipt.nonce, keyId: intent.keyId, requestHash });
}
/** Exchange is marked uncertain durably before dispatch and is never retried implicitly. */
export async function finishWorkspaceEnrollment(options: { home?: string; bundle: string; now: string;
  confirm: (details: { origin: string; collectionNotBefore: string; grantExpiresAt: string;
    localSourceInstanceRef: string; tenantId: string; projectId: string; sourceProjectRef: string; policy: Record<string, Json> }) => Promise<boolean>;
  transport?: WorkspaceExchangeTransport;
}): Promise<{ state: "connected" | "cancelled" | "unconfirmed" }> {
  return withState(options.home ?? homedir(), async (device, save, path) => {
    if (device) throw Error("This machine is already connected.");
    const retained = await readEnrollment(path);
    if (!retained || retained.state !== "prepared") throw Error("No unused native enrollment exists. Do not replay a completed or uncertain exchange.");
    const response = parseWorkspaceResponseBundle(options.bundle);
    const proof = validateWorkspaceEnrollmentResponse(retained.request, response, options.now);
    if (!await options.confirm({ origin: WORKSPACE_ORIGIN, collectionNotBefore: response.intent.collectionNotBefore,
      grantExpiresAt: response.intent.grantExpiresAt, localSourceInstanceRef: response.intent.localSourceInstanceRef,
      tenantId: response.binding.tenantId, projectId: response.binding.projectId, sourceProjectRef: response.binding.sourceProjectRef, policy: response.binding.policy })) return { state: "cancelled" };
    const body = workspaceCanonicalJson({ challengeId: response.receipt.challengeId, nonce: response.receipt.nonce,
      signature: sign(null, Buffer.from(proof), retained.privateKeyPem).toString("base64url") });
    await atomicPrivateJson(path, ENROLLMENT_FILE, { ...retained, state: "exchange_uncertain" });
    try {
      const result = await (options.transport ?? workspaceExchangeTransport)(body), receipt = result.body;
      exactKeys(receipt, ["state", "deviceGrantId", "grantRevision", "deviceKeyId", "connectionEpoch", "expiresAt", "token", "tokenHashKeyVersion"]);
      if (result.status !== 200 || receipt.state !== "enrolled" || receipt.deviceGrantId !== response.receipt.grantId
        || receipt.deviceKeyId !== retained.request.keyId || receipt.expiresAt !== response.intent.grantExpiresAt
        || typeof receipt.grantRevision !== "string" || !UINT.test(receipt.grantRevision)
        || typeof receipt.connectionEpoch !== "string" || !UINT.test(receipt.connectionEpoch) || !bytes(receipt.token, 32))
        return { state: "unconfirmed" };
      const enrolled: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: receipt.deviceGrantId,
        keyId: receipt.deviceKeyId, grantRevision: receipt.grantRevision, connectionEpoch: receipt.connectionEpoch,
        token: receipt.token, privateKeyPem: retained.privateKeyPem, sequence: "0",
        collectionNotBefore: response.intent.collectionNotBefore, authorityStartsAt: response.intent.authorityStartsAt, expiresAt: response.intent.grantExpiresAt };
      validateDevice(enrolled);
      await save({ version: 1, device: enrolled, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null });
      await unlink(join(path, ENROLLMENT_FILE));
      return { state: "connected" };
    } catch { return { state: "unconfirmed" }; }
  });
}

/** One native attempt per confirmation. Explicit recovery repeats the retained proof; unknown outcomes keep writes blocked. */
export async function disconnectWorkspace(options: { home?: string; retry?: boolean; confirm: (action: "revoke" | "retry_revoke" | "abandon_unexchanged") => Promise<boolean>;
  transport?: WorkspaceDisconnectTransport;
}): Promise<{ state: "revoked" | "abandoned" | "cancelled" | "unconfirmed" | "not_paired" | "retry_not_pending" }> {
  return withState(options.home ?? homedir(), async (state, save, path) => {
    if (options.retry && state?.disconnect?.state !== "uncertain")
      return { state: "retry_not_pending" };
    if (!state) {
      const enrollment = await readEnrollment(path);
      if (!enrollment) return { state: "not_paired" };
      // No exchange can have been dispatched while this state is prepared:
      // finishWorkspaceEnrollment persists exchange_uncertain before transport.
      // An unsigned pasted browser receipt never overrides uncertain custody.
      if (enrollment.state !== "prepared") return { state: "unconfirmed" };
      if (!await options.confirm("abandon_unexchanged")) return { state: "cancelled" };
      await unlink(join(path, ENROLLMENT_FILE));
      const directory = await open(path, constants.O_RDONLY | noFollow);
      try { await directory.sync(); } finally { await directory.close(); }
      return { state: "abandoned" };
    }
    if (state.disconnect?.state === "uncertain" && !options.retry) return { state: "unconfirmed" };
    if (!await options.confirm(state.disconnect?.state === "uncertain" ? "retry_revoke" : "revoke")) return { state: "cancelled" };
    if (state.disconnect?.state !== "revoked") {
      const proof = { purpose: "machine_disconnect_v1", grantId: state.device.grantId,
        grantRevision: state.device.grantRevision, connectionEpoch: state.device.connectionEpoch,
        requestId: state.disconnect?.requestId ?? `oref_${randomBytes(32).toString("base64url")}` };
      const body = { ...proof, publicKey: createPublicKey(state.device.privateKeyPem).export({ format: "jwk" }).x!,
        signature: sign(null, Buffer.from(workspaceCanonicalJson(proof)), state.device.privateKeyPem).toString("base64url") };
      const uncertain: WorkspaceState = { ...state, disconnect: { state: "uncertain", requestId: proof.requestId, revokedAt: null } };
      await save(uncertain);
      try {
        const result = await (options.transport ?? workspaceDisconnectTransport)(workspaceCanonicalJson(body), state.device.token);
        const receipt = result.body;
        exactKeys(receipt, ["state", "grantId", "connectionEpoch", "revokedAt"]);
        if (result.status !== 200 || receipt.state !== "revoked" || receipt.grantId !== proof.grantId
          || receipt.connectionEpoch !== String(BigInt(proof.connectionEpoch) + 1n) || typeof receipt.revokedAt !== "string")
          return { state: "unconfirmed" };
        utcDay(receipt.revokedAt);
        await save({ ...uncertain, disconnect: { state: "revoked", requestId: proof.requestId, revokedAt: receipt.revokedAt } });
      } catch { return { state: "unconfirmed" }; }
    }
    // A durable accepted receipt precedes removal, so a crash cannot authorize another request.
    for (const name of [ENROLLMENT_FILE, STATE_FILE]) {
      const target = join(path, name), info = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
          throw Error("Workspace pairing file is not private; no link target was removed.");
        await unlink(target);
      }
    }
    const directory = await open(path, constants.O_RDONLY | noFollow);
    try { await directory.sync(); } finally { await directory.close(); }
    return { state: "revoked" };
  });
}
