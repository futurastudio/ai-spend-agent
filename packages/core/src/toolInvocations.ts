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
};

export type ToolInvocationOptions = {
  /** default: join(homedir(), ".claude", "projects") */
  claudeProjectsDir?: string;
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

/** Scan this machine's Claude Code transcripts and aggregate tool invocations. */
export async function loadToolInvocations(options: ToolInvocationOptions = {}): Promise<InvocationSummary> {
  const claudeDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const sinceMs = typeof since === "number" && Number.isFinite(since) ? since : undefined;

  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const commands = new Set<string>();
  const sessionTurnCounts: number[] = [];
  let sessions = 0;

  for (const file of await listJsonlFiles(claudeDir)) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    sessions += 1;
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
    sessionTurnCounts
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
