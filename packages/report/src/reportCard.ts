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
  /** Controls whether the headline is billed cost or API-equivalent value. */
  mode?: "demo" | "connected" | "local-logs";
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
          `<tspan class="cutSave"> ${escapeXml(impact)}</tspan></text>`
        );
      }).join("\n")
    : `      <text x="40" y="274" class="cut">No high-confidence cut in this window yet.</text>`;

  const opportunityLine = opportunity.modeledMonthlySavingsUsd > 0
    ? `<tspan class="save">~${escapeXml(formatUsd(opportunity.modeledMonthlySavingsUsd))}/mo</tspan><tspan class="meta" dx="10">modeled API-rate opportunity · verify</tspan>`
    : opportunity.observedExposureUsd > 0
      ? `<tspan class="save">${escapeXml(formatUsd(opportunity.observedExposureUsd))}</tspan><tspan class="meta" dx="10">API-equivalent exposure · savings unavailable</tspan>`
      : `<tspan class="save">Savings unavailable</tspan><tspan class="meta" dx="10">no supported counterfactual</tspan>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="AI receipt">
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
    .save { fill: #4ade80; font-size: 30px; font-weight: 700; }
    .meta { fill: #9aa6d6; font-size: 14px; }
    .cut { fill: #cdd6f7; font-size: 14px; }
    .cutSave { fill: #4ade80; font-weight: 700; }
    .brand { fill: #5b6790; font-size: 12px; letter-spacing: 1px; }
  </style>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="18" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="18" fill="none" stroke="#26304f"/>

  <text x="40" y="58" class="label">AI RECEIPT</text>

  <text x="40" y="120" class="label">${headlineLabel(input.mode)}</text>
  <text x="40" y="172" class="big">${escapeXml(formatBigUsd(summary.totalUsd))}</text>

  <text x="40" y="212">${opportunityLine}</text>

  <text x="40" y="244" class="meta">${escapeXml(
    `${providerCount} provider${providerCount === 1 ? "" : "s"} · ${recordCountLabel} · ${confidenceLabel(summary.confidence)}`
  )}</text>

${cutLines}

  <text x="40" y="372" class="brand">aibill · local-first · npx aibill</text>
</svg>
`;
}

/** A one-line, copy-pasteable caption to share alongside the card. */
export function generateReportCardCaption(input: ReportCardInput): string {
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
  return (
    `My AI receipt: ${formatUsd(input.summary.totalUsd)} in ${captionBasis(input.mode)}, ` +
    `${opportunityText}. ` +
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

function headlineLabel(mode: ReportCardInput["mode"]): string {
  if (mode === "connected") return "PROVIDER-REPORTED COST (THIS WINDOW)";
  if (mode === "local-logs") return "OBSERVED API-EQUIVALENT VALUE";
  return "ILLUSTRATIVE COST / VALUE EVIDENCE";
}

function captionBasis(mode: ReportCardInput["mode"]): string {
  if (mode === "connected") return "provider-reported cost";
  if (mode === "local-logs") return "observed API-equivalent value";
  return "illustrative cost/value evidence";
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

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatBigUsd(amount: number): string {
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
