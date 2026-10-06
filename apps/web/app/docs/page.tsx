import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "Tilden docs — Workspace, CLI and MCP",
  description: "Get started with Tilden Workspace, the local aibill CLI and read-only Workspace MCP. Understand access, supported sources and the evidence behind each number.",
  alternates: { canonical: "/docs" },
};

const surfaces = [
  { name: "Workspace", state: "Invited onboarding", copy: "Review supported provider costs, project and model breakdowns, briefings and budgets. Add explicitly shared coding-agent activity when your team wants that context.", href: "/docs/workspace" },
  { name: "CLI", state: "Public · runs locally", copy: "Use aibill to inspect Claude Code and Codex evidence on your machine, understand estimates and coverage, and prepare a bounded improvement test. No Workspace account is required.", href: "/docs/cli" },
  { name: "Workspace MCP", state: "Assisted invited setup", copy: "Let a supported AI client read your Workspace spend, projects, briefing and budget settings with owner or admin consent. Client setup is checked during onboarding.", href: "/docs/mcp" },
] as const;

export default function DocsOverviewPage() {
  return (
    <DocsPage current="/docs" title="Know where your AI spend goes." intro="Tilden gives you a shared Workspace, a local CLI and a read-only MCP connection for supported AI clients. Start with the guide for your job, then check the sources and coverage behind the answer." repoPath="apps/web/app/docs/page.tsx">
      <DocsSection id="start" label="01 · Start here" title="Choose how you want to work">
        <div className="docs-status-grid" data-columns="3">
          {surfaces.map((surface) => (
            <article key={surface.name} className="docs-status-cell p-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-green">{surface.state}</p>
              <h3 className="mt-3 text-lg font-medium text-ink">{surface.name}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{surface.copy}</p>
              <p className="mt-4 text-sm"><TextLink href={surface.href}>Open guide →</TextLink></p>
            </article>
          ))}
        </div>
        <DocsCallout title="Workspace access">
          Join the waitlist for future access. Selected partners are invited to assisted onboarding, where we agree on supported sources and setup. Joining does not create a Workspace or enable MCP immediately. No provider key is needed to join. <TextLink href="/#beta">Join the waitlist →</TextLink>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="quickstart" label="02 · Try the CLI" title="Start with the evidence on your machine">
        <p>With Node 22 or newer, run these commands inside a project. The local CLI needs no account or provider key. Tilden is the product; <code className="font-mono text-ink">aibill</code> remains the published command and package name.</p>
        <CodeBlock label="Terminal">{`npx aibill@latest init
npx aibill@latest`}</CodeBlock>
        <p>Init reads supported local metadata and creates or preserves local state. It does not connect the machine to Workspace. Empty evidence stays empty; use <code className="font-mono text-ink">--sample</code> only when you want a labeled demonstration. See the <TextLink href="/docs/cli">CLI guide</TextLink> for commands, telemetry controls and the optional Claude Code statusline.</p>
      </DocsSection>

      <DocsSection id="evidence" label="03 · Read the evidence" title="Cost, usage and activity answer different questions">
        <dl className="legacy-space-y-6">
          <div><dt className="font-medium text-ink">Provider-reported cost</dt><dd className="mt-1">Amounts returned by a supported provider cost source. These can be a known subtotal with missing or pending days, and can differ from the final invoice after credits, taxes or adjustments.</dd></div>
          <div><dt className="font-medium text-ink">Estimated value</dt><dd className="mt-1">A value with a stated calculation or incomplete billing basis. Local tokens priced at API list rates are API-equivalent estimates, not subscription charges. Estimates do not become provider-reported costs when shared.</dd></div>
          <div><dt className="font-medium text-ink">Shared activity</dt><dd className="mt-1">Supported machine-reported sessions, tokens and repository context. This can help you investigate work, but does not prove which person or agent caused a bill, whether a task was accepted, or its ROI.</dd></div>
        </dl>
        <p className="mt-7">Missing data is never silently treated as zero. Source availability, reader validation and the basis of a number stay separate. <TextLink href="/docs/sources">Read the source and evidence guide →</TextLink></p>
      </DocsSection>

      <DocsSection id="data" label="04 · Data choices" title="Understand what you connect">
        <p>The default CLI analysis runs on your machine. Optional provider requests, Workspace sharing and MCP connections are separate choices. Workspace is hosted and stores the supported records you connect or explicitly share; a local-first claim about the CLI does not describe Workspace.</p>
        <p className="mt-4">CLI usage telemetry is disclosed before sending and can be disabled with <code className="font-mono text-ink">aibill telemetry off</code>. A configured MCP client receives the tool results it requests, which then follow that client&apos;s data policy. Read the <TextLink href="/privacy">privacy policy</TextLink> for the full data flows.</p>
      </DocsSection>

      <DocsSection id="references" label="05 · More guides" title="Go deeper when you need it">
        <ul className="list-disc legacy-space-y-3 pl-5 marker:text-faint">
          <li><TextLink href="/docs/mcp/local">Local MCP reference</TextLink>: run the aibill stdio server against local evidence, without a Workspace account.</li>
          <li><TextLink href="/docs/glance">Glance source preview</TextLink>: build the optional local macOS monitor. A public signed download is not available.</li>
          <li><TextLink href="/docs/roadmap">Weekly roadmap</TextLink>: current priorities and what we are exploring.</li>
        </ul>
      </DocsSection>
    </DocsPage>
  );
}
