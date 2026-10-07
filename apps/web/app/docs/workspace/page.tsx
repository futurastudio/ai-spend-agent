import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "Tilden Workspace guide — costs, activity and briefings",
  description: "Learn how invited teams set up Tilden Workspace, review provider-reported costs and coverage, share coding-agent activity and connect an AI client.",
  alternates: { canonical: "/docs/workspace" },
};

const views = [
  ["Overview", "Start with the selected date range and provider accounts. Read the reported subtotal together with coverage and freshness, then use the chart and project or model groups to investigate."],
  ["Projects", "Review the cost groups reported by supported sources. Provider project names do not automatically identify a repository, a person or an accepted business outcome."],
  ["Briefing", "Read the spending summary, available comparisons and questions worth investigating for your selected period. Missing data and insufficient comparison evidence remain visible."],
  ["Controls", "Review configured budgets and the evaluations available for them. Budget notices depend on observed costs and coverage; a configured budget is not a provider spending limit."],
  ["Connections", "Connect supported provider sources, inspect their read status and manage available key controls. The onboarding team helps confirm the right account and permissions."],
  ["Settings and activity", "Manage your profile, members and available machine or app connections. Your activity keeps provider-key context, shared machine activity and briefing history distinct."],
] as const;

export default function WorkspaceDocsPage() {
  return (
    <DocsPage updated="October 7, 2026" current="/docs/workspace" title="A shared view of supported AI spend." intro="Use Workspace to review provider costs and coverage with your team, investigate project and model changes, and bring explicitly shared coding-agent activity into the conversation." repoPath="apps/web/app/docs/workspace/page.tsx">
      <DocsCallout title="Announcement · ChatGPT Pilot">
        We’re bringing Tilden Workspace to ChatGPT. The planned plugin will give you read-only access to supported spend, projects, briefings and budget settings, with coverage alongside the answer. Public availability is planned. <TextLink href="/docs/plugin">Explore the ChatGPT Pilot →</TextLink>
      </DocsCallout>
      <DocsSection id="access" label="01 · Access" title="Begin with invited onboarding">
        <p>Workspace is invitation-only. <TextLink href="/#beta">Join the waitlist</TextLink> to express interest; selected partners receive an invitation and help setting up supported sources. A waitlist submission does not provide immediate access. Existing invited members can <TextLink href="https://app.asktilden.com/sign-in">sign in to Workspace</TextLink>.</p>
        <ol className="mt-6 list-decimal legacy-space-y-3 pl-5 marker:text-faint">
          <li>Agree on the accounts and questions you want to review during onboarding.</li>
          <li>Accept your Workspace invitation and sign in with the invited account.</li>
          <li>Ask the appropriate provider organization owner or admin to connect supported cost sources.</li>
          <li>Review the first report together, including missing coverage, before drawing conclusions.</li>
        </ol>
        <DocsCallout title="Start with supported sources">OpenAI and Anthropic provider connections are the core cost sources. Cursor Admin and GitHub Copilot are guided beta connections; ask about assisted setup. Real-account acceptance is still pending. Confirm scope during onboarding; a provider logo is not a promise of complete history. <TextLink href="/docs/sources#workspace">See Workspace source coverage →</TextLink></DocsCallout>
      </DocsSection>

      <DocsSection id="views" label="02 · Find your answer" title="Where to look in Workspace">
        <dl className="border-t border-hairline">
          {views.map(([name, description]) => (
            <div key={name} className="grid gap-2 border-b border-hairline py-5 sm:grid-cols-[9rem_minmax(0,1fr)]"><dt className="font-medium text-ink">{name}</dt><dd>{description}</dd></div>
          ))}
        </dl>
      </DocsSection>

      <DocsSection id="costs" label="03 · Read a report" title="Keep the amount and its coverage together">
        <p>Choose the period and accounts before comparing reports. OpenAI and Anthropic cost views can show a provider-reported known subtotal even when some daily records are unavailable. Read the included, pending and missing coverage next to the amount. Missing days do not mean zero spend, and a subtotal is not a final invoice.</p>
        <p className="mt-4">Usage records, local machine tokens and cost records can cover different periods. Available history depends on each connected source and the records retained for it. Some Usage views currently require shorter date ranges; if a range is unavailable, narrow the range rather than interpreting it as no usage.</p>
        <p className="mt-4">Where enabled, Cursor and Copilot amounts retain their own period and estimate labels. They are shown separately from the OpenAI/Anthropic reported subtotal. Budget evaluations and comparisons also retain their stated scope.</p>
      </DocsSection>

      <DocsSection id="activity" label="04 · Optional activity sharing" title="Bring in Claude Code and Codex context">
        <p>An invited member can pair a supported machine from Settings → Machines and explicitly share eligible local session facts. Follow the enrollment instructions in Workspace and the terminal; connecting the machine and approving a push are separate steps.</p>
        <CodeBlock label="Start pairing · invited Workspace required">{`npx aibill@latest workspace connect`}</CodeBlock>
        <p>After completing browser and terminal enrollment, review the sharing scope in Settings. The push command previews the exact outgoing facts and asks for confirmation. A default local CLI readout does not share session facts with Workspace.</p>
        <CodeBlock label="Review and share after enrollment">{`npx aibill@latest workspace status
npx aibill@latest workspace push`}</CodeBlock>
        <p>Shared records contain supported session counts, token counts and repository labels where available. The push excludes raw prompts, transcript contents, full paths, raw session IDs and dollar amounts. Unknown token values and unattributed activity stay visible instead of being filled in.</p>
        <DocsCallout title="Activity is context">Machine tokens remain separate from provider-reported tokens and costs. A member saving a provider key does not prove that member incurred all its spend. Repository or session activity does not establish the cost of an agent, an accepted task, productivity or ROI.</DocsCallout>
        <p>Use <code className="font-mono text-ink">npx aibill@latest workspace disconnect</code> to review revocation from the CLI, or manage the machine in Settings. Revocation stops future uploads; previously accepted records follow the disclosed retention policy. The <TextLink href="/docs/cli#workspace">CLI reference</TextLink> explains recovery when a connection or push outcome is uncertain.</p>
      </DocsSection>

      <DocsSection id="mcp" label="05 · Ask from your AI client" title="Connect read-only Workspace MCP">
        <p>Workspace MCP is available through assisted invited onboarding. An owner or admin reviews the requesting app and Workspace before granting access to spend, projects, briefing and budget settings. It cannot refresh providers, change budgets or manage keys. Follow the <TextLink href="/docs/mcp">Workspace MCP guide</TextLink>; supported client setup is confirmed during onboarding.</p>
      </DocsSection>

      <DocsSection id="help" label="06 · If something is missing" title="Check scope before the number">
        <ul className="list-disc legacy-space-y-3 pl-5 marker:text-faint">
          <li>Confirm the selected dates and accounts, source status and last successful read.</li>
          <li>Check whether the view shows provider cost, provider usage or machine activity.</li>
          <li>For a new connection, wait for its first accepted read; a saved key alone is not a completed report.</li>
          <li>Share the visible status and selected period with your onboarding contact. Keep provider keys and private credentials out of support messages.</li>
        </ul>
        <p className="mt-6">See <TextLink href="/docs/sources">Sources</TextLink> for evidence labels and the <TextLink href="/privacy">privacy policy</TextLink> for hosted data handling.</p>
      </DocsSection>
    </DocsPage>
  );
}
