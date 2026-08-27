import {
  costCoverage,
  missingCostPhrase,
  roundUsdCents,
  MISSING_NOT_ZERO,
  UNAVAILABLE_TOTAL
} from "./money.js";
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
  // 0.9.5 brand retint: the card ground joined the landing's warm
  // green-black ladder (#0C0D09 -> #12140E gradient, white-alpha hairline
  // stroke) replacing the off-brand indigo. Text and layout untouched.
  const { summary } = input;
  const cardTitle = input.mode === "demo" ? "AI RECEIPT · DEMO SAMPLE" : "AI RECEIPT";
  const ariaLabel = input.mode === "demo" ? "AI receipt demo sample" : "AI receipt";
  const presentationBasis = financialPresentationBasis(input.mode, input.records);
  const rawTotalUsd = input.records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const coverage = costCoverage(input.records);
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

  // B1: the missing-cost count gets its OWN line rather than a fourth clause
  // on the coverage line. The coverage line already runs to ~68 characters in
  // the connected partial-coverage case, and 640px of 14px monospace holds
  // about 70 — appending "· 12 records missing cost" would have pushed the
  // one caveat that keeps the headline honest off the right edge of the
  // artifact people screenshot. Its own line also lets it carry the full
  // "missing/null is not zero" clause the detail renderers print.
  const missingCostLine = coverage.missingCount > 0
    ? `  <text x="40" y="268" class="meta">${escapeXml(
        `${missingCostPhrase(coverage.missingCount)} · ${MISSING_NOT_ZERO}`
      )}</text>`
    : "";
  // The cut list starts lower and packs tighter when the caveat line is
  // present, so three candidates plus the brand still fit the 400px card.
  const cutTop = missingCostLine ? 300 : 274;
  const cutStep = missingCostLine ? 26 : 30;

  const cutLines = topCuts.length > 0
    ? topCuts.map((cut, index) => {
        const impact = cut.impactBasis === "observed_value_no_counterfactual"
          ? `${formatBigUsd(cut.affectedSpendUsd)} observed exposure`
          : `~${formatBigUsd(cut.estimatedMonthlySavingsUsd)}/mo modeled`;
        return (
          `      <text x="40" y="${cutTop + index * cutStep}" class="cut">` +
          `${escapeXml(`${index + 1}. ${genericCutTitle(cut)}`)}` +
          `<tspan class="cutImpact"> ${escapeXml(impact)}</tspan></text>`
        );
      }).join("\n")
    : `      <text x="40" y="${cutTop}" class="cut">No high-confidence cut in this window yet.</text>`;

  // Parity nit: ONE thousands style per artifact — the headline uses the
  // comma form, so every other dollar on the card (and its caption) does too.
  // 0.9.5 dedup: when the observed exposure IS the headline value (within
  // rounding noise), the card says so in words instead of printing the same
  // number twice two lines apart.
  const opportunityLine = opportunity.modeledMonthlySavingsUsd > 0
    ? `<tspan class="modeled">~${escapeXml(formatBigUsd(opportunity.modeledMonthlySavingsUsd))}/mo</tspan><tspan class="meta" dx="10">modeled API-rate opportunity · verify</tspan>`
    : observedExposureMatchesHeadline(summary.totalUsd, opportunity)
      ? `<tspan class="modeled">All</tspan><tspan class="meta" dx="10">of the value above is exposure · savings unavailable</tspan>`
      : opportunity.observedExposureUsd > 0
        ? `<tspan class="modeled">${escapeXml(formatBigUsd(opportunity.observedExposureUsd))}</tspan><tspan class="meta" dx="10">API-equivalent exposure · savings unavailable</tspan>`
        : `<tspan class="unavailable">Savings unavailable</tspan><tspan class="meta" dx="10">no supported counterfactual</tspan>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${ariaLabel}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0C0D09"/>
      <stop offset="100%" stop-color="#12140E"/>
    </linearGradient>
  </defs>
  <style>
    /* 0.9.5 brand retint: the neutral text inks were blue-tinted periwinkle,
       off the landing's warm ladder. Color-only swap to white-alpha
       ink/muted/faint (font sizes, positions, and letter-spacing untouched;
       the estimated-money amber stays receipt-scoped by mandate). */
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    /* 0.47, not 0.42: this tier renders the evidence-basis label — "CONNECTED
       API-EQUIVALENT VALUE (ESTIMATED)" — the one line that keeps the headline
       number honest. At 0.42 over #0C0D09 it computed to 4.07:1 (below AA
       4.5:1) and video compression eats this tier first; 0.47 clears AA at
       ~4.8:1 and still sits well under the #EDEDED primary tier. */
    .label { fill: rgba(255,255,255,0.47); font-size: 13px; letter-spacing: 2px; }
    .big { fill: #EDEDED; font-size: 52px; font-weight: 700; }
    .modeled { fill: #fbbf24; font-size: 30px; font-weight: 700; }
    .unavailable { fill: rgba(255,255,255,0.62); font-size: 30px; font-weight: 700; }
    .meta { fill: rgba(255,255,255,0.62); font-size: 14px; }
    .cut { fill: rgba(255,255,255,0.62); font-size: 14px; }
    .cutImpact { fill: #fbbf24; font-weight: 700; }
    .brand { fill: rgba(255,255,255,0.47); font-size: 12px; letter-spacing: 1px; }
  </style>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="18" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="18" fill="none" stroke="rgba(255,255,255,0.08)"/>

  <text x="40" y="58" class="label">${cardTitle}</text>

  <text x="40" y="120" class="label">${headlineLabel(presentationBasis)}</text>
  <text x="40" y="172" class="big">${escapeXml(headlineAmount)}</text>

  <text x="40" y="212">${opportunityLine}</text>

  <text x="40" y="244" class="meta">${escapeXml(
    `${providerCount} provider${providerCount === 1 ? "" : "s"} · ${recordCountLabel} · ${receiptConfidenceLabel(summary.confidence, input.providerCoverage)}`
  )}</text>
${missingCostLine}

${cutLines}

  <text x="40" y="372" class="brand">aibill · local-first · npx aibill · asktilden.com</text>
</svg>
`;
}

/** A one-line, copy-pasteable caption to share alongside the card. */
export function generateReportCardCaption(input: ReportCardInput): string {
  const presentationBasis = financialPresentationBasis(input.mode, input.records);
  const rawTotalUsd = input.records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const cutList = generateCutList(input.records);
  const opportunity = summarizeOpportunity(input.records, cutList);
  // The caption mirrors EXACTLY the card's own opportunity-line decision
  // (modeled branch, else observed branch, else unavailable) so every dollar
  // figure in the caption also appears on the artifact it captions. The old
  // "; $X is observed API-equivalent exposure…" appendix quoted a figure the
  // card and the receipt never display (launch-sweep finding: a sample
  // caption said $41.00 that reconciled to nothing a reader could see).
  // 0.9.5 dedup (founder-visible): when exposure and headline value agree
  // within rounding noise the caption keeps ONE number and says the value IS
  // the exposure, instead of quoting two near-identical dollars ("$2,281.89
  // value … $2,281.87 exposure"). The truth contract survives verbatim:
  // "savings unavailable without a matched counterfactual".
  const opportunityText = opportunity.modeledMonthlySavingsUsd > 0
    ? `with ~${formatBigUsd(opportunity.modeledMonthlySavingsUsd)}/mo in modeled opportunities to test—not verified savings`
    : observedExposureMatchesHeadline(input.summary.totalUsd, opportunity)
      // The headline just named the basis; repeating "observed
      // API-equivalent" here would reintroduce the noise this collapses.
      ? "effectively all of it exposure to investigate; savings unavailable without a matched counterfactual"
      : opportunity.observedExposureUsd > 0
        ? `with ${formatBigUsd(opportunity.observedExposureUsd)} in observed API-equivalent exposure to investigate; savings unavailable without a matched counterfactual`
        : "with no supported savings model in this window";
  // B1: the caption is the half of the artifact people actually paste, so it
  // takes the SAME unknown-total verdict as the card it captions. "$0.00 in
  // observed API-equivalent value" was the worst sentence the product could
  // publish — a claim of "these cost me nothing" made from records the very
  // same run reported as "financial evidence missing".
  const coverage = costCoverage(input.records);
  const headline = presentationBasis === "connected_missing"
    ? "amounts unavailable (no priced financial evidence)"
    : presentationBasis === "local_missing"
      ? `observed API-equivalent value ${UNAVAILABLE_TOTAL} (no priced cost evidence)`
      : `${formatBigUsd(input.summary.totalUsd, rawTotalUsd)} in ${captionBasis(presentationBasis)}`;
  // Carried in EVERY case with an unpriced record, not only the all-unknown
  // one: a real dollar total computed over part of the window still owes the
  // reader the count it could not price, and the terminal already discloses
  // it for the same records.
  const missingDisclosure = coverage.missingCount > 0
    ? `${missingCostPhrase(coverage.missingCount)}; ${MISSING_NOT_ZERO}. `
    : "";
  return (
    `${input.mode === "demo" ? "DEMO SAMPLE — " : ""}My AI receipt: ${headline}, ` +
    `${opportunityText}. ` +
    missingDisclosure +
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
  // The figure is labeled "API-equivalent exposure", so it sums ONLY the
  // estimated (API-equivalent) basis. Detected/unverified rows are a
  // different accounting basis; blending them here produced a number that
  // matched no other surface (shipped-audit $57.90-vs-$56.60 delta).
  const observedExposureUsd = Math.round(
    records.reduce(
      (total, record) => total + (
        observedRecordIds.has(record.id) && record.costConfidence === "estimated"
          ? record.amountUsd ?? 0
          : 0
      ),
      0
    ) * 100
  ) / 100;
  return { modeledMonthlySavingsUsd, observedExposureUsd };
}

/**
 * 0.9.5 equal-case collapse threshold, in INTEGER CENTS. Observed value
 * (headline) and observed exposure are two sums over near-identical record
 * subsets; sub-cent per-action rounding lets them drift a few cents apart
 * while describing the same evidence (the founder's live card read
 * "$2,281.89 value" vs "$2,281.87 exposure" — 2¢ of pure rounding noise).
 * At or under 5¢ the card and caption print ONE number with combined
 * phrasing; above it the two figures are treated as genuinely different and
 * both print. A nickel sits comfortably above the observed noise floor and
 * far below any real subset difference worth disclosing separately.
 *
 * Cents, not dollars, on purpose: a float comparison made the exact-5¢
 * boundary magnitude-dependent (20.05−20.00 → 0.05000000000000071 kept both
 * figures while 100.05−100.00 → 0.04999999999999716 collapsed). Both sides
 * round to displayed cents first, then diff as integers, so the boundary is
 * deterministic at every magnitude.
 */
const OBSERVED_EXPOSURE_MATCH_TOLERANCE_CENTS = 5;

/**
 * True when the card/caption would otherwise print the observed exposure as
 * a second number that reads identical to the headline observed value.
 * Display-level only: the underlying sums are untouched.
 */
function observedExposureMatchesHeadline(
  totalUsd: number,
  opportunity: { modeledMonthlySavingsUsd: number; observedExposureUsd: number }
): boolean {
  if (opportunity.modeledMonthlySavingsUsd > 0 || opportunity.observedExposureUsd <= 0) {
    return false;
  }
  const totalCents = Math.round(roundUsdCents(totalUsd) * 100);
  const exposureCents = Math.round(roundUsdCents(opportunity.observedExposureUsd) * 100);
  return Math.abs(totalCents - exposureCents) <= OBSERVED_EXPOSURE_MATCH_TOLERANCE_CENTS;
}

type FinancialPresentationBasis =
  | "demo"
  | "local_estimate"
  | "local_missing"
  | "provider_reported"
  | "connected_estimated"
  | "connected_unverified"
  | "connected_mixed"
  | "connected_missing";

function financialPresentationBasis(
  mode: ReportCardInput["mode"],
  records: readonly UsageRecord[]
): FinancialPresentationBasis {
  // B1: local-logs mode used to assume its own records were priced, so a
  // window of models absent from the pricing table fell through to
  // "local_estimate" and printed a $0.00 headline for an unknown total. The
  // terminal card's classifier already split these two cases; this is the
  // same split, so the card and the terminal reach the same verdict from the
  // same records.
  if (mode === "local-logs") {
    return records.some((record) => typeof record.amountUsd === "number")
      ? "local_estimate"
      : "local_missing";
  }
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

// §1.2 vocabulary: "cost/value" is killed copy — every label carries its
// basis word (billed / API-equivalent / detected) instead.
function headlineLabel(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "PROVIDER-REPORTED COST (THIS WINDOW)";
    case "connected_estimated": return "CONNECTED API-EQUIVALENT VALUE (ESTIMATED)";
    case "connected_unverified": return "CONNECTED DETECTED EVIDENCE (UNVERIFIED)";
    case "connected_mixed": return "MIXED CONNECTED EVIDENCE BASES";
    case "connected_missing": return "CONNECTED EVIDENCE · NO PRICED AMOUNT";
    case "local_missing": return "OBSERVED EVIDENCE · NO PRICED AMOUNT";
    case "local_estimate": return "OBSERVED API-EQUIVALENT VALUE";
    default: return "ILLUSTRATIVE EVIDENCE · DEMO SAMPLE";
  }
}

function captionBasis(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "provider-reported cost";
    case "connected_estimated": return "connected API-equivalent value (estimated)";
    case "connected_unverified": return "connected detected evidence (unverified)";
    case "connected_mixed": return "mixed connected evidence bases";
    case "connected_missing": return "connected evidence with no priced amount";
    case "local_missing": return "observed evidence with no priced amount";
    case "local_estimate": return "observed API-equivalent value";
    default: return "illustrative evidence";
  }
}

/**
 * B1: an unknown total renders as the word, never as a dollar figure. Both
 * missing bases route here — `analyzeSpend` hands both of them a `0`, and a
 * `0` that means "nothing could be priced" is the one number this card must
 * never print.
 */
function reportCardHeadlineAmount(
  basis: FinancialPresentationBasis,
  amount: number,
  rawAmount: number
): string {
  return basis === "connected_missing" || basis === "local_missing"
    ? UNAVAILABLE_TOTAL
    : formatBigUsd(amount, rawAmount);
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
  // Parity D1: the shared cents policy — every surface rounds identically.
  return `$${roundUsdCents(amount).toFixed(2)}`;
}

function formatBigUsd(amount: number, rawAmount = amount): string {
  if (rawAmount > 0 && rawAmount < 0.01) return "<$0.01";
  return `$${roundUsdCents(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A tiny, self-contained companion page that shows the receipt SVG together
 * with its caption (0.9.6).
 *
 * Why this exists: `report-card` wrote `ai-receipt.svg` and then left the
 * user to go find and open it — "not automatically showing on a html or
 * opening the file: making it inefficient." Auto-opening the bare .svg was
 * the obvious fix and the wrong one: the platform opener hands a .svg to
 * whatever claims that extension, which on a developer's machine is very
 * often an EDITOR (VS Code, Xcode, Inkscape), not a viewer. A user who asked
 * to see their receipt would get a wall of XML. An .html file is claimed by a
 * browser essentially everywhere, so opening the companion is the only way to
 * guarantee the artifact actually renders — and it puts the shareable card
 * and the caption a poster needs on ONE screen.
 *
 * The SVG stays the canonical shareable file. This page carries the SAME
 * redaction guarantees because it embeds the SAME generated SVG and caption
 * verbatim and adds no data of its own — no project, client, user, workspace,
 * or api-key names can enter here that were not already in the card.
 *
 * Deliberately self-contained: inline CSS only, no script, no network. It is
 * opened from a local file path, sometimes on a machine with no connectivity.
 */
export function generateReceiptCompanionHtml(input: {
  /** The generated card markup, inlined verbatim. */
  svg: string;
  /** The generated caption, rendered verbatim and selectable for pasting. */
  caption: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Receipt</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 32px 20px; background: #0C0D09; color: #EDEDED;
      font: 14px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      display: flex; flex-direction: column; align-items: center; gap: 24px;
      /* A narrow window must not auto-inflate the label out of proportion
         with the card it sits under. */
      -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
    }
    .card { width: 100%; max-width: 640px; }
    .card svg { width: 100%; height: auto; display: block; border: 1px solid rgba(255,255,255,.08); }
    .caption {
      width: 100%; max-width: 640px; padding: 16px; background: #12140E;
      border: 1px solid rgba(255,255,255,.08);
    }
    /* This page exists so the caption can be pasted into a post. user-select:
       all used to sit on .caption, which also wraps the "Caption to share" UI
       label, under white-space: pre-wrap — so one click-and-copy yielded 208
       characters for a ~190-character caption: the label, a newline, and the
       template's own indentation, all pasted into the user's post. Both
       properties now sit on an element holding the caption text and NOTHING
       else, and the interpolation carries no leading whitespace. */
    .caption-text { white-space: pre-wrap; -webkit-user-select: all; user-select: all; }
    .label { color: rgba(255,255,255,.47); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; margin-bottom: 8px; }
    .foot { color: rgba(255,255,255,.47); font-size: 12px; text-align: center; max-width: 640px; }
    .foot strong { color: #4CC98A; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">${input.svg}</div>
  <div class="caption">
    <div class="label">Caption to share</div>
    <div class="caption-text">${escapeXml(input.caption)}</div>
  </div>
  <p class="foot">
    The shareable file is <strong>the .svg next to this page</strong> — post that.
    Rendered locally; only totals, generic candidate categories, and evidence labels are included.
  </p>
</body>
</html>
`;
}
