export const DOCS_UPDATED = "October 3, 2026";
// Verified against each package's public npm registry latest endpoint on this date.
export const NPM_STABLE_VERSION = "0.9.11";
export const NPM_VERSION_CHECKED = "October 3, 2026";

export const REPO_URL = "https://github.com/futurastudio/ai-spend-agent";
export const ISSUE_URL = `${REPO_URL}/issues/new/choose`;

export const docsNavigation = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/first-review", label: "First review" },
  { href: "/docs/access", label: "Access & renewal" },
  { href: "/docs/workspace", label: "Workspace" },
  { href: "/docs/cli", label: "CLI" },
  { href: "/docs/mcp", label: "MCP" },
  { href: "/docs/plugin", label: "Plugin" },
  { href: "/docs/mcp/local", label: "Local MCP" },
  { href: "/docs/sources", label: "Sources" },
  { href: "/docs/glance", label: "Glance" },
  { href: "/docs/roadmap", label: "Roadmap" },
] as const;

export type DocsHref = (typeof docsNavigation)[number]["href"];

export const workspaceSources = [
  {
    name: "OpenAI and Anthropic",
    availability: "Available through invited onboarding",
    evidence: "Provider-reported API costs and source-specific usage",
    summary: "Connected admin sources support cost views with their reported dates, account scope, freshness and coverage. A known subtotal can exclude unavailable days; it is not a final invoice.",
  },
  {
    name: "Claude Code and Codex activity",
    availability: "Optional machine sharing",
    evidence: "Machine-reported sessions and tokens",
    summary: "Explicitly shared local activity can show sessions, tokens, days and repository labels where available. It stays separate from provider cost and does not allocate the bill to a person or agent.",
  },
  {
    name: "Cursor and GitHub Copilot",
    availability: "Ask about pilot availability",
    evidence: "Separate estimates; live partner validation pending",
    summary: "These connections are not generally enabled and require separate partner setup. Where enabled, Cursor cycle-to-date on-demand spend and Copilot current-month net charges keep their own periods and are not added to the OpenAI/Anthropic cost total or to each other.",
  },
] as const;

export const localSources = [
  {
    id: "claude-code",
    name: "Claude Code",
    provider: "Anthropic",
    availability: "Published CLI reader",
    validation: "live_verified",
    evidence: "estimated or missing",
    surfaces: "CLI, statusline cache, local MCP, Context Health, Glance",
    summary:
      "Reads supported local transcript metadata. API-equivalent values are estimates, never subscription charges or billed spend.",
  },
  {
    id: "codex",
    name: "Codex",
    provider: "OpenAI",
    availability: "Published CLI reader",
    validation: "live_verified",
    evidence: "estimated or missing",
    surfaces: "CLI, statusline cache, local MCP, Context Health, Glance",
    summary:
      "Reads root-session-aware rollout metadata with fork accounting and snapshot deduplication. Unsupported rows remain missing.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    provider: "Google",
    availability: "Experimental CLI reader",
    validation: "fixture_verified",
    evidence: "estimated or missing",
    surfaces: "Financial CLI, report, and local MCP only; excluded from statusline, Glance, Context Health, Apply, plan/runway, and invocation evidence",
    summary:
      "Experimental, fixture-verified reader for supported chats JSON/JSONL token records. logs.json is detection-only and creates no financial row.",
  },
] as const;

export const providerSources = [
  {
    id: "openai",
    name: "OpenAI Costs and Usage APIs",
    availability: "Published CLI connector",
    validation: "live_verified",
    evidence: "verified, estimated, or missing by endpoint",
    requirement: "Organization-owner Admin credential reference",
  },
  {
    id: "anthropic",
    name: "Anthropic Cost Report and Claude Code Analytics",
    availability: "Published CLI connector",
    validation: "live_verified",
    evidence: "verified, estimated, or missing by row",
    requirement: "Admin credential reference",
  },
  {
    id: "cursor",
    name: "Cursor Admin API",
    availability: "Beta CLI connector",
    validation: "fixture_verified",
    evidence: "estimated, detected_unverified, or missing",
    requirement: "Business plan and team-admin credential reference",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot organization APIs",
    availability: "Beta CLI connector",
    validation: "fixture_verified",
    evidence: "estimated, detected_unverified, or missing",
    requirement: "Organization or enterprise billing-admin credential reference",
  },
] as const;
