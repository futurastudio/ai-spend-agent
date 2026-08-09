import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const originalCwd = process.cwd();

describe("waitlist API", () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-waitlist-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("persists the normalized channel ref with local fallback signups", async () => {
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Launch@Test.com", ref: "hn" })
    }));

    expect(response.status).toBe(201);
    const saved = await readFile(join(process.cwd(), ".data", "waitlist.tsv"), "utf8");
    expect(saved).toMatch(/launch@test\.com\thn\n$/);
  });

  it("sends Teams & Agencies attribution in the normal Supabase payload", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "192.0.2.10",
      },
      body: JSON.stringify({ email: "Teams@Agency.com", ref: " Teams " }),
    }));

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://waitlist.test/rest/v1/waitlist",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "teams@agency.com",
          source_ref: "teams",
        }),
      }),
    );
  });

  it("logs visibly before using the legacy schema fallback without attribution", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "Could not find the source_ref column" }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "192.0.2.11",
      },
      body: JSON.stringify({ email: "legacy@agency.com", ref: "teams" }),
    }));

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { email: "legacy@agency.com", source_ref: "teams" },
      { email: "legacy@agency.com" },
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("waitlist table is missing the source_ref column"),
    );
  });
});
