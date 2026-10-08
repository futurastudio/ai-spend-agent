"use client";

import { useEffect, useState } from "react";
import styles from "./WaitlistForm.module.css";

type Status = "idle" | "loading" | "success" | "error";

export function WaitlistForm({ presentation = "legacy" }: { presentation?: "legacy" | "landing" }) {
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
      const requestConfirmation = presentation === "landing"
        && !ref?.trim().toLowerCase().includes("glance-study");
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(requestConfirmation ? { "x-tilden-confirmation": "waitlist-v1" } : {}),
        },
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
    if (presentation === "landing") return <p className={styles.success} role="status">Your request has been received. Opening your confirmation…</p>;
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-xs border border-green-line bg-green-wash px-5 py-4 text-sm text-ink"
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
              Thanks. We&apos;ll email{" "}
              <span className="font-medium text-green">{email}</span>{" "}
              with study timing and the exact preview build/setup. Expect one
              short session and a day-seven check-in.
            </>
          ) : (
            <>Thanks. Your interest is registered. Joining does not grant immediate Workspace access.</>
          )}
        </span>
      </div>
    );
  }

  if (presentation === "landing") return <form onSubmit={onSubmit} className={styles.form} aria-busy={status === "loading"}>
    <label htmlFor="waitlist-email">Work email</label>
    <div className={styles.fields}>
      <input id="waitlist-email" name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} required placeholder="you@company.com" value={email}
        onChange={event => { setEmail(event.target.value); if (status === "error") { setStatus("idle"); setMessage(""); } }}
        aria-invalid={status === "error"} aria-describedby={status === "error" ? "waitlist-error waitlist-note" : "waitlist-note"} />
      <button type="submit" disabled={status === "loading"}>{status === "loading" ? "Sending…" : "Request access"}<span aria-hidden="true">↗</span></button>
    </div>
    {status === "error" && <p id="waitlist-error" className={styles.error} role="alert">{message}</p>}
    <p id="waitlist-note" className={styles.note}>By requesting access, you agree to receive Tilden updates and access invitations. <a href="/privacy">Privacy policy</a>. You can opt out by <a href="mailto:contact@asktilden.com?subject=Tilden%20updates">contacting us</a>.</p>
  </form>;

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
          className="h-11 min-w-0 flex-1 rounded-xs border border-hairline bg-well px-4 font-mono text-sm text-ink placeholder:text-faint transition-colors focus:border-green-line focus:outline-hidden focus:ring-2 focus:ring-[rgba(76,201,138,0.25)]"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="inline-flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-xs bg-green px-6 text-sm font-medium text-ground transition-colors hover:bg-green-hi disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ground"
        >
          {status === "loading"
            ? "Submitting..."
            : isGlanceStudy
              ? "Volunteer for Glance study"
              : "Join the waitlist"}
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
          : "Join for product updates and access invitations. Joining does not grant immediate Workspace access."}
      </p>
      {isGlanceStudy ? null : (
        <div className="mt-5 border-t border-hairline pt-4" data-cli-free-tier="">
          <p className="text-sm text-ink">
            Want a number today? Run the free CLI on your machine:{" "}
            <code className="rounded-xs bg-well px-1.5 py-0.5 font-mono text-[13px]">npx aibill</code>
          </p>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            The CLI prices the agent logs on your machine. The Workspace reads what your providers billed. Same rules, different sources, so the two numbers differ and each says why.
          </p>
        </div>
      )}
    </form>
  );
}
