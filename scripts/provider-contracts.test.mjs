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

test("financial-schema markers catch one added OpenAI Costs result field", async () => {
  const contracts = await readProviderContracts();
  const resource = contracts.contracts.find((entry) => entry.id === "openai-platform")
    .resources.find((entry) => resourceAlertClass(entry) === "financial_schema");
  const endpointMarkers = [
    "GET /organization/usage/completions",
    "including cached and cache-write tokens",
    "across text, audio, and image outputs",
    "GET /organization/costs"
  ];
  for (const marker of [...endpointMarkers, "OrganizationCostsResult object {", "OrganizationUsageCompletionsResult object {"]) {
    assert.ok(resource.requiredMarkers.includes(marker), `missing required marker: ${marker}`);
  }
  // The reference page summarizes each result object as `{ first three fields, N more }`
  // before documenting its fields. The padding keeps each result object outside the
  // endpoint-list windows, as on the real page.
  const padding = "unchanged ".repeat(40);
  const costFields = ["object", "amount", "api_key_id", "api_source", "line_item", "project_id", "quantity", "quantity_unit", "user_id"];
  const page = (fields) => [
    "<nav><li>Completions GET /organization/usage/completions</li><li>Costs GET /organization/costs</li><li>Embeddings GET /organization/usage/embeddings</li></nav>",
    `<main>${padding}`,
    "<h4>OrganizationUsageCompletionsResult object { input_tokens, num_model_requests, object, 22 more }</h4>",
    "<p>input_tokens: integer, including cached and cache-write tokens.</p>",
    "<p>output_tokens: integer, across text, audio, and image outputs.</p>",
    // The connector reads these fields, so each one is a reviewed claim.
    "<p>api_source: optional string or null. input_cache_write_12h_tokens: optional integer. input_cache_write_30m_tokens: optional integer or null.</p>",
    padding,
    `<h4>OrganizationCostsResult object { ${fields.slice(0, 3).join(", ")}, ${fields.length - 3} more }</h4>`,
    "<p>amount: optional object { currency, value }. currency: optional string Lowercase ISO-4217 currency. value : optional number The numeric value of the cost.</p>",
    ...fields.map((field) => `<p>${field}: documented field of the grouped costs result.</p>`),
    "<p>user_id: optional string or null. When group_by=user_id, this field provides the user ID of the grouped costs result.</p>",
    "</main>"
  ].join("\n");
  const reviewed = normalizeDocument(page(costFields));
  const oneMoreField = normalizeDocument(page([...costFields, "region"]));
  assert.notEqual(semanticFingerprint(oneMoreField, resource.requiredMarkers), semanticFingerprint(reviewed, resource.requiredMarkers));
  // The endpoint-list markers alone never see a new result field.
  assert.equal(semanticFingerprint(oneMoreField, endpointMarkers), semanticFingerprint(reviewed, endpointMarkers));

  const fixture = {
    contracts: [{
      id: "openai-platform",
      provider: "openai",
      resources: [{
        ...resource,
        semanticSha256: semanticFingerprint(reviewed, resource.requiredMarkers),
        contentSha256: createHash("sha256").update(reviewed).digest("hex")
      }]
    }]
  };
  const [observation] = await inspectRemoteContracts(fixture, async () => new Response(page([...costFields, "region"])));
  assert.equal(observation.state, "stale_contract");
  assert.deepEqual(observation.missingMarkers, []);
  assert.equal(observation.error, "reviewed semantic fingerprint changed");
});

test("normalizeDocument strips markup but keeps a bare < comparison as text", () => {
  assert.equal(
    normalizeDocument("<!doctype html><p class=\"x\">A <= b<br>and C > d</p><!-- note --><?xml version=\"1.0\"?>"),
    "a <= b and c > d"
  );
  // Angle-bracket placeholders still read as tags; encoded comparisons are decoded after stripping.
  assert.equal(normalizeDocument("~/.gemini/tmp/<project_hash>/chats/ &lt;= 1"), "~/.gemini/tmp/ /chats/ <= 1");
});

test("Gemini pricing markers anchor on the priced gemini-2.5-pro rows of the Markdown mirror and keep its literal <=", async () => {
  const contracts = await readProviderContracts();
  const resource = contracts.contracts.find((entry) => entry.id === "google-gemini")
    .resources.find((entry) => entry.kind === "pricing");
  assert.equal(resource.url, "https://aistudio.google.com/docs/pricing.md");
  const genericMarkers = ["Output price (including thinking tokens)", "Context caching price", "Paid Tier, per 1M tokens in USD"];
  for (const marker of [...genericMarkers, "gemini-2.5-pro", "$10.00, prompts <= 200k tokens", "$15.00, prompts > 200k", "Gemini 3.8 Flash rates"]) {
    assert.ok(resource.requiredMarkers.includes(marker), `missing required marker: ${marker}`);
  }
  // The Markdown mirror lists newer models first, as the real page does. Their rows
  // are what the generic markers anchor on; the padding keeps the priced model
  // outside their windows. The tables write "prompts <= 200k tokens" with a literal
  // "<", which normalizeDocument keeps as text.
  const padding = "unchanged ".repeat(60);
  const table = (rows) => ["{% table %}", "* Feature", "* Free Tier", "* Paid Tier, per 1M tokens in USD", ...rows.flatMap((row) => ["---", ...row]), "{% /table %}"].join("\n");
  const page = (outputAbove200k) => [
    "# Gemini Developer API pricing",
    "## Gemini 4 Argon  {% id=\"gemini-4-argon\" %}",
    table([
      ["* Input price", "* Not available", "* $2.00 through November 30, 2026.   \n  $4.00 starting December 1, 2026."],
      ["* Output price (including thinking tokens)", "* Not available", "* $10.00 through November 30, 2026.   \n  $20.00 starting December 1, 2026."],
      ["* Context caching price", "* Not available", "* $0.10 through November 30, 2026.   \n  $0.20 starting December 1, 2026."]
    ]),
    padding,
    "## Gemini 3.8 Flash  {% id=\"gemini-3.8-flash\" %}",
    table([
      ["* Input price", "* Free of charge", "* $0.75 through December 31, 2026.   \n  $1.50 starting January 1, 2027."],
      ["* Output price (including thinking tokens)", "* Free of charge", "* $3.75 through December 31, 2026.   \n  $7.50 starting January 1, 2027."],
      ["* Context caching price", "* Free of charge", "* $0.075 through December 31, 2026.   \n  $0.15 starting January 1, 2027."]
    ]),
    padding,
    "## Gemini 2.5 Pro  {% id=\"gemini-2.5-pro\" %}",
    "*[`gemini-2.5-pro`](/docs/models/gemini-2.5-pro)*",
    "{% callout type=\"caution\" %}\nGemini 2.5 Pro (`gemini-2.5-pro`) is deprecated. Effective December 1, 2026, all API requests to `gemini-2.5-pro` will automatically route to Gemini 3.8 Flash and be billed at Gemini 3.8 Flash rates.\n{% /callout %}",
    table([
      ["* Input price", "* Free of charge", "* $1.25, prompts <= 200k tokens    \n  $2.50, prompts > 200k tokens"],
      ["* Output price (including thinking tokens)", "* Free of charge", `* $10.00, prompts <= 200k tokens    \n  ${outputAbove200k}, prompts > 200k`],
      ["* Context caching price", "* Not available", "* $0.125, prompts <= 200k tokens    \n  $0.25, prompts > 200k    \n  $4.50 / 1,000,000 tokens per hour (storage price)"]
    ]),
    padding
  ].join("\n");
  const reviewed = normalizeDocument(page("$15.00"));
  const repriced = normalizeDocument(page("$16.00"));
  // Both tiers of every priced row survive normalization, so each is a claim.
  assert.ok(reviewed.includes(normalizeDocument("$10.00, prompts <= 200k tokens $15.00, prompts > 200k")));
  // The generic markers alone never see a gemini-2.5-pro price change.
  assert.equal(semanticFingerprint(repriced, genericMarkers), semanticFingerprint(reviewed, genericMarkers));
  assert.notEqual(semanticFingerprint(repriced, resource.requiredMarkers), semanticFingerprint(reviewed, resource.requiredMarkers));

  const fixture = {
    contracts: [{
      id: "google-gemini",
      provider: "google",
      resources: [{
        ...resource,
        semanticSha256: semanticFingerprint(reviewed, resource.requiredMarkers),
        contentSha256: createHash("sha256").update(reviewed).digest("hex")
      }]
    }]
  };
  const [current] = await inspectRemoteContracts(fixture, async () => new Response(page("$15.00")));
  assert.equal(current.state, "current");
  assert.deepEqual(current.missingMarkers, []);
  const [observation] = await inspectRemoteContracts(fixture, async () => new Response(page("$16.00")));
  assert.equal(observation.state, "stale_contract");
  assert.deepEqual(observation.missingMarkers, ["$15.00, prompts > 200k"]);
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
