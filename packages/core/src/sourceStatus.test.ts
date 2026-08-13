import { describe, expect, it } from "vitest";
import type { UsageRecord } from "./schema.js";
import {
  buildSourceStatuses,
  applyProviderContractGate,
  applyProviderContractGateToSourceRegistry,
  financialEvidenceForRecords,
  formatSourceStatuses,
  sourceStatusDefinitions,
  providerContractStateValues,
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
      contractState: "current",
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
    expect(providerContractStateValues).toEqual(["current", "stale_contract"]);
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
    expect(rendered).toContain("provider contract: current");
    expect(rendered).toContain("financial evidence: missing");
    expect(rendered).toContain("freshness: fresh");
    expect(rendered).toContain("last error: users endpoint: HTTP 403");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("validation proof:");
    expect(rendered).toContain("evidence note:");
  });

  it("withholds a verified headline while provider contract drift is unresolved", () => {
    const status = buildSourceStatuses([{
      id: "openai",
      contractState: "stale_contract",
      financialEvidence: "verified",
      financialEvidenceNote: "Provider cost API returned $12.00.",
      checkedAt: "2026-08-13T12:00:00.000Z"
    }], new Date("2026-08-13T13:00:00.000Z")).find((entry) => entry.id === "openai");

    expect(status).toMatchObject({
      contractState: "stale_contract",
      financialEvidence: "missing",
      financialEvidenceNote: expect.stringContaining("withheld pending human review")
    });
  });

  it("does not invent a provider-contract state for local sources without a contract", () => {
    const statuses = buildSourceStatuses([], new Date("2026-08-13T13:00:00.000Z"));
    expect(statuses.find((entry) => entry.id === "claude-code")).not.toHaveProperty("contractState");
    expect(statuses.find((entry) => entry.id === "codex")).not.toHaveProperty("contractState");
    expect(statuses.find((entry) => entry.id === "gemini-cli")?.contractState).toBe("current");
    expect(statuses.find((entry) => entry.id === "openai")?.contractState).toBe("current");
  });

  it("never lets a runtime observation promote a stale shipped contract", () => {
    const original = sourceStatusDefinitions.find((entry) => entry.id === "openai");
    expect(original).toBeDefined();
    const status = buildSourceStatuses([{
      id: "openai",
      contractState: "current",
      financialEvidence: "verified",
      financialEvidenceNote: "Provider cost.",
      checkedAt: "2026-08-13T12:00:00.000Z"
    }], new Date("2026-08-13T13:00:00.000Z"), [{
      ...original!,
      contractState: "stale_contract"
    }]).find((entry) => entry.id === "openai");
    expect(status).toMatchObject({ contractState: "stale_contract", financialEvidence: "missing" });
  });

  it("withholds provider dollars at the record boundary while preserving local transcript value", () => {
    const openAi = sourceStatusDefinitions.find((entry) => entry.id === "openai");
    expect(openAi).toBeDefined();
    const providerRecord = {
      ...record("verified", 12),
      source: {
        ...record("verified", 12).source,
        provider: "openai",
        confidence: "verified" as const
      },
      providerCostType: "openai_cost" as const
    };
    const localRecord = {
      ...record("estimated", 4),
      source: {
        ...record("estimated", 4).source,
        provider: "openai",
        confidence: "estimated" as const
      },
      providerCostType: "local_agent_logs" as const
    };
    const gated = applyProviderContractGate([providerRecord, localRecord], [{
      ...openAi!,
      contractState: "stale_contract"
    }]);

    expect(gated[0]).toMatchObject({ amountUsd: null, costConfidence: "missing", source: { confidence: "missing" } });
    expect(gated[1]).toEqual(localRecord);
  });

  it("projects older verified source metadata through a newly stale contract without mutating its receipt bytes", () => {
    const openAi = sourceStatusDefinitions.find((entry) => entry.id === "openai");
    expect(openAi).toBeDefined();
    const registry = {
      version: 1 as const,
      localOnly: true as const,
      cloudUpload: false as const,
      deniedGlobs: [],
      ingestionLanes: [],
      supportedSourceTypes: ["provider_api" as const],
      updatedAt: "2026-08-12T00:00:00.000Z",
      approvedSources: [{
        id: "openai-provider-api",
        type: "provider_api" as const,
        label: "OpenAI",
        provider: "openai",
        readOnly: true,
        approvedAt: "2026-08-12T00:00:00.000Z",
        scope: "Reads provider data. Last successful pull produced 1 record(s); financial evidence: verified; financial headline: $12.00.",
        lane: "provider_apis" as const,
        accessMethod: "api" as const,
        boundaryApproval: "approved" as const,
        validationCoverage: "live_verified" as const,
        financialEvidence: "verified" as const,
        fieldsVerified: ["cost"],
        fieldsEstimated: [],
        fieldsMissing: []
      }]
    };
    const projected = applyProviderContractGateToSourceRegistry(registry, [{
      ...openAi!,
      contractState: "stale_contract"
    }]);

    expect(projected.approvedSources[0]).toMatchObject({
      financialEvidence: "missing",
      scope: "Reads provider data. Provider contract drift is unresolved; prior financial evidence and headline are withheld.",
      fieldsMissing: ["provider financial headline (contract review required)"]
    });
    expect(registry.approvedSources[0]).toMatchObject({
      financialEvidence: "verified",
      scope: expect.stringContaining("financial headline: $12.00")
    });
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
