import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

// The route keeps an in-memory per-IP rate limiter, so every test talks from
// its own TEST-NET-3 address to avoid bleeding limits across tests.
let nextIpOctet = 1;
function uniqueIp(): string {
  return `203.0.113.${nextIpOctet++}`;
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installId: "5f2b0c4e-6c1a-4b9e-8f3d-2a7c9e1b4d6f",
    command: "receipt",
    version: "0.9.1",
    os: "darwin",
    arch: "arm64",
    ci: false,
    durationBucket: "lt5s",
    ok: true,
    ts: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

// Smallest legal event (~186 bytes serialized): 21 of these stay under the
// 4 KB byte cap, so the batch-count cap gets exercised on its own.
function minimalEvent(): Record<string, unknown> {
  return validEvent({
    command: "full",
    version: "0.0.0",
    os: "linux",
    arch: "x64",
    durationBucket: "lt1s",
    ts: "2026-08-24T12:00:00Z",
  });
}

function post(body: unknown, ip: string = uniqueIp()): Promise<Response> {
  return POST(
    new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function stubSupabase(): ReturnType<typeof vi.fn> {
  vi.stubEnv("SUPABASE_URL", "https://telemetry.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("telemetry API", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores a valid batch as snake_case rows through the service-role key", async () => {
    const fetchMock = stubSupabase();

    const response = await post({
      events: [
        validEvent(),
        validEvent({ command: "improve", durationBucket: "gte30s", ok: false }),
      ],
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe("https://telemetry.test/rest/v1/telemetry_events");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        apikey: "test-service-role-key",
        Authorization: "Bearer test-service-role-key",
        Prefer: "return=minimal",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual([
      {
        install_id: "5f2b0c4e-6c1a-4b9e-8f3d-2a7c9e1b4d6f",
        command: "receipt",
        version: "0.9.1",
        os: "darwin",
        arch: "arm64",
        ci: false,
        duration_bucket: "lt5s",
        ok: true,
        ts: "2026-08-24T12:00:00.000Z",
      },
      {
        install_id: "5f2b0c4e-6c1a-4b9e-8f3d-2a7c9e1b4d6f",
        command: "improve",
        version: "0.9.1",
        os: "darwin",
        arch: "arm64",
        ci: false,
        duration_bucket: "gte30s",
        ok: false,
        ts: "2026-08-24T12:00:00.000Z",
      },
    ]);
  });

  it("accepts an uppercase uuid and stores it lowercased", async () => {
    const fetchMock = stubSupabase();

    const response = await post({
      events: [validEvent({ installId: "5F2B0C4E-6C1A-4B9E-8F3D-2A7C9E1B4D6F" })],
    });

    expect(response.status).toBe(204);
    const rows = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(rows[0].install_id).toBe("5f2b0c4e-6c1a-4b9e-8f3d-2a7c9e1b4d6f");
  });

  it("maps free-text commands to \"other\" and never stores the raw string", async () => {
    const fetchMock = stubSupabase();
    const freeText = "receipt --json /Users/jose/secret-project";

    const response = await post({ events: [validEvent({ command: freeText })] });

    expect(response.status).toBe(204);
    const rawBody = String(fetchMock.mock.calls[0][1]?.body);
    expect(JSON.parse(rawBody)[0].command).toBe("other");
    expect(rawBody).not.toContain("secret-project");
  });

  it("rejects an event carrying an unknown field with a bare 422", async () => {
    const fetchMock = stubSupabase();

    const response = await post({
      events: [validEvent({ note: "free text has no home here" })],
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an event missing a required field", async () => {
    const fetchMock = stubSupabase();
    const partial = validEvent();
    delete partial.ts;

    const response = await post({ events: [partial] });

    expect(response.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["installId is not a uuid", { installId: "not-a-uuid" }],
    ["installId is not uuid v4", { installId: "5f2b0c4e-6c1a-1b9e-8f3d-2a7c9e1b4d6f" }],
    ["installId is not a string", { installId: 42 }],
    ["command is empty", { command: "" }],
    ["command exceeds the length cap", { command: "x".repeat(65) }],
    ["command is not a string", { command: 7 }],
    ["version is not x.y.z", { version: "1.2" }],
    ["version carries a pre-release tag", { version: "1.2.3-beta.1" }],
    ["version is not a string", { version: 1.23 }],
    ["os is off-enum", { os: "windows" }],
    ["arch is off-enum", { arch: "x86" }],
    ["ci is a string", { ci: "false" }],
    ["durationBucket is off-enum", { durationBucket: "lt10s" }],
    ["ok is a number", { ok: 1 }],
    ["ts is not ISO", { ts: "yesterday" }],
    ["ts has impossible date parts", { ts: "2026-13-45T99:99:99Z" }],
    ["ts lacks a zone", { ts: "2026-08-24T12:00:00" }],
    ["ts is not a string", { ts: 1724500000 }],
  ])("rejects 422 when %s", async (_name, overrides) => {
    const fetchMock = stubSupabase();

    const response = await post({ events: [validEvent(overrides)] });

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["body is a bare array", [validEvent()]],
    ["body has no events key", {}],
    ["events is empty", { events: [] }],
    ["events exceeds the batch cap", { events: Array.from({ length: 21 }, () => minimalEvent()) }],
    ["an unknown top-level key rides along", { events: [validEvent()], extra: true }],
    ["events is not an array", { events: "nope" }],
    ["an event is not an object", { events: ["nope"] }],
  ])("rejects 422 when %s", async (_name, body) => {
    const fetchMock = stubSupabase();

    const response = await post(body);

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await post("{nope");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  it("rejects bodies over 4 KB with 413 before parsing", async () => {
    const response = await post(`"${"x".repeat(5000)}"`);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
  });

  it("guards non-POST methods with 405 and an Allow header", async () => {
    for (const handler of [GET, PUT, PATCH, DELETE]) {
      const response = handler();
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(await response.text()).toBe("");
    }
  });

  it("rate limits a single IP after 20 requests in the window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ip = uniqueIp();

    for (let i = 0; i < 20; i++) {
      const response = await post({ events: [validEvent()] }, ip);
      expect(response.status).toBe(204);
    }
    const limited = await post({ events: [validEvent()] }, ip);

    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("");
  });

  it("returns 503 with no detail when the Supabase insert fails", async () => {
    vi.stubEnv("SUPABASE_URL", "https://telemetry.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("supabase detail", { status: 500 })),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await post({ events: [validEvent()] });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("supabase insert failed: 500"),
    );
  });

  it("returns 503 when Supabase is unreachable", async () => {
    vi.stubEnv("SUPABASE_URL", "https://telemetry.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await post({ events: [validEvent()] });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("accepts and drops events in dev when Supabase is not configured", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await post({ events: [validEvent()] });

    expect(response.status).toBe(204);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped 1 event(s) (dev)"),
    );
  });
});
