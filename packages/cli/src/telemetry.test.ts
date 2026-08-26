import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import { readSignupState, signupStateFilePath, writeSignupState } from "./signup.js";
import {
  buildDetachedTelemetrySendScript,
  killTelemetryForThisProcess,
  openCliTelemetry,
  resetTelemetrySessionKillForTests,
  sendTelemetryDetached,
  postTelemetryBatch,
  readTelemetryState,
  serializeTelemetryBatch,
  serializeTelemetryEvent,
  telemetryArchLabel,
  telemetryBatchMaxBytes,
  telemetryBatchMaxEvents,
  telemetryCommandForArgv,
  telemetryCommands,
  telemetryDisclosureLine,
  telemetryDurationBucket,
  telemetryEnvDisabled,
  telemetryNoticeLines,
  telemetryOsLabel,
  telemetryStateFilePath,
  telemetryUrl,
  writeTelemetryState,
  type TelemetryEvent,
  type TelemetryState
} from "./telemetry.js";

afterEach(() => {
  // The M1 kill switch is process-scoped by design; tests must not leak it.
  resetTelemetrySessionKillForTests();
});

const creepHint =
  "telemetry payload creep — the event is exactly {installId, command, version, os, arch, ci, durationBucket, ok, ts}; see docs/TELEMETRY.md before adding anything";

const fixedEvent: TelemetryEvent = {
  installId: "3f2b8a90-1c4d-4e5f-8a6b-7c8d9e0f1a2b",
  command: "receipt",
  version: "0.9.2",
  os: "darwin",
  arch: "arm64",
  ci: false,
  durationBucket: "lt5s",
  ok: true,
  ts: "2026-08-25T10:00:00.000Z"
};

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aibill-telemetry-home-"));
}

function okResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("telemetry payload contract (CI creep guard)", () => {
  it("pins the serialized event byte shape and key order", () => {
    expect(serializeTelemetryEvent(fixedEvent), creepHint).toBe(
      '{"installId":"3f2b8a90-1c4d-4e5f-8a6b-7c8d9e0f1a2b","command":"receipt","version":"0.9.2","os":"darwin","arch":"arm64","ci":false,"durationBucket":"lt5s","ok":true,"ts":"2026-08-25T10:00:00.000Z"}'
    );
    expect(Object.keys(JSON.parse(serializeTelemetryEvent(fixedEvent)) as object), creepHint).toEqual([
      "installId", "command", "version", "os", "arch", "ci", "durationBucket", "ok", "ts"
    ]);
  });

  it("pins the batch wrapper and the endpoint caps (≤10 events, ≤4096 bytes)", () => {
    expect(serializeTelemetryBatch([fixedEvent]), creepHint).toBe(`{"events":[${serializeTelemetryEvent(fixedEvent)}]}`);
    expect(telemetryBatchMaxEvents).toBe(10);
    expect(telemetryBatchMaxBytes).toBe(4096);
    expect(serializeTelemetryBatch([])).toBeUndefined();
    expect(serializeTelemetryBatch(Array.from({ length: 11 }, () => fixedEvent))).toBeUndefined();
    const bloated = { ...fixedEvent, version: "9".repeat(5_000) };
    expect(serializeTelemetryBatch([bloated])).toBeUndefined();
  });

  it("sends one POST with pinned url/headers/body, silent and single on every outcome", async () => {
    const body = serializeTelemetryBatch([fixedEvent])!;
    for (const status of [204, 400, 429, 500]) {
      const fetchImpl = vi.fn(async () => okResponse(status));
      await postTelemetryBatch(body, { fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(telemetryUrl);
      expect(url).toBe("https://asktilden.com/api/telemetry");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "content-type": "application/json", "user-agent": "aibill-cli" });
      expect(init.body).toBe(body);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const failing = vi.fn(async () => { throw new Error("network down"); });
    await expect(postTelemetryBatch(body, { fetchImpl: failing as unknown as typeof fetch })).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("aborts a black-holed request within its budget and never blocks", async () => {
    const blackHole = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const started = Date.now();
    await postTelemetryBatch(serializeTelemetryBatch([fixedEvent])!, {
      fetchImpl: blackHole as unknown as typeof fetch,
      timeoutMs: 50
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("command mapping and buckets", () => {
  it("maps argv to the server allowlist without ever passing values or paths", () => {
    expect(telemetryCommandForArgv([])).toBe("receipt");
    expect(telemetryCommandForArgv(["quickstart"])).toBe("receipt");
    expect(telemetryCommandForArgv(["--full"])).toBe("full");
    expect(telemetryCommandForArgv(["--group-by", "project"])).toBe("group-by");
    expect(telemetryCommandForArgv(["--sample"])).toBe("other");
    expect(telemetryCommandForArgv(["--sample", "--full"])).toBe("other");
    expect(telemetryCommandForArgv(["improve"])).toBe("improve");
    expect(telemetryCommandForArgv(["improve", "--sample"])).toBe("improve-sample");
    expect(telemetryCommandForArgv(["statusline"])).toBe("statusline");
    expect(telemetryCommandForArgv(["statusline", "expand"])).toBe("statusline-expand");
    expect(telemetryCommandForArgv(["signup", "you@work.com"])).toBe("signup");
    expect(telemetryCommandForArgv(["apply-artifact"])).toBe("apply");
    expect(telemetryCommandForArgv(["telemetry"])).toBe("telemetry");
    expect(telemetryCommandForArgv(["--version"])).toBe("other");
    expect(telemetryCommandForArgv(["scan"])).toBe("other");
    expect(telemetryCommandForArgv(["definitely-not-a-command"])).toBe("other");
    for (const argv of [["--path", "/Users/testuser/secretproj"], ["report", "--out", "secret.md"]]) {
      const mapped = telemetryCommandForArgv(argv);
      expect(telemetryCommands).toContain(mapped);
      expect(mapped).not.toContain("secretproj");
    }
  });

  it("buckets durations at the documented boundaries", () => {
    expect(telemetryDurationBucket(0)).toBe("lt1s");
    expect(telemetryDurationBucket(999)).toBe("lt1s");
    expect(telemetryDurationBucket(1_000)).toBe("lt5s");
    expect(telemetryDurationBucket(4_999)).toBe("lt5s");
    expect(telemetryDurationBucket(5_000)).toBe("lt30s");
    expect(telemetryDurationBucket(29_999)).toBe("lt30s");
    expect(telemetryDurationBucket(30_000)).toBe("gte30s");
  });

  it("collapses os/arch to the contract labels", () => {
    expect(telemetryOsLabel("darwin")).toBe("darwin");
    expect(telemetryOsLabel("freebsd")).toBe("other");
    expect(telemetryArchLabel("arm64")).toBe("arm64");
    expect(telemetryArchLabel("ia32")).toBe("other");
  });
});

describe("kill-switches and fail-closed state", () => {
  it("any non-empty DO_NOT_TRACK / CI / AI_SPEND_NO_TELEMETRY disables telemetry", () => {
    expect(telemetryEnvDisabled({})).toBe(false);
    expect(telemetryEnvDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryEnvDisabled({ CI: "true" })).toBe(true);
    expect(telemetryEnvDisabled({ AI_SPEND_NO_TELEMETRY: "yes" })).toBe(true);
    expect(telemetryEnvDisabled({ DO_NOT_TRACK: "" })).toBe(false);
  });

  it("corrupt, malformed, or unreadable state reads as unreadable → telemetry off", async () => {
    const home = await tempHome();
    const file = telemetryStateFilePath(home);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{not json", "utf8");
    expect((await readTelemetryState(file)).kind).toBe("unreadable");
    await writeFile(file, JSON.stringify({ version: 1, installId: "not-a-uuid", enabled: true }), "utf8");
    expect((await readTelemetryState(file)).kind).toBe("unreadable");
    await writeFile(file, JSON.stringify({ version: 1, installId: fixedEvent.installId, enabled: true }), "utf8");
    await chmod(file, 0o000);
    try {
      expect((await readTelemetryState(file)).kind).toBe("unreadable");
    } finally {
      await chmod(file, 0o600);
    }

    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    // chmod restored above, so re-open on corrupt content instead:
    await writeFile(file, "{not json", "utf8");
    const corrupt = await openCliTelemetry({ homeDirectory: home, env: {} });
    expect(corrupt.disclosureActive).toBe(false);
    const fetchImpl = vi.fn(async () => okResponse());
    const printed: string[][] = [];
    await corrupt.finish({
      argv: [], ok: true, durationMs: 10, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: (lines) => printed.push([...lines])
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(printed).toEqual([]);
    void runtime;
  });
});

describe("notice-before-first-byte", () => {
  it("run 1 (interactive): prints the three-line notice, stamps state, sends NOTHING", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async () => okResponse());
    const printed: string[][] = [];
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {}, now: () => new Date("2026-08-25T10:00:00Z") });
    expect(runtime.disclosureActive).toBe(false);
    await runtime.finish({
      argv: [], ok: true, durationMs: 100, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: (lines) => printed.push([...lines])
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(printed).toEqual([[...telemetryNoticeLines]]);
    expect(telemetryNoticeLines).toHaveLength(3);
    const read = await readTelemetryState(telemetryStateFilePath(home));
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.state.enabled).toBe(true);
      expect(read.state.noticedAt).toBe("2026-08-25T10:00:00.000Z");
      expect(read.state.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(read.state.lastPayload).toBeUndefined();
    }
  });

  it("run 2 (after notice): emits exactly one event and caches the verbatim payload first", async () => {
    const home = await tempHome();
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });

    const fetchImpl = vi.fn(async () => okResponse());
    const second = await openCliTelemetry({ homeDirectory: home, env: {}, now: () => new Date("2026-08-25T11:00:00Z") });
    expect(second.disclosureActive).toBe(true);
    const printed: string[][] = [];
    await second.finish({
      argv: ["--full"], ok: true, durationMs: 1_500, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: (lines) => printed.push([...lines])
    });

    expect(printed).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as string;
    const parsed = JSON.parse(body) as { events: Array<Record<string, unknown>> };
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      command: "full",
      version: "0.9.2",
      os: telemetryOsLabel(),
      ci: false,
      durationBucket: "lt5s",
      ok: true,
      ts: "2026-08-25T11:00:00.000Z"
    });
    const read = await readTelemetryState(telemetryStateFilePath(home));
    expect(read.kind === "ok" && read.state.lastPayload).toBe(body);
  });

  it("caches the payload verbatim even when the send fails (drop-and-forget)", async () => {
    const home = await tempHome();
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });
    const failing = vi.fn(async () => { throw new Error("offline"); });
    const second = await openCliTelemetry({ homeDirectory: home, env: {} });
    await second.finish({
      argv: ["doctor"], ok: false, durationMs: 40_000, interactive: false, version: "0.9.2",
      fetchImpl: failing as unknown as typeof fetch
    });
    expect(failing).toHaveBeenCalledTimes(1);
    const read = await readTelemetryState(telemetryStateFilePath(home));
    expect(read.kind === "ok" && typeof read.state.lastPayload === "string").toBe(true);
    if (read.kind === "ok" && read.state.lastPayload) {
      expect(read.state.lastPayload).toContain('"command":"doctor"');
      expect(read.state.lastPayload).toContain('"durationBucket":"gte30s"');
      expect(read.state.lastPayload).toContain('"ok":false');
    }
  });

  it("a user who has never seen the notice is never tracked (non-interactive first runs)", async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async () => okResponse());
    for (const _ of [1, 2, 3]) {
      const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
      await runtime.finish({
        argv: [], ok: true, durationMs: 10, interactive: false, version: "0.9.2",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        printNotice: () => { throw new Error("must not print on non-interactive runs"); }
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readTelemetryState(telemetryStateFilePath(home))).toEqual({ kind: "fresh" });
  });

  it("env kill-switches stop events AND the notice, even after noticing", async () => {
    const home = await tempHome();
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });

    for (const env of [{ DO_NOT_TRACK: "1" }, { CI: "true" }, { AI_SPEND_NO_TELEMETRY: "1" }]) {
      const fetchImpl = vi.fn(async () => okResponse());
      const runtime = await openCliTelemetry({ homeDirectory: home, env });
      expect(runtime.disclosureActive).toBe(false);
      await runtime.finish({
        argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        printNotice: () => { throw new Error("no notice under kill-switch"); }
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a `telemetry off` in the SAME run is honored: no emit, no notice, no clobber", async () => {
    // Regression: finish() once merged its open-time snapshot back into the
    // state file, resurrecting enabled:true after the off switch and
    // emitting an event for the off run itself.
    const home = await tempHome();
    const noticedState: TelemetryState = {
      version: 1, installId: fixedEvent.installId, enabled: true, noticedAt: "2026-08-24T10:00:00.000Z"
    };
    await writeTelemetryState(telemetryStateFilePath(home), noticedState);
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    expect(runtime.disclosureActive).toBe(true);
    // The command that ran this process turned telemetry off before finish.
    const off = await runCli(["telemetry", "off"], { homeDirectory: home });
    expect(off.exitCode).toBe(0);
    const fetchImpl = vi.fn(async () => okResponse());
    await runtime.finish({
      argv: ["telemetry", "off"], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: () => { throw new Error("no notice after off"); }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readTelemetryState(telemetryStateFilePath(home))).toMatchObject({
      kind: "ok",
      state: { enabled: false }
    });

    // And a fresh-state `telemetry off` first run must not get the notice
    // stamped over it either.
    const home2 = await tempHome();
    const fresh = await openCliTelemetry({ homeDirectory: home2, env: {} });
    await runCli(["telemetry", "off"], { homeDirectory: home2 });
    await fresh.finish({
      argv: ["telemetry", "off"], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      printNotice: () => { throw new Error("no notice after off"); }
    });
    expect(await readTelemetryState(telemetryStateFilePath(home2))).toMatchObject({
      kind: "ok",
      state: { enabled: false }
    });
  });

  it("a `telemetry on` run stamps its own notice and emits nothing until the NEXT run", async () => {
    const home = await tempHome();
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    const on = await runCli(["telemetry", "on"], { homeDirectory: home });
    expect(on.exitCode).toBe(0);
    const fetchImpl = vi.fn(async () => okResponse());
    await runtime.finish({
      argv: ["telemetry", "on"], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: () => { throw new Error("the on command already noticed; no extra notice") }
    });
    // Open-time snapshot was un-noticed, so this run emits nothing…
    expect(fetchImpl).not.toHaveBeenCalled();
    // …and the on-stamp survives untouched.
    expect(await readTelemetryState(telemetryStateFilePath(home))).toMatchObject({
      kind: "ok",
      state: { enabled: true }
    });
    // The NEXT run emits.
    const next = await openCliTelemetry({ homeDirectory: home, env: {} });
    expect(next.disclosureActive).toBe(true);
    await next.finish({
      argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("disabled state stops events and the notice", async () => {
    const home = await tempHome();
    const state: TelemetryState = { version: 1, installId: fixedEvent.installId, enabled: false };
    expect(await writeTelemetryState(telemetryStateFilePath(home), state)).toBe(true);
    const fetchImpl = vi.fn(async () => okResponse());
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    expect(runtime.disclosureActive).toBe(false);
    await runtime.finish({
      argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: () => { throw new Error("no notice when disabled"); }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("aibill telemetry command", () => {
  it("off/on switch state with honest copy; status shows the exact last payload verbatim", async () => {
    const home = await tempHome();
    const off = await runCli(["telemetry", "off"], { homeDirectory: home });
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toBe("telemetry off · nothing is sent");
    expect(await readTelemetryState(telemetryStateFilePath(home))).toMatchObject({
      kind: "ok",
      state: { enabled: false }
    });

    const on = await runCli(["telemetry", "on"], { homeDirectory: home });
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain("telemetry on · anonymous command counts only");
    expect(on.stdout).toContain("never: arguments, paths, file contents, project names, or your email");

    const payload = serializeTelemetryBatch([fixedEvent])!;
    const read = await readTelemetryState(telemetryStateFilePath(home));
    if (read.kind === "ok") {
      await writeTelemetryState(telemetryStateFilePath(home), { ...read.state, lastPayload: payload });
    }
    const status = await runCli(["telemetry"], { homeDirectory: home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("status: on · noticed ");
    expect(status.stdout).toContain("last payload sent (verbatim):");
    expect(status.stdout).toContain(payload);

    const unknown = await runCli(["telemetry", "sideways"], { homeDirectory: home });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Use: npx aibill telemetry [on|off]");
  });

  it("fresh status is honest about never having sent anything", async () => {
    const home = await tempHome();
    const status = await runCli(["telemetry"], { homeDirectory: home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("status: not yet noticed · nothing has ever been sent");
    expect(status.stdout).toContain("last payload sent: none");
  });
});

describe("receipt-line truth (both states pinned)", () => {
  beforeEach(async () => {
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-tel-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-tel-codex-"));
    process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-tel-gemini-"));
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-tel-home-"));
    process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-tel-codex-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
    process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-tel-cache-"));
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
      sessionId: "sess-tel-1",
      requestId: "req-tel-1",
      message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }
    }), "utf8");
  }

  it("the real receipt swaps 'nothing uploaded' for the disclosure line only when telemetry is active", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-tel-real-"));

    const flatten = (text: string) => text.replace(/\s+/gu, " ");
    const off = await runCli(["--path", dir, "--no-color"]);
    expect(off.stdout).toContain("nothing uploaded");
    expect(off.stdout).not.toContain("anonymous command counts");

    const on = await runCli(["--path", dir, "--no-color"], { telemetryDisclosure: true });
    // The receipt wraps at terminal width, so assert on flattened text.
    expect(flatten(on.stdout)).toContain(telemetryDisclosureLine);
    expect(flatten(on.stdout)).not.toContain("nothing uploaded");
  });

  it("no-evidence, context, init, and help surfaces swap in both directions too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-tel-empty-"));

    const emptyOff = await runCli(["--path", dir]);
    expect(emptyOff.stdout).toContain("Nothing was uploaded. No sample data was substituted.");
    const emptyOn = await runCli(["--path", dir], { telemetryDisclosure: true });
    expect(emptyOn.stdout).toContain(`${telemetryDisclosureLine} No sample data was substituted.`);
    expect(emptyOn.stdout).not.toContain("Nothing was uploaded.");

    const contextOff = await runCli(["context", "--path", dir]);
    expect(contextOff.stdout).toContain("Privacy: this CLI run uploads nothing.");
    const contextOn = await runCli(["context", "--path", dir], { telemetryDisclosure: true });
    expect(contextOn.stdout).toContain(`Privacy: ${telemetryDisclosureLine}`);
    expect(contextOn.stdout).not.toContain("uploads nothing");

    const initDir = await mkdtemp(join(tmpdir(), "ai-spend-tel-init-"));
    const statuslineHome = await mkdtemp(join(tmpdir(), "ai-spend-tel-init-home-"));
    const initOn = await runCli(["init", "--path", initDir], { homeDirectory: statuslineHome, telemetryDisclosure: true });
    expect(initOn.stdout).toContain(`private local aggregate · ${telemetryDisclosureLine}`);
    expect(initOn.stdout).not.toContain("nothing uploaded`");

    const helpOff = await runCli(["--help"]);
    expect(helpOff.stdout).toContain("Privacy: local analysis and reports upload nothing. Only explicit");
    const helpOn = await runCli(["--help"], { telemetryDisclosure: true });
    expect(helpOn.stdout).toContain("anonymous command counts shared · npx aibill telemetry off");
  });

  it("doctor and report surfaces disclose in both states — including the generated md/html files (QA B1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-tel-b1-"));
    await runCli(["scan", "--sample", "--path", dir]);

    const doctorOff = await runCli(["doctor", "--path", dir]);
    expect(doctorOff.stdout).toContain("local-first mode: enabled (no cloud upload, no telemetry)");
    const doctorOn = await runCli(["doctor", "--path", dir], { telemetryDisclosure: true });
    expect(doctorOn.stdout).toContain("evidence stays local · anonymous command counts shared · npx aibill telemetry off");
    expect(doctorOn.stdout).not.toContain("no telemetry)");

    const reportOff = await runCli(["report", "--path", dir]);
    expect(reportOff.exitCode).toBe(0);
    // 0.9.5: the summary renders a "Privacy" label row that wraps at terminal
    // width, so the claim is pinned whitespace-normalized.
    expect(reportOff.stdout.replace(/\s+/gu, " ")).toContain("Privacy report rendered locally with no aibill telemetry");
    const markdownOff = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const htmlOff = await readFile(join(dir, ".ai-spend-agent", "report.html"), "utf8");
    expect(markdownOff).toContain("Report rendered locally with no aibill telemetry.");
    expect(htmlOff).toContain("No aibill telemetry.");
    expect(htmlOff).not.toContain("anonymous command counts");

    const reportOn = await runCli(["report", "--path", dir], { telemetryDisclosure: true });
    expect(reportOn.exitCode).toBe(0);
    expect(reportOn.stdout.replace(/\s+/gu, " ")).toContain("Privacy report rendered locally · anonymous command counts shared · npx aibill telemetry off");
    expect(reportOn.stdout).not.toContain("no aibill telemetry");
    const markdownOn = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const htmlOn = await readFile(join(dir, ".ai-spend-agent", "report.html"), "utf8");
    // Persistent, shareable artifacts must state what their generating run did.
    expect(markdownOn).toContain("the generating run shared anonymous command counts (npx aibill telemetry off to disable)");
    expect(markdownOn).not.toContain("no aibill telemetry");
    expect(htmlOn).toContain("The generating run shared anonymous command counts");
    expect(htmlOn).not.toContain("No aibill telemetry.");

    // The local-logs html variant carries the claim in its terminal-frame
    // footer instead of the banner — both directions there too.
    await writeClaudeLogFixture();
    const logsDir = await mkdtemp(join(tmpdir(), "ai-spend-tel-b1-logs-"));
    const localOff = await runCli(["report", "--path", logsDir]);
    expect(localOff.exitCode).toBe(0);
    const localHtmlOff = await readFile(join(logsDir, ".ai-spend-agent", "report.html"), "utf8");
    expect(localHtmlOff).toContain("no aibill telemetry");
    expect(localHtmlOff).not.toContain("anonymous command counts");
    const localOn = await runCli(["report", "--path", logsDir], { telemetryDisclosure: true });
    expect(localOn.exitCode).toBe(0);
    const localHtmlOn = await readFile(join(logsDir, ".ai-spend-agent", "report.html"), "utf8");
    expect(localHtmlOn).toContain("anonymous command counts shared · npx aibill telemetry off");
    expect(localHtmlOn).not.toContain("no aibill telemetry<");
  });

  it("embedded runCli emits nothing and creates no telemetry state (bin-entry-only wiring)", async () => {
    await writeClaudeLogFixture();
    const home = await tempHome();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-tel-embedded-"));
    const result = await runCli(["--path", dir, "--no-color"], { homeDirectory: home });
    expect(result.exitCode).toBe(0);
    expect(await readTelemetryState(telemetryStateFilePath(home))).toEqual({ kind: "fresh" });
  });
});

describe("fail-closed off switch (QA M1)", () => {
  afterEach(() => {
    resetTelemetrySessionKillForTests();
  });

  it("a failed off-persist silences the current process and points at the env kills", async () => {
    const home = await tempHome();
    // Notice first so the state is enabled+noticed.
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });

    // Make the state dir readable but unwritable, then try to turn off.
    const stateDir = join(telemetryStateFilePath(home), "..");
    await chmod(stateDir, 0o555);
    try {
      const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
      expect(runtime.disclosureActive).toBe(true);
      const off = await runCli(["telemetry", "off"], { homeDirectory: home });
      expect(off.exitCode).toBe(1);
      expect(off.stderr).toContain("telemetry off could not be persisted — nothing more will be sent by this run.");
      expect(off.stderr).toContain("AI_SPEND_NO_TELEMETRY=1");
      expect(off.stderr).toContain("DO_NOT_TRACK=1");
      expect(off.stderr).not.toContain("stays off anyway");

      // The very run that printed the failure must not emit its event.
      const fetchImpl = vi.fn(async () => okResponse());
      await runtime.finish({
        argv: ["telemetry", "off"], ok: false, durationMs: 5, interactive: true, version: "0.9.2",
        fetchImpl: fetchImpl as unknown as typeof fetch
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await chmod(stateDir, 0o700);
    }
  });

  it("a successful off also stops the in-flight process, not just later runs", async () => {
    const home = await tempHome();
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    await runCli(["telemetry", "off"], { homeDirectory: home });
    const fetchImpl = vi.fn(async () => okResponse());
    await runtime.finish({
      argv: ["telemetry", "off"], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("--json runs never receive the notice (QA m7)", () => {
  it("prints nothing and stamps nothing on a --json first run", async () => {
    const home = await tempHome();
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    await runtime.finish({
      argv: ["glance", "--json"], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      printNotice: () => { throw new Error("notice must not corrupt --json stdout"); }
    });
    expect(await readTelemetryState(telemetryStateFilePath(home))).toEqual({ kind: "fresh" });
  });
});

describe("detached delivery never holds exit (QA M3)", () => {
  it("wires the child exactly: node -e <script> <stateFile>, detached, stdio ignore, unref'd, prod URL baked in", async () => {
    const home = await tempHome();
    const stateFile = telemetryStateFilePath(home);
    let captured: { command: string; args: string[]; options: Record<string, unknown>; unrefs: number } | undefined;
    const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
      captured = { command, args, options, unrefs: 0 };
      return { unref: () => { captured!.unrefs += 1; } };
    }) as never;
    sendTelemetryDetached(stateFile, { spawnImpl });
    expect(captured).toBeDefined();
    expect(captured!.command).toBe(process.execPath);
    expect(captured!.args[0]).toBe("-e");
    expect(captured!.args[2]).toBe(stateFile);
    expect(captured!.args).toHaveLength(3);
    expect(captured!.options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(captured!.unrefs).toBe(1);
    // The destination is the baked-in production constant — never
    // environment-controlled, and the payload never rides on argv.
    expect(captured!.args[1]).toContain(JSON.stringify(telemetryUrl));
    expect(captured!.args[1]).toContain("AbortSignal.timeout(1500)");
    expect(captured!.args[1]).not.toContain("installId");
  });

  it("the child script delivers the cached payload byte-exactly to the endpoint", async () => {
    const { createServer } = await import("node:http");
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => {
        received.push(body);
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const port = (server.address() as { port: number }).port;
    try {
      const home = await tempHome();
      const stateFile = telemetryStateFilePath(home);
      const payload = serializeTelemetryBatch([fixedEvent])!;
      await writeTelemetryState(stateFile, {
        version: 1, installId: fixedEvent.installId, enabled: true,
        noticedAt: "2026-08-24T10:00:00.000Z", lastPayload: payload
      });
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(process.execPath, [
        "-e", buildDetachedTelemetrySendScript(`http://127.0.0.1:${port}/api/telemetry`), stateFile
      ]);
      expect(received).toEqual([payload]);

      // Disabled state: the child re-checks and sends nothing.
      await writeTelemetryState(stateFile, {
        version: 1, installId: fixedEvent.installId, enabled: false, lastPayload: payload
      });
      await promisify(execFile)(process.execPath, [
        "-e", buildDetachedTelemetrySendScript(`http://127.0.0.1:${port}/api/telemetry`), stateFile
      ]);
      expect(received).toHaveLength(1);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("a hanging endpoint adds ≤50ms to the parent path and never holds parent exit", async () => {
    const { createServer } = await import("node:http");
    const hangingServer = createServer(() => { /* never respond */ });
    await new Promise<void>((resolvePromise) => hangingServer.listen(0, "127.0.0.1", resolvePromise));
    const port = (hangingServer.address() as { port: number }).port;
    try {
      const home = await tempHome();
      const stateFile = telemetryStateFilePath(home);
      const payload = serializeTelemetryBatch([fixedEvent])!;
      await writeTelemetryState(stateFile, {
        version: 1, installId: fixedEvent.installId, enabled: true,
        noticedAt: "2026-08-24T10:00:00.000Z", lastPayload: payload
      });

      // (a) The parent-side call is non-blocking regardless of endpoint health.
      const spawnStarted = Date.now();
      sendTelemetryDetached(stateFile);
      expect(Date.now() - spawnStarted).toBeLessThanOrEqual(50);

      // (b) End-to-end: a parent that fires the detached send at the HANGING
      // endpoint and exits must not be held by the in-flight socket. The
      // child's own abort is 1500ms; the parent must beat it decisively.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(buildDetachedTelemetrySendScript(`http://127.0.0.1:${port}/api/telemetry`))}, process.argv[1]], { detached: true, stdio: "ignore" });`,
        "child.unref();"
      ].join("\n");
      const started = Date.now();
      await promisify(execFile)(process.execPath, ["-e", parentScript, stateFile]);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await new Promise<void>((resolvePromise) => hangingServer.close(() => resolvePromise()));
    }
  });
});

describe("unjoinability to signup (structural)", () => {
  it("telemetry state and signup state live in different files with no shared fields", async () => {
    const home = await tempHome();
    expect(telemetryStateFilePath(home)).not.toBe(signupStateFilePath(home));

    await writeSignupState(signupStateFilePath(home), {
      version: 1, status: "subscribed", askCount: 0, email: "you@work.com"
    });
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    await runtime.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2", printNotice: () => {} });
    const emit = await openCliTelemetry({ homeDirectory: home, env: {} });
    const fetchImpl = vi.fn(async () => okResponse());
    await emit.finish({
      argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.2",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const telemetryBytes = await readFile(telemetryStateFilePath(home), "utf8");
    const signupBytes = await readFile(signupStateFilePath(home), "utf8");
    const sentBody = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;

    // The email never appears in telemetry state or any payload…
    expect(telemetryBytes).not.toContain("you@work.com");
    expect(telemetryBytes).not.toContain("@");
    expect(sentBody).not.toContain("you@work.com");
    expect(sentBody).not.toContain("email");
    // …and the installId never appears in signup state.
    const installId = (JSON.parse(telemetryBytes) as TelemetryState).installId;
    expect(signupBytes).not.toContain(installId);
    expect(signupBytes).not.toContain("installId");
    expect(await readSignupState(signupStateFilePath(home))).toMatchObject({
      kind: "ok",
      state: { status: "subscribed" }
    });
  });
});

describe("npx-form command strings (0.9.3 — founder hit 'command not found')", () => {
  // npx users have no bare `aibill` on PATH. Every command the telemetry
  // surfaces tell a human to RUN must carry the npx form, verbatim.
  it("pins the notice and disclosure lines to the npx form", () => {
    expect(telemetryNoticeLines).toEqual([
      "aibill counts which commands run — anonymous, never your data or content",
      "turn off: npx aibill telemetry off",
      "see payloads: npx aibill telemetry"
    ]);
    expect(telemetryDisclosureLine).toBe(
      "anonymous command counts shared · npx aibill telemetry off"
    );
  });

  it("no shipped telemetry instruction regresses to a bare `aibill` invocation", () => {
    for (const line of [...telemetryNoticeLines, telemetryDisclosureLine]) {
      // Any `aibill telemetry…` occurrence must be immediately preceded by
      // "npx " — a bare invocation would strand npx users.
      expect(line).not.toMatch(/(?<!npx )aibill telemetry/u);
    }
  });
});

describe("home state directory permissions (cold-start audit NEW-B1)", () => {
  it("creates ~/.aibill 0700 even under a permissive umask", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-telemetry-mode-"));
    const filePath = telemetryStateFilePath(home);
    const previousUmask = process.umask(0o022);
    try {
      expect(await writeTelemetryState(filePath, {
        version: 1,
        installId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
        enabled: true
      })).toBe(true);
    } finally {
      process.umask(previousUmask);
    }
    if (process.platform !== "win32") {
      const { lstat } = await import("node:fs/promises");
      const info = await lstat(join(home, ".aibill"));
      expect(info.mode & 0o077).toBe(0);
    }
  });
});

describe("glance: machine-invoked poll, never counted", () => {
  it("labels glance honestly in the command map", () => {
    expect(telemetryCommandForArgv(["glance"])).toBe("glance");
    expect(telemetryCommandForArgv(["glance", "--since-days", "30"])).toBe("glance");
    expect(telemetryCommands).toContain("glance");
  });

  it("emits NOTHING for glance even on a noticed, enabled install", async () => {
    const home = await tempHome();
    const first = await openCliTelemetry({ homeDirectory: home, env: {} });
    await first.finish({ argv: [], ok: true, durationMs: 5, interactive: true, version: "0.9.3", printNotice: () => {} });

    // The Glance menu-bar app spawns `aibill glance --since-days 30` every
    // ~30s — ~2,880 machine events/day/user if counted. Suppressed entirely.
    const fetchImpl = vi.fn(async () => okResponse());
    const second = await openCliTelemetry({ homeDirectory: home, env: {} });
    const before = await readTelemetryState(telemetryStateFilePath(home));
    await second.finish({
      argv: ["glance", "--since-days", "30"], ok: true, durationMs: 40, interactive: false, version: "0.9.3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      printNotice: () => { throw new Error("glance must never print the notice"); }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // No payload cached either — the state is byte-identical.
    const after = await readTelemetryState(telemetryStateFilePath(home));
    expect(after).toEqual(before);
  });

  it("glance never stamps the first notice on a fresh install", async () => {
    const home = await tempHome();
    const runtime = await openCliTelemetry({ homeDirectory: home, env: {} });
    await runtime.finish({
      argv: ["glance"], ok: true, durationMs: 40, interactive: true, version: "0.9.3",
      printNotice: () => { throw new Error("glance must never print the notice"); }
    });
    expect(await readTelemetryState(telemetryStateFilePath(home))).toEqual({ kind: "fresh" });
  });
});
