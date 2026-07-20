"use client";

import { useState } from "react";

const COMMAND = "npx aibill";

export function CopyCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context); fail quietly.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied command" : "Copy command"}
      className="glass glass-interactive group flex w-full max-w-md items-center justify-between gap-4 rounded-xl px-5 py-4 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green/50"
    >
      <code className="flex min-w-0 items-center gap-2.5 truncate">
        <span className="select-none text-green" aria-hidden="true">
          $
        </span>
        <span className="text-ink">{COMMAND}</span>
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-blink bg-green"
          aria-hidden="true"
        />
      </code>
      <span
        className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
          copied
            ? "border-green/40 text-green"
            : "border-border text-muted group-hover:border-border-bright group-hover:text-ink"
        }`}
      >
        {copied ? "Copied ✓" : "Copy"}
      </span>
    </button>
  );
}
