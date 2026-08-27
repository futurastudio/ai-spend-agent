/**
 * The server-side command allowlist, shared by the telemetry INGEST route
 * (which collapses anything unknown to "other" before storing) and the ops
 * health route (which collapses anything unknown to "other" before REPORTING).
 *
 * Both directions matter. Ingest keeps free text out of the database; the
 * report-side pass keeps free text out of the alert payload even if a row
 * reached the table some other way (a manual insert, a future migration, a
 * restored backup). The aggregate-only invariant holds at both boundaries.
 *
 * MUST STAY IN SYNC with `telemetryCommands` in packages/cli/src/telemetry.ts.
 * When the two drift, the CLI's label is stored as "other" and that command's
 * failures become unattributable — which is exactly what happened to `glance`.
 */
export const TELEMETRY_COMMANDS = [
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
  "glance",
  "report",
  "report-card",
  "apply",
  "watch",
  "init",
  "verify",
  "drop-slice",
  "telemetry",
  "other",
] as const;

export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set<string>(TELEMETRY_COMMANDS);

export function isKnownCommand(value: unknown): value is TelemetryCommand {
  return typeof value === "string" && COMMAND_SET.has(value);
}

/** Any value outside the allowlist becomes the literal "other". */
export function normalizeCommand(value: unknown): TelemetryCommand {
  return isKnownCommand(value) ? value : "other";
}
