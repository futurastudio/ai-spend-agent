import { mkdir, mkdtemp, readdir, realpath, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Node.js 22.0 to 22.14 and 23.0 to 23.7 have no zstd: `node:zlib` whose zstd exports read as undefined, as in the
 * core's test of the same name. A command that adds up local spend would leave out every compressed Codex session in
 * its window, so it stops on the reader's one line and prints or writes no total. `init` and `doctor --sources` show
 * the line beside what they read.
 */
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  const withoutZstd = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, /zstd/i.test(key) ? undefined : value]));
  return { ...withoutZstd, default: withoutZstd };
});

const real = await vi.importActual<typeof import("node:zlib")>("node:zlib");
const zlib = await import("node:zlib");
const { runCli } = await import("./index.js");

const day = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
const rollout = (id: string, daysAgo: number, input: number, cached: number, output: number) => [
  JSON.stringify({ type: "session_meta", timestamp: at(daysAgo), payload: { id, timestamp: at(daysAgo), cwd: "/Users/testuser/tilden", cli_version: "0.130.0" } }),
  JSON.stringify({ type: "turn_context", timestamp: at(daysAgo), payload: { cwd: "/Users/testuser/tilden", model: "gpt-5" } }),
  JSON.stringify({ type: "event_msg", timestamp: at(daysAgo), payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } })
].join("\n") + "\n";

const line = `1 compressed Codex session file(s) could not be read: reading them needs Node.js 22.15 or later (23.8 or later on Node.js 23), and this is Node.js ${process.version}.`;
const stopLine = `${line} Nothing was totaled without them.`;
let project: string;

beforeEach(async () => {
  const sessions = await mkdtemp(join(tmpdir(), "aibill-codex-older-node-"));
  const dir = join(sessions, "2026", "11", "01");
  await mkdir(dir, { recursive: true });
  // One plain session from yesterday, and one compressed session from 10 days ago: inside a 30-day window, outside a 5-day one.
  await writeFile(join(dir, "rollout-plain.jsonl"), rollout("plain", 1, 1_000, 300, 40));
  const compressed = join(dir, "rollout-compressed.jsonl.zst");
  await writeFile(compressed, real.zstdCompressSync(Buffer.from(rollout("compressed", 10, 900_000, 600_000, 40_000))));
  await utimes(compressed, new Date(at(10)), new Date(at(10)));
  process.env.AI_SPEND_CODEX_LOGS_DIR = sessions;
  process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "aibill-no-claude-"));
  process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "aibill-no-gemini-"));
  process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "aibill-no-home-"));
  process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "aibill-no-codex-home-"));
  process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
  process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-cache-"));
  process.env.AI_SPEND_STATE_TRUST_DIR = await mkdtemp(join(tmpdir(), "aibill-trust-"));
  project = await mkdtemp(join(tmpdir(), "aibill-project-"));
});

afterEach(() => {
  for (const key of ["AI_SPEND_CODEX_LOGS_DIR", "AI_SPEND_CLAUDE_LOGS_DIR", "AI_SPEND_GEMINI_LOGS_DIR", "AI_SPEND_CLAUDE_HOME_DIR",
    "AI_SPEND_CODEX_HOME_DIR", "AI_SPEND_CLAUDE_CONFIG", "AI_SPEND_CODEX_AUTH", "AIBILL_CACHE_DIR", "AI_SPEND_STATE_TRUST_DIR"]) delete process.env[key];
});

const written = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();

describe("on a Node.js without zstd, with a compressed Codex session inside the window", () => {
  it("is the Node.js this file simulates", () => {
    expect(typeof zlib.createZstdDecompress).toBe("undefined");
  });

  it("the receipt and --full print that line and no total", async () => {
    for (const argv of [["--path", project, "--no-color"], ["--full", "--path", project, "--no-color"]]) {
      expect(await runCli(argv), argv.join(" ")).toEqual({ exitCode: 1, stdout: "", stderr: stopLine });
    }
  });

  it("report, from a project and machine-wide, and report-card write nothing that totals", async () => {
    expect(await runCli(["report", "--path", project, "--no-open"])).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't build a report: ${stopLine}` });
    expect(await written(join(project, ".ai-spend-agent"))).toEqual([]);
    // Machine-wide is the home directory itself: a sandbox one, so a regression never writes into a real home.
    const home = await realpath(await mkdtemp(join(tmpdir(), "aibill-older-node-home-")));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(homedir()).toBe(home);
      expect(await runCli(["report", "--path", home, "--no-open"])).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't build a report: ${stopLine}` });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
    expect(await written(home)).toEqual([]);
    const card = join(project, "receipt.svg");
    expect(await runCli(["report-card", "--path", project, "--out", card, "--no-color"])).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't write the report card: ${stopLine}` });
    expect(await written(project)).not.toContain("receipt.svg");
  });

  it("apply, improve, verify inspect, verify start and watch stop on the same line, and watch keeps no baseline", async () => {
    expect(await runCli(["apply", "--path", project])).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't build apply artifacts: ${stopLine}` });
    expect(await runCli(["improve", "--path", project])).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't run the local token test: ${stopLine}` });
    for (const verify of [["verify", "inspect", "some-candidate"], ["verify", "start", "some-candidate", "--quality", "held"]]) {
      expect(await runCli([...verify, "--path", project]), verify.join(" ")).toEqual({ exitCode: 1, stdout: "", stderr: `Couldn't evaluate the local token test: ${stopLine}` });
    }
    expect(await runCli(["watch", "--path", project])).toEqual({ exitCode: 1, stdout: "", stderr: stopLine });
    expect(await written(join(project, ".ai-spend-agent"))).toEqual([]);
  });

  it("doctor --sources names the files and the Node.js that reads them", async () => {
    const result = await runCli(["doctor", "--sources", "--path", project]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`last error: ${line}`);
  });

  it("init does not stop: it prints the same line beside what it read", async () => {
    const result = await runCli(["init", "--path", project]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`  ! ${line} (1)`);
  });

  it("a window the compressed session is not in reads as before", async () => {
    const result = await runCli(["--since-days", "5", "--path", project, "--no-color"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("compressed");
  });
});
