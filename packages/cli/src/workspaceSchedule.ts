/** Explicit, grant-bound standing consent for daily Workspace uploads. No credentials in OS jobs. */
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
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
const OWN_BATCH_FILE = "own-batch.json";
/** The job log is trimmed to its newest part once it passes this, so years of daily lines stay small. */
const LOG_CAP_BYTES = 256 * 1024, LOG_KEEP_BYTES = 64 * 1024;
/** A setup that died (a closed terminal, a kill) leaves its lock; one older than this is taken over. Setup itself takes seconds. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** A daily job that has recorded nothing for this long has missed at least one run. */
const RUN_STALE_MS = 48 * 60 * 60 * 1000;
export type ScheduleConsent = { version: 1; binding: string; includePlanTier: boolean; installedAt: string };
/**
 * Runs `launchctl` or `crontab`. `stdout` and `input` are byte strings, one character per byte: a crontab belongs to
 * the person and may hold bytes that are not UTF-8, and it is written back as it was read.
 */
export type ScheduleCommand = (command: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr?: string }>;
export type WorkspaceScheduleOptions = { platform?: NodeJS.Platform; command?: ScheduleCommand; stageRuntime?: (destination: string) => Promise<string>; nodePath?: string };
export class WorkspaceScheduleError extends Error {}
/** Another setup holds the lock, as opposed to a lock that could not be created. */
class ScheduleLockHeld extends WorkspaceScheduleError {}
/** The refusal for a system daily sync cannot run on, or null. Asked before any consent question. */
export function workspaceScheduleUnsupported(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" ? "Daily sync currently supports macOS and systems with crontab. Use workspace push manually on Windows." : null;
}
const errorCode = (error: unknown) => String((error as NodeJS.ErrnoException | null)?.code ?? "unknown error");
/** The program itself is not on this system. */
const commandMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
/** UTF-8 text as a byte string, the form a crontab is read and written in. */
const bytes = (text: string) => Buffer.from(text, "utf8").toString("latin1");
const noFollow = constants.O_NOFOLLOW ?? 0;
const execute: ScheduleCommand = (command, args, input) => new Promise((done, reject) => {
  const child = execFile(command, args, { encoding: "buffer", timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
    if (error && !("code" in error && typeof error.code === "number"))
      reject(Object.assign(new WorkspaceScheduleError("The operating system could not update daily sync. Nothing new was authorized."), commandMissing(error) ? { code: "ENOENT" } : {}));
    else done({ code: error ? Number(error.code) : 0, stdout: stdout.toString("latin1"), stderr: stderr.toString("latin1") });
  });
  child.stdin?.on("error", () => {}); // The exit/spawn result above owns reporting, including an early closed pipe.
  if (input !== undefined) child.stdin?.end(Buffer.from(input, "latin1"));
});
async function privateDir(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
    throw new WorkspaceScheduleError(`Daily sync needs ${path} to be a directory of yours that only you can open (mode 700), and it is not; no schedule was set up. To fix it: chmod 700 on that directory. To remove an existing schedule instead: ${REMOVE}`);
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
const isDailyCron = (line: string) => line.replace(/\r?\n?$/, "").endsWith(` ${MARKER}`);
const hasDailyCron = (existing: string) => existing.split("\n").some(isDailyCron);
/** A path as it stands inside the cron line: quoted for the shell, `%` escaped for cron, as bytes. */
const inCronLine = (path: string) => bytes(path.replaceAll("'", "'\\''").replaceAll("%", "\\%"));
/**
 * The crontab with this job's one line set, or removed when `job` is null. `existing` and the result are byte strings.
 * Every other line stays byte for byte, line endings and a missing final newline included: the job's line goes first,
 * with its own newline, so taking exactly that line away gives back what was there. First also means no `SHELL=` or
 * `PATH=` line of the person's applies to it; cron applies those to the lines that follow them.
 */
export function dailyCron(existing: string, job: DailyJob | null): string {
  const others = existing.split(/(?<=\n)/).filter(line => !isDailyCron(line)).join("");
  // The job's output is appended to a private local log, so a job that cannot start leaves a line a person can read.
  return job ? `${bytes(`17 9 * * * ${`${[job.node, job.runner].map(quote).join(" ")} >>${quote(job.log)} 2>&1`.replaceAll("%", "\\%")} ${MARKER}`)}\n${others}` : others;
}
export function dailyLaunchAgent({ node, runner, log }: DailyJob): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}
/**
 * The scheduled run. It sets HOME before the CLI loads, so the run reads session logs from the same home whose pairing
 * state it uses: the home the person previewed in a terminal, whatever HOME the operating system gives the job. Each
 * run appends one line to the job log itself and records its result, also when the retained CLI can no longer start;
 * the log is trimmed to its newest part once it grows past a bound.
 */
export function dailyRunner(entry: string, home: string, lastRun: string, log: string, includePlanTier: boolean): string {
  return [`process.env.HOME = ${JSON.stringify(home)};`, "process.env.AI_SPEND_NO_TELEMETRY = '1';",
    ...(includePlanTier ? [] : ["process.env.AIBILL_NO_PLAN_TIER = '1';"]),
    "const { appendFile, readFile, stat, writeFile } = await import('node:fs/promises');",
    `const LOG = ${JSON.stringify(log)};`,
    "let exitCode = 2, note = '';",
    "try {",
    `  const { runCli } = await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    `  const result = await runCli(['workspace', 'push', '--scheduled'], { homeDirectory: ${JSON.stringify(home)} });`,
    "  exitCode = result.exitCode === 0 ? 0 : 1;",
    "  note = exitCode === 0 ? result.stdout : result.stderr;",
    "} catch (error) { note = `The retained CLI could not start: ${error instanceof Error ? error.message : String(error)}`; }",
    "const at = new Date().toISOString();",
    "try {",
    `  const size = (await stat(LOG)).size;`,
    `  if (size > 16 * 1024 * 1024) await writeFile(LOG, '');`,
    `  else if (size > ${LOG_CAP_BYTES}) { const all = await readFile(LOG), tail = all.subarray(all.length - ${LOG_KEEP_BYTES}); await writeFile(LOG, tail.subarray(tail.indexOf(10) + 1)); }`,
    "} catch {}",
    "await appendFile(LOG, `${at} exit ${exitCode} ${String(note).replace(/\\s+/g, ' ').slice(0, 1000)}\\n`, { mode: 0o600 }).catch(() => {});",
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
async function cleanupWorkspaceRuntimes(root: string, keep?: string, ownerOnly = true): Promise<void> {
  const runningModule = fileURLToPath(import.meta.url);
  for (const name of await readdir(root)) {
    if (!/^runtime-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)) continue;
    const path = join(root, name);
    if (path === keep || runningModule.startsWith(`${path}/`)) continue;
    const info = await lstat(path).catch(() => null);
    // Removal deletes a copy whatever its mode bits say; it is still this person's own real directory.
    if (!info?.isDirectory() || info.isSymbolicLink() || ownerOnly && info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) continue;
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
      throw new ScheduleLockHeld(`Another daily-sync setup holds ${lock}, or one was stopped and left it. If none is running, delete that directory and run this command again; a lock older than ten minutes is cleared automatically. The scheduled job was not changed.`);
    }
  }
}
async function readCrontab(command: ScheduleCommand, unreadable: string): Promise<string> {
  const current = await command("crontab", ["-l"]);
  if (current.code === 0) return current.stdout;
  if (current.code === 1 && current.stdout === "" && /no crontab for/i.test(current.stderr ?? "")) return "";
  throw new WorkspaceScheduleError(unreadable);
}
/** Where daily sync keeps its files for this home. The home's real path when it has one. */
const syncRoot = async (home: string) => join(await realpath(resolve(home)).catch(() => resolve(home)), ".aibill", "workspace-sync");
/** True once daily sync was set up under this home and has not been removed since: its private directory exists. Reads nothing else. */
export async function workspaceScheduleLeftBehind(home = homedir()): Promise<boolean> {
  return Boolean(await lstat(join(resolve(home), ".aibill", "workspace-sync")).catch(() => null));
}
/**
 * Why daily sync cannot be set up on this system, or null. Asked before the consent question, so nobody is asked to
 * agree to something that is then refused. Reads the crontab at most; changes nothing.
 */
export async function workspaceScheduleUnavailable(options: WorkspaceScheduleOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform, unsupported = workspaceScheduleUnsupported(platform);
  if (unsupported || platform === "darwin") return unsupported;
  try { await (options.command ?? execute)("crontab", ["-l"]); return null; } catch (error) {
    return commandMissing(error) ? "This system has no crontab command, so daily sync cannot be installed here. Nothing was changed. Use npx aibill@latest workspace push in a terminal instead." : null;
  }
}
/**
 * Whether this home's daily job is in the operating system's own schedule right now: the launch agent file, or a cron
 * line that runs from this home's directory. Null when the crontab cannot be read. Changes nothing.
 */
async function scheduledJobInstalled(home: string, options: WorkspaceScheduleOptions): Promise<boolean | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return false;
  if (platform === "darwin") return Boolean(await lstat(join(home, "Library", "LaunchAgents", `${LABEL}.plist`)).catch(() => null));
  try {
    const from = inCronLine(`${await syncRoot(home)}/`);
    return (await readCrontab(options.command ?? execute, "unreadable")).split("\n").some(line => isDailyCron(line) && line.includes(from));
  } catch (error) { return commandMissing(error) ? false : null; }
}
/**
 * A scheduled run that Workspace refused withdraws its own standing consent, as removal does first: no later run reads
 * or sends anything, whoever started it. The job itself stays until a person removes it or sets it up again.
 */
export async function withdrawWorkspaceScheduleConsent(home = homedir()): Promise<boolean> {
  await rm(join(await syncRoot(home), "consent.json"), { force: true }).catch(() => {});
  return await readWorkspaceSchedule(home) === null;
}
/**
 * The one batch a scheduled run built. Should its answer be lost, the next scheduled run may send those identical
 * bytes again by itself; a retained batch a person approved in a terminal stays theirs to retry. An id, nothing else.
 */
export async function rememberScheduledBatch(home = homedir(), batchId: string): Promise<void> {
  const root = await syncRoot(home), pending = join(root, `own-batch-${randomUUID()}.json`);
  try {
    await writeFile(pending, JSON.stringify({ batchId }), { mode: 0o600, flag: "wx" });
    await rename(pending, join(root, OWN_BATCH_FILE));
  } catch { await rm(pending, { force: true }).catch(() => {}); } // Unremembered, a lost answer waits for a terminal, as before.
}
export async function scheduledBatchIsOwn(home = homedir(), batchId: string): Promise<boolean> {
  try { return (await readPrivateJson(join(await syncRoot(home), OWN_BATCH_FILE)) as { batchId?: unknown }).batchId === batchId; } catch { return false; }
}
/**
 * Removal. It must work whatever state the directories are in, so it asks less of them than setup does: the scheduled
 * job is removed first in every case, and the files go when their directory is this person's own real directory,
 * whatever its mode bits are. Standing consent is withdrawn before anything else, the lock included.
 */
async function removeWorkspaceSchedule(home: string, platform: NodeJS.Platform, command: ScheduleCommand): Promise<string> {
  const root = await syncRoot(home), lock = join(root, "install.lock"), consentFile = join(root, "consent.json");
  const mine = async (path: string) => {
    const info = await lstat(path).catch(() => null);
    return Boolean(info?.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid()));
  };
  const usable = await mine(dirname(root)) && await mine(root);
  let consentKept = false, locked = false, cleared = false;
  if (usable) {
    // The directory is about to be emptied and removed, so a mode that would stop that (read-only) is put right first.
    await chmod(root, 0o700).catch(() => {});
    await rm(consentFile, { force: true }).catch(() => { consentKept = true; });
    try { await takeInstallLock(lock); locked = true; } catch (error) {
      // A lock that cannot be created (a read-only directory) does not stand in the way of removing the job.
      if (error instanceof ScheduleLockHeld) throw new WorkspaceScheduleError(`${consentKept ? "" : "Standing consent was removed first, so no unattended upload can run from this machine. "}${error.message} A setup that is still running can finish and turn daily sync on again; run this command once more after it ends.`);
    }
  }
  try {
    if (platform === "darwin") {
      await command("/bin/launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`]);
      await rm(join(home, "Library", "LaunchAgents", `${LABEL}.plist`), { force: true });
    } else {
      // No crontab command means no cron line: there is nothing of the job to remove.
      const current = await readCrontab(command, "Daily sync consent is removed, but crontab could not be read. Remove its aibill-workspace-daily-v1 line manually.")
        .catch(error => { if (commandMissing(error)) return ""; throw error; });
      // A crontab without the line is left alone: nothing is rewritten, and none is created where there was none.
      if (hasDailyCron(current) && (await command("crontab", ["-"], dailyCron(current, null))).code !== 0) throw new WorkspaceScheduleError("Daily sync consent is removed, but its cron line could not be removed.");
    }
    if (usable) {
      await cleanupWorkspaceRuntimes(root, undefined, false).catch(() => {});
      for (const name of await readdir(root).catch(() => [] as string[]))
        if (["agent.plist", "last-run.json", LOG_FILE, OWN_BATCH_FILE].includes(name) || /^(consent|own-batch)-[a-f0-9-]{36}\.json$/.test(name)) await rm(join(root, name), { force: true }).catch(() => {});
      cleared = true;
    }
  } catch (error) {
    if (error instanceof WorkspaceScheduleError) throw error;
    throw new WorkspaceScheduleError(`${consentKept ? "The" : "Standing consent was removed, so no unattended upload can run, but the"} scheduled job could not be fully removed (${errorCode(error)}). Run this command again.`);
  } finally {
    if (locked) await rm(lock, { recursive: true, force: true }).catch(() => {});
    // Removal leaves nothing of its own behind; a directory that still holds something else is kept.
    if (cleared) await rmdir(root).catch(() => {});
  }
  const keeps = "This does not disconnect the machine or delete anything Workspace already holds.";
  if (!await lstat(root).catch(() => null)) return `Daily sync removed: its scheduled job, the retained CLI copy, its log and its standing consent are gone from this machine. No unattended upload is authorized. ${keeps}`;
  return `Daily sync removed: its scheduled job is gone from this machine, so nothing runs and nothing uploads. Some files are still in ${root}, which is not a plain directory of yours that can be changed, or holds other files; delete it by hand. ${keeps}`;
}
export async function updateWorkspaceSchedule(options: { home?: string; mode: "daily" | "none"; now: string; includePlanTier: boolean; binding?: string } & WorkspaceScheduleOptions): Promise<string> {
  const home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  const unsupported = workspaceScheduleUnsupported(platform);
  if (unsupported) throw new WorkspaceScheduleError(unsupported);
  const command = options.command ?? execute;
  if (options.mode === "none") return removeWorkspaceSchedule(home, platform, command);
  const root = await rootFor(home), lock = join(root, "install.lock"), consentFile = join(root, "consent.json");
  await takeInstallLock(lock);
  let stage: string | undefined;
  /** What this setup wrote outside its own staging directory, undone newest first if a later step fails. */
  const undo: (() => Promise<void>)[] = [];
  try {
    // Remove standing consent first. Even a stale loaded OS job now refuses to read local facts.
    await rm(consentFile, { force: true });
    // A setup killed between writing and renaming its consent left one of these; it never authorized anything.
    for (const name of await readdir(root)) if (/^consent-[a-f0-9-]{36}\.json$/.test(name)) await rm(join(root, name), { force: true });
    const agentDir = join(home, "Library", "LaunchAgents"), plist = join(agentDir, `${LABEL}.plist`);
    const domain = `gui/${process.getuid?.()}`, log = join(root, LOG_FILE);
    if (!options.binding || options.binding !== await workspaceScheduleBinding(home)) throw new WorkspaceScheduleError("The machine connection changed during setup. No daily uploads were authorized.");
    const node = await realpath(options.nodePath ?? process.execPath);
    // Every path the job's entry is built from: the real path of the home's directory, the home as given, and Node.js.
    if (/[\u0000-\u001f\u007f]/.test(root + home + node)) throw new WorkspaceScheduleError("Daily sync cannot use a path containing control characters.");
    stage = join(root, `runtime-${randomUUID()}`);
    await privateDir(stage);
    const entry = await (options.stageRuntime ?? stageWorkspaceRuntime)(stage);
    const runner = join(stage, "run.mjs"), job: DailyJob = { node, runner, log };
    await writeFile(runner, dailyRunner(entry, home, join(root, "last-run.json"), log, options.includePlanTier), { mode: 0o600, flag: "wx" });
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
    return `Daily sync installed for 09:17 local time while this machine is available. Each run sends one bounded session batch from the last 30 closed UTC days, with a tier-only follow-up when first announced. A run whose answer is lost sends that same batch again on the next run; a batch Workspace refuses, or an expired connection, stops it; and if Workspace refuses this machine, daily sync turns itself off. The current CLI was copied locally, so npx cache removal is safe. Run setup again after updating aibill or Node.js. Each run adds one line to ${log}; npx aibill@latest workspace status shows the last run and says so when none has been recorded for 48 hours. Remove it with: ${REMOVE}`;
  } catch (error) {
    let undone = true;
    for (const step of undo.reverse()) await step().catch(() => { undone = false; });
    const left = undone ? "" : ` Part of the scheduled job could not be taken away again; remove it with: ${REMOVE}`;
    if (error instanceof WorkspaceScheduleError) throw left ? new WorkspaceScheduleError(`${error.message}${left}`) : error;
    throw new WorkspaceScheduleError(`Daily sync setup stopped on a local error (${errorCode(error)}). No daily uploads were authorized.${left}`);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}
/**
 * What is in effect and what is installed, each read for itself: standing consent from this home's private file, the
 * job from the operating system's own schedule. The two can part (a setup that failed, a job removed by hand, a run
 * that withdrew its consent), and then the line says which one is there.
 */
export async function workspaceScheduleStatus(home = homedir(), now = new Date().toISOString(), options: WorkspaceScheduleOptions = {}): Promise<string> {
  const saved = await readWorkspaceSchedule(home), installed = await scheduledJobInstalled(home, options);
  const root = join(home, ".aibill", "workspace-sync");
  let ran: { at: string; exitCode: number } | null = null;
  try {
    const result = await readPrivateJson(join(root, "last-run.json")) as { at: string; exitCode: number };
    if (Number.isFinite(Date.parse(result.at)) && [0, 1, 2].includes(result.exitCode)) ran = result;
  } catch {}
  const last = !ran ? "No scheduled run recorded yet."
    : `Last scheduled run: ${ran.at} · ${ran.exitCode === 0 ? "completed" : ran.exitCode === 1 ? "stopped; run npx aibill@latest workspace push in a terminal" : `the retained CLI could not start; set it up again with: ${SETUP}`}.`;
  if (!saved) return installed !== true ? "Daily sync: off."
    : `Daily sync: OFF, but its scheduled job is STILL INSTALLED on this machine. It cannot upload, because no standing consent is in effect: daily sync turned itself off, a setup did not finish, or ${root} is no longer a directory only you can open. ${last} Job log: ${join(root, LOG_FILE)} · turn it on again with: ${SETUP} · remove the job with: ${REMOVE}`;
  const active = await authorizedWorkspaceSchedule(home);
  if (!active) return `Daily sync: stopped; connection changed. ${last} Remove with: ${REMOVE}`;
  if (installed === false) return `Daily sync: authorized, but its scheduled job is NOT INSTALLED on this machine, so nothing runs: it was removed outside aibill, or a setup did not finish. Set it up again with: ${SETUP} · remove the leftover consent with: ${REMOVE}`;
  // A job that cannot start records nothing: Node.js moved, the retained copy is gone, or no cron service runs. Silence is the only sign.
  const heard = Math.max(Date.parse(saved.installedAt), ran ? Date.parse(ran.at) : 0);
  if (Date.parse(now) - heard > RUN_STALE_MS)
    return `Daily sync: authorized, but NOT RUNNING as far as this machine can tell: no scheduled run has been recorded for more than 48 hours (${ran ? `last run ${ran.at}` : `none since setup on ${saved.installedAt}`}). Either this machine was off or asleep at 09:17 each day, or the job can no longer start: Node.js was updated or moved, the retained CLI copy was removed, or no cron service is running. Set it up again with: ${SETUP} · job log: ${join(root, LOG_FILE)} · remove with: ${REMOVE}`;
  return `Daily sync: authorized. ${last} Remove with: ${REMOVE}`;
}
