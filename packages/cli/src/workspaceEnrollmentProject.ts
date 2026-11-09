import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type WorkspaceEnrollmentProject = {
  directoryRef: string;
  displayName: string;
  confirmation: "CONFIRM_REPOSITORY";
};
export type WorkspaceEnrollmentProjectPreview = Omit<WorkspaceEnrollmentProject, "confirmation"> & { localDirectory: string };
export class WorkspaceEnrollmentProjectError extends Error {
  constructor(reason: "checkout" | "declined" | "changed" | "confirmation") {
    super({
      checkout: "Open a real Git checkout with a safe repository name before connecting. For an administrator-prepared setup, use workspace connect --prepared. No new request was created.",
      declined: "Repository confirmation declined. No new request was created.",
      changed: "The repository changed during confirmation. No new request was created.",
      confirmation: "Explicit repository confirmation is required.",
    }[reason]);
  }
}

export function validWorkspaceProjectName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && value.trim() === value
    && ![".", ".."].includes(value)
    && !/[/\\\u0000-\u001f\u007f-\u009f@\u202a-\u202e\u2066-\u2069]/.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

export function validateWorkspaceEnrollmentProject(value: unknown): asserts value is WorkspaceEnrollmentProject {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "confirmation,directoryRef,displayName") throw Error("The reported repository is invalid.");
  const project = value as WorkspaceEnrollmentProject;
  if (typeof project.directoryRef !== "string" || !/^sha256_[a-f0-9]{64}$/.test(project.directoryRef) || !validWorkspaceProjectName(project.displayName)
    || project.confirmation !== "CONFIRM_REPOSITORY") throw Error("The reported repository is invalid.");
}

/** Local checkout metadata only: no remote, file content, agent logs, or inherited Git overrides. */
export async function previewWorkspaceEnrollmentProject(directory: string): Promise<WorkspaceEnrollmentProjectPreview> {
  try {
    const current = await realpath(resolve(directory));
    if (!(await stat(current)).isDirectory()) throw Error("directory");
    const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SystemRoot"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const { stdout } = await promisify(execFile)("git", ["-C", current, "-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree", "--show-toplevel"], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout: 2000, maxBuffer: 8192, encoding: "utf8", windowsHide: true,
    });
    const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines.length !== 2 || lines[0] !== "true" || !isAbsolute(lines[1]!)) throw Error("checkout");
    const localDirectory = await realpath(lines[1]!);
    const within = relative(localDirectory, current);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`) || !(await stat(localDirectory)).isDirectory()) throw Error("checkout");
    const displayName = basename(localDirectory);
    if (!validWorkspaceProjectName(displayName)) throw Error("name");
    return { localDirectory, displayName,
      directoryRef: `sha256_${createHash("sha256").update(`project-working-directory\0${localDirectory}`).digest("hex")}` };
  } catch {
    throw new WorkspaceEnrollmentProjectError("checkout");
  }
}
