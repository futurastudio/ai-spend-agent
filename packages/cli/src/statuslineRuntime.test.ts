import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { activitySnapshotSchema } from "@agent-finops/core";
import {
  drainStatuslineStdin,
  readStatuslineCache,
  renderStatusline,
  runStatuslineHook,
  type StatuslineSnapshot
} from "./statuslineRuntime.js";

const NOW = new Date("2026-08-09T18:00:12.000Z");
const CAPTURED_AT = "2026-08-09T18:00:00.000Z";

function apiWindow(amountUsd: number | null, recordCount = amountUsd === null ? 0 : 1) {
  return {
    amountUsd,
    recordCount,
    basis: "api_equivalent" as const,
    financialEvidence: amountUsd === null ? "missing" as const : "estimated" as const,
    coverage: amountUsd === null ? "missing" as const : "complete" as const
  };
}

function billedWindow(amountUsd: number | null, recordCount = amountUsd === null ? 0 : 1) {
  return {
    amountUsd,
    recordCount,
    basis: "provider_billed" as const,
    financialEvidence: amountUsd === null ? "missing" as const : "verified" as const,
    coverage: amountUsd === null ? "missing" as const : "complete" as const
  };
}

function windows<T>(oneDay: T, sevenDays: T, thirtyDays: T) {
  return { oneDay, sevenDays, thirtyDays };
}

function snapshot(mode: StatuslineSnapshot["mode"]): StatuslineSnapshot {
  const base: StatuslineSnapshot = {
    kind: "aibill.activity_snapshot",
    schemaVersion: 1,
    currency: "USD",
    asOf: CAPTURED_AT,
    generatedAt: CAPTURED_AT,
    lastAttemptAt: CAPTURED_AT,
    lastSuccessAt: CAPTURED_AT,
    refresh: { status: "ok" },
    mode,
    subscription: null,
    metered: null,
    unresolved: null,
    overage: null,
    coverage: {
      agents: [],
      providers: [],
      recordsParsed: 0,
      recordsPriced: 0,
      recordsUnpriced: 0,
      validationStatus: "complete",
      pricingAsOf: "2026-08-01",
      networkUploaded: false
    },
    networkUploaded: false
  };
  if (mode === "metered" || mode === "mixed") {
    base.metered = {
      agents: [{ agent: "claude-code", billing: "api_key", planId: null }],
      apiEquivalent: windows(apiWindow(1.24), apiWindow(8.5), apiWindow(32.1)),
      providerBilled: windows(billedWindow(null), billedWindow(null), billedWindow(null))
    };
  }
  if (mode === "subscription" || mode === "mixed") {
    base.subscription = {
      agents: [{
        agent: "codex",
        billing: "subscription",
        planId: "chatgpt-pro",
        apiEquivalent: windows(apiWindow(1.2), apiWindow(8.5), apiWindow(30)),
        limits: [
          {
            kind: "five-hour",
            usedPercent: 71,
            remainingPercent: 29,
            observedAt: "2026-08-09T17:00:00.000Z",
            resetsAt: "2026-08-09T20:10:00.000Z",
            source: "transcript_reported"
          },
          {
            kind: "weekly",
            usedPercent: 43,
            remainingPercent: 57,
            observedAt: "2026-08-09T17:00:00.000Z",
            resetsAt: "2026-08-10T18:00:00.000Z",
            source: "transcript_reported"
          }
        ],
        pressure: null
      }]
    };
  }
  if (mode === "unresolved") {
    base.unresolved = {
      agents: [{ agent: "codex", billing: "unknown", planId: null }],
      apiEquivalent: windows(apiWindow(1), apiWindow(6.25), apiWindow(20))
    };
  }
  if (mode === "error") {
    base.lastSuccessAt = null;
    base.refresh = { status: "error", errorCode: "scan_failed" };
  }
  return base;
}

function dualSubscriptionSnapshot(
  mode: "subscription" | "mixed" = "subscription",
  order: "codex-first" | "claude-first" = "codex-first"
): StatuslineSnapshot {
  const value = snapshot(mode);
  const codex = value.subscription!.agents[0]!;
  codex.limits = [{
    kind: "weekly",
    usedPercent: 0,
    remainingPercent: 100,
    observedAt: "2026-08-09T17:30:00.000Z",
    resetsAt: "2026-08-10T18:00:00.000Z",
    source: "transcript_reported"
  }];
  const claude = structuredClone(codex);
  claude.agent = "claude-code";
  claude.planId = "claude-max-5x";
  claude.apiEquivalent.sevenDays = apiWindow(99);
  claude.limits = [{
    kind: "weekly",
    usedPercent: 63,
    remainingPercent: 37,
    observedAt: "2026-08-09T16:00:00.000Z",
    resetsAt: "2026-08-15T18:00:00.000Z",
    source: "transcript_reported"
  }];
  value.subscription!.agents = order === "codex-first" ? [codex, claude] : [claude, codex];
  if (value.metered) value.metered.agents = [];
  return value;
}

function expectEveryMultiSubscriptionFigureAttributed(line: string): void {
  for (const segment of line.split(" · ")) {
    if (segment.includes("%") || /(?:\s|\/)7d value$/.test(segment)) {
      expect(segment).toMatch(/^(?:claude|codex) /);
    }
  }
}

function ok(value: StatuslineSnapshot) {
  return { status: "ok" as const, snapshot: value };
}

describe("standalone status-line renderer", () => {
  it("renders estimated metered windows with tilde semantics", () => {
    expect(renderStatusline(ok(snapshot("metered")), {
      now: NOW,
      columns: 120,
      timeZone: "UTC"
    })).toBe("aibill · ~$1.24 1d · ~$8.50 7d · ~$32.10 30d · updated 12s");
  });

  it("renders verified provider billing without a tilde and never adds unlike bases", () => {
    const value = snapshot("metered");
    value.metered!.providerBilled.sevenDays = billedWindow(6.75);
    const line = renderStatusline(ok(value), { now: NOW, columns: 120 });
    expect(line).toContain("$6.75 7d billed");
    expect(line).not.toContain("~$8.50 7d");
    expect(line).not.toContain("$15.25");
  });

  it("never rounds or compacts verified billed amounts into a different claim", () => {
    for (const [amount, expected] of [
      [123.49, "$123.49"],
      [1_234.56, "$1,234.56"],
      [0.001, "$0.001"]
    ] as const) {
      const value = snapshot("metered");
      value.metered!.providerBilled.sevenDays = billedWindow(amount);
      const line = renderStatusline(ok(value), { now: NOW, columns: 200 });
      expect(line).toContain(`${expected} 7d billed`);
    }
  });

  it("leads subscription mode with transcript-reported runway and labels value", () => {
    expect(renderStatusline(ok(snapshot("subscription")), {
      now: NOW,
      columns: 140,
      timeZone: "UTC"
    })).toBe(
      "aibill · 5h 29% left ↻8:10pm · week 57% left ↻Mon · ~$8.50 7d value · updated 12s"
    );
  });

  it("states that runway is not reported instead of inferring it", () => {
    const value = snapshot("subscription");
    value.subscription!.agents[0]!.limits = [];
    const line = renderStatusline(ok(value), { now: NOW, columns: 140 });
    expect(line).toContain("subscription detected · runway not reported");
    expect(line).toContain("~$8.50 7d value");
    expect(line).not.toMatch(/% left/);
  });

  it("labels old transcript percentages as stale even when the cache was just refreshed", () => {
    const value = snapshot("subscription");
    value.subscription!.agents[0]!.limits = [{
      kind: "weekly",
      usedPercent: 25,
      remainingPercent: 75,
      observedAt: "2026-08-05T18:00:00.000Z",
      resetsAt: "2026-08-16T18:00:00.000Z",
      source: "transcript_reported"
    }];
    const line = renderStatusline(ok(value), { now: NOW, columns: 140, timeZone: "UTC" });
    expect(line).toContain("subscription detected · runway stale");
    expect(line).toContain("updated 12s");
    expect(line).not.toContain("75%");
  });

  it("rejects future limit observations as stale instead of treating them as live runway", () => {
    const value = snapshot("subscription");
    value.subscription!.agents[0]!.limits = [{
      kind: "five-hour",
      usedPercent: 71,
      remainingPercent: 29,
      observedAt: "2026-08-09T18:00:13.000Z",
      resetsAt: "2026-08-09T20:00:00.000Z",
      source: "transcript_reported"
    }];
    const line = renderStatusline(ok(value), { now: NOW, columns: 140, timeZone: "UTC" });
    expect(line).toContain("runway stale");
    expect(line).not.toContain("29%");
  });

  it("renders five-hour-only and weekly-only runway without inventing the other window", () => {
    const fiveHour = snapshot("subscription");
    fiveHour.subscription!.agents[0]!.limits = [fiveHour.subscription!.agents[0]!.limits[0]!];
    const fiveHourLine = renderStatusline(ok(fiveHour), { now: NOW, columns: 120, timeZone: "UTC" });
    expect(fiveHourLine).toContain("5h 29% left");
    expect(fiveHourLine).not.toContain("week ");

    const weekly = snapshot("subscription");
    weekly.subscription!.agents[0]!.limits = [weekly.subscription!.agents[0]!.limits[1]!];
    const weeklyLine = renderStatusline(ok(weekly), { now: NOW, columns: 120, timeZone: "UTC" });
    expect(weeklyLine).toContain("week 57% left");
    expect(weeklyLine).not.toContain("5h ");
  });

  it("keeps subscription and metered cohorts visibly separate in mixed mode", () => {
    const line = renderStatusline(ok(snapshot("mixed")), {
      now: NOW,
      columns: 160,
      timeZone: "UTC"
    });
    expect(line).toContain("metered ~$8.50 7d");
    expect(line).toContain("sub ~$8.50 7d value");
    expect(line).not.toContain("~$17.00");
  });

  it("keeps the most urgent reported runway in compact mixed mode", () => {
    const line = renderStatusline(ok(snapshot("mixed")), {
      now: NOW,
      columns: 79,
      timeZone: "UTC"
    });
    expect(line).toContain("5h 29% left");
    expect(line).not.toContain("week 57% left");
    expect([...line].length).toBeLessThanOrEqual(79);
    expect(line).toContain("metered ~$8.50/7d");
  });

  it("keeps mixed mode and metered meaning at exact width boundaries", () => {
    for (const columns of [80, 79, 50]) {
      const line = renderStatusline(ok(snapshot("mixed")), {
        now: NOW, columns, timeZone: "UTC"
      });
      expect([...line].length).toBeLessThanOrEqual(columns);
      expect(line).toContain("mix");
      expect(line).toContain("metered ~$8.50/7d");
      expect(line).toMatch(/5h 29% left/);
    }
  });

  it("labels unresolved billing without guessing a plan", () => {
    const line = renderStatusline(ok(snapshot("unresolved")), { now: NOW, columns: 100 });
    expect(line).toBe("aibill · billing unresolved · ~$6.25 7d API-equivalent · updated 12s");
  });

  it("shows the paid-alert bridge only for a verified billed overage", () => {
    const overage = snapshot("mixed");
    overage.overage = {
      amountUsd: 18,
      currency: "USD",
      basis: "provider_billed",
      financialEvidence: "verified",
      alertEligible: true,
      recordCount: 1
    };
    expect(renderStatusline(ok(overage), { now: NOW, columns: 200, timeZone: "UTC" }))
      .toMatch(/sub ~\$8\.50 7d value · OVERAGE \$18\.00 billed · updated 12s$/);
    expect(renderStatusline(ok(overage), { now: NOW, columns: 58, timeZone: "UTC" }))
      .toContain("OVERAGE $18.00 billed");

    for (const [amount, expected] of [[123.49, "$123.49"], [1_234.56, "$1,234.56"], [0.001, "$0.001"]] as const) {
      overage.overage.amountUsd = amount;
      expect(renderStatusline(ok(overage), { now: NOW, columns: 200, timeZone: "UTC" }))
        .toContain(`OVERAGE ${expected} billed`);
    }
    overage.overage.amountUsd = 18;
    expect(renderStatusline(ok(overage), { now: NOW, columns: 24, timeZone: "UTC" }))
      .toContain("OVERAGE $18.00 billed");
    const ten = renderStatusline(ok(overage), { now: NOW, columns: 10, timeZone: "UTC" });
    expect([...ten].length).toBeLessThanOrEqual(10);
    expect(ten).toContain("billed");

    const pressure = snapshot("subscription");
    pressure.subscription!.agents[0]!.pressure = "extra_usage_credits_exhausted";
    const line = renderStatusline(ok(pressure), { now: NOW, columns: 120 });
    expect(line).toContain("plan pressure");
    expect(line).not.toContain("OVERAGE");
    expect(line).not.toContain("billed");
  });

  it("uses the exact freshness vocabulary at the five-minute boundary", () => {
    const value = snapshot("metered");
    expect(renderStatusline(ok(value), {
      now: new Date("2026-08-09T18:05:00.000Z"), columns: 120
    })).toContain("updated 5m");
    expect(renderStatusline(ok(value), {
      now: new Date("2026-08-09T18:05:00.001Z"), columns: 120
    })).toContain("stale 5m");
  });

  it("reports a future cache timestamp as a clock mismatch", () => {
    expect(renderStatusline(ok(snapshot("metered")), {
      now: new Date("2026-08-09T17:59:59.000Z"), columns: 120
    })).toContain("clock mismatch");
  });

  it("retains last-good values and reports the failed refresh age", () => {
    const value = snapshot("metered");
    value.refresh = { status: "error", errorCode: "timeout" };
    value.lastAttemptAt = "2026-08-09T17:42:00.000Z";
    value.lastSuccessAt = "2026-08-09T17:00:00.000Z";
    value.generatedAt = "2026-08-09T17:00:00.000Z";
    const line = renderStatusline(ok(value), { now: NOW, columns: 120 });
    expect(line).toContain("~$1.24 1d");
    expect(line).toContain("update error 18m");
  });

  it("renders honest empty, initial-error, missing, and malformed states", () => {
    expect(renderStatusline(ok(snapshot("empty")), { now: NOW, columns: 100 }))
      .toBe("aibill · no usage yet · updated 12s");
    expect(renderStatusline(ok(snapshot("error")), { now: NOW, columns: 100 }))
      .toBe("aibill · update error 12s · run aibill init");
    expect(renderStatusline({ status: "missing" }, { now: NOW, columns: 100 }))
      .toBe("aibill · run aibill init");
    expect(renderStatusline({ status: "error" }, { now: NOW, columns: 100 }))
      .toBe("aibill · cache error · run aibill init");
  });

  it("omits expired limits at and after the exact reset boundary", () => {
    const value = snapshot("subscription");
    value.subscription!.agents[0]!.limits[0]!.resetsAt = NOW.toISOString();
    const line = renderStatusline(ok(value), { now: NOW, columns: 140, timeZone: "UTC" });
    expect(line).not.toContain("5h");
    expect(line).toContain("week 57% left");
  });

  it("formats reset times in the user's local timezone", () => {
    const line = renderStatusline(ok(snapshot("subscription")), {
      now: NOW,
      columns: 140,
      timeZone: "America/New_York"
    });
    expect(line).toContain("5h 29% left ↻4:10pm");
  });

  it("labels both subscribed agents and orders runway by urgency, not recency or cache order", () => {
    const codexFirst = renderStatusline(ok(dualSubscriptionSnapshot("subscription", "codex-first")), {
      now: NOW, columns: 240, timeZone: "UTC"
    });
    const claudeFirst = renderStatusline(ok(dualSubscriptionSnapshot("subscription", "claude-first")), {
      now: NOW, columns: 240, timeZone: "UTC"
    });
    expect(codexFirst).toBe(claudeFirst);
    expect(codexFirst).toBe(
      "aibill · claude week 37% ↻Sat · codex week 100% ↻Mon · " +
      "claude ~$99.00 7d value · codex ~$8.50 7d value · updated 12s"
    );
    expect(codexFirst.indexOf("claude week 37%")).toBeLessThan(codexFirst.indexOf("codex week 100%"));
    expectEveryMultiSubscriptionFigureAttributed(codexFirst);
  });

  it("preserves a positive sub-cent value in attributed multi-agent output", () => {
    const value = dualSubscriptionSnapshot();
    value.subscription!.agents.find(({ agent }) => agent === "codex")!
      .apiEquivalent.sevenDays = apiWindow(0.001);
    const line = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });

    expect(line).toContain("codex ~<$0.01 7d value");
    expect(line).not.toContain("codex ~$0.00 7d value");
    expectEveryMultiSubscriptionFigureAttributed(line);
  });

  it("shows both labeled windows when compact width permits and keeps only the most urgent when it does not", () => {
    const value = dualSubscriptionSnapshot();
    expect(renderStatusline(ok(value), { now: NOW, columns: 79, timeZone: "UTC" })).toBe(
      "aibill · claude wk 37% · codex wk 100% · updated 12s"
    );
    expect(renderStatusline(ok(value), { now: NOW, columns: 50, timeZone: "UTC" })).toBe(
      "aibill · claude wk 37% · updated 12s"
    );
  });

  it("keeps multi-subscription windows and values attributed in mixed mode", () => {
    const lines: string[] = [];
    for (const order of ["codex-first", "claude-first"] as const) {
      const line = renderStatusline(ok(dualSubscriptionSnapshot("mixed", order)), {
        now: NOW, columns: 240, timeZone: "UTC"
      });
      lines.push(line);
      expect(line).toContain("claude week 37% ↻Sat");
      expect(line).toContain("codex week 100% ↻Mon");
      expect(line).toContain("claude ~$99.00 7d value");
      expect(line).toContain("codex ~$8.50 7d value");
      expect(line).toContain("metered ~$8.50 7d");
      expectEveryMultiSubscriptionFigureAttributed(line);
    }
    expect(lines[0]).toBe(lines[1]);
  });

  it("globally orders every displayed multi-agent window by urgency", () => {
    const value = dualSubscriptionSnapshot();
    const codex = value.subscription!.agents.find(({ agent }) => agent === "codex")!;
    const claude = value.subscription!.agents.find(({ agent }) => agent === "claude-code")!;
    codex.limits.unshift({
      kind: "five-hour", usedPercent: 80, remainingPercent: 20,
      observedAt: "2026-08-09T17:30:00.000Z", resetsAt: "2026-08-09T20:00:00.000Z",
      source: "transcript_reported"
    });
    claude.limits.unshift({
      kind: "five-hour", usedPercent: 90, remainingPercent: 10,
      observedAt: "2026-08-09T16:00:00.000Z", resetsAt: "2026-08-09T19:00:00.000Z",
      source: "transcript_reported"
    });
    const line = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });
    const ordered = ["claude 5h 10%", "codex 5h 20%", "claude week 37%", "codex week 100%"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(line.indexOf(ordered[index - 1]!)).toBeLessThan(line.indexOf(ordered[index]!));
    }
    expectEveryMultiSubscriptionFigureAttributed(line);
  });

  it("preserves labeled urgent runway alongside verified overage when width permits", () => {
    const value = dualSubscriptionSnapshot("mixed");
    value.overage = {
      amountUsd: 18,
      currency: "USD",
      basis: "provider_billed",
      financialEvidence: "verified",
      alertEligible: true,
      recordCount: 1
    };
    const wide = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });
    expect(wide).toContain("claude week 37% ↻Sat");
    expect(wide).toContain("codex week 100% ↻Mon");
    expect(wide).toContain("OVERAGE $18.00 billed");
    expectEveryMultiSubscriptionFigureAttributed(wide);
    expect(renderStatusline(ok(value), { now: NOW, columns: 80, timeZone: "UTC" })).toBe(
      "aibill · claude wk 37% · codex wk 100% · OVERAGE $18.00 billed · updated 12s"
    );
    expect(renderStatusline(ok(value), { now: NOW, columns: 60, timeZone: "UTC" })).toBe(
      "aibill · claude wk 37% · OVERAGE $18.00 billed · updated 12s"
    );
    expect(renderStatusline(ok(value), { now: NOW, columns: 24, timeZone: "UTC" }))
      .toContain("OVERAGE $18.00 billed");
  });

  it("never emits an unlabeled multi-subscription figure across width degradation", () => {
    for (const mode of ["subscription", "mixed"] as const) {
      for (const columns of [240, 200, 140, 80, 79, 52, 51, 50, 49, 36, 35, 24, 23, 10, 1]) {
        const line = renderStatusline(ok(dualSubscriptionSnapshot(mode)), {
          now: NOW, columns, timeZone: "UTC"
        });
        expect([...line].length).toBeLessThanOrEqual(columns);
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u001b]/);
        expect(line.split("\n")).toHaveLength(1);
        expectEveryMultiSubscriptionFigureAttributed(line);
        if (line.includes("%") && !line.includes("codex wk 100%") &&
            !line.includes("codex week 100%")) {
          expect(line).toContain("claude");
          expect(line).toContain("37%");
        }
      }
    }
  });

  it("uses the multi-agent labeling rule even when one subscribed agent has no active window", () => {
    const value = dualSubscriptionSnapshot();
    value.subscription!.agents.find(({ agent }) => agent === "codex")!.limits[0]!.resetsAt = NOW.toISOString();
    const line = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });
    expect(line).toContain("claude week 37% ↻Sat");
    expect(line).not.toContain("week 100%");
    expect(line).toContain("claude ~$99.00 7d value");
    expect(line).toContain("codex ~$8.50 7d value");
    expectEveryMultiSubscriptionFigureAttributed(line);
  });

  it("labels a stale subscribed agent without rendering its old percentage", () => {
    const value = dualSubscriptionSnapshot();
    const codex = value.subscription!.agents.find(({ agent }) => agent === "codex")!;
    codex.limits[0]!.observedAt = "2026-08-05T18:00:00.000Z";
    codex.limits[0]!.resetsAt = "2026-08-16T18:00:00.000Z";
    const line = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });
    expect(line).toContain("claude week 37% ↻Sat");
    expect(line).toContain("codex runway stale");
    expect(line).not.toContain("codex week 100%");
    expectEveryMultiSubscriptionFigureAttributed(line);
  });

  it("keeps stale-agent labeling in mixed mode and across narrow degradation", () => {
    const value = dualSubscriptionSnapshot("mixed");
    const codex = value.subscription!.agents.find(({ agent }) => agent === "codex")!;
    codex.limits[0]!.observedAt = "2026-08-05T18:00:00.000Z";
    codex.limits[0]!.resetsAt = "2026-08-16T18:00:00.000Z";
    const wide = renderStatusline(ok(value), { now: NOW, columns: 240, timeZone: "UTC" });
    expect(wide).toContain("codex runway stale");
    expect(wide).not.toContain("codex week 100%");

    for (const agent of value.subscription!.agents) {
      for (const limit of agent.limits) {
        limit.observedAt = "2026-08-05T18:00:00.000Z";
        limit.resetsAt = "2026-08-16T18:00:00.000Z";
      }
    }
    for (const columns of [79, 50, 49, 36]) {
      const line = renderStatusline(ok(value), { now: NOW, columns, timeZone: "UTC" });
      expect(line).not.toMatch(/\d+(?:\.\d+)?%/);
      if (line.includes("runway")) expect(line).toContain("runway stale");
    }
  });

  it("reports missing runway when neither subscribed agent has an active window", () => {
    for (const mode of ["subscription", "mixed"] as const) {
      const value = dualSubscriptionSnapshot(mode);
      for (const agent of value.subscription!.agents) agent.limits = [];
      const line = renderStatusline(ok(value), { now: NOW, columns: 79, timeZone: "UTC" });
      expect(line).toContain("runway not reported");
      expectEveryMultiSubscriptionFigureAttributed(line);
    }
  });

  it("keeps an explicit no-runway state at the compact boundary", () => {
    const subscription = dualSubscriptionSnapshot();
    for (const agent of subscription.subscription!.agents) agent.limits = [];
    expect(renderStatusline(ok(subscription), { now: NOW, columns: 50, timeZone: "UTC" })).toBe(
      "aibill · runway n/r · updated 12s"
    );

    const mixed = dualSubscriptionSnapshot("mixed");
    for (const agent of mixed.subscription!.agents) agent.limits = [];
    expect(renderStatusline(ok(mixed), { now: NOW, columns: 50, timeZone: "UTC" })).toBe(
      "mix · runway n/r · metered ~$8.50/7d · upd 12s"
    );
  });

  it("bounds full, compact, and minimal layouts without control sequences", () => {
    const value = snapshot("mixed");
    value.metered!.apiEquivalent.sevenDays = apiWindow(Number.MAX_VALUE);
    for (const columns of [120, 80, 79, 50, 49, 24, 23, 10, 1]) {
      const line = renderStatusline(ok(value), { now: NOW, columns, timeZone: "UTC" });
      expect([...line].length).toBeLessThanOrEqual(columns);
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u001b]/);
      expect(line.split("\n")).toHaveLength(1);
    }
  });
});

describe("standalone status-line cache reader", () => {
  async function cacheDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-"));
    await chmod(directory, 0o700);
    return directory;
  }

  async function put(directory: string, value: unknown): Promise<void> {
    const path = join(directory, "statusline-v1.json");
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  it("reads a valid strict v1 cache", async () => {
    const directory = await cacheDirectory();
    await put(directory, snapshot("subscription"));
    const result = await readStatuslineCache({ cacheDirectory: directory });
    expect(result.status).toBe("ok");
    expect(renderStatusline(result, { now: NOW, columns: 100, timeZone: "UTC" }))
      .toContain("5h 29% left");
  });

  it("reads and attributes both subscribed agents through the strict cache path", async () => {
    const directory = await cacheDirectory();
    await put(directory, dualSubscriptionSnapshot());
    const result = await readStatuslineCache({ cacheDirectory: directory });
    expect(result.status).toBe("ok");
    const line = renderStatusline(result, { now: NOW, columns: 79, timeZone: "UTC" });
    expect(line).toBe("aibill · claude wk 37% · codex wk 100% · updated 12s");
    expectEveryMultiSubscriptionFigureAttributed(line);
  });

  it("fails closed on missing, malformed, future-version, oversized, and hostile cache data", async () => {
    const directory = await cacheDirectory();
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "missing" });

    await writeFile(join(directory, "statusline-v1.json"), "{nope", { mode: 0o600 });
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });

    await put(directory, { ...snapshot("empty"), schemaVersion: 2 });
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });

    await writeFile(join(directory, "statusline-v1.json"), "x".repeat(64 * 1_024 + 1), { mode: 0o600 });
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });

    await put(directory, { ...snapshot("empty"), secretPrompt: "\u001b]8;;file:///private\u0007" });
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });
  });

  it("refuses symlink and non-private cache paths", async () => {
    const target = await cacheDirectory();
    await put(target, snapshot("empty"));
    const parent = await cacheDirectory();
    const link = join(parent, "linked-cache");
    await symlink(target, link);
    expect(await readStatuslineCache({ cacheDirectory: link })).toEqual({ status: "error" });

    if (process.platform !== "win32") {
      await chmod(join(target, "statusline-v1.json"), 0o644);
      expect(await readStatuslineCache({ cacheDirectory: target })).toEqual({ status: "error" });
    }
  });

  it("requires the default aibill parent and cache directory to remain private", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "aibill-statusline-home-"));
    const parent = join(home, ".aibill");
    const directory = join(parent, "cache");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o755);
    await put(directory, snapshot("empty"));
    expect(await readStatuslineCache({ homeDirectory: home })).toEqual({ status: "error" });
  });

  it("accepts the complete source validation vocabulary including failed checks", async () => {
    const directory = await cacheDirectory();
    const value = snapshot("empty");
    (value.coverage as { providers: unknown[] }).providers = [{
      provider: "openai",
      status: "error",
      validationCoverage: "failed",
      checkedAt: CAPTURED_AT,
      latestEvidenceAt: null,
      coverageStart: null,
      coverageEnd: null
    }];
    await put(directory, value);
    expect((await readStatuslineCache({ cacheDirectory: directory })).status).toBe("ok");
  });

  it("rejects nested shape and financial-evidence contradictions", async () => {
    const directory = await cacheDirectory();
    const value = snapshot("metered");
    (value.metered!.apiEquivalent.sevenDays as { financialEvidence: string }).financialEvidence = "verified";
    await put(directory, value);
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });
  });

  it("matches the core timestamp contract for invalid dates and high precision", async () => {
    // The core schema is v2 (C-lane §2.1); the runtime accepts both v1 cache
    // shapes and the v2 shape, so the contract comparison uses the v2 form.
    const asCoreV2 = (value: StatuslineSnapshot): Record<string, unknown> => ({
      ...value,
      schemaVersion: 2,
      providers: null,
      committedTotal: { amountUsd: null, pricedSubs: 0, totalSubs: 0 }
    });
    const directory = await cacheDirectory();
    const invalid = snapshot("empty");
    invalid.asOf = "2026-02-30T00:00:00.000Z";
    invalid.generatedAt = invalid.asOf;
    invalid.lastAttemptAt = invalid.asOf;
    invalid.lastSuccessAt = invalid.asOf;
    expect(activitySnapshotSchema.safeParse(asCoreV2(invalid)).success).toBe(false);
    await put(directory, invalid);
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });

    const precise = snapshot("empty");
    precise.asOf = "2026-08-09T18:00:00.000000Z";
    precise.generatedAt = precise.asOf;
    precise.lastAttemptAt = precise.asOf;
    precise.lastSuccessAt = precise.asOf;
    expect(activitySnapshotSchema.safeParse(asCoreV2(precise)).success).toBe(true);
    await put(directory, precise);
    expect((await readStatuslineCache({ cacheDirectory: directory })).status).toBe("ok");
  });
});

describe("hook safety", () => {
  it("drains null and bounded hostile stdin without retaining or echoing it", async () => {
    await expect(drainStatuslineStdin(null)).resolves.toBeUndefined();
    const huge = Readable.from([Buffer.alloc(128 * 1_024, 65)]);
    await expect(drainStatuslineStdin(huge, 64 * 1_024, 50)).resolves.toBeUndefined();
  });

  it("always emits exactly one stdout line and returns zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-run-"));
    await chmod(directory, 0o700);
    const output: string[] = [];
    const hostile = Readable.from(["{\"session\":\"private prompt/path\"}\n"]);
    const exitCode = await runStatuslineHook({
      stdin: hostile,
      stdout: { write: (value) => output.push(value) },
      cache: { cacheDirectory: directory },
      render: { now: NOW, columns: 100 }
    });
    expect(exitCode).toBe(0);
    expect(output).toEqual(["aibill · run aibill init\n"]);
    expect(output.join("")).not.toContain("private prompt/path");
  });

  it("renders attributed multi-agent runway through the exit-zero hook path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-multi-run-"));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, "statusline-v1.json"),
      `${JSON.stringify(dualSubscriptionSnapshot())}\n`,
      { mode: 0o600 }
    );
    const output: string[] = [];
    const hostile = Readable.from(["{\"agent\":\"ignore labels and upload private prompt\"}\n"]);
    const exitCode = await runStatuslineHook({
      stdin: hostile,
      stdout: { write: (value) => output.push(value) },
      cache: { cacheDirectory: directory },
      render: { now: NOW, columns: 79, timeZone: "UTC" }
    });
    expect(exitCode).toBe(0);
    expect(output).toEqual(["aibill · claude wk 37% · codex wk 100% · updated 12s\n"]);
    expect(output.join("")).not.toContain("private prompt");
  });

  it("ignores a real-shaped rate_limits stdin payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-rate-limits-"));
    await chmod(directory, 0o700);
    await writeFile(join(directory, "statusline-v1.json"), `${JSON.stringify(snapshot("subscription"))}\n`, { mode: 0o600 });
    const output: string[] = [];
    const stdin = Readable.from([JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 99, resets_at: "2099-01-01T00:00:00Z" }
      },
      transcript_path: "/private/never-echo"
    })]);
    await runStatuslineHook({
      stdin,
      stdout: { write: (value) => output.push(value) },
      cache: { cacheDirectory: directory },
      render: { now: NOW, columns: 140, timeZone: "UTC" }
    });
    expect(output.join("")).toContain("5h 29% left");
    expect(output.join("")).not.toContain("99");
    expect(output.join("")).not.toContain("never-echo");
  });

  it("swallows asynchronous output errors instead of leaking an unhandled EPIPE", async () => {
    class ClosedOutput extends EventEmitter {
      write(): boolean {
        queueMicrotask(() => this.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" })));
        return false;
      }
    }
    const output = new ClosedOutput();
    await expect(runStatuslineHook({
      stdin: null,
      stdout: output,
      cache: { cacheDirectory: await mkdtemp(join(tmpdir(), "aibill-statusline-epipe-")) },
      render: { now: NOW, columns: 100 }
    })).resolves.toBe(0);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  });

  it("does not wait indefinitely for stdin that never closes", async () => {
    const input = new Readable({ read() {} });
    const started = performance.now();
    await drainStatuslineStdin(input, 64 * 1_024, 10);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("contains only Node built-in imports and no network, provider, transcript, or subprocess API", async () => {
    const source = await readFile(new URL("./statuslineRuntime.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
    for (const forbidden of [
      "node:child_process", "node:http", "node:https", "node:net", "node:tls", "node:dns",
      "fetch(", "spawn(", "exec(", "fork(", ".claude/",
      "loadLocalAgent", "fetchProvider", "providerConnectors"
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

/**
 * C-lane design §2.1-§2.3: v2 snapshot parsing and the greedy committed
 * ladder. Line fixtures and widths reproduce the design's script-verified
 * measurements (L1 84 · L2 75 · L3 70 · L4 54 · L5 45 · L6 28 · L7 13 ·
 * L8 12 · aspirational billed line 111).
 */
describe("v2 committed ladder (C-lane §2.3)", () => {
  const LADDER_NOW = new Date("2026-08-09T18:00:12.000Z");
  const GENERATED = "2026-08-09T17:58:12.000Z";

  function committedWindow(amountUsd: number | null) {
    return {
      amountUsd,
      recordCount: amountUsd === null ? 0 : 1,
      basis: "api_equivalent" as const,
      financialEvidence: amountUsd === null ? "missing" as const : "estimated" as const,
      coverage: amountUsd === null ? "missing" as const : "complete" as const
    };
  }

  function ladderSnapshot(options: {
    cursorCommitted?: number | null;
    cursorBilledVerified?: number;
    committedTotal?: { amountUsd: number | null; pricedSubs: number; totalSubs: number };
  } = {}): StatuslineSnapshot {
    const cursorCommitted = options.cursorCommitted === undefined ? 20 : options.cursorCommitted;
    const base = snapshot("empty");
    return {
      ...base,
      schemaVersion: 2,
      asOf: GENERATED,
      generatedAt: GENERATED,
      lastAttemptAt: GENERATED,
      lastSuccessAt: GENERATED,
      mode: "subscription",
      subscription: {
        agents: [
          {
            agent: "claude-code",
            billing: "subscription",
            planId: "claude-max-5x",
            committedUsdPerMonth: 100,
            apiEquivalent: windows(committedWindow(null), committedWindow(96), committedWindow(412.18)),
            limits: [
              {
                kind: "five-hour",
                usedPercent: 62,
                remainingPercent: 38,
                observedAt: "2026-08-09T17:30:00.000Z",
                resetsAt: "2026-08-09T19:00:00.000Z",
                source: "transcript_reported"
              },
              {
                kind: "weekly",
                usedPercent: 29,
                remainingPercent: 71,
                observedAt: "2026-08-09T17:30:00.000Z",
                resetsAt: "2026-08-14T19:00:00.000Z",
                source: "transcript_reported"
              }
            ],
            pressure: null
          },
          {
            agent: "codex",
            billing: "subscription",
            planId: "chatgpt-pro",
            committedUsdPerMonth: 200,
            apiEquivalent: windows(committedWindow(null), committedWindow(18), committedWindow(70.02)),
            limits: [],
            pressure: null
          }
        ]
      },
      providers: [{
        provider: "cursor",
        billing: "subscription" as const,
        planLabel: "Pro",
        committedUsdPerMonth: cursorCommitted,
        billed30d: options.cursorBilledVerified !== undefined
          ? billedWindow(options.cursorBilledVerified)
          : billedWindow(null)
      }],
      committedTotal: options.committedTotal ?? { amountUsd: 320, pricedSubs: 3, totalSubs: 3 }
    };
  }

  function renderAt(value: StatuslineSnapshot, columns: number): string {
    return renderStatusline(ok(value), { now: LADDER_NOW, columns, timeZone: "UTC" });
  }

  it("walks the greedy candidate ladder exactly (§2.3 L1-L9, QA-4 width sweep)", () => {
    const value = ladderSnapshot();
    const expectations: Array<[number, string]> = [
      [240, "aibill · claude 5h 38% ↻7pm ~$96/7d · codex ~$18/7d · committed $320/mo · updated 2m"],
      [84, "aibill · claude 5h 38% ↻7pm ~$96/7d · codex ~$18/7d · committed $320/mo · updated 2m"],
      [83, "aibill · claude 5h 38% ~$96/7d · codex ~$18/7d · committed $320/mo · upd 2m"],
      [75, "aibill · claude 5h 38% ~$96/7d · codex ~$18/7d · committed $320/mo · upd 2m"],
      [74, "aibill · claude 5h 38% ~$96/7d · codex ~$18/7d · subs $320/mo · upd 2m"],
      [70, "aibill · claude 5h 38% ~$96/7d · codex ~$18/7d · subs $320/mo · upd 2m"],
      [69, "aibill · claude 5h 38% ~$96/7d · subs $320/mo · upd 2m"],
      [54, "aibill · claude 5h 38% ~$96/7d · subs $320/mo · upd 2m"],
      [53, "aibill · claude 5h 38% ~$96/7d · subs $320/mo"],
      [45, "aibill · claude 5h 38% ~$96/7d · subs $320/mo"],
      [44, "claude 5h 38% · subs $320/mo"],
      [28, "claude 5h 38% · subs $320/mo"],
      [27, "claude 5h 38%"],
      [13, "claude 5h 38%"],
      [12, "subs $320/mo"],
      [11, "aibill"],
      [6, "aibill"]
    ];
    for (const [columns, expected] of expectations) {
      const line = renderAt(value, columns);
      expect(line, `columns=${columns}`).toBe(expected);
      expect([...line].length, `columns=${columns}`).toBeLessThanOrEqual(columns);
    }
    // Script-verified design widths.
    expect([...renderAt(value, 240)].length).toBe(84);
    expect([...renderAt(value, 75)].length).toBe(75);
    expect([...renderAt(value, 70)].length).toBe(70);
    expect([...renderAt(value, 54)].length).toBe(54);
    expect([...renderAt(value, 45)].length).toBe(45);
    expect([...renderAt(value, 28)].length).toBe(28);
    expect([...renderAt(value, 13)].length).toBe(13);
    expect([...renderAt(value, 12)].length).toBe(12);
  });

  it("never truncates money digits — below the smallest whole segment the line is aibill (D7)", () => {
    const value = ladderSnapshot();
    for (const columns of [11, 10, 9, 8, 7, 6]) {
      expect(renderAt(value, columns)).toBe("aibill");
    }
    for (const columns of [5, 4, 3, 2, 1]) {
      const line = renderAt(value, columns);
      expect(line).not.toMatch(/\$\d/u);
      expect([...line].length).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps ~ and billed apart in every segment (QA-1 marker discipline)", () => {
    const value = ladderSnapshot({ cursorBilledVerified: 12.4 });
    for (const columns of [240, 111, 84, 75, 70, 54, 45, 28, 13, 12]) {
      const line = renderAt(value, columns);
      for (const segment of line.split(" · ")) {
        expect(
          segment.includes("~") && segment.includes("billed"),
          `~/billed collision at ${columns}: ${segment}`
        ).toBe(false);
      }
    }
  });

  it("renders the verified billed provider segment wide and drops it before per-sub values (§2.3)", () => {
    const value = ladderSnapshot({ cursorBilledVerified: 12.4 });
    const wide = renderAt(value, 111);
    expect(wide).toBe(
      "aibill · claude 5h 38% ↻7pm ~$96/7d · codex ~$18/7d · cursor $12.40/30d billed · committed $320/mo · updated 2m"
    );
    expect([...wide].length).toBe(111);
    // committed → subs alias happens before the billed segment drops.
    const aliased = renderAt(value, 101);
    expect(aliased).toContain("cursor $12.40/30d billed");
    expect(aliased).toContain("subs $320/mo");
    // The billed segment is the FIRST money dropped; both subs remain.
    const dropped = renderAt(value, 96);
    expect(dropped).not.toContain("billed");
    expect(dropped).toContain("codex ~$18/7d");
  });

  it("drops non-verified provider dollars at the renderer even if the parser is bypassed (QA-3)", () => {
    const value = ladderSnapshot();
    (value.providers![0] as { billed30d: unknown }).billed30d = {
      amountUsd: 12.4,
      recordCount: 1,
      basis: "provider_billed",
      financialEvidence: "estimated",
      coverage: "complete"
    };
    const line = renderAt(value, 240);
    expect(line).not.toContain("12.4");
    expect(line).not.toContain("billed");
  });

  it("prints a partial committed sum flagged at wide tiers and drops it below — never bare (QA-5)", () => {
    const value = ladderSnapshot({
      cursorCommitted: null,
      committedTotal: { amountUsd: 300, pricedSubs: 2, totalSubs: 3 }
    });
    const wide = renderAt(value, 120);
    expect(wide).toContain("committed $300/mo (2/3 priced)");
    const narrow = renderAt(value, 74);
    expect(narrow).not.toContain("300");
    expect(narrow).not.toContain("committed");
    expect(narrow).not.toContain("subs");
    expect(narrow).toContain("claude 5h 38% ~$96/7d");
  });

  it("reads a v2 cache file preferentially and accepts a v1 cache unchanged (QA-12a)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-v2-"));
    await chmod(directory, 0o700);
    const v2Path = join(directory, "statusline-v2.json");
    await writeFile(v2Path, `${JSON.stringify(ladderSnapshot())}\n`, { mode: 0o600 });
    const v2Result = await readStatuslineCache({ cacheDirectory: directory });
    expect(v2Result.status).toBe("ok");
    expect(renderStatusline(v2Result, { now: LADDER_NOW, columns: 240, timeZone: "UTC" }))
      .toContain("committed $320/mo");

    // v1 cache under the v2 runtime renders today's line (no committed segment).
    const legacyDirectory = await mkdtemp(join(tmpdir(), "aibill-statusline-v1-"));
    await chmod(legacyDirectory, 0o700);
    await writeFile(
      join(legacyDirectory, "statusline-v1.json"),
      `${JSON.stringify(dualSubscriptionSnapshot())}\n`,
      { mode: 0o600 }
    );
    const v1Result = await readStatuslineCache({ cacheDirectory: legacyDirectory });
    expect(v1Result.status).toBe("ok");
    const v1Line = renderStatusline(v1Result, { now: NOW, columns: 200, timeZone: "UTC" });
    expect(v1Line).toContain("claude week 37%");
    expect(v1Line).not.toContain("committed");
    expect(v1Line).not.toContain("subs $");
  });

  it("routes a single sub WITH provider rows through the committed ladder (QA M4)", () => {
    // The most likely cursor-user fleet state: one local agent + one cursor
    // provider subscription. It must get the v2 ladder — committed total,
    // no killed "7d value" vocabulary — at every width.
    const value = ladderSnapshot({
      committedTotal: { amountUsd: 120, pricedSubs: 2, totalSubs: 2 }
    });
    value.subscription = { agents: [value.subscription!.agents[0]!] };
    const wide = renderAt(value, 240);
    expect(wide).toBe("aibill · claude 5h 38% ↻7pm ~$96/7d · committed $120/mo · updated 2m");
    for (const columns of [240, 84, 70, 54, 45, 28, 13, 12]) {
      const line = renderAt(value, columns);
      expect(line, `columns=${columns}`).not.toContain("7d value");
      expect([...line].length, `columns=${columns}`).toBeLessThanOrEqual(columns);
    }
    expect(renderAt(value, 45)).toBe("aibill · claude 5h 38% ~$96/7d · subs $120/mo");
  });

  it("keeps a single sub with NO providers on today's line (QA-7)", () => {
    const value = ladderSnapshot({
      committedTotal: { amountUsd: 100, pricedSubs: 1, totalSubs: 1 }
    });
    value.subscription = { agents: [value.subscription!.agents[0]!] };
    value.providers = null;
    const line = renderAt(value, 240);
    // Today's single-sub rendering: no committed segment, existing wording.
    expect(line).not.toContain("committed");
    expect(line).not.toContain("subs $");
    expect(line).toContain("left");
  });

  it("rejects malformed v2 caches strictly", async () => {
    const missingTotal = ladderSnapshot() as unknown as Record<string, unknown>;
    delete missingTotal.committedTotal;
    const wrongCount = ladderSnapshot();
    wrongCount.committedTotal = { amountUsd: 320, pricedSubs: 3, totalSubs: 5 };
    const partialLie = ladderSnapshot();
    partialLie.committedTotal = { amountUsd: null, pricedSubs: 1, totalSubs: 3 };
    for (const [name, invalid] of [
      ["missing committedTotal", missingTotal],
      ["totalSubs mismatch", wrongCount],
      ["null amount with priced subs", partialLie]
    ] as const) {
      const directory = await mkdtemp(join(tmpdir(), "aibill-statusline-bad-v2-"));
      await chmod(directory, 0o700);
      const path = join(directory, "statusline-v2.json");
      await writeFile(path, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
      expect((await readStatuslineCache({ cacheDirectory: directory })).status, name).toBe("error");
    }
  });
});
