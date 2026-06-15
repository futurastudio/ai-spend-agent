import type { ReactNode } from "react";

/** A terminal window with traffic-light chrome and a title. */
export function TerminalWindow({
  title = "ai-spend-agent",
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-border bg-well text-left ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-xs text-faint">{title}</span>
      </div>
      <div className="overflow-x-auto p-5 sm:p-6">
        <pre className="font-mono text-[12.5px] leading-[1.65] sm:text-[13px]">
          {children}
        </pre>
      </div>
    </div>
  );
}

// Tiny helpers so the demo output reads as syntax, not a flat blob.
const G = ({ children }: { children: ReactNode }) => (
  <span className="text-green">{children}</span>
);
const R = ({ children }: { children: ReactNode }) => (
  <span className="text-red">{children}</span>
);
const C = ({ children }: { children: ReactNode }) => (
  <span className="text-cyan">{children}</span>
);
const D = ({ children }: { children: ReactNode }) => (
  <span className="text-faint">{children}</span>
);
const W = ({ children }: { children: ReactNode }) => (
  <span className="text-ink">{children}</span>
);

/** Real `npx ai-spend-agent` output, hand-colored. */
export function TerminalDemo() {
  return (
    <TerminalWindow className="text-muted">
      <D>$ </D>
      <W>npx ai-spend-agent</W>
      {"\n\n"}
      <D>────────────────────────────────────────────────</D>
      {"\n"}
      <W>  AI SPEND</W> <D>your AI spend in one view</D>
      {"\n"}
      <D>────────────────────────────────────────────────</D>
      {"\n\n"}
      <span className="text-ink text-[17px] font-semibold">  $87.00</span>{" "}
      <D>tracked across 9 calls</D>
      {"\n"}
      <D>  ● </D>
      <G>$8.10 verified</G> <D>· $48.50 estimated · $30.40 detected</D>
      {"\n\n"}
      <W>  Where to cut </W>
      <D>(ranked by monthly savings)</D>
      {"\n\n"}
      <W>  1. Move gpt-5.5 calls to gpt-5.5-mini</W>{"  "}
      <G>save ~$376.80/mo</G>
      {"\n"}
      <D>     3 research_summary calls · $47.10 in window</D>
      {"\n\n"}
      <W>  2. Move research_summary calls to the Batch API</W>{"  "}
      <G>save ~$320.00/mo</G>
      {"\n"}
      <D>     flat 50% off · results within 24h</D>
      {"\n\n"}
      <W>  3. Trim oversized context on research_summary</W>{"  "}
      <G>save ~$144.75/mo</G>
      {"\n"}
      <D>     3 calls over 100k input tokens</D>
      {"\n\n"}
      <span className="font-semibold text-green">  ~$1,151.45/mo</span>{" "}
      <D>in identified savings</D>
      {"\n\n"}
      <W>  Plan check </W>
      <D>(subscription vs pay-per-token)</D>
      {"\n"}
      <C>  › </C>
      <D>claude-code: ~$253/mo at API rates — Max 20x</D>
      {"\n"}
      <D>    ($200/mo) covers it, </D>
      <G>~$53/mo cheaper</G>
      <D> than per-token.</D>
    </TerminalWindow>
  );
}
