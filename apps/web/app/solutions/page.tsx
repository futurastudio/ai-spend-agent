import type { Metadata } from "next";
import Link from "next/link";
import "@/components/iterations/trace-next/tokens.css";
import s from "./solutions.module.css";
import { TraceNavigation } from "@/components/iterations/trace-next/TraceNavigation";

export const metadata: Metadata = {
  title: "AI spend assessments and assisted value pilots | Tilden",
  description: "Scope an AI Spend Assessment or an assisted AI Value Pilot with Tilden. Review supported costs, coverage and one workflow's outcome baseline.",
  alternates: { canonical: "/solutions" },
};

const offers = [
  { id: "spend-assessment", label: "01 · AI Spend Assessment", title: "Which costs can your next decision rely on?", intro: "For engineering and AI-platform owners who need to explain a provider bill to finance. Start with one spending question, one workspace and an agreed reporting period.", rows: [
    ["Bring", "Your spending question, named supported sources, an authorized access owner and comparable provider records. Include the finance reviewer who needs the answer."],
    ["Review together", "Reported costs, available project attribution, source dates and missing coverage. Optional shared activity remains separate from billed cost."],
    ["Leave with", "A scoped cost summary, a source-and-date coverage sheet, attribution limits and a short list of next investigations."],
    ["Format", "Intake, an assisted review and a written readout. We agree timing, access, scope and terms after checking the available data."],
    ["A useful result", "You can answer the agreed question, or identify the exact evidence still needed. A known subtotal is not a complete invoice audit."],
  ], cta: "Register assessment interest", ref: "spend-assessment" },
  { id: "value-pilot", label: "02 · AI Value Pilot · assisted work", title: "What would make one AI workflow worth expanding?", intro: "For a workflow owner and an engineering–finance pair who want a useful outcome baseline. This is a scoped design-partner engagement with our team, not automated ROI tracking.", rows: [
    ["Bring", "One workflow, an outcome owner, the quality standard for an accepted result, and any existing output counts, cost records and review-effort data."],
    ["Define together", "One useful outcome, a cost boundary, a comparison period and the assumptions that would make the comparison meaningful."],
    ["Leave with", "An outcome definition, a baseline and assumptions sheet, available cost evidence, and a record of what can or cannot yet be measured."],
    ["Format", "Two assisted reviews with time between them to gather evidence. The measurement period, schedule and terms depend on your workflow and are agreed before starting."],
    ["A useful result", "You know whether cost per useful outcome can be measured and which evidence is missing. The pilot does not promise improved performance or a measured return."],
  ], cta: "Register value-pilot interest", ref: "value-pilot" },
];

export default function SolutionsPage() {
  return <div data-trace-next className={s.page}>
    <a href="#content" className={s.skip}>Skip to content</a>
    <header className={s.header}>
      <Link href="/" aria-label="Tilden home"><img src="/brand/lockup/tilden-lockup-horizontal-ink.svg" alt="Tilden" width="120" height="32" /></Link>
      <TraceNavigation solutionsPage />
      <Link href="/#beta" className={s.button}>Request access</Link>
    </header>
    <main id="content">
      <section className={s.hero}>
        <p className={s.label}>Professional Services · invited partners</p>
        <h1>Which AI investments<br /><span>deserve more budget?</span></h1>
        <p className={s.intro}>Start with costs you can explain. Tilden helps engineering and finance review supported spend, identify coverage gaps and scope the evidence needed for one investment decision.</p>
        <div className={s.actions}><a className={s.button} href="#spend-assessment">Start with spend</a><a href="#value-pilot">Explore an outcome baseline <span aria-hidden="true">↓</span></a></div>
        <p className={s.note}>Hands-on work with our team. Scope, access and terms agreed before onboarding.</p>
      </section>
      <div className={s.content}>
        {offers.map(offer => <section id={offer.id} key={offer.id} className={s.offer} aria-labelledby={`${offer.id}-heading`}>
          <div><p className={s.label}>{offer.label}</p><h2 id={`${offer.id}-heading`}>{offer.title}</h2><p className={s.offerIntro}>{offer.intro}</p><Link href={`/?ref=${offer.ref}#beta`} className={s.offerCta}>{offer.cta} <span aria-hidden="true">↗</span></Link></div>
          <dl>{offer.rows.map(([term,description]) => <div key={term}><dt>{term}</dt><dd>{description}</dd></div>)}</dl>
        </section>)}
        <section className={s.boundary} aria-labelledby="today-heading"><div><p className={s.label}>The product today</p><h2 id="today-heading">Four read-only reports.<br />An explicit scope.</h2></div><div><p>Spend, available project detail, a workspace briefing and budget settings support the review. Assisted baseline work adds human analysis; it is not an automated outcome-tracking feature.</p><p>Missing history stays visible. Activity does not establish return. Reading budget settings does not enforce a spending limit.</p><div className={s.actions}><Link href="/docs/first-review">Prepare your first review</Link><Link href="/docs/sources">Check source coverage</Link><Link href="/docs/access">Understand access</Link></div></div></section>
        <section className={s.closing}><h2>Bring the question you already need to answer.</h2><p>Register interest for product updates and an access invitation. Joining does not create a workspace or book a service. We confirm fit, delivery availability and terms before agreeing an engagement.</p><Link href="/?ref=assisted-reviews#beta" className={s.button}>Register interest</Link></section>
      </div>
    </main>
    <footer className={s.footer}><Link href="/">Tilden</Link><Link href="/docs">Docs</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:contact@asktilden.com">Contact</a></footer>
  </div>;
}
