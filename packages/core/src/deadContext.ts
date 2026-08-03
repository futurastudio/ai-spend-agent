import {
  loadAgentInventory,
  type AgentInventoryOptions,
  type InventoryHost,
  type InventoryItem
} from "./agentInventory.js";
import { findPricingRule } from "./modelPricing.js";
import {
  loadToolInvocations,
  type HostInvocationEvidence,
  type InvocationSummary,
  type ToolInvocationOptions
} from "./toolInvocations.js";
import type { CutAction } from "./cutList.js";

/**
 * Inventory-use evidence: compare locally configured/discoverable agent items
 * with explicit invocations in supported transcripts. Configuration alone does
 * not prove an item's full payload was loaded, and absence of an observed call
 * does not prove that an item has no future value.
 *
 * ACCURACY CONTRACT (this is the credibility lever — read before changing):
 *  - The COUNT + utilization % is always defensible and is the headline.
 *  - A token/$ magnitude is ONLY computed from items whose weight we actually
 *    MEASURED — skill/subagent/command frontmatter (weightConfidence
 *    "estimated"). We never price items whose weight we could not measure.
 *  - MCP config has no runtime schemas and current hosts can defer tool loading.
 *    Configured servers are counted as not-observed candidates but NEVER
 *    assigned a $/token figure. Explicit alwaysLoad is preserved as activation
 *    evidence while its payload size remains unmeasured.
 *  - Pricing is cache-aware (one cache write/session + a read/turn), never the
 *    inflated full-input-rate-every-turn number.
 *  - Items whose host transcript does not expose matchable invocation evidence
 *    are excluded instead of being falsely classified as dead.
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
  scope: InventoryItem["scope"];
  activation: InventoryItem["activation"];
  host?: InventoryItem["host"];
  invocationTracking: InventoryItem["invocationTracking"];
  alwaysLoadedTokens: number;
  weightConfidence: InventoryItem["weightConfidence"];
  /** Config/catalog file where the item was observed. */
  path?: string;
  /** Owning project dirs when scope is local or project. */
  ownerDirs?: string[];
};

export type DeadContextResult = {
  /** True when we found inventory + transcripts AND at least one dead item. */
  hasData: boolean;
  /** True when these are illustrative sample numbers, not the user's real data. */
  isSample?: boolean;
  /** Prunable inventory items considered (built-ins excluded upstream). */
  loadedCount: number;
  /** Observable items with no matching invocation in the parsed window. */
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
  /** The not-observed candidates, measured weight first. */
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
  const [inventory, invocations] = await Promise.all([
    options.inventory ?? loadAgentInventory(options),
    options.invocations ?? loadToolInvocations(options)
  ]);
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

  const dead: DeadContextItem[] = [];
  let loadedCount = 0;
  for (const item of items) {
    // Lifecycle hooks are activation evidence, not prunable inventory. Their
    // runtime output cannot be inferred from config and they cannot be called
    // like a skill/tool, so classifying them as "never invoked" would be false.
    if (item.kind === "hook" || item.invocationTracking === "not_observable") continue;
    const evidence = invocationEvidenceFor(item.host, invocations);
    const hasMatchingHostCoverage = evidence.sessions > 0 && evidence.totalAssistantTurns > 0;
    // Once host-isolated evidence is available, another host's transcripts are
    // never an observation opportunity for this item and do not enter the
    // candidate denominator. Hostless legacy fixtures keep the old global
    // inventory-count behavior while still producing no candidate without data.
    if (item.host && invocations.byHost && !hasMatchingHostCoverage) continue;
    loadedCount += 1;
    // Configuration without an observed assistant turn in the selected window
    // is inventory, not evidence that an item went unused. Keep the configured
    // count available for coverage reporting, but do not classify candidates.
    if (!hasMatchingHostCoverage) continue;
    if (!isDead(item, invocationSets(evidence))) {
      continue;
    }
    dead.push({
      kind: item.kind,
      name: item.name,
      scope: item.scope,
      activation: item.activation,
      host: item.host,
      invocationTracking: item.invocationTracking,
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
  const hasData = loadedCount > 0 && dead.length > 0;

  const rates = pricingRates(config.pricingModel);
  const monthFactor = DEFAULT_WINDOW_DAYS / windowDays;
  let windowCachedUsd = 0;
  let windowUncachedUsd = 0;
  let monthlyDeadTokens = 0;
  const measuredByCoverage = new Map<string, {
    tokens: number;
    evidence: HostInvocationEvidence;
  }>();
  for (const item of measuredDead) {
    const key = item.host && invocations.byHost ? item.host : "global";
    const current = measuredByCoverage.get(key) ?? {
      tokens: 0,
      evidence: invocationEvidenceFor(item.host, invocations)
    };
    current.tokens += item.alwaysLoadedTokens;
    measuredByCoverage.set(key, current);
  }
  for (const { tokens, evidence } of measuredByCoverage.values()) {
    // Cached: one cache write per same-host session + a cache read on every
    // later same-host turn. Cross-host turns never price this inventory.
    const cacheReads = Math.max(0, evidence.totalAssistantTurns - evidence.sessions);
    windowCachedUsd += (
      tokens * (
        evidence.sessions * rates.write5mPerM +
        cacheReads * rates.cacheReadPerM
      )
    ) / 1_000_000;
    windowUncachedUsd += (
      tokens * evidence.totalAssistantTurns * rates.inputPerM
    ) / 1_000_000;
    monthlyDeadTokens += tokens * evidence.totalAssistantTurns * monthFactor;
  }

  return {
    hasData,
    loadedCount,
    deadCount: dead.length,
    measuredDeadCount: measuredDead.length,
    unmeasuredDeadCount: unmeasuredDead.length,
    deadTokens: measuredTokens,
    monthlyDeadTokens: Math.round(monthlyDeadTokens),
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
    title: `Review ${result.measuredDeadCount} discoverable item${result.measuredDeadCount === 1 ? "" : "s"} with no observed invocation`,
    action:
      `Inspect ${result.deadCount} of ${result.loadedCount} observable inventory item${result.loadedCount === 1 ? "" : "s"} ` +
      `(${pct}% had no matching invocation) before proposing a scoped disable, lazy-load, or removal.`,
    estimatedMonthlySavingsUsd: result.monthlyUsd,
    affectedSpendUsd: result.monthlyUsd,
    impactBasis: "modeled_savings",
    recordCount: result.deadCount,
    recordUnit: "tools",
    // Dead-context savings come from inventory, not priced usage records, so
    // there are no record IDs to dedupe against the spend-based cut actions.
    recordIds: [],
    confidence: "estimated",
    kind: "context_trim"
  };
}

function invocationEvidenceFor(
  host: InventoryHost | undefined,
  invocations: InvocationSummary
): HostInvocationEvidence {
  if (host && invocations.byHost) return invocations.byHost[host];
  return {
    sessions: invocations.sessions,
    totalAssistantTurns: invocations.totalAssistantTurns,
    sessionTurnCounts: invocations.sessionTurnCounts,
    invokedMcpTools: invocations.invokedMcpTools,
    invokedSkills: invocations.invokedSkills,
    invokedSubagents: invocations.invokedSubagents,
    invokedCommands: invocations.invokedCommands
  };
}

function invocationSets(evidence: HostInvocationEvidence): {
  usedSkills: Set<string>;
  usedSubagents: Set<string>;
  usedCommands: Set<string>;
  usedMcpTools: Set<string>;
  usedMcpServers: Set<string>;
} {
  return {
    usedSkills: new Set(evidence.invokedSkills),
    usedSubagents: new Set(evidence.invokedSubagents),
    usedCommands: new Set(evidence.invokedCommands),
    usedMcpTools: new Set(evidence.invokedMcpTools),
    // An MCP server counts as used only when a same-host MCP tool belongs to it.
    usedMcpServers: new Set(
      evidence.invokedMcpTools
        .map((tool) => tool.split("__")[1])
        .filter((id): id is string => Boolean(id))
    )
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
    case "hook":
      return false;
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
