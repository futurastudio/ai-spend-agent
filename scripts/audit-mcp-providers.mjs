#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeSpend,
  fetchProviderUsageRecords,
  redactSecrets
} from "../packages/core/dist/index.js";

const envPath = resolve(process.cwd(), process.argv[2] ?? ".env");
const envValues = parseEnv(await readFile(envPath, "utf8"));
const endTime = Math.floor(Date.now() / 1000);
const startTime = endTime - 7 * 24 * 60 * 60;
const providers = [
  ["openai", "OPENAI_ADMIN_KEY"],
  ["anthropic", "ANTHROPIC_ADMIN_KEY"]
];

for (const [provider, envName] of providers) {
  const secret = envValues[envName];
  if (!secret) {
    console.log(JSON.stringify({ provider, status: "missing-key-reference" }));
    continue;
  }

  try {
    const result = await fetchProviderUsageRecords({
      provider,
      authReference: `env:${envName}`,
      startTime,
      endTime,
      tokenResolver: () => secret
    });
    const summary = analyzeSpend(result.records);
    console.log(JSON.stringify({
      provider,
      status: "ok",
      records: result.records.length,
      totalUsd: summary.totalUsd,
      completeness: result.completeness,
      recordTypes: Object.fromEntries(
        Array.from(new Set(result.records.map((record) => record.providerCostType)))
          .sort()
          .map((type) => [type, result.records.filter((record) => record.providerCostType === type).length])
      ),
      pagination: result.qa.pagination.map((row) => ({
        label: row.label,
        pagesFetched: row.pagesFetched,
        stoppedBecause: row.stoppedBecause
      })),
      responseDrift: result.qa.responseDrift.length,
      responseDriftFields: Array.from(new Set(
        result.qa.responseDrift.map((issue) => issue.field.replace(/\[\d+\]/g, "[]"))
      )).sort(),
      rateLimitSignals: result.qa.rateLimits.length
    }));
  } catch (error) {
    console.log(JSON.stringify({
      provider,
      status: "error",
      message: sanitize(error instanceof Error ? error.message : String(error))
    }));
  }
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function sanitize(message) {
  let sanitized = message;
  for (const value of Object.values(envValues)) {
    if (value.length > 8) sanitized = sanitized.split(value).join("[REDACTED]");
  }
  return redactSecrets(sanitized);
}
