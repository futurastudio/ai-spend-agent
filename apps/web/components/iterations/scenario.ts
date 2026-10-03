import data from "../landing/enterprise-tour.json";

/** Synthetic concept records only. No provider API calls or actual customer results. */
export const totalCents = data.rows.reduce((sum, row) => sum + row.cents, 0);
export const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const details: Record<string, { question: string; briefing: string; activity: string }> = {
  research: { question: "Why did research reach $874 on September 18?", briefing: "On September 18, research accounts for $874 of the example’s $1,272 total: 69% of that day’s spending. Start with that date’s model mix and workloads before deciding what to change.", activity: "Review optional coding-agent activity separately from reported costs." },
  support: { question: "Which source drives the support bill?", briefing: "Anthropic accounts for $2,632 of the example’s $6,137 support total: 43%. Review that source’s model mix first, then compare the date range before attributing a change to customer demand.", activity: "A source connection does not identify every task or accepted outcome." },
  platform: { question: "Where is the developer platform spending?", briefing: "Platform costs span several sources in this concept. Review the provider breakdown alongside optional coding-agent activity, without adding activity estimates to the bill.", activity: "Claude Code and Codex activity requires consent, pairing and an explicit CLI push." },
  unattributed: { question: "Which costs still need context?", briefing: "This example contains $1,994 with no project attribution: 10% of total spending. Keep it visible and review the source records before drawing a project-level conclusion.", activity: "Missing attribution is a question to resolve, never a zero-cost assumption." },
};
export const projects = data.projects.map(project => {
  const cents = data.rows.filter(row => row.project === project.id).reduce((sum, row) => sum + row.cents, 0);
  return { ...project, cents, share: Math.round(cents / totalCents * 100), ...details[project.id] };
});
const sourceDefinitions = [
  { name: "OpenAI", logo: "/brand/providers/openai-symbol.svg", status: "Invited partners", detail: "Organization API costs; optional Codex activity via CLI push." },
  { name: "Anthropic", logo: "/brand/providers/claude-symbol.svg", status: "Invited partners", detail: "Organization API costs; optional Claude Code activity via CLI push." },
  { name: "Cursor", logo: "/brand/providers/cursor-symbol.svg", status: "Workspace planned", detail: "Beta CLI connector; administrator access required, account checks pending." },
  { name: "GitHub Copilot", logo: "/brand/providers/copilot-symbol.svg", status: "Workspace planned", detail: "Beta CLI connector; administrator access required, account checks pending." },
  { name: "Jev", logo: "/brand/providers/typesafe-symbol.svg", status: "Future concept", detail: "Jev by TypeSafe AI. No integration today." },
  { name: "Kimi", logo: "/brand/providers/kimi-symbol.svg", status: "Future concept", detail: "No integration today." },
];
export const sources = sourceDefinitions.map(source => ({ ...source, cents: data.rows.filter(row => row.provider === source.name).reduce((sum, row) => sum + row.cents, 0) }));
export function getProjectSources(id: string) {
  return sources.map(source => ({ ...source, cents: data.rows.filter(row => row.project === id && row.provider === source.name).reduce((sum, row) => sum + row.cents, 0) }));
}
export function getDaySeries(id?: string) {
  return Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    const cents = data.rows.filter(row => row.date === date && (!id || row.project === id)).reduce((sum, row) => sum + row.cents, 0);
    return { day, date, cents, total: cents };
  });
}
export const daySeries = getDaySeries();
export const disclosure = "Illustrative data · future-coverage concept. Figures are invented examples, not customer results.";
