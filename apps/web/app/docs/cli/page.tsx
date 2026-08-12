import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "aibill CLI and Claude Code statusline docs",
  description: "Run a private AI cost receipt, connect provider reports, create an evidence-constrained Apply plan, and install the optional Claude Code statusline.",
  alternates: { canonical: "/docs/cli" },
};

const commandGroups = [
  {
    title: "Inspect",
    commands: [
      ["npx aibill", "Complete local readout; falls back to a clearly labeled demo only when supported evidence is absent."],
      ["npx aibill --group-by project", "Project breakdown; replace project with source, model, client, agent, user, workspace, or apiKey for another dimension."],
      ["npx aibill context", "Canonical hook-aware Context Health decision."],
      ["npx aibill doctor --sources", "Reader validation, financial evidence, freshness, and source errors."],
    ],
  },
  {
    title: "Act carefully",
    commands: [
      ["npx aibill apply", "Writes a copy-ready inspection, approval, rollback, and matched-verification plan from current trusted evidence."],
      ["npx aibill report", "Writes local Markdown and HTML reports from the selected evidence window."],
      ["npx aibill report-card", "Writes a redacted shareable SVG and caption."],
      ["npx aibill watch", "Records one or more local comparison cycles; one cycle is the cron-friendly default."],
    ],
  },
] as const;

export default function CliDocsPage() {
  return (
    <DocsPage
      current="/docs/cli"
      title="The complete private workflow."
      intro="Use the CLI to inspect the full evidence receipt, understand coverage, draft one bounded action, and compare what happened afterward. npm latest is v0.7.3."
      repoPath="apps/web/app/docs/cli/page.tsx"
    >
      <DocsSection id="first-run" label="01 · First run" title="Initialize once, inspect anytime">
        <CodeBlock label="Terminal">{`npx aibill init
npx aibill
npx aibill doctor --sources`}</CodeBlock>
        <p>
          Init performs a real 30-day machine-wide Claude Code and Codex financial scan. The project where you run it owns the project-local <code className="font-mono text-ink">.ai-spend-agent</code> state directory; init preserves existing connector, audit, and spend state. The private status cache contains aggregates—not prompts, responses, project names, transcript paths, session IDs, or credential references.
        </p>
        <p className="mt-4">
          Use <code className="font-mono text-ink">--plan &lt;id&gt;</code> only when automatic plan detection cannot identify your subscription. A plan label does not prove remaining entitlement or billed cost.
        </p>
      </DocsSection>

      <DocsSection id="commands" label="02 · Commands" title="Task-first command reference">
        <div className="space-y-9">
          {commandGroups.map((group) => (
            <div key={group.title}>
              <h3 className="text-lg font-medium text-ink">{group.title}</h3>
              <dl className="mt-4 border-t border-hairline">
                {group.commands.map(([command, description]) => (
                  <div key={command} className="grid gap-2 border-b border-hairline py-4 sm:grid-cols-[15rem_minmax(0,1fr)]">
                    <dt><code className="font-mono text-[13px] text-green">{command}</code></dt>
                    <dd className="text-sm leading-6 text-muted">{description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-7">
          The complete, version-matched list is always available from <code className="font-mono text-ink">npx aibill --help</code>.
        </p>
      </DocsSection>

      <DocsSection id="statusline" label="03 · Statusline" title="Ambient runway without an ambient scanner">
        <CodeBlock label="Install, refresh, remove">{`npx aibill statusline install
npx aibill statusline refresh
npx aibill statusline uninstall`}</CodeBlock>
        <p>
          The optional line is installed only in Claude Code, but its cache can hold separately labeled Claude Code and Codex cohorts. Claude Code asks the runner to render about every 30 seconds; that re-reads the cache and does <strong className="text-ink">not</strong> rescan transcripts. Use <code className="font-mono text-ink">statusline refresh</code> or rerun init when you need fresh evidence.
        </p>
        <ul className="mt-5 list-disc space-y-2 pl-5 marker:text-faint">
          <li>Metered mode leads with evidence-labeled dollars.</li>
          <li>Subscription mode leads with transcript-reported runway only; missing limits are not inferred.</li>
          <li>Mixed mode keeps subscribed runway and metered money separate.</li>
          <li><code className="font-mono text-ink">~</code> means API-equivalent value. Untilded <code className="font-mono text-ink">billed</code> money requires verified provider evidence.</li>
          <li>Cache evidence becomes stale after five minutes and is labeled accordingly.</li>
        </ul>
        <DocsCallout title="Reversible setup">
          Installation preserves the prior Claude status-line setting. Uninstall removes only aibill’s owned setting and restores the preserved predecessor; replacing an existing line requires the explicit <code className="font-mono text-ink">--replace</code> flag.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="providers" label="04 · Provider reports" title="Setup and sync are separate steps">
        <p>
          <code className="font-mono text-ink">connect</code> registers a local connector stub and prints the exact next command. It does not fetch billing data. Only <code className="font-mono text-ink">sync-provider</code> makes the read-only provider API request.
        </p>
        <CodeBlock label="Example · OpenAI">{`npx aibill connect openai
read -rsp "OpenAI Admin key: " OPENAI_ADMIN_KEY; printf "\\n"
export OPENAI_ADMIN_KEY
npx aibill sync-provider \
  --provider openai \
  --auth-reference env:OPENAI_ADMIN_KEY \
  --start-time <unix-seconds>`}</CodeBlock>
        <p>
          OpenAI and Anthropic connectors have non-empty live verification. Cursor and GitHub Copilot connectors remain fixture-verified beta pending live-account QA. Final invoices can still include credits, discounts, taxes, or later adjustments.
        </p>
      </DocsSection>

      <DocsSection id="apply" label="05 · Apply" title="A plan for an agent, not an autonomous change">
        <p>
          <code className="font-mono text-ink">npx aibill apply</code> writes a prompt, action plan, policy draft, verification plan, and demo package under the project’s <code className="font-mono text-ink">.ai-spend-agent/</code> directory. In local-transcript mode it freshly rereads the matching evidence. In connected-provider mode it uses receipt-bound state from the latest explicit sync and does not silently contact the provider. It changes no external system.
        </p>
        <p className="mt-4">
          The prompt asks a coding agent to inspect the cited candidates, show exact changes and rollback, wait for explicit approval, and compare matched future sessions. Sample Apply is explicitly non-executable. Provider buckets or daily aggregates that cannot prove a call-level counterfactual remain reconciliation evidence, not invented savings advice.
        </p>
        <DocsCallout title="Financial claim boundary" tone="preview">
          Local API-equivalent usage is observed comparison value. A cash-effect claim requires comparable provider-reported cost to fall while accepted output quality holds.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="next" label="06 · Continue" title="Add an interface only when it helps">
        <p>
          Install the <TextLink href="/docs/mcp">MCP server</TextLink> when an AI client should query the structured evidence on demand, or build the <TextLink href="/docs/glance">Glance source preview</TextLink> when you want a compact Mac monitor. Neither replaces the full CLI inspection and Apply workflow.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
