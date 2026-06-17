import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadToolInvocations,
  parseClaudeCodeInvocations
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
    // Assistant turn with a built-in, an MCP tool, a Skill, and a subagent (Task).
    assistantLine("msg_1", "req_1", [
      { type: "text", text: "working" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
      { type: "tool_use", id: "t2", name: "mcp__github__create_issue", input: { title: "x" } },
      { type: "tool_use", id: "t3", name: "Skill", input: { skill: "deep-research", args: "q" } },
      { type: "tool_use", id: "t4", name: "Task", input: { subagent_type: "general-purpose" } }
    ]),
    // DUPLICATE streamed line (same message.id + requestId) — must NOT double-count.
    assistantLine("msg_1", "req_1", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }
    ]),
    // Second distinct turn: another Read + an Agent-style subagent.
    assistantLine("msg_2", "req_2", [
      { type: "tool_use", id: "t5", name: "Read", input: { file_path: "/y" } },
      { type: "tool_use", id: "t6", name: "Agent", input: { subagent_type: "code-reviewer" } }
    ]),
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

  it("respects the sinceIso cutoff via sinceMs", () => {
    const cutoff = Date.parse("2026-06-16T13:00:00.000Z");
    const after = parseClaudeCodeInvocations(transcript, cutoff);
    expect(after.assistantTurns).toBe(0);
    expect(after.invocations).toEqual([]);
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
    const summary = await loadToolInvocations({ claudeProjectsDir: dir });
    expect(summary.sessions).toBe(2);
    expect(summary.totalAssistantTurns).toBe(3); // 2 turns in A + 1 in B
    expect(summary.sessionTurnCounts.slice().sort()).toEqual([1, 2]);
    const byName = Object.fromEntries(summary.invocations.map((i) => [i.name, i.count]));
    expect(byName.Read).toBe(2);
    expect(byName.Edit).toBe(1);
    expect(byName.Skill).toBe(1);
    expect(summary.invokedSkills).toEqual(["verify"]);
  });

  it("returns an empty summary for a missing dir without throwing", async () => {
    const summary = await loadToolInvocations({ claudeProjectsDir: join(dir, "does-not-exist") });
    expect(summary).toEqual({
      invocations: [],
      invokedMcpTools: [],
      invokedSkills: [],
      invokedSubagents: [],
      invokedCommands: [],
      sessions: 0,
      totalAssistantTurns: 0,
      sessionTurnCounts: []
    });
  });
});
