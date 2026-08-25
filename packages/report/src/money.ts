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
