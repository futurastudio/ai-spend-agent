import { homedir } from "node:os";
import { join } from "node:path";
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
            input: { file_path: "/Users/jose/agent-finops/apps/glance-macos/GlanceView.swift" }
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
});

describe("parseCodexRollout", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-sess", cwd: "/Users/jose/pitcht-com", timestamp: "2026-06-01T17:25:37.000Z" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.1-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-01T17:30:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10_000, cached_input_tokens: 4_000, output_tokens: 100 } } } }),
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
    expect(calls[0]!.startedAt).toBe("2026-06-01T17:25:37.000Z");
    expect(calls[0]!.timestamp).toBe("2026-06-01T17:40:00.000Z");
    expect(calls[0]!.usage.inputTokens).toBe(25_035 - 5_504);
    expect(calls[0]!.usage.cacheReadTokens).toBe(5_504);
    expect(calls[0]!.usage.outputTokens).toBe(365);
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

    expect(parseCodexRollout(homeLaunched)[0]?.project).toBe("agent-finops");
  });

  it("summarizes Codex prompts and marks delegated sessions", () => {
    const delegated = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-subagent",
          cwd: "/Users/jose/agent-finops",
          timestamp: "2026-07-28T16:00:00.000Z",
          thread_source: "subagent",
          parent_thread_id: "codex-parent",
          source: { subagent: { other: "worker" } }
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
          input: "*** Begin Patch\n*** Update File: /Users/jose/agent-finops/packages/mcp/src/index.test.ts\n*** End Patch\n"
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

  it("keeps temporary screenshot paths out of the user-facing focus summary", () => {
    const rollout = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-hover",
          cwd: "/Users/jose/agent-finops",
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
