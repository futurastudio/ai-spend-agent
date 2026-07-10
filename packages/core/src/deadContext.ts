import { loadAgentInventory, type AgentInventoryOptions, type InventoryItem } from "./agentInventory.js";
import { findPricingRule } from "./modelPricing.js";
import { loadToolInvocations, type InvocationSummary, type ToolInvocationOptions } from "./toolInvocations.js";
import type { CutAction } from "./cutList.js";

/**
 * Dead-context: the tools an agent LOADS into context but NEVER calls. Compares
 * the local Claude Code inventory (skills, subagents, slash commands, MCP
 * servers — {@link loadAgentInventory}) against what real transcripts show was
 * invoked ({@link loadToolInvocations}).
 *
 * ACCURACY CONTRACT (this is the credibility lever — read before changing):
 *  - The COUNT + utilization % is always defensible and is the headline.
 *  - A token/$ magnitude is ONLY computed from items whose weight we actually
 *    MEASURED — skill/subagent/command frontmatter (weightConfidence
 *    "estimated"). We never price items whose weight we could not measure.
 *  - MCP servers have NO readable schemas in local config, so their real
 *    weight is unknown. They are COUNTED as dead but NEVER assigned a $/token
 *    figure — to size them we'd have to query each server's tools/list. They
 *    surface as `unmeasuredDeadCount` so the renderer can say "not measurable".
 *  - Pricing is cache-aware (one cache write/session + a read/turn), never the
 *    inflated full-input-rate-every-turn number.
 */

const DEFAULT_WINDOW_DAYS = 30;
/**
 * Representative model for pricing measured dead context. Claude Code runs
 * Anthropic models; Sonnet rates are a conservative middle. Always "estimated".
 */
const DEFAULT_PRICING_MODEL = "claude-sonnet-4";

export type DeadContextItem = {
  kind: InventoryItem["kind"];
  name: string;
  alwaysLoadedTokens: number;
  weightConfidence: InventoryItem["weightConfidence"];
  /** Config file the item is loaded from — the place to remove it. */
  path?: string;
  /** Project dirs that load this item (where `claude mcp remove` must run). */
  ownerDirs?: string[];
};

export type DeadContextResult = {
  /** True when we found inventory + transcripts AND at least one dead item. */
  hasData: boolean;
  /** True when these are illustrative sample numbers, not the user's real data. */
  isSample?: boolean;
  /** Prunable inventory items considered (built-ins excluded upstream). */
  loadedCount: number;
  /** Items never invoked across the parsed window (the defensible headline). */
  deadCount: number;
  /** Dead items whose token weight we MEASURED (skills/subagents/commands). */
  measuredDeadCount: number;
  /** Dead items whose weight we could NOT measure (MCP servers, no schemas). */
  unmeasuredDeadCount: number;
  /** Measured-only always-loaded tokens across dead items (per turn). */
  deadTokens: number;
  /** Measured-only dead tokens loaded into context over a month (projected). */
  monthlyDeadTokens: number;
  /** deadCount / loadedCount, 0..1. */
  wastePercent: number;
  /** Cache-aware monthly $, MEASURED items only (0 when only MCP is dead). */
  monthlyUsd: number;
  /** Upper bound (no prompt caching), measured items only. */
  monthlyUsdUpperBound: number;
  /** The never-used items, heaviest first. */
  deadItems: DeadContextItem[];
  sessions: number;
  totalTurns: number;
  /** Model whose rates priced the measured estimate. */
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
 * flagged isSample. Shows the measured-skills case (count + a small honest $).
 */
export function sampleDeadContext(): DeadContextResult {
  const loadedCount = 38;
  const deadCount = 29;
  return {
    hasData: true,
    isSample: true,
    loadedCount,
    deadCount,
    measuredDeadCount: deadCount,
    unmeasuredDeadCount: 0,
    deadTokens: 80,
    monthlyDeadTokens: 120_000,
    wastePercent: deadCount / loadedCount,
    monthlyUsd: 0.4,
    monthlyUsdUpperBound: 2.4,
    deadItems: [],
    sessions: 120,
    totalTurns: 1500,
    pricingModel: DEFAULT_PRICING_MODEL,
    windowDays: 30
  };
}

/** Pure core: compare inventory vs. invocations; count all dead, price only measured. */
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
      weightConfidence: item.weightConfidence,
      path: item.path,
      ownerDirs: item.ownerDirs
    });
  }
  dead.sort((a, b) => b.alwaysLoadedTokens - a.alwaysLoadedTokens);

  // Only items whose weight we actually measured get a $/token figure. MCP
  // servers (weight unknown without querying tools/list) are counted, not priced.
  const measuredDead = dead.filter((item) => item.weightConfidence === "estimated");
  const unmeasuredDead = dead.filter((item) => item.weightConfidence !== "estimated");
  const measuredTokens = measuredDead.reduce((total, item) => total + item.alwaysLoadedTokens, 0);
  const hasData = items.length > 0 && sessions > 0 && dead.length > 0;

  const rates = pricingRates(config.pricingModel);
  // Cached: one cache write per session + a cache read on every later turn.
  const cacheReads = Math.max(0, totalTurns - sessions);
  const windowCachedUsd = (measuredTokens * (sessions * rates.write5mPerM + cacheReads * rates.cacheReadPerM)) / 1_000_000;
  const windowUncachedUsd = (measuredTokens * totalTurns * rates.inputPerM) / 1_000_000;
  const monthFactor = DEFAULT_WINDOW_DAYS / windowDays;

  return {
    hasData,
    loadedCount,
    deadCount: dead.length,
    measuredDeadCount: measuredDead.length,
    unmeasuredDeadCount: unmeasuredDead.length,
    deadTokens: measuredTokens,
    monthlyDeadTokens: Math.round(measuredTokens * totalTurns * monthFactor),
    wastePercent: loadedCount > 0 ? dead.length / loadedCount : 0,
    monthlyUsd: roundMoney(windowCachedUsd * monthFactor),
    monthlyUsdUpperBound: roundMoney(windowUncachedUsd * monthFactor),
    deadItems: dead,
    sessions,
    totalTurns,
    pricingModel: config.pricingModel,
    windowDays
  };
}

/**
 * Adapt a dead-context result to a {@link CutAction} so it can flow into the
 * ranked cut list / AI Receipt. Returns null unless there is MEASURED waste
 * worth a dollar figure (MCP-only waste is shown as a count, not a cut $).
 */
export function deadContextCutAction(result: DeadContextResult): CutAction | null {
  if (!result.hasData || result.measuredDeadCount === 0 || result.monthlyUsd < 0.5) {
    return null;
  }
  const pct = Math.round(result.wastePercent * 100);
  return {
    id: "dead-context",
    title: `Trim ${result.measuredDeadCount} loaded tool${result.measuredDeadCount === 1 ? "" : "s"} your agent never calls`,
    action:
      `Remove or lazy-load ${result.deadCount} of ${result.loadedCount} loaded item${result.loadedCount === 1 ? "" : "s"} ` +
      `(${pct}% never invoked) to reclaim ~${result.deadTokens.toLocaleString("en-US")} tokens of dead context per turn.`,
    estimatedMonthlySavingsUsd: result.monthlyUsd,
    affectedSpendUsd: result.monthlyUsd,
    recordCount: result.deadCount,
    recordUnit: "tools",
    // Dead-context savings come from inventory, not priced usage records, so
    // there are no record IDs to dedupe against the spend-based cut actions.
    recordIds: [],
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
