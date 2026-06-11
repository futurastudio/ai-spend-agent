import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { usageRecordSchema, type UsageRecord } from "./schema.js";

// One level up from dist/ = the package root, where samples/ ships (see
// "files" in package.json). Must survive npm installation — never resolve
// relative to the repo.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const sampleFiles = [
  "samples/openai-usage.csv",
  "samples/anthropic-usage.csv"
] as const;

type CsvRow = Record<string, string>;

export async function loadSampleUsageData(rootDir = packageRoot): Promise<UsageRecord[]> {
  const records = await Promise.all(
    sampleFiles.map((file) => loadUsageCsv(resolve(rootDir, file)))
  );

  return records.flat().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

async function loadUsageCsv(path: string): Promise<UsageRecord[]> {
  const contents = await readFile(path, "utf8");
  return parseUsageCsv(contents);
}

export function parseUsageCsv(contents: string): UsageRecord[] {
  const lines = contents.trim().split(/\r?\n/).filter(Boolean);
  const [headerLine, ...recordLines] = lines;
  if (!headerLine) {
    return [];
  }

  const headers = headerLine.split(",").map((header) => header.trim());
  return recordLines.map((line) => {
    const values = line.split(",");
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index]?.trim() ?? ""])
    ) as CsvRow;

    return usageRecordSchema.parse({
      id: row.id,
      timestamp: row.timestamp,
      source: {
        id: row.source_id,
        name: row.source_name,
        provider: row.provider,
        confidence: row.source_confidence,
        observedFrom: row.observed_from
      },
      model: row.model,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      amountUsd: row.amount_usd === "" ? null : Number(row.amount_usd),
      costConfidence: row.cost_confidence,
      clientId: optionalValue(row.client_id),
      projectId: optionalValue(row.project_id),
      agentId: optionalValue(row.agent_id),
      userId: optionalValue(row.user_id),
      workspaceId: optionalValue(row.workspace_id),
      apiKeyId: optionalValue(row.api_key_id),
      operation: optionalValue(row.operation)
    });
  });
}

function optionalValue(value: string): string | undefined {
  return value === "" ? undefined : value;
}
