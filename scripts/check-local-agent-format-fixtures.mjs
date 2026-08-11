#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(
  root,
  "packages/core/src/fixtures/local-agent-formats"
);
const malformedFixtureLine = "MALFORMED_FIXTURE_LINE";
const maximumFileBytes = 32 * 1024;
const maximumTotalBytes = 256 * 1024;
const requiredFiles = new Set([
  "claude-code-v1/transcript.jsonl",
  "codex-v1/rollout-synthetic.jsonl"
]);

try {
  const files = await fixtureFiles(fixtureRoot);
  assert(
    [...requiredFiles].every((required) => files.some((file) => file.relativePath === required)),
    `Required local-agent fixtures are missing: ${[...requiredFiles]
      .filter((required) => !files.some((file) => file.relativePath === required))
      .join(", ")}`
  );

  let totalBytes = 0;
  let jsonLinesChecked = 0;
  let malformedSentinels = 0;
  const parsedByFile = new Map();

  for (const file of files) {
  assert(file.info.isFile(), `Fixture is not a regular file: ${file.relativePath}`);
  assert(file.info.size > 0, `Fixture is empty: ${file.relativePath}`);
  assert(
    file.info.size <= maximumFileBytes,
    `Fixture exceeds ${maximumFileBytes} bytes: ${file.relativePath}`
  );
  totalBytes += file.info.size;
  const raw = await readFile(file.absolutePath, "utf8");
  assert(
    Buffer.byteLength(raw, "utf8") === file.info.size,
    `Fixture changed while it was checked: ${file.relativePath}`
  );
  assert(raw.endsWith("\n"), `Fixture must end with one newline: ${file.relativePath}`);
  assert(!raw.endsWith("\n\n"), `Fixture has a trailing blank line: ${file.relativePath}`);
  assertSafeFixtureText(raw, file.relativePath);

  const entries = [];
  if (file.relativePath.endsWith(".json")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `JSON fixture is malformed: ${file.relativePath}.`
      );
    }
    assertSafeFixtureValue(parsed, file.relativePath, 1);
    entries.push(parsed);
    jsonLinesChecked += 1;
  } else {
    for (const [index, line] of raw.trimEnd().split("\n").entries()) {
      if (line === malformedFixtureLine) {
        malformedSentinels += 1;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          `Only the explicit malformed sentinel may be non-JSON (${file.relativePath}:${index + 1}).`
        );
      }
      assertSafeFixtureValue(parsed, file.relativePath, index + 1);
      entries.push(parsed);
      jsonLinesChecked += 1;
    }
  }
  parsedByFile.set(file.relativePath, entries);
  }

  assert(
    totalBytes <= maximumTotalBytes,
    `Local-agent fixtures exceed ${maximumTotalBytes} total bytes.`
  );
  assert(malformedSentinels >= 1, "Expected at least one explicit malformed fixture line.");

  checkClaudeFixture(parsedByFile.get("claude-code-v1/transcript.jsonl"));
  checkCodexFixture(parsedByFile.get("codex-v1/rollout-synthetic.jsonl"));

  console.log(JSON.stringify({
    status: "pass",
    fixtureDirectories: [...new Set(files.map((file) => file.relativePath.split("/")[0]))],
    filesChecked: files.length,
    jsonLinesChecked,
    malformedSentinels,
    totalBytes
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown fixture validation failure";
  console.error(`local-agent fixture check failed: ${message}`);
  process.exitCode = 1;
}

async function fixtureFiles(directory) {
  const out = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(current, entry.name);
      assert(
        absolutePath === fixtureRoot || absolutePath.startsWith(`${fixtureRoot}${sep}`),
        `Fixture escaped its approved tree: ${entry.name}`
      );
      const info = await lstat(absolutePath);
      assert(!info.isSymbolicLink(), `Fixture symlinks are refused: ${entry.name}`);
      if (info.isDirectory()) {
        const relativeDirectory = absolutePath
          .slice(fixtureRoot.length + 1)
          .split(sep)
          .join("/");
        assert(
          !relativeDirectory.includes("/") &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(relativeDirectory),
          `Fixture directory must be one safely named versioned format: ${relativeDirectory}`
        );
        queue.push(absolutePath);
        continue;
      }
      const relativePath = absolutePath
        .slice(fixtureRoot.length + 1)
        .split(sep)
        .join("/");
      const parts = relativePath.split("/");
      assert(
        parts.length === 2 &&
          /^[a-z0-9][a-z0-9.-]*\.(?:json|jsonl|ndjson)$/.test(parts[1] ?? ""),
        `Fixture file is outside the allowed JSON fixture shape: ${relativePath}`
      );
      out.push({
        absolutePath,
        info,
        relativePath
      });
    }
  }
  return out.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertSafeFixtureText(raw, file) {
  const forbidden = [
    [/(?:^|["'\s])\/(?:Users|home)\/[^/\s"']+/i, "real home path"],
    [/[A-Za-z]:\\Users\\[^\\\s"']+/i, "Windows home path"],
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "email address"],
    [/\b(?:env|file|keychain):[A-Z0-9_./-]+/i, "credential reference"],
    [/\b(?:sk-(?:proj-)?|ghp_|github_pat_|npm_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/, "credential-shaped token"],
    [/\bBearer\s+[A-Za-z0-9._~-]{8,}/i, "bearer token"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, "JWT-shaped token"],
    [/\b(?:ignore|disregard) (?:all |any )?(?:previous|prior) instructions\b/i, "instruction-injection prose"],
    [/\b(?:upload|exfiltrate|leak) (?:the )?(?:secret|credential|token|key)s?\b/i, "data-exfiltration prose"],
    [/\b(?:customer|account|organization|tenant)[-_ ]?(?:id|name)\b/i, "customer or account identifier"],
    [/\b(?:prompt|response|instructions?)\s*:/i, "prompt or response prose"],
    [/\/private\//i, "private local path"]
  ];
  for (const [pattern, label] of forbidden) {
    assert(!pattern.test(raw), `Fixture contains ${label}: ${file}`);
  }
}

function assertSafeFixtureValue(value, file, line, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeFixtureValue(item, file, line, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (/^(?:account|customer|organization|tenant|user)[_-]?id$/i.test(key)) {
      throw new Error(`Fixture contains a private identity field (${file}:${line}:${nextPath.join(".")}).`);
    }
    if (/^(?:prompt|response|instructions?|system_prompt)$/i.test(key)) {
      throw new Error(`Fixture contains prompt/response prose (${file}:${line}:${nextPath.join(".")}).`);
    }
    if ((key === "id" || key === "sessionId" || key === "requestId") &&
        typeof item === "string" && !item.startsWith("fixture-")) {
      throw new Error(`Fixture identifier is not obviously synthetic (${file}:${line}:${nextPath.join(".")}).`);
    }
    if ((key === "cwd" || /path$/i.test(key)) && typeof item === "string") {
      assert(
        item === "/workspace/sample-project" || item.startsWith("/workspace/sample-project/"),
        `Fixture path is outside the synthetic workspace (${file}:${line}:${nextPath.join(".")}).`
      );
    }
    assertSafeFixtureValue(item, file, line, nextPath);
  }
}

function checkClaudeFixture(entries) {
  assert(Array.isArray(entries), "Claude Code fixture was not read.");
  assert(entries.every((entry) => isRecord(entry) && typeof entry.type === "string"),
    "Claude Code fixture lines must be typed event objects.");
  const assistant = entries.filter((entry) => entry.type === "assistant");
  assert(assistant.length === 3, "Claude Code fixture must contain three assistant events.");
  const identities = assistant.map((entry) => (
    `${entry.message?.id ?? ""}:${entry.requestId ?? ""}`
  ));
  assert(new Set(identities).size === 2, "Claude Code fixture must exercise one duplicate response.");
  const supported = assistant.filter((entry) => (
    nonnegative(entry.message?.usage?.input_tokens) &&
    nonnegative(entry.message?.usage?.output_tokens)
  ));
  assert(supported.length === 2, "Claude Code fixture must retain the duplicated supported usage shape.");
  const unsupported = assistant.find((entry) => (
    entry.message?.usage?.input_tokens === undefined &&
    nonnegative(entry.message?.usage?.output_tokens) &&
    nonnegative(entry.message?.usage?.total_tokens)
  ));
  assert(Boolean(unsupported), "Claude Code fixture must include one unsupported total-only input shape.");
}

function checkCodexFixture(entries) {
  assert(Array.isArray(entries), "Codex fixture was not read.");
  assert(entries.every((entry) => isRecord(entry) && typeof entry.type === "string"),
    "Codex fixture lines must be typed event objects.");
  assert(entries.filter((entry) => entry.type === "session_meta").length === 1,
    "Codex fixture must contain one root session metadata event.");
  assert(entries.some((entry) => entry.type === "turn_context" && typeof entry.payload?.model === "string"),
    "Codex fixture must identify the model through turn context.");
  const counters = entries.filter((entry) => (
    entry.type === "event_msg" && entry.payload?.type === "token_count"
  ));
  assert(counters.length === 2, "Codex fixture must contain an older and latest cumulative counter.");
  const latest = counters.at(-1)?.payload;
  assert(isRecord(latest?.info?.total_token_usage), "Codex latest counter is missing cumulative usage.");
  assert(isRecord(latest?.info?.last_token_usage), "Codex latest counter is missing last-turn usage.");
  assert(
    latest?.rate_limits?.primary?.window_minutes === 300 &&
      latest?.rate_limits?.secondary?.window_minutes === 10_080,
    "Codex latest counter must contain transcript-reported five-hour and weekly limits."
  );
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
