// TildenMark — the Tilden symbol ("Two sides, equal-area"), locked 2026-09-23.
// Picks the pixel-hinted master for small sizes, so the seam stays crisp at 1x.
// Optional one-shot entrance (1.4 s). Reduced motion always shows the settled mark.
// Requires tilden-brand.css (keyframes + tokens) to be imported once, globally.
import type { CSSProperties } from "react";

const MASTERS = {
  "16": { grid: 16, human: "M0.584 5H8V9H15.937A8 8 0 0 0 0.584 5Z", agent: "M0.063 7H6V11H15.416A8 8 0 0 1 0.063 7Z", dx: 3.5, dy: 1.25 },
  "20": { grid: 20, human: "M1.34 5H7A3 3 0 0 1 10 8V11H19.95A10 10 0 0 0 1.34 5Z", agent: "M0.461 7H8V13H19.539A10 10 0 0 1 0.461 7Z", dx: 4.375, dy: 1.5625 },
  "24": { grid: 24, human: "M1.608 6H8A4 4 0 0 1 12 10V13H23.958A12 12 0 0 0 1.608 6Z", agent: "M0.381 9H9V16H23.314A12 12 0 0 1 0.381 9Z", dx: 5.25, dy: 1.875 },
  "64": { grid: 64, human: "M4.004 16.5H22A10 10 0 0 1 32 26.5V36.5H63.682A32 32 0 0 0 4.004 16.5Z", agent: "M0.891 24.5H24V44.5H61.458A32 32 0 0 1 0.891 24.5Z", dx: 14, dy: 5 },
} as const;

type MasterKey = keyof typeof MASTERS;
export type TildenTone = "ultramarine" | "navy" | "ink" | "white" | "current";

const TONE: Record<TildenTone, string> = {
  ultramarine: "#243CCB",
  navy: "#17224B",
  ink: "#1D2540",
  white: "#FFFFFF",
  current: "currentColor",
};

/** 16 px and below: 16 master. 17-21: 20. 22-28: 24. 29 and up: geometric 64 master. */
export function masterFor(size: number): MasterKey {
  if (size <= 17) return "16";
  if (size <= 21) return "20";
  if (size <= 28) return "24";
  return "64";
}

export interface TildenMarkProps {
  /** Rendered diameter in CSS px. */
  size?: number;
  tone?: TildenTone;
  /** Play the entrance once on mount. Use for at most one mark per page. */
  animate?: boolean;
  /** Accessible name. Omit when the mark sits beside the visible word "Tilden". */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function TildenMark({ size = 24, tone = "current", animate = false, title, className, style }: TildenMarkProps) {
  const key = masterFor(size);
  const m = MASTERS[key];
  const vars = { "--tm-dx": `${m.dx}px`, "--tm-dy": `${m.dy}px`, ...style } as CSSProperties;
  return (
    <svg
      viewBox={`0 0 ${m.grid} ${m.grid}`}
      width={size}
      height={size}
      fill={TONE[tone]}
      className={["tilden-mark", animate ? "tilden-mark--enter" : "", className].filter(Boolean).join(" ")}
      style={vars}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path className="tilden-mark__human" d={m.human} />
      <path className="tilden-mark__agent" d={m.agent} />
    </svg>
  );
}
