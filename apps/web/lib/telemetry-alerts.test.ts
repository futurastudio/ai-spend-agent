import { describe, expect, it } from "vitest";
import {
  BASELINE_MIN_EVENTS,
  COMMAND_ERROR_MIN,
  ERROR_RATE_MIN_EVENTS,
  SHORT_WINDOW_MINUTES,
  SILENCE_BASELINE_MINUTES,
  SILENCE_BASELINE_MIN_EVENTS,
  SILENCE_WINDOW_MINUTES,
  evaluateTelemetryAlerts,
  ratePct,
  type TelemetrySnapshot,
} from "./telemetry-alerts";

/** A quiet, healthy fleet: nothing should ever page from this. */
function healthy(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    window: { minutes: SHORT_WINDOW_MINUTES, events: 100, errors: 2 },
    commands: [
      { command: "receipt", runs: 80, errors: 1 },
      { command: "report", runs: 20, errors: 1 },
    ],
    // Mirrors the real pre-launch table: 187 events, 4 errors, ~2.1%.
    baseline: { minutes: 1440, events: 187, errors: 4 },
    silence: {
      minutes: SILENCE_WINDOW_MINUTES,
      events: 40,
      priorMinutes: SILENCE_BASELINE_MINUTES,
      priorEvents: 300,
    },
    ...overrides,
  };
}

function codes(snapshot: TelemetrySnapshot): string[] {
  return evaluateTelemetryAlerts(snapshot).map((alert) => alert.code);
}

describe("ratePct", () => {
  it.each([
    [0, 0, 0],
    [0, 100, 0],
    [1, 3, 33.3],
    [2, 187, 1.1],
    [5, 10, 50],
    [10, 10, 100],
  ])("reports %i of %i as %f%%", (errors, events, expected) => {
    expect(ratePct(errors, events)).toBe(expected);
  });

  it("never returns NaN when there were no runs", () => {
    expect(ratePct(0, 0)).toBe(0);
    expect(ratePct(5, 0)).toBe(0);
  });
});

describe("evaluateTelemetryAlerts — healthy fleet", () => {
  it("stays silent on a normal window", () => {
    expect(evaluateTelemetryAlerts(healthy())).toEqual([]);
  });

  it("stays silent on an all-green window", () => {
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 500, errors: 0 },
          commands: [{ command: "receipt", runs: 500, errors: 0 }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("evaluateTelemetryAlerts — error rate", () => {
  it("does NOT page on 1 error out of 2 runs", () => {
    // The founder's explicit requirement: a 50% error rate at trivial volume
    // is one user with a broken machine, not an outage.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 2, errors: 1 },
          commands: [{ command: "receipt", runs: 2, errors: 1 }],
        }),
      ),
    ).toEqual([]);
  });

  it("stays silent one run below the volume floor even at a 100% error rate", () => {
    // Errors are spread across three commands so none of them trips the
    // per-command check on its own — this isolates the fleet-wide rate.
    const events = ERROR_RATE_MIN_EVENTS - 1;
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events, errors: events },
          commands: [
            { command: "receipt", runs: 7, errors: 7 },
            { command: "report", runs: 6, errors: 6 },
            { command: "init", runs: 6, errors: 6 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("pages once the volume floor is reached and the rate is high", () => {
    expect(
      codes(
        healthy({
          window: {
            minutes: SHORT_WINDOW_MINUTES,
            events: ERROR_RATE_MIN_EVENTS,
            errors: ERROR_RATE_MIN_EVENTS,
          },
          commands: [
            { command: "receipt", runs: ERROR_RATE_MIN_EVENTS, errors: ERROR_RATE_MIN_EVENTS },
          ],
        }),
      ),
    ).toContain("error_rate_high");
  });

  it("stays silent when the rate is elevated but under the absolute floor", () => {
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 100, errors: 20 },
          commands: [{ command: "receipt", runs: 100, errors: 20 }],
        }),
      ),
    ).toEqual([]);
  });

  it("does NOT page when a naturally high baseline already sits above the floor", () => {
    // The `report`-with-no-evidence class: ok:false by design. If 30% of runs
    // legitimately exit 1 every day, an absolute-only threshold would email
    // the founder every morning forever.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 100, errors: 31 },
          baseline: { minutes: 1440, events: 1000, errors: 300 },
          commands: [{ command: "report", runs: 100, errors: 31 }],
        }),
      ),
    ).toEqual([]);
  });

  it("pages when the window beats a high baseline by the margin", () => {
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 100, errors: 46 },
          baseline: { minutes: 1440, events: 1000, errors: 300 },
          commands: [{ command: "report", runs: 100, errors: 46 }],
        }),
      ),
    ).toContain("error_rate_high");
  });

  it("falls back to the absolute floor when there is no trustworthy baseline", () => {
    // Launch morning: no 24h history exists yet, so the relative margin has
    // nothing to compare against and must not block the alert.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 40, errors: 20 },
          baseline: { minutes: 1440, events: BASELINE_MIN_EVENTS - 1, errors: 0 },
          commands: [{ command: "receipt", runs: 40, errors: 20 }],
        }),
      ),
    ).toContain("error_rate_high");
  });

  it("puts both the window and the baseline numbers in the alert text", () => {
    const [alert] = evaluateTelemetryAlerts(
      healthy({
        window: { minutes: SHORT_WINDOW_MINUTES, events: 40, errors: 20 },
        commands: [{ command: "receipt", runs: 40, errors: 20 }],
      }),
    );
    expect(alert.code).toBe("error_rate_high");
    expect(alert.detail).toContain("50% of runs failed in the last 60m");
    expect(alert.detail).toContain("20 of 40");
    expect(alert.detail).toContain("24h baseline is 2.1%");
  });
});

describe("evaluateTelemetryAlerts — a single command on fire", () => {
  it("pages when one command fails hard even though the fleet rate looks fine", () => {
    // 990 healthy `receipt` runs mask a totally broken `improve`. The
    // fleet-wide rate is 1%, so only the per-command check can catch this.
    const snapshot = healthy({
      window: { minutes: SHORT_WINDOW_MINUTES, events: 1000, errors: 10 },
      commands: [
        { command: "receipt", runs: 990, errors: 0 },
        { command: "improve", runs: 10, errors: 10 },
      ],
    });
    const alerts = evaluateTelemetryAlerts(snapshot);
    expect(alerts.map((a) => a.code)).toEqual(["command_failing"]);
    expect(alerts[0].detail).toContain('"improve" failed 10 of its 10 runs');
  });

  it("stays silent one failure below the absolute minimum", () => {
    const errors = COMMAND_ERROR_MIN - 1;
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 1000, errors },
          commands: [
            { command: "receipt", runs: 1000 - errors, errors: 0 },
            { command: "improve", runs: errors, errors },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("stays silent when a busy command has many failures but a low share", () => {
    // 40 failures is a lot in absolute terms, but 40 of 1000 runs (4%) is a
    // long tail of legitimate exit-1s, not a broken command.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 1000, errors: 40 },
          commands: [{ command: "receipt", runs: 1000, errors: 40 }],
        }),
      ),
    ).toEqual([]);
  });

  it("reports the worst offender first when several commands are failing", () => {
    const alerts = evaluateTelemetryAlerts(
      healthy({
        window: { minutes: SHORT_WINDOW_MINUTES, events: 1000, errors: 38 },
        commands: [
          { command: "receipt", runs: 962, errors: 0 },
          { command: "improve", runs: 10, errors: 10 },
          { command: "glance", runs: 28, errors: 28 },
        ],
      }),
    );
    expect(alerts.map((a) => a.code)).toEqual(["command_failing", "command_failing"]);
    expect(alerts[0].detail).toContain('"glance"');
    expect(alerts[1].detail).toContain('"improve"');
  });
});

describe("evaluateTelemetryAlerts — silence", () => {
  it("pages when a previously busy fleet goes completely silent", () => {
    const alerts = evaluateTelemetryAlerts(
      healthy({
        window: { minutes: SHORT_WINDOW_MINUTES, events: 0, errors: 0 },
        commands: [],
        silence: {
          minutes: SILENCE_WINDOW_MINUTES,
          events: 0,
          priorMinutes: SILENCE_BASELINE_MINUTES,
          priorEvents: SILENCE_BASELINE_MIN_EVENTS,
        },
      }),
    );
    expect(alerts.map((a) => a.code)).toEqual(["telemetry_silent"]);
    expect(alerts[0].detail).toContain("Zero telemetry events in the last 180m");
    expect(alerts[0].detail).toContain("in the preceding 48h");
  });

  it("stays silent when the fleet was never busy enough to judge", () => {
    // A brand-new project with almost no installs must not page just because
    // nobody happened to run it for three hours.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 0, errors: 0 },
          commands: [],
          silence: {
            minutes: SILENCE_WINDOW_MINUTES,
            events: 0,
            priorMinutes: SILENCE_BASELINE_MINUTES,
            priorEvents: SILENCE_BASELINE_MIN_EVENTS - 1,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("stays silent while even one event is still arriving", () => {
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 0, errors: 0 },
          commands: [],
          silence: {
            minutes: SILENCE_WINDOW_MINUTES,
            events: 1,
            priorMinutes: SILENCE_BASELINE_MINUTES,
            priorEvents: 5000,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("still pages after a long outage, because the baseline excludes the silence", () => {
    // Regression guard for the classic self-silencing bug: if the baseline
    // window included the silent stretch, a sustained outage would drag its
    // own baseline to zero and the alert would switch itself off.
    expect(
      codes(
        healthy({
          window: { minutes: SHORT_WINDOW_MINUTES, events: 0, errors: 0 },
          commands: [],
          silence: {
            minutes: SILENCE_WINDOW_MINUTES,
            events: 0,
            priorMinutes: SILENCE_BASELINE_MINUTES,
            priorEvents: 400,
          },
        }),
      ),
    ).toContain("telemetry_silent");
  });
});
