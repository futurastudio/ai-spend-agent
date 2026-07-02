import { describe, expect, it } from "vitest";
import {
  createProviderConnection,
  fetchProviderUsageRecords,
  normalizeAnthropicCostResponse,
  normalizeCursorSpendResponse,
  normalizeGitHubCopilotMetricsResponse,
  normalizeOpenAiCostResponse,
  normalizeOpenAiUsageResponse,
  normalizeAnthropicClaudeCodeUsageResponse,
  normalizeGitHubCopilotSeatResponse,
  resolveTokenReference
} from "./providerConnectors.js";

const fakeToken = "sk-" + "admin-realistic-fake-token-do-not-store";

describe("real provider connector implementations", () => {
  it("normalizes OpenAI Usage API token evidence by project, user, model, and API key without overclaiming spend", () => {
    const records = normalizeOpenAiUsageResponse({
      data: [{
        start_time: 1761955200,
        results: [{
          object: "organization.usage.completions.result",
          input_tokens: 1200,
          output_tokens: 300,
          input_cached_tokens: 200,
          num_model_requests: 42,
          project_id: "proj_sales",
          user_id: "user_jose",
          api_key_id: "key_platform_sales",
          model: "gpt-5.1"
        }]
      }]
    }, { sourceId: "openai-provider-api", observedFrom: "OpenAI organization usage API" });

    expect(records).toEqual([
      expect.objectContaining({
        id: "openai-usage-1761955200-proj-sales-user-jose-key-platform-sales-gpt-5-1",
        model: "gpt-5.1",
        inputTokens: 1200,
        outputTokens: 300,
        amountUsd: null,
        costConfidence: "missing",
        projectId: "proj_sales",
        userId: "user_jose",
        apiKeyId: "key_platform_sales",
        providerCostType: "openai_usage_evidence",
        quantity: 42,
        operation: "OpenAI completions usage evidence"
      })
    ]);
  });

  it("normalizes Anthropic Claude Code usage reports into per-user estimated cost and productivity records", () => {
    const records = normalizeAnthropicClaudeCodeUsageResponse({
      data: [{
        date: "2026-05-01",
        actor: { type: "user_actor", email_address: "dev@example.com" },
        organization_id: "org_123",
        terminal_type: "vscode",
        customer_type: "subscription",
        core_metrics: {
          num_sessions: 8,
          lines_of_code: { added: 420, removed: 90 },
          commits_by_claude_code: 3,
          pull_requests_by_claude_code: 1
        },
        model_breakdown: [{
          model: "claude-sonnet-4-20250514",
          tokens: { input: 1000, output: 250, cache_read: 100, cache_creation: 50 },
          estimated_cost: { amount: 175, currency: "USD" }
        }]
      }]
    }, { sourceId: "anthropic-provider-api", observedFrom: "Anthropic Claude Code Usage Report" });

    expect(records).toEqual([
      expect.objectContaining({
        model: "claude-sonnet-4-20250514",
        inputTokens: 1150,
        outputTokens: 250,
        amountUsd: 1.75,
        costConfidence: "estimated",
        userId: "dev@example.com",
        projectId: "org_123",
        providerCostType: "anthropic_claude_code_usage",
        quantity: 8,
        operation: "Claude Code sessions: 8; LOC +420/-90; commits 3; PRs 1"
      })
    ]);
  });

  it("reconciles GitHub Copilot billing seats into estimated seat-cost records", () => {
    const records = normalizeGitHubCopilotSeatResponse({
      total_seats: 2,
      plan_type: "business",
      seats: [
        { assignee: { login: "alice" }, last_activity_at: "2026-05-02T12:00:00Z" },
        { assignee: { login: "bob" }, last_activity_at: null }
      ]
    }, { sourceId: "github-copilot-provider-api", observedFrom: "GitHub Copilot billing seats API", accountId: "futurastudio" });

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "github-copilot-business-seat",
        userId: "alice",
        amountUsd: 19,
        costConfidence: "estimated",
        projectId: "futurastudio",
        providerCostType: "copilot_seat_reconciliation",
        operation: "GitHub Copilot business seat; last activity 2026-05-02T12:00:00Z"
      }),
      expect.objectContaining({
        userId: "bob",
        amountUsd: 19,
        costConfidence: "estimated",
        operation: "GitHub Copilot business seat; no recent activity reported"
      })
    ]));
  });

  it("accepts string dollar amounts from the live OpenAI costs API", () => {
    // Regression: the live API returns amount.value as a decimal string;
    // dropping it silently zeroed real spend (caught in accuracy QA 2026-06-10).
    const records = normalizeOpenAiCostResponse({
      data: [{
        object: "bucket",
        start_time: 1781049600,
        results: [{
          object: "organization.costs.result",
          amount: { value: "0.0004632000000000000000000000000", currency: "usd" },
          project_id: "proj_default",
          line_item: null
        }]
      }]
    }, { sourceId: "openai-provider-api", observedFrom: "OpenAI organization costs API" });

    expect(records).toHaveLength(1);
    expect(records[0]!.amountUsd).toBeCloseTo(0.0004632, 7);
    expect(records[0]!.costConfidence).toBe("verified");
  });

  it("normalizes OpenAI organization cost buckets with project, API key, and line item dimensions", () => {
    const records = normalizeOpenAiCostResponse({
      data: [
        {
          object: "bucket",
          start_time: 1761955200,
          end_time: 1762041600,
          results: [
            {
              object: "organization.costs.result",
              amount: { value: 12.34, currency: "usd" },
              project_id: "proj_sales",
              api_key_id: "key_platform_sales",
              line_item: "gpt-5.1 input tokens",
              quantity: 12345
            }
          ]
        }
      ]
    }, { sourceId: "openai-provider-api", observedFrom: "OpenAI organization costs API" });

    expect(records).toEqual([
      expect.objectContaining({
        id: "openai-costs-1761955200-proj-sales-key-platform-sales-gpt-5-1-input-tokens",
        model: "gpt-5.1 input tokens",
        operation: "gpt-5.1 input tokens",
        amountUsd: 12.34,
        costConfidence: "verified",
        projectId: "proj_sales",
        apiKeyId: "key_platform_sales",
        quantity: 12345,
        source: expect.objectContaining({
          id: "openai-provider-api",
          provider: "openai",
          confidence: "verified",
          observedFrom: "OpenAI organization costs API"
        })
      })
    ]);
  });

  it("follows OpenAI pagination for costs and usage evidence without returning the raw token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      if (url.includes("/organization/costs") && !url.includes("page=cost-next")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ start_time: 1761955200, results: [{ amount: { value: 2, currency: "usd" }, line_item: "Responses API" }] }], has_more: true, next_page: "cost-next" }) };
      }
      if (url.includes("/organization/costs") && url.includes("page=cost-next")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ start_time: 1762041600, results: [{ amount: { value: 3, currency: "usd" }, line_item: "Batch API" }] }], has_more: false }) };
      }
      if (url.includes("/usage/completions") && !url.includes("page=usage-next")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ start_time: 1761955200, results: [{ input_tokens: 100, output_tokens: 20, user_id: "user_1", model: "gpt-5.1" }] }], has_more: true, next_page: "usage-next" }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ start_time: 1762041600, results: [{ input_tokens: 200, output_tokens: 40, user_id: "user_2", model: "gpt-5.1" }] }], has_more: false }) };
    };

    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      endTime: 1762128000,
      fetcher
    });

    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([
      expect.stringContaining("page=cost-next"),
      expect.stringContaining("page=usage-next")
    ]));
    expect(result.records).toHaveLength(4);
    expect(result.records.filter((record) => record.costConfidence === "verified")).toHaveLength(2);
    expect(result.records.filter((record) => record.costConfidence === "missing")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("captures live-provider QA for response drift, pagination boundaries, and rate-limit headers", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.includes("/organization/costs")) {
        return {
          ok: true,
          status: 200,
          headers: { "x-ratelimit-remaining-requests": "4", "retry-after": "2" },
          json: async () => ({ data: [{ start_time: 1761955200, results: [{ amount: { value: 1, currency: "usd" }, unexpected_cost_dimension: "new-provider-field" }] }] })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ start_time: 1761955200, unexpected_bucket_key: "drift", results: [] }], has_more: true })
      };
    };

    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher
    });

    expect(calls).toHaveLength(2);
    expect(result.qa.provider).toBe("openai");
    expect(result.qa.requestedEndpoints).toEqual(expect.arrayContaining(["OpenAI costs API", "OpenAI usage API"]));
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "OpenAI usage API", pagesFetched: 1, stoppedBecause: "missing_cursor", limitPerPage: 31 })
    ]));
    expect(result.qa.rateLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "OpenAI costs API", remainingRequests: 4, retryAfterSeconds: 2 })
    ]));
    expect(result.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "OpenAI costs API", field: "data[0].results[0].unexpected_cost_dimension" }),
      expect.objectContaining({ label: "OpenAI usage API", field: "data[0].unexpected_bucket_key" }),
      expect.objectContaining({ label: "OpenAI usage API", issue: "pagination indicated more pages but no next cursor was returned" })
    ]));
    expect(JSON.stringify(result.qa)).not.toContain(fakeToken);
  });

  it("returns actionable missing-scope prompts on provider permission failures without leaking the token", async () => {
    await expect(fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async () => ({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({ error: { message: `scope denied for ${fakeToken}` } }) })
    })).rejects.toThrow(/Missing OpenAI admin read scopes/);

    await expect(fetchProviderUsageRecords({
      provider: "github-copilot",
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      org: "futurastudio",
      fetcher: async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({ message: `bad token ${fakeToken}` }) })
    })).rejects.toThrow(/Missing GitHub Copilot org or enterprise read scopes/);
  });

  it("fails loudly (not silently $0) when Cursor returns an unrecognized shape", async () => {
    await expect(fetchProviderUsageRecords({
      provider: "cursor",
      sourceId: "cursor-provider-api",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      accountId: "team-acme",
      // API answers OK but with fields we don't map — must throw, never report $0.
      fetcher: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ teamMembers: [{ cents_spent: 4200 }] }) })
    })).rejects.toThrow(/no spend fields this connector recognizes/);
  });

  it("fetches OpenAI costs grouped by project, api key, and line item without returning the raw token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => url.includes("/usage/completions") ? ({
          data: [{ start_time: 1761955200, results: [{ input_tokens: 100, output_tokens: 25, project_id: "proj_usage", user_id: "user_123", api_key_id: "key_123", model: "gpt-5.1" }] }]
        }) : ({
          data: [{ start_time: 1761955200, results: [{ amount: { value: 4.2, currency: "usd" }, line_item: "Responses API", api_key_id: "key_123" }] }]
        })
      };
    };

    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      endTime: 1762041600,
      fetcher
    });

    expect(calls[0].url).toContain("https://api.openai.com/v1/organization/costs");
    expect(calls[1].url).toContain("https://api.openai.com/v1/organization/usage/completions");
    expect(calls[1].url).toContain("group_by=model");
    expect(calls[1].url).toContain("group_by=user_id");
    expect(calls[1].url).toContain("group_by=project_id");
    expect(calls[1].url).toContain("group_by=api_key_id");
    expect(calls[0].url).toContain("group_by=project_id");
    expect(calls[0].url).toContain("group_by=line_item");
    expect(calls[0].url).toContain("group_by=api_key_id");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${fakeToken}`);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerCostType: "openai_cost", apiKeyId: "key_123" }),
      expect.objectContaining({ providerCostType: "openai_usage_evidence", userId: "user_123", model: "gpt-5.1", costConfidence: "missing" })
    ]));
    expect(result.source).toMatchObject({ verification: "verified", provider: "openai", authReference: "env:OPENAI_ADMIN_KEY" });
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("normalizes Anthropic Admin cost reports into verified workspace/model records", () => {
    const records = normalizeAnthropicCostResponse({
      data: [{
        starting_at: "2026-05-01T00:00:00Z",
        ending_at: "2026-05-02T00:00:00Z",
        results: [{
          amount: "123.45",
          currency: "USD",
          cost_type: "tokens",
          description: "Claude Sonnet 4 output tokens",
          model: "claude-sonnet-4-20250514",
          workspace_id: "wrk_sales",
          token_type: "output_tokens"
        }]
      }]
    }, { sourceId: "anthropic-provider-api", observedFrom: "Anthropic Admin Cost Report" });

    expect(records).toEqual([
      expect.objectContaining({
        id: "anthropic-costs-2026-05-01t00-00-00z-wrk-sales-claude-sonnet-4-20250514-output-tokens",
        model: "claude-sonnet-4-20250514",
        amountUsd: 1.2345,
        costConfidence: "verified",
        projectId: "wrk_sales",
        providerCostType: "tokens",
        operation: "Claude Sonnet 4 output tokens",
        source: expect.objectContaining({ provider: "anthropic", confidence: "verified" })
      })
    ]);
  });

  it("fetches Anthropic Admin cost report with x-api-key reference auth", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ starting_at: "2026-05-01T00:00:00Z", results: [{ amount: "250", currency: "USD", model: "claude-opus-4-1", workspace_id: "wrk_eng", cost_type: "tokens" }] }] })
      };
    };

    const result = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_API_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      endTime: 1762041600,
      fetcher
    });

    expect(calls[0].url).toContain("https://api.anthropic.com/v1/organizations/cost_report");
    expect(calls[0].headers["x-api-key"]).toBe(fakeToken);
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(result.records[0]).toMatchObject({ providerCostType: "tokens", projectId: "wrk_eng" });
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("normalizes GitHub Copilot enterprise/org usage metrics as verified usage evidence", () => {
    const records = normalizeGitHubCopilotMetricsResponse({
      day_totals: [{
        day: "2026-05-01",
        daily_active_users: 12,
        totals_by_model_feature: [{ model: "gpt-4.1", feature: "chat", user_initiated_interaction_count: 44 }],
        totals_by_cli: { request_count: 9, token_usage: { prompt_tokens_sum: 1000, output_tokens_sum: 250 } }
      }]
    }, { sourceId: "github-copilot-provider-api", observedFrom: "GitHub Copilot metrics API", accountId: "futurastudio" });

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "gpt-4.1",
        amountUsd: null,
        costConfidence: "missing",
        operation: "chat",
        providerCostType: "copilot_usage_metrics",
        projectId: "futurastudio"
      }),
      expect.objectContaining({
        model: "github-copilot-cli",
        inputTokens: 1000,
        outputTokens: 250,
        providerCostType: "copilot_cli_metrics"
      })
    ]));
  });

  it("fetches GitHub Copilot metrics for org or enterprise account references", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      if (url.includes("/copilot/billing/seats") && !url.includes("page=2")) {
        return {
          ok: true,
          status: 200,
          headers: {
            link: '<https://api.github.com/orgs/futurastudio/copilot/billing/seats?per_page=100&page=2>; rel="next"',
            "x-ratelimit-remaining": "4999"
          },
          json: async () => ({ total_seats: 2, plan_type: "business", seats: [{ assignee: { login: "alice" } }] })
        };
      }
      if (url.includes("/copilot/billing/seats") && url.includes("page=2")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_seats: 2, plan_type: "business", seats: [{ assignee: { login: "bob" } }] })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ day_totals: [{ day: "2026-05-01", totals_by_cli: { request_count: 1, token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 25 } } }] })
      };
    };

    const result = await fetchProviderUsageRecords({
      provider: "github-copilot",
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      org: "futurastudio",
      fetcher
    });

    expect(calls[0].url).toContain("https://api.github.com/orgs/futurastudio/copilot/metrics/reports/organization-28-day/latest");
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([
      expect.stringContaining("/copilot/billing/seats?per_page=100"),
      expect.stringContaining("page=2")
    ]));
    expect(calls[0].headers.Authorization).toBe(`Bearer ${fakeToken}`);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "alice", providerCostType: "copilot_seat_reconciliation" }),
      expect.objectContaining({ userId: "bob", providerCostType: "copilot_seat_reconciliation" })
    ]));
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot seats", pagesFetched: 2, stoppedBecause: "complete", limitPerPage: 100 })
    ]));
    expect(result.qa.rateLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot seats", remainingRequests: 4999 })
    ]));
    // Seat dollars are estimated (plan-price reconciliation), so the result
    // and source labels must say estimated — never "verified" over estimates.
    expect(result.completeness).toBe("estimated");
    expect(result.source).toMatchObject({ provider: "github-copilot", verification: "estimated" });
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("normalizes Cursor Admin API spend when a real team API path is available", () => {
    const records = normalizeCursorSpendResponse({
      users: [{ email: "dev@example.com", spendCents: 345, usageBasedCents: 200 }]
    }, { sourceId: "cursor-provider-api", observedFrom: "Cursor Admin API", accountId: "futura-team" });

    expect(records).toEqual([
      expect.objectContaining({
        model: "cursor-team-usage",
        amountUsd: 3.45,
        // Cursor connector is spec-built, not live-verified: estimated.
        costConfidence: "estimated",
        userId: "dev@example.com",
        projectId: "futura-team",
        providerCostType: "cursor_spend"
      })
    ]);
  });

  it("resolves only reference-based tokens and rejects plaintext-looking secret references", () => {
    expect(resolveTokenReference("env:OPENAI_ADMIN_KEY", { OPENAI_ADMIN_KEY: fakeToken })).toBe(fakeToken);
    expect(() => resolveTokenReference(fakeToken, {})).toThrow(/must be a local reference/);
    expect(() => resolveTokenReference("env:MISSING_KEY", {})).toThrow(/not set/);
  });

  it("creates verified provider source metadata after a successful connector pull", () => {
    const source = createProviderConnection({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      verifiedRecordCount: 3,
      totalUsd: 42.5
    });

    expect(source).toMatchObject({
      id: "openai-provider-api",
      type: "provider_api",
      provider: "openai",
      verification: "verified",
      fieldsVerified: expect.arrayContaining(["organization costs", "project usage"]),
      authMode: "oauth",
      tokenStorage: "local_reference_only",
      authReference: "env:OPENAI_ADMIN_KEY"
    });
    expect(source.scope).toContain("3 verified records");
    expect(source.scope).toContain("$42.50");
    expect(JSON.stringify(source)).not.toContain(fakeToken);
  });

  it("retries transient 429s (honoring retry-after) and succeeds", async () => {
    let costAttempts = 0;
    const fetcher = async (url: string) => {
      if (url.includes("/organization/costs")) {
        costAttempts += 1;
        if (costAttempts === 1) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "0" },
            json: async () => ({ error: { message: "rate limited" } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ start_time: 1761955200, results: [{ amount: { value: 2, currency: "usd" }, line_item: "Responses API" }] }] })
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };

    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher
    });

    expect(costAttempts).toBe(2);
    expect(result.records).toHaveLength(1);
  });

  it("keeps already-fetched pages with a QA note when pagination fails mid-way", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("/organization/costs") && !url.includes("page=next")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ start_time: 1761955200, results: [{ amount: { value: 2, currency: "usd" }, line_item: "Responses API" }] }], has_more: true, next_page: "next" })
        };
      }
      if (url.includes("page=next")) {
        return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: { message: "page cursor expired" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };

    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher
    });

    // Page 1's verified dollars survive; the failure is reported, not fatal.
    expect(result.records.filter((record) => record.providerCostType === "openai_cost")).toHaveLength(1);
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "OpenAI costs API",
        pagesFetched: 1,
        stoppedBecause: "fetch_error",
        note: expect.stringContaining("Stopped after 1 page")
      })
    ]));
  });

  it("reports zero response drift for legitimate anthropic fields and derives estimated completeness from claude-code records", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("/organizations/cost_report")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ starting_at: "2026-05-01T00:00:00Z", ending_at: "2026-05-02T00:00:00Z", results: [{ amount: "250", currency: "USD", cost_type: "tokens", description: "Output tokens", model: "claude-opus-4-8", workspace_id: "wrk_eng", token_type: "output_tokens" }] }], has_more: false })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ date: "2026-05-01", actor: { email_address: "dev@example.com" }, organization_id: "org_1", core_metrics: { num_sessions: 3, lines_of_code: { added: 10, removed: 2 }, commits_by_claude_code: 1, pull_requests_by_claude_code: 0 }, model_breakdown: [{ model: "claude-sonnet-4-6", tokens: { input: 100, output: 20, cache_read: 5, cache_creation: 2 }, estimated_cost: { currency: "USD", amount: 123 } }] }], has_more: false })
      };
    };

    const result = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher
    });

    expect(result.qa.responseDrift).toEqual([]);
    // Mixed verified (cost report) + estimated (claude code) records: the
    // result-level label is the weakest cost-bearing confidence — estimated.
    expect(result.completeness).toBe("estimated");
    expect(result.source.verification).toBe("estimated");
  });

  it("reports zero response drift for legitimate copilot and cursor fields", async () => {
    const copilotFetcher = async (url: string) => {
      if (url.includes("/copilot/billing/seats")) {
        return { ok: true, status: 200, json: async () => ({ total_seats: 1, plan_type: "business", seats: [{ assignee: { login: "alice" }, last_activity_at: "2026-06-30T00:00:00Z", plan_type: "business" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ day_totals: [{ day: "2026-05-01", totals_by_model_feature: [{ model: "gpt-4.1", feature: "chat" }], totals_by_cli: { token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 25 } } }] }) };
    };
    const copilot = await fetchProviderUsageRecords({
      provider: "github-copilot",
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      org: "futurastudio",
      fetcher: copilotFetcher
    });
    expect(copilot.qa.responseDrift).toEqual([]);

    const cursor = await fetchProviderUsageRecords({
      provider: "cursor",
      sourceId: "cursor-provider-api",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      accountId: "team-acme",
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ users: [{ email: "dev@example.com", spendCents: 345 }] }) })
    });
    expect(cursor.qa.responseDrift).toEqual([]);
    // Cursor is spec-built, not live-verified: never labeled verified.
    expect(cursor.completeness).toBe("estimated");
  });
});
