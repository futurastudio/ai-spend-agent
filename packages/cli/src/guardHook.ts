import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AIBILL_POLICY_RELATIVE_PATH } from "./guardPolicyPath.js";
import {
  formatRemaining,
  guardStampPath,
  listTranscripts,
  policyIdentity,
  readGuardStamp,
  writePrivateJson,
  GUARD_STAMP_KIND,
  type GuardStamp,
  type TranscriptListing
} from "./guardStamp.js";
import { resolveRepositoryRoot } from "./repositoryRoot.js";
import type { GuardCheckDependencies, GuardCheckOutcome } from "./guard.js";

/**
 * The Claude Code hook entry behind `.aibill/guard-hook.mjs`. Contract: exit 2
 * with the block message on stderr when the budget is spent; otherwise exit 0
 * with at most one warning line on stderr and nothing on stdout, because
 * Claude Code adds a UserPromptSubmit hook's stdout to the model's context.
 *
 * Two tiers keep a run cheap. This module imports Node built-ins and the two
 * small guard helpers only; it reads the hook's stdin, finds the repository,
 * takes a listing of today's transcripts and compares day, policy file,
 * listing signature and session with the stamp the previous run left. When
 * none changed the verdict cannot have changed either, and the run exits
 * before `./guard.js` (and with it the core index) is ever imported. Only a
 * run that must recompute loads the evidence engine.
 */

/**
 * Claude Code puts the whole `prompt` (UserPromptSubmit) or `tool_input`
 * (PreToolUse) in the hook's stdin, so a large Write or a pasted document is
 * normal input. The cap exists only against runaway producers; input that
 * still exceeds it is treated as unknown, never as "a new session".
 */
const HOOK_INPUT_MAX_BYTES = 16 * 1_024 * 1_024;
const HOOK_INPUT_WAIT_MS = 1_000;

export type GuardHookInput = {
  cwd?: string;
  sessionId?: string;
  /** Present when the hook fired inside a sub-agent; the session id is still the parent's. */
  agentId?: string;
  hookEventName?: string;
};

export type GuardHookInputRead =
  | { status: "ok"; input: GuardHookInput }
  /** No stdin to read (a terminal, or none supplied). */
  | { status: "none" }
  /** Stdin overflowed, errored, timed out or was not a JSON object. */
  | { status: "incomplete" };

type ReadableLike = NodeJS.ReadableStream & { isTTY?: boolean; readableEnded?: boolean; destroyed?: boolean };

/** Read the hook's JSON from stdin, bounded in bytes and time. Never throws. */
export async function readGuardHookInput(
  input: ReadableLike | null | undefined,
  maxBytes = HOOK_INPUT_MAX_BYTES,
  waitMs = HOOK_INPUT_WAIT_MS
): Promise<GuardHookInputRead> {
  if (!input || input.isTTY || input.readableEnded || input.destroyed) return { status: "none" };
  const text = await new Promise<string | undefined>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (value: string | undefined) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      try {
        input.pause();
      } catch {
        // A closed stream has nothing to pause.
      }
      done(value);
    };
    const onData = (chunk: unknown) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.isBuffer(chunk) ? chunk : undefined;
      if (!buffer) return;
      size += buffer.byteLength;
      if (size > maxBytes) {
        finish(undefined);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), waitMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
  });
  return parseGuardHookInput(text);
}

export function parseGuardHookInput(text: string | undefined): GuardHookInputRead {
  if (text === undefined) return { status: "incomplete" };
  if (!text.trim()) return { status: "none" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "incomplete" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { status: "incomplete" };
  const record = value as Record<string, unknown>;
  const stringField = (key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.length > 0 && field.length <= 4_096 ? field : undefined;
  };
  return {
    status: "ok",
    input: {
      cwd: stringField("cwd"),
      sessionId: stringField("session_id"),
      agentId: stringField("agent_id"),
      hookEventName: stringField("hook_event_name")
    }
  };
}

export function guardHookDependenciesFromEnvironment(): GuardCheckDependencies {
  return {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    cacheDirectory: process.env.AIBILL_CACHE_DIR
  };
}

export type GuardHookTrace = (event: "stamp-reused" | "computed" | "failed") => void;

export async function runGuardHook(options: {
  stdin?: ReadableLike | null;
  stderr?: { write: (text: string) => unknown };
  cwd?: string;
  now?: Date;
  dependencies?: GuardCheckDependencies;
  trace?: GuardHookTrace;
} = {}): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? new Date();
  const dependencies = options.dependencies ?? guardHookDependenciesFromEnvironment();
  let outcome: GuardCheckOutcome;
  try {
    const read = await readGuardHookInput(options.stdin === undefined ? process.stdin : options.stdin);
    const input = read.status === "ok" ? read.input : undefined;
    const cwdInput = input?.cwd ?? options.cwd ?? process.cwd();
    const cwd = isAbsolute(cwdInput) ? resolve(cwdInput) : resolve(process.cwd(), cwdInput);
    const fast = fastPath({ cwd, read, now, dependencies });
    if (fast.reuse) {
      options.trace?.("stamp-reused");
      outcome = fast.reuse;
    } else {
      const { checkGuard } = await import("./guard.js");
      outcome = await checkGuard({
        cwd,
        sessionId: input?.sessionId,
        hookInputIncomplete: read.status === "incomplete",
        hookEventName: input?.hookEventName,
        now
      }, { ...dependencies, listing: fast.listing });
      options.trace?.("computed");
      if (fast.stampPath && read.status !== "incomplete") {
        const stamp: GuardStamp = {
          kind: GUARD_STAMP_KIND,
          version: 1,
          dayKey: fast.dayKey,
          policy: fast.policy,
          signature: outcome.usage?.signature ?? fast.listing?.signature ?? "",
          sessionId: input?.sessionId ?? null,
          exitCode: outcome.exitCode,
          stderr: outcome.stderr,
          reason: outcome.reason,
          writtenAt: now.toISOString()
        };
        // A deferred index must be finished by a later run, so it leaves no stamp.
        if (outcome.reason !== "usage_indexing" && outcome.reason !== "usage_unavailable") writePrivateJson(fast.stampPath, stamp);
      }
    }
  } catch (error) {
    // Fail open: an unexpected failure in the guard must never block work.
    options.trace?.("failed");
    outcome = {
      exitCode: 0,
      stderr: `aibill guard: check failed (${error instanceof Error ? error.message : String(error)}); not blocking.`,
      reason: "usage_unavailable"
    };
  }
  if (outcome.stderr) {
    try {
      stderr.write(`${outcome.stderr}\n`);
    } catch {
      // A closed pipe must not turn a decision into a crash.
    }
  }
  return outcome.exitCode;
}

type FastPath = {
  reuse?: GuardCheckOutcome;
  listing?: TranscriptListing;
  stampPath?: string;
  dayKey: string;
  policy: string;
};

/**
 * Decide whether the previous verdict still holds, from facts that are cheap
 * to read: the UTC day, the policy file's size and mtime, the listing
 * signature of today's transcripts and the session the verdict was for.
 */
function fastPath(context: {
  cwd: string;
  read: GuardHookInputRead;
  now: Date;
  dependencies: GuardCheckDependencies;
}): FastPath {
  const { now, dependencies } = context;
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayKey = new Date(dayStartMs).toISOString().slice(0, 10);
  const findRoot = dependencies.resolveRepositoryRoot ?? resolveRepositoryRoot;
  const repositoryRoot = findRoot(context.cwd);
  if (!repositoryRoot) return { dayKey, policy: "" };
  const policy = policyIdentity(join(repositoryRoot, AIBILL_POLICY_RELATIVE_PATH));
  const projectsDir = dependencies.claudeProjectsDir ?? join(dependencies.homeDirectory ?? homedir(), ".claude", "projects");
  const listing = dependencies.listing ?? listTranscripts(projectsDir, dayStartMs);
  const stampPath = guardStampPath(repositoryRoot, dependencies);
  if (context.read.status === "incomplete") return { listing, stampPath, dayKey, policy };
  const sessionId = context.read.status === "ok" ? context.read.input.sessionId ?? null : null;
  const stamp = readGuardStamp(stampPath);
  if (stamp && stamp.dayKey === dayKey && stamp.policy === policy &&
      stamp.signature === listing.signature && stamp.sessionId === sessionId) {
    return {
      reuse: {
        exitCode: stamp.exitCode,
        stderr: refreshPauseClause(stamp.stderr, dayStartMs + 24 * 60 * 60 * 1_000, now),
        reason: stamp.reason as GuardCheckOutcome["reason"],
        repositoryRoot
      },
      listing,
      stampPath,
      dayKey,
      policy
    };
  }
  return { listing, stampPath, dayKey, policy };
}

/**
 * A replayed block message must not freeze the time it was computed at: the
 * "(in 5h12m)" clause of `paused until 00:00 UTC (in …)` is recomputed for
 * the current run.
 */
export function refreshPauseClause(stderr: string, dayEndMs: number, now: Date): string {
  return stderr.replace(/paused until 00:00 UTC \(in [^)]*\)/g, `paused until 00:00 UTC (in ${formatRemaining(dayEndMs - now.getTime())})`);
}
