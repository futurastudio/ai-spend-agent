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
    vi.stubEnv("WAITLIST_CONFIRMATION_ENABLED", "false");
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
        JSON.stringify({ code: "PGRST204", message: "Could not find the source_ref column" }),
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

  it("rejects invalid email before contacting storage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.20" },
      body: JSON.stringify({ email: "invalid", ref: "launch" }),
    }));
    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate without exposing whether an address was already registered", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ code: "23505" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.21" },
      body: JSON.stringify({ email: "duplicate@example.test", ref: "launch" }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 409, body: { code: "23503", details: "person@example.test: foreign key violation" } },
    { status: 409, body: {} },
    { status: 400, body: { code: "23514", message: "source_ref violates a check constraint" } },
  ])("does not acknowledge or retry a nonduplicate storage error ($status / $body.code)", async ({ status, body }) => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": `storage-error-${body.code ?? "unknown"}` },
      body: JSON.stringify({ email: "person@example.test", ref: "launch" }),
    }));
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("person@example.test");
  });

  it("does not acknowledge success when configured storage rejects the signup", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.22" },
      body: JSON.stringify({ email: "failure@example.test" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error");
  });

  it("refuses production signup when durable storage is unconfigured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.23" },
      body: JSON.stringify({ email: "no-store@example.test" }),
    }));
    expect(response.status).toBe(503);
    await expect(readFile(join(process.cwd(), ".data", "waitlist.tsv"))).rejects.toThrow();
  });

  it("normalizes an invalid referral to direct before storage", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.24" },
      body: JSON.stringify({ email: "ref@example.test", ref: "https://example.test/a?secret=1" }),
    }));
    expect(response.status).toBe(201);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "ref@example.test", source_ref: "direct" });
  });

  it("limits repeated requests without issuing another storage write", async () => {
    vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const response = await POST(new Request("http://localhost/api/waitlist", {
        method: "POST", headers: { "x-forwarded-for": "192.0.2.25" },
        body: JSON.stringify({ email: "rate@example.test" }),
      }));
      statuses.push(response.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  describe("automatic confirmation", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_URL", "https://waitlist.test");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-only");
      vi.stubEnv("WAITLIST_CONFIRMATION_ENABLED", "true");
      vi.stubEnv("RESEND_API_KEY", "fixture-email-key");
      vi.stubEnv("WAITLIST_EMAIL_FROM", "team@example.test");
      vi.stubEnv("WAITLIST_EMAIL_REPLY_TO", "support@example.test");
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    const signup = (ip: string) => POST(new Request("http://localhost/api/waitlist", {
      method: "POST", headers: { "x-forwarded-for": ip, "x-tilden-confirmation": "waitlist-v1" },
      body: JSON.stringify({ email: "Onboarding@Example.test", ref: "launch" }),
    }));

    it("sends for the marked landing form after storage, preserves attribution, and does not resend for a duplicate", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 201 }))
        .mockResolvedValueOnce(Response.json({ id: "email-fixture-id" }))
        .mockResolvedValueOnce(Response.json({ code: "23505" }, { status: 409 }));
      vi.stubGlobal("fetch", fetchMock);
      const first = await signup("192.0.2.40");
      const duplicate = await signup("192.0.2.41");
      expect(first.status).toBe(201);
      expect(duplicate.status).toBe(201);
      expect(await first.json()).toEqual(await duplicate.json());
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://waitlist.test/rest/v1/waitlist", "https://api.resend.com/emails",
        "https://waitlist.test/rest/v1/waitlist",
      ]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "onboarding@example.test", source_ref: "launch" });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ to: ["onboarding@example.test"], reply_to: "support@example.test" });
    });

    it.each([
      { label: "legacy website form", ref: "direct", marker: undefined },
      { label: "legacy referral form", ref: "github-readme", marker: undefined },
      { label: "CLI receipt", ref: "cli-receipt", marker: undefined },
      { label: "CLI signup", ref: "cli-signup-starfund", marker: undefined },
      { label: "Glance study", ref: "github-glance-study", marker: undefined },
      { label: "unknown confirmation version", ref: "launch", marker: "waitlist-v2" },
      { label: "marked CLI signup", ref: "cli-signup", marker: "waitlist-v1" },
      { label: "marked Glance study", ref: " GitHub-Glance-Study ", marker: "waitlist-v1" },
    ])("preserves capture without contacting email for $label", async ({ ref, marker }) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      const response = await POST(new Request("http://localhost/api/waitlist", {
        method: "POST",
        headers: {
          "x-forwarded-for": `confirmation-scope-${ref}-${marker ?? "none"}`,
          ...(marker ? { "x-tilden-confirmation": marker } : {}),
        },
        body: JSON.stringify({ email: "Existing-Surface@Example.test", ref }),
      }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://waitlist.test/rest/v1/waitlist");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        email: "existing-surface@example.test", source_ref: ref.trim().toLowerCase(),
      });
    });

    it("keeps registration successful when the email service rejects sending", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 201 }))
        .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const response = await signup("192.0.2.42");
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not send a confirmation for failed storage", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await signup("192.0.2.43")).status).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("bounds storage and never sends or automatically retries after an uncertain timeout", async () => {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const fetchMock = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = signup("192.0.2.45");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new DOMException("Storage deadline reached", "TimeoutError"));
      expect((await pending).status).toBe(503);
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://waitlist.test/rest/v1/waitlist");
    });

    it("uses one storage deadline across the legacy-column fallback", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      vi.stubEnv("WAITLIST_CONFIRMATION_ENABLED", "false");
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ code: "PGRST204", message: "Missing source_ref column" }, { status: 400 }))
        .mockResolvedValueOnce(new Response(null, { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await signup("192.0.2.46")).status).toBe(201);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
    });

    it("sends once for concurrent differently cased signups only after the unique insert is acknowledged", async () => {
      let finishInsert!: (response: Response) => void;
      let inserts = 0;
      const fetchMock = vi.fn().mockImplementation((url) => {
        if (url === "https://api.resend.com/emails") return Promise.resolve(Response.json({ id: "race-confirmation" }));
        inserts += 1;
        return inserts === 1
          ? new Promise<Response>(resolve => { finishInsert = resolve; })
          : Promise.resolve(Response.json({ code: "23505" }, { status: 409 }));
      });
      vi.stubGlobal("fetch", fetchMock);
      const first = signup("192.0.2.47");
      await vi.waitFor(() => expect(inserts).toBe(1));
      const duplicate = await POST(new Request("http://localhost/api/waitlist", {
        method: "POST", headers: { "x-forwarded-for": "192.0.2.48", "x-tilden-confirmation": "waitlist-v1" },
        body: JSON.stringify({ email: "  ONBOARDING@example.test ", ref: "second-source" }),
      }));
      expect(duplicate.status).toBe(201);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://waitlist.test/rest/v1/waitlist", "https://waitlist.test/rest/v1/waitlist",
      ]);
      finishInsert(new Response(null, { status: 201 }));
      expect((await first).status).toBe(201);
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toMatchObject([
        { email: "onboarding@example.test", source_ref: "launch" },
        { email: "onboarding@example.test", source_ref: "second-source" },
        { to: ["onboarding@example.test"] },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does not send from the development TSV fallback", async () => {
      vi.stubEnv("SUPABASE_URL", "");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      expect((await signup("192.0.2.44")).status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await readFile(join(process.cwd(), ".data", "waitlist.tsv"), "utf8")).toContain("onboarding@example.test");
    });
  });
});
