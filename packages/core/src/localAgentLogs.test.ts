import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  aggregateCalls,
  dedupeCumulativeSessionCalls,
  latestObservedWorkingDirectory,
  loadLocalAgentUsage,
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
