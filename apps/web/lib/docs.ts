export const DOCS_UPDATED = "August 13, 2026";
export const NPM_STABLE_VERSION = "0.8.1";

export const REPO_URL = "https://github.com/futurastudio/ai-spend-agent";
export const ISSUE_URL = `${REPO_URL}/issues/new/choose`;

export const docsNavigation = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/cli", label: "CLI & statusline" },
  { href: "/docs/mcp", label: "MCP" },
  { href: "/docs/sources", label: "Sources" },
  { href: "/docs/glance", label: "Glance" },
  { href: "/docs/roadmap", label: "Roadmap" },
] as const;

export type DocsHref = (typeof docsNavigation)[number]["href"];

export const localSources = [
  {
    id: "claude-code",
    name: "Claude Code",
    provider: "Anthropic",
    availability: `Published in v${NPM_STABLE_VERSION}`,
    validation: "live_verified",
    evidence: "estimated or missing",
    surfaces: "CLI, statusline cache, MCP, Context Health, Glance",
    summary:
      "Reads supported local transcript metadata. API-equivalent values are estimates, never subscription charges or billed spend.",
  },
  {
    id: "codex",
    name: "Codex",
    provider: "OpenAI",
    availability: `Published in v${NPM_STABLE_VERSION}`,
    validation: "live_verified",
    evidence: "estimated or missing",
    surfaces: "CLI, statusline cache, MCP, Context Health, Glance",
    summary:
      "Reads root-session-aware rollout metadata with fork accounting and snapshot deduplication. Unsupported rows remain missing.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    provider: "Google",
    availability: `Published experimental in v${NPM_STABLE_VERSION}`,
    validation: "fixture_verified",
    evidence: "estimated or missing",
    surfaces: "Financial CLI, report, and MCP only; excluded from statusline, Glance, Context Health, Apply, plan/runway, and invocation evidence",
    summary:
      "Experimental, fixture-verified reader for supported chats JSON/JSONL token records. logs.json is detection-only and creates no financial row.",
  },
] as const;

export const providerSources = [
  {
    id: "openai",
    name: "OpenAI Costs and Usage APIs",
    availability: `Published in v${NPM_STABLE_VERSION}`,
    validation: "live_verified",
    evidence: "verified, estimated, or missing by endpoint",
    requirement: "Organization-owner Admin credential reference",
  },
  {
    id: "anthropic",
    name: "Anthropic Cost Report and Claude Code Analytics",
    availability: `Published in v${NPM_STABLE_VERSION}`,
    validation: "live_verified",
    evidence: "verified, estimated, or missing by row",
    requirement: "Admin credential reference",
  },
  {
    id: "cursor",
    name: "Cursor Admin API",
    availability: `Beta in v${NPM_STABLE_VERSION}`,
    validation: "fixture_verified",
    evidence: "estimated, detected_unverified, or missing",
    requirement: "Business plan and team-admin credential reference",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot organization APIs",
    availability: `Beta in v${NPM_STABLE_VERSION}`,
    validation: "fixture_verified",
    evidence: "estimated, detected_unverified, or missing",
    requirement: "Organization or enterprise billing-admin credential reference",
  },
] as const;
