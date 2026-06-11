import { describe, expect, it } from "vitest";
import { aggregateCalls, parseClaudeCodeTranscript, parseCodexRollout } from "./localAgentLogs.js";
import { estimateTokenCostUsd } from "./modelPricing.js";
import { usageRecordSchema } from "./schema.js";

const claudeLine = (overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-08T10:00:00.000Z",
    cwd: "/Users/jose/agent-finops",
    sessionId: "sess-1",
    requestId: "req-1",
    message: {
      id: "msg-1",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
        ...usage
      }
    },
    ...overrides
  });

describe("parseClaudeCodeTranscript", () => {
  it("extracts assistant usage with cache breakdown and project from cwd", () => {
    const calls = parseClaudeCodeTranscript(claudeLine());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-opus-4-8");
    expect(calls[0]!.project).toBe("agent-finops");
    expect(calls[0]!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 500
    });
  });

  it("dedupes repeated message id + request id lines (streaming rewrites)", () => {
    const content = [claudeLine(), claudeLine()].join("\n");
    expect(parseClaudeCodeTranscript(content)).toHaveLength(1);
  });

  it("ignores non-assistant lines and malformed JSON", () => {
    const content = ['{"type":"user"}', "not json", claudeLine({ requestId: "req-2" }, {})].join("\n");
    expect(parseClaudeCodeTranscript(content)).toHaveLength(1);
  });

  it("skips synthetic placeholder messages (not real API calls)", () => {
    const synthetic = claudeLine({ requestId: "req-3", message: { id: "msg-3", model: "<synthetic>", usage: { input_tokens: 1, output_tokens: 1 } } });
    expect(parseClaudeCodeTranscript(synthetic)).toHaveLength(0);
  });
});

describe("parseCodexRollout", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-sess", cwd: "/Users/jose/pitcht-com", timestamp: "2026-06-01T17:25:37.000Z" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-01T17:30:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10_000, cached_input_tokens: 4_000, output_tokens: 100 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-01T17:40:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 25_035, cached_input_tokens: 5_504, output_tokens: 365 } } } })
  ].join("\n");

  it("uses only the LAST cumulative token_count and splits cached input", () => {
    const calls = parseCodexRollout(rollout);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent).toBe("codex");
    expect(calls[0]!.model).toBe("gpt-5.1-codex");
    expect(calls[0]!.project).toBe("pitcht-com");
    expect(calls[0]!.usage.inputTokens).toBe(25_035 - 5_504);
    expect(calls[0]!.usage.cacheReadTokens).toBe(5_504);
    expect(calls[0]!.usage.outputTokens).toBe(365);
  });

  it("returns nothing for rollouts without token counts", () => {
    expect(parseCodexRollout(JSON.stringify({ type: "session_meta", payload: {} }))).toHaveLength(0);
  });
});

describe("aggregateCalls", () => {
  it("groups by day+agent+model+project, prices via the rule table, and passes schema", () => {
    const calls = [
      ...parseClaudeCodeTranscript(claudeLine()),
      ...parseClaudeCodeTranscript(claudeLine({ requestId: "req-2", message: { id: "msg-2", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
    ];
    const records = aggregateCalls(calls);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(usageRecordSchema.safeParse(record).success).toBe(true);
    expect(record.agentId).toBe("claude-code");
    expect(record.projectId).toBe("agent-finops");
    expect(record.quantity).toBe(2);
    expect(record.costConfidence).toBe("estimated");
    expect(record.amountUsd).toBeGreaterThan(0);
  });

  it("labels unknown models as missing cost instead of guessing", () => {
    const records = aggregateCalls([{
      agent: "claude-code",
      model: "mystery-model-9",
      timestamp: "2026-06-08T10:00:00.000Z",
      usage: { inputTokens: 10, outputTokens: 10 }
    }]);
    expect(records[0]!.amountUsd).toBeNull();
    expect(records[0]!.costConfidence).toBe("missing");
  });
});

describe("estimateTokenCostUsd", () => {
  it("prices opus 4.8 at published rates including cache tiers", () => {
    // 1M in @$5 + 1M out @$25 + 1M cache-read @$0.50 + 1M 1h-write @$10
    const usd = estimateTokenCostUsd("claude-opus-4-8", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000
    });
    expect(usd).toBe(5 + 25 + 0.5 + 10);
  });

  it("returns undefined for unknown models", () => {
    expect(estimateTokenCostUsd("unknown-model", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});
