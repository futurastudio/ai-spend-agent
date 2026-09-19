/**
 * The Workspace status switch. Unset (today): the pre-launch line is unchanged.
 * Set to the exact hosted origin: the "not launched" line becomes the launched one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceOrigin } from "./workspace-entry";

const ORIGIN = "https://app.asktilden.com";
afterEach(() => vi.unstubAllEnvs());

describe("workspaceOrigin", () => {
  it("accepts only an exact https origin, or http on localhost", () => {
    expect(workspaceOrigin(undefined)).toBeNull();
    expect(workspaceOrigin("")).toBeNull();
    expect(workspaceOrigin(ORIGIN)).toBe(ORIGIN);
    expect(workspaceOrigin(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(workspaceOrigin("http://127.0.0.1:3186")).toBe("http://127.0.0.1:3186");
    for (const bad of ["http://app.asktilden.com", `${ORIGIN}/sign-in`, `${ORIGIN}?x=1`, "https://u:p@app.asktilden.com", "app.asktilden.com", "javascript:alert(1)"]) {
      expect(workspaceOrigin(bad), bad).toBeNull();
    }
  });
});

describe("WORKSPACE_STATUS_LINE", () => {
  async function statusLine() {
    vi.resetModules();
    return (await import("./workspace-entry")).WORKSPACE_STATUS_LINE;
  }

  it("unset: the pre-launch line stands", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_URL", "");
    expect(await statusLine()).toBe("Workspace is not launched publicly. Local mode stays free and private.");
  });

  it("set to the hosted origin: sign-in is open", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_URL", ORIGIN);
    expect(await statusLine()).toBe("Workspace sign-in is open. Local mode stays free and private.");
  });

  it("set to something that is not an exact origin: treated as absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKSPACE_URL", `${ORIGIN}/sign-in`);
    expect(await statusLine()).toBe("Workspace is not launched publicly. Local mode stays free and private.");
  });
});
