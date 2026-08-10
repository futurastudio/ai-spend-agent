import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AGENT_ECONOMICS_RECEIPT_KIND,
  AGENT_ECONOMICS_RECEIPT_V0_VERSION,
  FOCUS_1_4_PIN,
  FOCUS_1_5_WORKING_DRAFT_PIN,
  OTEL_GENAI_DEVELOPMENT_PIN,
  TOKENOMICS_TRACKING_PIN,
  agentEconomicsReceiptV0DraftSchema,
  agentEconomicsReceiptV0Schema,
  createAgentEconomicsReceiptV0,
  createReceiptSourceRecordReference,
  parseAgentEconomicsReceiptV0,
  projectAgentEconomicsReceiptV0ToFocus,
  projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi,
  projectAgentEconomicsReceiptV0ToTokenomics,
  receiptFreshnessSchema,
  receiptSourceSchema,
  receiptTransformationValues,
  type AgentEconomicsReceiptV0,
  type AgentEconomicsReceiptV0DraftInput,
  type ReceiptFinancialCostLine,
  type ReceiptSource,
  type ReceiptTokenUsageLine
} from "./agentEconomicsReceipt.js";

const WINDOW_START = "2026-08-01T00:00:00.000Z";
const WINDOW_END = "2026-08-08T00:00:00.000Z";
const GENERATED_AT = "2026-08-08T00:00:01.000Z";

function ref(sourceId: string, recordId: string) {
  return createReceiptSourceRecordReference(sourceId, recordId);
}

function localSource(overrides: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    id: "local-codex",
    kind: "local_agent_log",
    provider: "openai",
    validationCoverage: "live_verified",
    freshness: {
      status: "fresh",
      checkedAt: WINDOW_END,
      latestEvidenceAt: "2026-08-07T23:00:00.000Z"
    },
    ...overrides
  };
}

function providerSource(overrides: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    id: "openai-costs",
    kind: "provider_billing_api",
    provider: "openai",
    validationCoverage: "live_verified",
    freshness: {
      status: "fresh",
      checkedAt: WINDOW_END,
      latestEvidenceAt: "2026-08-07T23:30:00.000Z"
    },
    ...overrides
  };
}

function tokenLine(overrides: Partial<ReceiptTokenUsageLine> = {}): ReceiptTokenUsageLine {
  return {
    id: "usage-1",
    kind: "token_usage",
    sourceId: "local-codex",
    provider: "openai",
    model: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    observedAt: "2026-08-07T23:00:00.000Z",
    granularity: "call",
    inputTokens: 120,
    outputTokens: 30,
    provenance: {
      origin: "locally_observed",
      transformations: ["normalized"]
    },
    sourceRecordReferences: [ref("local-codex", "record-1")],
    ...overrides
  };
}

function estimatedCostLine(
  overrides: Partial<ReceiptFinancialCostLine> = {}
): ReceiptFinancialCostLine {
  return {
    id: "cost-1",
    kind: "financial_cost",
    sourceId: "local-codex",
    observedAt: "2026-08-07T23:00:00.000Z",
    granularity: "call",
    amountUsd: 0.42,
    currency: "USD",
    accountingBasis: "api_equivalent",
    financialEvidence: "estimated",
    provenance: {
      origin: "locally_observed",
      transformations: ["normalized", "api_rate_estimated"]
    },
    sourceRecordReferences: [ref("local-codex", "record-1")],
    ...overrides
  };
}

function billedCostLine(
  overrides: Partial<ReceiptFinancialCostLine> = {}
): ReceiptFinancialCostLine {
  return {
    id: "bill-1",
    kind: "financial_cost",
    sourceId: "openai-costs",
    observedAt: "2026-08-07T23:30:00.000Z",
    granularity: "billing_bucket",
    amountUsd: 1.75,
    currency: "USD",
    accountingBasis: "provider_billed",
    financialEvidence: "verified",
    provenance: {
      origin: "provider_reported",
      transformations: ["normalized", "aggregated"]
    },
    sourceRecordReferences: [ref("openai-costs", "bucket-1")],
    ...overrides
  };
}

function localEstimateDraft(
  overrides: Partial<AgentEconomicsReceiptV0DraftInput> = {}
): AgentEconomicsReceiptV0DraftInput {
  return {
    kind: AGENT_ECONOMICS_RECEIPT_KIND,
    schemaVersion: AGENT_ECONOMICS_RECEIPT_V0_VERSION,
    generatedAt: GENERATED_AT,
    mode: "local",
    demoOnly: false,
    window: { start: WINDOW_START, end: WINDOW_END },
    sources: [localSource()],
    lines: [tokenLine(), estimatedCostLine()],
    mappingGaps: [{ code: "cost_unsplit", lineId: "cost-1", sourceId: "local-codex" }],
    ...overrides
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("AgentEconomicsReceiptV0 golden fixtures", () => {
  it("builds a deterministic local-estimate receipt with orthogonal evidence", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft());

    expect(receipt).toMatchObject({
      kind: "aibill.agent_economics_receipt",
      schemaVersion: "0.1.0",
      mode: "local",
      demoOnly: false,
      sources: [{
        id: "local-codex",
        validationCoverage: "live_verified",
        freshness: { status: "fresh" }
      }],
      costTotals: [{
        accountingBasis: "api_equivalent",
        financialEvidence: "estimated",
        currency: "USD",
        amountUsd: 0.42,
        lineCount: 1
      }]
    });
    expect(receipt.id).toBe(
      "aer_v0_9548fedb1689164382b471324b7bbce2fa1e5be07afc5e49789896476c8523b7"
    );
    expect(receipt.lines.find((line) => line.kind === "token_usage")).not.toHaveProperty("amountUsd");
    expect(receipt.lines.find((line) => line.kind === "financial_cost")).not.toHaveProperty("inputTokens");
    expect(parseAgentEconomicsReceiptV0(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("canonicalizes array ordering into one digest", () => {
    const first = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [tokenLine(), estimatedCostLine()],
      mappingGaps: [
        { code: "source_record_unmapped", sourceId: "local-codex" },
        { code: "cost_unsplit", lineId: "cost-1", sourceId: "local-codex" }
      ]
    }));
    const second = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [estimatedCostLine({
        provenance: {
          origin: "locally_observed",
          transformations: ["api_rate_estimated", "normalized"]
        }
      }), tokenLine()],
      mappingGaps: [
        { code: "cost_unsplit", lineId: "cost-1", sourceId: "local-codex" },
        { code: "source_record_unmapped", sourceId: "local-codex" }
      ]
    }));

    expect(second).toEqual(first);
  });

  it("canonicalizes semantically equivalent timestamps before deriving the ID", () => {
    const canonical = createAgentEconomicsReceiptV0(localEstimateDraft());
    const offset = createAgentEconomicsReceiptV0(localEstimateDraft({
      generatedAt: "2026-08-07T20:00:01-04:00",
      window: {
        start: "2026-07-31T20:00:00-04:00",
        end: "2026-08-07T20:00:00-04:00"
      },
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: "2026-08-07T20:00:00-04:00",
          latestEvidenceAt: "2026-08-07T19:00:00-04:00"
        }
      })],
      lines: [
        tokenLine({ observedAt: "2026-08-07T19:00:00-04:00" }),
        estimatedCostLine({ observedAt: "2026-08-07T19:00:00-04:00" })
      ]
    }));

    expect(offset).toEqual(canonical);
    expect(offset.id).toBe(canonical.id);
    expect(offset.generatedAt).toBe(GENERATED_AT);
    expect(offset.sources[0]?.freshness.checkedAt).toBe(WINDOW_END);
  });

  it("freezes canonical transformation order and all standard-version pins", () => {
    const before = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [estimatedCostLine({
        provenance: {
          origin: "locally_observed",
          transformations: ["api_rate_estimated", "normalized"]
        }
      })]
    }));
    const frozenExports: object[] = [
      receiptTransformationValues,
      FOCUS_1_4_PIN,
      FOCUS_1_5_WORKING_DRAFT_PIN,
      OTEL_GENAI_DEVELOPMENT_PIN,
      TOKENOMICS_TRACKING_PIN
    ];

    expect(frozenExports.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(receiptTransformationValues, "0", "api_rate_estimated")).toBe(false);
    expect(Reflect.set(FOCUS_1_4_PIN, "version", "tampered")).toBe(false);
    expect(Reflect.set(FOCUS_1_5_WORKING_DRAFT_PIN, "draftAsOf", "tampered")).toBe(false);
    expect(Reflect.set(OTEL_GENAI_DEVELOPMENT_PIN, "status", "stable")).toBe(false);
    expect(Reflect.set(TOKENOMICS_TRACKING_PIN, "status", "published")).toBe(false);

    const after = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [estimatedCostLine({
        provenance: {
          origin: "locally_observed",
          transformations: ["api_rate_estimated", "normalized"]
        }
      })]
    }));
    expect(after.id).toBe(before.id);
    expect(projectAgentEconomicsReceiptV0ToFocus(after, "focus_1_4").target)
      .toEqual({ standard: "FOCUS", version: "1.4", status: "ratified" });
    expect(projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(after).target.status)
      .toBe("development");
    expect(projectAgentEconomicsReceiptV0ToTokenomics(after).target.status)
      .toBe("not_published");
  });

  it("keeps a verified provider billing bucket separate from token usage", () => {
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "connected",
      sources: [providerSource()],
      lines: [billedCostLine()],
      mappingGaps: []
    });

    expect(receipt.lines).toEqual([billedCostLine()]);
    expect(receipt.costTotals).toEqual([{
      accountingBasis: "provider_billed",
      financialEvidence: "verified",
      currency: "USD",
      amountUsd: 1.75,
      lineCount: 1
    }]);
  });

  it("sums decimal USD values once without per-line precision collapse", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [
        estimatedCostLine({ amountUsd: 0.1 }),
        estimatedCostLine({
          id: "cost-2",
          amountUsd: 0.2,
          sourceRecordReferences: [ref("local-codex", "record-2")]
        }),
        estimatedCostLine({
          id: "cost-tiny",
          amountUsd: 0.0000000000004,
          sourceRecordReferences: [ref("local-codex", "record-tiny")]
        })
      ],
      mappingGaps: []
    }));

    expect(receipt.costTotals[0]?.amountUsd).toBe(0.3000000000004);
    expect(receipt.lines.find((line) => line.id === "cost-tiny")).toMatchObject({
      amountUsd: 0.0000000000004
    });
  });

  it("normalizes negative-zero money before deriving totals and IDs", () => {
    const negativeZero = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [estimatedCostLine({ amountUsd: -0 })],
      mappingGaps: []
    }));
    const positiveZero = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [estimatedCostLine({ amountUsd: 0 })],
      mappingGaps: []
    }));
    const amount = negativeZero.lines[0]?.kind === "financial_cost"
      ? negativeZero.lines[0].amountUsd
      : undefined;

    expect(Object.is(amount, -0)).toBe(false);
    expect(negativeZero).toEqual(positiveZero);
    expect(negativeZero.id).toBe(positiveZero.id);
  });

  it("normalizes negative-zero token counts before IDs and projections", () => {
    const negativeZero = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [tokenLine({ inputTokens: -0, outputTokens: -0 })],
      mappingGaps: []
    }));
    const positiveZero = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [tokenLine({ inputTokens: 0, outputTokens: 0 })],
      mappingGaps: []
    }));
    const line = negativeZero.lines[0];

    expect(line?.kind).toBe("token_usage");
    if (line?.kind === "token_usage") {
      expect(Object.is(line.inputTokens, -0)).toBe(false);
      expect(Object.is(line.outputTokens, -0)).toBe(false);
    }
    expect(negativeZero).toEqual(positiveZero);
    expect(negativeZero.id).toBe(positiveZero.id);
    expect(projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(negativeZero).rows[0])
      .toMatchObject({
        attributes: {
          "gen_ai.usage.input_tokens": 0,
          "gen_ai.usage.output_tokens": 0
        }
      });
  });

  it("represents call tokens and their unsplit cost as distinct typed lines", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft());
    const usage = receipt.lines.find((line) => line.kind === "token_usage");
    const cost = receipt.lines.find((line) => line.kind === "financial_cost");

    expect(usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(cost).toMatchObject({ amountUsd: 0.42, accountingBasis: "api_equivalent" });
    expect(receipt.mappingGaps).toContainEqual({
      code: "cost_unsplit",
      lineId: "cost-1",
      sourceId: "local-codex"
    });
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [{ ...estimatedCostLine(), inputTokens: 120 } as never]
    })).toThrow();
  });

  it("keeps unpriced usage as tokens plus an explicit mapping gap", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [tokenLine()],
      mappingGaps: [{ code: "cost_unpriced", lineId: "usage-1", sourceId: "local-codex" }]
    }));

    expect(receipt.costTotals).toEqual([]);
    expect(receipt.mappingGaps).toEqual([{
      code: "cost_unpriced",
      lineId: "usage-1",
      sourceId: "local-codex"
    }]);
  });

  it("does not blend verified billing and API-equivalent estimates", () => {
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "mixed",
      sources: [providerSource(), localSource()],
      lines: [billedCostLine(), tokenLine(), estimatedCostLine()],
      mappingGaps: [{ code: "cost_unsplit", lineId: "cost-1" }]
    });

    expect(receipt.costTotals).toEqual([
      {
        accountingBasis: "api_equivalent",
        financialEvidence: "estimated",
        currency: "USD",
        amountUsd: 0.42,
        lineCount: 1
      },
      {
        accountingBasis: "provider_billed",
        financialEvidence: "verified",
        currency: "USD",
        amountUsd: 1.75,
        lineCount: 1
      }
    ]);
    expect(receipt).not.toHaveProperty("totalUsd");
  });

  it("enforces the sample boundary and never permits verified sample cost", () => {
    const sampleSource = localSource({
      id: "sample-source",
      kind: "sample_fixture",
      validationCoverage: "fixture_verified"
    });
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "sample",
      demoOnly: true,
      sources: [sampleSource],
      lines: [
        tokenLine({
          sourceId: "sample-source",
          provenance: { origin: "sample", transformations: ["normalized"] },
          sourceRecordReferences: [ref("sample-source", "sample-1")]
        }),
        estimatedCostLine({
          sourceId: "sample-source",
          provenance: {
            origin: "sample",
            transformations: ["normalized", "api_rate_estimated"]
          },
          sourceRecordReferences: [ref("sample-source", "sample-1")]
        })
      ],
      mappingGaps: []
    });

    expect(receipt.demoOnly).toBe(true);
    expect(receipt.costTotals[0]?.financialEvidence).toBe("estimated");
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "sample",
      demoOnly: true,
      sources: [sampleSource],
      lines: [billedCostLine({
        sourceId: "sample-source",
        sourceRecordReferences: [ref("sample-source", "sample-1")]
      })],
      mappingGaps: []
    })).toThrow();

    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "sample",
      demoOnly: true,
      sources: [localSource({
        id: "sample-source",
        kind: "sample_fixture",
        validationCoverage: "live_verified"
      })],
      lines: [tokenLine({
        sourceId: "sample-source",
        provenance: { origin: "sample", transformations: ["normalized"] },
        sourceRecordReferences: [ref("sample-source", "sample-1")]
      })],
      mappingGaps: []
    })).toThrow();
  });

  it("keeps stale and failed source state explicit and separate from cost evidence", () => {
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        validationCoverage: "failed",
        freshness: {
          status: "error",
          checkedAt: WINDOW_END,
          latestEvidenceAt: "2026-08-07T23:00:00.000Z",
          errorCode: "provider_timeout"
        }
      })]
    });

    expect(receipt.sources[0]).toMatchObject({
      validationCoverage: "failed",
      freshness: { status: "error", errorCode: "provider_timeout" }
    });
    expect(receipt.costTotals[0]?.financialEvidence).toBe("estimated");

    const stale = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "stale",
          checkedAt: WINDOW_END,
          latestEvidenceAt: "2026-08-07T23:00:00.000Z"
        }
      })]
    });
    expect(stale.sources[0]?.freshness.status).toBe("stale");
  });

  it("defaults omitted connector validation to untested without promoting it", () => {
    const source = clone(localSource()) as unknown as Record<string, unknown>;
    delete source.validationCoverage;
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [source as never]
    });

    expect(receipt.sources[0]?.validationCoverage).toBe("untested");
    expect(receipt.costTotals[0]?.financialEvidence).toBe("estimated");
  });

  it("strips explicit undefined from optional receipt fields before canonicalization", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft({
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: WINDOW_END,
          latestEvidenceAt: undefined
        }
      })],
      mappingGaps: [{
        code: "cost_unsplit",
        lineId: "cost-1",
        sourceId: undefined
      }]
    }));

    expect(Object.hasOwn(receipt.sources[0]!.freshness, "latestEvidenceAt")).toBe(false);
    expect(Object.hasOwn(receipt.mappingGaps[0]!, "sourceId")).toBe(false);
    expect(agentEconomicsReceiptV0Schema.parse({
      ...receipt,
      mappingGaps: [{ ...receipt.mappingGaps[0]!, sourceId: undefined }]
    })).toEqual(receipt);
  });

  it("keeps user-declared subscription cost distinct from provider billing", () => {
    const receipt = createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [{
        id: "declared-plan",
        kind: "user_declaration",
        provider: "anthropic",
        freshness: { status: "not_checked" }
      }],
      lines: [{
        id: "declared-cost-1",
        kind: "financial_cost",
        sourceId: "declared-plan",
        observedAt: "2026-08-07T23:00:00.000Z",
        granularity: "seat",
        amountUsd: 200,
        currency: "USD",
        accountingBasis: "user_declared",
        financialEvidence: "detected_unverified",
        provenance: { origin: "user_declared", transformations: ["normalized"] },
        sourceRecordReferences: [ref("declared-plan", "plan-1")]
      }],
      mappingGaps: []
    });

    expect(receipt.sources[0]?.validationCoverage).toBe("untested");
    expect(receipt.sources[0]?.freshness.status).toBe("not_checked");
    expect(receipt.costTotals).toEqual([{
      accountingBasis: "user_declared",
      financialEvidence: "detected_unverified",
      currency: "USD",
      amountUsd: 200,
      lineCount: 1
    }]);
  });
});

describe("AgentEconomicsReceiptV0 fail-closed validation", () => {
  it("rejects unknown versions, stale digests, and mismatched or duplicate totals", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft());
    expect(() => parseAgentEconomicsReceiptV0({ ...receipt, schemaVersion: "0.2.0" })).toThrow();
    expect(() => parseAgentEconomicsReceiptV0({ ...receipt, id: `aer_v0_${"0".repeat(64)}` })).toThrow();
    expect(() => parseAgentEconomicsReceiptV0({
      ...receipt,
      costTotals: [{ ...receipt.costTotals[0]!, amountUsd: 999 }]
    })).toThrow();
    expect(() => parseAgentEconomicsReceiptV0({
      ...receipt,
      costTotals: [receipt.costTotals[0], receipt.costTotals[0]]
    })).toThrow();
  });

  it("rejects duplicate IDs, references, and unresolved relationships", () => {
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine(), estimatedCostLine({ id: "usage-1" })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource(), localSource()]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({
        sourceRecordReferences: [
          ref("local-codex", "record-1"),
          ref("local-codex", "record-1")
        ]
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mappingGaps: [{ code: "cost_unpriced", lineId: "missing-line" }]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mappingGaps: [
        { code: "cost_unsplit", lineId: "cost-1" },
        { code: "cost_unsplit", lineId: "cost-1" }
      ]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({ sourceId: "missing-source" })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [
        localSource(),
        localSource({ id: "other-local-source" })
      ],
      mappingGaps: [{
        code: "cost_unpriced",
        lineId: "usage-1",
        sourceId: "other-local-source"
      }]
    })).toThrow();
  });

  it("rejects non-integer tokens, inverted/out-of-window time, and invalid money", () => {
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({ inputTokens: 1.5 })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0(localEstimateDraft({
      window: { start: WINDOW_END, end: WINDOW_START }
    }))).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({ observedAt: "2026-07-31T23:59:59.000Z" })]
    })).toThrow();
    for (const amountUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createAgentEconomicsReceiptV0({
        ...localEstimateDraft(),
        lines: [estimatedCostLine({ amountUsd })]
      })).toThrow();
    }
    const unsafeAggregate: AgentEconomicsReceiptV0DraftInput = {
      ...localEstimateDraft(),
      lines: [
        estimatedCostLine({ amountUsd: Number.MAX_SAFE_INTEGER }),
        estimatedCostLine({
          id: "cost-2",
          amountUsd: 2,
          sourceRecordReferences: [ref("local-codex", "record-2")]
        })
      ],
      mappingGaps: []
    };
    expect(() => agentEconomicsReceiptV0DraftSchema.safeParse(unsafeAggregate)).not.toThrow();
    expect(agentEconomicsReceiptV0DraftSchema.safeParse(unsafeAggregate).success).toBe(false);
    expect(() => createAgentEconomicsReceiptV0(unsafeAggregate)).toThrow(/without precision loss/);
    const unsafeEnvelope = {
      ...unsafeAggregate,
      id: `aer_v0_${"0".repeat(64)}`,
      costTotals: [{
        accountingBasis: "api_equivalent",
        financialEvidence: "estimated",
        currency: "USD",
        amountUsd: Number.MAX_SAFE_INTEGER,
        lineCount: 2
      }]
    };
    expect(() => agentEconomicsReceiptV0Schema.safeParse(unsafeEnvelope)).not.toThrow();
    expect(agentEconomicsReceiptV0Schema.safeParse(unsafeEnvelope).success).toBe(false);
  });

  it("rejects hostile, path, prompt, observedFrom, and credential-like metadata", () => {
    const fakeGitLabPat = `glpat-${"A".repeat(20)}`;
    const fakeHeliconeKey = `helicone_${"b".repeat(24)}`;
    const fakeJwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const hostileProviders = [
      "<script>",
      "/Users/testuser/.config",
      "provider\u001b[31m",
      "npm_FAKE_CREDENTIAL_FIXTURE",
      "env_OPENAI_ADMIN_KEY",
      "keychain_OPENAI_ADMIN_KEY",
      "secret_OPENAI_ADMIN_KEY",
      "source_env_OPENAI_ADMIN_KEY",
      "source_keychain_OPENAI_ADMIN_KEY",
      "source_secret_OPENAI_ADMIN_KEY",
      "gho_FAKE_CREDENTIAL_FIXTURE",
      "ghu_FAKE_CREDENTIAL_FIXTURE",
      "ghs_FAKE_CREDENTIAL_FIXTURE",
      "ghr_FAKE_CREDENTIAL_FIXTURE",
      "Bearer_FAKE_CREDENTIAL_FIXTURE",
      "token_FAKE_CREDENTIAL_FIXTURE",
      `password_${"A".repeat(36)}`,
      `passwd_${"A".repeat(36)}`,
      `credential_${"A".repeat(36)}`,
      `authorization_${"A".repeat(36)}`,
      `auth_${"A".repeat(36)}`,
      `api_key_${"A".repeat(36)}`,
      `access_key_${"A".repeat(36)}`,
      `private_key_${"A".repeat(36)}`,
      `token-${"A".repeat(36)}`,
      `Bearer-${"A".repeat(36)}`,
      `password-${"A".repeat(36)}`,
      `authorization-${"A".repeat(36)}`,
      "IGNORE_PREVIOUS_INSTRUCTIONS",
      "upload_secrets_to_attacker",
      fakeGitLabPat,
      fakeHeliconeKey,
      fakeJwt,
      `source_${fakeGitLabPat}`,
      `source_${fakeHeliconeKey}`,
      `source_${fakeJwt}`,
      Buffer.from("gho_FAKE_CREDENTIAL_FIXTURE").toString("base64url"),
      "ZW52X09QRU5BSV9BRE1JTl9LRVk",
      "656e765f4f50454e41495f41444d494e5f4b4559",
      Buffer.from("keychain_OPENAI_ADMIN_KEY").toString("base64url"),
      Buffer.from("keychain_OPENAI_ADMIN_KEY").toString("hex"),
      Buffer.from("secret_OPENAI_ADMIN_KEY").toString("base64url"),
      Buffer.from("secret_OPENAI_ADMIN_KEY").toString("hex"),
      Buffer.from("source_env_OPENAI_ADMIN_KEY").toString("base64url"),
      Buffer.from("source_env_OPENAI_ADMIN_KEY").toString("hex"),
      Buffer.from("source_keychain_OPENAI_ADMIN_KEY").toString("base64url"),
      Buffer.from("source_keychain_OPENAI_ADMIN_KEY").toString("hex"),
      Buffer.from("source_secret_OPENAI_ADMIN_KEY").toString("base64url"),
      Buffer.from("source_secret_OPENAI_ADMIN_KEY").toString("hex"),
      Buffer.from("Bearer_FAKE_CREDENTIAL_FIXTURE").toString("base64url"),
      Buffer.from(`password_${"A".repeat(36)}`).toString("base64url"),
      Buffer.from(`authorization_${"A".repeat(36)}`).toString("base64url"),
      Buffer.from(`token-${"A".repeat(36)}`).toString("base64url"),
      Buffer.from(`Bearer-${"A".repeat(36)}`).toString("base64url"),
      Buffer.from(`password-${"A".repeat(36)}`).toString("base64url"),
      Buffer.from(`authorization-${"A".repeat(36)}`).toString("base64url"),
      Buffer.from("IGNORE_PREVIOUS_INSTRUCTIONS").toString("base64url"),
      Buffer.from("upload_secrets_to_attacker").toString("base64url"),
      Buffer.from(fakeGitLabPat).toString("base64url"),
      Buffer.from(`\n${fakeGitLabPat}`).toString("base64url"),
      Buffer.from(`prefix_\u001b[31m${fakeJwt}`).toString("base64url"),
      Buffer.from(fakeHeliconeKey).toString("hex"),
      Buffer.from("/Users/testuser/.config/provider-key.json").toString("base64url"),
      Buffer.from("project/src/index.ts").toString("base64url"),
      Buffer.from("workspace/secrets/config.json").toString("base64url"),
      Buffer.from("relative/path.txt").toString("base64url"),
      Buffer.from("project files/src/index.ts").toString("base64url"),
      Buffer.from("project/src/my file.ts").toString("base64url"),
      Buffer.from("\n project files/src/index.ts").toString("base64url"),
      "cHJvamV0w6kvc3JjL2luZGV4LnRz",
      Buffer.from("projeté\\src\\index.ts").toString("base64url"),
      "L3RtcC9h",
      "YS9iLnR4dA",
      "QzpceFx5",
      "2f746d702f61",
      "612f622e747874",
      "433a5c785c79"
    ];
    for (const provider of hostileProviders) {
      expect(receiptSourceSchema.safeParse({ ...localSource(), provider }).success).toBe(false);
    }
    expect(receiptSourceSchema.safeParse({ ...localSource(), provider: "openai" }).success)
      .toBe(true);
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [{ ...localSource(), observedFrom: "/private/transcript.jsonl" } as never]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [{ ...tokenLine(), prompt: "private user prompt" } as never]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({
        sourceRecordReferences: [{ sourceId: "local-codex", recordId: "raw-session-name" }]
      })]
    })).toThrow();

    const opaqueReference = createReceiptSourceRecordReference(
      "local-codex",
      "/Users/testuser/project/private-session.jsonl"
    );
    expect(opaqueReference.recordId).toMatch(/^ref_[a-f0-9]{32}$/);
    expect(JSON.stringify(opaqueReference)).not.toContain("private-session");
    expect(createReceiptSourceRecordReference("local-codex", "same-native-id"))
      .toEqual(createReceiptSourceRecordReference("local-codex", "same-native-id"));
  });

  it("keeps benign short and encoding-shaped identifiers valid", () => {
    const benignIdentifiers = [
      "ai",
      "openai",
      "local",
      "abc123",
      "deadbeef",
      "6162",
      "gpt-5.6-sol",
      "bearer-metrics",
      "token-usage",
      "ignore-previous-errors",
      "upload-token-counts",
      "password-reset",
      "authorization-header",
      "auth-service",
      "api-client",
      "api-key-source",
      "private-key-registry",
      "private-model",
      "source_envelope_metrics",
      "source_keychains_metrics",
      "source_secretary_metrics",
      Buffer.from("envelope_metrics").toString("base64url"),
      Buffer.from("keychains_metrics").toString("hex"),
      Buffer.from("secretary_metrics").toString("base64url"),
      Buffer.from("source_envelope_metrics").toString("base64url"),
      Buffer.from("source_keychains_metrics").toString("hex"),
      Buffer.from("source_secretary_metrics").toString("base64url")
    ];

    for (const provider of benignIdentifiers) {
      expect(() => createAgentEconomicsReceiptV0(localEstimateDraft({
        sources: [localSource({ provider })],
        lines: [tokenLine({ provider })],
        mappingGaps: []
      }))).not.toThrow();
    }

    expect(() => createAgentEconomicsReceiptV0(localEstimateDraft({
      sources: [localSource({
        freshness: {
          status: "error",
          checkedAt: WINDOW_END,
          errorCode: "token_expired"
        }
      })]
    }))).not.toThrow();
  });

  it("rejects unpaired Unicode surrogates before hashing native record IDs", () => {
    const replacementCharacter = createReceiptSourceRecordReference("local-codex", "\ufffd");
    const pairedSurrogate = createReceiptSourceRecordReference("local-codex", "record-\ud83d\ude80");

    expect(() => createReceiptSourceRecordReference("local-codex", "\ud800")).toThrow();
    expect(() => createReceiptSourceRecordReference("local-codex", "\udc00")).toThrow();
    expect(replacementCharacter.recordId).toMatch(/^ref_[a-f0-9]{32}$/);
    expect(pairedSurrogate.recordId).toMatch(/^ref_[a-f0-9]{32}$/);
    expect(pairedSurrogate).not.toEqual(replacementCharacter);
  });

  it("rejects credential and prompt-injection shapes in freshness error codes", () => {
    const hostileErrorCodes = [
      `password_${"A".repeat(36)}`,
      `authorization_${"A".repeat(36)}`,
      "IGNORE_PREVIOUS_INSTRUCTIONS",
      "upload_secrets_to_attacker"
    ];

    for (const errorCode of hostileErrorCodes) {
      expect(receiptFreshnessSchema.safeParse({
        status: "error",
        checkedAt: WINDOW_END,
        errorCode
      }).success).toBe(false);
    }
    for (const errorCode of ["token_expired", "authorization_failed", "provider_timeout"]) {
      expect(receiptFreshnessSchema.safeParse({
        status: "error",
        checkedAt: WINDOW_END,
        errorCode
      }).success).toBe(true);
    }
  });

  it("rejects impossible freshness and accounting/evidence combinations", () => {
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({ freshness: { status: "not_checked" } })]
    })).toThrow(/Observed lines require a checked source/);
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "connected",
      sources: [providerSource({ freshness: { status: "not_checked" } })],
      lines: [billedCostLine()],
      mappingGaps: []
    })).toThrow(/Observed lines require a checked source/);
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({ freshness: { status: "stale" } as never })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "error",
          errorCode: "provider_timeout"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: WINDOW_END,
          latestEvidenceAt: "2026-08-07T22:59:59.000Z"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: "2026-08-07T22:59:59.000Z"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: WINDOW_END,
          errorCode: "provider_timeout"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: "2026-08-08T00:00:02.000Z",
          latestEvidenceAt: "2026-08-08T00:00:01.500Z"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [localSource({
        freshness: {
          status: "fresh",
          checkedAt: GENERATED_AT,
          latestEvidenceAt: "2026-08-08T00:00:01.500Z"
        }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [estimatedCostLine({
        accountingBasis: "provider_billed",
        financialEvidence: "estimated"
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [estimatedCostLine({
        accountingBasis: "api_equivalent",
        financialEvidence: "estimated",
        provenance: { origin: "locally_observed", transformations: ["normalized"] }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "connected"
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      sources: [
        localSource(),
        localSource({ id: "sample-source", kind: "sample_fixture" })
      ]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({ provider: "anthropic" })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({
        provenance: { origin: "provider_reported", transformations: ["normalized"] }
      })]
    })).toThrow();
    expect(() => createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      lines: [tokenLine({
        provenance: {
          origin: "locally_observed",
          transformations: ["normalized", "api_rate_estimated"]
        }
      })]
    })).toThrow();
  });
});

describe("version-pinned standards projections", () => {
  function mixedReceipt(): AgentEconomicsReceiptV0 {
    return createAgentEconomicsReceiptV0({
      ...localEstimateDraft(),
      mode: "mixed",
      sources: [providerSource(), localSource()],
      lines: [
        billedCostLine(),
        tokenLine(),
        estimatedCostLine(),
        tokenLine({
          id: "usage-aggregate",
          granularity: "daily_aggregate",
          inputTokens: 500,
          outputTokens: 60,
          sourceRecordReferences: [ref("local-codex", "record-2")]
        })
      ],
      mappingGaps: [{ code: "cost_unsplit", lineId: "cost-1" }]
    });
  }

  it("keeps ratified FOCUS 1.4 distinct from the 1.5 working draft", () => {
    const receipt = mixedReceipt();
    const focus14 = projectAgentEconomicsReceiptV0ToFocus(receipt, "focus_1_4");
    const focus15 = projectAgentEconomicsReceiptV0ToFocus(
      receipt,
      "focus_1_5_working_draft"
    );

    expect(focus14.target).toEqual(FOCUS_1_4_PIN);
    expect(focus15.target).toEqual(FOCUS_1_5_WORKING_DRAFT_PIN);
    expect(focus14.rows.filter((row) => row.kind === "token_usage")).toHaveLength(4);
    expect(focus14.rows.filter((row) => row.kind === "token_usage")).toSatisfy(
      (rows: Array<{ mapping: string }>) => rows.every((row) => row.mapping === "aibill_extension")
    );
    expect(focus15.rows.filter((row) => row.kind === "token_usage")).toSatisfy(
      (rows: Array<{ mapping: string }>) => rows.every(
        (row) => row.mapping === "focus_1_5_working_draft"
      )
    );
    expect(focus14.gaps.some((gap) =>
      gap.code === "focus_1_4_token_dimensions_unavailable")).toBe(true);
    expect(focus15.gaps.some((gap) =>
      gap.code === "focus_1_4_token_dimensions_unavailable")).toBe(false);
  });

  it("never maps API-equivalent estimates into FOCUS BilledCost", () => {
    const focus = projectAgentEconomicsReceiptV0ToFocus(mixedReceipt(), "focus_1_5_working_draft");
    const billed = focus.rows.find((row) => row.kind === "financial_cost" &&
      row.accountingBasis === "provider_billed");
    const estimate = focus.rows.find((row) => row.kind === "financial_cost" &&
      row.accountingBasis === "api_equivalent");

    expect(billed).toMatchObject({ BilledCost: 1.75, extensions: {} });
    expect(estimate).toMatchObject({
      BilledCost: null,
      extensions: { "x_aibill.api_equivalent_cost_usd": 0.42 }
    });
    expect(focus.gaps).toContainEqual({
      code: "api_equivalent_not_billed_cost",
      lineId: "cost-1"
    });
  });

  it("projects only proven Development-status OTel GenAI attributes", () => {
    const projection = projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(mixedReceipt());

    expect(projection.target).toEqual(OTEL_GENAI_DEVELOPMENT_PIN);
    expect(projection.rows).toHaveLength(2);
    expect(projection.rows.find((row) => row.sourceLineId === "usage-1")).toMatchObject({
      representation: "span_like",
      conformantSpan: false,
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.6-sol",
        "gen_ai.usage.input_tokens": 120,
        "gen_ai.usage.output_tokens": 30
      }
    });
    expect(projection.rows.find((row) => row.sourceLineId === "usage-aggregate")).toMatchObject({
      representation: "aggregate_record",
      conformantSpan: false
    });
    expect(projection.gaps.filter((gap) => gap.code === "financial_cost_not_projected"))
      .toHaveLength(2);
  });

  it("never relabels an observed/pricing model as an OTel requested model", () => {
    const receipt = createAgentEconomicsReceiptV0(localEstimateDraft({
      lines: [tokenLine({
        model: "observed-pricing-model",
        requestedModel: undefined
      })],
      mappingGaps: []
    }));
    const projection = projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(receipt);

    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]?.attributes).not.toHaveProperty("gen_ai.request.model");
    expect(JSON.stringify(projection)).not.toContain("observed-pricing-model");
    expect(projection.gaps).toContainEqual({
      code: "requested_model_unavailable",
      lineId: "usage-1"
    });
  });

  it("emits no invented Tokenomics rows before a specification is published", () => {
    const projection = projectAgentEconomicsReceiptV0ToTokenomics(mixedReceipt());

    expect(projection).toEqual({
      target: TOKENOMICS_TRACKING_PIN,
      receiptId: mixedReceipt().id,
      rows: [],
      gaps: [{ code: "technical_specification_not_published" }]
    });
  });

  it("validates receipts before any adapter can project them", () => {
    const receipt = mixedReceipt();
    const tampered = {
      ...receipt,
      costTotals: receipt.costTotals.map((total) => ({ ...total, amountUsd: 999 }))
    } as AgentEconomicsReceiptV0;

    expect(() => projectAgentEconomicsReceiptV0ToFocus(tampered, "focus_1_4")).toThrow();
    expect(() => projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(tampered)).toThrow();
    expect(() => projectAgentEconomicsReceiptV0ToTokenomics(tampered)).toThrow();
    expect(() => projectAgentEconomicsReceiptV0ToFocus(
      receipt,
      "unknown-focus-target" as never
    )).toThrow();
    expect(agentEconomicsReceiptV0Schema.safeParse(tampered).success).toBe(false);
  });
});
