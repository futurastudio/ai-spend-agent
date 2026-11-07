import { createHash } from "node:crypto";

/**
 * Line selection for Claude Code transcripts, shared by the financial reader
 * (`localAgentLogs.ts`) and the qualitative reader (`toolInvocations.ts`) so
 * that both count a streamed response from the same line.
 *
 * Claude Code (2.1.221 onwards) writes an assistant message several times
 * while it streams, one content block per line: a `message_start` line with a
 * placeholder output count first, the final `message_delta` counts on the
 * line carrying the last block, sometimes a zeroed copy after that. Every
 * line repeats the message id and request id. One response is therefore one
 * API call (counted from the line carrying its final state) whose `tool_use`
 * blocks are spread over its lines (counted as the union over those lines).
 */

export type ClaudeNativeResponseIdentity = {
  /** In-process only; raw provider ids never enter a returned call or cache. */
  localDedupeKey: string;
  /** Stable privacy-safe identity used for cross-file checkpoint deduplication. */
  callId: string;
};

export function claudeNativeResponseIdentity(
  message: Record<string, unknown>,
  entry: Record<string, unknown>
): ClaudeNativeResponseIdentity | undefined {
  const rawMessageId = stringOf(message.id);
  const rawRequestId = stringOf(entry.requestId);
  // Never weaken a two-part native identity by silently dropping one
  // attacker-sized component; without the exact bounded pair there is no
  // cross-file deduplication proof.
  if ((rawMessageId && rawMessageId.length > 4_096) ||
      (rawRequestId && rawRequestId.length > 4_096)) {
    return undefined;
  }
  const messageId = rawMessageId || undefined;
  const requestId = rawRequestId || undefined;
  if (!messageId && !requestId) return undefined;
  const localDedupeKey = JSON.stringify([messageId ?? null, requestId ?? null]);
  return {
    localDedupeKey,
    callId: `callref_${createHash("sha256")
      .update("claude-native-response-v1")
      .update("\u0000")
      .update(localDedupeKey)
      .digest("hex")}`
  };
}

export type ClaudeResponseLineRank = { final: boolean; outputTokens: number };

/**
 * Ranks the lines Claude Code writes for one response. The line carrying the
 * final state has `iterations` or a stop reason and the largest output count;
 * the `message_start` placeholder has neither, and a zeroed copy written after
 * the final line ranks below it on output.
 */
export function claudeResponseLineRank(
  message: Record<string, unknown>,
  usage: Record<string, unknown>
): ClaudeResponseLineRank {
  return {
    final: Array.isArray(usage.iterations) || stringOf(message.stop_reason) !== undefined,
    outputTokens: tokenComponentOf(usage.output_tokens) ?? -1
  };
}

export function outranks(candidate: ClaudeResponseLineRank, prior: ClaudeResponseLineRank): boolean {
  if (candidate.final !== prior.final) return candidate.final;
  return candidate.outputTokens > prior.outputTokens;
}

/**
 * The highest-ranked line per native response identity carries the response's
 * final state; ties keep the first. Returns the chosen line index per
 * identity, from a cheap pass over the lines that contain `"usage"`.
 */
export function finalClaudeResponseLines(lines: readonly string[]): Map<string, number> {
  const chosen = new Map<string, { index: number; rank: ClaudeResponseLineRank }>();
  lines.forEach((line, index) => {
    if (!line.includes('"usage"')) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(entry) || entry.type !== "assistant" || !isRecord(entry.message)) return;
    const message = entry.message;
    if (!isRecord(message.usage) || stringOf(message.model) === "<synthetic>") return;
    const identity = claudeNativeResponseIdentity(message, entry);
    if (!identity) return;
    const rank = claudeResponseLineRank(message, message.usage);
    const prior = chosen.get(identity.localDedupeKey);
    if (!prior || outranks(rank, prior.rank)) chosen.set(identity.localDedupeKey, { index, rank });
  });
  return new Map([...chosen].map(([key, value]) => [key, value.index]));
}

/**
 * Of two copies of one response, the originating one: the copy outside a
 * sub-agent transcript (a sub-agent transcript opens with the parent turn it
 * was forked from), else the earlier, else the one in the transcript that
 * started earlier; equal copies keep the prior.
 *
 * The third step tells a session from its fork. Forking or handing off a
 * Claude Code conversation writes the parent's earlier lines into a new
 * session file (a new session id on every line, sometimes a new working
 * directory) with their original timestamps, so the copy and the original
 * share a timestamp. The fork's file opens with a line written at fork time,
 * after every response it copied, while the original's file opens at or
 * before its first response: the transcript that started earlier holds the
 * original. When neither start is known, or both are equal, the prior copy
 * stays; both readers fold a group in session id order, so the lower session
 * id wins and the choice is the same on every run, in every reader, whatever
 * order the files were read in.
 *
 * The financial reader (`dedupeCumulativeSessionCalls`) and the qualitative
 * reader (`loadToolInvocations`) both pick with this, so money and counts
 * agree on which transcript owns a turn.
 */
export function preferredClaudeResponseCopy<T extends { subagent: boolean; timestamp: string; transcriptStartedAt?: string }>(
  prior: T,
  candidate: T
): T {
  if (prior.subagent !== candidate.subagent) return prior.subagent ? candidate : prior;
  const byTimestamp = candidate.timestamp.localeCompare(prior.timestamp);
  if (byTimestamp !== 0) return byTimestamp < 0 ? candidate : prior;
  if (prior.transcriptStartedAt && candidate.transcriptStartedAt &&
      candidate.transcriptStartedAt.localeCompare(prior.transcriptStartedAt) < 0) {
    return candidate;
  }
  return prior;
}

/**
 * Calls `onBlock` for each `tool_use` block of this line that the response has
 * not shown on an earlier line. Streamed transcripts write one content block
 * per line, so the blocks of one response are the union over its lines;
 * `seen` holds that response's block keys across lines. A block is keyed by
 * its id; one without an id is keyed by its serialized form, so an exact copy
 * counts once and distinct blocks count each.
 */
export function eachNewClaudeToolUse(
  message: Record<string, unknown>,
  seen: Set<string>,
  onBlock: (block: Record<string, unknown>, key: string) => void
): void {
  if (!Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const key = stringOf(block.id) ?? JSON.stringify(block);
    if (seen.has(key)) continue;
    seen.add(key);
    onBlock(block, key);
  }
}

/** A non-negative finite token component, or undefined when the field is absent or malformed. */
export function tokenComponentOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
