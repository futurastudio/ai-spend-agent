import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decideReportAutoOpen, openReportInBrowser, type ReportOpenDecision } from "./reportOpener.js";

/**
 * 0.9.5 auto-open: the platform-opener decision is pure and synchronous, the
 * launch is a detached fire-and-forget. These tests pin the opener argv per
 * platform, EVERY suppression path, and the no-added-exit-time contract
 * (the telemetry detached-child assertions, reused).
 */

const htmlPath = "/tmp/report-under-test/ai-spend-report.html";

/** A TTY, non-CI, non-SSH baseline every case perturbs one dial on. */
function baseline(overrides: Partial<Parameters<typeof decideReportAutoOpen>[0]> = {}) {
  return decideReportAutoOpen({
    htmlPath,
    noOpenFlag: false,
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    platform: "darwin",
    stdoutIsTty: true,
    ...overrides
  });
}

describe("decideReportAutoOpen — platform openers", () => {
  it("darwin uses the built-in `open`", () => {
    expect(baseline()).toEqual({ open: true, command: "open", args: [htmlPath] });
  });

  it("win32 uses the non-reparsing rundll32/FileProtocolHandler opener, never `cmd /c start`", () => {
    // Command-injection fix (0.9.5): the old `cmd /c start "" <path>` let
    // cmd.exe re-parse & ^ % ( ) < > | even with shell:false. rundll32
    // hands the path to url.dll with a discrete argv and no shell.
    const decision = baseline({ platform: "win32" });
    expect(decision).toEqual({
      open: true,
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", htmlPath]
    });
    expect(decision.open && decision.command).not.toBe("cmd");
  });

  it("linux uses xdg-open only when it is actually on PATH", () => {
    expect(baseline({ platform: "linux", hasCommandImpl: () => true })).toEqual({
      open: true,
      command: "xdg-open",
      args: [htmlPath]
    });
    expect(baseline({ platform: "linux", hasCommandImpl: () => false })).toEqual({
      open: false,
      reason: "no-opener"
    });
  });

  it("an unknown platform never opens", () => {
    expect(baseline({ platform: "freebsd" })).toEqual({ open: false, reason: "no-opener" });
  });
});

describe("decideReportAutoOpen — every suppression path", () => {
  it("--no-open wins over everything", () => {
    expect(baseline({ noOpenFlag: true })).toEqual({ open: false, reason: "no-open-flag" });
  });

  it("AI_SPEND_NO_OPEN (any non-empty value) suppresses", () => {
    expect(baseline({ env: { AI_SPEND_NO_OPEN: "1" } as NodeJS.ProcessEnv }))
      .toEqual({ open: false, reason: "env-switch" });
  });

  it("a non-TTY stdout suppresses (pipes, redirection, scripts)", () => {
    expect(baseline({ stdoutIsTty: false })).toEqual({ open: false, reason: "not-a-tty" });
  });

  it("CI suppresses", () => {
    expect(baseline({ env: { CI: "1" } as NodeJS.ProcessEnv }))
      .toEqual({ open: false, reason: "ci" });
  });

  it("SSH sessions suppress via SSH_CONNECTION or SSH_TTY (browser would open on the wrong machine)", () => {
    expect(baseline({ env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" } as NodeJS.ProcessEnv }))
      .toEqual({ open: false, reason: "ssh" });
    expect(baseline({ env: { SSH_TTY: "/dev/pts/1" } as NodeJS.ProcessEnv }))
      .toEqual({ open: false, reason: "ssh" });
  });

  it("a path with any cmd metacharacter or quote suppresses on EVERY platform (command-injection defense 1)", () => {
    // The win32 vector: `C:\code\proj&calc` (all legal filename chars,
    // no spaces) used to make cmd.exe run calc. Each of & ^ % ( ) < > |
    // and the double-quote refuses auto-open on darwin/linux/win32 alike —
    // a metacharacter path is a reasonable thing to decline to shell-open.
    const metacharacters = ["&", "^", "%", "(", ")", "<", ">", "|", '"'];
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const character of metacharacters) {
        const decision = decideReportAutoOpen({
          htmlPath: `/base/proj${character}calc/ai-spend-report.html`,
          noOpenFlag: false,
          env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
          platform,
          stdoutIsTty: true,
          hasCommandImpl: () => true
        });
        expect(decision, `${platform} ${character}`).toEqual({ open: false, reason: "unsafe-path" });
      }
    }
  });

  it("the win32 %VAR% info-leak shape is also refused (defense 1)", () => {
    expect(baseline({
      platform: "win32",
      htmlPath: "C:\\code\\%USERNAME%\\ai-spend-report.html"
    })).toEqual({ open: false, reason: "unsafe-path" });
  });

  it("adversary 9-hostile-name probe: no path shape reaches a shell on any branch", () => {
    // The nine hostile cwd/--out shapes. For each we assert the decision on
    // all three platforms is EITHER a suppression (open:false) OR an
    // affirmative decision whose command is a known non-shell opener with
    // the raw path as a discrete argv element — never `cmd`, never a shell,
    // never the path spliced into a command string.
    const nonShellOpeners = new Set(["open", "xdg-open", "rundll32"]);
    const hostileNames = [
      "foo & calc",              // classic injection + spaces
      "bar;echo pwned",          // posix separator (also has a space)
      "$(cmd)",                  // command substitution shape
      'a"b',                     // embedded double-quote
      "with space",             // plain spaces (must be safe to open)
      "unicode-café-项目",        // non-ascii (must be safe to open)
      "space\\free\\UNC",        // space-free UNC-shaped
      "pipe|payload",            // pipe
      "redir<in>out"             // redirection pair
    ];
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (const name of hostileNames) {
        const htmlPath = `/base/${name}/ai-spend-report.html`;
        const decision = decideReportAutoOpen({
          htmlPath,
          noOpenFlag: false,
          env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
          platform,
          stdoutIsTty: true,
          hasCommandImpl: () => true
        });
        const label = `${platform} :: ${name}`;
        if (decision.open) {
          // Affirmative only for shapes with no cmd metacharacter (spaces,
          // unicode, plain UNC; `;`/`$` are inert without a shell). The
          // no-shell-reachability invariant is exactly: a KNOWN non-shell
          // opener, and the raw path carried as its OWN argv element —
          // never `cmd`/PowerShell, never spliced into a command string.
          expect(nonShellOpeners.has(decision.command), label).toBe(true);
          expect(decision.command, label).not.toBe("cmd");
          expect(decision.command.toLowerCase(), label).not.toContain("powershell");
          expect(decision.args, label).toContain(htmlPath);
          // The path is a discrete element, not concatenated into any arg.
          expect(decision.args.some((arg) => arg !== htmlPath && arg.includes(name)), label).toBe(false);
        } else {
          expect(["unsafe-path", "no-opener"], label).toContain(decision.reason);
        }
      }
    }
  });
});

type SpawnStubCall = { command: string; args: readonly string[]; options: Record<string, unknown> };

function spawnStub(calls: SpawnStubCall[], child = new EventEmitter() as EventEmitter & { unref?: () => void; unrefs?: number }) {
  child.unrefs = 0;
  child.unref = () => { child.unrefs! += 1; };
  return {
    child,
    impl: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return child;
    }) as never
  };
}

describe("openReportInBrowser — detached fire-and-forget", () => {
  const decision: ReportOpenDecision = { open: true, command: "open", args: [htmlPath] };

  it("spawns detached + stdio ignore, unrefs, swallows async spawn errors, returns true", () => {
    const calls: SpawnStubCall[] = [];
    const { child, impl } = spawnStub(calls);
    expect(openReportInBrowser(decision, { spawnImpl: impl })).toBe(true);
    expect(calls).toEqual([{
      command: "open",
      args: [htmlPath],
      options: { detached: true, stdio: "ignore" }
    }]);
    expect(child.unrefs).toBe(1);
    // A vanished opener emits an async error on the child — it must be
    // swallowed, never crash the exiting CLI.
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
  });

  it("a suppressed decision never spawns and returns false", () => {
    const calls: SpawnStubCall[] = [];
    const { impl } = spawnStub(calls);
    expect(openReportInBrowser({ open: false, reason: "ci" }, { spawnImpl: impl })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a synchronously throwing spawn is swallowed and reported as not-opened", () => {
    expect(openReportInBrowser(decision, {
      spawnImpl: (() => { throw new Error("spawn EPERM"); }) as never
    })).toBe(false);
  });

  it("the launch call adds ≤200ms to the parent path (fire-and-forget, no wait)", () => {
    // Real spawn of a child that would live for a minute: the call must
    // return immediately — the parent never waits on the opener.
    const started = Date.now();
    const opened = openReportInBrowser({
      open: true,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"]
    });
    expect(Date.now() - started).toBeLessThanOrEqual(200);
    expect(opened).toBe(true);
  });

  it("a parent that fires the opener and exits is never held by the child (telemetry pattern b)", async () => {
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });',
      'child.on("error", () => {});',
      "child.unref();"
    ].join("\n");
    const started = Date.now();
    await promisify(execFile)(process.execPath, ["-e", parentScript]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
