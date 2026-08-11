"use client";

import { useEffect, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [isGlanceStudy, setIsGlanceStudy] = useState(false);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    setIsGlanceStudy(ref?.includes("glance-study") ?? false);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "loading") return;

    setStatus("loading");
    setMessage("");

    try {
      const ref = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("ref")
        : null;
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ref }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      setStatus("success");
      // Dedicated thank-you page; the inline card below renders during the
      // brief navigation and remains the no-navigation fallback.
      window.location.assign(
        ref ? `/thanks?ref=${encodeURIComponent(ref)}` : "/thanks",
      );
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-sm border border-green-line bg-green-wash px-5 py-4 text-sm text-ink"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-wash text-green"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13.5 4.5L6 12L2.5 8.5" />
          </svg>
        </span>
        <span>
          {isGlanceStudy ? (
            <>
              Thanks—we&apos;ll email{" "}
              <span className="font-medium text-green">{email}</span>{" "}
              with study timing and the exact preview build/setup. Expect one
              short session and a day-seven check-in.
            </>
          ) : (
            <>
              Thanks—we&apos;ll follow up at{" "}
              <span className="font-medium text-green">{email}</span>{" "}
              about fit and onboarding for the two-week design-partner beta.
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full" noValidate>
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row">
        <label htmlFor="email" className="sr-only">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@agency.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "email-error" : undefined}
          className="h-11 min-w-0 flex-1 rounded-sm border border-hairline bg-well px-4 font-mono text-sm text-ink placeholder:text-faint transition-colors focus:border-green-line focus:outline-none focus:ring-2 focus:ring-[rgba(76,201,138,0.25)]"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="inline-flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-sm bg-green px-6 text-sm font-medium text-ground transition-colors hover:bg-green-hi disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ground"
        >
          {status === "loading"
            ? "Submitting..."
            : isGlanceStudy
              ? "Volunteer for Glance study"
              : "Request beta access"}
        </button>
      </div>
      {status === "error" && (
        <p id="email-error" className="mt-2 text-sm text-danger">
          {message}
        </p>
      )}
      <p className="mt-3 text-xs text-faint">
        {isGlanceStudy
          ? "We’ll schedule one short study session and a day-seven check-in."
          : "Includes onboarding, two weeks of real use, and one short follow-up."}
      </p>
    </form>
  );
}
