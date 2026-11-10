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
import { authorizedWorkspaceSchedule, dailyCron, dailyLaunchAgent, readWorkspaceSchedule, stageWorkspaceRuntime, updateWorkspaceSchedule, workspaceScheduleStatus, type ScheduleCommand, type WorkspaceScheduleOptions } from "./workspaceSchedule.js";

const homes: string[] = [];
const now = "2026-11-08T12:00:00.000Z";
const ref = (letter: string) => `oref_${letter.repeat(43)}`;
/** A paired machine. Workspace has accepted a push from it, as daily sync requires, unless `accepted` is false. */
async function machine(options: { accepted?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "aibill-schedule-")); homes.push(home);
  await mkdir(join(home, ".aibill"), { mode: 0o700 });
  const state: WorkspaceState = { version: 1, device: { origin: WORKSPACE_ORIGIN, grantId: ref("a"), keyId: ref("b"), grantRevision: "1", connectionEpoch: "1", token: Buffer.alloc(32, 1).toString("base64url"),
    privateKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), sequence: "0", collectionNotBefore: "2026-09-01T00:00:00.000Z", authorityStartsAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" }, facts: {}, pending: null, disconnect: null, lastAcceptedAt: options.accepted === false ? null : "2026-11-07T12:00:00.000Z" };
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
    const { home } = await machine(), os = cron(), on: WorkspaceScheduleOptions = { platform: "linux", command: os.command };
    await install(home, os.command);
    const hours = (count: number) => new Date(Date.parse(now) + count * 3_600_000).toISOString();
    expect(await workspaceScheduleStatus(home, hours(47), on)).toBe("Daily sync: authorized. No scheduled run recorded yet. Remove with: npx aibill@latest workspace push --schedule none");
    const silent = await workspaceScheduleStatus(home, hours(49), on);
    expect(silent).toContain("NOT RUNNING"); expect(silent).toContain(`none since setup on ${now}`);
    expect(silent).toContain("Set it up again with: npx aibill@latest workspace push --schedule daily");
    expect(silent).toContain(join(root(home), "daily.log"));
    await writeFile(join(root(home), "last-run.json"), JSON.stringify({ at: hours(48), exitCode: 0 }), { mode: 0o600 });
    expect(await workspaceScheduleStatus(home, hours(72), on)).toContain(`Last scheduled run: ${hours(48)} · completed.`);
    expect(await workspaceScheduleStatus(home, hours(97), on)).toContain(`NOT RUNNING as far as this machine can tell: no scheduled run has been recorded for more than 48 hours (last run ${hours(48)})`);
    const shown = await runCli(["workspace", "status"], { homeDirectory: home, workspaceNow: hours(97), workspaceScheduleOptions: on });
    expect(shown.stdout).toContain("NOT RUNNING");
  });

  it("status reports what is installed, not only what is consented: a job without consent, and consent without a job", async () => {
    const { home } = await machine(), os = cron(), on: WorkspaceScheduleOptions = { platform: "linux", command: os.command };
    await install(home, os.command);
    // A second setup that cannot write the crontab: consent is gone, and the first setup's line is still there.
    await expect(install(home, async (command, args, input) => args[0] === "-" ? { code: 2, stdout: "" } : os.command(command, args, input))).rejects.toThrow("could not be installed");
    const jobOnly = await workspaceScheduleStatus(home, now, on);
    expect(jobOnly).toContain("Daily sync: OFF, but its scheduled job is STILL INSTALLED");
    expect(jobOnly).toContain("remove the job with: npx aibill@latest workspace push --schedule none");
    // The line removed by hand in the crontab, under a consent that still stands.
    await install(home, os.command);
    await os.command("crontab", ["-"], "5 1 * * * /usr/bin/true # existing-job\n");
    const consentOnly = await workspaceScheduleStatus(home, now, on);
    expect(consentOnly).toContain("authorized, but its scheduled job is NOT INSTALLED");
    expect(consentOnly).toContain("Set it up again with: npx aibill@latest workspace push --schedule daily");
    // Another home's job in the same crontab is not this home's.
    const other = await machine();
    await install(home, os.command);
    expect(await workspaceScheduleStatus(other.home, now, on)).toBe("Daily sync: off.");
    // The launch agent file is what macOS has.
    const mac = await machine(), launchctl: ScheduleCommand = async () => ({ code: 0, stdout: "" });
    await updateWorkspaceSchedule({ home: mac.home, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(mac.home))!, platform: "darwin", command: launchctl, stageRuntime: fakeRuntime });
    await rm(join(root(mac.home), "consent.json"));
    expect(await workspaceScheduleStatus(mac.home, now, { platform: "darwin", command: launchctl })).toContain("STILL INSTALLED");
  });

  it("removal works whatever the directory modes are, and names the directory when setup cannot use it", async () => {
    // [mode of ~/.aibill, mode of its workspace-sync]: opened to others by a restore or a recursive chmod, or made read-only.
    for (const [outer, inner] of [[0o700, 0o755], [0o755, 0o755], [0o700, 0o500]] as const) {
      const { home } = await machine(), os = cron(), on: WorkspaceScheduleOptions = { platform: "linux", command: os.command };
      await install(home, os.command);
      await chmod(root(home), inner); await chmod(join(home, ".aibill"), outer);
      try {
        // Consent in a directory others can open is not honored, so status would say off: it says the job is there.
        if (inner === 0o755) expect(await workspaceScheduleStatus(home, now, on)).toContain("STILL INSTALLED");
        if (outer === 0o700 && inner === 0o755) {
          const refused = await install(home, os.command).catch((error: Error) => error.message);
          expect(refused).toContain(await realpath(root(home))); expect(refused).toContain("chmod 700");
        }
        const removed = await none(home, os.command);
        expect(removed).toContain("Daily sync removed");
        expect(os.value()).toBe("5 1 * * * /usr/bin/true # existing-job\n");
        expect(await workspaceScheduleStatus(home, now, on)).toBe("Daily sync: off.");
        await expect(lstat(root(home))).rejects.toThrow(); // read-only or open to others, nothing of daily sync is left
      } finally { await chmod(root(home), 0o700).catch(() => {}); await chmod(join(home, ".aibill"), 0o700); }
    }
  });

  it("keeps every other crontab byte: a line that is not UTF-8 and a missing final newline survive install and remove", async () => {
    const { home } = await machine();
    // Latin-1 bytes for "café" (0xE9 alone is not valid UTF-8), a CRLF line, and no newline at the end.
    const before = Buffer.concat([Buffer.from("MAILTO=\"\"\r\n5 1 * * * /usr/bin/true # caf"), Buffer.from([0xe9]), Buffer.from("\n9 9 * * * /usr/bin/false")]);
    let table = before.toString("latin1");
    const command: ScheduleCommand = async (_command, args, input) => { if (args[0] === "-l") return { code: 0, stdout: table }; table = input!; return { code: 0, stdout: "" }; };
    await install(home, command); await install(home, command);
    const installed = Buffer.from(table, "latin1");
    expect(installed.subarray(installed.length - before.length).equals(before)).toBe(true); // the person's bytes, untouched, after one line of ours
    expect(installed.subarray(0, installed.length - before.length).toString("utf8")).toMatch(/^17 9 \* \* \* '.+' '.+run\.mjs' >>'.+daily\.log' 2>&1 # aibill-workspace-daily-v1\n$/);
    await none(home, command);
    expect(Buffer.from(table, "latin1").equals(before)).toBe(true);
    // Our own line is UTF-8 bytes even when a path is not ASCII.
    const line = Buffer.from(dailyCron("", { node: "/opt/n\u00f8de/bin/node", runner: "/srv/z\u00e9/run.mjs", log: "/srv/z\u00e9/daily.log" }), "latin1").toString("utf8");
    expect(line).toContain("/opt/n\u00f8de/bin/node"); expect(line).toContain("/srv/z\u00e9/run.mjs");
  });

  it("asks nothing where it cannot install: no crontab command, a pairing with no accepted push, a path with a control character", async () => {
    const asked = vi.fn(async () => "y");
    const absent: ScheduleCommand = async () => { throw Object.assign(Error("spawn crontab ENOENT"), { code: "ENOENT" }); };
    const bare = await machine();
    const noCron = await runCli(["workspace", "push", "--schedule", "daily"], { homeDirectory: bare.home, interactive: true, workspaceNow: now, consentRead: asked, workspaceScheduleOptions: { platform: "linux", command: absent } });
    expect(noCron.exitCode).toBe(1); expect(noCron.stderr).toContain("no crontab command");
    // Removal still succeeds there: nothing can be in a crontab that does not exist.
    expect(await none(bare.home, absent)).toContain("Daily sync removed");
    const fresh = await machine({ accepted: false }), os = cron();
    const early = await runCli(["workspace", "push", "--schedule", "daily"], { homeDirectory: fresh.home, interactive: true, workspaceNow: now, consentRead: asked, workspaceScheduleOptions: { platform: "linux", command: os.command } });
    expect(early.exitCode).toBe(1); expect(early.stderr).toContain("once Workspace has accepted a push from this machine");
    expect(asked).not.toHaveBeenCalled(); expect(os.command.mock.calls.map(call => call[1][0])).toEqual(["-l"]); // read once, nothing written
    // The home is reached through a clean name, but the directory the cron line is built from has a newline in its name.
    const parent = await mkdtemp(join(tmpdir(), "aibill-schedule-")); homes.push(parent);
    const real = join(parent, "bad\nname"), link = join(parent, "home");
    await mkdir(join(real, ".aibill"), { recursive: true, mode: 0o700 }); await symlink(real, link);
    await writeFile(join(real, ".aibill", "workspace-device.json"), await readFile(join(bare.home, ".aibill", "workspace-device.json")), { mode: 0o600 });
    const untouched = cron();
    await expect(updateWorkspaceSchedule({ home: link, mode: "daily", now, includePlanTier: false, binding: (await workspaceScheduleBinding(link))!, platform: "linux", command: untouched.command, stageRuntime: fakeRuntime }))
      .rejects.toThrow("control characters");
    expect(untouched.command).not.toHaveBeenCalled();
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
    const log = join(root(home), "daily.log"), start = () => promisify(execFile)(process.execPath, [runner], { env: { PATH: process.env.PATH, HOME: elsewhere } }).catch(error => error);
    await start();
    const first = await readFile(log, "utf8");
    expect(first).toMatch(/^\S+Z exit 0 .+\n$/);
    expect(JSON.parse(first.slice(first.indexOf("{")))).toEqual({ argv: ["workspace", "push", "--scheduled"], read: home, state: home });
    expect(JSON.parse(await readFile(join(root(home), "last-run.json"), "utf8")).exitCode).toBe(0);
    // Years of lines stay small: past its bound the log keeps its newest part, cut at a line.
    await writeFile(log, `${"x".repeat(199)}\n`.repeat(1500));
    await start();
    const trimmed = await readFile(log, "utf8");
    expect(trimmed.length).toBeLessThan(70_000); expect(trimmed.startsWith("xxx")).toBe(true); expect(trimmed).toMatch(/\n\S+Z exit 0 .+\n$/);
    // A retained CLI that can no longer start still leaves a line and a result the status can show.
    await rm(join(runner, "..", "index.mjs"));
    await start();
    expect(await readFile(log, "utf8")).toContain("exit 2 The retained CLI could not start");
    expect(await workspaceScheduleStatus(home, now, { platform: "linux", command: os.command })).toContain("the retained CLI could not start; set it up again with: npx aibill@latest workspace push --schedule daily");
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
  const accepting = async (_path: string, body: string, _token?: string) => {
    const envelope = JSON.parse(body);
    return { status: 200, body: { state: "accepted", batchId: envelope.batchId, manifestHash: envelope.manifestHash, factCount: envelope.facts.length, introduced: envelope.facts.length, replaced: 0, unchanged: 0, acceptedAt: now } };
  };
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
  it("a yes given before sharing is on in the browser ends in plain words, no retained batch, and a schedule that waits for the first accepted push", async () => {
    vi.spyOn(workspace, "finishWorkspaceEnrollment").mockResolvedValue({ state: "connected" });
    const { home } = await machine({ accepted: false }), os = cron();
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
    // No batch blocks the schedule, but a pairing with no accepted push cannot have one yet: the push comes first.
    expect((await runCli(["workspace", "push", "--schedule", "daily"], runtime)).stderr).toContain("once Workspace has accepted a push from this machine");
    expect((await runCli(["workspace", "push"], { ...runtime, workspaceTransport: accepting })).stdout).toContain("Workspace accepted 1 local session facts");
    expect((await runCli(["workspace", "push", "--schedule", "daily"], runtime)).stdout).toContain("Daily sync installed");
  });
  it("a scheduled run Workspace refuses withdraws its own consent, logs how to turn it on again, and the next run sends nothing", async () => {
    const { home } = await machine(), os = cron(), on = { platform: "linux" as const, command: os.command };
    await install(home, os.command);
    const denied = vi.fn(async () => ({ status: 403, body: { state: "unavailable", retry: "same_envelope_only" } }));
    const refused = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: async () => loaded(), workspaceTransport: denied });
    expect(refused.exitCode).toBe(1); expect(denied).toHaveBeenCalledTimes(1);
    expect(refused.stderr).toContain("Daily sync turned itself off");
    expect(refused.stderr).toContain("turn daily sync back on with: npx aibill@latest workspace push --schedule daily");
    expect(await readWorkspaceSchedule(home)).toBeNull();
    // The job still fires every day; it reads nothing and sends nothing.
    const load = vi.fn(async () => loaded());
    const next = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: denied });
    expect(next.exitCode).toBe(1); expect(next.stderr).toContain("not authorized");
    expect(load).not.toHaveBeenCalled(); expect(denied).toHaveBeenCalledTimes(1);
    expect((await runCli(["workspace", "status"], { homeDirectory: home, workspaceNow: now, workspaceScheduleOptions: on })).stdout).toContain("Daily sync: OFF, but its scheduled job is STILL INSTALLED");
    // The same on the resend of a batch it had retained: that batch stays for a terminal, and the schedule is off.
    const again = await machine(); await install(again.home, os.command);
    const lost = vi.fn(async () => { throw Error("network loss"); });
    await runCli(["workspace", "push", "--scheduled"], { homeDirectory: again.home, workspaceNow: now, workspaceLoadCalls: async () => loaded(), workspaceTransport: lost });
    const resend = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: again.home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: denied });
    expect(resend.stderr).toContain("Daily sync turned itself off"); expect(await readWorkspaceSchedule(again.home)).toBeNull();
  });
  it("a scheduled run whose answer is lost sends that identical batch again on the next run, then goes on; a batch a person retained is left to them", async () => {
    const { home } = await machine(); await install(home);
    const sent: string[] = [];
    const lost = vi.fn(async (_path: string, body: string) => { sent.push(body); throw Error("network loss"); });
    const load = vi.fn(async () => loaded());
    const result = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: lost });
    expect(result.exitCode).toBe(1); expect(lost).toHaveBeenCalledTimes(1); expect(result.stderr).toContain("unknown");
    expect(result.stdout + result.stderr).not.toContain("secret-session");
    // The next run (no network yet after a wake, say) sends the same bytes and reads nothing new.
    const noRead = vi.fn();
    const retried = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: noRead, workspaceTransport: lost });
    expect(retried.exitCode).toBe(1); expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]); expect(noRead).not.toHaveBeenCalled();
    // Once Workspace answers, the retained batch lands as it was signed and the same run goes on to read today's facts.
    const through = vi.fn(accepting);
    const landed = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: through });
    expect(landed.exitCode).toBe(0); expect(through).toHaveBeenCalledTimes(1); expect(through.mock.calls[0]![1]).toBe(sent[0]);
    expect(landed.stdout).toContain("Workspace accepted the batch an earlier scheduled run had retained (1 local session facts).");
    expect(landed.stdout).toContain("No changed eligible local session facts to push."); expect(load).toHaveBeenCalledTimes(2);
    expect((JSON.parse(await readFile(join(home, ".aibill", "workspace-device.json"), "utf8")) as WorkspaceState).pending).toBeNull();

    // A retained batch Workspace never held is refused as out of date a day later: dropped, and its facts go in a new batch.
    const late = await machine(); await install(late.home);
    await runCli(["workspace", "push", "--scheduled"], { homeDirectory: late.home, workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: lost });
    const replies = [{ status: 409, body: { state: "refused", reason: "expired" } }];
    const tomorrow = "2026-11-09T12:00:00.000Z", bodies: string[] = [];
    const rebuilt = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: late.home, workspaceNow: tomorrow, workspaceLoadCalls: load,
      workspaceTransport: async (path, body, token) => { bodies.push(body); return replies.shift() ?? accepting(path, body, token); } });
    expect(rebuilt.exitCode).toBe(0); expect(bodies).toHaveLength(2); expect(JSON.parse(bodies[1]!).batchId).not.toBe(JSON.parse(bodies[0]!).batchId);
    expect(rebuilt.stdout).toContain("Workspace accepted 1 local session facts");

    // A batch a person approved in a terminal and then lost is theirs: a scheduled run does not send it for them.
    const mine = await machine(); await install(mine.home);
    await runCli(["workspace", "push"], { homeDirectory: mine.home, interactive: true, consentRead: async () => "y", workspaceNow: now, workspaceLoadCalls: load, workspaceTransport: lost });
    const calls = lost.mock.calls.length;
    const left = await runCli(["workspace", "push", "--scheduled"], { homeDirectory: mine.home, workspaceNow: now, workspaceLoadCalls: noRead, workspaceTransport: lost });
    expect(left.exitCode).toBe(1); expect(left.stderr).toContain("a retained batch that no scheduled run sent");
    expect(lost.mock.calls.length).toBe(calls); expect(noRead).not.toHaveBeenCalled();
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
