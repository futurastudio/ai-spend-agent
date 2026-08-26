/**
 * ONE money-rounding policy for every renderer in this package — terminal,
 * report.md, report.html, the SVG receipt card, and its caption (parity
 * audit D1: claude-opus-4-8 summed to exactly $15.995 and rendered ~$15.99
 * in the terminal but $16.00 in report.md/report.html, because two
 * formatters rounded order-dependent float accumulations differently).
 *
 * Policy (documented contract):
 * 1. Absorb float-summation noise by snapping to 4 decimal places first —
 *    two accumulation orders of the same records differ by ~1e-12, so both
 *    land on the same 4dp value.
 * 2. Round HALF-UP to cents ($X.XX5 → $X.X(X+1); 15.995 → 16.00) on the
 *    4dp INTEGER representation, never on binary floats where
 *    15.995 * 100 === 1599.4999… would silently flip the half case.
 *
 * Every user-facing dollar string must pass through roundUsdCents before
 * formatting; per-surface styling (commas, "<$0.01", tildes) stays with
 * each formatter.
 */
export function roundUsdCents(amount: number): number {
  if (!Number.isFinite(amount)) return amount;
  const sign = amount < 0 ? -1 : 1;
  const tenThousandths = Math.round(Math.abs(amount) * 10_000);
  const cents = Math.floor(tenThousandths / 100) + (tenThousandths % 100 >= 50 ? 1 : 0);
  return (sign * cents) / 100;
}

/**
 * ONE unknown-total vocabulary for every renderer, for the same reason
 * {@link roundUsdCents} exists.
 *
 * B1 (0.9.7): `analyzeSpend` sums a window of records into a plain `number`,
 * so a window in which NOTHING could be priced — every model id absent from
 * the pricing table — arrives at the renderers as `0`. report.md, the
 * report.html body, `--group-by` and the glance JSON each rebuild coverage
 * from the records and correctly print "Unavailable" / `null`. The headline
 * formatters did not: the shareable receipt, its caption, the companion page,
 * and the `report` terminal summary printed "$0.00" for money that is
 * UNKNOWN. On the one artifact the product asks people to post publicly,
 * "3 aggregates, $0.00" reads as "these cost me nothing" when the truth is
 * "cost unknown" — and it contradicted, two commands apart in the same
 * directory, what `npx aibill` and report.md said about the same records.
 *
 * Missing is not zero. A total is only a number when at least one record in
 * the set carries one; otherwise it is {@link UNAVAILABLE_TOTAL}. And a real
 * total computed over a partly-priced set still owes the reader the count it
 * could not price — see {@link missingCostPhrase}.
 */
export const UNAVAILABLE_TOTAL = "Unavailable";

/** The truth-contract clause the detail renderers already print verbatim. */
export const MISSING_NOT_ZERO = "missing/null is not zero";

export type CostCoverage = {
  recordCount: number;
  pricedCount: number;
  missingCount: number;
  /** Sum over the PRICED records only — never a stand-in for the unpriced ones. */
  amountUsd: number;
  /**
   * Nothing in a non-empty set could be priced: the total is unknown, and no
   * surface may render it as a dollar figure.
   */
  totalUnknown: boolean;
  /** A real dollar total that must still disclose how many records are missing. */
  partial: boolean;
};

/**
 * Coverage over whatever record set a surface is about to summarize. Priced
 * means "carries a number"; everything else (null, undefined, a `missing`
 * cost basis) counts as missing, so `pricedCount + missingCount` always
 * equals `recordCount` and no record can vanish between the two.
 */
export function costCoverage(
  records: readonly { readonly amountUsd?: number | null }[]
): CostCoverage {
  let pricedCount = 0;
  let amountUsd = 0;
  for (const record of records) {
    if (typeof record.amountUsd === "number") {
      pricedCount += 1;
      amountUsd += record.amountUsd;
    }
  }
  const recordCount = records.length;
  const missingCount = recordCount - pricedCount;
  return {
    recordCount,
    pricedCount,
    missingCount,
    amountUsd,
    totalUnknown: recordCount > 0 && pricedCount === 0,
    partial: pricedCount > 0 && missingCount > 0
  };
}

/**
 * "3 records missing cost" — the exact phrase the terminal evidence line
 * already prints, so the card and the terminal name the same gap the same
 * way. Empty when everything in the set was priced.
 */
export function missingCostPhrase(missingCount: number): string {
  if (missingCount <= 0) return "";
  return `${missingCount} record${missingCount === 1 ? "" : "s"} missing cost`;
}
