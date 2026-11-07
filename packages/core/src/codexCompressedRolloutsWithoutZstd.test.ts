import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * A Node.js before 22.15 has no zstd. Simulated here: `node:zlib` whose zstd exports read as undefined, as a missing
 * export reads through a namespace on such a Node.js (this test runner's mock refuses a key it does not hold, so the
 * keys are held, as undefined). Every reader still loads, a compressed rollout inside the window counts as unreadable
 * with one line naming the Node.js needed, and one before the window is skipped as before.
 */
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const withoutZstd = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, /zstd/i.test(key) ? undefined : value]));
  return { ...withoutZstd, default: withoutZstd };
});

const real = await vi.importActual<typeof import("node:zlib")>("node:zlib");
const { loadLocalAgentFinancialUsage, loadLocalAgentUsage, loadLocalAgentUsageWithFormats, SAFE_QUALITATIVE_SCAN_POLICY } = await import("./localAgentLogs.js");
const { localAgentFormatRuntimeRegistry } = await import("./localAgentFormats/runtimeRegistry.js");
const zlib = await import("node:zlib");

const rollout = (id: string) => [
  JSON.stringify({ type: "session_meta", timestamp: "2026-10-20T09:00:00.000Z", payload: { id, timestamp: "2026-10-20T09:00:00.000Z", cwd: "/Users/testuser/tilden" } }),
  JSON.stringify({ type: "turn_context", timestamp: "2026-10-20T09:00:01.000Z", payload: { cwd: "/Users/testuser/tilden", model: "gpt-5.6" } }),
  JSON.stringify({ type: "event_msg", timestamp: "2026-10-20T09:05:00.000Z", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } } } })
].join("\n") + "\n";

async function machine() {
  const root = await mkdtemp(join(tmpdir(), "aibill-codex-no-zstd-"));
  const dir = join(root, "sessions", "2026", "10", "20"), claude = join(root, "claude");
  await mkdir(dir, { recursive: true });
  await mkdir(claude);
  await writeFile(join(dir, "rollout-2026-10-20T09-00-00-plain.jsonl"), rollout("plain"));
  for (const [id, mtime] of [["inside", "2026-10-21T00:00:00.000Z"], ["inside-2", "2026-10-22T00:00:00.000Z"], ["before", "2026-10-01T00:00:00.000Z"]] as const) {
    const path = join(dir, `rollout-2026-10-20T09-00-00-${id}.jsonl.zst`);
    await writeFile(path, real.zstdCompressSync(Buffer.from(rollout(id))));
    await utimes(path, new Date(mtime), new Date(mtime));
  }
  return { codexSessionsDir: join(root, "sessions"), claudeProjectsDir: claude, sinceIso: "2026-10-08T00:00:00.000Z" };
}
const line = `2 compressed Codex session file(s) could not be read: reading them needs Node.js 22.15 or later, and this is Node.js ${process.version}.`;

describe("on a Node.js without zstd", () => {
  it("is the Node.js this file simulates", () => {
    expect(typeof zlib.createZstdDecompress).toBe("undefined");
  });

  it("the Workspace daily reader reads the plain rollout and counts each compressed one inside the window as unreadable", async () => {
    const loaded = await loadLocalAgentFinancialUsage({ ...await machine(), workspaceDailyFacts: true, untilIso: "2026-11-07T00:00:00.000Z" });
    expect(loaded.calls.map(call => call.sessionId)).toEqual(["plain"]);
    expect(loaded.diagnostics.filter(item => item.agent === "codex")).toEqual([
      { agent: "codex", code: "compressed_unsupported", severity: "error", message: line, count: 2 }
    ]);
    expect(loaded.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({
      filesDiscovered: 4, filesParsed: 1, unreadableFiles: 2, compressedFilesNotRead: 2, filesSkippedBeforeWindow: 1 });
  });

  it("the spend scan and the activity scans say the same, and still load", async () => {
    const options = await machine();
    for (const loaded of [await loadLocalAgentFinancialUsage(options), await loadLocalAgentUsage(options),
      await loadLocalAgentUsageWithFormats(localAgentFormatRuntimeRegistry, { ...options, qualitativeScan: SAFE_QUALITATIVE_SCAN_POLICY })]) {
      expect(loaded.calls.filter(call => call.agent === "codex").map(call => call.sessionId)).toEqual(["plain"]);
      expect(loaded.diagnostics.filter(item => item.code === "compressed_unsupported")).toEqual([
        { agent: "codex", code: "compressed_unsupported", severity: "error", message: line, count: 2 }
      ]);
      expect(loaded.sourceScans.find(scan => scan.agent === "codex")).toMatchObject({ unreadableFiles: 2, compressedFilesNotRead: 2 });
    }
    const bounded = await loadLocalAgentUsageWithFormats(localAgentFormatRuntimeRegistry, { ...options, qualitativeScan: SAFE_QUALITATIVE_SCAN_POLICY });
    expect(bounded.sourceScans.find(scan => scan.agent === "codex")?.qualitativeCoverage).toBe("partial");
  });
});
