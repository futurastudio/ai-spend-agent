type ActivityExample = {
  tool: "Claude Code" | "Codex";
  repository: string;
  day: string;
};

// Synthetic repository context only. These rows are not joined to billing records
// or filtered by billing source, and never contribute to the financial totals.
export const activityExamples: Readonly<Record<string, readonly ActivityExample[]>> = {
  research: [
    { tool: "Claude Code", repository: "research-pipeline", day: "2026-09-18" },
    { tool: "Codex", repository: "research-pipeline", day: "2026-09-18" },
  ],
  support: [
    { tool: "Claude Code", repository: "support-assistant", day: "2026-09-16" },
  ],
  platform: [
    { tool: "Codex", repository: "developer-platform", day: "2026-09-22" },
    { tool: "Claude Code", repository: "developer-platform", day: "2026-09-23" },
  ],
  unattributed: [],
};
