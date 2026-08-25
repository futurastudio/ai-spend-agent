import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";
import { Reveal } from "@/components/Reveal";

/**
 * Shared chrome for content pages (blog / comparison) so they stay visually
 * native to the hairline-framed landing page. Server component.
 */
export function PageShell({
  children,
  ctaRef,
}: {
  children: React.ReactNode;
  ctaRef: string;
}) {
  return (
    <div className="frame">
      <header className="sticky top-0 z-40 border-b border-hairline bg-[rgba(12,13,9,0.97)]">
        <div className="flex h-14 items-center justify-between px-5 sm:px-8">
          <Link href="/" className="wordmark min-h-11" aria-label="Tilden — home">
            Tilden
            <span className="wordmark-cursor" aria-hidden="true" />
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="/docs"
              className="inline-flex min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink"
            >
              Docs
            </Link>
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              GitHub ↗
            </a>
            <Link
              href={`/?ref=${ctaRef}#beta`}
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-sm border border-hairline-bright px-3.5 py-2 text-sm text-muted transition-colors hover:border-[rgba(255,255,255,0.25)] hover:text-ink"
            >
              Design partners
            </Link>
          </nav>
        </div>
      </header>

      <main className="border-b border-hairline">{children}</main>

      {/* CTA */}
      <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-20">
        <Reveal>
          <h2 className="text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
            See your own evidence locally
          </h2>
          <p className="mt-3 max-w-[560px] text-base leading-relaxed text-muted">
            Free and open source. The default CLI runs locally with no
            account, and your code, prompts, and financial data never leave
            your machine; provider connections and MCP sharing are always
            explicit.
          </p>
          <div className="mt-6 max-w-[380px]">
            <CopyCommand />
          </div>
          <p className="mt-3 font-mono text-xs text-faint">
            Requires Node 22+. Also on npm as{" "}
            <span className="text-muted">ai-spend-agent</span>.
          </p>
          <p className="mt-6 max-w-[560px] text-sm leading-relaxed text-muted">
            Need continuous monitoring, spend alerts, a shared team workspace,
            or white-label client reports?{" "}
            <Link
              href={`/?ref=${ctaRef}#beta`}
              className="text-ink underline-offset-4 hover:underline"
            >
              Request Workspace design-partner access →
            </Link>
          </p>
        </Reveal>
      </section>

      <footer className="px-5 py-10 sm:px-8">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <p className="flex items-baseline gap-3">
            <Link href="/" className="wordmark wordmark-sm" aria-label="Tilden — home">
              Tilden
              <span className="wordmark-cursor" aria-hidden="true" />
            </Link>
            <span className="text-[13px] text-faint">
              financial accountability for AI agents.
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-faint">
            <Link href="/docs" className="transition-colors hover:text-ink">
              Docs
            </Link>
            <Link href="/docs/roadmap" className="transition-colors hover:text-ink">
              Roadmap
            </Link>
            <Link
              href="/blog/claude-code-cost-usage-credits"
              className="transition-colors hover:text-ink"
            >
              Cost guide
            </Link>
            <Link href="/vs/ccusage" className="transition-colors hover:text-ink">
              vs ccusage
            </Link>
            <Link href="/vs/tokscale" className="transition-colors hover:text-ink">
              vs tokscale
            </Link>
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              GitHub ↗
            </a>
            <a
              href="https://www.npmjs.com/package/aibill"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              npm ↗
            </a>
            <Link href="/#privacy" className="transition-colors hover:text-ink">
              Privacy
            </Link>
            <span className="text-green">$ npx aibill</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
