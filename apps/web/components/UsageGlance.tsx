"use client";

import { useState } from "react";
import { PRODUCT_DEMO } from "@/lib/product-demo";

/**
 * Browser preview for the native macOS companion. It deliberately renders
 * from static sample data on the marketing site; the native surface reads the
 * same local state as the CLI.
 */
export function UsageGlance() {
  const [isOpen, setIsOpen] = useState(false);
  const { session, limits, focus, action, evidence } = PRODUCT_DEMO;

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
        data-open={isOpen}
      >
        <button
          type="button"
          className="glance-trigger"
          aria-label="aibill Glance. Hover with a pointer or activate to reveal illustrative AI usage."
          aria-expanded={isOpen}
          aria-controls="glance-preview-panel"
          onClick={() => setIsOpen((open) => !open)}
        >
          aibill
        </button>

        <div
          className="glance-panel"
          id="glance-preview-panel"
          role="region"
          aria-label="Illustrative Glance usage panel"
        >
          <div className="glance-detail">
            <div className="glance-headline">
              <div>
                <p className="glance-kicker">Current session · estimated API-equivalent value</p>
                <div className="glance-current-line">
                  <p className="glance-total">{session.value}</p>
                  <span>{session.agent} · {session.model}</span>
                </div>
                <p className="glance-current-project">{session.project}</p>
                <p className="glance-current-plan">
                  {session.plan} · detected locally · API value ≠ added spend
                </p>
              </div>
              <span className="glance-status">
                <span aria-hidden="true" />
                active · {session.duration}
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
                <p>Main focus · 7d · local activity</p>
                <strong>{focus.label}</strong>
                <span>{focus.kind} · {session.project} · {focus.file}</span>
              </div>
              <div className="glance-session-value">
                <strong>{focus.activity}</strong>
                <span>activity</span>
              </div>
            </div>

            <div className="glance-insight">
              <span className="glance-insight-dot" aria-hidden="true" />
              <div>
                <strong>{action.label}</strong>
                <span>{action.detail}</span>
              </div>
              <span className="glance-action-copy">Copy</span>
            </div>

            <div className="glance-source-row">
              <span aria-hidden="true">◇</span>
              <p>Local: {evidence.sources} · {evidence.files} · nothing uploaded</p>
              <strong>{evidence.freshness}</strong>
            </div>
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
