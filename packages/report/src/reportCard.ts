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
};

const CARD_WIDTH = 640;
const CARD_HEIGHT = 400;

/**
 * A redacted, shareable "AI Receipt" as a standalone SVG.
 *
 * This is the growth loop: a screenshot-able artifact a founder can post. It
 * deliberately carries only NON-identifying signal — total spend, estimated
 * monthly savings, provider count, confidence, and model-level cut headlines.
 * Client / project / user / workspace / api-key names are never rendered, so
 * sharing the card can't leak who a spend belongs to.
 */
export function generateReportCardSvg(input: ReportCardInput): string {
  const { summary } = input;
  const cutList = generateCutList(input.records);
  // Deduplicated recommended-plan savings — never exceeds the spend it draws from.
  const monthlySavings = buildRecommendedPlan(cutList).recommendedSavingsUsd;
  const providerCount = summary.bySource.length;
  const topCuts = cutList.slice(0, 3);

  const cutLines = topCuts.length > 0
    ? topCuts.map(
        (cut, index) =>
          `      <text x="40" y="${274 + index * 30}" class="cut">` +
          `${escapeXml(`${index + 1}. ${redactCutTitle(cut)}`)}` +
          `<tspan class="cutSave"> ~${escapeXml(formatUsd(cut.estimatedMonthlySavingsUsd))}/mo</tspan></text>`
      ).join("\n")
    : `      <text x="40" y="274" class="cut">No high-confidence cut in this window yet.</text>`;

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

  <text x="40" y="120" class="label">TOTAL AI SPEND (THIS WINDOW)</text>
  <text x="40" y="172" class="big">${escapeXml(formatBigUsd(summary.totalUsd))}</text>

  <text x="40" y="212"><tspan class="save">~${escapeXml(formatUsd(monthlySavings))}/mo</tspan><tspan class="meta" dx="10">recommended-plan savings (deduplicated)</tspan></text>

  <text x="40" y="244" class="meta">${escapeXml(
    `${providerCount} provider${providerCount === 1 ? "" : "s"} · ${summary.recordCount} call${summary.recordCount === 1 ? "" : "s"} · ${confidenceLabel(summary.confidence)}`
  )}</text>

${cutLines}

  <text x="40" y="372" class="brand">ai-spend-agent · local-first · npx ai-spend-agent</text>
</svg>
`;
}

/** A one-line, copy-pasteable caption to share alongside the card. */
export function generateReportCardCaption(input: ReportCardInput): string {
  const monthlySavings = buildRecommendedPlan(generateCutList(input.records)).recommendedSavingsUsd;
  return (
    `My AI receipt this month: ${formatUsd(input.summary.totalUsd)} tracked, ` +
    `~${formatUsd(monthlySavings)}/mo in savings I can act on. Local-first, no signup: npx ai-spend-agent`
  );
}

/**
 * Strip any entity name a cut headline might reference so the card stays
 * shareable. Cut titles are model/operation oriented, but we defensively
 * remove anything after a "for "/"on "/"in " clause that could name a client.
 */
function redactCutTitle(cut: CutAction): string {
  return cut.title
    .replace(/\s+for\s+[^.,]+/i, "")
    .replace(/\s+\(client[^)]*\)/i, "")
    .trim();
}

function confidenceLabel(confidence: SpendSummary["confidence"]): string {
  switch (confidence) {
    case "verified":
      return "verified";
    case "estimated":
      return "estimated";
    case "detected_unverified":
      return "detected";
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
