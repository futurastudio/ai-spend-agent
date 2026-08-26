import type { Metadata } from "next";
import {
  CodeBlock,
  DocsCallout,
  DocsPage,
  DocsSection,
  TextLink,
} from "@/components/DocsPage";
import { NPM_STABLE_VERSION } from "@/lib/docs";

export const metadata: Metadata = {
  title: "aibill docs — private AI cost and usage evidence",
  description:
    "Install aibill, understand its evidence labels, and choose the CLI, Claude Code statusline, MCP, or Glance source preview.",
  alternates: { canonical: "/docs" },
};

const surfaces = [
  {
    name: "CLI",
    state: "Published",
    copy: "The complete private receipt, source diagnostics, reports, Context Health, the guided improve loop, and the evidence-constrained Apply workflow.",
    href: "/docs/cli",
  },
  {
    name: "Claude Code statusline",
    state: "Published · opt-in",
    copy: "A cache-only monitor for plan-aware Claude Code and Codex cohorts. It never scans transcripts or calls a provider while rendering.",
    href: "/docs/cli#statusline",
  },
  {
    name: "MCP",
    state: "Published · explicit",
    copy: "A structured interface for compatible AI clients. The client receives each tool result; approval and automatic-use behavior follow that client’s settings.",
    href: "/docs/mcp",
  },
  {
    name: "Glance",
    state: "Source preview",
    copy: "An unsigned native macOS hover surface over the shared Glance JSON contract. No public Mac download exists yet.",
    href: "/docs/glance",
  },
] as const;

export default function DocsOverviewPage() {
  return (
    <DocsPage
      current="/docs"
      title="Start with evidence you can inspect."
      intro="aibill turns supported local coding-agent metadata and optional provider reports into evidence-labeled views that keep local estimates, subscription context, and provider cost separate. This guide distinguishes what works today from preview and roadmap items."
      repoPath="apps/web/app/docs/page.tsx"
    >
      <DocsSection id="quickstart" label="01 · Quickstart" title="Your first private receipt">
        <p>
          Run init inside a specific project. On npm v{NPM_STABLE_VERSION} it reads the last 30 days of supported Claude Code, Codex, and experimental Gemini CLI financial metadata on this machine, prints a personal receipt, preserves or creates project-local aibill state, and seeds a private aggregate cache for Claude Code and Codex.
        </p>
        <CodeBlock label="Terminal">{`npx aibill init
npx aibill`}</CodeBlock>
        <p>
          Init uses real local evidence only. It does not substitute sample dollars and it does not install the statusline unless you explicitly pass <code className="font-mono text-ink">--statusline</code>. If the default readout finds no supported evidence, it says so and substitutes nothing — &ldquo;No sample data was substituted.&rdquo; Pass <code className="font-mono text-ink">--sample</code> to see a labeled demo on purpose.
        </p>
        <DocsCallout title="Requirements" tone="published">
          Node 22 or newer. The default local run needs no account, provider key, or signup.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="surfaces" label="02 · Choose a surface" title="One evidence model, different jobs">
        <div className="docs-status-grid" data-columns="2">
          {surfaces.map((surface) => (
            <article key={surface.name} className="docs-status-cell p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-green">{surface.state}</p>
              <h3 className="mt-3 text-lg font-medium text-ink">{surface.name}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{surface.copy}</p>
              <p className="mt-4 text-sm"><TextLink href={surface.href}>Open guide →</TextLink></p>
            </article>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="evidence" label="03 · Trust model" title="Three questions stay separate">
        <ol className="space-y-6">
          <li>
            <strong className="text-ink">What financial evidence supports this number?</strong>
            <p className="mt-1"><code className="font-mono text-ink">verified</code> is provider-reported and source-authoritative, though not necessarily a final invoice. <code className="font-mono text-ink">estimated</code> is local usage priced at published API rates. <code className="font-mono text-ink">detected_unverified</code> is a signal that has not been reconciled. <code className="font-mono text-ink">missing</code> means no supported cost basis exists.</p>
          </li>
          <li>
            <strong className="text-ink">How has the reader or connector been tested?</strong>
            <p className="mt-1"><code className="font-mono text-ink">live_verified</code>, <code className="font-mono text-ink">fixture_verified</code>, <code className="font-mono text-ink">untested</code>, and <code className="font-mono text-ink">failed</code> describe validation coverage. They never upgrade a number’s financial evidence.</p>
          </li>
          <li>
            <strong className="text-ink">Was this location approved for reading?</strong>
            <p className="mt-1">Folder approval is a permission boundary, not proof that its contents are financially verified.</p>
          </li>
        </ol>
        <p className="mt-7">
          Run <code className="font-mono text-ink">npx aibill doctor --sources</code> to inspect validation, financial evidence, freshness, and the latest sanitized error together.
        </p>
      </DocsSection>

      <DocsSection id="privacy" label="04 · Privacy" title="Local by default, explicit at every boundary">
        <p>
          CLI and Glance analysis runs locally; transcripts, prompts, file names, and dollar amounts are never uploaded. The CLI counts which commands run — anonymous, never your data or content — and sends nothing before a one-time printed notice. <code className="font-mono text-ink">aibill telemetry</code> shows the exact last payload verbatim; <code className="font-mono text-ink">aibill telemetry off</code> (or <code className="font-mono text-ink">DO_NOT_TRACK</code>, <code className="font-mono text-ink">AI_SPEND_NO_TELEMETRY</code>, <code className="font-mono text-ink">CI</code>) turns it off, and every receipt states the current mode. An explicit <code className="font-mono text-ink">sync-provider</code> call contacts only the selected provider using an inherited <code className="font-mono text-ink">env:NAME</code> reference. MCP returns the selected structured result to the invoking AI client, so that result follows the client’s own data policy.
        </p>
        <p className="mt-4">
          aibill rejects raw credential arguments and never sits in the inference path or stores, prints, or proxies provider credentials.
        </p>
      </DocsSection>

      <DocsSection id="boundary" label="05 · Product boundary" title="What is—and is not—available">
        <DocsCallout title={`Published · npm v${NPM_STABLE_VERSION}`} tone="published">
          Claude Code and Codex local evidence, the experimental Gemini CLI financial reader, the CLI with the guided <code className="font-mono text-ink">improve</code> loop and local accountability commands (<code className="font-mono text-ink">identify</code>, <code className="font-mono text-ink">outcome github</code>, <code className="font-mono text-ink">accountability</code>), optional Claude Code statusline, explicit MCP/plugin with the read-only <code className="font-mono text-ink">draft_improve_command</code> tool, provider connectors, parser registry, generated source documentation, and the additive Receipt v0 core contract.
        </DocsCallout>
        <DocsCallout title="Gemini CLI · published experimental boundary" tone="preview">
          Gemini is <code className="font-mono text-ink">fixture_verified</code>, not live-verified. Its supported chat records can contribute estimated API-equivalent financial value or missing evidence, but it does not feed statusline, Glance, Context Health, Apply, plan, runway, or invocation surfaces.
        </DocsCallout>
        <p>
          Workspace, company-wide reconciliation, accepted-outcome economics, ROI measurement, autonomous enforcement, and a signed Glance download are not shipped. See the factual <TextLink href="/docs/roadmap">Now / Next / Later roadmap</TextLink>.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
