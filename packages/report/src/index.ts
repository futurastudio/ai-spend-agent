import type {
  AttributionMapping,
  ConfirmedMapping,
  LocalDiscoveryResult,
  MissingSourcePrompt,
  ProviderQaSummary,
  SourceRegistry,
  SpendSummary,
  UsageRecord
} from "@agent-finops/core";

export {
  generatePlainEnglishSummary,
  groupByDimensions,
  type GroupByDimension,
  type PlainEnglishSummaryOptions
} from "./terminal.js";

export {
  generateReportCardSvg,
  generateReportCardCaption,
  type ReportCardInput
} from "./reportCard.js";

export type SpendReportInput = {
  summary: SpendSummary;
  discovery?: LocalDiscoveryResult;
  mappings?: AttributionMapping[];
  sourceRegistry?: SourceRegistry;
  missingSourcePrompts?: MissingSourcePrompt[];
  confirmedMappings?: ConfirmedMapping[];
  providerRecords?: UsageRecord[];
  providerQa?: ProviderQaSummary[];
  generatedAt?: string;
};

export function generateMarkdownReport(input: SpendReportInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const mappingQuestions = (input.mappings ?? []).filter((mapping) => mapping.status !== "auto_mapped");
  const recommendations = [...input.summary.recommendations].sort(compareRecommendations);
  const insights = [...(input.summary.insights ?? [])].sort(compareInsights);
  const totalEstimatedImpactUsd = recommendations.reduce(
    (total, recommendation) => total + recommendation.estimatedImpactUsd,
    0
  );
  const lines = [
    "# AI Spend Analyst Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "> Local-first report. No files, credentials, invoices, or raw spend data were uploaded. Costs are confidence-labeled.",
    "",
    "## Executive summary",
    "",
    `- Total tracked spend: ${formatUsd(input.summary.totalUsd)}`,
    `- Records analyzed: ${input.summary.recordCount}`,
    `- Overall confidence: ${input.summary.confidence}`,
    `- Discovery signals: ${input.discovery?.signals.length ?? 0}`,
    `- Mapping questions: ${mappingQuestions.length}`,
    `- Estimated optimization impact: ${formatUsd(totalEstimatedImpactUsd)}`,
    "",
    "## Diagnose → Recommend → Apply → Verify",
    "",
    ...operatingLoopMarkdownLines(input.summary, recommendations, insights),
    "",
    "## Board brief",
    "",
    "- Decision needed: approve the top local optimization actions before connecting more sources.",
    `- Current readout: ${formatUsd(input.summary.totalUsd)} tracked across ${input.summary.recordCount} local records with ${input.summary.confidence} confidence.`,
    `- Biggest cost driver: ${topDriverLine(input.summary.byModel)}`,
    `- Attribution risk: ${mappingQuestions.length} mapping question${mappingQuestions.length === 1 ? "" : "s"} need confirmation before this becomes finance-grade.`,
    `- Savings thesis: ${formatUsd(totalEstimatedImpactUsd)} in near-term estimated impact from ${recommendations.length} local recommendations.`,
    "",
    "## Confidence breakdown",
    "",
    ...confidenceBreakdownLines(input.summary),
    "",
    "## Evidence quality ledger",
    "",
    ...evidenceLedgerMarkdownLines(input.providerRecords ?? []),
    "",
    "## Provider-by-provider live QA",
    "",
    ...providerQaMarkdownLines(input.providerQa ?? []),
    "",
    "## Spend by source",
    ...breakdownLines(input.summary.bySource),
    "",
    "## Spend by model",
    "",
    ...breakdownLines(input.summary.byModel),
    "",
    "## Spend by client",
    "",
    ...breakdownLines(input.summary.byClient),
    "",
    "## Spend by project",
    "",
    ...breakdownLines(input.summary.byProject),
    "",
    "## Spend by agent",
    "",
    ...breakdownLines(input.summary.byAgent),
    "",
    "## Enterprise entity spend",
    "",
    "### Spend by user",
    "",
    ...breakdownLines(input.summary.byUser),
    "",
    "### Spend by workspace / team",
    "",
    ...breakdownLines(input.summary.byWorkspace),
    "",
    "### Spend by API key",
    "",
    ...breakdownLines(input.summary.byApiKey),
    "",
    "## Agency margin and workflow watch",
    "",
    ...workflowWatchMarkdownLines(input.summary.workflowWatch),
    "",
    "## Source coverage and connection gaps",
    "",
    ...sourceCoverageMarkdownLines(input),
    "",
    "## Confirmed mappings",
    "",
    ...confirmedMappingMarkdownLines(input.confirmedMappings ?? []),
    "",
    "## Anomalies and likely causes",
    "",
    ...(input.summary.anomalies.length === 0
      ? ["No deterministic anomaly detected in this sample window."]
      : input.summary.anomalies.map((anomaly) =>
          `- ${anomaly.key}: ${formatUsd(anomaly.previousAmountUsd)} → ${formatUsd(anomaly.currentAmountUsd)} (${anomaly.multiplier.toFixed(1)}x, ${anomaly.confidence})`
        )),
    "",
    "## Mapping questions",
    "",
    ...(mappingQuestions.length === 0
      ? ["No mapping questions. Current records were auto-mapped by deterministic sample metadata."]
      : mappingQuestions.map((mapping) =>
          `- ${mapping.usageRecordId}: ${mapping.status}. Evidence: ${mapping.evidence.join("; ")}`
        )),
    "",
    "## Analyst insights",
    "",
    ...insightMarkdownLines(insights),
    "",
    "## Priority recommendations",
    "",
    ...(recommendations.length === 0
      ? ["No recommendations generated from the current sample."]
      : recommendations.flatMap((recommendation) => [
          `- **${recommendation.title}** (${recommendation.confidence})`,
          `  - Priority: ${recommendation.priority}`,
          `  - Estimated impact: ${formatUsd(recommendation.estimatedImpactUsd)}`,
          `  - Rationale: ${recommendation.rationale}`,
          `  - Why it matters: ${recommendation.whyItMatters}`,
          `  - Next action: ${recommendation.nextAction}`
        ])),
    "",
    "## Board action plan",
    "",
    ...boardActionPlanLines(recommendations, mappingQuestions.length),
    "",
    "## Next source to connect",
    "",
    nextSourceLine(input),
    ""
  ];

  return lines.join("\n");
}

export function generateApplyArtifactMarkdown(input: SpendReportInput): string {
  const watch = input.summary.workflowWatch;
  const lines = [
    "# AI Spend Apply Artifact",
    "",
    "> Low-risk Apply artifact. Copy this into your coding agent to cut cost, then verify before rollout.",
    "",
    "## Target workflow",
    ""
  ];

  if (watch.length === 0) {
    lines.push("No workflow watch entries were generated. Add client, project, agent, and operation metadata first.");
  } else {
    const top = watch[0];
    lines.push(
      `- Workflow: ${top.clientId} / ${top.projectId} / ${top.workflowKey}`,
      `- Agent: ${top.agentId}`,
      `- Current spend: ${formatUsd(top.amountUsd)} (${formatPercent(top.shareOfSpend)} of tracked spend)`,
      `- Estimated savings: ${formatUsd(top.estimatedSavingsUsd)}`,
      `- Margin at risk: ${formatUsd(top.estimatedMarginRiskUsd)}`,
      "",
      "## Copy this into your coding agent",
      "",
      "```text",
      `You are optimizing the ${top.workflowKey} workflow for client ${top.clientId} / project ${top.projectId}.`,
      `Goal: reduce AI spend by about ${formatUsd(top.estimatedSavingsUsd)} without lowering delivery quality.`,
      `Change request: ${top.suggestedOptimization}`,
      "Constraints: keep outputs functionally equivalent, preserve tests, do not add cloud uploads, keep the workflow local-first unless explicitly approved. Do not change user-visible quality thresholds without approval.",
      `Verification: ${top.verificationPlan}`,
      "Return a small diff, explain expected savings, and include rollback steps.",
      "```",
      "",
      "## Verification plan",
      "",
      `- ${top.verificationPlan}`,
      "- Compare cost, latency, and output acceptance against the pre-change baseline.",
      "- Roll back if quality drops or costs move in the wrong direction."
    );
  }

  lines.push("", "## Full watchlist", "", ...workflowWatchMarkdownLines(watch), "");
  return lines.join("\n");
}

export function generateActionPlanMarkdown(input: SpendReportInput): string {
  const recommendations = [...input.summary.recommendations].sort(compareRecommendations);
  const watch = input.summary.workflowWatch[0];
  return [
    "# AI Spend Action Plan",
    "",
    "> Human-approved next actions generated from the local report. Do not apply changes automatically.",
    "",
    "## Immediate actions",
    "",
    ...(recommendations.length === 0 ? ["- No optimization recommendations generated yet. Connect richer source data or confirm mappings first."] : recommendations.slice(0, 3).flatMap((recommendation, index) => [
      `${index + 1}. **${recommendation.title}**`,
      `   - Estimated impact: ${formatUsd(recommendation.estimatedImpactUsd)} (${recommendation.confidence})`,
      `   - Do next: ${recommendation.nextAction}`,
      `   - Evidence: ${recommendation.rationale}`
    ])),
    "",
    "## Owner handoff",
    "",
    `- Primary workflow: ${watch ? `${watch.clientId} / ${watch.projectId} / ${watch.workflowKey}` : "not enough mapped workflow data yet"}`,
    "- Approval needed: owner confirms quality bar, acceptable latency, and rollback trigger before any change ships.",
    "- Output expected: one small diff or config/policy change plus before/after measurements.",
    ""
  ].join("\n");
}

export function generatePolicyConfigDraftMarkdown(input: SpendReportInput): string {
  const watch = input.summary.workflowWatch[0];
  const topRecommendation = [...input.summary.recommendations].sort(compareRecommendations)[0];
  return [
    "# AI Spend Policy / Config Draft",
    "",
    "> Low-risk draft for a human to copy into a repo, MCP config, or team policy. It is not applied automatically.",
    "",
    "```yaml",
    "aiSpendPolicy:",
    "  cloudUpload: false",
    "  humanApproved: true",
    `  targetWorkflow: ${yamlString(watch ? `${watch.clientId}/${watch.projectId}/${watch.workflowKey}` : "unmapped")}`,
    `  targetAgent: ${yamlString(watch?.agentId ?? "unmapped")}`,
    `  currentTrackedSpendUsd: ${input.summary.totalUsd.toFixed(2)}`,
    `  expectedSavingsUsd: ${(watch?.estimatedSavingsUsd ?? topRecommendation?.estimatedImpactUsd ?? 0).toFixed(2)}`,
    "  allowedApplyModes:",
    "    - coding_agent_prompt",
    "    - policy_draft",
    "    - config_draft",
    "  blockedApplyModes:",
    "    - automatic_live_routing",
    "    - gateway_proxy_changes",
    "    - hard_budget_kill_switches",
    "  verification:",
    "    compareBeforeAfterSpend: true",
    "    compareLatency: true",
    "    compareOutputAcceptance: true",
    "    rollbackOnQualityDrop: true",
    "```",
    "",
    "## Policy notes",
    "",
    "- Treat verified spend, estimated spend, usage evidence, and missing cost data separately.",
    "- Keep source connectors read-only until an owner explicitly approves write-capable changes.",
    "- Use the verification plan before expanding beyond the first workflow.",
    ""
  ].join("\n");
}

export function generateVerificationPlanMarkdown(input: SpendReportInput): string {
  const watch = input.summary.workflowWatch[0];
  return [
    "# AI Spend Verification Plan",
    "",
    "> Prove savings before rollout. This is the controller checklist for the Apply step.",
    "",
    "## Before baseline",
    "",
    `- Tracked spend: ${formatUsd(input.summary.totalUsd)}`,
    `- Target workflow spend: ${watch ? formatUsd(watch.amountUsd) : "not available"}`,
    `- Target workflow records: ${watch?.recordCount ?? 0}`,
    `- Confidence: ${watch?.confidence ?? input.summary.confidence}`,
    "- Capture latency, acceptance/QA result, and any human override notes before changing anything.",
    "",
    "## After-change check",
    "",
    "- Rerun the same workflow/sample window.",
    "- Compare spend, latency, error rate, and output acceptance side by side.",
    `- Expected savings: ${watch ? formatUsd(watch.estimatedSavingsUsd) : "unknown until a workflow is mapped"}`,
    "- Mark result as verified only if cost decreases and quality remains acceptable.",
    "",
    "## Rollback triggers",
    "",
    "- Output quality drops or requires extra human repair.",
    "- Latency worsens enough to affect delivery.",
    "- Cost does not improve on the same sample window.",
    "- Source confidence is still missing for the cost being optimized.",
    ""
  ].join("\n");
}

export function generateDemoPackageMarkdown(input: SpendReportInput): string {
  return [
    "# AI Spend Analyst Demo Package",
    "",
    "## Demo command flow",
    "",
    "```bash",
    "ai-spend-agent init --path ./demo-workspace",
    "ai-spend-agent doctor --path ./demo-workspace",
    "ai-spend-agent scan --sample --path ./demo-workspace",
    "ai-spend-agent report --path ./demo-workspace",
    "ai-spend-agent apply-artifact --path ./demo-workspace",
    "```",
    "",
    "## What the buyer should understand in 10 seconds",
    "",
    `- The agent found ${formatUsd(input.summary.totalUsd)} of tracked AI spend across ${input.summary.recordCount} records.`,
    `- It generated ${input.summary.recommendations.length} ranked optimization recommendation(s).`,
    `- It labels confidence as ${input.summary.confidence} and separates verified, estimated, usage-only, and missing cost evidence.`,
    "- It outputs local reports and human-approved Apply/Verify artifacts before any automation.",
    "",
    "## Demo artifacts",
    "",
    "- `report.md` and `report.html`: board-ready readout.",
    "- `ai-spend-coding-agent-prompt.md`: copyable coding-agent task.",
    "- `ai-spend-action-plan.md`: operator action list.",
    "- `ai-spend-policy-config-draft.md`: low-risk policy/config draft.",
    "- `ai-spend-verify-plan.md`: before/after savings and quality check.",
    "",
    "## QA controller checklist",
    "",
    "- [ ] No arbitrary home scan was used.",
    "- [ ] No raw secrets appear in stdout or generated artifacts.",
    "- [ ] Report and artifacts use confidence language, not overclaims.",
    "- [ ] Apply steps are human-approved and low-risk only.",
    "- [ ] Demo flow completes from init to Apply/Verify artifacts in under 15 minutes.",
    ""
  ].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function generateHtmlReport(input: SpendReportInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const mappingQuestions = (input.mappings ?? []).filter((mapping) => mapping.status !== "auto_mapped");
  const recommendations = [...input.summary.recommendations].sort(compareRecommendations);
  const insights = [...(input.summary.insights ?? [])].sort(compareInsights);
  const totalEstimatedImpactUsd = recommendations.reduce(
    (total, recommendation) => total + recommendation.estimatedImpactUsd,
    0
  );
  const topRecommendation = recommendations[0];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Spend Analyst Report</title>
  <style>${premiumReportCss()}</style>
</head>
<body>
  <main class="report-shell" aria-labelledby="report-title">
    <section class="hero-panel">
      <div class="report-kicker">AI Spend Analyst · Local report</div>
      <div class="hero-grid">
        <div>
          <h1 id="report-title">Board-ready spend readout</h1>
          <p class="hero-copy">A client-facing artifact for deciding which AI costs to verify, optimize, and assign owners to next.</p>
        </div>
        <div class="hero-meta" aria-label="Report metadata">
          <span>Generated</span>
          <strong>${escapeHtml(generatedAt)}</strong>
          <span>Confidence status</span>
          <strong>${escapeHtml(formatConfidenceLabel(input.summary.confidence))}</strong>
        </div>
      </div>
      <aside class="privacy-banner" aria-label="Privacy posture">
        <span class="privacy-dot" aria-hidden="true"></span>
        <strong>Local files only. No cloud upload.</strong>
        <span>No credentials, invoices, or raw spend data leave the machine.</span>
      </aside>
    </section>

    <section class="metric-grid" aria-label="Executive metrics">
      ${metricCard("Tracked spend", formatUsd(input.summary.totalUsd), `${input.summary.recordCount} local records`, "primary")}
      ${metricCard("Optimization impact", formatUsd(totalEstimatedImpactUsd), `${recommendations.length} ranked recommendations`)}
      ${metricCard("Mapping questions", String(mappingQuestions.length), "Need confirmation for finance-grade attribution")}
      ${metricCard("Discovery signals", String(input.discovery?.signals.length ?? 0), "Local source hints found during scan")}
    </section>

    <section class="operating-loop" aria-label="Diagnose recommend apply verify operating loop">
      <div class="section-heading">
        <div>
          <div class="section-label">Operating loop</div>
          <h2>Diagnose → Recommend → Apply → Verify</h2>
        </div>
        <span class="impact-pill">Human-approved before rollout</span>
      </div>
      <div class="loop-grid">
        ${operatingLoopCards(input.summary, recommendations, insights).join("\n")}
      </div>
    </section>

    <section class="artifact-grid">
      <article class="artifact-card artifact-card--wide">
        <div class="section-label">Board brief</div>
        <h2>Decision needed before adding more sources</h2>
        <ul class="brief-list">
          <li><span>Current readout</span><strong>${formatUsd(input.summary.totalUsd)} across ${input.summary.recordCount} records</strong></li>
          <li><span>Biggest cost driver</span><strong>${escapeHtml(topDriverLine(input.summary.byModel))}</strong></li>
          <li><span>Attribution risk</span><strong>${mappingQuestions.length} mapping question${mappingQuestions.length === 1 ? "" : "s"}</strong></li>
          <li><span>Savings thesis</span><strong>${formatUsd(totalEstimatedImpactUsd)} near-term estimated impact</strong></li>
        </ul>
      </article>

      <article class="artifact-card">
        <div class="section-label">Confidence</div>
        <h2>Cost confidence mix</h2>
        <div class="stacked-bars" aria-label="Confidence breakdown">
          ${confidenceBarSegments(input.summary)}
        </div>
        <div class="mini-breakdown">
          ${confidenceBreakdownHtml(input.summary)}
        </div>
      </article>
    </section>

    <section class="evidence-quality" aria-label="Evidence quality ledger">
      <div class="section-heading">
        <div>
          <div class="section-label">Evidence quality ledger</div>
          <h2>Verified spend, estimates, usage evidence, and missing costs stay separate</h2>
        </div>
        <span class="impact-pill">No silent allocation</span>
      </div>
      <div class="evidence-quality-grid">
        ${evidenceLedgerHtml(input.providerRecords ?? [])}
      </div>
    </section>

    <section class="provider-qa" aria-label="Provider-by-provider live QA">
      <div class="section-heading">
        <div>
          <div class="section-label">Provider-by-provider live QA</div>
          <h2>API response drift, pagination, rate limits, and source-specific instructions</h2>
        </div>
        <span class="impact-pill">${input.providerQa?.length ?? 0} provider${(input.providerQa?.length ?? 0) === 1 ? "" : "s"}</span>
      </div>
      <div class="provider-qa-grid">
        ${providerQaHtml(input.providerQa ?? [])}
      </div>
    </section>

    <section class="analyst-insights" aria-label="Analyst insights">
      <div class="section-heading">
        <div>
          <div class="section-label">Analyst insights</div>
          <h2>What the agent thinks is happening</h2>
        </div>
        <span class="impact-pill">${insights.length} ranked finding${insights.length === 1 ? "" : "s"}</span>
      </div>
      <div class="insight-grid">
        ${insights.length === 0 ? emptyState("No analyst insights generated yet. Run a scan with enough local spend history to surface ranked findings.") : insights.map(insightCard).join("\n")}
      </div>
    </section>

    <section class="workflow-watch" aria-label="Agency margin and workflow watch">
      <div class="section-heading">
        <div>
          <div class="section-label">Agency margin + workflow optimization</div>
          <h2>Which clients, projects, agents, and workflows are eating margin</h2>
        </div>
        <span class="impact-pill">${input.summary.workflowWatch.length} watched workflow${input.summary.workflowWatch.length === 1 ? "" : "s"}</span>
      </div>
      <div class="workflow-chart">
        ${input.summary.workflowWatch.length === 0 ? emptyState("No workflow watch entries yet. Add client, project, agent, and operation metadata to surface margin risk.") : input.summary.workflowWatch.map(workflowWatchCard).join("\n")}
      </div>
    </section>

    <section class="entity-spend" aria-label="Enterprise entity spend">
      <div class="section-heading">
        <div>
          <div class="section-label">Enterprise entity spend</div>
          <h2>User, workspace/team, and API-key attribution</h2>
        </div>
        <span class="impact-pill">Auditable source signals</span>
      </div>
      <div class="source-detail-grid">
        <article class="source-detail-card">
          <h3>By user</h3>
          <div class="entity-breakdown-list">
            ${entityBreakdownHtml(input.summary.byUser)}
          </div>
        </article>
        <article class="source-detail-card">
          <h3>By workspace / team</h3>
          <div class="entity-breakdown-list">
            ${entityBreakdownHtml(input.summary.byWorkspace)}
          </div>
        </article>
        <article class="source-detail-card">
          <h3>By API key</h3>
          <div class="entity-breakdown-list">
            ${entityBreakdownHtml(input.summary.byApiKey)}
          </div>
        </article>
      </div>
    </section>

    <section class="source-coverage" aria-label="Source coverage and connection gaps">
      <div class="section-heading">
        <div>
          <div class="section-label">Source coverage</div>
          <h2>What is connected, what is detected, and what is still missing</h2>
        </div>
        <span class="impact-pill">${input.sourceRegistry?.approvedSources.length ?? 0} approved source${(input.sourceRegistry?.approvedSources.length ?? 0) === 1 ? "" : "s"}</span>
      </div>
      <div class="source-lane-grid">
        ${sourceLaneCards(input.sourceRegistry).join("\n")}
      </div>
      <div class="source-detail-grid">
        <article class="source-detail-card">
          <h3>Connection gaps</h3>
          <div class="missing-source-list">
            ${missingSourcePromptHtml(input.missingSourcePrompts ?? [])}
          </div>
        </article>
        <article class="source-detail-card">
          <h3>Confirmed mappings</h3>
          <div class="confirmed-mapping-list">
            ${confirmedMappingHtml(input.confirmedMappings ?? [])}
          </div>
        </article>
      </div>
    </section>

    <section class="recommendations-section" aria-label="Priority recommendations">
      <div class="section-heading">
        <div>
          <div class="section-label">Priority recommendations</div>
          <h2>What to do next</h2>
        </div>
        <span class="impact-pill">${formatUsd(totalEstimatedImpactUsd)} estimated impact</span>
      </div>
      <div class="recommendation-grid">
        ${recommendations.length === 0 ? emptyState("No recommendations generated from the current sample.") : recommendations.map(recommendationCard).join("\n")}
      </div>
    </section>

    <section class="artifact-grid artifact-grid--bottom">
      <article class="artifact-card">
        <div class="section-label">Board action plan</div>
        <h2>Owner-ready next moves</h2>
        <ol class="board-action-list">
          ${boardActionPlanLines(recommendations, mappingQuestions.length).map((line) => `<li>${escapeHtml(stripOrderedPrefix(line))}</li>`).join("\n")}
        </ol>
      </article>
      <article class="artifact-card">
        <div class="section-label">Next source</div>
        <h2>Connect only after the baseline is useful</h2>
        <p>${escapeHtml(nextSourceLine(input))}</p>
        ${topRecommendation ? `<div class="callout"><span>First action</span><strong>${escapeHtml(topRecommendation.nextAction)}</strong></div>` : ""}
      </article>
    </section>
  </main>
</body>
</html>`;
}

function compareRecommendations(
  left: SpendSummary["recommendations"][number],
  right: SpendSummary["recommendations"][number]
): number {
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  return (
    priorityRank[left.priority] - priorityRank[right.priority] ||
    right.estimatedImpactUsd - left.estimatedImpactUsd ||
    left.title.localeCompare(right.title)
  );
}

function compareInsights(left: SpendSummary["insights"][number], right: SpendSummary["insights"][number]): number {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return (
    severityRank[left.severity] - severityRank[right.severity] ||
    right.estimatedImpactUsd - left.estimatedImpactUsd ||
    right.evidence.length - left.evidence.length ||
    left.title.localeCompare(right.title)
  );
}

function operatingLoopMarkdownLines(
  summary: SpendSummary,
  recommendations: SpendSummary["recommendations"],
  insights: SpendSummary["insights"]
): string[] {
  const topWorkflow = summary.workflowWatch[0];
  const topRecommendation = recommendations[0];
  const topInsight = insights[0];

  return [
    `1. **Diagnose the leak:** ${topInsight ? topInsight.title : topWorkflow ? `${topWorkflow.clientId} / ${topWorkflow.projectId} / ${topWorkflow.workflowKey}` : `${formatUsd(summary.totalUsd)} tracked spend baseline`}.`,
    `2. **Recommend a change:** ${topRecommendation ? topRecommendation.nextAction : "Collect more usage evidence before changing the workflow."}`,
    `3. **Apply safely:** ${topWorkflow ? workflowApplyArtifact(topWorkflow) : "Generate a human-approved Apply artifact once a workflow watch entry exists."}`,
    `4. **Verify savings:** ${topWorkflow ? workflowVerificationPlan(topWorkflow) : "Compare before/after cost, latency, and accepted output quality before rollout."}`
  ];
}

function operatingLoopCards(
  summary: SpendSummary,
  recommendations: SpendSummary["recommendations"],
  insights: SpendSummary["insights"]
): string[] {
  const topWorkflow = summary.workflowWatch[0];
  const topRecommendation = recommendations[0];
  const topInsight = insights[0];

  return [
    loopCard(
      "01",
      "Diagnose the leak",
      topInsight ? topInsight.title : topWorkflow ? `${topWorkflow.clientId} / ${topWorkflow.workflowKey}` : `${formatUsd(summary.totalUsd)} tracked baseline`,
      topInsight?.summary ?? "Locate the client, project, agent, model, or workflow where spend is leaking margin."
    ),
    loopCard(
      "02",
      "Recommend a change",
      topRecommendation ? formatUsd(topRecommendation.estimatedImpactUsd) : "Evidence first",
      topRecommendation?.nextAction ?? "Wait for enough local evidence before recommending workflow changes."
    ),
    loopCard(
      "03",
      "Apply safely",
      topWorkflow ? workflowApplyArtifact(topWorkflow) : "Human-approved artifact",
      topWorkflow?.suggestedOptimization ?? "Generate a copy/paste implementation prompt, policy draft, or config task before touching production."
    ),
    loopCard(
      "04",
      "Verify savings",
      topWorkflow ? `${formatUsd(topWorkflow.estimatedSavingsUsd)} target` : "Before/after proof",
      topWorkflow ? workflowVerificationPlan(topWorkflow) : "Compare cost, latency, and accepted output quality against the baseline."
    )
  ];
}

function loopCard(step: string, title: string, value: string, body: string): string {
  return `<article class="loop-card">
    <span class="loop-step">${escapeHtml(step)}</span>
    <h3>${escapeHtml(title)}</h3>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(body)}</p>
  </article>`;
}

function insightMarkdownLines(insights: SpendSummary["insights"]): string[] {
  if (insights.length === 0) {
    return ["No analyst insights generated yet. Run a scan with enough local spend history to surface ranked findings."];
  }

  return insights.flatMap((insight) => [
    `- **${insight.title}** (${insight.severity}, ${insight.confidence})`,
    `  - Estimated impact: ${formatUsd(insight.estimatedImpactUsd)}`,
    `  - Summary: ${insight.summary}`,
    `  - Affected: ${affectedEntitiesLine(insight)}`,
    `  - Evidence: ${insight.evidence.map((item) => `${item.label}: ${item.value}${item.detail ? ` (${item.detail})` : ""}`).join("; ")}`,
    `  - Recommended action: ${insight.recommendedAction}`,
    ...(insight.verificationNeeded ? [`  - Verification needed: ${insight.verificationNeeded}`] : [])
  ]);
}

function affectedEntitiesLine(insight: SpendSummary["insights"][number]): string {
  const parts = [
    insight.affectedClients.length > 0 ? `clients ${insight.affectedClients.join(", ")}` : undefined,
    insight.affectedProjects.length > 0 ? `projects ${insight.affectedProjects.join(", ")}` : undefined,
    insight.affectedAgents.length > 0 ? `agents ${insight.affectedAgents.join(", ")}` : undefined,
    insight.affectedModels.length > 0 ? `models ${insight.affectedModels.join(", ")}` : undefined
  ].filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join("; ") : "global spend baseline";
}

function insightCard(insight: SpendSummary["insights"][number]): string {
  return `<article class="insight-card insight-card--${escapeHtml(insight.severity)}">
    <div class="insight-topline">
      <span class="severity-badge severity-badge--${escapeHtml(insight.severity)}">${escapeHtml(insight.severity)}</span>
      <span class="confidence-chip">${escapeHtml(insight.confidence)}</span>
    </div>
    <h3>${escapeHtml(insight.title)}</h3>
    <p>${escapeHtml(insight.summary)}</p>
    <dl class="insight-facts">
      <div><dt>Impact</dt><dd>${formatUsd(insight.estimatedImpactUsd)}</dd></div>
      <div><dt>Affected</dt><dd>${escapeHtml(affectedEntitiesLine(insight))}</dd></div>
    </dl>
    <div class="evidence-list"><strong>Evidence</strong>${insight.evidence.map((item) => `<span>${escapeHtml(item.label)}: ${escapeHtml(item.value)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ""}</span>`).join("")}</div>
    <div class="next-action"><strong>Recommended action:</strong> ${escapeHtml(insight.recommendedAction)}</div>
    ${insight.verificationNeeded ? `<div class="verification-note"><strong>Verification needed:</strong> ${escapeHtml(insight.verificationNeeded)}</div>` : ""}
  </article>`;
}

function boardActionPlanLines(
  recommendations: SpendSummary["recommendations"],
  mappingQuestionCount: number
): string[] {
  const topThree = recommendations.slice(0, 3);
  if (topThree.length === 0) {
    return ["No board actions yet. Import or scan more usage data, then rerun the local report."];
  }

  return [
    ...topThree.map((recommendation, index) =>
      `${index + 1}. ${recommendation.nextAction} (${recommendation.priority}, ${formatUsd(recommendation.estimatedImpactUsd)} estimated impact)`
    ),
    mappingQuestionCount > 0
      ? `4. Confirm ${mappingQuestionCount} attribution mapping question${mappingQuestionCount === 1 ? "" : "s"} so the next report can separate verified spend from estimates.`
      : "4. Keep the local-only report as the baseline, then connect the next source only after the action owners are assigned."
  ];
}

function topDriverLine(entries: SpendSummary["bySource"]): string {
  const topEntry = entries[0];
  if (!topEntry) {
    return "none detected yet";
  }
  return `${topEntry.key} at ${formatUsd(topEntry.amountUsd)} across ${topEntry.recordCount} records`;
}

function confidenceBreakdownLines(summary: SpendSummary): string[] {
  return Object.entries(summary.confidenceBreakdown).map(([confidence, amount]) => `- ${confidence}: ${formatUsd(amount)}`);
}

function evidenceLedgerMarkdownLines(records: UsageRecord[]): string[] {
  const ledger = buildEvidenceLedger(records);
  return [
    `- Verified spend: ${formatUsd(ledger.verifiedSpendUsd)} across ${ledger.verifiedSpendCount} record${ledger.verifiedSpendCount === 1 ? "" : "s"}`,
    `- Estimated spend: ${formatUsd(ledger.estimatedSpendUsd)} across ${ledger.estimatedSpendCount} record${ledger.estimatedSpendCount === 1 ? "" : "s"}`,
    `- Verified usage evidence: ${ledger.usageEvidenceTokens.toLocaleString("en-US")} tokens across ${ledger.usageEvidenceCount} record${ledger.usageEvidenceCount === 1 ? "" : "s"}`,
    `- Missing cost data: ${ledger.missingCostCount} record${ledger.missingCostCount === 1 ? "" : "s"} need${ledger.missingCostCount === 1 ? "s" : ""} billing/source reconciliation`
  ];
}

function evidenceLedgerHtml(records: UsageRecord[]): string {
  const ledger = buildEvidenceLedger(records);
  return [
    evidenceLedgerCard("verified", "Verified spend", formatUsd(ledger.verifiedSpendUsd), `${ledger.verifiedSpendCount} billing-backed record${ledger.verifiedSpendCount === 1 ? "" : "s"}`),
    evidenceLedgerCard("estimated", "Estimated spend", formatUsd(ledger.estimatedSpendUsd), `${ledger.estimatedSpendCount} estimate-backed record${ledger.estimatedSpendCount === 1 ? "" : "s"}`),
    evidenceLedgerCard("usage", "Verified usage evidence", `${ledger.usageEvidenceTokens.toLocaleString("en-US")} tokens`, `${ledger.usageEvidenceCount} usage record${ledger.usageEvidenceCount === 1 ? "" : "s"} without silent dollar allocation`),
    evidenceLedgerCard("missing", "Missing cost data", `${ledger.missingCostCount} record${ledger.missingCostCount === 1 ? "" : "s"}`, "Needs billing/export/source reconciliation before finance-grade reporting")
  ].join("\n");
}

function evidenceLedgerCard(tone: string, label: string, value: string, context: string): string {
  return `<article class="evidence-quality-card evidence-quality-card--${escapeHtml(tone)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(context)}</p>
  </article>`;
}

function buildEvidenceLedger(records: UsageRecord[]): {
  verifiedSpendUsd: number;
  verifiedSpendCount: number;
  estimatedSpendUsd: number;
  estimatedSpendCount: number;
  usageEvidenceTokens: number;
  usageEvidenceCount: number;
  missingCostCount: number;
} {
  return records.reduce((ledger, record) => {
    if (record.costConfidence === "verified" && typeof record.amountUsd === "number") {
      ledger.verifiedSpendUsd += record.amountUsd;
      ledger.verifiedSpendCount += 1;
    }
    if (record.costConfidence === "estimated" && typeof record.amountUsd === "number") {
      ledger.estimatedSpendUsd += record.amountUsd;
      ledger.estimatedSpendCount += 1;
    }
    const tokenCount = record.inputTokens + record.outputTokens;
    if (tokenCount > 0) {
      ledger.usageEvidenceTokens += tokenCount;
      ledger.usageEvidenceCount += 1;
    }
    if (record.costConfidence === "missing" || record.amountUsd === null) {
      ledger.missingCostCount += 1;
    }
    return ledger;
  }, { verifiedSpendUsd: 0, verifiedSpendCount: 0, estimatedSpendUsd: 0, estimatedSpendCount: 0, usageEvidenceTokens: 0, usageEvidenceCount: 0, missingCostCount: 0 });
}

function providerQaMarkdownLines(providerQa: ProviderQaSummary[]): string[] {
  if (providerQa.length === 0) {
    return ["No live-provider QA captured yet. Run provider sync with API access to record pagination, rate-limit, and response-shape evidence."];
  }

  return providerQa.flatMap((qa) => [
    `- **${qa.provider}** endpoints checked: ${qa.requestedEndpoints.join(", ") || "none"}`,
    ...qa.pagination.map((page) => `  - Pagination: ${providerPaginationExplanation(page)}`),
    providerRateLimitExplanation(qa),
    providerResponseDriftExplanation(qa),
    ...qa.instructions.map((instruction) => `  - Instruction: ${instruction}`)
  ]);
}

function providerQaHtml(providerQa: ProviderQaSummary[]): string {
  if (providerQa.length === 0) {
    return emptyState("No live-provider QA captured yet. Run provider sync with API access to record pagination, rate-limit, and response-shape evidence.");
  }

  return providerQa.map((qa) => `<article class="provider-qa-card">
    <span>${escapeHtml(qa.provider)}</span>
    <h3>${escapeHtml(qa.requestedEndpoints.join(", ") || "No endpoints checked")}</h3>
    <ul>
      ${qa.pagination.map((page) => `<li>${escapeHtml(providerPaginationExplanation(page))}</li>`).join("\n")}
      <li>${escapeHtml(stripListPrefix(providerRateLimitExplanation(qa)))}</li>
      <li>${escapeHtml(stripListPrefix(providerResponseDriftExplanation(qa)))}</li>
      ${qa.instructions.map((instruction) => `<li>Instruction: ${escapeHtml(instruction)}</li>`).join("\n")}
    </ul>
  </article>`).join("\n");
}

function providerPaginationExplanation(page: ProviderQaSummary["pagination"][number]): string {
  return `${page.label}: ${page.pagesFetched} page(s), stopped because ${page.stoppedBecause}${typeof page.limitPerPage === "number" ? `, provider limit ${page.limitPerPage} per page` : ""}`;
}

function providerRateLimitExplanation(qa: ProviderQaSummary): string {
  if (qa.rateLimits.length === 0) return "  - Rate limits: no rate-limit headers observed";
  return `  - Rate limits: ${qa.rateLimits.map((limit) => `${limit.label}${typeof limit.remainingRequests === "number" ? ` remaining ${limit.remainingRequests} requests` : ""}${typeof limit.retryAfterSeconds === "number" ? `; retry after ${limit.retryAfterSeconds}s` : ""}`).join("; ")}`;
}

function providerResponseDriftExplanation(qa: ProviderQaSummary): string {
  if (qa.responseDrift.length === 0) return "  - Response drift: no unknown fields or pagination anomalies observed";
  return `  - Response drift: ${qa.responseDrift.map((issue) => `${issue.label} ${issue.field} - ${issue.issue}`).join("; ")}`;
}

function stripListPrefix(value: string): string {
  return value.replace(/^\s*-\s*/, "");
}

function breakdownLines(entries: SpendSummary["bySource"]): string[] {
  if (entries.length === 0) {
    return ["No spend in this dimension."];
  }
  return entries.map((entry) => `- ${entry.key}: ${formatUsd(entry.amountUsd)} across ${entry.recordCount} records (${entry.confidence})`);
}

function entityBreakdownHtml(entries: SpendSummary["bySource"]): string {
  if (entries.length === 0) {
    return emptyState("No source signal for this entity yet. Connect provider admin data or confirm mappings to make this first-class.");
  }
  return entries.slice(0, 5).map((entry) => `<div class="mapping-row">
    <span>${escapeHtml(formatConfidenceLabel(entry.confidence))}</span>
    <strong>${escapeHtml(entry.key)}</strong>
    <p>${formatUsd(entry.amountUsd)} across ${entry.recordCount} record${entry.recordCount === 1 ? "" : "s"}</p>
  </div>`).join("\n");
}

function workflowWatchMarkdownLines(entries: SpendSummary["workflowWatch"]): string[] {
  if (entries.length === 0) {
    return ["No workflow watch entries yet. Add client, project, agent, and operation metadata to surface margin risk."];
  }

  return entries.flatMap((entry) => [
    `- **${entry.clientId} / ${entry.projectId} / ${entry.workflowKey}** (${entry.confidence})`,
    `  - Tracked spend: ${formatUsd(entry.amountUsd)} across ${entry.recordCount} records`,
    `  - Margin risk: ${formatUsd(entry.estimatedMarginRiskUsd)}`,
    `  - Estimated savings: ${formatUsd(entry.estimatedSavingsUsd)}`,
    `  - Suggested optimization: ${entry.suggestedOptimization}`,
    `  - Apply artifact: ${workflowApplyArtifact(entry)}`,
    `  - Verification plan: ${workflowVerificationPlan(entry)}`
  ]);
}

function workflowWatchCard(entry: SpendSummary["workflowWatch"][number]): string {
  const width = Math.max(6, Math.min(100, Math.round(entry.shareOfSpend * 100)));
  return `<article class="workflow-card">
    <div class="workflow-card-main">
      <div>
        <h3>${escapeHtml(entry.clientId)} / ${escapeHtml(entry.projectId)} / ${escapeHtml(entry.workflowKey)}</h3>
        <p>${escapeHtml(entry.agentId)} · ${escapeHtml(entry.confidence)}</p>
      </div>
      <strong>${formatUsd(entry.amountUsd)}</strong>
    </div>
    <div class="workflow-bar" aria-label="${escapeHtml(formatPercent(entry.shareOfSpend))} of tracked spend"><span style="width: ${width}%"></span></div>
    <div class="workflow-facts">
      <span>Margin risk <strong>${formatUsd(entry.estimatedMarginRiskUsd)}</strong></span>
      <span>Est. savings <strong>${formatUsd(entry.estimatedSavingsUsd)}</strong></span>
      <span>Share <strong>${formatPercent(entry.shareOfSpend)}</strong></span>
    </div>
    <div class="apply-prompt"><strong>Apply artifact:</strong> ${escapeHtml(workflowApplyArtifact(entry))}</div>
    <div class="verification-note"><strong>Verify:</strong> ${escapeHtml(workflowVerificationPlan(entry))}</div>
  </article>`;
}

function sourceCoverageMarkdownLines(input: SpendReportInput): string[] {
  const registry = input.sourceRegistry;
  if (!registry) {
    return ["No source registry attached to this report yet. Run scan/connect before generating a source coverage report."];
  }
  const laneLines = registry.ingestionLanes.map((lane) => {
    const count = registry.approvedSources.filter((source) => source.lane === lane.id).length;
    return `- ${lane.label}: ${count} approved source${count === 1 ? "" : "s"}`;
  });
  const promptLines = (input.missingSourcePrompts ?? []).length === 0
    ? ["- No detected-but-missing connector prompts." ]
    : (input.missingSourcePrompts ?? []).map((prompt) => `- ${prompt.reason} Suggested: ${prompt.suggestedConnector}`);
  return [...laneLines, "", "### Detected but missing", "", ...promptLines];
}

function confirmedMappingMarkdownLines(mappings: ConfirmedMapping[]): string[] {
  if (mappings.length === 0) {
    return ["No confirmed mappings yet. Use `confirm-mapping` to pin source spend to a team, project, workflow, or agent."];
  }
  return mappings.map((mapping) => {
    const target = [mapping.team, mapping.person, mapping.client, mapping.project, mapping.agent, mapping.workflow].filter(Boolean).join(" / ");
    return `- ${mapping.provider}: ${target} (${Math.round(mapping.confidence * 100)}% confidence). Evidence: ${mapping.evidence.join("; ")}`;
  });
}

function sourceLaneCards(registry?: SourceRegistry): string[] {
  const lanes = registry?.ingestionLanes ?? [];
  if (lanes.length === 0) {
    return [emptyState("No source registry attached yet.")];
  }
  return lanes.map((lane) => {
    const sources = registry?.approvedSources.filter((source) => source.lane === lane.id) ?? [];
    const verification = sources[0]?.verification ?? lane.defaultVerification;
    return `<article class="source-lane-card source-lane-card--${escapeHtml(lane.id)}">
      <span class="source-lane-status">${escapeHtml(formatConfidenceLabel(verification))}</span>
      <h3>${escapeHtml(lane.label)}</h3>
      <strong>${sources.length} approved source${sources.length === 1 ? "" : "s"}</strong>
      <p>${sources.length === 0 ? "Not connected yet." : sources.map((source) => source.label).join("; ")}</p>
    </article>`;
  });
}

function missingSourcePromptHtml(prompts: MissingSourcePrompt[]): string {
  if (prompts.length === 0) {
    return emptyState("No detected-but-missing connector prompts yet.");
  }
  return prompts.map((prompt) => `<div class="source-gap-row">
    <span>${escapeHtml(formatConfidenceLabel(prompt.status))}</span>
    <strong>${escapeHtml(prompt.provider)}</strong>
    <p>${escapeHtml(prompt.reason)}</p>
    <code>${escapeHtml(prompt.suggestedConnector)}</code>
  </div>`).join("\n");
}

function confirmedMappingHtml(mappings: ConfirmedMapping[]): string {
  if (mappings.length === 0) {
    return emptyState("No confirmed mappings yet.");
  }
  return mappings.map((mapping) => {
    const target = [mapping.team, mapping.person, mapping.client, mapping.project, mapping.agent, mapping.workflow].filter(Boolean).join(" / ");
    return `<div class="mapping-row">
      <span>${escapeHtml(mapping.provider)}</span>
      <strong>${escapeHtml(target || mapping.sourceId)}</strong>
      <p>${Math.round(mapping.confidence * 100)}% confidence · ${escapeHtml(mapping.evidence.join("; "))}</p>
    </div>`;
  }).join("\n");
}

function workflowApplyArtifact(entry: SpendSummary["workflowWatch"][number]): string {
  const legacyEntry = entry as SpendSummary["workflowWatch"][number] & { applyArtifactId?: string };
  return entry.applyArtifact ?? legacyEntry.applyArtifactId ?? `apply-${entry.id}`;
}

function workflowVerificationPlan(entry: SpendSummary["workflowWatch"][number]): string {
  return entry.verificationPlan ?? "Do not change user-visible quality thresholds without approval; compare cost, latency, and accepted output quality against the current baseline.";
}

function nextSourceLine(input: SpendReportInput): string {
  const providers = new Set(input.discovery?.signals.map((signal) => signal.provider) ?? []);
  if (!providers.has("openai")) {
    return "Connect or import OpenAI billing/export data first, then label costs as verified only after source confirmation.";
  }
  if (!providers.has("anthropic")) {
    return "Connect or import Anthropic usage/cost exports next, then compare source totals against local detected usage.";
  }
  return "Review unmatched local usage signals and confirm client/project mappings before expanding to another provider.";
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function premiumReportCss(): string {
  return `
    :root {
      color-scheme: dark;
      --bg: #08090a;
      --panel: #0f1011;
      --surface: rgba(255, 255, 255, 0.035);
      --surface-strong: rgba(255, 255, 255, 0.055);
      --border: rgba(255, 255, 255, 0.08);
      --border-soft: rgba(255, 255, 255, 0.05);
      --text: #f7f8f8;
      --muted: #8a8f98;
      --soft: #d0d6e0;
      --accent: #7170ff;
      --accent-bg: #5e6ad2;
      --success: #10b981;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      font-feature-settings: "cv01", "ss03";
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% -8%, rgba(113, 112, 255, 0.24), transparent 30rem),
        radial-gradient(circle at 90% 6%, rgba(16, 185, 129, 0.10), transparent 26rem),
        #08090a;
    }
    .report-shell { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 48px 0 64px; }
    .hero-panel, .artifact-card, .analyst-insights, .workflow-watch, .source-coverage, .provider-qa, .operating-loop, .recommendations-section, .metric-card, .evidence-quality {
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.022));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.045), 0 24px 80px rgba(0,0,0,0.26);
    }
    .hero-panel { border-radius: 24px; padding: 34px; overflow: hidden; position: relative; }
    .hero-panel::after { content: ""; position: absolute; inset: auto -16% -42% 45%; height: 280px; background: radial-gradient(circle, rgba(113,112,255,0.18), transparent 70%); pointer-events: none; }
    .report-kicker, .section-label { color: var(--accent); font-size: 12px; font-weight: 590; letter-spacing: 0.08em; text-transform: uppercase; }
    .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: end; position: relative; z-index: 1; }
    h1, h2, p { margin: 0; }
    h1 { max-width: 760px; font-size: clamp(42px, 7vw, 76px); line-height: 0.96; letter-spacing: -0.07em; font-weight: 510; color: var(--text); }
    h2 { margin-top: 10px; font-size: 22px; line-height: 1.18; letter-spacing: -0.03em; font-weight: 510; color: var(--text); }
    .hero-copy { max-width: 620px; margin-top: 18px; color: var(--muted); font-size: 18px; line-height: 1.62; letter-spacing: -0.01em; }
    .hero-meta { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 18px; border: 1px solid var(--border-soft); border-radius: 16px; background: rgba(255,255,255,0.025); }
    .hero-meta span { color: var(--muted); font-size: 12px; }
    .hero-meta strong { color: var(--soft); font-size: 13px; font-weight: 510; overflow-wrap: anywhere; }
    .privacy-banner { position: relative; z-index: 1; display: flex; gap: 10px; align-items: center; margin-top: 28px; padding: 14px 16px; border: 1px solid rgba(16,185,129,0.22); border-radius: 999px; background: rgba(16,185,129,0.075); color: var(--soft); font-size: 14px; }
    .privacy-banner strong { color: var(--text); font-weight: 590; }
    .privacy-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--success); box-shadow: 0 0 18px rgba(16,185,129,0.75); flex: 0 0 auto; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
    .metric-card { border-radius: 18px; padding: 18px; min-height: 132px; }
    .metric-card--primary { background: linear-gradient(180deg, rgba(94,106,210,0.25), rgba(255,255,255,0.03)); border-color: rgba(130,143,255,0.34); }
    .metric-label { color: var(--muted); font-size: 12px; font-weight: 510; }
    .metric-value { display: block; margin-top: 18px; color: var(--text); font-size: 31px; line-height: 1; letter-spacing: -0.05em; font-weight: 510; }
    .metric-context { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .operating-loop { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .loop-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .loop-card { position: relative; min-height: 220px; padding: 18px; border: 1px solid var(--border-soft); border-radius: 18px; background: rgba(255,255,255,0.025); overflow: hidden; }
    .loop-card::after { content: ""; position: absolute; inset: auto 12px 12px auto; width: 44px; height: 44px; border-radius: 999px; background: rgba(113,112,255,0.10); }
    .loop-step { color: var(--accent); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
    .loop-card h3 { margin: 28px 0 12px; color: var(--text); font-size: 18px; line-height: 1.18; letter-spacing: -0.03em; font-weight: 590; }
    .loop-card strong { display: block; color: var(--soft); font-size: 14px; line-height: 1.45; font-weight: 590; }
    .loop-card p { margin-top: 12px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .artifact-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr); gap: 16px; margin-top: 16px; }
    .artifact-grid--bottom { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .artifact-card, .recommendations-section { border-radius: 22px; padding: 24px; }
    .brief-list { list-style: none; padding: 0; margin: 22px 0 0; display: grid; gap: 12px; }
    .brief-list li, .mini-breakdown div { display: flex; justify-content: space-between; gap: 18px; padding-top: 12px; border-top: 1px solid var(--border-soft); color: var(--muted); }
    .brief-list strong, .mini-breakdown strong { color: var(--soft); font-weight: 510; text-align: right; }
    .stacked-bars { display: flex; width: 100%; height: 12px; margin: 22px 0 12px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,0.05); }
    .bar-segment { min-width: 2px; }
    .bar-segment--verified { background: #10b981; }
    .bar-segment--estimated { background: #7170ff; }
    .bar-segment--detected-unverified { background: #d97706; }
    .bar-segment--missing { background: #62666d; }
    .mini-breakdown { display: grid; gap: 0; }
    .analyst-insights { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .evidence-quality { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .evidence-quality-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .evidence-quality-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }
    .evidence-quality-card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .evidence-quality-card strong { display: block; margin-top: 12px; color: var(--text); font-size: 26px; line-height: 1; letter-spacing: -0.04em; font-weight: 510; }
    .evidence-quality-card p { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .evidence-quality-card--verified { border-color: rgba(16,185,129,0.28); }
    .evidence-quality-card--estimated { border-color: rgba(113,112,255,0.30); }
    .evidence-quality-card--usage { border-color: rgba(59,130,246,0.30); }
    .evidence-quality-card--missing { border-color: rgba(217,119,6,0.32); }
    .insight-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .insight-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }
    .insight-card--critical, .insight-card--high { border-color: rgba(217,119,6,0.36); background: linear-gradient(180deg, rgba(217,119,6,0.12), rgba(255,255,255,0.025)); }
    .insight-topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .severity-badge, .confidence-chip { border: 1px solid var(--border); border-radius: 999px; padding: 5px 8px; color: var(--soft); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .severity-badge--critical, .severity-badge--high { border-color: rgba(217,119,6,0.42); color: #fbbf24; background: rgba(217,119,6,0.12); }
    .confidence-chip { color: var(--muted); text-transform: none; letter-spacing: 0; }
    .insight-card h3 { margin: 16px 0 10px; color: var(--text); font-size: 18px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 590; }
    .insight-card p { color: var(--muted); line-height: 1.62; font-size: 14px; }
    .insight-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 16px 0 0; }
    .insight-facts div { padding: 12px; border: 1px solid var(--border-soft); border-radius: 12px; background: rgba(255,255,255,0.025); }
    .insight-facts dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .insight-facts dd { margin: 6px 0 0; color: var(--soft); font-size: 13px; line-height: 1.45; }
    .evidence-list { display: grid; gap: 8px; margin-top: 14px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .evidence-list strong { color: var(--soft); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .evidence-list span { padding-left: 10px; border-left: 1px solid var(--border-soft); }
    .verification-note { margin-top: 12px; padding: 12px; border: 1px solid rgba(113,112,255,0.24); border-radius: 12px; background: rgba(113,112,255,0.08); color: var(--soft); font-size: 13px; line-height: 1.5; }
    .workflow-watch { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .source-coverage { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .provider-qa { margin-top: 16px; border-radius: 22px; padding: 24px; }
    .provider-qa-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .provider-qa-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }
    .provider-qa-card span { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .provider-qa-card h3 { margin: 12px 0; color: var(--text); font-size: 16px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 590; }
    .provider-qa-card ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .provider-qa-card li { margin: 7px 0; }
    .source-lane-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .source-lane-card, .source-detail-card { border: 1px solid var(--border-soft); border-radius: 16px; padding: 16px; background: rgba(255,255,255,0.025); }
    .source-lane-status { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .source-lane-card h3, .source-detail-card h3 { margin: 12px 0 10px; color: var(--text); font-size: 16px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 590; }
    .source-lane-card strong { display: block; color: var(--soft); font-size: 14px; margin-bottom: 8px; }
    .source-lane-card p, .source-detail-card p { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .source-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
    .missing-source-list, .confirmed-mapping-list { display: grid; gap: 10px; }
    .source-gap-row, .mapping-row { padding: 12px; border: 1px solid var(--border-soft); border-radius: 12px; background: rgba(255,255,255,0.022); }
    .source-gap-row span, .mapping-row span { display: block; color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .source-gap-row strong, .mapping-row strong { display: block; margin-top: 6px; color: var(--soft); font-size: 14px; }
    .source-gap-row code { display: inline-block; margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(113,112,255,0.12); color: var(--soft); font-size: 12px; }
    .workflow-chart { display: grid; gap: 14px; }
    .workflow-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }
    .workflow-card-main { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .workflow-card h3 { margin: 0; color: var(--text); font-size: 17px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 590; }
    .workflow-card p { margin-top: 7px; color: var(--muted); line-height: 1.45; font-size: 13px; }
    .workflow-card-main > strong { color: var(--text); font-size: 24px; line-height: 1; letter-spacing: -0.04em; font-weight: 510; white-space: nowrap; }
    .workflow-bar { height: 10px; margin-top: 16px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,0.055); }
    .workflow-bar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #7170ff, #10b981); }
    .workflow-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .workflow-facts span { padding: 11px; border: 1px solid var(--border-soft); border-radius: 12px; color: var(--muted); background: rgba(255,255,255,0.022); font-size: 12px; }
    .workflow-facts strong { display: block; margin-top: 4px; color: var(--soft); font-size: 13px; }
    .apply-prompt { margin-top: 14px; padding: 12px; border-radius: 12px; background: rgba(16,185,129,0.075); color: var(--soft); font-size: 13px; line-height: 1.5; }
    .recommendations-section { margin-top: 16px; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    .impact-pill { border: 1px solid rgba(113,112,255,0.32); border-radius: 999px; padding: 8px 12px; color: var(--soft); background: rgba(113,112,255,0.10); font-size: 13px; font-weight: 510; }
    .recommendation-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .recommendation-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }
    .recommendation-card--high { border-color: rgba(113,112,255,0.36); background: linear-gradient(180deg, rgba(113,112,255,0.14), rgba(255,255,255,0.025)); }
    .recommendation-topline { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .priority-badge { border: 1px solid var(--border); border-radius: 999px; padding: 5px 8px; color: var(--soft); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
    .recommendation-card h3 { margin: 16px 0 10px; color: var(--text); font-size: 18px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 590; }
    .recommendation-card p, .artifact-card p { color: var(--muted); line-height: 1.62; font-size: 14px; }
    .impact-line { display: block; color: var(--text); font-size: 28px; letter-spacing: -0.05em; font-weight: 510; }
    .next-action { margin-top: 14px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.035); color: var(--soft); font-size: 13px; line-height: 1.5; }
    .board-action-list { margin: 20px 0 0; padding-left: 20px; color: var(--soft); }
    .board-action-list li { margin: 10px 0; padding-left: 8px; line-height: 1.58; }
    .callout { margin-top: 18px; padding: 14px; border: 1px solid var(--border-soft); border-radius: 14px; background: rgba(255,255,255,0.025); }
    .callout span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .callout strong { color: var(--soft); font-size: 13px; line-height: 1.5; }
    .empty-state { color: var(--muted); border: 1px dashed var(--border); border-radius: 16px; padding: 22px; }
    @media (max-width: 960px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero-grid, .artifact-grid, .artifact-grid--bottom { grid-template-columns: 1fr; } .loop-grid, .recommendation-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 760px) { .report-shell { width: min(100% - 28px, 1180px); padding: 24px 0 40px; } .hero-panel, .artifact-card, .analyst-insights, .workflow-watch, .provider-qa, .operating-loop, .recommendations-section { padding: 20px; border-radius: 18px; } .metric-grid, .loop-grid, .insight-grid, .provider-qa-grid, .workflow-facts, .recommendation-grid { grid-template-columns: 1fr; } .workflow-card-main { flex-direction: column; } .privacy-banner { align-items: flex-start; border-radius: 16px; flex-wrap: wrap; } .section-heading { align-items: flex-start; flex-direction: column; } }
  `;
}

function formatConfidenceLabel(confidence: SpendSummary["confidence"]): string {
  switch (confidence) {
    case "verified":
      return "Verified from source data";
    case "estimated":
      return "Estimated from local records";
    case "detected_unverified":
      return "Detected, not yet verified";
    case "missing":
      return "Source data needed";
  }
}

function metricCard(label: string, value: string, context: string, tone?: "primary"): string {
  return `<article class="metric-card${tone === "primary" ? " metric-card--primary" : ""}">
    <span class="metric-label">${escapeHtml(label)}</span>
    <strong class="metric-value">${escapeHtml(value)}</strong>
    <p class="metric-context">${escapeHtml(context)}</p>
  </article>`;
}

function recommendationCard(recommendation: SpendSummary["recommendations"][number]): string {
  return `<article class="recommendation-card recommendation-card--${escapeHtml(recommendation.priority)}">
    <div class="recommendation-topline">
      <span class="impact-line">${formatUsd(recommendation.estimatedImpactUsd)}</span>
      <span class="priority-badge">${escapeHtml(recommendation.priority)}</span>
    </div>
    <h3>${escapeHtml(recommendation.title)}</h3>
    <p>${escapeHtml(recommendation.whyItMatters)}</p>
    <div class="next-action"><strong>Next action:</strong> ${escapeHtml(recommendation.nextAction)}</div>
  </article>`;
}

function confidenceBarSegments(summary: SpendSummary): string {
  const total = Math.max(summary.totalUsd, 1);
  return Object.entries(summary.confidenceBreakdown)
    .map(([confidence, amount]) => {
      const width = Math.max((amount / total) * 100, amount > 0 ? 3 : 0);
      return `<span class="bar-segment bar-segment--${escapeHtml(confidence.replace(/_/g, "-"))}" style="width: ${width.toFixed(1)}%" title="${escapeHtml(confidence)} ${formatUsd(amount)}"></span>`;
    })
    .join("\n");
}

function confidenceBreakdownHtml(summary: SpendSummary): string {
  return Object.entries(summary.confidenceBreakdown)
    .map(([confidence, amount]) => `<div><span>${escapeHtml(confidence.replace(/_/g, " "))}</span><strong>${formatUsd(amount)}</strong></div>`)
    .join("\n");
}

function emptyState(message: string): string {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function stripOrderedPrefix(line: string): string {
  return line.replace(/^\d+\.\s*/, "");
}

function markdownToSimpleHtml(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("> ")) return `<blockquote>${escapeHtml(line.slice(2))}</blockquote>`;
      if (line.startsWith("- ")) return `<p>• ${formatInline(line.slice(2))}</p>`;
      if (line.trim() === "") return "";
      return `<p>${formatInline(line)}</p>`;
    })
    .join("\n");
}

function formatInline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
