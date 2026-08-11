import Link from "next/link";
import type { ReactNode } from "react";
import { CopyCodeButton } from "@/components/CopyCodeButton";
import {
  DOCS_UPDATED,
  ISSUE_URL,
  MAIN_PREVIEW_VERSION,
  NPM_STABLE_VERSION,
  REPO_URL,
  docsNavigation,
  type DocsHref,
} from "@/lib/docs";

function DocsLinks({ current, mobile = false }: { current: DocsHref; mobile?: boolean }) {
  return (
    <nav
      aria-label={mobile ? "Documentation sections" : "Documentation"}
      className={mobile ? "grid grid-cols-2 border-l border-t border-hairline sm:grid-cols-3" : "py-6"}
    >
      {docsNavigation.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.href === current ? "page" : undefined}
          className={
            mobile
              ? "flex min-h-11 items-center whitespace-nowrap border-b border-r border-hairline px-3 text-sm text-muted transition-colors hover:text-ink focus-visible:text-ink aria-[current=page]:bg-green-wash aria-[current=page]:text-ink"
              : "docs-side-link px-6"
          }
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function DocsPage({
  current,
  title,
  intro,
  repoPath,
  children,
}: {
  current: DocsHref;
  title: string;
  intro: string;
  repoPath: string;
  children: ReactNode;
}) {
  return (
    <div className="docs-shell border-x-0 border-hairline lg:border-x">
      <header className="docs-header sticky top-0 z-40 border-b border-hairline">
        <div className="flex h-14 items-center justify-between px-5 sm:px-8">
          <Link href="/" className="wordmark min-h-11" aria-label="Tilden — home">
            Tilden
            <span className="wordmark-cursor" aria-hidden="true" />
          </Link>
          <nav className="flex items-center gap-5" aria-label="Primary navigation">
            <Link href="/" className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex">
              Product
            </Link>
            <Link
              href="/docs"
              aria-current={current === "/docs" ? "page" : undefined}
              className="inline-flex min-h-11 items-center whitespace-nowrap text-sm text-ink"
            >
              Docs
            </Link>
            <Link href="/#teams" className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink md:inline-flex">
              Teams
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              GitHub ↗
            </a>
          </nav>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-side-index hidden lg:block">
          <p className="px-6 pt-8 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
            Documentation
          </p>
          <DocsLinks current={current} />
          <div className="mx-6 border-t border-hairline pt-5 font-mono text-[11px] leading-6 text-faint">
            <p>npm latest · v{NPM_STABLE_VERSION}</p>
            <p>main · v{MAIN_PREVIEW_VERSION} preview</p>
          </div>
        </aside>

        <main className="min-w-0 px-5 pb-20 pt-10 sm:px-8 sm:pt-14 lg:px-12 lg:pb-28 lg:pt-16">
          <div className="mb-10 lg:hidden">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              Documentation
            </p>
            <DocsLinks current={current} mobile />
          </div>

          <div className="docs-reading-column">
            <div className="mb-9 border-y border-hairline py-3 font-mono text-[11px] leading-5 text-faint">
              <p>
                <span className="text-green">Published</span> · npm latest v{NPM_STABLE_VERSION}
              </p>
              <p>
                <span className="text-muted">Main preview</span> · v{MAIN_PREVIEW_VERSION} is merged but unreleased
              </p>
            </div>

            <header className="border-b border-hairline pb-10">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-green">
                aibill documentation
              </p>
              <h1 className="mt-4 text-[36px] font-medium leading-[1.08] tracking-[-0.035em] text-ink sm:text-[50px]">
                {title}
              </h1>
              <p className="mt-5 max-w-[42rem] text-base leading-7 text-muted sm:text-lg">
                {intro}
              </p>
              <p className="mt-5 font-mono text-[11px] text-faint">Updated {DOCS_UPDATED}</p>
            </header>

            <div>{children}</div>

            <footer className="mt-20 border-t border-hairline pt-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <p className="max-w-md text-sm leading-6 text-muted">
                  Found a mismatch? Documentation is part of the product’s evidence boundary.
                </p>
                <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-faint">
                  <a
                    href={`${REPO_URL}/edit/main/${repoPath}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center whitespace-nowrap transition-colors hover:text-ink"
                  >
                    Edit on GitHub ↗
                  </a>
                  <a
                    href={ISSUE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center whitespace-nowrap transition-colors hover:text-ink"
                  >
                    Report an issue ↗
                  </a>
                </div>
              </div>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

export function DocsSection({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-b border-hairline py-12 sm:py-14">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
      <h2 className="mt-3 text-2xl font-medium tracking-[-0.025em] text-ink sm:text-[30px]">
        {title}
      </h2>
      <div className="mt-6 text-[15px] leading-7 text-muted">{children}</div>
    </section>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="my-6">
      <figcaption className="flex min-h-11 items-center justify-between border-t border-hairline pl-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
        <span>{label ?? "Code"}</span>
        <CopyCodeButton value={children} />
      </figcaption>
      <pre className="docs-code px-4 py-4" tabIndex={0}>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export function DocsCallout({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "published" | "preview";
}) {
  const border = `docs-callout-${tone}`;
  const titleColor = `docs-callout-title-${tone}`;
  return (
    <aside className={`my-6 border-l ${border} bg-well px-5 py-4`}>
      <p className={`font-mono text-[11px] uppercase tracking-[0.1em] ${titleColor}`}>{title}</p>
      <div className="mt-2 text-sm leading-6 text-muted">{children}</div>
    </aside>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-ink underline decoration-hairline-bright underline-offset-4 transition-colors hover:decoration-green">
      {children}
    </Link>
  );
}
