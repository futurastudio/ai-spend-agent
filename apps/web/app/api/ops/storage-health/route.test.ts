import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

const TOKEN = "launch-week-ops-token-0123456789";
const SUPABASE_URL = "https://waitlist.test";
const SERVICE_KEY = "test-service-role-key";
const CANARY_EMAIL = "aibill-storage-canary@canary.invalid";

// `null` means "send no header"; see the telemetry-health test for why this
// is not `undefined`.
function request(token: string | null = TOKEN): Request {
  return new Request("http://localhost/api/ops/storage-health", {
    method: "POST",
    headers: token === null ? {} : { "x-ops-token": token },
  });
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function callsOf(fetchMock: ReturnType<typeof vi.fn>): Call[] {
  return fetchMock.mock.calls.map(([target, init]) => ({
    url: String(target),
    method: String(init?.method ?? "GET"),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body === undefined ? undefined : String(init.body),
  }));
}

/** The happy path: preclean 204, insert 201, delete 200 + 1 row, verify []. */
function stubHealthyRoundTrip(): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ops/storage-health", () => {
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
    it("rejects a missing token with a bare 401 and writes nothing", async () => {
      const fetchMock = stubHealthyRoundTrip();
      const response = await POST(request(null));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a wrong token and writes nothing", async () => {
      const fetchMock = stubHealthyRoundTrip();
      const response = await POST(request("wrong-token-but-long-enough"));
      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects tokens of any length without a 500", async () => {
      const fetchMock = stubHealthyRoundTrip();
      for (const attempt of ["", "x", "x".repeat(4096)]) {
        expect((await POST(request(attempt))).status).toBe(401);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a bare 503 when OPS_HEALTH_TOKEN is not configured", async () => {
      vi.stubEnv("OPS_HEALTH_TOKEN", "short");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchMock = stubHealthyRoundTrip();

      const response = await POST(request("short"));

      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("guards non-POST methods with 405", async () => {
      for (const handler of [GET, PUT, PATCH, DELETE]) {
        const response = handler();
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("POST");
      }
    });
  });

  describe("the round trip really exercises the signup path", () => {
    it("uses the SAME table and the SAME service-role credentials as a real signup", async () => {
      // The whole point of the endpoint: a probe running against different
      // credentials could not detect the bad key it exists to detect.
      const fetchMock = stubHealthyRoundTrip();

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const call of callsOf(fetchMock)) {
        expect(call.url).toContain(`${SUPABASE_URL}/rest/v1/waitlist`);
        expect(call.headers).toMatchObject({
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        });
      }
    });

    it("walks preclean -> insert -> delete -> verify in order", async () => {
      const fetchMock = stubHealthyRoundTrip();

      const body = await (await POST(request())).json();
      const calls = callsOf(fetchMock);

      expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST", "DELETE", "GET"]);
      expect(body.stages).toEqual({
        preclean: "ok",
        insert: "ok",
        delete: "ok",
        verify: "ok",
      });
      expect(body.ok).toBe(true);
      expect(body.attribution).toBe("ok");
      expect(typeof body.roundTripMs).toBe("number");
    });

    it("writes the canary row with its attribution ref", async () => {
      const fetchMock = stubHealthyRoundTrip();

      await POST(request());

      const insert = callsOf(fetchMock)[1];
      expect(JSON.parse(String(insert.body))).toEqual({
        email: CANARY_EMAIL,
        source_ref: "canary",
      });
    });

    it("uses an obviously synthetic address in a reserved-invalid TLD", async () => {
      const fetchMock = stubHealthyRoundTrip();

      await POST(request());

      // RFC 2606: .invalid can never resolve, so the probe can never mail a
      // real person and can never collide with a real signup.
      expect(CANARY_EMAIL.endsWith(".invalid")).toBe(true);
      expect(JSON.parse(String(callsOf(fetchMock)[1].body)).email).toBe(CANARY_EMAIL);
    });

    it("only ever deletes an EXACT match on the canary address", async () => {
      // Safety test with teeth: this endpoint issues DELETE against the live
      // signup table. A prefix, domain, or `like` filter here would be a
      // delete pointed at real launch signups.
      const fetchMock = stubHealthyRoundTrip();

      await POST(request());

      const deletes = callsOf(fetchMock).filter((c) => c.method === "DELETE");
      expect(deletes).toHaveLength(2);
      for (const call of deletes) {
        expect(call.url).toContain(`email=eq.${encodeURIComponent(CANARY_EMAIL)}`);
        expect(call.url).not.toContain("like");
        expect(call.url).not.toContain("neq");
      }
    });

    it("asks for the deleted rows back so a phantom insert cannot pass", async () => {
      const fetchMock = stubHealthyRoundTrip();

      await POST(request());

      expect(callsOf(fetchMock)[2].headers.Prefer).toBe("return=representation");
    });
  });

  describe("it goes red when storage is broken", () => {
    it("fails at insert when the service-role key is rejected", async () => {
      // THE HEADLINE CASE. A rotated or expired key makes real signups 503
      // while the old `{}` canary stayed green. This must be red.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.failedStage).toBe("insert");
      expect(body.reason).toBe("http 401");
      expect(body.stages.insert).toBe("failed");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("round trip failed at insert"),
      );
    });

    it("fails at preclean when the key is rejected before anything is written", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const body = await (await POST(request())).json();

      expect(body.ok).toBe(false);
      expect(body.failedStage).toBe("preclean");
      expect(body.reason).toBe("http 403");
    });

    it("fails when Supabase is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.failedStage).toBe("preclean");
      expect(body.reason).toContain("unreachable");
    });

    it("fails when the insert returned 201 but nothing was actually stored", async () => {
      // A "successful" write that did not persist is the subtlest storage
      // failure there is; the delete-with-representation step catches it.
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(null, { status: 204 }))
          .mockResolvedValueOnce(new Response(null, { status: 201 }))
          .mockResolvedValueOnce(new Response("[]", { status: 200 })),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const body = await (await POST(request())).json();

      expect(body.ok).toBe(false);
      expect(body.failedStage).toBe("delete");
      expect(body.reason).toContain("removed 0");
    });

    it("fails when the canary row survives cleanup", async () => {
      // Guarantees the promise "this never leaves rows behind" is checked,
      // not merely asserted in a comment.
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(null, { status: 204 }))
          .mockResolvedValueOnce(new Response(null, { status: 201 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }),
          ),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const body = await (await POST(request())).json();

      expect(body.ok).toBe(false);
      expect(body.failedStage).toBe("verify");
      expect(body.reason).toBe("canary row survived cleanup");
    });

    it("fails loudly when Supabase is not configured at all", async () => {
      vi.stubEnv("SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.reason).toBe("supabase_not_configured");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("real signups are being refused right now"),
      );
    });
  });

  describe("attribution drift", () => {
    it("goes red when the source_ref column is gone, even though storage works", async () => {
      // The waitlist route silently falls back to an unattributed insert here
      // (a lost signup is worse than lost attribution). Silent is right for
      // the user and wrong for the founder — so the probe says it out loud.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ message: "Could not find the source_ref column" }),
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 201 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("[]", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("missing_source_ref");
      expect(body.attribution).toBe("missing_source_ref");
      // Storage itself was fine, so the round trip still completed and still
      // cleaned up after itself.
      expect(body.stages).toEqual({
        preclean: "ok",
        insert: "ok",
        delete: "ok",
        verify: "ok",
      });
      expect(callsOf(fetchMock).map((c) => JSON.parse(c.body ?? "null"))[1]).toEqual({
        email: CANARY_EMAIL,
        source_ref: "canary",
      });
      expect(callsOf(fetchMock).map((c) => JSON.parse(c.body ?? "null"))[2]).toEqual({
        email: CANARY_EMAIL,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing the source_ref column"),
      );
    });

    it("treats an unrelated 400 as a hard insert failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(null, { status: 204 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ message: "malformed request" }), {
              status: 400,
            }),
          ),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const body = await (await POST(request())).json();

      expect(body.ok).toBe(false);
      expect(body.failedStage).toBe("insert");
      expect(body.reason).toBe("http 400");
    });
  });
});
