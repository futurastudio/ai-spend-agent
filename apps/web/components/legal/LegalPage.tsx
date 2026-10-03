import Link from "next/link";
import { TildenMark } from "./TildenMark";
import styles from "./legal.module.css";

export type LegalSection = { id: string; title: string; paragraphs: string[]; bullets?: string[] };

export function LegalPage({ title, intro, sections, effectiveDate = "September 30, 2026" }: { title: string; intro: string; sections: LegalSection[]; effectiveDate?: string }) {
  return <div className={styles.page}>
    <a className={styles.skip} href="#legal-content">Skip to content</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/" aria-label="Tilden home"><TildenMark size={28} tone="ultramarine" /><span>Tilden</span></Link>
      <nav aria-label="Legal navigation"><Link href="/privacy" aria-current={title === "Privacy policy" ? "page" : undefined}>Privacy</Link><Link href="/terms" aria-current={title === "Terms of service" ? "page" : undefined}>Terms</Link><Link href="/">Back to Tilden ↗</Link></nav>
    </header>
    <main id="legal-content" className={styles.main}>
      <div className={styles.hero}><p className={styles.eyebrow}>Tilden / Legal</p><h1>{title}</h1><p className={styles.intro}>{intro}</p><p className={styles.date}>Effective {effectiveDate}</p></div>
      <div className={styles.layout}>
        <aside className={styles.index}><nav aria-label="On this page"><p>On this page</p>{sections.map((section, i) => <a key={section.id} href={`#${section.id}`}><span>{String(i + 1).padStart(2, "0")}</span>{section.title}</a>)}</nav></aside>
        <article className={styles.article}>{sections.map(section => <section id={section.id} key={section.id}><h2>{section.title}</h2>{section.paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)}{section.bullets && <ul>{section.bullets.map(item => <li key={item}>{item}</li>)}</ul>}</section>)}
          <div className={styles.contact}><h2>Contact Tilden</h2><p>Futura Studio, LLC</p><a href="mailto:contact@futurastudio.info">contact@futurastudio.info</a></div>
        </article>
      </div>
    </main>
    <footer className={styles.footer}><p>Tilden · Futura Studio, LLC</p><nav aria-label="Footer"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:contact@futurastudio.info">Contact</a></nav></footer>
  </div>;
}
