import { describe, expect, it } from "vitest";
import { loadSampleUsageData, parseUsageCsv } from "./sampleData.js";

describe("sample data loader", () => {
  it("loads deterministic normalized usage records", async () => {
    const records = await loadSampleUsageData();

    expect(records).toHaveLength(9);
    expect(records[0]?.id).toBe("oai-001");
    expect(records.every((record) => record.source.observedFrom === "sample_csv")).toBe(true);
  });

  it("keeps sample totals stable", async () => {
    const records = await loadSampleUsageData();
    const total = records.reduce((sum, record) => sum + (record.amountUsd ?? 0), 0);

    expect(Math.round(total * 100) / 100).toBe(87);
  });

  it("parses missing costs without inventing spend", () => {
    const records = parseUsageCsv(
      [
        "id,timestamp,source_id,source_name,provider,source_confidence,observed_from,model,input_tokens,output_tokens,amount_usd,cost_confidence,client_id,project_id,agent_id,operation",
        "missing-1,2026-05-20T10:00:00.000Z,local,Local signal,local,missing,unit_test,gpt-4.1,1,1,,missing,,,,"
      ].join("\n")
    );

    expect(records[0]?.amountUsd).toBeNull();
    expect(records[0]?.costConfidence).toBe("missing");
  });
});
