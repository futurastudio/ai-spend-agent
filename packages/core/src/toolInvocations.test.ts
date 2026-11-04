import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadToolInvocations,
  parseClaudeCodeInvocations,
  parseCodexInvocations
} from "./toolInvocations.js";

/** Build one assistant JSONL line with the given tool_use blocks. */
function assistantLine(
  id: string,
  requestId: string,
  blocks: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: "2026-06-16T12:00:00.000Z",
    message: { id, model: "claude-opus-4-8", role: "assistant", content: blocks },
    ...extra
  });
}

describe("parseClaudeCodeInvocations", () => {
  const transcript = [
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      sessionId: "claude-session",
      timestamp: "2026-06-16T11:59:59.000Z"
    }),
    // Assistant turn with a built-in, an MCP tool, a Skill, and a subagent (Task).
    assistantLine("msg_1", "req_1", [
      { type: "text", text: "working" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/private/project/x.ts" } },
      { type: "tool_use", id: "t2", name: "mcp__github__create_issue", input: { title: "x" } },
      { type: "tool_use", id: "t3", name: "Skill", input: { skill: "deep-research", args: "q" } },
      { type: "tool_use", id: "t4", name: "Task", input: { subagent_type: "general-purpose" } }
    ], { sessionId: "claude-session" }),
    // DUPLICATE streamed line (same message.id + requestId) — must NOT double-count.
    assistantLine("msg_1", "req_1", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/private/project/x.ts" } }
    ], { sessionId: "claude-session" }),
    // Second distinct turn: a repeat Read + an Agent-style subagent.
    assistantLine("msg_2", "req_2", [
      { type: "tool_use", id: "t5", name: "Read", input: { file_path: "/private/project/x.ts" } },
      { type: "tool_use", id: "t6", name: "Agent", input: { subagent_type: "code-reviewer" } }
    ], { sessionId: "claude-session" }),
    // A <synthetic> line that must be ignored entirely.
    JSON.stringify({
      type: "assistant",
      requestId: "req_3",
      message: { id: "msg_3", model: "<synthetic>", content: [
        { type: "tool_use", id: "t7", name: "Bash", input: { command: "ls" } }
      ] }
    }),
    // A user line carrying a slash command.
    JSON.stringify({
      type: "user",
      timestamp: "2026-06-16T12:01:00.000Z",
      message: { role: "user", content: "<command-name>/model</command-name> args" }
    }),
    // A malformed line that must be skipped.
    "{ this is not valid json",
    ""
  ].join("\n");

  const parsed = parseClaudeCodeInvocations(transcript);

  it("counts tool invocations without double-counting dedup duplicates", () => {
    const byName = Object.fromEntries(parsed.invocations.map((i) => [i.name, i.count]));
    // Read appears in msg_1 (once, dup ignored) and msg_2 (once) => 2.
    expect(byName.Read).toBe(2);
    expect(byName.mcp__github__create_issue).toBe(1);
    expect(byName.Skill).toBe(1);
    expect(byName.Task).toBe(1);
    expect(byName.Agent).toBe(1);
    // The <synthetic> Bash must not be counted.
    expect(byName.Bash).toBeUndefined();
  });

  it("resolves distinct invoked* arrays", () => {
    expect(parsed.invokedMcpTools).toEqual(["mcp__github__create_issue"]);
    expect(parsed.invokedSkills).toEqual(["deep-research"]);
    expect(parsed.invokedSubagents).toEqual(["code-reviewer", "general-purpose"]);
    expect(parsed.invokedCommands).toEqual(["/model"]);
  });

  it("counts assistant turns post-dedupe, skipping synthetic", () => {
    // msg_1 (dup collapsed) + msg_2 = 2; synthetic excluded.
    expect(parsed.assistantTurns).toBe(2);
  });

  it("records explicit compaction and repeated-read evidence without local paths", () => {
    expect(parsed.contextSignal).toMatchObject({
      agent: "claude-code",
      sessionId: "claude-session",
      compactionEvents: 1,
      fileReads: [{ name: "x.ts", count: 2 }],
      repeatedFileReads: [{ name: "x.ts", count: 2 }],
      isSubagent: false,
      readCoverage: "explicit_read_tools_only"
    });
    expect(JSON.stringify(parsed.contextSignal)).not.toContain("/private/project");
  });

  it("preserves explicit Claude parent/subagent session metadata", () => {
    const sidechain = parseClaudeCodeInvocations([
      assistantLine("side-1", "side-req", [
        { type: "tool_use", id: "side-read", name: "Read", input: { file_path: "/secret/plan.md" } }
      ], {
        sessionId: "child-session",
        parentSessionId: "parent-session",
        isSidechain: true
      })
    ].join("\n"));

    expect(sidechain.contextSignal).toMatchObject({
      sessionId: "child-session",
      parentSessionId: "parent-session",
      isSubagent: true,
      fileReads: [{ name: "plan.md", count: 1 }]
    });
  });

  it("respects the sinceIso cutoff via sinceMs", () => {
    const cutoff = Date.parse("2026-06-16T13:00:00.000Z");
    const after = parseClaudeCodeInvocations(transcript, cutoff);
    expect(after.assistantTurns).toBe(0);
    expect(after.invocations).toEqual([]);
  });

  it("excludes undated Claude entries from selected-window coverage", () => {
    const parsed = parseClaudeCodeInvocations(JSON.stringify({
      type: "assistant",
      sessionId: "undated-claude",
      requestId: "undated-request",
      message: {
        id: "undated-message",
        model: "claude-opus-4-8",
        content: [{
          type: "tool_use",
          name: "mcp__private__lookup",
          input: {}
        }]
      }
    }), Date.parse("2026-08-01T00:00:00.000Z"));

    expect(parsed.assistantTurns).toBe(0);
    expect(parsed.invocations).toEqual([]);
  });
});

describe("parseCodexInvocations", () => {
  it("tracks Codex turns, MCP, skills, subagents, and slash commands", () => {
    const rollout = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-16T11:59:59.000Z",
        payload: { id: "codex-session" }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-06-16T12:00:00.000Z",
        payload: { model: "gpt-5.6-codex" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:01.000Z",
        payload: {
          type: "function_call",
          name: "mcp__github__get_issue",
          arguments: "{}"
        }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:02.000Z",
        payload: {
          type: "function_call",
          name: "Skill",
          arguments: JSON.stringify({ skill: "aibill-check" })
        }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:03.000Z",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ task_name: "reviewer" })
        }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:03.100Z",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "/private/project/roadmap.md" })
        }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:03.200Z",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "/private/project/roadmap.md" })
        }
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-06-16T12:00:03.300Z",
        payload: { type: "compacted" }
      }),
      // Codex also writes this notification for the same compaction. It must
      // not be counted as a second event.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-16T12:00:03.301Z",
        payload: { type: "context_compacted" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:04.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "/aibill-check now" }]
        }
      })
    ].join("\n");

    const parsed = parseCodexInvocations(rollout);
    expect(parsed.assistantTurns).toBe(1);
    expect(parsed.invokedMcpTools).toEqual(["mcp__github__get_issue"]);
    expect(parsed.invokedSkills).toEqual(["aibill-check"]);
    expect(parsed.invokedSubagents).toEqual(["reviewer"]);
    expect(parsed.invokedCommands).toEqual(["aibill-check"]);
    expect(parsed.contextSignal).toMatchObject({
      agent: "codex",
      sessionId: "codex-session",
      compactionEvents: 1,
      fileReads: [{ name: "roadmap.md", count: 2 }],
      repeatedFileReads: [{ name: "roadmap.md", count: 2 }],
      isSubagent: false
    });
    expect(JSON.stringify(parsed.contextSignal)).not.toContain("/private/project");
  });

  it("keeps nested metadata separate and excludes inherited parent evidence from a fork", () => {
    const rootStartedAt = "2026-08-03T15:00:00.000Z";
    const forked = [
      JSON.stringify({
        type: "session_meta",
        timestamp: rootStartedAt,
        payload: {
          id: "child-root",
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
          timestamp: "2026-08-03T09:00:00.000Z",
          thread_source: "user"
        }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-03T15:00:00.200Z",
        payload: { model: "gpt-5.6-sol", turn_id: "inherited-turn" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-03T15:00:00.300Z",
        payload: {
          type: "function_call",
          name: "mcp__github__get_issue",
          arguments: "{}"
        }
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-08-03T15:00:00.400Z",
        payload: { type: "compacted" }
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
        payload: { model: "gpt-5.6-sol", turn_id: "root-turn" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-03T15:00:02.000Z",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: JSON.stringify({ path: "/private/child/root.ts" })
        }
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-08-03T15:00:03.000Z",
        payload: { type: "compacted" }
      })
    ].join("\n");

    const parsed = parseCodexInvocations(forked);
    expect(parsed.assistantTurns).toBe(1);
    expect(parsed.invocations).toEqual([{ name: "read_file", count: 1 }]);
    expect(parsed.invokedMcpTools).toEqual([]);
    expect(parsed.contextSignal).toMatchObject({
      sessionId: "child-root",
      isSubagent: true,
      parentSessionId: "parent-root",
      compactionEvents: 1,
      fileReads: [{ name: "root.ts", count: 1 }],
      nestedSessions: [{
        sessionId: "parent-root",
        isSubagent: false
      }]
    });
  });

  it("keeps older-format forks without a root task boundary out of coverage", () => {
    const parsed = parseCodexInvocations([
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-03T15:00:00.000Z",
        payload: {
          id: "older-child",
          timestamp: "2026-08-03T15:00:00.000Z",
          thread_source: "subagent",
          parent_thread_id: "older-parent",
          source: { subagent: { other: "reviewer" } }
        }
      }),
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-03T15:00:00.100Z",
        payload: { id: "older-parent", thread_source: "user" }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-08-03T15:00:00.200Z",
        payload: { model: "gpt-5.6-sol", turn_id: "inherited-turn" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-03T15:00:00.300Z",
        payload: {
          type: "function_call",
          name: "mcp__github__get_issue",
          arguments: "{}"
        }
      })
    ].join("\n"));

    expect(parsed.assistantTurns).toBe(0);
    expect(parsed.invocations).toEqual([]);
    expect(parsed.invokedMcpTools).toEqual([]);
    expect(parsed.contextSignal).toMatchObject({
      sessionId: "older-child",
      isSubagent: true,
      parentSessionId: "older-parent",
      nestedSessions: [{ sessionId: "older-parent", isSubagent: false }]
    });
  });

  it("excludes undated Codex entries from selected-window coverage", () => {
    const parsed = parseCodexInvocations([
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-02T00:00:00.000Z",
        payload: { id: "dated-root", timestamp: "2026-08-02T00:00:00.000Z" }
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.6-sol", turn_id: "undated-turn" }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "mcp__private__lookup",
          arguments: "{}"
        }
      })
    ].join("\n"), Date.parse("2026-08-01T00:00:00.000Z"));

    expect(parsed.assistantTurns).toBe(0);
    expect(parsed.invocations).toEqual([]);
  });
});

describe("loadToolInvocations", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tool-inv-"));
    const sessionA = [
      assistantLine("a1", "ra1", [
        { type: "tool_use", id: "x1", name: "Read", input: {} },
        { type: "tool_use", id: "x2", name: "Skill", input: { skill: "verify" } }
      ]),
      assistantLine("a2", "ra2", [
        { type: "tool_use", id: "x3", name: "Edit", input: {} }
      ])
    ].join("\n");
    const sessionB = [
      assistantLine("b1", "rb1", [
        { type: "tool_use", id: "y1", name: "Read", input: {} }
      ])
    ].join("\n");
    await writeFile(join(dir, "session-a.jsonl"), sessionA, "utf8");
    await writeFile(join(dir, "session-b.jsonl"), sessionB, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("aggregates two transcript files", async () => {
    const summary = await loadToolInvocations({
      claudeProjectsDir: dir,
      codexSessionsDir: join(dir, "no-codex")
    });
    expect(summary.sessions).toBe(2);
    expect(summary.totalAssistantTurns).toBe(3); // 2 turns in A + 1 in B
    expect(summary.sessionTurnCounts.slice().sort()).toEqual([1, 2]);
    const byName = Object.fromEntries(summary.invocations.map((i) => [i.name, i.count]));
    expect(byName.Read).toBe(2);
    expect(byName.Edit).toBe(1);
    expect(byName.Skill).toBe(1);
    expect(summary.invokedSkills).toEqual(["verify"]);
    expect(summary.sourceSessions).toEqual({ claudeCode: 2, codex: 0 });
    expect(summary.byHost).toEqual({
      "claude-code": {
        sessions: 2,
        totalAssistantTurns: 3,
        sessionTurnCounts: [2, 1],
        invokedMcpTools: [],
        invokedSkills: ["verify"],
        invokedSubagents: [],
        invokedCommands: []
      },
      codex: {
        sessions: 0,
        totalAssistantTurns: 0,
        sessionTurnCounts: [],
        invokedMcpTools: [],
        invokedSkills: [],
        invokedSubagents: [],
        invokedCommands: []
      }
    });
  });

  it("returns an empty summary for a missing dir without throwing", async () => {
    const summary = await loadToolInvocations({
      claudeProjectsDir: join(dir, "does-not-exist"),
      codexSessionsDir: join(dir, "does-not-exist-either")
    });
    expect(summary).toEqual({
      invocations: [],
      invokedMcpTools: [],
      invokedSkills: [],
      invokedSubagents: [],
      invokedCommands: [],
      sessions: 0,
      totalAssistantTurns: 0,
      sessionTurnCounts: [],
      sourceSessions: { claudeCode: 0, codex: 0 },
      byHost: {
        "claude-code": {
          sessions: 0,
          totalAssistantTurns: 0,
          sessionTurnCounts: [],
          invokedMcpTools: [],
          invokedSkills: [],
          invokedSubagents: [],
          invokedCommands: []
        },
        codex: {
          sessions: 0,
          totalAssistantTurns: 0,
          sessionTurnCounts: [],
          invokedMcpTools: [],
          invokedSkills: [],
          invokedSubagents: [],
          invokedCommands: []
        }
      },
      sessionSignals: []
    });
  });

  it("uses fresh pre-parsed Codex evidence without rescanning the rollout directory", async () => {
    const parsed = parseCodexInvocations([
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-16T11:59:59.000Z",
        payload: { id: "shared-pass" }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-06-16T12:00:00.000Z",
        payload: { model: "gpt-5.6-codex" }
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-16T12:00:01.000Z",
        payload: {
          type: "function_call",
          name: "mcp__github__get_issue",
          arguments: "{}"
        }
      })
    ].join("\n"));

    const summary = await loadToolInvocations({
      claudeProjectsDir: join(dir, "missing-claude"),
      codexSessionsDir: join(dir, "missing-codex"),
      codexInvocationFiles: [parsed]
    });

    expect(summary).toMatchObject({
      sessions: 1,
      totalAssistantTurns: 1,
      invokedMcpTools: ["mcp__github__get_issue"],
      sourceSessions: { claudeCode: 0, codex: 1 }
    });
  });

  it("does not count stale Claude or Codex files as in-window coverage", async () => {
    const staleRoot = await mkdtemp(join(tmpdir(), "tool-inv-stale-"));
    const claudeDir = join(staleRoot, "claude");
    const codexDir = join(staleRoot, "codex");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    try {
      await writeFile(join(claudeDir, "old-session.jsonl"), assistantLine(
        "old-claude",
        "old-request",
        [{ type: "tool_use", id: "old-tool", name: "mcp__framer__inspect", input: {} }]
      ), "utf8");
      await writeFile(join(codexDir, "rollout-old.jsonl"), [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-16T11:59:59.000Z",
          payload: { id: "old-codex" }
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-06-16T12:00:00.000Z",
          payload: { model: "gpt-5.6-codex" }
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-16T12:00:01.000Z",
          payload: {
            type: "function_call",
            name: "mcp__framer__inspect",
            arguments: "{}"
          }
        })
      ].join("\n"), "utf8");

      const summary = await loadToolInvocations({
        claudeProjectsDir: claudeDir,
        codexSessionsDir: codexDir,
        sinceIso: "2026-06-17T00:00:00.000Z"
      });

      expect(summary).toEqual({
        invocations: [],
        invokedMcpTools: [],
        invokedSkills: [],
        invokedSubagents: [],
        invokedCommands: [],
        sessions: 0,
        totalAssistantTurns: 0,
        sessionTurnCounts: [],
        sourceSessions: { claudeCode: 0, codex: 0 },
        byHost: {
          "claude-code": {
            sessions: 0,
            totalAssistantTurns: 0,
            sessionTurnCounts: [],
            invokedMcpTools: [],
            invokedSkills: [],
            invokedSubagents: [],
            invokedCommands: []
          },
          codex: {
            sessions: 0,
            totalAssistantTurns: 0,
            sessionTurnCounts: [],
            invokedMcpTools: [],
            invokedSkills: [],
            invokedSubagents: [],
            invokedCommands: []
          }
        },
        sessionSignals: []
      });
    } finally {
      await rm(staleRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Real Claude Code 2.1.222 transcript lines, anonymized (every string value
 * replaced, numbers kept): one assistant message written on six lines. The
 * `message_start` placeholder (a thinking block, 7 output tokens, no stop
 * reason) comes first, then one `tool_use` block per line; only the last line
 * carries `stop_reason` and the final output count.
 */
const streamedFixture = readFileSync(
  new URL("./fixtures/claude-code-streaming/streamed-tool-use.jsonl", import.meta.url),
  "utf8"
);

/** The tool_use blocks on one JSONL line: what a single-line selection would count. */
function toolUsesOnLine(line: string): number {
  const entry = JSON.parse(line) as { message: { content: Array<{ type: string }> } };
  return entry.message.content.filter((block) => block.type === "tool_use").length;
}

describe("parseClaudeCodeInvocations on a streamed Claude Code message", () => {
  const lines = streamedFixture.trim().split("\n");

  it("counts the union of tool_use blocks over the message's lines, not one line's", () => {
    expect(lines).toHaveLength(6);
    // Before this fix the first line per response was kept, so the message
    // counted 0 tool invocations; the final-state line alone would count 1.
    expect(toolUsesOnLine(lines[0]!)).toBe(0);
    expect(toolUsesOnLine(lines[5]!)).toBe(1);
    expect(lines.reduce((sum, line) => sum + toolUsesOnLine(line), 0)).toBe(5);

    const parsed = parseClaudeCodeInvocations(streamedFixture);
    expect(parsed.assistantTurns).toBe(1);
    expect(parsed.invocations).toEqual([{ name: "Read", count: 5 }]);
    expect(parsed.contextSignal).toMatchObject({
      sessionId: "fixture-session",
      isSubagent: true,
      lastActivityAt: "2026-06-16T12:00:03.191Z",
      fileReads: [1, 2, 3, 4, 5].map((n) => ({ name: `file-${n}.ts`, count: 1 })),
      repeatedFileReads: []
    });
  });

  it("counts the message once from its final line, inside the window, with every block", () => {
    // Placeholder and the first blocks sit before the window start, the final
    // line inside it: the message counts, with all five blocks.
    const straddle = parseClaudeCodeInvocations(streamedFixture, Date.parse("2026-06-16T12:00:03.000Z"));
    expect(straddle.assistantTurns).toBe(1);
    expect(straddle.invocations).toEqual([{ name: "Read", count: 5 }]);
    // Final line before the window: nothing counts.
    const after = parseClaudeCodeInvocations(streamedFixture, Date.parse("2026-06-16T12:00:04.000Z"));
    expect(after.assistantTurns).toBe(0);
    expect(after.invocations).toEqual([]);
  });

  it("gathers blocks written after the counted line and leaves single-line messages unchanged", () => {
    // The shape from 2.1.287 on: identical final usage on every line (ties keep
    // the first line as the turn) with the blocks on later lines.
    const usage = { input_tokens: 2, output_tokens: 551, cache_read_input_tokens: 40_658, cache_creation_input_tokens: 0 };
    const streamed = (blocks: Array<Record<string, unknown>>, lineUsage: Record<string, unknown> = usage): string =>
      JSON.stringify({
        type: "assistant",
        requestId: "req_tie",
        timestamp: "2026-06-16T12:00:00.000Z",
        sessionId: "tie-session",
        message: { id: "msg_tie", model: "claude-opus-4-8", role: "assistant", stop_reason: "tool_use", usage: lineUsage, content: blocks }
      });
    const content = [
      streamed([{ type: "thinking", thinking: "x" }]),
      streamed([{ type: "text", text: "x" }]),
      streamed([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      streamed([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }]),
      // A zeroed copy repeating the last block after the final line counts once.
      streamed([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }], { input_tokens: 0, output_tokens: 0 }),
      assistantLine("msg_single", "req_single", [
        { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/private/project/x.ts" } }
      ], { sessionId: "tie-session" })
    ].join("\n");
    const parsed = parseClaudeCodeInvocations(content);
    expect(parsed.assistantTurns).toBe(2);
    expect(parsed.invocations).toEqual([{ name: "Bash", count: 2 }, { name: "Edit", count: 1 }]);
  });
});

describe("loadToolInvocations across parent and sub-agent transcripts", () => {
  const usage = (output_tokens: number) => ({ input_tokens: 2, output_tokens, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 });
  const parentTurn = (overrides: Record<string, unknown>, message: Record<string, unknown>): string => JSON.stringify({
    type: "assistant",
    sessionId: "session-a",
    requestId: "req_parent",
    timestamp: "2026-06-16T12:00:00.000Z",
    message: { id: "msg_parent", model: "claude-opus-4-8", role: "assistant", stop_reason: null, usage: usage(3), content: [], ...message },
    ...overrides
  });
  const placeholder = parentTurn({}, { content: [{ type: "thinking", thinking: "x" }] });
  const finalLine = parentTurn({ timestamp: "2026-06-16T12:00:05.000Z" }, {
    stop_reason: "tool_use",
    usage: usage(120),
    content: [{ type: "tool_use", id: "tu_agent", name: "Agent", input: { subagent_type: "general-purpose" } }]
  });
  // The sub-agent transcript opens with a copy of the forked parent turn,
  // written seconds later, then holds its own streamed message (the fixture).
  const forkedCopy = parentTurn({ timestamp: "2026-06-16T12:00:09.000Z", isSidechain: true, agentId: "agent-fixture" }, {
    stop_reason: "tool_use",
    usage: usage(120),
    content: [{ type: "tool_use", id: "tu_agent", name: "Agent", input: { subagent_type: "general-purpose" } }]
  });
  const subagentTranscript = `${forkedCopy}\n${streamedFixture.replaceAll("fixture-session", "session-a")}`;

  async function summarize(projectFiles: Record<string, string>): Promise<Awaited<ReturnType<typeof loadToolInvocations>>> {
    const dir = await mkdtemp(join(tmpdir(), "aibill-invocations-"));
    try {
      const projectDir = join(dir, "projects", "-Users-testuser-project");
      for (const [relative, content] of Object.entries(projectFiles)) {
        const file = join(projectDir, relative);
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, content);
      }
      return await loadToolInvocations({
        claudeProjectsDir: join(dir, "projects"),
        codexSessionsDir: join(dir, "no-codex")
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("counts a response copied into a sub-agent transcript once, in the parent", async () => {
    const summary = await summarize({
      "session-a.jsonl": `${placeholder}\n${finalLine}\n`,
      "session-a/subagents/agent-fixture.jsonl": subagentTranscript
    });
    expect(summary.sessions).toBe(2);
    expect(summary.sessionTurnCounts).toEqual([1, 1]);
    expect(summary.totalAssistantTurns).toBe(2);
    expect(summary.invocations).toEqual([{ name: "Read", count: 5 }, { name: "Agent", count: 1 }]);
    expect(summary.invokedSubagents).toEqual(["general-purpose"]);
    expect(summary.sessionSignals?.map((signal) => signal.isSubagent)).toEqual([false, true]);
  });

  it("keeps the blocks either copy saw when the lines are split across the two files", async () => {
    // The parent holds only the placeholder line; the sub-agent copy holds the
    // final line with the block. One turn, in the parent, with that block.
    const split = await summarize({
      "session-a.jsonl": `${placeholder}\n`,
      "session-a/subagents/agent-fixture.jsonl": subagentTranscript
    });
    expect(split.sessionTurnCounts).toEqual([1, 1]);
    expect(split.invocations).toEqual([{ name: "Read", count: 5 }, { name: "Agent", count: 1 }]);
    // Without a parent copy, the sub-agent transcript is the only evidence and counts it.
    const alone = await summarize({ "session-a/subagents/agent-fixture.jsonl": subagentTranscript });
    expect(alone.sessionTurnCounts).toEqual([2]);
    expect(alone.invocations).toEqual([{ name: "Read", count: 5 }, { name: "Agent", count: 1 }]);
  });

  it("counts a session copied into a second transcript once", async () => {
    const copied = await summarize({
      "session-a.jsonl": `${placeholder}\n${finalLine}\n`,
      "session-a-copy.jsonl": `${placeholder}\n${finalLine}\n`
    });
    expect(copied.sessions).toBe(1);
    expect(copied.sessionTurnCounts).toEqual([1]);
    expect(copied.invocations).toEqual([{ name: "Agent", count: 1 }]);
    // A different session with the same message ids is separate evidence.
    const other = await summarize({
      "session-a.jsonl": `${placeholder}\n${finalLine}\n`,
      "session-b.jsonl": `${placeholder.replace("session-a", "session-b")}\n${finalLine.replace("session-a", "session-b")}\n`
    });
    expect(other.sessions).toBe(2);
    expect(other.invocations).toEqual([{ name: "Agent", count: 2 }]);
  });
});
