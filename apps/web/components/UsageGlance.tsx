const meters = [
  { label: "5-hour window", value: "71%", width: "71%" },
  { label: "Weekly window", value: "43%", width: "43%" },
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

      <div
        className="usage-glance"
        tabIndex={0}
        role="group"
        aria-label="Usage glance. Hover or focus to expand."
      >
        <div className="glance-summary">
          <span className="glance-orb" aria-hidden="true" />
          <span className="glance-name">aibill</span>
          <span className="glance-spacer" />
          <span className="glance-now">$3.21 today</span>
          <span className="glance-chevron" aria-hidden="true">
            ↓
          </span>
        </div>

        <div className="glance-detail">
          <div className="glance-headline">
            <div>
              <p className="glance-kicker">API-equivalent usage</p>
              <p className="glance-total">$87.42</p>
            </div>
            <span className="glance-status">local</span>
          </div>

          <div className="glance-meters">
            {meters.map((meter) => (
              <div key={meter.label}>
                <div className="glance-meter-label">
                  <span>{meter.label}</span>
                  <span>{meter.value}</span>
                </div>
                <div className="glance-meter-track">
                  <span style={{ width: meter.width }} />
                </div>
              </div>
            ))}
          </div>

          <div className="glance-project">
            <div>
              <p>Heaviest project</p>
              <strong>agent-finops</strong>
            </div>
            <span>$41.08</span>
          </div>
        </div>
      </div>

      <div className="glance-desktop-copy">
        <span>Quiet until you need it.</span>
        <strong>Hover or focus the pill.</strong>
      </div>
    </div>
  );
}
