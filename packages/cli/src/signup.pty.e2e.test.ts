import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signupCopy } from "./signup.js";

/**
 * End-to-end pin of the 0.9.2 production consent incident (founder transcript
 * 2026-08-24): email typed at the during-scan ask right at the ready-nudge,
 * receipt renders, and the follow-up Enter — still in flight from the email
 * entry — landed on the consent read the moment it armed. Consent resolved
 * instantly as a silent decline: no outcome line, no POST, the founder's row
 * absent from the production waitlist.
 *
 * These tests drive the REAL bin entrypoint (dist/index.js) as a child
 * process on a simulated tty: stdin/stdout are pipes with isTTY spoofed by a
 * --import preload, which puts readline into the exact terminal mode the
 * incident ran under while keeping keypress timing fully scriptable. The
 * preload also stubs the production waitlist POST with a 201 and records the
 * exact request — nothing here ever contacts asktilden.com.
 *
 * The 0.9.3 contract pinned here:
 * - consent WAITS for a fresh keypress (in-flight and key-repeat Enters are
 *   discarded, never answers),
 * - the consent line renders exactly once (no redraw loop, no marker spam),
 * - a deliberate y sends exactly the payload JSON once,
 * - EVERY resolution prints an outcome line (sent / nothing sent).
 */

const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const preloadSource = `
import { appendFileSync } from "node:fs";
const fakeTty = (stream) => {
  Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  if (typeof stream.setRawMode !== "function") {
    stream.setRawMode = function () { return this; };
  }
};
fakeTty(process.stdin);
fakeTty(process.stdout);
if (process.platform !== "win32") process.umask(0o022);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes("asktilden.com/api/waitlist")) {
    appendFileSync(process.env.WAITLIST_STUB_LOG, JSON.stringify({ body: init?.body ?? null }) + "\\n");
    return new Response("{}", { status: 201 });
  }
  if (target.includes("asktilden.com/api/telemetry")) {
    return new Response(null, { status: 204 });
  }
  return realFetch(url, init);
};
`;

type PtyRun = {
  output: () => string;
  write: (text: string) => void;
  endInput: () => void;
  waitFor: (needle: string, timeoutMs?: number) => Promise<void>;
  waitForExit: (timeoutMs?: number) => Promise<number | null>;
  home: string;
  stubLog: string;
};

async function startCli(argv: string[] = []): Promise<PtyRun> {
  expect(existsSync(cliEntry), `built CLI missing at ${cliEntry} — run npx tsc -b first`).toBe(true);
  const home = await mkdtemp(join(tmpdir(), "signup-pty-home-"));
  const preloadPath = join(home, "fake-tty-preload.mjs");
  const stubLog = join(home, "waitlist-stub.log");
  await writeFile(preloadPath, preloadSource, "utf8");
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    WAITLIST_STUB_LOG: stubLog,
    COLUMNS: "80",
    NO_COLOR: "1",
    // Point every evidence source at empty directories: the consent path is
    // receipt-independent and this keeps the scan instant + machine-clean.
    AI_SPEND_CLAUDE_LOGS_DIR: join(home, "empty-claude"),
    AI_SPEND_CODEX_LOGS_DIR: join(home, "empty-codex"),
    AI_SPEND_GEMINI_LOGS_DIR: join(home, "empty-gemini")
  };
  // CI=1 (and the no-prompt kill switch) would suppress the ask entirely.
  delete env.CI;
  delete env.AI_SPEND_NO_PROMPT;
  delete env.AI_SPEND_NO_TELEMETRY;
  delete env.DO_NOT_TRACK;

  const child = spawn(process.execPath, ["--import", preloadPath, cliEntry, ...argv], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let captured = "";
  child.stdout.on("data", (chunk: Buffer) => { captured += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { captured += chunk.toString("utf8"); });
  let exited: number | null | undefined;
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => { exited = code; resolve(code); });
  });
  return {
    output: () => captured,
    write: (text) => { child.stdin.write(text); },
    endInput: () => { child.stdin.end(); },
    waitFor: async (needle, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!captured.includes(needle)) {
        if (exited !== undefined) {
          throw new Error(`CLI exited (${exited}) before printing ${JSON.stringify(needle)}:\n${captured}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${JSON.stringify(needle)}:\n${captured}`);
        }
        await sleep(25);
      }
    },
    waitForExit: async (timeoutMs = 20_000) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      try {
        return await exitPromise;
      } finally {
        clearTimeout(timer);
      }
    },
    home,
    stubLog
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const email = "founder@gmail.com";
const expectedPayload = `{"email":"${email}","ref":"cli-receipt"}`;
const consentLine = signupCopy.consentQuestion(expectedPayload);

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe("signup consent PTY rhythm (founder incident end-to-end)", () => {
  it(
    "his exact sequence: email at the ask → receipt → consent WAITS through the in-flight Enter → fresh y sends → outcome printed",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      // The founder's rhythm: the email typed at the ask (the empty-home scan
      // resolves fast, so this lands right at the ready-nudge window), with
      // the follow-up Enter ~0.6s behind it — the keypress that auto-declined
      // 0.9.2 consent in production.
      run.write(`${email}\r`);
      await sleep(600);
      run.write("\r");

      await run.waitFor("[y/N]");
      // The consent read must still be waiting: the in-flight Enter may NEVER
      // answer it. Give it ample time to mis-resolve, then check nothing did.
      await sleep(1_300);
      expect(run.output()).not.toContain(signupCopy.sentLine);
      expect(run.output()).not.toContain(signupCopy.nothingSentLine);
      expect(await readFile(run.stubLog, "utf8").catch(() => "")).toBe("");

      // A deliberate, fresh y — far past the fresh-keypress holdoff.
      run.write("y\r");
      await run.waitFor(signupCopy.sentLine);
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);

      const output = run.output();
      // Exactly one POST, of exactly the payload JSON.
      const stubLines = (await readFile(run.stubLog, "utf8")).trim().split("\n");
      expect(stubLines).toHaveLength(1);
      expect(JSON.parse(stubLines[0]!)).toEqual({ body: expectedPayload });
      // The consent line rendered exactly once — no redraw loop, no marker
      // spam over the question (the incident showed the marker repeated ~11x
      // with "[y/N]" overwritten).
      expect(countOccurrences(output, consentLine)).toBe(1);
      expect(countOccurrences(output, "[y/N]")).toBe(1);
      expect(output).not.toMatch(/>{3,}/);
      // Exactly one outcome line.
      expect(countOccurrences(output, signupCopy.sentLine)).toBe(1);
      expect(output).not.toContain(signupCopy.nothingSentLine);
      // The decision persisted.
      const state = JSON.parse(await readFile(join(run.home, ".aibill", "signup.json"), "utf8")) as {
        status: string;
        email?: string;
      };
      expect(state.status).toBe("subscribed");
      expect(state.email).toBe(email);
    }
  );

  it(
    "a key-repeat Enter storm never answers consent; the eventual fresh decline is announced",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      run.write(email);
      await sleep(150);
      // Held Enter: macOS key-repeat fires every ~35-80ms. 40ms writes keep
      // each press safely inside the 75ms burst window even on a loaded CI
      // runner (adversary SF3: 70ms left a 5ms margin). The first submits
      // the email; the rest are one burst that must be discarded whole.
      for (let press = 0; press < 12; press += 1) {
        run.write("\r");
        await sleep(40);
      }

      await run.waitFor("[y/N]");
      await sleep(1_300);
      expect(run.output()).not.toContain(signupCopy.sentLine);
      expect(run.output()).not.toContain(signupCopy.nothingSentLine);

      // A deliberate, fresh decline — and it is announced, never silent.
      run.write("n\r");
      await run.waitFor(signupCopy.nothingSentLine);
      await run.waitForExit();

      const output = run.output();
      expect(countOccurrences(output, "[y/N]")).toBe(1);
      expect(output).not.toMatch(/>{3,}/);
      expect(countOccurrences(output, signupCopy.nothingSentLine)).toBe(1);
      expect(output).not.toContain(signupCopy.sentLine);
      expect(await readFile(run.stubLog, "utf8").catch(() => "")).toBe("");
      const state = JSON.parse(await readFile(join(run.home, ".aibill", "signup.json"), "utf8")) as {
        status: string;
        askCount: number;
      };
      expect(state.status).toBe("deferred");
      expect(state.askCount).toBe(1);
    }
  );
});

describe("ask-path resilience (cold-start audit NEW-B2 / PC-4 / PC-5)", () => {
  const drainNoticeFragment = "pasted line(s) were discarded";

  it(
    "a rapid double-Enter skip completes: nudge shown, ONE lifetime skip recorded, receipt renders, no phantom paste notice",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      // Both Enters in ONE chunk — the impatient double-tap that 0.9.2
      // discarded as "paste", leaving askCount 0 and a 30s dead prompt.
      run.write("\r\r");
      await run.waitFor("Next");
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      const output = run.output();
      expect(output).toContain(signupCopy.skipNudgeLine);
      expect(output).not.toContain(drainNoticeFragment);
      // PC-4a: the ready line never renders glued onto the open prompt row.
      expect(output).not.toContain(`${signupCopy.askPrompt}  ${signupCopy.receiptReadyLine}`);
      const state = JSON.parse(await readFile(join(run.home, ".aibill", "signup.json"), "utf8")) as {
        status: string;
        askCount: number;
      };
      expect(state.status).toBe("deferred");
      expect(state.askCount).toBe(1);
    }
  );

  it(
    "EOF at the ask still renders the receipt and exits clean (skip-this-run, no lifetime skip)",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      run.endInput();
      // 0.9.2 exited 0 HERE with no receipt (unsettled top-level await —
      // the closed interface left only an unref'd timer holding the loop).
      await run.waitFor("Next");
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      const state = JSON.parse(await readFile(join(run.home, ".aibill", "signup.json"), "utf8")) as {
        status: string;
        askCount: number;
      };
      expect(state.status).toBe("deferred");
      expect(state.askCount).toBe(0);
    }
  );

  it(
    "double-Enter followed immediately by EOF: the completed pair still counts and the receipt renders",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      run.write("\r\r");
      run.endInput();
      await run.waitFor("Next");
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      const state = JSON.parse(await readFile(join(run.home, ".aibill", "signup.json"), "utf8")) as {
        status: string;
        askCount: number;
      };
      expect(state.status).toBe("deferred");
      expect(state.askCount).toBe(1);
    }
  );
});

describe("cold-start funnel (audit NEW-B1): bare run stamps home state, init still works", () => {
  it(
    "fresh HOME + umask 022: skip the ask (state written), then init succeeds and everything is 0700",
    { timeout: 60_000 },
    async () => {
      const run = await startCli();
      await run.waitFor(signupCopy.askFooter);
      run.write("\r\r");
      await run.waitFor("Next");
      expect(await run.waitForExit()).toBe(0);
      // The first run stamped ~/.aibill (signup + telemetry notice state).
      const { lstat } = await import("node:fs/promises");
      const aibillInfo = await lstat(join(run.home, ".aibill"));
      if (process.platform !== "win32") expect(aibillInfo.mode & 0o077).toBe(0);

      // The funnel's second command — 0.9.2 dead-ended here forever.
      const projectDir = await mkdtemp(join(tmpdir(), "coldstart-project-"));
      const init = spawn(process.execPath, [cliEntry, "init", "--path", projectDir], {
        env: { ...process.env, HOME: run.home, USERPROFILE: run.home, NO_COLOR: "1" } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let initOutput = "";
      init.stdout.on("data", (chunk: Buffer) => { initOutput += chunk.toString("utf8"); });
      init.stderr.on("data", (chunk: Buffer) => { initOutput += chunk.toString("utf8"); });
      const initExit = await new Promise<number | null>((resolve) => { init.on("exit", resolve); });
      expect(initExit, initOutput).toBe(0);
      expect(initOutput).toContain("aibill init");
      expect(initOutput).not.toContain("unsafe directory");
      if (process.platform !== "win32") {
        const cacheInfo = await lstat(join(run.home, ".aibill", "cache"));
        expect(cacheInfo.mode & 0o077).toBe(0);
      }
    }
  );
});

describe("founder's literal repro: `npx aibill report-card` from the home directory", () => {
  it(
    "renders the friendly guard clean — never nested in the report-card error wrapper",
    { timeout: 30_000 },
    async () => {
      const home = await mkdtemp(join(tmpdir(), "reportcard-home-"));
      const child = spawn(process.execPath, [cliEntry, "report-card"], {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exitCode = await new Promise<number | null>((resolve) => { child.on("exit", resolve); });
      expect(exitCode).toBe(1);
      expect(stderr.split("\n")[0]).toBe("aibill report-card needs one exact project folder.");
      expect(stderr).toContain("Nothing was read, created, or changed.");
      expect(stderr).not.toContain("Couldn't write the report card");
      expect(stderr).not.toContain("Refusing to scan");
      expect(stdout).toBe("");
    }
  );
});

describe("explicit `signup <email>` consent (adversary SF1)", () => {
  const signupEmail = "founder@gmail.com";
  const signupPayload = `{"email":"${signupEmail}","ref":"cli-signup"}`;

  it(
    "type-ahead y before the question renders never auto-consents; a fresh y sends once",
    { timeout: 60_000 },
    async () => {
      const run = await startCli(["signup", signupEmail]);
      // Type-ahead: the y lands before the consent question exists.
      run.write("y\r");
      await run.waitFor("[y/N]");
      await sleep(1_300);
      expect(run.output()).not.toContain(signupCopy.sentLine);
      expect(await readFile(run.stubLog, "utf8").catch(() => "")).toBe("");

      run.write("y\r");
      await run.waitFor(signupCopy.sentLine);
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      const stubLines = (await readFile(run.stubLog, "utf8")).trim().split("\n");
      expect(stubLines).toHaveLength(1);
      expect(JSON.parse(stubLines[0]!)).toEqual({ body: signupPayload });
      expect(run.output()).not.toContain("unexpected error");
    }
  );

  it(
    "Ctrl-D at the consent question: nothing sent, exit 0, never the crash voice",
    { timeout: 60_000 },
    async () => {
      const run = await startCli(["signup", signupEmail]);
      await run.waitFor("[y/N]");
      run.endInput();
      await run.waitFor(signupCopy.nothingSentLine);
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      expect(run.output()).not.toContain("unexpected error");
      expect(run.output()).not.toContain("Aborted with Ctrl");
      expect(run.output()).not.toContain(signupCopy.sentLine);
      expect(await readFile(run.stubLog, "utf8").catch(() => "")).toBe("");
    }
  );

  it(
    "Ctrl-C at the consent question: nothing sent, exit 0, no ask-phase interrupt copy",
    { timeout: 60_000 },
    async () => {
      const run = await startCli(["signup", signupEmail]);
      await run.waitFor("[y/N]");
      run.write("\u0003");
      await run.waitFor(signupCopy.nothingSentLine);
      const exitCode = await run.waitForExit();
      expect(exitCode).toBe(0);
      expect(run.output()).not.toContain("unexpected error");
      expect(run.output()).not.toContain(signupCopy.interruptLine);
      expect(run.output()).not.toContain(signupCopy.interruptAfterAnswerLine);
      expect(await readFile(run.stubLog, "utf8").catch(() => "")).toBe("");
    }
  );
});
