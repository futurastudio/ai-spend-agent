import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";
export const metadata: Metadata = { title: "Your first AI spending review | Tilden docs", description: "Prepare an invited, scoped Tilden review: agree sources and dates, inspect four read-only reports and compare the evidence.", alternates: { canonical: "/docs/first-review" } };
export default function FirstReviewPage() {
  return <DocsPage current="/docs/first-review" updated="October 6, 2026" title="Leave the first review with an answer you can inspect." intro="Start with one question engineering and finance already need to answer. This guide is for invited partners after their workspace, source scope and client setup have been accepted during onboarding." repoPath="apps/web/app/docs/first-review/page.tsx">
    <DocsSection id="prepare" label="01 · Before setup" title="Bring a question and the right people">
      <ol className="list-decimal legacy-space-y-3 pl-5"><li>Name the decision and the person who needs the answer. For example: which reported project costs need investigation before the next budget review?</li><li>Identify the workspace owner or administrator who can authorize access and a finance reviewer who can check the result.</li><li>Agree sources, account IDs, currency and inclusive UTC dates with your onboarding contact. Record the latest available data and any missing days.</li><li>Have comparable source records ready for the same period. Do not paste provider keys, browser cookies or credentials into an AI conversation.</li></ol>
      <DocsCallout title="Not invited yet?">Register interest in an <TextLink href="/solutions">assisted review</TextLink>. A waitlist signup does not create a workspace, approve access or book a session.</DocsCallout>
    </DocsSection>
    <DocsSection id="connect" label="02 · Confirm access" title="A connection is only the starting point">
      <p>Use the client and setup path agreed during onboarding. For hosted MCP, follow the <TextLink href="/docs/mcp#connect">connection guide</TextLink>, inspect the app and workspace on the consent screen, and confirm that all four tools appear. A founder weekly review in ChatGPT Work has been demonstrated; acceptance of your own workspace and client remains a separate step.</p>
      <p className="mt-4">Read <TextLink href="/docs/access">how consent, expiry and removal work</TextLink>.</p>
    </DocsSection>
    <DocsSection id="review" label="03 · Read the reports" title="Keep the scope beside the answer">
      <CodeBlock label="Example review request">{`Review my workspace for the agreed UTC start and end dates.
Name the included accounts, currency, freshness and missing coverage.
Show supported spend and available project detail, summarize the briefing,
and list budget settings separately. Do not treat settings as enforcement.
Keep estimates and shared activity separate from provider-reported costs.
Identify one question to investigate; do not infer ROI or individual spend.`}</CodeBlock>
      <ol className="list-decimal legacy-space-y-3 pl-5"><li><strong>Spend:</strong> check the period and accounts before interpreting the total. Identify incomplete or unavailable coverage.</li><li><strong>Projects:</strong> inspect the available provider project groups. Unattributed amounts stay unattributed; repository activity is separate evidence.</li><li><strong>Briefing:</strong> check the evidence behind a suggested investigation. A spike is not automatically waste.</li><li><strong>Budget settings:</strong> read configured amounts and settings. These reports do not enforce limits or report every budget evaluation.</li></ol>
    </DocsSection>
    <DocsSection id="check" label="04 · Check the answer" title="Compare the same thing twice">
      <p>Compare the report with Workspace and the available source records using the same dates, accounts and currency. Keep credits, taxes, timing and missing records in view when an invoice differs. Do not combine overlapping history or silently shorten the requested period to produce a complete-looking answer.</p>
      <DocsCallout title="If the answer is unavailable or inconsistent">Record the request, scope, report status and the discrepancy without secrets. Check <TextLink href="/docs/sources#review-scope">coverage</TextLink> with your onboarding contact. Pause the financial conclusion until the difference is explained; do not interpret refusal or missing history as zero.</DocsCallout>
    </DocsSection>
    <DocsSection id="next" label="05 · Agree the next review" title="Record what was useful and what remains open">
      <p>Write down the answered question, remaining uncertainty, next investigation and review effort, including hands-on assistance. Agree whether a second review would be useful and check the <TextLink href="/docs/access#renew">access expiry</TextLink> before it. Connection alone is not a successful review.</p>
      <p className="mt-4">If the question is about return, an <TextLink href="/solutions#value-pilot">assisted AI Value Pilot</TextLink> can help define one outcome baseline. Current cost reports do not automatically measure productivity, useful outputs or ROI.</p>
    </DocsSection>
  </DocsPage>;
}
