// Turns a provider contract drift report into one GitHub issue per drifted
// official page. The planner is pure; syncProviderContractAlerts executes its
// plan through an Octokit client (actions/github-script in the daily workflow).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  providerContractStateFailures,
  readProviderContracts,
  resourceAlertClass,
  root,
  validateProviderContracts
} from "./provider-contract-lib.mjs";

export const monitorAuthor = "github-actions[bot]";
export const legacyIssueTitle = "Provider contract drift requires review";
export const digestKey = "digest:page-changes";
export const monitorKey = "monitor:checks";

const keyMarkerPattern = /<!-- provider-contract-alert:v1 key=([a-z0-9:-]+) -->/;
const stateMarkerPattern = /<!-- provider-contract-alert-state (\{[^\n]*\}) -->/;
const issueTokenPattern = /\{\{issue:([a-z0-9:-]+)\}\}/g;
const sha256Pattern = /^[a-f0-9]{64}$/;
const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const digestPriority = "P3";

// Rows are alert classes, columns the strength of the observed change. P3 pages
// share the digest issue; everything else gets an issue of its own.
const priorityMatrix = {
  financial_schema: { claims: "P0", page: "P1", unreachable: "P1" },
  api_contract: { claims: "P1", page: "P3", unreachable: "P2" },
  pricing: { claims: "P2", page: "P3", unreachable: "P2" },
  reconciliation: { claims: "P2", page: "P3", unreachable: "P2" }
};

const classDetails = {
  financial_schema: {
    title: "Financial schema",
    label: "provider-drift:financial-schema",
    why: "This page documents the result fields of a provider cost or usage API that a connector validates strictly. A new, renamed or removed result field can make provider syncs fail closed, so review it before syncs return the change.",
    review: "compare every documented result field, for the costs result and each usage result object, with the fields the connector reads. Handle any new, renamed or removed field in the connector before provider syncs return it."
  },
  api_contract: {
    title: "API contract",
    label: "provider-drift:api-contract",
    why: "This page documents an API contract (endpoints, authentication, pagination, units or freshness) that a connector or a reviewed target contract depends on.",
    review: "compare its endpoints, authentication, pagination, units, currency and freshness rules with this contract."
  },
  pricing: {
    title: "Pricing",
    label: "provider-drift:pricing",
    why: "This page states official rates that reviewed pricing claims and estimates depend on.",
    review: "compare the listed rates and multipliers with the reviewed pricing claims (the required markers) and the pricing data estimates use."
  },
  reconciliation: {
    title: "Reconciliation",
    label: "provider-drift:reconciliation",
    why: "This page documents the billing export used to reconcile provider-reported cost.",
    review: "compare the export tables and cost fields with this contract's reconciliation anchor."
  }
};

export const managedLabels = new Map([
  ["provider-drift", { color: "5319e7", description: "Managed by the daily provider contract monitor" }],
  ["provider-drift:P0", { color: "b60205", description: "Review now: financial schema claims changed" }],
  ["provider-drift:P1", { color: "d93f0b", description: "Review soon" }],
  ["provider-drift:P2", { color: "fbca04", description: "Review before the next release" }],
  ["provider-drift:P3", { color: "c5def5", description: "Low signal; re-pin before the next release" }],
  ["provider-drift:financial-schema", { color: "b60205", description: "Cost or usage API result schema page" }],
  ["provider-drift:api-contract", { color: "0e8a16", description: "Provider API contract page" }],
  ["provider-drift:pricing", { color: "1d76db", description: "Provider pricing page" }],
  ["provider-drift:reconciliation", { color: "006b75", description: "Billing export or reconciliation page" }],
  ["provider-drift:digest", { color: "c5def5", description: "Pages changed outside their reviewed claims" }],
  ["provider-drift:monitor", { color: "d4c5f9", description: "Monitor checks failing" }]
]);

export function resourceAlertKey({ contractId, kind, url }) {
  const digest = createHash("sha256").update(JSON.stringify([contractId, kind, url])).digest("hex");
  return `resource:${digest.slice(0, 16)}`;
}

/**
 * Reduce an observation to the strength of its evidence: `claims` when the
 * required markers or the text around them changed (or no baseline is pinned),
 * `page` when only the rest of the page changed, `unreachable` when the page
 * could not be checked at all.
 */
export function classifyObservation(observation) {
  if (observation?.state === "current") return { signal: "current", reasons: [] };
  if (!sha256Pattern.test(observation?.semanticSha256 ?? "") || !sha256Pattern.test(observation?.contentSha256 ?? "")) {
    return { signal: "unreachable", reasons: [observation?.error ?? "official page could not be checked"] };
  }
  const reasons = [];
  const missingMarkers = Array.isArray(observation.missingMarkers) ? observation.missingMarkers : [];
  if (missingMarkers.length > 0) reasons.push(`required markers missing: ${missingMarkers.join(", ")}`);
  if (!sha256Pattern.test(observation.expectedSemanticSha256 ?? "")) {
    reasons.push("reviewed semantic fingerprint is not pinned");
  } else if (observation.semanticSha256 !== observation.expectedSemanticSha256) {
    reasons.push("reviewed semantic fingerprint changed");
  }
  if (!sha256Pattern.test(observation.expectedContentSha256 ?? "")) {
    reasons.push("reviewed full-content fingerprint is not pinned");
  }
  if (reasons.length > 0) return { signal: "claims", reasons };
  if (observation.contentSha256 !== observation.expectedContentSha256) {
    return { signal: "page", reasons: ["page content changed outside the required semantics"] };
  }
  return { signal: "claims", reasons: [observation.error ?? "stale_contract without a recorded reason"] };
}

export function alertPriority(alertClass, signal) {
  if (signal === "current") return undefined;
  return (priorityMatrix[alertClass] ?? priorityMatrix.api_contract)[signal];
}

export function assessObservations(report, contracts) {
  const resources = new Map();
  for (const contract of contracts?.contracts ?? []) {
    for (const resource of Array.isArray(contract.resources) ? contract.resources : []) {
      resources.set(resourceAlertKey({ contractId: contract.id, kind: resource.kind, url: resource.url }), { contract, resource });
    }
  }
  return (report?.observations ?? []).map((observation) => {
    const key = resourceAlertKey(observation);
    const declared = resources.get(key);
    const alertClass = resourceAlertClass(declared?.resource ?? { kind: observation.kind });
    const { signal, reasons } = classifyObservation(observation);
    const priority = alertPriority(alertClass, signal);
    return {
      key,
      observation,
      contract: declared?.contract,
      resource: declared?.resource,
      alertClass,
      signal,
      reasons,
      priority,
      ownIssue: priority !== undefined && priority !== digestPriority
    };
  });
}

/** Read the monitor's key and recorded state from an issue it authored. */
export function parseAlertIssue(issue, author = monitorAuthor) {
  if (!issue || issue.pull_request || issue.user?.login !== author) return undefined;
  const body = issue.body ?? "";
  const key = body.match(keyMarkerPattern)?.[1];
  if (!key) return undefined;
  let state;
  try {
    state = JSON.parse(body.match(stateMarkerPattern)?.[1] ?? "null") ?? undefined;
  } catch {
    state = undefined;
  }
  return { number: issue.number, title: issue.title, body, labels: labelNames(issue.labels), key, state };
}

/**
 * Decide every issue write for one monitor run. Returns ordered actions plus the
 * assessments behind them; nothing here talks to GitHub.
 */
export function planProviderContractAlerts({
  report,
  contracts,
  openIssues = [],
  checks = {},
  declarationFailures = [],
  runUrl,
  now = new Date().toISOString(),
  author = monitorAuthor
}) {
  const checkedAt = report?.checkedAt ?? now;
  const actions = [];
  const closes = [];
  const byKey = new Map();
  for (const issue of openIssues
    .map((candidate) => parseAlertIssue(candidate, author))
    .filter(Boolean)
    .sort((left, right) => left.number - right.number)) {
    if (byKey.has(issue.key)) {
      closes.push({ type: "close", number: issue.number, key: issue.key, comment: `Duplicate of #${byKey.get(issue.key).number}, which tracks the same alert.` });
    } else {
      byKey.set(issue.key, issue);
    }
  }

  const assessments = assessObservations(report, contracts);
  // A report counts as complete only when it observed every declared page;
  // only then may silence (no observation) close an issue.
  const declaredKeys = new Set((contracts?.contracts ?? []).flatMap((contract) => (Array.isArray(contract.resources) ? contract.resources : [])
    .map((resource) => resourceAlertKey({ contractId: contract.id, kind: resource.kind, url: resource.url }))));
  const observedKeys = new Set(assessments.map((assessment) => assessment.key));
  const reportComplete = declaredKeys.size > 0 && [...declaredKeys].every((key) => observedKeys.has(key));
  const digestEntries = [];
  if (assessments.length > 0) {
    for (const assessment of assessments) {
      const existing = byKey.get(assessment.key);
      if (assessment.signal === "current") {
        if (existing) {
          closes.push({ type: "close", number: existing.number, key: assessment.key, comment: withRun("Resolved: this page matches its reviewed baseline in `provider-contracts/v1.json` again.", runUrl) });
        }
        continue;
      }
      if (!assessment.ownIssue) {
        digestEntries.push(assessment);
        if (existing) {
          closes.push({
            type: "close",
            number: existing.number,
            key: assessment.key,
            comment: withRun(`The required semantics match the reviewed baseline again. Other content on the page still differs from the reviewed fingerprint, so the page is now tracked at ${digestPriority} in {{issue:${digestKey}}}.`, runUrl)
          });
        }
        continue;
      }
      const state = nextResourceState(assessment, existing?.state, checkedAt, runUrl);
      const rendered = renderResourceIssue(assessment, state);
      planUpsert(actions, existing, assessment.key, rendered, resourceLabels(assessment));
      const comment = existing ? resourceChangeComment(existing.state, state, assessment, runUrl) : undefined;
      if (comment) actions.push({ type: "comment", number: existing.number, key: assessment.key, body: comment });
    }

    const digest = byKey.get(digestKey);
    if (digestEntries.length > 0) {
      const rendered = renderDigestIssue(digestEntries, digest?.state, checkedAt);
      planUpsert(actions, digest, digestKey, rendered, ["provider-drift", "provider-drift:digest", `provider-drift:${digestPriority}`]);
    } else if (digest && reportComplete) {
      closes.push({ type: "close", number: digest.number, key: digestKey, comment: withRun("No page differs from its reviewed baseline outside its required semantics any more.", runUrl) });
    }

    // A page dropped from v1.json is never observed again, so its issue would
    // otherwise stay open forever.
    if (reportComplete) {
      for (const [key, issue] of byKey) {
        if (key.startsWith("resource:") && !observedKeys.has(key)) {
          closes.push({ type: "close", number: issue.number, key, comment: withRun("This page is no longer listed in `provider-contracts/v1.json`, so the monitor stopped checking it.", runUrl) });
        }
      }
    }
  }

  const monitorFailures = monitorCheckFailures({ report, observed: assessments.length > 0, checks, declarationFailures });
  const monitor = byKey.get(monitorKey);
  if (monitorFailures.failures.length > 0) {
    const rendered = renderMonitorIssue(monitorFailures, checks);
    planUpsert(actions, monitor, monitorKey, rendered, ["provider-drift", "provider-drift:monitor", `provider-drift:${monitorFailures.priority}`]);
    if (monitor && monitor.state?.signature !== rendered.state.signature) {
      actions.push({ type: "comment", number: monitor.number, key: monitorKey, body: withRun(`The failing monitor checks changed:\n\n${monitorFailures.failures.map((failure) => `- ${failure}`).join("\n")}`, runUrl) });
    }
  } else if (monitor) {
    closes.push({ type: "close", number: monitor.number, key: monitorKey, comment: withRun("Every monitor check passes again.", runUrl) });
  }

  for (const issue of openIssues) {
    if (!issue.pull_request && issue.user?.login === author && issue.title === legacyIssueTitle && !keyMarkerPattern.test(issue.body ?? "")) {
      closes.push({ type: "close", number: issue.number, key: "legacy", comment: "{{legacy-superseded}}" });
    }
  }

  return { actions: [...actions, ...closes], assessments, checkedAt };
}

function planUpsert(actions, existing, key, rendered, managed) {
  if (!existing) {
    actions.push({ type: "create", key, title: rendered.title, body: rendered.body, labels: managed });
    return;
  }
  const labels = mergeLabels(existing.labels, managed);
  const labelsChanged = labels.length !== existing.labels.length || labels.some((label) => !existing.labels.includes(label));
  if (existing.title !== rendered.title || existing.body.replace(/\r\n/g, "\n") !== rendered.body || labelsChanged) {
    actions.push({ type: "update", number: existing.number, key, title: rendered.title, body: rendered.body, labels });
  }
}

function nextResourceState(assessment, previous, checkedAt, runUrl) {
  const { observation } = assessment;
  // An unreachable page has no hashes; keep the last observed ones so recovery
  // is compared with the page as it was before the outage.
  const unreachable = assessment.signal === "unreachable";
  const observed = {
    priority: assessment.priority,
    signal: assessment.signal,
    semanticSha256: (unreachable ? previous?.semanticSha256 : observation.semanticSha256) ?? null,
    contentSha256: (unreachable ? previous?.contentSha256 : observation.contentSha256) ?? null,
    missingMarkers: [...(observation.missingMarkers ?? [])].sort(),
    error: observation.error ?? null
  };
  const changed = !previous || ["priority", "signal", "semanticSha256", "contentSha256", "error"].some((field) => previous[field] !== observed[field])
    || JSON.stringify(previous.missingMarkers ?? []) !== JSON.stringify(observed.missingMarkers);
  return {
    ...observed,
    firstObservedAt: previous?.firstObservedAt ?? checkedAt,
    firstObservedRun: previous?.firstObservedRun ?? runUrl ?? null,
    lastChangedAt: changed ? checkedAt : previous.lastChangedAt,
    lastChangedRun: changed ? runUrl ?? null : previous.lastChangedRun
  };
}

// Comments notify watchers, so the monitor comments only when an alert
// escalates, when the reviewed claims change again, or when the page stops
// being checkable. Content-only changes update the description silently.
function resourceChangeComment(previous, next, assessment, runUrl) {
  if (!previous) return undefined;
  if (priorityRank[next.priority] < priorityRank[previous.priority]) {
    return withRun(`Escalated from ${previous.priority} to ${next.priority}: ${assessment.reasons.join("; ")}.`, runUrl);
  }
  if (next.signal === "unreachable" && previous.signal !== "unreachable") {
    return withRun(`The official page could not be checked: ${next.error ?? "unknown error"}.`, runUrl);
  }
  if (next.signal === "claims" && (previous.semanticSha256 !== next.semanticSha256 || JSON.stringify(previous.missingMarkers ?? []) !== JSON.stringify(next.missingMarkers))) {
    const missing = next.missingMarkers.length > 0 ? ` Missing markers: ${next.missingMarkers.join(", ")}.` : "";
    return withRun(`The required semantics changed again: semantic fingerprint \`${short(previous.semanticSha256)}\` → \`${short(next.semanticSha256)}\`.${missing}`, runUrl);
  }
  return undefined;
}

function renderResourceIssue(assessment, state) {
  const { observation, alertClass, signal, reasons, priority, key, contract, resource } = assessment;
  const details = classDetails[alertClass] ?? classDetails.api_contract;
  const headline = signalHeadline(assessment);
  const title = `[${priority}] ${details.title}: ${observation.contractId} ${observation.kind} (${pageName(observation.url)}) — ${headline}`;
  const rows = [
    `| Contract | \`${observation.contractId}\`${contract?.label ? ` · ${escapeCell(contract.label)}` : ""} |`,
    `| Page | \`${observation.kind}\` · ${observation.url} |`,
    `| Alert class | \`${alertClass}\` |`
  ];
  if (signal === "unreachable") {
    rows.push(`| Check error | ${escapeCell(observation.error ?? "unknown error")} |`);
  } else {
    if (resource?.requiredMarkers) rows.push(`| Required markers | ${resource.requiredMarkers.map((marker) => `\`${escapeCell(marker)}\``).join(", ")} |`);
    rows.push(
      `| Missing markers | ${state.missingMarkers.length > 0 ? state.missingMarkers.map((marker) => `\`${escapeCell(marker)}\``).join(", ") : "none"} |`,
      `| Semantic fingerprint | reviewed \`${short(observation.expectedSemanticSha256)}\` → observed \`${short(observation.semanticSha256)}\`${observation.expectedSemanticSha256 === observation.semanticSha256 ? " (unchanged)" : ""} |`,
      `| Content fingerprint | reviewed \`${short(observation.expectedContentSha256)}\` → observed \`${short(observation.contentSha256)}\`${observation.expectedContentSha256 === observation.contentSha256 ? " (unchanged)" : ""} |`
    );
  }
  rows.push(
    `| First observed | ${timestampWithRun(state.firstObservedAt, state.firstObservedRun)} |`,
    `| Last change observed | ${timestampWithRun(state.lastChangedAt, state.lastChangedRun)} |`
  );
  const steps = signal === "unreachable"
    ? [
      "1. Open the page. If it moved, review the new official page and update this resource's URL and fingerprints in `provider-contracts/v1.json`; the monitor then closes this issue as no longer monitored.",
      "2. If the outage was transient, no change is needed: this issue follows the page's state on the next daily run."
    ]
    : [
      `1. Open the official page and ${details.review}`,
      "2. Compare the page with this contract in `provider-contracts/v1.json`: endpoints, units, currency, window, financial basis and exclusions. If a reviewed claim changed, update the contract and its required markers first.",
      `3. Only after that review, pin the observed fingerprints for this page in \`provider-contracts/v1.json\` (semantic \`${observation.semanticSha256}\`, content \`${observation.contentSha256}\`), update \`reviewedAt\`, then run \`npm run generate:provider-docs\` and \`npm run check:provider-contracts\`.`
    ];
  const body = [
    `<!-- provider-contract-alert:v1 key=${key} -->`,
    `**${priority} · ${details.title} · ${headline}**`,
    "",
    `${capitalize(reasons.join("; "))}.`,
    "",
    details.why,
    "",
    "| | |",
    "| --- | --- |",
    ...rows,
    "",
    "**To resolve**",
    "",
    ...steps,
    "",
    "The monitor closes this issue on the first daily run where the page matches its reviewed baseline. Closing it by hand does not acknowledge the drift: the next run opens a new issue.",
    "",
    "No pricing or financial behavior was changed automatically. The monitor rewrites this description when the observation changes; add notes as comments.",
    "",
    `<!-- provider-contract-alert-state ${encodeState(state)} -->`
  ].join("\n");
  return { title, body, state };
}

function renderDigestIssue(entries, previous, checkedAt) {
  const firstObserved = {};
  for (const entry of entries) firstObserved[entry.key] = previous?.entries?.[entry.key] ?? checkedAt;
  const state = { entries: firstObserved };
  const sorted = [...entries].sort((left, right) => `${left.observation.contractId} ${left.observation.url}`.localeCompare(`${right.observation.contractId} ${right.observation.url}`));
  const body = [
    `<!-- provider-contract-alert:v1 key=${digestKey} -->`,
    `**${digestPriority} · Official pages changed outside their reviewed claims**`,
    "",
    "The required semantics of these pages still match their reviewed fingerprints, but other content on each page changed. Documentation sites redeploy often, so these changes are usually navigation or unrelated sections. Each page still needs a review and a re-pinned content fingerprint before the next release; the release gate stays red until then.",
    "",
    "| Contract | Page | Alert class | In this digest since |",
    "| --- | --- | --- | --- |",
    ...sorted.map((entry) => `| \`${entry.observation.contractId}\` | [${escapeCell(entry.observation.kind)} · ${escapeCell(pageName(entry.observation.url))}](${entry.observation.url}) | \`${entry.alertClass}\` | ${firstObserved[entry.key]} |`),
    "",
    "After reviewing a page, run `node scripts/check-provider-contracts.mjs --fetch --print-hashes`, pin its `contentSha256` in `provider-contracts/v1.json`, update `reviewedAt` and run `npm run generate:provider-docs`. A page leaves this digest when it matches its reviewed baseline again, or gets an issue of its own when its reviewed claims change.",
    "",
    `<!-- provider-contract-alert-state ${encodeState(state)} -->`
  ].join("\n");
  return { title: `[${digestPriority}] Provider pages changed outside their reviewed claims`, body, state };
}

function monitorCheckFailures({ report, observed, checks, declarationFailures }) {
  const failures = [];
  let priority = "P2";
  if (!report) {
    failures.push("The drift step did not write `provider-contract-drift.json`, so no official page was checked in this run.");
    priority = "P1";
  } else if (!observed) {
    failures.push("The drift report contains no page observations, so no official page was checked in this run.");
    priority = "P1";
  }
  if (checks.declarations === "failure") {
    if (declarationFailures.length > 0) {
      failures.push(...declarationFailures);
    } else {
      failures.push("`npm run check:provider-contracts` failed outside the contract declarations (unit tests or generated documentation); see the run log.");
      priority = "P1";
    }
  }
  if (checks.fixtures === "failure") {
    failures.push("Provider structural fixtures failed; see the run log.");
    priority = "P1";
  }
  return { failures, priority };
}

function renderMonitorIssue({ failures, priority }, checks) {
  const state = { signature: createHash("sha256").update(JSON.stringify([...failures].sort())).digest("hex").slice(0, 16) };
  const body = [
    `<!-- provider-contract-alert:v1 key=${monitorKey} -->`,
    `**${priority} · Provider contract monitor checks failing**`,
    "",
    `Latest checks: declarations=${checks.declarations ?? "unknown"}, remote=${checks.remote ?? "unknown"}, fixtures=${checks.fixtures ?? "unknown"}.`,
    "",
    ...failures.map((failure) => `- ${failure}`),
    "",
    "These failures are separate from page drift, which each page reports in its own issue. This issue closes on the first run where every check passes.",
    "",
    `<!-- provider-contract-alert-state ${encodeState(state)} -->`
  ].join("\n");
  return { title: `[${priority}] Provider contract monitor checks failing`, body, state };
}

function resourceLabels(assessment) {
  return [
    "provider-drift",
    `provider-drift:${assessment.priority}`,
    (classDetails[assessment.alertClass] ?? classDetails.api_contract).label
  ];
}

function mergeLabels(existing, managed) {
  return [...existing.filter((label) => !managedLabels.has(label)), ...managed];
}

function signalHeadline({ signal, reasons }) {
  if (signal === "unreachable") return "official page could not be checked";
  if (signal === "page") return "page changed outside reviewed claims";
  if (reasons.some((reason) => reason.startsWith("required markers missing"))) return "required claims missing";
  if (reasons.some((reason) => reason.endsWith("is not pinned"))) return "reviewed baseline not pinned";
  return "reviewed claims changed";
}

export function legacySupersededComment(issueRefs) {
  return [
    "Superseded by per-page provider contract alerts. Each drifted official page now has its own issue, ranked by alert class, and the monitor closes it once the page matches its reviewed baseline again. This issue is no longer updated.",
    "",
    ...(issueRefs.length > 0 ? ["Open alerts:", "", ...issueRefs.map((ref) => `- #${ref.number} ${ref.title}`)] : ["No alert is open."])
  ].join("\n");
}

export function renderRunSummary(plan, issueNumbers = new Map(), dryRun = false) {
  const rows = [...plan.assessments]
    .sort((left, right) => (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9) || left.observation.contractId.localeCompare(right.observation.contractId))
    .map((assessment) => {
      const issueKey = assessment.signal === "current" ? undefined : assessment.ownIssue ? assessment.key : digestKey;
      const number = issueKey ? issueNumbers.get(issueKey) : undefined;
      return `| ${assessment.priority ?? "current"} | \`${assessment.alertClass}\` | \`${assessment.observation.contractId}\` ${escapeCell(assessment.observation.kind)} · ${escapeCell(pageName(assessment.observation.url))} | ${assessment.signal === "current" ? "matches reviewed baseline" : escapeCell(signalHeadline(assessment))} | ${number ? `#${number}` : issueKey ? "pending" : ""} |`;
    });
  return [
    `### Provider contract alerts${dryRun ? " (dry run: no issue was changed)" : ""}`,
    "",
    "| Priority | Alert class | Page | Observation | Issue |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Planned issue writes: ${plan.actions.length === 0 ? "none" : plan.actions.map((action) => `${action.type}${action.number ? ` #${action.number}` : ""} (${action.key})`).join(", ")}.`
  ].join("\n");
}

/** Read the drift report, contracts and step outcomes the workflow left behind. */
export async function loadMonitorInputs({ reportPath = "provider-contract-drift.json", env = process.env } = {}) {
  let report;
  try {
    report = JSON.parse(await readFile(resolve(root, reportPath), "utf8"));
  } catch {
    report = undefined;
  }
  let contracts;
  let declarationFailures;
  try {
    contracts = await readProviderContracts();
    declarationFailures = [...validateProviderContracts(contracts), ...providerContractStateFailures(contracts)];
  } catch (error) {
    contracts = undefined;
    declarationFailures = [`provider-contracts/v1.json could not be read: ${error instanceof Error ? error.message : String(error)}`];
  }
  return {
    report,
    contracts,
    declarationFailures,
    checks: {
      declarations: env.STATIC_OUTCOME || "unknown",
      remote: env.DRIFT_OUTCOME || "unknown",
      fixtures: env.FIXTURES_OUTCOME || "unknown"
    },
    dryRun: env.DRY_RUN === "true"
  };
}

/**
 * Execute the plan through an Octokit client. Writes only on the default branch
 * unless dryRun is false explicitly; any other ref previews the plan instead.
 */
export async function syncProviderContractAlerts({ github, context, core, inputs, dryRun, author = monitorAuthor }) {
  const { owner, repo } = context.repo;
  const runUrl = context.runId ? `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}` : undefined;
  if (dryRun === undefined) {
    const { data } = await github.rest.repos.get({ owner, repo });
    dryRun = inputs.dryRun === true || context.ref !== `refs/heads/${data.default_branch}`;
  }
  const openIssues = (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", per_page: 100 }))
    .filter((issue) => !issue.pull_request);
  const plan = planProviderContractAlerts({ ...inputs, openIssues, runUrl, author });
  const issueNumbers = new Map();
  const issueTitles = new Map();
  for (const issue of openIssues.map((candidate) => parseAlertIssue(candidate, author)).filter(Boolean).sort((left, right) => left.number - right.number)) {
    // The oldest issue per key is canonical, matching the planner's duplicate handling.
    if (!issueNumbers.has(issue.key)) issueNumbers.set(issue.key, issue.number);
    issueTitles.set(issue.number, issue.title);
  }

  for (const assessment of plan.assessments) {
    if (assessment.signal === "current") continue;
    const message = `${assessment.priority} ${assessment.alertClass}: ${assessment.observation.contractId} ${assessment.observation.kind} ${assessment.observation.url} — ${signalHeadline(assessment)}`;
    if (assessment.priority === "P0" || assessment.priority === "P1") core.error(message);
    else if (assessment.priority === "P2") core.warning(message);
    else core.notice(message);
  }

  if (dryRun) {
    core.info(`Dry run: ${plan.actions.length} planned issue write(s) were not applied.`);
    await core.summary.addRaw(renderRunSummary(plan, issueNumbers, true)).write();
    return { plan, issueNumbers, dryRun };
  }

  const writeErrors = [];
  const usedLabels = new Set(plan.actions.flatMap((action) => action.labels ?? []));
  const availableLabels = await ensureLabels(github, owner, repo, usedLabels, core);
  const labelsFor = (labels) => labels.filter((label) => !managedLabels.has(label) || availableLabels.has(label));
  for (const action of plan.actions.filter((candidate) => candidate.type !== "close")) {
    try {
      if (action.type === "create") {
        const { data } = await github.rest.issues.create({ owner, repo, title: action.title, body: action.body, labels: labelsFor(action.labels) });
        issueNumbers.set(action.key, data.number);
        issueTitles.set(data.number, action.title);
        core.info(`Opened #${data.number}: ${action.title}`);
      } else if (action.type === "update") {
        await github.rest.issues.update({ owner, repo, issue_number: action.number, title: action.title, body: action.body, labels: labelsFor(action.labels) });
        issueTitles.set(action.number, action.title);
        core.info(`Updated #${action.number}: ${action.title}`);
      } else if (action.type === "comment") {
        await github.rest.issues.createComment({ owner, repo, issue_number: action.number, body: action.body });
        core.info(`Commented on #${action.number}`);
      }
    } catch (error) {
      writeErrors.push(`${action.type} ${action.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const closingNumbers = new Set(plan.actions.filter((action) => action.type === "close").map((action) => action.number));
  for (const action of plan.actions.filter((candidate) => candidate.type === "close")) {
    const comment = action.comment === "{{legacy-superseded}}"
      ? legacySupersededComment([...issueNumbers.values()]
        .filter((number) => !closingNumbers.has(number))
        .sort((left, right) => left - right)
        .map((number) => ({ number, title: issueTitles.get(number) ?? "" })))
      : action.comment.replace(issueTokenPattern, (_match, key) => (issueNumbers.has(key) ? `#${issueNumbers.get(key)}` : "the digest issue"));
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: action.number, body: comment });
      await github.rest.issues.update({ owner, repo, issue_number: action.number, state: "closed", state_reason: "completed" });
      core.info(`Closed #${action.number} (${action.key})`);
    } catch (error) {
      writeErrors.push(`close ${action.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await core.summary.addRaw(renderRunSummary(plan, issueNumbers, false)).write();
  if (writeErrors.length > 0) core.setFailed(`Provider contract alert issues were not fully synchronized:\n- ${writeErrors.join("\n- ")}`);
  return { plan, issueNumbers, dryRun, writeErrors };
}

/** Workflow entry point for actions/github-script. */
export async function runProviderContractAlerts({ github, context, core }) {
  return syncProviderContractAlerts({ github, context, core, inputs: await loadMonitorInputs() });
}

async function ensureLabels(github, owner, repo, wanted, core) {
  const available = new Set();
  try {
    const labels = await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
    for (const label of labels) available.add(label.name);
  } catch (error) {
    core.warning(`Could not list labels: ${error instanceof Error ? error.message : String(error)}`);
    return available;
  }
  for (const name of wanted) {
    if (available.has(name) || !managedLabels.has(name)) continue;
    try {
      await github.rest.issues.createLabel({ owner, repo, name, ...managedLabels.get(name) });
      available.add(name);
    } catch (error) {
      core.warning(`Could not create label ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return available;
}

function labelNames(labels) {
  return (labels ?? []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
}

function encodeState(state) {
  // Keep the JSON inside one HTML comment line: no raw angle brackets or newlines.
  return JSON.stringify(state).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function withRun(text, runUrl) {
  return runUrl ? `${text}\n\nObserved in ${runUrl}.` : text;
}

function timestampWithRun(timestamp, runUrl) {
  return runUrl ? `${timestamp} ([run](${runUrl}))` : String(timestamp);
}

function pageName(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
  } catch {
    return String(url);
  }
}

function short(hash) {
  return typeof hash === "string" && hash.length > 12 ? `${hash.slice(0, 12)}…` : String(hash ?? "none");
}

function capitalize(text) {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
