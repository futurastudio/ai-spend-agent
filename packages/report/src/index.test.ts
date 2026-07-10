import { describe, expect, it } from "vitest";
import { analyzeSpend } from "@agent-finops/core";
import type { SourceRegistry, UsageRecord } from "@agent-finops/core";
import type { SpendReportInput } from "./index.js";
import {
  generateApplyArtifactMarkdown,
  generateHtmlReport,
  generateMarkdownReport,
  generatePolicyConfigDraftMarkdown
} from "./index.js";

const sourceRegistry: SourceRegistry = {
  version: 1,
  localOnly: true,
  cloudUpload: false,
  updatedAt: "2026-05-25T16:40:00.000Z",
  deniedGlobs: [".env*"],
  supportedSourceTypes: ["local_folder", "provider_export", "provider_api", "browser_account", "local_tool_detection", "mcp_tool", "internal_system"],
  ingestionLanes: [
    { id: "local_files_exports", label: "Local files and provider exports", sourceTypes: ["local_folder", "provider_export"], defaultVerification: "estimated" },
    { id: "provider_apis", label: "Official provider APIs", sourceTypes: ["provider_api"], defaultVerification: "verified" },
    { id: "browser_account_ui", label: "Browser Account UI", sourceTypes: ["browser_account"], defaultVerification: "verified" },
    { id: "local_cli_tool_detection", label: "Local CLI/tool detection path", sourceTypes: ["local_tool_detection"], defaultVerification: "detected_unverified" },
    { id: "mcp_internal_systems", label: "MCP and internal systems", sourceTypes: ["mcp_tool", "internal_system"], defaultVerification: "verified" }
  ],
  approvedSources: [
    {
      id: "local-root",
      type: "local_folder",
      label: "Approved local scan root",
      path: "/tmp/ai-spend-fixture",
      readOnly: true,
      approvedAt: "2026-05-25T16:40:00.000Z",
      scope: "Read-only local folder",
      lane: "local_files_exports",
      accessMethod: "file",
      verification: "verified",
      fieldsVerified: ["approved folder boundary"],
      fieldsEstimated: [],
      fieldsMissing: ["provider account billing data"]
    },
    {
      id: "anthropic-provider-api",
      type: "provider_api",
      label: "Anthropic / Claude / Claude Code",
      provider: "anthropic",
      readOnly: true,
      approvedAt: "2026-05-25T16:42:00.000Z",
      scope: "Read-only provider API/account usage source. Store token references only; no raw secrets.",
      lane: "provider_apis",
      accessMethod: "api",
      verification: "missing",
      fieldsVerified: ["organization cost report", "Claude Code usage"],
      fieldsEstimated: [],
      fieldsMissing: ["admin API token reference", "organization id"]
    }
  ]
};

const providerRecords: UsageRecord[] = [
  {
    id: "verified-openai-cost",
    timestamp: "2026-05-25T16:00:00.000Z",
    source: { id: "openai-provider-api", name: "OpenAI Costs API", provider: "openai", confidence: "verified", observedFrom: "OpenAI organization costs API" },
    model: "Responses API",
    inputTokens: 0,
    outputTokens: 0,
    amountUsd: 25,
    costConfidence: "verified",
    providerCostType: "openai_cost",
    operation: "Verified OpenAI spend"
  },
  {
    id: "estimated-claude-code",
    timestamp: "2026-05-25T16:00:00.000Z",
    source: { id: "anthropic-provider-api", name: "Claude Code Usage", provider: "anthropic", confidence: "estimated", observedFrom: "Anthropic Claude Code Usage Report" },
    model: "claude-sonnet-4",
    inputTokens: 1200,
    outputTokens: 240,
    amountUsd: 1.75,
    costConfidence: "estimated",
    providerCostType: "anthropic_claude_code_usage",
    userId: "dev@example.com",
    operation: "Estimated Claude Code usage"
  },
  {
    id: "verified-usage-missing-cost",
    timestamp: "2026-05-25T16:00:00.000Z",
    source: { id: "openai-provider-api", name: "OpenAI Usage API", provider: "openai", confidence: "verified", observedFrom: "OpenAI organization usage API" },
    model: "gpt-5.1",
    inputTokens: 900,
    outputTokens: 120,
    amountUsd: null,
    costConfidence: "missing",
    providerCostType: "openai_usage_evidence",
    userId: "user_jose",
    operation: "Verified usage evidence; missing cost"
  }
];

const input: SpendReportInput = {
  generatedAt: "2026-05-25T16:45:00.000Z",
  summary: {
    totalUsd: 100,
    recordCount: 4,
    confidence: "estimated",
    confidenceBreakdown: {
      verified: 25,
      estimated: 75,
      detected_unverified: 0,
      missing: 0
    },
    bySource: [{ key: "openai", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byModel: [{ key: "gpt-4.1", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byClient: [{ key: "client-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byProject: [{ key: "project-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byAgent: [{ key: "agent-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byUser: [{ key: "user-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byWorkspace: [{ key: "workspace-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    byApiKey: [{ key: "key-a", amountUsd: 100, recordCount: 4, confidence: "estimated" }],
    workflowWatch: [
      {
        id: "workflow-client-a-project-a-strategy-brief",
        clientId: "client-a",
        projectId: "project-a",
        workflowKey: "strategy_brief",
        agentId: "agent-a",
        amountUsd: 100,
        recordCount: 4,
        shareOfSpend: 1,
        estimatedMarginRiskUsd: 40,
        estimatedSavingsUsd: 24,
        confidence: "estimated",
        suggestedOptimization: "Cap context and route draft work to cheaper model tiers.",
        applyArtifact: "apply-workflow-client-a-project-a-strategy-brief",
        verificationPlan: "Do not change user-visible quality thresholds without approval; compare cost, latency, and accepted output quality against the current baseline."
      }
    ],
    anomalies: [],
    insights: [
      {
        id: "agent-cost-driver-agent-a",
        kind: "agent_runaway",
        severity: "high",
        title: "agent-a is the dominant autonomous spend driver",
        summary: "agent-a accounts for all tracked spend and should receive the first budget cap before more sources are connected.",
        evidence: [
          { label: "Agent spend", value: "$100.00", detail: "4 records" },
          { label: "Share of tracked spend", value: "100%" },
          { label: "Dominant model", value: "gpt-4.1" }
        ],
        affectedClients: ["client-a"],
        affectedProjects: ["project-a"],
        affectedAgents: ["agent-a"],
        affectedModels: ["gpt-4.1"],
        estimatedImpactUsd: 15,
        confidence: "estimated",
        recommendedAction: "Set a local warning threshold and hard cap for agent-a before allowing higher-volume autonomous runs.",
        verificationNeeded: "Confirm whether agent-a has an approved budget owner and expected daily range."
      }
    ],
    recommendations: [
      {
        id: "routing",
        title: "Route workloads by cost sensitivity",
        rationale: "The highest-cost source is handling all sampled traffic.",
        whyItMatters: "Without routing rules, premium models quietly become the default and budget owners cannot defend the spend.",
        nextAction: "Approve a routing policy for low-risk summarization and extraction jobs this week.",
        priority: "high",
        estimatedImpactUsd: 20,
        confidence: "estimated",
        relatedKeys: ["openai"]
      }
    ]
  },
  mappings: [
    {
      usageRecordId: "usage-1",
      candidates: [],
      status: "needs_confirmation",
      evidence: ["client inferred from folder name"]
    }
  ],
  sourceRegistry,
  missingSourcePrompts: [
    {
      provider: "openai",
      status: "detected_unverified",
      reason: "OpenAI was detected locally, but no verified provider/API/browser/export source is connected.",
      detectedEvidence: ["package.json imports openai"],
      suggestedConnector: "connect openai --type provider_api",
      suggestedSourceTypes: ["provider_api", "browser_account"]
    }
  ],
  confirmedMappings: [
    {
      id: "anthropic-sales-enterprise-sales-proposal-drafting",
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      team: "Sales",
      project: "enterprise-sales",
      workflow: "proposal drafting",
      evidence: ["Claude account UI report"],
      confidence: 0.82,
      status: "confirmed",
      confirmedAt: "2026-05-25T16:46:00.000Z"
    }
  ],
  providerRecords,
  providerQa: [{
    provider: "openai",
    requestedEndpoints: ["OpenAI costs API", "OpenAI usage API"],
    pagination: [
      { label: "OpenAI costs API", pagesFetched: 2, stoppedBecause: "complete", maxPages: 50, limitPerPage: 180 },
      { label: "OpenAI usage API", pagesFetched: 1, stoppedBecause: "missing_cursor", maxPages: 50, limitPerPage: 31 }
    ],
    rateLimits: [{ label: "OpenAI costs API", remainingRequests: 4, retryAfterSeconds: 2 }],
    responseDrift: [{ label: "OpenAI usage API", field: "data[0].unexpected_bucket_key", issue: "unknown field observed in provider response" }],
    instructions: [
      "Use an OpenAI admin key reference with organization usage and cost read access.",
      "Keep cost buckets and usage buckets separate; usage evidence does not imply dollars until billing reconciliation."
    ]
  }]
};

describe("board-style report generation", () => {
  it("turns spend analysis into an executive board brief and action plan", () => {
    const markdown = generateMarkdownReport(input);

    expect(markdown).toContain("## Diagnose → Recommend → Apply → Verify");
    expect(markdown).toContain("Diagnose the leak");
    expect(markdown).toContain("Apply safely");
    expect(markdown).toContain("Verify savings");
    expect(markdown).toContain("## Board brief");
    expect(markdown).toContain("- Decision needed: approve the top local optimization actions before connecting more sources.");
    expect(markdown).toContain("## Priority recommendations");
    expect(markdown).toContain("Priority: high");
    expect(markdown).toContain("Estimated impact: $20.00");
    expect(markdown).toContain("Why it matters:");
    expect(markdown).toContain("Next action:");
    expect(markdown).toContain("## Analyst insights");
    expect(markdown).toContain("Evidence:");
    expect(markdown).toContain("Verification needed:");
    expect(markdown).toContain("## Agency margin and workflow watch");
    expect(markdown).toContain("client-a / project-a / strategy_brief");
    expect(markdown).toContain("Margin risk: $40.00");
    expect(markdown).toContain("## Source coverage and connection gaps");
    expect(markdown).toContain("Local files and provider exports: 1 approved source");
    expect(markdown).toContain("Official provider APIs: 1 approved source");
    expect(markdown).toContain("OpenAI was detected locally");
    expect(markdown).toContain("connect openai --type provider_api");
    expect(markdown).toContain("## Confirmed mappings");
    expect(markdown).toContain("anthropic: Sales / enterprise-sales / proposal drafting");
    expect(markdown).toContain("## Provider-by-provider live QA");
    expect(markdown).toContain("OpenAI costs API: 2 page(s), stopped because complete, provider limit 180 per page");
    expect(markdown).toContain("OpenAI usage API: 1 page(s), stopped because missing_cursor, provider limit 31 per page");
    expect(markdown).toContain("Rate limits: OpenAI costs API remaining 4 requests; retry after 2s");
    expect(markdown).toContain("Response drift: OpenAI usage API data[0].unexpected_bucket_key - unknown field observed in provider response");
    expect(markdown).toContain("Use an OpenAI admin key reference with organization usage and cost read access.");
    expect(markdown).toContain("Keep cost buckets and usage buckets separate");
  });

  it("renders a premium Linear-inspired HTML client artifact", () => {
    const html = generateHtmlReport(input);

    expect(html).toContain('class="report-shell"');
    expect(html).toContain('class="privacy-banner"');
    expect(html).toContain('class="metric-grid"');
    expect(html).toContain('class="metric-card metric-card--primary"');
    expect(html).toContain('class="artifact-grid"');
    expect(html).toContain('class="recommendation-card recommendation-card--high"');
    expect(html).toContain('class="board-action-list"');
    expect(html).toContain("Board-ready spend readout");
    expect(html).toContain("Local files only. No cloud upload.");
    expect(html).toContain("$100.00");
    expect(html).toContain("$20.00");
    expect(html).toContain('class="operating-loop"');
    expect(html).toContain('class="loop-grid"');
    expect(html).toContain('class="loop-card"');
    expect(html).toContain('class="loop-step"');
    expect(html).toContain("Diagnose → Recommend → Apply → Verify");
    expect(html).toContain("Diagnose the leak");
    expect(html).toContain("Recommend a change");
    expect(html).toContain("Apply safely");
    expect(html).toContain("Verify savings");
    expect(html).toContain("Human-approved before rollout");
    expect(html).toContain(".operating-loop { margin-top: 16px; border-radius: 22px; padding: 24px; }");
    expect(html).toContain(".loop-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }");
    expect(html).toContain('class="analyst-insights"');
    expect(html).toContain('class="insight-grid"');
    expect(html).toContain('class="insight-card insight-card--high"');
    expect(html).toContain('class="insight-topline"');
    expect(html).toContain('class="severity-badge severity-badge--high"');
    expect(html).toContain('class="confidence-chip"');
    expect(html).toContain('class="insight-facts"');
    expect(html).toContain('class="evidence-list"');
    expect(html).toContain('class="verification-note"');
    expect(html).toContain(".analyst-insights { margin-top: 16px; border-radius: 22px; padding: 24px; }");
    expect(html).toContain(".insight-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }");
    expect(html).toContain(".insight-card { border: 1px solid var(--border-soft); border-radius: 18px; padding: 18px; background: rgba(255,255,255,0.025); }");
    expect(html).toContain('class="workflow-watch"');
    expect(html).toContain('class="workflow-chart"');
    expect(html).toContain('class="workflow-bar"');
    expect(html).toContain('class="workflow-card"');
    expect(html).toContain("Agency margin and workflow watch");
    expect(html).toContain("client-a / project-a / strategy_brief");
    expect(html).toContain("Margin risk");
    expect(html).toContain(".workflow-watch { margin-top: 16px; border-radius: 22px; padding: 24px; }");
    expect(html).toContain("@media (max-width: 760px)");
    expect(html).toContain('class="source-coverage"');
    expect(html).toContain('class="source-lane-grid"');
    expect(html).toContain('class="source-lane-card source-lane-card--provider_apis"');
    expect(html).toContain('class="missing-source-list"');
    expect(html).toContain('class="confirmed-mapping-list"');
    expect(html).toContain("Detected, not yet verified");
    expect(html).toContain("connect openai --type provider_api");
    expect(html).toContain("Sales / enterprise-sales / proposal drafting");
    expect(html).toContain(".source-coverage { margin-top: 16px; border-radius: 22px; padding: 24px; }");
    expect(html).toContain(".source-lane-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }");
    expect(html).toContain("font-feature-settings: \"cv01\", \"ss03\"");
  });

  it("separates verified spend, estimated spend, verified usage evidence, and missing cost data in reports", () => {
    const markdown = generateMarkdownReport(input);
    const html = generateHtmlReport(input);

    expect(markdown).toContain("## Evidence quality ledger");
    expect(markdown).toContain("Verified spend: $25.00 across 1 record");
    expect(markdown).toContain("Estimated spend: $1.75 across 1 record");
    expect(markdown).toContain("Verified usage evidence: 2,460 tokens across 2 records");
    expect(markdown).toContain("Missing cost data: 1 record needs billing/source reconciliation");

    expect(html).toContain('class="evidence-quality"');
    expect(html).toContain('class="evidence-quality-grid"');
    expect(html).toContain('class="evidence-quality-card evidence-quality-card--verified"');
    expect(html).toContain('class="evidence-quality-card evidence-quality-card--estimated"');
    expect(html).toContain('class="evidence-quality-card evidence-quality-card--usage"');
    expect(html).toContain('class="evidence-quality-card evidence-quality-card--missing"');
    expect(html).toContain('class="provider-qa"');
    expect(html).toContain('class="provider-qa-card"');
    expect(html).toContain("Provider-by-provider live QA");
    expect(html).toContain("OpenAI costs API: 2 page(s), stopped because complete, provider limit 180 per page");
    expect(html).toContain("OpenAI usage API: 1 page(s), stopped because missing_cursor, provider limit 31 per page");
    expect(html).toContain("Rate limits: OpenAI costs API remaining 4 requests; retry after 2s");
    expect(html).toContain("Response drift: OpenAI usage API data[0].unexpected_bucket_key - unknown field observed in provider response");
    expect(html).toContain("Use an OpenAI admin key reference with organization usage and cost read access.");
    expect(html).toContain("Verified spend");
    expect(html).toContain("Estimated spend");
    expect(html).toContain("Verified usage evidence");
    expect(html).toContain("Missing cost data");
  });

  it("generates a coding-agent apply artifact from workflow watch", () => {
    const artifact = generateApplyArtifactMarkdown(input);

    expect(artifact).toContain("# AI Spend Apply Artifact");
    expect(artifact).toContain("Copy this into your coding agent to cut cost");
    expect(artifact).toContain("client-a / project-a / strategy_brief");
    expect(artifact).toContain("Estimated savings: $24.00");
    expect(artifact).toContain("Verification plan");
    expect(artifact).toContain("Do not change user-visible quality thresholds without approval");
  });

  it("builds the local-log apply artifact from the cut list and NAMED dead-context items", () => {
    const localRecords: UsageRecord[] = [
      {
        id: "local-1",
        timestamp: "2026-07-01T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local agent session logs", provider: "anthropic", confidence: "estimated", observedFrom: "test" },
        model: "claude-fable-5",
        inputTokens: 250_000,
        outputTokens: 5_000,
        amountUsd: 80,
        costConfidence: "estimated",
        agentId: "claude-code",
        providerCostType: "local_agent_logs",
        operation: "claude-code sessions"
      },
      {
        id: "local-2",
        timestamp: "2026-07-02T00:00:00.000Z",
        source: { id: "local-agent-logs", name: "Local agent session logs", provider: "anthropic", confidence: "estimated", observedFrom: "test" },
        model: "claude-fable-5",
        inputTokens: 180_000,
        outputTokens: 4_000,
        amountUsd: 60,
        costConfidence: "estimated",
        agentId: "claude-code",
        providerCostType: "local_agent_logs",
        operation: "claude-code sessions"
      }
    ];
    const artifact = generateApplyArtifactMarkdown({
      ...input,
      dataMode: "local_logs",
      allRecords: localRecords,
      deadContext: {
        hasData: true,
        loadedCount: 4,
        deadCount: 3,
        measuredDeadCount: 0,
        unmeasuredDeadCount: 3,
        deadTokens: 0,
        monthlyDeadTokens: 0,
        wastePercent: 0.75,
        monthlyUsd: 0,
        monthlyUsdUpperBound: 0,
        deadItems: [
          { kind: "mcp_server", name: "context7", alwaysLoadedTokens: 700, weightConfidence: "estimated_understated", path: "/Users/dev/.claude.json", ownerDirs: ["/Users/dev/site", "/Users/dev"] },
          { kind: "mcp_server", name: "framer", alwaysLoadedTokens: 700, weightConfidence: "estimated_understated", path: "/Users/dev/.claude.json", ownerDirs: ["/Users/dev/site"] }
        ],
        sessions: 20,
        totalTurns: 300,
        pricingModel: "claude-sonnet-4",
        windowDays: 30
      }
    });

    // Concrete, executable, from the same engines as the readout.
    expect(artifact).toContain('mcp server "context7" — used by projects: /Users/dev/site, /Users/dev (config: /Users/dev/.claude.json)');
    expect(artifact).toContain("claude mcp remove");
    // Hardened approval gate: forbids acting before approval, not just requests a diff.
    expect(artifact).toContain("APPROVAL GATE: do NOT use any file-editing or shell tool until I approve");
    expect(artifact).toContain("Shrink heavy context");
    expect(artifact).toContain("session-days");
    expect(artifact).toContain("Rollback");
    expect(artifact).toContain("npx aibill");
    // Agency workflow language must NOT leak into the coding-agent persona.
    expect(artifact).not.toContain("unmapped-client");
    expect(artifact).not.toContain("Margin at risk");
    expect(artifact).not.toContain("cache stable inputs");
  });

  it("renders the compact shareable HTML report for local-log data (no agency framing)", () => {
    const localRecords: UsageRecord[] = [{
      id: "local-1",
      timestamp: "2026-07-01T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local agent session logs", provider: "anthropic", confidence: "estimated", observedFrom: "test" },
      model: "claude-fable-5",
      inputTokens: 250_000,
      outputTokens: 5_000,
      amountUsd: 80,
      costConfidence: "estimated",
      agentId: "claude-code",
      projectId: "my-app",
      providerCostType: "local_agent_logs",
      operation: "claude-code sessions"
    }];
    const html = generateHtmlReport({
      ...input,
      dataMode: "local_logs",
      allRecords: localRecords,
      summary: analyzeSpend(localRecords),
      detectedPlans: [{
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        source: "test"
      }],
      deadContext: {
        hasData: true,
        loadedCount: 4,
        deadCount: 4,
        measuredDeadCount: 0,
        unmeasuredDeadCount: 4,
        deadTokens: 0,
        monthlyDeadTokens: 0,
        wastePercent: 1,
        monthlyUsd: 0,
        monthlyUsdUpperBound: 0,
        deadItems: [{ kind: "mcp_server", name: "context7", alwaysLoadedTokens: 700, weightConfidence: "estimated_understated", path: "/Users/dev/.claude.json" }],
        sessions: 10,
        totalTurns: 100,
        pricingModel: "claude-sonnet-4",
        windowDays: 30
      }
    });

    // Share-first content from the readout's own engines.
    expect(html).toContain("AI Receipt");
    expect(html).toContain("Plan value");
    expect(html).toContain("Claude Max 5x");
    expect(html).toContain("Dead context");
    expect(html).toContain("context7");
    expect(html).toContain("npx aibill");
    expect(html).toContain("my-app");
    // Agency board framing must not leak into the shareable report.
    expect(html).not.toContain("unmapped-client");
    expect(html).not.toContain("Margin risk");
    expect(html).not.toContain("Board-ready");
    expect(html).not.toContain("per-run budget cap");
    expect(html).not.toContain("Mapping questions");
  });

  it("quotes dynamic YAML values in policy/config drafts", () => {
    const policy = generatePolicyConfigDraftMarkdown({
      ...input,
      summary: {
        ...input.summary,
        workflowWatch: [{
          ...input.summary.workflowWatch[0]!,
          clientId: "client: risky # name",
          projectId: "project\nmalicious: true",
          workflowKey: "summary:write",
          agentId: "agent # comment"
        }]
      }
    });

    expect(policy).toContain('targetWorkflow: "client: risky # name/project\\nmalicious: true/summary:write"');
    expect(policy).toContain('targetAgent: "agent # comment"');
    expect(policy).not.toContain("malicious: true\n  targetAgent");
  });
});
