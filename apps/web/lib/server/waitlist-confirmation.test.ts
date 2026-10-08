import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendWaitlistConfirmation } from "./waitlist-confirmation";

describe("waitlist confirmation transport", () => {
  beforeEach(() => {
    vi.stubEnv("WAITLIST_CONFIRMATION_ENABLED", "true");
    vi.stubEnv("RESEND_API_KEY", "fixture-email-key");
    vi.stubEnv("WAITLIST_EMAIL_FROM", "team@example.test");
    vi.stubEnv("WAITLIST_EMAIL_REPLY_TO", "support@example.test");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: "email-fixture-id" }))));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["", "false", "1"])("does not send without the explicit enable flag (%s)", async (flag) => {
    vi.stubEnv("WAITLIST_CONFIRMATION_ENABLED", flag);
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["RESEND_API_KEY", "WAITLIST_EMAIL_FROM", "WAITLIST_EMAIL_REPLY_TO"])("does not send with missing %s", async (key) => {
    vi.stubEnv(key, "");
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "unconfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects header injection in configured mailbox fields", async () => {
    vi.stubEnv("WAITLIST_EMAIL_FROM", "team@example.test\r\nBcc: other@example.test");
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "unconfigured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses configured sender and reply inbox, HTML and text, and a stable recipient-specific key", async () => {
    const result = await sendWaitlistConfirmation("person@example.test");
    await sendWaitlistConfirmation("person@example.test");
    await sendWaitlistConfirmation("another@example.test");
    expect(result).toEqual({ status: "accepted", id: "email-fixture-id" });
    const calls = vi.mocked(fetch).mock.calls;
    const init = calls[0][1]!;
    expect(calls[0][0]).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", signal: expect.any(AbortSignal) });
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({ from: "Tilden <team@example.test>", reply_to: "support@example.test", to: ["person@example.test"] });
    expect(payload.subject).toBe("We’ve received your Tilden access request");
    expect(payload.text).toContain("Our team will follow up to discuss your AI spending needs and partner onboarding.");
    expect(payload.html).toContain("invitation-only");
    expect(payload.text).toContain("does not create an account or grant access");
    expect(payload.html).not.toContain("person@example.test");
    const key = (call: typeof calls[number]) => (call[1]!.headers as Record<string, string>)["Idempotency-Key"];
    expect(key(calls[0])).toBe(key(calls[1]));
    expect(key(calls[0])).not.toBe(key(calls[2]));
    expect(key(calls[0])).not.toContain("person@example.test");
  });

  it("bounds the provider request to five seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await sendWaitlistConfirmation("person@example.test");
    expect(timeout).toHaveBeenCalledWith(5_000);
  });

  it("handles rejection without logging the recipient or provider response body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("person@example.test: rejected", { status: 422 }));
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "failed" });
    expect(console.error).toHaveBeenCalledWith("[waitlist-confirmation] provider rejected request: 422");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("person@example.test");
  });

  it("handles an aborted or failed network request without retrying", async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not claim acceptance without a provider message id", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({}));
    expect(await sendWaitlistConfirmation("person@example.test")).toEqual({ status: "failed" });
    expect(console.info).not.toHaveBeenCalled();
  });
});
