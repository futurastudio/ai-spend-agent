/**
 * Hero receipt content — an excerpt of real renderer output (two runs of
 * lines: the header/value/bars block, then the VERIFY guidance).
 *
 * Transcribed verbatim from `node packages/cli/dist/index.js --sample
 * --no-color` (fixture: 9 records, $56.60 openai-sample + $30.40
 * anthropic-sample = $87.00). Lines may be excerpted, but never edit a
 * dollar figure, label, or bar by hand — regenerate from the CLI instead.
 *
 * Color mapping deviates from the CLI in exactly two disclosed ways:
 * cyan accents become neutral opacities, and section-label yellow becomes
 * ink. Amber marks estimated money only (.receipt scope).
 */

export type Tone = "green" | "amber" | "ink" | "strong" | "muted" | "faint";

export type Seg = {
  t: string;
  c?: Tone;
  /** The one ticking number: $0.00 → final over ~700ms. */
  tick?: boolean;
};

export type TextLine = { kind: "text"; at: number; segs: Seg[] };
export type BlankLine = { kind: "blank" };
export type BarLine = {
  kind: "bar";
  at: number;
  amountAt: number;
  label: string;
  /** Glyph bar exactly as the CLI prints it — exposed via aria-label only. */
  bar: string;
  amount: string;
  pct: string;
  /** Fill width as a percentage of the track. */
  width: number;
  amountTone: Tone;
};
export type ReceiptLine = TextLine | BlankLine | BarLine;

export const RECEIPT_COMMAND = "npx aibill";

/** When the trailing prompt appears and the clock stops. */
export const SETTLE_AT = 3350;

export const RECEIPT_LINES: ReceiptLine[] = [
  { kind: "blank" },
  {
    kind: "text",
    at: 950,
    segs: [
      { t: "  MODE / TRUST  ", c: "strong" },
      { t: "DEMO SAMPLE", c: "muted" },
    ],
  },
  {
    kind: "text",
    at: 1000,
    segs: [
      {
        t: "  illustrative only · not one invoice or homogeneous spend basis",
        c: "faint",
      },
    ],
  },
  { kind: "blank" },
  {
    kind: "text",
    at: 1150,
    segs: [
      { t: "  ILLUSTRATIVE COST / VALUE EVIDENCE  ", c: "strong" },
      { t: "evidence-labeled financial view", c: "faint" },
    ],
  },
  {
    kind: "text",
    at: 1250,
    segs: [
      { t: "  " },
      { t: "$87.00", c: "amber", tick: true },
      {
        t: "  combined illustrative evidence across 9 illustrative records",
        c: "muted",
      },
    ],
  },
  {
    kind: "text",
    at: 1450,
    segs: [
      { t: "  ● detected/unverified · evidence mix: ", c: "faint" },
      { t: "$56.60", c: "amber" },
      { t: " API-equivalent/estimated", c: "faint" },
    ],
  },
  {
    kind: "text",
    at: 1500,
    segs: [
      { t: "    · ", c: "faint" },
      { t: "$30.40", c: "ink" },
      { t: " detected/unverified", c: "faint" },
    ],
  },
  { kind: "blank" },
  {
    kind: "text",
    at: 1650,
    segs: [
      { t: "  ── 1 · DIAGNOSE ──  ", c: "strong" },
      { t: "what the available cost and usage evidence shows", c: "faint" },
    ],
  },
  { kind: "blank" },
  {
    kind: "text",
    at: 1800,
    segs: [
      { t: "  Cost/value evidence by source  ", c: "muted" },
      { t: "(by source)", c: "faint" },
    ],
  },
  { kind: "blank" },
  {
    kind: "bar",
    at: 1950,
    amountAt: 2550,
    label: "openai-sample",
    bar: "██████████████░░░░░░░░",
    amount: "$56.60",
    pct: "65%",
    width: 65,
    amountTone: "amber",
  },
  {
    kind: "bar",
    at: 2070,
    amountAt: 2670,
    label: "anthropic-sample",
    bar: "████████░░░░░░░░░░░░░░",
    amount: "$30.40",
    pct: "35%",
    width: 35,
    amountTone: "ink",
  },
  { kind: "blank" },
  {
    kind: "text",
    at: 2800,
    segs: [
      {
        t: "  › these are illustrative SAMPLE API-equivalent estimates — no local",
        c: "faint",
      },
    ],
  },
  {
    kind: "text",
    at: 2850,
    segs: [{ t: "    logs or account data were used", c: "faint" }],
  },
  {
    kind: "text",
    at: 3000,
    segs: [
      {
        t: "  › want your own evidence? run without --sample, or add official",
        c: "faint",
      },
    ],
  },
  {
    kind: "text",
    at: 3050,
    segs: [
      { t: "    provider-reported cost: ", c: "faint" },
      { t: "npx aibill connect openai", c: "muted" },
      { t: " or", c: "faint" },
    ],
  },
  {
    kind: "text",
    at: 3100,
    segs: [
      { t: "    ", c: "faint" },
      { t: "npx aibill connect anthropic", c: "muted" },
      { t: " (org admin/owner key)", c: "faint" },
    ],
  },
  { kind: "blank" },
];
