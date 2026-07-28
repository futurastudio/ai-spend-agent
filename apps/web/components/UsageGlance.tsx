const limits = [
  {
    label: "5-hour limit",
    value: "29% left",
    projection: "Exhausts ~1h 05m",
    reset: "Resets in 2h 18m",
    width: "29%",
    tone: "attention",
  },
  {
    label: "Weekly limit",
    value: "57% left",
    projection: "On pace to stay below cap",
    reset: "Resets Monday",
    width: "57%",
    tone: "healthy",
  },
];

/**
 * Product-direction preview for the planned macOS companion. It deliberately
 * renders from static sample data on the marketing site; the eventual native
 * surface will read the same local state as the CLI.
 */
export function UsageGlance() {
  return (
    <div className="glance-stage" aria-label="Concept preview of aibill Glance">
      <div className="glance-wallpaper" aria-hidden="true" />
      <div className="glance-menu-bar" aria-hidden="true">
        <span className="glance-menu-copy">aibill</span>
        <span className="glance-camera" />
        <span className="glance-menu-copy">9:41</span>
      </div>

      <details
        className="usage-glance"
        aria-describedby="glance-sample-note"
      >
        <summary
          className="glance-summary"
          aria-label="Usage glance. Hover, focus, or tap to expand."
        >
          <span className="glance-orb" aria-hidden="true" />
          <span className="glance-name">aibill</span>
          <span className="glance-summary-divider" aria-hidden="true" />
          <span className="glance-now">$4.18 session</span>
          <span className="glance-spacer" />
          <span className="glance-limit-compact">5h 29%</span>
          <span className="glance-summary-divider" aria-hidden="true" />
          <span className="glance-limit-compact glance-limit-weekly">wk 57%</span>
          <span className="glance-chevron" aria-hidden="true">
            ↓
          </span>
        </summary>

        <div className="glance-detail">
          <div className="glance-headline">
            <div>
              <p className="glance-kicker">Current session · API-equivalent</p>
              <div className="glance-current-line">
                <p className="glance-total">$4.18</p>
                <span>Codex · GPT-5.6</span>
              </div>
              <p className="glance-current-project">agent-finops</p>
            </div>
            <span className="glance-status">
              <span aria-hidden="true" />
              live · 42m
            </span>
          </div>

          <div className="glance-limit-grid" aria-label="Plan headroom">
            {limits.map((limit) => (
              <div className="glance-limit-card" key={limit.label}>
                <div className="glance-limit-top">
                  <span>{limit.label}</span>
                  <strong>{limit.value}</strong>
                </div>
                <div className="glance-meter-track">
                  <span
                    className={`glance-meter-fill glance-meter-${limit.tone}`}
                    style={{ width: limit.width }}
                  />
                </div>
                <p>
                  <strong>{limit.projection}</strong>
                  <span>{limit.reset}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="glance-session">
            <span className="glance-session-mark" aria-hidden="true">
              H
            </span>
            <div>
              <p>Heaviest this week</p>
              <strong>agent-finops · Claude Opus 4.8</strong>
            </div>
            <div className="glance-session-value">
              <strong>$31.20</strong>
              <span>estimated</span>
            </div>
          </div>

          <div className="glance-insight">
            <span className="glance-insight-dot" aria-hidden="true" />
            <div>
              <strong>Session spend is 1.8× your Codex median</strong>
              <span>Start fresh before the next task.</span>
            </div>
            <kbd aria-label="Keyboard shortcut Command Shift B">⌘⇧B</kbd>
          </div>

          <p className="glance-provenance">
            Claude Code + Codex transcripts · limits shown only when reported
          </p>
        </div>
      </details>

      <div className="glance-desktop-copy" id="glance-sample-note">
        <span>Product concept · sample data</span>
        <strong>Live Glance never guesses a missing limit.</strong>
      </div>
    </div>
  );
}
