import { createHash } from "node:crypto";
import type { ApprovedSource } from "./sourceRegistry.js";
import { createProviderConnectorStub, slugifySourceId } from "./sourceRegistry.js";
import { redactSecrets } from "./discovery.js";
import type { UsageRecord } from "./schema.js";

type ProviderResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string | undefined> | { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
};

export type ProviderQaPagination = {
  label: string;
  pagesFetched: number;
  stoppedBecause:
    | "complete"
    | "missing_cursor"
    | "max_pages"
    | "max_range_days"
    | "fetch_error"
    | "unsafe_next_link";
  maxPages: number;
  limitPerPage?: number;
  /** Present when stoppedBecause is "fetch_error": the sanitized reason the fetch stopped early. */
  note?: string;
};

export type ProviderCoverageStatus = "complete" | "partial";

/**
 * Exact provider interval requested by a sync. It is intentionally absent
 * when the caller leaves the end open: a successful narrow/open-ended read
 * must never be promoted into an assumed 30-day coverage claim.
 */
export type ProviderCoverageInterval = {
  coverageStart: string;
  coverageEnd: string;
};

export type ProviderFinancialSummary = {
  providerReportedBilledUsd: number | null;
  apiEquivalentEstimatedUsd: number | null;
  providerEstimatedUsd: number | null;
  headlineUsd: number | null;
  headlineBasis:
    | "provider_reported_billed_cost"
    | "api_equivalent_estimate"
    | "provider_estimated_cost"
    | "unavailable";
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
  coverage?: ProviderCoverageStatus;
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
  /** True when transport completed but one or more financial rows could not be normalized safely. */
  coverageIncomplete?: boolean;
};

export type ProviderId = "openai" | "anthropic" | "github-copilot" | "cursor" | string;

export type ProviderConnectorErrorCode =
  | "authentication_error"
  | "provider_request_error";

/**
 * Trusted connector failure metadata. Provider prose remains untrusted and is
 * used only as a sanitized human-readable message; callers classify failures
 * from this product-authored code and the observed HTTP status instead.
 */
export class ProviderConnectorError extends Error {
  readonly code: ProviderConnectorErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    options: { code: ProviderConnectorErrorCode; status?: number }
  ) {
    super(message);
    this.name = "ProviderConnectorError";
    this.code = options.code;
    this.status = options.status;
  }
}

export function isProviderAuthenticationError(error: unknown): boolean {
  return error instanceof ProviderConnectorError &&
    error.code === "authentication_error";
}

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
  /**
   * Operator-declared reconciliation anchor for this sync. Today only the
   * Cursor connector consumes it; when absent, the Cursor connector also
   * accepts the AI_SPEND_CURSOR_RECONCILE_* environment variables so the
   * shipped CLI can run a reconciliation without new flags.
   */
  reconciliation?: CursorReconciliationExpectation;
};

/**
 * A human-read billing anchor for one Cursor reconciliation run: the
 * on-demand ("usage based pricing") total the operator read off the Cursor
 * team dashboard or invoice for the CURRENT subscription cycle. The connector
 * compares its own summed spendCents against this figure; only an in-run
 * match within tolerance can produce verified financial evidence.
 */
export type CursorReconciliationExpectation = {
  /** Dashboard/invoice on-demand total for the current cycle, in USD. */
  expectedOnDemandUsd: number;
  /**
   * The billing-cycle start date shown next to that figure (YYYY-MM-DD).
   * Must land within one calendar day of the UTC date of the API's
   * subscriptionCycleStart, proving both numbers describe the same window.
   */
  expectedCycleStartDate: string;
  /**
   * Optional absolute comparison tolerance in USD. Defaults to $0.01 (the
   * dashboard rounds to cents). Clamped to at most 1% of the expected total
   * so a huge tolerance can never rubber-stamp a mismatch.
   */
  toleranceUsd?: number;
};

export type CursorReconciliationOutcome = {
  status: "verified" | "mismatch" | "not_provable";
  /** Product-authored, terminal-safe explanation of the outcome. */
  note: string;
  connectorTotalUsd?: number;
  expectedOnDemandUsd?: number;
  differenceUsd?: number;
  toleranceUsd?: number;
  /** Provider-reported cycle start for the reconciled window, ISO-8601. */
  cycleStartIso?: string;
};

/** Environment variables the Cursor connector reads for a reconciliation run. */
export const cursorReconciliationEnvVars = {
  expectedUsd: "AI_SPEND_CURSOR_RECONCILE_EXPECTED_USD",
  cycleStart: "AI_SPEND_CURSOR_RECONCILE_CYCLE_START",
  toleranceUsd: "AI_SPEND_CURSOR_RECONCILE_TOLERANCE_USD"
} as const;

/**
 * Read an operator-declared Cursor reconciliation anchor from the local
 * environment. Absent variables mean "no reconciliation requested"; present
 * but invalid variables fail closed with a reason (records stay estimated)
 * instead of throwing, so a typo can never abort or silently verify a sync.
 * Raw variable values are never echoed into the reason.
 */
export function parseCursorReconciliationEnv(
  env: Record<string, string | undefined> = process.env
): { expectation?: CursorReconciliationExpectation; invalidReason?: string } {
  const rawExpected = env[cursorReconciliationEnvVars.expectedUsd];
  const rawCycleStart = env[cursorReconciliationEnvVars.cycleStart];
  const rawTolerance = env[cursorReconciliationEnvVars.toleranceUsd];
  if (rawExpected === undefined && rawCycleStart === undefined && rawTolerance === undefined) {
    return {};
  }
  if (rawExpected === undefined || rawCycleStart === undefined) {
    return {
      invalidReason: `both ${cursorReconciliationEnvVars.expectedUsd} and ${cursorReconciliationEnvVars.cycleStart} are required to request a reconciliation`
    };
  }
  const expectedOnDemandUsd = Number(rawExpected.trim());
  const toleranceUsd = rawTolerance === undefined ? undefined : Number(rawTolerance.trim());
  const expectation: CursorReconciliationExpectation = {
    expectedOnDemandUsd,
    expectedCycleStartDate: rawCycleStart.trim(),
    ...(toleranceUsd === undefined ? {} : { toleranceUsd })
  };
  const invalidReason = invalidCursorReconciliationExpectationReason(expectation);
  return invalidReason ? { invalidReason } : { expectation };
}

function invalidCursorReconciliationExpectationReason(
  expectation: CursorReconciliationExpectation
): string | undefined {
  if (!Number.isFinite(expectation.expectedOnDemandUsd) || expectation.expectedOnDemandUsd <= 0) {
    return `${cursorReconciliationEnvVars.expectedUsd} must be a positive USD amount read off the Cursor dashboard or invoice`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectation.expectedCycleStartDate) ||
      !Number.isFinite(Date.parse(`${expectation.expectedCycleStartDate}T00:00:00Z`))) {
    return `${cursorReconciliationEnvVars.cycleStart} must be the cycle start date shown on the dashboard, formatted YYYY-MM-DD`;
  }
  if (expectation.toleranceUsd !== undefined &&
      (!Number.isFinite(expectation.toleranceUsd) || expectation.toleranceUsd < 0)) {
    return `${cursorReconciliationEnvVars.toleranceUsd} must be a non-negative USD amount when set`;
  }
  return undefined;
}

export type ProviderConnectorResult = {
  provider: string;
  source: ApprovedSource;
  records: UsageRecord[];
  fetchedAt: string;
  coverage: ProviderCoverageStatus;
  coverageInterval?: ProviderCoverageInterval;
  financials: ProviderFinancialSummary;
  completeness: "verified" | "estimated" | "detected_unverified" | "missing";
  qa: ProviderQaSummary;
};

export type CreateProviderConnectionInput = {
  provider: ProviderId;
  sourceId?: string;
  authReference: string;
  verifiedRecordCount: number;
  totalUsd: number | null;
  fetchedAt?: Date;
  /** Record-derived completeness; this controls financial evidence, not connector validation. */
  completeness?: ProviderConnectorResult["completeness"];
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

type OpenAiUsageResult = {
  object?: string;
  input_tokens?: number;
  input_uncached_tokens?: number;
  input_cache_write_tokens?: number;
  output_tokens?: number;
  input_cached_tokens?: number;
  input_text_tokens?: number;
  input_image_tokens?: number;
  input_audio_tokens?: number;
  input_cached_text_tokens?: number;
  input_cached_image_tokens?: number;
  input_cached_audio_tokens?: number;
  output_text_tokens?: number;
  output_image_tokens?: number;
  output_audio_tokens?: number;
  num_model_requests?: number;
  project_id?: string | null;
  user_id?: string | null;
  api_key_id?: string | null;
  model?: string | null;
  batch?: boolean | null;
  service_tier?: string | null;
};

type NormalizerOptions = { sourceId: string; observedFrom: string; accountId?: string };

export function normalizeOpenAiCostResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data : [];
  const records: UsageRecord[] = [];

  for (const bucketValue of data) {
    if (!isRecord(bucketValue)) continue;
    const startTime = validEpochSeconds(bucketValue.start_time);
    if (typeof startTime !== "number") continue;
    const timestamp = new Date(startTime * 1000).toISOString();
    const results = Array.isArray(bucketValue.results) ? bucketValue.results : [];
    for (const resultValue of results) {
      if (!isRecord(resultValue)) continue;
      const amount = isRecord(resultValue.amount) ? resultValue.amount : undefined;
      const currency = amount?.currency === undefined
        ? "usd"
        : typeof amount.currency === "string"
          ? amount.currency.toLowerCase()
          : undefined;
      // The live API returns amount.value as a decimal STRING (dollars);
      // accept both string and number.
      const amountUsd = currency === "usd"
        ? parseDollarUsd(amount?.value)
        : undefined;
      if (typeof amountUsd !== "number") continue;
      const lineItem = stringValue(resultValue.line_item) ?? "OpenAI organization costs";
      const projectId = stringValue(resultValue.project_id);
      const apiKeyId = stringValue(resultValue.api_key_id);
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
        usageGranularity: "billing_bucket",
        quantity: nonNegativeNumberValue(resultValue.quantity),
        operation: lineItem
      });
    }
  }

  return records;
}

export function normalizeOpenAiUsageResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data : [];
  const records: UsageRecord[] = [];

  for (const bucketValue of data) {
    if (!isRecord(bucketValue) || !Array.isArray(bucketValue.results)) continue;
    const startTime = validEpochSeconds(bucketValue.start_time);
    if (typeof startTime !== "number") continue;
    const timestamp = new Date(startTime * 1000).toISOString();
    for (const resultValue of bucketValue.results) {
      if (!isRecord(resultValue)) continue;
      const result = resultValue as OpenAiUsageResult;
      const projectId = stringValue(result.project_id);
      const userId = stringValue(result.user_id);
      const apiKeyId = stringValue(result.api_key_id);
      const model = stringValue(result.model) ?? "openai-usage";
      const serviceTier = stringValue(result.service_tier);
      const batch = typeof result.batch === "boolean" ? result.batch : undefined;
      // OpenAI's organization completions Usage API defines these as
      // inclusive totals across text, audio, image, cache reads, and cache
      // writes. The modality/cache fields below are subsets for provenance;
      // adding them again double-counts usage.
      // https://developers.openai.com/cookbook/examples/completions_usage_api
      const inputTokens = nonNegativeIntegerValue(result.input_tokens);
      const outputTokens = nonNegativeIntegerValue(result.output_tokens);
      // A request count does not prove a zero-token result. Preserve explicit
      // 0/0 totals, but fail closed when either canonical total is absent or
      // invalid so missing provider evidence never becomes a verified zero.
      if (typeof inputTokens !== "number" || typeof outputTokens !== "number") continue;
      const requestCount = nonNegativeIntegerValue(result.num_model_requests);
      if (inputTokens + outputTokens === 0 && !(typeof requestCount === "number" && requestCount > 0)) continue;
      const inputComponent = (value: unknown) => boundedTokenComponent(value, inputTokens);
      const outputComponent = (value: unknown) => boundedTokenComponent(value, outputTokens);
      const cacheReadTokens = inputComponent(result.input_cached_tokens);
      const cachedComponent = (value: unknown) => {
        const component = inputComponent(value);
        return component !== undefined && (cacheReadTokens === undefined || component <= cacheReadTokens)
          ? component
          : undefined;
      };
      const inputAccountingValid = componentFamilyWithinParent([
        result.input_uncached_tokens,
        result.input_cache_write_tokens,
        result.input_cached_tokens
      ], inputTokens);
      const inputModalitiesValid = componentFamilyWithinParent([
        result.input_text_tokens,
        result.input_image_tokens,
        result.input_audio_tokens
      ], inputTokens);
      const cachedModalitiesPresent = [
        result.input_cached_text_tokens,
        result.input_cached_image_tokens,
        result.input_cached_audio_tokens
      ].some((value) => value !== undefined);
      const cachedModalitiesValid = !cachedModalitiesPresent || (cacheReadTokens !== undefined && componentFamilyWithinParent([
        result.input_cached_text_tokens,
        result.input_cached_image_tokens,
        result.input_cached_audio_tokens
      ], cacheReadTokens));
      const outputModalitiesValid = componentFamilyWithinParent([
        result.output_text_tokens,
        result.output_image_tokens,
        result.output_audio_tokens
      ], outputTokens);
      records.push({
        id: slugifySourceId(["openai-usage", String(startTime), projectId, userId, apiKeyId, model, serviceTier, batch === undefined ? undefined : `batch-${batch}`].filter(Boolean).join("-")),
        timestamp,
        source: { id: options.sourceId, name: "OpenAI organization usage API", provider: "openai", confidence: "verified", observedFrom: options.observedFrom },
        model,
        inputTokens,
        outputTokens,
        ...(inputAccountingValid && inputComponent(result.input_uncached_tokens) !== undefined
          ? { inputUncachedTokens: inputComponent(result.input_uncached_tokens) }
          : {}),
        ...(inputAccountingValid && inputComponent(result.input_cache_write_tokens) !== undefined
          ? { inputCacheWriteTokens: inputComponent(result.input_cache_write_tokens) }
          : {}),
        ...(inputAccountingValid && cacheReadTokens !== undefined
          ? { cacheReadTokens }
          : {}),
        ...(inputModalitiesValid && inputComponent(result.input_text_tokens) !== undefined
          ? { inputTextTokens: inputComponent(result.input_text_tokens) }
          : {}),
        ...(inputModalitiesValid && inputComponent(result.input_image_tokens) !== undefined
          ? { inputImageTokens: inputComponent(result.input_image_tokens) }
          : {}),
        ...(inputModalitiesValid && inputComponent(result.input_audio_tokens) !== undefined
          ? { inputAudioTokens: inputComponent(result.input_audio_tokens) }
          : {}),
        ...(cachedModalitiesValid && cachedComponent(result.input_cached_text_tokens) !== undefined
          ? { inputCachedTextTokens: cachedComponent(result.input_cached_text_tokens) }
          : {}),
        ...(cachedModalitiesValid && cachedComponent(result.input_cached_image_tokens) !== undefined
          ? { inputCachedImageTokens: cachedComponent(result.input_cached_image_tokens) }
          : {}),
        ...(cachedModalitiesValid && cachedComponent(result.input_cached_audio_tokens) !== undefined
          ? { inputCachedAudioTokens: cachedComponent(result.input_cached_audio_tokens) }
          : {}),
        ...(outputModalitiesValid && outputComponent(result.output_text_tokens) !== undefined
          ? { outputTextTokens: outputComponent(result.output_text_tokens) }
          : {}),
        ...(outputModalitiesValid && outputComponent(result.output_image_tokens) !== undefined
          ? { outputImageTokens: outputComponent(result.output_image_tokens) }
          : {}),
        ...(outputModalitiesValid && outputComponent(result.output_audio_tokens) !== undefined
          ? { outputAudioTokens: outputComponent(result.output_audio_tokens) }
          : {}),
        amountUsd: null,
        costConfidence: "missing",
        projectId,
        userId,
        apiKeyId,
        providerCostType: "openai_usage_evidence",
        usageGranularity: "usage_bucket",
        quantity: requestCount,
        ...(serviceTier ? { serviceTier } : {}),
        ...(batch !== undefined ? { batch } : {}),
        operation: "OpenAI completions usage evidence"
      });
    }
  }

  return records;
}

function boundedTokenComponent(value: unknown, inclusiveTotal: number): number | undefined {
  const component = nonNegativeIntegerValue(value);
  return typeof component === "number" && component <= inclusiveTotal ? component : undefined;
}

function componentFamilyWithinParent(values: unknown[], parent: number): boolean {
  const components = values
    .map(nonNegativeIntegerValue)
    .filter((value): value is number => typeof value === "number");
  return components.reduce((sum, value) => sum + value, 0) <= parent;
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
    const sessions = nonNegativeIntegerValue(core.num_sessions) ?? 0;
    const added = nonNegativeIntegerValue(lines.added) ?? 0;
    const removed = nonNegativeIntegerValue(lines.removed) ?? 0;
    const commits = nonNegativeIntegerValue(core.commits_by_claude_code) ?? 0;
    const prs = nonNegativeIntegerValue(core.pull_requests_by_claude_code) ?? 0;
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
        inputTokens: (nonNegativeIntegerValue(tokens.input) ?? 0) + (nonNegativeIntegerValue(tokens.cache_read) ?? 0) + (nonNegativeIntegerValue(tokens.cache_creation) ?? 0),
        outputTokens: nonNegativeIntegerValue(tokens.output) ?? 0,
        amountUsd,
        costConfidence: "estimated",
        userId,
        projectId: organizationId,
        providerCostType: "anthropic_claude_code_usage",
        usageGranularity: "daily_aggregate",
        quantity: sessions,
        operation: `Claude Code sessions: ${sessions}; LOC +${added}/-${removed}; commits ${commits}; PRs ${prs}`
      });
    }
  }
  return records;
}

export function normalizeGitHubCopilotSeatResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const seats = extractArray(response, "seats");
  const timestamp = new Date().toISOString();
  return seats.flatMap((seat) => {
    if (!isRecord(seat)) return [];
    const assignee = isRecord(seat.assignee) ? seat.assignee : {};
    const userId = stringValue(assignee.login) ?? stringValue(assignee.email) ?? stringValue(seat.login) ?? stringValue(seat.id);
    if (!userId) return [];
    // The current GitHub seat schema reports plan_type on each seat. Never
    // inherit a top-level value: an enterprise can contain mixed Business and
    // Enterprise organizations, and an unknown tier is evidence, not $19.
    const reportedPlan = stringValue(seat.plan_type)?.toLowerCase();
    const plan = reportedPlan === "business" || reportedPlan === "enterprise" ? reportedPlan : "unknown";
    const seatUsd = plan === "enterprise" ? 39 : plan === "business" ? 19 : null;
    const lastActivity = stringValue(seat.last_activity_at);
    return [{
      id: slugifySourceId(["github-copilot-seat", options.accountId, userId, plan].filter(Boolean).join("-")),
      timestamp,
      source: { id: options.sourceId, name: "GitHub Copilot billing seats API", provider: "github-copilot", confidence: "estimated", observedFrom: options.observedFrom },
      model: `github-copilot-${plan}-seat`,
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: seatUsd,
      costConfidence: seatUsd === null ? "missing" as const : "estimated" as const,
      userId,
      projectId: options.accountId,
      providerCostType: "copilot_seat_reconciliation",
      usageGranularity: "seat",
      quantity: 1,
      operation: `GitHub Copilot ${plan} seat; ${lastActivity ? `last activity ${lastActivity}` : "no recent activity reported"}`
    }];
  });
}

export function normalizeAnthropicCostResponse(response: unknown, options: NormalizerOptions): UsageRecord[] {
  const data = isObject(response) && Array.isArray(response.data) ? response.data : [];
  const records: UsageRecord[] = [];

  for (const bucketValue of data) {
    if (!isRecord(bucketValue)) continue;
    const timestamp = validDateTimeString(bucketValue.starting_at);
    if (!timestamp) continue;
    const results = Array.isArray(bucketValue.results) ? bucketValue.results : [];
    for (const resultValue of results) {
      if (!isRecord(resultValue)) continue;
      const currency = resultValue.currency === undefined
        ? "usd"
        : typeof resultValue.currency === "string"
          ? resultValue.currency.toLowerCase()
          : undefined;
      if (currency !== "usd") continue;
      const amountUsd = parseMinorUsd(resultValue.amount);
      if (typeof amountUsd !== "number") continue;
      const costType = stringValue(resultValue.cost_type);
      const description = stringValue(resultValue.description) ?? costType ?? "Anthropic organization costs";
      const model = stringValue(resultValue.model) ?? description;
      const workspaceId = stringValue(resultValue.workspace_id);
      const tokenType = stringValue(resultValue.token_type);
      records.push({
        id: slugifySourceId(["anthropic-costs", timestamp, workspaceId, model, tokenType ?? costType].filter(Boolean).join("-")),
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
        providerCostType: costType ?? "anthropic_cost",
        usageGranularity: "billing_bucket",
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
        usageGranularity: "daily_aggregate",
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
        inputTokens: nonNegativeIntegerValue(tokenUsage?.prompt_tokens_sum) ?? 0,
        outputTokens: nonNegativeIntegerValue(tokenUsage?.output_tokens_sum) ?? 0,
        amountUsd: null,
        costConfidence: "missing",
        projectId: options.accountId,
        providerCostType: "copilot_cli_metrics",
        usageGranularity: "daily_aggregate",
        operation: "CLI requests"
      });
    }
  }
  return records;
}

export function normalizeCursorSpendResponse(
  response: unknown,
  options: NormalizerOptions,
  reconciliation?: CursorReconciliationOutcome
): UsageRecord[] {
  const users = extractArray(response, "teamMemberSpend");
  const cycleStart = isRecord(response) ? numberValue(response.subscriptionCycleStart) : undefined;
  const timestamp = typeof cycleStart === "number" ? new Date(cycleStart).toISOString() : new Date().toISOString();
  // The Cursor connector's dollars are labeled estimated until an in-run
  // reconciliation proves the connector total against a human-read dashboard
  // or invoice figure for the same cycle. Only that evidence — never a
  // hardcoded flip — can stamp these records "verified", and a mismatched or
  // unprovable reconciliation fails closed back to estimated.
  const reconciled = reconciliation?.status === "verified";
  const confidence = reconciled ? "verified" as const : "estimated" as const;
  // Documented semantics: spendCents is "On-demand spend in cents for the
  // current billing cycle" — seat fees and included-pool usage are excluded.
  const baseOperation = "Cursor on-demand team spend (current billing cycle; excludes seat fees and included-pool usage)";
  const operation = reconciled ? `${baseOperation}; ${reconciliation.note}` : baseOperation;
  return users.flatMap((user) => {
    if (!isRecord(user)) return [];
    const userId = stringValue(user.email) ?? stringValue(user.userId);
    const cents = numberValue(user.spendCents);
    if (!userId || typeof cents !== "number") return [];
    return [{
      id: slugifySourceId(["cursor-spend", options.accountId, userId].filter(Boolean).join("-")),
      timestamp,
      source: { id: options.sourceId, name: "Cursor Admin API", provider: "cursor", confidence, observedFrom: options.observedFrom },
      model: "cursor-team-usage",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: cents / 100,
      costConfidence: confidence,
      userId,
      projectId: options.accountId,
      providerCostType: "cursor_spend",
      usageGranularity: "user_aggregate",
      operation
    }];
  });
}

export async function fetchProviderUsageRecords(input: ProviderConnectorInput): Promise<ProviderConnectorResult> {
  // Validate explicit bounds before resolving a credential or making a request.
  // The interval-aware OpenAI/Anthropic result paths call the same pure helper
  // to attach normalized bounds only after a successful fetch. Copilot and
  // Cursor do not currently constrain their reads to these requested bounds,
  // so they deliberately return no coverage interval.
  requestedCoverageInterval(input);
  const token = (input.tokenResolver ?? defaultTokenResolver)(input.authReference);
  const fetcher = input.fetcher ?? defaultFetcher;
  const sourceId = input.sourceId ?? `${input.provider}-provider-api`;
  const credentialVariants = resolvedCredentialVariants(input.provider, token);

  try {
    if (input.provider === "openai") {
      return redactResolvedCredentialValue(
        await fetchOpenAi(input, token, fetcher, sourceId),
        credentialVariants
      );
    }
    if (input.provider === "anthropic") {
      return redactResolvedCredentialValue(
        await fetchAnthropic(input, token, fetcher, sourceId),
        credentialVariants
      );
    }
    if (input.provider === "github-copilot") {
      return redactResolvedCredentialValue(
        await fetchGitHubCopilot(input, token, fetcher, sourceId),
        credentialVariants
      );
    }
    if (input.provider === "cursor") {
      return redactResolvedCredentialValue(
        await fetchCursor(input, token, fetcher, sourceId),
        credentialVariants
      );
    }
    throw new Error(`Provider connector not implemented yet: ${input.provider}`);
  } catch (error) {
    // This is the shared credential boundary for CLI, MCP, and future hosts.
    // Provider payloads, status text, fetch implementations, and validation
    // errors are all untrusted after a credential has been resolved. Exact
    // replacement covers opaque tokens that do not match a known key shape.
    throw redactResolvedCredentialError(error, credentialVariants);
  }
}

function resolvedCredentialVariants(provider: ProviderId, token: string): string[] {
  const values = token ? [token] : [];
  if (provider === "cursor" && token) {
    try {
      const encoded = btoaCompat(`${token}:`);
      const unpadded = encoded.replace(/=+$/g, "");
      const base64Url = unpadded.replace(/\+/g, "-").replace(/\//g, "_");
      values.push(encoded, unpadded, base64Url, `Basic ${encoded}`, `Basic ${unpadded}`, `Basic ${base64Url}`);
    } catch {
      // Cursor's request will fail on the same unsupported credential. Keep the
      // raw value in the redaction set so that failure is still safe to return.
    }
  }
  const encodedValues = values.flatMap((value) => {
    const encoded = encodeURIComponent(value);
    return encoded === value ? [value] : [value, encoded];
  });
  return Array.from(new Set(encodedValues)).sort((left, right) => right.length - left.length);
}

function exactRedactCredentialValues(value: string, credentialVariants: string[]): string {
  return credentialVariants.reduce(
    (safeValue, credential) => safeValue.split(credential).join("[REDACTED]"),
    value
  );
}

function redactResolvedCredentialError(error: unknown, credentialVariants: string[]): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const withoutResolvedCredential = exactRedactCredentialValues(rawMessage, credentialVariants);
  // Strip controls before a second exact-redaction pass: an adversarial
  // provider can splice ANSI bytes through an opaque credential so the first
  // literal replacement misses it and control stripping reconstructs it.
  const safeMessage = exactRedactCredentialValues(
    sanitizeProviderMessage(withoutResolvedCredential),
    credentialVariants
  ).trim();
  const message = safeMessage || "Provider connector request failed without a safe error message.";
  return error instanceof ProviderConnectorError
    ? new ProviderConnectorError(message, { code: error.code, status: error.status })
    : new Error(message);
}

function redactResolvedCredentialValue<T>(value: T, credentialVariants: string[]): T {
  if (typeof value === "string") {
    const withoutResolvedCredential = exactRedactCredentialValues(value, credentialVariants);
    return exactRedactCredentialValues(
      sanitizeProviderMessage(withoutResolvedCredential),
      credentialVariants
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactResolvedCredentialValue(item, credentialVariants)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactResolvedCredentialValue(item, credentialVariants)])
    ) as T;
  }
  return value;
}

async function fetchOpenAi(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const request = {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  };
  const costFetch = await fetchPaginatedJson(fetcher, buildOpenAiCostsUrl(input.startTime, input.endTime), request, "openai", "OpenAI costs API");
  markMalformedCostRows(costFetch, "openai", "OpenAI costs API");
  enforceOpenAiRequestedWindow(costFetch, input.startTime, input.endTime, "OpenAI costs API");
  const usageFetch = await fetchPaginatedJson(fetcher, buildOpenAiUsageUrl(input.startTime, input.endTime), request, "openai", "OpenAI usage API");
  markMalformedUsageRows(usageFetch, "openai", "OpenAI usage API");
  enforceOpenAiRequestedWindow(usageFetch, input.startTime, input.endTime, "OpenAI usage API");
  const normalizedRecords = [
    ...costFetch.pages.flatMap((page) => normalizeOpenAiCostResponse(page, { sourceId, observedFrom: "OpenAI organization costs API" })),
    ...usageFetch.pages.flatMap((page) => normalizeOpenAiUsageResponse(page, { sourceId, observedFrom: "OpenAI organization usage API" }))
  ];
  const records = dedupeProviderRecords(normalizedRecords, [costFetch, usageFetch]);
  return providerResult(
    "openai",
    sourceId,
    input.authReference,
    records,
    qaSummary("openai", [costFetch, usageFetch]),
    requestedCoverageInterval(input)
  );
}

async function fetchAnthropic(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const costRequest = {
    method: "GET",
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
  };
  const costFetch = await fetchPaginatedJson(fetcher, buildAnthropicCostUrl(input.startTime, input.endTime), costRequest, "anthropic", "Anthropic Admin cost report");
  markMalformedCostRows(costFetch, "anthropic", "Anthropic Admin cost report");
  const claudeCodeFetches = await fetchDateRangeJson(fetcher, buildAnthropicClaudeCodeUrl, input.startTime, input.endTime, costRequest, "anthropic", "Anthropic Claude Code usage report");
  for (const fetchResult of claudeCodeFetches) {
    markMalformedUsageRows(fetchResult, "anthropic", "Anthropic Claude Code usage report");
  }
  const records = [
    ...costFetch.pages.flatMap((page) => normalizeAnthropicCostResponse(page, { sourceId, observedFrom: "Anthropic Admin Cost Report" })),
    ...claudeCodeFetches.flatMap((fetchResult) => fetchResult.pages.flatMap((page) => normalizeAnthropicClaudeCodeUsageResponse(page, { sourceId, observedFrom: "Anthropic Claude Code Usage Report", accountId: input.accountId })))
  ];
  return providerResult(
    "anthropic",
    sourceId,
    input.authReference,
    records,
    qaSummary("anthropic", [costFetch, ...claudeCodeFetches]),
    requestedCoverageInterval(input)
  );
}

async function fetchGitHubCopilot(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const accountId = input.org ?? input.enterprise;
  if (!accountId) throw new Error("GitHub Copilot connector requires --org or --enterprise.");
  const request = {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" }
  };
  const metricsManifestResponse = await fetchJsonOrThrow(fetcher, buildGitHubCopilotMetricsUrl(input), request, "github-copilot", "GitHub Copilot metrics manifest");
  const metricsManifest = metricsManifestResponse.payload;
  const metricsDownloadLinks = requireStringArray(metricsManifest, "download_links", "GitHub Copilot metrics manifest");
  const metricsFetch = await fetchGitHubCopilotSignedReports(fetcher, metricsDownloadLinks, metricsManifest, metricsManifestResponse.rateLimit);
  markMalformedUsageRows(metricsFetch, "github-copilot", "GitHub Copilot metrics reports");
  const seatFetch = input.org ? await fetchPaginatedJson(fetcher, buildGitHubCopilotSeatsUrl(input.org), request, "github-copilot", "GitHub Copilot seats") : undefined;
  if (seatFetch) assessGitHubCopilotSeatCompleteness(seatFetch);
  const metricsRecords = metricsFetch.pages.flatMap((page) => normalizeGitHubCopilotMetricsResponse(page, { sourceId, observedFrom: "GitHub Copilot metrics API", accountId }));
  const seatRecords = seatFetch ? seatFetch.pages.flatMap((page) => normalizeGitHubCopilotSeatResponse(page, { sourceId, observedFrom: "GitHub Copilot billing seats API", accountId })) : [];
  return providerResult(
    "github-copilot",
    sourceId,
    input.authReference,
    [...metricsRecords, ...seatRecords],
    qaSummary("github-copilot", [metricsFetch, ...(seatFetch ? [seatFetch] : [])])
  );
}

async function fetchCursor(input: ProviderConnectorInput, token: string, fetcher: Fetcher, sourceId: string): Promise<ProviderConnectorResult> {
  const accountId = input.accountId ?? input.org ?? "cursor-team";
  const spendFetch = await fetchCursorSpendPages(fetcher, token);
  const requested = input.reconciliation
    ? { expectation: input.reconciliation, invalidReason: invalidCursorReconciliationExpectationReason(input.reconciliation) }
    : parseCursorReconciliationEnv();
  const reconciliation = assessCursorReconciliation(spendFetch, requested.expectation, requested.invalidReason);
  const records = spendFetch.pages.flatMap((page) => normalizeCursorSpendResponse(page, { sourceId, observedFrom: "Cursor Admin API", accountId }, reconciliation));
  const qa = qaSummary("cursor", [spendFetch]);
  if (reconciliation) {
    // The outcome must survive the persisted-QA round trip, so it rides in
    // instructions (kept verbatim) and, on failure, in responseDrift.
    qa.instructions = [...qa.instructions, `Reconciliation ${reconciliation.status}: ${reconciliation.note}`];
    if (reconciliation.status !== "verified") {
      qa.responseDrift.push({
        label: "Cursor Admin API spend",
        field: "teamMemberSpend[].spendCents (cycle total)",
        issue: reconciliation.note
      });
    }
  }
  return providerResult(
    "cursor",
    sourceId,
    input.authReference,
    records,
    qa
  );
}

/**
 * Compare the connector's summed current-cycle on-demand total against the
 * operator-read dashboard/invoice figure. Every exit that is not an exact
 * window-proven match inside the clamped tolerance fails closed: the records
 * stay estimated and the note says exactly why. Returns undefined when no
 * reconciliation was requested.
 */
function assessCursorReconciliation(
  spendFetch: FetchPagesResult,
  expectation: CursorReconciliationExpectation | undefined,
  invalidReason: string | undefined
): CursorReconciliationOutcome | undefined {
  if (!expectation && !invalidReason) return undefined;
  if (invalidReason || !expectation) {
    return {
      status: "not_provable",
      note: `Cursor reconciliation input was rejected (${invalidReason ?? "missing expectation"}); records remain estimated.`
    };
  }
  if (spendFetch.pagination.stoppedBecause !== "complete" || spendFetch.coverageIncomplete === true) {
    return {
      status: "not_provable",
      note: `Cursor reconciliation requires a complete spend window; pagination stopped because "${spendFetch.pagination.stoppedBecause}" so a partial window cannot verify billed dollars. Records remain estimated.`
    };
  }
  const cycleStarts = spendFetch.pages.map((page) => isRecord(page) ? numberValue(page.subscriptionCycleStart) : undefined);
  const cycleStart = cycleStarts[0];
  if (typeof cycleStart !== "number" || cycleStarts.some((value) => value !== cycleStart)) {
    return {
      status: "not_provable",
      note: "Cursor did not report one consistent subscriptionCycleStart across spend pages; the reconciliation window cannot be proven. Records remain estimated."
    };
  }
  const cycleStartIso = new Date(cycleStart).toISOString();
  const apiCycleDate = cycleStartIso.slice(0, 10);
  const declaredDateMs = Date.parse(`${expectation.expectedCycleStartDate}T00:00:00Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(declaredDateMs) || Math.abs(Date.parse(`${apiCycleDate}T00:00:00Z`) - declaredDateMs) > dayMs) {
    return {
      status: "not_provable",
      cycleStartIso,
      note: `The declared cycle start ${expectation.expectedCycleStartDate} does not match the provider-reported cycle start ${apiCycleDate} (UTC); the dashboard figure and the connector read different windows. Records remain estimated.`
    };
  }
  const connectorTotalCents = spendFetch.pages.reduce<number>((sum, page) =>
    sum + extractArray(page, "teamMemberSpend").reduce<number>((pageSum, member) =>
      pageSum + (isRecord(member) ? numberValue(member.spendCents) ?? 0 : 0), 0), 0);
  const connectorTotalUsd = connectorTotalCents / 100;
  if (!(connectorTotalUsd > 0)) {
    return {
      status: "not_provable",
      cycleStartIso,
      connectorTotalUsd,
      expectedOnDemandUsd: expectation.expectedOnDemandUsd,
      note: "Cursor reconciliation needs a non-zero connector total; matching $0.00 against a dashboard figure proves nothing. Records remain estimated."
    };
  }
  // Default $0.01 (dashboards round to cents); clamp to at most 1% of the
  // expected figure so an oversized tolerance cannot manufacture a match.
  const requestedTolerance = Math.max(expectation.toleranceUsd ?? 0.01, 0.01);
  const toleranceUsd = Math.min(requestedTolerance, Math.max(0.01, expectation.expectedOnDemandUsd * 0.01));
  const differenceUsd = Math.abs(connectorTotalUsd - expectation.expectedOnDemandUsd);
  const shared = {
    connectorTotalUsd,
    expectedOnDemandUsd: expectation.expectedOnDemandUsd,
    differenceUsd,
    toleranceUsd,
    cycleStartIso
  };
  if (differenceUsd <= toleranceUsd + 1e-9) {
    return {
      status: "verified",
      ...shared,
      note: `reconciled to the operator-read dashboard/invoice on-demand total $${expectation.expectedOnDemandUsd.toFixed(2)} for the cycle starting ${apiCycleDate}: connector total $${connectorTotalUsd.toFixed(2)}, difference $${differenceUsd.toFixed(2)} within tolerance $${toleranceUsd.toFixed(2)}`
    };
  }
  return {
    status: "mismatch",
    ...shared,
    note: `Cursor reconciliation mismatch: connector on-demand total $${connectorTotalUsd.toFixed(2)} vs operator-read $${expectation.expectedOnDemandUsd.toFixed(2)} for the cycle starting ${apiCycleDate}; difference $${differenceUsd.toFixed(2)} exceeds tolerance $${toleranceUsd.toFixed(2)}. Records remain estimated until the totals agree.`
  };
}

async function fetchCursorSpendPages(fetcher: Fetcher, token: string): Promise<FetchPagesResult> {
  const label = "Cursor Admin API spend";
  const pages: unknown[] = [];
  const rateLimits: ProviderQaRateLimit[] = [];
  const responseDrift: ProviderQaDriftIssue[] = [];
  const maxPages = 50;
  const pageSize = 100;
  let expectedTotalPages: number | undefined;
  let expectedTotalMembers: number | undefined;
  let stoppedBecause: ProviderQaPagination["stoppedBecause"] = "complete";
  let note: string | undefined;

  for (let pageNumber = 1; pageNumber <= (expectedTotalPages ?? 1) && pageNumber <= maxPages; pageNumber += 1) {
    let response;
    try {
      response = await fetchJsonOrThrow(fetcher, "https://api.cursor.com/teams/spend", {
        method: "POST",
        headers: { Authorization: `Basic ${btoaCompat(`${token}:`)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ page: pageNumber, pageSize })
      }, "cursor", label);
    } catch (error) {
      if (pages.length === 0) throw error;
      stoppedBecause = "fetch_error";
      note = `Stopped after ${pages.length} page(s): ${sanitizeProviderMessage(error instanceof Error ? error.message : String(error))}`;
      break;
    }

    const page = response.payload;
    const pageMetadata = validateCursorSpendPage(page, pageNumber);
    if (expectedTotalPages === undefined) expectedTotalPages = pageMetadata.totalPages;
    if (expectedTotalMembers === undefined) expectedTotalMembers = pageMetadata.totalMembers;
    if (pageMetadata.totalPages !== expectedTotalPages || pageMetadata.totalMembers !== expectedTotalMembers) {
      stoppedBecause = "fetch_error";
      note = `Cursor pagination metadata changed on page ${pageNumber} (totalPages ${expectedTotalPages}→${pageMetadata.totalPages}, totalMembers ${expectedTotalMembers}→${pageMetadata.totalMembers}); results may be incomplete.`;
      pages.push(page);
      responseDrift.push({ label, field: "totalPages/totalMembers", issue: note });
      break;
    }
    pages.push(page);
    if (response.rateLimit) rateLimits.push(response.rateLimit);
    responseDrift.push(...detectResponseDrift(page, "cursor", label));
  }

  if ((expectedTotalPages ?? 0) > maxPages && stoppedBecause === "complete") {
    stoppedBecause = "max_pages";
    note = `Cursor reported ${expectedTotalPages} pages, exceeding the ${maxPages}-page connector limit.`;
  }
  const fetchedMembers = pages.reduce<number>((sum, page) => sum + extractArray(page, "teamMemberSpend").length, 0);
  if (stoppedBecause === "complete" && typeof expectedTotalMembers === "number" && fetchedMembers !== expectedTotalMembers) {
    stoppedBecause = "missing_cursor";
    note = `Cursor reported ${expectedTotalMembers} members but returned ${fetchedMembers}; refusing to mark the sync complete.`;
    responseDrift.push({ label, field: "totalMembers", issue: note });
  }

  return {
    pages,
    pagination: { label, pagesFetched: pages.length, stoppedBecause, maxPages, limitPerPage: pageSize, ...(note ? { note } : {}) },
    rateLimits,
    responseDrift
  };
}

function validateCursorSpendPage(page: unknown, pageNumber: number): { totalPages: number; totalMembers: number } {
  if (!isRecord(page) || !Array.isArray(page.teamMemberSpend)) {
    const fields = isRecord(page) ? Object.keys(page).slice(0, 8).join(", ") : typeof page;
    throw new Error(`Cursor spend page ${pageNumber} is missing canonical teamMemberSpend data (saw: ${fields}).`);
  }
  const totalPages = numberValue(page.totalPages);
  if (typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error(`Cursor spend page ${pageNumber} has invalid or missing totalPages; completeness cannot be proven.`);
  }
  const totalMembers = numberValue(page.totalMembers);
  if (typeof totalMembers !== "number" || !Number.isInteger(totalMembers) || totalMembers < 0) {
    throw new Error(`Cursor spend page ${pageNumber} has invalid or missing totalMembers; completeness cannot be proven.`);
  }
  for (const [index, member] of page.teamMemberSpend.entries()) {
    const spendCents = isRecord(member) ? numberValue(member.spendCents) : undefined;
    if (!isRecord(member) || (!stringValue(member.email) && !stringValue(member.userId)) || typeof spendCents !== "number" || spendCents < 0) {
      const fields = isRecord(member) ? Object.keys(member).slice(0, 8).join(", ") : typeof member;
      throw new Error(`Cursor spend page ${pageNumber} member ${index + 1} is missing email/userId or a non-negative spendCents value (saw: ${fields}).`);
    }
    if (member.fastPremiumRequests !== undefined && typeof nonNegativeIntegerValue(member.fastPremiumRequests) !== "number") {
      throw new Error(`Cursor spend page ${pageNumber} member ${index + 1} has an invalid fastPremiumRequests quantity; expected a non-negative integer.`);
    }
  }
  return { totalPages, totalMembers };
}

async function fetchGitHubCopilotSignedReports(
  fetcher: Fetcher,
  downloadLinks: string[],
  manifest: unknown,
  manifestRateLimit?: ProviderQaRateLimit
): Promise<FetchPagesResult> {
  const label = "GitHub Copilot metrics reports";
  const maxReports = 100;
  if (downloadLinks.length > maxReports) {
    throw new Error(`GitHub Copilot metrics manifest returned ${downloadLinks.length} report files, exceeding the ${maxReports}-file safety limit.`);
  }

  const pages: unknown[] = [];
  const responseDrift = detectResponseDrift(manifest, "github-copilot", "GitHub Copilot metrics manifest");
  for (const [index, candidate] of downloadLinks.entries()) {
    const safeUrl = validateSignedDownloadUrl(candidate);
    if (!safeUrl) {
      throw new Error(`GitHub Copilot metrics report ${index + 1} had an unsafe signed download URL; only public HTTPS URLs without embedded credentials are accepted.`);
    }
    const body = await fetchTextOrThrow(fetcher, safeUrl, {
      method: "GET",
      // Signed report URLs carry their own authorization. Never replay the
      // GitHub bearer token to a storage host.
      headers: { Accept: "application/x-ndjson, application/json" }
    }, "github-copilot", `GitHub Copilot metrics report ${index + 1}`);
    const reports = parseNdjsonReports(body, index + 1);
    if (reports.length === 0) {
      throw new Error(`GitHub Copilot metrics report ${index + 1} was empty; refusing to report a complete sync.`);
    }
    for (const report of reports) {
      if (!isRecord(report) || !Array.isArray(report.day_totals)) {
        const fields = isRecord(report) ? Object.keys(report).slice(0, 8).join(", ") : typeof report;
        throw new Error(`GitHub Copilot metrics report ${index + 1} did not contain the documented day_totals wrapper (saw: ${fields}).`);
      }
      pages.push(report);
      responseDrift.push(...detectResponseDrift(report, "github-copilot", label));
    }
  }

  return {
    pages,
    pagination: { label, pagesFetched: downloadLinks.length, stoppedBecause: "complete", maxPages: maxReports },
    rateLimits: manifestRateLimit ? [manifestRateLimit] : [],
    responseDrift
  };
}

async function fetchTextOrThrow(
  fetcher: Fetcher,
  url: string,
  request: { method?: string; headers?: Record<string, string>; body?: string },
  provider: string,
  label: string
): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxFetchRetries; attempt += 1) {
    const response = await fetcher(url, request);
    if (response.ok) {
      if (!response.text) throw new Error(`${label} did not expose a readable NDJSON body.`);
      return response.text();
    }
    const payload = await response.json().catch(() => undefined);
    lastError = providerRequestError(provider, label, response, payload);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxFetchRetries) break;
    const retryAfterSeconds = headerNumber(response.headers, "retry-after");
    const delayMs = typeof retryAfterSeconds === "number"
      ? Math.min(Math.max(retryAfterSeconds, 0) * 1000, maxRetryDelayMs)
      : 500 * 2 ** attempt;
    if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  throw lastError ?? new Error(`${label} request failed.`);
}

function parseNdjsonReports(body: string, reportNumber: number): unknown[] {
  const reports: unknown[] = [];
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [lineIndex, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`GitHub Copilot metrics report ${reportNumber} contains malformed NDJSON at line ${lineIndex + 1}.`);
    }
    if (Array.isArray(parsed)) reports.push(...parsed);
    else reports.push(parsed);
  }
  return reports;
}

function validateSignedDownloadUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return undefined;
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "::" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return undefined;
    if (/^0\./.test(hostname) || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return undefined;
    if (/^(?:fc|fd|fe[89ab])/i.test(hostname)) return undefined;
    const private172 = hostname.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function assessGitHubCopilotSeatCompleteness(fetchResult: FetchPagesResult): void {
  const expected = fetchResult.pages
    .map((page) => isRecord(page) ? numberValue(page.total_seats) : undefined)
    .find((value): value is number => typeof value === "number");
  const actual = fetchResult.pages.reduce<number>((sum, page) => sum + extractArray(page, "seats").length, 0);
  if (typeof expected !== "number") {
    if (fetchResult.pagination.stoppedBecause === "complete") fetchResult.pagination.stoppedBecause = "missing_cursor";
    fetchResult.pagination.note = "GitHub Copilot seats response omitted total_seats; completeness cannot be proven.";
    fetchResult.responseDrift.push({ label: "GitHub Copilot seats", field: "total_seats", issue: fetchResult.pagination.note });
  } else if (fetchResult.pagination.stoppedBecause === "complete" && actual !== expected) {
    fetchResult.pagination.stoppedBecause = "missing_cursor";
    fetchResult.pagination.note = `GitHub reported ${expected} seats but returned ${actual}; completeness cannot be proven.`;
    fetchResult.responseDrift.push({ label: "GitHub Copilot seats", field: "total_seats", issue: fetchResult.pagination.note });
  }
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
  let note: string | undefined;
  const maxPages = 50;
  const seenUrls = new Set<string>();
  for (let pageCount = 0; nextUrl && pageCount < maxPages; pageCount += 1) {
    if (seenUrls.has(nextUrl)) {
      stoppedBecause = "missing_cursor";
      note = `Stopped after ${pages.length} page(s): provider repeated a pagination URL.`;
      responseDrift.push({
        label,
        field: "next_page",
        issue: "provider repeated a pagination cursor; duplicate pages were not fetched"
      });
      nextUrl = undefined;
      break;
    }
    seenUrls.add(nextUrl);
    let response;
    try {
      response = await fetchJsonOrThrow(fetcher, nextUrl, request, provider, label);
    } catch (error) {
      // A mid-pagination failure (after retries) must not discard the pages
      // already fetched — return partial results with an explicit QA note.
      // A failure on the FIRST page (auth, bad scope) still throws.
      if (pages.length === 0) throw error;
      stoppedBecause = "fetch_error";
      note = `Stopped after ${pages.length} page(s): ${error instanceof Error ? error.message : String(error)}`;
      nextUrl = undefined;
      break;
    }
    const page = response.payload;
    pages.push(page);
    if (response.rateLimit) rateLimits.push(response.rateLimit);
    responseDrift.push(...detectResponseDrift(page, provider, label));
    const nextPage = nextPageFromPayload(page);
    const rawNextLink = nextUrlFromHeaders(response.headers);
    const safeNextLink = rawNextLink ? validatePaginationUrl(initialUrl, rawNextLink) : undefined;
    const hasMore = isRecord(page) && (page.has_more === true || page.hasMore === true || Boolean(nextPage) || Boolean(rawNextLink));
    if (rawNextLink && !safeNextLink) {
      stoppedBecause = "unsafe_next_link";
      responseDrift.push({
        label,
        field: "headers.link",
        issue: "rejected pagination URL because it was not HTTPS and same-origin with the provider endpoint"
      });
      nextUrl = undefined;
    } else if (safeNextLink) {
      nextUrl = safeNextLink;
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
    pagination: { label, pagesFetched: pages.length, stoppedBecause, maxPages, limitPerPage: limitPerPageFromUrl(initialUrl), ...(note ? { note } : {}) },
    rateLimits,
    responseDrift
  };
}

function enforceOpenAiRequestedWindow(
  fetchResult: FetchPagesResult,
  requestedStart: number,
  requestedEnd: number | undefined,
  label: string
): void {
  let excluded = 0;
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  fetchResult.pages = fetchResult.pages.map((page) => {
    if (!isRecord(page) || !Array.isArray(page.data)) return page;
    const data = page.data.filter((bucket) => {
      if (!isRecord(bucket)) return true;
      const start = validEpochSeconds(bucket.start_time);
      const hasEnd = bucket.end_time !== undefined;
      const end = hasEnd ? validEpochSeconds(bucket.end_time) : undefined;
      const invalidEnd = hasEnd && (typeof end !== "number" || typeof start !== "number" || end <= start);
      const missingRequiredEnd = typeof requestedEnd === "number" && typeof end !== "number";
      const outsideStart = typeof start !== "number" || start < requestedStart ||
        (typeof requestedEnd === "number" && start >= requestedEnd);
      const outsideEnd = typeof requestedEnd === "number" && typeof end === "number" && end > requestedEnd;
      const futureOpenEndedStart = requestedEnd === undefined && typeof start === "number" && start > nowEpochSeconds;
      if (!invalidEnd && !missingRequiredEnd && !outsideStart && !outsideEnd && !futureOpenEndedStart) return true;
      excluded += 1;
      fetchResult.responseDrift.push({
        label,
        field: "data[].start_time/end_time",
        issue: "bucket boundary was missing, invalid, future-starting, or outside the requested interval; the bucket was excluded"
      });
      return false;
    });
    return { ...page, data };
  });
  if (excluded > 0) fetchResult.coverageIncomplete = true;
}

function dedupeProviderRecords(records: UsageRecord[], fetches: FetchPagesResult[]): UsageRecord[] {
  const byId = new Map<string, UsageRecord>();
  const conflicted = new Set<string>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing && !conflicted.has(record.id)) {
      byId.set(record.id, record);
      continue;
    }
    const target = record.providerCostType === "openai_cost" ? fetches[0] : fetches[1];
    target.coverageIncomplete = true;
    target.responseDrift.push({
      label: target.pagination.label,
      field: "normalized records[].id",
      issue: existing && JSON.stringify(existing) === JSON.stringify(record)
        ? "duplicate provider record was excluded"
        : "conflicting provider records shared one stable identity; all conflicting rows were excluded"
    });
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      byId.delete(record.id);
      conflicted.add(record.id);
    }
  }
  return Array.from(byId.values());
}

function validatePaginationUrl(initialUrl: string, candidate: string): string | undefined {
  try {
    const initial = new URL(initialUrl);
    const next = new URL(candidate, initial);
    if (initial.protocol !== "https:" || next.protocol !== "https:" || next.origin !== initial.origin) {
      return undefined;
    }
    return next.toString();
  } catch {
    return undefined;
  }
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
  const maxRangeDays = 370;
  for (let cursor = startTime, count = 0; cursor <= finalTime && count < maxRangeDays; cursor += daySeconds, count += 1) {
    try {
      results.push(await fetchPaginatedJson(fetcher, buildUrl(cursor), request, provider, label));
    } catch (error) {
      // Persistent failure mid-range: keep the days already fetched and note
      // where the sync stopped instead of discarding everything. First-day
      // failures (bad auth/scope) still throw so the user sees the real error.
      if (results.length === 0) throw error;
      results.push({
        pages: [],
        pagination: {
          label,
          pagesFetched: 0,
          stoppedBecause: "fetch_error",
          maxPages: 50,
          note: `Day range stopped early after ${results.length} day(s): ${error instanceof Error ? error.message : String(error)}`
        },
        rateLimits: [],
        responseDrift: []
      });
      break;
    }
  }
  const lastCoveredTime = startTime + (maxRangeDays - 1) * daySeconds;
  if (finalTime > lastCoveredTime && results.every((result) => result.pagination.stoppedBecause !== "fetch_error")) {
    results.push({
      pages: [],
      pagination: {
        label,
        pagesFetched: 0,
        stoppedBecause: "max_range_days",
        maxPages: 50,
        note: `Requested range exceeds the ${maxRangeDays}-day connector limit; narrow the range or run multiple syncs.`
      },
      rateLimits: [],
      responseDrift: []
    });
  }
  return results;
}

/** Retries per request on 429/5xx before giving up (initial try + retries). */
const maxFetchRetries = 2;
/** Cap on how long a retry-after header can make us wait, per attempt. */
const maxRetryDelayMs = 30_000;

async function fetchJsonOrThrow(
  fetcher: Fetcher,
  url: string,
  request: { method?: string; headers?: Record<string, string>; body?: string },
  provider: string,
  label: string
): Promise<{ payload: unknown; rateLimit?: ProviderQaRateLimit; headers?: ProviderResponse["headers"] }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxFetchRetries; attempt += 1) {
    const response = await fetcher(url, request);
    const payload = await response.json().catch(() => undefined);
    if (response.ok) {
      return { payload, rateLimit: rateLimitFromHeaders(label, response.headers), headers: response.headers };
    }
    lastError = providerRequestError(provider, label, response, payload);
    // 429 and 5xx are transient: honor retry-after when present, otherwise
    // back off briefly and try again. 4xx auth/scope errors fail immediately.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxFetchRetries) {
      break;
    }
    const retryAfterSeconds = headerNumber(response.headers, "retry-after");
    const delayMs = typeof retryAfterSeconds === "number"
      ? Math.min(Math.max(retryAfterSeconds, 0) * 1000, maxRetryDelayMs)
      : 500 * 2 ** attempt;
    if (delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
  throw lastError ?? new Error(`${label} request failed.`);
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
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function hasHeaderGetter(headers: ProviderResponse["headers"]): headers is { get: (name: string) => string | null } {
  return typeof (headers as { get?: unknown } | undefined)?.get === "function";
}

function markMalformedCostRows(fetchResult: FetchPagesResult, provider: "openai" | "anthropic", label: string): void {
  const issues: ProviderQaDriftIssue[] = [];
  const maxDetailedIssues = 25;
  let issueCount = 0;
  const report = (field: string, issue: string) => {
    issueCount += 1;
    if (issues.length < maxDetailedIssues) issues.push({ label, field, issue });
  };

  for (const page of fetchResult.pages) {
    if (!isRecord(page) || !Array.isArray(page.data)) {
      report("data", "cost response omitted the canonical data array; no financial completeness claim is safe");
      continue;
    }
    for (const [bucketIndex, bucketValue] of page.data.entries()) {
      const bucketPath = `data[${bucketIndex}]`;
      if (!isRecord(bucketValue)) {
        report(bucketPath, "cost response contained a non-object billing bucket");
        continue;
      }
      if (provider === "openai") {
        if (typeof validEpochSeconds(bucketValue.start_time) !== "number") {
          report(`${bucketPath}.start_time`, "cost bucket had an invalid timestamp and its rows were excluded");
          continue;
        }
      } else if (!validDateTimeString(bucketValue.starting_at)) {
        report(`${bucketPath}.starting_at`, "cost bucket had an invalid timestamp and its rows were excluded");
        continue;
      }
      if (!Array.isArray(bucketValue.results)) {
        report(`${bucketPath}.results`, "cost bucket omitted the canonical results array");
        continue;
      }

      for (const [resultIndex, resultValue] of bucketValue.results.entries()) {
        const resultPath = `${bucketPath}.results[${resultIndex}]`;
        if (!isRecord(resultValue)) {
          report(resultPath, "cost response contained a non-object billed-cost row");
          continue;
        }
        if (provider === "openai") {
          const amount = isRecord(resultValue.amount) ? resultValue.amount : undefined;
          if (!amount) {
            report(`${resultPath}.amount`, "billed-cost row had no canonical amount object and was excluded");
            continue;
          }
          if (amount.currency !== undefined && (typeof amount.currency !== "string" || amount.currency.toLowerCase() !== "usd")) {
            report(`${resultPath}.amount.currency`, "billed-cost row used an invalid or unsupported currency and was excluded from the USD headline");
            continue;
          }
          if (typeof parseDollarUsd(amount.value) !== "number") {
            report(`${resultPath}.amount.value`, "billed-cost row had an invalid dollar amount and was excluded");
          }
          if (resultValue.quantity !== undefined && typeof nonNegativeNumberValue(resultValue.quantity) !== "number") {
            report(`${resultPath}.quantity`, "billed-cost row had a negative or invalid quantity; the quantity was excluded");
          }
          continue;
        }

        if (resultValue.currency !== undefined && (typeof resultValue.currency !== "string" || resultValue.currency.toLowerCase() !== "usd")) {
          report(`${resultPath}.currency`, "billed-cost row used an invalid or unsupported currency and was excluded from the USD headline");
          continue;
        }
        if (typeof parseMinorUsd(resultValue.amount) !== "number") {
          report(`${resultPath}.amount`, "billed-cost row had an invalid minor-unit amount and was excluded");
        }
      }
    }
  }

  if (issueCount === 0) return;
  if (issueCount > maxDetailedIssues) {
    issues.push({
      label,
      field: "data[].results[]",
      issue: `${issueCount - maxDetailedIssues} additional malformed billed-cost schema issue(s) were omitted from QA details`
    });
  }
  fetchResult.coverageIncomplete = true;
  fetchResult.responseDrift.push(...issues);
}

/**
 * Provider APIs are untrusted even after transport succeeds. A negative or
 * fractional token count cannot satisfy UsageRecord's finance-grade schema,
 * and a negative count/quantity cannot support a completeness claim. Keep any
 * independently valid evidence, but mark the whole source pull partial and
 * omit the invalid values during normalization.
 */
function markMalformedUsageRows(
  fetchResult: FetchPagesResult,
  provider: "openai" | "anthropic" | "github-copilot",
  label: string
): void {
  const issues: ProviderQaDriftIssue[] = [];
  const maxDetailedIssues = 25;
  let issueCount = 0;
  const report = (field: string, issue: string) => {
    issueCount += 1;
    if (issues.length < maxDetailedIssues) issues.push({ label, field, issue });
  };
  const checkInteger = (value: unknown, field: string, kind: "token count" | "quantity") => {
    if (value !== undefined && typeof nonNegativeIntegerValue(value) !== "number") {
      report(field, `${kind} must be a non-negative integer; the invalid value was excluded`);
    }
  };

  for (const page of fetchResult.pages) {
    if (provider === "openai") {
      if (!isRecord(page) || !Array.isArray(page.data)) {
        report("data", "usage response omitted the canonical data array; completeness cannot be proven");
        continue;
      }
      for (const [bucketIndex, bucketValue] of page.data.entries()) {
        const bucketPath = `data[${bucketIndex}]`;
        if (!isRecord(bucketValue) || !Array.isArray(bucketValue.results)) {
          report(bucketPath, "usage response contained a malformed bucket or omitted its results array");
          continue;
        }
        if (typeof validEpochSeconds(bucketValue.start_time) !== "number") {
          report(`${bucketPath}.start_time`, "usage bucket start_time must be a non-negative whole-second timestamp; the bucket was excluded");
        }
        for (const [resultIndex, resultValue] of bucketValue.results.entries()) {
          const resultPath = `${bucketPath}.results[${resultIndex}]`;
          if (!isRecord(resultValue)) {
            report(resultPath, "usage response contained a non-object usage row");
            continue;
          }
          for (const field of [
            "input_tokens",
            "input_uncached_tokens",
            "input_cache_write_tokens",
            "input_cached_tokens",
            "input_text_tokens",
            "input_image_tokens",
            "input_audio_tokens",
            "input_cached_text_tokens",
            "input_cached_image_tokens",
            "input_cached_audio_tokens",
            "output_tokens",
            "output_text_tokens",
            "output_image_tokens",
            "output_audio_tokens"
          ] as const) {
            checkInteger(resultValue[field], `${resultPath}.${field}`, "token count");
          }
          checkInteger(resultValue.num_model_requests, `${resultPath}.num_model_requests`, "quantity");

          const inputTotal = nonNegativeIntegerValue(resultValue.input_tokens);
          const outputTotal = nonNegativeIntegerValue(resultValue.output_tokens);
          const cachedTotal = nonNegativeIntegerValue(resultValue.input_cached_tokens);
          if (typeof inputTotal !== "number") {
            report(`${resultPath}.input_tokens`, "canonical input_tokens total is required; the usage row was excluded");
          }
          if (typeof outputTotal !== "number") {
            report(`${resultPath}.output_tokens`, "canonical output_tokens total is required; the usage row was excluded");
          }
          for (const field of [
            "input_uncached_tokens",
            "input_cache_write_tokens",
            "input_cached_tokens",
            "input_text_tokens",
            "input_image_tokens",
            "input_audio_tokens",
            "input_cached_text_tokens",
            "input_cached_image_tokens",
            "input_cached_audio_tokens"
          ] as const) {
            const component = nonNegativeIntegerValue(resultValue[field]);
            if (typeof component === "number" && typeof inputTotal === "number" && component > inputTotal) {
              report(`${resultPath}.${field}`, "input component exceeds the inclusive input_tokens total; the component was excluded");
            }
          }
          for (const field of ["output_text_tokens", "output_image_tokens", "output_audio_tokens"] as const) {
            const component = nonNegativeIntegerValue(resultValue[field]);
            if (typeof component === "number" && typeof outputTotal === "number" && component > outputTotal) {
              report(`${resultPath}.${field}`, "output component exceeds the inclusive output_tokens total; the component was excluded");
            }
          }
          for (const field of [
            "input_cached_text_tokens",
            "input_cached_image_tokens",
            "input_cached_audio_tokens"
          ] as const) {
            const component = nonNegativeIntegerValue(resultValue[field]);
            if (typeof component === "number" && typeof cachedTotal === "number" && component > cachedTotal) {
              report(`${resultPath}.${field}`, "cached component exceeds input_cached_tokens; the component was excluded");
            }
          }
          if (typeof cachedTotal !== "number" && [
            resultValue.input_cached_text_tokens,
            resultValue.input_cached_image_tokens,
            resultValue.input_cached_audio_tokens
          ].some((value) => typeof nonNegativeIntegerValue(value) === "number")) {
            report(`${resultPath}.input_cached_*_tokens`, "cached modality components require input_cached_tokens; the component family was excluded");
          }
          const reportFamilyOverflow = (fields: readonly string[], parent: number | undefined, parentField: string) => {
            if (typeof parent !== "number") return;
            const values = fields.map((field) => nonNegativeIntegerValue(resultValue[field]));
            const present = values.filter((value): value is number => typeof value === "number");
            if (present.reduce((sum, value) => sum + value, 0) > parent) {
              report(`${resultPath}.${fields.join("+")}`, `component family exceeds ${parentField}; the contradictory component family was excluded`);
            }
          };
          reportFamilyOverflow(["input_uncached_tokens", "input_cache_write_tokens", "input_cached_tokens"], inputTotal, "input_tokens");
          reportFamilyOverflow(["input_text_tokens", "input_image_tokens", "input_audio_tokens"], inputTotal, "input_tokens");
          reportFamilyOverflow(["input_cached_text_tokens", "input_cached_image_tokens", "input_cached_audio_tokens"], cachedTotal, "input_cached_tokens");
          reportFamilyOverflow(["output_text_tokens", "output_image_tokens", "output_audio_tokens"], outputTotal, "output_tokens");
        }
      }
      continue;
    }

    if (provider === "anthropic") {
      if (!isRecord(page) || !Array.isArray(page.data)) {
        report("data", "Claude Code usage response omitted the canonical data array; completeness cannot be proven");
        continue;
      }
      for (const [rowIndex, rowValue] of page.data.entries()) {
        const rowPath = `data[${rowIndex}]`;
        if (!isRecord(rowValue)) {
          report(rowPath, "Claude Code usage response contained a non-object row");
          continue;
        }
        const core = isRecord(rowValue.core_metrics) ? rowValue.core_metrics : {};
        const lines = isRecord(core.lines_of_code) ? core.lines_of_code : {};
        checkInteger(core.num_sessions, `${rowPath}.core_metrics.num_sessions`, "quantity");
        checkInteger(lines.added, `${rowPath}.core_metrics.lines_of_code.added`, "quantity");
        checkInteger(lines.removed, `${rowPath}.core_metrics.lines_of_code.removed`, "quantity");
        checkInteger(core.commits_by_claude_code, `${rowPath}.core_metrics.commits_by_claude_code`, "quantity");
        checkInteger(core.pull_requests_by_claude_code, `${rowPath}.core_metrics.pull_requests_by_claude_code`, "quantity");
        const modelBreakdown = Array.isArray(rowValue.model_breakdown) ? rowValue.model_breakdown : [];
        for (const [modelIndex, modelValue] of modelBreakdown.entries()) {
          const modelPath = `${rowPath}.model_breakdown[${modelIndex}]`;
          if (!isRecord(modelValue)) {
            report(modelPath, "Claude Code usage response contained a non-object model row");
            continue;
          }
          const tokens = isRecord(modelValue.tokens) ? modelValue.tokens : {};
          for (const field of ["input", "output", "cache_read", "cache_creation"] as const) {
            checkInteger(tokens[field], `${modelPath}.tokens.${field}`, "token count");
          }
        }
      }
      continue;
    }

    if (!isRecord(page) || !Array.isArray(page.day_totals)) {
      report("day_totals", "Copilot metrics response omitted the canonical day_totals array; completeness cannot be proven");
      continue;
    }
    for (const [dayIndex, dayValue] of page.day_totals.entries()) {
      const dayPath = `day_totals[${dayIndex}]`;
      if (!isRecord(dayValue)) {
        report(dayPath, "Copilot metrics response contained a non-object day row");
        continue;
      }
      checkInteger(dayValue.daily_active_users, `${dayPath}.daily_active_users`, "quantity");
      const featureRows = Array.isArray(dayValue.totals_by_model_feature) ? dayValue.totals_by_model_feature : [];
      for (const [featureIndex, featureValue] of featureRows.entries()) {
        if (!isRecord(featureValue)) {
          report(`${dayPath}.totals_by_model_feature[${featureIndex}]`, "Copilot metrics response contained a non-object feature row");
          continue;
        }
        const featurePath = `${dayPath}.totals_by_model_feature[${featureIndex}]`;
        for (const field of ["engaged_users", "total_requests", "user_initiated_interaction_count"] as const) {
          checkInteger(featureValue[field], `${featurePath}.${field}`, "quantity");
        }
      }
      const cli = isRecord(dayValue.totals_by_cli) ? dayValue.totals_by_cli : undefined;
      if (!cli) continue;
      for (const field of ["request_count", "prompt_count", "session_count", "engaged_users", "total_requests"] as const) {
        checkInteger(cli[field], `${dayPath}.totals_by_cli.${field}`, "quantity");
      }
      const tokenUsage = isRecord(cli.token_usage) ? cli.token_usage : undefined;
      if (!tokenUsage) continue;
      checkInteger(tokenUsage.prompt_tokens_sum, `${dayPath}.totals_by_cli.token_usage.prompt_tokens_sum`, "token count");
      checkInteger(tokenUsage.output_tokens_sum, `${dayPath}.totals_by_cli.token_usage.output_tokens_sum`, "token count");
    }
  }

  if (issueCount === 0) return;
  if (issueCount > maxDetailedIssues) {
    issues.push({
      label,
      field: "usage rows",
      issue: `${issueCount - maxDetailedIssues} additional malformed usage schema issue(s) were omitted from QA details`
    });
  }
  fetchResult.coverageIncomplete = true;
  fetchResult.responseDrift.push(...issues);
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
  // Every provider MUST enumerate the fields its normalizer consumes; a
  // fall-through to `common` alone flags every legitimate field of every page
  // as drift, burying real drift signals in thousands of false positives.
  const common = ["data", "data[]", "has_more", "hasMore", "next_page", "nextPage", "object", "links", "links.next"];
  if (provider === "openai" && label.includes("costs")) {
    return new Set([...common, "data[].object", "data[].start_time", "data[].start_time_iso", "data[].end_time", "data[].end_time_iso", "data[].results", "data[].results[]", "data[].results[].object", "data[].results[].amount", "data[].results[].amount.value", "data[].results[].amount.currency", "data[].results[].line_item", "data[].results[].organization_id", "data[].results[].organization_name", "data[].results[].project_id", "data[].results[].project_name", "data[].results[].user_id", "data[].results[].user_email", "data[].results[].api_key_id", "data[].results[].quantity"]);
  }
  if (provider === "openai" && label.includes("usage")) {
    return new Set([...common, "data[].object", "data[].start_time", "data[].start_time_iso", "data[].end_time", "data[].end_time_iso", "data[].results", "data[].results[]", "data[].results[].object", "data[].results[].input_tokens", "data[].results[].input_uncached_tokens", "data[].results[].input_cache_write_tokens", "data[].results[].input_cached_tokens", "data[].results[].input_text_tokens", "data[].results[].input_image_tokens", "data[].results[].input_audio_tokens", "data[].results[].input_cached_text_tokens", "data[].results[].input_cached_image_tokens", "data[].results[].input_cached_audio_tokens", "data[].results[].output_tokens", "data[].results[].output_text_tokens", "data[].results[].output_image_tokens", "data[].results[].output_audio_tokens", "data[].results[].num_model_requests", "data[].results[].project_id", "data[].results[].user_id", "data[].results[].api_key_id", "data[].results[].model", "data[].results[].batch", "data[].results[].service_tier"]);
  }
  if (provider === "anthropic" && label.toLowerCase().includes("cost")) {
    return new Set([...common, "data[].starting_at", "data[].ending_at", "data[].results", "data[].results[]", "data[].results[].amount", "data[].results[].currency", "data[].results[].cost_type", "data[].results[].description", "data[].results[].model", "data[].results[].workspace_id", "data[].results[].token_type", "data[].results[].service_tier", "data[].results[].context_window", "data[].results[].inference_geo"]);
  }
  if (provider === "anthropic" && label.toLowerCase().includes("claude code")) {
    return new Set([...common, "data[].date", "data[].actor", "data[].actor.email_address", "data[].actor.api_key_name", "data[].actor.id", "data[].actor.type", "data[].organization_id", "data[].customer_type", "data[].terminal_type", "data[].subscription_type", "data[].core_metrics", "data[].core_metrics.num_sessions", "data[].core_metrics.lines_of_code", "data[].core_metrics.lines_of_code.added", "data[].core_metrics.lines_of_code.removed", "data[].core_metrics.commits_by_claude_code", "data[].core_metrics.pull_requests_by_claude_code", "data[].model_breakdown", "data[].model_breakdown[]", "data[].model_breakdown[].model", "data[].model_breakdown[].tokens", "data[].model_breakdown[].tokens.input", "data[].model_breakdown[].tokens.output", "data[].model_breakdown[].tokens.cache_read", "data[].model_breakdown[].tokens.cache_creation", "data[].model_breakdown[].estimated_cost", "data[].model_breakdown[].estimated_cost.currency", "data[].model_breakdown[].estimated_cost.amount", "data[].tool_actions", "data[].tool_actions[]"]);
  }
  if (provider === "github-copilot" && label.toLowerCase().includes("metrics")) {
    return new Set([...common, "download_links", "download_links[]", "day_totals", "day_totals[]", "day_totals[].day", "day_totals[].daily_active_users", "day_totals[].totals_by_model_feature", "day_totals[].totals_by_model_feature[]", "day_totals[].totals_by_model_feature[].model", "day_totals[].totals_by_model_feature[].feature", "day_totals[].totals_by_model_feature[].engaged_users", "day_totals[].totals_by_model_feature[].total_requests", "day_totals[].totals_by_model_feature[].user_initiated_interaction_count", "day_totals[].totals_by_cli", "day_totals[].totals_by_cli.request_count", "day_totals[].totals_by_cli.prompt_count", "day_totals[].totals_by_cli.session_count", "day_totals[].totals_by_cli.token_usage", "day_totals[].totals_by_cli.token_usage.prompt_tokens_sum", "day_totals[].totals_by_cli.token_usage.output_tokens_sum", "day_totals[].totals_by_cli.token_usage.avg_tokens_per_request", "day_totals[].totals_by_cli.engaged_users", "day_totals[].totals_by_cli.total_requests", "report_start_day", "report_end_day", "created_at", "generated_at", "etl_id", "day_partition", "entity_id_partition", "enterprise_id", "organization_id"]);
  }
  if (provider === "github-copilot" && label.toLowerCase().includes("seats")) {
    return new Set([...common, "total_seats", "seats", "seats[]", "seats[].created_at", "seats[].updated_at", "seats[].pending_cancellation_date", "seats[].last_activity_at", "seats[].last_activity_editor", "seats[].last_authenticated_at", "seats[].plan_type", "seats[].login", "seats[].id", "seats[].assignee", "seats[].assignee.login", "seats[].assignee.email", "seats[].assignee.id", "seats[].assignee.node_id", "seats[].assignee.avatar_url", "seats[].assignee.html_url", "seats[].assignee.type", "seats[].assignee.site_admin", "seats[].assigning_team", "seats[].organization"]);
  }
  if (provider === "cursor") {
    return new Set([
      ...common,
      "teamMemberSpend", "teamMemberSpend[]", "teamMemberSpend[].userId", "teamMemberSpend[].email", "teamMemberSpend[].name", "teamMemberSpend[].role", "teamMemberSpend[].spendCents", "teamMemberSpend[].fastPremiumRequests", "teamMemberSpend[].hardLimitOverrideDollars",
      // Documented in the 2026 Admin API reference alongside spendCents.
      "teamMemberSpend[].overallSpendCents", "teamMemberSpend[].monthlyLimitDollars", "teamMemberSpend[].effectivePerUserLimitDollars",
      // Present in live responses and staff-acknowledged as a docs lag
      // (forum.cursor.com thread 162742, "docs for Get Spending Data are
      // behind the current API schema"). billingTier and the percent fields
      // are tiered-team-only and may be undefined elsewhere.
      "teamMemberSpend[].includedSpendCents", "teamMemberSpend[].profilePictureUrl", "teamMemberSpend[].billingTier", "teamMemberSpend[].autoPercentUsed", "teamMemberSpend[].apiPercentUsed", "teamMemberSpend[].totalPercentUsed",
      "subscriptionCycleStart", "totalMembers", "totalPages"
    ]);
  }
  return new Set([...common]);
}

function qaSummary(provider: string, fetches: FetchPagesResult[]): ProviderQaSummary {
  return {
    provider,
    coverage: fetches.every((fetchResult) =>
      fetchResult.pagination.stoppedBecause === "complete" && fetchResult.coverageIncomplete !== true
    ) ? "complete" : "partial",
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
      "Cursor's 2026 docs list the Admin API under Enterprise teams; individual Pro/Ultra plans expose no billing API. Standard Admin API endpoints are rate-limited to 20 requests/minute per team.",
      "spendCents is on-demand spend for the current billing cycle; seat fees and included-pool usage are not in this total.",
      "Validate user-level spend against invoices before treating the source as finance-grade; set AI_SPEND_CURSOR_RECONCILE_EXPECTED_USD and AI_SPEND_CURSOR_RECONCILE_CYCLE_START to run an in-sync reconciliation."
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

function providerRequestError(
  provider: string,
  label: string,
  response: ProviderResponse,
  payload: unknown
): ProviderConnectorError {
  const authenticationFailure = response.status === 401 || response.status === 403;
  return new ProviderConnectorError(
    providerPermissionPrompt(provider, label, response, payload),
    {
      code: authenticationFailure ? "authentication_error" : "provider_request_error",
      status: response.status
    }
  );
}

function extractProviderMessage(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const error = isRecord(payload.error) ? payload.error : undefined;
  return stringValue(error?.message) ?? stringValue(payload.message) ?? "";
}

function sanitizeProviderMessage(message: string): string {
  // Provider error bodies/status text are terminal-facing untrusted input.
  // Strip controls first so an escape sequence cannot split a secret pattern,
  // then apply the product-wide redaction rules.
  return redactSecrets(stripTerminalControlSequences(message))
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]")
    .trim();
}

function stripTerminalControlSequences(message: string): string {
  return message
    // OSC (window title, hyperlinks, clipboard), terminated by BEL/ST or EOF.
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "")
    // DCS/SOS/PM/APC string controls, terminated by ST or EOF.
    .replace(/(?:\u001b(?:P|X|\^|_)|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu, "")
    // CSI plus remaining two-character ESC sequences.
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    // Prevent line/status injection while keeping words readable.
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ");
}

export function summarizeProviderFinancials(records: UsageRecord[]): ProviderFinancialSummary {
  const providerReportedBilledUsd = sumAmounts(records.filter((record) => record.costConfidence === "verified"));
  const apiEquivalentEstimatedUsd = sumAmounts(records.filter((record) =>
    record.providerCostType === "anthropic_claude_code_usage" && record.costConfidence === "estimated"
  ));
  const providerEstimatedUsd = sumAmounts(records.filter((record) =>
    record.costConfidence === "estimated" && record.providerCostType !== "anthropic_claude_code_usage"
  ));

  if (providerReportedBilledUsd !== null) {
    return { providerReportedBilledUsd, apiEquivalentEstimatedUsd, providerEstimatedUsd, headlineUsd: providerReportedBilledUsd, headlineBasis: "provider_reported_billed_cost" };
  }
  if (apiEquivalentEstimatedUsd !== null) {
    return { providerReportedBilledUsd, apiEquivalentEstimatedUsd, providerEstimatedUsd, headlineUsd: apiEquivalentEstimatedUsd, headlineBasis: "api_equivalent_estimate" };
  }
  if (providerEstimatedUsd !== null) {
    return { providerReportedBilledUsd, apiEquivalentEstimatedUsd, providerEstimatedUsd, headlineUsd: providerEstimatedUsd, headlineBasis: "provider_estimated_cost" };
  }
  return { providerReportedBilledUsd, apiEquivalentEstimatedUsd, providerEstimatedUsd, headlineUsd: null, headlineBasis: "unavailable" };
}

export function providerFinancialCompleteness(
  records: UsageRecord[],
  coverage: ProviderCoverageStatus
): ProviderConnectorResult["completeness"] {
  const financials = summarizeProviderFinancials(records);
  const headlineConfidence: ProviderConnectorResult["completeness"] =
    financials.headlineBasis === "provider_reported_billed_cost"
      ? "verified"
      : financials.headlineBasis === "unavailable"
        ? "missing"
        : "estimated";
  return coverage === "partial" && headlineConfidence !== "missing"
    ? "detected_unverified"
    : headlineConfidence;
}

/**
 * Keep evidence records available to callers, but never add estimates to a
 * provider's official billed total. This selection is intended for aggregate
 * spend headlines; callers should retain the original records for attribution.
 */
export function selectProviderFinancialHeadlineRecords(records: UsageRecord[]): UsageRecord[] {
  const byProvider = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const providerRecords = byProvider.get(record.source.provider) ?? [];
    providerRecords.push(record);
    byProvider.set(record.source.provider, providerRecords);
  }
  return Array.from(byProvider.values()).flatMap((providerRecords) => {
    const hasProviderBilledCost = providerRecords.some((record) =>
      record.costConfidence === "verified" && typeof record.amountUsd === "number"
    );
    return hasProviderBilledCost
      ? providerRecords.filter((record) => record.costConfidence === "verified" || record.amountUsd === null)
      : providerRecords;
  });
}

/** Inputs that determine which provider account (org/team) one sync reads. */
export type ProviderAccountKeyInput = {
  provider: string;
  authReference: string;
  org?: string;
  enterprise?: string;
  accountId?: string;
};

/**
 * Stable identity for one provider account (an OpenAI/Anthropic organization,
 * a Cursor team, a GitHub org/enterprise). Admin credentials are account-
 * scoped and multi-account setups are common, so records from different
 * accounts of one provider must coexist instead of replacing each other.
 *
 * The key prefers the explicit account flag the connector already requires
 * (--org/--enterprise/--account-id, which can share one credential); it
 * otherwise falls back to the user-chosen credential REFERENCE NAME
 * (e.g. "env:OPENAI_ADMIN_KEY_ORG2") — stable, printable, and never derived
 * from secret material. A provider-reported organization id would be
 * preferable, but the cost APIs aibill calls do not reliably return one
 * (the OpenAI costs request groups by project/line-item/api-key only), and a
 * sometimes-present key would split one account into two slices.
 */
export function providerAccountKey(input: ProviderAccountKeyInput): string {
  if (input.org) return `org:${input.org}`;
  if (input.enterprise) return `enterprise:${input.enterprise}`;
  if (input.accountId) return `account:${input.accountId}`;
  return input.authReference;
}

/**
 * Deterministic short digest of the RAW account key. The slug alone is not
 * injective — cursor `--account-id "team a"` and `--account-id "team-a"`
 * both slug to `team-a` — so the record-id prefix carries this digest of the
 * raw identity: distinct account keys can never share a record-id namespace,
 * while the same key always regenerates the same digest (idempotent
 * re-sync). Never derived from secret material: account keys are reference
 * names and explicit account flags by construction.
 */
function providerAccountKeyDigest(accountKey: string): string {
  return createHash("sha256").update(accountKey, "utf8").digest("hex").slice(0, 8);
}

/** The deterministic record-id prefix for one account slice. */
export function providerAccountRecordIdPrefix(accountKey: string): string {
  return `${slugifySourceId(accountKey)}-${providerAccountKeyDigest(accountKey)}`;
}

/**
 * Stamp one sync's records with their account slice. The record id gains a
 * deterministic account prefix (slug + raw-key digest) so identical usage
 * buckets from two accounts of the same provider can never collide into one
 * row id — even for slug-equivalent account spellings — and re-syncing the
 * same account regenerates the same ids (idempotent replace).
 *
 * Migration note: slices tagged by the short-lived pre-digest format
 * (slug-only prefix) are superseded on their next re-sync — same-account
 * replacement keys on `source.account`, never on id shape — and any
 * colliding pre-digest rows already persisted are excluded fail-closed by
 * the id-conflict guard in {@link retainProviderRecordsForNewSync}.
 */
export function tagProviderAccountRecords(
  records: readonly UsageRecord[],
  accountKey: string
): UsageRecord[] {
  const prefix = providerAccountRecordIdPrefix(accountKey);
  return records.map((record) => ({
    ...record,
    id: `${prefix}-${record.id}`,
    source: { ...record.source, account: accountKey }
  }));
}

/**
 * Records from a prior trusted snapshot that must survive a new sync of
 * `provider` + `accountKey`: every other provider's records, plus this
 * provider's records that belong to a DIFFERENT named account slice.
 * Re-syncing the same account replaces its own slice. Records with no account
 * label (synced before multi-account support) are replaced too — fail-closed:
 * they cannot be proven to come from a different account, and keeping them
 * could double-count the same organization.
 *
 * Id-conflict guard: a retained record may never share an id with a newly
 * synced record, nor with another retained record. Colliding ids describe
 * the same underlying row (possible only in state written by the pre-digest
 * prefix format, where slug-equivalent account spellings collided) — keeping
 * both would double-count, so the copy that is not part of the fresh sync is
 * dropped fail-closed.
 */
export function retainProviderRecordsForNewSync(
  priorRecords: readonly UsageRecord[],
  provider: string,
  accountKey: string,
  syncedRecords: readonly UsageRecord[]
): UsageRecord[] {
  const syncedIds = new Set(syncedRecords.map((record) => record.id));
  const seenIds = new Set<string>();
  return priorRecords.filter((record) => {
    const replacedSlice = record.source.provider === provider &&
      !(typeof record.source.account === "string" && record.source.account !== accountKey);
    if (replacedSlice) return false;
    if (syncedIds.has(record.id) || seenIds.has(record.id)) return false;
    seenIds.add(record.id);
    return true;
  });
}

export type ProviderAccountSlice = {
  /** Account key, or null for records synced before multi-account support. */
  account: string | null;
  recordCount: number;
  /** Sum of this slice's verified provider-billed rows; null when none. */
  billedUsd: number | null;
};

/** Group one provider's records into per-account slices for honest display. */
export function providerAccountSlices(
  records: readonly UsageRecord[],
  provider: string
): ProviderAccountSlice[] {
  const slices = new Map<string | null, { recordCount: number; billedUsd: number | null }>();
  for (const record of records) {
    if (record.source.provider !== provider) continue;
    const key = record.source.account ?? null;
    const slice = slices.get(key) ?? { recordCount: 0, billedUsd: null };
    slice.recordCount += 1;
    if (record.costConfidence === "verified" && typeof record.amountUsd === "number") {
      slice.billedUsd = (slice.billedUsd ?? 0) + record.amountUsd;
    }
    slices.set(key, slice);
  }
  return [...slices.entries()]
    .map(([account, slice]) => ({ account, ...slice }))
    .sort((left, right) => (left.account ?? "").localeCompare(right.account ?? ""));
}

/**
 * Intersection of two claimed coverage windows — the interval every account
 * slice of a provider actually covers. Returns undefined when either window
 * is absent/malformed or the windows do not overlap (fail-closed: no window
 * is claimed rather than an overstated one).
 */
export function intersectProviderCoverageIntervals(
  left: ProviderCoverageInterval | undefined,
  right: ProviderCoverageInterval | undefined
): ProviderCoverageInterval | undefined {
  if (!left || !right) return undefined;
  if (
    typeof left.coverageStart !== "string" || typeof left.coverageEnd !== "string" ||
    typeof right.coverageStart !== "string" || typeof right.coverageEnd !== "string"
  ) {
    return undefined;
  }
  const coverageStart = left.coverageStart > right.coverageStart
    ? left.coverageStart
    : right.coverageStart;
  const coverageEnd = left.coverageEnd < right.coverageEnd
    ? left.coverageEnd
    : right.coverageEnd;
  return coverageStart <= coverageEnd ? { coverageStart, coverageEnd } : undefined;
}

/**
 * Printable slice list, e.g.
 * `env:OPENAI_ADMIN_KEY (6 records, billed $0.81) + env:OPENAI_ADMIN_KEY_ORG2 (18 records, billed $8.66)`.
 */
export function formatProviderAccountSlices(slices: readonly ProviderAccountSlice[]): string {
  return slices.map((slice) => {
    const label = slice.account ?? "earlier sync (unlabeled account)";
    const billed = slice.billedUsd === null ? "" : `, billed ${formatProviderUsd(slice.billedUsd)}`;
    return `${label} (${slice.recordCount} record${slice.recordCount === 1 ? "" : "s"}${billed})`;
  }).join(" + ");
}

function sumAmounts(records: UsageRecord[]): number | null {
  const amounts = records
    .map((record) => record.amountUsd)
    .filter((amount): amount is number => typeof amount === "number");
  return amounts.length > 0 ? amounts.reduce((sum, amount) => sum + amount, 0) : null;
}

function providerResult(
  provider: string,
  sourceId: string,
  authReference: string,
  records: UsageRecord[],
  qa?: ProviderQaSummary,
  coverageInterval?: ProviderCoverageInterval
): ProviderConnectorResult {
  const resolvedQa = qa ?? qaSummary(provider, []);
  const coverage: ProviderCoverageStatus = resolvedQa.coverage
    ?? (resolvedQa.pagination.every((pagination) => pagination.stoppedBecause === "complete") ? "complete" : "partial");
  const financials = summarizeProviderFinancials(records);
  const completeness = providerFinancialCompleteness(records, coverage);
  return {
    provider,
    source: createProviderConnection({ provider, sourceId, authReference, verifiedRecordCount: records.length, totalUsd: financials.headlineUsd, completeness }),
    records,
    fetchedAt: new Date().toISOString(),
    coverage,
    ...(coverageInterval ? { coverageInterval } : {}),
    financials,
    completeness,
    qa: resolvedQa
  };
}

function requestedCoverageInterval(
  input: Pick<ProviderConnectorInput, "startTime" | "endTime">
): ProviderCoverageInterval | undefined {
  if (!Number.isFinite(input.startTime) || !Number.isInteger(input.startTime) || input.startTime < 0) {
    throw new Error("Provider coverage startTime requires a non-negative whole-second timestamp.");
  }
  const coverageStart = new Date(input.startTime * 1_000);
  if (Number.isNaN(coverageStart.getTime())) {
    throw new Error("Provider coverage interval falls outside the supported timestamp range.");
  }
  if (input.endTime === undefined) {
    if (coverageStart.getTime() > Date.now()) {
      throw new Error("Provider coverage startTime cannot be in the future.");
    }
    return undefined;
  }
  if (!Number.isFinite(input.endTime) || !Number.isInteger(input.endTime) ||
      input.endTime < input.startTime) {
    throw new Error("Provider coverage interval requires non-negative whole-second bounds with endTime at or after startTime.");
  }
  const coverageEnd = new Date(input.endTime * 1_000);
  if (Number.isNaN(coverageEnd.getTime())) {
    throw new Error("Provider coverage interval falls outside the supported timestamp range.");
  }
  if (coverageEnd.getTime() > Date.now()) {
    throw new Error("Provider coverage endTime cannot be in the future.");
  }
  return {
    coverageStart: coverageStart.toISOString(),
    coverageEnd: coverageEnd.toISOString()
  };
}

export function createProviderConnection(input: CreateProviderConnectionInput): ApprovedSource {
  const source = createProviderConnectorStub(input.provider, "provider_api", input.fetchedAt);
  const total = input.totalUsd === null ? "an unavailable financial headline" : formatProviderUsd(input.totalUsd);
  const financialEvidence = input.completeness ?? "verified";
  const fulfilledBySuccessfulSync = new Set(providerConnectionPrerequisiteFields[input.provider] ?? [
    "approved account/API/export source"
  ]);
  const fieldsMissing = source.fieldsMissing.filter((field) => !fulfilledBySuccessfulSync.has(field));
  if (financialEvidence === "missing" || input.totalUsd === null) {
    fieldsMissing.push("provider financial headline");
  }
  return {
    ...source,
    id: input.sourceId ?? source.id,
    validationCoverage: validationCoverageForCompletedProviderSync(input.provider),
    financialEvidence,
    authReference: input.authReference,
    // A successful request satisfies credentials/setup, not permanent product
    // coverage gaps such as invoice settlement or unsupported usage families.
    fieldsMissing: Array.from(new Set(fieldsMissing)),
    scope: `${source.scope} Last successful pull produced ${input.verifiedRecordCount} record(s); financial evidence: ${financialEvidence}; financial headline: ${total}.`
  };
}

const providerConnectionPrerequisiteFields: Record<string, readonly string[]> = {
  openai: ["OpenAI Admin API key reference"],
  anthropic: ["Anthropic Admin API key reference"],
  cursor: ["Cursor team Admin API key reference"],
  "github-copilot": ["GitHub admin token reference and organization or enterprise slug"],
  codex: ["OpenAI Admin API key reference"]
};

function validationCoverageForCompletedProviderSync(provider: string): ApprovedSource["validationCoverage"] {
  if (provider === "openai" || provider === "anthropic") return "live_verified";
  if (provider === "cursor" || provider === "github-copilot" || provider === "copilot") {
    return "fixture_verified";
  }
  return "untested";
}

function formatProviderUsd(value: number): string {
  return value > 0 && value < 0.01 ? "less than $0.01" : `$${value.toFixed(2)}`;
}

export function resolveTokenReference(reference: string, env: Record<string, string | undefined> = process.env): string {
  if (!reference.startsWith("env:")) {
    throw new ProviderConnectorError(
      "Provider auth reference must be a local reference such as env:OPENAI_ADMIN_KEY; raw secrets are not accepted.",
      { code: "authentication_error" }
    );
  }
  const envName = reference.slice("env:".length);
  if (!/^[A-Z0-9_]+$/.test(envName)) {
    throw new ProviderConnectorError(
      "Provider auth env reference must use an uppercase environment variable name.",
      { code: "authentication_error" }
    );
  }
  const value = env[envName];
  if (!value) {
    throw new ProviderConnectorError(
      `Provider auth reference ${reference} is not set in the local environment.`,
      { code: "authentication_error" }
    );
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
  if (endTime !== undefined) url.searchParams.set("end_time", String(endTime));
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
  url.searchParams.append("group_by", "batch");
  url.searchParams.append("group_by", "service_tier");
  if (endTime !== undefined) url.searchParams.set("end_time", String(endTime));
  return url.toString();
}

function buildAnthropicCostUrl(startTime: number, endTime?: number): string {
  const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  url.searchParams.set("starting_at", new Date(startTime * 1000).toISOString());
  if (endTime !== undefined) url.searchParams.set("ending_at", new Date(endTime * 1000).toISOString());
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
  // Never let the runtime automatically replay provider credentials to a
  // redirect target. Provider endpoint changes must be explicit code changes.
  return fetch(url, { ...init, redirect: "manual" });
}

function parseMinorUsd(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric / 100 : undefined;
}

/** Amount already denominated in dollars, as number or decimal string. */
function parseDollarUsd(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  return typeof numeric === "number" && numeric >= 0 ? numeric : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  return typeof numeric === "number" && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validEpochSeconds(value: unknown): number | undefined {
  const seconds = numberValue(value);
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 0 && Number.isFinite(new Date(seconds * 1000).getTime())
    ? seconds
    : undefined;
}

function validDateTimeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function extractArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as unknown[];
  return [];
}

function requireStringArray(value: unknown, key: string, label: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key]) || value[key].length === 0) {
    throw new Error(`${label} returned no signed NDJSON ${key}; refusing to report an empty metrics sync.`);
  }
  const values = value[key] as unknown[];
  if (values.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} returned a malformed ${key} entry; refusing a partial metrics sync.`);
  }
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} returned duplicate ${key}; refusing to double-count a report partition.`);
  }
  return strings;
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
