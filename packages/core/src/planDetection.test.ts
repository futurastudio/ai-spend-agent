import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLAN_TIER_OPT_OUT,
  detectLocalPlans,
  normalizeClaudePlanTier,
  normalizeCodexPlanTier,
  readAgentPlanFacts,
  type AgentPlanFact
} from "./planDetection.js";

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

const fakeToken = "fake-oauth-" + "token-value-should-never-appear";

describe("local plan detection", () => {
  it("detects Claude Max tiers from Claude Code's local config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-claude-"));
    const configPath = join(dir, "claude.json");
    await writeFile(configPath, JSON.stringify({
      oauthAccount: {
        emailAddress: "dev@example.com",
        billingType: "stripe_subscription",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_5x",
        accessToken: fakeToken
      }
    }));

    const plans = await detectLocalPlans({ claudeConfigPath: configPath, codexAuthPath: join(dir, "missing.json") });

    expect(plans).toEqual([
      expect.objectContaining({
        agent: "claude-code",
        provider: "anthropic",
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription"
      })
    ]);
    expect(JSON.stringify(plans)).not.toContain(fakeToken);
  });

  it("detects Max 20x and Pro tiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-tiers-"));
    const write = async (tier: string, organizationType = "claude_max") => {
      const path = join(dir, `${tier}.json`);
      await writeFile(path, JSON.stringify({
        oauthAccount: { billingType: "stripe_subscription", organizationType, organizationRateLimitTier: tier }
      }));
      return (await detectLocalPlans({ claudeConfigPath: path, codexAuthPath: join(dir, "missing.json") }))[0];
    };

    expect((await write("default_claude_max_20x"))!.planId).toBe("claude-max-20x");
    expect((await write("default_claude_pro", "claude_pro"))!.planId).toBe("claude-pro");
  });

  it("names unknown Claude tiers honestly without inventing a price", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-unknown-"));
    const configPath = join(dir, "claude.json");
    await writeFile(configPath, JSON.stringify({
      oauthAccount: { billingType: "stripe_subscription", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_100x" }
    }));

    const [plan] = await detectLocalPlans({ claudeConfigPath: configPath, codexAuthPath: join(dir, "missing.json") });

    expect(plan!.planId).toBeUndefined();
    expect(plan!.planLabel).toContain("default_claude_max_100x");
  });

  it("detects ChatGPT plan type from Codex's local id_token claims", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-codex-"));
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: fakeJwt({
          email: "dev@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-1" }
        }),
        access_token: fakeToken
      }
    }));

    const plans = await detectLocalPlans({ claudeConfigPath: join(dir, "missing.json"), codexAuthPath: authPath });

    expect(plans).toEqual([
      expect.objectContaining({ agent: "codex", planId: "chatgpt-plus", planLabel: "ChatGPT Plus", billing: "subscription" })
    ]);
    expect(JSON.stringify(plans)).not.toContain(fakeToken);
  });

  it("labels Codex API-key mode as pay-per-token, and unknown plan types by name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-codex2-"));
    const apiKeyPath = join(dir, "apikey.json");
    await writeFile(apiKeyPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-" + "fake1234567890abcdefgh" }));
    const proLitePath = join(dir, "prolite.json");
    await writeFile(proLitePath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "prolite" } }) }
    }));

    const apiKey = (await detectLocalPlans({ claudeConfigPath: join(dir, "m.json"), codexAuthPath: apiKeyPath }))[0];
    expect(apiKey).toMatchObject({ agent: "codex", billing: "api_key" });
    expect(apiKey!.planId).toBeUndefined();

    const proLite = (await detectLocalPlans({ claudeConfigPath: join(dir, "m.json"), codexAuthPath: proLitePath }))[0];
    expect(proLite!.planId).toBeUndefined();
    expect(proLite!.planLabel).toContain("prolite");
  });

  it("surfaces exhausted extra-usage credits as a limit signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-limit-"));
    const configPath = join(dir, "claude.json");
    await writeFile(configPath, JSON.stringify({
      cachedExtraUsageDisabledReason: "out_of_credits",
      oauthAccount: { billingType: "stripe_subscription", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x" }
    }));

    const [plan] = await detectLocalPlans({ claudeConfigPath: configPath, codexAuthPath: join(dir, "missing.json") });
    expect(plan!.limitSignal).toBe("extra-usage credits exhausted");
  });

  it("returns empty (never throws) when nothing is on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-plan-empty-"));
    const plans = await detectLocalPlans({
      claudeConfigPath: join(dir, "missing.json"),
      codexAuthPath: join(dir, "missing-auth.json")
    });
    expect(plans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workspace agent-plan facts
// ---------------------------------------------------------------------------

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures/local-agent-formats");
const claudePlanFixture = join(fixtureRoot, "claude-code-plan-v1/claude.json");
const codexPlanFixture = join(fixtureRoot, "codex-plan-v1/auth.json");
const now = "2026-11-04T12:00:00.000Z";

/** A throwaway home laid out the way the agents leave it: ~/.claude.json and ~/.codex/auth.json. */
async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-home-"));
  await cp(claudePlanFixture, join(home, ".claude.json"));
  await mkdir(join(home, ".codex"));
  await cp(codexPlanFixture, join(home, ".codex", "auth.json"));
  return home;
}

/** Every identity or credential string the fixtures carry; none may reach a serialized fact. */
async function fixtureSecrets(): Promise<{ keys: string[]; values: string[] }> {
  const claude = JSON.parse(await readFile(claudePlanFixture, "utf8")) as { oauthAccount: Record<string, unknown> };
  const codex = JSON.parse(await readFile(codexPlanFixture, "utf8")) as { tokens: Record<string, string> };
  const payload = JSON.parse(Buffer.from(codex.tokens.id_token!.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const authClaims = payload["https://api.openai.com/auth"] as Record<string, unknown>;
  const keys = ["accountUuid", "emailAddress", "organizationUuid", "displayName", "organizationRole", "seatTier",
    "id_token", "access_token", "refresh_token", "email", "sub", "chatgpt_account_id", "chatgpt_user_id", "user_id"];
  const values = [
    ...["accountUuid", "emailAddress", "organizationUuid", "displayName"].map(key => claude.oauthAccount[key] as string),
    ...Object.values(codex.tokens),
    ...codex.tokens.id_token!.split("."),
    payload.email as string, payload.sub as string, payload.iss as string,
    ...["chatgpt_account_id", "chatgpt_user_id", "user_id"].map(key => authClaims[key] as string)
  ];
  expect(values.every(value => typeof value === "string" && value.length > 0)).toBe(true);
  return { keys, values };
}

describe("agent plan facts for Workspace", () => {
  it("reads one exact fact per agent from the fixture home and leaks nothing else", async () => {
    const home = await fixtureHome();
    const facts = await readAgentPlanFacts({ now, home, env: {} });

    const expected: AgentPlanFact[] = [
      { kind: "agent_plan", agent: "claude_code", tier: "claude_max_20x", tierRaw: "default_claude_max_20x",
        source: "claude_json.oauthAccount.organizationRateLimitTier", observedAt: now, activeUntil: null },
      { kind: "agent_plan", agent: "codex", tier: "chatgpt_pro", tierRaw: "pro",
        source: "codex_auth.id_token.chatgpt_plan_type", observedAt: now, activeUntil: "2026-12-01T00:00:00.000Z" }
    ];
    expect(facts).toEqual(expected);
    expect(facts.map(fact => Object.keys(fact))).toEqual(expected.map(() =>
      ["kind", "agent", "tier", "tierRaw", "source", "observedAt", "activeUntil"]));

    const serialized = JSON.stringify(facts);
    const secrets = await fixtureSecrets();
    for (const key of secrets.keys) expect(serialized).not.toContain(`"${key}"`);
    for (const value of secrets.values) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain("fixture-");
    expect(serialized).not.toContain("eyJ");
  });

  it("maps the tier strings the agents write and keeps anything else as unknown with the raw string", () => {
    expect(normalizeClaudePlanTier("default_claude_max_20x")).toBe("claude_max_20x");
    expect(normalizeClaudePlanTier("default_claude_max_5x")).toBe("claude_max_5x");
    expect(normalizeClaudePlanTier("default_claude_pro")).toBe("claude_pro");
    expect(normalizeClaudePlanTier("claude_team")).toBe("claude_team");
    expect(normalizeClaudePlanTier("default_claude_enterprise")).toBe("claude_enterprise");
    expect(normalizeClaudePlanTier("default_claude_max_100x")).toBe("unknown");
    expect(normalizeClaudePlanTier("default_unknown")).toBe("unknown");
    expect(normalizeClaudePlanTier("chatgpt_pro")).toBe("unknown");
    expect(normalizeClaudePlanTier("")).toBe("unknown");

    expect(normalizeCodexPlanTier("plus")).toBe("chatgpt_plus");
    expect(normalizeCodexPlanTier("pro")).toBe("chatgpt_pro");
    expect(normalizeCodexPlanTier("business")).toBe("chatgpt_business");
    expect(normalizeCodexPlanTier("team")).toBe("chatgpt_business");
    expect(normalizeCodexPlanTier("enterprise")).toBe("chatgpt_enterprise");
    expect(normalizeCodexPlanTier("Pro")).toBe("chatgpt_pro");
    expect(normalizeCodexPlanTier("prolite")).toBe("unknown");
    expect(normalizeCodexPlanTier("free")).toBe("unknown");
  });

  it("keeps an unmapped tier as unknown while sending the raw string", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-unknown-"));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_100x" } }));
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: fakeJwt({
      "https://api.openai.com/auth": { chatgpt_plan_type: "prolite" } }) } }));

    const facts = await readAgentPlanFacts({ now, home, env: {} });
    expect(facts.map(fact => [fact.agent, fact.tier, fact.tierRaw, fact.activeUntil])).toEqual([
      ["claude_code", "unknown", "default_claude_max_100x", null],
      ["codex", "unknown", "prolite", null]
    ]);
  });

  it("is suppressed by the documented opt-out and ignores an empty value", async () => {
    const home = await fixtureHome();
    expect(AGENT_PLAN_TIER_OPT_OUT).toBe("AIBILL_NO_PLAN_TIER");
    expect(await readAgentPlanFacts({ now, home, env: { AIBILL_NO_PLAN_TIER: "1" } })).toEqual([]);
    expect(await readAgentPlanFacts({ now, home, env: { AIBILL_NO_PLAN_TIER: "true" } })).toEqual([]);
    expect(await readAgentPlanFacts({ now, home, env: { AIBILL_NO_PLAN_TIER: "" } })).toHaveLength(2);
  });

  it("fails open: missing, malformed or unexpected files yield no fact and no error", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-failopen-"));
    const codexDir = join(home, ".codex");
    await mkdir(codexDir);
    const read = () => readAgentPlanFacts({ now, home, env: {} });

    // Nothing on disk.
    expect(await read()).toEqual([]);

    // Not JSON, JSON without the account, account without a string tier, tier that is not an identifier.
    await writeFile(join(home, ".claude.json"), "{ not json");
    await writeFile(join(codexDir, "auth.json"), "[]");
    expect(await read()).toEqual([]);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: "string" }));
    expect(await read()).toEqual([]);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: 20 } }));
    expect(await read()).toEqual([]);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "has a space" } }));
    expect(await read()).toEqual([]);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationRateLimitTier: "x".repeat(121) } }));
    expect(await read()).toEqual([]);

    // Codex: API-key sign-in, no tokens, id_token that is not a JWT, two segments, payload that is not JSON,
    // payload without the auth claim, plan type that is not a string.
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    const codexCases: unknown[] = [
      { auth_mode: "apikey", tokens: { id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) } },
      { auth_mode: "chatgpt" },
      { auth_mode: "chatgpt", tokens: { id_token: "not-a-jwt" } },
      { auth_mode: "chatgpt", tokens: { id_token: `${encode("{}")}.${encode(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }))}` } },
      { auth_mode: "chatgpt", tokens: { id_token: `${encode("{}")}.${encode("{ nope")}.${encode("sig")}` } },
      { auth_mode: "chatgpt", tokens: { id_token: `${encode("{}")}.${encode("[1,2]")}.${encode("sig")}` } },
      { auth_mode: "chatgpt", tokens: { id_token: fakeJwt({ sub: "someone" }) } },
      { auth_mode: "chatgpt", tokens: { id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: 7 } }) } },
      { auth_mode: "chatgpt", tokens: { id_token: 42 } }
    ];
    for (const auth of codexCases) {
      await writeFile(join(codexDir, "auth.json"), JSON.stringify(auth));
      expect(await read(), JSON.stringify(auth)).toEqual([]);
    }

    // A directory where the file should be.
    await rm(join(home, ".claude.json"));
    await mkdir(join(home, ".claude.json"));
    expect(await read()).toEqual([]);

    // A caller clock that is not an ISO instant yields nothing rather than a malformed fact.
    const good = await fixtureHome();
    expect(await readAgentPlanFacts({ now: "yesterday", home: good, env: {} })).toEqual([]);
  });

  it("normalizes the subscription end to an ISO instant and drops one it cannot read", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibill-plan-facts-until-"));
    await mkdir(join(home, ".codex"));
    const write = (until: unknown) => writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
      tokens: { id_token: fakeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_subscription_active_until: until } }) } }));

    await write("2027-01-31T23:59:59+01:00");
    expect((await readAgentPlanFacts({ now, home, env: {} }))[0]?.activeUntil).toBe("2027-01-31T22:59:59.000Z");
    await write("soon");
    expect((await readAgentPlanFacts({ now, home, env: {} }))[0]?.activeUntil).toBeNull();
    await write(1800000000);
    expect((await readAgentPlanFacts({ now, home, env: {} }))[0]?.activeUntil).toBeNull();
  });

  it("honours explicit file paths the way doctor does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibill-plan-facts-paths-"));
    const facts = await readAgentPlanFacts({ now, home: dir, env: {}, claudeConfigPath: claudePlanFixture, codexAuthPath: codexPlanFixture });
    expect(facts.map(fact => fact.tier)).toEqual(["claude_max_20x", "chatgpt_pro"]);
  });
});
