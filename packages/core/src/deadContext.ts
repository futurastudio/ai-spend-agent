import { loadAgentInventory, type AgentInventoryOptions, type InventoryItem } from "./agentInventory.js";
import { findPricingRule } from "./modelPricing.js";
import { loadToolInvocations, type InvocationSummary, type ToolInvocationOptions } from "./toolInvocations.js";
import type { CutAction } from "./cutList.js";

/**
 * Dead-context cost: prices the tools an agent LOADS into context every turn
 * but NEVER actually calls. Compares the local Claude Code inventory (skills,
 * subagents, slash commands, MCP servers/tools — {@link loadAgentInventory})
 * against the tools real transcripts show were invoked
 * ({@link loadToolInvocations}), then values the always-loaded weight of the
 * never-used items at API-equivalent rates.
 *
 * HONESTY NOTE: loaded tools sit in the PROMPT-CACHED system/tools context, so
 * the realistic cost is one cache *write* per session plus a cache *read* per
 * subsequent turn — NOT the full input rate every turn. We report that cached
 * figure as the headline and the uncached number only as an upper bound. We
 * never quote the inflated `deadTokens × turns × inputRate` as the result.
 */

const DEFAULT_WINDOW_DAYS = 30;
/**
 * Representative model for pricing dead context. Claude Code runs Anthropic
 * models; Sonnet rates are a conservative middle (cheaper than Opus) so we do
 * not overstate. Always surfaced as "estimated".
 */
const DEFAULT_PRICING_MODEL = "claude-sonnet-4";

export type DeadContextItem = {
  kind: InventoryItem["kind"];
  name: string;
  alwaysLoadedTokens: number;
  weightConfidence: InventoryItem["weightConfidence"];
};

export type DeadContextResult = {
  /** True only when we found both an inventory AND parsed transcripts. */
  hasData: boolean;
  /** True when these are illustrative sample numbers, not the user's real data. */
  isSample?: boolean;
  /** Prunable inventory items considered (built-ins excluded upstream). */
  loadedCount: number;
  /** Items never invoked across the parsed window. */
  deadCount: number;
  /** Always-loaded tokens summed across the dead items (per turn). */
  deadTokens: number;
  /** Dead tokens actually loaded into context over a month (deadTokens × turns,
   * projected). The screenshot-able "headline" number. */
  monthlyDeadTokens: number;
  /** deadCount / loadedCount, 0..1. */
  wastePercent: number;
  /** Honest, cache-aware estimate of monthly waste (the headline number). */
  monthlyUsd: number;
  /** Upper bound assuming NO prompt caching (full input rate every turn). */
  monthlyUsdUpperBound: number;
  /** True when any dead item's token weight is understated (e.g. MCP schemas
   * unavailable) — the real number is likely higher than reported. */
  understated: boolean;
  /** The never-used items, heaviest first. */
  deadItems: DeadContextItem[];
  sessions: number;
  totalTurns: number;
  /** Model whose rates priced the estimate. */
  pricingModel: string;
  /** Days the parsed transcripts were assumed to represent. */
  windowDays: number;
};

export type DeadContextOptions = AgentInventoryOptions &
  ToolInvocationOptions & {
    /** Days the parsed transcripts represent (for the /mo projection). Default 30. */
    windowDays?: number;
    /** Representative model for cache/input rates. Default claude-sonnet-4. */
    pricingModel?: string;
    /** Inject inventory/invocations (tests); otherwise loaded from disk. */
    inventory?: { items: InventoryItem[] };
    invocations?: InvocationSummary;
  };

/** Load inventory + invocations from disk (or use injected ones) and price the waste. */
export async function loadDeadContext(options: DeadContextOptions = {}): Promise<DeadContextResult> {
  const inventory = options.inventory ?? (await loadAgentInventory(options));
  const invocations = options.invocations ?? (await loadToolInvocations(options));
  return computeDeadContext(inventory.items, invocations, {
    windowDays: options.windowDays ?? DEFAULT_WINDOW_DAYS,
    pricingModel: options.pricingModel ?? DEFAULT_PRICING_MODEL
  });
}

/**
 * Illustrative dead-context numbers for the first-run / demo card, so the
 * feature is always visible even when a user has nothing loaded yet. Clearly
 * flagged isSample so the renderer can label it. Numbers are deliberately
 * round and conservative; the README opener uses the same shape.
 */
export function sampleDeadContext(): DeadContextResult {
  const loadedCount = 38;
  const deadCount = 29;
  return {
    hasData: true,
    isSample: true,
    loadedCount,
    deadCount,
    deadTokens: 1400,
    monthlyDeadTokens: 2_100_000,
    wastePercent: deadCount / loadedCount,
    monthlyUsd: 3.0,
    monthlyUsdUpperBound: 18.0,
    understated: true,
    deadItems: [],
    sessions: 120,
    totalTurns: 1500,
    pricingModel: DEFAULT_PRICING_MODEL,
    windowDays: 30
  };
}

/** Pure core: compare inventory vs. invocations and price the never-used items. */
export function computeDeadContext(
  items: InventoryItem[],
  invocations: InvocationSummary,
  config: { windowDays: number; pricingModel: string }
): DeadContextResult {
  const windowDays = Math.max(1, config.windowDays);
  const sessions = invocations.sessions;
  const totalTurns = invocations.totalAssistantTurns;

  const usedSkills = new Set(invocations.invokedSkills);
  const usedSubagents = new Set(invocations.invokedSubagents);
  const usedCommands = new Set(invocations.invokedCommands);
  const usedMcpTools = new Set(invocations.invokedMcpTools);
  // An MCP server counts as "used" if any invoked mcp tool belongs to it.
  const usedMcpServers = new Set(
    invocations.invokedMcpTools.map((tool) => tool.split("__")[1]).filter((id): id is string => Boolean(id))
  );

  const dead: DeadContextItem[] = [];
  let loadedCount = 0;
  for (const item of items) {
    loadedCount += 1;
    if (!isDead(item, { usedSkills, usedSubagents, usedCommands, usedMcpTools, usedMcpServers })) {
      continue;
    }
    dead.push({
      kind: item.kind,
      name: item.name,
      alwaysLoadedTokens: item.alwaysLoadedTokens,
      weightConfidence: item.weightConfidence
    });
  }
  dead.sort((a, b) => b.alwaysLoadedTokens - a.alwaysLoadedTokens);

  const deadTokens = dead.reduce((total, item) => total + item.alwaysLoadedTokens, 0);
  const hasData = items.length > 0 && invocations.sessions > 0 && deadTokens > 0;

  const rates = pricingRates(config.pricingModel);
  // Cached: one cache write per session + a cache read on every later turn.
  const cacheReads = Math.max(0, totalTurns - sessions);
  const windowCachedUsd = (deadTokens * (sessions * rates.write5mPerM + cacheReads * rates.cacheReadPerM)) / 1_000_000;
  // Uncached upper bound: the full input rate on every turn.
  const windowUncachedUsd = (deadTokens * totalTurns * rates.inputPerM) / 1_000_000;
  const monthFactor = DEFAULT_WINDOW_DAYS / windowDays;

  return {
    hasData,
    loadedCount,
    deadCount: dead.length,
    deadTokens,
    monthlyDeadTokens: Math.round(deadTokens * totalTurns * monthFactor),
    wastePercent: loadedCount > 0 ? dead.length / loadedCount : 0,
    monthlyUsd: roundMoney(windowCachedUsd * monthFactor),
    monthlyUsdUpperBound: roundMoney(windowUncachedUsd * monthFactor),
    understated: dead.some((item) => item.weightConfidence === "estimated_understated"),
    deadItems: dead,
    sessions,
    totalTurns,
    pricingModel: config.pricingModel,
    windowDays
  };
}

/**
 * Adapt a dead-context result to a {@link CutAction} so it can flow into the
 * ranked cut list / AI Receipt. Returns null when there is nothing to cut.
 */
export function deadContextCutAction(result: DeadContextResult): CutAction | null {
  if (!result.hasData || result.deadCount === 0 || result.monthlyUsd < 0.5) {
    return null;
  }
  const pct = Math.round(result.wastePercent * 100);
  return {
    id: "dead-context",
    title: `Trim ${result.deadCount} loaded tool${result.deadCount === 1 ? "" : "s"} your agent never calls`,
    action:
      `Remove or lazy-load ${result.deadCount} of ${result.loadedCount} loaded item${result.loadedCount === 1 ? "" : "s"} ` +
      `(${pct}% never invoked) to reclaim ~${result.deadTokens.toLocaleString("en-US")} tokens of dead context per turn.`,
    estimatedMonthlySavingsUsd: result.monthlyUsd,
    affectedSpendUsd: result.monthlyUsd,
    recordCount: result.deadCount,
    confidence: "estimated",
    kind: "context_trim"
  };
}

function isDead(
  item: InventoryItem,
  used: {
    usedSkills: Set<string>;
    usedSubagents: Set<string>;
    usedCommands: Set<string>;
    usedMcpTools: Set<string>;
    usedMcpServers: Set<string>;
  }
): boolean {
  switch (item.kind) {
    case "skill":
      return !used.usedSkills.has(item.name);
    case "subagent":
      return !used.usedSubagents.has(item.name);
    case "command":
      return !used.usedCommands.has(item.name);
    case "mcp_tool":
      return !used.usedMcpTools.has(item.name);
    case "mcp_server":
      return !used.usedMcpServers.has(item.name);
    default:
      return false;
  }
}

function pricingRates(model: string): { inputPerM: number; cacheReadPerM: number; write5mPerM: number } {
  const rule = findPricingRule(model) ?? findPricingRule(DEFAULT_PRICING_MODEL);
  // Fallback to Sonnet-class numbers if even the default is somehow unmatched.
  const inputPerM = rule?.inputPerM ?? 3;
  return {
    inputPerM,
    cacheReadPerM: rule?.cacheReadPerM ?? inputPerM * 0.1,
    write5mPerM: rule?.cacheWrite5mPerM ?? inputPerM * 1.25
  };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
