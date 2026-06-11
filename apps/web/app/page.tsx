import { CopyCommand } from "@/components/CopyCommand";
import { WaitlistForm } from "@/components/WaitlistForm";

const providers = ["OpenAI", "Anthropic", "Cursor", "Copilot"];

const features = [
  {
    title: "Every provider, one view",
    body: "OpenAI, Anthropic, Cursor, and Copilot spend unified into a single breakdown — no more flipping between four billing dashboards.",
  },
  {
    title: "Find the waste",
    body: "Surfaces your most expensive models, runaway usage, and the concrete switches that cut the bill — ranked by how much you'd save.",
  },
  {
    title: "Runs entirely locally",
    body: "A single npx command reads your usage and renders the report in your terminal. No account, no upload, no setup.",
  },
];

export default function Home() {
  return (
    <main className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[680px] grid-fade"
        aria-hidden="true"
      />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex max-w-content items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface font-mono text-xs text-accent"
          >
            $
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">
            AI Spend Analyst
          </span>
        </div>
        <a
          href="#beta"
          className="rounded-lg border border-border bg-surface/60 px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-white/20 hover:text-ink"
        >
          Join the beta
        </a>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-content px-6 pb-20 pt-16 text-center sm:pt-24">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-3.5 py-1.5 text-xs text-muted animate-fade-up">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          Free &amp; open-source CLI
        </div>

        <h1 className="mx-auto mt-7 max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-ink animate-fade-up sm:text-6xl">
          See your AI spend in one view in{" "}
          <span className="bg-gradient-to-r from-accent-bright to-accent bg-clip-text text-transparent">
            90 seconds
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-relaxed text-muted animate-fade-up sm:text-lg">
          One command unifies your OpenAI, Anthropic, Cursor, and Copilot bills
          into a single breakdown — and shows you exactly where to cut. Runs
          locally. Your data never leaves your machine.
        </p>

        <div className="mt-9 flex flex-col items-center gap-3 animate-fade-up">
          <CopyCommand />
          <p className="text-xs text-faint">
            Requires Node. Nothing to install or sign up for.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 animate-fade-up">
          {providers.map((p) => (
            <span
              key={p}
              className="text-sm font-medium text-faint transition-colors hover:text-muted"
            >
              {p}
            </span>
          ))}
        </div>

        {/* Demo placeholder */}
        <div className="mx-auto mt-16 max-w-4xl animate-fade-up">
          <div className="rounded-2xl border border-border bg-surface/50 p-2 shadow-2xl shadow-black/40 backdrop-blur">
            <div className="flex items-center gap-1.5 px-3 py-2.5">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-xs text-faint">
                ai-spend-agent
              </span>
            </div>
            <div className="flex aspect-[16/9] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-bg/60 text-center">
              <span className="rounded-full border border-border bg-surface px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-faint">
                Demo
              </span>
              <p className="max-w-xs text-sm text-muted">
                Animated walkthrough of the spend report goes here.
              </p>
              <p className="font-mono text-xs text-faint">
                [ placeholder &mdash; demo.gif ]
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-16">
        <h2 className="text-center text-sm font-medium uppercase tracking-widest text-faint">
          What it does
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="bg-surface/60 p-7">
              <h3 className="text-base font-semibold text-ink">{f.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Privacy / trust */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-10">
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-gradient-to-b from-surface/80 to-surface/30 px-8 py-10 text-center sm:flex-row sm:text-left">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg text-accent"
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
              terminal. No telemetry, no cloud, no keys shipped off-box. It&apos;s
              open-source — read every line before you run it.
            </p>
          </div>
        </div>
      </section>

      {/* Beta CTA */}
      <section id="beta" className="relative z-10 mx-auto max-w-content px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Want it running 24/7?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-balance text-base leading-relaxed text-muted">
            The hosted version adds continuous monitoring, spend alerts before
            bills spike, and white-label reports you can send straight to
            clients. Join the beta and we&apos;ll reach out as spots open.
          </p>
          <div className="mx-auto mt-8 max-w-md text-left">
            <WaitlistForm />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border">
        <div className="mx-auto flex max-w-content flex-col items-center justify-between gap-3 px-6 py-8 text-xs text-faint sm:flex-row">
          <span>AI Spend Analyst — free, local-first, open-source.</span>
          <span className="font-mono">npx ai-spend-agent</span>
        </div>
      </footer>
    </main>
  );
}
