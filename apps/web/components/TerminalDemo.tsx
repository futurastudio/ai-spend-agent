"use client";

import { useEffect, useRef, useState } from "react";
import { PRODUCT_DEMO } from "@/lib/product-demo";

type PlaybackState = "paused" | "playing" | "ended" | "error";

function PlaybackIcon({ state }: { state: PlaybackState }) {
  if (state === "playing") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M4.5 3.5v9M11.5 3.5v9" />
      </svg>
    );
  }

  if (state === "ended") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M12.5 6A5 5 0 1 0 13 9" />
        <path d="M12.5 2.8V6H9.3" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m5.5 3.5 6 4.5-6 4.5z" />
    </svg>
  );
}

export function TerminalReceipt() {
  const { session, limits, focus, action, evidence } = PRODUCT_DEMO;

  return (
    <div className="tour-terminal-body" aria-label="Illustrative aibill terminal receipt">
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
  );
}

export function TerminalDemo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playback, setPlayback] = useState<PlaybackState>("paused");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) {
      void video.play().catch(() => setPlayback("paused"));
    }

    const pauseWhenHidden = () => {
      if (document.hidden && !video.paused) video.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && entry.intersectionRatio < 0.2 && !video.paused) video.pause();
      },
      { threshold: [0, 0.2] }
    );
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      observer.disconnect();
      video.pause();
    };
  }, []);

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video || playback === "error") return;

    if (playback === "playing") {
      video.pause();
      return;
    }

    if (playback === "ended") video.currentTime = 0;
    await video.play().catch(() => setPlayback("paused"));
  }

  const controlLabel = playback === "playing"
    ? "Pause demo"
    : playback === "ended"
      ? "Replay demo"
      : "Play demo";

  return (
    <div
      ref={containerRef}
      className="tour-terminal tour-terminal-recording"
      aria-label="Current aibill terminal demonstration"
    >
      <div className="tour-window-bar">
        <strong>Terminal recording · npx aibill</strong>
        {playback !== "error" && (
          <button
            type="button"
            className="tour-video-control"
            onClick={togglePlayback}
            aria-label={`${controlLabel}, terminal recording`}
          >
            <PlaybackIcon state={playback} />
            <span>{controlLabel}</span>
          </button>
        )}
      </div>

      {playback === "error" ? (
        <TerminalReceipt />
      ) : (
        <div className="tour-terminal-media">
          <video
            ref={videoRef}
            muted
            playsInline
            preload="metadata"
            poster="/demo-poster.png"
            className="tour-terminal-video"
            aria-label="A silent recording of npx aibill revealing an illustrative, evidence-labeled terminal report"
            aria-describedby="terminal-demo-description"
            onPlay={() => setPlayback("playing")}
            onPause={() => setPlayback((current) => current === "ended" ? current : "paused")}
            onEnded={() => setPlayback("ended")}
            onError={() => setPlayback("error")}
          >
            <source src="/demo.webm" type="video/webm" />
            <source src="/demo.mp4" type="video/mp4" />
          </video>
        </div>
      )}

      <p id="terminal-demo-description" className="sr-only">
        The recording types npx aibill, labels the numbers as illustrative
        sample data, then reveals cost/value evidence by source and model,
        context candidates, ranked tests, and verification guidance. No personal data is
        present in the recording.
      </p>
    </div>
  );
}
