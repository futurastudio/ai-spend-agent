import Link from "next/link";
import type { ReactNode } from "react";
import { CopyCodeButton } from "@/components/CopyCodeButton";
import { DOCS_UPDATED, ISSUE_URL, REPO_URL, docsNavigation, type DocsHref } from "@/lib/docs";
import "./iterations/trace-next/tokens.css";
import s from "./DocsPage.module.css";

function DocsLinks({ current, mobile = false }: { current: DocsHref; mobile?: boolean }) {
  return (
    <nav aria-label={mobile ? "Documentation sections" : "Documentation"} className={s.sectionNav}>
      {docsNavigation.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.href === current ? "page" : undefined}
          data-nested={item.href.startsWith("/docs/mcp/") || item.href === "/docs/plugin" || undefined}
          className={s.sectionLink}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function DocsPage({ current, title, intro, children, updated = DOCS_UPDATED }: {
  updated?: string;
  current: DocsHref;
  title: string;
  intro: string;
  repoPath: string;
  children: ReactNode;
}) {
  const currentIndex = docsNavigation.findIndex((item) => item.href === current);
  const currentLabel = docsNavigation[currentIndex]?.label ?? "Documentation";
  const previous = docsNavigation[currentIndex - 1];
  const next = docsNavigation[currentIndex + 1];

  return (
    <div data-trace-next data-tilden-docs className={s.page}>
      <a href="#docs-content" className={s.skipLink}>Skip to content</a>
      <header className={s.header}>
        <div className={s.headerInner}>
          <div className={s.brandGroup}>
            <Link href="/" className={s.brandLink} aria-label="Tilden home">
              <img src="/brand/lockup/tilden-lockup-horizontal-ink.svg" alt="Tilden" width="120" height="28" className={s.brand} />
            </Link>
            <Link href="/docs" className={s.docsLabel}>Docs</Link>
          </div>
          <nav className={s.headerNav} aria-label="Primary navigation">
            <Link href="/solutions" className={s.productLink}>Solutions</Link>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className={s.repositoryLink}>
              GitHub <span aria-hidden="true">↗</span>
            </a>
            <Link href="/#beta" className={s.waitlistLink}>Request access</Link>
          </nav>
        </div>
      </header>

      <div className={s.layout}>
        <aside className={s.sidebar}>
          <p className={s.sidebarHeading}>Documentation</p>
          <DocsLinks current={current} />
          <div className={s.sidebarHelp}>
            <p>Building with Tilden?</p>
            <a href={ISSUE_URL} target="_blank" rel="noreferrer">Ask a question <span aria-hidden="true">↗</span></a>
          </div>
        </aside>

        <main id="docs-content" tabIndex={-1} className={s.main}>
          <details className={s.mobileNav}>
            <summary>
              <span>Browse docs</span>
              <span className={s.mobileCurrent}>
                {currentLabel}
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </span>
            </summary>
            <DocsLinks current={current} mobile />
          </details>

          <div className={s.readingColumn}>
            <header className={s.introduction}>
              <p className={s.breadcrumb}>Documentation <span aria-hidden="true">/</span> {currentLabel}</p>
              <h1>{title}</h1>
              <p className={s.intro}>{intro}</p>
              <p className={s.updated}>Updated {updated}</p>
            </header>

            <div className={s.content}>{children}</div>

            <nav className={s.pagination} aria-label="More documentation">
              {previous && (
                <Link href={previous.href} className={s.previousPage}>
                  <span>Previous</span>
                  <strong><span aria-hidden="true">←</span> {previous.label}</strong>
                </Link>
              )}
              {next && (
                <Link href={next.href} className={s.nextPage}>
                  <span>Next</span>
                  <strong>{next.label} <span aria-hidden="true">→</span></strong>
                </Link>
              )}
            </nav>

            <footer className={s.footer}>
              <div className={s.feedback}>
                <p>Questions or a correction?</p>
                <div>
                  <a href="mailto:contact@asktilden.com">Suggest a correction <span aria-hidden="true">↗</span></a>
                  <a href={ISSUE_URL} target="_blank" rel="noreferrer">Report an issue <span aria-hidden="true">↗</span></a>
                </div>
              </div>
              <nav className={s.legalLinks} aria-label="Legal">
                <Link href="/privacy">Privacy</Link>
                <Link href="/terms">Terms</Link>
              </nav>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

export function DocsSection({ id, label, title, children }: {
  id: string;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={s.section} aria-labelledby={`${id}-heading`}>
      <p className={s.sectionLabel}>{label}</p>
      <h2 id={`${id}-heading`}>{title}</h2>
      <div className={s.sectionContent}>{children}</div>
    </section>
  );
}

export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <figure className={s.codeFigure}>
      <figcaption className={s.codeCaption}>
        <span>{label ?? "Code"}</span>
        <CopyCodeButton value={children} />
      </figcaption>
      <pre className={s.code} tabIndex={0} aria-label={label ?? "Code example"}>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export function DocsCallout({ title, children, tone = "neutral" }: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "published" | "preview";
}) {
  return (
    <aside className={s.callout} data-tone={tone}>
      <p className={s.calloutTitle}>{title}</p>
      <div className={s.calloutContent}>{children}</div>
    </aside>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className={s.textLink}>{children}</Link>;
}
