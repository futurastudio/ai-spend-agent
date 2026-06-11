"use client";

import { useState } from "react";

const COMMAND = "npx ai-spend-agent";

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
    <div className="group flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-border bg-surface/80 px-4 py-3 font-mono text-sm shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] backdrop-blur transition-colors hover:border-white/20">
      <code className="flex min-w-0 items-center gap-2 truncate text-ink">
        <span className="select-none text-faint" aria-hidden="true">
          $
        </span>
        {COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied install command" : "Copy install command"}
        className="shrink-0 rounded-md border border-border bg-bg/60 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:border-white/20 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
