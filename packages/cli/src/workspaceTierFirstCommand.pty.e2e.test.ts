import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceEnvelope, isWorkspaceAgentPlanFact, workspaceCanonicalJson, workspaceDomainHash, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceEnvelope, type WorkspaceFact, type WorkspaceState
} from "./workspaceConnect.js";

/**
 * The REAL bin entrypoint on a simulated terminal, answering two consent prompts
 * in one `workspace push`: the production consent reader, the production sign-in
 * reader over a throwaway HOME, and the real clock. As in the signup PTY suite,
 * stdin and stdout are pipes with isTTY spoofed by a --import preload. The preload
 * replaces `https.request` with an in-process Workspace, so no request can leave
 * this machine, and records every body it is handed.
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../core/src/fixtures/local-agent-formats");

const preloadSource = `
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
const fakeTty = (stream) => {
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  if (typeof stream.setRawMode !== "function") stream.setRawMode = function () { return this; };
};
fakeTty(process.stdin);
fakeTty(process.stdout);
if (process.platform !== "win32") process.umask(0o022);
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const https = createRequire(import.meta.url)("node:https");
https.request = (url, _options, onResponse) => {
  const request = new EventEmitter();
  request.destroy = () => {};
  request.end = (payload) => {
    appendFileSync(process.env.WORKSPACE_STUB_LOG, JSON.stringify({ url: String(url), payload }) + "\\n");
    const envelope = JSON.parse(payload);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = { "content-type": "application/json", "x-tilden-push-capabilities": "agentPlanFacts=1" };
    onResponse(response);
    setImmediate(() => {
      response.emit("data", Buffer.from(JSON.stringify({ state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash,
        factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: new Date().toISOString() })));
      response.emit("end");
    });
  };
  return request;
};
syncBuiltinESMExports();
`;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const ref = (char: string) => `oref_${char.repeat(43)}`;

describe("workspace push on a terminal", () => {
  it("takes two deliberate answers in one command: the retained session batch, then the tier the ACCEPT made sendable", { timeout: 60_000 }, async () => {
    expect(existsSync(cliEntry), `built CLI missing at ${cliEntry}: run npx tsc -b first`).toBe(true);
    const home = await mkdtemp(join(tmpdir(), "workspace-push-pty-home-"));
    const stubLog = join(home, "workspace-stub.log");
    const preloadPath = join(home, "workspace-stub-preload.mjs");
    await writeFile(preloadPath, preloadSource, "utf8");

    // The sign-in files, from the gated fixtures; the Codex token is assembled here and exists only in this home.
    await cp(join(fixtureRoot, "claude-code-plan-v1/claude.json"), join(home, ".claude.json"));
    const auth = JSON.parse(await readFile(join(fixtureRoot, "codex-plan-v1/auth.json"), "utf8")) as { tokens: Record<string, string> };
    const parts = JSON.parse(await readFile(join(fixtureRoot, "codex-plan-v1/id-token-parts.json"), "utf8")) as { header: unknown; payload: unknown; signature: string };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    auth.tokens.id_token = `${encode(parts.header)}.${encode(parts.payload)}.${parts.signature}`;
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify(auth));

    // A paired machine holding a retained, uncertain session batch: the resend needs no local logs and the ACCEPT announces the capability.
    const started = Date.now();
    const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1", sequence: "0",
      token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      collectionNotBefore: new Date(started - 7 * 86400000).toISOString(), authorityStartsAt: new Date(started - 7 * 86400000).toISOString(), expiresAt: new Date(started + 7 * 86400000).toISOString() };
    const sessionRefs = [`sha256_${"1".repeat(64)}`];
    const session: WorkspaceFact = { day: new Date(started - 86400000).toISOString().slice(0, 10), agent: "codex", provider: "openai", model: "gpt-5", projectName: "repo",
      directoryRef: `sha256_${"0".repeat(64)}`, apiKeyRef: null, workspaceRef: null, sessionCount: "1", sessionRefs,
      tokens: { uncachedInputTokens: "20", cacheReadTokens: "3", cacheWriteTokens: null, outputTokens: "5" },
      sessionsHash: workspaceDomainHash("tilden:local-session-identities:v1", sessionRefs), factRevision: "1" };
    const envelope = buildWorkspaceEnvelope(device, [session], new Date(started).toISOString());
    const state: WorkspaceState = { version: 1, device, facts: {}, pending: { envelope, state: "uncertain", refusal: null }, lastAcceptedAt: null, disconnect: null };
    await mkdir(join(home, ".aibill"), { mode: 0o700 });
    const statePath = join(home, ".aibill", "workspace-device.json");
    await writeFile(statePath, workspaceCanonicalJson(state as never), { mode: 0o600 });

    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, WORKSPACE_STUB_LOG: stubLog, COLUMNS: "80", NO_COLOR: "1", AI_SPEND_NO_TELEMETRY: "1" };
    for (const name of ["CI", "AI_SPEND_NO_PROMPT", "AI_SPEND_CLAUDE_CONFIG", "AI_SPEND_CODEX_AUTH", "AIBILL_NO_PLAN_TIER"]) delete env[name];
    const child = spawn(process.execPath, ["--import", preloadPath, cliEntry, "workspace", "push"], { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", exited: number | null | undefined;
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const exit = new Promise<number | null>(resolve => child.on("exit", code => { exited = code; resolve(code); }));
    const waitFor = async (needle: string) => {
      const deadline = Date.now() + 15_000;
      while (!output.includes(needle)) {
        if (exited !== undefined) throw new Error(`CLI exited (${exited}) before printing ${JSON.stringify(needle)}:\n${output}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${output}`);
        await sleep(25);
      }
    };
    const sent = async () => (await readFile(stubLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { url: string; payload: string });

    // Prompt one. It waits; nothing is sent until a deliberate answer.
    await waitFor("Send this exact batch again? [y/N]");
    await sleep(1_300);
    expect(await sent()).toEqual([]);
    child.stdin.write("y\r");

    // Prompt two, in the same process. That answer does not carry over to it: it waits for its own.
    await waitFor("This batch carries only the subscription tier");
    await waitFor("Send this batch? [y/N]");
    await sleep(1_300);
    expect(await sent()).toHaveLength(1);
    expect(output).not.toContain("Workspace accepted the subscription tier");
    child.stdin.write("y\r");

    await waitFor("Workspace accepted the subscription tier for claude_code (claude_max_20x), codex (chatgpt_pro).");
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    expect(await exit).toBe(0);
    clearTimeout(timer);
    expect(output).toContain("Workspace accepted 1 local session facts.");
    expect(count(output, "Send this exact batch again? [y/N]")).toBe(1);
    expect(count(output, "Send this batch? [y/N]")).toBe(1);

    const requests = await sent();
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.url === `${WORKSPACE_ORIGIN}/api/workspace/local-session-facts`)).toBe(true);
    expect(requests[0]!.payload).toBe(workspaceCanonicalJson(envelope as never));
    const tier = JSON.parse(requests[1]!.payload) as WorkspaceEnvelope;
    expect(tier.sequence).toBe("2");
    expect(tier.facts.every(isWorkspaceAgentPlanFact)).toBe(true);
    expect(tier.facts.map(fact => isWorkspaceAgentPlanFact(fact) ? [fact.agent, fact.tier] : [])).toEqual([["claude_code", "claude_max_20x"], ["codex", "chatgpt_pro"]]);

    const after = JSON.parse(await readFile(statePath, "utf8")) as WorkspaceState;
    expect(after.pending).toBeNull();
    expect(after.device.sequence).toBe("2");
    expect(Object.keys(after.agentPlansAccepted ?? {})).toEqual(["claude_code", "codex"]);
  });
});
