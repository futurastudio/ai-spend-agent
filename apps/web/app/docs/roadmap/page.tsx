import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection } from "@/components/DocsPage";
import { NPM_STABLE_VERSION } from "@/lib/docs";

export const metadata: Metadata = {
  title: "aibill product roadmap — now, next, and later",
  description: "A factual roadmap for aibill, separating published product, experimental boundaries, next-30-day priorities, and capabilities that are not yet available.",
  alternates: { canonical: "/docs/roadmap" },
};

export default function RoadmapDocsPage() {
  return (
    <DocsPage
      current="/docs/roadmap"
      title="Now, next, and not yet."
      intro="This is product direction, not a delivery guarantee. Published behavior lives in the release notes; every planned item remains unavailable until it passes its own evidence, privacy, compatibility, and release gates."
      repoPath="apps/web/app/docs/roadmap/page.tsx"
    >
      <DocsSection id="now" label="01 · Available now" title={`npm v${NPM_STABLE_VERSION}`}>
        <ul className="list-disc space-y-3 pl-5 marker:text-green">
          <li>Claude Code and Codex local evidence in the CLI, explicit MCP/plugin, private init/cache, and optional cache-only Claude Code statusline.</li>
          <li>Separate provider-billed cost, subscription context, API-equivalent value, validation coverage, freshness, and missing coverage.</li>
          <li>Optional OpenAI and Anthropic provider reports; Cursor and GitHub Copilot connectors remain fixture-verified beta.</li>
          <li>An experimental, fixture-verified Gemini CLI financial reader. It is financial-only and never enters statusline, Glance, Context Health, Apply, plan, runway, or invocation evidence.</li>
          <li>An additive Agent Economics Receipt v0 contract in <code className="font-mono text-ink">@agent-finops/core</code>, plus a registry and generated-doc foundation for local readers.</li>
          <li>An unsigned, source-built Glance preview. The public Mac download and shared Workspace are not launched.</li>
        </ul>
      </DocsSection>

      <DocsSection id="experimental" label="02 · Current boundary" title="Gemini CLI remains deliberately narrow">
        <DocsCallout title="Published experimental financial reader" tone="preview">
          Supported complete Gemini chat records can produce <code className="font-mono text-ink">estimated</code> API-equivalent value. Unknown, incomplete, inconsistent, or unsupported evidence stays <code className="font-mono text-ink">missing</code>. The reader is fixture-verified, not live-verified.
        </DocsCallout>
        <p>
          <code className="font-mono text-ink">logs.json</code> is detection-only and creates no financial row. Gemini does not feed statusline, Glance, Context Health, plan, runway, invocation evidence, recommendations, or Apply.
        </p>
      </DocsSection>

      <DocsSection id="next" label="03 · Next 30 days" title="Current focus areas, not an exhaustive build order">
        <ol className="space-y-7">
          {[
            ["1", "Deepen attribution and session evidence before outcomes", "Add branch, ticket, and work-unit attribution plus plan presets and session vitals before accepted/rejected/reverted/rework outcome states. The first verified unit is an accepted coding task or merged PR—not lines of code or modeled hours."],
            ["2", "Add financial CI without autonomous enforcement", "Start with warnings, preview, dry-run, explicit approval, rollback, and verified result. A real control adapter and team policy are prerequisites for any bounded action."],
            ["3", "Close distribution and comprehension proof", "Run the 8–12-person study, collect real billing-reconciliation cases, and complete signed, notarized, safely updated Glance distribution before offering a public download."],
            ["4", "Earn the organization foundation with design partners", "Test one read-only observability import and gather design-partner proof first. Then begin an opt-in aggregate receipt sync for shared reconciliation, allocation, and approval history. This is a foundation—not Workspace general availability."],
          ].map(([number, title, description]) => (
            <li key={number} className="grid gap-3 border-t border-hairline pt-5 sm:grid-cols-[2rem_minmax(0,1fr)]">
              <span className="font-mono text-sm text-green">{number}</span>
              <div>
                <h3 className="text-lg font-medium text-ink">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
              </div>
            </li>
          ))}
        </ol>
      </DocsSection>

      <DocsSection id="later" label="04 · Later" title="The paid accountability system">
        <p>
          The intended company product is an opt-in, permissioned Workspace over approved Agent Economics Receipts: organization-wide reconciliation, project/client/user/agent allocation, budgets, anomalies, approvals, audit history, accepted-outcome economics, and a read-only financial teammate that cites its evidence and missing coverage.
        </p>
        <p className="mt-4">
          Defensible ROI needs reconciled cost, an accepted outcome, and independently evidenced business value. Token volume, activity, lines of code, or invented hours saved are not ROI.
        </p>
      </DocsSection>

      <DocsSection id="not-yet" label="05 · Explicitly not yet" title="Do not mistake direction for product">
        <ul className="list-disc space-y-3 pl-5 marker:text-faint">
          <li>ROI or productivity claims from usage evidence alone.</li>
          <li>Autonomous budget enforcement or provider changes.</li>
          <li>Cursor-local financial parsing from current internal IDE databases; official admin APIs remain the financial path unless a stable, versioned local format emerges.</li>
          <li>General Workspace availability, RBAC, or team billing.</li>
          <li>A signed public Glance binary.</li>
          <li>A general trace explorer, prompt warehouse, model gateway, or long-tail parser race.</li>
        </ul>
      </DocsSection>
    </DocsPage>
  );
}
