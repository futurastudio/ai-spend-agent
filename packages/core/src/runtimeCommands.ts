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

/** Published semver shape a composed pin must have (charset-safe by regex). */
const pinnableVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Version-pinned command for machine-composed lines (M4c): a command an AI
 * client relays to a human must be reproducible and must not silently
 * resolve to a different release, so `draft_improve_command` pins to the
 * composing package's own version (`npx aibill@<version> …`). A version
 * that is not a plain semver falls back to the unpinned published command
 * rather than composing an unrunnable line. In source-preview builds the
 * checkout command needs no pin.
 *
 * Release gate (n2): the coordinated release must also prove the pinned
 * version EXISTS on the public registry and supports the composed flags —
 * the packed-install gate described on AIBILL_IMPROVE_DELIVERY_V0 is the
 * natural home for that check; QA 24 asserts only that the pin is present.
 */
export function aibillPinnedCommandV0(
  args: string,
  version: string,
  delivery: AibillImproveDeliveryV0 = AIBILL_IMPROVE_DELIVERY_V0
): string {
  const commandArgs = args.trim();
  if (delivery === "source_preview" || !pinnableVersionPattern.test(version)) {
    return aibillCommandV0(commandArgs, delivery);
  }
  return `npx aibill@${version}${commandArgs.length > 0 ? ` ${commandArgs}` : ""}`;
}
