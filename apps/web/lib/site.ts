// Single source of truth for the canonical origin. Flip the whole site to a
// custom domain (e.g. https://aibill.dev) by setting NEXT_PUBLIC_SITE_URL in
// Vercel — no code change needed.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://ai-spend-agent.vercel.app";
