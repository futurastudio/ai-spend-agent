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

export function TerminalDemo({ variant = "recorded" }: { variant?: "recorded" | "glass" }) {
  const isGlass = variant === "glass";
  const mediaPath = isGlass ? "/media/tilden-cli-glass" : "/demo";
  const descriptionId = isGlass ? "cli-glass-demo-description" : "terminal-demo-description";
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playbackAttempt = useRef(0);
  const manualRetry = useRef(false);
  const [playback, setPlayback] = useState<PlaybackState>("paused");
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let active = true;
    const attempt = ++playbackAttempt.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shouldPlay = manualRetry.current || !reducedMotion.matches;
    manualRetry.current = false;
    if (shouldPlay) {
      void video.play().catch(() => {
        // A blocked autoplay attempt is not a broken recording. Ignore stale
        // rejections after a format switch or after leaving the CLI tab.
        if (active && attempt === playbackAttempt.current && !video.error && video.paused) {
          setPlayback(current => current === "error" ? current : "paused");
        }
      });
    }

    const pauseForReducedMotion = () => { if (reducedMotion.matches) video.pause(); };
    reducedMotion.addEventListener("change", pauseForReducedMotion);

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
      active = false;
      playbackAttempt.current++;
      reducedMotion.removeEventListener("change", pauseForReducedMotion);
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      observer.disconnect();
      video.pause();
    };
  }, [format]);

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    const attempt = ++playbackAttempt.current;

    if (playback === "playing") {
      video.pause();
      return;
    }

    if (playback === "error") {
      setPlayback("paused");
      if (format !== "mp4") {
        // Retry the preferred format too: its failure may have been temporary
        // even when this browser cannot decode the WebM fallback.
        manualRetry.current = true;
        setFormat("mp4");
        return;
      }
      video.load();
    } else if (playback === "ended") video.currentTime = 0;
    await video.play().catch(() => {
      if (attempt === playbackAttempt.current && videoRef.current === video && !video.error && video.paused) {
        setPlayback(current => current === "error" ? current : "paused");
      }
    });
  }

  const controlLabel = playback === "playing"
    ? "Pause demo"
    : playback === "ended"
      ? "Replay demo"
      : playback === "error" ? "Retry demo" : "Play demo";

  return (
    <div
      ref={containerRef}
      className="tour-terminal tour-terminal-recording"
      aria-label={isGlass ? "Styled aibill CLI replay with sample data" : "Current aibill terminal demonstration"}
    >
      <div className="tour-window-bar">
        <strong>{isGlass ? "aibill — styled CLI replay · sample data" : "aibill — recorded session · sample data"}</strong>
          <button
            type="button"
            className="tour-video-control"
            onClick={togglePlayback}
            aria-label={`${controlLabel}, ${isGlass ? "styled CLI replay" : "terminal recording"}`}
          >
            <PlaybackIcon state={playback} />
            <span>{controlLabel}</span>
          </button>
      </div>

        <div className="tour-terminal-media">
          <video
            ref={videoRef}
            src={`${mediaPath}.${format}`}
            muted
            controls
            playsInline
            preload="metadata"
            poster={`${mediaPath}-poster.png`}
            className="tour-terminal-video"
            aria-label={isGlass ? "A silent styled replay of real aibill CLI excerpts using illustrative sample data" : "A silent recording of npx aibill revealing an illustrative, evidence-labeled terminal report"}
            aria-describedby={descriptionId}
            onPlay={() => setPlayback("playing")}
            onPause={event => { if (event.currentTarget.paused) setPlayback((current) => current === "ended" || current === "error" ? current : "paused"); }}
            onEnded={event => { if (event.currentTarget.ended) setPlayback("ended"); }}
            onError={event => {
              // Only a confirmed network/decode/unsupported-source error
              // advances the fallback. Source selection itself is not fatal.
              if (!event.currentTarget.error || event.currentTarget.error.code < 2) return;
              if (format === "mp4") {
                setPlayback("paused");
                setFormat("webm");
              } else setPlayback("error");
            }}
          />
        </div>
      {playback === "error" && <p className="tour-terminal-fallback-note" role="status">Playback could not start. Retry the demo or <a href={`${mediaPath}.mp4`} target="_blank" rel="noopener noreferrer">open the recording</a>.</p>}

      <p id={descriptionId} className="sr-only">
        {isGlass ? <>Styled replay of real aibill CLI output excerpts: a sample
        receipt, project grouping, and source evidence. The amounts are illustrative
        sample data with mixed evidence bases, not one invoice or a homogeneous
        spend total. Typography and window chrome are restyled for this replay.</>
        : <>The recording types npx aibill, labels the numbers as illustrative
        sample data, then reveals cost/value evidence by source and model,
        context candidates, ranked tests, and verification guidance. No personal data is
        present in the recording.</>}
      </p>
    </div>
  );
}
