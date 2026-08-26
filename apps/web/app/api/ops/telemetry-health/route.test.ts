import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

const TOKEN = "launch-week-ops-token-0123456789";
const SUPABASE_URL = "https://telemetry.test";
const SERVICE_KEY = "test-service-role-key";

// `null` means "send no header at all". Deliberately not `undefined`: passing
// undefined to a defaulted parameter silently selects the default, which is
// how an earlier version of this test sent the CORRECT token and still
// claimed to be testing the missing-header path.
function request(token: string | null = TOKEN): Request {
  return new Request("http://localhost/api/ops/telemetry-health", {
    headers: token === null ? {} : { "x-ops-token": token },
  });
}

/** PostgREST reports an exact count in Content-Range when asked for one. */
function countResponse(total: number): Response {
  return new Response("[]", {
    status: 200,
    headers: { "content-range": `0-0/${total}` },
  });
}

type Row = { command: unknown; ok: unknown };

type Counts = {
  rows?: Row[];
  baselineEvents?: number;
  baselineErrors?: number;
  silenceEvents?: number;
  silencePriorEvents?: number;
};

/**
 * The route issues its five queries inside one Promise.all, so the call order
 * is deterministic: window rows, baseline total, baseline errors, silence
 * window, silence baseline.
 */
function stubQueries(counts: Counts = {}): ReturnType<typeof vi.fn> {
  const {
    rows = [
      ...Array.from({ length: 80 }, () => ({ command: "receipt", ok: true })),
      ...Array.from({ length: 20 }, () => ({ command: "report", ok: true })),
    ],
    baselineEvents = 187,
    baselineErrors = 4,
    silenceEvents = 40,
    silencePriorEvents = 300,
  } = counts;

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rows), { status: 200 }))
    .mockResolvedValueOnce(countResponse(baselineEvents))
    .mockResolvedValueOnce(countResponse(baselineErrors))
    .mockResolvedValueOnce(countResponse(silenceEvents))
    .mockResolvedValueOnce(countResponse(silencePriorEvents));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urlsOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([target]) => String(target));
}

describe("ops/telemetry-health", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPS_HEALTH_TOKEN", TOKEN);
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("auth", () => {
    it("rejects a missing token with a bare 401 and never touches the database", async () => {
      const fetchMock = stubQueries();
      const response = await GET(request(null));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a wrong token with a bare 401", async () => {
      const fetchMock = stubQueries();
      const response = await GET(request("wrong-token-but-long-enough"));
      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a token of a different length without a 500", async () => {
      // Guards the crypto.timingSafeEqual length trap: an unhashed compare
      // would throw here and surface as a 500 rather than a 401.
      const fetchMock = stubQueries();
      for (const attempt of ["", "x", "x".repeat(4096)]) {
        const response = await GET(request(attempt));
        expect(response.status).toBe(401);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a bare 503 and logs when OPS_HEALTH_TOKEN is not configured", async () => {
      vi.stubEnv("OPS_HEALTH_TOKEN", "");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchMock = stubQueries();

      const response = await GET(request(""));

      expect(response.status).toBe(503);
      // Pre-auth branch: it must not describe the server to a stranger.
      expect(await response.text()).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("OPS_HEALTH_TOKEN missing"),
      );
    });

    it("guards non-GET methods with 405 and an Allow header", async () => {
      for (const handler of [POST, PUT, PATCH, DELETE]) {
        const response = handler();
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("GET");
      }
    });
  });

  describe("queries", () => {
    it("reads telemetry_events with the service-role key on every query", async () => {
      const fetchMock = stubQueries();

      await GET(request());

      expect(fetchMock).toHaveBeenCalledTimes(5);
      for (const [target, init] of fetchMock.mock.calls) {
        expect(String(target)).toContain(`${SUPABASE_URL}/rest/v1/telemetry_events?`);
        expect(init?.headers).toMatchObject({
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        });
      }
    });

    it("asks for exact counts and never selects an identifying column", async () => {
      const fetchMock = stubQueries();

      await GET(request());

      const [windowUrl, ...countUrls] = urlsOf(fetchMock);
      expect(windowUrl).toContain("select=command,ok");
      for (const target of countUrls) {
        expect(target).toContain("select=id&limit=1");
      }
      // install_id is the one column that could re-identify a machine.
      for (const target of urlsOf(fetchMock)) {
        expect(target).not.toContain("install_id");
      }
      const countHeaders = fetchMock.mock.calls
        .slice(1)
        .map(([, init]) => (init?.headers as Record<string, string>)?.Prefer);
      expect(countHeaders).toEqual(Array(4).fill("count=exact"));
    });

    it("measures the silence baseline over a window that ENDS where silence begins", async () => {
      const fetchMock = stubQueries();

      await GET(request());

      // Without the `lt` bound the baseline would include the silent stretch
      // and a long outage would silence its own alert.
      const silenceBaselineUrl = urlsOf(fetchMock)[4];
      expect(silenceBaselineUrl).toContain("received_at=gte.");
      expect(silenceBaselineUrl).toContain("&received_at=lt.");
    });
  });

  describe("aggregate-only response", () => {
    it("returns counts and nothing that identifies a machine or a user", async () => {
      stubQueries();

      const response = await GET(request());
      const body = await response.json();
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(body).sort()).toEqual([
        "alerts",
        "baseline",
        "commands",
        "generatedAt",
        "ok",
        "silence",
        "window",
      ]);
      for (const forbidden of ["install", "email", "@", "stack", "/users/"]) {
        expect(serialized.toLowerCase()).not.toContain(forbidden);
      }
      // Per-command entries carry a label and two counts — nothing else.
      for (const entry of body.commands) {
        expect(Object.keys(entry).sort()).toEqual(["command", "errors", "runs"]);
      }
      expect(body.ok).toBe(true);
      expect(body.alerts).toEqual([]);
      expect(body.window).toEqual({
        minutes: 60,
        events: 100,
        errors: 0,
        errorRatePct: 0,
        truncated: false,
      });
      expect(body.commands).toEqual([
        { command: "receipt", runs: 80, errors: 0 },
        { command: "report", runs: 20, errors: 0 },
      ]);
      expect(body.baseline).toEqual({
        minutes: 1440,
        events: 187,
        errors: 4,
        errorRatePct: 2.1,
      });
    });

    it("collapses an off-allowlist command label to \"other\" on the way out", async () => {
      // Defence in depth: the ingest route already allowlists, but a row that
      // arrived some other way must not leak free text into the alert payload.
      stubQueries({
        rows: [
          { command: "receipt", ok: true },
          { command: "/Users/testuser/secret-project --token=abc", ok: false },
        ],
      });

      const response = await GET(request());
      const body = await response.json();

      expect(JSON.stringify(body)).not.toContain("secret-project");
      expect(body.commands).toEqual([
        { command: "receipt", runs: 1, errors: 0 },
        { command: "other", runs: 1, errors: 1 },
      ]);
    });

    it("counts a row that is not explicitly ok:true as a failure", async () => {
      // Fail visible, not silently clean, if a malformed row ever appears.
      stubQueries({
        rows: [
          { command: "receipt", ok: true },
          { command: "receipt", ok: null },
          { command: "receipt", ok: "false" },
        ],
      });

      const body = await (await GET(request())).json();

      expect(body.window.events).toBe(3);
      expect(body.window.errors).toBe(2);
    });
  });

  describe("thresholds end to end", () => {
    it("goes red and names the failing command", async () => {
      stubQueries({
        rows: [
          ...Array.from({ length: 990 }, () => ({ command: "receipt", ok: true })),
          ...Array.from({ length: 10 }, () => ({ command: "improve", ok: false })),
        ],
      });

      const response = await GET(request());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.alerts).toHaveLength(1);
      expect(body.alerts[0].code).toBe("command_failing");
      expect(body.alerts[0].detail).toContain('"improve" failed 10 of its 10 runs');
    });

    it("goes red on silence after a busy period", async () => {
      stubQueries({
        rows: [],
        silenceEvents: 0,
        silencePriorEvents: 400,
      });

      const body = await (await GET(request())).json();

      expect(body.ok).toBe(false);
      expect(body.alerts.map((a: { code: string }) => a.code)).toEqual([
        "telemetry_silent",
      ]);
    });

    it("stays green on silence from a fleet that was never busy", async () => {
      stubQueries({ rows: [], silenceEvents: 0, silencePriorEvents: 3 });

      const body = await (await GET(request())).json();

      expect(body.ok).toBe(true);
      expect(body.alerts).toEqual([]);
    });

    it("flags a truncated window without hiding the counts it did read", async () => {
      stubQueries({
        rows: Array.from({ length: 5001 }, () => ({ command: "receipt", ok: true })),
      });

      const body = await (await GET(request())).json();

      expect(body.window.truncated).toBe(true);
      expect(body.window.events).toBe(5000);
    });
  });

  describe("storage failures are loud", () => {
    it("returns 503 when Supabase is not configured", async () => {
      vi.stubEnv("SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await GET(request());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "supabase_not_configured",
      });
      expect(errorSpy).toHaveBeenCalled();
    });

    it("returns 503 when a count query fails, rather than reporting a green zero", async () => {
      // The failure mode this prevents: treating an unreadable table as "no
      // errors found" and staying green through an outage.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("permission denied", { status: 401 })),
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await GET(request());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "telemetry_query_failed",
      });
      expect(errorSpy).toHaveBeenCalled();
    });

    it("returns 503 when Supabase is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await GET(request());

      expect(response.status).toBe(503);
    });

    it("returns 503 when a count query answers without a Content-Range", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("[]", { status: 200 }))
        .mockResolvedValue(new Response("[]", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await GET(request());

      expect(response.status).toBe(503);
    });
  });
});
