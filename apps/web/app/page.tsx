import { CopyCommand } from "@/components/CopyCommand";
import { WaitlistForm } from "@/components/WaitlistForm";
import { Reveal } from "@/components/Reveal";
import { UsageGlance } from "@/components/UsageGlance";

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
    title: "Runway, not another meter",
    body: "See five-hour and weekly headroom only when the coding agent reports it, paired with reset time and a clearly labeled local exhaustion projection. Missing windows stay missing.",
  },
  {
    title: "Your work + one decision",
    body: "Connect observed project, file, automation, and agent activity to one Context Health action: continue, start fresh, review context sources, or collect more evidence.",
  },
  {
    title: "Every number explains itself",
    body: "Reported, locally observed, calculated, unmeasured, stale, or unavailable: source and freshness travel with the field instead of hiding behind one generic “live” label.",
  },
  {
    title: "One engine, three surfaces",
    body: "Terminal gives the full private baseline, Glance protects momentum during work, and explicit MCP answers “why?” from the same contract. No renderer gets a second parser.",
  },
  {
    title: "Billing when it actually matters",
    body: "API-equivalent value is comparison math—not an added subscription charge. Connect OpenAI or Anthropic admin billing only when you need verified reconciliation.",
  },
];

const steps = [
  {
    n: "01",
    title: "Run one command",
    body: "npx aibill — nothing to install, configure, or sign up for. (Also on npm as ai-spend-agent.)",
  },
  {
    n: "02",
    title: "Keep the decision at a glance",
    body: "The optional macOS hover shows current work, reported runway, freshness, and one action without becoming an always-on floating widget.",
  },
  {
    n: "03",
    title: "Ask why only when needed",
    body: "Invoke the optional MCP/plugin for a conversational explanation, or connect provider billing for verified reconciliation. Both reuse the same local contracts.",
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
        <div className="aurora aurora-violet left-[42%] top-[360px] h-[360px] w-[430px]" />
      </div>

      {/* Nav — floating glass island */}
      <header className="sticky top-4 z-40 mx-auto max-w-content px-4 sm:px-6">
        <div className="glass-heavy flex items-center justify-between rounded-full px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="glass-well flex h-7 w-7 items-center justify-center rounded-md font-mono text-sm text-green"
            >
              $
            </span>
            <span className="font-mono text-sm font-semibold tracking-tight text-ink">
              aibill
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

        <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-balance text-[2.65rem] font-semibold leading-[0.98] tracking-[-0.06em] text-ink sm:text-[5rem]">
          Will your AI coding session
          <br className="hidden sm:block" />{" "}
          <span className="bg-gradient-to-r from-green-bright via-cyan to-[#9d8cff] bg-clip-text text-transparent">
            make it to the finish line?
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl animate-fade-up text-balance text-base leading-relaxed text-muted sm:text-xl">
          Know what you&apos;re working on, whether reported limits will last,
          and what to do next. Start in Terminal, keep it visible only on hover,
          and ask the same local data through MCP when you need an explanation.
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

        {/* Native-companion direction: the useful CLI signal at a glance. */}
        <div className="relative mx-auto mt-14 max-w-terminal animate-fade-up text-left">
          <div
            className="accent-glow pointer-events-none absolute inset-x-0 -bottom-10 top-10"
            aria-hidden="true"
          />
          <UsageGlance />
          <p className="mt-4 text-center text-xs leading-relaxed text-faint">
            Native prototype: <span className="text-muted">aibill Glance</span>,
            a source-built macOS companion backed by the same local transcript
            engine as the CLI and MCP server. It stays hidden until the pointer
            reaches the menu bar; then one stationary glass wordmark appears
            left of the camera. Hover it—no click required—to slide down the
            panel. Session value is estimated at API rates—not treated as
            an added subscription charge—plan limits appear only when the agent
            reports each window, and Main focus describes the dominant local
            workstream rather than its spend. Its final two-line row combines
            the same Context Health, focus, and reported-runway contract used
            by Terminal and MCP; clicking it copies a handoff, but never runs
            an agent. Freshness is explicit, including stale and failed-refresh
            states. The numbers above are illustrative; a signed public
            download is not available yet.
          </p>
        </div>

        {/* Real terminal recording — regenerated from the CLI by scripts/record-demo.sh */}
        <div className="relative mx-auto mt-10 max-w-terminal animate-fade-up">
          <div className="mb-4 flex items-center justify-between px-1 text-left">
            <div>
              <p className="text-sm font-semibold text-ink">Need the full receipt?</p>
              <p className="mt-1 text-xs text-faint">The terminal remains the source of truth.</p>
            </div>
            <span className="font-mono text-xs text-green">npx aibill</span>
          </div>
          <div className="glass relative overflow-hidden rounded-[1.6rem] text-left">
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-xs text-faint">
                aibill
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
          <h2 className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-faint">
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
            published API rates — not a bill. Glance separately labels local
            transcript facts, local calculations, locally detected plans, and
            coding-agent-reported limits. Connect a provider with an
            admin/owner key and aggregate spend can be{" "}
            <span className="text-green">verified</span> against your real
            invoices.
          </p>
        </Reveal>
      </section>

      {/* How it works */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-10">
        <Reveal>
          <h2 className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-faint">
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
                Local by default, explicit when shared
              </h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
                The CLI reads usage locally and renders the report in your
                terminal. No telemetry, no cloud, no keys shipped off-box.
                Glance stays local too. If you explicitly ask an MCP-backed AI
                client, only the structured tool result is returned to that
                client and follows its data policy.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* Delivery surfaces */}
      <section id="roadmap" className="relative z-10 mx-auto max-w-content px-6 py-16">
        <Reveal>
          <div className="text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
              Three surfaces, one answer
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-balance text-base leading-relaxed text-muted">
              Choose the terminal, an on-demand AI skill, or the macOS hover.
              Every surface consumes the same evidence and Context Health contract.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                week: "available",
                cmd: "npx aibill context",
                copy: "Hook-aware Context Health in human-readable or canonical JSON form."
              },
              {
                week: "available",
                cmd: "$aibill-check",
                copy: "An explicit-only plugin skill backed by the local aibill MCP."
              },
              {
                week: "prototype",
                cmd: "aibill Glance",
                copy: "A hidden-until-hover macOS view of runway, focus, and one action."
              },
              {
                week: "research next",
                cmd: "aibill Workboard",
                copy: "A temporary expanded view of recent work, verified changes, blockers, and resume state."
              }
            ].map((item) => (
              <div key={item.cmd} className="glass rounded-2xl px-5 py-6">
                <div className="font-mono text-xs uppercase tracking-widest text-green">
                  {item.week}
                </div>
                <div className="mt-2 font-mono text-sm font-semibold text-ink">
                  {item.cmd}
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
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
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
          <span>aibill — free, local-first, open-source. Also on npm as ai-spend-agent.</span>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <a
              href="/blog/ai-coding-context-health"
              className="transition-colors hover:text-ink"
            >
              Context health
            </a>
            <a
              href="/blog/claude-code-cost-usage-credits"
              className="transition-colors hover:text-ink"
            >
              Claude cost guide
            </a>
            <a href="/vs/ccusage" className="transition-colors hover:text-ink">
              vs ccusage
            </a>
            <a href="/vs/tokscale" className="transition-colors hover:text-ink">
              vs tokscale
            </a>
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
            <span className="text-green">npx aibill</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
