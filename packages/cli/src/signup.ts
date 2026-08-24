import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI email capture — the launch-list signup lane (v0.9.2).
 *
 * Design: docs/qa-handoff/CLI_CAPTURE_DESIGN.md
 * QA verdict (fixes are mandatory): docs/qa-handoff/CLI_CAPTURE_QA_VERDICT.md
 *
 * Hard rules encoded here:
 * - The payload is EXACTLY {email, ref} — the deployed asktilden.com route
 *   reads `ref` (not `sourceRef`) and normalizes anything failing
 *   /^[a-z0-9][a-z0-9_-]{0,63}$/ (dots included) to "direct" (verdict B1).
 * - Consent shows the literal payload JSON; the sent line claims only the
 *   payload layer, never "nothing else left this machine" (verdict B2).
 * - One POST attempt, 3s timeout, no retry, no queue, and the typed email is
 *   never persisted on failure.
 * - The post-receipt ask is a timeout-guarded read that can never eat a
 *   skip: a timeout records NO lifetime skip (verdict M3).
 * - Never-ask state lives in ~/.aibill/signup.json (the existing home dir —
 *   verdict M5) and fails CLOSED to never-ask on corrupt/readonly state.
 */

export const waitlistUrl = "https://asktilden.com/api/waitlist";

/** Closed payload type — adding a field here must fail the creep-guard test. */
export type WaitlistPayload = { email: string; ref: string };

export type WaitlistRefSurface = "receipt" | "signup";

// Server-parity email rules (apps/web/app/api/waitlist/route.ts): trim,
// lowercase, <=254 chars, pragmatic shape check. The CLI additionally rejects
// control bytes (terminal-escape injection into the echoed consent line).
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const controlBytePattern = /[\u0000-\u001f\u007f-\u009f]/u;

// The deployed route's ref contract: dot-free, else attribution silently
// becomes "direct" (verdict B1). Both patterns are pinned by tests.
export const deployedRefPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const refTagPattern = /^[a-z0-9-]{1,24}$/;

export function normalizeWaitlistEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254) return undefined;
  if (controlBytePattern.test(email)) return undefined;
  if (!emailPattern.test(email)) return undefined;
  return email;
}

/** `--ref` allowlist: lowercase alphanumerics and dashes, 1–24 chars. */
export function sanitizeSignupRefTag(raw: string): string | undefined {
  const tag = raw.trim().toLowerCase();
  return refTagPattern.test(tag) ? tag : undefined;
}

export function buildWaitlistRef(surface: WaitlistRefSurface, tag?: string): string {
  const ref = tag === undefined ? `cli-${surface}` : `cli-${surface}-${tag}`;
  if (!deployedRefPattern.test(ref)) {
    // Structurally unreachable (surface enum + tag allowlist), kept as a
    // fail-closed guard so a future edit cannot ship a ref the deployed
    // route would rewrite to "direct".
    throw new Error("signup ref failed the deployed route contract");
  }
  return ref;
}

/**
 * The exact bytes sent — key order pinned. Payload creep (adding os/plan/
 * version data, or stuffing values into ref) fails the CI creep-guard test;
 * see docs/qa-handoff/CLI_CAPTURE_DESIGN.md §3c before touching this.
 */
export function serializeWaitlistPayload(payload: WaitlistPayload): string {
  return JSON.stringify({ email: payload.email, ref: payload.ref });
}

export type WaitlistPostOutcome = "sent" | "invalid_email" | "rate_limited" | "unreachable";

/**
 * Single POST, 3s timeout, one attempt, no retry, no queue. The response
 * body is never printed (it could be an HTML error page); only the status
 * code is mapped. Headers are the full explicit set this request adds —
 * pinned by test so header creep fails CI too.
 */
export async function postWaitlistSignup(
  payload: WaitlistPayload,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<WaitlistPostOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(waitlistUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "aibill-cli" },
      body: serializeWaitlistPayload(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000)
    });
    // 201 covers duplicates too — the route maps the unique-email conflict
    // to 201, so signup is idempotent server-side.
    if (response.status === 201) return "sent";
    if (response.status === 422) return "invalid_email";
    if (response.status === 429) return "rate_limited";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

// ---------------------------------------------------------------------------
// Copy — declarative, ·-separated, promising ONLY what exists for the cli-*
// refs: launch updates (docs/EMAIL_SEND_POLICY.md anchors the promise per
// ref; verdict M1/M2). No savings claims, no urgency, no beta/Workspace/
// weekly language.
// ---------------------------------------------------------------------------

export const signupCopy = {
  askQuestion: "launch updates — type your email to join, Enter to skip: ",
  scopeLine: "your email is used only for launch updates · never shared",
  consentQuestion: (payloadJson: string): string => `send ${payloadJson} → asktilden.com/api/waitlist? [y/N] `,
  sentLine: "sent: exactly that JSON · nothing else in the payload",
  neverLine: "ok — never asking again · npx aibill signup <email> if you change your mind",
  invalidEmailLine: "that email did not validate — check it and retry",
  rateLimitedLine: "busy — try again in a minute, or join at https://asktilden.com",
  unreachableLine: "could not reach asktilden.com — join at https://asktilden.com",
  alreadyLine: "already on the list · nothing sent twice",
  nothingSentLine: "nothing sent",
  nonInteractiveLine: "signup needs an interactive terminal — or join at https://asktilden.com",
  forgetLine: "local signup state cleared · to leave the list, reply to any email or write hello@asktilden.com",
  // Static pointer lines (never interactive; see the capture design's
  // moments map).
  receiptPointer: "npx aibill signup <email>         launch updates · optional · email only",
  samplePointer: "launch updates: npx aibill signup <email> · optional · email only",
  initPointer: "launch updates (optional): npx aibill signup <email>",
  statuslinePointer: "launch updates: npx aibill signup <email> · optional"
} as const;

// ---------------------------------------------------------------------------
// "Never ask again" state — ~/.aibill/signup.json (the SECOND home-scope
// aibill file, next to the statusline cache; documented in the README).
// ---------------------------------------------------------------------------

export type SignupStatus = "subscribed" | "never" | "deferred";

export type SignupState = {
  version: 1;
  status: SignupStatus;
  /** Lifetime count of explicit user skips (Enter / declined consent). */
  askCount: number;
  lastAskedAt?: string;
  /** Stored only after a successful subscribe, only locally. */
  email?: string;
};

export type SignupStateRead =
  | { kind: "fresh" }
  | { kind: "ok"; state: SignupState }
  | { kind: "unreadable" };

export function signupStateFilePath(homeDirectory?: string): string {
  return join(homeDirectory ?? homedir(), ".aibill", "signup.json");
}

function isSignupState(value: unknown): value is SignupState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    (state.status === "subscribed" || state.status === "never" || state.status === "deferred") &&
    typeof state.askCount === "number" && Number.isInteger(state.askCount) && state.askCount >= 0 &&
    (state.lastAskedAt === undefined || typeof state.lastAskedAt === "string") &&
    (state.email === undefined || typeof state.email === "string");
}

export async function readSignupState(filePath: string): Promise<SignupStateRead> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "fresh" };
    }
    // Unreadable (permissions, not a file, …): fail closed to never-ask.
    return { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!isSignupState(parsed)) return { kind: "unreadable" };
    return { kind: "ok", state: parsed };
  } catch {
    // Corrupt state must never cause re-nagging: fail closed.
    return { kind: "unreadable" };
  }
}

/** Atomic-ish write; returns false instead of throwing so callers fail closed. */
export async function writeSignupState(filePath: string, state: SignupState): Promise<boolean> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export async function clearSignupState(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

const minimumMsBetweenAsks = 7 * 24 * 60 * 60 * 1_000;

/**
 * Whether the ONE post-receipt ask may run. Fails closed on unreadable
 * state; a future-dated lastAskedAt (clock moved back) counts as recently
 * asked, never as a reason to re-ask.
 */
export function signupAskAllowed(read: SignupStateRead, now: Date): boolean {
  if (read.kind === "unreadable") return false;
  if (read.kind === "fresh") return true;
  const state = read.state;
  if (state.status === "subscribed" || state.status === "never") return false;
  if (state.askCount >= 2) return false;
  if (state.lastAskedAt !== undefined) {
    const askedAt = Date.parse(state.lastAskedAt);
    if (!Number.isFinite(askedAt)) return false;
    const age = now.getTime() - askedAt;
    if (age < minimumMsBetweenAsks) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The one inline post-receipt ask.
// ---------------------------------------------------------------------------

export type SignupAskIo = {
  /** Resolves the typed line, or undefined when the inactivity timeout fired. */
  question: (query: string, timeoutMs: number) => Promise<string | undefined>;
  write: (line: string) => void;
};

export const signupAskTimeoutMs = 30_000;

/**
 * Runs after the receipt has fully printed. The receipt's bytes and exit
 * code are already settled — nothing here may throw, retry, or queue.
 *
 * Decision ledger:
 * - timeout            → no decision: lastAskedAt stamped, NO skip consumed
 * - Enter              → skip (askCount + 1; two lifetime skips end the asks)
 * - n / never          → never ask again
 * - email + y + 201    → subscribed
 * - email + y + failure→ deferred, email NOT persisted
 */
export async function runPostReceiptSignupAsk(options: {
  io: SignupAskIo;
  stateFilePath: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const read = await readSignupState(options.stateFilePath);
  if (!signupAskAllowed(read, now())) return;
  const base: SignupState = read.kind === "ok"
    ? read.state
    : { version: 1, status: "deferred", askCount: 0 };

  // Stamp the ask BEFORE prompting. If home state cannot be written the ask
  // never shows (readonly home must not become an every-run nag: the decision
  // could never be persisted — fail closed to never-ask).
  const stamped: SignupState = { ...base, status: "deferred", lastAskedAt: now().toISOString() };
  if (!await writeSignupState(options.stateFilePath, stamped)) return;

  const answer = await options.io.question(signupCopy.askQuestion, signupAskTimeoutMs);
  if (answer === undefined) {
    // Inactivity timeout: no decision was made, so no lifetime skip is
    // consumed (verdict M3). The lastAskedAt stamp already prevents an
    // every-run re-ask.
    return;
  }
  const trimmed = answer.trim();
  if (trimmed === "") {
    await writeSignupState(options.stateFilePath, { ...stamped, askCount: stamped.askCount + 1 });
    return;
  }
  if (trimmed.toLowerCase() === "n" || trimmed.toLowerCase() === "never") {
    await writeSignupState(options.stateFilePath, { ...stamped, status: "never" });
    options.io.write(signupCopy.neverLine);
    return;
  }

  const email = normalizeWaitlistEmail(trimmed);
  if (email === undefined) {
    await writeSignupState(options.stateFilePath, { ...stamped, askCount: stamped.askCount + 1 });
    options.io.write(`${signupCopy.invalidEmailLine}: npx aibill signup <email>`);
    return;
  }

  const payload: WaitlistPayload = { email, ref: buildWaitlistRef("receipt") };
  options.io.write(signupCopy.scopeLine);
  const consent = await options.io.question(
    signupCopy.consentQuestion(serializeWaitlistPayload(payload)),
    signupAskTimeoutMs
  );
  if (consent === undefined) return;
  const consentAnswer = consent.trim().toLowerCase();
  if (consentAnswer !== "y" && consentAnswer !== "yes") {
    await writeSignupState(options.stateFilePath, { ...stamped, askCount: stamped.askCount + 1 });
    return;
  }

  const outcome = await postWaitlistSignup(payload, { fetchImpl: options.fetchImpl });
  if (outcome === "sent") {
    await writeSignupState(options.stateFilePath, { ...stamped, status: "subscribed", email });
    options.io.write(signupCopy.sentLine);
    return;
  }
  // Failure: the typed email is never persisted, retried, or queued.
  await writeSignupState(options.stateFilePath, stamped);
  options.io.write(
    outcome === "invalid_email"
      ? signupCopy.invalidEmailLine
      : outcome === "rate_limited"
        ? signupCopy.rateLimitedLine
        : signupCopy.unreachableLine
  );
}

/**
 * Terminal binding for the post-receipt ask: its own readline with an
 * AbortSignal inactivity timeout. The timeout race can never eat a typed
 * skip — either the line resolved first (the skip is recorded) or the abort
 * won and NOTHING is recorded; the wrong decision is unrepresentable.
 * Ctrl-C mid-prompt closes cleanly with nothing sent.
 */
export async function runPostReceiptSignupAskInTerminal(): Promise<void> {
  try {
    const { createInterface } = await import("node:readline/promises");
    const lineInterface = createInterface({ input: process.stdin, output: process.stdout });
    let interrupted = false;
    lineInterface.on("SIGINT", () => {
      interrupted = true;
      lineInterface.close();
    });
    const io: SignupAskIo = {
      question: async (query, timeoutMs) => {
        if (interrupted) return undefined;
        try {
          return await lineInterface.question(query, { signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          // Timeout, closed stream, or Ctrl-C: a no-decision, never a skip.
          return undefined;
        }
      },
      write: (line) => {
        process.stdout.write(`${line}\n`);
      }
    };
    try {
      await runPostReceiptSignupAsk({ io, stateFilePath: signupStateFilePath() });
    } finally {
      lineInterface.close();
    }
  } catch {
    // The ask must never break the receipt path.
  }
}
