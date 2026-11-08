/** Explicit, grant-bound standing consent for daily Workspace uploads. No credentials in OS jobs. */
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspaceScheduleBinding } from "./workspaceConnect.js";

const LABEL = "com.asktilden.workspace-daily";
const MARKER = "# aibill-workspace-daily-v1";
const REMOVE = "npx aibill@latest workspace push --schedule none";
export type ScheduleConsent = { version: 1; binding: string; includePlanTier: boolean; installedAt: string };
export type ScheduleCommand = (command: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type WorkspaceScheduleOptions = { platform?: NodeJS.Platform; command?: ScheduleCommand; stageRuntime?: (destination: string) => Promise<string>; nodePath?: string };
export class WorkspaceScheduleError extends Error {}
const noFollow = constants.O_NOFOLLOW ?? 0;
const execute: ScheduleCommand = (command, args, input) => new Promise((done, reject) => {
  const child = execFile(command, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
    if (error && !("code" in error && typeof error.code === "number")) reject(new WorkspaceScheduleError("The operating system could not update daily sync. Nothing new was authorized."));
    else done({ code: error ? Number(error.code) : 0, stdout, stderr });
  });
  child.stdin?.on("error", () => {}); // The exit/spawn result above owns reporting, including an early closed pipe.
  if (input !== undefined) child.stdin?.end(input);
});
async function privateDir(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
    throw new WorkspaceScheduleError("Daily sync needs a private local directory; no schedule was changed.");
}
async function rootFor(home: string): Promise<string> {
  const base = join(await realpath(resolve(home)), ".aibill");
  await privateDir(base);
  const root = join(base, "workspace-sync");
  await privateDir(root);
  return root;
}
async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 4096 || process.getuid && info.uid !== process.getuid()) throw Error("Invalid schedule state");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
export async function readWorkspaceSchedule(home = homedir()): Promise<ScheduleConsent | null> {
  try {
    const base = join(await realpath(resolve(home)), ".aibill");
    for (const path of [base, join(base, "workspace-sync")]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) return null;
    }
    const value = await readPrivateJson(join(base, "workspace-sync", "consent.json")) as ScheduleConsent;
    return value && Object.keys(value).sort().join(",") === "binding,includePlanTier,installedAt,version" && value.version === 1
      && /^sha256_[a-f0-9]{64}$/.test(value.binding) && typeof value.includePlanTier === "boolean" && Number.isFinite(Date.parse(value.installedAt)) ? value : null;
  } catch { return null; }
}
export async function authorizedWorkspaceSchedule(home = homedir()): Promise<ScheduleConsent | null> {
  const saved = await readWorkspaceSchedule(home);
  if (!saved) return null;
  return saved.binding === await workspaceScheduleBinding(home) ? saved : null;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export function dailyCron(existing: string, node: string, runner: string, remove = false): string {
  const lines = existing.split("\n").filter(line => !line.endsWith(` ${MARKER}`));
  while (lines.at(-1) === "") lines.pop();
  if (!remove) lines.push(`17 9 * * * ${[node, runner].map(quote).join(" ").replaceAll("%", "\\%")} >/dev/null 2>&1 ${MARKER}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
export function dailyLaunchAgent(node: string, runner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer></dict><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}
/** Copy the exact installed code and dependency closure, so an npx cache eviction cannot break tomorrow's job. */
export async function stageWorkspaceRuntime(destination: string): Promise<string> {
  const copied = new Map<string, string>();
  const packageRoot = async (entry: string, name: string): Promise<string> => {
    for (let path = dirname(await realpath(entry)); dirname(path) !== path; path = dirname(path)) {
      try { if (JSON.parse(await readFile(join(path, "package.json"), "utf8")).name === name) return path; } catch {}
    }
    throw new WorkspaceScheduleError("The installed CLI runtime could not be retained. No schedule was authorized.");
  };
  const copyPackage = async (source: string): Promise<void> => {
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (copied.has(manifest.name)) {
      if (copied.get(manifest.name) !== source) throw new WorkspaceScheduleError("The installed dependency layout cannot be retained safely. No schedule was authorized.");
      return;
    }
    copied.set(manifest.name, source);
    const target = join(destination, "node_modules", manifest.name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const allowed = ["ai-spend-agent", "@agent-finops/core", "@agent-finops/report"].includes(manifest.name) && Array.isArray(manifest.files) ? new Set(["package.json", ...manifest.files.filter((item: string) => !item.startsWith("!")).map((item: string) => item.split("/")[0])]) : null;
    for (const item of await readdir(source)) {
      if (item.startsWith(".") || item === "node_modules" || allowed && !allowed.has(item)) continue;
      await cp(join(source, item), join(target, item), { recursive: true, dereference: true, filter: path => !/\.test\.[^/]+$|\.(map|tsbuildinfo)$/.test(path) });
    }
    const require = createRequire(join(source, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) await copyPackage(await packageRoot(require.resolve(name), name));
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      let entry: string;
      try { entry = require.resolve(name); } catch { continue; }
      await copyPackage(await packageRoot(entry, name));
    }
  };
  await copyPackage(await realpath(join(dirname(fileURLToPath(import.meta.url)), "..")));
  const entry = join(destination, "node_modules", "ai-spend-agent", "dist", "index.js");
  await lstat(entry); // A source-only checkout must build first.
  return entry;
}
export async function updateWorkspaceSchedule(options: { home?: string; mode: "daily" | "none"; now: string; includePlanTier: boolean; binding?: string } & WorkspaceScheduleOptions): Promise<string> {
  const home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  if (platform === "win32") throw new WorkspaceScheduleError("Daily sync currently supports macOS and systems with crontab. Use workspace push manually on Windows.");
  const root = await rootFor(home), lock = join(root, "install.lock"), command = options.command ?? execute;
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new WorkspaceScheduleError("Another daily-sync setup is running. Retry after it finishes."); }
  let stage: string | undefined;
  try {
    // Remove standing consent first. Even a stale loaded OS job now refuses to read local facts.
    await rm(join(root, "consent.json"), { force: true });
    const agentDir = join(home, "Library", "LaunchAgents"), plist = join(agentDir, `${LABEL}.plist`);
    const domain = `gui/${process.getuid?.()}`;
    if (options.mode === "none") {
      if (platform === "darwin") {
        await command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]);
        await rm(plist, { force: true });
      } else {
        const current = await command("crontab", ["-l"]);
        if (current.code !== 0 && !(current.code === 1 && current.stdout === "" && /no crontab for/i.test(current.stderr ?? ""))) throw new WorkspaceScheduleError("Daily sync consent is removed, but crontab could not be read. Remove its aibill-workspace-daily-v1 line manually.");
        if ((await command("crontab", ["-"], dailyCron(current.stdout, "", "", true))).code !== 0) throw new WorkspaceScheduleError("Daily sync consent is removed, but its cron line could not be removed.");
      }
      return "Daily sync removed. No more unattended uploads are authorized; the machine remains paired.";
    }
    if (!options.binding || options.binding !== await workspaceScheduleBinding(home)) throw new WorkspaceScheduleError("The machine connection changed during setup. No daily uploads were authorized.");
    const node = await realpath(options.nodePath ?? process.execPath);
    if (/[\u0000-\u001f\u007f]/.test(home + node)) throw new WorkspaceScheduleError("Daily sync cannot use a path containing control characters.");
    stage = join(root, `runtime-${randomUUID()}`);
    await privateDir(stage);
    const entry = await (options.stageRuntime ?? stageWorkspaceRuntime)(stage);
    const runner = join(stage, "run.mjs");
    await writeFile(runner, `import { runCli } from ${JSON.stringify(pathToFileURL(entry).href)};\nimport { writeFile } from 'node:fs/promises';\nprocess.env.AI_SPEND_NO_TELEMETRY = '1';\n${options.includePlanTier ? "" : "process.env.AIBILL_NO_PLAN_TIER = '1';\n"}const result = await runCli(['workspace', 'push', '--scheduled'], { homeDirectory: ${JSON.stringify(home)} });\nawait writeFile(${JSON.stringify(join(root, "last-run.json"))}, JSON.stringify({ at: new Date().toISOString(), exitCode: result.exitCode }), { mode: 0o600 });\nprocess.exitCode = result.exitCode;\n`, { mode: 0o600, flag: "wx" });
    if (platform === "darwin") {
      await mkdir(agentDir, { recursive: true });
      const parent = await lstat(agentDir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new WorkspaceScheduleError("LaunchAgents is not a regular directory. No schedule was authorized.");
      await command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]);
      const temporary = join(root, "agent.plist");
      await writeFile(temporary, dailyLaunchAgent(node, runner), { mode: 0o600 });
      await rename(temporary, plist);
      if ((await command("/bin/launchctl", ["bootstrap", domain, plist])).code !== 0) throw new WorkspaceScheduleError("macOS could not load daily sync. No daily uploads were authorized; run setup again from your signed-in terminal.");
    } else {
      const current = await command("crontab", ["-l"]);
      if (current.code !== 0 && !(current.code === 1 && current.stdout === "" && /no crontab for/i.test(current.stderr ?? ""))) throw new WorkspaceScheduleError("The existing crontab could not be read. No schedule was authorized.");
      if ((await command("crontab", ["-"], dailyCron(current.stdout, node, runner))).code !== 0) throw new WorkspaceScheduleError("The daily cron entry could not be installed. No daily uploads were authorized.");
    }
    if (options.binding !== await workspaceScheduleBinding(home)) throw new WorkspaceScheduleError("The machine connection changed during setup. No daily uploads were authorized.");
    const pending = join(root, `consent-${randomUUID()}.json`);
    await writeFile(pending, JSON.stringify({ version: 1, binding: options.binding, includePlanTier: options.includePlanTier, installedAt: options.now } satisfies ScheduleConsent), { mode: 0o600, flag: "wx" });
    await rename(pending, join(root, "consent.json"));
    stage = undefined;
    return `Daily sync installed for 09:17 local time while this machine is available. Each run sends one bounded session batch from the last 30 closed UTC days, with a tier-only follow-up when first announced; it stops on an uncertain prior batch or an expired connection. The current CLI was copied locally, so npx cache removal is safe. Run setup again after updating aibill or Node.js. Remove it with: ${REMOVE}`;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
export async function workspaceScheduleStatus(home = homedir()): Promise<string> {
  const saved = await readWorkspaceSchedule(home);
  if (!saved) return "Daily sync: off.";
  const active = await authorizedWorkspaceSchedule(home);
  let last = "No scheduled run recorded yet.";
  try {
    const result = await readPrivateJson(join(home, ".aibill", "workspace-sync", "last-run.json")) as { at: string; exitCode: number };
    if (Number.isFinite(Date.parse(result.at)) && [0, 1].includes(result.exitCode)) last = `Last scheduled run: ${result.at} · ${result.exitCode === 0 ? "completed" : "stopped; run npx aibill@latest workspace push in a terminal"}.`;
  } catch {}
  return `Daily sync: ${active ? "authorized" : "stopped; connection changed"}. ${last} Remove with: ${REMOVE}`;
}
