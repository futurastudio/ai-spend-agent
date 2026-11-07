import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalAgentCall } from "@agent-finops/core";
import { runCli } from "./index.js";
import {
  aggregateWorkspaceFacts, prepareWorkspacePush, sendWorkspacePending, workspaceCanonicalJson, workspaceFactContentHash, workspaceFactKey, WORKSPACE_ORIGIN,
  type WorkspaceAggregate, type WorkspaceEnvelope, type WorkspaceFactState, type WorkspaceState
} from "./workspaceConnect.js";

/**
 * The consent preview counts the unknown token components of the session facts in the batch it shows, the one the
 * person says yes to: not those of every fact the window read (facts the Workspace already holds unchanged, or facts
 * waiting for a later batch), and not zero for a retained batch whose facts carry unknown components.
 */
const ref = (char: string) => `oref_${char.repeat(43)}`;
const now = "2026-09-20T12:00:00.000Z";
const evidence = {
  inputTokens: "observed", outputTokens: "observed", cacheReadTokens: "observed",
  cacheWriteTokens: "observed", thoughtTokens: "not_separately_reported", toolTokens: "not_separately_reported",
  calculatedTotalTokens: "calculated_partial", reportedTotalTokens: "not_reported"
} as const;
// One unknown component (the cache write was not reported) on a day the Workspace already holds, unchanged.
const heldDay: LocalAgentCall = {
  agent: "claude-code", sessionId: "private-session-one", callId: "call-one", model: "claude-sonnet-4-5",
  timestamp: "2026-09-17T10:00:00.000Z", usageScope: "turn", workingDirectory: "/private/repo", project: "repo",
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 }, tokenComponentEvidence: { ...evidence, cacheWriteTokens: "not_separately_reported" }
};
// Every component known, on a day the Workspace does not hold yet: the only fact this push sends.
const newDay: LocalAgentCall = {
  agent: "claude-code", sessionId: "private-session-two", callId: "call-two", model: "claude-sonnet-4-5",
  timestamp: "2026-09-18T10:00:00.000Z", usageScope: "turn", workingDirectory: "/private/repo", project: "repo",
  usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cacheWrite5mTokens: 4, cacheWrite1hTokens: 0 }, tokenComponentEvidence: evidence
};

async function connectedHome(facts: WorkspaceFactState = {}): Promise<{ home: string; state: WorkspaceState }> {
  const home = await mkdtemp(join(tmpdir(), "aibill-preview-components-"));
  await mkdir(join(home, ".aibill"), { mode: 0o700 });
  const key = generateKeyPairSync("ed25519");
  const state: WorkspaceState = { version: 1, device: { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"),
    grantRevision: "1", connectionEpoch: "1", sequence: "0", token: Buffer.alloc(32, 1).toString("base64url"),
    privateKeyPem: key.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" },
    facts, pending: null, lastAcceptedAt: facts && Object.keys(facts).length ? "2026-09-18T00:30:00.000Z" : null, disconnect: null };
  await writeFile(join(home, ".aibill", "workspace-device.json"), workspaceCanonicalJson(state as never), { mode: 0o600 });
  return { home, state };
}
const unknownComponents = (payload: string) => (JSON.parse(payload) as WorkspaceEnvelope).facts
  .reduce((count, fact) => count + ("tokens" in fact ? Object.values(fact.tokens).filter(value => value === null).length : 0), 0);

describe("the consent preview's unknown token components", () => {
  it("counts only the facts in the batch, not a held fact the push leaves alone", async () => {
    const held = aggregateWorkspaceFacts([heldDay], {}, ref("b")).facts[0]!;
    expect(Object.values(held.tokens).filter(value => value === null)).toHaveLength(1);
    const { home } = await connectedHome({ [workspaceFactKey(held)]: { revision: "1", contentHash: workspaceFactContentHash(held) } });
    const shown: { payload: string; coverage: WorkspaceAggregate }[] = [];
    const prepared = await prepareWorkspacePush({ home, calls: [heldDay, newDay], generatedAt: now,
      confirm: async (payload, coverage) => { shown.push({ payload, coverage }); return true; } });
    expect(prepared.state).toBe("prepared");
    expect(shown).toHaveLength(1);
    const { payload, coverage } = shown[0]!;
    expect((JSON.parse(payload) as WorkspaceEnvelope).facts.map(fact => "day" in fact ? fact.day : null)).toEqual(["2026-09-18"]);
    expect(unknownComponents(payload)).toBe(0);
    expect(coverage.incompleteComponents).toBe(0);
  });

  it("counts a retained batch's own unknown components when it is shown again", async () => {
    const { home } = await connectedHome();
    const shown: WorkspaceAggregate[] = [];
    const first = await prepareWorkspacePush({ home, calls: [heldDay, newDay], generatedAt: now,
      confirm: async (_payload, coverage) => { shown.push(coverage); return true; } });
    expect(first.state).toBe("prepared");
    // The reply is lost, so the exact envelope is retained and the next push shows it again.
    expect((await sendWorkspacePending({ home, transport: async () => { throw Error("lost reply"); } })).state).toBe("unconfirmed");
    let retainedPayload = "";
    const again = await prepareWorkspacePush({ home, calls: [], generatedAt: now,
      confirm: async (payload, coverage) => { retainedPayload = payload; shown.push(coverage); return true; } });
    expect(again.state).toBe("prepared");
    expect(unknownComponents(retainedPayload)).toBe(1);
    expect(shown.map(coverage => coverage.incompleteComponents)).toEqual([1, 1]);
  });

  it("says in the preview that the count is this batch's", async () => {
    const held = aggregateWorkspaceFacts([heldDay], {}, ref("b")).facts[0]!;
    const { home } = await connectedHome({ [workspaceFactKey(held)]: { revision: "1", contentHash: workspaceFactContentHash(held) } });
    const messages: string[] = [];
    const result = await runCli(["workspace", "push"], { homeDirectory: home, interactive: true, workspaceNow: now,
      consentRead: async (message: string) => { messages.push(message); return "n"; },
      workspaceLoadCalls: async () => ({ calls: [heldDay, newDay], records: [], diagnostics: [], sourceScans: [], filesParsed: 1, agentsDetected: ["claude-code" as const] }),
      workspaceTransport: async () => { throw Error("nothing is sent on no"); } });
    expect(result.stdout).toContain("Not sent.");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Missing token components in this batch: 0.");
  });
});
