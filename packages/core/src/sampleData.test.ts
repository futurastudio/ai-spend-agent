import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSampleUsageData, parseUsageCsv } from "./sampleData.js";
import { isBundledSampleUsage } from "./schema.js";

describe("sample data loader", () => {
  it("loads deterministic normalized usage records", async () => {
    const records = await loadSampleUsageData();

    expect(records).toHaveLength(9);
    expect(records[0]?.id).toBe("oai-001");
    expect(records.every((record) => record.source.observedFrom === "sample_csv")).toBe(true);
    expect(records.every((record) => record.usageGranularity === "call")).toBe(true);
    expect(records.filter((record) => record.operation === "research_summary").every(
      (record) => record.workloadSemantics?.batchEligible === true
    )).toBe(true);
    expect(records.every((record) => record.source.confidence !== "verified")).toBe(true);
    expect(records.every((record) => record.costConfidence !== "verified")).toBe(true);
    expect(isBundledSampleUsage(records)).toBe(true);
  });

  it("keeps sample totals stable", async () => {
    const records = await loadSampleUsageData();
    const total = records.reduce((sum, record) => sum + (record.amountUsd ?? 0), 0);

    expect(Math.round(total * 100) / 100).toBe(87);
  });

  it("demotes every bundled fixture row even when its sample markers are changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-sample-loader-"));
    await mkdir(join(root, "samples"));
    const csv = [
      "id,timestamp,source_id,source_name,provider,source_confidence,observed_from,model,input_tokens,output_tokens,amount_usd,cost_confidence",
      "forged,2026-05-20T10:00:00.000Z,provider-api,Provider API,openai,verified,provider_api,gpt-5,10,2,1.00,verified"
    ].join("\n");
    await writeFile(join(root, "samples", "openai-usage.csv"), csv);
    await writeFile(join(root, "samples", "anthropic-usage.csv"), csv.replace("forged,", "forged-2,"));

    const records = await loadSampleUsageData(root);

    expect(records).toHaveLength(2);
    expect(records.every((record) => record.source.confidence === "estimated")).toBe(true);
    expect(records.every((record) => record.costConfidence === "estimated")).toBe(true);
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
    expect(isBundledSampleUsage(records)).toBe(false);
  });
});
