import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Read-only ingestion of which tools were actually INVOKED in Claude Code
 * sessions, plus session/turn counts for cache-aware pricing.
 *
 * This is the counterpart to agentInventory.ts (what's LOADED into context):
 * comparing loaded-but-never-invoked tools against this "actually invoked" set
 * is the "dead-context cost" signal.
 *
 * Transcript format (~/.claude/projects/** /*.jsonl, one JSON object per line):
 *  - type:"assistant" lines carry message.content = array of blocks; blocks
 *    with type:"tool_use" have `name` (the invoked tool) and `input`.
 *  - Built-ins: Read/Edit/Bash/Glob/Grep/...; MCP: "mcp__<server>__<tool>".
 *  - The `Skill` tool's input.skill names the invoked skill.
 *  - The `Agent` (or `Task`) tool's input.subagent_type names the subagent.
 *  - Slash commands surface in type:"user" lines as
 *    "<command-name>/foo</command-name>".
 *
 * A "turn" = one assistant message that produced an API call, deduped by
 * message.id + requestId (streaming/retries write the same response on
 * multiple lines), matching parseClaudeCodeTranscript in localAgentLogs.ts.
 */

export type ToolInvocationCount = { name: string; count: number };

export type InvocationSummary = {
  /** aggregated counts by raw tool name across all parsed transcripts */
  invocations: ToolInvocationCount[];
  /** distinct mcp tool names invoked, formatted "mcp__<server>__<tool>" */
  invokedMcpTools: string[];
  /** distinct skill names invoked (resolved from the Skill tool input) */
  invokedSkills: string[];
  /** distinct subagent types invoked (resolved from Task/Agent input) */
  invokedSubagents: string[];
  /** distinct slash-command names invoked, if detectable; else [] */
  invokedCommands: string[];
  /** number of transcript files parsed (≈ sessions) */
  sessions: number;
  /** total assistant turns across all sessions (post-dedupe) */
  totalAssistantTurns: number;
  /** assistant-turn count per session, for cache-read pricing */
  sessionTurnCounts: number[];
  /** Transcript coverage by host. Optional for backwards-compatible fixtures. */
  sourceSessions?: {
    claudeCode: number;
    codex: number;
  };
};

export type ToolInvocationOptions = {
  /** default: join(homedir(), ".claude", "projects") */
  claudeProjectsDir?: string;
  /** default: join(homedir(), ".codex", "sessions") */
  codexSessionsDir?: string;
  /** optional: only count turns at/after this time */
  sinceIso?: string;
};

/** Parse ONE transcript's content. Exported for tests. Returns the per-file pieces the aggregator needs. */
export function parseClaudeCodeInvocations(content: string, sinceMs?: number): {
  invocations: ToolInvocationCount[];
  invokedMcpTools: string[];
  invokedSkills: string[];
  invokedSubagents: string[];
  invokedCommands: string[];
  assistantTurns: number;
} {
  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const commands = new Set<string>();
  const seen = new Set<string>();
  let assistantTurns = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    // sinceIso filter: skip lines older than the cutoff when a timestamp exists.
    if (typeof sinceMs === "number") {
      const ts = Date.parse(stringOf(entry.timestamp) ?? "");
      if (Number.isFinite(ts) && ts < sinceMs) continue;
    }

    // Slash commands surface in user lines as "<command-name>/foo</command-name>".
    if (entry.type === "user") {
      for (const cmd of slashCommandsFrom(entry)) commands.add(cmd);
      continue;
    }

    if (entry.type !== "assistant") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    if (!message) continue;
    // "<synthetic>" marks Claude Code internal placeholder messages, not API calls.
    if (stringOf(message.model) === "<synthetic>") continue;

    // Streaming/retries can write the same API response on multiple lines.
    const dedupeKey = `${stringOf(message.id) ?? ""}:${stringOf(entry.requestId) ?? ""}`;
    if (dedupeKey !== ":" && seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    assistantTurns += 1;

    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const name = stringOf(block.name);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);

      const input = isRecord(block.input) ? block.input : undefined;
      if (name.startsWith("mcp__")) {
        mcpTools.add(name);
      } else if (name === "Skill") {
        const skill = input && stringOf(input.skill);
        if (skill) skills.add(skill);
      } else if (name === "Task" || name === "Agent") {
        const sub = input && stringOf(input.subagent_type);
        if (sub) subagents.add(sub);
      }
    }
  }

  const invocations = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    invocations,
    invokedMcpTools: [...mcpTools].sort(),
    invokedSkills: [...skills].sort(),
    invokedSubagents: [...subagents].sort(),
    invokedCommands: [...commands].sort(),
    assistantTurns
  };
}

/** Parse ONE Codex rollout's tool/skill/subagent invocations. */
export function parseCodexInvocations(content: string, sinceMs?: number): {
  invocations: ToolInvocationCount[];
  invokedMcpTools: string[];
  invokedSkills: string[];
  invokedSubagents: string[];
  invokedCommands: string[];
  assistantTurns: number;
} {
  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const commands = new Set<string>();
  let assistantTurns = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (typeof sinceMs === "number") {
      const timestamp = Date.parse(stringOf(entry.timestamp) ?? "");
      if (Number.isFinite(timestamp) && timestamp < sinceMs) continue;
    }
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (!payload) continue;

    // Codex emits one turn_context per model turn.
    if (entry.type === "turn_context") {
      assistantTurns += 1;
      continue;
    }

    if (payload.type === "message" && payload.role === "user") {
      for (const text of codexTextValues(payload.content)) {
        const command = /^\s*\/([A-Za-z0-9:_-]+)/.exec(text)?.[1];
        if (command) commands.add(command);
      }
      continue;
    }

    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") {
      continue;
    }
    const name = stringOf(payload.name);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const input = codexToolInput(payload);
    if (name.startsWith("mcp__")) {
      mcpTools.add(name);
    } else if (name === "Skill") {
      const skill = input && stringOf(input.skill);
      if (skill) skills.add(skill);
    } else if (name === "Task" || name === "Agent" || name === "spawn_agent") {
      const subagent = input && (
        stringOf(input.subagent_type) ??
        stringOf(input.task_name) ??
        stringOf(input.agent)
      );
      if (subagent) subagents.add(subagent);
    }
  }

  return {
    invocations: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    invokedMcpTools: [...mcpTools].sort(),
    invokedSkills: [...skills].sort(),
    invokedSubagents: [...subagents].sort(),
    invokedCommands: [...commands].sort(),
    assistantTurns
  };
}

/** Scan this machine's Claude Code + Codex transcripts and aggregate invocations. */
export async function loadToolInvocations(options: ToolInvocationOptions = {}): Promise<InvocationSummary> {
  const claudeDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const codexDir = options.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;

  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const commands = new Set<string>();
  const sessionTurnCounts: number[] = [];
  let sessions = 0;
  let claudeCodeSessions = 0;
  let codexSessions = 0;

  for (const file of await listJsonlFiles(claudeDir)) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    sessions += 1;
    claudeCodeSessions += 1;
    const parsed = parseClaudeCodeInvocations(content, sinceMs);
    sessionTurnCounts.push(parsed.assistantTurns);
    for (const { name, count } of parsed.invocations) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
    for (const t of parsed.invokedMcpTools) mcpTools.add(t);
    for (const s of parsed.invokedSkills) skills.add(s);
    for (const s of parsed.invokedSubagents) subagents.add(s);
    for (const c of parsed.invokedCommands) commands.add(c);
  }
  for (const file of await listJsonlFiles(codexDir)) {
    if (!file.split(/[\\/]/).pop()?.startsWith("rollout-")) continue;
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    sessions += 1;
    codexSessions += 1;
    const parsed = parseCodexInvocations(content, sinceMs);
    sessionTurnCounts.push(parsed.assistantTurns);
    for (const { name, count } of parsed.invocations) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
    for (const t of parsed.invokedMcpTools) mcpTools.add(t);
    for (const s of parsed.invokedSkills) skills.add(s);
    for (const s of parsed.invokedSubagents) subagents.add(s);
    for (const c of parsed.invokedCommands) commands.add(c);
  }

  const invocations = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    invocations,
    invokedMcpTools: [...mcpTools].sort(),
    invokedSkills: [...skills].sort(),
    invokedSubagents: [...subagents].sort(),
    invokedCommands: [...commands].sort(),
    sessions,
    totalAssistantTurns: sessionTurnCounts.reduce((sum, n) => sum + n, 0),
    sessionTurnCounts,
    sourceSessions: {
      claudeCode: claudeCodeSessions,
      codex: codexSessions
    }
  };
}

/** Extract "/foo" slash-command names from a user entry's content. */
function slashCommandsFrom(entry: Record<string, unknown>): string[] {
  const message = isRecord(entry.message) ? entry.message : undefined;
  if (!message) return [];
  let text = "";
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block === "string") text += ` ${block}`;
      else if (isRecord(block) && block.type === "text") text += ` ${stringOf(block.text) ?? ""}`;
    }
  }
  if (!text.includes("<command-name>")) return [];
  const out: string[] = [];
  const re = /<command-name>([^<]*)<\/command-name>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1].trim();
    if (name) out.push(name);
  }
  return out;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const exists = await stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) return [];
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
    }
  }
  return out;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function codexToolInput(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = isRecord(payload.input) ? payload.input : undefined;
  if (direct) return direct;
  for (const value of [payload.arguments, payload.input]) {
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Custom tool payloads are often free-form patches, not JSON.
    }
  }
  return undefined;
}

function codexTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
    else if (isRecord(entry)) {
      const text = stringOf(entry.text);
      if (text) out.push(text);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
