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
 *   win32   →  rundll32 url.dll,FileProtocolHandler <html>
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
 *   - the resolved path contains a shell metacharacter (see below)
 *   - the platform has no known opener (or linux without xdg-open)
 *
 * The spawn itself follows the telemetry detached-child pattern: detached,
 * stdio ignored, unref'd, every failure (including async ENOENT) swallowed —
 * the CLI must never crash, hang, or delay exit because an opener is
 * missing or slow.
 *
 * SECURITY (win32 command-injection, fixed 0.9.5): the earlier
 * `cmd /c start "" <path>` opener passed the path through cmd.exe, which
 * re-parses `& ^ % ( ) < > |` even when spawned with shell:false — a
 * space-free path like `C:\code\proj&calc` (all legal filename chars)
 * would make cmd execute `calc`, and `%VAR%` would expand (info leak). The
 * cwd-derived machine-wide path AND an absolute `--out` both reach here.
 * Two independent defenses now stand:
 *   1. UNSAFE_PATH_METACHARACTERS refuses auto-open (falling back to the
 *      plain pointer) for ANY path carrying those characters or a quote,
 *      on every platform — a metacharacter path is a reasonable thing to
 *      decline to shell-open anywhere.
 *   2. The win32 opener no longer touches a shell: rundll32 hands the path
 *      straight to url.dll's FileProtocolHandler with a discrete argv, so
 *      even a metacharacter path that slipped past (1) cannot reach cmd.
 */

/**
 * cmd.exe re-parsing set plus the double-quote (which can break out of
 * libuv's own arg quoting). A path containing any of these is never handed
 * to a platform opener; auto-open falls back to the plain pointer instead.
 */
const UNSAFE_PATH_METACHARACTERS = /[&^%()<>|"]/u;

export type ReportOpenDecision =
  | { open: true; command: string; args: string[] }
  | {
      open: false;
      reason:
        | "no-open-flag"
        | "env-switch"
        | "not-a-tty"
        | "ci"
        | "ssh"
        | "unsafe-path"
        | "no-opener";
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
  // Defense (1): never shell-open a path carrying a cmd metacharacter or a
  // quote — on any platform. This alone neutralizes the win32 vector.
  if (UNSAFE_PATH_METACHARACTERS.test(input.htmlPath)) {
    return { open: false, reason: "unsafe-path" };
  }

  if (platform === "darwin") {
    return { open: true, command: "open", args: [input.htmlPath] };
  }
  if (platform === "win32") {
    // Defense (2): rundll32 → url.dll,FileProtocolHandler opens the path
    // with NO shell in the chain — cmd.exe never sees it, so its
    // `& ^ % ( ) < > |` re-parsing (which shell:false does not prevent for
    // `cmd /c start`) cannot fire even if defense (1) ever missed a char.
    return {
      open: true,
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", input.htmlPath]
    };
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
