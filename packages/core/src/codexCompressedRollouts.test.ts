import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { constants, createZstdCompress, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  codexRolloutToRead,
  loadLocalAgentFinancialUsage,
  loadLocalAgentUsage,
  loadLocalAgentUsageWithFormats,
  SAFE_QUALITATIVE_SCAN_POLICY,
  type LocalAgentCall,
  type LocalAgentLogDiagnostic,
  type LocalAgentSourceScan
} from "./localAgentLogs.js";
import { localAgentFormatRuntimeRegistry } from "./localAgentFormats/runtimeRegistry.js";

/**
 * Codex compresses a rollout it has not written to for 7 days into `<rollout>.jsonl.zst` (one zstd frame, the plain
 * file's mtime kept). Every reader reads it as its plain form, a plain file wins over it, and a file that is not one
 * whole frame is unreadable rather than a short session.
 */
const since = "2026-10-08T00:00:00.000Z";
const until = "2026-11-07T00:00:00.000Z";
const repo = "/Users/testuser/tilden";

const meta = (id: string, cwd: string, at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "session_meta", timestamp: at, payload: { id, timestamp: at, cwd, cli_version: "0.130.0", ...extra } });
const turn = (cwd: string, at: string, model = "gpt-5.6") => JSON.stringify({ type: "turn_context", timestamp: at, payload: { cwd, model } });
const tokens = (at: string, input: number, cached: number, output: number) => JSON.stringify({
  type: "event_msg", timestamp: at, payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1, total_tokens: 11 } } }
});
const prompt = (at: string) => JSON.stringify({ type: "response_item", timestamp: at, payload: { type: "message", role: "user",
  content: [{ type: "input_text", text: "a private prompt that must never leave this machine" }] } });
/** One session on 10-20 and 10-21: three counters, so two days of deltas. */
const session = (id = "s-1", cwd = repo) => [
  meta(id, cwd, "2026-10-20T09:00:00.000Z"), turn(cwd, "2026-10-20T09:00:01.000Z"), prompt("2026-10-20T09:00:02.000Z"),
  tokens("2026-10-20T09:05:00.000Z", 1000, 600, 50), tokens("2026-10-20T10:00:00.000Z", 3000, 2000, 120),
  tokens("2026-10-21T08:00:00.000Z", 4500, 3000, 200)
].join("\n") + "\n";

async function sessionsDir(): Promise<{ root: string; codex: string; claude: string }> {
  const root = await mkdtemp(join(tmpdir(), "aibill-codex-zst-"));
  const codex = join(root, "sessions", "2026", "10", "20"), claude = join(root, "claude");
  await mkdir(codex, { recursive: true });
  await mkdir(claude);
  return { root, codex, claude };
}
const name = (id: string) => `rollout-2026-10-20T09-00-00-${id}.jsonl`;
async function writePlain(dir: string, id: string, text: string): Promise<string> {
  const path = join(dir, name(id));
  await writeFile(path, text);
  return path;
}
/** As Codex leaves it: one frame that declares its size, and the plain file's mtime. */
async function writeCompressed(dir: string, id: string, text: string, mtime = "2026-10-21T08:00:01.000Z"): Promise<string> {
  const path = join(dir, `${name(id)}.zst`);
  await writeFile(path, zstdCompressSync(Buffer.from(text)));
  await utimes(path, new Date(mtime), new Date(mtime));
  return path;
}
const daily = (dirs: { root: string; claude: string }) => loadLocalAgentFinancialUsage({
  workspaceDailyFacts: true, codexSessionsDir: join(dirs.root, "sessions"), claudeProjectsDir: dirs.claude, sinceIso: since, untilIso: until
});
const numbers = (calls: readonly LocalAgentCall[]) => calls.map(call => [call.timestamp.slice(0, 10), call.usage.inputTokens,
  call.usage.cacheReadTokens, call.usage.outputTokens, call.workingDirectory]);

describe("compressed Codex rollouts", () => {
  it("the Workspace daily reader reads a compressed rollout exactly as its plain form", async () => {
    const plain = await sessionsDir(), compressed = await sessionsDir();
    await writePlain(plain.codex, "s-1", session());
    await writeCompressed(compressed.codex, "s-1", session());
    const [fromPlain, fromCompressed] = [await daily(plain), await daily(compressed)];

    expect(fromCompressed.calls).toEqual(fromPlain.calls);
    expect(numbers(fromCompressed.calls)).toEqual([
      ["2026-10-20", 400, 600, 50], ["2026-10-20", 600, 1400, 70], ["2026-10-21", 500, 1000, 80]
    ].map(row => [...row, repo]));
    expect(fromCompressed.diagnostics.filter(item => item.agent === "codex")).toEqual([]);
    expect(fromCompressed.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({ filesDiscovered: 1, filesParsed: 1 });
    expect(JSON.stringify(fromCompressed)).not.toContain("private prompt");
  });

  it("a plain rollout wins over a compressed sibling of the same name, so one rollout counts once", async () => {
    const dirs = await sessionsDir();
    await writePlain(dirs.codex, "s-1", session());
    // A sibling Codex has not finished replacing: what it holds must not be added to what the plain file holds.
    await writeCompressed(dirs.codex, "s-1", session().replace("4500, 3000, 200", "9500, 3000, 900"));
    const loaded = await daily(dirs);
    expect(numbers(loaded.calls).map(row => row[1])).toEqual([400, 600, 500]);
    expect(loaded.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({ filesDiscovered: 1, filesParsed: 1 });
  });

  it("reads a rollout in whichever form it has when read, the plain one first, as Codex moves it between them", async () => {
    const dirs = await sessionsDir();
    const scan = (): LocalAgentSourceScan => ({ agent: "codex", directoryStatus: "readable", filesDiscovered: 0, filesParsed: 0, malformedLines: 0, unreadableFiles: 0, unsupportedUsageSnapshots: 0 });
    const plain = join(dirs.codex, name("s-1")), compressed = `${plain}.zst`;
    const resolve = async (listed: string) => {
      const diagnostics: LocalAgentLogDiagnostic[] = [], counted = scan();
      return { path: await codexRolloutToRead(listed, Date.parse(since), counted, diagnostics), diagnostics, counted };
    };
    // Listed plain, compressed since: the compressed form is read.
    await writeCompressed(dirs.codex, "s-1", session());
    expect((await resolve(plain)).path).toBe(compressed);
    // Listed compressed, restored to plain since for an append: the plain form wins.
    await writePlain(dirs.codex, "s-1", session());
    expect((await resolve(compressed)).path).toBe(plain);
    // Gone in both forms: unreadable, as a plain file gone since the listing always was.
    const gone = await resolve(join(dirs.codex, name("gone")));
    expect(gone.path).toBeUndefined();
    expect(gone.diagnostics).toEqual([expect.objectContaining({ code: "file_unreadable", message: "Codex transcript file could not be read (ENOENT)." })]);
    expect(gone.counted.unreadableFiles).toBe(1);
  });

  it("skips a compressed rollout before the window by its mtime, though Codex compressed it today", async () => {
    const dirs = await sessionsDir();
    // Its ctime and birthtime are now, as for every file Codex compresses; the max-of-times rule would read it.
    await writeCompressed(dirs.codex, "old", session("old"), "2026-10-07T23:59:59.000Z");
    await writeCompressed(dirs.codex, "edge", session("edge"), since);
    const loaded = await daily(dirs);
    expect(new Set(loaded.calls.map(call => call.sessionId))).toEqual(new Set(["edge"]));
    expect(loaded.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({ filesDiscovered: 2, filesParsed: 1, filesSkippedBeforeWindow: 1 });
  });

  it("a cut, appended or foreign compressed file is unreadable, never a short session", async () => {
    const whole = zstdCompressSync(Buffer.from(session()));
    const cases: [string, Buffer, string][] = [
      ["cut", whole.subarray(0, Math.floor(whole.length * 0.6)), "ZSTD_FRAME_INCOMPLETE"],
      ["cut-by-one", whole.subarray(0, whole.length - 1), "ZSTD_FRAME_INCOMPLETE"],
      ["second-frame", Buffer.concat([whole, zstdCompressSync(Buffer.from(tokens("2026-10-22T08:00:00.000Z", 9000, 3000, 900)))]), "ZSTD_FRAME_TRAILING_DATA"],
      ["junk", Buffer.concat([whole, Buffer.from("junk")]), "ZSTD_FRAME_TRAILING_DATA"],
      ["plain-text", Buffer.from(session()), "ZSTD_FRAME_INVALID"],
      ["empty", Buffer.alloc(0), "ZSTD_FRAME_INCOMPLETE"]
    ];
    for (const [label, bytes, code] of cases) {
      const dirs = await sessionsDir();
      const path = join(dirs.codex, `${name(label)}.zst`);
      await writeFile(path, bytes);
      await utimes(path, new Date("2026-10-22T00:00:00.000Z"), new Date("2026-10-22T00:00:00.000Z"));
      for (const loaded of [await daily(dirs), await loadLocalAgentFinancialUsage({ codexSessionsDir: join(dirs.root, "sessions"), claudeProjectsDir: dirs.claude, sinceIso: since })]) {
        expect(loaded.calls.filter(call => call.agent === "codex"), label).toEqual([]);
        expect(loaded.diagnostics.filter(item => item.agent === "codex"), label).toEqual([expect.objectContaining({
          code: "file_unreadable", severity: "error", message: `Codex transcript file could not be read (${code}).` })]);
      }
    }
  });

  it("decodes a frame with a checksum, raw and run-length blocks, and one that declares no size", async () => {
    const text = session() + JSON.stringify({ type: "response_item", payload: { pad: "z".repeat(300_000) } }) + "\n";
    const streamed = await new Promise<Buffer>((done, fail) => {
      const parts: Buffer[] = [], encoder = createZstdCompress();
      encoder.on("data", (part: Buffer) => parts.push(part)).on("end", () => done(Buffer.concat(parts))).on("error", fail);
      encoder.end(Buffer.from(text));
    });
    const checksummed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    // By hand: one raw block holding the rollout, then a last run-length block of 300 spaces; size declared in 2 bytes.
    const raw = Buffer.from(session()), runs = 300, blockHeader = (value: number) => Buffer.from([value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff]);
    const handMade = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x60]), Buffer.from([(raw.length + runs - 256) & 0xff, (raw.length + runs - 256) >> 8]),
      blockHeader(raw.length << 3), raw, blockHeader(1 | 1 << 1 | runs << 3), Buffer.from(" ")]);
    for (const [bytes, plainText] of [[checksummed, text], [streamed, text], [handMade, session() + " ".repeat(runs)]] as const) {
      const dirs = await sessionsDir(), plain = await sessionsDir();
      const path = join(dirs.codex, `${name("s-1")}.zst`);
      await writeFile(path, bytes);
      await utimes(path, new Date("2026-10-22T00:00:00.000Z"), new Date("2026-10-22T00:00:00.000Z"));
      await writePlain(plain.codex, "s-1", plainText);
      const [fromCompressed, fromPlain] = [await daily(dirs), await daily(plain)];
      expect(fromCompressed.calls).toHaveLength(3);
      expect(fromCompressed.calls).toEqual(fromPlain.calls);
      expect(fromCompressed.diagnostics.filter(item => item.agent === "codex")).toEqual(fromPlain.diagnostics.filter(item => item.agent === "codex"));
    }
  });

  it("the spend scan behind the report and MCP reads a compressed rollout as its plain form", async () => {
    const plain = await sessionsDir(), compressed = await sessionsDir();
    await writePlain(plain.codex, "s-1", session());
    await writeCompressed(compressed.codex, "s-1", session());
    const read = (dirs: { root: string; claude: string }) => loadLocalAgentFinancialUsage({
      codexSessionsDir: join(dirs.root, "sessions"), claudeProjectsDir: dirs.claude, sinceIso: since });
    const [fromPlain, fromCompressed] = [await read(plain), await read(compressed)];
    expect(fromCompressed.calls).toEqual(fromPlain.calls);
    expect(fromCompressed.records).toEqual(fromPlain.records);
    expect(fromCompressed.calls).toEqual([expect.objectContaining({ usageScope: "session_cumulative", usage: expect.objectContaining({ inputTokens: 1500, cacheReadTokens: 3000, outputTokens: 200 }) })]);
    expect(fromCompressed.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({ filesParsed: 1, filesReadFinancially: 1 });
  });

  it("the activity scans read a compressed rollout within their budget, counted by what it decodes to", async () => {
    const plain = await sessionsDir(), compressed = await sessionsDir();
    await writePlain(plain.codex, "s-1", session());
    await writeCompressed(compressed.codex, "s-1", session());
    const options = (dirs: { root: string; claude: string }) => ({ codexSessionsDir: join(dirs.root, "sessions"), claudeProjectsDir: dirs.claude, sinceIso: since });
    const strip = (calls: readonly LocalAgentCall[]) => calls.map(({ activity: _activity, ...call }) => call);
    expect(strip((await loadLocalAgentUsage(options(compressed))).calls)).toEqual(strip((await loadLocalAgentUsage(options(plain))).calls));

    const runtimes = localAgentFormatRuntimeRegistry.filter(runtime => runtime.descriptor.id === "codex");
    const bounded = (dirs: { root: string; claude: string }, maxFileBytes: number) => loadLocalAgentUsageWithFormats(runtimes,
      { ...options(dirs), qualitativeScan: { ...SAFE_QUALITATIVE_SCAN_POLICY, maxFileBytes } });
    const fits = await bounded(compressed, Buffer.byteLength(session()));
    expect(strip(fits.calls)).toEqual(strip((await bounded(plain, Buffer.byteLength(session()))).calls));
    expect(fits.sourceScans[0]).toMatchObject({ qualitativeCoverage: "complete", qualitativeFilesSelected: 1, qualitativeFilesReadCompletely: 1,
      qualitativeBytesRead: Buffer.byteLength(session()) });
    // Its file on disk is far smaller than the limit; what it decodes to is not.
    const onDisk = (await readFile(join(compressed.codex, `${name("s-1")}.zst`))).length;
    const over = await bounded(compressed, Buffer.byteLength(session()) - 1);
    expect(onDisk).toBeLessThan(Buffer.byteLength(session()) - 1);
    expect(over.calls).toEqual([]);
    expect(over.sourceScans[0]).toMatchObject({ qualitativeCoverage: "partial", qualitativeFilesSkippedForBudget: 1, qualitativeFilesSelected: 0 });
  });
});

describe("each Codex event goes under the folder its turn ran in", () => {
  it("a session that moved files its later events under the new folder, and says where the session started", async () => {
    const dirs = await sessionsDir(), home = homedir();
    await writePlain(dirs.codex, "moved", [
      meta("moved", home, "2026-10-20T09:00:00.000Z"), turn(home, "2026-10-20T09:00:01.000Z"),
      tokens("2026-10-20T09:05:00.000Z", 1000, 600, 50),
      turn(repo, "2026-10-20T11:00:00.000Z"), tokens("2026-10-20T11:05:00.000Z", 3000, 2000, 120),
      turn(home, "2026-10-21T07:00:00.000Z"), tokens("2026-10-21T08:00:00.000Z", 4500, 3000, 200)
    ].join("\n"));
    const calls = (await daily(dirs)).calls;
    expect(calls.map(call => [call.workingDirectory, call.project, call.sessionPlace])).toEqual([
      [home, "(home)", undefined],
      [repo, "tilden", { workingDirectory: home, project: "(home)" }],
      [home, "(home)", undefined]
    ]);
  });

  it("a fork's inherited turns say nothing of its own folder", async () => {
    const dirs = await sessionsDir(), started = "2026-10-20T09:00:00.000Z";
    await writePlain(dirs.codex, "fork", [
      meta("fork", repo, started, { thread_source: "user", source: "vscode", forked_from_id: "parent" }),
      // The parent's history, replayed: its turns ran elsewhere and its task started days before this rollout.
      turn("/Users/testuser/elsewhere", "2026-10-20T09:00:01.000Z"),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-20T09:00:02.000Z", payload: { type: "task_started", started_at: Date.parse("2026-10-17T09:00:00.000Z") / 1000 } }),
      tokens("2026-10-20T09:00:03.000Z", 1000, 600, 50),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-20T09:01:00.000Z", payload: { type: "task_started", started_at: Date.parse("2026-10-20T09:01:00.000Z") / 1000 } }),
      tokens("2026-10-20T09:02:00.000Z", 1500, 900, 70),
      turn("/Users/testuser/later", "2026-10-20T10:00:00.000Z"), tokens("2026-10-20T10:05:00.000Z", 2500, 1500, 90)
    ].join("\n"));
    const calls = (await daily(dirs)).calls;
    expect(calls.map(call => [call.usage.inputTokens, call.workingDirectory, call.sessionPlace?.workingDirectory])).toEqual([
      [200, repo, undefined],
      [400, "/Users/testuser/later", repo]
    ]);
  });
});
