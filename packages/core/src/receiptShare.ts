import { z } from "zod";
import {
  resultCardSchema,
  resultCardTotalsSchema,
  type ResultCard
} from "./resultCard.js";

/**
 * Post-launch transport groundwork only.
 *
 * This module does not upload, send, persist, authenticate, render markup, or
 * expose a CLI command. It defines the bounded aggregate payload that a future
 * opt-in receipt route may accept after its own waitlist, durable-rate-limit,
 * retention, and mail-provider controls exist.
 */
export const RECEIPT_SHARE_V0_VERSION = "0.1.0" as const;
export const RECEIPT_SHARE_CARD_V0_KIND = "aibill.receipt_share_card" as const;
export const RECEIPT_EMAIL_REQUEST_V0_KIND = "aibill.receipt_email_request" as const;

const boundedUsdSchema = z.number().finite().nonnegative().max(1_000_000_000);

export const receiptShareCutV0Schema = z.object({
  template: z.enum([
    "route_lower_cost_model",
    "narrow_context",
    "cache_repeated_work",
    "use_batch_api"
  ]),
  modeledOpportunityUsd: boundedUsdSchema.positive(),
  evidence: z.literal("modeled_not_verified")
}).strict();

export const receiptShareCardV0Schema = z.object({
  kind: z.literal(RECEIPT_SHARE_CARD_V0_KIND),
  schemaVersion: z.literal(RECEIPT_SHARE_V0_VERSION),
  currency: z.literal("USD"),
  windowDays: z.number().int().min(1).max(365),
  // Demo/sample payloads are intentionally ineligible for real delivery.
  mode: z.enum(["local-logs", "connected", "mixed"]),
  /** Canonical three-basis stack, including blended:null/never_blended. */
  financials: resultCardTotalsSchema,
  providerCount: z.number().int().positive().max(64),
  recordCount: z.number().int().positive().max(1_000_000),
  confidence: z.enum(["verified", "estimated", "detected_unverified", "missing"]),
  /** Fixed templates only: no client-provided title, model, operation, or markup. */
  cuts: z.array(receiptShareCutV0Schema).max(3),
  contentBoundary: z.object({
    rawHistoryIncluded: z.literal(false),
    localIdentifiersIncluded: z.literal(false),
    clientMarkupIncluded: z.literal(false)
  }).strict()
}).strict().superRefine((card, context) => {
  if (card.providerCount > card.recordCount) {
    context.addIssue({
      code: "custom",
      path: ["providerCount"],
      message: "Provider count cannot exceed aggregate record count."
    });
  }
});

// Deliberately ASCII and single-line. The future route must additionally use
// the already-waitlisted normalized address as its authorization identity.
const receiptRecipientEmailV0Schema = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u);

export const receiptEmailRequestV0Schema = z.object({
  kind: z.literal(RECEIPT_EMAIL_REQUEST_V0_KIND),
  schemaVersion: z.literal(RECEIPT_SHARE_V0_VERSION),
  recipientEmail: receiptRecipientEmailV0Schema,
  /** Names both pieces of data and the third-party transit boundary. */
  consent: z.literal("email_and_aggregate_card_via_mail_provider"),
  card: receiptShareCardV0Schema
}).strict();

export type ReceiptShareCutV0 = z.infer<typeof receiptShareCutV0Schema>;
export type ReceiptShareCardV0 = z.infer<typeof receiptShareCardV0Schema>;
export type ReceiptEmailRequestV0 = z.infer<typeof receiptEmailRequestV0Schema>;

export type BuildReceiptShareCardV0Input = {
  resultCard: ResultCard;
  providerCount: number;
  recordCount: number;
  confidence: ReceiptShareCardV0["confidence"];
  cuts: ReceiptShareCutV0[];
};

/**
 * Projects the canonical local result card into a smaller aggregate-only
 * transport card. Subscription labels, project rows, runways, record IDs,
 * source metadata, prompts, paths, and raw history are intentionally omitted.
 */
export function buildReceiptShareCardV0(input: BuildReceiptShareCardV0Input): ReceiptShareCardV0 {
  const resultCard = resultCardSchema.parse(input.resultCard);
  return receiptShareCardV0Schema.parse({
    kind: RECEIPT_SHARE_CARD_V0_KIND,
    schemaVersion: RECEIPT_SHARE_V0_VERSION,
    currency: "USD",
    windowDays: resultCard.windowDays,
    mode: resultCard.mode,
    financials: resultCard.totals,
    providerCount: input.providerCount,
    recordCount: input.recordCount,
    confidence: input.confidence,
    cuts: input.cuts,
    contentBoundary: {
      rawHistoryIncluded: false,
      localIdentifiersIncluded: false,
      clientMarkupIncluded: false
    }
  });
}

export const RECEIPT_EMAIL_MAX_SENDS_PER_EMAIL_24H = 1 as const;
export const RECEIPT_EMAIL_MAX_SENDS_PER_IP_24H = 10 as const;

const receiptEmailDeliveryStateV0Schema = z.object({
  waitlistMember: z.boolean(),
  emailSendsLast24Hours: z.number().int().nonnegative().max(1_000_000),
  ipSendsLast24Hours: z.number().int().nonnegative().max(1_000_000)
}).strict();

export type ReceiptEmailDeliveryDecisionV0 =
  | { status: "join_first"; httpStatus: 403 }
  | { status: "rate_limited"; httpStatus: 429; scope: "email" | "ip" }
  | { status: "accepted"; httpStatus: 202 };

/**
 * Pure authorization policy for a future route. Counters must come from a
 * durable shared store; this function creates no in-memory limiter and has no
 * persistence or network side effects.
 */
export function decideReceiptEmailDeliveryV0(
  state: z.input<typeof receiptEmailDeliveryStateV0Schema>
): ReceiptEmailDeliveryDecisionV0 {
  const parsed = receiptEmailDeliveryStateV0Schema.parse(state);
  if (!parsed.waitlistMember) return { status: "join_first", httpStatus: 403 };
  if (parsed.emailSendsLast24Hours >= RECEIPT_EMAIL_MAX_SENDS_PER_EMAIL_24H) {
    return { status: "rate_limited", httpStatus: 429, scope: "email" };
  }
  if (parsed.ipSendsLast24Hours >= RECEIPT_EMAIL_MAX_SENDS_PER_IP_24H) {
    return { status: "rate_limited", httpStatus: 429, scope: "ip" };
  }
  return { status: "accepted", httpStatus: 202 };
}
