import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_OPS_TOKEN_LENGTH,
  OPS_TOKEN_HEADER,
  checkOpsToken,
  constantTimeEquals,
} from "./ops-auth";

const GOOD_TOKEN = "s3cret-launch-token-0123456789abcdef";

function requestWith(token?: string): Request {
  return new Request("http://localhost/api/ops/telemetry-health", {
    headers: token === undefined ? {} : { [OPS_TOKEN_HEADER]: token },
  });
}

describe("constantTimeEquals", () => {
  it("matches identical secrets", () => {
    expect(constantTimeEquals(GOOD_TOKEN, GOOD_TOKEN)).toBe(true);
  });

  it.each([
    ["differs in the first character", `X${GOOD_TOKEN.slice(1)}`],
    ["differs in the last character", `${GOOD_TOKEN.slice(0, -1)}X`],
    ["differs in the middle", `${GOOD_TOKEN.slice(0, 8)}X${GOOD_TOKEN.slice(9)}`],
  ])("rejects a near miss that %s", (_name, presented) => {
    expect(constantTimeEquals(presented, GOOD_TOKEN)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["one character", "s"],
    ["a prefix of the real token", GOOD_TOKEN.slice(0, 10)],
    ["far longer than the real token", "x".repeat(4096)],
  ])("compares a %s token without throwing", (_name, presented) => {
    // THE POINT OF THIS TEST: crypto.timingSafeEqual throws on a length
    // mismatch. If the implementation ever stops hashing to a fixed-length
    // digest first, these cases become exceptions — a loud length oracle and
    // a 500 instead of a 401. Returning plain `false` proves the digest
    // comparison is still in place.
    expect(() => constantTimeEquals(presented, GOOD_TOKEN)).not.toThrow();
    expect(constantTimeEquals(presented, GOOD_TOKEN)).toBe(false);
  });

  it("does not treat a token that hashes the same as different casing", () => {
    expect(constantTimeEquals(GOOD_TOKEN.toUpperCase(), GOOD_TOKEN)).toBe(false);
  });
});

describe("checkOpsToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("authorizes the exact token", () => {
    expect(checkOpsToken(requestWith(GOOD_TOKEN), GOOD_TOKEN)).toBe("ok");
  });

  it("rejects a wrong token", () => {
    expect(checkOpsToken(requestWith("wrong-but-long-enough-token"), GOOD_TOKEN)).toBe(
      "unauthorized",
    );
  });

  it("rejects a missing header", () => {
    expect(checkOpsToken(requestWith(), GOOD_TOKEN)).toBe("unauthorized");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "    "],
    ["shorter than the minimum", "x".repeat(MIN_OPS_TOKEN_LENGTH - 1)],
  ])("reports not-configured when the server token is %s", (_name, configured) => {
    // An unset or placeholder secret must never authenticate ANYONE — not even
    // a caller who sends exactly the same empty/short string.
    expect(checkOpsToken(requestWith(configured ?? ""), configured)).toBe(
      "not-configured",
    );
  });

  it("accepts a token exactly at the minimum length", () => {
    const minimal = "a".repeat(MIN_OPS_TOKEN_LENGTH);
    expect(checkOpsToken(requestWith(minimal), minimal)).toBe("ok");
  });

  it("reads the live env when no token is passed explicitly", () => {
    vi.stubEnv("OPS_HEALTH_TOKEN", GOOD_TOKEN);
    expect(checkOpsToken(requestWith(GOOD_TOKEN))).toBe("ok");
    expect(checkOpsToken(requestWith("nope-nope-nope-nope"))).toBe("unauthorized");
  });

  it("ignores surrounding whitespace in the configured token", () => {
    // Env vars pasted into a dashboard routinely pick up a trailing newline.
    expect(checkOpsToken(requestWith(GOOD_TOKEN), `  ${GOOD_TOKEN}\n`)).toBe("ok");
  });
});
