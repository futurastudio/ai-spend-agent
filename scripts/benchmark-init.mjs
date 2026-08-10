#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runCli } from "../packages/cli/dist/index.js";
import { readActivitySnapshot } from "../packages/core/dist/index.js";

const fixtureRoot = await mkdtemp(join(tmpdir(), "aibill-init-benchmark-"));
const projectDirectory = join(fixtureRoot, "project");
const claudeDirectory = join(fixtureRoot, "claude-projects");
const codexDirectory = join(fixtureRoot, "codex-sessions");
const cacheDirectory = join(fixtureRoot, "cache");
const emptyHome = join(fixtureRoot, "agent-home");

try {
  await Promise.all([
    mkdir(projectDirectory),
    mkdir(join(claudeDirectory, "fixture-project"), { recursive: true }),
    mkdir(codexDirectory),
    mkdir(emptyHome)
  ]);
  const timestamp = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  await writeFile(
    join(claudeDirectory, "fixture-project", "session.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      cwd: "/private/benchmark/project-that-must-not-enter-cache",
      sessionId: "benchmark-session-secret",
      requestId: "benchmark-request-secret",
      message: {
        id: "benchmark-message-secret",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    })}\n`,
    "utf8"
  );

  process.env.AI_SPEND_CLAUDE_LOGS_DIR = claudeDirectory;
  process.env.AI_SPEND_CODEX_LOGS_DIR = codexDirectory;
  process.env.AI_SPEND_CLAUDE_CONFIG = join(emptyHome, "missing-claude.json");
  process.env.AI_SPEND_CODEX_AUTH = join(emptyHome, "missing-codex.json");
  process.env.AIBILL_CACHE_DIR = cacheDirectory;

  const initStarted = performance.now();
  const initialized = await runCli(["init", "--path", projectDirectory]);
  const initMs = performance.now() - initStarted;
  if (initialized.exitCode !== 0) {
    throw new Error(`init failed: ${initialized.stderr}`);
  }
  if (!initialized.stdout.includes("FIRST RECEIPT · API-equivalent usage value")) {
    throw new Error("init did not print the evidence-labeled first receipt");
  }
  if (initMs >= 30_000) {
    throw new Error(`financial init exceeded the 30s acceptance limit (${initMs.toFixed(2)}ms)`);
  }

  const initialCache = await readActivitySnapshot({ cacheDirectory });
  if (initialCache.status !== "ok") {
    throw new Error(`cache was not readable after init (${initialCache.status})`);
  }
  const serialized = JSON.stringify(initialCache.snapshot);
  for (const forbidden of [fixtureRoot, "benchmark-session-secret", "benchmark-request-secret", "project-that-must-not-enter-cache"]) {
    if (serialized.includes(forbidden)) {
      throw new Error("private transcript metadata entered the aggregate cache");
    }
  }

  const readTimings = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    const read = await readActivitySnapshot({ cacheDirectory });
    readTimings.push(performance.now() - started);
    if (read.status !== "ok") throw new Error(`cached read ${index + 1} failed`);
  }
  readTimings.sort((left, right) => left - right);
  const p95Ms = readTimings[Math.ceil(readTimings.length * 0.95) - 1];
  if (p95Ms >= 100) {
    throw new Error(`cached read p95 exceeded the 100ms acceptance limit (${p95Ms.toFixed(2)}ms)`);
  }

  console.log(JSON.stringify({
    fixture: "financial-only init + private cache",
    initMs: Number(initMs.toFixed(2)),
    cachedReadP95Ms: Number(p95Ms.toFixed(2)),
    initUnder30s: true,
    cachedReadP95Under100ms: true,
    cachePrivacyPass: true
  }, null, 2));
} finally {
  delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
  delete process.env.AI_SPEND_CODEX_LOGS_DIR;
  delete process.env.AI_SPEND_CLAUDE_CONFIG;
  delete process.env.AI_SPEND_CODEX_AUTH;
  delete process.env.AIBILL_CACHE_DIR;
  await rm(fixtureRoot, { recursive: true, force: true });
}
