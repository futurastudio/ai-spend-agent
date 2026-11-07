import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLocalAgentFinancialUsage, type LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import { workspaceClock } from "./lib/clock.js";
import {
  aggregateWorkspaceFacts, isWorkspaceSessionFact, workspaceCanonicalJson, workspaceFactKey, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceFact, type WorkspaceState, type WorkspaceTransport
} from "./workspaceConnect.js";

/**
 * Forked and handed-off Claude Code sessions in the Workspace push. A fork copies the parent's earlier responses into a
 * new session file (new session id, same ids, usage and timestamps, a file that opens at fork time). The reader counts
 * such a response once, under the original session, so a day's fact carries it once; a machine whose earlier push
 * counted the copy sends the corrected, smaller fact on its next push as a revision, and nothing refuses or re-keys it.
 */
const keyId = `oref_${"b".repeat(43)}`;
const now = "2026-11-06T12:00:00.000Z";
const noCheckout = () => undefined;
const repo = "/Users/testuser/agent-finops";
const usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 };
const response = (sessionId: string, timestamp: string, ids: string, tokens: Record<string, number> = usage, cwd = repo) => JSON.stringify({
  type: "assistant", timestamp, cwd, sessionId, requestId: `req-${ids}`,
  message: { id: `msg-${ids}`, model: "claude-opus-4-8", usage: tokens }
});
/** The line a fork's file opens with, written at fork time. */
const opening = (sessionId: string, timestamp: string) => JSON.stringify({ type: "custom-title", sessionId, timestamp });
const shared = (sessionId: string) => response(sessionId, "2026-10-20T10:00:00.000Z", "shared");
/** The same response on a day the 30-day window of a push at `now` no longer reads. */
const sharedOld = (sessionId: string) => response(sessionId, "2026-09-20T10:00:00.000Z", "shared-old");
const original = [opening("sess-1", "2026-09-20T09:59:00.000Z"), sharedOld("sess-1"), shared("sess-1"),
  response("sess-1", "2026-10-20T10:01:00.000Z", "own-1", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })];
const fork = [opening("fork", "2026-10-21T02:00:00.000Z"), sharedOld("fork"), shared("fork"),
  response("fork", "2026-10-21T02:05:00.000Z", "own-f", { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })];
const tokensOf = (fact: WorkspaceFact) => [fact.day, fact.projectName, fact.sessionCount, fact.factRevision, fact.tokens.uncachedInputTokens, fact.tokens.cacheReadTokens, fact.tokens.cacheWriteTokens, fact.tokens.outputTokens];

/** Transcripts on disk as Claude Code leaves them after a fork, a simulated Workspace that keeps every key it accepts, and `workspace push`. */
async function machine() {
  const root = await mkdtemp(join(tmpdir(), "aibill-forked-sessions-"));
  const claude = join(root, "claude", "-Users-testuser-agent-finops"), sessions = join(root, "sessions"), aibill = join(root, ".aibill");
  await mkdir(claude, { recursive: true });
  await mkdir(sessions);
  await mkdir(aibill, { mode: 0o700 });
  // The fork's file sorts before the original's: path order alone would hand the copy the response.
  await writeFile(join(claude, "a-fork.jsonl"), fork.join("\n") + "\n");
  await writeFile(join(claude, "z-original.jsonl"), original.join("\n") + "\n");
  const key = generateKeyPairSync("ed25519");
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: `oref_${"a".repeat(43)}`, keyId, grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-10-01T00:00:00.000Z" };
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null };
  await writeFile(join(aibill, "workspace-device.json"), workspaceCanonicalJson(state as never), { mode: 0o600 });
  const rows = new Map<string, WorkspaceFact>(), requests: WorkspaceEnvelope[] = [];
  const transport: WorkspaceTransport = async (_path, payload) => {
    const envelope = JSON.parse(payload) as WorkspaceEnvelope;
    requests.push(envelope);
    for (const fact of envelope.facts.filter(isWorkspaceSessionFact)) rows.set(workspaceFactKey(fact), fact);
    return { status: 200, headers: {}, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
      factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: envelope.generatedAt } };
  };
  /** The real reader, as `workspace push` runs it: daily facts over the 30 days before `now`. */
  const read = () => loadLocalAgentFinancialUsage({ workspaceDailyFacts: true, claudeProjectsDir: join(root, "claude"), codexSessionsDir: sessions,
    sinceIso: workspaceClock.daysBefore(now, 30), untilIso: `${now.slice(0, 10)}T00:00:00.000Z` });
  const push = async (load?: () => ReturnType<typeof read>) => {
    const before = requests.length;
    const result = await runCli(["workspace", "push"], { homeDirectory: root, interactive: true, workspaceNow: now, workspaceLoadCalls: load ?? read,
      workspaceRepositoryRoot: noCheckout, consentRead: async () => "y", workspaceTransport: transport });
    return { ...result, sent: requests.slice(before).flatMap(envelope => envelope.facts.filter(isWorkspaceSessionFact)) };
  };
  return { read, push, rows };
}

/**
 * What the reader before this one produced for these files: the copy as a second call under the fork's session. Its
 * call id is altered because the reader now folds an identical id into the original; the facts are what that version
 * sent. A test double for an older CLI's read, never for the push.
 */
const asBeforeThisVersion = (calls: readonly LocalAgentCall[]): LocalAgentCall[] => {
  const owner = calls.find(call => call.sessionId === "sess-1" && call.usage.outputTokens === 200)!;
  return [...calls, { ...owner, sessionId: "fork", callId: `callref_${"f".repeat(64)}`, transcriptStartedAt: "2026-10-21T02:00:00.000Z" }];
};

describe("forked Claude Code sessions in the Workspace push", () => {
  it("a day's fact carries a response copied by a fork once, under the original, and the fork's own turns stay", async () => {
    const m = await machine();
    const loaded = await m.read();
    expect(loaded.diagnostics).toEqual([]);
    const calls = loaded.calls.filter(call => call.agent === "claude-code");
    // The shared response once (original), each session's own response once; the day before the window is not read.
    expect(calls.map(call => [call.sessionId, call.timestamp, call.usage.outputTokens]).sort()).toEqual([
      ["fork", "2026-10-21T02:05:00.000Z", 3], ["sess-1", "2026-10-20T10:00:00.000Z", 200], ["sess-1", "2026-10-20T10:01:00.000Z", 20]
    ]);
    const facts = aggregateWorkspaceFacts(calls, {}, keyId).facts;
    expect(facts.map(tokensOf).sort()).toEqual([
      ["2026-10-20", "agent-finops", "1", "1", "110", "1000", "500", "220"],
      ["2026-10-21", "agent-finops", "1", "1", "7", "0", "0", "3"]
    ]);
    // The reader before this one counted the copy too: a second session on the day and every component of it twice.
    expect(aggregateWorkspaceFacts(asBeforeThisVersion(calls), {}, keyId).facts.map(tokensOf).sort()[0])
      .toEqual(["2026-10-20", "agent-finops", "2", "1", "210", "2000", "1000", "420"]);
  });

  it("a machine whose earlier push counted the copy sends the corrected, smaller fact as a revision; nothing refuses or re-keys it", async () => {
    const m = await machine();
    const before = await m.push(async () => ({ ...await m.read(), calls: asBeforeThisVersion((await m.read()).calls) }));
    expect(before.exitCode).toBe(0);
    expect(before.sent.map(tokensOf).sort()).toEqual([
      ["2026-10-20", "agent-finops", "2", "1", "210", "2000", "1000", "420"],
      ["2026-10-21", "agent-finops", "1", "1", "7", "0", "0", "3"]
    ]);
    // This version reads the same files: the one changed fact goes, smaller, as revision 2, under the same key.
    const corrected = await m.push();
    expect(corrected.exitCode).toBe(0);
    expect(corrected.sent.map(tokensOf)).toEqual([["2026-10-20", "agent-finops", "1", "2", "110", "1000", "500", "220"]]);
    expect(workspaceFactKey(corrected.sent[0]!)).toBe(workspaceFactKey(before.sent[0]!));
    expect([...m.rows.values()].map(tokensOf).sort()).toEqual([
      ["2026-10-20", "agent-finops", "1", "2", "110", "1000", "500", "220"],
      ["2026-10-21", "agent-finops", "1", "1", "7", "0", "0", "3"]
    ]);
    // Corrected once: the next push has nothing to send.
    const settled = await m.push();
    expect(settled.exitCode).toBe(0);
    expect(settled.sent).toEqual([]);
    expect(settled.stdout).toContain("No changed eligible local session facts");
  });
});
