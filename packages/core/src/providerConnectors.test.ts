import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateCutList } from "./cutList.js";
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
  resolveTokenReference,
  selectProviderFinancialHeadlineRecords
} from "./providerConnectors.js";

const fakeToken = "sk-" + "admin-realistic-fake-token-do-not-store";

function providerFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/providers/${name}`, import.meta.url), "utf8"));
}

function providerFixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/providers/${name}`, import.meta.url), "utf8");
}

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
        usageGranularity: "usage_bucket",
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
        usageGranularity: "daily_aggregate",
        quantity: 8,
        operation: "Claude Code sessions: 8; LOC +420/-90; commits 3; PRs 1"
      })
    ]);
  });

  it("derives GitHub Copilot seat estimates from each official seat plan_type and preserves unknown tiers", () => {
    const records = normalizeGitHubCopilotSeatResponse(
      providerFixtureJson("github-copilot-seats-mixed.json"),
      { sourceId: "github-copilot-provider-api", observedFrom: "GitHub Copilot billing seats API", accountId: "futurastudio" }
    );

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "github-copilot-business-seat",
        userId: "alice",
        amountUsd: 19,
        costConfidence: "estimated",
        projectId: "futurastudio",
        providerCostType: "copilot_seat_reconciliation",
        usageGranularity: "seat",
        operation: "GitHub Copilot business seat; last activity 2026-08-01T12:00:00Z"
      }),
      expect.objectContaining({
        userId: "bob",
        model: "github-copilot-enterprise-seat",
        amountUsd: 39,
        costConfidence: "estimated",
        operation: "GitHub Copilot enterprise seat; last activity 2026-08-01T13:00:00Z"
      }),
      expect.objectContaining({
        userId: "casey",
        model: "github-copilot-unknown-seat",
        amountUsd: null,
        costConfidence: "missing",
        operation: "GitHub Copilot unknown seat; no recent activity reported"
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
        usageGranularity: "billing_bucket",
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

  it("keeps valid OpenAI billed rows but marks malformed cost rows as partial schema drift", async () => {
    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("/organization/costs")
          ? {
              data: [{
                start_time: 1761955200,
                results: [
                  { amount: { value: "2.00", currency: "usd" }, line_item: "valid billed row", project_id: "proj_valid" },
                  { amount: { value: "not-a-number", currency: "usd" }, line_item: "malformed billed row", project_id: "proj_bad" },
                  null
                ]
              }],
              has_more: false
            }
          : { data: [], has_more: false }
      })
    });

    expect(result.records).toEqual([
      expect.objectContaining({
        projectId: "proj_valid",
        amountUsd: 2,
        costConfidence: "verified",
        providerCostType: "openai_cost"
      })
    ]);
    expect(result.financials).toMatchObject({ providerReportedBilledUsd: 2, headlineUsd: 2 });
    expect(result.qa.pagination.every((page) => page.stoppedBecause === "complete")).toBe(true);
    expect(result.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "OpenAI costs API",
        field: "data[0].results[1].amount.value",
        issue: expect.stringContaining("excluded")
      }),
      expect.objectContaining({
        label: "OpenAI costs API",
        field: "data[0].results[2]",
        issue: expect.stringContaining("non-object")
      })
    ]));
    expect(result.qa.coverage).toBe("partial");
    expect(result.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.source.financialEvidence).toBe("detected_unverified");
  });

  it("never claims complete provider coverage for negative or fractional usage schema", async () => {
    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("/organization/costs")
          ? {
              data: [{
                start_time: 1761955200,
                results: [{
                  amount: { value: "2.00", currency: "usd" },
                  line_item: "valid billed row",
                  quantity: -3
                }]
              }],
              has_more: false
            }
          : {
              data: [{
                start_time: 1761955200,
                results: [{
                  input_tokens: 100,
                  output_tokens: -2,
                  input_cached_tokens: 1.5,
                  num_model_requests: -1,
                  model: "gpt-5.1"
                }]
              }],
              has_more: false
            }
      })
    });

    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerCostType: "openai_cost",
        amountUsd: 2,
        quantity: undefined
      }),
      expect.objectContaining({
        providerCostType: "openai_usage_evidence",
        inputTokens: 100,
        outputTokens: 0,
        quantity: undefined
      })
    ]));
    expect(result.records.every((record) =>
      Number.isInteger(record.inputTokens) && record.inputTokens >= 0 &&
      Number.isInteger(record.outputTokens) && record.outputTokens >= 0 &&
      (record.quantity === undefined || record.quantity >= 0)
    )).toBe(true);
    expect(result.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "data[0].results[0].quantity", issue: expect.stringContaining("excluded") }),
      expect.objectContaining({ field: "data[0].results[0].output_tokens", issue: expect.stringContaining("non-negative integer") }),
      expect.objectContaining({ field: "data[0].results[0].input_cached_tokens", issue: expect.stringContaining("non-negative integer") }),
      expect.objectContaining({ field: "data[0].results[0].num_model_requests", issue: expect.stringContaining("non-negative integer") })
    ]));
    expect(result.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.source.financialEvidence).toBe("detected_unverified");
  });

  it("marks malformed Anthropic and Copilot usage quantities incomplete", async () => {
    const anthropic = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("cost_report")
          ? {
              data: [{
                starting_at: "2026-05-01T00:00:00Z",
                results: [{ amount: "250", currency: "USD", cost_type: "tokens" }]
              }],
              has_more: false
            }
          : {
              data: [{
                date: "2026-05-01",
                actor: { id: "dev" },
                core_metrics: { num_sessions: -1 },
                model_breakdown: [{
                  model: "claude-sonnet-4-6",
                  tokens: { input: -100, output: 1.5 },
                  estimated_cost: { amount: 123, currency: "USD" }
                }]
              }],
              has_more: false
            }
      })
    });

    expect(anthropic.coverage).toBe("partial");
    expect(anthropic.completeness).toBe("detected_unverified");
    expect(anthropic.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "data[0].core_metrics.num_sessions" }),
      expect.objectContaining({ field: "data[0].model_breakdown[0].tokens.input" }),
      expect.objectContaining({ field: "data[0].model_breakdown[0].tokens.output" })
    ]));
    expect(anthropic.records.find((record) => record.providerCostType === "anthropic_claude_code_usage")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      quantity: 0
    });

    const copilotReport = JSON.stringify({
      day_totals: [{
        day: "2026-08-01",
        daily_active_users: 1,
        totals_by_model_feature: [],
        totals_by_cli: {
          request_count: -1,
          prompt_count: 1,
          session_count: 1,
          token_usage: { prompt_tokens_sum: -100, output_tokens_sum: 2.5, avg_tokens_per_request: 0 }
        }
      }]
    });
    const copilot = await fetchProviderUsageRecords({
      provider: "github-copilot",
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      enterprise: "futura",
      fetcher: async (url) => url.includes("api.github.com")
        ? { ok: true, status: 200, json: async () => ({ download_links: ["https://reports.example.com/copilot/invalid.ndjson"] }) }
        : { ok: true, status: 200, json: async () => ({}), text: async () => copilotReport }
    });

    expect(copilot.coverage).toBe("partial");
    expect(copilot.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "day_totals[0].totals_by_cli.request_count" }),
      expect.objectContaining({ field: "day_totals[0].totals_by_cli.token_usage.prompt_tokens_sum" }),
      expect.objectContaining({ field: "day_totals[0].totals_by_cli.token_usage.output_tokens_sum" })
    ]));
    expect(copilot.records).toEqual([
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 })
    ]);
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

  it("strips terminal controls from provider errors without weakening exact credential redaction", async () => {
    const opaqueToken = "opaque.ArbitraryCredential-control-test";
    const splitToken = `${opaqueToken.slice(0, 10)}\u001b[31m${opaqueToken.slice(10)}`;
    const failure = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      fetcher: async () => ({
        ok: false,
        status: 403,
        statusText: `Forbidden\u001b[2J\rFORGED ${splitToken}`,
        json: async () => ({
          message: `denied \u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\n${splitToken}`
        })
      })
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(opaqueToken);
    expect(message).not.toContain("evil.example");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u0007");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\r");
  });

  it("exact-redacts raw and Cursor-derived credentials from errors and returned QA", async () => {
    const opaqueToken = "opaque.ArbitraryCredential-7zQ9-no-known-prefix?";
    const cursorBasicPayload = Buffer.from(`${opaqueToken}:`).toString("base64");
    const cursorUnpaddedPayload = cursorBasicPayload.replace(/=+$/g, "");
    const cursorBase64UrlPayload = cursorUnpaddedPayload.replace(/\+/g, "-").replace(/\//g, "_");
    const cursorAuthorization = `Basic ${cursorBasicPayload}`;
    const encodedCursorAuthorization = encodeURIComponent(cursorAuthorization);
    const providerFailure = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      fetcher: async () => ({
        ok: false,
        status: 403,
        statusText: `Forbidden ${opaqueToken}`,
        json: async () => ({ message: `provider echoed bare credential ${opaqueToken}` })
      })
    }).catch((error: unknown) => error);

    const transportFailure = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      fetcher: async () => {
        throw new Error(`transport echoed bare credential ${opaqueToken}`);
      }
    }).catch((error: unknown) => error);

    const cursorFailure = await fetchProviderUsageRecords({
      provider: "cursor",
      sourceId: "cursor-provider-api",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      accountId: "team-acme",
      fetcher: async (_url, init) => {
        const authorization = init?.headers?.Authorization ?? "";
        throw new Error(`transport echoed ${authorization}; payload ${cursorBasicPayload}; unpadded ${cursorUnpaddedPayload}; base64url ${cursorBase64UrlPayload}; encoded ${encodeURIComponent(authorization)}`);
      }
    }).catch((error: unknown) => error);

    for (const failure of [providerFailure, transportFailure, cursorFailure]) {
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).not.toContain(opaqueToken);
      expect(message).not.toContain(cursorBasicPayload);
      expect(message).not.toContain(cursorUnpaddedPayload);
      expect(message).not.toContain(cursorBase64UrlPayload);
      expect(message).not.toContain(cursorAuthorization);
      expect(message).not.toContain(encodedCursorAuthorization);
      expect(message).toContain("[REDACTED]");
    }

    const partialResult = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      fetcher: async (url) => {
        if (url.includes("/organization/costs") && !url.includes("page=second")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [], has_more: true, next_page: "second" })
          };
        }
        if (url.includes("/organization/costs")) {
          return {
            ok: false,
            status: 403,
            statusText: "Forbidden",
            json: async () => ({ message: `partial-page error echoed ${opaqueToken}` })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [], has_more: false })
        };
      }
    });

    expect(JSON.stringify(partialResult)).not.toContain(opaqueToken);
    expect(partialResult.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stoppedBecause: "fetch_error",
        note: expect.stringContaining("[REDACTED]")
      })
    ]));

    let cursorPage = 0;
    const cursorPartialResult = await fetchProviderUsageRecords({
      provider: "cursor",
      sourceId: "cursor-provider-api",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => opaqueToken,
      startTime: 1761955200,
      accountId: "team-acme",
      fetcher: async (_url, init) => {
        cursorPage += 1;
        if (cursorPage === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              teamMemberSpend: [{ email: "developer@example.com", spendCents: 250 }],
              subscriptionCycleStart: 1761955200000,
              totalMembers: 2,
              totalPages: 2
            })
          };
        }
        const authorization = init?.headers?.Authorization ?? "";
        throw new Error(`page two echoed ${authorization}; payload ${cursorBasicPayload}; unpadded ${cursorUnpaddedPayload}; base64url ${cursorBase64UrlPayload}; encoded ${encodeURIComponent(authorization)}`);
      }
    });

    const serializedCursorResult = JSON.stringify(cursorPartialResult);
    expect(cursorPartialResult.records).toEqual([
      expect.objectContaining({ userId: "developer@example.com", amountUsd: 2.5, costConfidence: "estimated" })
    ]);
    expect(cursorPartialResult.coverage).toBe("partial");
    expect(serializedCursorResult).not.toContain(opaqueToken);
    expect(serializedCursorResult).not.toContain(cursorBasicPayload);
    expect(serializedCursorResult).not.toContain(cursorUnpaddedPayload);
    expect(serializedCursorResult).not.toContain(cursorBase64UrlPayload);
    expect(serializedCursorResult).not.toContain(cursorAuthorization);
    expect(serializedCursorResult).not.toContain(encodedCursorAuthorization);
    expect(cursorPartialResult.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ stoppedBecause: "fetch_error", note: expect.stringContaining("[REDACTED]") })
    ]));
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
    })).rejects.toThrow(/missing canonical teamMemberSpend/);
  });

  it("fetches OpenAI costs grouped by project, api key, and line item without returning the raw token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => url.includes("/usage/completions") ? ({
          data: [{
            start_time: 1761955200,
            start_time_iso: "2025-11-01T00:00:00Z",
            end_time_iso: "2025-11-02T00:00:00Z",
            results: [{
              input_tokens: 100,
              input_uncached_tokens: 80,
              input_cache_write_tokens: 5,
              input_cached_text_tokens: 15,
              output_tokens: 25,
              output_text_tokens: 25,
              project_id: "proj_usage",
              user_id: "user_123",
              api_key_id: "key_123",
              model: "gpt-5.1",
              batch: false,
              service_tier: "default"
            }]
          }]
        }) : ({
          data: [{
            start_time: 1761955200,
            start_time_iso: "2025-11-01T00:00:00Z",
            end_time_iso: "2025-11-02T00:00:00Z",
            results: [{
              amount: { value: 4.2, currency: "usd" },
              line_item: "Responses API",
              organization_id: "org_123",
              organization_name: "Example",
              project_name: "Usage",
              user_id: "user_123",
              user_email: "dev@example.com",
              api_key_id: "key_123"
            }]
          }]
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
    expect(result.source).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      provider: "openai",
      authReference: "env:OPENAI_ADMIN_KEY"
    });
    expect(result.qa.responseDrift).toEqual([]);
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
        usageGranularity: "billing_bucket",
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

  it("keeps valid Anthropic billed rows but marks malformed cost rows as partial schema drift", async () => {
    const result = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_API_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("/organizations/cost_report")
          ? {
              data: [{
                starting_at: "2026-05-01T00:00:00Z",
                results: [
                  { amount: "250", currency: "USD", model: "claude-opus", workspace_id: "wrk_valid", cost_type: "tokens" },
                  { amount: "not-a-number", currency: "USD", model: "claude-sonnet", workspace_id: "wrk_bad", cost_type: "tokens" },
                  { amount: "100", currency: 840, model: "claude-haiku", workspace_id: "wrk_bad_currency", cost_type: "tokens" }
                ]
              }],
              has_more: false
            }
          : { data: [], has_more: false }
      })
    });

    expect(result.records).toEqual([
      expect.objectContaining({
        workspaceId: "wrk_valid",
        amountUsd: 2.5,
        costConfidence: "verified",
        providerCostType: "tokens"
      })
    ]);
    expect(result.financials).toMatchObject({ providerReportedBilledUsd: 2.5, headlineUsd: 2.5 });
    expect(result.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Anthropic Admin cost report",
        field: "data[0].results[1].amount",
        issue: expect.stringContaining("excluded")
      }),
      expect.objectContaining({
        label: "Anthropic Admin cost report",
        field: "data[0].results[2].currency",
        issue: expect.stringContaining("unsupported currency")
      })
    ]));
    expect(result.qa.coverage).toBe("partial");
    expect(result.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.source.financialEvidence).toBe("detected_unverified");
  });

  it("keeps explicit zero provider costs verified and complete", async () => {
    const result = await fetchProviderUsageRecords({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        json: async () => url.includes("/organization/costs")
          ? { data: [{ start_time: 1761955200, results: [{ amount: { value: "0", currency: "usd" }, line_item: "zero billed row" }] }], has_more: false }
          : { data: [], has_more: false }
      })
    });

    expect(result.records).toEqual([
      expect.objectContaining({ amountUsd: 0, costConfidence: "verified", providerCostType: "openai_cost" })
    ]);
    expect(result.qa.responseDrift).toEqual([]);
    expect(result.coverage).toBe("complete");
    expect(result.completeness).toBe("verified");
    expect(result.financials.headlineUsd).toBe(0);
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
        usageGranularity: "daily_aggregate",
        projectId: "futurastudio"
      }),
      expect.objectContaining({
        model: "github-copilot-cli",
        inputTokens: 1000,
        outputTokens: 250,
        providerCostType: "copilot_cli_metrics",
        usageGranularity: "daily_aggregate"
      })
    ]));
  });

  it("fetches every signed GitHub Copilot NDJSON report with the current API version and no credential forwarding", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const manifest = providerFixtureJson("github-copilot-metrics-manifest.json");
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      if (url.includes("/copilot/metrics/reports/organization-28-day/latest")) {
        return { ok: true, status: 200, headers: { "x-ratelimit-remaining": "4999" }, json: async () => manifest };
      }
      if (url.includes("reports.example.com/copilot/part-1.ndjson")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => providerFixtureText("github-copilot-metrics-part-1.ndjson") };
      }
      if (url.includes("reports.example.com/copilot/part-2.ndjson")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => providerFixtureText("github-copilot-metrics-part-2.ndjson") };
      }
      if (url.includes("/copilot/billing/seats") && !url.includes("page=2")) {
        return {
          ok: true,
          status: 200,
          headers: {
            link: '<https://api.github.com/orgs/futurastudio/copilot/billing/seats?per_page=100&page=2>; rel="next"',
            "x-ratelimit-remaining": "4999"
          },
          json: async () => ({ total_seats: 2, seats: [{ assignee: { login: "alice" }, plan_type: "business" }] })
        };
      }
      if (url.includes("/copilot/billing/seats") && url.includes("page=2")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_seats: 2, seats: [{ assignee: { login: "bob" }, plan_type: "enterprise" }] })
        };
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
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
    expect(calls[0].headers["X-GitHub-Api-Version"]).toBe("2026-03-10");
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([
      expect.stringContaining("reports.example.com/copilot/part-1.ndjson"),
      expect.stringContaining("reports.example.com/copilot/part-2.ndjson"),
      expect.stringContaining("/copilot/billing/seats?per_page=100"),
      expect.stringContaining("page=2")
    ]));
    expect(calls[0].headers.Authorization).toBe(`Bearer ${fakeToken}`);
    expect(calls.filter((call) => call.url.includes("reports.example.com")).every((call) => call.headers.Authorization === undefined)).toBe(true);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "gpt-5", providerCostType: "copilot_usage_metrics" }),
      expect.objectContaining({ model: "claude-sonnet-4.5", providerCostType: "copilot_usage_metrics" }),
      expect.objectContaining({ userId: "alice", providerCostType: "copilot_seat_reconciliation" }),
      expect.objectContaining({ userId: "bob", amountUsd: 39, providerCostType: "copilot_seat_reconciliation" })
    ]));
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot metrics reports", pagesFetched: 2, stoppedBecause: "complete" }),
      expect.objectContaining({ label: "GitHub Copilot seats", pagesFetched: 2, stoppedBecause: "complete", limitPerPage: 100 })
    ]));
    expect(result.qa.rateLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot seats", remainingRequests: 4999 })
    ]));
    // Seat dollars are estimated (plan-price reconciliation), so the result
    // and source labels must say estimated — never "verified" over estimates.
    expect(result.completeness).toBe("estimated");
    expect(result.coverage).toBe("complete");
    expect(result.source).toMatchObject({
      provider: "github-copilot",
      validationCoverage: "fixture_verified",
      financialEvidence: "estimated"
    });
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("rejects cross-origin pagination links before forwarding provider authorization", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, authorization: init?.headers?.Authorization });
      if (url.includes("/copilot/metrics/reports/")) {
        return { ok: true, status: 200, json: async () => ({ download_links: ["https://reports.example.com/copilot/metrics.ndjson"], report_start_day: "2026-07-05", report_end_day: "2026-08-01" }) };
      }
      if (url.includes("reports.example.com/copilot/metrics.ndjson")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => providerFixtureText("github-copilot-metrics-part-1.ndjson") };
      }
      if (url.includes("/copilot/billing/seats")) {
        return {
          ok: true,
          status: 200,
          headers: { link: '<https://evil.example/steal>; rel="next"' },
          json: async () => ({ total_seats: 1, seats: [{ assignee: { login: "alice" }, plan_type: "business" }] })
        };
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
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

    expect(calls.some((call) => call.url.startsWith("https://evil.example"))).toBe(false);
    expect(result.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot seats", stoppedBecause: "unsafe_next_link" })
    ]));
    expect(result.qa.responseDrift).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "headers.link", issue: expect.stringContaining("same-origin") })
    ]));
  });

  it("rejects missing, unsafe, or malformed Copilot report downloads instead of silently returning zero", async () => {
    const base = {
      provider: "github-copilot" as const,
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      enterprise: "futura"
    };

    await expect(fetchProviderUsageRecords({
      ...base,
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ report_start_day: "2026-07-05", report_end_day: "2026-08-01" }) })
    })).rejects.toThrow(/no signed NDJSON download_links/);

    const unsafeCalls: string[] = [];
    await expect(fetchProviderUsageRecords({
      ...base,
      fetcher: async (url) => {
        unsafeCalls.push(url);
        return { ok: true, status: 200, json: async () => ({ download_links: ["http://127.0.0.1/private.ndjson"] }) };
      }
    })).rejects.toThrow(/unsafe signed download URL/);
    expect(unsafeCalls).toHaveLength(1);

    await expect(fetchProviderUsageRecords({
      ...base,
      fetcher: async (url) => url.includes("api.github.com")
        ? { ok: true, status: 200, json: async () => ({ download_links: ["https://reports.example.com/copilot/bad.ndjson"] }) }
        : { ok: true, status: 200, json: async () => ({}), text: async () => `{not-json-${fakeToken}}` }
    })).rejects.toThrow(/malformed NDJSON at line 1/);
  });

  it("marks Copilot seat coverage partial when total_seats exceeds returned pages", async () => {
    const result = await fetchProviderUsageRecords({
      provider: "github-copilot",
      sourceId: "github-copilot-provider-api",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      org: "futurastudio",
      fetcher: async (url) => {
        if (url.includes("/copilot/metrics/reports/")) {
          return { ok: true, status: 200, json: async () => ({ download_links: ["https://reports.example.com/copilot/metrics.ndjson"] }) };
        }
        if (url.includes("reports.example.com")) {
          return { ok: true, status: 200, json: async () => ({}), text: async () => providerFixtureText("github-copilot-metrics-part-1.ndjson") };
        }
        return { ok: true, status: 200, json: async () => ({ total_seats: 2, seats: [{ assignee: { login: "alice" }, plan_type: "business" }] }) };
      }
    });

    expect(result.coverage).toBe("partial");
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "GitHub Copilot seats", stoppedBecause: "missing_cursor", note: expect.stringContaining("reported 2 seats") })
    ]));
  });

  it("normalizes Cursor Admin API spend when a real team API path is available", () => {
    const records = normalizeCursorSpendResponse(
      providerFixtureJson("cursor-spend-page-1.json"),
      { sourceId: "cursor-provider-api", observedFrom: "Cursor Admin API", accountId: "futura-team" }
    );

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: "cursor-team-usage",
        // Cursor connector is spec-built, not live-verified: estimated.
        costConfidence: "estimated",
        userId: "developer@example.com",
        projectId: "futura-team",
        providerCostType: "cursor_spend"
      })
    ]));
    expect(records.find((record) => record.userId === "developer@example.com")?.amountUsd).toBeCloseTo(24.50125487, 8);
  });

  it("fetches every canonical Cursor spend page and proves member completeness", async () => {
    const member = (index: number) => ({ email: `developer-${index}@example.com`, spendCents: 100 + index });
    const pageOne = { teamMemberSpend: Array.from({ length: 100 }, (_, index) => member(index)), subscriptionCycleStart: 1785542400000, totalMembers: 101, totalPages: 2 };
    const pageTwo = { teamMemberSpend: [member(100)], subscriptionCycleStart: 1785542400000, totalMembers: 101, totalPages: 2 };
    const calls: Array<{ authorization?: string; body?: string }> = [];
    const result = await fetchProviderUsageRecords({
      provider: "cursor",
      sourceId: "cursor-provider-api",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      accountId: "team-acme",
      fetcher: async (_url, init) => {
        calls.push({ authorization: init?.headers?.Authorization, body: init?.body });
        const requestedPage = JSON.parse(init?.body ?? "{}").page;
        return { ok: true, status: 200, json: async () => requestedPage === 1 ? pageOne : pageTwo };
      }
    });

    expect(calls.map((call) => JSON.parse(call.body ?? "{}"))).toEqual([
      { page: 1, pageSize: 100 },
      { page: 2, pageSize: 100 }
    ]);
    expect(calls.every((call) => call.authorization?.startsWith("Basic "))).toBe(true);
    expect(result.records).toHaveLength(101);
    expect(result.coverage).toBe("complete");
    expect(result.qa.pagination).toEqual([
      expect.objectContaining({ label: "Cursor Admin API spend", pagesFetched: 2, stoppedBecause: "complete", limitPerPage: 100 })
    ]);
    expect(JSON.stringify(result)).not.toContain(fakeToken);
  });

  it("does not claim complete Cursor coverage when pagination metadata is malformed or changes", async () => {
    await expect(fetchProviderUsageRecords({
      provider: "cursor",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ teamMemberSpend: [], totalMembers: 0 }) })
    })).rejects.toThrow(/invalid or missing totalPages/);

    await expect(fetchProviderUsageRecords({
      provider: "cursor",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          teamMemberSpend: [{ email: "one@example.com", spendCents: 100, fastPremiumRequests: -1 }],
          totalMembers: 1,
          totalPages: 1
        })
      })
    })).rejects.toThrow(/invalid fastPremiumRequests quantity/);

    const first = { teamMemberSpend: [{ email: "one@example.com", spendCents: 100 }], totalMembers: 2, totalPages: 2 };
    const second = { teamMemberSpend: [{ email: "two@example.com", spendCents: 100 }], totalMembers: 2, totalPages: 3 };
    const result = await fetchProviderUsageRecords({
      provider: "cursor",
      authReference: "env:CURSOR_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime: 1761955200,
      fetcher: async (_url, init) => ({ ok: true, status: 200, json: async () => JSON.parse(init?.body ?? "{}").page === 1 ? first : second })
    });
    expect(result.coverage).toBe("partial");
    expect(result.qa.pagination[0]).toMatchObject({ stoppedBecause: "fetch_error", note: expect.stringContaining("pagination metadata changed") });
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
      boundaryApproval: "approved",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      fieldsVerified: expect.arrayContaining(["organization costs", "project usage"]),
      authMode: "oauth",
      tokenStorage: "local_reference_only",
      authReference: "env:OPENAI_ADMIN_KEY"
    });
    expect(source.scope).toContain("3 record(s); financial evidence: verified");
    expect(source.scope).toContain("$42.50");
    expect(JSON.stringify(source)).not.toContain(fakeToken);
  });

  it("keeps an unavailable provider headline missing instead of inventing $0.00", () => {
    const source = createProviderConnection({
      provider: "openai",
      sourceId: "openai-provider-api",
      authReference: "env:OPENAI_ADMIN_KEY",
      verifiedRecordCount: 0,
      totalUsd: null,
      completeness: "missing"
    });

    expect(source.financialEvidence).toBe("missing");
    expect(source.scope).toContain("an unavailable financial headline");
    expect(source.scope).not.toContain("$0.00");
  });

  it("labels a positive sub-cent provider headline without rounding it to zero", () => {
    const source = createProviderConnection({
      provider: "openai",
      authReference: "env:OPENAI_ADMIN_KEY",
      verifiedRecordCount: 1,
      totalUsd: 0.004,
      completeness: "verified"
    });

    expect(source.scope).toContain("less than $0.01");
    expect(source.scope).not.toContain("$0.00");
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
    expect(result.coverage).toBe("partial");
    expect(result.qa.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.financials).toMatchObject({
      providerReportedBilledUsd: 2,
      headlineUsd: 2,
      headlineBasis: "provider_reported_billed_cost"
    });
  });

  it("keeps official Anthropic billing separate from Claude Code API-equivalent estimates", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("/organizations/cost_report")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ starting_at: "2026-05-01T00:00:00Z", ending_at: "2026-05-02T00:00:00Z", results: [{ amount: "250", currency: "USD", cost_type: "tokens", description: "Output tokens", model: "claude-opus-4-8", workspace_id: "wrk_eng", token_type: "output_tokens", inference_geo: "us" }] }], has_more: false })
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
    expect(result.coverage).toBe("complete");
    expect(result.completeness).toBe("verified");
    expect(result.source.financialEvidence).toBe("verified");
    expect(result.financials).toEqual({
      providerReportedBilledUsd: 2.5,
      apiEquivalentEstimatedUsd: 1.23,
      providerEstimatedUsd: null,
      headlineUsd: 2.5,
      headlineBasis: "provider_reported_billed_cost"
    });
    expect(selectProviderFinancialHeadlineRecords(result.records)).toEqual([
      expect.objectContaining({ amountUsd: 2.5, costConfidence: "verified" })
    ]);
  });

  it("marks Anthropic coverage partial when a requested date range exceeds the connector cap", async () => {
    const startTime = 1_761_955_200;
    const fetcher = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("cost_report")
        ? {
            data: [{
              starting_at: new Date(startTime * 1000).toISOString(),
              results: [{ amount: "100", currency: "USD", cost_type: "tokens" }]
            }],
            has_more: false
          }
        : { data: [], has_more: false }
    });

    const result = await fetchProviderUsageRecords({
      provider: "anthropic",
      sourceId: "anthropic-provider-api",
      authReference: "env:ANTHROPIC_ADMIN_KEY",
      tokenResolver: () => fakeToken,
      startTime,
      endTime: startTime + 371 * 24 * 60 * 60,
      fetcher
    });

    expect(result.coverage).toBe("partial");
    expect(result.completeness).toBe("detected_unverified");
    expect(result.financials.headlineUsd).toBe(1);
    expect(result.qa.pagination).toEqual(expect.arrayContaining([
      expect.objectContaining({ stoppedBecause: "max_range_days", note: expect.stringContaining("370-day") })
    ]));
  });

  it("reports zero response drift for legitimate copilot and cursor fields", async () => {
    const copilotFetcher = async (url: string) => {
      if (url.includes("/copilot/metrics/reports/")) {
        return { ok: true, status: 200, json: async () => ({ download_links: ["https://reports.example.com/copilot/metrics.ndjson"], report_start_day: "2026-07-05", report_end_day: "2026-08-01" }) };
      }
      if (url.includes("reports.example.com/copilot/metrics.ndjson")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => providerFixtureText("github-copilot-metrics-part-1.ndjson") };
      }
      if (url.includes("/copilot/billing/seats")) {
        return { ok: true, status: 200, json: async () => ({ total_seats: 1, seats: [{ assignee: { login: "alice" }, last_activity_at: "2026-06-30T00:00:00Z", plan_type: "business" }] }) };
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
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
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ teamMemberSpend: [{ email: "dev@example.com", spendCents: 345 }], subscriptionCycleStart: 1785542400000, totalMembers: 1, totalPages: 1 }) })
    });
    expect(cursor.qa.responseDrift).toEqual([]);
    // Cursor is spec-built, not live-verified: never labeled verified.
    expect(cursor.completeness).toBe("estimated");
    expect(cursor.records[0]).toMatchObject({ usageGranularity: "user_aggregate" });
  });

  it("keeps real adapter aggregate shapes out of call-level cut modeling", () => {
    const options = { sourceId: "provider", observedFrom: "provider API", accountId: "org" };
    const records = [
      ...normalizeOpenAiCostResponse({ data: [{ start_time: 1761955200, results: [{ amount: { value: 40, currency: "usd" }, line_item: "gpt-5.5 input tokens" }] }] }, options),
      ...normalizeOpenAiUsageResponse({ data: [{ start_time: 1761955200, results: [{ input_tokens: 200_000, output_tokens: 1_000, num_model_requests: 20, model: "gpt-5.5" }] }] }, options),
      ...normalizeAnthropicCostResponse({ data: [{ starting_at: "2026-05-01T00:00:00Z", results: [{ amount: "4000", currency: "USD", cost_type: "tokens", description: "research_summary", model: "claude-fable-5" }] }] }, options),
      ...normalizeAnthropicClaudeCodeUsageResponse({ data: [{ date: "2026-05-01", actor: { id: "dev" }, core_metrics: { num_sessions: 3 }, model_breakdown: [{ model: "claude-fable-5", tokens: { input: 200_000, output: 1_000 }, estimated_cost: { amount: 4000, currency: "USD" } }] }] }, options),
      ...normalizeGitHubCopilotSeatResponse({ seats: [{ assignee: { login: "dev" }, plan_type: "business" }] }, options),
      ...normalizeCursorSpendResponse({ teamMemberSpend: [{ email: "dev@example.com", spendCents: 4_000 }], totalPages: 1, totalMembers: 1 }, options)
    ];

    expect(new Set(records.map((record) => record.usageGranularity))).toEqual(new Set([
      "billing_bucket",
      "usage_bucket",
      "daily_aggregate",
      "seat",
      "user_aggregate"
    ]));
    expect(generateCutList(records)).toEqual([]);
  });
});
