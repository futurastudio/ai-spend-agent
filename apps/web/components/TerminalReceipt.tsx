"use client";

import { useEffect, useRef } from "react";
import {
  RECEIPT_COMMAND,
  RECEIPT_LINES,
  SETTLE_AT,
  type Tone,
} from "@/lib/receipt-demo";

const TYPE_START = 200;
const TYPE_MS_PER_CHAR = 45;
const ENTER_BEAT = 800;
const TICK_START = 1250;
const TICK_MS = 700;
const TICK_TARGET = 87;

function toneClass(c?: Tone): string {
  switch (c) {
    case "green":
      return "tl-green";
    case "amber":
      return "tl-amber";
    case "strong":
      return "tl-strong";
    case "muted":
      return "tl-muted";
    case "faint":
      return "tl-faint";
    default:
      return "";
  }
}

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

/**
 * The hero receipt: real renderer output printed once, then settled.
 *
 * Server markup IS the settled final state — no-JS and reduced-motion
 * visitors see the complete receipt with the full $87.00. The storyboard
 * only runs client-side: a single rAF clock (elapsed-time driven, so a
 * backgrounded tab resumes with one clean flush, never a timeout burst)
 * reveals lines instantly, types the command, ticks the value, and
 * scales the bar fills.
 */
export function TerminalReceipt() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // stay settled — never start the clock
    }

    const timed = Array.from(root.querySelectorAll<HTMLElement>("[data-at]"));
    const cmd = root.querySelector<HTMLElement>("[data-cmd]");
    const cmdCursor = root.querySelector<HTMLElement>("[data-cmd-cursor]");
    const tick = root.querySelector<HTMLElement>("[data-tick]");
    let raf = 0;
    let started = false;

    const observer = new IntersectionObserver(
      (entries) => {
        if (started || !entries.some((entry) => entry.isIntersecting)) return;
        started = true;
        observer.disconnect();

        root.classList.add("tl-playing");
        for (const el of timed) el.classList.remove("is-on");
        if (cmd) cmd.textContent = "";
        if (cmdCursor) cmdCursor.classList.remove("hidden");
        if (tick) tick.textContent = "$0.00";

        const start = performance.now();
        const frame = (now: number) => {
          const elapsed = now - start;

          const typed = Math.max(
            0,
            Math.min(
              RECEIPT_COMMAND.length,
              Math.floor((elapsed - TYPE_START) / TYPE_MS_PER_CHAR),
            ),
          );
          if (cmd) cmd.textContent = RECEIPT_COMMAND.slice(0, typed);
          if (cmdCursor && elapsed >= ENTER_BEAT) {
            cmdCursor.classList.add("hidden");
          }

          for (const el of timed) {
            if (elapsed >= Number(el.dataset.at)) el.classList.add("is-on");
          }

          if (tick && elapsed >= TICK_START) {
            const p = Math.min(1, (elapsed - TICK_START) / TICK_MS);
            tick.textContent = `$${(TICK_TARGET * easeOutCubic(p)).toFixed(2)}`;
          }

          if (elapsed < SETTLE_AT) {
            raf = requestAnimationFrame(frame);
          }
        };
        raf = requestAnimationFrame(frame);
      },
      { threshold: 0.4 },
    );
    observer.observe(root);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="receipt overflow-hidden rounded-sm border border-hairline-bright bg-well"
    >
      <div className="flex h-9 items-center justify-between border-b border-hairline bg-panel px-4 font-mono text-[11px] text-faint">
        <span>aibill — sample receipt</span>
        <span className="uppercase tracking-[0.1em]">Demo sample</span>
      </div>
      <div className="p-4 text-[11px] leading-[1.7] text-ink sm:p-6 sm:text-[13px]">
        <div className="tl-line">
          <span className="tl-green">$ </span>
          <span data-cmd>{RECEIPT_COMMAND}</span>
          <span data-cmd-cursor className="tl-cursor hidden" aria-hidden="true" />
        </div>
        {RECEIPT_LINES.map((line, i) => {
          if (line.kind === "blank") {
            return (
              <div key={i} className="tl-line" aria-hidden="true">
                {" "}
              </div>
            );
          }
          if (line.kind === "bar") {
            return (
              <div
                key={i}
                className="tl-bar-row ml-[2ch]"
                data-at={line.at}
                role="img"
                aria-label={`${line.label} ${line.bar} ${line.amount} ${line.pct}`}
              >
                <span className="tl-muted" aria-hidden="true">
                  {line.label}
                </span>
                <span className="tl-bar-track" aria-hidden="true">
                  <span
                    className="tl-bar-fill"
                    data-at={line.at}
                    style={{ width: `${line.width}%` }}
                  />
                </span>
                <span
                  className={`tl-bar-amount ${toneClass(line.amountTone)}`}
                  data-at={line.amountAt}
                  aria-hidden="true"
                >
                  {line.amount}
                </span>
                <span className="tl-faint" data-at={line.amountAt} aria-hidden="true">
                  {line.pct}
                </span>
              </div>
            );
          }
          return (
            <div key={i} className="tl-line" data-at={line.at}>
              {line.segs.map((seg, j) => (
                <span
                  key={j}
                  className={toneClass(seg.c)}
                  {...(seg.tick ? { "data-tick": true } : {})}
                >
                  {seg.t}
                </span>
              ))}
            </div>
          );
        })}
        <div className="tl-line" data-at={SETTLE_AT}>
          <span className="tl-green">$ </span>
          <span className="tl-cursor animate-blink" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
