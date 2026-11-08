import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import * as workspace from "./workspaceConnect.js";
import { WORKSPACE_ORIGIN, workspaceCanonicalJson, workspaceScheduleBinding, type WorkspaceState } from "./workspaceConnect.js";
import { authorizedWorkspaceSchedule, dailyCron, dailyLaunchAgent, readWorkspaceSchedule, stageWorkspaceRuntime, updateWorkspaceSchedule, type ScheduleCommand } from "./workspaceSchedule.js";

const homes: string[] = [];
const now = "2026-11-08T12:00:00.000Z";
const ref = (letter: string) => `oref_${letter.repeat(43)}`;
async function machine() {
  const home = await mkdtemp(join(tmpdir(), "aibill-schedule-")); homes.push(home);
  await mkdir(join(home, ".aibill"), { mode: 0o700 });
  const state: WorkspaceState = { version: 1, device: { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1", token: Buffer.alloc(32, 1).toString("base64url"),
    privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), sequence: "0", collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" }, facts: {}, pending: null, disconnect: null, lastAcceptedAt: null };
  const path = join(home, ".aibill", "workspace-device.json");
  const save = () => writeFile(path, workspaceCanonicalJson(state as never), { mode: 0o600 });
  await save();
  return { home, state, save };
}
const fakeRuntime = async (path: string) => { const entry = join(path, "index.mjs"); await writeFile(entry, "export async function runCli() { return {exitCode:0}; }"); return entry; };
function cron() {
  let value = "5 1 * * * /usr/bin/true # existing-job\n";
  const command = vi.fn<ScheduleCommand>(async (_command, args, input) => {
    if (args[0] === "-l") return { code: 0, stdout: value };
    value = input!; return { code: 0, stdout: "" };
  });
  return { command, value: () => value };
}
async function install(home: string, command: ScheduleCommand = cron().command) {
  return updateWorkspaceSchedule({ home, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(home))!, platform: "linux", command, stageRuntime: fakeRuntime });
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

describe("daily Workspace sync consent and OS jobs", () => {
  it("does not scan, send, or install without interactive standing consent", async () => {
    const { home } = await machine(), load = vi.fn(), os = cron();
    for (const argv of [["workspace", "push", "--scheduled"], ["workspace", "push", "--schedule", "daily"]]) {
      const result = await runCli(argv, { homeDirectory: home, workspaceLoadCalls: load, workspaceScheduleOptions: { command: os.command } });
      expect(result.exitCode).toBe(1);
    }
    const declined = await runCli(["workspace", "push", "--schedule", "daily"], { homeDirectory: home, interactive: true, consentRead: async () => "n", workspaceNow: now, workspaceLoadCalls: load, workspaceScheduleOptions: { command: os.command } });
    expect(declined.stdout).toContain("unchanged"); expect(load).not.toHaveBeenCalled(); expect(os.command).not.toHaveBeenCalled();
    expect(await readWorkspaceSchedule(home)).toBeNull();
  });
  it("keeps unrelated cron jobs, installs idempotently, removes consent before removing the job", async () => {
    const { home, state } = await machine(), os = cron();
    await install(home, os.command); await install(home, os.command);
    expect(os.value().split("aibill-workspace-daily-v1")).toHaveLength(2);
    expect(os.value()).toContain("existing-job"); expect(os.value()).not.toContain(state.device.token);
    expect(os.value()).not.toContain(state.device.grantId); expect(os.value()).not.toContain("_npx");
    expect(await authorizedWorkspaceSchedule(home)).not.toBeNull();
    const command: ScheduleCommand = async (...args) => { expect(await readWorkspaceSchedule(home)).toBeNull(); return os.command(...args); };
    await updateWorkspaceSchedule({ home, mode: "none", now, includePlanTier: false, platform: "linux", command });
    expect(os.value()).toBe("5 1 * * * /usr/bin/true # existing-job\n"); expect(await authorizedWorkspaceSchedule(home)).toBeNull();
  });
  it("removes obsolete private runtimes only after successful replacement or removal", async () => {
    const { home } = await machine(), os = cron(), root = join(home, ".aibill", "workspace-sync");
    await install(home, os.command);
    const names = async () => (await readdir(root)).filter(name => /^runtime-[a-f0-9-]{36}$/.test(name));
    const first = (await names())[0]!;
    await expect(install(home, async (_cmd, args) => ({ code: args[0] === "-l" ? 0 : 2, stdout: "" }))).rejects.toThrow();
    expect(await names()).toEqual([first]); // Partial replacement cannot remove the installed code.
    await mkdir(join(root, "runtime-not-managed"));
    const link = "runtime-11111111-1111-4111-8111-111111111111";
    await symlink(join(root, "runtime-not-managed"), join(root, link));
    await install(home, os.command);
    const kept = await names();
    expect(kept).toHaveLength(2); expect(kept).toContain(link); expect(kept).not.toContain(first);
    await updateWorkspaceSchedule({ home, mode: "none", now, includePlanTier: false, platform: "linux", command: os.command });
    expect(await names()).toEqual([link]);
    expect(await readdir(root)).toContain("runtime-not-managed");
  });
  it("fails closed if the OS install fails or the machine grant changes", async () => {
    const { home, state, save } = await machine();
    await expect(install(home, async (_cmd, args) => ({ code: args[0] === "-l" ? 0 : 2, stdout: "" }))).rejects.toThrow("could not be installed");
    expect(await readWorkspaceSchedule(home)).toBeNull();
    await install(home);
    state.device.connectionEpoch = "2"; await save();
    expect(await authorizedWorkspaceSchedule(home)).toBeNull();
    const load = vi.fn();
    expect((await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceLoadCalls: load })).exitCode).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });
  it("uses launchd arguments without a shell and never installs a real launch agent in tests", async () => {
    const { home } = await machine();
    const command = vi.fn<ScheduleCommand>(async () => ({ code: 0, stdout: "" }));
    await updateWorkspaceSchedule({ home, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(home))!, platform: "darwin", command, stageRuntime: fakeRuntime });
    const plist = await readFile(join(home, "Library", "LaunchAgents", "com.asktilden.workspace-daily.plist"), "utf8");
    expect(plist).toContain("StartCalendarInterval"); expect(plist).not.toContain("/bin/sh");
    expect(command.mock.calls.at(-1)?.[1][0]).toBe("bootstrap");
  });
  it("quotes paths and cron percent signs; launchd XML escapes special characters", () => {
    const line = dailyCron("", "/node's & bin/node", "/home/user/50% done/run.mjs");
    expect(line).toContain("'\\''"); expect(line).toContain("50\\% done");
    const plist = dailyLaunchAgent("/x<&\"'/node", "/x/run.mjs");
    expect(plist).toContain("&lt;&amp;&quot;&apos;");
  });
  it("retains the actual installed runtime and runs it independently of the source path", async () => {
    const { home } = await machine(), destination = join(home, "runtime");
    await mkdir(destination);
    const entry = await stageWorkspaceRuntime(destination);
    const result = await promisify(execFile)(process.execPath, [entry, "--help"], { env: { ...process.env, AI_SPEND_NO_TELEMETRY: "1", AI_SPEND_NO_PROMPT: "1" } });
    expect(result.stdout).toContain("workspace push --schedule daily");
    expect((await readdir(join(destination, "node_modules"))).includes("ai-spend-agent")).toBe(true);
  }, 20_000); // Copies the installed dependency graph and starts Node; allow parallel-suite disk contention.
});

describe("scheduled upload authority", () => {
  const loaded = () => ({ calls: [{ agent: "codex" as const, sessionId: "secret-session", callId: "one", model: "gpt-5", timestamp: "2026-11-07T10:00:00.000Z", startedAt: "2026-11-07T10:00:00.000Z", usageScope: "turn" as const, workingDirectory: "/private/repo", project: "repo", usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 } }], records: [], diagnostics: [], sourceScans: [], filesParsed: 1, agentsDetected: ["codex" as const] });
  it("offers the first push after pairing and preserves both the read choice and exact-batch approval", async () => {
    vi.spyOn(workspace, "finishWorkspaceEnrollment").mockResolvedValue({ state: "connected" });
    for (const answers of [["n"], ["y", "n"], ["y", "y"]]) {
      const { home } = await machine(), responses = [...answers], prompts: string[] = [];
      const load = vi.fn(async () => loaded());
      const transport = vi.fn(async (_path: string, body: string) => {
        const envelope = JSON.parse(body);
        return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash, factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: now } };
      });
      const result = await runCli(["workspace", "connect", "synthetic-response"], { homeDirectory: home, interactive: true, workspaceNow: now,
        consentRead: async prompt => { prompts.push(prompt); return responses.shift(); }, workspaceLoadCalls: load, workspaceTransport: transport });
      expect(result.exitCode).toBe(0);
      expect(prompts[0]).toContain("last 30 closed UTC days");
      expect(load).toHaveBeenCalledTimes(answers[0] === "y" ? 1 : 0);
      expect(transport).toHaveBeenCalledTimes(answers[1] === "y" ? 1 : 0);
      if (answers[0] === "y") expect(prompts[1]).toContain("Exact outgoing local facts");
    }
  });
  it("sends one bounded batch only under saved consent, and stops on uncertain replay", async () => {
    const { home } = await machine(); await install(home);
    const transport = vi.fn(async () => { throw Error("network loss"); });
    const load = vi.fn(async () => loaded());
    const result = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: transport });
    expect(result.exitCode).toBe(1); expect(transport).toHaveBeenCalledTimes(1); expect(result.stderr).toContain("unknown");
    const loadAgain = vi.fn();
    const retained = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: loadAgain, workspaceTransport: transport });
    expect(retained.stderr).toContain("retained batch"); expect(loadAgain).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
    expect(result.stdout + result.stderr).not.toContain("secret-session");
  });
  it("does not read local facts after connection expiry or send after consent is removed during the scan", async () => {
    const { home, state, save } = await machine(); await install(home);
    const noRead = vi.fn(), transport = vi.fn();
    const expired = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: "2028-11-08T00:00:00.000Z", workspaceLoadCalls: noRead });
    expect(expired.stderr).toContain("connection ended"); expect(noRead).not.toHaveBeenCalled();
    const changed = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceTransport: transport, workspaceLoadCalls: async () => { state.device.grantRevision = "2"; await save(); return loaded(); } });
    expect(changed.stderr).toContain("consent changed"); expect(transport).not.toHaveBeenCalled();
  });
  it("accepts harmless trailing global flags without silently treating sample mode as a real push", async () => {
    const { home } = await machine();
    for (const action of ["status", "push", "disconnect"]) {
      const result = await runCli(["workspace", action, "--no-color", "--no-open"], { homeDirectory: home });
      expect(result.stderr).not.toContain("Invalid arguments");
    }
    const load = vi.fn();
    expect((await runCli(["workspace", "push", "--sample"], { homeDirectory: home, interactive: true, consentRead: async () => "y", workspaceLoadCalls: load })).stderr).toContain("Invalid arguments");
    expect(load).not.toHaveBeenCalled();
  });
});
