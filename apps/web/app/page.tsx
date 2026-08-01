import { CopyCommand } from "@/components/CopyCommand";
import { WaitlistForm } from "@/components/WaitlistForm";
import { Reveal } from "@/components/Reveal";
import { UsageGlance } from "@/components/UsageGlance";

const sources = [
  "Claude Code · local logs",
  "Codex · local logs",
  "OpenAI · provider API",
  "Anthropic · provider API",
  "Cursor Admin API · beta",
  "Copilot org API · beta",
];

const features = [
  {
    title: "Runway, not another meter",
    body: "See five-hour and weekly headroom only when the coding agent reports it, paired with reset time and a clearly labeled local exhaustion projection. Missing windows stay missing.",
  },
  {
    title: "Your work + one decision",
    body: "Connect observed project, file, automation, and agent activity to one Context Health action: continue, start fresh, review context evidence, or collect more history.",
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
    body: "API-equivalent value is comparison math—not an added subscription charge. Connect OpenAI or Anthropic admin billing only when you need official provider-reported cost beside it.",
  },
];

const steps = [
  {
    n: "01",
    title: "Run one command",
    body: "npx aibill — no global install, account, or initial configuration. (Also on npm as ai-spend-agent.)",
  },
  {
    n: "02",
    title: "Preview the decision at a glance",
    body: "The source-built macOS preview shows current work, reported runway, freshness, and one action. A signed standalone download is not available yet.",
  },
  {
    n: "03",
    title: "Ask why only when needed",
    body: "Invoke the optional MCP/plugin for a conversational explanation, or connect OpenAI/Anthropic admin reporting to add official provider-reported cost beside local estimates.",
  },
];

const decisions = [
  {
    status: "Available in beta",
    title: "Separate billed cost from usage value",
    body: "Keep official cost reports, purchased credits, subscription capacity, and API-equivalent value separate. Final invoices can still include credits, discounts, tax, or adjustments.",
  },
  {
    status: "Available with source coverage",
    title: "See available ownership",
    body: "Use only the project, model, agent, user, workspace, or client dimensions each source exposes as inputs to allocation or rebilling decisions.",
  },
  {
    status: "Available in beta",
    title: "Assess interruption risk",
    body: "Pair provider-reported limit windows and reset time with a separately labeled exhaustion projection. Missing windows remain unavailable instead of becoming false precision.",
  },
  {
    status: "Available in beta",
    title: "Investigate possible waste",
    body: "Review context pressure, injected items or items with no observed invocation, repeated work, model mix, and unusual burn—then re-run the same evidence contract after an intervention.",
  },
  {
    status: "Open roadmap",
    title: "Compare cost per accepted outcome",
    body: "Join cost to tests, review, rework, merge, and task acceptance so teams compare workflows on accepted results backed by explicit evidence—not tokens, lines of code, or invented hours saved.",
  },
  {
    status: "Workspace roadmap",
    title: "Decide what to scale or stop",
    body: "Give engineering and finance one ledger for provider cost evidence, outcomes, budgets, approvals, and policy results—the basis for deciding whether to expand, constrain, renegotiate, or retire an AI workflow.",
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
              className="glass glass-interactive whitespace-nowrap rounded-xl px-2.5 py-2 text-xs font-medium text-muted hover:text-ink sm:px-3.5 sm:text-sm"
            >
              Become a design partner
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
          Know what your AI coding agents consumed
          <br className="hidden sm:block" />{" "}
          <span className="bg-gradient-to-r from-green-bright via-cyan to-[#9d8cff] bg-clip-text text-transparent">
            and what to do next.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl animate-fade-up text-balance text-base leading-relaxed text-muted sm:text-xl">
          Separate local API-equivalent usage, detected subscription context,
          and optional provider-reported cost. See what each source exposes,
          where runway is at risk, and one evidence-backed next
          action—without uploading raw conversations.
        </p>

        <div className="mt-9 flex animate-fade-up flex-col items-center gap-3">
          <CopyCommand />
          <p className="font-mono text-xs text-faint">
            Requires Node 22+. No global install or signup.
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
            Hidden until hover on macOS, <span className="text-muted">aibill
            Glance</span> reveals one sourced snapshot: session value, reported
            runway, main focus, freshness, and one next action. Hover its
            wordmark—or tap it in this preview. It reads the same local
            contract as Terminal and MCP, never invents missing limits, and
            never runs an agent. This is a source-built preview; a signed
            public download is not available yet.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 font-mono text-xs">
            <a
              href="https://github.com/futurastudio/ai-spend-agent/tree/main/apps/glance-macos"
              target="_blank"
              rel="noreferrer"
              className="text-muted transition-colors hover:text-ink"
            >
              Build Glance from source ↗
            </a>
            <a
              href="https://github.com/futurastudio/ai-spend-agent/tree/main/benchmarks/glance-comprehension"
              target="_blank"
              rel="noreferrer"
              className="text-muted transition-colors hover:text-ink"
            >
              Read the study protocol ↗
            </a>
            <a
              href="/?ref=glance-study#beta"
              className="text-green transition-colors hover:text-green-bright"
            >
              Volunteer for the study →
            </a>
          </div>
        </div>

        {/* Real terminal recording — regenerated from the CLI by scripts/record-demo.sh */}
        <div className="relative mx-auto mt-10 max-w-terminal animate-fade-up">
          <div className="mb-4 flex items-center justify-between px-1 text-left">
            <div>
              <p className="text-sm font-semibold text-ink">Need the full receipt?</p>
              <p className="mt-1 text-xs text-faint">The terminal remains the complete private baseline.</p>
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
            Illustrative sample data. API-rate figures are modeled, not
            provider-reported cost or verified savings.
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
            admin/owner source to add{" "}
            <span className="text-green">official provider-reported cost</span>{" "}
            beside those estimates. Final invoices can still include credits,
            discounts, tax, or adjustments.
          </p>
        </Reveal>
      </section>

      {/* Decisions and ROI path */}
      <section className="relative z-10 mx-auto max-w-content px-6 py-16">
        <Reveal>
          <div className="text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
              A trustworthy view should change a decision
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-balance text-base leading-relaxed text-muted">
              The beta establishes cost-and-capacity evidence: provider reports,
              subscription context, API-equivalent value, ownership, coverage,
              and what is missing. The roadmap then links that ledger to accepted
              outcomes. ROI also requires independently measured monetary value.
            </p>
          </div>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {decisions.map((decision, i) => (
            <Reveal key={decision.title} delay={i * 60}>
              <div className="glass h-full rounded-2xl p-6">
                <span className="font-mono text-[0.68rem] uppercase tracking-wider text-green">
                  {decision.status}
                </span>
                <h3 className="mt-3 text-base font-semibold text-ink">
                  {decision.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {decision.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={100}>
          <p className="mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed text-faint">
            Public-beta boundaries: aibill does not infer missing plan limits,
            claim productivity or ROI, or automatically enforce a recommendation.
            Glance remains a source preview and Workspace is not launched.
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
                The default CLI and Glance run locally with no account,
                telemetry, key, or upload. If you deliberately connect provider
                billing, the env-referenced credential is sent only to that
                provider&apos;s official API. Explicit MCP results go only to the
                AI client you invoked and follow that client&apos;s data policy.
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
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[
              {
                week: "public beta",
                cmd: "npx aibill",
                copy: "Private view of available usage/spend evidence, provenance, attribution, and ranked investigations."
              },
              {
                week: "public beta",
                cmd: "MCP + explicit plugin",
                copy: "On-demand explanation from the same structured contract; never an always-on prompt.",
                href: "https://github.com/futurastudio/ai-spend-agent/blob/main/docs/MCP.md",
                cta: "Configure MCP →"
              },
              {
                week: "source preview",
                cmd: "aibill Glance",
                copy: "A hidden-until-hover macOS view. No signed standalone download is available yet.",
                href: "https://github.com/futurastudio/ai-spend-agent/tree/main/apps/glance-macos",
                cta: "Build from source →"
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
                {item.href && item.cta && (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex font-mono text-xs text-green transition-colors hover:text-green-bright"
                  >
                    {item.cta}
                  </a>
                )}
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
              Turn local evidence into company-wide decisions
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-balance text-base leading-relaxed text-muted">
              The planned aibill Workspace consolidates explicit,
              aggregate-only receipts into a shared organizational evidence
              ledger: provider cost reports, project/client ownership, budgets,
              anomaly routing, approvals, and evidence-backed cost per accepted
              outcome where coverage supports it. Local mode stays free and
              private. Join as a design partner to shape the first shared-ledger
              alpha. Workspace is not launched; the local CLI and MCP remain
              useful without an account.
            </p>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-faint">
              Testing the Mac preview instead? Read the{" "}
              <a
                href="https://github.com/futurastudio/ai-spend-agent/tree/main/benchmarks/glance-comprehension"
                target="_blank"
                rel="noreferrer"
                className="text-muted underline-offset-4 hover:text-ink hover:underline"
              >
                Glance study protocol
              </a>{" "}
              and volunteer below. We&apos;ll provide the exact preview build and
              setup for each session; broad-distribution validation will be
              repeated on the future signed candidate.
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
              href="https://github.com/futurastudio/ai-spend-agent/issues/new/choose"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink"
            >
              Report an issue
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
