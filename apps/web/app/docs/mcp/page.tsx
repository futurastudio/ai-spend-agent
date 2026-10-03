import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "Tilden Workspace MCP — read-only AI client connection",
  description: "Connect a supported AI client to Tilden Workspace through assisted invited onboarding. Read spend, projects, briefings and budget settings with explicit consent.",
  alternates: { canonical: "/docs/mcp" },
};

const tools = [
  ["workspace_spend", "Read retained cost data, evidence labels and missing-data coverage for selected dates and accounts."],
  ["workspace_projects", "Read the project cost groups in the same Workspace report. Provider projects do not establish repository ownership or agent outcomes."],
  ["workspace_briefing", "Read the spending summary, available comparisons and investigation suggestions with their evidence and coverage."],
  ["workspace_budgets", "Read configured monthly budgets and their settings. Budget evaluations, reached thresholds and alert history are not included."],
] as const;

export default function McpDocsPage() {
  return (
    <DocsPage current="/docs/mcp" title="Ask your AI client about Workspace spend." intro="Workspace MCP gives a supported AI client read-only access to your Tilden reports. It is available through assisted invited onboarding, with explicit owner or admin consent for the requesting app." repoPath="apps/web/app/docs/mcp/page.tsx">
      <DocsSection id="access" label="01 · Access" title="Start with your invited Workspace">
        <p>You need an active invited Workspace, owner or admin access, and MCP enabled for that Workspace. Your onboarding contact helps confirm the client version and connection flow. Joining the <TextLink href="/#beta">waitlist</TextLink> does not immediately enable a Workspace or this endpoint.</p>
        <DocsCallout title="Choose the right MCP connection">This guide covers hosted Workspace reports over HTTP. To read evidence on your own machine without Workspace, use the separate <TextLink href="/docs/mcp/local">local aibill MCP reference</TextLink>.</DocsCallout>
      </DocsSection>

      <DocsSection id="connect" label="02 · Connect" title="Add the Workspace endpoint">
        <CodeBlock label="Remote MCP server URL">{`https://app.asktilden.com/api/workspace/mcp`}</CodeBlock>
        <ol className="list-decimal space-y-3 pl-5 marker:text-faint">
          <li>In the client selected during onboarding, add a remote HTTP MCP server using the URL above.</li>
          <li>Start the client&apos;s sign-in flow and sign in with your invited owner or admin account.</li>
          <li>On the Tilden consent screen, check the app name, Workspace and read-only access before choosing Allow access.</li>
          <li>Return to the client and confirm that the four Workspace tools appear. Read a report and compare it with Workspace using the same dates and accounts.</li>
        </ol>
        <DocsCallout title="Client setup is part of onboarding">Remote MCP and sign-in support vary by client and version. We confirm sign-in, report reads and connection management for the client you will use; support for every MCP client is not implied. A saved server configuration or successful sign-in alone does not confirm a report read.</DocsCallout>
        <p>Use the canonical URL exactly. Provider API keys, browser cookies and machine-sharing credentials are not MCP login credentials. The client follows the server&apos;s OAuth sign-in flow; provider keys stay out of the client configuration.</p>
      </DocsSection>

      <DocsSection id="tools" label="03 · Read reports" title="Four read-only tools">
        <div className="docs-status-grid" data-columns="2">
          {tools.map(([name, description]) => (
            <article key={name} className="docs-status-cell p-5"><h3 className="font-mono text-[13px] text-green">{name}</h3><p className="mt-2 text-sm leading-6 text-muted">{description}</p></article>
          ))}
        </div>
        <p className="mt-6">Spend, projects and briefing accept inclusive UTC start and end dates, plus optional connected account IDs within the consented Workspace. Budget reads return settings in pages. All tools read retained records; none triggers a provider refresh.</p>
        <CodeBlock label="Example request">{`Show my Workspace spend for September 1–30, 2026.
Name the included accounts and currency. Keep provider-reported costs,
estimates and missing coverage separate. Show the largest reported
project groups and one question worth investigating.
Do not infer per-person spend, savings or ROI from activity.`}</CodeBlock>
        <p>When separately enabled, Cursor and Copilot results retain their own periods and estimate labels. They are not added to the OpenAI/Anthropic cost report, its comparison, or each other. An unavailable report is not a zero-dollar result.</p>
      </DocsSection>

      <DocsSection id="consent" label="04 · Manage access" title="Review, expire or remove a connection">
        <p>Approval grants read-only access for seven days. The app can keep reading without a fresh sign-in until that access expires or is removed. Open <TextLink href="https://app.asktilden.com/settings/apps">Settings → Apps</TextLink> to review connections and remove access. If the page reports an uncertain outcome, check the recorded connection before starting a new request.</p>
        <p className="mt-4">Removing access stops future authorized reads. It cannot erase results an AI client already received. Those results follow the client&apos;s data policy. A fresh connection after removal may also require resetting that app&apos;s sign-in consent, as explained in Settings.</p>
        <DocsCallout title="What this connection can do">It can read the four report types above. It cannot change budgets, enforce provider limits, manage keys, upload machine activity or refresh provider data. Project ownership, budget evaluations and alert history are not included in these tools.</DocsCallout>
      </DocsSection>

      <DocsSection id="troubleshooting" label="05 · Troubleshooting" title="Check the connection and the evidence">
        <dl className="border-t border-hairline">
          {[
            ["Sign-in does not finish", "Return to the client and use its normal sign-in flow. Confirm the invited account and client version with your onboarding contact."],
            ["Access is unavailable", "Check that Workspace MCP is enabled, your owner or admin membership remains active, and the app connection has not expired or been removed."],
            ["A report is unavailable", "Check the requested dates, selected accounts and source coverage in Workspace. MCP reads existing records and cannot create missing provider data."],
            ["The answer differs from Workspace", "Compare the same period and accounts, then inspect the returned evidence labels and coverage. An AI-generated answer can omit qualifications present in the tool result."],
          ].map(([term, detail]) => (
            <div key={term} className="border-b border-hairline py-4"><dt className="font-medium text-ink">{term}</dt><dd className="mt-1 text-sm leading-6 text-muted">{detail}</dd></div>
          ))}
        </dl>
      </DocsSection>
    </DocsPage>
  );
}
