import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { estimateTokenCostUsd, type TokenUsage } from "./modelPricing.js";
import type { UsageRecord } from "./schema.js";

/**
 * Local agent-session log ingestion: turns the transcript files that coding
 * agents already write on this machine into UsageRecords, priced at
 * API-equivalent rates ("estimated" confidence).
 *
 * Why this exists: subscription usage (Claude Max, ChatGPT plans) has NO
 * billing API — local logs are the only place that spend is visible. This is
 * also what makes the zero-key first run show REAL numbers.
 *
 * Supported agents:
 *  - Claude Code: ~/.claude/projects/** /*.jsonl — one JSON object per line;
 *    assistant messages carry message.usage token counts.
 *  - Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — event stream;
 *    the LAST event_msg/token_count carries the session's cumulative
 *    total_token_usage (earlier ones are running updates — never summed).
 */

export type LocalAgentCall = {
  agent: "claude-code" | "codex";
  model: string;
  /** ISO timestamp of the call (or session start for session-level entries). */
  timestamp: string;
  /** Project attribution derived from the session's working directory. */
  project?: string;
  usage: TokenUsage;
  sessionId?: string;
};

export type LocalAgentLogOptions = {
  /** Default: ~/.claude/projects */
  claudeProjectsDir?: string;
  /** Default: ~/.codex/sessions */
  codexSessionsDir?: string;
  /** Only include calls at/after this ISO timestamp. */
  sinceIso?: string;
};

export type LocalAgentLogResult = {
  records: UsageRecord[];
  /** Per-call entries before aggregation (for drill-down/debugging). */
  calls: LocalAgentCall[];
  filesParsed: number;
  /** Which agents actually had data on this machine. */
  agentsDetected: string[];
};

/** Parse one Claude Code transcript (JSONL). Exported for tests. */
export function parseClaudeCodeTranscript(content: string, filePath = ""): LocalAgentCall[] {
  const calls: LocalAgentCall[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "assistant") continue;
    const message = isRecord(entry.message) ? entry.message : undefined;
    const usage = message && isRecord(message.usage) ? message.usage : undefined;
    if (!message || !usage) continue;
    // "<synthetic>" marks Claude Code internal placeholder messages, not API calls.
    if (stringOf(message.model) === "<synthetic>") continue;
    // Streaming/retries can write the same API response on multiple lines.
    const dedupeKey = `${stringOf(message.id) ?? ""}:${stringOf(entry.requestId) ?? ""}`;
    if (dedupeKey !== ":" && seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
    const write5m = numberOf(cacheCreation?.ephemeral_5m_input_tokens);
    const write1h = numberOf(cacheCreation?.ephemeral_1h_input_tokens);
    const writeTotal = numberOf(usage.cache_creation_input_tokens) ?? 0;
    calls.push({
      agent: "claude-code",
      model: stringOf(message.model) ?? "claude-code",
      timestamp: toIso(stringOf(entry.timestamp)) ?? new Date(0).toISOString(),
      project: projectFromCwd(stringOf(entry.cwd)) ?? projectFromTranscriptPath(filePath),
      sessionId: stringOf(entry.sessionId),
      usage: {
        inputTokens: numberOf(usage.input_tokens) ?? 0,
        outputTokens: numberOf(usage.output_tokens) ?? 0,
        cacheReadTokens: numberOf(usage.cache_read_input_tokens) ?? 0,
        // Prefer the 5m/1h breakdown; fall back to the total as 5m (cheaper bound).
        cacheWrite5mTokens: write5m ?? writeTotal,
        cacheWrite1hTokens: write1h ?? 0
      }
    });
  }
  return calls;
}

/** Parse one Codex rollout file (JSONL event stream). Exported for tests. */
export function parseCodexRollout(content: string): LocalAgentCall[] {
  let model: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let lastTotal: Record<string, unknown> | undefined;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (entry.type === "session_meta" && payload) {
      sessionId = stringOf(payload.id) ?? sessionId;
      cwd = stringOf(payload.cwd) ?? cwd;
      timestamp = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp)) ?? timestamp;
    }
    if (entry.type === "turn_context" && payload) {
      model = stringOf(payload.model) ?? model;
      cwd = stringOf(payload.cwd) ?? cwd;
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      const info = isRecord(payload.info) ? payload.info : undefined;
      const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
      if (total) {
        lastTotal = total;
        timestamp = timestamp ?? toIso(stringOf(entry.timestamp));
      }
    }
  }
  if (!lastTotal) return [];
  const input = numberOf(lastTotal.input_tokens) ?? 0;
  const cached = numberOf(lastTotal.cached_input_tokens) ?? 0;
  return [{
    agent: "codex",
    model: model ?? "codex",
    timestamp: timestamp ?? new Date(0).toISOString(),
    project: projectFromCwd(cwd),
    sessionId,
    usage: {
      // Codex input_tokens INCLUDES cached tokens; split them out.
      inputTokens: Math.max(0, input - cached),
      outputTokens: numberOf(lastTotal.output_tokens) ?? 0,
      cacheReadTokens: cached
    }
  }];
}

/** Scan this machine's agent logs and return aggregated UsageRecords. */
export async function loadLocalAgentUsage(options: LocalAgentLogOptions = {}): Promise<LocalAgentLogResult> {
  const home = homedir();
  const claudeDir = options.claudeProjectsDir ?? join(home, ".claude", "projects");
  const codexDir = options.codexSessionsDir ?? join(home, ".codex", "sessions");
  const calls: LocalAgentCall[] = [];
  let filesParsed = 0;

  for (const file of await listJsonlFiles(claudeDir)) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    filesParsed += 1;
    calls.push(...parseClaudeCodeTranscript(content, file));
  }
  for (const file of await listJsonlFiles(codexDir)) {
    if (!basename(file).startsWith("rollout-")) continue;
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    filesParsed += 1;
    calls.push(...parseCodexRollout(content));
  }

  const since = options.sinceIso ? Date.parse(options.sinceIso) : undefined;
  const filtered = typeof since === "number" && Number.isFinite(since)
    ? calls.filter((call) => Date.parse(call.timestamp) >= since)
    : calls;

  return {
    records: aggregateCalls(filtered),
    calls: filtered,
    filesParsed,
    agentsDetected: [...new Set(filtered.map((call) => call.agent))]
  };
}

/** Aggregate per-call usage into one UsageRecord per day+agent+model+project. */
export function aggregateCalls(calls: LocalAgentCall[]): UsageRecord[] {
  const groups = new Map<string, LocalAgentCall[]>();
  for (const call of calls) {
    const day = call.timestamp.slice(0, 10);
    const key = [day, call.agent, call.model, call.project ?? "unattributed"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }

  const records: UsageRecord[] = [];
  for (const [key, groupCalls] of groups) {
    const [day, agent, model, project] = key.split("|") as [string, LocalAgentCall["agent"], string, string];
    const usage: TokenUsage = {
      inputTokens: sum(groupCalls, (c) => c.usage.inputTokens),
      outputTokens: sum(groupCalls, (c) => c.usage.outputTokens),
      cacheReadTokens: sum(groupCalls, (c) => c.usage.cacheReadTokens ?? 0),
      cacheWrite5mTokens: sum(groupCalls, (c) => c.usage.cacheWrite5mTokens ?? 0),
      cacheWrite1hTokens: sum(groupCalls, (c) => c.usage.cacheWrite1hTokens ?? 0)
    };
    const amountUsd = estimateTokenCostUsd(model, usage);
    const priced = typeof amountUsd === "number";
    records.push({
      id: slug(["local", agent, day, model, project].join("-")),
      timestamp: new Date(`${day}T00:00:00Z`).toISOString(),
      source: {
        id: "local-agent-logs",
        name: "Local agent session logs",
        provider: agent === "claude-code" ? "anthropic" : "openai",
        confidence: "estimated",
        observedFrom: `${agent} transcript JSONL (this machine)`
      },
      model,
      inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0),
      outputTokens: usage.outputTokens,
      amountUsd: priced ? amountUsd : null,
      costConfidence: priced ? "estimated" : "missing",
      projectId: project === "unattributed" ? undefined : project,
      agentId: agent,
      providerCostType: "local_agent_logs",
      quantity: groupCalls.length,
      operation: `${agent} sessions`
    });
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
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

function projectFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Sessions launched from the home directory aren't a "project" — labeling
  // them with the username reads like a data bug on the by-project table.
  if (resolve(cwd) === resolve(homedir())) return "(home)";
  const name = basename(cwd);
  return name.length > 0 ? name : undefined;
}

/** Claude Code encodes the project path into the transcript's parent dir name. */
function projectFromTranscriptPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const parent = basename(join(filePath, ".."));
  const tail = parent.split("-").filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : undefined;
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function sum(calls: LocalAgentCall[], pick: (call: LocalAgentCall) => number): number {
  return calls.reduce((total, call) => total + pick(call), 0);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
