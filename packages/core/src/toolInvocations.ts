import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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

export type HostInvocationEvidence = {
  sessions: number;
  totalAssistantTurns: number;
  sessionTurnCounts: number[];
  invokedMcpTools: string[];
  invokedSkills: string[];
  invokedSubagents: string[];
  invokedCommands: string[];
};

export type NestedSessionMetadata = {
  sessionId?: string;
  isSubagent: boolean;
  parentSessionId?: string;
};

export type SessionContextSignal = {
  agent: "claude-code" | "codex";
  sessionId?: string;
  lastActivityAt?: string;
  /** Explicit compaction markers observed in this transcript. */
  compactionEvents: number;
  /**
   * Explicit file-read tool calls, reduced to basenames so raw local paths
   * never enter the Context Health contract.
   */
  fileReads: ToolInvocationCount[];
  repeatedFileReads: ToolInvocationCount[];
  /** Whether this transcript is a Claude sidechain/subagent transcript. */
  isSubagent: boolean;
  parentSessionId?: string;
  /** Embedded/fork-history metadata, kept separate from this file's root identity. */
  nestedSessions?: NestedSessionMetadata[];
  /**
   * Coverage is intentionally narrow. Shell commands are not parsed as file
   * reads because doing so would turn arbitrary command text into a heuristic.
   */
  readCoverage: "explicit_read_tools_only";
};

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
  /** transcript files with at least one assistant turn in the selected window */
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
  /** Host-isolated coverage and matchable invocation evidence. */
  byHost?: {
    "claude-code": HostInvocationEvidence;
    codex: HostInvocationEvidence;
  };
  /** Per-transcript compaction/read evidence used by Context Health. */
  sessionSignals?: SessionContextSignal[];
};

/** Privacy-safe per-file result; it never contains prompt text or local paths. */
export type ParsedInvocationFile = {
  invocations: ToolInvocationCount[];
  invokedMcpTools: string[];
  invokedSkills: string[];
  invokedSubagents: string[];
  invokedCommands: string[];
  assistantTurns: number;
  contextSignal: SessionContextSignal;
};

/** Private-index proof used to narrow one aggregated Codex window exactly. */
export type ParsedInvocationWindowProof = {
  earliestCountedAt?: string;
  allCountedEventsTimestamped: boolean;
};

export type ToolInvocationOptions = {
  /** default: join(homedir(), ".claude", "projects") */
  claudeProjectsDir?: string;
  /** default: join(homedir(), ".codex", "sessions") */
  codexSessionsDir?: string;
  /** optional: only count turns at/after this time */
  sinceIso?: string;
  /**
   * Fresh Codex summaries collected while usage parsed the same files. Supplying
   * these skips a second rollout read/JSON parse in the same command. The
   * summaries contain counts and basenames only, never raw transcript text.
   */
  codexInvocationFiles?: ParsedInvocationFile[];
};

/** Parse ONE transcript's content. Exported for tests. Returns the per-file pieces the aggregator needs. */
export function parseClaudeCodeInvocations(
  content: string,
  sinceMs?: number
): ParsedInvocationFile {
  const counts = new Map<string, number>();
  const mcpTools = new Set<string>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  const commands = new Set<string>();
  const fileReads = new Map<string, number>();
  const seen = new Set<string>();
  let assistantTurns = 0;
  let sessionId: string | undefined;
  let lastActivityAt: string | undefined;
  let compactionEvents = 0;
  let isSubagent = false;
  let parentSessionId: string | undefined;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    sessionId = stringOf(entry.sessionId) ?? sessionId;
    if (entry.isSidechain === true) isSubagent = true;
    parentSessionId = stringOf(entry.parentSessionId) ?? parentSessionId;
    const timestamp = stringOf(entry.timestamp);
    if (timestamp && (!lastActivityAt || timestamp > lastActivityAt)) {
      lastActivityAt = timestamp;
    }

    // A selected window requires dated evidence. Undated lines cannot prove an
    // invocation occurred inside that window and must not create removal-safe
    // coverage by accident.
    if (typeof sinceMs === "number") {
      const ts = Date.parse(stringOf(entry.timestamp) ?? "");
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
    }
    if (isClaudeCompactionEntry(entry)) compactionEvents += 1;

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
      const file = input && explicitReadFile(name, input);
      if (file) fileReads.set(file, (fileReads.get(file) ?? 0) + 1);
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
    assistantTurns,
    contextSignal: buildSessionContextSignal({
      agent: "claude-code",
      sessionId,
      lastActivityAt,
      compactionEvents,
      fileReads,
      isSubagent,
      parentSessionId
    })
  };
}

/** Parse ONE Codex rollout's tool/skill/subagent invocations. */
export function parseCodexInvocations(
  content: string,
  sinceMs?: number
): ParsedInvocationFile {
  const collector = createCodexInvocationCollector(sinceMs);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(entry)) collector.consume(entry);
  }
  return collector.finish();
}

/**
 * Serializable snapshot of one Codex invocation collector, used by the
 * checkpointed streaming path to carry aggregation across bounded runs. It
 * contains only what the finished summary itself persists — tool/skill/
 * command names, file basenames, opaque session ids, counters and window
 * proof timestamps — never raw transcript text or absolute paths.
 */
export type CodexInvocationCollectorSnapshot = {
  counts: Array<[string, number]>;
  mcpTools: string[];
  skills: string[];
  subagents: string[];
  commands: string[];
  fileReads: Array<[string, number]>;
  assistantTurns: number;
  sessionId?: string;
  rootSessionMetaSeen: boolean;
  rootStartedAtMs?: number;
  rootTaskStarted: boolean;
  lastActivityAt?: string;
  compactionEvents: number;
  isSubagent: boolean;
  parentSessionId?: string;
  nestedSessions: Array<[string, NestedSessionMetadata]>;
  earliestCountedMs?: number;
  allCountedEventsTimestamped: boolean;
};

/** Fail-closed structural check for a restored collector snapshot. */
export function isCodexInvocationCollectorSnapshot(
  value: unknown
): value is CodexInvocationCollectorSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const stringNumberPairs = (input: unknown): boolean => (
    Array.isArray(input) && input.every((pair) => (
      Array.isArray(pair) && pair.length === 2 &&
      typeof pair[0] === "string" &&
      Number.isSafeInteger(pair[1]) && Number(pair[1]) >= 0
    ))
  );
  const stringArray = (input: unknown): boolean => (
    Array.isArray(input) && input.every((item) => typeof item === "string")
  );
  const optionalString = (input: unknown): boolean => (
    input === undefined || typeof input === "string"
  );
  const optionalFinite = (input: unknown): boolean => (
    input === undefined || typeof input === "number" && Number.isFinite(input)
  );
  return stringNumberPairs(record.counts) &&
    stringArray(record.mcpTools) &&
    stringArray(record.skills) &&
    stringArray(record.subagents) &&
    stringArray(record.commands) &&
    stringNumberPairs(record.fileReads) &&
    Number.isSafeInteger(record.assistantTurns) && Number(record.assistantTurns) >= 0 &&
    optionalString(record.sessionId) &&
    typeof record.rootSessionMetaSeen === "boolean" &&
    optionalFinite(record.rootStartedAtMs) &&
    typeof record.rootTaskStarted === "boolean" &&
    optionalString(record.lastActivityAt) &&
    Number.isSafeInteger(record.compactionEvents) && Number(record.compactionEvents) >= 0 &&
    typeof record.isSubagent === "boolean" &&
    optionalString(record.parentSessionId) &&
    Array.isArray(record.nestedSessions) && record.nestedSessions.every((pair) => (
      Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" &&
      typeof pair[1] === "object" && pair[1] !== null &&
      typeof (pair[1] as Record<string, unknown>).isSubagent === "boolean"
    )) &&
    optionalFinite(record.earliestCountedMs) &&
    typeof record.allCountedEventsTimestamped === "boolean";
}

/**
 * Stateful Codex invocation parser used to share localAgentLogs' JSONL pass.
 * One collector is created per rollout file and discarded after `finish()`.
 * A checkpointed stream restores a prior run's snapshot; the window (sinceMs)
 * must be the one the snapshot was created under — the caller pins it in the
 * checkpoint envelope.
 */
export function createCodexInvocationCollector(
  sinceMs?: number,
  restored?: CodexInvocationCollectorSnapshot
): {
  consume: (entry: Record<string, unknown>) => void;
  finish: () => ParsedInvocationFile;
  windowProof: () => ParsedInvocationWindowProof;
  snapshot: () => CodexInvocationCollectorSnapshot;
} {
  const counts = new Map<string, number>(restored?.counts ?? []);
  const mcpTools = new Set<string>(restored?.mcpTools ?? []);
  const skills = new Set<string>(restored?.skills ?? []);
  const subagents = new Set<string>(restored?.subagents ?? []);
  const commands = new Set<string>(restored?.commands ?? []);
  const fileReads = new Map<string, number>(restored?.fileReads ?? []);
  let assistantTurns = restored?.assistantTurns ?? 0;
  let sessionId: string | undefined = restored?.sessionId;
  let rootSessionMetaSeen = restored?.rootSessionMetaSeen ?? false;
  let rootStartedAtMs: number | undefined = restored?.rootStartedAtMs;
  let rootTaskStarted = restored?.rootTaskStarted ?? false;
  let lastActivityAt: string | undefined = restored?.lastActivityAt;
  let compactionEvents = restored?.compactionEvents ?? 0;
  let isSubagent = restored?.isSubagent ?? false;
  let parentSessionId: string | undefined = restored?.parentSessionId;
  const nestedSessions = new Map<string, NestedSessionMetadata>(restored?.nestedSessions ?? []);
  let earliestCountedMs: number | undefined = restored?.earliestCountedMs;
  let allCountedEventsTimestamped = restored?.allCountedEventsTimestamped ?? true;

  const resetObservedEvidence = (): void => {
    counts.clear();
    mcpTools.clear();
    skills.clear();
    subagents.clear();
    commands.clear();
    fileReads.clear();
    assistantTurns = 0;
    compactionEvents = 0;
    earliestCountedMs = undefined;
    allCountedEventsTimestamped = true;
  };

  const recordCountedTimestamp = (entry: Record<string, unknown>): void => {
    const timestamp = Date.parse(stringOf(entry.timestamp) ?? "");
    if (!Number.isFinite(timestamp)) {
      allCountedEventsTimestamped = false;
      return;
    }
    earliestCountedMs = earliestCountedMs === undefined
      ? timestamp
      : Math.min(earliestCountedMs, timestamp);
  };

  const consume = (entry: Record<string, unknown>): void => {
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (entry.type === "session_meta" && payload) {
      const metadata = codexSessionMetadata(payload);
      if (!rootSessionMetaSeen) {
        // Forked rollouts can contain a complete parent history after the
        // first line. Bind this file to its first/root metadata exactly once.
        rootSessionMetaSeen = true;
        sessionId = metadata.sessionId;
        isSubagent = metadata.isSubagent;
        parentSessionId = metadata.parentSessionId;
        rootStartedAtMs = timestampMilliseconds(payload.timestamp ?? entry.timestamp);
      } else if (
        metadata.sessionId !== sessionId ||
        metadata.parentSessionId !== parentSessionId ||
        metadata.isSubagent !== isSubagent
      ) {
        const key = [
          metadata.sessionId ?? "",
          metadata.parentSessionId ?? "",
          metadata.isSubagent ? "subagent" : "session"
        ].join("\u0000");
        nestedSessions.set(key, metadata);
      }
    }
    if (
      isSubagent &&
      !rootTaskStarted &&
      payload?.type === "task_started" &&
      isRootSpecificTaskStart(payload.started_at, rootStartedAtMs)
    ) {
      // Everything before this boundary is inherited parent history copied
      // into the fork. It is useful nested provenance, but it is not evidence
      // that the child invoked those tools or incurred those compactions.
      rootTaskStarted = true;
      resetObservedEvidence();
      lastActivityAt = stringOf(entry.timestamp) ?? lastActivityAt;
    }
    const timestampValue = stringOf(entry.timestamp);
    if (timestampValue && (!lastActivityAt || timestampValue > lastActivityAt)) {
      lastActivityAt = timestampValue;
    }
    if (typeof sinceMs === "number") {
      const timestamp = Date.parse(stringOf(entry.timestamp) ?? "");
      if (!Number.isFinite(timestamp) || timestamp < sinceMs) return;
    }
    if (!payload) return;
    // Codex writes both a top-level `compacted` entry and a separate
    // `context_compacted` event for one compaction. Count only the former.
    if (entry.type === "compacted") {
      compactionEvents += 1;
      recordCountedTimestamp(entry);
    }

    // Codex emits one turn_context per model turn.
    if (entry.type === "turn_context") {
      assistantTurns += 1;
      recordCountedTimestamp(entry);
      return;
    }

    if (payload.type === "message" && payload.role === "user") {
      for (const text of codexTextValues(payload.content)) {
        const command = /^\s*\/([A-Za-z0-9:_-]+)/.exec(text)?.[1];
        if (command) {
          commands.add(command);
          recordCountedTimestamp(entry);
        }
      }
      return;
    }

    if (payload.type !== "function_call" && payload.type !== "custom_tool_call") {
      return;
    }
    const name = stringOf(payload.name);
    if (!name) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    recordCountedTimestamp(entry);
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
    const file = input && explicitReadFile(name, input);
    if (file) fileReads.set(file, (fileReads.get(file) ?? 0) + 1);
  };

  const finish = (): ParsedInvocationFile => {
    // Without a recognized root task boundary, an older-format child file is
    // indistinguishable from copied parent history. Preserve nested metadata,
    // but do not manufacture child invocation/turn coverage from it.
    if (isSubagent && !rootTaskStarted) resetObservedEvidence();
    return {
      invocations: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
      invokedMcpTools: [...mcpTools].sort(),
      invokedSkills: [...skills].sort(),
      invokedSubagents: [...subagents].sort(),
      invokedCommands: [...commands].sort(),
      assistantTurns,
      contextSignal: buildSessionContextSignal({
        agent: "codex",
        sessionId,
        lastActivityAt,
        compactionEvents,
        fileReads,
        isSubagent,
        parentSessionId,
        nestedSessions: [...nestedSessions.values()]
      })
    };
  };

  const windowProof = (): ParsedInvocationWindowProof => ({
    ...(earliestCountedMs === undefined
      ? {}
      : { earliestCountedAt: new Date(earliestCountedMs).toISOString() }),
    allCountedEventsTimestamped
  });

  const snapshot = (): CodexInvocationCollectorSnapshot => ({
    counts: [...counts.entries()],
    mcpTools: [...mcpTools],
    skills: [...skills],
    subagents: [...subagents],
    commands: [...commands],
    fileReads: [...fileReads.entries()],
    assistantTurns,
    ...(sessionId !== undefined ? { sessionId } : {}),
    rootSessionMetaSeen,
    ...(rootStartedAtMs !== undefined ? { rootStartedAtMs } : {}),
    rootTaskStarted,
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    compactionEvents,
    isSubagent,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    nestedSessions: [...nestedSessions.entries()],
    ...(earliestCountedMs !== undefined ? { earliestCountedMs } : {}),
    allCountedEventsTimestamped
  });

  return { consume, finish, windowProof, snapshot };
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
  const sessionSignals: SessionContextSignal[] = [];
  const hostEvidence = {
    "claude-code": createHostInvocationAccumulator(),
    codex: createHostInvocationAccumulator()
  };
  let sessions = 0;
  let claudeCodeSessions = 0;
  let codexSessions = 0;

  for (const file of await listJsonlFiles(claudeDir)) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    const parsed = parseClaudeCodeInvocations(content, sinceMs);
    // A transcript file is not coverage for the selected window merely
    // because it exists on disk. Without an in-window assistant turn there
    // was no opportunity to observe an invocation, so counting the file would
    // manufacture configured-without-invocation findings from stale history.
    if (parsed.assistantTurns === 0) continue;
    sessions += 1;
    claudeCodeSessions += 1;
    sessionTurnCounts.push(parsed.assistantTurns);
    sessionSignals.push(parsed.contextSignal);
    addHostInvocationEvidence(hostEvidence["claude-code"], parsed);
    for (const { name, count } of parsed.invocations) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
    for (const t of parsed.invokedMcpTools) mcpTools.add(t);
    for (const s of parsed.invokedSkills) skills.add(s);
    for (const s of parsed.invokedSubagents) subagents.add(s);
    for (const c of parsed.invokedCommands) commands.add(c);
  }
  const codexInvocationFiles = options.codexInvocationFiles ?? await (async () => {
    const parsedFiles: ParsedInvocationFile[] = [];
    for (const file of await listJsonlFiles(codexDir)) {
      if (!file.split(/[\\/]/).pop()?.startsWith("rollout-")) continue;
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      parsedFiles.push(parseCodexInvocations(content, sinceMs));
    }
    return parsedFiles;
  })();
  for (const parsed of codexInvocationFiles) {
    if (parsed.assistantTurns === 0) continue;
    sessions += 1;
    codexSessions += 1;
    sessionTurnCounts.push(parsed.assistantTurns);
    sessionSignals.push(parsed.contextSignal);
    addHostInvocationEvidence(hostEvidence.codex, parsed);
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
    },
    byHost: {
      "claude-code": finishHostInvocationEvidence(hostEvidence["claude-code"]),
      codex: finishHostInvocationEvidence(hostEvidence.codex)
    },
    sessionSignals
  };
}

type HostInvocationAccumulator = {
  sessionTurnCounts: number[];
  mcpTools: Set<string>;
  skills: Set<string>;
  subagents: Set<string>;
  commands: Set<string>;
};

function createHostInvocationAccumulator(): HostInvocationAccumulator {
  return {
    sessionTurnCounts: [],
    mcpTools: new Set<string>(),
    skills: new Set<string>(),
    subagents: new Set<string>(),
    commands: new Set<string>()
  };
}

function addHostInvocationEvidence(
  accumulator: HostInvocationAccumulator,
  parsed: ParsedInvocationFile
): void {
  accumulator.sessionTurnCounts.push(parsed.assistantTurns);
  parsed.invokedMcpTools.forEach((value) => accumulator.mcpTools.add(value));
  parsed.invokedSkills.forEach((value) => accumulator.skills.add(value));
  parsed.invokedSubagents.forEach((value) => accumulator.subagents.add(value));
  parsed.invokedCommands.forEach((value) => accumulator.commands.add(value));
}

function finishHostInvocationEvidence(
  accumulator: HostInvocationAccumulator
): HostInvocationEvidence {
  return {
    sessions: accumulator.sessionTurnCounts.length,
    totalAssistantTurns: accumulator.sessionTurnCounts.reduce((sum, count) => sum + count, 0),
    sessionTurnCounts: accumulator.sessionTurnCounts,
    invokedMcpTools: [...accumulator.mcpTools].sort(),
    invokedSkills: [...accumulator.skills].sort(),
    invokedSubagents: [...accumulator.subagents].sort(),
    invokedCommands: [...accumulator.commands].sort()
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

function isClaudeCompactionEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "system") return false;
  const subtype = stringOf(entry.subtype)?.toLowerCase();
  return subtype === "compact_boundary" ||
    subtype === "compacted" ||
    subtype === "context_compacted";
}

function explicitReadFile(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const normalized = toolName.toLowerCase();
  if (![
    "read",
    "read_file",
    "readfile",
    "view_image"
  ].includes(normalized)) return undefined;
  const raw = stringOf(input.file_path) ??
    stringOf(input.path) ??
    stringOf(input.file);
  if (!raw) return undefined;
  const name = basename(raw);
  return name && name !== "." && name !== "/" ? name : undefined;
}

function buildSessionContextSignal(input: {
  agent: SessionContextSignal["agent"];
  sessionId?: string;
  lastActivityAt?: string;
  compactionEvents: number;
  fileReads: Map<string, number>;
  isSubagent: boolean;
  parentSessionId?: string;
  nestedSessions?: NestedSessionMetadata[];
}): SessionContextSignal {
  const fileReads = [...input.fileReads.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return {
    agent: input.agent,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
    compactionEvents: input.compactionEvents,
    fileReads,
    repeatedFileReads: fileReads.filter((file) => file.count > 1),
    isSubagent: input.isSubagent,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.nestedSessions && input.nestedSessions.length > 0
      ? { nestedSessions: input.nestedSessions }
      : {}),
    readCoverage: "explicit_read_tools_only"
  };
}

function codexSessionMetadata(payload: Record<string, unknown>): NestedSessionMetadata {
  return {
    ...(stringOf(payload.id) ? { sessionId: stringOf(payload.id) } : {}),
    isSubagent: stringOf(payload.thread_source) === "subagent" ||
      isRecord(payload.source) && "subagent" in payload.source,
    ...(stringOf(payload.parent_thread_id)
      ? { parentSessionId: stringOf(payload.parent_thread_id) }
      : {})
  };
}

const ROOT_TASK_CLOCK_TOLERANCE_MS = 5_000;

function isRootSpecificTaskStart(value: unknown, rootStartedAtMs: number | undefined): boolean {
  const taskStartedAtMs = timestampMilliseconds(value);
  return typeof rootStartedAtMs === "number" &&
    typeof taskStartedAtMs === "number" &&
    taskStartedAtMs >= rootStartedAtMs - ROOT_TASK_CLOCK_TOLERANCE_MS;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
