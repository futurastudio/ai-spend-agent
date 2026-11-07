import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceEnvelope, workspaceCanonicalJson, workspaceDomainHash, WORKSPACE_ORIGIN,
  type WorkspaceDevice, type WorkspaceFact, type WorkspaceState
} from "./workspaceConnect.js";

/**
 * The real bin on a real pseudo-terminal, killed the ways a command does get killed: the terminal closing, as a dropped
 * SSH session or a closed laptop closes it, SIGTERM and SIGKILL. Node has no pty of its own, so a short python driver
 * holds the terminal's other end. A preload replaces `https.request` so nothing can leave this machine.
 */
const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const python = spawnSync("python3", ["-c", "import pty"]).status === 0;

const driver = String.raw`
import json, os, pty, select, signal, sys, time
# One list of steps per prompt, run in order: y, n, hup, term, kill, or await:<path>, which holds the next step until that file exists.
actions = json.loads(sys.argv[1]); cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out = b""; seen = 0; queue = []; next_at = 0; is_open = True; status = None; deadline = time.time() + 45
def act(kind):
    global is_open
    if kind in ("y", "n"): os.write(fd, kind.encode() + b"\r")
    elif kind == "hup":
        os.close(fd); is_open = False
    elif kind == "term": os.kill(pid, signal.SIGTERM)
    elif kind == "kill": os.kill(pid, signal.SIGKILL)
while time.time() < deadline:
    now = time.time()
    if queue and now >= next_at:
        if not queue[0].startswith("await:"):
            act(queue.pop(0))
        elif os.path.exists(queue[0][6:]):
            queue.pop(0)
    if is_open:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: chunk = b""
            if chunk:
                out += chunk
                while out.count(b"[y/N] ") > seen:
                    queue += actions[seen] if seen < len(actions) else ["n"]; seen += 1
                    # The consent reader drops a line that lands faster than a person could read.
                    next_at = time.time() + 1.3
            else:
                is_open = False
    else:
        time.sleep(0.05)
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st; break
if status is None:
    os.kill(pid, signal.SIGKILL); _, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None, "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None, "pid": pid, "prompts": out.count(b"[y/N] "), "out": out.decode("utf8", "replace").replace("\r\n", "\n")}))
`;

const preloadSource = `
import { appendFileSync, existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
globalThis.fetch = async () => { throw new Error("no network in this test"); };
const https = createRequire(import.meta.url)("node:https");
https.request = (url, _options, onResponse) => {
  const request = new EventEmitter();
  request.destroy = () => {};
  request.end = (payload) => {
    appendFileSync(process.env.WORKSPACE_STUB_LOG, JSON.stringify({ url: String(url), payload }) + "\\n");
    if (process.env.WORKSPACE_STUB_HANG) return;
    const envelope = JSON.parse(payload);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = { "content-type": "application/json" };
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

const ref = (char: string) => `oref_${char.repeat(43)}`;
const LOCKED = "Another aibill Workspace command holds ~/.aibill/.workspace-device.lock, or one was killed and left it. If none is running, delete that file and run this command again.";
type Run = { code: number | null; signal: number | null; pid: number; prompts: number; out: string };

/** A paired machine holding a retained, uncertain batch: a push asks about it without reading any local log. */
async function machine() {
  const home = await mkdtemp(join(tmpdir(), "workspace-lock-pty-home-"));
  const stubLog = join(home, "workspace-stub.log"), preload = join(home, "workspace-stub-preload.mjs");
  await writeFile(preload, preloadSource, "utf8");
  const started = Date.now();
  const device: WorkspaceDevice = { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1", sequence: "0",
    token: Buffer.alloc(32, 1).toString("base64url"), privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    collectionNotBefore: new Date(started - 7 * 86400000).toISOString(), authorityStartsAt: new Date(started - 7 * 86400000).toISOString(), expiresAt: new Date(started + 7 * 86400000).toISOString() };
  const sessionRefs = [`sha256_${"1".repeat(64)}`];
  const session: WorkspaceFact = { day: new Date(started - 86400000).toISOString().slice(0, 10), agent: "codex", provider: "openai", model: "gpt-5", projectName: "repo",
    directoryRef: `sha256_${"0".repeat(64)}`, apiKeyRef: null, workspaceRef: null, sessionCount: "1", sessionRefs,
    tokens: { uncachedInputTokens: "20", cacheReadTokens: "3", cacheWriteTokens: null, outputTokens: "5" },
    sessionsHash: workspaceDomainHash("tilden:local-session-identities:v1", sessionRefs), factRevision: "1" };
  const state: WorkspaceState = { version: 1, device, facts: {}, pending: { envelope: buildWorkspaceEnvelope(device, [session], new Date(started).toISOString()), state: "uncertain", refusal: null }, lastAcceptedAt: null, disconnect: null };
  await mkdir(join(home, ".aibill"), { mode: 0o700 });
  const statePath = join(home, ".aibill", "workspace-device.json"), lockPath = join(home, ".aibill", ".workspace-device.lock");
  await writeFile(statePath, workspaceCanonicalJson(state as never), { mode: 0o600 });
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, WORKSPACE_STUB_LOG: stubLog, COLUMNS: "200", TERM: "xterm", NO_COLOR: "1", AI_SPEND_NO_TELEMETRY: "1" };
    for (const name of ["CI", "AI_SPEND_NO_PROMPT", "AI_SPEND_CLAUDE_CONFIG", "AI_SPEND_CODEX_AUTH", "AIBILL_NO_PLAN_TIER"]) delete env[name];
    return env;
  };
  const onTerminal = (args: string[], actions: string[][], extra: Record<string, string> = {}) => new Promise<Run>((resolve, reject) => {
    const child = spawn("python3", ["-I", "-c", driver, JSON.stringify(actions), process.execPath, "--import", preload, cliEntry, "workspace", ...args],
      { env: { ...baseEnv(), ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("exit", () => { try { resolve(JSON.parse(stdout) as Run); } catch { reject(Error(`pty driver: ${stdout}\n${stderr}`)); } });
  });
  /** Status reads no terminal, so a plain child is the real command. */
  const status = () => spawnSync(process.execPath, ["--import", preload, cliEntry, "workspace", "status"], { env: baseEnv(), encoding: "utf8" });
  const sent = async () => (await readFile(stubLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { home, statePath, lockPath, stubLog, onTerminal, status, sent, raw: () => readFile(statePath, "utf8") };
}

describe.skipIf(!python)("a Workspace command killed on a real terminal", () => {
  it.each([
    ["the terminal closing, as a dropped SSH session closes it", "hup", 1],
    ["SIGTERM", "term", 15],
    ["SIGKILL", "kill", 9],
  ] as const)("at the prompt, by %s: the lock it left names it, and the next push takes that over and asks again", { timeout: 60_000 }, async (_name, how, signal) => {
    expect(existsSync(cliEntry), `built CLI missing at ${cliEntry}: run npx tsc -b first`).toBe(true);
    const m = await machine();
    const before = await m.raw();
    const killed = await m.onTerminal(["push"], [[how]]);
    expect(killed.signal).toBe(signal);
    expect(killed.prompts).toBe(1);
    expect(await m.raw()).toBe(before);
    // What it leaves is the reason this test exists: a process that dies this way runs no cleanup.
    expect(await readFile(m.lockPath, "utf8")).toBe(`${killed.pid} ${hostname().replace(/\s+/g, "-")}\n`);
    expect(await m.sent()).toEqual([]);
    expect(m.status().stdout).not.toContain("workspace-device.lock");

    const next = await m.onTerminal(["push"], [["n"]]);
    expect(next.prompts).toBe(1);
    expect(next.out).toContain("Send this exact batch again? [y/N]");
    expect(next.code).toBe(0);
    expect(existsSync(m.lockPath)).toBe(false);
    expect(await m.sent()).toEqual([]);
  });

  it("during the send: the batch stays uncertain, and the next push takes the lock over and lands that exact batch", { timeout: 60_000 }, async () => {
    const m = await machine();
    const killed = await m.onTerminal(["push"], [["y", `await:${m.stubLog}`, "kill"]], { WORKSPACE_STUB_HANG: "1" });
    expect(killed.signal).toBe(9);
    const first = await m.sent();
    expect(first).toHaveLength(1);
    expect((JSON.parse(await m.raw()) as WorkspaceState).pending?.state).toBe("uncertain");
    expect(existsSync(m.lockPath)).toBe(true);

    const next = await m.onTerminal(["push"], [["y"]]);
    expect(next.code).toBe(0);
    expect(next.out).toContain("Workspace accepted 1 local session facts.");
    const both = await m.sent();
    expect(both).toHaveLength(2);
    expect(both[1]).toBe(first[0]);
    expect((JSON.parse(await m.raw()) as WorkspaceState).pending).toBeNull();
    expect(existsSync(m.lockPath)).toBe(false);
  });

  it("at the disconnect's own question: the next disconnect takes the lock over and asks again", { timeout: 60_000 }, async () => {
    const m = await machine();
    const killed = await m.onTerminal(["disconnect"], [["hup"]]);
    expect(killed.signal).toBe(1);
    expect(existsSync(m.lockPath)).toBe(true);
    const next = await m.onTerminal(["disconnect"], [["n"]]);
    expect(next.prompts).toBe(1);
    expect(next.out).toContain("Pairing kept.");
    expect(existsSync(m.lockPath)).toBe(false);
  });

  it("a lock with no owner, as a released CLI leaves one: its own line, on status too; deleting the file as it says is enough", { timeout: 60_000 }, async () => {
    const m = await machine();
    await writeFile(m.lockPath, "", { mode: 0o600 });
    const stopped = await m.onTerminal(["push"], []);
    expect(stopped.code).toBe(1);
    expect(stopped.prompts).toBe(0);
    expect(stopped.out.trim()).toBe(LOCKED);
    expect(m.status().stdout).toContain("delete that file before the next connect, push or disconnect.");
    await rm(m.lockPath);
    const next = await m.onTerminal(["push"], [["n"]]);
    expect(next.prompts).toBe(1);
    expect(next.code).toBe(0);
  });

  it("a command still running keeps its lock: a second push says so and leaves it", { timeout: 60_000 }, async () => {
    const m = await machine();
    const release = join(m.home, "answer-now");
    const first = m.onTerminal(["push"], [[`await:${release}`, "n"]]);
    // It holds its answer until the second command has run, so a slow machine cannot end it first.
    const deadline = Date.now() + 15_000;
    while (!(await readFile(m.lockPath, "utf8").catch(() => "")).includes(" ") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const second = await m.onTerminal(["push"], []);
    expect(second.code).toBe(1);
    expect(second.out.trim()).toBe(LOCKED);
    expect(await readFile(m.lockPath, "utf8")).toContain(" ");
    await writeFile(release, "");
    const done = await first;
    expect(done.code).toBe(0);
    expect(existsSync(m.lockPath)).toBe(false);
  });
});
