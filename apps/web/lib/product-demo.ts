/**
 * One illustrative receipt shared by every marketing-site product surface.
 * Keeping the sample centralized prevents Glance, Terminal, and MCP from
 * telling three subtly different stories while demonstrating the same engine.
 */
export const PRODUCT_DEMO = {
  session: {
    value: "$4.18",
    basis: "estimated API-equivalent value",
    agent: "Codex",
    model: "GPT-5.6",
    project: "agent-finops",
    plan: "ChatGPT Pro",
    duration: "42m",
  },
  limits: [
    {
      label: "5-hour limit",
      value: "29% left",
      projection: "Local estimate · Exhausts ~1h",
      reset: "Codex reported · Resets in 2h",
      width: "29%",
      tone: "attention",
    },
    {
      label: "Weekly limit",
      value: "57% left",
      projection: "Local estimate · Below cap",
      reset: "Codex reported · Resets Monday",
      width: "57%",
      tone: "healthy",
    },
  ],
  focus: {
    label: "Refining Glance hover UI",
    kind: "Task",
    file: "GlanceView.swift",
    activity: "68%",
  },
  action: {
    label: "Start fresh · agent-finops",
    detail: "Carry “Refining Glance hover UI” into a clean session",
  },
  evidence: {
    sources: "Claude Code + Codex",
    files: "60 files",
    freshness: "Updated 12s ago",
  },
} as const;
