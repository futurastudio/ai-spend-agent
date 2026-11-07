import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadLocalAgentFinancialUsage, type LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import { workspaceClock } from "./lib/clock.js";
import {
  aggregateWorkspaceFacts, collapseRepositoryProjects, isWorkspaceSessionFact, workspaceCanonicalJson, workspaceDomainHash,
  workspaceFactContentHash, workspaceFactKey, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceFact, type WorkspaceFactState, type WorkspaceState, type WorkspaceTransport
} from "./workspaceConnect.js";

/**
 * Codex in the Workspace push. A rollout Codex compressed is read (so a day never goes out shorter than it went before),
 * and each event goes under the folder its turn ran in, unless a release before this one already sent it under its
 * session's first folder. No fact that went out moves, shrinks or doubles, across pushes with files compressing between.
 */
const keyId = `oref_${"b".repeat(43)}`;
const home = homedir();
const tilden = "/Users/testuser/tilden";
const evidence = {
  inputTokens: "observed", outputTokens: "observed", cacheReadTokens: "observed",
  cacheWriteTokens: "not_separately_reported", thoughtTokens: "not_separately_reported", toolTokens: "not_separately_reported",
  calculatedTotalTokens: "calculated_partial", reportedTotalTokens: "not_reported"
} as const;
const call = (overrides: Partial<LocalAgentCall>): LocalAgentCall => ({
  agent: "codex", model: "gpt-5.6", timestamp: "2026-10-20T10:00:00.000Z", startedAt: "2026-10-20T10:00:00.000Z", sessionId: "s", callId: "c-1",
  usageScope: "turn", workingDirectory: home, project: "(home)",
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }, tokenComponentEvidence: evidence, ...overrides
});
/** S's turn moved from the home folder to Tilden; T never moved. */
const moved = (overrides: Partial<LocalAgentCall> = {}) => call({ sessionId: "S", callId: "s-after", workingDirectory: tilden, project: "tilden",
  sessionPlace: { workingDirectory: home, project: "(home)" }, ...overrides });
const stayed = (overrides: Partial<LocalAgentCall> = {}) => call({ sessionId: "T", callId: "t", ...overrides });
const record = (facts: readonly WorkspaceFact[], into: WorkspaceFactState = {}): WorkspaceFactState => {
  for (const fact of facts) into[workspaceFactKey(fact)] = { revision: fact.factRevision, contentHash: workspaceFactContentHash(fact) };
  return into;
};
/** How a release before this one filed a call: under its session's first folder. */
const asEarlierRelease = (item: LocalAgentCall): LocalAgentCall => {
  if (!item.sessionPlace) return item;
  const { sessionPlace, ...rest } = item;
  return { ...rest, workingDirectory: sessionPlace.workingDirectory, project: sessionPlace.project };
};
const noCheckout = () => undefined;
const facts = (calls: readonly LocalAgentCall[], previous: WorkspaceFactState, kept?: readonly string[]) => {
  const placed = collapseRepositoryProjects(calls, previous, noCheckout, {}, kept);
  return { ...aggregateWorkspaceFacts(placed.calls, previous, keyId), keptPlaces: placed.keptPlaces, calls: placed.calls };
};

describe("placing Codex events (collapseRepositoryProjects)", () => {
  it("an unsent day takes the turn's folder, and a first push records that no earlier release sent a place", () => {
    const placed = facts([stayed(), moved()], {});
    expect(placed.calls.map(item => [item.sessionId, item.workingDirectory, "sessionPlace" in item])).toEqual([["T", home, false], ["S", tilden, false]]);
    expect(placed.facts.map(fact => [fact.projectName, fact.sessionCount])).toEqual(expect.arrayContaining([[null, "1"], ["tilden", "1"]]));
    expect(placed.keptPlaces).toEqual([]);
  });

  it("a place an earlier release sent keeps its events, and that is what the first push records", () => {
    const sent = record(aggregateWorkspaceFacts([stayed(), moved()].map(asEarlierRelease), {}, keyId).facts);
    const placed = facts([stayed(), moved()], sent);
    expect(placed.calls.map(item => item.workingDirectory)).toEqual([home, home]);
    expect(placed.facts).toEqual([]);
    expect(placed.keptPlaces).toHaveLength(1);
    // Every later push reads the list, not the ledger.
    expect(facts([stayed(), moved()], sent, placed.keptPlaces).facts).toEqual([]);
  });

  it("once this release has sent a day, a session that never moved does not pull a moved one back into its folder", () => {
    // The ledger alone cannot tell this from the case above: T alone put the home folder's key there.
    const first = facts([stayed(), moved()], {});
    const ledger = record(first.facts);
    const second = facts([stayed(), moved()], ledger, first.keptPlaces);
    expect(second.facts).toEqual([]);
    expect(second.calls.map(item => item.workingDirectory)).toEqual([home, tilden]);
    // What the brief's ledger-only rule would have sent: the home folder's row again, now holding S too.
    const ledgerOnly = facts([stayed(), moved()], ledger);
    expect(ledgerOnly.facts.map(fact => [fact.projectName, fact.sessionCount, fact.factRevision])).toEqual([[null, "2", "2"]]);
  });

  it("an event read for the first time on a day an earlier release sent joins that day's place, which grows", () => {
    const sent = record(aggregateWorkspaceFacts([stayed()], {}, keyId).facts);
    const placed = facts([stayed(), moved()], sent);
    expect(placed.facts.map(fact => [fact.projectName, fact.sessionCount, fact.factRevision])).toEqual([[null, "2", "2"]]);
  });

  it("keeps the name the place went out under, as #139 does for any place", () => {
    const repoTurn = moved({ workingDirectory: "/repo/.worktrees/feature", project: "feature",
      sessionPlace: { workingDirectory: "/repo/apps/web", project: "web" } });
    const resolveRoot = (directory: string) => directory.startsWith("/repo") ? "/repo" : undefined;
    // An earlier release sent the session's folder under the folder's own name, before checkouts were collapsed.
    const sent = record(aggregateWorkspaceFacts([asEarlierRelease(repoTurn)], {}, keyId).facts);
    const placed = collapseRepositoryProjects([repoTurn], sent, resolveRoot);
    expect(placed.calls.map(item => [item.workingDirectory, item.project])).toEqual([["/repo/apps/web", "web"]]);
    expect(aggregateWorkspaceFacts(placed.calls, sent, keyId).facts).toEqual([]);
    // Unsent, the turn's folder is named after its repository.
    expect(collapseRepositoryProjects([repoTurn], {}, resolveRoot).calls.map(item => [item.workingDirectory, item.project]))
      .toEqual([["/repo/.worktrees/feature", "repo"]]);
  });
});

const meta = (id: string, cwd: string, at: string) =>
  JSON.stringify({ type: "session_meta", timestamp: at, payload: { id, timestamp: at, cwd, cli_version: "0.130.0" } });
const turn = (cwd: string, at: string) => JSON.stringify({ type: "turn_context", timestamp: at, payload: { cwd, model: "gpt-5.6" } });
const tokens = (at: string, input: number, cached: number, output: number) => JSON.stringify({ type: "event_msg", timestamp: at,
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } });

/** Rollouts on disk as Codex keeps them, a simulated Workspace that keeps every key it accepts, and `workspace push`. */
async function machine(rollouts: Record<string, string[]>) {
  const root = await mkdtemp(join(tmpdir(), "aibill-codex-places-"));
  const sessions = join(root, "sessions"), day = join(sessions, "2026", "10", "20"), claude = join(root, "claude"), aibill = join(root, ".aibill");
  await mkdir(day, { recursive: true });
  await mkdir(claude);
  await mkdir(aibill, { mode: 0o700 });
  const path = (id: string) => join(day, `rollout-2026-10-20T09-00-00-${id}.jsonl`);
  for (const [id, lines] of Object.entries(rollouts)) await writeFile(path(id), lines.join("\n") + "\n");
  const key = generateKeyPairSync("ed25519");
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: `oref_${"a".repeat(43)}`, keyId, grantRevision: "1", connectionEpoch: "1",
    sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-10-01T00:00:00.000Z", authorityStartsAt: "2026-10-01T00:00:00.000Z", expiresAt: "2027-10-01T00:00:00.000Z" };
  const statePath = join(aibill, "workspace-device.json");
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: null, lastAcceptedAt: null, disconnect: null };
  await writeFile(statePath, workspaceCanonicalJson(state as never), { mode: 0o600 });
  /** The Workspace keeps every key it accepts; the same key replaces its row. */
  const rows = new Map<string, WorkspaceFact>(), requests: WorkspaceEnvelope[] = [];
  const transport: WorkspaceTransport = async (_path, payload) => {
    const envelope = JSON.parse(payload) as WorkspaceEnvelope;
    requests.push(envelope);
    for (const fact of envelope.facts.filter(isWorkspaceSessionFact)) rows.set(workspaceFactKey(fact), fact);
    return { status: 200, headers: {}, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
      factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: envelope.generatedAt } };
  };
  const now = "2026-11-06T12:00:00.000Z";
  const read = () => loadLocalAgentFinancialUsage({ workspaceDailyFacts: true, codexSessionsDir: sessions, claudeProjectsDir: claude,
    sinceIso: workspaceClock.daysBefore(now, 30), untilIso: `${now.slice(0, 10)}T00:00:00.000Z` });
  const push = async (load = read) => {
    const before = requests.length;
    const result = await runCli(["workspace", "push"], { homeDirectory: root, interactive: true, workspaceNow: now, workspaceLoadCalls: load,
      workspaceRepositoryRoot: noCheckout, consentRead: async () => "y", workspaceTransport: transport });
    return { ...result, sent: requests.slice(before).flatMap(envelope => envelope.facts.filter(isWorkspaceSessionFact)) };
  };
  /** As Codex does after 7 cold days: the same bytes in one zstd frame, the plain file's mtime kept, the plain file gone. */
  const compress = async (id: string) => {
    const text = await readFile(path(id));
    await writeFile(`${path(id)}.zst`, zstdCompressSync(text));
    await utimes(`${path(id)}.zst`, new Date("2026-10-22T00:00:00.000Z"), new Date("2026-10-22T00:00:00.000Z"));
    await rm(path(id));
  };
  /** An earlier release's ledger and rows: every event under its session's first folder, plain files only. */
  const sentByEarlierRelease = async (only?: (item: LocalAgentCall) => boolean) => {
    const calls = (await read()).calls.filter(item => !only || only(item)).map(asEarlierRelease);
    const sent = aggregateWorkspaceFacts(calls, {}, keyId).facts;
    for (const fact of sent) rows.set(workspaceFactKey(fact), fact);
    const held = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    await writeFile(statePath, JSON.stringify({ ...held, facts: record(sent) }), { mode: 0o600 });
  };
  const sum = (items: Iterable<{ day: string; tokens: WorkspaceFact["tokens"] }>) => {
    const byDay: Record<string, number[]> = {};
    for (const item of items) {
      const total = byDay[item.day] ??= [0, 0, 0];
      total[0]! += Number(item.tokens.uncachedInputTokens); total[1]! += Number(item.tokens.cacheReadTokens); total[2]! += Number(item.tokens.outputTokens);
    }
    return byDay;
  };
  /** The disk's truth for the closed days: every event in the window, from every file, plain or compressed. */
  const truth = async () => sum(aggregateWorkspaceFacts((await read()).calls, {}, keyId).facts);
  const server = () => sum(rows.values());
  const places = () => [...rows.values()].map(fact => `${fact.day} ${fact.projectName ?? "(no name)"} ${fact.sessionCount} r${fact.factRevision}`).sort();
  return { push, compress, sentByEarlierRelease, truth, server, places, statePath, read };
}

/** S starts in the home folder and moves to Tilden at 11:00 on 10-20; T stays in the home folder; both run on 10-20 and 10-21. */
const S = [meta("S", home, "2026-10-20T09:00:00.000Z"), turn(home, "2026-10-20T09:00:01.000Z"), tokens("2026-10-20T09:30:00.000Z", 1000, 600, 50),
  turn(tilden, "2026-10-20T11:00:00.000Z"), tokens("2026-10-20T11:30:00.000Z", 3000, 2000, 120), tokens("2026-10-21T08:00:00.000Z", 4500, 3000, 200)];
const T = [meta("T", home, "2026-10-20T09:10:00.000Z"), turn(home, "2026-10-20T09:10:01.000Z"), tokens("2026-10-20T09:40:00.000Z", 700, 300, 40),
  tokens("2026-10-21T09:00:00.000Z", 1200, 500, 90)];

describe("workspace push with Codex rollouts compressing between pushes", () => {
  it("a file compressed after it went out is still read, so its day does not shrink", async () => {
    const m = await machine({ S, T });
    const first = await m.push();
    expect(first.exitCode).toBe(0);
    expect(first.sent.length).toBeGreaterThan(0);
    await m.compress("T");
    const second = await m.push();
    expect(second.sent).toEqual([]);
    expect(second.stdout).toContain("No changed eligible local session facts to push.");
    await m.compress("S");
    expect((await m.push()).sent).toEqual([]);
    expect(m.server()).toEqual(await m.truth());
  });

  it("three pushes: a day an earlier release sent keeps its folder, a new day takes the turn's, and nothing doubles", async () => {
    const m = await machine({ S, T });
    // An earlier release sent 10-20, every event under the home folder, before any file was compressed.
    await m.sentByEarlierRelease(item => item.timestamp < "2026-10-21");
    expect(m.places()).toEqual(["2026-10-20 (no name) 2 r1"]);
    const first = await m.push();
    expect(first.exitCode).toBe(0);
    expect(m.places()).toEqual(["2026-10-20 (no name) 2 r1", "2026-10-21 (no name) 1 r1", "2026-10-21 tilden 1 r1"]);
    expect((JSON.parse(await readFile(m.statePath, "utf8")) as WorkspaceState).codexKeptPlaces).toHaveLength(1);
    await m.compress("S");
    expect((await m.push()).sent).toEqual([]);
    await m.compress("T");
    expect((await m.push()).sent).toEqual([]);
    expect(m.places()).toEqual(["2026-10-20 (no name) 2 r1", "2026-10-21 (no name) 1 r1", "2026-10-21 tilden 1 r1"]);
    expect(m.server()).toEqual(await m.truth());
  });

  it("a day an earlier release sent short, because a file was compressed, grows back on the next push", async () => {
    const m = await machine({ S, T });
    await m.compress("S");
    // An earlier release read only plain files: 10-20 went out with T alone.
    await m.sentByEarlierRelease(item => item.sessionId === "T" && item.timestamp < "2026-10-21");
    const first = await m.push();
    expect(first.exitCode).toBe(0);
    expect(first.sent.filter(fact => fact.day === "2026-10-20").map(fact => [fact.projectName, fact.sessionCount, fact.factRevision])).toEqual([[null, "2", "2"]]);
    expect((await m.push()).sent).toEqual([]);
    expect(m.server()).toEqual(await m.truth());
  });

  it("a fresh machine: a session that never moved does not pull a moved one back into its folder on the next push", async () => {
    const m = await machine({ S, T });
    await m.push();
    expect(m.places()).toEqual(["2026-10-20 (no name) 2 r1", "2026-10-20 tilden 1 r1", "2026-10-21 (no name) 1 r1", "2026-10-21 tilden 1 r1"]);
    expect((await m.push()).sent).toEqual([]);
    await m.compress("S");
    await m.compress("T");
    expect((await m.push()).sent).toEqual([]);
    expect(m.server()).toEqual(await m.truth());
  });

  it("on a Node.js that cannot read compressed rollouts the push sends nothing, in one line, and leaves the state as it was", async () => {
    const m = await machine({ S, T });
    const before = await readFile(m.statePath, "utf8");
    const message = `1 compressed Codex session file(s) could not be read: reading them needs Node.js 22.15 or later, and this is Node.js v22.14.0.`;
    // A test double for the reader on such a Node.js: what the core tests show it reports.
    const refused = await m.push(async () => ({ ...await m.read(), diagnostics: [{ agent: "codex", code: "compressed_unsupported", severity: "error", message, count: 1 }] }));
    expect(refused).toMatchObject({ exitCode: 1, stdout: "", stderr: `${message} No facts were replaced or sent.`, sent: [] });
    expect(await readFile(m.statePath, "utf8")).toBe(before);
  });
});

describe("the state file", () => {
  it("holds the kept places as hashes only, and refuses any other shape", async () => {
    const m = await machine({ S, T });
    await m.push();
    const held = JSON.parse(await readFile(m.statePath, "utf8")) as WorkspaceState;
    expect(held.codexKeptPlaces).toEqual([]);
    for (const bad of [["not-a-hash"], "x", [`sha256_${"0".repeat(64)}`, `sha256_${"0".repeat(64)}`]]) {
      await writeFile(m.statePath, JSON.stringify({ ...held, codexKeptPlaces: bad }), { mode: 0o600 });
      expect((await m.push()).exitCode, JSON.stringify(bad)).toBe(1);
    }
    expect(workspaceDomainHash("tilden:local-session-kept-place:v1", ["2026-10-20", "codex", "openai", "gpt-5.6", `sha256_${"0".repeat(64)}`])).toMatch(/^sha256_[a-f0-9]{64}$/);
  });
});
