/**
 * The landing page's one status line about the hosted Workspace. Driven by a single build-time
 * variable, NEXT_PUBLIC_WORKSPACE_URL: absent (today) → every page keeps its pre-launch copy;
 * set to the exact hosted origin → the "not launched" line becomes the launched one. Nothing here
 * creates an account, a session or a charge.
 */

/** Only an exact https origin (or an http localhost origin for local checks) is accepted; anything else is treated as absent. */
export function workspaceOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== raw.replace(/\/$/, "") || url.username || url.password) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}

export const WORKSPACE_URL = workspaceOrigin(process.env.NEXT_PUBLIC_WORKSPACE_URL);
export const WORKSPACE_LAUNCHED = WORKSPACE_URL !== null;

/* Copy in both states, side by side, so a reviewer sees exactly what changes at launch. */
export const WORKSPACE_STATUS_LINE = WORKSPACE_LAUNCHED
  ? "Workspace sign-in is open. Local mode stays free and private."
  : "Workspace is not launched. Local mode stays free and private.";
