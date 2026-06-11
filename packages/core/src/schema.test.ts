import { describe, expect, it } from "vitest";
import {
  attributionMappingSchema,
  costConfidenceValues,
  recommendationSchema,
  spendSourceSchema,
  usageRecordSchema
} from "./schema.js";

const source = {
  id: "sample-source",
  name: "Sample source",
  provider: "openai",
  confidence: "verified",
  observedFrom: "unit_test"
};

describe("core schemas", () => {
  it("accepts all required cost confidence labels", () => {
    expect(costConfidenceValues).toEqual([
      "verified",
      "estimated",
      "detected_unverified",
      "missing"
    ]);

    for (const confidence of costConfidenceValues) {
      expect(spendSourceSchema.parse({ ...source, confidence }).confidence).toBe(confidence);
    }
  });

  it("requires normalized usage fields", () => {
    const record = usageRecordSchema.parse({
      id: "usage-1",
      timestamp: "2026-05-19T14:40:00.000Z",
      source,
      model: "gpt-4.1",
      inputTokens: 160000,
      outputTokens: 12000,
      amountUsd: 18.6,
      costConfidence: "estimated",
      clientId: "client-beta",
      projectId: "project-research",
      agentId: "agent-analyst",
      operation: "research_summary"
    });

    expect(record.amountUsd).toBe(18.6);
  });

  it("requires missing costs to omit the amount", () => {
    expect(() =>
      usageRecordSchema.parse({
        id: "usage-2",
        timestamp: "2026-05-19T14:40:00.000Z",
        source,
        model: "gpt-4.1",
        inputTokens: 1,
        outputTokens: 1,
        amountUsd: 1,
        costConfidence: "missing"
      })
    ).toThrow();
  });

  it("validates attribution mappings and recommendations", () => {
    expect(
      attributionMappingSchema.parse({
        usageRecordId: "usage-1",
        candidates: [
          {
            entityType: "project",
            entityId: "project-research",
            confidence: 0.91,
            evidence: ["sample usage project_id"]
          }
        ],
        status: "needs_confirmation",
        evidence: ["sample usage project_id"]
      }).status
    ).toBe("needs_confirmation");

    expect(
      recommendationSchema.parse({
        id: "routing",
        title: "Route workloads",
        rationale: "Multiple sources are present.",
        whyItMatters: "A default routing policy prevents premium models from becoming the default for low-value work.",
        nextAction: "Review the top three repeated operations and assign a default model tier to each.",
        priority: "high",
        estimatedImpactUsd: 24,
        confidence: "estimated",
        relatedKeys: ["openai-sample"]
      })
    ).toMatchObject({
      confidence: "estimated",
      priority: "high",
      estimatedImpactUsd: 24
    });
  });
});
