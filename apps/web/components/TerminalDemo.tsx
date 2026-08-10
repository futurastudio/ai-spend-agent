"use client";

import { useEffect, useRef, useState } from "react";

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
        <strong>aibill — recorded session · sample data</strong>
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
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/demo-poster.png"
            alt="Poster frame of the recorded aibill session"
            className="tour-terminal-poster"
          />
          <p className="tour-terminal-fallback-note">
            # recording unavailable — poster frame shown
          </p>
        </div>
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
            {/* Per spec, when every <source> fails the error event fires at
                the LAST source element, not the <video> — the source-level
                handler is what makes the poster fallback reachable. */}
            <source
              src="/demo.mp4"
              type="video/mp4"
              onError={() => setPlayback("error")}
            />
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
