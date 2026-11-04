import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createClaudeCodeUsageTally,
  parseClaudeCodeTranscript,
  tallyClaudeCodeTranscriptLines,
  type ClaudeCodeUsageTally,
  type LocalAgentCall
} from "./localAgentLogs.js";

const fixtureTranscript = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/local-agent-formats/claude-code-v1/transcript.jsonl"
);

const line = (
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
  message: Record<string, unknown> = { stop_reason: "end_turn" }
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-04T10:00:00.000Z",
    cwd: "/workspace/checkout-api",
    sessionId: "sess-1",
    requestId: "req-1",
    message: {
      id: "msg-1",
      model: "claude-opus-5-5",
      ...message,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
        ...usage
      }
    },
    ...overrides
  });

function tokensOf(call: LocalAgentCall): number {
  return call.usage.inputTokens + call.usage.outputTokens + (call.usage.cacheReadTokens ?? 0) +
    (call.usage.cacheWrite5mTokens ?? 0) + (call.usage.cacheWrite1hTokens ?? 0);
}

function keptLines(tally: ClaudeCodeUsageTally) {
  return Object.values(tally.responses)
    .map((kept) => ({ tokens: kept.tokens, timestamp: kept.timestamp, sessionId: kept.sessionId }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.tokens - right.tokens);
}

function fullParse(text: string, filePath = "") {
  return parseClaudeCodeTranscript(text, filePath)
    .map((call) => ({ tokens: tokensOf(call), timestamp: call.timestamp, sessionId: call.sessionId }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.tokens - right.tokens);
}

describe("tallyClaudeCodeTranscriptLines", () => {
  it("keeps the same lines as the whole-file parser on the recorded fixture", () => {
    const text = readFileSync(fixtureTranscript, "utf8");
    const tally = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(text, tally);
    expect(keptLines(tally)).toEqual(fullParse(text, fixtureTranscript));
    // The fixture's malformed line carries no "usage" key, so the tally's
    // pre-filter never parses it; only malformed usage-bearing lines count.
    expect(tally.malformedLines).toBe(0);
    const [supported, unsupported] = Object.values(tally.responses)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    expect(supported).toMatchObject({ complete: true, workingDirectory: "/workspace/sample-project" });
    expect(unsupported).toMatchObject({ complete: false, tokens: 11 });
  });

  it("gives the same result when a transcript arrives in appended chunks", () => {
    // The message_start placeholder has no stop reason yet; the final does.
    const placeholder = line({}, { output_tokens: 2 }, {});
    const final = line({}, { output_tokens: 180 });
    const zeroedCopy = line({ timestamp: "2026-11-04T10:00:03.000Z" }, {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
    }, {});
    const second = line({ requestId: "req-2", timestamp: "2026-11-04T10:05:00.000Z", message: {
      id: "msg-2", model: "claude-opus-5-5", stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    } });
    const user = JSON.stringify({ type: "user", timestamp: "2026-11-04T10:04:00.000Z", message: { content: "hi" } });
    const lines = [placeholder, user, final, zeroedCopy, second];
    const whole = `${lines.join("\n")}\n`;

    const oneShot = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(whole, oneShot);

    const chunked = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(`${placeholder}\n`, chunked);
    expect(Object.values(chunked.responses)).toEqual([expect.objectContaining({ outputTokens: 2, final: false })]);
    tallyClaudeCodeTranscriptLines(`${user}\n${final}\n`, chunked);
    tallyClaudeCodeTranscriptLines(`${zeroedCopy}\n${second}\n`, chunked);

    expect(keptLines(chunked)).toEqual(keptLines(oneShot));
    expect(keptLines(chunked)).toEqual(fullParse(whole));
    expect(keptLines(chunked)).toEqual([
      { tokens: 100 + 180 + 1_000 + 500, timestamp: "2026-11-04T10:00:00.000Z", sessionId: "sess-1" },
      { tokens: 30, timestamp: "2026-11-04T10:05:00.000Z", sessionId: "sess-1" }
    ]);
  });

  it("skips synthetic placeholders and lines without usage, counts malformed lines", () => {
    const tally = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines([
      line({ message: { id: "s", model: "<synthetic>", usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: "assistant", message: { id: "no-usage", model: "claude-opus-5-5" } }),
      '{"usage": broken',
      "",
      line({ requestId: "req-9", message: { id: "msg-9", model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 6 } } })
    ].join("\n") + "\n", tally);
    expect(Object.keys(tally.responses)).toHaveLength(1);
    expect(Object.values(tally.responses)[0]).toMatchObject({ tokens: 11, complete: true });
    expect(tally.malformedLines).toBe(1);
  });

  it("counts every line without a native identity, with stable keys across chunks", () => {
    const anonymous = (output: number) => JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-04T11:00:00.000Z",
      message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: output } }
    });
    const tally = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(`${anonymous(1)}\n`, tally);
    tallyClaudeCodeTranscriptLines(`${anonymous(2)}\n${anonymous(3)}\n`, tally);
    expect(Object.keys(tally.responses).sort()).toEqual(["line:1", "line:2", "line:3"]);
    expect(fullParse(`${anonymous(1)}\n${anonymous(2)}\n${anonymous(3)}\n`)).toHaveLength(3);
  });

  it("keeps the first line of equally ranked copies and reads the iterations split", () => {
    const first = line({ cwd: "/workspace/first" });
    const copy = line({ cwd: "/workspace/copy", timestamp: "2026-11-04T10:00:01.000Z" });
    const tally = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(`${first}\n`, tally);
    tallyClaudeCodeTranscriptLines(`${copy}\n`, tally);
    expect(Object.values(tally.responses)[0]).toMatchObject({
      workingDirectory: "/workspace/first",
      timestamp: "2026-11-04T10:00:00.000Z"
    });

    const iterated = line({ requestId: "req-it", message: {
      id: "msg-it", model: "claude-opus-5-5",
      usage: {
        input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 40 },
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 10, output_tokens: 20,
            cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
            cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } }
        ]
      }
    } });
    const iterationTally = createClaudeCodeUsageTally();
    tallyClaudeCodeTranscriptLines(`${iterated}\n`, iterationTally);
    expect(Object.values(iterationTally.responses)[0]).toMatchObject({ tokens: 100, final: true, complete: true });
    expect(fullParse(`${iterated}\n`)[0]!.tokens).toBe(100);
  });
});
