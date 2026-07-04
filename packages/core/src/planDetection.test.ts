import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectLocalPlans } from "./planDetection.js";

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
