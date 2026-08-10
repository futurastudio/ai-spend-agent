import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  costConfidenceSchema,
  usageGranularitySchema
} from "./schema.js";
import { redactSecrets } from "./discovery.js";
import { sourceValidationCoverageValues } from "./sourceStatus.js";

export const AGENT_ECONOMICS_RECEIPT_KIND = "aibill.agent_economics_receipt" as const;
export const AGENT_ECONOMICS_RECEIPT_V0_VERSION = "0.1.0" as const;

function decodesToSensitiveIdentifier(value: string): boolean {
  const decodedCandidates: string[] = [];
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    try {
      const decoded = Buffer.from(value, "base64url");
      if (decoded.toString("base64url") === value) {
        decodedCandidates.push(utf8Decoder.decode(decoded));
      }
    } catch {
      // Invalid encodings are handled by the identifier grammar.
    }
  }

  if (value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value)) {
    try {
      decodedCandidates.push(utf8Decoder.decode(Buffer.from(value, "hex")));
    } catch {
      // Binary identifiers are not interpreted as encoded receipt metadata.
    }
  }

  return decodedCandidates.some((decoded) => {
    const normalized = decoded
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    if (containsKnownSecret(decoded) || containsKnownSecret(normalized) ||
        looksLikeAuthReferenceIdentifier(decoded) ||
        looksLikeAuthReferenceIdentifier(normalized) ||
        looksLikeUnsafeIdentifier(decoded) || looksLikeUnsafeIdentifier(normalized)) return true;
    return normalized.includes("/") || normalized.includes("\\");
  });
}

function containsKnownSecret(value: string): boolean {
  if (redactSecrets(value) !== value) return true;
  const secretShapes = [
    /sk-proj-[A-Za-z0-9_-]{20,}/i,
    /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/i,
    /sk-[A-Za-z0-9_-]{20,}/i,
    /helicone_[A-Za-z0-9_-]{16,}/i,
    /gh[pousr]_[A-Za-z0-9]{20,}/i,
    /github_pat_[A-Za-z0-9_]{20,}/i,
    /AIza[0-9A-Za-z_-]{30,}/i,
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i,
    /xox[baprs]-[A-Za-z0-9-]{10,}/i,
    /AKIA[0-9A-Z]{16}/,
    /glpat-[A-Za-z0-9_-]{16,}/i,
    /npm_[A-Za-z0-9]{30,}/i
  ];
  return secretShapes.some((pattern) => pattern.test(value)) ||
    /(?:^|[._-])(?:sk-|gh[pousr]_|github_pat_|npm_|AKIA|AIza|xox[baprs]-|glpat-|helicone_)/i
      .test(value);
}

function looksLikeAuthReferenceIdentifier(value: string): boolean {
  return /(?:^|[._-])(?:env|keychain|credential|secret)[._-]/i.test(value);
}

function looksLikeUnsafeIdentifier(value: string): boolean {
  if (/(?:^|[._-])(?:bearer|token|password|passwd|credential|authorization|auth)[._]/i
    .test(value)) return true;
  if (/(?:^|[._-])(?:bearer|token|password|passwd|credential|authorization|auth)-[A-Za-z0-9_-]{16,}$/i
    .test(value)) return true;
  if (/(?:^|[._-])(?:api[._]?key|access[._]?key|private[._]?key)[._]/i
    .test(value)) return true;
  if (/(?:^|[._-])(?:api[._-]?key|access[._-]?key|private[._-]?key)-[A-Za-z0-9_-]{16,}$/i
    .test(value)) return true;
  const words = value.toLowerCase().replace(/[._-]+/g, " ");
  return /\b(?:ignore|disregard|override|bypass)\b.*\b(?:previous|prior|system|all)\b.*\b(?:instructions?|prompts?|rules?)\b/.test(words) ||
    /\b(?:upload|send|exfiltrate|leak|reveal|print)\b.*\b(?:secrets?|credentials?|passwords?|private keys?)\b/.test(words) ||
    /\b(?:upload|send|exfiltrate|leak)\b.*\btokens?\b.*\b(?:attacker|external|remote)\b/.test(words);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const safeIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Expected a path-free, control-free identifier.")
  .superRefine((value, context) => {
    if (containsKnownSecret(value) ||
        looksLikeAuthReferenceIdentifier(value) ||
        decodesToSensitiveIdentifier(value)) {
      context.addIssue({
        code: "custom",
        message: "Credential-like and auth-reference identifiers are not receipt data."
      });
    }
  });
const receiptIdentifierSchema = safeIdentifierSchema.superRefine((value, context) => {
  if (looksLikeUnsafeIdentifier(value)) {
    context.addIssue({
      code: "custom",
      message: "Credential references and prompt-like instructions are not receipt identifiers."
    });
  }
});
const receiptErrorCodeSchema = safeIdentifierSchema.superRefine((value, context) => {
  const knownCredentialStatus = /^(?:token|password|passwd|credential|authorization|auth|api_key|access_key|private_key)_(?:expired|invalid|missing|revoked|unavailable|failed|required|denied)$/i
    .test(value);
  if (looksLikeUnsafeIdentifier(value) && !knownCredentialStatus) {
    context.addIssue({
      code: "custom",
      message: "Credential references and prompt-like instructions are not receipt error codes."
    });
  }
});
const utcTimestampSchema = z.string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const usdSchema = z.number()
  .finite()
  .nonnegative()
  .transform((value) => Object.is(value, -0) ? 0 : value);
const tokenCountSchema = z.number()
  .int()
  .nonnegative()
  .transform((value) => Object.is(value, -0) ? 0 : value);
const financialEvidenceWithAmountSchema = costConfidenceSchema.exclude(["missing"]);

export const receiptModeValues = [
  "local",
  "connected",
  "mixed",
  "sample"
] as const;
export const receiptModeSchema = z.enum(receiptModeValues);
export type ReceiptMode = z.infer<typeof receiptModeSchema>;

export const receiptSourceKindValues = [
  "local_agent_log",
  "provider_billing_api",
  "provider_usage_api",
  "user_declaration",
  "sample_fixture"
] as const;
export const receiptSourceKindSchema = z.enum(receiptSourceKindValues);
export type ReceiptSourceKind = z.infer<typeof receiptSourceKindSchema>;

export const receiptProvenanceOriginValues = [
  "provider_reported",
  "locally_observed",
  "user_declared",
  "sample"
] as const;
export const receiptProvenanceOriginSchema = z.enum(receiptProvenanceOriginValues);
export type ReceiptProvenanceOrigin = z.infer<typeof receiptProvenanceOriginSchema>;

export const receiptTransformationValues = Object.freeze([
  "normalized",
  "aggregated",
  "api_rate_estimated"
] as const);
export const receiptTransformationSchema = z.enum(receiptTransformationValues);
export type ReceiptTransformation = z.infer<typeof receiptTransformationSchema>;

export const receiptAccountingBasisValues = [
  "provider_billed",
  "api_equivalent",
  "user_declared"
] as const;
export const receiptAccountingBasisSchema = z.enum(receiptAccountingBasisValues);
export type ReceiptAccountingBasis = z.infer<typeof receiptAccountingBasisSchema>;

export const receiptMappingGapCodeValues = [
  "cost_unsplit",
  "cost_unpriced",
  "model_unmapped",
  "provider_unmapped",
  "source_record_unmapped"
] as const;
export const receiptMappingGapCodeSchema = z.enum(receiptMappingGapCodeValues);
export type ReceiptMappingGapCode = z.infer<typeof receiptMappingGapCodeSchema>;

export const receiptFreshnessSchema = z.object({
  status: z.enum(["fresh", "stale", "not_checked", "error"]),
  checkedAt: utcTimestampSchema.optional(),
  latestEvidenceAt: utcTimestampSchema.optional(),
  errorCode: receiptErrorCodeSchema.optional()
}).strict().superRefine((freshness, context) => {
  if ((freshness.status === "fresh" || freshness.status === "stale") && !freshness.checkedAt) {
    context.addIssue({
      code: "custom",
      path: ["checkedAt"],
      message: "Fresh and stale source states require a check timestamp."
    });
  }
  if (freshness.status === "error") {
    if (!freshness.checkedAt) {
      context.addIssue({
        code: "custom",
        path: ["checkedAt"],
        message: "Error source states require the timestamp of the failed check."
      });
    }
    if (!freshness.errorCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Error source states require a sanitized error code."
      });
    }
  } else if (freshness.errorCode) {
    context.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "Only error source states may carry an error code."
    });
  }
  if (freshness.status === "not_checked" &&
      (freshness.checkedAt || freshness.latestEvidenceAt || freshness.errorCode)) {
    context.addIssue({
      code: "custom",
      message: "A source that was not checked cannot carry observation or error metadata."
    });
  }
  if (freshness.checkedAt && freshness.latestEvidenceAt &&
      Date.parse(freshness.latestEvidenceAt) > Date.parse(freshness.checkedAt)) {
    context.addIssue({
      code: "custom",
      path: ["latestEvidenceAt"],
      message: "Latest evidence cannot postdate the source check."
    });
  }
}).transform((freshness) => ({
  status: freshness.status,
  ...(freshness.checkedAt !== undefined ? { checkedAt: freshness.checkedAt } : {}),
  ...(freshness.latestEvidenceAt !== undefined
    ? { latestEvidenceAt: freshness.latestEvidenceAt }
    : {}),
  ...(freshness.errorCode !== undefined ? { errorCode: freshness.errorCode } : {})
}));
export type ReceiptFreshness = z.infer<typeof receiptFreshnessSchema>;

export const receiptSourceSchema = z.object({
  id: receiptIdentifierSchema,
  kind: receiptSourceKindSchema,
  provider: receiptIdentifierSchema,
  validationCoverage: z.enum(sourceValidationCoverageValues).default("untested"),
  freshness: receiptFreshnessSchema
}).strict().superRefine((source, context) => {
  if (source.kind === "sample_fixture" && source.validationCoverage === "live_verified") {
    context.addIssue({
      code: "custom",
      path: ["validationCoverage"],
      message: "Sample fixtures cannot claim live verification."
    });
  }
});
export type ReceiptSource = z.infer<typeof receiptSourceSchema>;

export const receiptSourceRecordReferenceSchema = z.object({
  sourceId: receiptIdentifierSchema,
  recordId: z.string().regex(/^ref_[a-f0-9]{32}$/)
}).strict();
export type ReceiptSourceRecordReference = z.infer<
  typeof receiptSourceRecordReferenceSchema
>;

const sourceNativeRecordIdSchema = z.string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({
        code: "custom",
        message: "Source-native record IDs cannot contain unpaired Unicode surrogates."
      });
    }
  });

/** Convert a source-native identifier into the only reference form persisted in a receipt. */
export function createReceiptSourceRecordReference(
  sourceId: string,
  sourceRecordId: string
): ReceiptSourceRecordReference {
  const parsedSourceId = receiptIdentifierSchema.parse(sourceId);
  const parsedRecordId = sourceNativeRecordIdSchema.parse(sourceRecordId);
  const opaqueId = createHash("sha256")
    .update(`${parsedSourceId}\u0000${parsedRecordId}`)
    .digest("hex")
    .slice(0, 32);
  return receiptSourceRecordReferenceSchema.parse({
    sourceId: parsedSourceId,
    recordId: `ref_${opaqueId}`
  });
}

export const receiptProvenanceSchema = z.object({
  origin: receiptProvenanceOriginSchema,
  transformations: z.array(receiptTransformationSchema).min(1).max(3)
}).strict().superRefine((provenance, context) => {
  if (new Set(provenance.transformations).size !== provenance.transformations.length) {
    context.addIssue({
      code: "custom",
      path: ["transformations"],
      message: "Receipt transformations must be unique."
    });
  }
});
export type ReceiptProvenance = z.infer<typeof receiptProvenanceSchema>;

const receiptLineBaseShape = {
  id: receiptIdentifierSchema,
  sourceId: receiptIdentifierSchema,
  observedAt: utcTimestampSchema,
  granularity: usageGranularitySchema,
  provenance: receiptProvenanceSchema,
  sourceRecordReferences: z.array(receiptSourceRecordReferenceSchema).min(1).max(256)
};

export const receiptTokenUsageLineSchema = z.object({
  ...receiptLineBaseShape,
  kind: z.literal("token_usage"),
  provider: receiptIdentifierSchema,
  model: receiptIdentifierSchema,
  requestedModel: receiptIdentifierSchema.optional(),
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema
}).strict().superRefine((line, context) => {
  if (line.provenance.transformations.includes("api_rate_estimated")) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "transformations"],
      message: "Token usage cannot carry an API-rate cost transformation."
    });
  }
});
export type ReceiptTokenUsageLine = z.infer<typeof receiptTokenUsageLineSchema>;

export const receiptFinancialCostLineSchema = z.object({
  ...receiptLineBaseShape,
  kind: z.literal("financial_cost"),
  amountUsd: usdSchema,
  currency: z.literal("USD"),
  accountingBasis: receiptAccountingBasisSchema,
  financialEvidence: financialEvidenceWithAmountSchema
}).strict().superRefine((line, context) => {
  const transformations = new Set(line.provenance.transformations);
  if (line.accountingBasis === "provider_billed" &&
      (line.financialEvidence !== "verified" || line.provenance.origin !== "provider_reported")) {
    context.addIssue({
      code: "custom",
      path: ["accountingBasis"],
      message: "Provider-billed cost requires verified, provider-reported evidence."
    });
  }
  if (line.accountingBasis === "api_equivalent" &&
      (line.financialEvidence !== "estimated" || !transformations.has("api_rate_estimated"))) {
    context.addIssue({
      code: "custom",
      path: ["accountingBasis"],
      message: "API-equivalent cost must remain estimated and name its rate transformation."
    });
  }
  if (line.accountingBasis === "user_declared" &&
      (line.financialEvidence === "verified" || line.provenance.origin !== "user_declared")) {
    context.addIssue({
      code: "custom",
      path: ["accountingBasis"],
      message: "User-declared cost cannot become verified provider billing."
    });
  }
  if (line.accountingBasis !== "api_equivalent" && transformations.has("api_rate_estimated")) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "transformations"],
      message: "Only API-equivalent cost may use the API-rate transformation."
    });
  }
});
export type ReceiptFinancialCostLine = z.infer<typeof receiptFinancialCostLineSchema>;

export const receiptLineSchema = z.discriminatedUnion("kind", [
  receiptTokenUsageLineSchema,
  receiptFinancialCostLineSchema
]);
export type ReceiptLine = z.infer<typeof receiptLineSchema>;

export const receiptMappingGapSchema = z.object({
  code: receiptMappingGapCodeSchema,
  lineId: receiptIdentifierSchema.optional(),
  sourceId: receiptIdentifierSchema.optional()
}).strict().transform((gap) => ({
  code: gap.code,
  ...(gap.lineId !== undefined ? { lineId: gap.lineId } : {}),
  ...(gap.sourceId !== undefined ? { sourceId: gap.sourceId } : {})
}));
export type ReceiptMappingGap = z.infer<typeof receiptMappingGapSchema>;

export const receiptCostTotalSchema = z.object({
  accountingBasis: receiptAccountingBasisSchema,
  financialEvidence: financialEvidenceWithAmountSchema,
  currency: z.literal("USD"),
  amountUsd: usdSchema,
  lineCount: z.number().int().positive()
}).strict();
export type ReceiptCostTotal = z.infer<typeof receiptCostTotalSchema>;

const receiptBodyObjectSchema = z.object({
  kind: z.literal(AGENT_ECONOMICS_RECEIPT_KIND),
  schemaVersion: z.literal(AGENT_ECONOMICS_RECEIPT_V0_VERSION),
  generatedAt: utcTimestampSchema,
  mode: receiptModeSchema,
  demoOnly: z.boolean(),
  window: z.object({
    start: utcTimestampSchema,
    end: utcTimestampSchema
  }).strict(),
  sources: z.array(receiptSourceSchema).min(1).max(64),
  lines: z.array(receiptLineSchema).max(10_000),
  mappingGaps: z.array(receiptMappingGapSchema).max(10_000)
}).strict();

type ReceiptBody = z.infer<typeof receiptBodyObjectSchema>;

function validateReceiptBody(receipt: ReceiptBody, context: z.RefinementCtx): void {
  if (Date.parse(receipt.window.start) >= Date.parse(receipt.window.end)) {
    context.addIssue({
      code: "custom",
      path: ["window", "end"],
      message: "Receipt window end must follow its start."
    });
  }
  if (Date.parse(receipt.generatedAt) < Date.parse(receipt.window.end)) {
    context.addIssue({
      code: "custom",
      path: ["generatedAt"],
      message: "A receipt cannot be generated before its evidence window closes."
    });
  }
  if ((receipt.mode === "sample") !== receipt.demoOnly) {
    context.addIssue({
      code: "custom",
      path: ["demoOnly"],
      message: "Sample mode and the demo-only boundary must agree."
    });
  }

  const sourceIds = receipt.sources.map((source) => source.id);
  const sourceIdSet = new Set(sourceIds);
  const sourceById = new Map(receipt.sources.map((source) => [source.id, source]));
  if (sourceIdSet.size !== sourceIds.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Source IDs must be unique." });
  }
  const hasLocalSource = receipt.sources.some((source) =>
    source.kind === "local_agent_log" || source.kind === "user_declaration");
  const hasConnectedSource = receipt.sources.some((source) =>
    source.kind === "provider_billing_api" || source.kind === "provider_usage_api");
  if ((receipt.mode === "local" && (!hasLocalSource || hasConnectedSource)) ||
      (receipt.mode === "connected" && (!hasConnectedSource || hasLocalSource)) ||
      (receipt.mode === "mixed" && (!hasLocalSource || !hasConnectedSource))) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Receipt mode must match its local and connected source classes."
    });
  }
  const lineIds = receipt.lines.map((line) => line.id);
  const lineIdSet = new Set(lineIds);
  const lineById = new Map(receipt.lines.map((line) => [line.id, line]));
  if (lineIdSet.size !== lineIds.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Line IDs must be unique." });
  }

  const generatedAt = Date.parse(receipt.generatedAt);
  receipt.sources.forEach((source, sourceIndex) => {
    if (source.freshness.checkedAt && Date.parse(source.freshness.checkedAt) > generatedAt) {
      context.addIssue({
        code: "custom",
        path: ["sources", sourceIndex, "freshness", "checkedAt"],
        message: "A source check cannot postdate receipt generation."
      });
    }
    if (source.freshness.latestEvidenceAt &&
        Date.parse(source.freshness.latestEvidenceAt) > generatedAt) {
      context.addIssue({
        code: "custom",
        path: ["sources", sourceIndex, "freshness", "latestEvidenceAt"],
        message: "Latest source evidence cannot postdate receipt generation."
      });
    }
  });

  receipt.lines.forEach((line, lineIndex) => {
    const source = sourceById.get(line.sourceId);
    if (!sourceIdSet.has(line.sourceId)) {
      context.addIssue({
        code: "custom",
        path: ["lines", lineIndex, "sourceId"],
        message: "Receipt lines must reference a declared source."
      });
    }
    if (source) {
      if (source.freshness.status === "not_checked" &&
          source.kind !== "user_declaration" &&
          source.kind !== "sample_fixture") {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "sourceId"],
          message: "Observed lines require a checked source; user declarations and sample fixtures are explicit exceptions."
        });
      }
      const expectedOrigin: ReceiptProvenanceOrigin = source.kind === "local_agent_log"
        ? "locally_observed"
        : source.kind === "user_declaration"
          ? "user_declared"
          : source.kind === "sample_fixture"
            ? "sample"
            : "provider_reported";
      if (line.provenance.origin !== expectedOrigin) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "provenance", "origin"],
          message: "Line provenance must agree with the declared source kind."
        });
      }
      if (line.kind === "token_usage" && line.provider !== source.provider) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "provider"],
          message: "Token provider identity must agree with its declared source."
        });
      }
      if (line.kind === "financial_cost" &&
          line.accountingBasis === "provider_billed" &&
          source.kind !== "provider_billing_api") {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "accountingBasis"],
          message: "Provider-billed cost requires a provider billing source."
        });
      }
      if (line.kind === "financial_cost" &&
          line.accountingBasis === "user_declared" &&
          source.kind !== "user_declaration") {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "accountingBasis"],
          message: "User-declared cost requires a user-declaration source."
        });
      }
    }
    const referenceKeys = line.sourceRecordReferences.map(
      (reference) => `${reference.sourceId}\u0000${reference.recordId}`
    );
    if (new Set(referenceKeys).size !== referenceKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["lines", lineIndex, "sourceRecordReferences"],
        message: "Source-record references must be unique."
      });
    }
    line.sourceRecordReferences.forEach((reference, referenceIndex) => {
      if (reference.sourceId !== line.sourceId || !sourceIdSet.has(reference.sourceId)) {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "sourceRecordReferences", referenceIndex],
          message: "A source-record reference must resolve to the line's declared source."
        });
      }
    });
    const observedAt = Date.parse(line.observedAt);
    if (observedAt < Date.parse(receipt.window.start) || observedAt > Date.parse(receipt.window.end)) {
      context.addIssue({
        code: "custom",
        path: ["lines", lineIndex, "observedAt"],
        message: "Receipt line evidence must fall inside the receipt window."
      });
    }
    if (source?.freshness.checkedAt && observedAt > Date.parse(source.freshness.checkedAt)) {
      context.addIssue({
        code: "custom",
        path: ["lines", lineIndex, "observedAt"],
        message: "Line evidence cannot postdate its source check."
      });
    }
    if (source?.freshness.latestEvidenceAt &&
        observedAt > Date.parse(source.freshness.latestEvidenceAt)) {
      context.addIssue({
        code: "custom",
        path: ["lines", lineIndex, "observedAt"],
        message: "Line evidence cannot postdate its source's latest-evidence marker."
      });
    }
    if (receipt.mode === "sample") {
      if (line.provenance.origin !== "sample") {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "provenance", "origin"],
          message: "Sample receipts may contain only sample provenance."
        });
      }
      if (line.kind === "financial_cost" && line.financialEvidence === "verified") {
        context.addIssue({
          code: "custom",
          path: ["lines", lineIndex, "financialEvidence"],
          message: "Sample receipts cannot carry verified financial evidence."
        });
      }
    }
  });

  if (receipt.mode === "sample" &&
      receipt.sources.some((source) => source.kind !== "sample_fixture")) {
    context.addIssue({
      code: "custom",
      path: ["sources"],
      message: "Sample receipts may contain only sample-fixture sources."
    });
  }
  if (receipt.mode !== "sample" &&
      receipt.sources.some((source) => source.kind === "sample_fixture")) {
    context.addIssue({
      code: "custom",
      path: ["sources"],
      message: "Sample-fixture sources cannot enter a non-demo receipt."
    });
  }

  receipt.mappingGaps.forEach((gap, gapIndex) => {
    if (gap.lineId && !lineIdSet.has(gap.lineId)) {
      context.addIssue({
        code: "custom",
        path: ["mappingGaps", gapIndex, "lineId"],
        message: "Mapping gaps must reference a declared line."
      });
    }
    if (gap.sourceId && !sourceIdSet.has(gap.sourceId)) {
      context.addIssue({
        code: "custom",
        path: ["mappingGaps", gapIndex, "sourceId"],
        message: "Mapping gaps must reference a declared source."
      });
    }
    if (gap.lineId && gap.sourceId && lineById.get(gap.lineId)?.sourceId !== gap.sourceId) {
      context.addIssue({
        code: "custom",
        path: ["mappingGaps", gapIndex, "sourceId"],
        message: "A mapping gap's source must agree with its referenced line."
      });
    }
  });
  if (new Set(receipt.mappingGaps.map(mappingGapKey)).size !== receipt.mappingGaps.length) {
    context.addIssue({
      code: "custom",
      path: ["mappingGaps"],
      message: "Mapping gaps must be unique."
    });
  }
  const totalDerivation = deriveCostTotals(receipt.lines);
  if (!totalDerivation.success) {
    context.addIssue({
      code: "custom",
      path: ["lines"],
      message: totalDerivation.error
    });
  }
}

export const agentEconomicsReceiptV0DraftSchema = receiptBodyObjectSchema
  .superRefine(validateReceiptBody);
export type AgentEconomicsReceiptV0Draft = z.infer<
  typeof agentEconomicsReceiptV0DraftSchema
>;
export type AgentEconomicsReceiptV0DraftInput = z.input<
  typeof receiptBodyObjectSchema
>;

const receiptWithComputedFieldsObjectSchema = receiptBodyObjectSchema.extend({
  id: z.string().regex(/^aer_v0_[a-f0-9]{64}$/),
  costTotals: z.array(receiptCostTotalSchema).max(9)
});
type ReceiptWithComputedFields = z.infer<typeof receiptWithComputedFieldsObjectSchema>;

function canonicalReceiptBody(receipt: ReceiptBody): ReceiptBody {
  const transformationOrder = new Map(
    receiptTransformationValues.map((value, index) => [value, index])
  );
  const lines = receipt.lines.map((line) => {
    const canonicalLine = {
      ...line,
      provenance: {
        ...line.provenance,
        transformations: [...line.provenance.transformations].sort(
          (left, right) => (transformationOrder.get(left) ?? 0) -
            (transformationOrder.get(right) ?? 0)
        )
      },
      sourceRecordReferences: [...line.sourceRecordReferences].sort(compareReferences)
    };
    if (canonicalLine.kind === "token_usage") {
      const { requestedModel, ...withoutRequestedModel } = canonicalLine;
      return {
        ...withoutRequestedModel,
        ...(requestedModel !== undefined ? { requestedModel } : {})
      };
    }
    return canonicalLine;
  }).sort((left, right) => compareText(left.id, right.id));

  return {
    kind: receipt.kind,
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    mode: receipt.mode,
    demoOnly: receipt.demoOnly,
    window: receipt.window,
    sources: [...receipt.sources].sort((left, right) => compareText(left.id, right.id)),
    lines,
    mappingGaps: [...receipt.mappingGaps].sort((left, right) =>
      compareText(mappingGapKey(left), mappingGapKey(right)))
  };
}

function compareReferences(
  left: ReceiptSourceRecordReference,
  right: ReceiptSourceRecordReference
): number {
  return compareText(
    `${left.sourceId}\u0000${left.recordId}`,
    `${right.sourceId}\u0000${right.recordId}`
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mappingGapKey(gap: ReceiptMappingGap): string {
  return `${gap.code}\u0000${gap.sourceId ?? ""}\u0000${gap.lineId ?? ""}`;
}

type CostTotalDerivation =
  | { success: true; costTotals: ReceiptCostTotal[] }
  | { success: false; error: string };

type DecimalParts = { coefficient: bigint; scale: number };

function deriveCostTotals(lines: readonly ReceiptLine[]): CostTotalDerivation {
  const totals = new Map<string, {
    accountingBasis: ReceiptAccountingBasis;
    financialEvidence: z.infer<typeof financialEvidenceWithAmountSchema>;
    currency: "USD";
    coefficient: bigint;
    scale: number;
    lineCount: number;
  }>();
  for (const line of lines) {
    if (line.kind !== "financial_cost") continue;
    const key = `${line.accountingBasis}\u0000${line.financialEvidence}\u0000${line.currency}`;
    const existing = totals.get(key);
    const next = decimalParts(line.amountUsd);
    if (!next) return { success: false, error: "USD values must be finite, nonnegative decimal numbers." };
    if (!existing) {
      totals.set(key, {
        accountingBasis: line.accountingBasis,
        financialEvidence: line.financialEvidence,
        currency: line.currency,
        coefficient: next.coefficient,
        scale: next.scale,
        lineCount: 1
      });
      continue;
    }
    const commonScale = Math.max(existing.scale, next.scale);
    existing.coefficient =
      existing.coefficient * (10n ** BigInt(commonScale - existing.scale)) +
      next.coefficient * (10n ** BigInt(commonScale - next.scale));
    existing.scale = commonScale;
    existing.lineCount += 1;
  }
  const costTotals: ReceiptCostTotal[] = [];
  for (const total of totals.values()) {
    const amountUsd = decimalPartsToNumber({
      coefficient: total.coefficient,
      scale: total.scale
    });
    if (amountUsd === undefined) {
      return {
        success: false,
        error: "Aggregated USD total cannot be represented as a finite number without precision loss."
      };
    }
    costTotals.push({
      accountingBasis: total.accountingBasis,
      financialEvidence: total.financialEvidence,
      currency: total.currency,
      amountUsd,
      lineCount: total.lineCount
    });
  }
  return {
    success: true,
    costTotals: costTotals.sort((left, right) => compareText(totalKey(left), totalKey(right)))
  };
}

function totalKey(total: ReceiptCostTotal): string {
  return `${total.accountingBasis}\u0000${total.financialEvidence}\u0000${total.currency}`;
}

function decimalPartsToNumber(parts: DecimalParts): number | undefined {
  const digits = parts.coefficient.toString();
  const decimal = parts.scale <= 0
    ? `${digits}${"0".repeat(-parts.scale)}`
    : digits.length <= parts.scale
      ? `0.${"0".repeat(parts.scale - digits.length)}${digits}`
      : `${digits.slice(0, -parts.scale)}.${digits.slice(-parts.scale)}`;
  const total = Number(decimal);
  const exact = normalizeDecimalParts(parts);
  if (!Number.isFinite(total)) return undefined;
  const roundTripParts = decimalParts(total);
  if (!roundTripParts) return undefined;
  const roundTrip = normalizeDecimalParts(roundTripParts);
  if (roundTrip.coefficient !== exact.coefficient || roundTrip.scale !== exact.scale) {
    return undefined;
  }
  return Object.is(total, -0) ? 0 : total;
}

function decimalParts(value: number): DecimalParts | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  return {
    coefficient: BigInt(`${match[1]}${fraction}`),
    scale: fraction.length - exponent
  };
}

function normalizeDecimalParts(
  parts: DecimalParts
): DecimalParts {
  let { coefficient, scale } = parts;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function receiptDigest(body: ReceiptBody, costTotals: readonly ReceiptCostTotal[]): string {
  return `aer_v0_${createHash("sha256")
    .update(canonicalJson({ ...body, costTotals }))
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical receipt values must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical receipt values must be JSON data.");
}

function validateComputedFields(
  receipt: ReceiptWithComputedFields,
  context: z.RefinementCtx
): void {
  validateReceiptBody(receipt, context);
  const canonicalBody = canonicalReceiptBody(receipt);
  const derivation = deriveCostTotals(canonicalBody.lines);
  if (!derivation.success) return;
  const expectedTotals = derivation.costTotals;
  const actualTotals = [...receipt.costTotals].sort((left, right) =>
    compareText(totalKey(left), totalKey(right)));
  if (new Set(actualTotals.map(totalKey)).size !== actualTotals.length ||
      canonicalJson(actualTotals) !== canonicalJson(expectedTotals)) {
    context.addIssue({
      code: "custom",
      path: ["costTotals"],
      message: "Receipt cost totals must exactly match grouped financial-cost lines."
    });
  }
  const expectedId = receiptDigest(canonicalBody, expectedTotals);
  if (receipt.id !== expectedId) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "Receipt ID does not match its canonical SHA-256 digest."
    });
  }
}

export const agentEconomicsReceiptV0Schema = receiptWithComputedFieldsObjectSchema
  .superRefine(validateComputedFields);
export type AgentEconomicsReceiptV0 = z.infer<typeof agentEconomicsReceiptV0Schema>;

/** Build a canonical, content-addressed v0 receipt from validated evidence lines. */
export function createAgentEconomicsReceiptV0(
  input: AgentEconomicsReceiptV0DraftInput
): AgentEconomicsReceiptV0 {
  const body = canonicalReceiptBody(agentEconomicsReceiptV0DraftSchema.parse(input));
  const derivation = deriveCostTotals(body.lines);
  const costTotals = derivation.success ? derivation.costTotals : [];
  return agentEconomicsReceiptV0Schema.parse({
    ...body,
    id: receiptDigest(body, costTotals),
    costTotals
  });
}

/** Parse and re-canonicalize a serialized receipt, rejecting stale IDs or totals. */
export function parseAgentEconomicsReceiptV0(value: unknown): AgentEconomicsReceiptV0 {
  const parsed = agentEconomicsReceiptV0Schema.parse(value);
  const body = canonicalReceiptBody(parsed);
  const derivation = deriveCostTotals(body.lines);
  const costTotals = derivation.success ? derivation.costTotals : [];
  return {
    ...body,
    id: receiptDigest(body, costTotals),
    costTotals
  };
}

export const FOCUS_1_4_PIN = Object.freeze({
  standard: "FOCUS",
  version: "1.4",
  status: "ratified"
} as const);
export const FOCUS_1_5_WORKING_DRAFT_PIN = Object.freeze({
  standard: "FOCUS",
  version: "1.5",
  status: "working_draft",
  draftAsOf: "2026-08-08"
} as const);
export const focusProjectionTargetSchema = z.enum([
  "focus_1_4",
  "focus_1_5_working_draft"
]);
export type FocusProjectionTarget = z.infer<typeof focusProjectionTargetSchema>;

export type FocusProjectionGap = {
  code:
    | ReceiptMappingGapCode
    | "focus_1_4_token_dimensions_unavailable"
    | "api_equivalent_not_billed_cost"
    | "user_declared_not_billed_cost";
  lineId?: string;
  sourceId?: string;
};

export type FocusTokenProjectionRow = {
  kind: "token_usage";
  rowId: string;
  sourceLineId: string;
  provider: string;
  model: string;
  ConsumedQuantity: number;
  ConsumedUnit: "input_token" | "output_token";
  mapping: "aibill_extension" | "focus_1_5_working_draft";
  sourceRecordReferences: ReceiptSourceRecordReference[];
};

export type FocusCostProjectionRow = {
  kind: "financial_cost";
  rowId: string;
  sourceLineId: string;
  provider: string;
  BillingCurrency: "USD";
  BilledCost: number | null;
  extensions: {
    "x_aibill.api_equivalent_cost_usd"?: number;
    "x_aibill.user_declared_cost_usd"?: number;
  };
  accountingBasis: ReceiptAccountingBasis;
  financialEvidence: z.infer<typeof financialEvidenceWithAmountSchema>;
  sourceRecordReferences: ReceiptSourceRecordReference[];
};

export type FocusProjection = {
  target: typeof FOCUS_1_4_PIN | typeof FOCUS_1_5_WORKING_DRAFT_PIN;
  receiptId: string;
  rows: Array<FocusTokenProjectionRow | FocusCostProjectionRow>;
  gaps: FocusProjectionGap[];
};

/**
 * Version-pinned FOCUS projection. It deliberately keeps estimates out of
 * BilledCost and treats pre-1.5 token fields as aibill extensions.
 */
export function projectAgentEconomicsReceiptV0ToFocus(
  value: AgentEconomicsReceiptV0,
  target: FocusProjectionTarget
): FocusProjection {
  const receipt = parseAgentEconomicsReceiptV0(value);
  const parsedTarget = focusProjectionTargetSchema.parse(target);
  const sources = new Map(receipt.sources.map((source) => [source.id, source]));
  const gaps: FocusProjectionGap[] = receipt.mappingGaps.map((gap) => ({ ...gap }));
  const rows: Array<FocusTokenProjectionRow | FocusCostProjectionRow> = [];

  for (const line of receipt.lines) {
    if (line.kind === "token_usage") {
      const mapping = parsedTarget === "focus_1_4"
        ? "aibill_extension" as const
        : "focus_1_5_working_draft" as const;
      rows.push({
        kind: "token_usage",
        rowId: `focus.token.${line.id}.input`,
        sourceLineId: line.id,
        provider: line.provider,
        model: line.model,
        ConsumedQuantity: line.inputTokens,
        ConsumedUnit: "input_token",
        mapping,
        sourceRecordReferences: line.sourceRecordReferences
      }, {
        kind: "token_usage",
        rowId: `focus.token.${line.id}.output`,
        sourceLineId: line.id,
        provider: line.provider,
        model: line.model,
        ConsumedQuantity: line.outputTokens,
        ConsumedUnit: "output_token",
        mapping,
        sourceRecordReferences: line.sourceRecordReferences
      });
      if (parsedTarget === "focus_1_4") {
        gaps.push({ code: "focus_1_4_token_dimensions_unavailable", lineId: line.id });
      }
      continue;
    }

    const provider = sources.get(line.sourceId)?.provider;
    if (!provider) throw new TypeError("Validated receipt source unexpectedly disappeared.");
    rows.push({
      kind: "financial_cost",
      rowId: `focus.cost.${line.id}`,
      sourceLineId: line.id,
      provider,
      BillingCurrency: line.currency,
      BilledCost: line.accountingBasis === "provider_billed" ? line.amountUsd : null,
      extensions: line.accountingBasis === "api_equivalent"
        ? { "x_aibill.api_equivalent_cost_usd": line.amountUsd }
        : line.accountingBasis === "user_declared"
          ? { "x_aibill.user_declared_cost_usd": line.amountUsd }
          : {},
      accountingBasis: line.accountingBasis,
      financialEvidence: line.financialEvidence,
      sourceRecordReferences: line.sourceRecordReferences
    });
    if (line.accountingBasis === "api_equivalent") {
      gaps.push({ code: "api_equivalent_not_billed_cost", lineId: line.id });
    } else if (line.accountingBasis === "user_declared") {
      gaps.push({ code: "user_declared_not_billed_cost", lineId: line.id });
    }
  }

  return {
    target: parsedTarget === "focus_1_4" ? FOCUS_1_4_PIN : FOCUS_1_5_WORKING_DRAFT_PIN,
    receiptId: receipt.id,
    rows,
    gaps: uniqueSortedGaps(gaps)
  };
}

export const OTEL_GENAI_DEVELOPMENT_PIN = Object.freeze({
  standard: "OpenTelemetry GenAI semantic conventions",
  version: "development-2026-08-08",
  status: "development"
} as const);

export type OpenTelemetryGenAiProjectionRow = {
  sourceLineId: string;
  representation: "span_like" | "aggregate_record";
  conformantSpan: false;
  attributes: {
    "gen_ai.provider.name": string;
    "gen_ai.request.model"?: string;
    "gen_ai.usage.input_tokens": number;
    "gen_ai.usage.output_tokens": number;
  };
  sourceRecordReferences: ReceiptSourceRecordReference[];
};

export type OpenTelemetryGenAiProjection = {
  target: typeof OTEL_GENAI_DEVELOPMENT_PIN;
  receiptId: string;
  rows: OpenTelemetryGenAiProjectionRow[];
  gaps: Array<{
    code:
      | ReceiptMappingGapCode
      | "financial_cost_not_projected"
      | "requested_model_unavailable";
    lineId?: string;
    sourceId?: string;
  }>;
};

/** A Development-status attribute projection, never a claimed conformant span. */
export function projectAgentEconomicsReceiptV0ToOpenTelemetryGenAi(
  value: AgentEconomicsReceiptV0
): OpenTelemetryGenAiProjection {
  const receipt = parseAgentEconomicsReceiptV0(value);
  return {
    target: OTEL_GENAI_DEVELOPMENT_PIN,
    receiptId: receipt.id,
    rows: receipt.lines.flatMap((line): OpenTelemetryGenAiProjectionRow[] => {
      if (line.kind !== "token_usage") return [];
      return [{
        sourceLineId: line.id,
        representation: line.granularity === "call" || line.granularity === "invocation"
          ? "span_like"
          : "aggregate_record",
        conformantSpan: false,
        attributes: {
          "gen_ai.provider.name": line.provider,
          ...(line.requestedModel !== undefined
            ? { "gen_ai.request.model": line.requestedModel }
            : {}),
          "gen_ai.usage.input_tokens": line.inputTokens,
          "gen_ai.usage.output_tokens": line.outputTokens
        },
        sourceRecordReferences: line.sourceRecordReferences
      }];
    }),
    gaps: uniqueSortedGaps([
      ...receipt.mappingGaps.map((gap) => ({ ...gap })),
      ...receipt.lines
        .filter((line) => line.kind === "financial_cost")
        .map((line) => ({ code: "financial_cost_not_projected" as const, lineId: line.id })),
      ...receipt.lines
        .filter((line) => line.kind === "token_usage" && line.requestedModel === undefined)
        .map((line) => ({ code: "requested_model_unavailable" as const, lineId: line.id }))
    ])
  };
}

export const TOKENOMICS_TRACKING_PIN = Object.freeze({
  standard: "Tokenomics Foundation",
  trackedAsOf: "2026-08-08",
  status: "not_published"
} as const);

export type TokenomicsProjection = {
  target: typeof TOKENOMICS_TRACKING_PIN;
  receiptId: string;
  rows: [];
  gaps: [{ code: "technical_specification_not_published" }];
};

/** No Tokenomics rows are emitted until a technical specification exists. */
export function projectAgentEconomicsReceiptV0ToTokenomics(
  value: AgentEconomicsReceiptV0
): TokenomicsProjection {
  const receipt = parseAgentEconomicsReceiptV0(value);
  return {
    target: TOKENOMICS_TRACKING_PIN,
    receiptId: receipt.id,
    rows: [],
    gaps: [{ code: "technical_specification_not_published" }]
  };
}

function uniqueSortedGaps<T extends { code: string; lineId?: string; sourceId?: string }>(
  gaps: readonly T[]
): T[] {
  const unique = new Map<string, T>();
  for (const gap of gaps) unique.set(mappingGapKey(gap as ReceiptMappingGap), gap);
  return [...unique.values()].sort((left, right) =>
    compareText(
      mappingGapKey(left as ReceiptMappingGap),
      mappingGapKey(right as ReceiptMappingGap)
    ));
}
