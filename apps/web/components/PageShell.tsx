import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";
import { Reveal } from "@/components/Reveal";

/**
 * Shared chrome for content pages (blog / comparison) so they stay visually
 * native to the liquid-glass landing page. Server component.
 */
export function PageShell({
  children,
  ctaRef,
}: {
  children: React.ReactNode;
  ctaRef: string;
}) {
  return (
    <main className="relative overflow-x-clip">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[700px]"
        aria-hidden="true"
      >
        <div className="grid-fade absolute inset-0" />
        <div className="aurora aurora-green left-[8%] top-[-120px] h-[420px] w-[520px]" />
        <div className="aurora aurora-cyan right-[4%] top-[140px] h-[360px] w-[460px]" />
      </div>

      <header className="sticky top-4 z-40 mx-auto max-w-content px-4 sm:px-6">
        <div className="glass-heavy flex items-center justify-between rounded-2xl px-4 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="glass-well flex h-7 w-7 items-center justify-center rounded-md font-mono text-sm text-green"
            >
              $
            </span>
            <span className="font-mono text-sm font-semibold tracking-tight text-ink">
              aibill
            </span>
          </Link>
          <nav className="flex items-center gap-2">
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="glass glass-interactive hidden rounded-xl px-3.5 py-2 text-sm font-medium text-muted hover:text-ink sm:inline-flex"
            >
              GitHub
            </a>
            <Link
              href={`/?ref=${ctaRef}#beta`}
              className="glass glass-interactive rounded-xl px-3.5 py-2 text-sm font-medium text-muted hover:text-ink"
            >
              Hosted beta
            </Link>
          </nav>
        </div>
      </header>

      {children}

      {/* CTA */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-16">
        <Reveal>
          <div className="glass mx-auto max-w-3xl rounded-3xl px-6 py-10 text-center sm:px-12">
            <h2 className="text-balance font-mono text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              See your own number, in 90 seconds
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-balance text-sm leading-relaxed text-muted">
              Free, open-source, local-first — nothing leaves your machine. No
              account, no telemetry.
            </p>
            <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-3">
              <CopyCommand />
              <p className="font-mono text-xs text-faint">
                Requires Node 22+. Also on npm as{" "}
                <span className="text-muted">ai-spend-agent</span>.
              </p>
            </div>
            <p className="mt-5 text-sm text-muted">
              Want continuous monitoring and burn-rate alerts?{" "}
              <Link
                href={`/?ref=${ctaRef}#beta`}
                className="text-green underline-offset-4 hover:underline"
              >
                Join the hosted beta →
              </Link>
            </p>
          </div>
        </Reveal>
      </section>

      <footer className="relative z-10 border-t border-white/5">
        <div className="mx-auto flex max-w-content flex-col items-center justify-between gap-3 px-6 py-8 font-mono text-xs text-faint sm:flex-row">
          <span>aibill — free, local-first, open-source.</span>
          <div className="flex items-center gap-5">
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/aibill"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              npm
            </a>
            <span className="text-green">npx aibill</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
