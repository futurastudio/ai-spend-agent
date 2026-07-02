import { describe, expect, it } from "vitest";
import { UnsafeScanRootError, assertSafeScanRoot, unsafeScanRootReason } from "./scanGuard.js";

const fakeHome = "/Users/testuser";

describe("shared unsafe-scan-root guard (CLI + MCP)", () => {
  it("refuses the filesystem root", () => {
    expect(unsafeScanRootReason("/", fakeHome)).toMatch(/filesystem root/);
  });

  it("refuses the home directory", () => {
    expect(unsafeScanRootReason(fakeHome, fakeHome)).toMatch(/home directory/);
    expect(unsafeScanRootReason(`${fakeHome}/`, fakeHome)).toMatch(/home directory/);
  });

  it("refuses ancestors of the home directory such as /Users", () => {
    expect(unsafeScanRootReason("/Users", fakeHome)).toMatch(/contains your home directory/);
  });

  it("refuses system directories", () => {
    for (const path of ["/etc", "/usr", "/var", "/Library", "/System"]) {
      expect(unsafeScanRootReason(path, fakeHome), path).toBeDefined();
    }
  });

  it("allows a normal project directory inside home", () => {
    expect(unsafeScanRootReason(`${fakeHome}/projects/my-app`, fakeHome)).toBeUndefined();
  });

  it("assertSafeScanRoot throws a typed error for unsafe roots and passes safe ones", () => {
    expect(() => assertSafeScanRoot(fakeHome, fakeHome)).toThrow(UnsafeScanRootError);
    expect(() => assertSafeScanRoot(fakeHome, fakeHome)).toThrow(/too broad/);
    expect(() => assertSafeScanRoot(`${fakeHome}/projects/my-app`, fakeHome)).not.toThrow();
  });
});
