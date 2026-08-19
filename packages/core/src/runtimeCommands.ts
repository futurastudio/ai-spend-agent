export type AibillImproveDeliveryV0 = "source_preview" | "published";

/**
 * Distribution truth for the guided action loop.
 *
 * Release gate: change this single value to `published` only in the exact,
 * coordinated new-version release candidate. Its packed-install gate must
 * prove every generated handoff uses the new package command before publish;
 * the clean public-registry smoke then verifies that same exact commit. Until
 * that release candidate exists, handoffs execute the already-built checkout
 * and must not let `npx` download the older public package.
 */
export const AIBILL_IMPROVE_DELIVERY_V0: AibillImproveDeliveryV0 = "published";

/**
 * Build a command for capabilities that exist only in the current source
 * preview. Keep every generated handoff on the checkout until the coordinated
 * npm release containing those capabilities has passed its registry smoke.
 */
export function aibillCommandV0(
  args: string,
  delivery: AibillImproveDeliveryV0 = AIBILL_IMPROVE_DELIVERY_V0
): string {
  const commandArgs = args.trim();
  return delivery === "source_preview"
    ? `node packages/cli/dist/index.js${commandArgs.length > 0 ? ` ${commandArgs}` : ""}`
    : `npx aibill${commandArgs.length > 0 ? ` ${commandArgs}` : ""}`;
}

/** One privacy-safe command shared by terminal, MCP, and Glance. */
export function aibillImproveCommandV0(
  delivery: AibillImproveDeliveryV0 = AIBILL_IMPROVE_DELIVERY_V0
): string {
  return aibillCommandV0(
    delivery === "source_preview" ? "improve --path ." : "improve",
    delivery
  );
}
