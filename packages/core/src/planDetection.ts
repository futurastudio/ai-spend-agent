import { readFile } from "node:fs/promises";
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
  const segment = jwt.split(".")[1];
  if (!segment) return undefined;
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonQuietly(path: string): Promise<unknown> {
  try {
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
