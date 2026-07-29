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
 * Browser preview for the native macOS companion. It deliberately renders
 * from static sample data on the marketing site; the native surface reads the
 * same local state as the CLI.
 */
export function UsageGlance() {
  return (
    <div className="glance-stage" aria-label="Preview of aibill Glance">
      <div className="glance-wallpaper" aria-hidden="true" />
      <div className="glance-menu-bar" aria-hidden="true">
        <span className="glance-camera" />
        <span className="glance-menu-copy">9:41</span>
      </div>

      <div
        className="usage-glance"
        aria-describedby="glance-sample-note"
      >
        <button
          type="button"
          className="glance-trigger"
          aria-label="aibill Glance. Hover or focus to reveal current AI usage."
        >
          aibill
        </button>

        <div className="glance-panel">
          <div className="glance-summary" aria-hidden="true">
            <span className="glance-now">$4.18 API value</span>
            <span className="glance-spacer" />
            <span className="glance-limit-compact">5h 29%</span>
            <span className="glance-summary-divider" />
            <span className="glance-limit-compact glance-limit-weekly">wk 57%</span>
          </div>

          <div className="glance-detail">
            <div className="glance-headline">
              <div>
                <p className="glance-kicker">Current session · value at API rates</p>
                <div className="glance-current-line">
                  <p className="glance-total">$4.18</p>
                  <span>Codex · GPT-5.6</span>
                </div>
                <p className="glance-current-project">agent-finops</p>
                <p className="glance-current-plan">
                  ChatGPT Pro · $200/mo subscription · value, not added spend
                </p>
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
                F
              </span>
              <div>
                <p>Main focus · 7d</p>
                <strong>Refining Glance hover UI</strong>
                <span>Task · agent-finops · GlanceView.swift</span>
              </div>
              <div className="glance-session-value">
                <strong>68%</strong>
                <span>activity</span>
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
        </div>
      </div>

      <div className="glance-desktop-copy" id="glance-sample-note">
        <span>Product concept · sample data</span>
        <strong>Live Glance never guesses a missing limit.</strong>
      </div>
    </div>
  );
}
