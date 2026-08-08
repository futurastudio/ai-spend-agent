import { describe, expect, it } from "vitest";
import type { UsageRecord } from "./schema.js";
import {
  buildSourceStatuses,
  financialEvidenceForRecords,
  formatSourceStatuses,
  sourceStatusDefinitions,
  sourceValidationCoverageValues
} from "./sourceStatus.js";

describe("canonical source status", () => {
  it("keeps validation coverage separate from financial evidence", () => {
    const statuses = buildSourceStatuses([{
      id: "cursor",
      validationCoverage: "failed",
      financialEvidence: "verified",
      financialEvidenceNote: "Official provider cost is present.",
      checkedAt: "2026-08-08T12:00:00.000Z",
      latestEvidenceAt: "2026-08-08T00:00:00.000Z"
    }], new Date("2026-08-08T13:00:00.000Z"));
    const cursor = statuses.find((status) => status.id === "cursor");

    expect(cursor).toMatchObject({
      validationCoverage: "failed",
      financialEvidence: "verified",
      freshness: { status: "fresh" }
    });
    expect(cursor?.validationNote).toContain("teamMemberSpend");
  });

  it("uses proof-conservative shipped validation claims", () => {
    expect(sourceValidationCoverageValues).toEqual([
      "live_verified",
      "fixture_verified",
      "untested",
      "failed"
    ]);
    expect(sourceStatusDefinitions.find((source) => source.id === "claude-code")?.validationCoverage).toBe("live_verified");
    expect(sourceStatusDefinitions.find((source) => source.id === "codex")?.validationCoverage).toBe("live_verified");
    expect(sourceStatusDefinitions.find((source) => source.id === "anthropic")?.validationCoverage).toBe("live_verified");
    expect(sourceStatusDefinitions.find((source) => source.id === "openai")?.validationCoverage).toBe("live_verified");
    expect(sourceStatusDefinitions.find((source) => source.id === "cursor")?.validationCoverage).toBe("fixture_verified");
    expect(sourceStatusDefinitions.find((source) => source.id === "github-copilot")?.validationCoverage).toBe("fixture_verified");
  });

  it("reports fresh, stale, and never-checked sources without inventing timestamps", () => {
    const statuses = buildSourceStatuses([
      {
        id: "claude-code",
        financialEvidence: "estimated",
        financialEvidenceNote: "Local estimate.",
        checkedAt: "2026-08-08T12:00:00.000Z"
      },
      {
        id: "anthropic",
        financialEvidence: "verified",
        financialEvidenceNote: "Provider cost.",
        checkedAt: "2026-08-01T12:00:00.000Z"
      }
    ], new Date("2026-08-08T13:00:00.000Z"));

    expect(statuses.find((status) => status.id === "claude-code")?.freshness.status).toBe("fresh");
    expect(statuses.find((status) => status.id === "anthropic")?.freshness.status).toBe("stale");
    expect(statuses.find((status) => status.id === "cursor")?.freshness).toEqual({
      status: "not_checked",
      staleAfterHours: 48
    });
  });

  it("derives the headline evidence label from actual rows", () => {
    expect(financialEvidenceForRecords([])).toBe("missing");
    expect(financialEvidenceForRecords([record("missing", null)])).toBe("missing");
    expect(financialEvidenceForRecords([record("detected_unverified", 2)])).toBe("detected_unverified");
    expect(financialEvidenceForRecords([record("estimated", 2), record("missing", null)])).toBe("estimated");
    expect(financialEvidenceForRecords([record("estimated", 2), record("verified", 1)])).toBe("verified");
  });

  it("formats every required field and preserves a recorded failure", () => {
    const statuses = buildSourceStatuses([{
      id: "cursor",
      validationCoverage: "failed",
      financialEvidence: "missing",
      financialEvidenceNote: "No rows.",
      checkedAt: "2026-08-08T12:00:00.000Z",
      lastError: "users endpoint:\n\u001b[31mHTTP 403"
    }], new Date("2026-08-08T13:00:00.000Z"));
    const rendered = formatSourceStatuses(statuses.filter((status) => status.id === "cursor"));

    expect(rendered).toContain("validation coverage: failed");
    expect(rendered).toContain("financial evidence: missing");
    expect(rendered).toContain("freshness: fresh");
    expect(rendered).toContain("last error: users endpoint: HTTP 403");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("validation proof:");
    expect(rendered).toContain("evidence note:");
  });
});

function record(costConfidence: UsageRecord["costConfidence"], amountUsd: number | null): UsageRecord {
  return {
    id: `${costConfidence}-${amountUsd}`,
    timestamp: "2026-08-08T00:00:00.000Z",
    source: {
      id: "test-source",
      name: "Test source",
      provider: "test",
      confidence: costConfidence,
      observedFrom: "fixture"
    },
    model: "test-model",
    inputTokens: 0,
    outputTokens: 0,
    amountUsd,
    costConfidence
  };
}
