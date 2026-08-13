import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const contractPath = resolve(root, "provider-contracts/v1.json");
export const generatedDocPath = resolve(root, "docs/sources/provider-contracts.md");
export const generatedRuntimePath = resolve(root, "packages/core/src/providerContractStates.generated.ts");

const runtimeSourceIds = new Map([
  ["openai-platform", "openai"],
  ["anthropic-platform", "anthropic"],
  ["google-gemini", "gemini-cli"],
  ["cursor-admin", "cursor"],
  ["github-copilot", "github-copilot"]
]);

const allowedStates = new Set(["current", "stale_contract"]);
const allowedAvailability = new Set(["first_class", "experimental", "beta", "contract_only"]);
const allowedValidationTargets = new Set(["live_verified", "fixture_verified", "untested"]);
const requiredProviders = new Set(["openai", "anthropic", "google", "cursor", "github"]);
const officialHosts = new Set([
  "developers.openai.com",
  "platform.claude.com",
  "geminicli.com",
  "ai.google.dev",
  "docs.cloud.google.com",
  "cursor.com",
  "docs.github.com"
]);

export async function readProviderContracts() {
  return JSON.parse(await readFile(contractPath, "utf8"));
}

export function validateProviderContracts(value, now = new Date()) {
  const failures = [];
  if (!isObject(value) || value.schemaVersion !== 1) failures.push("schemaVersion must equal 1");
  if (!validDate(value?.reviewedAt)) failures.push("reviewedAt must be an ISO date");
  if (!positiveInteger(value?.defaultReviewCadenceDays) || value.defaultReviewCadenceDays > 90) {
    failures.push("defaultReviewCadenceDays must be a positive integer no greater than 90");
  }
  if (JSON.stringify(value?.statusVocabulary) !== JSON.stringify(["current", "stale_contract"])) {
    failures.push("statusVocabulary must remain [current, stale_contract]");
  }
  if (!Array.isArray(value?.contracts) || value.contracts.length === 0) {
    failures.push("contracts must be a non-empty array");
    return failures;
  }

  const ids = new Set();
  const providers = new Set();
  for (const [index, contract] of value.contracts.entries()) {
    const prefix = `contracts[${index}]`;
    if (!isObject(contract)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    if (!nonEmpty(contract.id)) failures.push(`${prefix}.id must be non-empty`);
    else if (ids.has(contract.id)) failures.push(`${prefix}.id is duplicated: ${contract.id}`);
    else ids.add(contract.id);
    if (!nonEmpty(contract.provider)) failures.push(`${prefix}.provider must be non-empty`);
    else providers.add(contract.provider);
    for (const field of [
      "label", "owner", "apiVersion", "auth", "pagination", "units", "currency",
      "window", "freshnessAndRevision", "financialBasis", "reconciliationAnchor"
    ]) {
      if (!nonEmpty(contract[field])) failures.push(`${prefix}.${field} must be non-empty`);
    }
    if (!allowedStates.has(contract.state)) failures.push(`${prefix}.state is invalid`);
    if (!allowedAvailability.has(contract.availability)) failures.push(`${prefix}.availability is invalid`);
    if (!allowedValidationTargets.has(contract.validationTarget)) failures.push(`${prefix}.validationTarget is invalid`);
    for (const field of ["endpoints", "exclusions", "resources"]) {
      if (!Array.isArray(contract[field]) || contract[field].length === 0) failures.push(`${prefix}.${field} must be non-empty`);
    }
    for (const field of ["endpoints", "exclusions"]) {
      if (Array.isArray(contract[field]) && !contract[field].every(nonEmpty)) {
        failures.push(`${prefix}.${field} must contain only non-empty strings`);
      }
    }
    if (!Array.isArray(contract.implementedEndpoints)) {
      failures.push(`${prefix}.implementedEndpoints must be an array (empty is allowed for contract-only sources)`);
    } else {
      for (const implementedEndpoint of contract.implementedEndpoints) {
        if (!nonEmpty(implementedEndpoint) || !Array.isArray(contract.endpoints) || !contract.endpoints.includes(implementedEndpoint)) {
          failures.push(`${prefix}.implementedEndpoints may only contain declared endpoint strings`);
        }
      }
    }
    const resources = Array.isArray(contract.resources) ? contract.resources : [];
    for (const [resourceIndex, resource] of resources.entries()) {
      const resourcePrefix = `${prefix}.resources[${resourceIndex}]`;
      if (!isObject(resource) || !nonEmpty(resource.kind)) failures.push(`${resourcePrefix}.kind must be non-empty`);
      let parsed;
      try {
        parsed = new URL(resource?.url);
      } catch {
        failures.push(`${resourcePrefix}.url must be a valid URL`);
      }
      if (parsed && (parsed.protocol !== "https:" || !officialHosts.has(parsed.hostname))) {
        failures.push(`${resourcePrefix}.url must use an approved official HTTPS host`);
      }
      if (!Array.isArray(resource?.requiredMarkers) || resource.requiredMarkers.length < 2 || !resource.requiredMarkers.every((marker) => nonEmpty(marker) && marker.trim().length >= 3)) {
        failures.push(`${resourcePrefix}.requiredMarkers must contain at least two meaningful strings`);
      }
      if (!/^[a-f0-9]{64}$/.test(resource?.semanticSha256 ?? "") && resource?.semanticSha256 !== "bootstrap") {
        failures.push(`${resourcePrefix}.semanticSha256 must be a lowercase SHA-256 digest`);
      }
      if (!/^[a-f0-9]{64}$/.test(resource?.contentSha256 ?? "")) {
        failures.push(`${resourcePrefix}.contentSha256 must be a reviewed lowercase SHA-256 digest`);
      }
    }
  }
  for (const provider of requiredProviders) {
    if (!providers.has(provider)) failures.push(`required provider contract is missing: ${provider}`);
  }

  const reviewedAt = Date.parse(`${value.reviewedAt}T00:00:00.000Z`);
  const cadenceMs = value.defaultReviewCadenceDays * 86_400_000;
  if (Number.isFinite(reviewedAt) && reviewedAt > now.getTime()) {
    failures.push(`provider contract review date is in the future; reviewedAt=${value.reviewedAt}`);
  }
  if (Number.isFinite(reviewedAt) && now.getTime() - reviewedAt > cadenceMs) {
    failures.push(`provider contract review is overdue; reviewedAt=${value.reviewedAt}`);
  }
  return failures;
}

export function providerContractStateFailures(value) {
  return value.contracts
    .filter((contract) => contract.state === "stale_contract")
    .map((contract) => `${contract.id}: declared provider contract state is stale_contract and requires human review`);
}

export async function inspectRemoteContracts(contracts, fetcher = fetch, timeoutMs = 15_000) {
  const observations = [];
  for (const contract of contracts.contracts) {
    for (const resource of contract.resources) {
      let response;
      try {
        response = await fetchWithTimeout(fetcher, resource.url, {
          headers: {
            "accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": "Mozilla/5.0 (compatible; aibill-provider-contract-monitor/0.8; +https://asktilden.com)"
          },
          redirect: "follow"
        }, timeoutMs);
      } catch (error) {
        observations.push({
          contractId: contract.id,
          provider: contract.provider,
          kind: resource.kind,
          url: resource.url,
          state: "stale_contract",
          error: `network error: ${singleLineError(error)}`
        });
        continue;
      }
      if (!response.ok) {
        observations.push({
          contractId: contract.id,
          provider: contract.provider,
          kind: resource.kind,
          url: resource.url,
          state: "stale_contract",
          error: `HTTP ${response.status} ${response.statusText}`
        });
        continue;
      }
      let body;
      try {
        body = await response.text();
      } catch (error) {
        observations.push({
          contractId: contract.id,
          provider: contract.provider,
          kind: resource.kind,
          url: resource.url,
          state: "stale_contract",
          error: `response read error: ${singleLineError(error)}`
        });
        continue;
      }
      const normalized = normalizeDocument(body);
      const missingMarkers = resource.requiredMarkers.filter((marker) => !normalized.includes(normalizeDocument(marker)));
      const semanticSha256 = semanticFingerprint(normalized, resource.requiredMarkers);
      const contentSha256 = sha256(normalized);
      const baselineMissing = resource.semanticSha256 === "bootstrap";
      const contentHashMissing = !/^[a-f0-9]{64}$/.test(resource.contentSha256 ?? "");
      const fingerprintChanged = !baselineMissing && semanticSha256 !== resource.semanticSha256;
      const contentChanged = !contentHashMissing && contentSha256 !== resource.contentSha256;
      observations.push({
        contractId: contract.id,
        provider: contract.provider,
        kind: resource.kind,
        url: resource.url,
        state: missingMarkers.length > 0 || fingerprintChanged || contentChanged || baselineMissing || contentHashMissing
          ? "stale_contract"
          : "current",
        contentSha256,
        semanticSha256,
        expectedSemanticSha256: resource.semanticSha256,
        expectedContentSha256: resource.contentSha256,
        missingMarkers,
        ...(baselineMissing ? { error: "reviewed semantic fingerprint is not pinned" } : {}),
        ...(contentHashMissing ? { error: "reviewed full-content fingerprint is not pinned" } : {}),
        ...(fingerprintChanged ? { error: "reviewed semantic fingerprint changed" } : {}),
        ...(contentChanged ? { error: "reviewed official page content changed" } : {})
      });
    }
  }
  return observations;
}

export function normalizeDocument(value) {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x3c;/gi, "<")
    .replace(/&#x3e;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function semanticFingerprint(normalizedDocument, markers) {
  const evidence = markers.map((marker) => {
    const normalizedMarker = normalizeDocument(marker);
    const index = normalizedDocument.indexOf(normalizedMarker);
    if (index < 0) return `missing:${normalizedMarker}`;
    const start = Math.max(0, index - 120);
    const end = Math.min(normalizedDocument.length, index + normalizedMarker.length + 240);
    return normalizedDocument.slice(start, end);
  });
  return sha256(evidence.join("\n"));
}

export function renderProviderContractDoc(contracts) {
  const lines = [
    "<!-- GENERATED by scripts/generate-provider-contract-docs.mjs. Do not edit by hand. -->",
    "",
    "# Provider financial contracts",
    "",
    `Contract schema v${contracts.schemaVersion}; reviewed ${contracts.reviewedAt}.`,
    "",
    "These contracts are the reviewed financial rulebook for each provider source. They do not imply that every declared surface is implemented, that a user's account was connected, or that an invoice reconciled. Implemented connector coverage is listed separately. Provider-reported cost, API-equivalent value, plan context, credits and final invoices remain separate.",
    "",
    "| Source | Launch state | Validation target | Financial basis | Reconciliation anchor |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const contract of contracts.contracts) {
    lines.push(`| ${escapeCell(contract.label)} | \`${contract.availability}\` / \`${contract.state}\` | \`${contract.validationTarget}\` | \`${contract.financialBasis}\` | ${escapeCell(contract.reconciliationAnchor)} |`);
  }
  for (const contract of contracts.contracts) {
    lines.push(
      "",
      `## ${contract.label}`,
      "",
      `- Contract ID: \`${contract.id}\``,
      `- Owner: \`${contract.owner}\``,
      `- Authentication: ${contract.auth}`,
      `- API/version: ${contract.apiVersion}`,
      `- Window: ${contract.window}`,
      `- Pagination/completeness: ${contract.pagination}`,
      `- Units: ${contract.units}`,
      `- Currency/basis: ${contract.currency}`,
      `- Freshness/revisions: ${contract.freshnessAndRevision}`,
      `- Reconciliation: ${contract.reconciliationAnchor}`,
      "- Endpoints/evidence surfaces:"
    );
    for (const endpoint of contract.endpoints) lines.push(`  - \`${endpoint}\``);
    lines.push("- Implemented connector coverage:");
    if (contract.implementedEndpoints.length === 0) {
      lines.push("  - None; this is a reviewed target contract only.");
    } else {
      for (const endpoint of contract.implementedEndpoints) lines.push(`  - \`${endpoint}\``);
    }
    lines.push("- Exclusions:");
    for (const exclusion of contract.exclusions) lines.push(`  - ${exclusion}`);
    lines.push("- Official sources:");
    for (const resource of contract.resources) lines.push(`  - [${resource.kind}](${resource.url}) — semantic \`${resource.semanticSha256}\`; reviewed content \`${resource.contentSha256}\``);
  }
  lines.push(
    "",
    "## Drift behavior",
    "",
    "The daily workflow checks required semantics and reviewed normalized-page fingerprints, records the current page hashes, runs provider structural fixtures, and opens or updates a GitHub issue if a contract drifts. Any official-page change is intentionally triaged by a human; the monitor never changes pricing or financial behavior automatically. Until review lands, the contract is `stale_contract` and the affected source cannot be promoted as financially verified in a new release.",
    ""
  );
  return lines.join("\n");
}

export function renderProviderContractRuntime(contracts) {
  const entries = contracts.contracts
    .filter((contract) => runtimeSourceIds.has(contract.id))
    .map((contract) => [runtimeSourceIds.get(contract.id), contract.state])
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length !== runtimeSourceIds.size) {
    throw new Error("Every runtime source must have a provider contract mapping.");
  }
  return [
    "// GENERATED by scripts/generate-provider-contract-docs.mjs. Do not edit by hand.",
    "",
    "export const generatedProviderContractStates = {",
    ...entries.map(([id, state]) => `  ${JSON.stringify(id)}: ${JSON.stringify(state)},`),
    "} as const;",
    ""
  ].join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchWithTimeout(fetcher, url, init, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(fetcher(url, { ...init, signal: controller.signal })),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function singleLineError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "unknown error";
}
