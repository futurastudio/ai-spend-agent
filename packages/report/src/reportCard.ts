import {
  generateCutList,
  buildRecommendedPlan,
  type CutAction,
  type SpendSummary,
  type UsageRecord
} from "@agent-finops/core";

export type ReportCardInput = {
  summary: SpendSummary;
  /** Records the summary was computed from — used to derive the cut list. */
  records: UsageRecord[];
  /** Selects the surface; connected financial wording still follows evidence. */
  mode?: "demo" | "connected" | "local-logs";
  /** Provider response completeness; independent from row-level confidence. */
  providerCoverage?: "complete" | "partial";
};

const CARD_WIDTH = 640;
const CARD_HEIGHT = 400;

/**
 * A redacted, shareable "AI Receipt" as a standalone SVG.
 *
 * This is the growth loop: a screenshot-able artifact a founder can post. It
 * deliberately carries only NON-identifying signal — cost/value, modeled
 * monthly opportunities, provider count, confidence, and generic candidate
 * categories. Candidate titles are intentionally regenerated from a fixed
 * vocabulary instead of redacted after the fact: operations and project names
 * can contain arbitrary private text.
 * Client / project / user / workspace / api-key names are never rendered, so
 * sharing the card can't leak who a spend belongs to.
 */
export function generateReportCardSvg(input: ReportCardInput): string {
  const { summary } = input;
  const cardTitle = input.mode === "demo" ? "AI RECEIPT · DEMO SAMPLE" : "AI RECEIPT";
  const ariaLabel = input.mode === "demo" ? "AI receipt demo sample" : "AI receipt";
  const presentationBasis = financialPresentationBasis(input.mode, input.records);
  const rawTotalUsd = input.records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const headlineAmount = reportCardHeadlineAmount(
    presentationBasis,
    summary.totalUsd,
    rawTotalUsd
  );
  const cutList = generateCutList(input.records);
  const opportunity = summarizeOpportunity(input.records, cutList);
  const providerCount = new Set(input.records.map((record) => record.source.provider)).size;
  const topCuts = cutList.slice(0, 3);
  const recordCountLabel = input.mode === "local-logs"
    ? `${summary.recordCount} daily aggregate${summary.recordCount === 1 ? "" : "s"}`
    : input.mode === "demo"
      ? `${summary.recordCount} illustrative record${summary.recordCount === 1 ? "" : "s"}`
      : `${summary.recordCount} provider record${summary.recordCount === 1 ? "" : "s"}`;

  const cutLines = topCuts.length > 0
    ? topCuts.map((cut, index) => {
        const impact = cut.impactBasis === "observed_value_no_counterfactual"
          ? `${formatUsd(cut.affectedSpendUsd)} observed exposure`
          : `~${formatUsd(cut.estimatedMonthlySavingsUsd)}/mo modeled`;
        return (
          `      <text x="40" y="${274 + index * 30}" class="cut">` +
          `${escapeXml(`${index + 1}. ${genericCutTitle(cut)}`)}` +
          `<tspan class="cutImpact"> ${escapeXml(impact)}</tspan></text>`
        );
      }).join("\n")
    : `      <text x="40" y="274" class="cut">No high-confidence cut in this window yet.</text>`;

  const opportunityLine = opportunity.modeledMonthlySavingsUsd > 0
    ? `<tspan class="modeled">~${escapeXml(formatUsd(opportunity.modeledMonthlySavingsUsd))}/mo</tspan><tspan class="meta" dx="10">modeled API-rate opportunity · verify</tspan>`
    : opportunity.observedExposureUsd > 0
      ? `<tspan class="modeled">${escapeXml(formatUsd(opportunity.observedExposureUsd))}</tspan><tspan class="meta" dx="10">API-equivalent exposure · savings unavailable</tspan>`
      : `<tspan class="unavailable">Savings unavailable</tspan><tspan class="meta" dx="10">no supported counterfactual</tspan>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${ariaLabel}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1020"/>
      <stop offset="100%" stop-color="#121a33"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .label { fill: #7c89b3; font-size: 13px; letter-spacing: 2px; }
    .big { fill: #e8edff; font-size: 52px; font-weight: 700; }
    .modeled { fill: #fbbf24; font-size: 30px; font-weight: 700; }
    .unavailable { fill: #9aa6d6; font-size: 30px; font-weight: 700; }
    .meta { fill: #9aa6d6; font-size: 14px; }
    .cut { fill: #cdd6f7; font-size: 14px; }
    .cutImpact { fill: #fbbf24; font-weight: 700; }
    .brand { fill: #5b6790; font-size: 12px; letter-spacing: 1px; }
  </style>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="18" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="18" fill="none" stroke="#26304f"/>

  <text x="40" y="58" class="label">${cardTitle}</text>

  <text x="40" y="120" class="label">${headlineLabel(presentationBasis)}</text>
  <text x="40" y="172" class="big">${escapeXml(headlineAmount)}</text>

  <text x="40" y="212">${opportunityLine}</text>

  <text x="40" y="244" class="meta">${escapeXml(
    `${providerCount} provider${providerCount === 1 ? "" : "s"} · ${recordCountLabel} · ${receiptConfidenceLabel(summary.confidence, input.providerCoverage)}`
  )}</text>

${cutLines}

  <text x="40" y="372" class="brand">aibill · local-first · npx aibill</text>
</svg>
`;
}

/** A one-line, copy-pasteable caption to share alongside the card. */
export function generateReportCardCaption(input: ReportCardInput): string {
  const presentationBasis = financialPresentationBasis(input.mode, input.records);
  const rawTotalUsd = input.records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const cutList = generateCutList(input.records);
  const opportunity = summarizeOpportunity(input.records, cutList);
  const opportunityText = opportunity.modeledMonthlySavingsUsd > 0
    ? (
      `with ~${formatUsd(opportunity.modeledMonthlySavingsUsd)}/mo in modeled opportunities to test—not verified savings` +
      (opportunity.observedExposureUsd > 0
        ? `; ${formatUsd(opportunity.observedExposureUsd)} is observed API-equivalent exposure with savings unavailable without a matched counterfactual`
        : "")
    )
    : opportunity.observedExposureUsd > 0
      ? `with ${formatUsd(opportunity.observedExposureUsd)} in observed API-equivalent exposure to investigate; savings unavailable without a matched counterfactual`
      : "with no supported savings model in this window";
  const headline = presentationBasis === "connected_missing"
    ? "cost/value unavailable (no priced financial evidence)"
    : `${formatUsd(input.summary.totalUsd, rawTotalUsd)} in ${captionBasis(presentationBasis)}`;
  return (
    `${input.mode === "demo" ? "DEMO SAMPLE — " : ""}My AI receipt: ${headline}, ` +
    `${opportunityText}. ` +
    (input.providerCoverage === "partial"
      ? "Provider coverage was partial; available rows retain their evidence labels. "
      : "") +
    `Local-first: npx aibill`
  );
}

function summarizeOpportunity(records: UsageRecord[], cutList: CutAction[]): {
  modeledMonthlySavingsUsd: number;
  observedExposureUsd: number;
} {
  const modeledMonthlySavingsUsd = buildRecommendedPlan(cutList).recommendedSavingsUsd;
  const observedRecordIds = new Set(
    cutList
      .filter((cut) => cut.impactBasis === "observed_value_no_counterfactual")
      .flatMap((cut) => cut.recordIds)
  );
  const observedExposureUsd = Math.round(
    records.reduce(
      (total, record) => total + (observedRecordIds.has(record.id) ? record.amountUsd ?? 0 : 0),
      0
    ) * 100
  ) / 100;
  return { modeledMonthlySavingsUsd, observedExposureUsd };
}

type FinancialPresentationBasis =
  | "demo"
  | "local_estimate"
  | "provider_reported"
  | "connected_estimated"
  | "connected_unverified"
  | "connected_mixed"
  | "connected_missing";

function financialPresentationBasis(
  mode: ReportCardInput["mode"],
  records: readonly UsageRecord[]
): FinancialPresentationBasis {
  if (mode === "local-logs") return "local_estimate";
  if (mode !== "connected") return "demo";

  const priced = records.filter((record) => typeof record.amountUsd === "number");
  if (priced.length === 0) return "connected_missing";

  const hasVerified = priced.some((record) => record.costConfidence === "verified");
  const hasEstimated = priced.some((record) => record.costConfidence === "estimated");
  const hasUnverified = priced.some((record) => record.costConfidence === "detected_unverified");
  const hasMissing = priced.some((record) => record.costConfidence === "missing");
  const bearingKinds = [hasVerified, hasEstimated, hasUnverified, hasMissing].filter(Boolean).length;

  if (hasVerified && bearingKinds === 1) return "provider_reported";
  if (hasEstimated && bearingKinds === 1) return "connected_estimated";
  if (hasUnverified && bearingKinds === 1) return "connected_unverified";
  return "connected_mixed";
}

function headlineLabel(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "PROVIDER-REPORTED COST (THIS WINDOW)";
    case "connected_estimated": return "CONNECTED ESTIMATED COST / VALUE";
    case "connected_unverified": return "CONNECTED UNVERIFIED COST / VALUE";
    case "connected_mixed": return "MIXED CONNECTED COST / VALUE EVIDENCE";
    case "connected_missing": return "CONNECTED COST / VALUE UNAVAILABLE";
    case "local_estimate": return "OBSERVED API-EQUIVALENT VALUE";
    default: return "ILLUSTRATIVE COST / VALUE EVIDENCE";
  }
}

function captionBasis(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "provider-reported cost";
    case "connected_estimated": return "connected estimated cost/value";
    case "connected_unverified": return "connected unverified cost/value";
    case "connected_mixed": return "mixed connected cost/value evidence";
    case "connected_missing": return "connected cost/value evidence with no priced amount";
    case "local_estimate": return "observed API-equivalent value";
    default: return "illustrative cost/value evidence";
  }
}

function reportCardHeadlineAmount(
  basis: FinancialPresentationBasis,
  amount: number,
  rawAmount: number
): string {
  return basis === "connected_missing" ? "Unavailable" : formatBigUsd(amount, rawAmount);
}

/** Fixed, non-identifying labels for the public receipt. */
function genericCutTitle(cut: CutAction): string {
  switch (cut.kind) {
    case "model_downgrade":
      return "Investigate a model-routing candidate";
    case "context_trim":
      return cut.impactBasis === "observed_value_no_counterfactual"
        ? "Inspect cumulative coding-agent context"
        : "Inspect oversized context";
    case "cache":
      return "Investigate a repeated-work cache candidate";
    case "batch":
      return "Investigate an asynchronous batch candidate";
  }
}

function confidenceLabel(confidence: SpendSummary["confidence"]): string {
  switch (confidence) {
    case "verified":
      return "verified";
    case "estimated":
      return "estimated";
    case "detected_unverified":
      return "detected/unverified";
    default:
      return "unconfirmed";
  }
}

function receiptConfidenceLabel(
  confidence: SpendSummary["confidence"],
  providerCoverage: ReportCardInput["providerCoverage"]
): string {
  const rowLabel = confidenceLabel(confidence);
  return providerCoverage === "partial" ? `partial coverage · ${rowLabel} rows` : rowLabel;
}

function formatUsd(amount: number, rawAmount = amount): string {
  if (rawAmount > 0 && rawAmount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

function formatBigUsd(amount: number, rawAmount = amount): string {
  if (rawAmount > 0 && rawAmount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
