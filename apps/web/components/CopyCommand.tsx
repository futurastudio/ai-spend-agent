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
      className="group flex h-11 w-full max-w-md items-center justify-between gap-4 rounded-sm border border-green-line bg-green-wash px-4 font-mono text-sm transition-colors hover:border-[rgba(76,201,138,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green/50"
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
        className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
          copied ? "text-green" : "text-faint group-hover:text-ink"
        }`}
      >
        {copied ? "COPIED" : "COPY"}
      </span>
    </button>
  );
}
