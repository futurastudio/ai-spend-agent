/** Opt-in macOS scheduler. Each invocation sends at most one existing signed batch. */
import { constants } from "node:fs";
import { open, lstat, realpath, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadLocalAgentFinancialUsage } from "@agent-finops/core";
import { workspaceClock } from "./lib/clock.js";
import { atomicPrivateJson, withState, workspaceDomainHash, prepareWorkspacePushLocked,
  sendWorkspacePendingLocked, type WorkspaceState, type WorkspaceTransport } from "./workspaceConnect.js";

const FILE = "workspace-sync.json", LABEL = "com.asktilden.workspace-sync", INTERVAL = 3600;
const exec = promisify(execFile);
type SyncState = { version: 1; enabled: boolean; binding: string; runtime: string; runtimeHash: string; node: string;
  lastRun: string | null; outcome: "enabled" | "disabled" | "running" | "unchanged" | "accepted" | "paused";
  acceptedFacts: number | null };
export type WorkspaceSyncScheduler = {
  install: (home: string, node: string, runtime: string) => Promise<void>;
  remove: (home: string) => Promise<void>;
};
export type WorkspaceSyncOptions = { home?: string; now?: string; platform?: string;
  scheduler?: WorkspaceSyncScheduler; runtimePath?: string; nodePath?: string;
  load?: () => Promise<Awaited<ReturnType<typeof loadLocalAgentFinancialUsage>>>;
  transport?: WorkspaceTransport; confirm?: (message: string) => Promise<boolean> };
const binding = (state: WorkspaceState) => workspaceDomainHash("tilden:workspace-sync-consent:v1", {
  origin: state.device.origin, grant: state.device.grantId, revision: state.device.grantRevision,
  key: state.device.keyId, epoch: state.device.connectionEpoch, from: state.device.collectionNotBefore,
  authority: state.device.authorityStartsAt, until: state.device.expiresAt,
});
async function readSync(path: string): Promise<SyncState | null> {
  let file;
  try { file = await open(join(path, FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 8192 || process.getuid && stat.uid !== process.getuid()) throw Error("Unsafe sync state");
    const value = JSON.parse(await file.readFile("utf8")) as SyncState;
    if (Object.keys(value).sort().join() !== ["version", "enabled", "binding", "runtime", "runtimeHash", "node", "lastRun", "outcome", "acceptedFacts"].sort().join()
      || value.version !== 1 || typeof value.enabled !== "boolean" || !/^sha256_[a-f0-9]{64}$/.test(value.binding)
      || typeof value.runtime !== "string" || !value.runtime.startsWith("/") || typeof value.node !== "string" || !value.node.startsWith("/")
      || !/^[a-f0-9]{64}$/.test(value.runtimeHash)
      || value.lastRun !== null && !Number.isFinite(Date.parse(value.lastRun))
      || !["enabled", "disabled", "running", "unchanged", "accepted", "paused"].includes(value.outcome)
      || value.acceptedFacts !== null && (!Number.isSafeInteger(value.acceptedFacts) || value.acceptedFacts < 0 || value.acceptedFacts > 256)) throw Error("Invalid sync state");
    return value;
  } finally { await file.close(); }
}
const saveSync = (path: string, state: SyncState) => atomicPrivateJson(path, FILE, state);
async function runtimeHash(runtime: string): Promise<string> {
  const hash = createHash("sha256"), extension = extname(runtime);
  const core = dirname(createRequire(import.meta.url).resolve("@agent-finops/core"));
  const paths = ["index", "workspaceConnect", "workspaceSync"].map(name => join(dirname(runtime), name + extension));
  paths.push(join(dirname(runtime), "../package.json"), join(core, "localAgentLogs.js"), join(core, "../package.json"));
  for (const path of paths) {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error("Upload runtime unavailable");
      hash.update(path); hash.update(await file.readFile());
    } finally { await file.close(); }
  }
  return hash.digest("hex");
}
async function runtimeAvailable(sync: Pick<SyncState, "node" | "runtime">): Promise<boolean> {
  try {
    return (await lstat(sync.node)).isFile() && (await lstat(sync.runtime)).isFile()
      && await realpath(sync.node) === sync.node && await realpath(sync.runtime) === sync.runtime;
  } catch { return false; }
}
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function plist(node: string, runtime: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${[node, runtime, "workspace", "sync", "run"].map(value => `<string>${xml(value)}</string>`).join("")}</array><key>StartInterval</key><integer>${INTERVAL}</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}
async function agentPath(home: string): Promise<string> {
  const base = await realpath(resolve(home));
  for (const part of ["Library", "Library/LaunchAgents"]) {
    const path = join(base, part); await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 || process.getuid && stat.uid !== process.getuid()) throw Error("Unsafe LaunchAgents directory");
  }
  return join(base, "Library/LaunchAgents", `${LABEL}.plist`);
}
async function ownedPlist(path: string): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384 || process.getuid && stat.uid !== process.getuid()) throw Error("Unsafe scheduler file");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
/** No shell, package download, or provider access. The installed CLI path is pinned. */
export const workspaceSyncScheduler: WorkspaceSyncScheduler = {
  async install(home, node, runtime) {
    const path = await agentPath(home), content = plist(node, runtime), previous = await ownedPlist(path);
    if (previous !== null && previous !== content) throw Error("An existing scheduler file differs; disable it before updating");
    if (previous === null) {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    }
    await exec("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, path], { timeout: 10000, env: { PATH: "/usr/bin:/bin" } });
  },
  async remove(home) {
    const base = await realpath(resolve(home)), privatePath = join(base, ".aibill"), sync = await readSync(privatePath);
    const path = await agentPath(home), content = await ownedPlist(path);
    if (content !== null && (!sync || content !== plist(sync.node, sync.runtime))) throw Error("Scheduler ownership changed; automatic consent is disabled but file was preserved");
    try { await exec("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`], { timeout: 10000, env: { PATH: "/usr/bin:/bin" } }); }
    catch (error) { if (![3, 113].includes(Number((error as { code?: unknown }).code))) throw error; }
    if (content !== null) await unlink(path);
  },
};

export async function workspaceSync(action: string, options: WorkspaceSyncOptions = {}): Promise<string> {
  const home = options.home ?? homedir(), now = options.now ?? workspaceClock.now();
  if (!Number.isFinite(Date.parse(now))) throw Error("Invalid sync clock");
  if (!["enable", "disable", "status", "run"].includes(action)) throw Error("Use workspace sync enable, status or disable");
  if ((options.platform ?? process.platform) !== "darwin") return "Automatic Workspace uploads currently support macOS only. Use workspace push for a reviewed manual upload.";
  const scheduler = options.scheduler ?? workspaceSyncScheduler;
  return withState(home, async (state, save, path) => {
    let sync = await readSync(path);
    if (action === "disable") {
      if (!sync) return "Automatic uploads are already off.";
      if (sync) { sync = { ...sync, enabled: false, outcome: "disabled" }; await saveSync(path, sync); }
      await scheduler.remove(home);
      return "Automatic uploads disabled. Pairing and previously accepted activity are unchanged.";
    }
    const eligible = !!state && !state.disconnect && !state.pending && Date.parse(state.device.expiresAt) > Date.parse(now);
    const bound = eligible && sync?.binding === binding(state!);
    if (action === "status") {
      if (!sync) return "Automatic uploads are off. No local logs or network were read.";
      if (sync.enabled && (!await runtimeAvailable(sync) || await runtimeHash(sync.runtime).catch(() => null) !== sync.runtimeHash)) return "Automatic uploads paused: the pinned CLI runtime is missing or changed. Run workspace sync disable, then workspace sync enable from an installed CLI. No local logs or network were read.";
      return `Automatic upload permission: ${sync.enabled && bound ? "enabled for hourly checks while logged in" : sync.enabled ? "paused: pairing, expiry or pending upload needs attention" : sync.outcome === "paused" ? "paused: disable sync, review workspace status and recover manually before enabling again" : "disabled"}. Last check: ${sync.lastRun ?? "not run yet"}. Last result: ${sync.outcome}${sync.acceptedFacts === null ? "" : ` (${sync.acceptedFacts} local fact groups accepted)`}. Status reads local state only; it does not confirm the scheduler is running or the server grant is still active.`;
    }
    if (action === "run" && (!sync?.enabled || !bound)) {
      if (sync?.enabled) await saveSync(path, { ...sync, enabled: false, outcome: "paused" });
      return "Automatic uploads are off or paused. No local logs were read.";
    }
    if (action === "run" && (!await runtimeAvailable(sync!)
      || await runtimeHash(sync!.runtime).catch(() => null) !== sync!.runtimeHash
      || sync!.runtime !== (options.runtimePath ?? await realpath(join(dirname(fileURLToPath(import.meta.url)), "index.js")))
      || sync!.node !== (options.nodePath ?? await realpath(process.execPath)))) {
      await saveSync(path, { ...sync!, enabled: false, outcome: "paused" });
      return "Automatic uploads paused: use the reviewed installed runtime or explicitly enable again. No local logs were read.";
    }
    if (!eligible) throw Error("Connect this machine and resolve any pending upload or disconnect before enabling automatic uploads");
    if (action === "enable") {
      if (sync?.enabled && bound) return "Automatic uploads are already enabled. Use workspace sync status to check the latest result.";
      const node = options.nodePath ?? await realpath(process.execPath);
      const runtime = options.runtimePath ?? await realpath(join(dirname(fileURLToPath(import.meta.url)), "index.js"));
      if (!await runtimeAvailable({ node, runtime })) throw Error("The installed runtime is unavailable");
      if (!await options.confirm?.(`Enable hourly uploads of Claude Code and Codex local summaries to ${state!.device.origin} until ${state!.device.expiresAt}? The approved repository scope and collection start ${state!.device.collectionNotBefore} remain unchanged. Each run reads the latest 30 days, excludes today's unfinished UTC day, and sends at most 256 changed fact groups. Uploads contain repository names, hashed references, sessions and tokens, never prompts, transcripts, raw paths or billed amounts. This continues while you are logged in, without a prompt each time. Review the first payload next. [y/N]`)) return "Automatic uploads were not enabled.";
      sync = { version: 1, enabled: false, binding: binding(state!), runtime, runtimeHash: await runtimeHash(runtime), node, lastRun: null, outcome: "enabled", acceptedFacts: null };
    }
    if (action === "run" && sync!.lastRun !== null && Date.parse(now) - Date.parse(sync!.lastRun) < INTERVAL * 1000) return "The next hourly check is not due.";
    const original = sync!;
    try {
      const loaded = await (options.load ?? (() => loadLocalAgentFinancialUsage({ workspaceDailyFacts: true,
        sinceIso: workspaceClock.daysBefore(now, 30), untilIso: `${now.slice(0, 10)}T00:00:00.000Z` })))();
      if (loaded.diagnostics.some(item => item.code !== "directory_missing" && !(item.code === "unsupported_token_shape" && item.workspaceFactCoverage === "unknown_tokens"))) throw Error("Local source coverage incomplete");
      let current = state!;
      const saveCurrent = async (next: WorkspaceState) => { await save(next); current = next; };
      const prepared = await prepareWorkspacePushLocked(current, saveCurrent, { calls: loaded.calls, generatedAt: now,
        confirm: payload => action === "enable" ? options.confirm?.(`Exact first outgoing summary batch (no prompts, raw paths, session IDs or billed amounts):\n${payload}\nEnable recurring uploads with this reviewed summary scope? [y/N]`) ?? Promise.resolve(false) : Promise.resolve(true) });
      if (prepared.state === "cancelled") return "Automatic uploads were not enabled. No facts were sent.";
      if (!["prepared", "unchanged"].includes(prepared.state)) throw Error("Pending upload requires manual recovery");
      await saveSync(path, { ...original, enabled: false, lastRun: now, outcome: "running" });
      const result = prepared.state === "unchanged" ? { state: "unchanged" as const } : await sendWorkspacePendingLocked(current, saveCurrent, options.transport);
      if (result.state !== "accepted" && result.state !== "unchanged") throw Error("Upload outcome requires manual recovery");
      if (action === "enable") await scheduler.install(home, original.node, original.runtime);
      await saveSync(path, { ...original, enabled: true, lastRun: now, outcome: result.state, acceptedFacts: result.state === "accepted" ? result.factCount ?? null : null });
      return `Automatic uploads ${action === "enable" ? "enabled hourly while logged in" : "checked"}. ${result.state === "accepted" ? `${result.factCount} local fact groups accepted.` : "No changed eligible facts."} Today appears after its UTC day closes. Use workspace sync status or workspace sync disable.`;
    } catch {
      await saveSync(path, { ...original, enabled: false, lastRun: now, outcome: "paused" });
      return "Automatic uploads paused. No automatic retry will occur. Run workspace sync disable, then workspace status to inspect pairing and any retained batch; complete manual recovery before enabling again.";
    }
  });
}
