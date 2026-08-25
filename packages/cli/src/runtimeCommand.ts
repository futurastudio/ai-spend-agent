/**
 * Runtime command composition for user-facing output (0.9.3).
 *
 * The launch path is `npx aibill` — npx users have no bare `aibill` on
 * PATH (founder incident 2026-08-24: following the 0.9.2 telemetry
 * notice's `aibill telemetry off` produced "command not found"). Every
 * command that aibill's own output tells a human to RUN must therefore
 * carry the npx form. Output HEADERS ("aibill doctor" as a letterhead)
 * and noun usages ("aibill statusline installed") are not invocations
 * and stay bare.
 */
export function runtimeCliCommand(subcommand?: string): string {
  return subcommand === undefined || subcommand === ""
    ? "npx aibill"
    : `npx aibill ${subcommand}`;
}
