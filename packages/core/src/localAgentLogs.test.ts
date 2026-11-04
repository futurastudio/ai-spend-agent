import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  aggregateCalls,
  dedupeCumulativeSessionCalls,
  hasCompleteQualitativeCoverage,
  hasExactSelectedQualitativeEvidence,
  latestObservedWorkingDirectory,
  loadLocalAgentFinancialUsage,
  loadLocalAgentUsage,
  type LocalAgentQualitativeIndexKey,
  type LocalAgentQualitativeIndexValue,
  parseClaudeCodeTranscript,
  parseCodexRollout
} from "./localAgentLogs.js";
import {
  createCodexInvocationCollector,
  parseCodexInvocations
} from "./toolInvocations.js";
import { estimateTokenCostUsd } from "./modelPricing.js";
import { usageRecordSchema } from "./schema.js";

const claudeLine = (overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-08T10:00:00.000Z",
    cwd: "/Users/testuser/agent-finops",
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

describe("latestObservedWorkingDirectory", () => {
  it("uses the newest transcript cwd and ignores a newer call without one", () => {
    expect(latestObservedWorkingDirectory([
      {
        agent: "codex",
        model: "gpt-5.6",
        timestamp: "2026-08-03T12:00:00.000Z",
        workingDirectory: "/tmp/older-project",
        usage: { inputTokens: 1, outputTokens: 1 }
      },
      {
        agent: "claude-code",
        model: "claude-opus-4-8",
        timestamp: "2026-08-03T13:00:00.000Z",
        workingDirectory: "/tmp/latest-project",
        usage: { inputTokens: 1, outputTokens: 1 }
      },
      {
        agent: "codex",
        model: "gpt-5.6",
        timestamp: "2026-08-03T14:00:00.000Z",
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    ])).toBe("/tmp/latest-project");
  });
});

describe("parseClaudeCodeTranscript", () => {
  it("extracts assistant usage with cache breakdown and project from cwd", () => {
    const calls = parseClaudeCodeTranscript(claudeLine());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-opus-4-8");
    expect(calls[0]!.project).toBe("agent-finops");
    expect(calls[0]!.workingDirectory).toBe("/Users/testuser/agent-finops");
    expect(calls[0]!.usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 500
    });
    expect(calls[0]!.tokenComponentEvidence).toEqual({
      inputTokens: "observed",
      outputTokens: "observed",
      cacheReadTokens: "observed",
      cacheWriteTokens: "observed",
      thoughtTokens: "not_separately_reported",
      toolTokens: "not_separately_reported",
      calculatedTotalTokens: "calculated_complete",
      reportedTotalTokens: "not_reported"
    });
    for (const split of [
      { ephemeral_1h_input_tokens: 200 },
      { ephemeral_5m_input_tokens: 300 },
      { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 }
    ]) {
      const [call] = parseClaudeCodeTranscript(claudeLine({}, { cache_creation: split }));
      expect(call?.usage).toMatchObject({ cacheWrite5mTokens: 300, cacheWrite1hTokens: 200 });
      expect(call?.tokenComponentEvidence?.cacheWriteTokens).toBe("observed");
      expect(call?.usageSupport).toBeUndefined();
    }
    for (const split of [
      { ephemeral_1h_input_tokens: 501 },
      { ephemeral_5m_input_tokens: 501 },
      { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 201 }
    ]) {
      const diagnostics: Array<{ code: string; count: number }> = [];
      const invalid = parseClaudeCodeTranscript(claudeLine({}, { cache_creation: split }), "", undefined,
        diagnostic => diagnostics.push(diagnostic));
      expect(invalid[0]?.usageSupport).toBe("unsupported_token_shape");
      expect(invalid[0]?.tokenComponentEvidence).toBeUndefined();
      expect(diagnostics).toEqual([{ code: "unsupported_token_shape", count: 1 }]);
      expect(aggregateCalls(invalid)[0]?.amountUsd).toBeNull();
    }
    for (const split of [{ ephemeral_1h_input_tokens: 200 }, { ephemeral_5m_input_tokens: 300 }]) {
      const [partial] = parseClaudeCodeTranscript(claudeLine({}, {
        cache_creation_input_tokens: undefined, cache_creation: split
      }));
      expect(partial?.tokenComponentEvidence?.cacheWriteTokens).toBe("partial");
      expect(partial?.tokenComponentEvidence?.calculatedTotalTokens).toBe("calculated_partial");
    }
  });

  it("prices a Claude Code fallback message as its served request and reads that request's cache split", () => {
    // A failed first attempt and the served fallback. The top level carries the
    // served request's counts but sums the cache-write split over both attempts
    // (seen in real transcripts, 2026-08-24).
    const diagnostics: Array<{ code: string; count: number }> = [];
    const [call] = parseClaudeCodeTranscript(claudeLine({}, {
      input_tokens: 2,
      output_tokens: 4750,
      cache_read_input_tokens: 686_903,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 874 },
      iterations: [
        {
          type: "message",
          model: "claude-fable-5",
          input_tokens: 2,
          output_tokens: 254,
          cache_read_input_tokens: 883_323,
          cache_creation_input_tokens: 874,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 874 }
        },
        {
          type: "fallback_message",
          model: "claude-opus-4-8",
          input_tokens: 2,
          output_tokens: 4750,
          cache_read_input_tokens: 686_903,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
        }
      ]
    }), "", undefined, diagnostic => diagnostics.push(diagnostic));
    expect(diagnostics).toEqual([]);
    expect(call?.usageSupport).toBeUndefined();
    // The failed attempt is not billed and is not added.
    expect(call?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4750,
      cacheReadTokens: 686_903,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0
    });
    expect(call?.latestTurnUsage).toMatchObject({ contextTokens: 2 + 686_903, source: "assistant_message_usage" });
    expect(call?.tokenComponentEvidence).toMatchObject({
      cacheWriteTokens: "observed",
      calculatedTotalTokens: "calculated_complete"
    });
    expect(aggregateCalls([call!])[0]?.amountUsd).toBeGreaterThan(0);
  });

  it("keeps a line whose top level does not describe its served iteration unsupported", () => {
    const diagnostics: Array<{ code: string; count: number }> = [];
    const served = {
      type: "message",
      input_tokens: 32,
      output_tokens: 5017,
      cache_read_input_tokens: 959_767,
      cache_creation_input_tokens: 2083,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2083 }
    };
    // A re-written copy with every top-level count zeroed (seen 2026-09).
    const [zeroed] = parseClaudeCodeTranscript(claudeLine({}, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2083 },
      iterations: [served]
    }), "", undefined, diagnostic => diagnostics.push(diagnostic));
    expect(zeroed?.usageSupport).toBe("unsupported_token_shape");
    // A readable top level that disagrees with its iteration is never overridden.
    const [disagreeing] = parseClaudeCodeTranscript(claudeLine({}, {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2083 },
      iterations: [served]
    }), "", undefined, diagnostic => diagnostics.push(diagnostic));
    expect(disagreeing?.usageSupport).toBe("unsupported_token_shape");
    expect(diagnostics).toEqual([
      { code: "unsupported_token_shape", count: 1 },
      { code: "unsupported_token_shape", count: 1 }
    ]);
  });

  it("leaves other iteration lists to the top-level rules", () => {
    const diagnostics: Array<{ code: string; count: number }> = [];
    const parse = (usage: Record<string, unknown>) =>
      parseClaudeCodeTranscript(claudeLine({}, usage), "", undefined, diagnostic => diagnostics.push(diagnostic))[0];
    const defaults = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 1000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 500 };
    expect(parse({ iterations: [] })?.usage).toEqual(defaults);
    expect(parse({ iterations: [{ input_tokens: "2", output_tokens: 254 }] })?.usage).toEqual(defaults);
    // A server-side side call after the served reply is not the served reply,
    // and never becomes the context size.
    const sideCall = parse({ iterations: [
      {
        type: "message",
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }
      },
      { type: "compaction", input_tokens: 50_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    ] });
    expect(sideCall?.usage).toEqual(defaults);
    expect(sideCall?.latestTurnUsage?.contextTokens).toBe(1600);
    expect(diagnostics).toEqual([]);
    // Unreadable iterations plus a contradictory top level is one unsupported
    // shape, reported once.
    const invalid = parse({
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 201 },
      iterations: [{ input_tokens: "2", output_tokens: 254 }]
    });
    expect(invalid?.usageSupport).toBe("unsupported_token_shape");
    expect(diagnostics).toEqual([{ code: "unsupported_token_shape", count: 1 }]);
  });

  it("counts a streamed message once, from the line carrying its final state", () => {
    // Claude Code 2.1.2xx writes the message_start placeholder first (2–3 output
    // tokens), the final counts later, and sometimes a zeroed copy after that.
    const diagnostics: Array<{ code: string; count: number }> = [];
    const content = [
      claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" }, { output_tokens: 3 }),
      claudeLine({ timestamp: "2026-06-08T10:00:09.000Z" }, { output_tokens: 10_966 }),
      claudeLine({ timestamp: "2026-06-08T10:00:09.500Z" }, {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }
      }),
      claudeLine({ requestId: "req-2", message: { id: "msg-2", model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 7 } } })
    ].join("\n");
    const calls = parseClaudeCodeTranscript(content, "", undefined, diagnostic => diagnostics.push(diagnostic));
    expect(calls.map(call => [call.usage.outputTokens, call.timestamp])).toEqual([
      [10_966, "2026-06-08T10:00:09.000Z"],
      [7, "2026-06-08T10:00:00.000Z"]
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("prefers the line carrying the final state, keeps the first of a tie, and counts a message that straddles the window", () => {
    // A fallback: the early line carries the failed attempt's counts and no
    // iterations; the final line carries the served request with iterations
    // and a smaller output count.
    const failedAttempt = {
      input_tokens: 2,
      output_tokens: 254,
      cache_read_input_tokens: 883_323,
      cache_creation_input_tokens: 874,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 874 }
    };
    const servedRequest = {
      input_tokens: 2,
      output_tokens: 40,
      cache_read_input_tokens: 686_903,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
    };
    const content = [
      claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" }, failedAttempt),
      claudeLine({ timestamp: "2026-06-08T10:00:20.000Z" }, {
        ...servedRequest,
        iterations: [
          { type: "message", model: "claude-fable-5", ...failedAttempt },
          { type: "fallback_message", model: "claude-opus-4-8", ...servedRequest }
        ]
      })
    ].join("\n");
    const [call] = parseClaudeCodeTranscript(content);
    expect(call?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 40,
      cacheReadTokens: 686_903,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0
    });
    expect(call?.timestamp).toBe("2026-06-08T10:00:20.000Z");
    // The placeholder sits before the window and the final line inside it:
    // the message counts (earlier versions dropped it as a duplicate).
    const straddle = parseClaudeCodeTranscript(content, "", Date.parse("2026-06-08T10:00:10.000Z"));
    expect(straddle.map(item => item.usage.outputTokens)).toEqual([40]);
    // Equal rank keeps the first line, whatever the later copy says elsewhere.
    const tie = parseClaudeCodeTranscript([
      claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" }, { cache_read_input_tokens: 1000 }),
      claudeLine({ timestamp: "2026-06-08T10:00:01.000Z" }, { cache_read_input_tokens: 999 })
    ].join("\n"));
    expect(tie.map(item => [item.usage.cacheReadTokens, item.timestamp])).toEqual([[1000, "2026-06-08T10:00:00.000Z"]]);
  });

  it("fails closed on iteration lists it does not recognise", () => {
    const diagnostics: Array<{ code: string; count: number }> = [];
    // A contradictory top-level split, so only a recognised served iteration
    // can make the line price.
    const contradictory = { cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 201 } };
    const served = {
      type: "message",
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }
    };
    const sideCall = { type: "advisor_message", input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const parse = (iterations: unknown[]) =>
      parseClaudeCodeTranscript(claudeLine({}, { ...contradictory, iterations }), "", undefined, diagnostic => diagnostics.push(diagnostic))[0];
    // Recognised: the served reply, then a server-side side call.
    const priced = parse([served, sideCall]);
    expect(priced?.usageSupport).toBeUndefined();
    expect(priced?.usage).toMatchObject({ outputTokens: 200, cacheWrite1hTokens: 500 });
    expect(priced?.latestTurnUsage?.contextTokens).toBe(1600);
    expect(diagnostics).toEqual([]);
    // Not recognised: an unknown kind or shape ends the search; a served
    // iteration missing a count, naming another model, or carrying an
    // inconsistent split never replaces the top level.
    const { cache_read_input_tokens: _absent, ...withoutRead } = served;
    for (const iterations of [
      [served, { ...sideCall, type: "retry_message" }],
      [served, null],
      [{ ...served, model: "claude-sonnet-5-5" }],
      [withoutRead],
      [{ ...served, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 5 } }]
    ]) {
      expect(parse(iterations)?.usageSupport).toBe("unsupported_token_shape");
    }
    expect(diagnostics).toHaveLength(5);
    // A served iteration that names the message's own model is recognised.
    expect(parse([{ ...served, type: "fallback_message", model: "claude-opus-4-8" }])?.usageSupport).toBeUndefined();
  });

  it("distinguishes a provider total from a partial calculated Claude component total", () => {
    const [withoutTotal] = parseClaudeCodeTranscript(claudeLine({}, {
      cache_read_input_tokens: undefined,
      cache_creation_input_tokens: undefined,
      cache_creation: undefined
    }));
    expect(withoutTotal).toMatchObject({
      tokenComponentEvidence: {
        cacheReadTokens: "not_separately_reported",
        cacheWriteTokens: "not_separately_reported",
        calculatedTotalTokens: "calculated_partial",
        reportedTotalTokens: "not_reported"
      }
    });
    expect(withoutTotal?.reportedTotalTokens).toBeUndefined();

    const [withTotal] = parseClaudeCodeTranscript(claudeLine({}, {
      total_tokens: 1_800
    }));
    expect(withTotal).toMatchObject({
      reportedTotalTokens: 1_800,
      tokenComponentEvidence: {
        calculatedTotalTokens: "calculated_complete",
        reportedTotalTokens: "provider_reported"
      }
    });
  });

  it("retains Claude host version and requires the final explicit turn marker", () => {
    const completed = [
      claudeLine({ version: "2.1.170" }),
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        timestamp: "2026-06-08T10:00:01.000Z",
        sessionId: "sess-1",
        durationMs: 1_000,
        version: "2.1.170"
      })
    ].join("\n");

    expect(parseClaudeCodeTranscript(completed)[0]).toMatchObject({
      sourceVersion: "2.1.170",
      completion: {
        status: "completed",
        evidence: "claude_turn_duration",
        observedAt: "2026-06-08T10:00:01.000Z"
      }
    });

    const resumed = [
      completed,
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-08T10:00:02.000Z",
        sessionId: "sess-1",
        message: { content: "A later task remains in progress." }
      })
    ].join("\n");
    expect(parseClaudeCodeTranscript(resumed)[0]?.completion).toBeUndefined();
  });

  it("keeps incomplete Claude usage as unpriced partial evidence instead of coercing it to zero", () => {
    const diagnostics: Array<{ code: string; count: number }> = [];
    const calls = parseClaudeCodeTranscript(
      claudeLine({}, {
        input_tokens: undefined,
        output_tokens: 25,
        total_tokens: 321
      }),
      "",
      undefined,
      (diagnostic) => diagnostics.push(diagnostic)
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 321,
      usage: { inputTokens: 0, outputTokens: 25 }
    });
    expect(calls[0]?.latestTurnUsage).toBeUndefined();
    expect(diagnostics).toEqual([{ code: "unsupported_token_shape", count: 1 }]);
    expect(aggregateCalls(calls)[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("accepts explicit numeric zero Claude components as complete usage", () => {
    const diagnostics: Array<{ code: string; count: number }> = [];
    const calls = parseClaudeCodeTranscript(
      claudeLine({}, {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0
        }
      }),
      "",
      undefined,
      (diagnostic) => diagnostics.push(diagnostic)
    );

    expect(calls[0]?.usageSupport).toBeUndefined();
    expect(calls[0]?.latestTurnUsage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      totalTokens: 0
    });
    expect(diagnostics).toEqual([]);
    expect(aggregateCalls(calls)[0]).toMatchObject({
      amountUsd: 0,
      costConfidence: "estimated"
    });
  });

  it("labels sessions launched from the home directory as (home), not the username", () => {
    const calls = parseClaudeCodeTranscript(claudeLine({ cwd: homedir() }));
    expect(calls[0]!.project).toBe("(home)");
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

  it("derives a task-level focus from human prompts without retaining raw prompt text", () => {
    const content = [
      JSON.stringify({
        type: "user",
        message: { content: "Please edit the hover glance UI to make it more transparent." }
      }),
      JSON.stringify({
        type: "user",
        message: { content: "Change the Glance hover UI so the focus description is clearer." }
      }),
      claudeLine({
        message: {
          id: "msg-focus",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{
            type: "tool_use",
            input: { file_path: "/Users/testuser/agent-finops/apps/glance-macos/GlanceView.swift" }
          }]
        }
      })
    ].join("\n");

    const activity = parseClaudeCodeTranscript(content)[0]?.activity;
    expect(activity).toMatchObject({
      summary: "Refining Glance hover UI",
      kind: "task",
      source: "user_prompts",
      promptCount: 2,
      toolCallCount: 1,
      files: ["GlanceView.swift"]
    });
    expect(JSON.stringify(activity)).not.toContain("make it more transparent");
  });

  it("turns Glance prompt and action requests into a natural agent-handoff focus", () => {
    const content = [
      JSON.stringify({
        type: "user",
        message: {
          content: "Could we include a call to action for the specific main focus in Glance?"
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: "Make sure the prompt does not look crowded in the Glance."
        }
      }),
      claudeLine({
        message: {
          id: "msg-handoff-focus",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      })
    ].join("\n");

    expect(parseClaudeCodeTranscript(content)[0]?.activity).toMatchObject({
      summary: "Building Glance agent handoff",
      kind: "agent",
      source: "user_prompts",
      promptCount: 2
    });
  });

  it("removes credential-shaped values before deriving focus metadata", () => {
    const fakeOpenAiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const fakeGithubToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const content = [
      JSON.stringify({
        type: "user",
        message: {
          content: `Fix the customer merger using ${fakeOpenAiKey} and token=${fakeGithubToken}.`
        }
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: `Please finish the customer merger; Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456.`
        }
      }),
      claudeLine({
        message: {
          id: "msg-secret-focus",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      })
    ].join("\n");

    const serialized = JSON.stringify(parseClaudeCodeTranscript(content)[0]?.activity);
    expect(serialized).toContain("customer");
    expect(serialized).not.toContain(fakeOpenAiKey);
    expect(serialized).not.toContain(fakeGithubToken);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("scopes prompt and file activity to each project when one transcript changes cwd", () => {
    const content = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-03T10:00:00.000Z",
        cwd: "/Users/testuser/project-alpha",
        sessionId: "mixed-project-session",
        message: { content: "Please launch the landing page." }
      }),
      claudeLine({
        timestamp: "2026-08-03T10:01:00.000Z",
        cwd: "/Users/testuser/project-alpha",
        sessionId: "mixed-project-session",
        requestId: "req-project-alpha",
        message: {
          id: "msg-project-alpha",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: "tool_use", input: { file_path: "/Users/testuser/project-alpha/page.tsx" } }]
        }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-03T11:00:00.000Z",
        cwd: "/Users/testuser/project-beta",
        sessionId: "mixed-project-session",
        message: { content: "Please test the MCP feature." }
      }),
      claudeLine({
        timestamp: "2026-08-03T11:01:00.000Z",
        cwd: "/Users/testuser/project-beta",
        sessionId: "mixed-project-session",
        requestId: "req-project-beta",
        message: {
          id: "msg-project-beta",
          model: "claude-opus-4-8",
          usage: { input_tokens: 30, output_tokens: 40 },
          content: [{ type: "tool_use", input: { file_path: "/Users/testuser/project-beta/mcp.test.ts" } }]
        }
      })
    ].join("\n");

    const calls = parseClaudeCodeTranscript(content);
    expect(calls.map((call) => ({
      project: call.project,
      summary: call.activity?.summary,
      files: call.activity?.files
    }))).toEqual([{
      project: "project-alpha",
      summary: "Publishing landing page",
      files: ["page.tsx"]
    }, {
      project: "project-beta",
      summary: "Testing MCP feature",
      files: ["mcp.test.ts"]
    }]);
  });
});

describe("Claude Code subagent transcript identity", () => {
  const subagentPath =
    "/Users/testuser/.claude/projects/-Users-testuser-agent-finops/sess-1/subagents/agent-abc123.jsonl";

  it("gives subagent transcript calls their own run identity from line-level agentId", () => {
    const content = [
      claudeLine({ isSidechain: true, agentId: "abc123" }),
      claudeLine({
        isSidechain: true,
        agentId: "abc123",
        timestamp: "2026-06-08T10:01:00.000Z",
        requestId: "req-sub-2",
        message: {
          id: "msg-sub-2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      })
    ].join("\n");

    const calls = parseClaudeCodeTranscript(content, subagentPath);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // The host writes the parent's sessionId on every subagent line; the
      // sessionId itself is deliberately untouched (financial identity).
      expect(call.sessionId).toBe("sess-1");
      expect(call.subagentId).toBe("abc123");
      expect(call.activity?.isSubagent).toBe(true);
    }
  });

  it("treats line-level agentId as subagent evidence even without path or sidechain markers", () => {
    const calls = parseClaudeCodeTranscript(claudeLine({ agentId: "zed999" }));
    expect(calls[0]?.subagentId).toBe("zed999");
    expect(calls[0]?.activity?.isSubagent).toBe(true);
  });

  it("falls back to the subagents/ file name when lines omit agentId, and never invents one elsewhere", () => {
    const withoutAgentId = parseClaudeCodeTranscript(
      claudeLine({ isSidechain: true }),
      subagentPath
    );
    expect(withoutAgentId[0]?.subagentId).toBe("agent-abc123");

    const parentFile = parseClaudeCodeTranscript(
      claudeLine(),
      "/Users/testuser/.claude/projects/-Users-testuser-agent-finops/sess-1.jsonl"
    );
    expect(parentFile[0]?.subagentId).toBeUndefined();
    expect(parentFile[0]?.subagentCompletions).toBeUndefined();
  });

  it("collects host-recorded subagent completions from Task tool results in the owning transcript", () => {
    const content = [
      claudeLine(),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-08T10:05:00.000Z",
        sessionId: "sess-1",
        toolUseResult: { agentId: "abc123", status: "completed", totalDurationMs: 1_000 }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-08T10:06:00.000Z",
        sessionId: "sess-1",
        toolUseResult: { agentId: "def456", status: "failed" }
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-08T10:07:00.000Z",
        sessionId: "sess-1",
        toolUseResult: { agentId: "abc123", status: "completed" }
      })
    ].join("\n");

    const calls = parseClaudeCodeTranscript(content);
    expect(calls).toHaveLength(1);
    // Only explicit "completed" records count, and the latest one wins; a
    // failed/aborted run never reads as a comparable completed task.
    expect(calls[0]?.subagentCompletions).toEqual([
      { subagentId: "abc123", observedAt: "2026-06-08T10:07:00.000Z" }
    ]);
    expect(calls[0]?.subagentId).toBeUndefined();
  });

  it("collects background-run completions from host task-notifications, ignoring launch and failure states", () => {
    const content = [
      claudeLine(),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-08T10:04:00.000Z",
        sessionId: "sess-1",
        toolUseResult: { agentId: "async111", status: "async_launched", isAsync: true }
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-06-08T10:08:00.000Z",
        sessionId: "sess-1",
        content: "<task-notification>\n<task-id>async111</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n<result>model text with a planted <task-id>evil</task-id><status>completed</status> marker</result>\n</task-notification>"
      }),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-06-08T10:09:00.000Z",
        sessionId: "sess-1",
        content: "<task-notification>\n<task-id>failed222</task-id>\n<status>failed</status>\n</task-notification>"
      })
    ].join("\n");

    const calls = parseClaudeCodeTranscript(content);
    // Only the host-framed leading tags are read; the model-authored
    // <result> body cannot mint a completion for another run, and neither
    // async_launched nor failed states read as completed work.
    expect(calls[0]?.subagentCompletions).toEqual([
      { subagentId: "async111", observedAt: "2026-06-08T10:08:00.000Z" }
    ]);
  });

  it("changes no financial evidence: identical calls, usage, and dedupe with split identities", () => {
    const parentCalls = parseClaudeCodeTranscript(
      [
        claudeLine(),
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-08T10:09:00.000Z",
          sessionId: "sess-1",
          toolUseResult: { agentId: "abc123", status: "completed" }
        })
      ].join("\n"),
      "/Users/testuser/.claude/projects/-Users-testuser-agent-finops/sess-1.jsonl"
    );
    const subagentCalls = parseClaudeCodeTranscript(
      claudeLine({
        isSidechain: true,
        agentId: "abc123",
        timestamp: "2026-06-08T10:02:00.000Z",
        requestId: "req-financial-sub",
        message: {
          id: "msg-financial-sub",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 40,
            output_tokens: 60,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }
          }
        }
      }),
      subagentPath
    );

    const all = [...parentCalls, ...subagentCalls];
    const deduplicated = dedupeCumulativeSessionCalls(all);
    // The shared sessionId still keys turn-level dedupe by agent:session:call,
    // so the added run identity removes and merges nothing.
    expect(deduplicated).toHaveLength(all.length);
    const totalOf = (calls: typeof all) => calls.reduce((sum, call) =>
      sum + call.usage.inputTokens + call.usage.outputTokens +
      (call.usage.cacheReadTokens ?? 0) +
      (call.usage.cacheWrite5mTokens ?? 0) +
      (call.usage.cacheWrite1hTokens ?? 0), 0);
    expect(totalOf(deduplicated)).toBe(totalOf(all));
    expect(totalOf(deduplicated)).toBe(100 + 200 + 1_000 + 0 + 500 + 40 + 60 + 300 + 100 + 0);
  });
});

describe("parseCodexRollout", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-sess", cwd: "/Users/testuser/pitcht-com", timestamp: "2026-06-01T17:25:37.000Z" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-01T17:30:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10_000, cached_input_tokens: 4_000, output_tokens: 100 }, last_token_usage: { input_tokens: 4_000, cached_input_tokens: 3_000, output_tokens: 100, total_tokens: 4_100 } } } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-06-01T17:40:00.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 25_035,
            cached_input_tokens: 5_504,
            output_tokens: 365
          },
          last_token_usage: {
            input_tokens: 27_419,
            cached_input_tokens: 22_400,
            output_tokens: 78,
            reasoning_output_tokens: 8,
            total_tokens: 27_497
          }
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 71,
            window_minutes: 300,
            resets_at: Date.parse("2026-06-01T20:00:00.000Z") / 1_000
          },
          secondary: {
            used_percent: 43,
            window_minutes: 10_080,
            resets_at: Date.parse("2026-06-08T00:00:00.000Z") / 1_000
          }
        }
      }
    })
  ].join("\n");

  it("uses the latest cumulative usage, timestamp, and provider-reported limits", () => {
    const calls = parseCodexRollout(rollout);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.agent).toBe("codex");
    expect(calls[0]!.model).toBe("gpt-5.1-codex");
    expect(calls[0]!.project).toBe("pitcht-com");
    expect(calls[0]!.workingDirectory).toBe("/Users/testuser/pitcht-com");
    expect(calls[0]!.startedAt).toBe("2026-06-01T17:25:37.000Z");
    expect(calls[0]!.timestamp).toBe("2026-06-01T17:40:00.000Z");
    expect(calls[0]!.usage.inputTokens).toBe(25_035 - 5_504);
    expect(calls[0]!.usage.cacheReadTokens).toBe(5_504);
    expect(calls[0]!.usage.outputTokens).toBe(365);
    expect(calls[0]!.latestTurnUsage).toEqual({
      inputTokens: 5_019,
      outputTokens: 78,
      cacheReadTokens: 22_400,
      contextTokens: 27_419,
      totalTokens: 27_497,
      source: "transcript_last_token_usage"
    });
    expect(calls[0]!.rateLimits).toEqual({
      observedAt: "2026-06-01T17:40:00.000Z",
      limitId: "codex",
      planType: "pro",
      windows: [
        {
          kind: "five-hour",
          name: "five-hour",
          usedPercent: 71,
          windowMinutes: 300,
          resetsAt: "2026-06-01T20:00:00.000Z"
        },
        {
          kind: "weekly",
          name: "weekly",
          usedPercent: 43,
          windowMinutes: 10_080,
          resetsAt: "2026-06-08T00:00:00.000Z"
        }
      ]
    });
  });

  it("retains Codex host version and requires a matching final task completion", () => {
    const completed = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-completed",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-06-01T17:25:37.000Z",
          cli_version: "0.136.0-alpha.2"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T17:26:00.000Z",
        payload: { type: "task_started", turn_id: "turn-1" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T17:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T17:30:01.000Z",
        payload: { type: "task_complete", turn_id: "turn-1" }
      })
    ].join("\n");

    expect(parseCodexRollout(completed)[0]).toMatchObject({
      sourceVersion: "0.136.0-alpha.2",
      completion: {
        status: "completed",
        evidence: "codex_task_complete",
        observedAt: "2026-06-01T17:30:01.000Z"
      }
    });

    const nextTaskStarted = [
      completed,
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T17:31:00.000Z",
        payload: { type: "task_started", turn_id: "turn-2" }
      })
    ].join("\n");
    expect(parseCodexRollout(nextTaskStarted)[0]?.completion).toBeUndefined();
  });

  it("collects identical privacy-safe invocation evidence during the usage parse", () => {
    const content = [
      rollout,
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T17:40:01.000Z",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "/private/customer/roadmap.md" })
        }
      })
    ].join("\n");
    const collector = createCodexInvocationCollector();

    expect(parseCodexRollout(content, collector.consume)).toHaveLength(1);
    const sharedPass = collector.finish();
    expect(sharedPass).toEqual(parseCodexInvocations(content));
    expect(sharedPass.contextSignal.fileReads).toEqual([
      { name: "roadmap.md", count: 1 }
    ]);
    expect(JSON.stringify(sharedPass)).not.toContain("/private/customer");
  });

  it("attributes a home-launched Codex session to its dominant tool workdir", () => {
    const projectRoot = join(homedir(), "agent-finops");
    const homeLaunched = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-home",
          cwd: homedir(),
          timestamp: "2026-07-28T16:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "npm test", workdir: projectRoot })
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "npm run build",
            workdir: join(projectRoot, "apps", "web")
          })
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-28T16:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 5_000,
              output_tokens: 1_000
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(homeLaunched)[0]).toMatchObject({
      project: "agent-finops",
      workingDirectory: projectRoot
    });
  });

  it("recovers workdirs from the current nested Codex exec envelope without evaluating it", () => {
    const projectRoot = join(homedir(), "agent-finops");
    const nestedExec = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-nested-exec",
          cwd: homedir(),
          timestamp: "2026-08-03T14:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: [
            "const first = await tools.exec_command({",
            `  cmd: \"npm test\", workdir: ${JSON.stringify(projectRoot)}`,
            "});",
            "const second = await tools.exec_command({",
            `  cmd: \"npm run build\", workdir: ${JSON.stringify(join(projectRoot, "apps", "web"))}`,
            "});"
          ].join("\n")
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T14:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 5_000,
              output_tokens: 1_000
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(nestedExec)[0]).toMatchObject({
      project: "agent-finops",
      workingDirectory: projectRoot
    });
  });

  it("summarizes Codex prompts and marks delegated sessions", () => {
    const delegated = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-subagent",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-07-28T16:00:00.000Z",
          thread_source: "subagent",
          parent_thread_id: "codex-parent",
          source: { subagent: { other: "worker" } }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-28T16:00:00.000Z",
        payload: {
          type: "task_started",
          started_at: Date.parse("2026-07-28T16:00:00.000Z") / 1_000,
          turn_id: "codex-subagent-turn"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Test the MCP feature with multiple AI providers." }]
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please verify the MCP feature provider tests." }]
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: /Users/testuser/agent-finops/packages/mcp/src/index.test.ts\n*** End Patch\n"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-28T16:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 5_000,
              output_tokens: 1_000
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(delegated)[0]?.activity).toMatchObject({
      summary: "Testing MCP feature",
      kind: "agent",
      source: "user_prompts",
      promptCount: 2,
      toolCallCount: 1,
      files: ["index.test.ts"],
      isSubagent: true,
      parentSessionId: "codex-parent"
    });
  });

  it("does not turn screenshot attachment prose or filenames into a work topic", () => {
    const attachmentOnly = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-attachment-noise",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-03T15:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Also here is the screenshot from earlier: Screenshot 2026-08-03 at 11.15.49 AM.png"
          }]
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "This attached image is the one I mentioned above, codex-clipboard-pm.png"
          }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 250_000,
              cached_input_tokens: 220_000,
              output_tokens: 3_000
            },
            last_token_usage: {
              input_tokens: 42_000,
              cached_input_tokens: 38_000,
              output_tokens: 300,
              total_tokens: 42_300
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(attachmentOnly)[0]?.activity).toMatchObject({
      summary: "Working in agent-finops",
      source: "project",
      promptCount: 2
    });
  });

  it("keeps a recognized aibill prompt topic while dropping its attachment filename", () => {
    const promptReview = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-aibill-prompt",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-03T15:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Here is the prompt from my personal aibill analysis in Screenshot 2026-08-03 PM.png"
          }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 250_000,
              cached_input_tokens: 220_000,
              output_tokens: 3_000
            },
            last_token_usage: {
              input_tokens: 42_000,
              cached_input_tokens: 38_000,
              output_tokens: 300,
              total_tokens: 42_300
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(promptReview)[0]?.activity).toMatchObject({
      summary: "Working aibill prompt",
      source: "user_prompts",
      promptCount: 1
    });
  });

  it("keeps temporary screenshot paths out of the user-facing focus summary", () => {
    const rollout = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-hover",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-07-28T16:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Please refine the hover using /var/folders/cz_5fv/codex-clipboard.png."
          }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-28T16:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 5_000,
              output_tokens: 1_000
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(rollout)[0]?.activity?.summary).toBe(
      "Refining hover interaction"
    );
  });

  it("keeps the first/root identity and subtracts inherited parent usage for a fork", () => {
    const rootStartedAt = "2026-08-03T15:00:00.000Z";
    const forked = [
      JSON.stringify({
        type: "session_meta",
        timestamp: rootStartedAt,
        payload: {
          id: "child-root",
          cwd: "/Users/testuser/project-alpha",
          timestamp: rootStartedAt,
          thread_source: "subagent",
          parent_thread_id: "parent-root",
          source: { subagent: { other: "reviewer" } }
        }
      }),
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-03T15:00:00.100Z",
        payload: {
          id: "parent-root",
          cwd: "/Users/testuser/project-beta",
          timestamp: "2026-08-03T09:00:00.000Z",
          thread_source: "user"
        }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-03T15:00:00.200Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please test the MCP feature." }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:00:00.300Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 700,
              output_tokens: 100
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: rootStartedAt,
        payload: {
          type: "task_started",
          started_at: Date.parse(rootStartedAt) / 1_000,
          turn_id: "root-turn"
        }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-03T15:00:01.000Z",
        payload: { model: "gpt-5.6-sol", cwd: "/Users/testuser/project-beta" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-03T15:00:02.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please launch the landing page." }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_500,
              cached_input_tokens: 1_000,
              output_tokens: 160
            },
            last_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 300,
              output_tokens: 60,
              total_tokens: 560
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(forked)[0]).toMatchObject({
      sessionId: "child-root",
      startedAt: rootStartedAt,
      project: "project-alpha",
      workingDirectory: "/Users/testuser/project-alpha",
      usage: {
        inputTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 60
      },
      latestTurnUsage: {
        inputTokens: 200,
        cacheReadTokens: 300,
        outputTokens: 60,
        contextTokens: 500,
        totalTokens: 560
      },
      activity: {
        summary: "Publishing landing page",
        isSubagent: true,
        parentSessionId: "parent-root"
      }
    });
  });

  it("marks a fork unsupported when cumulative non-cached input regresses", () => {
    const rootStartedAt = "2026-08-03T15:00:00.000Z";
    const forked = [
      JSON.stringify({
        type: "session_meta",
        timestamp: rootStartedAt,
        payload: {
          id: "child-regressed-uncached",
          timestamp: rootStartedAt,
          thread_source: "subagent"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:00:00.100Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 10,
              total_tokens: 110
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: rootStartedAt,
        payload: {
          type: "task_started",
          started_at: Date.parse(rootStartedAt) / 1_000
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 150,
              cached_input_tokens: 100,
              output_tokens: 20,
              total_tokens: 170
            }
          }
        }
      })
    ].join("\n");

    expect(parseCodexRollout(forked)[0]).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 60,
      usage: { inputTokens: 0, cacheReadTokens: 100, outputTokens: 10 }
    });
  });

  it("marks inconsistent cumulative total_tokens unsupported", () => {
    const inconsistentCurrent = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "inconsistent-current-total", timestamp: "2026-08-03T15:00:00.000Z" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-03T15:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              total_tokens: 109
            }
          }
        }
      })
    ].join("\n");

    const call = parseCodexRollout(inconsistentCurrent)[0];
    expect(call).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 109,
      usage: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10 }
    });
    expect(call?.latestTurnUsage).toBeUndefined();
  });

  it("omits ambiguous forks without post-boundary root usage instead of charging parent history", () => {
    const rootStartedAt = "2026-08-03T15:00:00.000Z";
    const rootMeta = JSON.stringify({
      type: "session_meta",
      timestamp: rootStartedAt,
      payload: {
        id: "child-root",
        timestamp: rootStartedAt,
        thread_source: "subagent",
        parent_thread_id: "parent-root",
        source: { subagent: { other: "reviewer" } }
      }
    });
    const inheritedTotal = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-03T15:00:00.100Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 700,
            output_tokens: 100
          }
        }
      }
    });
    const boundary = JSON.stringify({
      type: "event_msg",
      timestamp: rootStartedAt,
      payload: {
        type: "task_started",
        started_at: Date.parse(rootStartedAt) / 1_000,
        turn_id: "root-turn"
      }
    });

    expect(parseCodexRollout([rootMeta, inheritedTotal, boundary].join("\n"))).toEqual([]);
    expect(parseCodexRollout([rootMeta, inheritedTotal].join("\n"))).toEqual([]);
  });

  it("returns nothing for rollouts without token counts", () => {
    expect(parseCodexRollout(JSON.stringify({ type: "session_meta", payload: {} }))).toHaveLength(0);
  });

  it("marks nonzero total-only token snapshots unsupported instead of estimating $0", () => {
    const totalOnly = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-total-only",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T10:05:00.000Z",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 42_000 } }
        }
      })
    ].join("\n");

    const calls = parseCodexRollout(totalOnly);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 42_000,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    });
    expect(aggregateCalls(calls)[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });
});

describe("aggregateCalls", () => {
  it("keeps only the latest Codex cumulative snapshot for one session", () => {
    const early = {
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      timestamp: "2026-08-03T10:00:00.000Z",
      project: "agent-finops",
      sessionId: "same-session",
      usageScope: "session_cumulative" as const,
      usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 9_000 }
    };
    const latest = {
      ...early,
      timestamp: "2026-08-03T11:00:00.000Z",
      usage: { inputTokens: 2_000, outputTokens: 200, cacheReadTokens: 18_000 }
    };

    expect(dedupeCumulativeSessionCalls([early, latest])).toEqual([latest]);
    const records = aggregateCalls([early, latest]);
    expect(records).toHaveLength(1);
    expect(records[0]!.quantity).toBe(1);
    expect(records[0]!.inputTokens).toBe(20_000);
  });

  it("never dedupes distinct root session ids that share inherited parent history", () => {
    const first = {
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      timestamp: "2026-08-03T10:00:00.000Z",
      sessionId: "fork-root-a",
      usageScope: "session_cumulative" as const,
      usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 9_000 },
      activity: {
        summary: "Working in agent-finops",
        kind: "project" as const,
        action: "working" as const,
        source: "project" as const,
        promptCount: 0,
        toolCallCount: 0,
        files: [],
        isSubagent: true,
        parentSessionId: "shared-parent"
      }
    };
    const second = {
      ...first,
      timestamp: "2026-08-03T10:01:00.000Z",
      sessionId: "fork-root-b"
    };

    expect(dedupeCumulativeSessionCalls([first, second])).toHaveLength(2);
  });

  it("fails conflicting stable-turn duplicates closed independent of file order", () => {
    const base = {
      agent: "gemini-cli" as const,
      callId: "same-message",
      sessionId: "same-session",
      timestamp: "2026-08-10T10:00:00.000Z",
      usageScope: "turn" as const,
      usageSupport: "complete" as const,
      usage: { inputTokens: 100, outputTokens: 10 }
    };
    const pro = { ...base, model: "gemini-2.5-pro", project: "project-a" };
    const flash = { ...base, model: "gemini-2.5-flash", project: "project-b" };
    const conflicts: string[] = [];

    const forward = dedupeCumulativeSessionCalls([pro, flash], (agent) => conflicts.push(agent));
    const reverse = dedupeCumulativeSessionCalls([flash, pro]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([expect.objectContaining({
      agent: "gemini-cli",
      model: "conflicting-local-evidence",
      usageSupport: "unsupported_token_shape",
      usage: { inputTokens: 0, outputTokens: 0 }
    })]);
    expect(forward[0]?.project).toBeUndefined();
    expect(conflicts).toEqual(["gemini-cli"]);
    expect(aggregateCalls(forward)[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("fails later or larger conflicting stable-turn copies closed in both orders", () => {
    const base = {
      agent: "gemini-cli" as const,
      callId: "same-message",
      sessionId: "same-session",
      usageScope: "turn" as const,
      usageSupport: "complete" as const
    };
    const earlier = {
      ...base,
      model: "gemini-2.5-pro",
      timestamp: "2026-08-10T10:00:00.000Z",
      project: "project-a",
      usage: { inputTokens: 100, outputTokens: 10 }
    };
    const laterLarger = {
      ...base,
      model: "gemini-2.5-flash",
      timestamp: "2026-08-11T10:00:00.000Z",
      project: "project-b",
      usage: { inputTokens: 1_000, outputTokens: 100 }
    };

    const forward = dedupeCumulativeSessionCalls([earlier, laterLarger]);
    const reverse = dedupeCumulativeSessionCalls([laterLarger, earlier]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([expect.objectContaining({
      model: "conflicting-local-evidence",
      timestamp: "2026-08-10T10:00:00.000Z",
      usageSupport: "unsupported_token_shape",
      usage: { inputTokens: 0, outputTokens: 0 }
    })]);
    expect(aggregateCalls(forward)[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("allows a complete stable-turn copy to supersede an unsupported early snapshot", () => {
    const unsupported = {
      agent: "gemini-cli" as const,
      callId: "same-message",
      sessionId: "same-session",
      model: "gemini-2.5-pro",
      timestamp: "2026-08-10T10:00:00.000Z",
      usageScope: "turn" as const,
      usageSupport: "unsupported_token_shape" as const,
      usage: { inputTokens: 0, outputTokens: 0 }
    };
    const complete = {
      ...unsupported,
      usageSupport: "complete" as const,
      usage: { inputTokens: 100, outputTokens: 10 }
    };

    expect(dedupeCumulativeSessionCalls([unsupported, complete])).toEqual([complete]);
    expect(dedupeCumulativeSessionCalls([complete, unsupported])).toEqual([complete]);
  });

  it("keeps one call when the same complete stable turn is written twice with different timestamps", () => {
    // A sub-agent transcript opens with the parent turn it was forked from,
    // seconds later: two copies with the same evidence, timestamps apart.
    const base = {
      agent: "claude-code" as const,
      callId: "same-message",
      sessionId: "same-session",
      model: "claude-opus-5-5",
      project: "agent-finops",
      usageScope: "turn" as const,
      usage: {
        inputTokens: 2,
        outputTokens: 2659,
        cacheReadTokens: 172_213,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 21_985
      }
    };
    const parent = { ...base, timestamp: "2026-10-31T22:49:56.701Z" };
    const forked = { ...base, timestamp: "2026-10-31T22:50:10.120Z", subagentId: "agent-a582e5" };
    const conflicts: string[] = [];

    const forward = dedupeCumulativeSessionCalls([parent, forked], (agent) => conflicts.push(agent));
    const reverse = dedupeCumulativeSessionCalls([forked, parent], (agent) => conflicts.push(agent));

    expect(forward).toEqual([parent]);
    expect(reverse).toEqual([parent]);
    expect(conflicts).toEqual([]);
    // The originating copy wins even when the sub-agent file was written first;
    // without a sub-agent copy, the earliest wins.
    const earlierFork = { ...forked, timestamp: "2026-10-31T22:49:40.000Z" };
    expect(dedupeCumulativeSessionCalls([earlierFork, parent])).toEqual([parent]);
    expect(dedupeCumulativeSessionCalls([parent, earlierFork])).toEqual([parent]);
    const laterPlain = { ...base, timestamp: "2026-10-31T22:50:10.120Z" };
    expect(dedupeCumulativeSessionCalls([laterPlain, parent])).toEqual([parent]);
  });

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
    expect(record.usageGranularity).toBe("daily_aggregate");
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

  it("does not assign a GPT price to an undocumented Codex alias", () => {
    const records = aggregateCalls([{
      agent: "codex",
      model: "codex-auto-review",
      timestamp: "2026-08-08T10:00:00.000Z",
      usage: { inputTokens: 100_000, outputTokens: 10_000 }
    }]);
    expect(records[0]).toMatchObject({ amountUsd: null, costConfidence: "missing" });
  });

  it("does not partially price a group when one cumulative snapshot has unsupported usage", () => {
    const shared = {
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      timestamp: "2026-08-08T10:00:00.000Z",
      project: "agent-finops"
    };
    const records = aggregateCalls([
      {
        ...shared,
        sessionId: "complete-session",
        usageScope: "session_cumulative",
        usageSupport: "complete",
        usage: { inputTokens: 100_000, outputTokens: 10_000 }
      },
      {
        ...shared,
        sessionId: "total-only-session",
        usageScope: "session_cumulative",
        usageSupport: "unsupported_token_shape",
        reportedTotalTokens: 50_000,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      quantity: 2,
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("prices GPT-5.6 per turn but fails closed for an ambiguous cumulative long-context aggregate", () => {
    const base = {
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      project: "agent-finops",
      usageSupport: "complete" as const
    };
    const turns = aggregateCalls([
      {
        ...base,
        timestamp: "2026-08-13T10:00:00.000Z",
        sessionId: "session-1",
        callId: "turn-1",
        usageScope: "turn",
        usage: { inputTokens: 150_000, outputTokens: 10_000 }
      },
      {
        ...base,
        timestamp: "2026-08-13T11:00:00.000Z",
        sessionId: "session-1",
        callId: "turn-2",
        usageScope: "turn",
        usage: { inputTokens: 150_000, outputTokens: 10_000 }
      }
    ]);
    const cumulative = aggregateCalls([{
      ...base,
      timestamp: "2026-08-13T11:00:00.000Z",
      sessionId: "session-2",
      usageScope: "session_cumulative",
      usage: { inputTokens: 300_000, outputTokens: 20_000 }
    }]);

    expect(turns[0]).toMatchObject({
      quantity: 2,
      amountUsd: 1.6,
      costConfidence: "estimated"
    });
    expect(cumulative[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("prices Gemini 2.5 Pro per turn before daily aggregation", () => {
    const geminiCall = (timestamp: string, inputTokens = 150_000) => ({
      agent: "gemini-cli" as const,
      model: "gemini-2.5-pro",
      timestamp,
      project: "gemini-project-test",
      usageScope: "turn" as const,
      usageSupport: "complete" as const,
      reportedTotalTokens: inputTokens + 10_000,
      usage: {
        inputTokens,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        thoughtTokens: 0,
        toolTokens: 0
      },
      geminiTokenEvidence: {
        input: inputTokens,
        output: 10_000,
        cached: 0,
        thoughts: 0,
        tool: 0,
        total: inputTokens + 10_000,
        cacheAccounting: "none" as const
      }
    });

    const records = aggregateCalls([
      geminiCall("2026-08-10T10:00:00.000Z"),
      geminiCall("2026-08-10T11:00:00.000Z")
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      quantity: 2,
      amountUsd: 0.575,
      costConfidence: "estimated"
    });

    const mixedTiers = aggregateCalls([
      geminiCall("2026-08-10T12:00:00.000Z"),
      geminiCall("2026-08-10T13:00:00.000Z", 250_000)
    ]);
    expect(mixedTiers[0]?.amountUsd).toBe(1.0625);
  });

  it("prices Claude Haiku 5.5 transcript requests per request, counting cache reads and writes", () => {
    const haikuLine = (id: string, cacheReadTokens: number) => claudeLine(
      {
        requestId: `req-${id}`,
        message: {
          id: `msg-${id}`,
          model: "claude-haiku-5-5",
          usage: {
            input_tokens: 20_000,
            output_tokens: 20_000,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 30_000,
            cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 10_000 }
          }
        }
      }
    );
    // Same session and day: a 100,000-token prompt, then a 100,001-token prompt.
    const calls = parseClaudeCodeTranscript([
      haikuLine("at-threshold", 50_000),
      haikuLine("over-threshold", 50_001)
    ].join("\n"));

    expect(calls).toHaveLength(2);
    expect(aggregateCalls(calls)).toEqual([expect.objectContaining({
      model: "claude-haiku-5-5",
      quantity: 2,
      // 0.017 at the base rates plus 0.08500005 at the higher rates.
      amountUsd: 0.102,
      costConfidence: "estimated"
    })]);
  });

  it("prices Gemini 4 Argon at the rates in force on each call's UTC day", () => {
    const argonCall = (timestamp: string) => ({
      agent: "gemini-cli" as const,
      callId: `argon-${timestamp}`,
      sessionId: "argon-session",
      model: "gemini-4-argon",
      timestamp,
      project: "gemini-project-test",
      usageScope: "turn" as const,
      usageSupport: "complete" as const,
      reportedTotalTokens: 167_000,
      // promptTokenCount 150K includes 50K cached tokens.
      usage: {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadTokens: 50_000,
        thoughtTokens: 5_000,
        toolTokens: 2_000
      },
      geminiTokenEvidence: {
        input: 150_000,
        output: 10_000,
        cached: 50_000,
        thoughts: 5_000,
        tool: 2_000,
        total: 167_000,
        cacheAccounting: "included" as const
      }
    });

    const records = aggregateCalls([
      argonCall("2026-11-30T23:59:59.999Z"),
      argonCall("2026-12-01T00:00:00.000Z")
    ]);

    // 100K*2 + 10K*10 + 50K*0.10 + 5K*10 + 2K*2 per million, doubled from December.
    expect(records).toEqual([
      expect.objectContaining({ timestamp: "2026-11-30T00:00:00.000Z", amountUsd: 0.359, costConfidence: "estimated" }),
      expect.objectContaining({ timestamp: "2026-12-01T00:00:00.000Z", amountUsd: 0.718, costConfidence: "estimated" })
    ]);
  });

  it("fails Gemini 2.5 Pro pricing closed when request-level prompt evidence is ambiguous", () => {
    const records = aggregateCalls([{
      agent: "gemini-cli",
      model: "gemini-2.5-pro",
      timestamp: "2026-08-10T10:00:00.000Z",
      project: "gemini-project-test",
      usageScope: "turn",
      usageSupport: "complete",
      usage: {
        inputTokens: 250_000,
        outputTokens: 10_000
      }
    }]);

    expect(records[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("fails Gemini Pro pricing closed when tool tokens straddle the published prompt tier", () => {
    const input = 199_000;
    const tool = 2_000;
    const records = aggregateCalls([{
      agent: "gemini-cli",
      model: "gemini-2.5-pro",
      timestamp: "2026-08-10T10:00:00.000Z",
      project: "gemini-project-test",
      usageScope: "turn",
      usageSupport: "complete",
      reportedTotalTokens: input + tool + 100,
      usage: {
        inputTokens: input,
        outputTokens: 100,
        cacheReadTokens: 0,
        thoughtTokens: 0,
        toolTokens: tool
      },
      geminiTokenEvidence: {
        input,
        output: 100,
        cached: 0,
        thoughts: 0,
        tool,
        total: input + tool + 100,
        cacheAccounting: "none"
      }
    }]);

    expect(records[0]).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
  });

  it("keeps home-launched sessions unattributed instead of inventing a Home project", () => {
    const records = aggregateCalls([{
      agent: "codex",
      model: "gpt-5.6-sol",
      timestamp: "2026-08-03T10:00:00.000Z",
      project: "(home)",
      usage: { inputTokens: 10_000, outputTokens: 1_000 }
    }]);

    expect(records[0]!.projectId).toBeUndefined();
    expect(records[0]!.id).toContain("home");
  });
});

describe("loadLocalAgentUsage diagnostics", () => {
  it("distinguishes a missing directory from a readable directory with no usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-local-diagnostics-"));
    const readableCodex = join(root, "codex");
    await mkdir(readableCodex);

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: join(root, "missing-claude"),
      codexSessionsDir: readableCodex
    });

    expect(result.sourceScans).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "claude-code", directoryStatus: "missing" }),
      expect.objectContaining({ agent: "codex", directoryStatus: "readable", filesDiscovered: 0 })
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      agent: "claude-code",
      code: "directory_missing",
      severity: "info"
    }));
  });

  it("reports malformed JSONL and unsupported Codex usage without exposing transcript text", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-local-malformed-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    const secretishMalformedLine = "not-json sk-proj-this-must-not-appear";
    await writeFile(join(claudeDir, "session.jsonl"), secretishMalformedLine, "utf8");
    await writeFile(join(codexDir, "rollout-total.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "total-only", timestamp: "2026-08-08T10:00:00.000Z" }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T10:05:00.000Z",
        payload: { type: "token_count", info: { total_token_usage: { total_tokens: 12_345 } } }
      })
    ].join("\n"), "utf8");

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir
    });

    expect(result.sourceScans).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "claude-code", malformedLines: 1 }),
      expect.objectContaining({ agent: "codex", unsupportedUsageSnapshots: 1 })
    ]));
    expect(result.records.find((record) => record.agentId === "codex")).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain(secretishMalformedLine);
  });

  it("reports a non-directory source path as unreadable instead of an honest empty scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-local-unreadable-"));
    const notDirectory = join(root, "not-a-directory");
    const codexDir = join(root, "codex");
    await writeFile(notDirectory, "not a directory", "utf8");
    await mkdir(codexDir);

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: notDirectory,
      codexSessionsDir: codexDir
    });

    expect(result.sourceScans.find((scan) => scan.agent === "claude-code")?.directoryStatus).toBe("unreadable");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      agent: "claude-code",
      code: "directory_unreadable",
      severity: "error"
    }));
  });
});

describe("Claude native response identity across transcript files", () => {
  async function fixtureDirectories(prefix: string): Promise<{
    claudeProjectsDir: string;
    codexSessionsDir: string;
    geminiSessionsDir: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const directories = {
      claudeProjectsDir: join(root, "claude"),
      codexSessionsDir: join(root, "codex"),
      geminiSessionsDir: join(root, "gemini")
    };
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory)));
    return directories;
  }

  for (const [name, load] of [
    ["qualitative", loadLocalAgentUsage],
    ["financial", loadLocalAgentFinancialUsage]
  ] as const) {
    it(`${name} path deduplicates a copied native session response without exposing provider ids`, async () => {
      const directories = await fixtureDirectories(`aibill-claude-${name}-copy-`);
      const response = claudeLine();
      await writeFile(join(directories.claudeProjectsDir, "original.jsonl"), response, "utf8");
      await writeFile(join(directories.claudeProjectsDir, "checkpoint.jsonl"), response, "utf8");

      const result = await load(directories);
      const calls = result.calls.filter((call) => call.agent === "claude-code");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.callId).toMatch(/^callref_[a-f0-9]{64}$/);
      expect(calls[0]?.callId).not.toContain("msg-1");
      expect(calls[0]?.callId).not.toContain("req-1");
      expect(result.records.find((record) => record.agentId === "claude-code")).toMatchObject({
        quantity: 1,
        costConfidence: "estimated"
      });
    });

    it(`${name} path counts a streamed message once, from the line carrying its final state`, async () => {
      const directories = await fixtureDirectories(`aibill-claude-${name}-stream-`);
      const content = [
        claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" }, { output_tokens: 3 }),
        claudeLine({ timestamp: "2026-06-08T10:00:09.000Z" }, { output_tokens: 10_966 }),
        claudeLine({ timestamp: "2026-06-08T10:00:09.500Z" }, {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }
        })
      ].join("\n");
      await writeFile(join(directories.claudeProjectsDir, "stream.jsonl"), content, "utf8");

      const result = await load(directories);
      const calls = result.calls.filter((call) => call.agent === "claude-code");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.usage.outputTokens).toBe(10_966);
      expect(calls[0]?.usageSupport).toBeUndefined();
      expect(result.diagnostics.filter((item) => item.code === "unsupported_token_shape")).toEqual([]);
    });

    it(`${name} path keeps one call when a sub-agent transcript opens with its parent turn, seconds later`, async () => {
      const directories = await fixtureDirectories(`aibill-claude-${name}-fork-`);
      // The parent streamed the turn (placeholder, then final); the sub-agent copy is final only.
      const parent = [
        claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" }, { output_tokens: 3 }),
        claudeLine({ timestamp: "2026-06-08T10:00:00.000Z" })
      ].join("\n");
      const forked = claudeLine({ timestamp: "2026-06-08T10:00:14.120Z", agentId: "agent-1", isSidechain: true });
      await writeFile(join(directories.claudeProjectsDir, "parent.jsonl"), parent, "utf8");
      await mkdir(join(directories.claudeProjectsDir, "subagents"));
      await writeFile(join(directories.claudeProjectsDir, "subagents", "agent-1.jsonl"), forked, "utf8");

      const result = await load(directories);
      const calls = result.calls.filter((call) => call.agent === "claude-code");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timestamp).toBe("2026-06-08T10:00:00.000Z");
      expect(calls[0]?.usage.outputTokens).toBe(200);
      expect(calls[0]?.subagentId).toBeUndefined();
      expect(calls[0]?.usageSupport).toBeUndefined();
      expect(result.diagnostics.filter((item) => item.code === "unsupported_token_shape")).toEqual([]);
      expect(result.records.find((record) => record.agentId === "claude-code")).toMatchObject({
        quantity: 1,
        costConfidence: "estimated"
      });
    });

    it(`${name} path fails conflicting copies of one native response closed`, async () => {
      const directories = await fixtureDirectories(`aibill-claude-${name}-conflict-`);
      const original = claudeLine({}, { input_tokens: 100, output_tokens: 20 });
      const conflicting = claudeLine({}, { input_tokens: 900, output_tokens: 200 });
      await writeFile(join(directories.claudeProjectsDir, "original.jsonl"), original, "utf8");
      await writeFile(join(directories.claudeProjectsDir, "checkpoint.jsonl"), conflicting, "utf8");

      const result = await load(directories);
      const calls = result.calls.filter((call) => call.agent === "claude-code");
      expect(calls).toEqual([expect.objectContaining({
        callId: expect.stringMatching(/^callref_[a-f0-9]{64}$/),
        model: "conflicting-local-evidence",
        usageSupport: "unsupported_token_shape",
        usage: { inputTokens: 0, outputTokens: 0 }
      })]);
      expect(result.records.find((record) => record.agentId === "claude-code")).toMatchObject({
        amountUsd: null,
        costConfidence: "missing",
        quantity: 1
      });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        agent: "claude-code",
        code: "unsupported_token_shape",
        severity: "warning",
        count: 1
      }));
    });
  }
});

describe("bounded qualitative local-agent scans", () => {
  it("preserves complete small-file results while exposing explicit coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-complete-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    await writeFile(join(claudeDir, "session.jsonl"), claudeLine(), "utf8");
    await writeFile(join(codexDir, "rollout-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "bounded-codex",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-15T10:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-15T10:05:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 700,
              output_tokens: 100
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const directories = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      collectCodexInvocationEvidence: true
    };
    const legacy = await loadLocalAgentUsage(directories);
    const bounded = await loadLocalAgentUsage({
      ...directories,
      qualitativeScan: { maxFileBytes: 64 * 1024, maxSourceBytes: 128 * 1024 }
    });

    expect(bounded.calls).toEqual(legacy.calls);
    expect(bounded.records).toEqual(legacy.records);
    expect(bounded.codexInvocationFiles).toEqual(legacy.codexInvocationFiles);
    expect(bounded.diagnostics).toEqual(legacy.diagnostics);
    expect(hasCompleteQualitativeCoverage(bounded)).toBe(true);
    expect(hasCompleteQualitativeCoverage(legacy)).toBe(false);
    expect(bounded.sourceScans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent: "claude-code",
        qualitativeCoverage: "complete",
        qualitativeFilesEligible: 1,
        qualitativeFilesSkippedForBudget: 0,
        qualitativeBytesEligible: expect.any(Number),
        qualitativeBytesRead: expect.any(Number)
      }),
      expect.objectContaining({
        agent: "codex",
        qualitativeCoverage: "complete",
        qualitativeFilesEligible: 1,
        qualitativeFilesSkippedForBudget: 0
      })
    ]));
  });

  it("reuses a file-identity-bound warm index without rereading transcript bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-index-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const indexedPath = join(claudeDir, "session.jsonl");
    await writeFile(indexedPath, claudeLine({
      sessionId: "indexed-session"
    }), "utf8");
    const entries = new Map<string, LocalAgentQualitativeIndexValue>();
    const index = {
      read: async (key: Readonly<LocalAgentQualitativeIndexKey>) => entries.get(JSON.stringify(key)),
      write: async (
        key: Readonly<LocalAgentQualitativeIndexKey>,
        value: Readonly<LocalAgentQualitativeIndexValue>
      ) => {
        entries.set(JSON.stringify(key), structuredClone(value) as LocalAgentQualitativeIndexValue);
      }
    };
    const options = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      qualitativeScan: { maxFileBytes: 64 * 1024, maxSourceBytes: 128 * 1024 },
      qualitativeIndex: index
    };

    const cold = await loadLocalAgentUsage(options);
    const warm = await loadLocalAgentUsage(options);
    const coldScan = cold.sourceScans.find((scan) => scan.agent === "claude-code");
    const warmScan = warm.sourceScans.find((scan) => scan.agent === "claude-code");

    expect(warm.calls).toEqual(cold.calls);
    expect(warm.records).toEqual(cold.records);
    expect(coldScan).toMatchObject({
      qualitativeIndexHits: 0,
      qualitativeBytesRead: expect.any(Number),
      qualitativeBytesReused: 0
    });
    expect(coldScan?.qualitativeBytesRead).toBeGreaterThan(0);
    expect(warmScan).toMatchObject({
      qualitativeIndexHits: 1,
      qualitativeBytesRead: 0,
      qualitativeBytesReused: expect.any(Number),
      qualitativeFilesReadCompletely: 1,
      qualitativeCoverage: "complete"
    });
    expect(warmScan?.qualitativeBytesReused).toBeGreaterThan(0);
    expect(hasExactSelectedQualitativeEvidence(warm)).toBe(true);

    await writeFile(indexedPath, claudeLine({
      sessionId: "changed-session",
      requestId: "changed-request-with-different-size"
    }), "utf8");
    const changed = await loadLocalAgentUsage(options);
    const changedScan = changed.sourceScans.find((scan) => scan.agent === "claude-code");
    expect(changed.calls[0]?.sessionId).toBe("changed-session");
    expect(changedScan).toMatchObject({
      qualitativeIndexHits: 0,
      qualitativeBytesReused: 0,
      qualitativeBytesRead: expect.any(Number)
    });
    expect(changedScan?.qualitativeBytesRead).toBeGreaterThan(0);
  });

  it("fails closed when a selected transcript path is swapped to a same-size symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-symlink-swap-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const selectedPath = join(claudeDir, "session.jsonl");
    const outsidePath = join(root, "outside.jsonl");
    const selectedContent = claudeLine({
      sessionId: "safe-session",
      cwd: join(root, "safe")
    });
    const outsideContent = claudeLine({
      sessionId: "evil-session",
      cwd: join(root, "evil")
    });
    expect(Buffer.byteLength(outsideContent)).toBe(Buffer.byteLength(selectedContent));
    await writeFile(selectedPath, selectedContent, "utf8");
    await writeFile(outsidePath, outsideContent, "utf8");

    let swapped = false;
    const index = {
      read: async () => {
        if (!swapped) {
          swapped = true;
          await unlink(selectedPath);
          await symlink(outsidePath, selectedPath);
        }
        return undefined;
      },
      write: async () => {}
    };
    const result = await loadLocalAgentUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      qualitativeScan: { maxFileBytes: 64 * 1024, maxSourceBytes: 128 * 1024 },
      qualitativeIndex: index
    });

    expect(swapped).toBe(true);
    expect(result.calls).toEqual([]);
    expect(result.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({
        qualitativeCoverage: "partial",
        qualitativeFilesSelected: 1,
        qualitativeFilesReadCompletely: 0,
        filesParsed: 0,
        unreadableFiles: 1
      });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      agent: "claude-code",
      code: "file_unreadable",
      severity: "error"
    }));
    expect(hasCompleteQualitativeCoverage(result)).toBe(false);
    expect(hasExactSelectedQualitativeEvidence(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("evil-session");
  });

  it("omits an oversized file as a whole and labels the source partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-partial-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const smallPath = join(claudeDir, "small.jsonl");
    const largePath = join(claudeDir, "large.jsonl");
    const privateOversizedPrompt = "private-oversized-prompt-".repeat(200);
    await writeFile(smallPath, claudeLine({
      sessionId: "small-session",
      requestId: "small-request",
      message: {
        id: "small-message",
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }), "utf8");
    await writeFile(largePath, [
      JSON.stringify({
        type: "user",
        sessionId: "large-session",
        message: { content: privateOversizedPrompt }
      }),
      claudeLine({
        sessionId: "large-session",
        requestId: "large-request",
        message: {
          id: "large-message",
          model: "claude-opus-4-8",
          usage: { input_tokens: 99_999, output_tokens: 99_999 }
        }
      })
    ].join("\n"), "utf8");
    await utimes(smallPath, new Date("2026-08-15T10:00:00.000Z"), new Date("2026-08-15T10:00:00.000Z"));
    await utimes(largePath, new Date("2026-08-15T11:00:00.000Z"), new Date("2026-08-15T11:00:00.000Z"));

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      qualitativeScan: { maxFileBytes: 1_024, maxSourceBytes: 4_096 }
    });

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.sessionId).toBe("small-session");
    expect(result.calls[0]?.usage.inputTokens).toBe(10);
    expect(result.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({
        qualitativeCoverage: "partial",
        qualitativeFilesEligible: 2,
        qualitativeFilesSkippedForBudget: 1,
        filesParsed: 1
      });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      agent: "claude-code",
      code: "qualitative_scan_incomplete",
      severity: "warning",
      count: 1
    }));
    expect(hasCompleteQualitativeCoverage(result)).toBe(false);
    expect(hasExactSelectedQualitativeEvidence(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateOversizedPrompt);
    expect(JSON.stringify(result)).not.toContain("large-message");
  });

  it("spends the per-source budget on the newest complete files deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-newest-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const fixture = (sessionId: string, ordinal: number) => claudeLine({
      timestamp: `2026-08-15T1${ordinal}:00:00.000Z`,
      sessionId,
      requestId: `request-${ordinal}`,
      message: {
        id: `message-${ordinal}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: ordinal, output_tokens: 1 }
      }
    });
    const names = ["oldest", "middle", "newest"];
    const paths = names.map((name) => join(claudeDir, `${name}.jsonl`));
    for (let index = 0; index < paths.length; index += 1) {
      await writeFile(paths[index]!, fixture(names[index]!, index + 1), "utf8");
      const modifiedAt = new Date(`2026-08-15T1${index}:00:00.000Z`);
      await utimes(paths[index]!, modifiedAt, modifiedAt);
    }
    const bytes = Buffer.byteLength(fixture("middle", 2), "utf8") +
      Buffer.byteLength(fixture("newest", 3), "utf8");

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      qualitativeScan: { maxFileBytes: 4_096, maxSourceBytes: bytes }
    });

    expect(result.calls.map((call) => call.sessionId).sort()).toEqual(["middle", "newest"]);
    expect(result.calls.some((call) => call.sessionId === "oldest")).toBe(false);
    expect(result.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({
        qualitativeCoverage: "partial",
        qualitativeFilesEligible: 3,
        qualitativeFilesSkippedForBudget: 1,
        filesParsed: 2
      });
  });

  it("skips files proven older than the requested window without making coverage partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-qualitative-window-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const geminiDir = join(root, "gemini");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await mkdir(geminiDir);
    const oldPath = join(claudeDir, "old.jsonl");
    await writeFile(oldPath, claudeLine(), "utf8");
    await utimes(oldPath, new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));

    const result = await loadLocalAgentUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: geminiDir,
      // A future boundary proves all filesystem metadata predates the window,
      // including ctime/birthtime on this newly-created fixture.
      sinceIso: "2100-08-02T00:00:00.000Z",
      qualitativeScan: { maxFileBytes: 1_024, maxSourceBytes: 4_096 }
    });

    expect(result.calls).toEqual([]);
    expect(result.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({
        qualitativeCoverage: "complete",
        qualitativeFilesEligible: 0,
        qualitativeFilesSkippedForBudget: 0,
        filesSkippedBeforeWindow: 1
      });
    expect(hasCompleteQualitativeCoverage(result)).toBe(true);
  });

  it("rejects invalid byte limits before scanning", async () => {
    await expect(loadLocalAgentUsage({
      qualitativeScan: { maxFileBytes: 0, maxSourceBytes: 1 }
    })).rejects.toThrow("maxFileBytes must be a positive safe integer byte limit");
  });
});

describe("loadLocalAgentFinancialUsage", () => {
  it("matches the full loader's financial and transcript-limit evidence while omitting activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-parity-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);

    await writeFile(join(claudeDir, "session.jsonl"), [
      JSON.stringify({
        type: "user",
        message: { content: "Audit the private customer billing prompt." }
      }),
      claudeLine({
        requestId: "req-cache",
        message: {
          id: "msg-cache",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 500,
            cache_creation: {
              ephemeral_5m_input_tokens: 200,
              ephemeral_1h_input_tokens: 300
            }
          },
          content: [{
            type: "tool_use",
            input: { file_path: "/Users/testuser/private/customer-ledger.md" }
          }]
        }
      }),
      // Repeated streamed response must not count twice.
      claudeLine({
        requestId: "req-cache",
        message: {
          id: "msg-cache",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 25 }
        }
      }),
      "malformed sk-proj-value-must-not-enter-diagnostics",
      claudeLine({
        timestamp: "2026-06-08T10:05:00.000Z",
        requestId: "req-unknown",
        message: {
          id: "msg-unknown",
          model: "future-unknown-model",
          usage: { input_tokens: 50, output_tokens: 10 }
        }
      })
    ].join("\n"), "utf8");

    await writeFile(join(codexDir, "rollout-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-financial",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-06-08T09:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Do not retain this prompt." }]
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-08T09:10:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 5_000,
              cached_input_tokens: 3_000,
              output_tokens: 250
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-08T09:20:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 8_000,
              cached_input_tokens: 5_000,
              output_tokens: 400
            },
            last_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 100,
              total_tokens: 2_100
            }
          },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: {
              used_percent: 25,
              window_minutes: 300,
              resets_at: Date.parse("2026-06-08T12:00:00.000Z") / 1_000
            },
            secondary: {
              used_percent: 60,
              window_minutes: 10_080,
              resets_at: Date.parse("2026-06-15T00:00:00.000Z") / 1_000
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const options = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      sinceIso: "2026-06-01T00:00:00.000Z"
    };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const withoutActivity = (calls: typeof full.calls) => calls
      .map(({ activity: _activity, ...call }) => call)
      .sort((left, right) => `${left.agent}:${left.timestamp}`.localeCompare(`${right.agent}:${right.timestamp}`));

    expect(withoutActivity(financial.calls)).toEqual(withoutActivity(full.calls));
    expect(financial.records).toEqual(full.records);
    expect(financial.calls.every((call) => call.activity === undefined)).toBe(true);
    expect(financial.calls.find((call) => call.agent === "codex")?.rateLimits?.windows)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "five-hour", usedPercent: 25 }),
        expect.objectContaining({ kind: "weekly", usedPercent: 60 })
      ]));
    expect(financial.sourceScans).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "claude-code", malformedLines: 1 }),
      expect.objectContaining({ agent: "codex", malformedLines: 0 })
    ]));
    expect(JSON.stringify(financial)).not.toContain("customer billing prompt");
    expect(JSON.stringify(financial)).not.toContain("customer-ledger.md");
    expect(JSON.stringify(financial.diagnostics)).not.toContain("sk-proj-value");
    const dailyBefore = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true });
    expect(dailyBefore.calls.filter(call => call.agent === "codex").map(call => call.usage.inputTokens)).toEqual([2000, 1000]);
    const dailyPath = join(codexDir, "rollout-session.jsonl");
    await writeFile(dailyPath, `${await readFile(dailyPath, "utf8")}\n${JSON.stringify({ type: "event_msg", timestamp: "2026-06-09T09:00:00.000Z",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 6000, output_tokens: 500 } } } })}\n`);
    const dailyAfter = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true });
    const codexDaily = dailyAfter.calls.filter(call => call.agent === "codex");
    expect(codexDaily.map(call => [call.timestamp.slice(0, 10), call.usage.inputTokens, call.usage.outputTokens])).toEqual([
      ["2026-06-08", 2000, 250], ["2026-06-08", 1000, 150], ["2026-06-09", 1000, 100]
    ]);
    expect(codexDaily.every(call => call.usageScope === "turn")).toBe(true);
    expect(JSON.stringify(dailyAfter)).not.toContain("Do not retain this prompt");
    expect(JSON.stringify(dailyAfter)).not.toContain("customer-ledger.md");
    await writeFile(dailyPath, `${await readFile(dailyPath, "utf8")}${JSON.stringify({ type: "event_msg", timestamp: "2026-06-10T09:00:00.000Z",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } } } })}\n`);
    const missingEndpoint = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true });
    expect(missingEndpoint.diagnostics).toContainEqual(expect.objectContaining({ agent: "codex", code: "unsupported_token_shape", workspaceReason: "missing_endpoint" }));
    const bounded = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true, untilIso: "2026-06-10T00:00:00.000Z" });
    expect(bounded.diagnostics.filter(entry => entry.agent === "codex")).toEqual([]);
    expect(bounded.calls.every(call => call.timestamp < "2026-06-10T00:00:00.000Z")).toBe(true);

    const repairedLine = claudeLine({ timestamp: "2026-06-08T11:00:00.000Z", requestId: "req-repaired",
      message: { id: "msg-repaired", model: "claude-sonnet-4", usage: { input_tokens: 7, output_tokens: 3 },
        content: "private first\nprivate second\tend" } }).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const unsupportedLine = (timestamp: string, id: string) => claudeLine({ timestamp, requestId: id,
      message: { id, model: "claude-sonnet-4", usage: { input_tokens: "invalid", output_tokens: 3 } } });
    const claudePath = join(claudeDir, "session.jsonl");
    await writeFile(claudePath, [repairedLine,
      unsupportedLine("2026-05-31T23:00:00.000Z", "before-window"),
      unsupportedLine("2026-06-10T00:00:00.000Z", "after-window")].join("\n"));
    const repaired = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true, untilIso: "2026-06-10T00:00:00.000Z" });
    expect(repaired.diagnostics.filter(entry => entry.agent === "claude-code")).toEqual([]);
    expect(repaired.calls.filter(call => call.agent === "claude-code").map(call => call.usage.inputTokens)).toEqual([7]);
    expect(JSON.stringify(repaired)).not.toContain("private first");
    const strictReader = await loadLocalAgentFinancialUsage(options);
    expect(strictReader.diagnostics).toContainEqual(expect.objectContaining({ agent: "claude-code", code: "malformed_jsonl" }));
    await writeFile(claudePath, [repairedLine, unsupportedLine("2026-06-08T12:00:00.000Z", "in-window"),
      '{"type":"assistant","message":BROKEN}', claudeLine({ requestId: "after-broken" })].join("\n"));
    const stillBlocked = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true, untilIso: "2026-06-10T00:00:00.000Z" });
    expect(stillBlocked.diagnostics).toContainEqual(expect.objectContaining({ agent: "claude-code", code: "unsupported_token_shape", workspaceFactCoverage: "unknown_tokens" }));
    expect(stillBlocked.diagnostics).toContainEqual(expect.objectContaining({ agent: "claude-code", code: "malformed_jsonl", count: 1 }));
    expect(stillBlocked.diagnostics.find(entry => entry.code === "malformed_jsonl")?.workspaceFactCoverage).toBeUndefined();
    expect(missingEndpoint.diagnostics.find(entry => entry.workspaceReason === "missing_endpoint")?.workspaceFactCoverage).toBeUndefined();
    await writeFile(dailyPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "marker-session", timestamp: "2026-06-01T00:00:00.000Z", cwd: "/private/repo" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-06-08T09:00:00.000Z", payload: { type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-06-08T10:00:00.000Z", payload: { type: "token_count",
        info: { total_token_usage: { input_tokens: 50, output_tokens: 5 } } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-06-07T10:00:00.000Z", payload: { type: "token_count",
        info: { total_token_usage: { input_tokens: 200, output_tokens: 20 } } } })
    ].join("\n"));
    const marked = await loadLocalAgentFinancialUsage({ ...options, workspaceDailyFacts: true, untilIso: "2026-06-10T00:00:00.000Z" });
    expect(marked.diagnostics).toContainEqual(expect.objectContaining({ agent: "codex", workspaceReason: "first_day_unknown", workspaceFactCoverage: "unknown_tokens" }));
    expect(marked.diagnostics).toContainEqual(expect.objectContaining({ agent: "codex", workspaceReason: "counter_decreased", workspaceFactCoverage: "unknown_tokens" }));
    expect(marked.diagnostics.find(entry => entry.workspaceReason === "nonchronological")?.workspaceFactCoverage).toBeUndefined();
    expect(marked.calls.filter(call => call.agent === "codex").every(call => call.usageSupport === "unsupported_token_shape")).toBe(true);



  });

  it("matches the full loader when Codex payload appears before the top-level event type", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-property-order-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(codexDir, "rollout-reordered.jsonl"), [
      JSON.stringify({
        payload: {
          id: "reordered-session",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        },
        timestamp: "2026-08-08T10:00:00.000Z",
        type: "session_meta"
      }),
      JSON.stringify({ payload: { model: "gpt-5.6-sol" }, type: "turn_context" }),
      JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 4_000,
              cached_input_tokens: 3_000,
              output_tokens: 500
            },
            last_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 700,
              output_tokens: 100,
              total_tokens: 1_100
            }
          },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: {
              used_percent: 35,
              window_minutes: 300,
              resets_at: Date.parse("2026-08-08T13:00:00.000Z") / 1_000
            }
          }
        },
        timestamp: "2026-08-08T10:30:00.000Z",
        type: "event_msg"
      })
    ].join("\n"), "utf8");

    const options = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const financialFields = ({ activity: _activity, ...call }: typeof full.calls[number]) => call;

    expect(financial.calls.map(financialFields)).toEqual(full.calls.map(financialFields));
    expect(financial.records).toEqual(full.records);
    expect(financial.calls).toHaveLength(1);
    expect(financial.calls[0]?.rateLimits?.windows[0]).toMatchObject({
      kind: "five-hour",
      usedPercent: 35
    });
  });

  it("dedupes cumulative Codex snapshots across files exactly like the full loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-dedupe-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    const rolloutFile = (
      timestamp: string,
      inputTokens: number,
      cachedInputTokens: number,
      outputTokens: number
    ) => [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "repeated-session",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: inputTokens,
              cached_input_tokens: cachedInputTokens,
              output_tokens: outputTokens
            }
          }
        }
      })
    ].join("\n");
    await writeFile(
      join(codexDir, "rollout-older.jsonl"),
      rolloutFile("2026-08-08T10:30:00.000Z", 1_000, 700, 100),
      "utf8"
    );
    await writeFile(
      join(codexDir, "rollout-newer.jsonl"),
      rolloutFile("2026-08-08T11:30:00.000Z", 2_000, 1_500, 250),
      "utf8"
    );
    const options = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);

    expect(financial.calls).toHaveLength(1);
    expect(financial.calls[0]).toMatchObject({
      timestamp: "2026-08-08T11:30:00.000Z",
      usage: { inputTokens: 500, cacheReadTokens: 1_500, outputTokens: 250 }
    });
    expect(financial.records).toEqual(full.records);
  });

  it("finds the root subagent boundary without mistaking a later task for its baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-subagent-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    const rootStartedAt = "2026-08-08T15:00:00.000Z";
    const privateHistory = "private prompt text ".repeat(100_000);
    await writeFile(join(codexDir, "rollout-subagent.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: rootStartedAt,
        payload: {
          id: "child-session",
          cwd: "/Users/testuser/agent-finops",
          timestamp: rootStartedAt,
          thread_source: "subagent",
          parent_thread_id: "parent-session",
          source: { subagent: { other: "worker" } }
        }
      }),
      // A large inherited qualitative event is intentionally outside the
      // financial tail and must neither leak nor force a byte cap.
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: privateHistory }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T14:50:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10_000,
              cached_input_tokens: 7_000,
              output_tokens: 500
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: rootStartedAt,
        payload: {
          type: "task_started",
          started_at: Date.parse(rootStartedAt) / 1_000
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T15:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 15_000,
              cached_input_tokens: 10_000,
              output_tokens: 800
            }
          }
        }
      }),
      // The full parser has already selected the root boundary when this later
      // task arrives. A reverse parser must not select this newer task.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T15:00:02.000Z",
        payload: {
          type: "task_started",
          // Deliberately inside the clock-tolerance band: reverse selection
          // still has to find the first qualifying boundary, not this latest.
          started_at: Date.parse("2026-08-08T15:00:02.000Z") / 1_000
        }
      }),
      "malformed financial-tail line",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T16:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 13_000,
              output_tokens: 1_100
            },
            last_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 100,
              total_tokens: 2_100
            }
          },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            secondary: {
              used_percent: 40,
              window_minutes: 10_080,
              resets_at: Date.parse("2026-08-15T00:00:00.000Z") / 1_000
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const options = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const financialFields = ({ activity: _activity, ...call }: typeof full.calls[number]) => call;

    expect(financial.calls.map(financialFields)).toEqual(full.calls.map(financialFields));
    expect(financial.calls[0]?.usage).toEqual({
      inputTokens: 4_000,
      cacheReadTokens: 6_000,
      outputTokens: 600
    });
    expect(financial.sourceScans.find((scan) => scan.agent === "codex"))
      .toMatchObject({
        malformedLines: 1,
        filesReadFinancially: 1,
        bytesSkippedAsNonFinancialHistory: 0,
        jsonlValidationCoverage: "financial_events_only"
      });
    expect(
      financial.sourceScans.find((scan) => scan.agent === "codex")
        ?.nonFinancialBytesPrefiltered
    ).toBeGreaterThan(1_000_000);
    expect(JSON.stringify(financial)).not.toContain("private prompt text");
  });

  it("falls back to complete replay when a preamble precedes the root session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-preamble-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    const rootStartedAt = "2026-08-08T15:00:00.000Z";
    await writeFile(join(codexDir, "rollout-preamble.jsonl"), [
      "malformed preamble",
      JSON.stringify({ type: "response_item", payload: { type: "message", content: "private" } }),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "preamble-child",
          cwd: "/Users/testuser/agent-finops",
          timestamp: rootStartedAt,
          thread_source: "subagent",
          source: { subagent: { other: "worker" } }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T14:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1_000,
              cached_input_tokens: 700,
              output_tokens: 100
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: rootStartedAt,
        payload: { type: "task_started", started_at: Date.parse(rootStartedAt) / 1_000 }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T15:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 250
            },
            last_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 600,
              output_tokens: 100,
              total_tokens: 900
            }
          },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            secondary: {
              used_percent: 50,
              window_minutes: 10_080,
              resets_at: Date.parse("2026-08-15T00:00:00.000Z") / 1_000
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const options = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const financialFields = ({ activity: _activity, ...call }: typeof full.calls[number]) => call;

    expect(financial.calls.map(financialFields)).toEqual(full.calls.map(financialFields));
    expect(financial.sourceScans.find((scan) => scan.agent === "codex"))
      .toMatchObject({
        malformedLines: 1,
        bytesSkippedAsNonFinancialHistory: 0,
        jsonlValidationCoverage: "financial_events_only"
      });
  });

  it("preserves unsupported token evidence and never manufactures Claude limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-unsupported-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(claudeDir, "session.jsonl"), [
      claudeLine({
        rate_limits: {
          primary: { used_percent: 99, window_minutes: 300, resets_at: 1_800_000_000 }
        }
      }),
      claudeLine({
        timestamp: "2026-06-08T10:01:00.000Z",
        requestId: "req-missing-input",
        message: {
          id: "msg-missing-input",
          model: "claude-opus-4-8",
          usage: { output_tokens: 25, total_tokens: 456 }
        }
      }),
      claudeLine({
        timestamp: "2026-06-08T10:02:00.000Z",
        requestId: "req-invalid-output",
        message: {
          id: "msg-invalid-output",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: "25" }
        }
      })
    ].join("\n"), "utf8");
    await writeFile(join(codexDir, "rollout-total-only.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "total-only",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "future-codex" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T10:05:00.000Z",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 12_345 } }
        }
      })
    ].join("\n"), "utf8");

    const options = {
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir
    };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const financialFields = ({ activity: _activity, ...call }: typeof full.calls[number]) => call;

    expect(financial.calls.map(financialFields)).toEqual(full.calls.map(financialFields));
    expect(financial.calls.find((call) => call.agent === "claude-code")?.rateLimits)
      .toBeUndefined();
    expect(financial.calls.filter((call) => (
      call.agent === "claude-code" && call.usageSupport === "unsupported_token_shape"
    ))).toHaveLength(2);
    expect(financial.calls.find((call) => call.agent === "codex")).toMatchObject({
      usageSupport: "unsupported_token_shape",
      reportedTotalTokens: 12_345
    });
    expect(financial.records.find((record) => record.agentId === "codex")).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
    expect(financial.records.find((record) => record.agentId === "claude-code")).toMatchObject({
      amountUsd: null,
      costConfidence: "missing"
    });
    expect(
      financial.sourceScans.find((scan) => scan.agent === "claude-code")
        ?.unsupportedUsageSnapshots
    ).toBe(2);
    expect(financial.sourceScans.find((scan) => scan.agent === "codex")?.unsupportedUsageSnapshots)
      .toBe(1);
  });

  it("rejects malformed cache components in Claude and Codex with exact full-fast parity", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-cache-shapes-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(claudeDir, "session.jsonl"), [
      claudeLine({
        requestId: "req-invalid-cache-read",
        message: {
          id: "msg-invalid-cache-read",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: "100"
          }
        }
      }),
      claudeLine({
        timestamp: "2026-06-08T10:01:00.000Z",
        requestId: "req-negative-cache-write",
        message: {
          id: "msg-negative-cache-write",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_creation_input_tokens: 10,
            cache_creation: {
              ephemeral_5m_input_tokens: -1,
              ephemeral_1h_input_tokens: 5
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const codexRollout = (
      id: string,
      total: Record<string, unknown>,
      last: Record<string, unknown>
    ) => [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T10:30:00.000Z",
        payload: {
          type: "token_count",
          info: { total_token_usage: total, last_token_usage: last },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: {
              used_percent: 35,
              window_minutes: 300,
              resets_at: Date.parse("2026-08-08T13:00:00.000Z") / 1_000
            }
          }
        }
      })
    ].join("\n");
    await writeFile(
      join(codexDir, "rollout-cache-over-input.jsonl"),
      codexRollout(
        "cache-over-input",
        { input_tokens: 100, cached_input_tokens: 101, output_tokens: 10, total_tokens: 110 },
        { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5, total_tokens: 55 }
      ),
      "utf8"
    );
    await writeFile(
      join(codexDir, "rollout-invalid-last-turn.jsonl"),
      codexRollout(
        "invalid-last-turn",
        { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 },
        { input_tokens: 10, cached_input_tokens: 11, output_tokens: 2, total_tokens: 12 }
      ),
      "utf8"
    );

    const options = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir };
    const [full, financial] = await Promise.all([
      loadLocalAgentUsage(options),
      loadLocalAgentFinancialUsage(options)
    ]);
    const financialFields = ({ activity: _activity, ...call }: typeof full.calls[number]) => call;

    expect(financial.calls.map(financialFields)).toEqual(full.calls.map(financialFields));
    expect(financial.records).toEqual(full.records);
    expect(financial.calls).toHaveLength(4);
    expect(financial.calls.every((call) => (
      call.usageSupport === "unsupported_token_shape" && call.latestTurnUsage === undefined
    ))).toBe(true);
    expect(financial.records.every((record) => (
      record.amountUsd === null && record.costConfidence === "missing"
    ))).toBe(true);
    expect(financial.sourceScans).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "claude-code", unsupportedUsageSnapshots: 2 }),
      expect.objectContaining({ agent: "codex", unsupportedUsageSnapshots: 2 })
    ]));
  });

  it("falls back linearly across a huge single-line qualitative event when tail proof is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-huge-line-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    const largePrivateBody = "sensitive qualitative payload ".repeat(900_000);
    await writeFile(join(codexDir, "rollout-large.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "large-line-session",
          cwd: "/Users/testuser/agent-finops",
          timestamp: "2026-08-08T10:00:00.000Z"
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: largePrivateBody }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      // No last-turn or rate-limit fields: the proof reader must fall back to
      // byte zero rather than treating a bounded tail as complete.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-08T10:30:00.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 250
            }
          }
        }
      })
    ].join("\n"), "utf8");

    const result = await loadLocalAgentFinancialUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir
    });

    expect(result.calls[0]?.usage).toEqual({
      inputTokens: 500,
      cacheReadTokens: 1_500,
      outputTokens: 250
    });
    expect(result.sourceScans.find((scan) => scan.agent === "codex"))
      .toMatchObject({
        filesReadFinancially: 1,
        bytesSkippedAsNonFinancialHistory: 0,
        nonFinancialLinesPrefiltered: 1
      });
    expect(
      result.sourceScans.find((scan) => scan.agent === "codex")
        ?.nonFinancialBytesPrefiltered
    ).toBeGreaterThan(20_000_000);
    expect(JSON.stringify(result)).not.toContain("sensitive qualitative payload");
  }, 10_000);

  it("safely skips regular files whose metadata predates the selected window", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-financial-mtime-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(claudeDir, "old-session.jsonl"), claudeLine(), "utf8");

    const result = await loadLocalAgentFinancialUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      // A future boundary proves the newly-created file is outside the window
      // using metadata without depending on mutable fixture timestamps.
      sinceIso: "2100-01-01T00:00:00.000Z"
    });

    expect(result.calls).toEqual([]);
    expect(result.filesParsed).toBe(0);
    expect(result.sourceScans.find((scan) => scan.agent === "claude-code"))
      .toMatchObject({ filesDiscovered: 1, filesParsed: 0, filesSkippedBeforeWindow: 1 });
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

describe("Codex cumulative tiered pricing (per-request tier evidence)", () => {
  const codexRollout = (turns: ReadonlyArray<{
    total: Record<string, number>;
    last: Record<string, number>;
    at: string;
  }>): string => [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-tier-sess", cwd: "/Users/testuser/agent-finops", timestamp: "2026-08-23T10:00:00.000Z" }
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    ...turns.map((turn) => JSON.stringify({
      type: "event_msg",
      timestamp: turn.at,
      payload: {
        type: "token_count",
        info: { total_token_usage: turn.total, last_token_usage: turn.last }
      }
    }))
  ].join("\n");

  it("prices a >272K cumulative Codex session at the base tier when every request stayed under the threshold", () => {
    // The founder's real shape: cumulative prompt (500K) clears the 272K
    // per-request tier on cache reads alone, but no single turn did — so the
    // whole session is base-tier, not voided to "missing".
    const rollout = codexRollout([
      {
        at: "2026-08-23T10:10:00.000Z",
        total: { input_tokens: 200_000, cached_input_tokens: 150_000, output_tokens: 500 },
        last: { input_tokens: 200_000, cached_input_tokens: 150_000, output_tokens: 500, total_tokens: 200_500 }
      },
      {
        at: "2026-08-23T10:20:00.000Z",
        total: { input_tokens: 500_000, cached_input_tokens: 400_000, output_tokens: 1_000 },
        last: { input_tokens: 250_000, cached_input_tokens: 250_000, output_tokens: 500, total_tokens: 250_500 }
      }
    ]);
    const calls = parseCodexRollout(rollout);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.model).toBe("gpt-5.6-sol");
    expect(call.usageScope).toBe("session_cumulative");
    // Largest single request across turns (200K, then 250K).
    expect(call.maxRequestPromptTokens).toBe(250_000);
    // Cumulative usage: 100K non-cached input, 400K cache reads, 1K output.
    expect(call.usage).toMatchObject({
      inputTokens: 100_000,
      cacheReadTokens: 400_000,
      outputTokens: 1_000
    });
    const record = aggregateCalls(calls)[0]!;
    // Base tier: 100000*4 + 1000*20 + 400000*0.4, per million = 0.58 (not the
    // 1.15 the 2x tier would have charged, and not null/"missing").
    expect(record.amountUsd).toBeCloseTo(0.58, 4);
    expect(record.costConfidence).toBe("estimated");
  });

  it("keeps a Codex session honestly 'missing' when a single request genuinely crossed the threshold", () => {
    const rollout = codexRollout([
      {
        at: "2026-08-23T10:10:00.000Z",
        total: { input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 500 },
        last: { input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 500, total_tokens: 300_500 }
      },
      {
        at: "2026-08-23T10:20:00.000Z",
        total: { input_tokens: 500_000, cached_input_tokens: 400_000, output_tokens: 1_000 },
        last: { input_tokens: 250_000, cached_input_tokens: 250_000, output_tokens: 500, total_tokens: 250_500 }
      }
    ]);
    const calls = parseCodexRollout(rollout);
    expect(calls[0]!.maxRequestPromptTokens).toBe(300_000);
    const record = aggregateCalls(calls)[0]!;
    // A request that truly crossed 272K cannot be split from the cumulative sum
    // with the evidence at hand: stay honestly unpriced rather than guess.
    expect(record.amountUsd).toBeNull();
    expect(record.costConfidence).toBe("missing");
  });

  it("still prices a small (<=272K cumulative) Codex session without needing request evidence", () => {
    const rollout = codexRollout([
      {
        at: "2026-08-23T10:10:00.000Z",
        total: { input_tokens: 100_000, cached_input_tokens: 40_000, output_tokens: 500 },
        last: { input_tokens: 100_000, cached_input_tokens: 40_000, output_tokens: 500, total_tokens: 100_500 }
      }
    ]);
    const record = aggregateCalls(parseCodexRollout(rollout))[0]!;
    // 60000*4 + 500*20 + 40000*0.4, per million = 0.266.
    expect(record.amountUsd).toBeCloseTo(0.266, 4);
    expect(record.costConfidence).toBe("estimated");
  });
});

describe("Codex USER forks inherit a baseline, not a bill", () => {
  // Real shape from ~/.codex: a user fork carries thread_source "user", a
  // string `source` (not the subagent record), and `forked_from_id`. It then
  // replays the parent's entire transcript before its own first task. Before
  // this fix only `thread_source: "subagent"` reset the baseline, so a fork
  // was billed for its parent's history — and again down each fork chain.
  const rootStartedAt = "2026-08-11T21:53:39.509Z";
  const ownTaskStartedAt = "2026-08-11T22:11:19.000Z";
  const userFork = (options: { includeOwnTask?: boolean } = {}) => [
    JSON.stringify({
      type: "session_meta",
      timestamp: rootStartedAt,
      payload: {
        id: "fork-child",
        cwd: "/Users/testuser/project-alpha",
        timestamp: rootStartedAt,
        thread_source: "user",
        source: "vscode",
        forked_from_id: "parent-session"
      }
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-11T21:53:40.000Z",
      payload: { model: "gpt-5.6-sol" }
    }),
    // --- replayed PARENT history: task_started keeps the parent's own
    // started_at (hours earlier), so isRootSpecificTaskStart rejects it.
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-11T21:53:41.000Z",
      payload: {
        type: "task_started",
        started_at: Date.parse("2026-08-08T20:23:01.000Z") / 1_000,
        turn_id: "parent-turn"
      }
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-11T21:53:44.342Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 900_000,
            output_tokens: 20_000
          },
          last_token_usage: {
            input_tokens: 200_000, cached_input_tokens: 190_000,
            output_tokens: 100, total_tokens: 200_100
          }
        }
      }
    }),
    // --- the child's OWN first task: started_at matches this rollout's root.
    ...(options.includeOwnTask === false ? [] : [JSON.stringify({
      type: "event_msg",
      timestamp: ownTaskStartedAt,
      payload: {
        type: "task_started",
        started_at: Date.parse(ownTaskStartedAt) / 1_000,
        turn_id: "own-turn"
      }
    })]),
    // The boundary deliberately clears the inherited model; Codex re-declares
    // it per turn, so the child's own turn_context follows its first task.
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-08-11T22:11:20.000Z",
      payload: { model: "gpt-5.6-sol" }
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-11T22:30:00.000Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_100_000,
            cached_input_tokens: 980_000,
            output_tokens: 25_000
          },
          last_token_usage: {
            input_tokens: 150_000, cached_input_tokens: 140_000,
            output_tokens: 200, total_tokens: 150_200
          }
        }
      }
    })
  ].join("\n") + "\n";

  it("charges a user fork only its own post-boundary usage", () => {
    const calls = parseCodexRollout(userFork());
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // Own usage = final cumulative MINUS the inherited baseline:
    // input 1_100_000-1_000_000 = 100_000 (of which cache 980_000-900_000 =
    // 80_000), output 25_000-20_000 = 5_000.
    expect(call.usage).toMatchObject({
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 5_000
    });
    // The replayed parent turn (200_000) must not survive as tier evidence.
    expect(call.maxRequestPromptTokens).toBe(150_000);
    const record = aggregateCalls(calls)[0]!;
    // 20000*4 + 5000*20 + 80000*0.4, per million = 0.212.
    expect(record.amountUsd).toBeCloseTo(0.212, 4);
    // Without the fix this priced the parent's 1.1M-token history instead.
    expect(record.amountUsd).toBeLessThan(1);
  });

  it("emits nothing for a user fork whose own task never starts", () => {
    // Only inherited history is present: charging the parent's cumulative
    // again would be worse than staying honestly absent.
    expect(parseCodexRollout(userFork({ includeOwnTask: false }))).toEqual([]);
  });

  it("reads a user fork whole on the financial path (no tail shortcut)", async () => {
    // The financial reader may stop early once it has proof-complete tail
    // evidence. A fork's baseline boundary sits mid-file, so an inherited-
    // history rollout must be read whole or the fork fix would not apply to
    // the surface that actually prices the founder's spend.
    const root = await mkdtemp(join(tmpdir(), "aibill-userfork-"));
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(codexDir, "rollout-userfork.jsonl"), userFork(), { mode: 0o600 });
    const financial = await loadLocalAgentFinancialUsage({
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      geminiSessionsDir: join(root, "no-gemini")
    });
    const call = financial.calls.find((entry) => entry.agent === "codex")!;
    expect(call).toBeDefined();
    expect(call.usage).toMatchObject({
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      outputTokens: 5_000
    });
    // Byte-identical to the full parser on the same bytes.
    expect(call.usage).toEqual(parseCodexRollout(userFork())[0]!.usage);
    expect(financial.records[0]!.amountUsd).toBeCloseTo(0.212, 4);
  });

  it("still treats subagent rollouts as inherited history", () => {
    const subagent = userFork()
      .replace('"thread_source":"user"', '"thread_source":"subagent"')
      .replace('"forked_from_id":"parent-session"', '"parent_thread_id":"parent-session"');
    const call = parseCodexRollout(subagent)[0]!;
    expect(call.usage).toMatchObject({ inputTokens: 20_000, outputTokens: 5_000 });
  });
});

describe("parseClaudeCodeTranscript on a streamed Claude Code message", () => {
  it("attributes the tool_use blocks from every line of the message to its activity", () => {
    // Real 2.1.222 lines, anonymized: a placeholder thinking line, then one
    // Read block per line; only the sixth line carries the final state.
    const streamed = readFileSync(
      new URL("./fixtures/local-agent-formats/claude-code-streaming-v1/streamed-tool-use.jsonl", import.meta.url),
      "utf8"
    );
    const calls = parseClaudeCodeTranscript(
      streamed,
      "/Users/testuser/.claude/projects/-fixture-project/fixture-session/subagents/agent-fixture.jsonl"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      timestamp: "2026-06-16T12:00:03.191Z",
      subagentId: "agent-fixture",
      usage: { outputTokens: 475 }
    });
    // Before this fix the activity saw the final line's one block.
    expect(calls[0]?.activity).toMatchObject({
      toolCallCount: 5,
      files: ["file-1.ts", "file-2.ts", "file-3.ts", "file-4.ts", "file-5.ts"]
    });
    // The window is the final line's: the earlier lines' blocks still count.
    const straddle = parseClaudeCodeTranscript(streamed, "", Date.parse("2026-06-16T12:00:03.000Z"));
    expect(straddle.map((call) => call.activity?.toolCallCount)).toEqual([5]);
  });
});
