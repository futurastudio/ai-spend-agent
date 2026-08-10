"use client";

import { useState, type KeyboardEvent } from "react";
import { UsageGlance } from "@/components/UsageGlance";
import { TerminalDemo } from "@/components/TerminalDemo";
import { PRODUCT_DEMO } from "@/lib/product-demo";

const surfaces = [
  {
    id: "glance",
    label: "Glance",
    eyebrow: "Menu bar · macOS",
    title: "The receipt at a glance.",
    body: "A native menu bar companion reads the same local state as the CLI — session value, limit runway, focus, freshness. Built from source today; no signed download yet.",
  },
  {
    id: "terminal",
    label: "Terminal",
    eyebrow: "Terminal · recorded",
    title: "The full run, recorded.",
    body: "The receipt above is the excerpt. This is the complete session — the real CLI over deterministic sample data, recorded once, uncut.",
  },
  {
    id: "mcp",
    label: "MCP",
    eyebrow: "MCP · your AI client",
    title: "Ask why, get sources.",
    body: "Invoke aibill from your AI client when you want an explanation — every claim in the answer cites the local log or report it came from. Runs only when you call it.",
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
          <TerminalDemo />
        )}

        {active === "mcp" && (
          <div className="tour-mcp receipt" aria-label="Illustrative sourced MCP answer">
            <div className="tour-mcp-question">
              What needs my attention before I keep coding?
            </div>
            <div className="tour-mcp-answer">
              <div className="tour-mcp-mark" aria-hidden="true">$</div>
              <div>
                <p>
                  Your 5-hour window has <strong>{limits[0].value}</strong> and is
                  projected to exhaust in about one hour. This session represents
                  <strong className="tour-mcp-money"> {session.value}</strong> at API-equivalent rates; because
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
        Glance and MCP share overlapping fields in this illustrative
        receipt. Terminal replays the real CLI with deterministic sample data;
        in sample mode, Apply is a non-executable demonstration. On real local
        evidence, npx aibill apply adds read-only checks, explicit approval,
        rollback, and a matched future-session comparison. Estimated value,
        provider-reported cost, detected plans, and missing limits remain
        visibly separate.
      </p>
    </div>
  );
}
