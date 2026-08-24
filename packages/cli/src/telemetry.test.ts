import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import { readSignupState, signupStateFilePath, writeSignupState } from "./signup.js";
import {
  openCliTelemetry,
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
    expect(unknown.stderr).toContain("Use: aibill telemetry [on|off]");
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
    expect(helpOn.stdout).toContain("anonymous command counts shared · aibill telemetry off");
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
