import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";
import { NPM_STABLE_VERSION, NPM_VERSION_CHECKED, REPO_URL, localSources, providerSources, workspaceSources } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Tilden sources — Workspace, CLI and evidence coverage",
  description: "Compare Workspace and local CLI source support. Understand provider-reported costs, estimates, shared activity and missing coverage before using a number.",
  alternates: { canonical: "/docs/sources" },
};

export default function SourcesDocsPage() {
  return (
    <DocsPage updated="October 7, 2026"
      current="/docs/sources"
      title="Know where every number stops."
      intro="Workspace connections and local CLI readers have different setup and availability. For both, source support, reader validation and the evidence behind a number remain separate."
      repoPath="apps/web/app/docs/sources/page.tsx"
    >
      <DocsSection id="review-scope" label="Before your first review" title="Agree what the report can cover">
        <p>With your onboarding contact, record the workspace, connected accounts, currency, inclusive UTC dates, source freshness and known missing days. Confirm source-specific administrative permissions before connecting; do not send provider keys in email or chat.</p>
        <ul className="list-disc legacy-space-y-3 pl-5 mt-5">
          <li><strong>OpenAI and Anthropic API costs:</strong> invited setup, subject to accessible provider records and retained history. Project detail depends on what those records contain.</li>
          <li><strong>Historical limits:</strong> available history varies by connected source. Check coverage before treating a subtotal as a complete-period answer, and do not add overlapping records.</li>
          <li><strong>Coding activity:</strong> optional Claude Code and Codex sharing needs explicit setup and consent. Sessions and repository labels do not allocate the provider bill.</li>
          <li><strong>Cursor and Copilot:</strong> separate pilot checks are required. Broad real-account coverage is not established; do not depend on these facets without explicit acceptance for your setup.</li>
        </ul>
        <p className="mt-5">If the requested period is incomplete, keep the gap visible. Agree a narrower useful review explicitly or pause that question. An unavailable answer is not zero spend. <TextLink href="/docs/first-review">Prepare the review →</TextLink></p>
      </DocsSection>
      <DocsSection id="labels" label="01 · Read the labels" title="Three axes, one source row">
        <div className="docs-status-grid" data-columns="3">
          {[
            ["Availability", "Published, experimental, beta, planned, or unavailable in the version you are running."],
            ["Reader validation", "live_verified, fixture_verified, untested, or failed—the path’s test coverage."],
            ["Financial evidence", "verified, estimated, detected_unverified, or missing—the basis of a particular number."],
          ].map(([title, description]) => (
            <article key={title} className="docs-status-cell p-5">
              <h3 className="text-base font-medium text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
            </article>
          ))}
        </div>
        <p className="mt-6">
          A live-verified local reader still produces API-equivalent <code className="font-mono text-ink">estimated</code> values, not billed spend. Approving a folder is a separate read boundary and verifies neither the reader nor the money.
        </p>
        <p className="mt-4">
          In CLI output, <code className="font-mono text-ink">verified</code> means provider-reported and source-authoritative; it does not guarantee a final invoice. <code className="font-mono text-ink">estimated</code> states a calculation or qualified billing basis, <code className="font-mono text-ink">detected_unverified</code> is an unreconciled signal, and <code className="font-mono text-ink">missing</code> means a supported cost basis is absent. Workspace reports use their displayed source labels and coverage.
        </p>
      </DocsSection>

      <DocsSection id="workspace" label="02 · Workspace" title="Hosted sources and optional shared activity">
        <p>Workspace access is invitation-only. Source setup and availability are confirmed during assisted onboarding; a published CLI connector does not automatically enable that provider in Workspace.</p>
        <div className="mt-6 legacy-space-y-7">
          {workspaceSources.map((source) => (
            <article key={source.name} className="border-t border-hairline pt-5">
              <h3 className="text-lg font-medium text-ink">{source.name}</h3>
              <p className="mt-2 font-mono text-[11px] text-green">{source.availability}</p>
              <p className="mt-3 text-sm font-medium text-ink">{source.evidence}</p>
              <p className="mt-2">{source.summary}</p>
            </article>
          ))}
        </div>
        <DocsCallout title="Keep scope attached to the amount">
          Provider reports can differ in billing period, currency, freshness and coverage. OpenAI and Anthropic known subtotals can exclude unavailable records. Shared machine activity does not allocate these totals to people, agents or outcomes. Compare like-for-like scopes and preserve gaps. <TextLink href="/docs/workspace#costs">Read a Workspace report →</TextLink>
        </DocsCallout>
        <p>Jev, Kimi and other planned integrations are not included as supported Workspace sources here. Historical availability depends on each connected source; there is no promise of complete account history.</p>
      </DocsSection>

      <DocsSection id="local" label="03 · Local CLI readers" title="On-device transcript metadata">
        <p className="mb-6">The following entries describe the local aibill CLI and local MCP. The public CLI version is v{NPM_STABLE_VERSION}, checked {NPM_VERSION_CHECKED}.</p>
        <div className="legacy-space-y-8">
          {localSources.map((source) => (
            <article key={source.id} id={source.id} className="scroll-mt-24 border-t border-hairline pt-6">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-baseline">
                <div>
                  <h3 className="text-xl font-medium text-ink">{source.name}</h3>
                  <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.1em] text-faint">{source.provider}</p>
                </div>
                <p className="font-mono text-[11px] text-green">{source.availability}</p>
              </div>
              <p className="mt-4">{source.summary}</p>
              <dl className="mt-5 grid border-l border-t border-hairline sm:grid-cols-2">
                {[
                  ["Reader validation", source.validation],
                  ["Financial evidence", source.evidence],
                  ["Product surfaces", source.surfaces],
                ].map(([term, value]) => (
                  <div key={term} className="border-b border-r border-hairline p-4 last:sm:col-span-2">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">{term}</dt>
                    <dd className="mt-2 text-sm leading-6 text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-sm">
                <a href={`${REPO_URL}/blob/main/docs/sources/${source.id}.md`} target="_blank" rel="noreferrer" className="text-ink underline decoration-hairline-bright underline-offset-4 hover:decoration-green">
                  Read the generated format boundary ↗
                </a>
              </p>
            </article>
          ))}
        </div>
        <DocsCallout title="Gemini experimental boundary" tone="preview">
          Gemini CLI is published in npm v{NPM_STABLE_VERSION} as an experimental, <code className="font-mono text-ink">fixture_verified</code>, financial-only reader. Its <code className="font-mono text-ink">logs.json</code> file is presence-only; financial evidence comes only from supported chat-session JSON/JSONL records and incomplete shapes remain missing. Gemini is excluded from statusline, Glance, Context Health, Apply, plan, runway, and invocation evidence.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="providers" label="04 · CLI provider reports" title="Official APIs, explicit local sync">
        <p className="mb-6">These are optional local CLI connectors. The Workspace setup above is separate. CLI connection registration and an explicit provider sync are also separate steps.</p>
        <div className="legacy-space-y-7">
          {providerSources.map((source) => (
            <article key={source.id} id={source.id} className="scroll-mt-24 border-t border-hairline pt-5">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-baseline">
                <h3 className="text-lg font-medium text-ink">{source.name}</h3>
                <p className="font-mono text-[11px] text-green">{source.availability}</p>
              </div>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Validation</dt>
                <dd className="text-ink">{source.validation}</dd>
                <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Evidence</dt>
                <dd className="text-ink">{source.evidence}</dd>
                <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Requires</dt>
                <dd>{source.requirement}</dd>
              </dl>
            </article>
          ))}
        </div>
        <p className="mt-7">
          Connector validation never makes every returned row verified. The endpoint, record, coverage window, and final invoice boundary still determine the label.
          {" "}<TextLink href="/docs/cli#providers">Open provider setup →</TextLink>
          {" · "}<a href={`${REPO_URL}/blob/main/docs/sources/provider-contracts.md`} target="_blank" rel="noreferrer" className="text-ink underline decoration-hairline-bright underline-offset-4 hover:decoration-green">Review the versioned provider contracts ↗</a>
        </p>
      </DocsSection>

      <DocsSection id="unsupported" label="05 · Coverage gaps" title="Missing is a product answer">
        <p>
          Cursor local session storage, Cline, Aider, and other long-tail local formats do not currently produce financial rows. The investigated Cursor local store did not provide sufficiently stable evidence for routed model, billing mode, token semantics, adjustments, or reconciled spend, so a speculative local financial parser is not currently planned; official admin APIs remain the financial path unless a stable, versioned local format emerges.
        </p>
        <p className="mt-4">
          New local formats enter through the public parser registry with a descriptor, synthetic recorded fixtures, conservative evidence defaults, generated source documentation, and privacy checks. Unknown models or token shapes stay <code className="font-mono text-ink">missing</code>, never estimated as zero.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
