import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";

const LAST_MODIFIED = new Date("2026-08-11");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, lastModified: LAST_MODIFIED, priority: 1 },
    { url: `${SITE_URL}/docs`, lastModified: LAST_MODIFIED, priority: 0.9 },
    { url: `${SITE_URL}/docs/cli`, lastModified: LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/mcp`, lastModified: LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/sources`, lastModified: LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/glance`, lastModified: LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/docs/roadmap`, lastModified: LAST_MODIFIED, priority: 0.7 },
    {
      url: `${SITE_URL}/blog/claude-code-cost-usage-credits`,
      lastModified: LAST_MODIFIED,
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/blog/ai-coding-context-health`,
      lastModified: LAST_MODIFIED,
      priority: 0.8,
    },
    { url: `${SITE_URL}/vs/ccusage`, lastModified: LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/vs/tokscale`, lastModified: LAST_MODIFIED, priority: 0.7 },
  ];
}
