import s from "./WaitlistThanks.module.css";
import "./iterations/trace-next/tokens.css";

export function WaitlistThanks() {
  return <div className={s.page} data-trace-next>
    <header className={s.header}><a href="/" aria-label="Tilden home"><img src="/brand/lockup/tilden-lockup-horizontal-ink.svg" alt="Tilden" width="120" height="32" /></a><a href="/docs/cli">CLI docs ↗</a></header>
    <main className={s.main}>
      <p className={s.eyebrow}>Request received</p><h1>You’re on the waitlist.</h1>
      <p>We’ve registered your interest. Our onboarding team will reach out to learn about your AI spend and help with next steps.</p>
      <p>Workspace is invitation-only. Joining the waitlist does not create an account or grant access.</p>
      <div className={s.question}><h2>What would you like to explain about your AI spend?</h2><p>If you’d like, tell us which tools your team uses and the spending question you’re trying to answer. No credentials or billing files needed.</p><a href="mailto:contact@asktilden.com?subject=My%20Tilden%20spending%20question">Share your question by email <span aria-hidden="true">↗</span></a></div>
      <a className={s.back} href="/">← Back to Tilden</a>
    </main>
    <footer className={s.footer}><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:contact@asktilden.com">Contact</a></footer>
  </div>;
}
