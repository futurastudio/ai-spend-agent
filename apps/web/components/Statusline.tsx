/**
 * Static recreation of the real Claude Code statusline. Responsive tiers
 * are pure CSS and mirror the runtime's own compaction: full words at
 * ≥640px, the compact `wk`/`upd` tier below, and `· upd 12s` dropped
 * below 400px before the value claim is ever touched. Never wraps,
 * never pans; a 24px fade mask is the last resort.
 */
export function Statusline() {
  return (
    <div className="receipt statusline-mask overflow-hidden whitespace-nowrap rounded-sm border border-hairline bg-well px-4 py-3 font-mono text-[11px] sm:text-[13px]">
      <span className="tl-strong">aibill</span>
      <span className="tl-faint"> · </span>
      <span className="text-ink">
        <span className="hidden sm:inline">week</span>
        <span className="sm:hidden">wk</span> 68% left
      </span>
      <span className="tl-muted"> ↻Sat</span>
      <span className="tl-faint"> · </span>
      <span className="tl-amber">~$2.1k 7d value</span>
      <span className="hidden min-[400px]:inline">
        <span className="tl-faint"> · </span>
        <span className="tl-faint">
          <span className="hidden sm:inline">updated 12s</span>
          <span className="sm:hidden">upd 12s</span>
        </span>
      </span>
    </div>
  );
}
