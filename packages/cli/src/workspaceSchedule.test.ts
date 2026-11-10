import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import * as workspace from "./workspaceConnect.js";
import { WORKSPACE_ORIGIN, workspaceCanonicalJson, workspaceScheduleBinding, type WorkspaceState } from "./workspaceConnect.js";
import { authorizedWorkspaceSchedule, dailyCron, dailyLaunchAgent, readWorkspaceSchedule, stageWorkspaceRuntime, updateWorkspaceSchedule, workspaceScheduleStatus, type ScheduleCommand } from "./workspaceSchedule.js";

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
  it("quotes paths and cron percent signs; launchd XML escapes special characters; both keep the job's output in a local log", () => {
    const line = dailyCron("", { node: "/node's & bin/node", runner: "/home/user/50% done/run.mjs", log: "/home/user/50% done/daily.log" });
    expect(line).toContain("'\\''"); expect(line).toContain("50\\% done/run.mjs"); expect(line).toContain(">>'/home/user/50\\% done/daily.log' 2>&1");
    expect(line).not.toContain("/dev/null");
    const plist = dailyLaunchAgent({ node: "/x<&\"'/node", runner: "/x/run.mjs", log: "/x/daily.log" });
    expect(plist).toContain("&lt;&amp;&quot;&apos;");
    expect(plist).toContain("<key>StandardErrorPath</key><string>/x/daily.log</string>");
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

describe("a daily sync that can always be removed and never fails quietly", () => {
  const root = (home: string) => join(home, ".aibill", "workspace-sync");
  const none = (home: string, command: ScheduleCommand, platform: NodeJS.Platform = "linux") => updateWorkspaceSchedule({ home, mode: "none", now, includePlanTier: false, platform, command });
  const aged = async (path: string, minutes: number) => { const then = new Date(Date.now() - minutes * 60_000); await utimes(path, then, then); };

  it("takes over a setup lock a dead setup left, names a fresh one, and removal withdraws consent before it meets either", async () => {
    const { home } = await machine(), os = cron();
    await install(home, os.command);
    const lock = join(await realpath(root(home)), "install.lock");
    await mkdir(lock, { mode: 0o700 });
    // A terminal closed mid-setup a moment ago: the lock is named, and consent is gone before the lock is even tried.
    await expect(install(home, os.command)).rejects.toThrow(lock);
    expect(await readWorkspaceSchedule(home)).not.toBeNull();
    await expect(none(home, os.command)).rejects.toThrow(/Standing consent was removed first.*install\.lock/s);
    expect(await readWorkspaceSchedule(home)).toBeNull();
    expect(os.value()).toContain("aibill-workspace-daily-v1");
    // Ten minutes on, both setup and removal go through.
    await aged(lock, 11);
    await install(home, os.command);
    expect(await authorizedWorkspaceSchedule(home)).not.toBeNull();
    await mkdir(lock, { mode: 0o700 }); await aged(lock, 11);
    await none(home, os.command);
    expect(os.value()).toBe("5 1 * * * /usr/bin/true # existing-job\n");
    await expect(lstat(root(home))).rejects.toThrow(); // nothing of daily sync is left
  });

  it.runIf(process.getuid?.() !== 0)("a lock that cannot be created says why, not that another setup is running", async () => {
    const { home } = await machine(), os = cron();
    await install(home, os.command);
    await chmod(root(home), 0o500);
    try {
      const refused = await install(home, os.command).catch((error: Error) => error.message);
      expect(refused).toContain("EACCES"); expect(refused).not.toContain("Another daily-sync setup");
    } finally { await chmod(root(home), 0o700); }
  });

  it("undoes what a failed setup wrote: no launch agent pointing at a deleted runner, no cron line without consent", async () => {
    const mac = await machine();
    const launchctl = vi.fn<ScheduleCommand>(async (_command, args) => ({ code: args[0] === "bootstrap" ? 5 : 0, stdout: "" }));
    await expect(updateWorkspaceSchedule({ home: mac.home, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(mac.home))!, platform: "darwin", command: launchctl, stageRuntime: fakeRuntime }))
      .rejects.toThrow("could not load daily sync");
    await expect(lstat(join(mac.home, "Library", "LaunchAgents", "com.asktilden.workspace-daily.plist"))).rejects.toThrow();
    expect(launchctl.mock.calls.at(-1)?.[1][0]).toBe("bootout");

    // The grant changes while the cron line is being written: the line is taken away again.
    const linux = await machine(), os = cron();
    const changing: ScheduleCommand = async (command, args, input) => {
      const result = await os.command(command, args, input);
      if (args[0] === "-" && input?.includes("aibill-workspace-daily-v1")) { linux.state.device.connectionEpoch = "2"; await linux.save(); }
      return result;
    };
    await expect(install(linux.home, changing)).rejects.toThrow("connection changed during setup");
    expect(os.value()).toBe("5 1 * * * /usr/bin/true # existing-job\n");
    expect(await readWorkspaceSchedule(linux.home)).toBeNull();
    // If even that cannot be done, the message carries the removal command.
    const stuck = await machine(); let writes = 0;
    const once: ScheduleCommand = async (_command, args) => {
      if (args[0] === "-l") return { code: 0, stdout: writes ? "17 9 * * * x # aibill-workspace-daily-v1\n" : "" };
      if (writes++ === 0) { stuck.state.device.connectionEpoch = "2"; await stuck.save(); return { code: 0, stdout: "" }; }
      return { code: 1, stdout: "" };
    };
    await expect(install(stuck.home, once)).rejects.toThrow("npx aibill@latest workspace push --schedule none");
  });

  it("disconnect removes the schedule with the pairing, or prints the exact removal command", async () => {
    const revoked = (state: WorkspaceState) => async () => ({ status: 200, body: { state: "revoked", grantId: state.device.grantId, connectionEpoch: "2", revokedAt: now } });
    const { home, state } = await machine(), os = cron();
    await install(home, os.command);
    const result = await runCli(["workspace", "disconnect"], { homeDirectory: home, interactive: true, workspaceNow: now, consentRead: async () => "y",
      workspaceDisconnectTransport: revoked(state), workspaceScheduleOptions: { platform: "linux", command: os.command } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Local pairing was removed."); expect(result.stdout).toContain("Daily sync removed");
    expect(os.value()).toBe("5 1 * * * /usr/bin/true # existing-job\n");
    await expect(lstat(root(home))).rejects.toThrow();

    const other = await machine(), held = cron();
    await install(other.home, held.command);
    const failing: ScheduleCommand = async (command, args, input) => args[0] === "-" ? { code: 1, stdout: "" } : held.command(command, args, input);
    const kept = await runCli(["workspace", "disconnect"], { homeDirectory: other.home, interactive: true, workspaceNow: now, consentRead: async () => "y",
      workspaceDisconnectTransport: revoked(other.state), workspaceScheduleOptions: { platform: "linux", command: failing } });
    expect(kept.exitCode).toBe(0);
    expect(kept.stdout).toContain("could not be removed with the pairing");
    expect(kept.stdout).toContain("npx aibill@latest workspace push --schedule none");
    expect(await authorizedWorkspaceSchedule(other.home)).toBeNull(); // the pairing its consent was bound to is gone

    // A machine that never set daily sync up: the operating system's schedule is not touched at all.
    const plain = await machine(), untouched = vi.fn<ScheduleCommand>();
    const quiet = await runCli(["workspace", "disconnect"], { homeDirectory: plain.home, interactive: true, workspaceNow: now, consentRead: async () => "y",
      workspaceDisconnectTransport: revoked(plain.state), workspaceScheduleOptions: { platform: "linux", command: untouched } });
    expect(quiet.stdout).toBe("Workspace revoked this machine grant. Local pairing was removed."); expect(untouched).not.toHaveBeenCalled();
  });

  it("status says so when no scheduled run has been recorded for 48 hours, and prints the command that sets it up again", async () => {
    const { home } = await machine();
    await install(home);
    const hours = (count: number) => new Date(Date.parse(now) + count * 3_600_000).toISOString();
    expect(await workspaceScheduleStatus(home, hours(47))).toBe("Daily sync: authorized. No scheduled run recorded yet. Remove with: npx aibill@latest workspace push --schedule none");
    const silent = await workspaceScheduleStatus(home, hours(49));
    expect(silent).toContain("NOT RUNNING"); expect(silent).toContain(`none since setup on ${now}`);
    expect(silent).toContain("Set it up again with: npx aibill@latest workspace push --schedule daily");
    expect(silent).toContain(join(root(home), "daily.log"));
    await writeFile(join(root(home), "last-run.json"), JSON.stringify({ at: hours(48), exitCode: 0 }), { mode: 0o600 });
    expect(await workspaceScheduleStatus(home, hours(72))).toContain(`Last scheduled run: ${hours(48)} · completed.`);
    expect(await workspaceScheduleStatus(home, hours(97))).toContain(`NOT RUNNING as far as this machine can tell: no scheduled run has been recorded for more than 48 hours (last run ${hours(48)})`);
    const shown = await runCli(["workspace", "status"], { homeDirectory: home, workspaceNow: hours(97) });
    expect(shown.stdout).toContain("NOT RUNNING");
  });

  it("the scheduled run reads the home that was paired and previewed, whatever HOME the operating system hands the job", async () => {
    const { home } = await machine(), os = cron();
    const recording = async (path: string) => {
      const entry = join(path, "index.mjs");
      await writeFile(entry, "import { homedir } from 'node:os';\nexport async function runCli(argv, options) { return { exitCode: 0, stdout: JSON.stringify({ argv, read: homedir(), state: options.homeDirectory }), stderr: '' }; }\n");
      return entry;
    };
    await updateWorkspaceSchedule({ home, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(home))!, platform: "linux", command: os.command, stageRuntime: recording });
    const runner = /'([^']+run\.mjs)'/.exec(os.value())![1]!;
    const elsewhere = await mkdtemp(join(tmpdir(), "aibill-other-home-")); homes.push(elsewhere);
    const ran = await promisify(execFile)(process.execPath, [runner], { env: { PATH: process.env.PATH, HOME: elsewhere } });
    expect(ran.stdout).toMatch(/^\S+Z exit 0 /);
    const seen = JSON.parse(ran.stdout.slice(ran.stdout.indexOf("{")));
    expect(seen).toEqual({ argv: ["workspace", "push", "--scheduled"], read: home, state: home });
    expect(JSON.parse(await readFile(join(root(home), "last-run.json"), "utf8")).exitCode).toBe(0);
    // A retained CLI that can no longer start still leaves a line and a result the status can show.
    await rm(join(runner, "..", "index.mjs"));
    const broken = await promisify(execFile)(process.execPath, [runner], { env: { PATH: process.env.PATH, HOME: elsewhere } }).catch(error => error);
    expect(broken.stdout).toContain("exit 2 The retained CLI could not start");
    expect(await workspaceScheduleStatus(home, now)).toContain("the retained CLI could not start; set it up again with: npx aibill@latest workspace push --schedule daily");
  }, 20_000);

  it("refuses on Windows before asking for consent", async () => {
    const { home } = await machine(), asked = vi.fn(async () => "y");
    for (const mode of ["daily", "none"]) {
      const result = await runCli(["workspace", "push", "--schedule", mode], { homeDirectory: home, interactive: true, workspaceNow: now, consentRead: asked, workspaceScheduleOptions: { platform: "win32" } });
      expect(result.exitCode).toBe(1); expect(result.stderr).toContain("Use workspace push manually on Windows");
    }
    expect(asked).not.toHaveBeenCalled();
  });
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
      const waits: number[] = [];
      const result = await runCli(["workspace", "connect", "synthetic-response"], { homeDirectory: home, interactive: true, workspaceNow: now,
        consentRead: async (prompt, wait) => { prompts.push(prompt); waits.push(wait); return responses.shift(); }, workspaceLoadCalls: load, workspaceTransport: transport });
      expect(result.exitCode).toBe(0);
      expect(prompts[0]).toContain("last 30 closed UTC days");
      expect(prompts[0]).toContain("Answer yes only after the browser shows sharing is on");
      expect(waits[0]).toBe(600_000);
      expect(load).toHaveBeenCalledTimes(answers[0] === "y" ? 1 : 0);
      expect(transport).toHaveBeenCalledTimes(answers[1] === "y" ? 1 : 0);
      if (answers[0] === "y") expect(prompts[1]).toContain("Exact outgoing local facts");
    }
  });
  it("a yes given before sharing is on in the browser ends in plain words, no retained batch, and a schedule that can still be enabled", async () => {
    vi.spyOn(workspace, "finishWorkspaceEnrollment").mockResolvedValue({ state: "connected" });
    const { home } = await machine(), os = cron();
    const denied = vi.fn(async () => ({ status: 403, body: { state: "unavailable", retry: "same_envelope_only" } }));
    const runtime = { homeDirectory: home, interactive: true, workspaceNow: now, consentRead: async () => "y", workspaceLoadCalls: async () => loaded(), workspaceScheduleOptions: { platform: "linux" as const, command: os.command, stageRuntime: fakeRuntime } };
    const early = await runCli(["workspace", "connect", "synthetic-response"], { ...runtime, workspaceTransport: denied });
    expect(early.exitCode).toBe(0); expect(early.stderr).toBe("");
    expect(early.stdout).toContain("Paired.");
    expect(early.stdout).toContain("sharing consent is not finished for it in the browser");
    expect(early.stdout).toContain("then run: npx aibill@latest workspace push");
    const state = JSON.parse(await readFile(join(home, ".aibill", "workspace-device.json"), "utf8")) as WorkspaceState;
    expect(state.pending).toBeNull(); expect(state.device.sequence).toBe("1"); expect(state.facts).toEqual({});
    // On its own the same refusal is a failed push, with the same words and still nothing retained.
    const alone = await runCli(["workspace", "push"], { ...runtime, workspaceTransport: denied });
    expect(alone.exitCode).toBe(1); expect(alone.stderr).toContain("sharing consent is not finished");
    expect((await runCli(["workspace", "push", "--schedule", "daily"], runtime)).stdout).toContain("Daily sync installed");
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
