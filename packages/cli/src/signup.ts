import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI email capture — the launch-list signup lane (v0.9.2).
 *
 * Design: docs/qa-handoff/CLI_CAPTURE_DESIGN.md (see its dated placement
 * addendum). QA verdict (its B/M fixes are mandatory):
 * docs/qa-handoff/CLI_CAPTURE_QA_VERDICT.md.
 *
 * Placement (founder decision 2026-08-24): the ONE ask runs PRE-RECEIPT,
 * DURING the first evidence scan — it fills the first-run wait instead of
 * adding one. The receipt renders when both the human's answer (or skip /
 * timeout / Ctrl-C) and the pipeline resolve; consent, when an email was
 * typed, renders strictly AFTER the receipt.
 *
 * Hard rules encoded here:
 * - The payload is EXACTLY {email, ref} — the deployed asktilden.com route
 *   reads `ref` (not `sourceRef`) and normalizes anything failing
 *   /^[a-z0-9][a-z0-9_-]{0,63}$/ (dots included) to "direct" (verdict B1).
 * - Consent shows the literal payload JSON; the sent line claims only the
 *   payload layer, never "nothing else left this machine" (verdict B2).
 * - One POST attempt, 3s timeout, no retry, no queue, and the typed email is
 *   never persisted on failure.
 * - Every read is timeout-guarded and can never eat a skip: a timeout or
 *   Ctrl-C records NO lifetime skip (verdict M3).
 * - Skip = two empty Enters with one declarative nudge between them; the
 *   completed pair counts as ONE lifetime skip. This is the founder-approved
 *   ceiling: no further skip friction may be added, and removal of skip is
 *   refused by design.
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
// Email deliverability (founder addition 2026-08-24): after format
// validation, resolve MX for the domain (A-record fallback) with a hard
// 1.5s budget. DNS problems NEVER block capture — only a provable
// cannot-receive answer (or a disposable-inbox domain) re-prompts, and
// re-prompts never consume skips.
// ---------------------------------------------------------------------------

export type EmailDeliverability = "ok" | "no_mx" | "disposable";

/** Small static blocklist of throwaway-inbox domains (exact match only). */
export const disposableEmailDomains: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "sharklasers.com",
  "grr.la",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "mintemail.com",
  "throwawaymail.com",
  "fakeinbox.com",
  "mailnesia.com",
  "spamgourmet.com",
  "mytemp.email",
  "tempinbox.com",
  "emailondeck.com"
]);

export type SignupDnsResolver = {
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resolve4: (domain: string) => Promise<string[]>;
};

async function defaultSignupDnsResolver(): Promise<SignupDnsResolver> {
  const dns = await import("node:dns/promises");
  return { resolveMx: (domain) => dns.resolveMx(domain), resolve4: (domain) => dns.resolve4(domain) };
}

const dnsTimeoutMs = 1_500;

function isDefinitiveDnsMiss(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTFOUND" || code === "ENODATA";
}

export async function assessEmailDeliverability(
  email: string,
  options: { resolver?: SignupDnsResolver; timeoutMs?: number } = {}
): Promise<EmailDeliverability> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (disposableEmailDomains.has(domain)) return "disposable";
  const resolver = options.resolver ?? await defaultSignupDnsResolver().catch(() => undefined);
  if (!resolver) return "ok";
  const budgetMs = options.timeoutMs ?? dnsTimeoutMs;
  const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("dns timeout")), budgetMs);
          timer.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const records = await withTimeout(resolver.resolveMx(domain));
    // RFC 7505 null MX ("." exchange) is an explicit refusal to receive.
    const receiving = records.filter((record) => record.exchange !== "" && record.exchange !== ".");
    if (receiving.length > 0) return "ok";
    if (records.length > 0) return "no_mx";
    // Zero MX records without an error: fall through to the A-record check.
  } catch (error) {
    if (!isDefinitiveDnsMiss(error)) {
      // Timeout / transport / resolver failure: NEVER block capture on DNS.
      return "ok";
    }
  }
  try {
    const addresses = await withTimeout(resolver.resolve4(domain));
    return addresses.length > 0 ? "ok" : "no_mx";
  } catch (error) {
    return isDefinitiveDnsMiss(error) ? "no_mx" : "ok";
  }
}

// ---------------------------------------------------------------------------
// Copy — declarative, ·-separated, promising ONLY what exists for the cli-*
// refs: the launch email + product updates (docs/EMAIL_SEND_POLICY.md
// anchors the promise per ref; verdict M1/M2). No savings claims, no
// urgency, no confirm-shaming, no beta/Workspace/weekly language.
// ---------------------------------------------------------------------------

export const signupCopy = {
  /**
   * Launch-week headline — TRUE only through launch day (Fri Aug 28); the
   * date gate in signupAskBlockLines swaps in the evergreen fallback after
   * signupLaunchWindowEndsAt so this copy can never go stale.
   */
  askHeadlineLaunch: [
    "aibill launches Friday with Star.fun.",
    "Get the launch email + what ships next:"
  ],
  askHeadlineFallback: ["Get product updates:"],
  askFooter: "type your email, or press Enter to skip",
  askPrompt: "  > ",
  waitLine: "reading your local AI evidence…",
  /** Printed once if the scan finishes while the ask is still open. */
  receiptReadyLine: "your receipt is ready — type your email, or press Enter to see it",
  /** Printed after the FIRST empty Enter; the second empty Enter skips. */
  skipNudgeLine: "one launch email · Enter again to skip, or type your email",
  scopeLine: "used only for updates · never shared",
  consentQuestion: (payloadJson: string): string => `send ${payloadJson} → asktilden.com/api/waitlist? [y/N] `,
  sentLine: "sent: exactly that JSON · nothing else in the payload",
  neverLine: "ok — never asking again · npx aibill signup <email> if you change your mind",
  invalidEmailLine: "that email did not validate — check it and retry",
  noMxLine: "that domain can't receive email — check the spelling",
  disposableLine: "use an address you actually check",
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

/**
 * End of the launch-week headline window (the Friday line is true only
 * through launch day, Fri 2026-08-28). After this instant the ask block
 * automatically uses the evergreen fallback headline.
 */
export const signupLaunchWindowEndsAt = "2026-08-29T00:00:00Z";

/**
 * The standout ask block: full-width rule (the receipt's own rule
 * convention), then the headline for the current window, then the skip
 * footer. Text lines carry the receipt's two-space indent.
 */
export function signupAskBlockLines(now: Date, width: number): string[] {
  const headline = now.getTime() < Date.parse(signupLaunchWindowEndsAt)
    ? signupCopy.askHeadlineLaunch
    : signupCopy.askHeadlineFallback;
  return [
    "─".repeat(Math.max(8, width)),
    ...headline.map((line) => `  ${line}`),
    `  ${signupCopy.askFooter}`
  ];
}

/** Same clamp the receipt renderer applies (COLUMNS → tty → 72, 40..120). */
export function signupTerminalWidth(): number {
  const envColumns = Number(process.env.COLUMNS);
  const ttyColumns = process.stdout.columns;
  const requested = Number.isFinite(envColumns) && envColumns > 0
    ? envColumns
    : Number.isFinite(ttyColumns) && (ttyColumns ?? 0) > 0
      ? ttyColumns!
      : 72;
  return Math.max(40, Math.min(120, Math.floor(requested)));
}

// ---------------------------------------------------------------------------
// "Never ask again" state — ~/.aibill/signup.json (the SECOND home-scope
// aibill file, next to the statusline cache; documented in the README).
// ---------------------------------------------------------------------------

export type SignupStatus = "subscribed" | "never" | "deferred";

export type SignupState = {
  version: 1;
  status: SignupStatus;
  /** Lifetime count of completed explicit skips (double-Enter / declined consent). */
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
 * Whether the ONE ask may run. Fails closed on unreadable state; a
 * future-dated lastAskedAt (clock moved back) counts as recently asked,
 * never as a reason to re-ask.
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
// The pre-receipt, during-the-scan ask.
// ---------------------------------------------------------------------------

export type SignupAskIo = {
  /** Resolves the typed line, or undefined when the read timed out / aborted. */
  question: (query: string, timeoutMs: number) => Promise<string | undefined>;
  write: (line: string) => void;
  /** Raw prompt redraw after a nudge line (no newline appended). */
  writeRaw?: (text: string) => void;
};

export const signupAskTimeoutMs = 30_000;

export type PreReceiptAskOutcome =
  | { kind: "no_ask" }
  | { kind: "skipped" }
  | { kind: "email"; payload: WaitlistPayload; stamped: SignupState };

export type PreReceiptAskSession = {
  /** Resolves when the human answered, skipped, timed out, or interrupted. */
  outcome: Promise<PreReceiptAskOutcome>;
  /**
   * Ready-nudge: the pipeline finished while the ask is still open. Prints
   * one line and re-draws the prompt; the open read's timer is NOT reset.
   */
  notifyReceiptReady: () => void;
};

/**
 * Opens the ONE ask, or returns undefined (with zero output) when state
 * disallows it — subsequent runs stay byte-identical to the fast path.
 *
 * Decision ledger (unchanged semantics, earlier placement):
 * - timeout / Ctrl-C        → no decision: lastAskedAt stamped, NO skip
 * - Enter, then Enter again → ONE lifetime skip (nudge line between)
 * - n / never               → never ask again
 * - typed input             → email path (format + deliverability checks
 *                             re-prompt without consuming skips)
 * The consent step (literal payload JSON → y/N → single POST) runs strictly
 * AFTER the receipt via runSignupConsentAfterReceipt.
 */
export async function openPreReceiptSignupAsk(options: {
  io: SignupAskIo;
  stateFilePath: string;
  now?: () => Date;
  width?: number;
  /** Lines printed before the ask block (the terminal wait line). */
  preambleLines?: readonly string[];
  dnsResolver?: SignupDnsResolver;
}): Promise<PreReceiptAskSession | undefined> {
  const now = options.now ?? (() => new Date());
  const read = await readSignupState(options.stateFilePath);
  if (!signupAskAllowed(read, now())) return undefined;
  const base: SignupState = read.kind === "ok"
    ? read.state
    : { version: 1, status: "deferred", askCount: 0 };

  // Stamp the ask BEFORE prompting. If home state cannot be written the ask
  // never shows (readonly home must not become an every-run nag: the decision
  // could never be persisted — fail closed to never-ask).
  const stamped: SignupState = { ...base, status: "deferred", lastAskedAt: now().toISOString() };
  if (!await writeSignupState(options.stateFilePath, stamped)) return undefined;

  let settled = false;
  const io = options.io;
  const write = (line: string) => io.write(line);

  const outcome = (async (): Promise<PreReceiptAskOutcome> => {
    for (const line of options.preambleLines ?? []) write(line);
    write("");
    for (const line of signupAskBlockLines(now(), options.width ?? 72)) write(line);

    let enterNudgeShown = false;
    // Bounded re-prompt budget: format/deliverability rejections re-prompt
    // without consuming skips, but an adversarial or hopeless session ends
    // silently (no skip consumed) instead of looping forever.
    for (let rejections = 0; rejections < 6; rejections += 1) {
      const answer = await io.question(signupCopy.askPrompt, signupAskTimeoutMs);
      if (answer === undefined) {
        // Inactivity timeout or Ctrl-C: no decision, no lifetime skip
        // (verdict M3) — the lastAskedAt stamp alone throttles re-asks.
        return { kind: "skipped" };
      }
      const trimmed = answer.trim();
      if (trimmed === "") {
        if (!enterNudgeShown) {
          // Founder-approved ceiling: exactly one declarative nudge, then
          // the second empty Enter completes the skip. Never more.
          enterNudgeShown = true;
          write(`  ${signupCopy.skipNudgeLine}`);
          continue;
        }
        await writeSignupState(options.stateFilePath, { ...stamped, askCount: stamped.askCount + 1 });
        return { kind: "skipped" };
      }
      const lowered = trimmed.toLowerCase();
      if (lowered === "n" || lowered === "never") {
        await writeSignupState(options.stateFilePath, { ...stamped, status: "never" });
        write(`  ${signupCopy.neverLine}`);
        return { kind: "skipped" };
      }
      const email = normalizeWaitlistEmail(trimmed);
      if (email === undefined) {
        write(`  ${signupCopy.invalidEmailLine}`);
        continue;
      }
      const deliverability = await assessEmailDeliverability(email, {
        ...(options.dnsResolver ? { resolver: options.dnsResolver } : {})
      });
      if (deliverability === "no_mx") {
        write(`  ${signupCopy.noMxLine}`);
        continue;
      }
      if (deliverability === "disposable") {
        write(`  ${signupCopy.disposableLine}`);
        continue;
      }
      return { kind: "email", payload: { email, ref: buildWaitlistRef("receipt") }, stamped };
    }
    return { kind: "skipped" };
  })().finally(() => {
    settled = true;
  });

  return {
    outcome,
    notifyReceiptReady: () => {
      if (settled) return;
      io.write(`  ${signupCopy.receiptReadyLine}`);
      io.writeRaw?.(signupCopy.askPrompt);
    }
  };
}

/**
 * The consent step, strictly AFTER the receipt has printed: scope line, the
 * literal payload JSON, a typed y — then ONE POST. Failures never persist,
 * retry, or queue the typed email.
 */
export async function runSignupConsentAfterReceipt(options: {
  io: SignupAskIo;
  stateFilePath: string;
  payload: WaitlistPayload;
  stamped: SignupState;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { io, stamped } = options;
  io.write("");
  io.write(signupCopy.scopeLine);
  const consent = await io.question(
    signupCopy.consentQuestion(serializeWaitlistPayload(options.payload)),
    signupAskTimeoutMs
  );
  if (consent === undefined) return;
  const consentAnswer = consent.trim().toLowerCase();
  if (consentAnswer !== "y" && consentAnswer !== "yes") {
    await writeSignupState(options.stateFilePath, { ...stamped, askCount: stamped.askCount + 1 });
    return;
  }
  const outcome = await postWaitlistSignup(options.payload, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  if (outcome === "sent") {
    await writeSignupState(options.stateFilePath, {
      ...stamped,
      status: "subscribed",
      email: options.payload.email
    });
    io.write(signupCopy.sentLine);
    return;
  }
  // Failure: the typed email is never persisted, retried, or queued.
  await writeSignupState(options.stateFilePath, stamped);
  io.write(
    outcome === "invalid_email"
      ? signupCopy.invalidEmailLine
      : outcome === "rate_limited"
        ? signupCopy.rateLimitedLine
        : signupCopy.unreachableLine
  );
}

/**
 * Which argv shapes qualify for the during-scan ask: the real receipt path
 * only — the default/quickstart command (flag-form included) — and never
 * sample, drill-downs, JSON, help/version, or any named command (improve,
 * report, init, …).
 */
export function qualifiesForPreReceiptSignupAsk(argv: readonly string[]): boolean {
  if (argv.includes("--sample") || argv.includes("--group-by") || argv.includes("--json")) return false;
  if (argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-v")) return false;
  const command = argv[0];
  return command === undefined || command === "quickstart" || command === "demo" || command.startsWith("--");
}

/**
 * Concurrency shell: run the evidence pipeline and the open ask together.
 * The receipt renders only after BOTH resolve; a pipeline error is captured
 * (never an unhandled rejection) and still waits for the bounded ask, so a
 * prompt can never hang over a dead pipeline longer than its own timeout.
 * If the pipeline settles first, the session gets the one ready-nudge.
 */
export async function orchestratePreReceiptAsk<T>(input: {
  session: PreReceiptAskSession | undefined;
  runPipeline: () => Promise<T>;
}): Promise<{
  pipeline: { ok: true; value: T } | { ok: false; error: unknown };
  outcome: PreReceiptAskOutcome;
}> {
  const settledPipeline = input.runPipeline().then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
  const session = input.session;
  if (!session) {
    return { pipeline: await settledPipeline, outcome: { kind: "no_ask" } };
  }
  let askSettled = false;
  const trackedOutcome = session.outcome.then((value) => {
    askSettled = true;
    return value;
  });
  void settledPipeline.then(() => {
    if (!askSettled) session.notifyReceiptReady();
  });
  const [pipeline, outcome] = await Promise.all([settledPipeline, trackedOutcome]);
  return { pipeline, outcome };
}

// ---------------------------------------------------------------------------
// Terminal binding for the bin entrypoint.
// ---------------------------------------------------------------------------

export type TerminalPreReceiptAsk = {
  session: PreReceiptAskSession;
  /** True when the last read ended without the user pressing Enter. */
  needsFreshLine: () => boolean;
  runConsent: (outcome: Extract<PreReceiptAskOutcome, { kind: "email" }>) => Promise<void>;
  close: () => void;
};

/**
 * Opens the during-scan ask on the real terminal: its own readline with
 * per-read AbortSignal timeouts. The timeout race can never eat a typed
 * skip — either the line resolved first (the skip is recorded) or the abort
 * won and NOTHING is recorded; the wrong decision is unrepresentable.
 * Ctrl-C cancels only the ask (no skip consumed, state already stamped);
 * the receipt still renders. Returns undefined — with zero output — when
 * signup state disallows the ask.
 */
export async function openPreReceiptSignupAskInTerminal(): Promise<TerminalPreReceiptAsk | undefined> {
  try {
    const { createInterface } = await import("node:readline/promises");
    const lineInterface = createInterface({ input: process.stdin, output: process.stdout });
    let interrupted = false;
    let abortedRead = false;
    // Ctrl-C must SETTLE the pending read (closing the interface alone
    // leaves question() unsettled, draining the loop before the receipt
    // prints — the ask would eat the whole run). The interrupt signal
    // rejects the read deterministically; the ask resolves as a
    // no-decision and the receipt still renders.
    const interruptController = new AbortController();
    lineInterface.on("SIGINT", () => {
      interrupted = true;
      interruptController.abort();
      lineInterface.close();
    });
    const io: SignupAskIo = {
      question: async (query, timeoutMs) => {
        if (interrupted) return undefined;
        try {
          const answer = await lineInterface.question(query, {
            signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), interruptController.signal])
          });
          abortedRead = false;
          return answer;
        } catch {
          // Timeout, closed stream, or Ctrl-C: a no-decision, never a skip.
          abortedRead = true;
          return undefined;
        }
      },
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
      writeRaw: (text) => {
        process.stdout.write(text);
      }
    };
    const session = await openPreReceiptSignupAsk({
      io,
      stateFilePath: signupStateFilePath(),
      width: signupTerminalWidth(),
      preambleLines: [signupCopy.waitLine]
    });
    if (!session) {
      lineInterface.close();
      return undefined;
    }
    return {
      session,
      needsFreshLine: () => abortedRead,
      runConsent: async (outcome) => {
        if (interrupted) return;
        try {
          await runSignupConsentAfterReceipt({
            io,
            stateFilePath: signupStateFilePath(),
            payload: outcome.payload,
            stamped: outcome.stamped
          });
        } catch {
          // Consent must never break the receipt path.
        }
      },
      close: () => {
        lineInterface.close();
      }
    };
  } catch {
    return undefined;
  }
}
