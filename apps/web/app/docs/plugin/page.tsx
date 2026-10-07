import type { Metadata } from "next";
import { DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "Tilden Plugin · ChatGPT Pilot",
  description: "We’re building a ChatGPT plugin for read-only Tilden Workspace spending reviews. Explore what’s planned and join the waitlist.",
  alternates: { canonical: "/docs/plugin" },
};

export default function PluginDocsPage() {
  return <DocsPage updated="October 7, 2026" current="/docs/plugin" title="Your spending review, inside ChatGPT." intro="The ChatGPT Pilot is a planned plugin that brings your Tilden Workspace reports into the conversation. Ask where supported AI costs are going and what deserves a closer look." repoPath="apps/web/app/docs/plugin/page.tsx">
    <DocsCallout title="Public availability is planned">
      The ChatGPT plugin is not publicly available yet. <TextLink href="/?ref=chatgpt-pilot#beta">Join the waitlist</TextLink> for availability updates.
    </DocsCallout>
    <DocsSection id="overview" label="01 · What’s planned" title="Keep the evidence close to the question">
      <p>The planned experience gives you read-only access to supported Workspace spend, project breakdowns, briefings and budget settings in ChatGPT, with source coverage and freshness alongside the answer.</p>
      <p className="mt-4">It is designed to help you understand reported costs and decide what to investigate next. Available history and detail depend on your connected sources.</p>
    </DocsSection>
    <DocsSection id="availability" label="02 · Stay informed" title="Follow what’s next">
      <p>Follow the <TextLink href="/docs/roadmap">roadmap</TextLink> for product direction, or <TextLink href="/?ref=chatgpt-pilot#beta">join the waitlist</TextLink> for updates. We’ll share setup guidance when access becomes available.</p>
      <p className="mt-4">For current invited connections, see the <TextLink href="/docs/mcp">Workspace MCP guide</TextLink>.</p>
    </DocsSection>
  </DocsPage>;
}
