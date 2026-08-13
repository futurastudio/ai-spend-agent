import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";
import { REPO_URL, localSources, providerSources } from "@/lib/docs";

export const metadata: Metadata = {
  title: "aibill supported sources and evidence coverage",
  description: "See which local coding-agent and provider sources aibill supports, how each reader has been validated, and which financial evidence it can produce.",
  alternates: { canonical: "/docs/sources" },
};

export default function SourcesDocsPage() {
  return (
    <DocsPage
      current="/docs/sources"
      title="Know where every number stops."
      intro="Availability, reader validation, and financial evidence are independent. This page keeps all three visible so a supported source is never mistaken for a verified bill."
      repoPath="apps/web/app/docs/sources/page.tsx"
    >
      <DocsSection id="labels" label="01 · Read the labels" title="Three axes, one source row">
        <div className="docs-status-grid" data-columns="3">
          {[
            ["Availability", "Published, merged preview, beta, planned, or unavailable in the version you are running."],
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
      </DocsSection>

      <DocsSection id="local" label="02 · Local coding agents" title="On-device transcript metadata">
        <div className="space-y-8">
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
        <DocsCallout title="Gemini release boundary" tone="preview">
          Gemini CLI is merged for v0.8.0 but is not available from npm latest v0.7.3. Its <code className="font-mono text-ink">logs.json</code> file is presence-only; financial evidence comes only from supported chat-session JSON/JSONL records and incomplete shapes remain missing.
        </DocsCallout>
      </DocsSection>

      <DocsSection id="providers" label="03 · Provider reports" title="Official APIs, explicit connection">
        <div className="space-y-7">
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

      <DocsSection id="unsupported" label="04 · Coverage gaps" title="Missing is a product answer">
        <p>
          Cursor local session storage, Cline, Aider, and other long-tail local formats do not currently produce financial rows. The investigated Cursor local store did not provide sufficiently stable evidence for routed model, billing mode, token semantics, adjustments, or reconciled spend, so a speculative local financial parser is not planned for v0.8.x.
        </p>
        <p className="mt-4">
          New local formats enter through the public parser registry with a descriptor, synthetic recorded fixtures, conservative evidence defaults, generated source documentation, and privacy checks. Unknown models or token shapes stay <code className="font-mono text-ink">missing</code>, never estimated as zero.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
