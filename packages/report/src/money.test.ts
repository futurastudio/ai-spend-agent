import { describe, expect, it } from "vitest";
import { roundUsdCents } from "./money.js";

describe("shared money-rounding policy (parity audit D1)", () => {
  it("rounds HALF-UP at cents after absorbing float noise at 4dp — boundary table", () => {
    // Every $X.XX5 half-cent boundary goes UP; float traps (values whose
    // binary double sits a hair below the printed half) must not flip it.
    const table: Array<[number, number]> = [
      [15.995, 16.0],      // the corpus case (claude-opus-4-8)
      [2.675, 2.68],       // classic float trap: 2.675 * 100 === 267.49999…
      [1.005, 1.01],       // 1.005 stored as 1.00499999…
      [0.125, 0.13],
      [0.135, 0.14],
      [1234.565, 1234.57],
      [0.62, 0.62],        // exact cents pass through
      [15.9949, 15.99],    // genuinely below the half — stays down
      [16.0051, 16.01],
      [0, 0],
      [-15.995, -16.0]     // symmetric for signed values
    ];
    for (const [input, expected] of table) {
      expect(roundUsdCents(input), `roundUsdCents(${input})`).toBe(expected);
    }
  });

  it("both accumulation orders of the corpus addends land on the same cents", () => {
    // 6.452 + 0.3563 + 9.1867 = 15.995 exactly in decimal; the two float
    // accumulation orders differ by ~1e-15 and used to round apart
    // (terminal ~$15.99 vs report.md/html $16.00).
    const forward = 6.452 + 0.3563 + 9.1867;
    const backward = 9.1867 + 0.3563 + 6.452;
    expect(roundUsdCents(forward)).toBe(16.0);
    expect(roundUsdCents(backward)).toBe(16.0);
  });
});
