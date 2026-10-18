import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  inspectRemoteContracts,
  normalizeDocument,
  providerContractStateFailures,
  readProviderContracts,
  renderProviderContractDoc,
  renderProviderContractRuntime,
  resourceAlertClass,
  semanticFingerprint,
  validateProviderContracts
} from "./provider-contract-lib.mjs";

test("the public provider contract matrix is structurally complete", async () => {
  const contracts = await readProviderContracts();
  assert.deepEqual(validateProviderContracts(contracts, new Date(`${contracts.reviewedAt}T12:00:00.000Z`)), []);
  assert.deepEqual(new Set(contracts.contracts.map((entry) => entry.provider)), new Set(["openai", "anthropic", "google", "cursor", "github"]));
  assert.equal(contracts.contracts.find((entry) => entry.id === "cursor-admin")?.endpoints.includes("POST /teams/filtered-usage-events"), true);
  assert.equal(contracts.contracts.find((entry) => entry.id === "github-copilot")?.endpoints.includes("GET /organizations/{org}/settings/billing/ai_credit/usage"), true);
});

test("review cadence expires to stale rather than silently retaining current", async () => {
  const contracts = await readProviderContracts();
  const overdueAt = new Date(Date.parse(`${contracts.reviewedAt}T00:00:00.000Z`)
    + (contracts.defaultReviewCadenceDays + 1) * 86_400_000);
  assert.match(validateProviderContracts(contracts, overdueAt).join("\n"), /review is overdue/);
});

test("review metadata and contract arrays reject implausible future edits", async () => {
  const contracts = structuredClone(await readProviderContracts());
  contracts.reviewedAt = "2099-12-31";
  contracts.defaultReviewCadenceDays = 999_999_999;
  contracts.contracts[0].endpoints = [null];
  contracts.contracts[0].exclusions = [42];
  contracts.contracts[0].resources[0].requiredMarkers = ["a", "b"];
  const failures = validateProviderContracts(contracts, new Date("2026-08-13T12:00:00.000Z")).join("\n");
  assert.match(failures, /review date is in the future/);
  assert.match(failures, /no greater than 90/);
  assert.match(failures, /endpoints must contain only non-empty strings/);
  assert.match(failures, /exclusions must contain only non-empty strings/);
  assert.match(failures, /meaningful strings/);
});

test("a declared stale contract blocks release and reaches generated runtime state", async () => {
  const contracts = structuredClone(await readProviderContracts());
  contracts.contracts.find((entry) => entry.id === "openai-platform").state = "stale_contract";
  assert.match(providerContractStateFailures(contracts).join("\n"), /openai-platform.*stale_contract/);
  assert.match(renderProviderContractRuntime(contracts), /"openai": "stale_contract"/);
});

test("semantic drift fails closed while recording a non-secret content hash", async () => {
  // The padding keeps the claim added below outside every marker's semantic window.
  const padding = "unchanged ".repeat(100);
  const baselineBody = `<main>inclusive total and final invoice ${padding}</main>`;
  const baselineNormalized = normalizeDocument(baselineBody);
  const contracts = {
    schemaVersion: 1,
    contracts: [{
      id: "fixture",
      provider: "fixture",
      resources: [{
        kind: "contract",
        url: "https://developers.openai.com/fixture",
        requiredMarkers: ["inclusive total", "final invoice"],
        semanticSha256: semanticFingerprint(baselineNormalized, ["inclusive total", "final invoice"]),
        contentSha256: createHash("sha256").update(baselineNormalized).digest("hex")
      }]
    }]
  };
  const current = await inspectRemoteContracts(contracts, async () => new Response(baselineBody));
  assert.equal(current[0].state, "current");
  assert.match(current[0].contentSha256, /^[a-f0-9]{64}$/);

  const drift = await inspectRemoteContracts(contracts, async () => new Response("<main>inclusive total only</main>"));
  assert.equal(drift[0].state, "stale_contract");
  assert.deepEqual(drift[0].missingMarkers, ["final invoice"]);

  const distantClaimDrift = await inspectRemoteContracts(
    contracts,
    async () => new Response(`<main>inclusive total and final invoice ${padding}credits are final cash settlement</main>`)
  );
  assert.equal(distantClaimDrift[0].state, "stale_contract");
  assert.deepEqual(distantClaimDrift[0].missingMarkers, []);
  assert.equal(distantClaimDrift[0].semanticSha256, distantClaimDrift[0].expectedSemanticSha256);
  assert.equal(distantClaimDrift[0].error, "reviewed official page content changed");
});

test("a changed semantic fingerprint is reported even when the whole page changed too", async () => {
  const markers = ["inclusive total", "final invoice"];
  const baselineNormalized = normalizeDocument("<main>inclusive total and final invoice</main>");
  const contracts = {
    contracts: [{
      id: "fixture",
      provider: "fixture",
      resources: [{
        kind: "contract",
        url: "https://developers.openai.com/fixture",
        requiredMarkers: markers,
        semanticSha256: semanticFingerprint(baselineNormalized, markers),
        contentSha256: createHash("sha256").update(baselineNormalized).digest("hex")
      }]
    }]
  };
  const [observation] = await inspectRemoteContracts(contracts, async () => new Response("<main>inclusive total, api_source and final invoice</main>"));
  assert.equal(observation.state, "stale_contract");
  assert.notEqual(observation.contentSha256, observation.expectedContentSha256);
  assert.equal(observation.error, "reviewed semantic fingerprint changed");
});

test("alert classes default from the resource kind and are rendered when declared", async () => {
  const contracts = await readProviderContracts();
  assert.equal(resourceAlertClass({ kind: "contract" }), "api_contract");
  assert.equal(resourceAlertClass({ kind: "pricing" }), "pricing");
  assert.equal(resourceAlertClass({ kind: "reconciliation" }), "reconciliation");
  assert.equal(resourceAlertClass({ kind: "contract", alertClass: "financial_schema" }), "financial_schema");
  const output = renderProviderContractDoc(contracts);
  assert.match(output, /\[contract\]\(https:\/\/developers\.openai\.com\/api\/reference\/resources\/admin\/subresources\/organization\/subresources\/usage\) — alert class `financial_schema`;/);
  assert.match(output, /Each drifted official page gets its own GitHub issue/);
  assert.match(output, /\| `financial_schema` .* \| P0 \| P1 \| P1 \|/);
});

test("network failure becomes stale_contract and still yields a reportable observation", async () => {
  const contracts = {
    contracts: [{
      id: "fixture",
      provider: "fixture",
      resources: [{
        kind: "contract",
        url: "https://developers.openai.com/fixture",
        requiredMarkers: ["one", "two"],
        semanticSha256: "0".repeat(64),
        contentSha256: "0".repeat(64)
      }]
    }]
  };
  const observations = await inspectRemoteContracts(contracts, async () => {
    throw new Error("temporary DNS failure\nwith controls\u0000");
  });
  assert.deepEqual(observations, [{
    contractId: "fixture",
    provider: "fixture",
    kind: "contract",
    url: "https://developers.openai.com/fixture",
    state: "stale_contract",
    error: "network error: temporary DNS failure with controls"
  }]);
});

test("remote checks time out and fail closed instead of hanging CI", async () => {
  const contracts = {
    contracts: [{
      id: "fixture",
      provider: "fixture",
      resources: [{
        kind: "contract",
        url: "https://developers.openai.com/fixture",
        requiredMarkers: ["one", "two"],
        semanticSha256: "0".repeat(64),
        contentSha256: "0".repeat(64)
      }]
    }]
  };
  const observations = await inspectRemoteContracts(contracts, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }), 20);
  assert.equal(observations[0].state, "stale_contract");
  assert.match(observations[0].error, /^network error:/);
});

test("malformed resource containers report failures without throwing", async () => {
  const contracts = structuredClone(await readProviderContracts());
  contracts.contracts[0].resources = {};
  assert.doesNotThrow(() => validateProviderContracts(contracts));
  assert.match(validateProviderContracts(contracts).join("\n"), /resources must be non-empty/);
});

test("generated matrix keeps readiness and financial basis distinct", async () => {
  const contracts = await readProviderContracts();
  const output = renderProviderContractDoc(contracts);
  assert.match(output, /do not imply .*that a user's account was connected/);
  assert.match(output, /Implemented connector coverage/);
  assert.match(output, /reviewed target contract only/);
  assert.match(output, /provider_reported_accrued_cost/);
  assert.match(output, /api_equivalent_value_until_billing_export/);
  assert.match(output, /stale_contract/);
});
