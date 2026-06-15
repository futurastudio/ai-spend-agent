import type { ApprovedSource } from "./sourceRegistry.js";
import { createProviderConnectorStub, slugifySourceId } from "./sourceRegistry.js";
import type { UsageRecord } from "./schema.js";

type ProviderResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string | undefined> | { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

export type ProviderQaPagination = {
  label: string;
  pagesFetched: number;
  stoppedBecause: "complete" | "missing_cursor" | "max_pages";
  maxPages: number;
  limitPerPage?: number;
};

export type ProviderQaRateLimit = {
  label: string;
  remainingRequests?: number;
  retryAfterSeconds?: number;
};

export type ProviderQaDriftIssue = {
  label: string;
  field: string;
  issue: string;
};

export type ProviderQaSummary = {
  provider: string;
  requestedEndpoints: string[];
  pagination: ProviderQaPagination[];
  rateLimits: ProviderQaRateLimit[];
  responseDrift: ProviderQaDriftIssue[];
  instructions: string[];
};

type FetchPagesResult = {
  pages: unknown[];
  pagination: ProviderQaPagination;
  rateLimits: ProviderQaRateLimit[];
  responseDrift: ProviderQaDriftIssue[];
};

export type ProviderId = "openai" | "anthropic" | "github-copilot" | "cursor" | string;

export type ProviderConnectorInput = {
  provider: ProviderId;
  sourceId?: string;
  authReference: string;
  startTime: number;
  endTime?: number;
  org?: string;
  enterprise?: string;
  accountId?: string;
  fetcher?: Fetcher;
  tokenResolver?: TokenResolver;
};

export type ProviderConnectorResult = {
  provider: string;
  source: ApprovedSource;
  records: UsageRecord[];
  fetchedAt: string;
  completeness: "verified" | "estimated" | "detected_unverified" | "missing";
  qa: ProviderQaSummary;
};

export type CreateProviderConnectionInput = {
  provider: ProviderId;
  sourceId?: string;
  authReference: string;
  verifiedRecordCount: number;
  totalUsd: number;
  fetchedAt?: Date;
};

export type TokenResolver = (reference: string) => string;

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<ProviderResponse>;

type OpenAiCostBucket = {
  start_time?: number;
  end_time?: number;
  results?: Array<{
    amount?: { value?: number | string; currency?: string };
    line_item?: string | null;
    project_id?: string | null;
    api_key_id?: string | null;
    quantity?: number | null;
  }>;
};

type AnthropicCostBucket = {
  starting_at?: string;
  ending_at?: string;
  results?: Array<{
    amount?: string | number;
    currency?: string;
    cost_type?: string | null;
    description?: string | null;
    model?: string | null;
    workspace_id?: string | null;
    token_type?: string | null;
  }>;
};

type OpenAiUsageBucket = {
  start_time?: number;
  end_time?: number;
  results?: Array<{
    object?: string;
    input_tokens?: number;
    output_tokens?: number;
    input_cached_tokens?: number;
    input_audio_tokens?: number;
    output_audio_tokens?: number;
    num_model_requests?: number;
    project_id?: string | null;
    user_id?: string | null;
    api_key_id?: string | null;
    model?: string | null;
  }>;
};

type NormalizerOptions = { sourceId: string; observedFrom: string; accountId?: string };

export function normalizeOpenAiCostResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data as OpenAiCostBucket[] : [];
  const records: UsageRecord[] = [];

  for (const bucket of data) {
    const startTime = typeof bucket.start_time === "number" ? bucket.start_time : 0;
    const timestamp = new Date(startTime * 1000).toISOString();
    for (const result of bucket.results ?? []) {
      // The live API returns amount.value as a decimal STRING (dollars);
      // accept both string and number.
      const amountUsd = result.amount?.currency?.toLowerCase() === "usd" || !result.amount?.currency
        ? parseDollarUsd(result.amount?.value)
        : undefined;
      if (typeof amountUsd !== "number") continue;
      const lineItem = result.line_item ?? "OpenAI organization costs";
      const projectId = result.project_id ?? undefined;
      const apiKeyId = result.api_key_id ?? undefined;
      records.push({
        id: slugifySourceId(["openai-costs", String(startTime), projectId, apiKeyId, lineItem].filter(Boolean).join("-")),
        timestamp,
        source: {
          id: options.sourceId,
          name: "OpenAI organization costs API",
          provider: "openai",
          confidence: "verified",
          observedFrom: options.observedFrom
        },
        model: lineItem,
        inputTokens: 0,
        outputTokens: 0,
        amountUsd,
        costConfidence: "verified",
        projectId,
        apiKeyId,
        providerCostType: "openai_cost",
        quantity: typeof result.quantity === "number" ? result.quantity : undefined,
        operation: lineItem
      });
    }
  }

  return records;
}

export function normalizeOpenAiUsageResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data as OpenAiUsageBucket[] : [];
  const records: UsageRecord[] = [];

  for (const bucket of data) {
    const startTime = typeof bucket.start_time === "number" ? bucket.start_time : 0;
    const timestamp = new Date(startTime * 1000).toISOString();
    for (const result of bucket.results ?? []) {
      const projectId = result.project_id ?? undefined;
      const userId = result.user_id ?? undefined;
      const apiKeyId = result.api_key_id ?? undefined;
      const model = result.model ?? "openai-usage";
      const inputTokens = numberValue(result.input_tokens) ?? 0;
      const outputTokens = numberValue(result.output_tokens) ?? 0;
      const cachedTokens = numberValue(result.input_cached_tokens) ?? 0;
      const audioInputTokens = numberValue(result.input_audio_tokens) ?? 0;
      const audioOutputTokens = numberValue(result.output_audio_tokens) ?? 0;
      const requestCount = numberValue(result.num_model_requests);
      if (inputTokens + outputTokens + audioInputTokens + audioOutputTokens === 0 && typeof requestCount !== "number") continue;
      records.push({
        id: slugifySourceId(["openai-usage", String(startTime), projectId, userId, apiKeyId, model].filter(Boolean).join("-")),
        timestamp,
        source: { id: options.sourceId, name: "OpenAI organization usage API", provider: "openai", confidence: "verified", observedFrom: options.observedFrom },
        model,
        inputTokens: inputTokens + audioInputTokens,
        outputTokens: outputTokens + audioOutputTokens,
        amountUsd: null,
        costConfidence: "missing",
        projectId,
        userId,
        apiKeyId,
        providerCostType: "openai_usage_evidence",
        quantity: numberValue(result.num_model_requests),
        operation: "OpenAI completions usage evidence"
      });
    }
  }

  return records;
}

export function normalizeAnthropicClaudeCodeUsageResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const rows = extractArray(response, "data");
  const records: UsageRecord[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const date = stringValue(row.date) ?? new Date(0).toISOString().slice(0, 10);
    const actor = isRecord(row.actor) ? row.actor : {};
    const userId = stringValue(actor.email_address) ?? stringValue(actor.api_key_name) ?? stringValue(actor.id) ?? "unknown-claude-code-actor";
    const core = isRecord(row.core_metrics) ? row.core_metrics : {};
    const lines = isRecord(core.lines_of_code) ? core.lines_of_code : {};
    const sessions = numberValue(core.num_sessions) ?? 0;
    const added = numberValue(lines.added) ?? 0;
    const removed = numberValue(lines.removed) ?? 0;
    const commits = numberValue(core.commits_by_claude_code) ?? 0;
    const prs = numberValue(core.pull_requests_by_claude_code) ?? 0;
    const organizationId = stringValue(row.organization_id) ?? options.accountId;
    const modelBreakdown = Array.isArray(row.model_breakdown) ? row.model_breakdown : [];
    for (const item of modelBreakdown) {
      if (!isRecord(item)) continue;
      const model = stringValue(item.model) ?? "claude-code";
      const tokens = isRecord(item.tokens) ? item.tokens : {};
      const cost = isRecord(item.estimated_cost) ? item.estimated_cost : {};
      const currency = stringValue(cost.currency)?.toLowerCase() ?? "usd";
      const amountUsd = currency === "usd" ? parseMinorUsd(cost.amount) : undefined;
      if (typeof amountUsd !== "number") continue;
      records.push({
        id: slugifySourceId(["anthropic-claude-code", date, userId, model].filter(Boolean).join("-")),
        timestamp: new Date(`${date}T00:00:00Z`).toISOString(),
        source: { id: options.sourceId, name: "Anthropic Claude Code Usage Report", provider: "anthropic", confidence: "estimated", observedFrom: options.observedFrom },
        model,
        inputTokens: (numberValue(tokens.input) ?? 0) + (numberValue(tokens.cache_read) ?? 0) + (numberValue(tokens.cache_creation) ?? 0),
        outputTokens: numberValue(tokens.output) ?? 0,
        amountUsd,
        costConfidence: "estimated",
        userId,
        projectId: organizationId,
        providerCostType: "anthropic_claude_code_usage",
        quantity: sessions,
        operation: `Claude Code sessions: ${sessions}; LOC +${added}/-${removed}; commits ${commits}; PRs ${prs}`
      });
    }
  }
  return records;
}

export function normalizeGitHubCopilotSeatResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const seats = extractArray(response, "seats");
  const plan = stringValue(isRecord(response) ? response.plan_type : undefined) ?? "business";
  const seatUsd = plan === "enterprise" ? 39 : 19;
  const timestamp = new Date().toISOString();
  return seats.flatMap((seat) => {
    if (!isRecord(seat)) return [];
    const assignee = isRecord(seat.assignee) ? seat.assignee : {};
    const userId = stringValue(assignee.login) ?? stringValue(assignee.email) ?? stringValue(seat.login) ?? stringValue(seat.id);
    if (!userId) return [];
    const lastActivity = stringValue(seat.last_activity_at);
    return [{
      id: slugifySourceId(["github-copilot-seat", options.accountId, userId, plan].filter(Boolean).join("-")),
      timestamp,
      source: { id: options.sourceId, name: "GitHub Copilot billing seats API", provider: "github-copilot", confidence: "estimated", observedFrom: options.observedFrom },
      model: `github-copilot-${plan}-seat`,
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: seatUsd,
      costConfidence: "estimated" as const,
      userId,
      projectId: options.accountId,
      providerCostType: "copilot_seat_reconciliation",
      quantity: 1,
      operation: `GitHub Copilot ${plan} seat; ${lastActivity ? `last activity ${lastActivity}` : "no recent activity reported"}`
    }];
  });
}

export function normalizeAnthropicCostResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data as AnthropicCostBucket[] : [];
  const records: UsageRecord[] = [];

  for (const bucket of data) {
    const timestamp = bucket.starting_at ?? new Date(0).toISOString();
    for (const result of bucket.results ?? []) {
      const currency = result.currency?.toLowerCase() ?? "usd";
      if (currency !== "usd") continue;
      const amountUsd = parseMinorUsd(result.amount);
      if (typeof amountUsd !== "number") continue;
      const description = result.description ?? result.cost_type ?? "Anthropic organization costs";
      const model = result.model ?? description;
      const workspaceId = result.workspace_id ?? undefined;
      records.push({
        id: slugifySourceId(["anthropic-costs", timestamp, workspaceId, model, result.token_type ?? result.cost_type].filter(Boolean).join("-")),
        timestamp: new Date(timestamp).toISOString(),
        source: {
          id: options.sourceId,
          name: "Anthropic Admin Cost Report",
          provider: "anthropic",
          confidence: "verified",
          observedFrom: options.observedFrom
        },
        model,
        inputTokens: 0,
        outputTokens: 0,
        amountUsd,
        costConfidence: "verified",
        projectId: workspaceId,
        workspaceId,
        providerCostType: result.cost_type ?? "anthropic_cost",
        operation: description
      });
    }
  }

  return records;
}

export function normalizeGitHubCopilotMetricsResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const records: UsageRecord[] = [];
  const dayTotals = extractArray(response, "day_totals");
  for (const day of dayTotals) {
    if (!isRecord(day)) continue;
    const dayString = stringValue(day.day) ?? new Date(0).toISOString().slice(0, 10);
    const timestamp = new Date(`${dayString}T00:00:00Z`).toISOString();
    const modelFeatureRows = Array.isArray(day.totals_by_model_feature) ? day.totals_by_model_feature : [];
    for (const row of modelFeatureRows) {
      if (!isRecord(row)) continue;
      const model = stringValue(row.model) ?? "github-copilot";
      const feature = stringValue(row.feature) ?? "copilot usage";
      records.push({
        id: slugifySourceId(["github-copilot", dayString, options.accountId, model, feature].filter(Boolean).join("-")),
        timestamp,
        source: { id: options.sourceId, name: "GitHub Copilot metrics API", provider: "github-copilot", confidence: "verified", observedFrom: options.observedFrom },
        model,
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: null,
        costConfidence: "missing",
        projectId: options.accountId,
        providerCostType: "copilot_usage_metrics",
        operation: feature
      });
    }
    const cli = isRecord(day.totals_by_cli) ? day.totals_by_cli : undefined;
    const tokenUsage = cli && isRecord(cli.token_usage) ? cli.token_usage : undefined;
    if (cli) {
      records.push({
        id: slugifySourceId(["github-copilot-cli", dayString, options.accountId].filter(Boolean).join("-")),
        timestamp,
        source: { id: options.sourceId, name: "GitHub Copilot metrics API", provider: "github-copilot", confidence: "verified", observedFrom: options.observedFrom },
        model: "github-copilot-cli",
        inputTokens: numberValue(tokenUsage?.prompt_tokens_sum) ?? 0,
        outputTokens: numberValue(tokenUsage?.output_tokens_sum) ?? 0,
        amountUsd: null,
        costConfidence: "missing",
        projectId: options.accountId,
        providerCostType: "copilot_cli_metrics",
        operation: "CLI requests"
      });
    }
  }
  return records;
}

export function normalizeCursorSpendResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const users = extractArray(response, "users").length > 0 ? extractArray(response, "users") : extractArray(response, "data");
  const timestamp = new Date().toISOString();
  return users.flatMap((user) => {
    if (!isRecord(user)) return [];
    const userId = stringValue(user.email) ?? stringValue(user.emailAddress) ?? stringValue(user.userId) ?? stringValue(user.id);
    const cents = numberValue(user.spendCents) ?? numberValue(user.usageBasedCents) ?? numberValue(user.chargedCents);
    if (!userId || typeof cents !== "number") return [];
    return [{
      id: slugifySourceId(["cursor-spend", options.accountId, userId].filter(Boolean).join("-")),
      timestamp,
      source: { id: options.sourceId, name: "Cursor Admin API", provider: "cursor", confidence: "verified", observedFrom: options.observedFrom },
      model: "cursor-team-usage",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: cents / 100,
      costConfidence: "verified" as const,
      userId,
      projectId: options.accountId,
      providerCostType: "cursor_spend",
      operation: "Cursor team spend"
    }];
  });
}

export async function fetchProviderUsageRecords(input: ProviderConnectorInput): Promise<ProviderConnectorResult> {
  const token = (input.tokenResolver ?? defaultTokenResolver)(input.authReference);
  const fetcher = input.fetcher ?? defaultFetcher;
  const sourceId = input.sourceId ?? `${input.provider}-provider-api`;

  if (input.provider === "openai") {
    return fetchOpenAi(input, token, fetcher, sourceId);
  }
  if (input.provider === "anthropic") {
    return fetchAnthropic(input, token, fetcher, sourceId);
  }
  if (input.provider === "github-copilot") {
    return fetchGitHubCopilot(input, token, fetcher, sourceId);
  }
  if (input.provider === "cursor") {
    return fetchCursor(input, token, fetcher, sourceId);
  }
  throw new Error(`Provider connector not implemented yet: ${input.provider}`);
}

async function fetchOpenAi(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const request = {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  };
  const costFetch = await fetchPaginatedJson(fetcher, buildOpenAiCostsUrl(input.startTime, input.endTime), request, "openai", "OpenAI costs API");
  const usageFetch = await fetchPaginatedJson(fetcher, buildOpenAiUsageUrl(input.startTime, input.endTime), request, "openai", "OpenAI usage API");
  const records = [
    ...costFetch.pages.flatMap((page) => normalizeOpenAiCostResponse(page, { sourceId, observedFrom: "OpenAI organization costs API" })),
    ...usageFetch.pages.flatMap((page) => normalizeOpenAiUsageResponse(page, { sourceId, observedFrom: "OpenAI organization usage API" }))
  ];
  return providerResult("openai", sourceId, input.authReference, records, "verified", qaSummary("openai", [costFetch, usageFetch]));
}

async function fetchAnthropic(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const costRequest = {
    method: "GET",
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
  };
  const costFetch = await fetchPaginatedJson(fetcher, buildAnthropicCostUrl(input.startTime, input.endTime), costRequest, "anthropic", "Anthropic Admin cost report");
  const claudeCodeFetches = await fetchDateRangeJson(fetcher, buildAnthropicClaudeCodeUrl, input.startTime, input.endTime, costRequest, "anthropic", "Anthropic Claude Code usage report");
  const records = [
    ...costFetch.pages.flatMap((page) => normalizeAnthropicCostResponse(page, { sourceId, observedFrom: "Anthropic Admin Cost Report" })),
    ...claudeCodeFetches.flatMap((fetchResult) => fetchResult.pages.flatMap((page) => normalizeAnthropicClaudeCodeUsageResponse(page, { sourceId, observedFrom: "Anthropic Claude Code Usage Report", accountId: input.accountId })))
  ];
  return providerResult("anthropic", sourceId, input.authReference, records, "verified", qaSummary("anthropic", [costFetch, ...claudeCodeFetches]));
}

async function fetchGitHubCopilot(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const accountId = input.org ?? input.enterprise;
  if (!accountId) throw new Error("GitHub Copilot connector requires --org or --enterprise.");
  const request = {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  };
  const metricsFetch = await fetchPaginatedJson(fetcher, buildGitHubCopilotMetricsUrl(input), request, "github-copilot", "GitHub Copilot metrics");
  const seatFetch = input.org ? await fetchPaginatedJson(fetcher, buildGitHubCopilotSeatsUrl(input.org), request, "github-copilot", "GitHub Copilot seats") : undefined;
  const metricsRecords = metricsFetch.pages.flatMap((page) => normalizeGitHubCopilotMetricsResponse(page, { sourceId, observedFrom: "GitHub Copilot metrics API", accountId }));
  const seatRecords = seatFetch ? seatFetch.pages.flatMap((page) => normalizeGitHubCopilotSeatResponse(page, { sourceId, observedFrom: "GitHub Copilot billing seats API", accountId })) : [];
  return providerResult("github-copilot", sourceId, input.authReference, [...metricsRecords, ...seatRecords], "verified", qaSummary("github-copilot", [metricsFetch, ...(seatFetch ? [seatFetch] : [])]));
}

async function fetchCursor(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const accountId = input.accountId ?? input.org ?? "cursor-team";
  const response = await fetchJsonOrThrow(fetcher, "https://api.cursor.com/teams/spend", {
    method: "POST",
    headers: { Authorization: `Basic ${btoaCompat(`${token}:`)}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  }, "cursor", "Cursor Admin API spend");
  const page = response.payload;
  const records = normalizeCursorSpendResponse(page, { sourceId, observedFrom: "Cursor Admin API", accountId });
  // The Cursor connector is matched to the published spec but not live-verified.
  // If the API answered with content but no spend fields we recognize, say so
  // loudly rather than silently report $0 (which reads as "you spent nothing").
  if (records.length === 0 && isRecord(page) && Object.keys(page).length > 0) {
    throw new Error(
      "Cursor returned data but no spend fields this connector recognizes " +
        `(saw: ${Object.keys(page).slice(0, 8).join(", ")}). The Cursor connector is beta — ` +
        "please open an issue with this field list so we can map it: https://github.com/futurastudio/ai-spend-agent/issues"
    );
  }
  const singleFetch: FetchPagesResult = {
    pages: [page],
    pagination: { label: "Cursor Admin API spend", pagesFetched: 1, stoppedBecause: "complete", maxPages: 1 },
    rateLimits: response.rateLimit ? [response.rateLimit] : [],
    responseDrift: detectResponseDrift(page, "cursor", "Cursor Admin API spend")
  };
  return providerResult("cursor", sourceId, input.authReference, records, "verified", qaSummary("cursor", [singleFetch]));
}

async function fetchPaginatedJson(
  fetcher: Fetcher,
  initialUrl: string,
  request: { method?: string; headers?: Record<string, string>; body?: string },
  provider: string,
  label: string
): Promise<FetchPagesResult> {
  const pages: unknown[] = [];
  const rateLimits: ProviderQaRateLimit[] = [];
  const responseDrift: ProviderQaDriftIssue[] = [];
  let nextUrl: string | undefined = initialUrl;
  let stoppedBecause: ProviderQaPagination["stoppedBecause"] = "complete";
  const maxPages = 50;
  for (let pageCount = 0; nextUrl && pageCount < maxPages; pageCount += 1) {
    const response = await fetchJsonOrThrow(fetcher, nextUrl, request, provider, label);
    const page = response.payload;
    pages.push(page);
    if (response.rateLimit) rateLimits.push(response.rateLimit);
    responseDrift.push(...detectResponseDrift(page, provider, label));
    const nextPage = nextPageFromPayload(page);
    const nextLink = nextUrlFromHeaders(response.headers);
    const hasMore = isRecord(page) && (page.has_more === true || page.hasMore === true || Boolean(nextPage) || Boolean(nextLink));
    if (nextLink) {
      nextUrl = nextLink;
    } else if (hasMore && nextPage) {
      nextUrl = appendPageCursor(initialUrl, nextPage);
    } else {
      if (hasMore && !nextPage) {
        stoppedBecause = "missing_cursor";
        responseDrift.push({ label, field: "next_page", issue: "pagination indicated more pages but no next cursor was returned" });
      }
      nextUrl = undefined;
    }
    if (pageCount === maxPages - 1 && nextUrl) stoppedBecause = "max_pages";
  }
  return {
    pages,
    pagination: { label, pagesFetched: pages.length, stoppedBecause, maxPages, limitPerPage: limitPerPageFromUrl(initialUrl) },
    rateLimits,
    responseDrift
  };
}

async function fetchDateRangeJson(
  fetcher: Fetcher,
  buildUrl: (startTime: number) => string,
  startTime: number,
  endTime: number | undefined,
  request: { method?: string; headers?: Record<string, string>; body?: string },
  provider: string,
  label: string
): Promise<FetchPagesResult[]> {
  const results: FetchPagesResult[] = [];
  const daySeconds = 24 * 60 * 60;
  const finalTime = endTime ?? startTime;
  for (let cursor = startTime, count = 0; cursor <= finalTime && count < 370; cursor += daySeconds, count += 1) {
    results.push(await fetchPaginatedJson(fetcher, buildUrl(cursor), request, provider, label));
  }
  return results;
}

async function fetchJsonOrThrow(
  fetcher: Fetcher,
  url: string,
  request: { method?: string; headers?: Record<string, string>; body?: string },
  provider: string,
  label: string
): Promise<{ payload: unknown; rateLimit?: ProviderQaRateLimit; headers?: ProviderResponse["headers"] }> {
  const response = await fetcher(url, request);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(providerPermissionPrompt(provider, label, response, payload));
  }
  return { payload, rateLimit: rateLimitFromHeaders(label, response.headers), headers: response.headers };
}

function nextPageFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const bodyLink = isRecord(payload.links) ? stringValue(payload.links.next) : undefined;
  return stringValue(payload.next_page) ?? stringValue(payload.nextPage) ?? stringValue(payload.next) ?? bodyLink;
}

function nextUrlFromHeaders(headers: ProviderResponse["headers"]): string | undefined {
  const link = headerString(headers, "link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function appendPageCursor(initialUrl: string, cursor: string): string {
  const url = new URL(initialUrl);
  url.searchParams.set("page", cursor);
  return url.toString();
}

function limitPerPageFromUrl(rawUrl: string): number | undefined {
  const params = new URL(rawUrl).searchParams;
  const rawLimit = params.get("limit") ?? params.get("per_page");
  if (!rawLimit) return undefined;
  const limit = Number(rawLimit);
  return Number.isFinite(limit) ? limit : undefined;
}

function rateLimitFromHeaders(label: string, headers: ProviderResponse["headers"]): ProviderQaRateLimit | undefined {
  const remaining = headerNumber(headers, "x-ratelimit-remaining-requests") ?? headerNumber(headers, "x-ratelimit-remaining");
  const retryAfter = headerNumber(headers, "retry-after");
  if (typeof remaining !== "number" && typeof retryAfter !== "number") return undefined;
  return { label, remainingRequests: remaining, retryAfterSeconds: retryAfter };
}

function headerString(headers: ProviderResponse["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  const value = hasHeaderGetter(headers) ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function headerNumber(headers: ProviderResponse["headers"], name: string): number | undefined {
  if (!headers) return undefined;
  const value = hasHeaderGetter(headers) ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function hasHeaderGetter(headers: ProviderResponse["headers"]): headers is { get: (name: string) => string | null } {
  return typeof (headers as { get?: unknown } | undefined)?.get === "function";
}

function detectResponseDrift(payload: unknown, provider: string, label: string): ProviderQaDriftIssue[] {
  const known = knownProviderFields(provider, label);
  const issues: ProviderQaDriftIssue[] = [];
  walkProviderFields(payload, "", (path) => {
    if (path && !known.has(path.replace(/\[\d+\]/g, "[]"))) {
      issues.push({ label, field: path, issue: "unknown field observed in provider response" });
    }
  });
  return issues;
}

function walkProviderFields(value: unknown, path: string, visit: (path: string) => void): void {
  if (Array.isArray(value)) {
    value.slice(0, 2).forEach((item, index) => walkProviderFields(item, `${path}[${index}]`, visit));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    visit(next);
    walkProviderFields(child, next, visit);
  }
}

function knownProviderFields(provider: string, label: string): Set<string> {
  const common = ["data", "data[]", "has_more", "hasMore", "next_page", "nextPage"];
  if (provider === "openai" && label.includes("costs")) {
    return new Set([...common, "data[].object", "data[].start_time", "data[].end_time", "data[].results", "data[].results[]", "data[].results[].object", "data[].results[].amount", "data[].results[].amount.value", "data[].results[].amount.currency", "data[].results[].line_item", "data[].results[].project_id", "data[].results[].api_key_id", "data[].results[].quantity"]);
  }
  if (provider === "openai" && label.includes("usage")) {
    return new Set([...common, "data[].object", "data[].start_time", "data[].end_time", "data[].results", "data[].results[]", "data[].results[].object", "data[].results[].input_tokens", "data[].results[].output_tokens", "data[].results[].input_cached_tokens", "data[].results[].input_audio_tokens", "data[].results[].output_audio_tokens", "data[].results[].num_model_requests", "data[].results[].project_id", "data[].results[].user_id", "data[].results[].api_key_id", "data[].results[].model"]);
  }
  return new Set([...common]);
}

function qaSummary(provider: string, fetches: FetchPagesResult[]): ProviderQaSummary {
  return {
    provider,
    requestedEndpoints: Array.from(new Set(fetches.map((fetchResult) => fetchResult.pagination.label))),
    pagination: fetches.map((fetchResult) => fetchResult.pagination),
    rateLimits: fetches.flatMap((fetchResult) => fetchResult.rateLimits),
    responseDrift: fetches.flatMap((fetchResult) => fetchResult.responseDrift),
    instructions: providerInstructions(provider)
  };
}

function providerInstructions(provider: string): string[] {
  if (provider === "openai") {
    return [
      "Use an OpenAI admin key reference with organization usage and cost read access.",
      "Keep cost buckets and usage buckets separate; usage evidence does not imply dollars until billing reconciliation."
    ];
  }
  if (provider === "anthropic") {
    return [
      "Use an Anthropic Admin API key reference with organization cost report and Claude Code usage report read access.",
      "Treat Claude Code usage-report costs as estimated unless reconciled to Admin cost report totals."
    ];
  }
  if (provider === "github-copilot") {
    return [
      "Use a GitHub token reference with org or enterprise Copilot metrics and billing seats read access.",
      "Seat records estimate monthly commitment; metrics records are usage evidence without direct spend allocation."
    ];
  }
  if (provider === "cursor") {
    return [
      "Use a Cursor team admin API key reference, or fall back to Browser Account UI/manual export when API access is unavailable.",
      "Validate user-level spend against invoices before treating the source as finance-grade."
    ];
  }
  return ["Use a local token reference only; never paste raw provider secrets into commands or reports."];
}

function providerPermissionPrompt(provider: string, label: string, response: ProviderResponse, payload: unknown): string {
  const rawMessage = sanitizeProviderMessage(extractProviderMessage(payload));
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  if (response.status === 401 || response.status === 403) {
    if (provider === "openai") {
      return `Missing OpenAI admin read scopes for ${label} (${status}). Reconnect with organization usage/cost read access or use an admin token reference. ${rawMessage}`;
    }
    if (provider === "anthropic") {
      return `Missing Anthropic Admin read scopes for ${label} (${status}). Reconnect with organization cost report and Claude Code usage report read access. ${rawMessage}`;
    }
    if (provider === "github-copilot") {
      return `Missing GitHub Copilot org or enterprise read scopes for ${label} (${status}). Reconnect with Copilot metrics and billing seats read access. ${rawMessage}`;
    }
    if (provider === "cursor") {
      return `Missing Cursor team admin read scopes for ${label} (${status}). Use Cursor Admin API access or fall back to Browser Account UI/manual export. ${rawMessage}`;
    }
  }
  return `${label} request failed with ${status}. ${rawMessage}`.trim();
}

function extractProviderMessage(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const error = isRecord(payload.error) ? payload.error : undefined;
  return stringValue(error?.message) ?? stringValue(payload.message) ?? "";
}

function sanitizeProviderMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]");
}

function providerResult(provider: string, sourceId: string, authReference: string, records: UsageRecord[], fallbackCompleteness: ProviderConnectorResult["completeness"], qa?: ProviderQaSummary): ProviderConnectorResult {
  const totalUsd = records.reduce((sum, record) => sum + (record.amountUsd ?? 0), 0);
  return {
    provider,
    source: createProviderConnection({ provider, sourceId, authReference, verifiedRecordCount: records.length, totalUsd }),
    records,
    fetchedAt: new Date().toISOString(),
    completeness: records.length > 0 ? fallbackCompleteness : "missing",
    qa: qa ?? qaSummary(provider, [])
  };
}

export function createProviderConnection(input: CreateProviderConnectionInput): ApprovedSource {
  const source = createProviderConnectorStub(input.provider, "provider_api", input.fetchedAt);
  const total = `$${input.totalUsd.toFixed(2)}`;
  return {
    ...source,
    id: input.sourceId ?? source.id,
    verification: "verified",
    authReference: input.authReference,
    fieldsMissing: [],
    scope: `${source.scope} Last successful pull produced ${input.verifiedRecordCount} verified records totaling ${total}.`
  };
}

export function resolveTokenReference(reference: string, env: Record<string, string | undefined> = process.env): string {
  if (!reference.startsWith("env:")) {
    throw new Error("Provider auth reference must be a local reference such as env:OPENAI_ADMIN_KEY; raw secrets are not accepted.");
  }
  const envName = reference.slice("env:".length);
  if (!/^[A-Z0-9_]+$/.test(envName)) {
    throw new Error("Provider auth env reference must use an uppercase environment variable name.");
  }
  const value = env[envName];
  if (!value) {
    throw new Error(`Provider auth reference ${reference} is not set in the local environment.`);
  }
  return value;
}

function buildOpenAiCostsUrl(startTime: number, endTime?: number): string {
  const url = new URL("https://api.openai.com/v1/organization/costs");
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "180");
  url.searchParams.append("group_by", "project_id");
  url.searchParams.append("group_by", "line_item");
  url.searchParams.append("group_by", "api_key_id");
  if (endTime) url.searchParams.set("end_time", String(endTime));
  return url.toString();
}

function buildOpenAiUsageUrl(startTime: number, endTime?: number): string {
  const url = new URL("https://api.openai.com/v1/organization/usage/completions");
  url.searchParams.set("start_time", String(startTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", "31");
  url.searchParams.append("group_by", "project_id");
  url.searchParams.append("group_by", "user_id");
  url.searchParams.append("group_by", "api_key_id");
  url.searchParams.append("group_by", "model");
  if (endTime) url.searchParams.set("end_time", String(endTime));
  return url.toString();
}

function buildAnthropicCostUrl(startTime: number, endTime?: number): string {
  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", new Date(startTime * 1000).toISOString());
  if (endTime) url.searchParams.set("ending_at", new Date(endTime * 1000).toISOString());
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.append("group_by[]", "workspace_id");
  url.searchParams.append("group_by[]", "description");
  return url.toString();
}

function buildGitHubCopilotMetricsUrl(input: ProviderConnectorInput): string {
  if (input.enterprise) return `https://api.github.com/enterprises/${encodeURIComponent(input.enterprise)}/copilot/metrics/reports/enterprise-28-day/latest`;
  if (input.org) return `https://api.github.com/orgs/${encodeURIComponent(input.org)}/copilot/metrics/reports/organization-28-day/latest`;
  throw new Error("GitHub Copilot connector requires --org or --enterprise.");
}

function buildAnthropicClaudeCodeUrl(startTime: number): string {
  const url = new URL("https://api.anthropic.com/v1/organizations/usage_report/claude_code");
  url.searchParams.set("starting_at", new Date(startTime * 1000).toISOString().slice(0, 10));
  url.searchParams.set("limit", "1000");
  return url.toString();
}

function buildGitHubCopilotSeatsUrl(org: string): string {
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/billing/seats?per_page=100`;
}

function defaultTokenResolver(reference: string): string {
  return resolveTokenReference(reference);
}

async function defaultFetcher(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  return fetch(url, init);
}

function parseMinorUsd(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric / 100 : undefined;
}

/** Amount already denominated in dollars, as number or decimal string. */
function parseDollarUsd(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as unknown[];
  return [];
}

function isObject(value: unknown): value is { data?: unknown } {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function btoaCompat(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value).toString("base64");
}
