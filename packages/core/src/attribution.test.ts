import { describe, expect, it } from "vitest";
import { attributeUsageRecords, classifyAttributionConfidence } from "./attribution.js";
import type { UsageRecord } from "./schema.js";

const baseSource = {
  id: "sample",
  name: "Sample",
  provider: "openai",
  confidence: "estimated" as const,
  observedFrom: "unit_test"
};

function usage(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: "usage-1",
    timestamp: "2026-05-20T10:00:00.000Z",
    source: baseSource,
    model: "gpt-4.1",
    inputTokens: 100,
    outputTokens: 50,
    amountUsd: 10,
    costConfidence: "estimated",
    ...overrides
  };
}

describe("attribution heuristic engine", () => {
  it("classifies confidence using the locked product thresholds", () => {
    expect(classifyAttributionConfidence(0.96)).toBe("auto_mapped");
    expect(classifyAttributionConfidence(0.8)).toBe("needs_confirmation");
    expect(classifyAttributionConfidence(0.55)).toBe("needs_question");
    expect(classifyAttributionConfidence(0.49)).toBe("unmapped");
  });

  it("auto-maps explicit client, project, and agent ids with audit evidence", () => {
    const [mapping] = attributeUsageRecords([
      usage({ clientId: "client-acme", projectId: "project-support", agentId: "agent-triage" })
    ]);

    expect(mapping?.status).toBe("auto_mapped");
    expect(mapping?.selected).toMatchObject({ entityType: "project", entityId: "project-support", confidence: 0.98 });
    expect(mapping?.evidence).toEqual([
      "usage record includes projectId project-support",
      "usage record includes clientId client-acme",
      "usage record includes agentId agent-triage"
    ]);
  });

  it("adds user, workspace, and API-key candidates without fabricating an owner", () => {
    const [mapping] = attributeUsageRecords([
      usage({ id: "usage-entity", userId: "user-research-lead", workspaceId: "workspace-beta", apiKeyId: "key-research" })
    ]);

    expect(mapping?.status).toBe("needs_confirmation");
    expect(mapping?.selected).toMatchObject({ entityType: "user", entityId: "user-research-lead", confidence: 0.94 });
    expect(mapping?.candidates.map((candidate) => candidate.entityType)).toEqual(["user", "workspace", "api_key"]);
    expect(mapping?.evidence).toEqual([
      "usage record includes userId user-research-lead",
      "usage record includes workspaceId workspace-beta",
      "usage record includes apiKeyId key-research"
    ]);
  });

  it("proposes confirmation for strong operation-derived candidates", () => {
    const [mapping] = attributeUsageRecords([
      usage({ id: "usage-2", operation: "client_acme support reply_draft" })
    ]);

    expect(mapping?.status).toBe("needs_confirmation");
    expect(mapping?.candidates[0]).toMatchObject({ entityType: "client", entityId: "client-acme", confidence: 0.82 });
  });

  it("asks a focused question for weak model/source-derived candidates", () => {
    const [mapping] = attributeUsageRecords([
      usage({ id: "usage-3", source: { ...baseSource, id: "anthropic-sample", provider: "anthropic" }, model: "claude-sonnet-4" })
    ]);

    expect(mapping?.status).toBe("needs_question");
    expect(mapping?.candidates[0]?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(mapping?.candidates[0]?.confidence).toBeLessThan(0.75);
  });

  it("leaves unmapped records below 50 percent confidence", () => {
    const [mapping] = attributeUsageRecords([usage({ id: "usage-4", source: { ...baseSource, id: "local" }, model: "unknown-model" })]);

    expect(mapping?.status).toBe("unmapped");
    expect(mapping?.selected).toBeUndefined();
  });
});
