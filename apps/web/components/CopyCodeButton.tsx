"use client";

import { useEffect, useRef, useState } from "react";

export function CopyCodeButton({ value }: { value: string }) {
  const [label, setLabel] = useState("Copy");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setLabel("Copied");
    } catch {
      setLabel("Copy failed");
    }

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setLabel("Copy"), 1_800);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex min-h-11 items-center px-3 text-[10px] uppercase tracking-[0.12em] text-faint transition-colors hover:text-ink"
      aria-label="Copy code to clipboard"
    >
      <span aria-live="polite">{label}</span>
    </button>
  );
}
