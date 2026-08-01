"use client";

import { useState } from "react";

const limits = [
  {
    label: "5-hour limit",
    value: "29% left",
    projection: "Local estimate · Exhausts ~1h",
    reset: "Codex reported · Resets in 2h",
    width: "29%",
    tone: "attention",
  },
  {
    label: "Weekly limit",
    value: "57% left",
    projection: "Local estimate · Below cap",
    reset: "Codex reported · Resets Monday",
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
  const [isOpen, setIsOpen] = useState(false);

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
                  <p className="glance-total">$4.18</p>
                  <span>Codex · GPT-5.6</span>
                </div>
                <p className="glance-current-project">agent-finops</p>
                <p className="glance-current-plan">
                  ChatGPT Pro · $200/mo · detected locally · API value ≠ added spend
                </p>
              </div>
              <span className="glance-status">
                <span aria-hidden="true" />
                active · 42m
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
                <strong>Start fresh · agent-finops</strong>
                <span>Carry “Refining Glance hover UI” into a clean session</span>
              </div>
              <span className="glance-action-copy">Copy</span>
            </div>

            <div className="glance-source-row">
              <span aria-hidden="true">◇</span>
              <p>Local: Claude Code + Codex · 60 files · nothing uploaded</p>
              <strong>Updated 12s ago</strong>
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
