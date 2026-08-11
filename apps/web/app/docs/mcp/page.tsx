import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "aibill MCP setup for Codex, Claude Code, and Cursor",
  description: "Connect the local-first aibill MCP server to a compatible AI client and understand its eight evidence tools and safety boundaries.",
  alternates: { canonical: "/docs/mcp" },
};

const tools = [
  ["scan_ai_spend", "Discover provider and configuration signals inside one caller-supplied absolute path and persist local discovery state."],
  ["sync_local_agent_spend", "Read supported local coding-agent financial metadata and persist a local report."],
  ["sync_provider_spend", "Read provider billing or usage through an env-reference credential."],
  ["get_usage_glance", "Return the read-only Claude Code/Codex Glance contract."],
  ["get_context_health", "Return canonical hook-aware Context Health."],
  ["list_sources", "Show approved sources and separate status axes."],
  ["get_spend_report", "Return the current local, provider, or explicitly labeled sample report."],
  ["recommend_cuts", "Legacy compatibility name for evidence-constrained candidate inspection."],
] as const;

export default function McpDocsPage() {
  return (
    <DocsPage
      current="/docs/mcp"
      title="Let your AI client ask the receipt."
      intro="The aibill MCP server exposes the same evidence contract as structured, explicit tools. It is local stdio—not an always-on prompt, proxy, or cloud service."
      repoPath="apps/web/app/docs/mcp/page.tsx"
    >
      <DocsSection id="install" label="01 · Install" title="Choose your MCP client">
        <h3 className="text-lg font-medium text-ink">Codex</h3>
        <CodeBlock label="Terminal">{`codex mcp add aibill -- npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
codex mcp list`}</CodeBlock>
        <h3 className="mt-8 text-lg font-medium text-ink">Claude Code</h3>
        <CodeBlock label="Terminal">{`claude mcp add --scope user aibill -- npx --yes --package @agent-finops/mcp@latest ai-spend-mcp
claude mcp list`}</CodeBlock>
        <h3 className="mt-8 text-lg font-medium text-ink">Cursor or another stdio client</h3>
        <CodeBlock label="mcp.json">{`{
  "mcpServers": {
    "aibill": {
      "command": "npx",
      "args": ["--yes", "--package", "@agent-finops/mcp@latest", "ai-spend-mcp"]
    }
  }
}`}</CodeBlock>
        <p>
          Use <code className="font-mono text-ink">~/.cursor/mcp.json</code> for all Cursor projects or <code className="font-mono text-ink">.cursor/mcp.json</code> for one project. Other clients use the same command and arguments at their documented local stdio configuration path.
        </p>
        <DocsCallout title="Stable version boundary" tone="published">
          npm latest v0.7.3 reads Claude Code and Codex local evidence. Gemini financial parsing is merged on main for v0.8.0 but is not yet in <code className="font-mono text-ink">@agent-finops/mcp@latest</code>.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="tools" label="02 · Tools" title="Eight bounded operations">
        <div className="docs-status-grid" data-columns="2">
          {tools.map(([name, description]) => (
            <article key={name} className="docs-status-cell p-5">
              <h3 className="font-mono text-[13px] text-green">{name}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
            </article>
          ))}
        </div>
        <p className="mt-6">
          Each scan/sync tool may write local aibill state; <code className="font-mono text-ink">sync_provider_spend</code> also contacts the selected provider API. The get, list, and recommendation tools are read-only. <code className="font-mono text-ink">recommend_cuts</code> can return an evidence gap or observed exposure instead of a cut; the name remains for compatibility.
        </p>
      </DocsSection>

      <DocsSection id="workflow" label="03 · Recommended flow" title="Sync, ask, inspect the basis">
        <CodeBlock label="Suggested agent request">{`Use aibill to sync my local coding-agent evidence for this project.
Then show the spend report, source status, Context Health, and one
evidence-constrained next action. Keep billed cost, API-equivalent value,
subscription context, and missing evidence separate.`}</CodeBlock>
        <ol className="list-decimal space-y-2 pl-5 marker:text-faint">
          <li>Call <code className="font-mono text-ink">sync_local_agent_spend</code> with a specific absolute project path.</li>
          <li>Read <code className="font-mono text-ink">get_spend_report</code> and <code className="font-mono text-ink">list_sources</code>.</li>
          <li>Ask for <code className="font-mono text-ink">get_context_health</code> or <code className="font-mono text-ink">get_usage_glance</code> only when that decision surface helps.</li>
          <li>Use the CLI Apply workflow for the complete approval, rollback, and verification artifact.</li>
        </ol>
        <p className="mt-5">
          With no synced state, <code className="font-mono text-ink">get_spend_report</code> can return an unmistakably labeled, in-memory demo fallback. It does not silently become user evidence or create project state.
        </p>
      </DocsSection>

      <DocsSection id="safety" label="04 · Safety" title="The client and provider are different boundaries">
        <ul className="list-disc space-y-3 pl-5 marker:text-faint">
          <li>State tools require a specific absolute project path; home, filesystem, and system roots are refused.</li>
          <li>Raw provider keys are rejected. Provider tools accept an inherited <code className="font-mono text-ink">env:NAME</code> reference.</li>
          <li>Provider syncs are read-only against the selected provider API.</li>
          <li>aibill sends no telemetry and does not upload transcript contents.</li>
          <li>The selected structured tool result is returned to the invoking AI client and then follows that client’s data policy.</li>
          <li>A project cannot declare its own connected totals trusted; a separate hash-only local receipt binds trusted provider state to this machine.</li>
        </ul>
      </DocsSection>

      <DocsSection id="troubleshooting" label="05 · Troubleshooting" title="Fast checks">
        <dl className="border-t border-hairline">
          {[
            ["Tools do not appear", "Run the exact npx server command in a terminal, confirm Node 22+, restart the client, and verify that it supports local stdio MCP."],
            ["Provider returns 401 or 403", "Use an organization/admin billing-read credential rather than a normal inference API key."],
            ["A path is refused", "Select one project directory. Broad-root refusal is intentional prompt-injection protection."],
            ["Report says sample", "Run a local or provider sync for real evidence. An automatic sample is demo-only and not persisted."],
          ].map(([term, detail]) => (
            <div key={term} className="border-b border-hairline py-4">
              <dt className="font-medium text-ink">{term}</dt>
              <dd className="mt-1 text-sm leading-6 text-muted">{detail}</dd>
            </div>
          ))}
        </dl>
      </DocsSection>
    </DocsPage>
  );
}
