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
  for (const marker of [...endpointMarkers, "OrganizationCostsResult", "OrganizationUsageCompletionsResult"]) {
    assert.ok(resource.requiredMarkers.includes(marker), `missing required marker: ${marker}`);
  }
  // The reference page lists the usage result objects, then summarizes each one as
  // `{ first three fields, N more }` before documenting its fields. The markers first match
  // in that list, and the summary has to stay inside their window. The padding keeps each
  // result object outside the endpoint-list windows, as on the real page.
  const padding = "unchanged ".repeat(40);
  const costFields = ["object", "amount", "api_key_id", "api_source", "line_item", "project_id", "quantity", "quantity_unit", "user_id"];
  const page = (fields, completionsMore = 22) => [
    "<nav><li>Completions GET /organization/usage/completions</li><li>Costs GET /organization/costs</li><li>Embeddings GET /organization/usage/embeddings</li></nav>",
    `<main>${padding}`,
    "<p>results: array of OrganizationUsageCompletionsResult or OrganizationUsageEmbeddingsResult or OrganizationUsageModerationsResult or 8 more. One of the following:</p>",
    `<h4>OrganizationUsageCompletionsResult { input_tokens, num_model_requests, object, ${completionsMore} more }</h4>`,
    "<p>input_tokens: integer, including cached and cache-write tokens.</p>",
    "<p>output_tokens: integer, across text, audio, and image outputs.</p>",
    // The connector reads these fields, so each one is a reviewed claim.
    "<p>api_source: optional string or null. input_cache_write_12h_tokens: optional integer. input_cache_write_30m_tokens: optional integer or null.</p>",
    padding,
    `<h4>OrganizationCostsResult { ${fields.slice(0, 3).join(", ")}, ${fields.length - 3} more }</h4>`,
    "<p>amount: optional { currency, value }. currency: optional string Lowercase ISO-4217 currency. value: optional number The numeric value of the cost.</p>",
    ...fields.map((field) => `<p>${field}: documented field of the grouped costs result.</p>`),
    "<p>user_id: optional string or null. When group_by=user_id, this field provides the user ID of the grouped costs result.</p>",
    "</main>"
  ].join("\n");
  const reviewed = normalizeDocument(page(costFields));
  const oneMoreField = normalizeDocument(page([...costFields, "region"]));
  assert.notEqual(semanticFingerprint(oneMoreField, resource.requiredMarkers), semanticFingerprint(reviewed, resource.requiredMarkers));
  assert.notEqual(semanticFingerprint(normalizeDocument(page(costFields, 23)), resource.requiredMarkers), semanticFingerprint(reviewed, resource.requiredMarkers));
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

test("reference markers catch one added Anthropic result field, on the cost report and on Messages usage", async () => {
  const contracts = await readProviderContracts();
  const resources = contracts.contracts.find((entry) => entry.id === "anthropic-platform").resources;
  const padding = "unchanged ".repeat(40);
  // The reference shows one example result, twice. `speed` reached production as one more line of it.
  const page = (head, middle, tail) => {
    const example = `{ "data" : [ { "ending_at" : "2025-08-02T00:00:00Z" , "results" : [ { ${head}${middle}${tail} } ], "starting_at" : "2025-08-01T00:00:00Z" } ], "has_more" : true }`;
    return normalizeDocument(`<main>${padding} response 200 ${example} returns examples response 200 ${example} ${padding}</main>`);
  };
  const costReport = resources.find((entry) => entry.url.endsWith("/cost_report/retrieve"));
  const messages = resources.find((entry) => entry.url.endsWith("/usage_report/retrieve_messages"));
  for (const [resource, head, tail] of [
    [costReport,
      `"amount" : "123.78912" , "context_window" : "0-200k" , "cost_type" : "tokens" , "currency" : "USD" , "description" : "Sample Usage - Input Tokens" , `,
      `"inference_geo" : "global" , "model" : "sample-model" , "service_tier" : "standard" , "speed" : "standard" , "token_type" : "uncached_input_tokens" , "workspace_id" : "wrkspc_sample"`],
    [messages,
      `"account_id" : "user_sample" , "api_key_id" : "apikey_sample" , "cache_creation" : { "ephemeral_1h_input_tokens" : 0 , "ephemeral_5m_input_tokens" : 0 }, "cache_read_input_tokens" : 200 , "context_window" : "0-200k" , `,
      `"inference_geo" : "global" , "model" : "sample-model" , "output_tokens" : 500 , "server_tool_use" : { "web_search_requests" : 10 }, "service_account_id" : "svac_sample" , "service_tier" : "standard" , "speed" : "standard" , "uncached_input_tokens" : 1500 , "workspace_id" : "wrkspc_sample"`]
  ]) {
    const reviewed = semanticFingerprint(page(head, "", tail), resource.requiredMarkers);
    assert.notEqual(semanticFingerprint(page(head, `"billing_region" : "us" , `, tail), resource.requiredMarkers), reviewed, `${resource.kind}: a field in the middle`);
    assert.notEqual(semanticFingerprint(page(head, "", `${tail} , "zone" : "us"`), resource.requiredMarkers), reviewed, `${resource.kind}: a field at the end`);
  }
});

test("no marker depends on how a docs generator spaces its punctuation", async () => {
  // OpenAI's generator dropped the space before every colon and comma on 2026-11-06 and took `object`
  // out of its summaries. Nothing else on the page changed, yet markers written against the old
  // rendering went missing, which on this page raises a P0. Anchor on words.
  const contracts = await readProviderContracts();
  for (const contract of contracts.contracts) {
    for (const resource of contract.resources) {
      for (const marker of resource.requiredMarkers) {
        assert.doesNotMatch(marker, /\s[:,]\s|\bobject \{/, `${contract.id} ${resource.kind}: ${marker}`);
      }
    }
  }
});

test("reference markers catch a changed Claude Code date, money unit, row field or tool", async () => {
  const contracts = await readProviderContracts();
  const resource = contracts.contracts.find((entry) => entry.id === "anthropic-platform")
    .resources.find((entry) => entry.url.endsWith("/usage_report/retrieve_claude_code"));
  const padding = "unchanged ".repeat(40);
  const row = ({ date = "2025-08-08T00:00:00Z", amount = "186", middle = "", tools = "", end = "" } = {}) =>
    `"actor" : { "email_address" : "user@example.com" , "type" : "user_actor" }, "core_metrics" : { "commits_by_claude_code" : 8 , "lines_of_code" : { "added" : 342 , "removed" : 128 }, "num_sessions" : 15 , "pull_requests_by_claude_code" : 2 }, "customer_type" : "api" , "date" : "${date}" , "is_remote" : false , ${middle}"model_breakdown" : [ { "estimated_cost" : { "amount" : ${amount} , "currency" : "USD" }, "model" : "sample-model" , "tokens" : { "cache_creation" : 2340 , "cache_read" : 8790 , "input" : 45230 , "output" : 12450 } } ], "organization_id" : "org_sample" , "terminal_type" : "iterm.app" , "tool_actions" : { "edit_tool" : { "accepted" : 25 , "rejected" : 3 }, ${tools}"write_tool" : { "accepted" : 8 , "rejected" : 0 } }, "subscription_type" : "enterprise"${end}`;
  const page = (options) => normalizeDocument(`<main>${padding} returns betaclaudecodeusagereport object { data , has_more , next_page } ${padding} response 200 { "data" : [ { ${row(options)} } ], "has_more" : true } ${padding}</main>`);
  const reviewed = semanticFingerprint(page(), resource.requiredMarkers);
  for (const [label, options] of [
    ["the date form the reader depends on", { date: "2025-08-08" }],
    ["the money unit", { amount: "\"1.86\"" }],
    ["a field in the middle of the row", { middle: "\"billing_region\" : \"us\" , " }],
    ["a new tool", { tools: "\"web_tool\" : { \"accepted\" : 1 , \"rejected\" : 0 }, " }],
    ["a field at the end of the row", { end: " , \"zone\" : \"us\"" }]
  ]) {
    assert.notEqual(semanticFingerprint(page(options), resource.requiredMarkers), reviewed, label);
  }
});

test("the rule that Claude bills the full context window flat is a reviewed claim", async () => {
  // The estimator's flat Claude rates depend on this sentence, which sat outside every window.
  const contracts = await readProviderContracts();
  const { requiredMarkers } = contracts.contracts.find((entry) => entry.id === "anthropic-platform")
    .resources.find((entry) => entry.kind === "pricing");
  const padding = "unchanged ".repeat(40);
  const page = (rule) => normalizeDocument(`<main>${padding} Claude 4.6 and later models include the full 1M token context window ${rule}. ${padding}</main>`);
  assert.notEqual(semanticFingerprint(page("at a premium"), requiredMarkers), semanticFingerprint(page("at standard pricing"), requiredMarkers));
  assert.ok(requiredMarkers.includes("include the full 1M token context window at standard pricing"));
});

test("every rate the Anthropic pricing page publishes for a priced model sits inside a semantic window", async () => {
  const contracts = await readProviderContracts();
  const { requiredMarkers } = contracts.contracts.find((entry) => entry.id === "anthropic-platform")
    .resources.find((entry) => entry.kind === "pricing");
  // The standard table as published on 2026-11-06, in page order. A rate no window covers is
  // a real price change the checker would file as noise: Haiku 4.5 and Opus 4.5 were, until now.
  const rows = [
    "Claude Fable 5.1 for demanding reasoning and long-horizon agentic work $10 / MTok $50 / MTok $12.50 / MTok $20 / MTok $0.25 / MTok",
    "Claude Opus 5.5 for long-running agentic coding and knowledge work $4 / MTok $20 / MTok $5 / MTok $8 / MTok $0.20 / MTok",
    "Claude Sonnet 5.5 The best combination of speed and intelligence $2 / MTok $10 / MTok $2.50 / MTok $4 / MTok $0.10 / MTok",
    "Claude Haiku 5.5 for high-volume, latency-sensitive tasks such as classification, extraction, and routing",
    "$0.10 / MTok for prompts up to 100,000 tokens $0.50 / MTok $0.125 / MTok $0.20 / MTok $0.01 / MTok",
    "$0.50 / MTok for prompts over 100,000 tokens $2.50 / MTok $0.625 / MTok $1 / MTok $0.05 / MTok",
    "Additional models",
    "Claude Mythos 5.1 $10 / MTok $50 / MTok $12.50 / MTok $20 / MTok $0.25 / MTok",
    "Claude Fable 5 $10 / MTok $50 / MTok $12.50 / MTok $20 / MTok $1 / MTok",
    "Claude Mythos 5 $10 / MTok $50 / MTok $12.50 / MTok $20 / MTok $1 / MTok",
    "Claude Opus 5 $5 / MTok $25 / MTok $6.25 / MTok $10 / MTok $0.50 / MTok",
    "Claude Opus 4.8 $5 / MTok $25 / MTok $6.25 / MTok $10 / MTok $0.50 / MTok",
    "Claude Opus 4.7 $5 / MTok $25 / MTok $6.25 / MTok $10 / MTok $0.50 / MTok",
    "Claude Opus 4.6 $5 / MTok $25 / MTok $6.25 / MTok $10 / MTok $0.50 / MTok",
    "Claude Opus 4.5 $5 / MTok $25 / MTok $6.25 / MTok $10 / MTok $0.50 / MTok",
    "Claude Opus 4.1 $15 / MTok $75 / MTok $18.75 / MTok $30 / MTok $1.50 / MTok",
    "Claude Opus 4 $15 / MTok $75 / MTok $18.75 / MTok $30 / MTok $1.50 / MTok",
    "Claude Sonnet 5 $2 / MTok $10 / MTok $2.50 / MTok $4 / MTok $0.20 / MTok",
    "Claude Sonnet 4.6 $3 / MTok $15 / MTok $3.75 / MTok $6 / MTok $0.30 / MTok",
    "Claude Sonnet 4.5 $3 / MTok $15 / MTok $3.75 / MTok $6 / MTok $0.30 / MTok",
    "Claude Sonnet 4 $3 / MTok $15 / MTok $3.75 / MTok $6 / MTok $0.30 / MTok",
    "Claude Haiku 4.5 $1 / MTok $5 / MTok $1.25 / MTok $2 / MTok $0.10 / MTok"
  ];
  assertEveryFigureMovesTheFingerprint([
    "Model Base tokens Prompt caching Name Input Output 5m writes 1h writes Hits and refreshes",
    ...rows,
    "Additional notes All other models use the standard 0.1x multiplier."
  ].join(" "), requiredMarkers);
});

test("every standard OpenAI rate on the pricing page sits inside a semantic window", async () => {
  const contracts = await readProviderContracts();
  const { requiredMarkers } = contracts.contracts.find((entry) => entry.id === "openai-platform")
    .resources.find((entry) => entry.url.endsWith("/api/docs/pricing.md"));
  // The two standard tables as published on 2026-11-06, in page order, with their long-context columns.
  const longContext = [
    "| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |",
    "| gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |",
    "| gpt-6.1-terra | $1.00 | $5.00 | $0.05 | $1.25 | $2.50 | $2.00 | $7.50 | $0.10 | $2.50 | $5.00 |",
    "| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 | $0.20 | $0.75 | $0.02 | $0.25 | $0.50 |",
    "| gpt-6-sol | $2.00 | $10.00 | $0.20 | $2.50 | $5.00 | $4.00 | $15.00 | $0.40 | $5.00 | $10.00 |",
    "| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $30.00 | $0.80 | $10.00 | $20.00 |",
    "| gpt-5.6-terra | $2.00 | $12.00 | $0.20 | $2.50 | $5.00 | $4.00 | $18.00 | $0.40 | $5.00 | $10.00 |",
    "| gpt-5.6-luna | $0.20 | $1.20 | $0.02 | $0.25 | $0.50 | $0.40 | $1.80 | $0.04 | $0.50 | $1.00 |",
    "| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |",
    "| gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |",
    "| gpt-5.4 (<272K context length) | $2.50 | $15.00 | $0.25 | - | - | $5.00 | $22.50 | $0.50 | - | - |",
    "| gpt-5.4-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |"
  ];
  const flat = [
    "| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |",
    "| gpt-5.4-nano | $0.20 | $1.25 | $0.02 |",
    "| gpt-5.2 | $1.75 | $14.00 | $0.175 |",
    "| gpt-5.2-pro | $21.00 | $168.00 | - |",
    "| gpt-5.1 | $1.25 | $10.00 | $0.125 |",
    "| gpt-5 | $1.25 | $10.00 | $0.125 |",
    "| gpt-5-mini | $0.25 | $2.00 | $0.025 |",
    "| gpt-5-nano | $0.05 | $0.40 | $0.005 |",
    "| gpt-5-pro | $15.00 | $120.00 | - |",
    "| gpt-4.1 | $2.00 | $8.00 | $0.50 |",
    "| gpt-4.1-mini | $0.40 | $1.60 | $0.10 |",
    "| gpt-4o | $2.50 | $10.00 | $1.25 |",
    "| gpt-4o-mini | $0.15 | $0.60 | $0.075 |",
    "| o3-pro | $20.00 | $80.00 | - |",
    "| o3 | $2.00 | $8.00 | $0.50 |"
  ];
  assertEveryFigureMovesTheFingerprint([
    "### Standard pricing data",
    "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...longContext,
    "| Model | Input | Output | Cached input |",
    "| --- | --- | --- | --- |",
    ...flat,
    "Batch ### Batch pricing data"
  ].join("\n"), requiredMarkers);
});

function assertEveryFigureMovesTheFingerprint(page, requiredMarkers) {
  const normalized = normalizeDocument(page);
  const reviewed = semanticFingerprint(normalized, requiredMarkers);
  let figures = 0;
  for (const { 0: figure, index } of normalized.matchAll(/\$[0-9.]+/g)) {
    figures += 1;
    const changed = `${normalized.slice(0, index)}$99.99${normalized.slice(index + figure.length)}`;
    assert.notEqual(semanticFingerprint(changed, requiredMarkers), reviewed, `no window sees ${figure} in ...${normalized.slice(Math.max(0, index - 40), index + 20)}...`);
  }
  assert.ok(figures > 60, `the fixture lost its table: ${figures} figures`);
}

test("alert classes default from the resource kind and are rendered when declared", async () => {
  const contracts = await readProviderContracts();
  assert.equal(resourceAlertClass({ kind: "contract" }), "api_contract");
  assert.equal(resourceAlertClass({ kind: "contract-cost-report" }), "api_contract");
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
