import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "Tilden roadmap — weekly product focus",
  description: "A high-level weekly view of Tilden priorities across Workspace, CLI and MCP: current work, what comes next and ideas being explored.",
  alternates: { canonical: "/docs/roadmap" },
};

export default function RoadmapDocsPage() {
  return (
    <DocsPage current="/docs/roadmap" title="What we’re working on." intro="A weekly view of our product focus across Workspace, CLI and MCP. Priorities follow what we learn with invited teams. This is direction, not a delivery calendar." repoPath="apps/web/app/docs/roadmap/page.tsx">
      <DocsSection id="this-week" label="Week of September 28 · updated October 3, 2026" title="This week">
        <ul className="list-disc space-y-4 pl-5 marker:text-green">
          <li><strong className="text-ink">A clearer Workspace.</strong> Make spending views, briefings and chart navigation easier to follow, while keeping coverage and missing data beside the numbers.</li>
          <li><strong className="text-ink">A better first setup.</strong> Bring the guides together around Workspace, the local CLI and assisted MCP onboarding so invited teams know where to start.</li>
          <li><strong className="text-ink">Read-only answers in your AI client.</strong> Check the connection, consent and report-reading experience for the clients used during onboarding.</li>
        </ul>
      </DocsSection>

      <DocsSection id="next" label="Next" title="Learn from the connected teams">
        <ul className="list-disc space-y-4 pl-5 marker:text-faint">
          <li>Improve onboarding and the first spending review around real account coverage and the questions teams bring.</li>
          <li>Validate more supported provider connections with partners, keeping different cost bases and billing periods clear.</li>
          <li>Make historical usage and shared coding-agent activity easier to inspect without overstating attribution.</li>
        </ul>
      </DocsSection>

      <DocsSection id="exploring" label="Exploring" title="Connect spending to useful work">
        <p>We are exploring richer project and workflow context, better evidence for accepted outcomes, and carefully scoped ways to act on spending insights. Broader source coverage and an easier desktop experience are also areas of interest.</p>
        <p className="mt-4">Activity and token volume alone do not establish value. Work on outcome economics, ROI or automated controls needs its own evidence before it can become a product claim.</p>
        <DocsCallout title="How to read this roadmap">“Next” and “Exploring” are priorities and questions, not commitments to ship in a particular week. Current access and source support live in the <TextLink href="/docs/workspace">Workspace guide</TextLink>, <TextLink href="/docs/cli">CLI guide</TextLink> and <TextLink href="/docs/sources">source reference</TextLink>.</DocsCallout>
      </DocsSection>

      <DocsSection id="participate" label="Shape what comes next" title="Bring a real spending question">
        <p><TextLink href="/#beta">Join the waitlist</TextLink> if you want to help shape Tilden. Selected partners receive assisted onboarding. Tell us which sources you use and what you cannot explain about your AI spend today; joining does not grant immediate access or promise a delivery date.</p>
      </DocsSection>
    </DocsPage>
  );
}
