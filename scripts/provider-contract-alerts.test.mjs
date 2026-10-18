import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  alertPriority,
  assessObservations,
  classifyObservation,
  digestKey,
  legacyIssueTitle,
  monitorKey,
  parseAlertIssue,
  planProviderContractAlerts,
  resourceAlertKey,
  syncProviderContractAlerts
} from "./provider-contract-alerts.mjs";
import { readProviderContracts, renderProviderContractDoc, resourceAlertClass, root, validateProviderContracts } from "./provider-contract-lib.mjs";

const openAiUsageUrl = "https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage";
const context = { repo: { owner: "futurastudio", repo: "ai-spend-agent" }, serverUrl: "https://github.com", runId: 42, ref: "refs/heads/main" };
const contracts = await readProviderContracts();

function hex(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

function findResource(contractId, url) {
  const contract = contracts.contracts.find((entry) => entry.id === contractId);
  return { contract, resource: contract.resources.find((entry) => entry.url === url) };
}

// One observation per declared page. `changes` maps "contractId kind" (or a
// URL) to the drift to simulate; unlisted pages match their reviewed baseline.
function report(changes = {}, checkedAt = "2026-10-18T14:38:52.192Z") {
  const observations = contracts.contracts.flatMap((contract) => contract.resources.map((resource) => {
    const change = changes[resource.url] ?? changes[`${contract.id} ${resource.kind}`];
    const base = { contractId: contract.id, provider: contract.provider, kind: resource.kind, url: resource.url };
    if (change?.error) return { ...base, state: "stale_contract", error: change.error };
    const semanticSha256 = change?.semantic ? hex(`semantic ${change.semantic} ${resource.url}`) : resource.semanticSha256;
    const contentSha256 = change?.content || change?.semantic ? hex(`content ${change.content ?? change.semantic} ${resource.url}`) : resource.contentSha256;
    const missingMarkers = change?.missing ?? [];
    const current = semanticSha256 === resource.semanticSha256 && contentSha256 === resource.contentSha256 && missingMarkers.length === 0;
    return {
      ...base,
      state: current ? "current" : "stale_contract",
      contentSha256,
      semanticSha256,
      expectedSemanticSha256: resource.semanticSha256,
      expectedContentSha256: resource.contentSha256,
      missingMarkers
    };
  }));
  return { schemaVersion: 1, checkedAt, status: "stale_contract", observations, failures: [] };
}

// The drift recorded in #51 on 2026-10-18: four pages changed inside their
// required semantics, the other ten only elsewhere on the page.
function todaysChanges(extra = {}) {
  const changes = {};
  for (const contract of contracts.contracts) {
    for (const resource of contract.resources) changes[resource.url] = { content: "today" };
  }
  for (const key of ["openai-platform contract", "anthropic-platform pricing", "google-gemini pricing", "cursor-admin pricing"]) {
    const [contractId, kind] = key.split(" ");
    const resource = contracts.contracts.find((entry) => entry.id === contractId).resources.find((entry) => entry.kind === kind);
    changes[resource.url] = { semantic: "today" };
  }
  return { ...changes, ...extra };
}

function legacyIssue() {
  return { number: 51, title: legacyIssueTitle, body: "The daily read-only provider contract monitor detected a documentation or semantic fingerprint change.", user: { login: "github-actions[bot]", type: "Bot" }, labels: [] };
}

function fakeGitHub({ issues = [], labels = [], defaultBranch = "main", failOn } = {}) {
  const calls = [];
  const store = issues.map((issue) => ({ state: "open", labels: [], ...structuredClone(issue) }));
  const labelNames = new Set(labels);
  let next = Math.max(100, ...store.map((issue) => issue.number + 1));
  const github = {
    async paginate(method, params) {
      return (await method(params)).data;
    },
    rest: {
      repos: {
        async get() {
          return { data: { default_branch: defaultBranch } };
        }
      },
      issues: {
        async listForRepo({ state }) {
          return { data: structuredClone(store.filter((issue) => issue.state === state)) };
        },
        async listLabelsForRepo() {
          return { data: [...labelNames].map((name) => ({ name })) };
        },
        async createLabel({ name }) {
          calls.push(["label", name]);
          labelNames.add(name);
          return { data: { name } };
        },
        async create({ title, body, labels: issueLabels }) {
          if (failOn?.("create", title)) throw new Error("simulated GitHub outage");
          const number = next++;
          store.push({ number, title, body, labels: issueLabels.map((name) => ({ name })), state: "open", user: { login: "github-actions[bot]", type: "Bot" } });
          calls.push(["create", number, title]);
          return { data: { number } };
        },
        async update({ issue_number: number, title, body, labels: issueLabels, state }) {
          const issue = store.find((candidate) => candidate.number === number);
          if (title !== undefined) issue.title = title;
          if (body !== undefined) issue.body = body;
          if (issueLabels !== undefined) issue.labels = issueLabels.map((name) => ({ name }));
          if (state !== undefined) issue.state = state;
          calls.push(state === "closed" ? ["close", number] : ["update", number, title]);
          return { data: {} };
        },
        async createComment({ issue_number: number, body }) {
          calls.push(["comment", number, body]);
          return { data: {} };
        }
      }
    }
  };
  return { github, calls, store, labelNames };
}

function fakeCore() {
  const log = { info: [], warning: [], error: [], notice: [], failed: [], summary: [] };
  return {
    log,
    info: (message) => log.info.push(message),
    warning: (message) => log.warning.push(message),
    error: (message) => log.error.push(message),
    notice: (message) => log.notice.push(message),
    setFailed: (message) => log.failed.push(message),
    summary: {
      addRaw(text) {
        log.summary.push(text);
        return this;
      },
      async write() {
        return this;
      }
    }
  };
}

async function sync(fake, inputs, options = {}) {
  const core = fakeCore();
  const result = await syncProviderContractAlerts({
    github: fake.github,
    context: { ...context, ...options.context },
    core,
    inputs: { contracts, declarationFailures: [], checks: { declarations: "success", remote: "failure", fixtures: "success" }, ...inputs },
    // `dryRun: undefined` lets the executor decide from the ref and inputs.
    dryRun: "dryRun" in options ? options.dryRun : false
  });
  return { ...result, core };
}

function openAlerts(fake) {
  return fake.store.filter((issue) => issue.state === "open").map((issue) => ({ ...parseAlertIssue(issue), labels: issue.labels.map((label) => label.name) })).filter((issue) => issue.key);
}

test("alert keys follow contract id, kind and url, never the observed hashes", () => {
  const base = { contractId: "openai-platform", kind: "pricing", url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol" };
  assert.equal(resourceAlertKey({ ...base, semanticSha256: "a".repeat(64), state: "current" }), resourceAlertKey(base));
  assert.match(resourceAlertKey(base), /^resource:[a-f0-9]{16}$/);
  assert.notEqual(resourceAlertKey(base), resourceAlertKey({ ...base, url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra" }));
  assert.notEqual(resourceAlertKey(base), resourceAlertKey({ ...base, kind: "contract" }));
  assert.notEqual(resourceAlertKey(base), resourceAlertKey({ ...base, contractId: "openai-other" }));
  const keys = contracts.contracts.flatMap((contract) => contract.resources.map((resource) => resourceAlertKey({ contractId: contract.id, kind: resource.kind, url: resource.url })));
  assert.equal(new Set(keys).size, keys.length, "every declared page needs its own issue key");
});

test("the OpenAI Costs/Usage reference is the financial-schema alert and outranks pricing pages", () => {
  const { resource } = findResource("openai-platform", openAiUsageUrl);
  assert.equal(resource.alertClass, "financial_schema");
  assert.equal(resourceAlertClass(resource), "financial_schema");
  for (const contract of contracts.contracts) {
    for (const entry of contract.resources.filter((candidate) => candidate.kind === "pricing")) {
      assert.equal(resourceAlertClass(entry), "pricing", `${contract.id} ${entry.url}`);
    }
  }
  assert.equal(alertPriority("financial_schema", "claims"), "P0");
  assert.equal(alertPriority("financial_schema", "page"), "P1");
  assert.equal(alertPriority("api_contract", "claims"), "P1");
  assert.equal(alertPriority("pricing", "claims"), "P2");
  assert.equal(alertPriority("pricing", "page"), "P3");
  assert.equal(alertPriority("reconciliation", "unreachable"), "P2");
  assert.equal(alertPriority("pricing", "current"), undefined);

  const invalid = structuredClone(contracts);
  invalid.contracts[0].resources[0].alertClass = "urgent";
  invalid.contracts[0].resources[1].alertClass = "financial_schema";
  const failures = validateProviderContracts(invalid, new Date(`${contracts.reviewedAt}T12:00:00.000Z`)).join("\n");
  assert.match(failures, /resources\[0\]\.alertClass must be one of/);
  assert.match(failures, /resources\[1\]\.alertClass financial_schema is reserved for contract resources/);
});

test("classification separates changed claims from page-only changes and outages", () => {
  const reviewed = { semanticSha256: "1".repeat(64), contentSha256: "2".repeat(64), expectedSemanticSha256: "1".repeat(64), expectedContentSha256: "2".repeat(64), missingMarkers: [] };
  assert.deepEqual(classifyObservation({ ...reviewed, state: "current" }), { signal: "current", reasons: [] });
  assert.deepEqual(classifyObservation({ state: "stale_contract", error: "HTTP 503 Service Unavailable" }), { signal: "unreachable", reasons: ["HTTP 503 Service Unavailable"] });
  assert.deepEqual(classifyObservation({ ...reviewed, state: "stale_contract", contentSha256: "3".repeat(64) }), { signal: "page", reasons: ["page content changed outside the required semantics"] });
  // A semantic change wins even though the full page changed too.
  assert.deepEqual(classifyObservation({ ...reviewed, state: "stale_contract", semanticSha256: "4".repeat(64), contentSha256: "3".repeat(64) }), { signal: "claims", reasons: ["reviewed semantic fingerprint changed"] });
  assert.equal(classifyObservation({ ...reviewed, state: "stale_contract", semanticSha256: "4".repeat(64), missingMarkers: ["GET /organization/costs"] }).reasons[0], "required markers missing: GET /organization/costs");
  assert.deepEqual(classifyObservation({ ...reviewed, state: "stale_contract", expectedSemanticSha256: "bootstrap" }).reasons, ["reviewed semantic fingerprint is not pinned"]);
});

test("today's drift opens one P0 financial-schema issue, separate pricing issues and one digest", async () => {
  const fake = fakeGitHub({ issues: [legacyIssue()] });
  const { core } = await sync(fake, { report: report(todaysChanges()) });
  const creates = fake.calls.filter(([type]) => type === "create").map(([, , title]) => title);
  assert.deepEqual(creates, [
    "[P0] Financial schema: openai-platform contract (usage) — reviewed claims changed",
    "[P2] Pricing: anthropic-platform pricing (pricing) — reviewed claims changed",
    "[P2] Pricing: google-gemini pricing (pricing) — reviewed claims changed",
    "[P2] Pricing: cursor-admin pricing (models-and-pricing) — reviewed claims changed",
    "[P3] Provider pages changed outside their reviewed claims"
  ]);
  const alerts = openAlerts(fake);
  const p0 = alerts.find((issue) => issue.title.startsWith("[P0]"));
  assert.equal(p0.key, resourceAlertKey({ contractId: "openai-platform", kind: "contract", url: openAiUsageUrl }));
  assert.deepEqual(p0.labels, ["provider-drift", "provider-drift:P0", "provider-drift:financial-schema"]);
  assert.match(p0.body, /result fields of a provider cost or usage API/);
  assert.match(p0.body, /Only after that review, pin the observed fingerprints/);
  assert.match(p0.body, /No pricing or financial behavior was changed automatically/);
  assert.equal(p0.state.firstObservedRun, "https://github.com/futurastudio/ai-spend-agent/actions/runs/42");
  const digest = alerts.find((issue) => issue.key === digestKey);
  assert.equal(Object.keys(digest.state.entries).length, 10);
  assert.doesNotMatch(digest.body, /organization\/subresources\/usage/, "the financial-schema page never sits in the low-priority digest");
  assert.deepEqual([...fake.labelNames].sort(), ["provider-drift", "provider-drift:P0", "provider-drift:P2", "provider-drift:P3", "provider-drift:digest", "provider-drift:financial-schema", "provider-drift:pricing"]);

  const legacy = fake.store.find((issue) => issue.number === 51);
  assert.equal(legacy.state, "closed");
  const legacyComment = fake.calls.find(([type, number]) => type === "comment" && number === 51)[2];
  assert.match(legacyComment, /Superseded by per-page provider contract alerts/);
  for (const issue of alerts) assert.match(legacyComment, new RegExp(`#${issue.number} `));
  assert.equal(core.log.error.length, 1, "only the P0 is raised as an error annotation");
  assert.match(core.log.summary[0], /\| P0 \| `financial_schema` \| `openai-platform` contract · usage \| reviewed claims changed \| #\d+ \|/);
  assert.deepEqual(core.log.failed, []);
});

test("a page that keeps drifting the same way is not rewritten on the next run", async () => {
  const fake = fakeGitHub({ issues: [legacyIssue()] });
  await sync(fake, { report: report(todaysChanges()) });
  const before = fake.calls.length;
  const { plan } = await sync(fake, { report: report(todaysChanges(), "2026-10-19T11:17:00.000Z") }, { context: { runId: 43 } });
  assert.deepEqual(plan.actions, []);
  assert.equal(fake.calls.length, before);
});

test("content-only churn updates silently while changed claims and escalations comment", async () => {
  const fake = fakeGitHub();
  await sync(fake, { report: report(todaysChanges()) });
  const p0 = () => openAlerts(fake).find((issue) => issue.title.includes("openai-platform contract"));
  const number = p0().number;

  // The page redeploys again but the required semantics are unchanged.
  let mark = fake.calls.length;
  await sync(fake, { report: report(todaysChanges({ [openAiUsageUrl]: { semantic: "today", content: "tomorrow" } }), "2026-10-19T11:17:00.000Z") }, { context: { runId: 43 } });
  assert.deepEqual(fake.calls.slice(mark).map(([type, issue]) => [type, issue]), [["update", number]]);
  assert.equal(p0().state.lastChangedAt, "2026-10-19T11:17:00.000Z");
  assert.equal(p0().state.firstObservedAt, "2026-10-18T14:38:52.192Z");

  // The reviewed claims change again: watchers get a comment.
  mark = fake.calls.length;
  await sync(fake, { report: report(todaysChanges({ [openAiUsageUrl]: { semantic: "again" } }), "2026-10-20T11:17:00.000Z") }, { context: { runId: 44 } });
  const comments = fake.calls.slice(mark).filter(([type]) => type === "comment");
  assert.equal(comments.length, 1);
  assert.equal(comments[0][1], number);
  assert.match(comments[0][2], /The required semantics changed again/);
});

test("an outage on an alerted page comments once and recovers without a false change notice", async () => {
  const fake = fakeGitHub();
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" } }) });
  const [p0] = openAlerts(fake);

  let mark = fake.calls.length;
  await sync(fake, { report: report({ [openAiUsageUrl]: { error: "HTTP 503 Service Unavailable" } }) }, { context: { runId: 43 } });
  const [down] = openAlerts(fake);
  assert.equal(down.number, p0.number);
  assert.equal(down.title, "[P1] Financial schema: openai-platform contract (usage) — official page could not be checked");
  assert.match(down.body, /\| Check error \| HTTP 503 Service Unavailable \|/);
  assert.deepEqual(fake.calls.slice(mark).filter(([type]) => type === "comment").map(([, , body]) => body.split("\n")[0]), ["The official page could not be checked: HTTP 503 Service Unavailable."]);

  mark = fake.calls.length;
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" } }) }, { context: { runId: 44 } });
  const comments = fake.calls.slice(mark).filter(([type]) => type === "comment").map(([, , body]) => body.split("\n")[0]);
  assert.deepEqual(comments, ["Escalated from P1 to P0: reviewed semantic fingerprint changed."], "recovery to the same claims is an escalation, not a new change");
  assert.equal(openAlerts(fake)[0].title, p0.title);
});

test("a financial-schema page escalates from P1 to P0 with a comment and keeps human labels", async () => {
  const fake = fakeGitHub();
  await sync(fake, { report: report({ [openAiUsageUrl]: { content: "redeploy" } }) });
  const [p1] = openAlerts(fake);
  assert.equal(p1.title, "[P1] Financial schema: openai-platform contract (usage) — page changed outside reviewed claims");
  fake.store.find((issue) => issue.number === p1.number).labels.push({ name: "triaged" });

  const mark = fake.calls.length;
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" } }) }, { context: { runId: 43 } });
  const [p0] = openAlerts(fake);
  assert.equal(p0.number, p1.number);
  assert.equal(p0.title, "[P0] Financial schema: openai-platform contract (usage) — reviewed claims changed");
  assert.deepEqual(p0.labels, ["triaged", "provider-drift", "provider-drift:P0", "provider-drift:financial-schema"]);
  const comment = fake.calls.slice(mark).find(([type]) => type === "comment");
  assert.match(comment[2], /^Escalated from P1 to P0: reviewed semantic fingerprint changed\./);
});

test("matching pages close their issues, and re-matched claims move a page into the digest", async () => {
  const anthropicPricing = findResource("anthropic-platform", "https://platform.claude.com/docs/en/about-claude/pricing").resource.url;
  const fake = fakeGitHub();
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" }, [anthropicPricing]: { semantic: "new model" } }) });
  const [p0, p2] = openAlerts(fake).sort((left, right) => left.number - right.number);

  await sync(fake, { report: report({ [anthropicPricing]: { content: "nav only" } }) }, { context: { runId: 43 } });
  assert.equal(fake.store.find((issue) => issue.number === p0.number).state, "closed");
  assert.equal(fake.store.find((issue) => issue.number === p2.number).state, "closed");
  const digest = openAlerts(fake).find((issue) => issue.key === digestKey);
  assert.ok(digest);
  const resolved = fake.calls.find(([type, number]) => type === "comment" && number === p0.number)[2];
  assert.match(resolved, /^Resolved: this page matches its reviewed baseline/);
  const moved = fake.calls.find(([type, number]) => type === "comment" && number === p2.number)[2];
  assert.match(moved, new RegExp(`now tracked at P3 in #${digest.number}\\.`));

  await sync(fake, { report: report({}) }, { context: { runId: 44 } });
  assert.deepEqual(openAlerts(fake), []);
});

test("a missing or empty report never closes an alert and raises the monitor issue instead", async () => {
  const fake = fakeGitHub();
  await sync(fake, { report: report(todaysChanges()) });
  const open = openAlerts(fake).map((issue) => issue.number);

  await sync(fake, { report: undefined, checks: { declarations: "success", remote: "failure", fixtures: "success" } }, { context: { runId: 43 } });
  await sync(fake, { report: { ...report(), observations: [] } }, { context: { runId: 44 } });
  const after = openAlerts(fake);
  for (const number of open) assert.ok(after.some((issue) => issue.number === number), `#${number} must stay open`);
  const monitor = after.find((issue) => issue.key === monitorKey);
  assert.equal(monitor.title, "[P1] Provider contract monitor checks failing");
  assert.match(monitor.body, /contains no page observations/);
});

test("a page dropped from the contracts closes only when the report observed every declared page", async () => {
  const orphan = { number: 7, title: "[P2] Pricing: old-contract pricing (old) — reviewed claims changed", body: "<!-- provider-contract-alert:v1 key=resource:0123456789abcdef -->\nold", user: { login: "github-actions[bot]", type: "Bot" } };
  const partial = report();
  partial.observations = partial.observations.slice(1);
  let plan = planProviderContractAlerts({ report: partial, contracts, openIssues: [orphan] });
  assert.equal(plan.actions.some((action) => action.number === 7), false);
  plan = planProviderContractAlerts({ report: report(), contracts, openIssues: [orphan] });
  assert.match(plan.actions.find((action) => action.number === 7).comment, /no longer listed in `provider-contracts\/v1.json`/);
});

test("only issues the monitor authored can claim an alert key", () => {
  const key = resourceAlertKey({ contractId: "openai-platform", kind: "contract", url: openAiUsageUrl });
  const spoof = { number: 9, title: "spoof", body: `<!-- provider-contract-alert:v1 key=${key} -->`, user: { login: "mallory", type: "User" } };
  assert.equal(parseAlertIssue(spoof), undefined);
  const plan = planProviderContractAlerts({ report: report({ [openAiUsageUrl]: { semantic: "api_source" } }), contracts, openIssues: [spoof] });
  assert.equal(plan.actions.filter((action) => action.type === "create" && action.key === key).length, 1);
  assert.equal(plan.actions.some((action) => action.number === 9), false);
});

test("duplicate alert issues collapse onto the oldest one", async () => {
  const fake = fakeGitHub();
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" } }) });
  const [original] = openAlerts(fake);
  const copy = { ...structuredClone(fake.store.find((issue) => issue.number === original.number)), number: original.number + 5 };
  fake.store.push(copy);
  await sync(fake, { report: report({ [openAiUsageUrl]: { semantic: "api_source" } }) }, { context: { runId: 43 } });
  assert.deepEqual(openAlerts(fake).map((issue) => issue.number), [original.number]);
  assert.match(fake.calls.find(([type, number]) => type === "comment" && number === copy.number)[2], new RegExp(`^Duplicate of #${original.number}`));
});

test("monitor check failures share one issue that comments when they change and closes when they pass", async () => {
  const fake = fakeGitHub();
  const overdue = ["provider contract review is overdue; reviewedAt=2026-10-08"];
  await sync(fake, { report: report(), declarationFailures: overdue, checks: { declarations: "failure", remote: "failure", fixtures: "success" } });
  let [monitor] = openAlerts(fake);
  assert.equal(monitor.title, "[P2] Provider contract monitor checks failing");
  assert.match(monitor.body, /review is overdue/);

  await sync(fake, { report: report(), declarationFailures: overdue, checks: { declarations: "failure", remote: "failure", fixtures: "failure" } }, { context: { runId: 43 } });
  [monitor] = openAlerts(fake);
  assert.equal(monitor.title, "[P1] Provider contract monitor checks failing");
  assert.match(fake.calls.filter(([type]) => type === "comment").at(-1)[2], /Provider structural fixtures failed/);

  await sync(fake, { report: report() }, { context: { runId: 44 } });
  assert.deepEqual(openAlerts(fake), []);
});

test("off the default branch, or on a dry run, the plan is previewed and no issue changes", async () => {
  for (const options of [{ dryRun: undefined, context: { ref: "refs/heads/feature" } }, { dryRun: true }]) {
    const fake = fakeGitHub({ issues: [legacyIssue()] });
    const { core, dryRun, plan } = await sync(fake, { report: report(todaysChanges()) }, options);
    assert.equal(dryRun, true);
    assert.ok(plan.actions.length > 0);
    assert.deepEqual(fake.calls, []);
    assert.match(core.log.summary[0], /dry run: no issue was changed/);
  }
  const fake = fakeGitHub();
  const { dryRun } = await sync(fake, { report: report(todaysChanges()), dryRun: true }, { dryRun: undefined });
  assert.equal(dryRun, true, "the workflow_dispatch dry_run input also previews on the default branch");
  assert.deepEqual(fake.calls, []);
});

test("a failed issue write fails the step without stopping the other alerts", async () => {
  const fake = fakeGitHub({ failOn: (type, title) => type === "create" && title.includes("google-gemini") });
  const { core } = await sync(fake, { report: report(todaysChanges()) });
  assert.equal(fake.calls.filter(([type]) => type === "create").length, 4);
  assert.equal(core.log.failed.length, 1);
  assert.match(core.log.failed[0], /create resource:[a-f0-9]{16}: simulated GitHub outage/);
});

test("assessments fall back to the resource kind when a page is missing from the contracts", () => {
  const [assessment] = assessObservations({ observations: [{ contractId: "x", kind: "pricing", url: "https://cursor.com/x", state: "stale_contract", error: "HTTP 404 Not Found" }] }, contracts);
  assert.equal(assessment.alertClass, "pricing");
  assert.equal(assessment.priority, "P2");
  assert.equal(assessment.ownIssue, true);
});

test("the generated drift documentation states the priority matrix the monitor applies", () => {
  const doc = renderProviderContractDoc(contracts);
  const signals = ["claims", "page", "unreachable"];
  const rows = [
    ["financial_schema", /\| `financial_schema` [^|]*\| (P\d)[^|]*\| (P\d)[^|]*\| (P\d)[^|]*\|/],
    ["api_contract", /\| `api_contract` [^|]*\| (P\d)[^|]*\| (P\d)[^|]*\| (P\d)[^|]*\|/],
    ["pricing", /\| `pricing`, `reconciliation` [^|]*\| (P\d)[^|]*\| (P\d)[^|]*\| (P\d)[^|]*\|/],
    ["reconciliation", /\| `pricing`, `reconciliation` [^|]*\| (P\d)[^|]*\| (P\d)[^|]*\| (P\d)[^|]*\|/]
  ];
  for (const [alertClass, pattern] of rows) {
    assert.deepEqual(doc.match(pattern).slice(1), signals.map((signal) => alertPriority(alertClass, signal)), alertClass);
  }
});

test("the daily workflow syncs per-page issues through the alert module", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/provider-contract-drift.yml"), "utf8");
  assert.match(workflow, /cron: "17 11 \* \* \*"/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /group: provider-contract-drift/);
  assert.match(workflow, /name: Sync per-page drift issues\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(workflow, /await import\('\$\{\{ github\.workspace \}\}\/scripts\/provider-contract-alerts\.mjs'\)/);
  assert.match(workflow, /runProviderContractAlerts\(\{ github, context, core \}\)/);
  assert.doesNotMatch(workflow, new RegExp(legacyIssueTitle), "the single aggregate issue is gone");
});
