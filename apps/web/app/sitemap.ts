import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";

const LAST_MODIFIED = new Date("2026-07-20");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, lastModified: LAST_MODIFIED, priority: 1 },
    {
      url: `${SITE_URL}/blog/claude-code-cost-usage-credits`,
      lastModified: LAST_MODIFIED,
      priority: 0.8,
    },
    { url: `${SITE_URL}/vs/ccusage`, lastModified: LAST_MODIFIED, priority: 0.7 },
    { url: `${SITE_URL}/vs/tokscale`, lastModified: LAST_MODIFIED, priority: 0.7 },
  ];
}
