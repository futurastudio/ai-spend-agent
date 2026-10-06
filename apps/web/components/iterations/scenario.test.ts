import { describe, expect, it } from "vitest";
import { projects, sources, totalCents, daySeries, getProjectSources, getDaySeries } from "./scenario";

describe("shared iteration example", () => {
  it("preserves exact costs across every project's daily and source views", () => {
    expect(totalCents).toBe(2094339);
    expect(projects.reduce((n, p) => n + p.cents, 0)).toBe(totalCents);
    expect(sources.reduce((n, s) => n + s.cents, 0)).toBe(totalCents);
    expect(daySeries.reduce((n, d) => n + d.cents, 0)).toBe(totalCents);
    for (const project of projects) {
      expect(getDaySeries(project.id)).toHaveLength(30);
      expect(getProjectSources(project.id)).toHaveLength(6);
      expect(getDaySeries(project.id).reduce((n, d) => n + d.cents, 0)).toBe(project.cents);
      expect(getProjectSources(project.id).reduce((n, s) => n + s.cents, 0)).toBe(project.cents);
    }
  });
  it("grounds the displayed research spike and support driver in the sample records", () => {
    const researchDay = getDaySeries("research").find(d => d.day === 18)!;
    const organizationDay = daySeries.find(d => d.day === 18)!;
    expect(researchDay.cents).toBe(87434);
    expect(organizationDay.cents).toBe(127198);
    expect(Math.round(researchDay.cents / organizationDay.cents * 100)).toBe(69);
    const support = projects.find(p => p.id === "support")!;
    const supportAnthropic = getProjectSources("support").find(s => s.name === "Anthropic")!;
    expect(Math.round(supportAnthropic.cents / support.cents * 100)).toBe(43);
  });
  it("retains unattributed costs and explicit non-shipped source status", () => {
    expect(projects.find(p => p.id === "unattributed")?.cents).toBe(199385);
    expect(sources.filter(s => s.status === "Invited partners").map(s => s.name)).toEqual(["OpenAI", "Anthropic"]);
    expect(sources.filter(s => s.status === "Workspace planned").map(s => s.name)).toEqual(["Cursor", "GitHub Copilot"]);
    expect(sources.filter(s => s.status === "Future concept").map(s => s.name)).toEqual(["Jev", "Kimi"]);
  });
});
