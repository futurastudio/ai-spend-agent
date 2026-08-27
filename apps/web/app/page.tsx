import { CopyCommand } from "@/components/CopyCommand";
import { JsonLd } from "@/components/JsonLd";
import { ProductTour } from "@/components/ProductTour";
import { Reveal } from "@/components/Reveal";
import { Statusline } from "@/components/Statusline";
import { TerminalReceipt } from "@/components/TerminalReceipt";
import { WaitlistForm } from "@/components/WaitlistForm";

const REPO = "https://github.com/futurastudio/ai-spend-agent";

const sources = [
  { name: "Claude Code", role: "transcript parser", chip: "LIVE", tone: "live" },
  { name: "Codex CLI", role: "transcript parser", chip: "LIVE", tone: "live" },
  {
    name: "OpenAI",
    role: "billing API",
    chip: "LIVE · VERIFIED",
    tone: "verified",
  },
  {
    name: "Anthropic",
    role: "billing API",
    chip: "LIVE · VERIFIED",
    tone: "verified",
  },
  {
    name: "Cursor",
    role: "billing connector",
    chip: "BETA · FIXTURE-VERIFIED",
    tone: "beta",
  },
  {
    name: "GitHub Copilot",
    role: "billing connector",
    chip: "BETA · FIXTURE-VERIFIED",
    tone: "beta",
  },
] as const;

function chipClass(tone: "live" | "verified" | "beta") {
  if (tone === "verified") return "border-green-line text-green";
  if (tone === "live") return "border-hairline-bright text-muted";
  return "border-hairline text-faint";
}

const workspaceItems = [
  "continuous monitoring",
  "spend alerts",
  "shared team workspace",
  "white-label client reports",
];

const faqs = [
  {
    question: "Is API-equivalent value my bill?",
    answer:
      "No. It is comparison math based on published API rates. aibill keeps that separate from detected subscription context and optional provider-reported cost; final invoices may still include credits, discounts, tax, or adjustments.",
  },
  {
    question: "What leaves my computer?",
    answer:
      "Your transcripts, prompts, file names, and dollar amounts never leave your machine, and no account is needed. Two disclosed exceptions: the CLI counts which commands run — anonymous, never your data or content — after a printed first-run notice, and aibill telemetry off or DO_NOT_TRACK ends it; the optional launch-email ask sends exactly the one payload the CLI prints, only after you type y. Provider credentials are used only when you explicitly connect an official billing API, and MCP results go only to the AI client you invoke under that client’s data policy. aibill never sits in the inference path and never stores, prints, or proxies provider credentials.",
  },
  {
    question: "What can I use today?",
    answer:
      "The local CLI and explicit MCP integration are in public beta. Glance can be built from source for testing; a signed Mac download and the shared Workspace are not launched yet.",
  },
  {
    question: "Can it warn me before I hit a usage limit?",
    answer:
      "Locally, yes. aibill reads the limit windows your agents already report and shows runway — how much of the window is left and when it resets — in the CLI, in Glance, and in the Claude Code statusline. Detection is read-only from local state; where a source doesn't expose a limit, the gap stays visible instead of being guessed.",
  },
  {
    question: "Can finance use aibill to prove ROI?",
    answer:
      "Not from spend evidence alone. The beta establishes cost, activity, attribution, and coverage, and now records locally confirmed ownership and accepted GitHub outcomes. Defensible ROI requires reconciled cost, an accepted outcome, and independently evidenced business value; the company-accountability layer that reconciles those at team scale is next.",
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
      {children}
    </p>
  );
}

export default function Home() {
  return (
    <div className="frame">
      <header className="sticky top-0 z-40 border-b border-hairline bg-[rgba(12,13,9,0.97)]">
        <div className="flex h-14 items-center justify-between px-5 sm:px-8">
          <a href="#top" className="wordmark min-h-11" aria-label="Tilden — home">
            Tilden
            <span className="wordmark-cursor" aria-hidden="true" />
          </a>
          <nav className="flex items-center gap-6" aria-label="Primary navigation">
            <a
              href="#product"
              className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              Product
            </a>
            <a
              href="/docs"
              className="inline-flex min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink"
            >
              Docs
            </a>
            <a
              href="#teams"
              className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              Teams
            </a>
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="hidden min-h-11 items-center whitespace-nowrap text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              GitHub ↗
            </a>
            <a
              href="/?ref=teams#beta"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-sm border border-hairline-bright px-3.5 py-2 text-sm text-muted transition-colors hover:border-[rgba(255,255,255,0.25)] hover:text-ink"
            >
              Design partners
            </a>
          </nav>
        </div>
      </header>

      <main id="top" className="scroll-mt-24">
        {/* Hero — renders at first paint, never inside a reveal. */}
        <section className="border-b border-hairline px-5 pb-16 pt-16 sm:px-8 sm:pb-20 sm:pt-28">
          <h1 className="max-w-[840px] text-[34px] font-medium leading-[1.08] tracking-[-0.03em] text-ink sm:text-[56px]">
            Know what your AI agents cost.
            <br className="hidden sm:block" /> See the work behind the bill.
          </h1>
          <p className="mt-5 max-w-[560px] text-base leading-relaxed text-muted sm:text-lg">
            Reads supported coding-agent activity and optional provider cost
            reports. Local-first, every number labeled, in 90 seconds.
          </p>
          <div className="mt-8 max-w-[380px]">
            <CopyCommand />
          </div>
          <p className="mt-3 font-mono text-xs text-faint">
            Free · open source · no signup · transcripts never leave your
            machine.
          </p>
          <p className="mt-6 text-[13px] text-faint">
            Tilden is built on the open-source{" "}
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
            >
              aibill
            </a>{" "}
            engine. Requires Node 22+.
          </p>
        </section>

        {/* 01 · The receipt */}
        <section
          id="product"
          className="scroll-mt-24 border-b border-hairline px-5 py-16 sm:px-8 sm:py-24"
        >
          <Reveal>
            <Eyebrow>01 · The receipt</Eyebrow>
            <h2 className="mt-3 text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
              The receipt, not a dashboard.
            </h2>
            <p className="mt-3 max-w-[640px] text-base leading-relaxed text-muted">
              Real output. Sanitized sample data. Every number labeled.
            </p>
            <div className="relative mt-10">
              <div
                className="grid-field pointer-events-none absolute -inset-x-5 -inset-y-8 sm:-inset-x-16 sm:-inset-y-16"
                aria-hidden="true"
              />
              <div className="relative">
                <TerminalReceipt />
              </div>
            </div>
            <p className="mt-3 font-mono text-[11px] text-faint">
              # sample data · 9 records · labels: provider-reported / estimated
              / detected-unverified / missing
            </p>
          </Reveal>
        </section>

        {/* 02 · Evidence */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <Reveal>
            <Eyebrow>02 · Evidence</Eyebrow>
            <div className="mt-6 grid gap-8 md:grid-cols-2 md:items-end">
              <p className="font-mono text-[clamp(64px,12vw,136px)] leading-none tracking-[-0.04em] text-green [font-variant-numeric:tabular-nums]">
                $0.00
              </p>
              <div>
                <p className="max-w-[420px] text-lg leading-relaxed text-muted">
                  Variance in our tested OpenAI Costs API reconciliation.
                </p>
                <p className="mt-3 max-w-[420px] text-[13px] leading-relaxed text-faint">
                  Release QA — the Costs total reconciled to invoiced
                  API credits, net of the provider-UI balance. Each user&apos;s
                  final invoice remains separate.
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        {/* 03 · How it works */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <Reveal>
            <Eyebrow>03 · How it works</Eyebrow>
          </Reveal>
          <div className="mt-4 divide-y divide-hairline">
            <Reveal className="grid gap-8 py-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-center">
              <div>
                <h3 className="text-[19px] font-medium tracking-[-0.015em] text-ink sm:text-[22px]">
                  Every number carries its label
                </h3>
                <p className="mt-3 max-w-[480px] text-[15px] leading-relaxed text-muted">
                  Verified, estimated, detected, or missing — every dollar on
                  the receipt states its evidence. Green is reserved for
                  provider-reported numbers: proven, never modeled.
                </p>
              </div>
              <div>
                <div className="receipt rounded-sm border border-hairline bg-well font-mono text-[12px] sm:text-[13px]">
                  <div className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-3">
                    <span>
                      <span className="tl-green">●</span>{" "}
                      <span className="tl-muted">provider-reported</span>
                    </span>
                    <span className="tl-green">$12.00 billed</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-3">
                    <span>
                      <span className="tl-faint">~</span>{" "}
                      <span className="tl-muted">estimated</span>
                    </span>
                    <span className="tl-amber">$56.60</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-3">
                    <span>
                      <span className="tl-faint">◌</span>{" "}
                      <span className="tl-faint">detected/unverified</span>
                    </span>
                    <span className="text-ink">$30.40</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 px-4 py-3">
                    <span>
                      <span className="tl-faint">—</span>{" "}
                      <span className="tl-faint">missing</span>
                    </span>
                    <span className="tl-faint">connect a provider</span>
                  </div>
                </div>
                <p className="mt-3 font-mono text-[11px] text-faint">
                  # the four labels, illustrated — only a provider-reported
                  dollar is ever green
                </p>
              </div>
            </Reveal>
            <Reveal className="grid gap-8 py-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-center">
              <div>
                <h3 className="text-[19px] font-medium tracking-[-0.015em] text-ink sm:text-[22px]">
                  Knows the plan you already pay for
                </h3>
                <p className="mt-3 max-w-[480px] text-[15px] leading-relaxed text-muted">
                  Detects Claude Pro/Max and ChatGPT Plus/Pro plans from
                  your agents&apos; local config — read-only, nothing connected.
                  Shows limit runway and how API-equivalent usage compares with
                  the plan&apos;s listed price: a value difference to
                  investigate, not proof of coverage.
                </p>
              </div>
              <div>
                <div className="receipt rounded-sm border border-hairline bg-well p-4 font-mono text-[12px] leading-[1.7] sm:text-[13px]">
                  <div className="tl-line">
                    <span className="tl-strong">DETECTED PLAN  </span>
                    <span className="tl-muted">
                      Claude Max 5x — from local config (read-only)
                    </span>
                  </div>
                  <div className="tl-line">
                    <span className="tl-strong">COMPARED WITH  </span>
                    <span className="tl-muted">
                      Claude Max 5x ($100/mo) — API-equivalent
                    </span>
                  </div>
                  <div className="tl-line">
                    <span className="tl-muted">  usage is </span>
                    <span className="tl-amber">~4.3×</span>
                    <span className="tl-muted"> the listed price</span>
                  </div>
                </div>
                <p className="mt-3 font-mono text-[11px] text-faint">
                  # illustration of plan detection — sample mode can&apos;t
                  detect a plan; run npx aibill to see yours
                </p>
              </div>
            </Reveal>
            <Reveal className="grid gap-8 py-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-center">
              <div>
                <h3 className="text-[19px] font-medium tracking-[-0.015em] text-ink sm:text-[22px]">
                  Ambient in your statusline
                </h3>
                <p className="mt-3 max-w-[480px] text-[15px] leading-relaxed text-muted">
                  The receipt follows you into Claude Code. One line, always
                  current: limits left, reset time, seven-day value.
                </p>
              </div>
              <div>
                <Statusline />
                <p className="mt-3 font-mono text-[11px] text-faint">
                  # the real statusline template — the ~ marks API-equivalent
                  estimates; billed dollars only ever appear verified
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 04 · Surfaces */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <Reveal>
            <Eyebrow>04 · Surfaces</Eyebrow>
            <h2 className="mt-3 text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
              One receipt. Three places to read it.
            </h2>
            <p className="mt-3 max-w-[640px] text-base leading-relaxed text-muted">
              Menu bar, terminal, AI client — same local evidence, same
              labels, same numbers, nothing recomputed per surface.
            </p>
            <div className="mt-8">
              <ProductTour />
            </div>
            <p className="mt-3 font-mono text-[11px] text-faint">
              # terminal: the same sample receipt as above, recorded uncut ·
              glance &amp; mcp: a second illustrative session · sample data
              throughout
            </p>
          </Reveal>
        </section>

        {/* 05 · Privacy */}
        <section
          id="privacy"
          className="scroll-mt-24 border-b border-hairline px-5 py-16 sm:px-8 sm:py-24"
        >
          <Reveal>
            <Eyebrow>05 · Privacy</Eyebrow>
            <div className="mt-6 grid gap-8 md:grid-cols-2 md:items-end">
              <p className="font-mono text-[clamp(64px,12vw,136px)] leading-none tracking-[-0.04em] text-ink [font-variant-numeric:tabular-nums]">
                0
              </p>
              <div className="text-lg leading-relaxed text-muted">
                <p>0 transcripts, prompts, or file names uploaded.</p>
                <p>Your code and your dollars stay on your machine.</p>
                <p>Analysis runs locally — no account, no signup.</p>
              </div>
            </div>
            <p className="mt-10 max-w-[640px] border-t border-hairline pt-6 text-base font-medium text-ink">
              Never in the inference path; never stores, prints, or proxies
              provider credentials.
            </p>
          </Reveal>
        </section>

        {/* 06 · Sources */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <Reveal>
            <Eyebrow>06 · Sources</Eyebrow>
            <h2 className="mt-3 text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
              Reads what your agents already write.
            </h2>
            <p className="mt-3 max-w-[640px] text-base leading-relaxed text-muted">
              Transcripts locally; billing APIs only when you connect them.
            </p>
            <p className="mt-4 text-sm">
              <a
                href="/docs/sources"
                className="text-ink underline decoration-hairline-bright underline-offset-4 transition-colors hover:decoration-green"
              >
                View coverage and limitations →
              </a>
            </p>
            <div className="mt-8 grid border-l border-t border-hairline sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => (
                <div
                  key={source.name}
                  className="min-h-[128px] border-b border-r border-hairline p-6 transition-colors duration-150 hover:bg-panel"
                >
                  <p className="text-base font-medium text-ink">{source.name}</p>
                  <p className="mt-1 font-mono text-xs text-faint">
                    {source.role}
                  </p>
                  <span
                    className={`mt-4 inline-block rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ${chipClass(source.tone)}`}
                  >
                    {source.chip}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 font-mono text-[11px] text-faint">
              # statuses are literal — beta means fixture-verified, not yet
              verified against live billing
            </p>
          </Reveal>
        </section>

        {/* 07 · Teams */}
        <section
          id="teams"
          className="scroll-mt-24 border-b border-hairline px-5 py-16 sm:px-8 sm:py-24"
        >
          <Reveal>
            <Eyebrow>07 · Teams</Eyebrow>
            <div className="mt-6 grid gap-12 md:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
              <div>
                <h2 className="text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
                  For teams and agencies accountable for agent spend.
                </h2>
                <p className="mt-4 max-w-[520px] text-base leading-relaxed text-muted">
                  The engine stays open source. Tilden Workspace adds the same
                  evidence labels at team scale.
                </p>
                <ul className="mt-8 max-w-[520px]">
                  {workspaceItems.map((item) => (
                    <li
                      key={item}
                      className="flex items-baseline py-2 font-mono text-[13px] text-ink"
                    >
                      <span>{item}</span>
                      <span className="dotted-leader" aria-hidden="true" />
                      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                        Workspace
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div id="beta" className="scroll-mt-24">
                <h3 className="text-[19px] font-medium tracking-[-0.015em] text-ink sm:text-[22px]">
                  Become a founding design partner
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-muted">
                  Founding design partners will help shape reconciliation,
                  budgets, approvals, and reporting before the workspace
                  launches broadly.
                </p>
                <div className="mt-6">
                  <WaitlistForm />
                </div>
                <p className="mt-4 text-xs leading-relaxed text-faint">
                  Workspace is not launched. Local mode stays free and private.
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        {/* 08 · FAQ */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <JsonLd
            data={{
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: faqs.map((faq) => ({
                "@type": "Question",
                name: faq.question,
                acceptedAnswer: { "@type": "Answer", text: faq.answer },
              })),
            }}
          />
          <Reveal>
            <Eyebrow>08 · FAQ</Eyebrow>
            <h2 className="mt-3 text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
              The short answers.
            </h2>
            <div className="mt-8 max-w-[640px] divide-y divide-hairline border-y border-hairline">
              {faqs.map((faq) => (
                <details key={faq.question} className="group">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-4 text-left text-base font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-line [&::-webkit-details-marker]:hidden">
                    {faq.question}
                    <span
                      aria-hidden="true"
                      className="font-mono text-base font-normal text-faint transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
                    >
                      +
                    </span>
                  </summary>
                  <p className="max-w-[640px] pb-5 text-pretty text-sm leading-relaxed text-muted">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          </Reveal>
        </section>

        {/* Closing CTA */}
        <section className="border-b border-hairline px-5 py-16 sm:px-8 sm:py-24">
          <Reveal>
            <h2 className="max-w-[640px] text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
              Run the receipt on your own agents.
            </h2>
            <p className="mt-3 max-w-[560px] text-base leading-relaxed text-muted">
              Ninety seconds from install to evidence. Your transcripts never
              leave your machine.
            </p>
            <div className="mt-6 max-w-[380px]">
              <CopyCommand />
            </div>
            <p className="mt-4 text-sm text-muted">
              Running agents for a team?{" "}
              <a
                href="/?ref=teams#beta"
                className="text-ink underline-offset-4 hover:underline"
              >
                Become a founding design partner →
              </a>
            </p>
          </Reveal>
        </section>
      </main>

      <footer className="px-5 py-10 sm:px-8">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <p className="flex items-baseline gap-3">
            <a href="#top" className="wordmark wordmark-sm" aria-label="Tilden — top">
              Tilden
              <span className="wordmark-cursor" aria-hidden="true" />
            </a>
            <span className="text-[13px] text-faint">
              financial accountability for AI agents.
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-faint">
            <a
              href={REPO}
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
            <a href="/docs" className="transition-colors hover:text-ink">
              Docs
            </a>
            <a href="/docs/mcp" className="transition-colors hover:text-ink">
              MCP
            </a>
            <a href="/docs/roadmap" className="transition-colors hover:text-ink">
              Roadmap
            </a>
            <a href="#privacy" className="transition-colors hover:text-ink">
              Privacy
            </a>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] text-faint">
          <a
            href="/blog/claude-code-cost-usage-credits"
            className="transition-colors hover:text-ink"
          >
            Cost guide
          </a>
          <a
            href="/blog/ai-coding-context-health"
            className="transition-colors hover:text-ink"
          >
            Context health
          </a>
          <a href="/vs/ccusage" className="transition-colors hover:text-ink">
            vs ccusage
          </a>
          <a href="/vs/tokscale" className="transition-colors hover:text-ink">
            vs tokscale
          </a>
          <a
            href={`${REPO}/tree/main/apps/glance-macos`}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-ink"
          >
            Build Glance ↗
          </a>
          <a
            href={`${REPO}/issues/new/choose`}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-ink"
          >
            Report an issue ↗
          </a>
          <span className="ml-auto text-green">$ npx aibill</span>
        </div>
      </footer>
    </div>
  );
}
