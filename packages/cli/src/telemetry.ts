import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI telemetry — anonymous command counts, notice-before-first-byte.
 *
 * Consent model (founder decision 2026-08-24, disclosed opt-out):
 * - Run 1 (interactive) prints a three-line notice AFTER the output and
 *   stamps noticedAt. NOTHING is sent on that run.
 * - Events begin only on runs after noticedAt exists. A user who has never
 *   seen the notice is never tracked — non-interactive runs before any
 *   notice emit nothing, ever.
 * - `aibill telemetry` shows status + the exact last payload verbatim;
 *   `aibill telemetry off` / `on` switch it. DO_NOT_TRACK, CI, and
 *   AI_SPEND_NO_TELEMETRY hard-disable it regardless of state.
 * - State is fail-closed: corrupt or unreadable state means telemetry OFF.
 *
 * Payload truth (non-negotiable):
 * - The event is EXACTLY {installId, command, version, os, arch, ci,
 *   durationBucket, ok, ts} — no args, flag values, paths, content, email,
 *   or anything joinable to signup.json. The installId lives ONLY in
 *   ~/.aibill/telemetry.json; the signup state has no installId and the
 *   telemetry state has no email — per-email usage is structurally
 *   impossible, and tests pin the separation.
 * - When telemetry is enabled+noticed, every surface that printed
 *   "nothing uploaded" prints the disclosure line instead — the receipt
 *   never claims less than what leaves the machine.
 * - One fire-and-forget POST per run, batch of 1 (contract allows up to
 *   10 per batch, 4096-byte body cap), hard 1500ms abort, never retried,
 *   never queued, total silence on any failure (any non-204 = drop).
 */

export const telemetryUrl = "https://asktilden.com/api/telemetry";

/** Server-allowlisted command labels; anything else is sent as "other". */
export const telemetryCommands = [
  "receipt",
  "full",
  "group-by",
  "improve",
  "improve-sample",
  "index",
  "identify",
  "accountability",
  "outcome",
  "statusline",
  "statusline-expand",
  "signup",
  "connect",
  "sync-provider",
  "doctor",
  "report",
  "report-card",
  "apply",
  "watch",
  "init",
  "verify",
  "drop-slice",
  "telemetry",
  "other"
] as const;

export type TelemetryCommand = (typeof telemetryCommands)[number];

export type TelemetryDurationBucket = "lt1s" | "lt5s" | "lt30s" | "gte30s";

export type TelemetryOs = "darwin" | "linux" | "win32" | "other";
export type TelemetryArch = "arm64" | "x64" | "other";

/** Closed event type — adding a field must fail the creep-guard test. */
export type TelemetryEvent = {
  installId: string;
  command: TelemetryCommand;
  version: string;
  os: TelemetryOs;
  arch: TelemetryArch;
  ci: boolean;
  durationBucket: TelemetryDurationBucket;
  ok: boolean;
  ts: string;
};

/** Printed instead of "nothing uploaded" while telemetry is active. */
export const telemetryDisclosureLine = "anonymous command counts shared · aibill telemetry off";

export const telemetryNoticeLines = [
  "aibill counts which commands run — anonymous, never your data or content",
  "turn off: aibill telemetry off",
  "see payloads: aibill telemetry"
] as const;

export function telemetryOsLabel(platform: string = process.platform): TelemetryOs {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
}

export function telemetryArchLabel(arch: string = process.arch): TelemetryArch {
  return arch === "arm64" || arch === "x64" ? arch : "other";
}

export function telemetryDurationBucket(durationMs: number): TelemetryDurationBucket {
  if (durationMs < 1_000) return "lt1s";
  if (durationMs < 5_000) return "lt5s";
  if (durationMs < 30_000) return "lt30s";
  return "gte30s";
}

/**
 * argv → allowlisted command label. Only the command word is mapped; flag
 * VALUES, paths, and everything else in argv never leave this function.
 * Explicit --sample demo runs map to "other" so the receipt count stays a
 * count of real receipts.
 */
export function telemetryCommandForArgv(argv: readonly string[]): TelemetryCommand {
  const command = argv[0];
  const isQuickstart = command === undefined || command === "quickstart" || command === "demo" ||
    (command !== undefined && command.startsWith("-"));
  if (argv.includes("--version") || argv.includes("-v") || argv.includes("--help") || argv.includes("-h")) {
    return "other";
  }
  if (isQuickstart) {
    if (argv.includes("--sample")) return "other";
    if (argv.includes("--group-by")) return "group-by";
    if (argv.includes("--full")) return "full";
    return "receipt";
  }
  switch (command) {
    case "improve": return argv.includes("--sample") ? "improve-sample" : "improve";
    case "index": return "index";
    case "identify": return "identify";
    case "accountability": return "accountability";
    case "outcome": return "outcome";
    case "statusline": return argv[1] === "expand" ? "statusline-expand" : "statusline";
    case "signup": return "signup";
    case "connect": return "connect";
    case "sync-provider": return "sync-provider";
    case "doctor": return "doctor";
    case "report": return "report";
    case "report-card": return "report-card";
    case "apply":
    case "apply-artifact": return "apply";
    case "watch": return "watch";
    case "init": return "init";
    case "verify": return "verify";
    case "drop-slice": return "drop-slice";
    case "telemetry": return "telemetry";
    default: return "other";
  }
}

// ---------------------------------------------------------------------------
// State — ~/.aibill/telemetry.json. Deliberately a DIFFERENT file from
// signup.json with NO shared fields: the installId is unjoinable to any
// email by construction.
// ---------------------------------------------------------------------------

export type TelemetryState = {
  version: 1;
  installId: string;
  enabled: boolean;
  noticedAt?: string;
  /** The exact serialized batch last attempted, verbatim (inspectability). */
  lastPayload?: string;
};

export type TelemetryStateRead =
  | { kind: "fresh" }
  | { kind: "ok"; state: TelemetryState }
  | { kind: "unreadable" };

export function telemetryStateFilePath(homeDirectory?: string): string {
  return join(homeDirectory ?? homedir(), ".aibill", "telemetry.json");
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isTelemetryState(value: unknown): value is TelemetryState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    typeof state.installId === "string" && uuidPattern.test(state.installId) &&
    typeof state.enabled === "boolean" &&
    (state.noticedAt === undefined || typeof state.noticedAt === "string") &&
    (state.lastPayload === undefined || typeof state.lastPayload === "string");
}

export async function readTelemetryState(filePath: string): Promise<TelemetryStateRead> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "fresh" };
    }
    // Unreadable: telemetry fails CLOSED to off.
    return { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!isTelemetryState(parsed)) return { kind: "unreadable" };
    return { kind: "ok", state: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

export async function writeTelemetryState(filePath: string, state: TelemetryState): Promise<boolean> {
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

/** Environment kill-switches: any non-empty value disables telemetry. */
export function telemetryEnvDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.DO_NOT_TRACK) || Boolean(env.CI) || Boolean(env.AI_SPEND_NO_TELEMETRY);
}

// ---------------------------------------------------------------------------
// Batch serialization + transport (contract: web branch telemetry-endpoint).
// ---------------------------------------------------------------------------

export const telemetryBatchMaxEvents = 10;
export const telemetryBatchMaxBytes = 4_096;

export function serializeTelemetryEvent(event: TelemetryEvent): string {
  // Key order pinned by the creep-guard test.
  return JSON.stringify({
    installId: event.installId,
    command: event.command,
    version: event.version,
    os: event.os,
    arch: event.arch,
    ci: event.ci,
    durationBucket: event.durationBucket,
    ok: event.ok,
    ts: event.ts
  });
}

/**
 * Serializes {"events":[...]} within the contract caps (flush at <=10
 * events; body <=4096 bytes). Returns undefined — the batch is DROPPED —
 * when a cap would be exceeded; nothing is ever split-retried.
 */
export function serializeTelemetryBatch(events: readonly TelemetryEvent[]): string | undefined {
  if (events.length === 0 || events.length > telemetryBatchMaxEvents) return undefined;
  const body = `{"events":[${events.map(serializeTelemetryEvent).join(",")}]}`;
  if (Buffer.byteLength(body, "utf8") > telemetryBatchMaxBytes) return undefined;
  return body;
}

/**
 * One fire-and-forget POST: hard 1500ms abort, no retry, no queue, total
 * silence on ANY outcome that is not a 204 (4xx/429/5xx/transport = drop
 * and forget). Resolves quickly and never throws.
 */
export async function postTelemetryBatch(
  body: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    await fetchImpl(telemetryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "aibill-cli" },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500)
    });
  } catch {
    // Silence. Never retry, never queue, never surface.
  }
}

// ---------------------------------------------------------------------------
// The bin-entry runtime. Embedded runCli callers and the MCP server never
// construct this — zero emission outside the CLI entrypoint by structure.
// ---------------------------------------------------------------------------

export type CliTelemetryRuntime = {
  /** True when receipts must print the disclosure line instead of "nothing uploaded". */
  disclosureActive: boolean;
  finish: (input: {
    argv: readonly string[];
    ok: boolean;
    durationMs: number;
    interactive: boolean;
    version: string;
    fetchImpl?: typeof fetch;
    /** Test override; production writes stdout. */
    printNotice?: (lines: readonly string[]) => void;
  }) => Promise<void>;
};

export async function openCliTelemetry(options: {
  homeDirectory?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
} = {}): Promise<CliTelemetryRuntime> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const filePath = telemetryStateFilePath(options.homeDirectory);
  const read = await readTelemetryState(filePath);
  const envDisabled = telemetryEnvDisabled(env);
  const noticed = read.kind === "ok" && read.state.enabled && typeof read.state.noticedAt === "string";
  const disclosureActive = noticed && !envDisabled;

  return {
    disclosureActive,
    finish: async (input) => {
      try {
        if (envDisabled || read.kind === "unreadable") return;
        if (read.kind === "ok" && !read.state.enabled) return;
        if (noticed && read.kind === "ok") {
          // Events begin only on runs AFTER the notice was stamped.
          const event: TelemetryEvent = {
            installId: read.state.installId,
            command: telemetryCommandForArgv(input.argv),
            version: input.version,
            os: telemetryOsLabel(),
            arch: telemetryArchLabel(),
            ci: Boolean(env.CI),
            durationBucket: telemetryDurationBucket(input.durationMs),
            ok: input.ok,
            ts: now().toISOString()
          };
          const body = serializeTelemetryBatch([event]);
          if (body === undefined) return;
          // The exact payload is cached verbatim BEFORE the send so
          // `aibill telemetry` can always show what left the machine.
          await writeTelemetryState(filePath, { ...read.state, lastPayload: body });
          void postTelemetryBatch(body, {
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
          });
          return;
        }
        // First-notice path: interactive runs only. The notice prints ONLY
        // when the stamp persisted — a user whose state cannot be written
        // is simply never tracked (fail closed), never re-nagged.
        if (!input.interactive) return;
        const stamped: TelemetryState = {
          version: 1,
          installId: read.kind === "ok" ? read.state.installId : randomUUID(),
          enabled: true,
          noticedAt: now().toISOString(),
          ...(read.kind === "ok" && read.state.lastPayload !== undefined
            ? { lastPayload: read.state.lastPayload }
            : {})
        };
        if (!await writeTelemetryState(filePath, stamped)) return;
        const print = input.printNotice ?? ((lines: readonly string[]) => {
          process.stdout.write(`\n${lines.join("\n")}\n`);
        });
        print(telemetryNoticeLines);
      } catch {
        // Telemetry must never break the CLI.
      }
    }
  };
}
