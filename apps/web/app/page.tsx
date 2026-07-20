import { CopyCommand } from "@/components/CopyCommand";
import { WaitlistForm } from "@/components/WaitlistForm";
import { Reveal } from "@/components/Reveal";

const sources = [
  "Claude Code logs",
  "Codex logs",
  "OpenAI",
  "Anthropic",
  "Cursor",
  "Copilot",
];

const features = [
  {
    title: "Every source, one view",
    body: "Your Claude Code and Codex session logs (priced locally at API rates) — plus your real OpenAI and Anthropic bills when you connect an admin/owner key — unified into a single breakdown. Cursor and Copilot connectors are in beta. No more flipping between dashboards.",
  },
  {
    title: "A ranked list of cuts",
    body: "Surfaces your most expensive models and the concrete switches that lower the bill — move to a cheaper tier, batch offline work, cache repeats — each with an estimated $/mo saving.",
  },
  {
    title: "The plan-vs-API math",
    body: "Projects your usage at API rates against subscription plan prices, so you can tell whether Pro, Max 5x, or pay-per-token is actually cheapest. The math no provider shows you.",
  },
  {
    title: "Runs entirely locally",
    body: "One npx command reads your usage and renders the report in your terminal. No account, no upload, no telemetry. Open-source — read every line before you run it.",
  },
];

const steps = [
  {
    n: "01",
    title: "Run one command",
    body: "npx ai-spend-agent — nothing to install, configure, or sign up for.",
  },
  {
    n: "02",
    title: "It reads what's already there",
    body: "Your Claude Code and Codex session logs, locally — priced at API rates as estimates. Connect provider billing with an admin/owner key to reconcile those estimates into verified numbers.",
  },
  {
    n: "03",
    title: "See spend + what to cut",
    body: "A headline number, a ranked cut list with dollar savings, and a plan check — in under 90 seconds.",
  },
];

export default function Home() {
  return (
    <main className="relative overflow-x-clip">
      {/* Ambient light the glass refracts */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[900px]"
        aria-hidden="true"
      >
        <div className="grid-fade absolute inset-0" />
        <div className="aurora aurora-green left-[8%] top-[-120px] h-[480px] w-[560px]" />
        <div className="aurora aurora-cyan right-[4%] top-[160px] h-[420px] w-[520px]" />
      </div>

      {/* Nav — floating glass island */}
      <header className="sticky top-4 z-40 mx-auto max-w-content px-4 sm:px-6">
        <div className="glass-heavy flex items-center justify-between rounded-2xl px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="glass-well flex h-7 w-7 items-center justify-center rounded-md font-mono text-sm text-green"
            >
              $
            </span>
            <span className="font-mono text-sm font-semibold tracking-tight text-ink">
              ai-spend-agent
            </span>
          </div>
          <nav className="flex items-center gap-2">
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="glass glass-interactive hidden rounded-xl px-3.5 py-2 text-sm font-medium text-muted hover:text-ink sm:inline-flex"
            >
              GitHub
            </a>
            <a
              href="#beta"
              className="glass glass-interactive rounded-xl px-3.5 py-2 text-sm font-medium text-muted hover:text-ink"
            >
              Hosted beta
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-content px-6 pb-8 pt-14 text-center sm:pt-20">
        <a
          href="https://github.com/futurastudio/ai-spend-agent"
          target="_blank"
          rel="noreferrer"
          className="glass glass-interactive mx-auto inline-flex animate-fade-up items-center gap-2 rounded-full px-3.5 py-1.5 font-mono text-xs text-muted hover:text-ink"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden="true" />
          Free &amp; open-source · MIT
        </a>

        <h1 className="mx-auto mt-7 max-w-3xl animate-fade-up text-balance font-mono text-[2.1rem] font-semibold leading-[1.1] tracking-[-0.025em] text-ink sm:text-[3.4rem]">
          Your AI spend in one view,
          <br className="hidden sm:block" /> in{" "}
          <span className="text-green">90 seconds</span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl animate-fade-up text-balance text-base leading-relaxed text-muted sm:text-lg">
          One command unifies your OpenAI, Anthropic, Cursor, and Copilot
          bills — plus the Claude Code and Codex logs already on your machine
          — into a single breakdown, and shows you exactly where to cut. Runs
          locally. Your data never leaves your machine.
        </p>

        <div className="mt-9 flex animate-fade-up flex-col items-center gap-3">
          <CopyCommand />
          <p className="font-mono text-xs text-faint">
            Requires Node 22+. Nothing to install or sign up for.
          </p>
        </div>

        <div className="mt-8 flex animate-fade-up flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {sources.map((s) => (
            <span key={s} className="font-mono text-xs text-faint">
              {s}
            </span>
          ))}
        </div>

        {/* Real terminal recording — regenerated from the CLI by scripts/record-demo.sh */}
        <div className="relative mx-auto mt-14 max-w-terminal animate-fade-up">
          <div
            className="accent-glow pointer-events-none absolute inset-x-0 -bottom-10 top-10"
            aria-hidden="true"
          />
          <div className="glass relative overflow-hidden rounded-2xl text-left">
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-xs text-faint">
                ai-spend-agent
              </span>
            </div>
            <video
              autoPlay
              loop
              muted
              playsInline
              poster="/demo-poster.png"
              aria-label="Terminal recording of npx ai-spend-agent rendering the spend report"
              className="block w-full"
            >
              <source src="/demo.webm" type="video/webm" />
              <source src="/demo.mp4" type="video/mp4" />
            </video>
          </div>
          <p className="mt-4 text-center font-mono text-xs text-faint">
            Illustrative sample output — demo data, not real or verified numbers.
          </p>
        </div>
      </section>

      {/* What it does */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-20">
        <Reveal>
          <h2 className="text-center font-mono text-xs font-medium uppercase tracking-[0.2em] text-faint">
            What it does
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 70}>
              <div className="glass glass-interactive h-full rounded-2xl p-7">
                <h3 className="font-mono text-base font-semibold text-ink">
                  {f.title}
                </h3>
                <p className="mt-2.5 text-sm leading-relaxed text-muted">
                  {f.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120}>
          <p className="mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed text-muted">
            Every number is labeled. Figures from your local Claude Code and
            Codex logs are <span className="text-ink">estimated</span> at
            published API rates — not a bill. Connect a provider with an
            admin/owner key and those estimates become{" "}
            <span className="text-green">verified</span> against your real
            invoices.
          </p>
        </Reveal>
      </section>

      {/* How it works */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-10">
        <Reveal>
          <h2 className="text-center font-mono text-xs font-medium uppercase tracking-[0.2em] text-faint">
            How it works
          </h2>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 90}>
              <div className="glass glass-interactive h-full rounded-2xl p-7">
                <span className="font-mono text-sm text-green">{s.n}</span>
                <h3 className="mt-3 text-base font-semibold text-ink">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {s.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Privacy / trust */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-10">
        <Reveal>
          <div className="glass flex flex-col items-center gap-4 rounded-2xl px-8 py-10 text-center sm:flex-row sm:text-left">
            <span
              aria-hidden="true"
              className="glass-well flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-green"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3l7 4v5c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V7l7-4z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </span>
            <div>
              <h2 className="text-lg font-semibold text-ink">
                Your data never leaves your machine
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
                The CLI reads usage locally and renders the report in your
                terminal. No telemetry, no cloud, no keys shipped off-box.
                It&apos;s open-source — read every line before you run it.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* Roadmap: weekly artifacts */}
      <section id="roadmap" className="relative z-10 mx-auto max-w-content px-6 py-16">
        <Reveal>
          <div className="text-center">
            <h2 className="text-balance font-mono text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              What&apos;s next
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-balance text-base leading-relaxed text-muted">
              A new artifact every week — free in the CLI, built from the logs
              already on your machine. Nothing leaves your laptop.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                week: "week 1",
                cmd: "aibill limits",
                copy: "Know when you'll hit your rate cap — before it hits you."
              },
              {
                week: "week 2",
                cmd: "aibill wrapped",
                copy: "Your month with AI, as a card worth sharing."
              },
              {
                week: "week 3",
                cmd: "aibill context",
                copy: "A measured context-health grade, with named culprits."
              },
              {
                week: "week 4",
                cmd: "aibill secrets",
                copy: "Find keys leaked into your transcripts — locally."
              }
            ].map((item) => (
              <div key={item.cmd} className="glass rounded-2xl px-5 py-6">
                <div className="font-mono text-xs uppercase tracking-widest text-green">
                  {item.week}
                </div>
                <div className="mt-2 font-mono text-sm font-semibold text-ink">
                  npx {item.cmd}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted">{item.copy}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* Beta CTA */}
      <section id="beta" className="relative z-10 mx-auto max-w-content px-6 py-20">
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px]"
          aria-hidden="true"
        >
          <div className="aurora aurora-green left-[22%] top-[40px] h-[320px] w-[480px] opacity-70" />
        </div>
        <Reveal>
          <div className="glass relative mx-auto max-w-3xl rounded-3xl px-6 py-12 text-center sm:px-12">
            <h2 className="text-balance font-mono text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              Want it running 24/7?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-balance text-base leading-relaxed text-muted">
              The hosted tier is everything the CLI can&apos;t do alone: your
              history kept forever, burn-rate alerts while your laptop is off,
              your receipt and Wrapped at a living share URL, multi-machine
              merge, and team rollups. Join the beta and we&apos;ll reach out
              as spots open.
            </p>
            <div className="mx-auto mt-8 max-w-md text-left">
              <WaitlistForm />
            </div>
          </div>
        </Reveal>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5">
        <div className="mx-auto flex max-w-content flex-col items-center justify-between gap-3 px-6 py-8 font-mono text-xs text-faint sm:flex-row">
          <span>ai-spend-agent — free, local-first, open-source.</span>
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
              href="https://www.npmjs.com/package/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              npm
            </a>
            <span className="text-green">npx ai-spend-agent</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
