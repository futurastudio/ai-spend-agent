import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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
  /** ISO timestamp of this call, or the latest cumulative usage event. */
  timestamp: string;
  /** ISO session start when the transcript format reports it separately. */
  startedAt?: string;
  /** Project attribution derived from the session's working directory. */
  project?: string;
  usage: TokenUsage;
  sessionId?: string;
  /** Provider-reported plan windows embedded in the transcript, when present. */
  rateLimits?: LocalAgentRateLimitSnapshot;
  /**
   * Privacy-conscious work summary derived locally from prompt/tool metadata.
   * Raw prompt text never leaves the parser or enters the Glance snapshot.
   */
  activity?: LocalAgentActivity;
};

export type LocalAgentActivity = {
  summary: string;
  kind: "task" | "automation" | "agent" | "file" | "project";
  action:
    | "building"
    | "refining"
    | "fixing"
    | "testing"
    | "auditing"
    | "researching"
    | "configuring"
    | "publishing"
    | "running"
    | "working";
  source: "agent_title" | "user_prompts" | "file_activity" | "project";
  promptCount: number;
  toolCallCount: number;
  /** Basenames only, ordered by observed tool activity. */
  files: string[];
  isSubagent: boolean;
  parentSessionId?: string;
};

export type LocalAgentRateLimitWindow = {
  kind: "five-hour" | "weekly" | "custom";
  name: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type LocalAgentRateLimitSnapshot = {
  observedAt: string;
  limitId?: string;
  planType?: string;
  windows: LocalAgentRateLimitWindow[];
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
  agentsDetected: Array<LocalAgentCall["agent"]>;
};

/** Parse one Claude Code transcript (JSONL). Exported for tests. */
export function parseClaudeCodeTranscript(content: string, filePath = ""): LocalAgentCall[] {
  const calls: LocalAgentCall[] = [];
  const seen = new Set<string>();
  const prompts: string[] = [];
  const fileCounts = new Map<string, number>();
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let toolCallCount = 0;
  let isSubagent = filePath.split(sep).includes("subagents");
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
    if (entry.type === "ai-title") {
      title = stringOf(entry.aiTitle) ?? title;
    }
    if (entry.type === "last-prompt") {
      lastPrompt = stringOf(entry.lastPrompt) ?? lastPrompt;
    }
    if (entry.isSidechain === true) isSubagent = true;
    parentSessionId = stringOf(entry.parentSessionId) ?? parentSessionId;

    const message = isRecord(entry.message) ? entry.message : undefined;
    if (entry.type === "user" && message) {
      for (const prompt of textValues(message.content)) {
        if (isHumanPrompt(prompt)) prompts.push(prompt);
      }
    }
    if (entry.type === "assistant" && message) {
      for (const item of recordValues(message.content)) {
        if (item.type !== "tool_use") continue;
        toolCallCount += 1;
        collectToolFiles(item.input, fileCounts);
      }
    }
    if (entry.type !== "assistant") continue;
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
  const fallbackPrompt = lastPrompt && isHumanPrompt(lastPrompt) ? lastPrompt : undefined;
  const activity = buildLocalAgentActivity({
    title,
    prompts: prompts.length > 0 ? prompts : fallbackPrompt ? [fallbackPrompt] : [],
    files: fileCounts,
    toolCallCount,
    project: calls[0]?.project ?? projectFromTranscriptPath(filePath),
    isSubagent,
    parentSessionId
  });
  if (activity) {
    for (const call of calls) call.activity = activity;
  }
  return calls;
}

/** Parse one Codex rollout file (JSONL event stream). Exported for tests. */
export function parseCodexRollout(content: string): LocalAgentCall[] {
  let model: string | undefined;
  let cwd: string | undefined;
  const toolWorkdirs = new Map<string, number>();
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  let lastActivityAt: string | undefined;
  let lastTotal: Record<string, unknown> | undefined;
  let lastRateLimits: LocalAgentRateLimitSnapshot | undefined;
  const prompts: string[] = [];
  const fileCounts = new Map<string, number>();
  let toolCallCount = 0;
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
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    if (entry.type === "session_meta" && payload) {
      sessionId = stringOf(payload.id) ?? sessionId;
      cwd = stringOf(payload.cwd) ?? cwd;
      startedAt = toIso(stringOf(payload.timestamp) ?? stringOf(entry.timestamp)) ?? startedAt;
      isSubagent = stringOf(payload.thread_source) === "subagent" || isRecord(payload.source) && "subagent" in payload.source;
      parentSessionId = stringOf(payload.parent_thread_id) ?? parentSessionId;
    }
    if (entry.type === "turn_context" && payload) {
      model = stringOf(payload.model) ?? model;
      cwd = stringOf(payload.cwd) ?? cwd;
    }
    if (payload?.type === "function_call" || payload?.type === "custom_tool_call") {
      toolCallCount += 1;
      const args = jsonRecord(stringOf(payload.arguments));
      const workdir = stringOf(args?.workdir) ?? stringOf(args?.cwd);
      if (workdir && isAbsolute(workdir)) {
        const normalized = resolve(workdir);
        toolWorkdirs.set(normalized, (toolWorkdirs.get(normalized) ?? 0) + 1);
      }
      collectToolFiles(args, fileCounts);
      collectPatchFiles(
        stringOf(args?.patch) ?? stringOf(args?.input) ?? stringOf(payload.input),
        fileCounts
      );
    }
    if (payload?.type === "message" && payload.role === "user") {
      for (const prompt of textValues(payload.content)) {
        if (isHumanPrompt(prompt)) prompts.push(prompt);
      }
    }
    if (entry.type === "event_msg" && payload?.type === "token_count") {
      const eventTimestamp = toIso(stringOf(entry.timestamp)) ?? lastActivityAt ?? startedAt;
      const info = isRecord(payload.info) ? payload.info : undefined;
      const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
      if (total) {
        lastTotal = total;
        lastActivityAt = eventTimestamp;
      }
      const rateLimits = parseCodexRateLimits(payload.rate_limits, eventTimestamp);
      if (rateLimits) {
        lastRateLimits = rateLimits;
      }
    }
  }
  if (!lastTotal) return [];
  const input = numberOf(lastTotal.input_tokens) ?? 0;
  const cached = numberOf(lastTotal.cached_input_tokens) ?? 0;
  const project = projectFromCwd(dominantCodexCwd(cwd, toolWorkdirs));
  const activity = buildLocalAgentActivity({
    prompts,
    files: fileCounts,
    toolCallCount,
    project,
    isSubagent,
    parentSessionId
  });
  return [{
    agent: "codex",
    model: model ?? "codex",
    timestamp: lastActivityAt ?? startedAt ?? new Date(0).toISOString(),
    startedAt,
    project,
    sessionId,
    rateLimits: lastRateLimits,
    activity,
    usage: {
      // Codex input_tokens INCLUDES cached tokens; split them out.
      inputTokens: Math.max(0, input - cached),
      outputTokens: numberOf(lastTotal.output_tokens) ?? 0,
      cacheReadTokens: cached
    }
  }];
}

function parseCodexRateLimits(
  value: unknown,
  observedAt: string | undefined
): LocalAgentRateLimitSnapshot | undefined {
  if (!isRecord(value) || !observedAt) return undefined;
  const windows = [value.primary, value.secondary]
    .map((window) => parseCodexRateLimitWindow(window))
    .filter((window): window is LocalAgentRateLimitWindow => Boolean(window));
  if (windows.length === 0) return undefined;
  return {
    observedAt,
    limitId: stringOf(value.limit_id),
    planType: stringOf(value.plan_type),
    windows
  };
}

function parseCodexRateLimitWindow(value: unknown): LocalAgentRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberOf(value.used_percent);
  const windowMinutes = numberOf(value.window_minutes);
  const resetsAtSeconds = numberOf(value.resets_at);
  if (
    usedPercent === undefined ||
    windowMinutes === undefined ||
    windowMinutes <= 0 ||
    resetsAtSeconds === undefined
  ) {
    return undefined;
  }
  const resetMs = resetsAtSeconds < 1_000_000_000_000
    ? resetsAtSeconds * 1_000
    : resetsAtSeconds;
  const resetsAt = toIso(new Date(resetMs).toISOString());
  if (!resetsAt) return undefined;
  const kind = windowMinutes === 300
    ? "five-hour"
    : windowMinutes === 10_080
      ? "weekly"
      : "custom";
  return {
    kind,
    name: kind === "custom" ? `${windowMinutes}-minute` : kind,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt
  };
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

/**
 * Codex can be launched from HOME and do nearly all of its work through tools
 * that declare a more specific working directory. Prefer that observed
 * activity only when the session-level cwd is not already a real project.
 * Nested tool directories roll up to the shallowest observed ancestor with
 * the strongest descendant-weighted activity.
 */
function dominantCodexCwd(
  sessionCwd: string | undefined,
  toolWorkdirs: Map<string, number>
): string | undefined {
  const sessionProject = projectFromCwd(sessionCwd);
  if (sessionProject && sessionProject !== "(home)") return sessionCwd;

  const home = resolve(homedir());
  const candidates = [...toolWorkdirs.entries()]
    .filter(([path]) => resolve(path) !== home);
  const scored = candidates.map(([candidate]) => ({
    candidate,
    score: candidates.reduce((total, [path, count]) => (
      path === candidate || path.startsWith(`${candidate}${sep}`)
        ? total + count
        : total
    ), 0)
  }));
  scored.sort((left, right) => (
    right.score - left.score ||
    left.candidate.split(sep).length - right.candidate.split(sep).length ||
    left.candidate.localeCompare(right.candidate)
  ));
  return scored[0]?.candidate ?? sessionCwd;
}

/** Claude Code encodes the project path into the transcript's parent dir name. */
function projectFromTranscriptPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const parent = basename(join(filePath, ".."));
  const tail = parent.split("-").filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : undefined;
}

type ActivityInput = {
  title?: string;
  prompts: string[];
  files: Map<string, number>;
  toolCallCount: number;
  project?: string;
  isSubagent: boolean;
  parentSessionId?: string;
};

const FOCUS_STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "at", "been", "being", "but",
  "can", "check", "could", "did", "does", "doing", "dont", "every", "from",
  "for", "have", "here", "how", "into", "its", "just", "like", "make", "more",
  "need", "not", "now", "on", "only", "other", "our", "please", "really", "should",
  "something", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "thing", "think", "this", "through", "too", "use", "user",
  "users", "want", "was", "way", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "work", "working", "would", "you", "your"
]);

const ACTION_WORDS: Array<{
  action: LocalAgentActivity["action"];
  words: Set<string>;
}> = [
  { action: "refining", words: new Set(["adjust", "change", "customize", "design", "edit", "improve", "refine", "revise", "update"]) },
  { action: "fixing", words: new Set(["bug", "debug", "fix", "repair", "resolve"]) },
  { action: "testing", words: new Set(["test", "testing", "validate", "verification", "verify"]) },
  { action: "auditing", words: new Set(["audit", "review", "status"]) },
  { action: "researching", words: new Set(["compare", "find", "investigate", "research"]) },
  { action: "configuring", words: new Set(["configure", "connect", "setup"]) },
  { action: "publishing", words: new Set(["deploy", "launch", "publish", "release"]) },
  { action: "running", words: new Set(["automation", "monitor", "run", "schedule"]) },
  { action: "building", words: new Set(["add", "build", "create", "develop", "implement"]) }
];

function buildLocalAgentActivity(input: ActivityInput): LocalAgentActivity | undefined {
  const prompts = input.prompts.filter(isHumanPrompt);
  const topic = focusTopic(prompts);
  const title = cleanTitle(input.title);
  const files = [...input.files.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([file]) => file)
    .slice(0, 5);
  const action = inferAction(prompts, title);
  let source: LocalAgentActivity["source"];
  let kind: LocalAgentActivity["kind"];
  let subject: string;

  if (topic) {
    source = "user_prompts";
    kind = inferActivityKind(topic, input.isSubagent);
    subject = topic;
  } else if (title) {
    source = "agent_title";
    kind = inferActivityKind(title, input.isSubagent);
    subject = stripLeadingAction(title);
  } else if (files[0]) {
    source = "file_activity";
    kind = "file";
    subject = files[0];
  } else if (input.project) {
    source = "project";
    kind = "project";
    subject = input.project;
  } else {
    return undefined;
  }

  return {
    summary: activitySummary(action, subject, source),
    kind,
    action,
    source,
    promptCount: prompts.length,
    toolCallCount: input.toolCallCount,
    files,
    isSubagent: input.isSubagent,
    parentSessionId: input.parentSessionId
  };
}

function focusTopic(prompts: string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  const recent = prompts.slice(-12);
  const tokenScores = new Map<string, number>();
  const pairScores = new Map<string, number>();
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    const tokens = topicTokens(prompt).filter((token) => !FOCUS_STOP_WORDS.has(token));
    const unique = [...new Set(tokens)];
    for (const token of unique) {
      tokenScores.set(token, (tokenScores.get(token) ?? 0) + weight);
    }
    for (let pairIndex = 0; pairIndex < tokens.length - 1; pairIndex += 1) {
      const pair = `${tokens[pairIndex]} ${tokens[pairIndex + 1]}`;
      pairScores.set(pair, (pairScores.get(pair) ?? 0) + weight);
    }
  });

  const topPairs = [...pairScores.entries()]
    .filter(([, score]) => score >= 2.5)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const topTokens = [...tokenScores.entries()]
    .filter(([token]) => !isActionToken(token))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const candidateTokens = new Set<string>();
  for (const [pair] of topPairs.slice(0, 2)) {
    pair.split(" ").forEach((token) => candidateTokens.add(token));
  }
  for (const [token] of topTokens) {
    if (candidateTokens.size >= 3) break;
    candidateTokens.add(token);
  }
  if (candidateTokens.size === 0) return undefined;

  const tokens = [...candidateTokens].slice(0, 3);
  if (tokens.includes("glance") && tokens.includes("hover")) {
    return tokens.includes("ui") ? "Glance hover UI" : "Glance hover";
  }
  if (tokens.includes("hover")) {
    return tokens.includes("ui") ? "hover UI" : "hover interaction";
  }
  if (tokens.includes("landing") && tokens.includes("page")) return "landing page";
  if (tokens.includes("mcp")) return tokens.includes("feature") ? "MCP feature" : "MCP";
  if (tokens.includes("seo")) return tokens.includes("strategy") ? "SEO strategy" : "SEO";
  return tokens.map(displayToken).join(" ");
}

function inferAction(prompts: string[], title: string | undefined): LocalAgentActivity["action"] {
  const scores = new Map<LocalAgentActivity["action"], number>();
  const recent = prompts.slice(-12);
  recent.forEach((prompt, index) => {
    const weight = 1 + index / Math.max(1, recent.length - 1);
    for (const token of promptTokens(prompt)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + weight);
        }
      }
    }
  });
  if (title) {
    for (const token of promptTokens(title)) {
      for (const group of ACTION_WORDS) {
        if (group.words.has(token)) {
          scores.set(group.action, (scores.get(group.action) ?? 0) + 0.75);
        }
      }
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "working";
}

function inferActivityKind(subject: string, isSubagent: boolean): LocalAgentActivity["kind"] {
  const tokens = new Set(promptTokens(subject));
  if (tokens.has("automation") || tokens.has("workflow") || tokens.has("schedule")) return "automation";
  if (tokens.has("agent") || tokens.has("subagent") || isSubagent) return "agent";
  return "task";
}

function activitySummary(
  action: LocalAgentActivity["action"],
  subject: string,
  source: LocalAgentActivity["source"]
): string {
  if (source === "project") return `Working in ${subject}`;
  const actionLabel = action[0]!.toUpperCase() + action.slice(1);
  return `${actionLabel} ${subject}`.replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return clean.length >= 3 && clean.length <= 96 ? clean : undefined;
}

function stripLeadingAction(value: string): string {
  const words = value.split(/\s+/);
  return isActionToken(words[0]?.toLowerCase() ?? "") && words.length > 1
    ? words.slice(1).join(" ")
    : value;
}

function isActionToken(token: string): boolean {
  return ACTION_WORDS.some((group) => group.words.has(token)) ||
    ["building", "refining", "fixing", "testing", "auditing", "researching", "configuring", "publishing", "running"].includes(token);
}

function displayToken(token: string): string {
  const acronym = new Map([
    ["api", "API"],
    ["cli", "CLI"],
    ["mcp", "MCP"],
    ["seo", "SEO"],
    ["ui", "UI"],
    ["ux", "UX"]
  ]).get(token);
  return acronym ?? token;
}

function promptTokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? [])
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && token !== "cz" && !/^\d+$/.test(token));
}

function topicTokens(value: string): string[] {
  // Absolute paths often appear in attached-image metadata and tool-oriented
  // prompts. They are machine context, not the user's work topic, and can
  // otherwise outrank meaningful words when only one recent prompt exists.
  const withoutAbsolutePaths = value.replace(
    /(^|[\s("'=:])(?:file:\/\/)?\/[^\s)"']+/g,
    "$1"
  );
  return promptTokens(withoutAbsolutePaths);
}

function isHumanPrompt(value: string): boolean {
  const text = value.trim();
  if (text.length < 3) return false;
  return ![
    /^</,
    /^>>>/,
    /^\s*\[\d+\]\s+(tool|assistant|user)\b/i,
    /^#\s*AGENTS\.md/i,
    /^Assess the exact/i,
    /^Planned action JSON/i,
    /^Reviewed Codex/i,
    /^Some conversation/i,
    /^The Codex agent/i,
    /^The following is the Codex/i,
    /^You are .*primary agent/i,
    /^You have \d+ weighted tokens left/i
  ].some((pattern) => pattern.test(text));
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [stringOf(item.text) ?? stringOf(item.content)].filter((text): text is string => Boolean(text));
  });
}

function recordValues(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function collectToolFiles(value: unknown, counts: Map<string, number>): void {
  if (!isRecord(value)) return;
  for (const key of ["file_path", "path", "notebook_path"]) {
    addFile(stringOf(value[key]), counts);
  }
  collectPatchFiles(stringOf(value.patch) ?? stringOf(value.input), counts);
}

function collectPatchFiles(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    addFile(match[1], counts);
  }
}

function addFile(value: string | undefined, counts: Map<string, number>): void {
  if (!value) return;
  const file = basename(value.trim());
  if (!file || file === "." || file === sep) return;
  counts.set(file, (counts.get(file) ?? 0) + 1);
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

function jsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
