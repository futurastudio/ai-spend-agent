import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import type { AibillPolicy } from "@agent-finops/core";
import { resolveStatuslinePaths, type StatuslinePlatform } from "./statuslineInstaller.js";

/**
 * What `aibill guard install` writes into a repository, and how it is read
 * back and removed. Two files, both meant to be committed next to
 * `.aibill/policy.json`:
 *
 *  - `.claude/settings.json` (Claude Code shared project settings): the
 *    policy's `models.allow` as `availableModels`, and one command hook on
 *    `UserPromptSubmit` and on `PreToolUse` that runs the launcher below.
 *    Every other key in the file is left as it was.
 *  - `.aibill/guard-hook.mjs`: a launcher that finds the `ai-spend-agent`
 *    package installed for the repository and runs its hook entry, or exits 0
 *    with a one-line warning when the package is missing. A committed hook
 *    cannot carry a machine path, and `npx` would add network and ~200 ms to
 *    every prompt; the launcher keeps the hook portable and fast.
 *
 * `models.deny` maps to `deniedModels`, which Claude Code honours only from
 * managed settings, so project scope reports it and `--managed` prints it.
 */

export const GUARD_LAUNCHER_RELATIVE_PATH = ".aibill/guard-hook.mjs";
export const GUARD_LAUNCHER_VERSION = 1;
export const GUARD_HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;
export const GUARD_HOOK_TIMEOUT_SECONDS = 10;
/** Shell form: Claude Code expands ${CLAUDE_PROJECT_DIR}; the quotes keep spaces in paths intact. */
export const GUARD_HOOK_COMMAND = 'node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"';
/** Managed settings reach every repository, so the hook runs only where a launcher is committed. */
export const GUARD_MANAGED_HOOK_COMMAND =
  'if [ -f "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs" ]; then node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"; fi';
const LAUNCHER_MARKER = "aibill guard hook launcher";
const MAX_SETTINGS_BYTES = 1024 * 1024;

export type GuardHookEvent = typeof GUARD_HOOK_EVENTS[number];

export type GuardHookHandler = {
  type: "command";
  command: string;
  timeout: number;
};

type JsonObject = Record<string, unknown>;

export type GuardSettingsErrorCode =
  | "settings-unreadable"
  | "settings-not-object"
  | "launcher-foreign";

export class GuardSettingsError extends Error {
  constructor(readonly code: GuardSettingsErrorCode, message: string) {
    super(message);
    this.name = "GuardSettingsError";
  }
}

export function buildGuardHookHandler(command: string = GUARD_HOOK_COMMAND): GuardHookHandler {
  return { type: "command", command, timeout: GUARD_HOOK_TIMEOUT_SECONDS };
}

/** The exact settings fragment project scope receives for a policy. */
export function guardProjectSettingsFragment(policy: AibillPolicy): JsonObject {
  const fragment: JsonObject = {};
  if (policy.models?.allow) fragment.availableModels = uniqueModels(policy.models.allow);
  fragment.hooks = Object.fromEntries(
    GUARD_HOOK_EVENTS.map((event) => [event, [{ hooks: [buildGuardHookHandler()] }]])
  );
  return fragment;
}

/** The managed-settings document an organization deploys to enforce the same policy. */
export function guardManagedSettingsSnippet(policy: AibillPolicy): JsonObject {
  const snippet: JsonObject = {};
  if (policy.models?.allow) snippet.availableModels = uniqueModels(policy.models.allow);
  if (policy.models?.deny) snippet.deniedModels = uniqueModels(policy.models.deny);
  snippet.hooks = Object.fromEntries(
    GUARD_HOOK_EVENTS.map((event) => [event, [{ hooks: [buildGuardHookHandler(GUARD_MANAGED_HOOK_COMMAND)] }]])
  );
  return snippet;
}

export function isGuardHookHandler(value: unknown): value is GuardHookHandler {
  return isObject(value) &&
    value.type === "command" &&
    typeof value.command === "string" &&
    value.command.includes(GUARD_LAUNCHER_RELATIVE_PATH);
}

/**
 * Merge the policy into existing project settings: `availableModels` follows
 * the policy, earlier guard hook handlers are replaced by the current one,
 * and every other key, hook group and handler is kept byte-for-byte in
 * meaning. Returns the next document and the human-readable changes.
 */
export function mergeGuardSettings(existing: JsonObject, policy: AibillPolicy): { next: JsonObject; changes: string[] } {
  const next: JsonObject = cloneJson(existing);
  const changes: string[] = [];
  const allow = policy.models?.allow ? uniqueModels(policy.models.allow) : undefined;
  if (allow) {
    if (!sameJson(next.availableModels, allow)) {
      changes.push(next.availableModels === undefined
        ? `availableModels: set to ${allow.join(", ")}`
        : `availableModels: replaced with ${allow.join(", ")}`);
      next.availableModels = allow;
    }
  }
  const hooks: JsonObject = isObject(next.hooks) ? next.hooks : {};
  if (!isObject(next.hooks) && next.hooks !== undefined) changes.push("hooks: replaced a non-object value");
  for (const event of GUARD_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event] as unknown[]] : [];
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) changes.push(`hooks.${event}: replaced a non-array value`);
    const stripped = stripGuardHandlers(groups);
    const nextGroups = [...stripped.kept, { hooks: [buildGuardHookHandler()] }];
    if (!sameJson(groups, nextGroups)) {
      changes.push(stripped.removed > 0 ? `hooks.${event}: guard hook updated` : `hooks.${event}: guard hook added`);
    }
    hooks[event] = nextGroups;
  }
  next.hooks = hooks;
  return { next, changes };
}

/**
 * Remove exactly what `mergeGuardSettings` adds: guard hook handlers (and the
 * groups and `hooks` object they leave empty) and `availableModels` when it
 * still equals the policy's allow list. A list the developer changed stays.
 */
export function removeGuardSettings(existing: JsonObject, policy: AibillPolicy | undefined): { next: JsonObject; changes: string[]; kept: string[] } {
  const next: JsonObject = cloneJson(existing);
  const changes: string[] = [];
  const kept: string[] = [];
  if (next.availableModels !== undefined) {
    const allow = policy?.models?.allow ? uniqueModels(policy.models.allow) : undefined;
    if (allow && sameJson(next.availableModels, allow)) {
      delete next.availableModels;
      changes.push("availableModels: removed");
    } else {
      kept.push(policy
        ? "availableModels: kept, it no longer equals the policy's models.allow"
        : "availableModels: kept, no policy to compare it with");
    }
  }
  if (isObject(next.hooks)) {
    const hooks = next.hooks;
    for (const event of GUARD_HOOK_EVENTS) {
      if (!Array.isArray(hooks[event])) continue;
      const stripped = stripGuardHandlers(hooks[event] as unknown[]);
      if (stripped.removed === 0) continue;
      changes.push(`hooks.${event}: guard hook removed`);
      if (stripped.kept.length > 0) hooks[event] = stripped.kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete next.hooks;
  }
  return { next, changes, kept };
}

function stripGuardHandlers(groups: readonly unknown[]): { kept: unknown[]; removed: number } {
  const kept: unknown[] = [];
  let removed = 0;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => {
      if (isGuardHookHandler(handler)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (handlers.length === group.hooks.length) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return { kept, removed };
}

/** The committed launcher. Plain ESM; no dependency on the aibill version that wrote it. */
export function buildGuardLauncherSource(): string {
  return [
    "#!/usr/bin/env node",
    `// ${LAUNCHER_MARKER} v${GUARD_LAUNCHER_VERSION}. Written by \`aibill guard install\`; \`aibill guard install --uninstall\` removes it.`,
    "// Claude Code runs this on every prompt and tool call (see .claude/settings.json). It",
    "// runs `aibill guard check` from the ai-spend-agent package installed for this repository",
    "// and never blocks when that package is missing or fails to load.",
    'import { createRequire } from "node:module";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    "",
    "const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));",
    "const globalRoot = process.platform === \"win32\"",
    '  ? join(dirname(process.execPath), "node_modules")',
    '  : join(dirname(dirname(process.execPath)), "lib", "node_modules");',
    "const anchors = [",
    '  join(repositoryRoot, "package.json"),',
    '  join(process.cwd(), "package.json"),',
    '  join(globalRoot, "package.json")',
    "];",
    "",
    "let manifest;",
    "for (const anchor of anchors) {",
    "  try {",
    '    manifest = createRequire(anchor).resolve("ai-spend-agent/package.json");',
    "    break;",
    "  } catch {",
    "    // Try the next anchor.",
    "  }",
    "}",
    "if (!manifest) {",
    '  process.stderr.write("aibill guard: ai-spend-agent is not installed for this repository, so its policy was not checked. Install it with: npm install --save-dev aibill\\n");',
    "  process.exit(0);",
    "}",
    "try {",
    '  const { runGuardHook } = await import(pathToFileURL(join(dirname(manifest), "dist", "guardHook.js")).href);',
    "  process.exitCode = await runGuardHook();",
    "} catch (error) {",
    '  process.stderr.write(`aibill guard: the installed ai-spend-agent could not run the hook (${error instanceof Error ? error.message : String(error)}); not blocking.\\n`);',
    "  process.exitCode = 0;",
    "}",
    ""
  ].join("\n");
}

export function isGuardLauncherSource(text: string): boolean {
  return text.split("\n", 3).some((line) => line.includes(LAUNCHER_MARKER));
}

export type GuardInstallResult = {
  repositoryRoot: string;
  settingsPath: string;
  launcherPath: string;
  settings: "created" | "updated" | "unchanged";
  launcher: "created" | "updated" | "unchanged";
  changes: string[];
};

export async function installGuard(options: { repositoryRoot: string; policy: AibillPolicy }): Promise<GuardInstallResult> {
  const settingsPath = join(options.repositoryRoot, ".claude", "settings.json");
  const launcherPath = join(options.repositoryRoot, GUARD_LAUNCHER_RELATIVE_PATH);
  const existing = await readProjectSettings(settingsPath);
  const merged = mergeGuardSettings(existing.value, options.policy);
  // Only a change in meaning rewrites the file, so a developer's formatting
  // survives an install that has nothing to add.
  const settings: GuardInstallResult["settings"] = !existing.exists
    ? "created"
    : merged.changes.length > 0 ? "updated" : "unchanged";
  if (settings !== "unchanged") {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(merged.next, null, 2)}\n`, "utf8");
  }

  const launcherSource = buildGuardLauncherSource();
  const current = await readOptionalFile(launcherPath);
  let launcher: GuardInstallResult["launcher"] = "unchanged";
  if (current === undefined) launcher = "created";
  else if (current !== launcherSource) {
    if (!isGuardLauncherSource(current)) {
      throw new GuardSettingsError(
        "launcher-foreign",
        `${GUARD_LAUNCHER_RELATIVE_PATH} exists and was not written by aibill guard; move it aside first.`
      );
    }
    launcher = "updated";
  }
  if (launcher !== "unchanged") {
    await mkdir(dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, launcherSource, { encoding: "utf8", mode: 0o644 });
  }
  return { repositoryRoot: options.repositoryRoot, settingsPath, launcherPath, settings, launcher, changes: merged.changes };
}

export type GuardUninstallResult = {
  repositoryRoot: string;
  settingsPath: string;
  launcherPath: string;
  settings: "removed" | "updated" | "unchanged" | "absent";
  launcher: "removed" | "absent" | "kept-foreign";
  changes: string[];
  kept: string[];
};

export async function uninstallGuard(options: { repositoryRoot: string; policy: AibillPolicy | undefined }): Promise<GuardUninstallResult> {
  const settingsPath = join(options.repositoryRoot, ".claude", "settings.json");
  const launcherPath = join(options.repositoryRoot, GUARD_LAUNCHER_RELATIVE_PATH);
  const existing = await readProjectSettings(settingsPath);
  let settings: GuardUninstallResult["settings"] = existing.exists ? "unchanged" : "absent";
  let changes: string[] = [];
  let kept: string[] = [];
  if (existing.exists) {
    const removed = removeGuardSettings(existing.value, options.policy);
    changes = removed.changes;
    kept = removed.kept;
    if (removed.changes.length > 0) {
      if (Object.keys(removed.next).length === 0) {
        // Nothing but guard settings was in the file; an empty settings file
        // carries no setting, so the file goes too.
        await rm(settingsPath, { force: true });
        settings = "removed";
      } else {
        await writeFile(settingsPath, `${JSON.stringify(removed.next, null, 2)}\n`, "utf8");
        settings = "updated";
      }
    }
  }
  const current = await readOptionalFile(launcherPath);
  let launcher: GuardUninstallResult["launcher"] = "absent";
  if (current !== undefined) {
    if (isGuardLauncherSource(current)) {
      await rm(launcherPath, { force: true });
      launcher = "removed";
    } else {
      launcher = "kept-foreign";
    }
  }
  return { repositoryRoot: options.repositoryRoot, settingsPath, launcherPath, settings, launcher, changes, kept };
}

export type GuardInstallState = {
  settingsPath: string;
  settingsExists: boolean;
  settingsReadable: boolean;
  availableModels: string[] | undefined;
  availableModelsMatchPolicy: boolean;
  hookEvents: GuardHookEvent[];
  launcherPath: string;
  launcher: "present" | "absent" | "foreign";
  managed: {
    directory: string;
    files: string[];
    availableModels: boolean;
    deniedModels: boolean;
    guardHook: boolean;
  };
};

/** What is installed where, for `guard status`. Reads only; never throws. */
export async function readGuardInstallState(options: {
  repositoryRoot: string;
  policy: AibillPolicy | undefined;
  homeDirectory: string;
  platform?: StatuslinePlatform;
}): Promise<GuardInstallState> {
  const platform = options.platform ?? normalizePlatform(hostPlatform());
  const paths = resolveStatuslinePaths(options.homeDirectory, options.repositoryRoot, platform);
  const settingsPath = join(options.repositoryRoot, ".claude", "settings.json");
  const launcherPath = join(options.repositoryRoot, GUARD_LAUNCHER_RELATIVE_PATH);
  let settingsExists = false;
  let settingsReadable = true;
  let value: JsonObject = {};
  try {
    const read = await readProjectSettings(settingsPath);
    settingsExists = read.exists;
    value = read.value;
  } catch {
    settingsExists = true;
    settingsReadable = false;
  }
  const availableModels = Array.isArray(value.availableModels) && value.availableModels.every((entry) => typeof entry === "string")
    ? value.availableModels as string[]
    : undefined;
  const allow = options.policy?.models?.allow ? uniqueModels(options.policy.models.allow) : undefined;
  const hookEvents = GUARD_HOOK_EVENTS.filter((event) => {
    const groups = isObject(value.hooks) && Array.isArray(value.hooks[event]) ? value.hooks[event] as unknown[] : [];
    return groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isGuardHookHandler));
  });
  const launcherText = await readOptionalFile(launcherPath);
  const launcher = launcherText === undefined ? "absent" : isGuardLauncherSource(launcherText) ? "present" : "foreign";

  const managedFiles: string[] = [];
  const managedDocuments: JsonObject[] = [];
  const candidates = [paths.managedSettingsPath];
  try {
    const dropIns = (await readdir(paths.managedDropInDirectory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
    candidates.push(...dropIns.map((name) => join(paths.managedDropInDirectory, name)));
  } catch {
    // No drop-in directory.
  }
  for (const candidate of candidates) {
    const text = await readOptionalFile(candidate);
    if (text === undefined) continue;
    managedFiles.push(candidate);
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) managedDocuments.push(parsed);
    } catch {
      // An unparseable managed file is reported by Claude Code itself.
    }
  }
  return {
    settingsPath,
    settingsExists,
    settingsReadable,
    availableModels,
    availableModelsMatchPolicy: allow !== undefined && sameJson(availableModels, allow),
    hookEvents,
    launcherPath,
    launcher,
    managed: {
      directory: dirname(paths.managedSettingsPath),
      files: managedFiles,
      availableModels: managedDocuments.some((document) => document.availableModels !== undefined),
      deniedModels: managedDocuments.some((document) => document.deniedModels !== undefined),
      guardHook: managedDocuments.some((document) => isObject(document.hooks) &&
        Object.values(document.hooks).some((groups) => Array.isArray(groups) &&
          groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isGuardHookHandler))))
    }
  };
}

async function readProjectSettings(path: string): Promise<{ exists: boolean; text: string; value: JsonObject }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "", value: {} };
    throw new GuardSettingsError("settings-unreadable", `${path} could not be read.`);
  }
  if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) {
    throw new GuardSettingsError("settings-unreadable", `${path} is not a regular settings file under ${MAX_SETTINGS_BYTES} bytes.`);
  }
  const text = await readFile(path, "utf8");
  if (text.trim().length === 0) return { exists: true, text, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GuardSettingsError("settings-unreadable", `${path} is not valid JSON; fix it before installing the guard.`);
  }
  if (!isObject(value)) {
    throw new GuardSettingsError("settings-not-object", `${path} must hold a JSON object.`);
  }
  return { exists: true, text, value };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function uniqueModels(entries: readonly string[]): string[] {
  return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function normalizePlatform(value: NodeJS.Platform): StatuslinePlatform {
  return value === "darwin" || value === "win32" ? value : "linux";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
