import { describe, expect, it } from "vitest";
import { normalizeAibillEmailAddress } from "./emailAddress.js";

describe("normalizeAibillEmailAddress", () => {
  it("normalizes the same bounded address used by opt-in email flows", () => {
    expect(normalizeAibillEmailAddress("  Founder@Example.COM "))
      .toBe("founder@example.com");
  });

  it("rejects malformed, control-bearing, and unbounded values", () => {
    for (const value of [
      "not-an-email",
      "founder@example.com\nBcc: victim@example.com",
      `a@${"x".repeat(250)}.com`
    ]) {
      expect(normalizeAibillEmailAddress(value)).toBeUndefined();
    }
  });
});
