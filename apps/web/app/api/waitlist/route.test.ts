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
});
