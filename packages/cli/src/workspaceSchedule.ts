/** Explicit, grant-bound standing consent for daily Workspace uploads. No credentials in OS jobs. */
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
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
const SETUP = "npx aibill@latest workspace push --schedule daily";
const LOG_FILE = "daily.log";
/** A setup that died (a closed terminal, a kill) leaves its lock; one older than this is taken over. Setup itself takes seconds. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** A daily job that has recorded nothing for this long has missed at least one run. */
const RUN_STALE_MS = 48 * 60 * 60 * 1000;
export type ScheduleConsent = { version: 1; binding: string; includePlanTier: boolean; installedAt: string };
export type ScheduleCommand = (command: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type WorkspaceScheduleOptions = { platform?: NodeJS.Platform; command?: ScheduleCommand; stageRuntime?: (destination: string) => Promise<string>; nodePath?: string };
export class WorkspaceScheduleError extends Error {}
/** The refusal for a system daily sync cannot run on, or null. Asked before any consent question. */
export function workspaceScheduleUnsupported(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" ? "Daily sync currently supports macOS and systems with crontab. Use workspace push manually on Windows." : null;
}
const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException | null)?.code ?? "unknown error");
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
export type DailyJob = { node: string; runner: string; log: string };
const hasDailyCron = (existing: string) => existing.split("\n").some(line => line.endsWith(` ${MARKER}`));
/** The crontab with this job's one line replaced, or removed when `job` is null. Every other line is kept as it is. */
export function dailyCron(existing: string, job: DailyJob | null): string {
  const lines = existing.split("\n").filter(line => !line.endsWith(` ${MARKER}`));
  while (lines.at(-1) === "") lines.pop();
  // The job's output is appended to a private local log, so a job that cannot start leaves a line a person can read.
  if (job) lines.push(`17 9 * * * ${`${[job.node, job.runner].map(quote).join(" ")} >>${quote(job.log)} 2>&1`.replaceAll("%", "\\%")} ${MARKER}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
export function dailyLaunchAgent({ node, runner, log }: DailyJob): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}
/**
 * The scheduled run. It sets HOME before the CLI loads, so the run reads session logs from the same home whose pairing
 * state it uses: the home the person previewed in a terminal, whatever HOME the operating system gives the job. Each
 * run appends one line to the job log and records its result, also when the retained CLI can no longer start.
 */
export function dailyRunner(entry: string, home: string, lastRun: string, includePlanTier: boolean): string {
  return [`process.env.HOME = ${JSON.stringify(home)};`, "process.env.AI_SPEND_NO_TELEMETRY = '1';",
    ...(includePlanTier ? [] : ["process.env.AIBILL_NO_PLAN_TIER = '1';"]),
    "const { writeFile } = await import('node:fs/promises');",
    "let exitCode = 2, note = '';",
    "try {",
    `  const { runCli } = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    `  const result = await runCli(['workspace', 'push', '--scheduled'], { homeDirectory: ${JSON.stringify(home)} });`,
    "  exitCode = result.exitCode === 0 ? 0 : 1;",
    "  note = exitCode === 0 ? result.stdout : result.stderr;",
    "} catch (error) { note = `The retained CLI could not start: ${error instanceof Error ? error.message : String(error)}`; }",
    "const at = new Date().toISOString();",
    "console.log(`${at} exit ${exitCode} ${String(note).replace(/\\s+/g, ' ').slice(0, 1000)}`);",
    `await writeFile(${JSON.stringify(lastRun)}, JSON.stringify({ at, exitCode }), { mode: 0o600 });`,
    "process.exitCode = exitCode;", ""].join("\n");
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
/** Only directories created by this installer, after OS replacement/removal succeeds.
 * An invocation running from a retained runtime keeps its own code until a later setup. */
async function cleanupWorkspaceRuntimes(root: string, keep?: string): Promise<void> {
  const runningModule = fileURLToPath(import.meta.url);
  for (const name of await readdir(root)) {
    if (!/^runtime-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)) continue;
    const path = join(root, name);
    if (path === keep || runningModule.startsWith(`${path}/`)) continue;
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) continue;
    await rm(path, { recursive: true, force: true });
  }
}
/**
 * One setup at a time. A lock left by a setup that died is taken over once it is old; a newer one is named, so a person
 * can remove it. Any other failure to create the lock reports itself: it is not another setup.
 */
async function takeInstallLock(lock: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new WorkspaceScheduleError(`Daily sync could not create its setup lock at ${lock} (${errorCode(error)}). The scheduled job was not changed.`);
      const held = await lstat(lock).catch(() => null);
      if (attempt === 0 && (!held || Date.now() - held.mtimeMs > LOCK_STALE_MS)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      throw new WorkspaceScheduleError(`Another daily-sync setup holds ${lock}, or one was stopped and left it. If none is running, delete that directory and run this command again; a lock older than ten minutes is cleared automatically. The scheduled job was not changed.`);
    }
  }
}
async function readCrontab(command: ScheduleCommand, unreadable: string): Promise<string> {
  const current = await command("crontab", ["-l"]);
  if (current.code === 0) return current.stdout;
  if (current.code === 1 && current.stdout === "" && /no crontab for/i.test(current.stderr ?? "")) return "";
  throw new WorkspaceScheduleError(unreadable);
}
/** True once daily sync was set up under this home and has not been removed since: its private directory exists. Reads nothing else. */
export async function workspaceScheduleLeftBehind(home = homedir()): Promise<boolean> {
  return Boolean(await lstat(join(resolve(home), ".aibill", "workspace-sync")).catch(() => null));
}
export async function updateWorkspaceSchedule(options: { home?: string; mode: "daily" | "none"; now: string; includePlanTier: boolean; binding?: string } & WorkspaceScheduleOptions): Promise<string> {
  const home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  const unsupported = workspaceScheduleUnsupported(platform);
  if (unsupported) throw new WorkspaceScheduleError(unsupported);
  const root = await rootFor(home), lock = join(root, "install.lock"), command = options.command ?? execute;
  const consentFile = join(root, "consent.json");
  // Removal withdraws standing consent before anything else, lock included: a job that is still loaded then refuses to
  // read local facts, so stopping uploads never waits on a lock or on the operating system.
  if (options.mode === "none") {
    await rm(consentFile, { force: true }).catch(error => { throw new WorkspaceScheduleError(`Daily sync consent could not be removed at ${consentFile} (${errorCode(error)}). Delete that file to stop unattended uploads.`); });
    try { await takeInstallLock(lock); } catch (error) {
      throw error instanceof WorkspaceScheduleError ? new WorkspaceScheduleError(`Standing consent was removed first, so no unattended upload can run from this machine. ${error.message} A setup that is still running can finish and turn daily sync on again; run this command once more after it ends.`) : error;
    }
  } else await takeInstallLock(lock);
  let stage: string | undefined, removed = false;
  /** What this setup wrote outside its own staging directory, undone newest first if a later step fails. */
  const undo: (() => Promise<void>)[] = [];
  try {
    // Remove standing consent first. Even a stale loaded OS job now refuses to read local facts.
    await rm(consentFile, { force: true });
    // A setup killed between writing and renaming its consent left one of these; it never authorized anything.
    for (const name of await readdir(root)) if (/^consent-[a-f0-9-]{36}\.json$/.test(name)) await rm(join(root, name), { force: true });
    const agentDir = join(home, "Library", "LaunchAgents"), plist = join(agentDir, `${LABEL}.plist`);
    const domain = `gui/${process.getuid?.()}`, log = join(root, LOG_FILE);
    if (options.mode === "none") {
      if (platform === "darwin") {
        await command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]);
        await rm(plist, { force: true });
      } else {
        const current = await readCrontab(command, "Daily sync consent is removed, but crontab could not be read. Remove its aibill-workspace-daily-v1 line manually.");
        // A crontab without the line is left alone: nothing is rewritten, and none is created where there was none.
        if (hasDailyCron(current) && (await command("crontab", ["-"], dailyCron(current, null))).code !== 0) throw new WorkspaceScheduleError("Daily sync consent is removed, but its cron line could not be removed.");
      }
      await cleanupWorkspaceRuntimes(root).catch(() => {});
      for (const name of ["agent.plist", "last-run.json", LOG_FILE]) await rm(join(root, name), { force: true }).catch(() => {});
      removed = true;
      return "Daily sync removed: its scheduled job, the retained CLI copy, its log and its standing consent are gone from this machine. No unattended upload is authorized. This does not disconnect the machine or delete anything Workspace already holds.";
    }
    if (!options.binding || options.binding !== await workspaceScheduleBinding(home)) throw new WorkspaceScheduleError("The machine connection changed during setup. No daily uploads were authorized.");
    const node = await realpath(options.nodePath ?? process.execPath);
    if (/[\u0000-\u001f\u007f]/.test(home + node)) throw new WorkspaceScheduleError("Daily sync cannot use a path containing control characters.");
    stage = join(root, `runtime-${randomUUID()}`);
    await privateDir(stage);
    const entry = await (options.stageRuntime ?? stageWorkspaceRuntime)(stage);
    const runner = join(stage, "run.mjs"), job: DailyJob = { node, runner, log };
    await writeFile(runner, dailyRunner(entry, home, join(root, "last-run.json"), options.includePlanTier), { mode: 0o600, flag: "wx" });
    if (platform === "darwin") {
      await mkdir(agentDir, { recursive: true });
      const parent = await lstat(agentDir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new WorkspaceScheduleError("LaunchAgents is not a regular directory. No schedule was authorized.");
      await command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]);
      const temporary = join(root, "agent.plist");
      undo.push(() => rm(temporary, { force: true }));
      await writeFile(temporary, dailyLaunchAgent(job), { mode: 0o600 });
      await rename(temporary, plist);
      // From here the agent file names a runner that a failed setup deletes: unload it and take the file away again.
      undo.push(async () => { await command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => {}); await rm(plist, { force: true }); });
      if ((await command("/bin/launchctl", ["bootstrap", domain, plist])).code !== 0) throw new WorkspaceScheduleError("macOS could not load daily sync. No daily uploads were authorized; run setup again from your signed-in terminal.");
    } else {
      const current = await readCrontab(command, "The existing crontab could not be read. No schedule was authorized.");
      if ((await command("crontab", ["-"], dailyCron(current, job))).code !== 0) throw new WorkspaceScheduleError("The daily cron entry could not be installed. No daily uploads were authorized.");
      undo.push(async () => {
        const written = await readCrontab(command, "crontab could not be read.");
        if (hasDailyCron(written) && (await command("crontab", ["-"], dailyCron(written, null))).code !== 0) throw Error("crontab could not be written.");
      });
    }
    if (options.binding !== await workspaceScheduleBinding(home)) throw new WorkspaceScheduleError("The machine connection changed during setup. No daily uploads were authorized.");
    const pending = join(root, `consent-${randomUUID()}.json`);
    undo.push(() => rm(pending, { force: true }));
    await writeFile(pending, JSON.stringify({ version: 1, binding: options.binding, includePlanTier: options.includePlanTier, installedAt: options.now } satisfies ScheduleConsent), { mode: 0o600, flag: "wx" });
    await rename(pending, consentFile);
    undo.length = 0; // Consent is written: the setup stands.
    const installedRuntime = stage;
    stage = undefined; // Consent/job now own it; cleanup failure must never delete the live runtime.
    await cleanupWorkspaceRuntimes(root, installedRuntime).catch(() => {});
    return `Daily sync installed for 09:17 local time while this machine is available. Each run sends one bounded session batch from the last 30 closed UTC days, with a tier-only follow-up when first announced; it stops on an uncertain prior batch or an expired connection. The current CLI was copied locally, so npx cache removal is safe. Run setup again after updating aibill or Node.js. Each run adds one line to ${log}; npx aibill@latest workspace status shows the last run and says so when none has been recorded for 48 hours. Remove it with: ${REMOVE}`;
  } catch (error) {
    let undone = true;
    for (const step of undo.reverse()) await step().catch(() => { undone = false; });
    const left = undone ? "" : ` Part of the scheduled job could not be taken away again; remove it with: ${REMOVE}`;
    if (error instanceof WorkspaceScheduleError) throw left ? new WorkspaceScheduleError(`${error.message}${left}`) : error;
    throw new WorkspaceScheduleError(options.mode === "none"
      ? `Standing consent was removed, so no unattended upload can run, but the scheduled job could not be fully removed (${errorCode(error)}). Run this command again.`
      : `Daily sync setup stopped on a local error (${errorCode(error)}). No daily uploads were authorized.${left}`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(lock, { recursive: true, force: true }).catch(() => {});
    // Removal leaves nothing of its own behind; a directory that still holds something else is kept.
    if (removed) await rmdir(root).catch(() => {});
  }
}
export async function workspaceScheduleStatus(home = homedir(), now = new Date().toISOString()): Promise<string> {
  const saved = await readWorkspaceSchedule(home);
  if (!saved) return "Daily sync: off.";
  const active = await authorizedWorkspaceSchedule(home), root = join(home, ".aibill", "workspace-sync");
  let ran: { at: string; exitCode: number } | null = null;
  try {
    const result = await readPrivateJson(join(root, "last-run.json")) as { at: string; exitCode: number };
    if (Number.isFinite(Date.parse(result.at)) && [0, 1, 2].includes(result.exitCode)) ran = result;
  } catch {}
  const last = !ran ? "No scheduled run recorded yet."
    : `Last scheduled run: ${ran.at} · ${ran.exitCode === 0 ? "completed" : ran.exitCode === 1 ? "stopped; run npx aibill@latest workspace push in a terminal" : `the retained CLI could not start; set it up again with: ${SETUP}`}.`;
  if (!active) return `Daily sync: stopped; connection changed. ${last} Remove with: ${REMOVE}`;
  // A job that cannot start records nothing: Node.js moved, the retained copy is gone, or no cron service runs. Silence is the only sign.
  const heard = Math.max(Date.parse(saved.installedAt), ran ? Date.parse(ran.at) : 0);
  if (Date.parse(now) - heard > RUN_STALE_MS)
    return `Daily sync: authorized, but NOT RUNNING as far as this machine can tell: no scheduled run has been recorded for more than 48 hours (${ran ? `last run ${ran.at}` : `none since setup on ${saved.installedAt}`}). Either this machine was off or asleep at 09:17 each day, or the job can no longer start: Node.js was updated or moved, the retained CLI copy was removed, or no cron service is running. Set it up again with: ${SETUP} · job log: ${join(root, LOG_FILE)} · remove with: ${REMOVE}`;
  return `Daily sync: authorized. ${last} Remove with: ${REMOVE}`;
}
