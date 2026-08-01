"use client";

import { useState, type KeyboardEvent } from "react";
import { UsageGlance } from "@/components/UsageGlance";
import { PRODUCT_DEMO } from "@/lib/product-demo";

const surfaces = [
  {
    id: "glance",
    label: "Glance",
    eyebrow: "Stay in flow",
    title: "See risk before it interrupts you.",
    body: "Hover at the menu bar for spend, runway, focus, freshness, and one next action.",
  },
  {
    id: "terminal",
    label: "Terminal",
    eyebrow: "Inspect the receipt",
    title: "Keep the complete private view.",
    body: "Run one command for the full evidence, provenance, attribution, and missing coverage.",
  },
  {
    id: "mcp",
    label: "Ask aibill",
    eyebrow: "Understand why",
    title: "Question the same evidence.",
    body: "Invoke MCP only when you want a sourced explanation inside your AI client.",
  },
] as const;

type SurfaceId = (typeof surfaces)[number]["id"];

export function ProductTour() {
  const [active, setActive] = useState<SurfaceId>("glance");
  const current = surfaces.find((surface) => surface.id === active) ?? surfaces[0];
  const { session, limits, focus, action, evidence } = PRODUCT_DEMO;

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight") nextIndex = (index + 1) % surfaces.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + surfaces.length) % surfaces.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = surfaces.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const next = surfaces[nextIndex];
    setActive(next.id);
    document.getElementById(`surface-tab-${next.id}`)?.focus();
  }

  return (
    <div className="product-tour">
      <div
        className="product-tour-tabs"
        role="tablist"
        aria-label="Choose an aibill surface"
      >
        {surfaces.map((surface, index) => (
          <button
            key={surface.id}
            type="button"
            id={`surface-tab-${surface.id}`}
            className="product-tour-tab"
            role="tab"
            aria-selected={active === surface.id}
            aria-controls="surface-panel"
            tabIndex={active === surface.id ? 0 : -1}
            onClick={() => setActive(surface.id)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            {surface.label}
          </button>
        ))}
      </div>

      <div className="product-tour-copy" aria-live="polite">
        <p>{current.eyebrow}</p>
        <h3>{current.title}</h3>
        <span>{current.body}</span>
      </div>

      <div
        id="surface-panel"
        role="tabpanel"
        aria-labelledby={`surface-tab-${active}`}
        className="product-tour-panel"
      >
        {active === "glance" && <UsageGlance />}

        {active === "terminal" && (
          <div className="tour-terminal" aria-label="Illustrative aibill terminal receipt">
            <div className="tour-window-bar">
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <strong>aibill · local receipt</strong>
            </div>
            <div className="tour-terminal-body">
              <p className="tour-prompt"><span>$</span> npx aibill</p>
              <div className="tour-terminal-grid">
                <div className="tour-terminal-primary">
                  <p>Current session · {session.basis}</p>
                  <strong>{session.value}</strong>
                  <span>{session.agent} · {session.model} · {session.project}</span>
                  <small>{session.plan} detected locally · usage value ≠ billed spend</small>
                </div>
                <div className="tour-terminal-runway">
                  {limits.map((limit) => (
                    <div key={limit.label}>
                      <span>{limit.label}</span>
                      <strong>{limit.value}</strong>
                      <small>{limit.projection} · {limit.reset}</small>
                    </div>
                  ))}
                </div>
              </div>
              <div className="tour-terminal-row">
                <span>MAIN FOCUS</span>
                <strong>{focus.label}</strong>
                <small>{focus.activity} of observed 7d activity · {focus.file}</small>
              </div>
              <div className="tour-terminal-row tour-terminal-action">
                <span>NEXT ACTION</span>
                <strong>{action.label}</strong>
                <small>{action.detail}</small>
              </div>
              <div className="tour-terminal-source">
                Local: {evidence.sources} · {evidence.files} · nothing uploaded
                <strong>{evidence.freshness}</strong>
              </div>
            </div>
          </div>
        )}

        {active === "mcp" && (
          <div className="tour-mcp" aria-label="Illustrative sourced MCP answer">
            <div className="tour-mcp-question">
              What needs my attention before I keep coding?
            </div>
            <div className="tour-mcp-answer">
              <div className="tour-mcp-mark" aria-hidden="true">$</div>
              <div>
                <p>
                  Your 5-hour window has <strong>{limits[0].value}</strong> and is
                  projected to exhaust in about one hour. This session represents
                  <strong> {session.value}</strong> at API-equivalent rates; because
                  {` ${session.plan}`} was detected locally, that is usage value—not
                  an added charge.
                </p>
                <p>
                  Main focus is <strong>{focus.label}</strong>. Recommended next
                  step: <strong>{action.label}</strong> and carry the task into a
                  clean session.
                </p>
                <div className="tour-mcp-sources">
                  <span>Codex local log</span>
                  <span>Codex limit report</span>
                  <span>Local calculation</span>
                  <span>{evidence.freshness}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="product-tour-note">
        Illustrative sample data. Every surface reads one evidence contract;
        estimated value, provider-reported cost, detected plans, and missing
        limits remain visibly separate.
      </p>
    </div>
  );
}
