import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import {
  buildWaitlistRef,
  clearSignupState,
  deployedRefPattern,
  normalizeWaitlistEmail,
  postWaitlistSignup,
  readSignupState,
  runPostReceiptSignupAsk,
  sanitizeSignupRefTag,
  serializeWaitlistPayload,
  signupAskAllowed,
  signupCopy,
  signupStateFilePath,
  waitlistUrl,
  writeSignupState,
  type SignupAskIo,
  type SignupState
} from "./signup.js";

const creepGuardHint =
  "payload creep — the waitlist body is exactly {email, ref}; see docs/qa-handoff/CLI_CAPTURE_DESIGN.md §3c before adding anything";

function jsonResponse(status: number): Response {
  return new Response(status === 201 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "x" }), { status });
}

async function tempStateFile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aibill-signup-home-"));
  return signupStateFilePath(home);
}

describe("waitlist payload contract (CI creep guard)", () => {
  it("pins the serialized payload byte shape to exactly {email, ref}", () => {
    const body = serializeWaitlistPayload({ email: "you@work.com", ref: buildWaitlistRef("receipt") });
    expect(body, creepGuardHint).toBe('{"email":"you@work.com","ref":"cli-receipt"}');
    expect(Object.keys(JSON.parse(body) as object), creepGuardHint).toEqual(["email", "ref"]);
  });

  it("pins every producible ref to the deployed route's dot-free contract", () => {
    const refs = [
      buildWaitlistRef("receipt"),
      buildWaitlistRef("signup"),
      buildWaitlistRef("signup", "starfund"),
      buildWaitlistRef("receipt", "starfund")
    ];
    expect(refs).toEqual(["cli-receipt", "cli-signup", "cli-signup-starfund", "cli-receipt-starfund"]);
    for (const ref of refs) {
      // The deployed route (apps/web/app/api/waitlist/route.ts) rewrites any
      // ref failing this regex — dots included — to "direct" (verdict B1).
      expect(ref, creepGuardHint).toMatch(deployedRefPattern);
      expect(ref, creepGuardHint).toMatch(/^cli-(receipt|signup)(-[a-z0-9-]{1,24})?$/);
      expect(ref).not.toContain(".");
    }
  });

  it("sends exactly one POST with the pinned url, headers, and body — and nothing else", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const payload = { email: "you@work.com", ref: buildWaitlistRef("signup", "starfund") };
    const outcome = await postWaitlistSignup(payload, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(outcome).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(waitlistUrl);
    expect(url).toBe("https://asktilden.com/api/waitlist");
    expect(init.method).toBe("POST");
    // The FULL explicit header set — header creep fails here (verdict m1).
    expect(init.headers).toEqual({ "content-type": "application/json", "user-agent": "aibill-cli" });
    expect(init.body, creepGuardHint).toBe('{"email":"you@work.com","ref":"cli-signup-starfund"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps 422, 429, 5xx, and network failure distinctly and never retries", async () => {
    for (const [status, expected] of [[422, "invalid_email"], [429, "rate_limited"], [500, "unreachable"], [403, "unreachable"]] as const) {
      const fetchImpl = vi.fn(async () => jsonResponse(status));
      expect(await postWaitlistSignup({ email: "a@b.co", ref: "cli-signup" }, { fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const failing = vi.fn(async () => { throw new Error("ENOTFOUND asktilden.com"); });
    expect(await postWaitlistSignup({ email: "a@b.co", ref: "cli-signup" }, { fetchImpl: failing as unknown as typeof fetch })).toBe("unreachable");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});

describe("email validation (server parity + control bytes)", () => {
  it("mirrors the deployed route's rules", () => {
    expect(normalizeWaitlistEmail("  You@Work.COM ")).toBe("you@work.com");
    expect(normalizeWaitlistEmail("a@b")).toBeUndefined();
    expect(normalizeWaitlistEmail("a b@c.d")).toBeUndefined();
    expect(normalizeWaitlistEmail("")).toBeUndefined();
    expect(normalizeWaitlistEmail("--ref")).toBeUndefined();
    expect(normalizeWaitlistEmail(`${"a".repeat(250)}@b.co`)).toBeUndefined();
    expect(normalizeWaitlistEmail("üser@exämple.com")).toBe("üser@exämple.com");
  });

  it("rejects control bytes that would inject into the echoed consent line", () => {
    expect(normalizeWaitlistEmail("a\u001b[31m@b.co")).toBeUndefined();
    expect(normalizeWaitlistEmail("a\u0000@b.co")).toBeUndefined();
    expect(normalizeWaitlistEmail("a\u007f@b.co")).toBeUndefined();
    expect(normalizeWaitlistEmail("a\u009b@b.co")).toBeUndefined();
  });
});

describe("--ref sanitization (QA 8)", () => {
  it("allowlists [a-z0-9-]{1,24} and rejects injection shapes", () => {
    expect(sanitizeSignupRefTag("starfund")).toBe("starfund");
    expect(sanitizeSignupRefTag(" STARFUND ")).toBe("starfund");
    expect(sanitizeSignupRefTag("$(rm -rf ~)")).toBeUndefined();
    expect(sanitizeSignupRefTag("starfund%0aX-Header:1")).toBeUndefined();
    expect(sanitizeSignupRefTag("a".repeat(500))).toBeUndefined();
    expect(sanitizeSignupRefTag("dots.break.attribution")).toBeUndefined();
    expect(sanitizeSignupRefTag("under_score")).toBeUndefined();
    expect(sanitizeSignupRefTag("")).toBeUndefined();
  });
});

describe("signup state (fail closed)", () => {
  it("reads missing state as fresh and round-trips a written decision", async () => {
    const file = await tempStateFile();
    expect(await readSignupState(file)).toEqual({ kind: "fresh" });
    const state: SignupState = { version: 1, status: "never", askCount: 1 };
    expect(await writeSignupState(file, state)).toBe(true);
    expect(await readSignupState(file)).toEqual({ kind: "ok", state });
    expect(await clearSignupState(file)).toBe(true);
    expect(await readSignupState(file)).toEqual({ kind: "fresh" });
  });

  it("treats truncated JSON, wrong types, and unreadable files as never-ask", async () => {
    const file = await tempStateFile();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, '{"version":1,"status":"defer', "utf8");
    expect(await readSignupState(file)).toEqual({ kind: "unreadable" });
    expect(signupAskAllowed(await readSignupState(file), new Date())).toBe(false);

    await writeFile(file, JSON.stringify({ version: 1, status: "maybe", askCount: "two" }), "utf8");
    expect(await readSignupState(file)).toEqual({ kind: "unreadable" });

    await writeFile(file, JSON.stringify({ version: 1, status: "deferred", askCount: 0 }), "utf8");
    await chmod(file, 0o000);
    try {
      expect((await readSignupState(file)).kind).toBe("unreadable");
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("enforces the nag ceiling: two skips, seven days apart, future-dated clocks", () => {
    const now = new Date("2026-08-28T12:00:00Z");
    const allowed = (state: SignupState) => signupAskAllowed({ kind: "ok", state }, now);
    expect(signupAskAllowed({ kind: "fresh" }, now)).toBe(true);
    expect(allowed({ version: 1, status: "subscribed", askCount: 0, email: "a@b.co" })).toBe(false);
    expect(allowed({ version: 1, status: "never", askCount: 0 })).toBe(false);
    expect(allowed({ version: 1, status: "deferred", askCount: 2 })).toBe(false);
    expect(allowed({ version: 1, status: "deferred", askCount: 1, lastAskedAt: "2026-08-27T12:00:00Z" })).toBe(false);
    expect(allowed({ version: 1, status: "deferred", askCount: 1, lastAskedAt: "2026-08-01T12:00:00Z" })).toBe(true);
    // Clock moved back: a future lastAskedAt counts as recently asked (m4).
    expect(allowed({ version: 1, status: "deferred", askCount: 0, lastAskedAt: "2027-01-01T00:00:00Z" })).toBe(false);
    expect(allowed({ version: 1, status: "deferred", askCount: 0, lastAskedAt: "not-a-date" })).toBe(false);
  });
});

type ScriptedIo = { io: SignupAskIo; questions: string[]; written: string[] };

function scriptedIo(answers: Array<string | undefined>): ScriptedIo {
  const questions: string[] = [];
  const written: string[] = [];
  return {
    questions,
    written,
    io: {
      question: async (query) => {
        questions.push(query);
        return answers.shift();
      },
      write: (line) => written.push(line)
    }
  };
}

describe("post-receipt inline ask", () => {
  it("Enter skips: a lifetime skip is consumed, nothing is printed, nothing is sent", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { io, questions, written } = scriptedIo([""]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(questions).toEqual([signupCopy.askQuestion]);
    expect(written).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    const read = await readSignupState(file);
    expect(read).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 1 } });
  });

  it("stays silent forever after two lifetime skips, across runs", async () => {
    const file = await tempStateFile();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1_000;
    let clock = Date.now();
    const now = () => new Date(clock);
    for (const _ of [1, 2]) {
      const { io } = scriptedIo([""]);
      await runPostReceiptSignupAsk({ io, stateFilePath: file, now });
      clock += eightDaysMs;
    }
    const third = scriptedIo(["should-never-be-read"]);
    await runPostReceiptSignupAsk({ io: third.io, stateFilePath: file, now });
    expect(third.questions).toEqual([]);
  });

  it("waits at least 7 days between asks", async () => {
    const file = await tempStateFile();
    const first = scriptedIo([""]);
    await runPostReceiptSignupAsk({ io: first.io, stateFilePath: file });
    const sameWeek = scriptedIo(["x"]);
    await runPostReceiptSignupAsk({ io: sameWeek.io, stateFilePath: file });
    expect(sameWeek.questions).toEqual([]);
  });

  it("a timeout consumes NO lifetime skip but still throttles re-asks (M3)", async () => {
    const file = await tempStateFile();
    const timedOut = scriptedIo([undefined]);
    await runPostReceiptSignupAsk({ io: timedOut.io, stateFilePath: file });
    expect(timedOut.written).toEqual([]);
    const afterTimeout = await readSignupState(file);
    expect(afterTimeout).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 0 } });

    // Within the week: throttled by the ask stamp alone.
    const sameWeek = scriptedIo(["x"]);
    await runPostReceiptSignupAsk({ io: sameWeek.io, stateFilePath: file });
    expect(sameWeek.questions).toEqual([]);

    // Eight days on: asked again — the timeout burned no skip.
    const later = scriptedIo([""]);
    await runPostReceiptSignupAsk({
      io: later.io,
      stateFilePath: file,
      now: () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000)
    });
    expect(later.questions).toEqual([signupCopy.askQuestion]);
  });

  it("n persists never-ask and says how to change your mind", async () => {
    const file = await tempStateFile();
    const { io, written } = scriptedIo(["n"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file });
    expect(written).toEqual([signupCopy.neverLine]);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "never" } });
    const again = scriptedIo(["x"]);
    await runPostReceiptSignupAsk({ io: again.io, stateFilePath: file });
    expect(again.questions).toEqual([]);
  });

  it("a typed email shows the scope line, then the LITERAL payload JSON, and sends only on y", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { io, questions, written } = scriptedIo(["  You@Work.COM ", "y"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(questions[1]).toBe('send {"email":"you@work.com","ref":"cli-receipt"} → asktilden.com/api/waitlist? [y/N] ');
    expect(written).toEqual([signupCopy.scopeLine, signupCopy.sentLine]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
      .toBe('{"email":"you@work.com","ref":"cli-receipt"}');
    expect(await readSignupState(file)).toMatchObject({
      kind: "ok",
      state: { status: "subscribed", email: "you@work.com" }
    });
  });

  it("anything but y at the consent step is a skip: nothing is sent", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { io, written } = scriptedIo(["you@work.com", ""]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(written).toEqual([signupCopy.scopeLine]);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 1 } });
  });

  it("send failure prints the offline line and never persists, retries, or queues the email", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const { io, written } = scriptedIo(["you@work.com", "y"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(written).toEqual([signupCopy.scopeLine, signupCopy.unreachableLine]);
    const stateBytes = await readFile(file, "utf8");
    expect(stateBytes).not.toContain("you@work.com");
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred" } });
  });

  it("maps the deployed route's 429 distinctly from offline (M4)", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(429));
    const { io, written } = scriptedIo(["you@work.com", "y"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(written).toEqual([signupCopy.scopeLine, signupCopy.rateLimitedLine]);
  });

  it("an invalid typed email counts as a skip and points at the signup command", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { io, written } = scriptedIo(["not-an-email"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(written).toEqual([`${signupCopy.invalidEmailLine}: npx aibill signup <email>`]);
  });

  it("never asks when the decision could not be persisted (readonly home fails closed)", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-ro-"));
    const file = signupStateFilePath(home);
    await chmod(home, 0o500);
    try {
      const { io, questions } = scriptedIo(["x"]);
      await runPostReceiptSignupAsk({ io, stateFilePath: file });
      expect(questions).toEqual([]);
    } finally {
      await chmod(home, 0o700);
    }
  });

  it("never asks on corrupt state (fail closed, no crash)", async () => {
    const file = await tempStateFile();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "not json at all", "utf8");
    const { io, questions } = scriptedIo(["x"]);
    await runPostReceiptSignupAsk({ io, stateFilePath: file });
    expect(questions).toEqual([]);
  });
});

describe("aibill signup command", () => {
  beforeEach(async () => {
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-signup-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-signup-codex-"));
    process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-signup-gemini-"));
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-signup-home-"));
    process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-signup-codex-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_GEMINI_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CODEX_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });

  it("refuses to send from a non-interactive terminal — no --yes flag exists (QA 2)", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const result = await runCli(["signup", "a@b.co"], {
      homeDirectory: home,
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(signupCopy.nonInteractiveLine);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows the literal payload with the scope line and sends after a typed y", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const prompts: string[] = [];
    const result = await runCli(["signup", "You@Work.com", "--ref", "starfund"], {
      homeDirectory: home,
      interactive: true,
      prompt: async (question) => {
        prompts.push(question);
        return "y";
      },
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(signupCopy.sentLine);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(signupCopy.scopeLine);
    expect(prompts[0]).toContain('send {"email":"you@work.com","ref":"cli-signup-starfund"} → asktilden.com/api/waitlist? [y/N]');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
      .toBe('{"email":"you@work.com","ref":"cli-signup-starfund"}');
    expect(await readSignupState(signupStateFilePath(home)))
      .toMatchObject({ kind: "ok", state: { status: "subscribed", email: "you@work.com" } });
  });

  it("treats Enter at the confirm as a decline and sends nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const result = await runCli(["signup", "a@b.co"], {
      homeDirectory: home,
      interactive: true,
      prompt: async () => "",
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(signupCopy.nothingSentLine);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exits 1 with the mapped line on failure and the email is not persisted", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(429));
    const result = await runCli(["signup", "a@b.co"], {
      homeDirectory: home,
      interactive: true,
      prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(signupCopy.rateLimitedLine);
    expect(await readSignupState(signupStateFilePath(home))).toEqual({ kind: "fresh" });
  });

  it("rejects an injection-shaped --ref before anything else runs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const result = await runCli(["signup", "a@b.co", "--ref", "$(rm -rf ~)"], {
      interactive: true,
      prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--ref must be 1-24 lowercase letters, digits, or dashes");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates the email locally and refuses control bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    for (const email of ["not-an-email", "a\u001b[31m@b.co"]) {
      const result = await runCli(["signup", email], {
        homeDirectory: home,
        interactive: true,
        prompt: async () => "y",
        waitlistFetch: fetchImpl as unknown as typeof fetch
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(signupCopy.invalidEmailLine);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("signup twice reports already on the list without a second send", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const runtime = {
      homeDirectory: home,
      interactive: true,
      prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch
    };
    await runCli(["signup", "a@b.co"], runtime);
    const second = await runCli(["signup", "a@b.co"], runtime);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(signupCopy.alreadyLine);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("--never records never-ask without sending; --forget clears local state only", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const never = await runCli(["signup", "--never"], {
      homeDirectory: home,
      waitlistFetch: fetchImpl as unknown as typeof fetch
    });
    expect(never.exitCode).toBe(0);
    expect(never.stdout).toBe(signupCopy.neverLine);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readSignupState(signupStateFilePath(home))).toMatchObject({ kind: "ok", state: { status: "never" } });

    const forget = await runCli(["signup", "--forget"], { homeDirectory: home });
    expect(forget.exitCode).toBe(0);
    expect(forget.stdout).toBe(signupCopy.forgetLine);
    expect(await readSignupState(signupStateFilePath(home))).toEqual({ kind: "fresh" });
  });

  it("without an email prints usage and sends nothing", async () => {
    const result = await runCli(["signup"], { interactive: true, prompt: async () => "y" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("signup needs an email: npx aibill signup you@work.com [--ref <token>]");
  });
});

describe("surface contracts (QA 11-12)", () => {
  beforeEach(async () => {
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-surface-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-surface-codex-"));
    process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-surface-gemini-"));
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-surface-home-"));
    process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-surface-codex-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
    process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-surface-cache-"));
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_GEMINI_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CODEX_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
    delete process.env.AIBILL_CACHE_DIR;
  });

  async function writeClaudeLogFixture(): Promise<void> {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-Users-testuser-someproject"), { recursive: true });
    await writeFile(join(logsDir, "-Users-testuser-someproject", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      cwd: "/Users/testuser/someproject",
      sessionId: "sess-signup-1",
      requestId: "req-signup-1",
      message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }
    }), "utf8");
  }

  it("marks the REAL receipt for the post-print ask without changing the receipt bytes", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-real-"));
    const result = await runCli(["--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.postReceiptSignupAsk).toBe(true);
    // The ask itself is NOT part of the receipt: it runs after printing.
    expect(result.stdout).not.toContain("type your email");
    expect(result.stdout).not.toContain(signupCopy.scopeLine);
  });

  it("never marks --sample output and carries only the static pointer (safe to GIF)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-sample-"));
    for (const argv of [["--sample", "--path", dir, "--no-color"], ["--sample", "--full", "--path", dir, "--no-color"]]) {
      const result = await runCli(argv);
      expect(result.exitCode).toBe(0);
      expect(result.postReceiptSignupAsk).toBeUndefined();
      expect(result.stdout).toContain(signupCopy.samplePointer);
      expect(result.stdout).not.toContain("type your email");
      expect(result.stdout).not.toContain("[y/N]");
    }
  });

  it("never marks a --group-by drill-down", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-groupby-"));
    const result = await runCli(["--group-by", "project", "--path", dir, "--no-color"]);
    expect(result.postReceiptSignupAsk).toBeUndefined();
  });

  it("no-evidence receipt points at signup without asking and stays unmarked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-empty-"));
    const result = await runCli(["--path", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.postReceiptSignupAsk).toBeUndefined();
    expect(result.stdout).toContain(signupCopy.receiptPointer);
  });

  it("keeps init's strict single next-command exit line last, pointer above", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-init-"));
    const result = await runCli(["init", "--path", dir]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    // Strict single next-command contract: exactly one `next:` line, with
    // the static pointer immediately ABOVE it (never below, never a prompt).
    expect(lines.filter((line) => line.startsWith("next:"))).toEqual(["next: npx aibill doctor --sources"]);
    const nextIndex = lines.indexOf("next: npx aibill doctor --sources");
    expect(lines[nextIndex - 1]).toBe(signupCopy.initPointer);
    expect(result.postReceiptSignupAsk).toBeUndefined();
  });

  it("improve exits carry no signup surface at all (one-command exit contract)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-improve-"));
    const result = await runCli(["improve", "--path", dir]);
    expect(result.postReceiptSignupAsk).toBeUndefined();
    expect(result.stdout).not.toContain("signup");
    expect(result.stdout).not.toContain("launch updates");
  });

  it("keeps the copy kill-list: no urgency, savings, or Workspace-as-shipped in signup strings", () => {
    const everyLine = Object.values(signupCopy)
      .map((value) => typeof value === "function" ? value('{"email":"a@b.co","ref":"cli-signup"}') : value)
      .join("\n")
      .toLowerCase();
    for (const banned of ["last chance", "don't miss", "free forever", "save ", "savings", "roi", "weekly receipt", "workspace access", "beta access"]) {
      expect(everyLine).not.toContain(banned);
    }
    // The claim never overreaches the payload layer (verdict B2).
    expect(everyLine).not.toContain("nothing else left this machine");
  });
});
