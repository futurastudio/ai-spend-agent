import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonSession,
  parseGeminiJsonlSession,
  parseGeminiSession
} from "./gemini.js";

const hashA = "1111111111111111111111111111111111111111111111111111111111111111";
const hashB = "2222222222222222222222222222222222222222222222222222222222222222";

function aliasFor(value: string): string {
  return `gemini-project-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

describe("Gemini CLI local session parser", () => {
  it("parses legacy JSON, separates included cache, and hashes opaque project attribution", () => {
    const content = JSON.stringify({
      sessionId: "legacy-session",
      projectHash: hashA,
      startTime: "2026-08-10T12:00:00.000Z",
      geminiCliVersion: "0.56.0-nightly",
      messages: [
        {
          id: "user-1",
          type: "user",
          timestamp: "2026-08-10T12:00:00.000Z",
          content: "private prompt must not be returned"
        },
        {
          id: "model-1",
          type: "gemini",
          timestamp: "2026-08-10T12:02:00.000Z",
          model: "gemini-2.5-pro",
          content: "private response must not be returned",
          tokens: {
            input: 1_200,
            output: 120,
            cached: 400,
            thoughts: 30,
            tool: 50,
            total: 1_400
          }
        }
      ]
    });

    const result = parseGeminiSession(content, {
      filePath: `/tmp/${hashA}/chats/session-legacy.json`
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      agent: "gemini-cli",
      model: "gemini-2.5-pro",
      timestamp: "2026-08-10T12:02:00.000Z",
      startedAt: "2026-08-10T12:00:00.000Z",
      project: aliasFor(hashA),
      sessionId: "legacy-session",
      sourceVersion: "0.56.0-nightly",
      usageScope: "turn",
      usageSupport: "complete",
      reportedTotalTokens: 1_400,
      usage: {
        inputTokens: 800,
        outputTokens: 120,
        cacheReadTokens: 400,
        thoughtTokens: 30,
        toolTokens: 50
      },
      geminiTokenEvidence: {
        input: 1_200,
        output: 120,
        cached: 400,
        thoughts: 30,
        tool: 50,
        total: 1_400,
        cacheAccounting: "included"
      }
    });
    expect(JSON.stringify(result)).not.toContain(hashA);
    expect(JSON.stringify(result)).not.toContain("private prompt");
    expect(JSON.stringify(result)).not.toContain("private response");
  });

  it("uses the last token-bearing duplicate message id and ignores a later tokenless duplicate", () => {
    const content = [
      JSON.stringify({
        sessionId: "current-session",
        projectHash: hashB,
        startTime: "2026-08-10T13:00:00.000Z",
        cliVersion: "0.57.0"
      }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-08-10T13:01:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 100, output: 10, cached: 20, total: 110 }
      }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-08-10T13:02:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 900, output: 90, cached: 300, thoughts: 20, tool: 10, total: 1_020 }
      }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-08-10T13:03:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: null
      }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-08-10T13:04:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash"
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashB}/chats/nested/parent/session-current.jsonl`
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      timestamp: "2026-08-10T13:02:00.000Z",
      project: aliasFor(hashB),
      sourceVersion: "0.57.0",
      usage: {
        inputTokens: 600,
        outputTokens: 90,
        cacheReadTokens: 300,
        thoughtTokens: 20,
        toolTokens: 10
      }
    });
  });

  it("retains a unique tokenless Gemini response as missing evidence", () => {
    const result = parseGeminiJsonlSession([
      JSON.stringify({ sessionId: "tokenless-session", projectHash: hashA }),
      JSON.stringify({
        id: "tokenless-response",
        timestamp: "2026-08-10T13:08:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro"
      })
    ].join("\n"), {
      filePath: `/tmp/${hashA}/chats/tokenless.jsonl`
    });

    expect(result.calls).toEqual([expect.objectContaining({
      callId: "tokenless-response",
      usageSupport: "unsupported_token_shape",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    })]);
    expect(result.diagnostics).toEqual([{
      code: "unsupported_token_shape",
      count: 1
    }]);
  });

  it("accepts a legacy conversation document stored with a jsonl suffix", () => {
    const content = JSON.stringify({
      sessionId: "inline-legacy-session",
      projectHash: hashA,
      messages: [{
        id: "inline-legacy-response",
        timestamp: "2026-08-10T13:04:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
      }]
    });

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/legacy-with-jsonl-suffix.jsonl`
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.calls).toEqual([
      expect.objectContaining({
        callId: "inline-legacy-response",
        sessionId: "inline-legacy-session",
        usageSupport: "complete",
        reportedTotalTokens: 110
      })
    ]);
  });

  it("accepts an inline conversation record inside an append-only jsonl stream", () => {
    const content = [
      JSON.stringify({ sessionId: "inline-stream-session", projectHash: hashA }),
      JSON.stringify({
        messages: [{
          id: "inline-stream-response",
          timestamp: "2026-08-10T13:05:00.000Z",
          type: "gemini",
          model: "gemini-2.5-pro",
          tokens: { input: 120, output: 12, cached: 0, thoughts: 0, tool: 0, total: 132 }
        }]
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/inline-record.jsonl`
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.calls[0]).toMatchObject({
      callId: "inline-stream-response",
      sessionId: "inline-stream-session",
      reportedTotalTokens: 132
    });
  });

  it.each(["json", "jsonl"])(
    "keeps valid %s rows but diagnoses evolving token-bearing envelopes",
    (extension) => {
      const messages = [{
        id: "valid-response",
        timestamp: "2026-08-10T13:06:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
      }, {
        id: "future-response",
        timestamp: "2026-08-10T13:07:00.000Z",
        type: "gemini-next",
        model: "gemini-2.5-pro",
        tokens: { input: 200, output: 20, cached: 0, thoughts: 0, tool: 0, total: 220 }
      }];
      const content = extension === "json"
        ? JSON.stringify({ sessionId: "future-envelope-session", projectHash: hashA, messages })
        : [
            JSON.stringify({ sessionId: "future-envelope-session", projectHash: hashA }),
            ...messages.map((message) => JSON.stringify(message)),
            JSON.stringify(["future", "non-object", "record"])
          ].join("\n");

      const result = parseGeminiSession(content, {
        filePath: `/tmp/${hashA}/chats/future-envelope.${extension}`
      });

      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toMatchObject({
        callId: "valid-response",
        usageSupport: "complete"
      });
      expect(result.diagnostics).toEqual([{
        code: "unsupported_token_shape",
        count: extension === "json" ? 1 : 2
      }]);
    }
  );

  it("fails closed on a noncanonical cache-excluded total instead of inferring an alternative convention", () => {
    const content = [
      JSON.stringify({
        sessionId: "excluded-cache-session",
        projectHash: hashB,
        startTime: "2026-08-10T13:00:00.000Z"
      }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-08-10T13:03:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 600, output: 90, cached: 300, thoughts: 20, tool: 10, total: 1_020 }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashB}/chats/session-current.jsonl`
    });

    expect(result.calls[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 90,
      cacheReadTokens: 300,
      thoughtTokens: 20,
      toolTokens: 10
    });
    expect(result.calls[0]?.geminiTokenEvidence.cacheAccounting).toBe("unknown");
    expect(result.calls[0]?.usageSupport).toBe("unsupported_token_shape");
    expect(result.diagnostics).toEqual([{
      code: "unsupported_token_shape",
      count: 1
    }]);
  });

  it("retains partial token evidence but never infers missing components from total", () => {
    const content = [
      JSON.stringify({ sessionId: "partial", projectHash: hashA }),
      JSON.stringify({
        id: "partial-1",
        timestamp: "2026-08-10T14:01:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 500, cached: 100, tool: 10, total: 560 }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/session-partial.jsonl`
    });

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 560,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100,
        toolTokens: 10
      },
      geminiTokenEvidence: {
        input: 500,
        cached: 100,
        tool: 10,
        total: 560,
        cacheAccounting: "unknown"
      }
    });
    expect(result.diagnostics).toContainEqual({
      code: "unsupported_token_shape",
      count: 1
    });
  });

  it("fails closed on inconsistent totals and invalid token numbers", () => {
    const content = [
      JSON.stringify({ sessionId: "invalid", projectHash: hashA }),
      JSON.stringify({
        id: "bad-total",
        timestamp: "2026-08-10T15:01:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 700, output: 70, cached: 200, thoughts: 20, tool: 10, total: 999 }
      }),
      JSON.stringify({
        id: "bad-number",
        timestamp: "2026-08-10T15:02:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: -1, output: 1.5, cached: 0, thoughts: 0, tool: 0, total: 1 }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/session-invalid.jsonl`
    });

    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.usageSupport === "unsupported_token_shape")).toBe(true);
    expect(result.diagnostics).toContainEqual({
      code: "unsupported_token_shape",
      count: 2
    });
  });

  it("leaves otherwise valid rows unpriced when thought or tool splits are absent", () => {
    const content = [
      JSON.stringify({ sessionId: "missing-splits", projectHash: hashA }),
      JSON.stringify({
        id: "missing-thoughts",
        timestamp: "2026-08-10T15:03:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 700, output: 70, cached: 200, tool: 10, total: 780 }
      }),
      JSON.stringify({
        id: "missing-tool",
        timestamp: "2026-08-10T15:04:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 700, output: 70, cached: 200, thoughts: 10, total: 780 }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/session-missing-splits.jsonl`
    });

    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.usageSupport === "unsupported_token_shape")).toBe(true);
    expect(result.diagnostics).toContainEqual({
      code: "unsupported_token_shape",
      count: 2
    });
  });

  it("retains incurred token calls across checkpoints and rewinds", () => {
    const content = [
      JSON.stringify({ sessionId: "rewound", projectHash: hashA }),
      JSON.stringify({
        id: "first",
        timestamp: "2026-08-10T15:10:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
      }),
      JSON.stringify({ $rewindTo: "user-turn-before-first" }),
      JSON.stringify({
        $set: {
          messages: [{
            id: "second",
            timestamp: "2026-08-10T15:11:00.000Z",
            type: "gemini",
            model: "gemini-2.5-flash",
            tokens: { input: 200, output: 20, cached: 0, thoughts: 0, tool: 0, total: 220 }
          }]
        }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/session-rewound.jsonl`
    });

    expect(result.calls.map((call) => call.reportedTotalTokens)).toEqual([110, 220]);
    expect(result.calls.every((call) => call.usageSupport === "complete")).toBe(true);
  });

  it("fails closed when a token-bearing row lacks stable session or message identity", () => {
    const result = parseGeminiJsonlSession(JSON.stringify({
      timestamp: "2026-08-10T15:20:00.000Z",
      type: "gemini",
      model: "gemini-2.5-flash",
      tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
    }), {
      filePath: `/tmp/${hashA}/chats/session-idless.jsonl`
    });

    expect(result.calls).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "unsupported_token_shape", count: 1 }]);
  });

  it("passes an unknown model through and prefers trustworthy explicit cwd attribution", () => {
    const content = JSON.stringify({
      sessionId: "future-model",
      projectHash: hashA,
      cwd: "/workspace/sample-project/visible-project",
      startTime: "2026-08-10T16:00:00.000Z",
      messages: [{
        id: "future-1",
        timestamp: "2026-08-10T16:01:00.000Z",
        type: "gemini",
        model: "gemini-future-synthetic-unknown",
        tokens: { input: 600, output: 60, cached: 100, thoughts: 10, tool: 0, total: 670 }
      }]
    });

    const result = parseGeminiJsonSession(content, {
      filePath: `/tmp/${hashA}/chats/session-future.json`
    });

    expect(result.calls[0]).toMatchObject({
      model: "gemini-future-synthetic-unknown",
      project: "visible-project",
      workingDirectory: "/workspace/sample-project/visible-project",
      usageSupport: "complete"
    });
    expect(JSON.stringify(result)).not.toContain(hashA);
  });

  it("leaves project unattributed when path and recorded opaque hashes disagree", () => {
    const content = JSON.stringify({
      sessionId: "mismatched-project-session",
      projectHash: hashA,
      messages: [{
        id: "mismatched-project-response",
        timestamp: "2026-08-10T16:02:00.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 100, output: 10, cached: 0, thoughts: 0, tool: 0, total: 110 }
      }]
    });

    const result = parseGeminiJsonSession(content, {
      filePath: `/tmp/${hashB}/chats/session-mismatched.json`
    });

    expect(result.calls[0]?.project).toBeUndefined();
    expect(result.calls[0]?.workingDirectory).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(hashA);
    expect(JSON.stringify(result)).not.toContain(hashB);
  });

  it("counts malformed JSONL while retaining valid records and rejects invented timestamps", () => {
    const content = [
      JSON.stringify({ sessionId: "malformed", projectHash: hashA }),
      "MALFORMED",
      JSON.stringify({
        id: "missing-time",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 10, output: 2, cached: 0, total: 12 }
      }),
      JSON.stringify({
        id: "valid",
        timestamp: "2026-08-10T17:02:00.000Z",
        type: "gemini",
        model: "gemini-2.5-flash",
        tokens: { input: 400, output: 40, cached: 100, thoughts: 5, tool: 5, total: 450 }
      })
    ].join("\n");

    const result = parseGeminiJsonlSession(content, {
      filePath: `/tmp/${hashA}/chats/session-malformed.jsonl`
    });

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.timestamp).toBe("2026-08-10T17:02:00.000Z");
    expect(result.diagnostics).toEqual([
      { code: "malformed_jsonl", count: 1 },
      { code: "missing_timestamp", count: 1 }
    ]);
  });

  it("reports malformed legacy JSON without manufacturing a call", () => {
    const result = parseGeminiJsonSession("{not-json", {
      filePath: `/tmp/${hashA}/chats/session-bad.json`
    });
    expect(result).toEqual({
      calls: [],
      diagnostics: [{ code: "malformed_json", count: 1 }]
    });
  });

  it("parses window-blind so cached values stay complete; the loader narrows", () => {
    const content = JSON.stringify({
      sessionId: "windowed",
      projectHash: hashA,
      messages: [
        {
          id: "old",
          timestamp: "2026-08-10T10:00:00.000Z",
          type: "gemini",
          model: "gemini-2.5-flash",
          tokens: { input: 10, output: 1, cached: 0, total: 11 }
        },
        {
          id: "new",
          timestamp: "2026-08-10T12:00:00.000Z",
          type: "gemini",
          model: "gemini-2.5-flash",
          tokens: { input: 20, output: 2, cached: 0, total: 22 }
        }
      ]
    });

    const result = parseGeminiJsonSession(content, {
      filePath: `/tmp/${hashA}/chats/session-window.json`,
      sinceMs: Date.parse("2026-08-10T11:00:00.000Z")
    });
    // Window-blind by design (financial cache correctness): both messages
    // parse; the loader's final timestamp filter performs all narrowing.
    expect(result.calls).toHaveLength(2);
    expect(result.calls.map((call) => call.reportedTotalTokens).sort()).toEqual([11, 22]);
  });
});
