import { z } from "zod";
import type { DetectedPlan } from "./planDetection.js";
import { subscriptionPlans } from "./planMath.js";
import type { UsageRecord } from "./schema.js";

/**
 * The canonical result card (`aibill.result_card` v1) — C-lane design §1.1.
 *
 * ONE contract behind every money surface (CLI default card, --full header,
 * MCP `resultCard`, statusline expansion): per-subscription rows with
 * per-basis figures, then a labeled totals stack that is NEVER blended into
 * one number. Three kinds of money exist and they are never added together:
 *
 *  - committed  (`subscription_committed`): the list price of a detected
 *    plan. A fact about price, not usage. Never `~`.
 *  - API-equivalent value (`api_equivalent`): usage × published API rates.
 *    Estimated. Never billed. `~` appears on EVERY figure of this basis and
 *    on NO other basis.
 *  - billed (`provider_billed`): provider-reported AND verified. Exact
 *    digits, never `~`, never compacted.
 *
 * `detectedUnverifiedUsd` is disclosure-only: provider-reported dollars from
 * a connector that is not yet live-verified (cursor today). It joins NO
 * total, is never "billed", never "~", and renders only in Evidence lines
 * and MCP output. It graduates to `billed` the day the connector is
 * live-verified.
 */

export type ResultCardBasis = "subscription_committed" | "api_equivalent" | "provider_billed";

export type ResultCardMode = "local-logs" | "connected" | "mixed" | "demo";

export type ResultCardRunway = {
  kind: "five-hour" | "weekly";
  remainingPercent: number;
  resetsAt: string;
};

export type ResultCardSubscriptionRow = {
  /** Display id; "chatgpt" covers the codex agent. */
  id: "claude" | "chatgpt" | "cursor" | string;
  agentId: "claude-code" | "codex" | null;
  /** "Max 5x", "Pro"; null = plan not detected/priced. */
  planLabel: string | null;
  connection: "local_logs" | "connected" | "detected_only";
  committedUsdPerMonth: number | null;
  apiEquivalentUsd: number | null;
  providerBilledUsd: number | null;
  /**
   * Provider-reported dollars a beta/unverified connector returned (cursor
   * today). Disclosure only: rendered in the Evidence line and MCP; NEVER in
   * rows' money columns, NEVER totaled, never "billed", never "~".
   */
  detectedUnverifiedUsd: number | null;
  /** 0-2 FRESH limits, most-urgent first; single-limit renderers take [0]. */
  runways: ResultCardRunway[];
};

export type ResultCardTotals = {
  subscriptionCommitted: {
    amountUsd: number | null;
    pricedSubs: number;
    totalSubs: number;
  };
  /** "missing" ⟺ amountUsd null. */
  apiEquivalent: { amountUsd: number | null; financialEvidence: "estimated" | "missing" };
  /** "missing" ⟺ amountUsd null. */
  providerBilled: { amountUsd: number | null; financialEvidence: "verified" | "missing" };
  /** Reserved and PERMANENTLY null — see blendPolicy. */
  blended: null;
  /**
   * String constant; survives null-stripping serializers as the
   * machine-readable statement of the no-blend rule.
   */
  blendPolicy: "never_blended";
};

export type ResultCardByProjectRow = {
  project: string;
  amountUsd: number;
  /** Unrounded-fraction share (4-dp, largest-remainder; sums to 1.0000). */
  share: number;
  unattributed: boolean;
};

export type ResultCardByProjectBlock = {
  /** The card's primary basis, stated once. */
  basis: "api_equivalent" | "provider_billed";
  rows: ResultCardByProjectRow[];
  /** null when it would cover 0 projects — never a $0.00 (0% · 0 projects) row. */
  everythingElse: { amountUsd: number; share: number; projectCount: number } | null;
};

export type ResultCard = {
  kind: "aibill.result_card";
  schemaVersion: 1;
  currency: "USD";
  /** Evidence window (default 30). */
  windowDays: number;
  mode: ResultCardMode;
  /** Stable order: claude, chatgpt/codex, cursor, then others alphabetical. */
  subscriptions: ResultCardSubscriptionRow[];
  /** The labeled stack — NEVER one blended figure. */
  totals: ResultCardTotals;
  /** null when zero attributable rows (never a $0 row). */
  byProject: ResultCardByProjectBlock | null;
};

/** §1.2 canonical vocabulary — everything outside this set is killed. */
export const resultCardVocabulary = Object.freeze({
  committed: "committed",
  /** Sanctioned narrow alias for the committed total, statusline <75 col only. */
  committedNarrowAlias: "subs",
  apiEquivalent: "API-equivalent",
  billed: "billed",
  estimatedMarker: "~",
  notReported: "not reported",
  notReportedShort: "n/r",
  notReportedLegend: "n/r = not reported",
  estimatedMarkerLegend: "~ = estimated at API rates",
  everythingElse: "everything else",
  unattributed: "unattributed",
  detectedUnverifiedSuffix: "detected (unverified · beta connector)",
  blendPolicy: "never_blended"
} as const);

/**
 * Killed on sight (§1.2): QA greps new/changed rendered copy for these.
 * "provider-reported" survives ONLY in trust/mode lines explaining where
 * `billed` comes from — never on a figure.
 */
export const resultCardKilledTerms: readonly string[] = Object.freeze([
  "usage value",
  "observed value",
  "cost/value",
  "API-equivalent/estimated",
  // QA MINOR-5: the pre-C-lane statusline suffix, killed on every new surface.
  "7d value"
]);

const usdSchema = z.number().finite().nonnegative();
const shareSchema = z.number().finite().min(0).max(1);

export const resultCardRunwaySchema = z.object({
  kind: z.enum(["five-hour", "weekly"]),
  remainingPercent: z.number().finite().min(0).max(100),
  resetsAt: z.string().datetime({ offset: true })
}).strict();

export const resultCardSubscriptionRowSchema = z.object({
  id: z.string().min(1),
  agentId: z.enum(["claude-code", "codex"]).nullable(),
  planLabel: z.string().min(1).nullable(),
  connection: z.enum(["local_logs", "connected", "detected_only"]),
  committedUsdPerMonth: usdSchema.nullable(),
  apiEquivalentUsd: usdSchema.nullable(),
  providerBilledUsd: usdSchema.nullable(),
  detectedUnverifiedUsd: usdSchema.nullable(),
  runways: z.array(resultCardRunwaySchema).max(2)
}).strict();

export const resultCardTotalsSchema = z.object({
  subscriptionCommitted: z.object({
    amountUsd: usdSchema.nullable(),
    pricedSubs: z.number().int().nonnegative(),
    totalSubs: z.number().int().nonnegative()
  }).strict().superRefine((committed, context) => {
    if (committed.pricedSubs > committed.totalSubs) {
      context.addIssue({
        code: "custom",
        path: ["pricedSubs"],
        message: "Priced subscriptions cannot exceed total subscriptions."
      });
    }
    if ((committed.amountUsd === null) !== (committed.pricedSubs === 0)) {
      context.addIssue({
        code: "custom",
        path: ["amountUsd"],
        message: "A committed total exists exactly when at least one subscription is priced."
      });
    }
  }),
  apiEquivalent: z.object({
    amountUsd: usdSchema.nullable(),
    financialEvidence: z.enum(["estimated", "missing"])
  }).strict().superRefine((total, context) => {
    if ((total.amountUsd === null) !== (total.financialEvidence === "missing")) {
      context.addIssue({
        code: "custom",
        path: ["financialEvidence"],
        message: "API-equivalent amount and financial evidence must agree (null ⟺ missing)."
      });
    }
  }),
  providerBilled: z.object({
    amountUsd: usdSchema.nullable(),
    financialEvidence: z.enum(["verified", "missing"])
  }).strict().superRefine((total, context) => {
    if ((total.amountUsd === null) !== (total.financialEvidence === "missing")) {
      context.addIssue({
        code: "custom",
        path: ["financialEvidence"],
        message: "Provider-billed amount and financial evidence must agree (null ⟺ missing)."
      });
    }
  }),
  blended: z.null(),
  blendPolicy: z.literal("never_blended")
}).strict();

export const resultCardByProjectSchema = z.object({
  basis: z.enum(["api_equivalent", "provider_billed"]),
  rows: z.array(z.object({
    project: z.string().min(1),
    amountUsd: usdSchema,
    share: shareSchema,
    unattributed: z.boolean()
  }).strict()).min(1),
  everythingElse: z.object({
    amountUsd: usdSchema,
    share: shareSchema,
    projectCount: z.number().int().positive()
  }).strict().nullable()
}).strict().superRefine((block, context) => {
  const shares = [
    ...block.rows.map((row) => row.share),
    ...(block.everythingElse ? [block.everythingElse.share] : [])
  ];
  const shareSum = shares.reduce((total, share) => total + share, 0);
  if (Math.abs(shareSum - 1) > 0.0001) {
    context.addIssue({
      code: "custom",
      path: ["rows"],
      message: "By-project shares must sum to 1.0000."
    });
  }
});

export const resultCardSchema = z.object({
  kind: z.literal("aibill.result_card"),
  schemaVersion: z.literal(1),
  currency: z.literal("USD"),
  windowDays: z.number().int().positive(),
  mode: z.enum(["local-logs", "connected", "mixed", "demo"]),
  subscriptions: z.array(resultCardSubscriptionRowSchema),
  totals: resultCardTotalsSchema,
  byProject: resultCardByProjectSchema.nullable()
}).strict().superRefine((card, context) => {
  if (card.mode === "demo" && card.subscriptions.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["subscriptions"],
      message: "Sample/demo cards never carry real detected subscriptions."
    });
  }
  if (card.totals.subscriptionCommitted.totalSubs !== card.subscriptions.length) {
    context.addIssue({
      code: "custom",
      path: ["totals", "subscriptionCommitted", "totalSubs"],
      message: "totalSubs must equal the number of subscription rows."
    });
  }
  if (new Set(card.subscriptions.map((row) => row.id)).size !== card.subscriptions.length) {
    context.addIssue({
      code: "custom",
      path: ["subscriptions"],
      message: "Subscription ids must be unique."
    });
  }
  if (card.byProject) {
    // rows + everythingElse reconcile exactly to the basis total (≤$0.01 drift).
    const basisTotal = card.byProject.basis === "api_equivalent"
      ? card.totals.apiEquivalent.amountUsd
      : card.totals.providerBilled.amountUsd;
    if (basisTotal === null) {
      context.addIssue({
        code: "custom",
        path: ["byProject", "basis"],
        message: "A by-project block requires its basis total to exist."
      });
    } else {
      const rowSum = card.byProject.rows.reduce((total, row) => total + row.amountUsd, 0) +
        (card.byProject.everythingElse?.amountUsd ?? 0);
      if (Math.abs(rowSum - basisTotal) > 0.011) {
        context.addIssue({
          code: "custom",
          path: ["byProject", "rows"],
          message: "By-project rows plus everything-else must reconcile to the basis total."
        });
      }
    }
  }
});

export type ResultCardBuildInput = {
  mode: ResultCardMode;
  /** Evidence window in days (metadata; records must already be window-scoped). */
  windowDays?: number;
  records: readonly UsageRecord[];
  detectedPlans?: readonly DetectedPlan[];
  /**
   * Optional fresh runway evidence keyed by agent id. The builder orders each
   * list most-urgent first and keeps at most two. Freshness filtering is the
   * caller's responsibility (existing statusline freshness rules).
   */
  runways?: Readonly<Partial<Record<"claude-code" | "codex", readonly ResultCardRunway[]>>>;
  /**
   * Optional provider-side subscription plan facts for provider-only rows
   * (e.g. a priced Cursor plan). Nothing detects these automatically today;
   * absent entries render honestly as plan-not-priced.
   */
  providerPlans?: readonly {
    provider: string;
    planLabel: string | null;
    committedUsdPerMonth: number | null;
  }[];
};

/** Providers whose connected billing is a subscription with no local agent. */
const providerSubscriptionProviders = new Set(["cursor", "github-copilot"]);

/**
 * Cost types whose estimated dollars are usage × published API rates — the
 * `api_equivalent` basis. Estimated dollars from any other connected source
 * are provider-reported-but-unverified and stay disclosure-only.
 */
const apiEquivalentCostTypes = new Set(["local_agent_logs", "anthropic_claude_code_usage"]);

const unattributedProjectKeys = new Set(["unmapped", "(home)", "home", "unattributed", "unknown", ""]);

function isUnattributedProject(projectId: string | undefined): boolean {
  return projectId === undefined || unattributedProjectKeys.has(projectId.trim().toLowerCase());
}

export type ResultCardRecordBasis =
  | "api_equivalent"
  | "provider_billed"
  | "detected_unverified"
  | "none";

/**
 * The one basis classifier every surface shares (§1.2): verified dollars are
 * provider_billed; estimated dollars are api_equivalent ONLY when they were
 * priced at published API rates; every other priced-but-unverified dollar is
 * detected_unverified (disclosure-only). Exported so renderers can keep their
 * bars/tables same-kind (QA finding M2) instead of re-deriving basis rules.
 */
export function classifyResultCardRecordBasis(
  record: UsageRecord,
  mode: ResultCardMode
): ResultCardRecordBasis {
  return classifyRecordBasis(record, mode);
}

type RecordBasis = ResultCardRecordBasis;

function classifyRecordBasis(record: UsageRecord, mode: ResultCardMode): RecordBasis {
  if (typeof record.amountUsd !== "number") return "none";
  if (record.costConfidence === "verified") return "provider_billed";
  if (record.costConfidence === "estimated") {
    if (mode === "demo") return "api_equivalent";
    return record.providerCostType !== undefined && apiEquivalentCostTypes.has(record.providerCostType)
      ? "api_equivalent"
      : "detected_unverified";
  }
  if (record.costConfidence === "detected_unverified") return "detected_unverified";
  return "none";
}

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function sumOrNull(amounts: readonly number[]): number | null {
  if (amounts.length === 0) return null;
  return roundCents(amounts.reduce((total, amount) => total + amount, 0));
}

/** Strip the provider brand from a detected plan label: "Claude Max 5x" → "Max 5x". */
function displayPlanLabel(plan: DetectedPlan): string | null {
  const known = plan.planId
    ? subscriptionPlans.find((candidate) => candidate.id === plan.planId)
    : undefined;
  const label = known?.name ?? plan.planLabel;
  if (!label) return null;
  return label.replace(/^Claude /u, "").replace(/^ChatGPT /u, "").trim() || null;
}

function committedPriceFor(plan: DetectedPlan): number | null {
  const known = plan.planId
    ? subscriptionPlans.find((candidate) => candidate.id === plan.planId)
    : undefined;
  return known?.monthlyUsd ?? null;
}

function subscriptionDisplayId(agent: "claude-code" | "codex"): "claude" | "chatgpt" {
  return agent === "claude-code" ? "claude" : "chatgpt";
}

function subscriptionOrder(id: string): number {
  if (id === "claude") return 0;
  if (id === "chatgpt") return 1;
  if (id === "cursor") return 2;
  return 3;
}

function orderRunways(runways: readonly ResultCardRunway[]): ResultCardRunway[] {
  return [...runways]
    .sort((left, right) => {
      const remaining = left.remainingPercent - right.remainingPercent;
      if (remaining !== 0) return remaining;
      const reset = Date.parse(left.resetsAt) - Date.parse(right.resetsAt);
      if (reset !== 0) return reset;
      return left.kind === right.kind ? 0 : left.kind === "five-hour" ? -1 : 1;
    })
    .slice(0, 2);
}

/** Project names clip at 24 chars + `…` on every renderer (§1.1). */
export function clipResultCardProjectName(name: string): string {
  const characters = [...name];
  if (characters.length <= 24) return name;
  return `${characters.slice(0, 24).join("")}…`;
}

/**
 * Largest-remainder integer percentages: printed shares sum to exactly 100.
 * Input weights need not be normalized.
 */
export function largestRemainderPercents(weights: readonly number[]): number[] {
  return largestRemainderUnits(weights, 100);
}

function largestRemainderUnits(weights: readonly number[], totalUnits: number): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / total) * totalUnits);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = totalUnits - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  const result = [...floors];
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remaining -= 1;
  }
  return result;
}

/**
 * Build the canonical result card from window-scoped usage records plus
 * locally detected plans. Pure and deterministic; every §1.1 rule lives here,
 * not in the renderers.
 */
export function buildResultCard(input: ResultCardBuildInput): ResultCard {
  const windowDays = input.windowDays ?? 30;
  const mode = input.mode;
  const records = input.records;

  // --- basis-wide sums (same-kind money is summable; cross-kind never) -----
  const apiEquivalentAmounts: number[] = [];
  const providerBilledAmounts: number[] = [];
  for (const record of records) {
    const basis = classifyRecordBasis(record, mode);
    if (basis === "api_equivalent") apiEquivalentAmounts.push(record.amountUsd ?? 0);
    if (basis === "provider_billed") providerBilledAmounts.push(record.amountUsd ?? 0);
  }
  const apiEquivalentTotal = sumOrNull(apiEquivalentAmounts);
  const providerBilledTotal = sumOrNull(providerBilledAmounts);

  // --- subscription rows ---------------------------------------------------
  // Sample/demo mode: real detected plans never mix into demo output (§1.1).
  const subscriptions: ResultCardSubscriptionRow[] = [];
  if (mode !== "demo") {
    const detectedSubscriptions = (input.detectedPlans ?? []).filter(
      (plan): plan is DetectedPlan & { agent: "claude-code" | "codex" } =>
        plan.billing === "subscription" && (plan.agent === "claude-code" || plan.agent === "codex")
    );
    const seenAgents = new Set<string>();
    for (const plan of detectedSubscriptions) {
      if (seenAgents.has(plan.agent)) continue;
      seenAgents.add(plan.agent);
      const agentRecords = records.filter((record) => record.agentId === plan.agent);
      const agentApiAmounts = agentRecords
        .filter((record) => classifyRecordBasis(record, mode) === "api_equivalent")
        .map((record) => record.amountUsd ?? 0);
      const agentBilledAmounts = agentRecords
        .filter((record) => classifyRecordBasis(record, mode) === "provider_billed")
        .map((record) => record.amountUsd ?? 0);
      subscriptions.push({
        id: subscriptionDisplayId(plan.agent),
        agentId: plan.agent,
        planLabel: displayPlanLabel(plan),
        connection: "local_logs",
        committedUsdPerMonth: committedPriceFor(plan),
        apiEquivalentUsd: sumOrNull(agentApiAmounts),
        providerBilledUsd: sumOrNull(agentBilledAmounts),
        detectedUnverifiedUsd: null,
        runways: orderRunways(input.runways?.[plan.agent] ?? [])
      });
    }

    // Provider-billed subscriptions with no local agent (cursor today). The
    // beta cursor connector hard-codes estimated confidence, so its dollars
    // land in detectedUnverifiedUsd — never providerBilledUsd — until the
    // connector is live-verified.
    const providersSeen = [...new Set(
      records
        .map((record) => record.source.provider)
        .filter((provider) => providerSubscriptionProviders.has(provider))
    )].sort();
    for (const provider of providersSeen) {
      const providerRecords = records.filter((record) => record.source.provider === provider);
      const billedAmounts = providerRecords
        .filter((record) => classifyRecordBasis(record, mode) === "provider_billed")
        .map((record) => record.amountUsd ?? 0);
      const detectedAmounts = providerRecords
        .filter((record) => classifyRecordBasis(record, mode) === "detected_unverified")
        .map((record) => record.amountUsd ?? 0);
      const providerPlan = input.providerPlans?.find((plan) => plan.provider === provider);
      subscriptions.push({
        id: provider,
        agentId: null,
        planLabel: providerPlan?.planLabel ?? null,
        connection: "connected",
        committedUsdPerMonth: providerPlan?.committedUsdPerMonth ?? null,
        apiEquivalentUsd: null,
        providerBilledUsd: sumOrNull(billedAmounts),
        detectedUnverifiedUsd: sumOrNull(detectedAmounts),
        runways: []
      });
    }
    subscriptions.sort((left, right) =>
      subscriptionOrder(left.id) - subscriptionOrder(right.id) || left.id.localeCompare(right.id)
    );
  }

  // --- totals stack (never blended) ----------------------------------------
  const pricedSubs = subscriptions.filter((row) => row.committedUsdPerMonth !== null);
  const totals: ResultCardTotals = {
    subscriptionCommitted: {
      amountUsd: pricedSubs.length > 0
        ? roundCents(pricedSubs.reduce((total, row) => total + (row.committedUsdPerMonth ?? 0), 0))
        : null,
      pricedSubs: pricedSubs.length,
      totalSubs: subscriptions.length
    },
    apiEquivalent: {
      amountUsd: apiEquivalentTotal,
      financialEvidence: apiEquivalentTotal === null ? "missing" : "estimated"
    },
    providerBilled: {
      amountUsd: providerBilledTotal,
      financialEvidence: providerBilledTotal === null ? "missing" : "verified"
    },
    blended: null,
    blendPolicy: "never_blended"
  };

  return resultCardSchema.parse({
    kind: "aibill.result_card",
    schemaVersion: 1,
    currency: "USD",
    windowDays,
    mode,
    subscriptions,
    totals,
    byProject: buildByProject(records, mode, totals)
  });
}

function buildByProject(
  records: readonly UsageRecord[],
  mode: ResultCardMode,
  totals: ResultCardTotals
): ResultCardByProjectBlock | null {
  // The card's primary basis follows the MODE (§3: local → api_equivalent,
  // connected → provider_billed), falling back to the other basis only when
  // the preferred one has no money at all. QA finding M3: the first verified
  // billed row must never hijack by-project away from rich local attribution
  // in local/mixed modes.
  const preferred: "api_equivalent" | "provider_billed" =
    mode === "connected" ? "provider_billed" : "api_equivalent";
  const preferredTotal = preferred === "provider_billed"
    ? totals.providerBilled.amountUsd
    : totals.apiEquivalent.amountUsd;
  const fallback: "api_equivalent" | "provider_billed" =
    preferred === "provider_billed" ? "api_equivalent" : "provider_billed";
  const fallbackTotal = fallback === "provider_billed"
    ? totals.providerBilled.amountUsd
    : totals.apiEquivalent.amountUsd;
  const basis: "api_equivalent" | "provider_billed" | null =
    preferredTotal !== null ? preferred : fallbackTotal !== null ? fallback : null;
  if (basis === null) return null;
  const basisTotal = basis === "provider_billed"
    ? totals.providerBilled.amountUsd!
    : totals.apiEquivalent.amountUsd!;
  if (basisTotal <= 0) return null;

  const basisRecords = records.filter((record) => classifyRecordBasis(record, mode) === basis);
  const named = new Map<string, number>();
  let unattributedAmount = 0;
  for (const record of basisRecords) {
    const amount = record.amountUsd ?? 0;
    if (isUnattributedProject(record.projectId)) {
      unattributedAmount += amount;
    } else {
      const key = record.projectId!;
      named.set(key, (named.get(key) ?? 0) + amount);
    }
  }
  const namedSorted = [...named.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (namedSorted.length === 0 && unattributedAmount <= 0) return null;

  // byProject spans the ENTIRE primary basis: top-2 named projects + the
  // unattributed row (never hidden, never renamed) + everything else.
  const topNamed = namedSorted.slice(0, 2);
  const restNamed = namedSorted.slice(2);
  const restAmount = restNamed.reduce((total, [, amount]) => total + amount, 0);

  type Bucket = {
    kind: "named" | "unattributed" | "everything_else";
    project?: string;
    amount: number;
  };
  const buckets: Bucket[] = [
    ...topNamed.map(([project, amount]): Bucket => ({ kind: "named", project, amount })),
    ...(unattributedAmount > 0
      ? [{ kind: "unattributed", amount: unattributedAmount } as Bucket]
      : []),
    ...(restNamed.length > 0
      ? [{ kind: "everything_else", amount: restAmount } as Bucket]
      : [])
  ];

  // Exact reconciliation: cent-round every bucket, then absorb the residual
  // rounding drift into the largest bucket so rows + everythingElse equal the
  // basis total to the cent (≤$0.01 drift rule met by construction).
  const rounded = buckets.map((bucket) => roundCents(bucket.amount));
  const drift = roundCents(basisTotal - rounded.reduce((total, amount) => total + amount, 0));
  if (drift !== 0) {
    const largestIndex = rounded.reduce(
      (best, amount, index) => (amount > (rounded[best] ?? 0) ? index : best),
      0
    );
    rounded[largestIndex] = roundCents((rounded[largestIndex] ?? 0) + drift);
  }

  // Machine shares: 4-decimal largest-remainder fractions summing to 1.0000.
  const shareUnits = largestRemainderUnits(rounded, 10_000);
  const shares = shareUnits.map((units) => units / 10_000);

  const rows: ResultCardByProjectRow[] = [];
  let everythingElse: ResultCardByProjectBlock["everythingElse"] = null;
  buckets.forEach((bucket, index) => {
    if (bucket.kind === "everything_else") {
      everythingElse = {
        amountUsd: rounded[index] ?? 0,
        share: shares[index] ?? 0,
        projectCount: restNamed.length
      };
      return;
    }
    rows.push({
      project: bucket.kind === "unattributed"
        ? resultCardVocabulary.unattributed
        : clipResultCardProjectName(bucket.project ?? ""),
      amountUsd: rounded[index] ?? 0,
      share: shares[index] ?? 0,
      unattributed: bucket.kind === "unattributed"
    });
  });
  if (rows.length === 0) return null;

  return { basis, rows, everythingElse };
}

export type ResultCardProjectLineInput = {
  card: ResultCard;
  /** The same window-scoped records the card was built from. */
  records: readonly UsageRecord[];
  /** Current project id (working-folder basename); undefined = unattributed cwd. */
  currentProjectId: string | undefined;
};

/**
 * The improve card's PROJECT line (§3): the CURRENT project's standing on the
 * card's primary basis — one line, N=1 plus context. Returns undefined when
 * no project attribution exists for the current directory (the line is
 * omitted, never fabricated). Rank counts named projects; the unattributed
 * bucket is excluded from ranking but included in the denominator total.
 */
export function buildResultCardProjectLine(input: ResultCardProjectLineInput): string | undefined {
  const byProject = input.card.byProject;
  if (!byProject) return undefined;
  const basis = byProject.basis;
  const basisTotal = basis === "provider_billed"
    ? input.card.totals.providerBilled.amountUsd
    : input.card.totals.apiEquivalent.amountUsd;
  if (basisTotal === null || basisTotal <= 0) return undefined;

  const named = new Map<string, number>();
  let unattributedAmount = 0;
  for (const record of input.records) {
    if (classifyRecordBasis(record, input.card.mode) !== basis) continue;
    const amount = record.amountUsd ?? 0;
    if (isUnattributedProject(record.projectId)) {
      unattributedAmount += amount;
    } else {
      named.set(record.projectId!, (named.get(record.projectId!) ?? 0) + amount);
    }
  }

  const formatAmount = (amount: number): string => basis === "provider_billed"
    ? formatBilledUsdExact(amount)
    : formatApproxUsd(amount);
  const basisWord = basis === "provider_billed" ? "billed" : "API-equivalent";
  const windowSuffix = `${input.card.windowDays}d`;

  // QA MINOR-2: one bucket, one percentage. When the current bucket is also
  // a by-project row, reuse the card's largest-remainder display percent so
  // the same money never shows two different shares across surfaces.
  const bucketWeights = [
    ...byProject.rows.map((row) => row.amountUsd),
    ...(byProject.everythingElse ? [byProject.everythingElse.amountUsd] : [])
  ];
  const bucketPercents = largestRemainderPercents(bucketWeights);
  const cardPercentFor = (predicate: (row: ResultCardByProjectRow) => boolean): number | undefined => {
    const index = byProject.rows.findIndex(predicate);
    return index >= 0 ? bucketPercents[index] : undefined;
  };

  if (input.currentProjectId === undefined || isUnattributedProject(input.currentProjectId)) {
    if (unattributedAmount <= 0) return undefined;
    const amount = roundCents(unattributedAmount);
    const percent = cardPercentFor((row) => row.unattributed) ??
      Math.round((amount / basisTotal) * 100);
    return `${resultCardVocabulary.unattributed} · ${formatAmount(amount)} of ` +
      `${formatAmount(basisTotal)} ${basisWord} (${percent}%, ${windowSuffix})`;
  }

  const currentAmount = named.get(input.currentProjectId);
  if (currentAmount === undefined || currentAmount <= 0) return undefined;
  const amount = roundCents(currentAmount);
  const clippedName = clipResultCardProjectName(input.currentProjectId);
  const percent = cardPercentFor((row) => !row.unattributed && row.project === clippedName) ??
    Math.round((amount / basisTotal) * 100);
  const rank = 1 + [...named.values()].filter((value) => value > currentAmount).length;
  const projectCount = named.size;
  return `${clippedName} · ${formatAmount(amount)} of ` +
    `${formatAmount(basisTotal)} ${basisWord} (${percent}%, ${windowSuffix}) · ` +
    `rank ${rank} of ${projectCount} project${projectCount === 1 ? "" : "s"}`;
}

// --- shared renderer formatting (one grammar for every surface, §1.2) -------

/** `committed $320/mo` amount part: "$320/mo" (whole dollars, list prices). */
export function formatCommittedPerMonth(amountUsd: number): string {
  return `$${formatWholeUsdNumber(amountUsd)}/mo`;
}

/**
 * API-equivalent figures always carry `~` and round to whole dollars.
 * Real-but-tiny usage prints `~<$1` (QA MINOR-4): `~$0` reads as absence.
 */
export function formatApproxUsd(amountUsd: number): string {
  if (amountUsd > 0 && Math.round(amountUsd) === 0) return "~<$1";
  return `~$${formatWholeUsdNumber(amountUsd)}`;
}

function formatWholeUsdNumber(amountUsd: number): string {
  return Math.round(amountUsd).toLocaleString("en-US");
}

/** Provider-billed money is never compacted, rounded, or approximated. */
export function formatBilledUsdExact(amountUsd: number): string {
  const text = String(amountUsd);
  if (/[eE]/u.test(text)) return `$${text}`;
  const [whole, fraction] = text.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const decimal = fraction === undefined
    ? ".00"
    : fraction.length === 1
      ? `.${fraction}0`
      : `.${fraction}`;
  return `$${grouped}${decimal}`;
}
