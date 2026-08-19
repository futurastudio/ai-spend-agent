import { describe, expect, it } from "vitest";
import {
  AIBILL_IMPROVE_DELIVERY_V0,
  aibillCommandV0,
  aibillImproveCommandV0
} from "./runtimeCommands.js";

describe("guided action runtime command", () => {
  it("published delivery hands off the npm package command without exposing a path", () => {
    expect(AIBILL_IMPROVE_DELIVERY_V0).toBe("published");
    expect(aibillImproveCommandV0()).not.toContain("/Users/");
    expect(aibillImproveCommandV0()).not.toContain("<project");
    expect(aibillImproveCommandV0()).toBe("npx aibill improve");
    expect(aibillCommandV0("verify start finding --quality held --since-days 7")).toBe(
      "npx aibill verify start finding --quality held --since-days 7"
    );
  });

  it("keeps the eventual coordinated npm command explicit", () => {
    expect(aibillImproveCommandV0("published")).toBe("npx aibill improve");
    expect(aibillCommandV0("identify", "published")).toBe("npx aibill identify");
  });
});
