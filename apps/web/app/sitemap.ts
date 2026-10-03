import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";

const LAST_MODIFIED = new Date("2026-08-24");
const DOCS_LAST_MODIFIED = new Date("2026-10-03");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/privacy`, lastModified: new Date("2026-10-03"), priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: new Date("2026-09-30"), priority: 0.3 },
    { url: `${SITE_URL}/`, lastModified: new Date("2026-10-03"), priority: 1 },
    { url: `${SITE_URL}/docs`, lastModified: DOCS_LAST_MODIFIED, priority: 0.9 },
    { url: `${SITE_URL}/docs/workspace`, lastModified: DOCS_LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/cli`, lastModified: DOCS_LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/mcp`, lastModified: DOCS_LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/mcp/local`, lastModified: DOCS_LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/docs/sources`, lastModified: DOCS_LAST_MODIFIED, priority: 0.8 },
    { url: `${SITE_URL}/docs/glance`, lastModified: DOCS_LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/docs/roadmap`, lastModified: DOCS_LAST_MODIFIED, priority: 0.7 },
    {
      url: `${SITE_URL}/blog/claude-code-cost-usage-credits`,
      lastModified: new Date("2026-10-03"),
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/blog/ai-coding-context-health`,
      lastModified: new Date("2026-10-03"),
      priority: 0.8,
    },
    { url: `${SITE_URL}/vs/ccusage`, lastModified: LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/vs/tokscale`, lastModified: LAST_MODIFIED, priority: 0.7 },
  ];
}
