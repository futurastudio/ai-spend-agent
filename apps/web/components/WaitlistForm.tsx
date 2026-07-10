"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

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
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-xl border border-green/40 bg-green/10 px-5 py-4 text-sm text-ink animate-fade-up"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green/20 text-green"
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
          You&apos;re on the list. We&apos;ll email{" "}
          <span className="font-medium text-green-bright">{email}</span> when
          the hosted beta opens.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full" noValidate>
      <div className="flex flex-col gap-3 sm:flex-row">
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
          className="glass-well h-12 flex-1 rounded-xl px-4 font-mono text-sm text-ink placeholder:text-faint transition-colors focus:border-green/50 focus:outline-none focus:ring-2 focus:ring-green/25"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-green px-6 text-sm font-semibold text-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_24px_-8px_rgba(89,212,153,0.5)] transition-[background-color,transform,box-shadow] duration-200 ease-out hover:bg-green-bright hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_12px_28px_-8px_rgba(94,242,168,0.55)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {status === "loading" ? "Joining..." : "Join the hosted beta"}
        </button>
      </div>
      {status === "error" && (
        <p id="email-error" className="mt-2 text-sm text-red">
          {message}
        </p>
      )}
      <p className="mt-3 text-xs text-faint">
        No spam. One email when the beta opens, then nothing until it does.
      </p>
    </form>
  );
}
