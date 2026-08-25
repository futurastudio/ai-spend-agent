import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * 0.9.5 "agent feel": after `report` writes its artifacts, the HTML report
 * opens in the user's browser automatically — through the platform opener,
 * never a hardcoded browser:
 *
 *   darwin  →  open <html>
 *   linux   →  xdg-open <html>   (only when xdg-open is actually on PATH)
 *   win32   →  cmd /c start "" <html>
 *
 * The decision to open is computed SYNCHRONOUSLY and truthfully before the
 * summary renders, so the summary's Next block can say what actually
 * happened. Auto-open is suppressed — silently, keeping the plain
 * `open <path>` pointer — whenever any of these hold:
 *
 *   - stdout is not a TTY (pipes, redirection, scripts)
 *   - CI is set (any non-empty value)
 *   - an SSH session (SSH_CONNECTION or SSH_TTY set): the browser would
 *     open on the wrong machine
 *   - the user asked not to: `--no-open` flag or AI_SPEND_NO_OPEN env
 *     (any non-empty value, same convention as AI_SPEND_NO_TELEMETRY)
 *   - the platform has no known opener (or linux without xdg-open)
 *
 * The spawn itself follows the telemetry detached-child pattern: detached,
 * stdio ignored, unref'd, every failure (including async ENOENT) swallowed —
 * the CLI must never crash, hang, or delay exit because an opener is
 * missing or slow.
 */

export type ReportOpenDecision =
  | { open: true; command: string; args: string[] }
  | {
      open: false;
      reason: "no-open-flag" | "env-switch" | "not-a-tty" | "ci" | "ssh" | "no-opener";
    };

export function decideReportAutoOpen(input: {
  htmlPath: string;
  noOpenFlag: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdoutIsTty?: boolean;
  /** Test seam for the linux xdg-open PATH probe. */
  hasCommandImpl?: (command: string, env: NodeJS.ProcessEnv) => boolean;
}): ReportOpenDecision {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const stdoutIsTty = input.stdoutIsTty ?? Boolean(process.stdout.isTTY);
  const hasCommand = input.hasCommandImpl ?? commandOnPath;

  if (input.noOpenFlag) return { open: false, reason: "no-open-flag" };
  if (env.AI_SPEND_NO_OPEN) return { open: false, reason: "env-switch" };
  if (!stdoutIsTty) return { open: false, reason: "not-a-tty" };
  if (env.CI) return { open: false, reason: "ci" };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { open: false, reason: "ssh" };

  if (platform === "darwin") {
    return { open: true, command: "open", args: [input.htmlPath] };
  }
  if (platform === "win32") {
    // The empty "" is cmd's window-title slot: without it a quoted path
    // becomes the title and nothing opens.
    return { open: true, command: "cmd", args: ["/c", "start", "", input.htmlPath] };
  }
  if (platform === "linux" && hasCommand("xdg-open", env)) {
    return { open: true, command: "xdg-open", args: [input.htmlPath] };
  }
  return { open: false, reason: "no-opener" };
}

/**
 * Fire-and-forget launch of an affirmative decision. Returns true when the
 * opener was handed to the OS (the summary may then say "opened …");
 * returns false — never throws — on any spawn failure.
 */
export function openReportInBrowser(
  decision: ReportOpenDecision,
  options: { spawnImpl?: typeof spawn } = {}
): boolean {
  if (!decision.open) return false;
  try {
    const spawnImpl = options.spawnImpl ?? spawn;
    const child = spawnImpl(decision.command, decision.args, {
      detached: true,
      stdio: "ignore"
    });
    // Async spawn errors (a vanished opener) surface on the child, not the
    // call — swallow them so they can never crash the exiting CLI.
    child.on?.("error", () => { /* silence */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Synchronous PATH probe (linux xdg-open) — cheap, no child process. */
function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
