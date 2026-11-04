import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local subscription-plan detection — the zero-friction, fully legitimate
 * path to "the tool knows who it's talking to".
 *
 * Consumer subscriptions (Claude Max/Pro, ChatGPT Plus/Pro) have NO billing
 * API, so there is nothing to OAuth against. But the coding agents already
 * did their own OAuth and persist what they learned on disk, right next to
 * the transcripts we already read:
 *
 *  - Claude Code: `~/.claude.json` -> `oauthAccount.organizationType`
 *    ("claude_max" | "claude_pro" | ...), `organizationRateLimitTier`
 *    ("default_claude_max_5x" | "default_claude_max_20x" | ...), and
 *    `billingType` ("stripe_subscription" | ...).
 *  - Codex CLI: `~/.codex/auth.json` -> `auth_mode` ("chatgpt" | "apikey");
 *    in chatgpt mode the locally stored id_token's claims carry
 *    `chatgpt_plan_type` ("plus" | "pro" | ...).
 *
 * Privacy contract: this module reads ONLY the whitelisted plan/billing
 * fields above. Token values are never read into results, never returned,
 * never logged. Everything is local; no network calls.
 */

export type DetectedPlan = {
  agent: "claude-code" | "codex";
  provider: "anthropic" | "openai";
  /** Matches a `subscriptionPlans` id when the plan is one we can price. */
  planId?: string;
  /** Human-readable plan label; falls back to the raw local identifier. */
  planLabel: string;
  billing: "subscription" | "api_key" | "unknown";
  /**
   * Evidence of plan-limit pressure found in the agent's local config —
   * e.g. Claude Code records when extra-usage credits ran out. This is the
   * difference between "you might hit limits" and "you ARE hitting limits".
   */
  limitSignal?: string;
  /** Where the detection came from (file or "--plan override"). */
  source: string;
};

export type PlanDetectionOptions = {
  /** Default: ~/.claude.json (Claude Code's top-level config). */
  claudeConfigPath?: string;
  /** Default: ~/.codex/auth.json. */
  codexAuthPath?: string;
};

/** Detect the plans this machine's coding agents are signed in with. */
export async function detectLocalPlans(options: PlanDetectionOptions = {}): Promise<DetectedPlan[]> {
  const home = homedir();
  const claudeConfigPath = options.claudeConfigPath ?? join(home, ".claude.json");
  const codexAuthPath = options.codexAuthPath ?? join(home, ".codex", "auth.json");

  const plans: DetectedPlan[] = [];
  const claude = await detectClaudePlan(claudeConfigPath);
  if (claude) plans.push(claude);
  const codex = await detectCodexPlan(codexAuthPath);
  if (codex) plans.push(codex);
  return plans;
}

async function detectClaudePlan(configPath: string): Promise<DetectedPlan | undefined> {
  const config = await readJsonQuietly(configPath);
  const account = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : undefined;
  if (!account) return undefined;

  const organizationType = stringOf(account.organizationType);
  const rateLimitTier = stringOf(account.organizationRateLimitTier) ?? stringOf(account.userRateLimitTier);
  const billingType = stringOf(account.billingType);
  if (!organizationType && !rateLimitTier) return undefined;

  let planId: string | undefined;
  let planLabel: string;
  if (rateLimitTier && /max_20x/i.test(rateLimitTier)) {
    planId = "claude-max-20x";
    planLabel = "Claude Max 20x";
  } else if (rateLimitTier && /max_5x/i.test(rateLimitTier)) {
    planId = "claude-max-5x";
    planLabel = "Claude Max 5x";
  } else if (organizationType === "claude_pro" || (rateLimitTier && /pro/i.test(rateLimitTier))) {
    planId = "claude-pro";
    planLabel = "Claude Pro";
  } else if (organizationType === "claude_max") {
    // Max org but an unrecognized tier string: say what we know, price nothing.
    planLabel = `Claude Max (tier: ${rateLimitTier ?? "unknown"})`;
  } else {
    planLabel = organizationType ?? rateLimitTier ?? "unknown";
  }

  // Claude Code records why extra usage is unavailable; "out_of_credits"
  // means the user already exhausted their overage pool — hard evidence of
  // limit pressure, not a guess.
  const extraUsageReason = isRecord(config) ? stringOf(config.cachedExtraUsageDisabledReason) : undefined;
  const limitSignal = extraUsageReason === "out_of_credits"
    ? "extra-usage credits exhausted"
    : undefined;

  return {
    agent: "claude-code",
    provider: "anthropic",
    planId,
    planLabel,
    billing: billingType === "stripe_subscription" ? "subscription" : billingType ? "unknown" : "unknown",
    limitSignal,
    source: configPath
  };
}

async function detectCodexPlan(authPath: string): Promise<DetectedPlan | undefined> {
  const auth = await readJsonQuietly(authPath);
  if (!isRecord(auth)) return undefined;

  const authMode = stringOf(auth.auth_mode);
  if (authMode === "apikey") {
    return {
      agent: "codex",
      provider: "openai",
      planLabel: "API key (pay per token)",
      billing: "api_key",
      source: authPath
    };
  }

  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const idToken = tokens ? stringOf(tokens.id_token) : undefined;
  const claims = idToken ? decodeJwtClaims(idToken) : undefined;
  const authClaims = claims && isRecord(claims["https://api.openai.com/auth"])
    ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
    : undefined;
  const planType = authClaims ? stringOf(authClaims.chatgpt_plan_type) : undefined;
  if (!planType && authMode !== "chatgpt") return undefined;

  let planId: string | undefined;
  let planLabel: string;
  if (planType === "plus") {
    planId = "chatgpt-plus";
    planLabel = "ChatGPT Plus";
  } else if (planType === "pro") {
    planId = "chatgpt-pro";
    planLabel = "ChatGPT Pro";
  } else if (planType) {
    // e.g. "team", "prolite": name it honestly, don't guess a price.
    planLabel = `ChatGPT (plan: ${planType})`;
  } else {
    planLabel = "ChatGPT (plan unknown)";
  }

  return {
    agent: "codex",
    provider: "openai",
    planId,
    planLabel,
    billing: "subscription",
    source: authPath
  };
}

/**
 * Decode a JWT's claims segment locally (base64url JSON). No verification —
 * we are reading our own user's already-trusted local file for display
 * metadata, not authenticating anything.
 */
function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const segments = jwt.split(".");
  const segment = segments[1];
  if (segments.length !== 3 || !segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Larger files are not an agent's config; the reader fails open rather than load them. */
const MAX_PLAN_FILE_BYTES = 64 * 1024 * 1024;

async function readJsonQuietly(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PLAN_FILE_BYTES) return undefined;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Workspace agent-plan facts
// ---------------------------------------------------------------------------

/**
 * Normalized subscription tier ids shared with Tilden Workspace. A raw tier
 * string the table does not know travels as `unknown` with `tierRaw` kept, so
 * the hosted side can add the mapping without a CLI release.
 */
export const AGENT_PLAN_TIER_IDS = [
  "claude_pro",
  "claude_max_5x",
  "claude_max_20x",
  "claude_team",
  "claude_enterprise",
  "chatgpt_plus",
  "chatgpt_pro",
  "chatgpt_business",
  "chatgpt_enterprise",
  "unknown"
] as const;
export type AgentPlanTierId = typeof AGENT_PLAN_TIER_IDS[number];

export const AGENT_PLAN_FACT_SOURCES = [
  "claude_json.oauthAccount.organizationRateLimitTier",
  "claude_json.oauthAccount.organizationType",
  "codex_auth.id_token.chatgpt_plan_type"
] as const;
export type AgentPlanFactSource = typeof AGENT_PLAN_FACT_SOURCES[number];

/**
 * One fact per machine and agent, sent with `workspace push` so Workspace can
 * cost subscription-billed sessions. It carries exactly these seven fields:
 * never a token, email, name, account id, organization name or uuid.
 */
export type AgentPlanFact = {
  kind: "agent_plan";
  agent: "claude_code" | "codex";
  tier: AgentPlanTierId;
  /** The tier string exactly as the agent stored it, bounded to a 64-character identifier. */
  tierRaw: string;
  source: AgentPlanFactSource;
  /** When this machine's file was read (an ISO instant supplied by the caller). */
  observedAt: string;
  /**
   * The UTC day the subscription the agent recorded runs to, as that day's
   * start (`YYYY-MM-DDT00:00:00.000Z`), or null when it records none. The day
   * is enough to cost sessions; the recorded instant would be a quasi-identifier.
   */
  activeUntil: string | null;
};

/** Set to any non-empty value to keep plan tiers out of every Workspace push. */
export const AGENT_PLAN_TIER_OPT_OUT = "AIBILL_NO_PLAN_TIER";

export type AgentPlanFactOptions = PlanDetectionOptions & {
  /** The instant the facts are observed; `workspace push` passes its batch time. */
  now: string;
  /** Default: the OS home directory. Tests and embeddings point it elsewhere. */
  home?: string;
  /** Default: `process.env`; read only for the opt-out. */
  env?: Record<string, string | undefined>;
};

const TIER_RAW = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Claude Code organization types billed as a consumer subscription; the rate-limit tier names the plan. */
const CLAUDE_CONSUMER_ORGANIZATION_TYPES = new Set(["claude_pro", "claude_max"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Claude Code stores the organization's rate-limit tier as
 * `default_claude_max_20x`; the id after the `default_` prefix is the tier.
 * Only exact matches map; `default_claude_max_100x` stays `unknown`.
 */
export function normalizeClaudePlanTier(raw: string): AgentPlanTierId {
  const candidate = raw.trim().toLowerCase().replace(/^default_/, "");
  return candidate !== "unknown" && candidate.startsWith("claude_") && (AGENT_PLAN_TIER_IDS as readonly string[]).includes(candidate)
    ? candidate as AgentPlanTierId : "unknown";
}

/**
 * A Claude Code organization that is not a consumer plan is a Team or
 * Enterprise seat; the rate-limit tier then describes the organization's
 * limits, not the plan. Unrecognized organization types stay `unknown`.
 */
export function normalizeClaudeOrganizationType(raw: string): AgentPlanTierId {
  switch (raw.trim().toLowerCase()) {
    case "claude_team": return "claude_team";
    case "claude_enterprise": return "claude_enterprise";
    default: return "unknown";
  }
}

/** Codex's id_token names the ChatGPT plan: `plus`, `pro`, `business` (`team` before the rename), `enterprise`. */
export function normalizeCodexPlanTier(raw: string): AgentPlanTierId {
  switch (raw.trim().toLowerCase()) {
    case "plus": return "chatgpt_plus";
    case "pro": return "chatgpt_pro";
    case "business":
    case "team": return "chatgpt_business";
    case "enterprise": return "chatgpt_enterprise";
    default: return "unknown";
  }
}

/**
 * Read the subscription tier each coding agent left on this machine. Fails
 * open: a missing or unreadable file, a malformed id_token or an unexpected
 * shape yields no fact for that agent and never throws. Nothing is cached,
 * logged or sent from here; `workspace push` previews the facts before sending.
 */
export async function readAgentPlanFacts(options: AgentPlanFactOptions): Promise<AgentPlanFact[]> {
  const env = options.env ?? process.env;
  if (env[AGENT_PLAN_TIER_OPT_OUT]) return [];
  if (!ISO_INSTANT.test(options.now) || !Number.isFinite(Date.parse(options.now))) return [];
  const home = options.home ?? homedir();
  const claudeConfigPath = options.claudeConfigPath ?? join(home, ".claude.json");
  const codexAuthPath = options.codexAuthPath ?? join(home, ".codex", "auth.json");
  const facts: AgentPlanFact[] = [];
  const claude = await readClaudePlanFact(claudeConfigPath, options.now).catch(() => undefined);
  if (claude) facts.push(claude);
  const codex = await readCodexPlanFact(codexAuthPath, options.now).catch(() => undefined);
  if (codex) facts.push(codex);
  return facts;
}

async function readClaudePlanFact(configPath: string, observedAt: string): Promise<AgentPlanFact | undefined> {
  const config = await readJsonQuietly(configPath);
  const account = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : undefined;
  if (!account) return undefined;
  const organizationType = stringOf(account.organizationType);
  if (organizationType && !CLAUDE_CONSUMER_ORGANIZATION_TYPES.has(organizationType.trim().toLowerCase())) {
    if (!TIER_RAW.test(organizationType)) return undefined;
    return {
      kind: "agent_plan",
      agent: "claude_code",
      tier: normalizeClaudeOrganizationType(organizationType),
      tierRaw: organizationType,
      source: "claude_json.oauthAccount.organizationType",
      observedAt,
      activeUntil: null
    };
  }
  const tierRaw = stringOf(account.organizationRateLimitTier);
  if (!tierRaw || !TIER_RAW.test(tierRaw)) return undefined;
  return {
    kind: "agent_plan",
    agent: "claude_code",
    tier: normalizeClaudePlanTier(tierRaw),
    tierRaw,
    source: "claude_json.oauthAccount.organizationRateLimitTier",
    observedAt,
    activeUntil: null
  };
}

async function readCodexPlanFact(authPath: string, observedAt: string): Promise<AgentPlanFact | undefined> {
  const auth = await readJsonQuietly(authPath);
  if (!isRecord(auth)) return undefined;
  // An API-key sign-in bills per token; it has no plan tier to report.
  if (stringOf(auth.auth_mode) === "apikey") return undefined;
  const tokens = isRecord(auth.tokens) ? auth.tokens : undefined;
  const idToken = tokens ? stringOf(tokens.id_token) : undefined;
  // Only the payload segment is decoded, locally, without verification; the
  // token itself is never kept past this call.
  const claims = idToken ? decodeJwtClaims(idToken) : undefined;
  const authClaims = claims && isRecord(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"] : undefined;
  if (!authClaims) return undefined;
  const tierRaw = stringOf(authClaims.chatgpt_plan_type);
  if (!tierRaw || !TIER_RAW.test(tierRaw)) return undefined;
  return {
    kind: "agent_plan",
    agent: "codex",
    tier: normalizeCodexPlanTier(tierRaw),
    tierRaw,
    source: "codex_auth.id_token.chatgpt_plan_type",
    observedAt,
    activeUntil: utcDayStartOf(authClaims.chatgpt_subscription_active_until)
  };
}

/** A parseable date string becomes the start of its UTC day; anything else is null. */
function utcDayStartOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z` : null;
}
