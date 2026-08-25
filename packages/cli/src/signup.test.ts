import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import {
  assessEmailDeliverability,
  buildWaitlistRef,
  clearSignupState,
  deployedRefPattern,
  disposableEmailDomains,
  normalizeWaitlistEmail,
  openPreReceiptSignupAsk,
  orchestratePreReceiptAsk,
  postWaitlistSignup,
  qualifiesForPreReceiptSignupAsk,
  readSignupState,
  runSignupConsentAfterReceipt,
  sanitizeSignupRefTag,
  serializeWaitlistPayload,
  signupAskAllowed,
  signupAskBlockLines,
  signupCopy,
  signupStateFilePath,
  waitlistUrl,
  writeSignupState,
  type PreReceiptAskOutcome,
  type PreReceiptAskSession,
  type SignupAskIo,
  type SignupDnsResolver,
  type SignupState
} from "./signup.js";

const creepGuardHint =
  "payload creep — the waitlist body is exactly {email, ref}; see docs/qa-handoff/CLI_CAPTURE_DESIGN.md §3c before adding anything";

function jsonResponse(status: number): Response {
  return new Response(status === 201 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "x" }), { status });
}

const okDns: SignupDnsResolver = {
  resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
  resolve4: async () => ["203.0.113.10"]
};

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

describe("email deliverability (MX + A fallback, fail-open DNS)", () => {
  it("accepts a domain with receiving MX records", async () => {
    expect(await assessEmailDeliverability("a@ok.example", { resolver: okDns })).toBe("ok");
  });

  it("falls back to an A record when MX is absent", async () => {
    const resolver: SignupDnsResolver = {
      resolveMx: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
      resolve4: async () => ["203.0.113.9"]
    };
    expect(await assessEmailDeliverability("a@apex.example", { resolver })).toBe("ok");
  });

  it("rejects only a provable cannot-receive domain (no MX, no A)", async () => {
    const resolver: SignupDnsResolver = {
      resolveMx: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
      resolve4: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); }
    };
    expect(await assessEmailDeliverability("a@nxdomain.example", { resolver })).toBe("no_mx");
  });

  it("treats an RFC 7505 null MX as a refusal to receive", async () => {
    const resolver: SignupDnsResolver = {
      resolveMx: async () => [{ exchange: ".", priority: 0 }],
      resolve4: async () => ["203.0.113.9"]
    };
    expect(await assessEmailDeliverability("a@nullmx.example", { resolver })).toBe("no_mx");
  });

  it("NEVER blocks capture on DNS trouble: timeout and transport errors pass format-only", async () => {
    const slow: SignupDnsResolver = {
      resolveMx: () => new Promise(() => { /* black hole */ }),
      resolve4: async () => ["203.0.113.9"]
    };
    expect(await assessEmailDeliverability("a@slow.example", { resolver: slow, timeoutMs: 20 })).toBe("ok");
    const broken: SignupDnsResolver = {
      resolveMx: async () => { throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }); },
      resolve4: async () => { throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }); }
    };
    expect(await assessEmailDeliverability("a@offline.example", { resolver: broken })).toBe("ok");
  });

  it("shares ONE deadline across MX and the A fallback (QA m3)", async () => {
    const blackHole: SignupDnsResolver = {
      resolveMx: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {})
    };
    const started = Date.now();
    expect(await assessEmailDeliverability("a@slow.example", { resolver: blackHole, timeoutMs: 60 })).toBe("ok");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("treats a resolver EBADNAME as provably undeliverable (QA m4)", async () => {
    const badName: SignupDnsResolver = {
      resolveMx: async () => { throw Object.assign(new Error("EBADNAME"), { code: "EBADNAME" }); },
      resolve4: async () => { throw Object.assign(new Error("EBADNAME"), { code: "EBADNAME" }); }
    };
    expect(await assessEmailDeliverability("a@bad_name.example", { resolver: badName })).toBe("no_mx");
  });

  it("blocks disposable subdomains, not just exact matches (QA m5)", async () => {
    const resolver: SignupDnsResolver = {
      resolveMx: vi.fn(async () => [{ exchange: "mx", priority: 1 }]),
      resolve4: vi.fn(async () => ["203.0.113.9"])
    };
    expect(await assessEmailDeliverability("x@sub.mailinator.com", { resolver })).toBe("disposable");
    expect(await assessEmailDeliverability("x@notmailinator.com", { resolver })).toBe("ok");
    expect(resolver.resolveMx).toHaveBeenCalledTimes(1);
  });

  it("rejects disposable-inbox domains from the static blocklist without any DNS call", async () => {
    const resolver: SignupDnsResolver = {
      resolveMx: vi.fn(async () => [{ exchange: "mx", priority: 1 }]),
      resolve4: vi.fn(async () => ["203.0.113.9"])
    };
    expect(disposableEmailDomains.size).toBeGreaterThanOrEqual(20);
    expect(await assessEmailDeliverability("x@mailinator.com", { resolver })).toBe("disposable");
    expect(await assessEmailDeliverability("x@10minutemail.com", { resolver })).toBe("disposable");
    expect(resolver.resolveMx).not.toHaveBeenCalled();
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

describe("ask block copy (launch window + evergreen fallback)", () => {
  it("pins the launch-week block and its post-launch fallback exactly", () => {
    const launch = signupAskBlockLines(new Date("2026-08-24T12:00:00Z"), 72);
    expect(launch).toEqual([
      "─".repeat(72),
      "  aibill launches Friday with Star.fun.",
      "  Get the launch email + what ships next:",
      "  type your email, or press Enter to skip"
    ]);
    const evergreen = signupAskBlockLines(new Date("2026-08-29T00:00:00Z"), 72);
    expect(evergreen).toEqual([
      "─".repeat(72),
      "  Get product updates:",
      "  type your email, or press Enter to skip"
    ]);
    // Boundary: the Friday line survives through launch day, not past it.
    expect(signupAskBlockLines(new Date("2026-08-28T23:59:59Z"), 72)[1]).toContain("launches Friday");
    expect(signupAskBlockLines(new Date("2026-08-29T00:00:01Z"), 72).join("\n")).not.toContain("Friday");
  });

  it("adapts the rule to the receipt width convention", () => {
    expect(signupAskBlockLines(new Date("2026-08-24T12:00:00Z"), 40)[0]).toBe("─".repeat(40));
    expect(signupAskBlockLines(new Date("2026-08-24T12:00:00Z"), 4)[0]).toBe("─".repeat(8));
  });
});

type ScriptedIo = { io: SignupAskIo; questions: string[]; written: string[]; raws: string[] };

function scriptedIo(answers: Array<string | undefined | (() => Promise<string | undefined>)>): ScriptedIo {
  const questions: string[] = [];
  const written: string[] = [];
  const raws: string[] = [];
  return {
    questions,
    written,
    raws,
    io: {
      question: async (query) => {
        questions.push(query);
        const next = answers.shift();
        return typeof next === "function" ? next() : next;
      },
      write: (line) => written.push(line),
      writeRaw: (text) => raws.push(text)
    }
  };
}

const launchNow = () => new Date("2026-08-24T12:00:00Z");
const expectedBlock = ["", ...signupAskBlockLines(launchNow(), 72)];

async function openAsk(
  file: string,
  scripted: ScriptedIo,
  overrides: Partial<Parameters<typeof openPreReceiptSignupAsk>[0]> = {}
): Promise<PreReceiptAskSession | undefined> {
  return openPreReceiptSignupAsk({
    io: scripted.io,
    stateFilePath: file,
    now: launchNow,
    dnsResolver: okDns,
    ...overrides
  });
}

describe("during-scan pre-receipt ask", () => {
  it("prints the wait line, blank line, and standout block before the prompt", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo([""]);
    const session = await openAsk(file, scripted, { preambleLines: [signupCopy.waitLine] });
    expect(session).toBeDefined();
    await session!.outcome;
    expect(scripted.written.slice(0, 2 + signupAskBlockLines(launchNow(), 72).length)).toEqual([
      signupCopy.waitLine,
      ...expectedBlock
    ]);
    expect(scripted.questions[0]).toBe(signupCopy.askPrompt);
  });

  it("skip takes TWO empty Enters with exactly one declarative nudge, consuming ONE lifetime skip", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo(["", ""]);
    const session = await openAsk(file, scripted);
    expect(await session!.outcome).toEqual({ kind: "skipped" });
    expect(scripted.questions).toEqual([signupCopy.askPrompt, signupCopy.askPrompt]);
    expect(scripted.written).toEqual([...expectedBlock, `  ${signupCopy.skipNudgeLine}`]);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 1 } });
  });

  it("typed input after the first Enter is treated as the email answer", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo(["", "you@work.com"]);
    const session = await openAsk(file, scripted);
    const outcome = await session!.outcome;
    expect(outcome).toMatchObject({ kind: "email", payload: { email: "you@work.com", ref: "cli-receipt" } });
    // The half-completed double-Enter consumed no skip.
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0 } });
  });

  it("stays silent forever after two completed skips, across runs", async () => {
    const file = await tempStateFile();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1_000;
    let clock = Date.parse("2026-09-01T00:00:00Z");
    const now = () => new Date(clock);
    for (const _ of [1, 2]) {
      const scripted = scriptedIo(["", ""]);
      const session = await openPreReceiptSignupAsk({ io: scripted.io, stateFilePath: file, now, dnsResolver: okDns });
      await session!.outcome;
      clock += eightDaysMs;
    }
    const third = scriptedIo(["should-never-be-read"]);
    expect(await openPreReceiptSignupAsk({ io: third.io, stateFilePath: file, now, dnsResolver: okDns })).toBeUndefined();
    expect(third.questions).toEqual([]);
    expect(third.written).toEqual([]);
  });

  it("waits at least 7 days between asks with zero output on suppressed runs", async () => {
    const file = await tempStateFile();
    const first = scriptedIo(["", ""]);
    await (await openAsk(file, first))!.outcome;
    const sameWeek = scriptedIo(["x"]);
    expect(await openAsk(file, sameWeek)).toBeUndefined();
    expect(sameWeek.questions).toEqual([]);
    expect(sameWeek.written).toEqual([]);
  });

  it("a timeout consumes NO lifetime skip but still throttles re-asks (M3)", async () => {
    const file = await tempStateFile();
    const timedOut = scriptedIo([undefined]);
    await (await openAsk(file, timedOut))!.outcome;
    expect(timedOut.written).toEqual(expectedBlock);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 0 } });

    // Within the week: throttled by the ask stamp alone.
    const sameWeek = scriptedIo(["x"]);
    expect(await openAsk(file, sameWeek)).toBeUndefined();

    // Eight days on: asked again — the timeout burned no skip.
    const later = scriptedIo(["", ""]);
    const laterSession = await openPreReceiptSignupAsk({
      io: later.io,
      stateFilePath: file,
      now: () => new Date(launchNow().getTime() + 8 * 24 * 60 * 60 * 1_000),
      dnsResolver: okDns
    });
    expect(laterSession).toBeDefined();
    await laterSession!.outcome;
    expect(later.questions.length).toBeGreaterThan(0);
  });

  it("a timeout after the first Enter (nudge shown) still consumes no skip", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo(["", undefined]);
    const session = await openAsk(file, scripted);
    expect(await session!.outcome).toEqual({ kind: "skipped" });
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0 } });
  });

  it("n persists never-ask and says how to change your mind — at any point in the ask", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo(["", "n"]);
    const session = await openAsk(file, scripted);
    expect(await session!.outcome).toEqual({ kind: "skipped" });
    expect(scripted.written).toContain(`  ${signupCopy.neverLine}`);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "never" } });
    const again = scriptedIo(["x"]);
    expect(await openAsk(file, again)).toBeUndefined();
  });

  it("invalid format, dead domains, and disposable inboxes re-prompt without consuming skips", async () => {
    const file = await tempStateFile();
    const deadDns: SignupDnsResolver = {
      resolveMx: async (domain) => {
        if (domain === "dead.example") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return [{ exchange: "mx.example.com", priority: 10 }];
      },
      resolve4: async (domain) => {
        if (domain === "dead.example") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return ["203.0.113.9"];
      }
    };
    const scripted = scriptedIo(["not-an-email", "a@dead.example", "x@mailinator.com", "you@work.com"]);
    const session = await openAsk(file, scripted, { dnsResolver: deadDns });
    const outcome = await session!.outcome;
    expect(outcome).toMatchObject({ kind: "email", payload: { email: "you@work.com" } });
    expect(scripted.written).toEqual([
      ...expectedBlock,
      `  ${signupCopy.invalidEmailLine}`,
      `  ${signupCopy.noMxLine}`,
      `  ${signupCopy.disposableLine}`
    ]);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0 } });
  });

  it("closes the ask honestly (no skip) after the bounded re-prompt budget", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo(["bad", "bad", "bad", "bad", "bad", "bad", "never-read"]);
    const session = await openAsk(file, scripted);
    expect(await session!.outcome).toEqual({ kind: "skipped" });
    expect(scripted.questions).toHaveLength(6);
    // QA m2: the surface says it is moving on instead of dying silently.
    expect(scripted.written.at(-1)).toBe(`  ${signupCopy.budgetClosedLine}`);
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0 } });
  });

  it("caps lifetime ask openings for perpetual walk-away users (QA m10)", async () => {
    const file = await tempStateFile();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1_000;
    let clock = Date.parse("2026-09-01T00:00:00Z");
    const now = () => new Date(clock);
    for (let opening = 0; opening < 6; opening += 1) {
      const scripted = scriptedIo([undefined]); // walk away every time
      const session = await openPreReceiptSignupAsk({ io: scripted.io, stateFilePath: file, now, dnsResolver: okDns });
      expect(session, `opening ${opening + 1}`).toBeDefined();
      await session!.outcome;
      clock += eightDaysMs;
    }
    // Timeouts consumed no skips, but the stamp ceiling now ends the asks.
    const seventh = scriptedIo(["never-read"]);
    expect(await openPreReceiptSignupAsk({ io: seventh.io, stateFilePath: file, now, dnsResolver: okDns })).toBeUndefined();
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0, stampCount: 6 } });
  });

  it("never asks when the decision could not be persisted (readonly home fails closed)", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-ro-"));
    const file = signupStateFilePath(home);
    await chmod(home, 0o500);
    try {
      const scripted = scriptedIo(["x"]);
      expect(await openAsk(file, scripted)).toBeUndefined();
      expect(scripted.questions).toEqual([]);
      expect(scripted.written).toEqual([]);
    } finally {
      await chmod(home, 0o700);
    }
  });

  it("never asks on corrupt state (fail closed, no crash)", async () => {
    const file = await tempStateFile();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "not json at all", "utf8");
    const scripted = scriptedIo(["x"]);
    expect(await openAsk(file, scripted)).toBeUndefined();
  });
});

describe("consent after the receipt", () => {
  async function emailOutcome(file: string, answers: Array<string | undefined>): Promise<{
    outcome: Extract<PreReceiptAskOutcome, { kind: "email" }>;
    scripted: ScriptedIo;
  }> {
    const scripted = scriptedIo(["you@work.com", ...answers]);
    const session = await openAsk(file, scripted);
    const outcome = await session!.outcome as Extract<PreReceiptAskOutcome, { kind: "email" }>;
    expect(outcome.kind).toBe("email");
    return { outcome, scripted };
  }

  it("shows the scope line, then the LITERAL payload JSON, and sends only on y", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { outcome, scripted } = await emailOutcome(file, ["y"]);
    await runSignupConsentAfterReceipt({
      io: scripted.io,
      stateFilePath: file,
      payload: outcome.payload,
      stamped: outcome.stamped,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(scripted.questions[1]).toBe('send {"email":"you@work.com","ref":"cli-receipt"} → asktilden.com/api/waitlist? [y/N] ');
    expect(scripted.written.slice(expectedBlock.length)).toEqual(["", signupCopy.scopeLine, signupCopy.sentLine]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
      .toBe('{"email":"you@work.com","ref":"cli-receipt"}');
    expect(await readSignupState(file)).toMatchObject({
      kind: "ok",
      state: { status: "subscribed", email: "you@work.com" }
    });
  });

  it("anything but y at the consent step is a decline: nothing sent, one skip", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { outcome, scripted } = await emailOutcome(file, [""]);
    await runSignupConsentAfterReceipt({
      io: scripted.io, stateFilePath: file, payload: outcome.payload, stamped: outcome.stamped,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 1 } });
  });

  it("a consent timeout decides nothing and consumes no skip", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const { outcome, scripted } = await emailOutcome(file, [undefined]);
    await runSignupConsentAfterReceipt({
      io: scripted.io, stateFilePath: file, payload: outcome.payload, stamped: outcome.stamped,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { status: "deferred", askCount: 0 } });
  });

  it("send failure prints the mapped line and never persists, retries, or queues the email", async () => {
    const file = await tempStateFile();
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const { outcome, scripted } = await emailOutcome(file, ["y"]);
    await runSignupConsentAfterReceipt({
      io: scripted.io, stateFilePath: file, payload: outcome.payload, stamped: outcome.stamped,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(scripted.written.at(-1)).toBe(signupCopy.unreachableLine);
    const stateBytes = await readFile(file, "utf8");
    expect(stateBytes).not.toContain("you@work.com");

    const busy = vi.fn(async () => jsonResponse(429));
    const second = await emailOutcome(await tempStateFile(), ["y"]);
    await runSignupConsentAfterReceipt({
      io: second.scripted.io, stateFilePath: file, payload: second.outcome.payload, stamped: second.outcome.stamped,
      fetchImpl: busy as unknown as typeof fetch
    });
    expect(second.scripted.written.at(-1)).toBe(signupCopy.rateLimitedLine);
  });
});

describe("during-scan orchestration", () => {
  function manualSession(): {
    session: PreReceiptAskSession;
    resolveOutcome: (outcome: PreReceiptAskOutcome) => void;
    readyNudges: number[];
  } {
    let resolveOutcome!: (outcome: PreReceiptAskOutcome) => void;
    const readyNudges: number[] = [];
    let settled = false;
    const outcome = new Promise<PreReceiptAskOutcome>((resolve) => {
      resolveOutcome = (value) => {
        settled = true;
        resolve(value);
      };
    });
    return {
      session: {
        outcome,
        notifyReceiptReady: () => {
          if (!settled) readyNudges.push(Date.now());
        }
      },
      resolveOutcome,
      readyNudges
    };
  }

  it("fast-scan-first: the ready nudge fires once and the receipt waits for the answer", async () => {
    const { session, resolveOutcome, readyNudges } = manualSession();
    const order: string[] = [];
    const run = orchestratePreReceiptAsk({
      session,
      runPipeline: async () => {
        order.push("pipeline-done");
        return "receipt";
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readyNudges).toHaveLength(1);
    order.push("answering");
    resolveOutcome({ kind: "skipped" });
    const { pipeline, outcome } = await run;
    expect(order).toEqual(["pipeline-done", "answering"]);
    expect(pipeline).toEqual({ ok: true, value: "receipt" });
    expect(outcome).toEqual({ kind: "skipped" });
  });

  it("slow-scan-first: the answer lands first, no nudge, and the receipt waits for the pipeline", async () => {
    const { session, resolveOutcome, readyNudges } = manualSession();
    resolveOutcome({ kind: "skipped" });
    const run = orchestratePreReceiptAsk({
      session,
      runPipeline: () => new Promise((resolve) => setTimeout(() => resolve("late receipt"), 30))
    });
    const { pipeline } = await run;
    expect(pipeline).toEqual({ ok: true, value: "late receipt" });
    expect(readyNudges).toHaveLength(0);
  });

  it("error-during-ask: the pipeline error is captured, the bounded ask still resolves, nothing hangs", async () => {
    const { session, resolveOutcome, readyNudges } = manualSession();
    const run = orchestratePreReceiptAsk({
      session,
      runPipeline: async () => { throw new Error("scan exploded"); }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveOutcome({ kind: "skipped" });
    const { pipeline, outcome } = await run;
    expect(pipeline.ok).toBe(false);
    expect((pipeline as { ok: false; error: Error }).error.message).toBe("scan exploded");
    expect(outcome).toEqual({ kind: "skipped" });
    // QA m1: "your receipt is ready" must never announce an error.
    expect(readyNudges).toHaveLength(0);
  });

  it("interrupt: an immediately-aborted read resolves as skipped with no skip consumed", async () => {
    const file = await tempStateFile();
    const scripted = scriptedIo([undefined]);
    const session = await openAsk(file, scripted);
    const { pipeline, outcome } = await orchestratePreReceiptAsk({
      session,
      runPipeline: async () => "receipt"
    });
    expect(pipeline).toEqual({ ok: true, value: "receipt" });
    expect(outcome).toEqual({ kind: "skipped" });
    expect(await readSignupState(file)).toMatchObject({ kind: "ok", state: { askCount: 0 } });
  });

  it("no session: pipeline result passes straight through", async () => {
    const { pipeline, outcome } = await orchestratePreReceiptAsk({
      session: undefined,
      runPipeline: async () => 42
    });
    expect(pipeline).toEqual({ ok: true, value: 42 });
    expect(outcome).toEqual({ kind: "no_ask" });
  });

  it("the ready nudge redraws the prompt through the io", async () => {
    const file = await tempStateFile();
    let answer!: (value: string | undefined) => void;
    const pending = new Promise<string | undefined>((resolve) => { answer = resolve; });
    const scripted = scriptedIo([() => pending]);
    const session = await openAsk(file, scripted);
    const run = orchestratePreReceiptAsk({ session, runPipeline: async () => "receipt" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scripted.written).toContain(`  ${signupCopy.receiptReadyLine}`);
    expect(scripted.raws).toEqual([signupCopy.askPrompt]);
    answer("");
    answer = () => undefined;
    // Second empty Enter completes the skip.
    const { outcome } = await run;
    // The scripted io only had one pending answer; a nudged Enter then a
    // bounded follow-up read that returns undefined is still a clean skip.
    expect(["skipped"]).toContain(outcome.kind);
  });
});

describe("argv qualification (real receipt path only)", () => {
  it("qualifies default/quickstart/flag-form runs and nothing else", () => {
    expect(qualifiesForPreReceiptSignupAsk([])).toBe(true);
    expect(qualifiesForPreReceiptSignupAsk(["quickstart"])).toBe(true);
    expect(qualifiesForPreReceiptSignupAsk(["demo"])).toBe(true);
    expect(qualifiesForPreReceiptSignupAsk(["--full"])).toBe(true);
    expect(qualifiesForPreReceiptSignupAsk(["--since-days", "7"])).toBe(true);
    expect(qualifiesForPreReceiptSignupAsk(["--path", "."])).toBe(true);

    expect(qualifiesForPreReceiptSignupAsk(["--sample"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["--sample", "--full"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["--group-by", "project"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["--json"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["--version"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["-v"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["--help"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["improve"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["report"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["init"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["statusline"])).toBe(false);
    expect(qualifiesForPreReceiptSignupAsk(["signup", "a@b.co"])).toBe(false);
  });
});

describe("aibill signup command", () => {
  it("refuses to send from a non-interactive terminal — no --yes flag exists (QA 2)", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const result = await runCli(["signup", "a@b.co"], {
      homeDirectory: home,
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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
        waitlistFetch: fetchImpl as unknown as typeof fetch,
        signupDns: okDns
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(signupCopy.invalidEmailLine);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses provably-dead and disposable domains with the exact copy", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const deadDns: SignupDnsResolver = {
      resolveMx: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
      resolve4: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); }
    };
    const dead = await runCli(["signup", "a@dead.example"], {
      homeDirectory: home, interactive: true, prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch, signupDns: deadDns
    });
    expect(dead.exitCode).toBe(1);
    expect(dead.stderr).toBe(signupCopy.noMxLine);

    const disposable = await runCli(["signup", "a@mailinator.com"], {
      homeDirectory: home, interactive: true, prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch, signupDns: okDns
    });
    expect(disposable.exitCode).toBe(1);
    expect(disposable.stderr).toBe(signupCopy.disposableLine);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("signup twice reports already on the list without a second send", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-signup-cmd-"));
    const fetchImpl = vi.fn(async () => jsonResponse(201));
    const runtime = {
      homeDirectory: home,
      interactive: true,
      prompt: async () => "y",
      waitlistFetch: fetchImpl as unknown as typeof fetch,
      signupDns: okDns
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

  it("keeps the real receipt bytes free of any ask copy (the ask lives outside runCli)", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-real-"));
    const result = await runCli(["--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill · LOCAL ESTIMATE");
    expect(result.stdout).not.toContain("type your email");
    expect(result.stdout).not.toContain(signupCopy.scopeLine);
    expect(result.stdout).not.toContain("launches Friday");
    expect(result.stdout).not.toContain("[y/N]");
  });

  it("--sample output carries only the static pointer — no ask, no prompt (safe to GIF)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-sample-"));
    for (const argv of [["--sample", "--path", dir, "--no-color"], ["--sample", "--full", "--path", dir, "--no-color"]]) {
      const result = await runCli(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(signupCopy.samplePointer);
      expect(result.stdout).not.toContain("type your email");
      expect(result.stdout).not.toContain("[y/N]");
    }
  });

  it("no-evidence receipt points at signup without asking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-empty-"));
    const result = await runCli(["--path", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(signupCopy.receiptPointer);
    expect(result.stdout).not.toContain("type your email");
  });

  it("keeps init's strict single next-command exit line last, pointer above", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-init-"));
    const result = await runCli(["init", "--path", dir]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.filter((line) => line.startsWith("next:"))).toEqual(["next: npx aibill doctor --sources"]);
    const nextIndex = lines.indexOf("next: npx aibill doctor --sources");
    expect(lines[nextIndex - 1]).toBe(signupCopy.initPointer);
  });

  it("improve exits carry no signup surface at all (one-command exit contract)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-surface-improve-"));
    const result = await runCli(["improve", "--path", dir]);
    expect(result.stdout).not.toContain("signup");
    expect(result.stdout).not.toContain("launch updates");
    expect(result.stdout).not.toContain("launches Friday");
  });

  it("keeps the copy kill-list: no urgency, savings, confirm-shaming, or Workspace-as-shipped", () => {
    const flatten = (value: unknown): string[] =>
      typeof value === "function"
        ? [(value as (json: string) => string)('{"email":"a@b.co","ref":"cli-signup"}')]
        : Array.isArray(value)
          ? value as string[]
          : [value as string];
    const everyLine = [
      ...Object.values(signupCopy).flatMap(flatten),
      ...signupAskBlockLines(new Date("2026-08-24T12:00:00Z"), 72),
      ...signupAskBlockLines(new Date("2026-09-15T12:00:00Z"), 72)
    ].join("\n").toLowerCase();
    for (const banned of [
      "last chance", "don't miss", "free forever", "save ", "savings", "roi",
      "weekly receipt", "workspace access", "beta access", "sure?", "launch drop"
    ]) {
      expect(everyLine).not.toContain(banned);
    }
    // The claim never overreaches the payload layer (verdict B2).
    expect(everyLine).not.toContain("nothing else left this machine");
  });
});
