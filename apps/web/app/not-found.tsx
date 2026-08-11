import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";

export default function NotFound() {
  return (
    <div className="frame flex min-h-screen flex-col">
      <header className="border-b border-hairline">
        <div className="flex h-14 items-center px-5 sm:px-8">
          <Link href="/" className="wordmark" aria-label="Tilden — home">
            Tilden
            <span className="wordmark-cursor" aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col justify-center px-5 py-24 sm:px-8">
        <div className="receipt max-w-[420px] rounded-sm border border-hairline-bright bg-well p-4 font-mono text-[13px] leading-[1.7]">
          <div className="tl-line">
            <span className="tl-green">$ </span>
            <span>open {"<page>"}</span>
          </div>
          <div className="tl-line">
            <span className="tl-faint">error: 404 — not found</span>
          </div>
          <div className="tl-line">
            <span className="tl-green">$ </span>
            <span className="tl-cursor animate-blink" aria-hidden="true" />
          </div>
        </div>
        <h1 className="mt-8 text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
          This page doesn&apos;t exist.
        </h1>
        <p className="mt-3 max-w-[480px] text-base leading-relaxed text-muted">
          The receipt for it would read $0.00. Head back to the{" "}
          <Link
            href="/"
            className="text-ink underline-offset-4 hover:underline"
          >
            landing page
          </Link>{" "}
          — or skip the website entirely:
        </p>
        <div className="mt-6 max-w-[380px]">
          <CopyCommand />
        </div>
      </main>
    </div>
  );
}
