import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";
export const metadata: Metadata = { title: "Access, consent and renewal | Tilden docs", description: "Understand invited Workspace access, read-only MCP consent, token refresh, seven-day grant expiry and removing a connection.", alternates: { canonical: "/docs/access" } };
export default function AccessPage() {
  return <DocsPage current="/docs/access" updated="October 6, 2026" title="Know who can read your reports, and for how long." intro="Workspace admission, provider setup and an AI client's read access are separate decisions. Confirm each during assisted onboarding. These instructions describe the current invited hosted MCP flow, not every local CLI connection." repoPath="apps/web/app/docs/access/page.tsx">
    <DocsSection id="authorize" label="01 · Authorize" title="Check the app, workspace and scope">
      <p>An invited owner or administrator approves the requesting client on Tilden's consent screen. Check the app name, intended workspace and read-only scope before allowing access. Only connect the workspace and sources agreed during onboarding.</p>
      <p className="mt-4">MCP returns four report types: spend, projects, briefing and budget settings. It does not change budgets, enforce provider limits, refresh provider records or upload machine activity. Source credentials and browser cookies are not MCP login credentials.</p>
      <DocsCallout title="Separate choices">Optional CLI sharing has its own setup and consent. Removing an AI app connection does not by itself disconnect a provider or delete workspace data. Ask your onboarding contact about the specific connection or data you want removed.</DocsCallout>
    </DocsSection>
    <DocsSection id="renew" label="02 · Expiry and renewal" title="Token refresh does not renew consent">
      <p>The current approval grants read-only access for seven days. OAuth refresh can renew a short-lived access token while that grant remains valid; it does not extend the grant's lifetime.</p>
      <ol className="list-decimal legacy-space-y-3 pl-5 mt-5"><li>Before the next review, open <TextLink href="https://app.asktilden.com/settings/apps">Settings → Apps</TextLink> and check the connection's recorded status.</li><li>If the grant has expired, return through the client's sign-in and Tilden consent flow. Confirm the workspace and permissions again.</li><li>Read one scoped report to confirm access. A saved configuration or a successful sign-in is not evidence that the report succeeded.</li></ol>
      <p className="mt-5">Client behavior varies. If renewal loops or fails, stop and contact your onboarding owner with the client/version and error, without credentials. Do not repeatedly create connections to work around an uncertain state.</p>
    </DocsSection>
    <DocsSection id="remove" label="03 · Remove access" title="Check the recorded result">
      <p>Use <TextLink href="https://app.asktilden.com/settings/apps">Settings → Apps</TextLink> to review connections and remove the selected app's access. If the result is uncertain, inspect the recorded connection and ask your onboarding contact to confirm removal before reconnecting. A new connection may also require resetting the client's saved sign-in consent.</p>
      <p className="mt-4">Removal is intended to stop future authorized reads. It cannot erase reports the client already received. Test removal and denied future reads for the partner's setup during onboarding rather than assuming a founder demonstration validates every client.</p>
    </DocsSection>
    <DocsSection id="data" label="04 · Data boundaries" title="An AI client receives the report it requests">
      <p>Hosted Workspace retains the supported records you connect or explicitly share. MCP sends requested report results to the authorized client; those results then follow that client's data policy. A local-first statement about the CLI does not describe hosted Workspace.</p>
      <p className="mt-4">Review the <TextLink href="/privacy">privacy policy</TextLink> and <TextLink href="/docs/sources">source boundaries</TextLink>. For retention, deletion or procurement questions, contact <a href="mailto:contact@asktilden.com">contact@asktilden.com</a> before providing access. Do not include keys or sensitive report contents in a support email.</p>
    </DocsSection>
    <DocsSection id="troubleshooting" label="05 · If a read fails" title="Check access before changing the question">
      <ul className="list-disc legacy-space-y-3 pl-5"><li><strong>Access denied:</strong> confirm the invited account, current owner/admin membership, enabled workspace and grant status.</li><li><strong>Wrong workspace:</strong> stop the review and confirm the consented workspace with your onboarding contact.</li><li><strong>Report unavailable:</strong> inspect the dates and source coverage. Reconnecting cannot create missing historical records.</li></ul>
      <p className="mt-5"><TextLink href="/docs/first-review">Return to the first-review checklist →</TextLink></p>
    </DocsSection>
  </DocsPage>;
}
