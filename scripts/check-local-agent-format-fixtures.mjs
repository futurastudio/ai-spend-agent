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
const geminiFixtureDirectory = "gemini-cli-v1";
const geminiMetadataPath = `${geminiFixtureDirectory}/fixture-metadata.json`;
const geminiCaseFiles = new Map([
  [
    "legacy-json-full-split",
    `${geminiFixtureDirectory}/legacy-json/1111111111111111111111111111111111111111111111111111111111111111/chats/session-legacy.json`
  ],
  [
    "current-jsonl-duplicate-id",
    `${geminiFixtureDirectory}/current-jsonl/2222222222222222222222222222222222222222222222222222222222222222/chats/session-current.jsonl`
  ],
  [
    "incomplete-components",
    `${geminiFixtureDirectory}/incomplete-components/3333333333333333333333333333333333333333333333333333333333333333/chats/session-incomplete.jsonl`
  ],
  [
    "inconsistent-total",
    `${geminiFixtureDirectory}/inconsistent-total/4444444444444444444444444444444444444444444444444444444444444444/chats/session-inconsistent.jsonl`
  ],
  [
    "unknown-model",
    `${geminiFixtureDirectory}/unknown-model/5555555555555555555555555555555555555555555555555555555555555555/chats/session-unknown-model.jsonl`
  ],
  [
    "malformed-jsonl",
    `${geminiFixtureDirectory}/malformed-jsonl/6666666666666666666666666666666666666666666666666666666666666666/chats/session-malformed.jsonl`
  ],
  [
    "nested-subagent",
    `${geminiFixtureDirectory}/nested-subagent/7777777777777777777777777777777777777777777777777777777777777777/chats/fixture-parent-session/fixture-subagent-session.jsonl`
  ],
  [
    "logs-only-presence",
    `${geminiFixtureDirectory}/logs-only/8888888888888888888888888888888888888888888888888888888888888888/logs.json`
  ]
]);
const requiredGeminiFiles = new Set([geminiMetadataPath, ...geminiCaseFiles.values()]);
const allowedGeminiDirectories = new Set(
  [...requiredGeminiFiles].flatMap((file) => {
    const parts = file.split("/");
    return parts.slice(1, -1).map((_, index) => parts.slice(0, index + 2).join("/"));
  })
);
const allowedMalformedSentinels = new Set([
  "claude-code-v1/transcript.jsonl:4",
  `${geminiCaseFiles.get("malformed-jsonl")}:2`
]);
const requiredFiles = new Set([
  "claude-code-v1/transcript.jsonl",
  "codex-v1/rollout-synthetic.jsonl",
  ...requiredGeminiFiles
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
  const seenMalformedSentinels = new Set();
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
        const location = `${file.relativePath}:${index + 1}`;
        assert(
          allowedMalformedSentinels.has(location),
          `Malformed fixture sentinel is not permitted at ${location}.`
        );
        assert(
          !seenMalformedSentinels.has(location),
          `Malformed fixture sentinel is duplicated at ${location}.`
        );
        seenMalformedSentinels.add(location);
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
  assert(
    malformedSentinels === allowedMalformedSentinels.size &&
      [...allowedMalformedSentinels].every((location) => seenMalformedSentinels.has(location)),
    "Every approved malformed fixture sentinel must appear exactly once."
  );

  checkClaudeFixture(parsedByFile.get("claude-code-v1/transcript.jsonl"));
  checkCodexFixture(parsedByFile.get("codex-v1/rollout-synthetic.jsonl"));
  checkGeminiFixtures(parsedByFile);

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
        if (relativeDirectory.includes("/")) {
          assert(
            allowedGeminiDirectories.has(relativeDirectory),
            `Nested fixture directory is outside the bounded Gemini corpus: ${relativeDirectory}`
          );
        } else {
          assert(
            /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(relativeDirectory),
            `Fixture directory must be one safely named versioned format: ${relativeDirectory}`
          );
        }
        queue.push(absolutePath);
        continue;
      }
      const relativePath = absolutePath
        .slice(fixtureRoot.length + 1)
        .split(sep)
        .join("/");
      const parts = relativePath.split("/");
      if (parts[0] === geminiFixtureDirectory) {
        assert(
          requiredGeminiFiles.has(relativePath),
          `Fixture file is outside the bounded Gemini corpus: ${relativePath}`
        );
      } else {
        assert(
          parts.length === 2 &&
            /^[a-z0-9][a-z0-9.-]*\.(?:json|jsonl|ndjson)$/.test(parts[1] ?? ""),
          `Fixture file is outside the allowed JSON fixture shape: ${relativePath}`
        );
      }
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
    const approvedGeminiCaseId =
      file === geminiMetadataPath &&
      key === "id" &&
      typeof item === "string" &&
      geminiCaseFiles.has(item);
    if ((key === "id" || key === "sessionId" || key === "requestId") &&
        typeof item === "string" && !item.startsWith("fixture-") && !approvedGeminiCaseId) {
      throw new Error(`Fixture identifier is not obviously synthetic (${file}:${line}:${nextPath.join(".")}).`);
    }
    if ((key === "cwd" || /path$/i.test(key)) && typeof item === "string") {
      const approvedGeminiCasePath =
        file === geminiMetadataPath &&
        key === "path" &&
        requiredGeminiFiles.has(`${geminiFixtureDirectory}/${item}`);
      assert(
        approvedGeminiCasePath ||
          item === "/workspace/sample-project" ||
          item.startsWith("/workspace/sample-project/"),
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

function checkGeminiFixtures(parsedByFile) {
  const metadata = singleJsonDocument(parsedByFile, geminiMetadataPath);
  assert(isRecord(metadata), "Gemini fixture metadata must be one JSON object.");
  assert(metadata.fixtureSetVersion === 1, "Gemini fixture metadata version must remain pinned to 1.");
  assert(metadata.synthetic === true, "Gemini fixture metadata must declare synthetic data.");
  assert(metadata.observedAt === "2026-08-11", "Gemini fixture observation date changed unexpectedly.");
  assert(
    metadata.geminiCli?.packageVersion === "0.56.0-nightly.20260806.g761f604c1" &&
      metadata.geminiCli?.sourceCommit === "659c7aacd96f6632f19e2fac0796db83a2f97e6b",
    "Gemini fixture source version must remain explicitly pinned."
  );
  assert(
    metadata.referenceParser?.name === "ccusage" &&
      metadata.referenceParser?.sourceCommit === "4d71b5e72fc042d1a9b2e755227fd66130f30338",
    "Gemini fixture reference parser must remain explicitly pinned."
  );
  assert(
    Array.isArray(metadata.sourceShapeNotes) &&
      metadata.sourceShapeNotes.length >= 8 &&
      metadata.sourceShapeNotes.every((note) => typeof note === "string" && note.length > 0),
    "Gemini fixture metadata must retain its source-shape notes."
  );
  assert(
    Array.isArray(metadata.cases) && metadata.cases.length === geminiCaseFiles.size,
    "Gemini fixture metadata must declare every bounded case exactly once."
  );

  const cases = new Map();
  for (const fixtureCase of metadata.cases) {
    assert(isRecord(fixtureCase), "Gemini fixture case metadata must be an object.");
    assert(
      typeof fixtureCase.id === "string" && geminiCaseFiles.has(fixtureCase.id),
      `Unknown Gemini fixture case metadata: ${String(fixtureCase.id)}`
    );
    assert(!cases.has(fixtureCase.id), `Duplicate Gemini fixture case metadata: ${fixtureCase.id}`);
    const expectedPath = geminiCaseFiles.get(fixtureCase.id);
    assert(
      `${geminiFixtureDirectory}/${fixtureCase.path}` === expectedPath,
      `Gemini fixture case path changed unexpectedly: ${fixtureCase.id}`
    );
    assert(
      fixtureCase.id === "logs-only-presence"
        ? !expectedPath.includes("/chats/") && expectedPath.endsWith("/logs.json")
        : expectedPath.includes("/chats/") && /\.(?:json|jsonl)$/.test(expectedPath),
      `Gemini financial evidence must remain under chats while logs.json stays detection-only: ${fixtureCase.id}`
    );
    assert(isRecord(fixtureCase.expected), `Gemini fixture case lacks expectations: ${fixtureCase.id}`);
    cases.set(fixtureCase.id, fixtureCase);
  }
  assert(
    [...geminiCaseFiles].every(([id, file]) => cases.has(id) && parsedByFile.has(file)),
    "Gemini fixture metadata or corpus is incomplete."
  );

  const legacyPath = geminiCaseFiles.get("legacy-json-full-split");
  const legacy = singleJsonDocument(parsedByFile, legacyPath);
  checkGeminiSessionMetadata(legacy, legacyPath, "main");
  assert(Array.isArray(legacy.messages), "Legacy Gemini JSON fixture must contain messages.");
  const legacyMessages = legacy.messages.filter((entry) => entry?.type === "gemini");
  assert(legacyMessages.length === 1, "Legacy Gemini JSON fixture must contain one Gemini response.");
  checkCompleteGeminiTokens(legacyMessages[0]?.tokens, {
    input: 1200,
    output: 120,
    cached: 400,
    thoughts: 30,
    tool: 50,
    total: 1400
  }, "legacy Gemini JSON");
  assert(
    cases.get("legacy-json-full-split")?.expected?.freshInputTokens === 800,
    "Legacy Gemini fixture must document cache-exclusive fresh input."
  );

  const currentPath = geminiCaseFiles.get("current-jsonl-duplicate-id");
  const current = parsedByFile.get(currentPath);
  assert(Array.isArray(current) && current.length === 7,
    "Current Gemini JSONL fixture must contain metadata, user, two response records, and writer $set updates.");
  checkGeminiSessionMetadata(current[0], currentPath, "main");
  const currentMessages = current.filter((entry) => entry?.type === "gemini");
  assert(currentMessages.length === 2, "Current Gemini JSONL fixture must repeat one Gemini response.");
  assert(
    currentMessages[0]?.id === currentMessages[1]?.id &&
      currentMessages[0]?.tokens === null &&
      isRecord(currentMessages[1]?.tokens),
    "Current Gemini JSONL fixture must model tokens null followed by a token-bearing update for one message id."
  );
  assert(
    current.filter((entry) => isRecord(entry?.$set) && typeof entry.$set.lastUpdated === "string").length === 3,
    "Current Gemini JSONL fixture must retain the official writer's $set lastUpdated sequence."
  );
  checkCompleteGeminiTokens(currentMessages[1].tokens, {
    input: 900,
    output: 90,
    cached: 300,
    thoughts: 20,
    tool: 10,
    total: 1020
  }, "current Gemini JSONL");
  assert(
    cases.get("current-jsonl-duplicate-id")?.expected?.duplicateMessageIdsCollapsed === 1,
    "Current Gemini fixture must require duplicate-id collapse."
  );
  assert(
    cases.get("current-jsonl-duplicate-id")?.expected?.costEvidence === "missing_without_modality" &&
      cases.get("current-jsonl-duplicate-id")?.expected?.mustNotEmitZeroCost === true,
    "Current Flash fixture must remain unpriced when session evidence lacks token modality."
  );

  const incompletePath = geminiCaseFiles.get("incomplete-components");
  const incomplete = parsedByFile.get(incompletePath);
  checkGeminiSessionMetadata(incomplete?.[0], incompletePath, "main");
  const incompleteTokens = onlyGeminiMessage(incomplete, "incomplete Gemini fixture").tokens;
  assert(isRecord(incompleteTokens), "Incomplete Gemini fixture must still contain a token object.");
  assert(
    nonnegativeInteger(incompleteTokens.input) &&
      nonnegativeInteger(incompleteTokens.cached) &&
      nonnegativeInteger(incompleteTokens.tool) &&
      nonnegativeInteger(incompleteTokens.total) &&
      incompleteTokens.output === undefined &&
      incompleteTokens.thoughts === undefined,
    "Incomplete Gemini fixture must omit output and thoughts without inventing zeros."
  );
  assert(
    cases.get("incomplete-components")?.expected?.costEvidence === "missing" &&
      cases.get("incomplete-components")?.expected?.mustNotInferFromTotal === true,
    "Incomplete Gemini fixture must require missing cost and prohibit total-based inference."
  );

  const inconsistentPath = geminiCaseFiles.get("inconsistent-total");
  const inconsistent = parsedByFile.get(inconsistentPath);
  checkGeminiSessionMetadata(inconsistent?.[0], inconsistentPath, "main");
  const inconsistentTokens = onlyGeminiMessage(inconsistent, "inconsistent Gemini fixture").tokens;
  checkGeminiTokenComponents(inconsistentTokens, "inconsistent Gemini fixture");
  assert(
    inconsistentTokens.total !== geminiComponentTotal(inconsistentTokens),
    "Inconsistent Gemini fixture total must not reconcile."
  );
  assert(
    cases.get("inconsistent-total")?.expected?.costEvidence === "missing" &&
      cases.get("inconsistent-total")?.expected?.mustNotRepairTotal === true,
    "Inconsistent Gemini fixture must require missing cost and prohibit repair."
  );

  const unknownPath = geminiCaseFiles.get("unknown-model");
  const unknown = parsedByFile.get(unknownPath);
  checkGeminiSessionMetadata(unknown?.[0], unknownPath, "main");
  const unknownMessage = onlyGeminiMessage(unknown, "unknown-model Gemini fixture");
  assert(
    unknownMessage.model === "gemini-future-synthetic-unknown",
    "Unknown-model Gemini fixture must retain an explicitly synthetic model name."
  );
  checkCompleteGeminiTokens(unknownMessage.tokens, {
    input: 600,
    output: 60,
    cached: 100,
    thoughts: 10,
    tool: 0,
    total: 670
  }, "unknown-model Gemini fixture");
  assert(
    cases.get("unknown-model")?.expected?.costEvidence === "missing" &&
      cases.get("unknown-model")?.expected?.mustNotEmitZeroCost === true,
    "Unknown-model Gemini fixture must require missing cost rather than zero cost."
  );

  const malformedPath = geminiCaseFiles.get("malformed-jsonl");
  const malformed = parsedByFile.get(malformedPath);
  checkGeminiSessionMetadata(malformed?.[0], malformedPath, "main");
  const malformedMessage = onlyGeminiMessage(malformed, "malformed-line Gemini fixture");
  checkCompleteGeminiTokens(malformedMessage.tokens, {
    input: 400,
    output: 40,
    cached: 100,
    thoughts: 5,
    tool: 5,
    total: 450
  }, "malformed-line Gemini fixture");
  assert(
    cases.get("malformed-jsonl")?.expected?.malformedLines === 1,
    "Malformed Gemini fixture must document exactly one skipped line."
  );

  const subagentPath = geminiCaseFiles.get("nested-subagent");
  const subagent = parsedByFile.get(subagentPath);
  checkGeminiSessionMetadata(subagent?.[0], subagentPath, "subagent");
  assert(
    subagentPath.includes("/chats/fixture-parent-session/"),
    "Gemini subagent fixture must remain nested below its parent session."
  );
  checkCompleteGeminiTokens(
    onlyGeminiMessage(subagent, "nested Gemini subagent fixture").tokens,
    { input: 300, output: 30, cached: 100, thoughts: 10, tool: 10, total: 350 },
    "nested Gemini subagent fixture"
  );
  assert(
    cases.get("nested-subagent")?.expected?.projectAttribution === "opaque_or_unattributed",
    "Nested Gemini fixture must not promise readable project attribution."
  );

  const logsPath = geminiCaseFiles.get("logs-only-presence");
  const logs = singleJsonDocument(parsedByFile, logsPath);
  assert(Array.isArray(logs) && logs.length === 1, "Gemini logs-only fixture must be one prompt-history array.");
  assert(
    logs.every((entry) =>
      isRecord(entry) &&
      entry.type === "user" &&
      typeof entry.sessionId === "string" &&
      typeof entry.message === "string" &&
      !containsGeminiFinancialEvidence(entry)
    ),
    "Gemini logs.json must remain detection-only prompt history with no financial evidence."
  );
  assert(!logsPath.includes("/chats/"), "Gemini logs.json must remain outside the financial chats tree.");
  assert(
    cases.get("logs-only-presence")?.expected?.geminiPresent === true &&
      cases.get("logs-only-presence")?.expected?.financialRows === 0,
    "Gemini logs-only fixture must detect presence while producing zero financial rows."
  );
}

function singleJsonDocument(parsedByFile, file) {
  const entries = parsedByFile.get(file);
  assert(Array.isArray(entries) && entries.length === 1, `Expected one JSON document: ${file}`);
  return entries[0];
}

function checkGeminiSessionMetadata(metadata, file, kind) {
  assert(isRecord(metadata), `Gemini session metadata is missing: ${file}`);
  const projectHash = file.split("/").find((part) => /^[0-9a-f]{64}$/.test(part));
  assert(typeof projectHash === "string", `Gemini fixture path lacks an opaque project hash: ${file}`);
  assert(
    typeof metadata.sessionId === "string" &&
      metadata.sessionId.startsWith("fixture-") &&
      metadata.projectHash === projectHash &&
      typeof metadata.startTime === "string" &&
      typeof metadata.lastUpdated === "string" &&
      metadata.kind === kind,
    `Gemini session metadata is not internally consistent: ${file}`
  );
  assert(
    metadata.cwd === undefined && metadata.projectRoot === undefined,
    `Gemini fixture must not invent cwd or project-root attribution: ${file}`
  );
}

function onlyGeminiMessage(entries, label) {
  assert(Array.isArray(entries), `${label} was not read.`);
  const messages = entries.filter((entry) => entry?.type === "gemini");
  assert(messages.length === 1, `${label} must contain exactly one Gemini message.`);
  return messages[0];
}

function checkGeminiTokenComponents(tokens, label) {
  assert(isRecord(tokens), `${label} is missing its token object.`);
  for (const key of ["input", "output", "cached", "thoughts", "tool", "total"]) {
    assert(nonnegativeInteger(tokens[key]), `${label} has an invalid ${key} token count.`);
  }
  assert(tokens.cached <= tokens.input, `${label} has more cached tokens than input tokens.`);
}

function checkCompleteGeminiTokens(tokens, expected, label) {
  checkGeminiTokenComponents(tokens, label);
  assert(
    geminiComponentTotal(tokens) === tokens.total,
    `${label} total must equal input + output + thoughts + tool.`
  );
  assert(
    Object.entries(expected).every(([key, value]) => tokens[key] === value),
    `${label} token split changed unexpectedly.`
  );
}

function geminiComponentTotal(tokens) {
  return tokens.input + tokens.output + tokens.thoughts + tokens.tool;
}

function containsGeminiFinancialEvidence(value) {
  if (Array.isArray(value)) return value.some(containsGeminiFinancialEvidence);
  if (!isRecord(value)) return false;
  const financialKeys = new Set([
    "model",
    "tokens",
    "stats",
    "result",
    "usage",
    "usageMetadata",
    "input",
    "output",
    "cached",
    "thoughts",
    "tool",
    "total"
  ]);
  return Object.entries(value).some(([key, item]) =>
    financialKeys.has(key) || containsGeminiFinancialEvidence(item)
  );
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
