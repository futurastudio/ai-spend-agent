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
    const directory = await cacheDirectory();
    const invalid = snapshot("empty");
    invalid.asOf = "2026-02-30T00:00:00.000Z";
    invalid.generatedAt = invalid.asOf;
    invalid.lastAttemptAt = invalid.asOf;
    invalid.lastSuccessAt = invalid.asOf;
    expect(activitySnapshotSchema.safeParse(invalid).success).toBe(false);
    await put(directory, invalid);
    expect(await readStatuslineCache({ cacheDirectory: directory })).toEqual({ status: "error" });

    const precise = snapshot("empty");
    precise.asOf = "2026-08-09T18:00:00.000000Z";
    precise.generatedAt = precise.asOf;
    precise.lastAttemptAt = precise.asOf;
    precise.lastSuccessAt = precise.asOf;
    expect(activitySnapshotSchema.safeParse(precise).success).toBe(true);
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
