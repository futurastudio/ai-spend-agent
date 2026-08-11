// Single source of truth for the canonical origin. NEXT_PUBLIC_SITE_URL in
// Vercel still overrides — the fallback is the production domain so
// canonicals/OG/sitemap URLs are correct even with no env var set.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://asktilden.com";
