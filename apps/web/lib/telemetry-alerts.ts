import type { TelemetryCommand } from "./telemetry-commands";

/**
 * Threshold logic for the launch-week error alerts.
 *
 * Deliberately a PURE function over already-counted numbers: the endpoint does
 * the I/O, this does the judgement, and the judgement is unit-tested without a
 * database. Tuning a threshold is a one-line change with a test next to it.
 *
 * The bar every threshold has to clear: it must be worth waking the founder at
 * 6am on launch day. A false page trains him to ignore the next one, which is
 * strictly worse than no alerting at all.
 */

// ---------------------------------------------------------------------------
// Thresholds. Calibrated against the real pre-launch table (187 events over
// ~44h, 4 errors = 2.1% baseline error rate, ~4 events/hour).
// ---------------------------------------------------------------------------

/** Rolling window for the error-rate and per-command checks. */
export const SHORT_WINDOW_MINUTES = 60;

/**
 * VOLUME FLOOR. Below this many runs in the window we say nothing at all.
 * This is the "1 error out of 2 runs must not page" rule: at tiny volume the
 * error RATE is noise — a single user with a broken PATH would read as a 50%
 * outage. 20 runs/hour is roughly 5x the pre-launch baseline, so this check is
 * intentionally dormant until launch traffic actually arrives.
 */
export const ERROR_RATE_MIN_EVENTS = 20;

/**
 * ABSOLUTE FLOOR. Never page below this rate no matter what the baseline says,
 * so a freak-quiet baseline (say 0 errors in 24h) cannot make a 3% blip look
 * like a regression. 25% is ~12x the observed 2.1% baseline.
 */
export const ERROR_RATE_ABS_PCT = 25;

/**
 * RELATIVE MARGIN. The window must also beat the 24h baseline by this many
 * percentage points. This is the important one: some ok:false results are
 * BY DESIGN (`report` with no evidence exits 1 and is an honest empty result,
 * not a bug). If that pushes the true baseline to, say, 30%, an absolute-only
 * threshold of 25% would page every single morning. Requiring baseline+15
 * makes the alert mean "worse than normal", not "nonzero".
 */
export const ERROR_RATE_MARGIN_PCT = 15;

/**
 * Below this many baseline events the baseline itself is noise, so the
 * relative margin is skipped and the absolute floor decides alone. On launch
 * morning there is no meaningful 24h history — this is that case.
 */
export const BASELINE_MIN_EVENTS = 50;

/**
 * A SINGLE COMMAND ON FIRE. Absolute count first: 8 failures of one command
 * inside an hour is a real defect, whatever the fleet-wide rate says. This is
 * the check that survives a launch where most traffic is one popular command
 * masking a second command that is 100% broken.
 */
export const COMMAND_ERROR_MIN = 8;

/**
 * ...and that command must be failing at least half of ITS OWN runs, so a
 * high-volume command with a long tail of legitimate exit-1s does not page.
 */
export const COMMAND_ERROR_SHARE_PCT = 50;

/**
 * SILENCE WINDOW. The endpoint-down signature is not errors, it is NOTHING:
 * if /api/telemetry starts 5xx-ing or Supabase rejects the service key, the
 * CLI fires-and-forgets and drops the event, so the table simply stops
 * growing. No error rate can ever detect that — only absence can.
 *
 * 180 minutes = six consecutive 30-minute alert runs of total silence before
 * anyone is woken. Long enough that an ordinary quiet stretch is not a page.
 */
export const SILENCE_WINDOW_MINUTES = 180;

/**
 * ...but only when the fleet was demonstrably alive beforehand. Measured over
 * the 48h ENDING WHERE THE SILENT WINDOW BEGINS, never over a window that
 * includes the silence itself. If the baseline included the silent stretch, a
 * long outage would drag its own baseline to zero and the alert would
 * self-silence exactly when it mattered most. 60 events over 48h is ~1.25/hour,
 * against which 3 hours of absolute zero is a genuine signal.
 */
export const SILENCE_BASELINE_MINUTES = 48 * 60;
export const SILENCE_BASELINE_MIN_EVENTS = 60;

// ---------------------------------------------------------------------------

export type CommandCount = {
  command: TelemetryCommand;
  runs: number;
  errors: number;
};

export type TelemetrySnapshot = {
  /** Rolling short window: every run and every failure inside it. */
  window: { minutes: number; events: number; errors: number };
  /** Per-command split of the same short window. */
  commands: CommandCount[];
  /** 24h context, used only to decide what "normal" looks like. */
  baseline: { minutes: number; events: number; errors: number };
  /** Silence check: recent events, and events in the period before it. */
  silence: {
    minutes: number;
    events: number;
    priorMinutes: number;
    priorEvents: number;
  };
};

export type AlertCode =
  | "error_rate_high"
  | "command_failing"
  | "telemetry_silent";

export type Alert = {
  code: AlertCode;
  /**
   * Human sentence for the failure email. Built ONLY from numbers and
   * allowlisted command labels — never from stored strings — so the
   * aggregate-only invariant survives all the way into the alert text.
   */
  detail: string;
};

/** Error percentage, one decimal. 0 events reads as 0, never NaN. */
export function ratePct(errors: number, events: number): number {
  if (events <= 0) return 0;
  return Math.round((errors / events) * 1000) / 10;
}

export function evaluateTelemetryAlerts(snapshot: TelemetrySnapshot): Alert[] {
  const alerts: Alert[] = [];
  const { window, commands, baseline, silence } = snapshot;

  // 1) Fleet-wide error rate, gated by volume, an absolute floor, and (when
  //    there is enough history to trust it) a margin over normal.
  const windowRate = ratePct(window.errors, window.events);
  const baselineRate = ratePct(baseline.errors, baseline.events);
  const baselineIsTrustworthy = baseline.events >= BASELINE_MIN_EVENTS;
  const beatsBaseline =
    !baselineIsTrustworthy || windowRate >= baselineRate + ERROR_RATE_MARGIN_PCT;
  if (
    window.events >= ERROR_RATE_MIN_EVENTS &&
    windowRate >= ERROR_RATE_ABS_PCT &&
    beatsBaseline
  ) {
    alerts.push({
      code: "error_rate_high",
      detail:
        `${windowRate}% of runs failed in the last ${window.minutes}m ` +
        `(${window.errors} of ${window.events}). ` +
        `24h baseline is ${baselineRate}% ` +
        `(${baseline.errors} of ${baseline.events}).`,
    });
  }

  // 2) One command failing hard, even if the fleet-wide rate looks fine.
  //    Worst offender first so the email leads with the biggest fire.
  const failing = commands
    .filter(
      (entry) =>
        entry.errors >= COMMAND_ERROR_MIN &&
        ratePct(entry.errors, entry.runs) >= COMMAND_ERROR_SHARE_PCT,
    )
    .sort((a, b) => b.errors - a.errors);
  for (const entry of failing) {
    alerts.push({
      code: "command_failing",
      detail:
        `"${entry.command}" failed ${entry.errors} of its ${entry.runs} runs ` +
        `in the last ${window.minutes}m ` +
        `(${ratePct(entry.errors, entry.runs)}%).`,
    });
  }

  // 3) Silence where there used to be traffic — the endpoint-down signature.
  if (
    silence.events === 0 &&
    silence.priorEvents >= SILENCE_BASELINE_MIN_EVENTS
  ) {
    alerts.push({
      code: "telemetry_silent",
      detail:
        `Zero telemetry events in the last ${silence.minutes}m, after ` +
        `${silence.priorEvents} events in the preceding ` +
        `${Math.round(silence.priorMinutes / 60)}h. ` +
        `Ingest or storage is likely down — errors would still be counted, ` +
        `silence means nothing is arriving at all.`,
    });
  }

  return alerts;
}
