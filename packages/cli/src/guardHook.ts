import { checkGuard, type GuardCheckDependencies, type GuardCheckOutcome } from "./guard.js";

/**
 * The Claude Code hook entry behind `.aibill/guard-hook.mjs`. It imports only
 * the guard modules, not the whole CLI, so a warm run costs the Node start,
 * the policy read and the appended transcript bytes. Contract: exit 2 with the
 * block message on stderr when the budget is spent; otherwise exit 0 with at
 * most one warning line on stderr and nothing on stdout, because Claude Code
 * adds a UserPromptSubmit hook's stdout to the model's context.
 */

const HOOK_INPUT_MAX_BYTES = 64 * 1_024;
const HOOK_INPUT_WAIT_MS = 400;

export type GuardHookInput = {
  cwd?: string;
  sessionId?: string;
  model?: string;
  hookEventName?: string;
};

type ReadableLike = NodeJS.ReadableStream & { isTTY?: boolean; readableEnded?: boolean; destroyed?: boolean };

/** Read the hook's JSON from stdin, bounded in bytes and time. Never throws. */
export async function readGuardHookInput(
  input: ReadableLike | null | undefined,
  maxBytes = HOOK_INPUT_MAX_BYTES,
  waitMs = HOOK_INPUT_WAIT_MS
): Promise<GuardHookInput | undefined> {
  if (!input || input.isTTY || input.readableEnded || input.destroyed) return undefined;
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

export function parseGuardHookInput(text: string | undefined): GuardHookInput | undefined {
  if (!text || !text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const stringField = (key: string): string | undefined => {
    const field = record[key];
    return typeof field === "string" && field.length > 0 && field.length <= 4_096 ? field : undefined;
  };
  return {
    cwd: stringField("cwd"),
    sessionId: stringField("session_id"),
    model: stringField("model"),
    hookEventName: stringField("hook_event_name")
  };
}

export function guardHookDependenciesFromEnvironment(): GuardCheckDependencies {
  return {
    claudeProjectsDir: process.env.AI_SPEND_CLAUDE_LOGS_DIR,
    cacheDirectory: process.env.AIBILL_CACHE_DIR
  };
}

export async function runGuardHook(options: {
  stdin?: ReadableLike | null;
  stderr?: { write: (text: string) => unknown };
  cwd?: string;
  now?: Date;
  dependencies?: GuardCheckDependencies;
} = {}): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  let outcome: GuardCheckOutcome;
  try {
    const input = await readGuardHookInput(options.stdin === undefined ? process.stdin : options.stdin);
    outcome = await checkGuard({
      cwd: input?.cwd ?? options.cwd ?? process.cwd(),
      sessionId: input?.sessionId,
      model: input?.model,
      hookEventName: input?.hookEventName,
      now: options.now
    }, options.dependencies ?? guardHookDependenciesFromEnvironment());
  } catch (error) {
    // Fail open: an unexpected failure in the guard must never block work.
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
