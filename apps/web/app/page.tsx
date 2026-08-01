import { CopyCommand } from "@/components/CopyCommand";
import { ProductTour } from "@/components/ProductTour";
import { WaitlistForm } from "@/components/WaitlistForm";

const integrations = [
  "Claude Code",
  "Codex",
  "OpenAI billing",
  "Anthropic billing",
];

const accountabilityPath = [
  ["Agent work", "Observed"],
  ["Cost", "Source-labeled"],
  ["Owner", "Where exposed"],
  ["Accepted outcome", "Workspace next"],
  ["Controlled action", "Approval-gated next"],
];

const accountabilityQuestions = [
  {
    status: "Available now",
    title: "What work is driving our AI bill?",
    body: "Attribute observed activity and cost evidence by project, model, agent, workspace, user, or client—only where the source exposes it.",
  },
  {
    status: "Partial",
    title: "Who owns it—and did it produce an accepted outcome?",
    body: "Observed ownership is available where supported. Accepted-task and pull-request receipts are the next open contract.",
  },
  {
    status: "Partial",
    title: "Which subscriptions and provider charges never reach finance?",
    body: "Local plan context and optional provider reports are available now. A centralized seat and invoice ledger is Workspace next.",
  },
  {
    status: "Partial · controls next",
    title: "What changed, what needs approval, and did the action work?",
    body: "The beta surfaces anomalies and one bounded recommendation. Shared approvals and verified results come with Workspace.",
  },
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
      "The default CLI and Glance run locally with no account or telemetry. Provider credentials are used only when you explicitly connect an official billing API, and MCP results go only to the AI client you invoke under that client’s data policy.",
  },
  {
    question: "What can I use today?",
    answer:
      "The local CLI and explicit MCP integration are in public beta. Glance can be built from source for testing; a signed Mac download and the shared Workspace are not launched yet.",
  },
  {
    question: "Can finance use aibill to prove ROI?",
    answer:
      "Not from spend evidence alone. The beta establishes cost, activity, attribution, and coverage. Defensible ROI requires reconciled cost, an accepted outcome, and independently evidenced business value; those outcome and company-accountability layers are next.",
  },
];

export default function Home() {
  return (
    <main className="relative overflow-x-clip">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[960px]"
        aria-hidden="true"
      >
        <div className="grid-fade absolute inset-0" />
      </div>

      <header className="sticky top-4 z-40 mx-auto max-w-content px-4 sm:px-6">
        <div className="glass-heavy flex items-center justify-between rounded-full px-4 py-3">
          <a href="#top" className="flex min-h-11 items-center gap-2.5 px-1">
            <span
              aria-hidden="true"
              className="glass-well flex h-7 w-7 items-center justify-center rounded-md font-mono text-sm text-green"
            >
              $
            </span>
            <span className="font-mono text-sm font-semibold tracking-tight text-ink">
              aibill
            </span>
          </a>
          <nav className="flex items-center gap-1 sm:gap-2" aria-label="Primary navigation">
            <a
              href="#product"
              className="hidden min-h-11 items-center rounded-xl px-3.5 text-sm font-medium text-muted transition-colors hover:text-ink md:inline-flex"
            >
              Product
            </a>
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="hidden min-h-11 items-center rounded-xl px-3.5 text-sm font-medium text-muted transition-colors hover:text-ink sm:inline-flex"
            >
              GitHub
            </a>
            <a
              href="#beta"
              className="glass glass-interactive inline-flex min-h-11 items-center whitespace-nowrap rounded-xl px-3.5 text-xs font-medium text-ink sm:text-sm"
            >
              Join the team beta
            </a>
          </nav>
        </div>
      </header>

      <section
        id="top"
        className="relative z-10 mx-auto max-w-content animate-fade-up scroll-mt-24 px-6 pb-12 pt-16 text-left sm:pt-24"
      >
        <div className="grid w-full gap-12 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-end">
          <div className="min-w-0">
            <a
              href="https://github.com/futurastudio/ai-spend-agent"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-2 border-l border-green/60 pl-3 font-mono text-xs text-muted transition-colors hover:text-ink"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden="true" />
              Open source · local first ↗
            </a>

            <h1 className="mt-7 max-w-5xl min-w-0 text-balance text-[2.85rem] font-semibold leading-[0.96] tracking-[-0.065em] text-ink [overflow-wrap:anywhere] sm:text-[4.25rem] lg:text-[4.65rem]">
              Know what your AI agents cost.
              <br className="hidden sm:block" />{" "}
              Know what to do next.
            </h1>

            <p className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-muted sm:text-xl">
              aibill connects coding-agent work to cost evidence, attribution, and
              one next action. Today&apos;s beta runs privately on your machine; the
              shared company accountability layer comes next.
            </p>

            <div className="mt-9 flex w-full flex-col items-start gap-3">
              <CopyCommand />
              <div className="flex flex-wrap items-center justify-start gap-x-4 gap-y-2 font-mono text-xs">
                <span className="text-faint">Node 22+ · no signup</span>
                <a
                  href="#beta"
                  className="text-green transition-colors hover:text-green-bright"
                >
                  Need a company view? Join the beta →
                </a>
              </div>
            </div>
          </div>

          <aside
            aria-label="aibill financial accountability chain"
            className="hidden border-y border-white/[0.09] py-4 lg:block"
          >
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-faint">
              Accountability chain
            </p>
            <ol className="mt-3">
              {accountabilityPath.map(([label, state], index) => (
                <li
                  key={label}
                  className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 border-t border-white/[0.07] py-3 first:border-t-0"
                >
                  <span className="font-mono text-[0.65rem] text-green">0{index + 1}</span>
                  <span className="text-sm font-medium text-ink">{label}</span>
                  <span className="col-start-2 mt-0.5 font-mono text-[0.65rem] text-faint">
                    {state}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-2 font-mono text-[0.65rem] text-faint">
              Evidence first · gaps stay explicit
            </p>
          </aside>
        </div>

        <div className="mt-12 w-full border-y border-white/[0.07] py-5">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-faint">
            Reads the tools you already use
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-start gap-x-8 gap-y-3">
            {integrations.map((integration) => (
              <span key={integration} className="text-sm font-medium text-muted">
                {integration}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-7 grid w-full gap-y-5 text-left sm:grid-cols-4 sm:divide-x sm:divide-white/[0.07]">
          {[
            ["Local by default", "Raw transcripts stay on-device."],
            ["Source linked", "Every number names its origin."],
            ["Honest gaps", "Missing data stays missing."],
            ["One contract", "CLI, Glance, and MCP agree."],
          ].map(([title, body]) => (
            <div key={title} className="px-0 sm:px-5">
              <p className="text-sm font-semibold text-ink">{title}</p>
              <p className="mt-1 text-sm text-faint">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        id="product"
        className="relative z-10 mx-auto max-w-content scroll-mt-24 px-6 py-20"
      >
        <div className="grid gap-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-end">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.045em] text-ink sm:text-5xl">
            One bill. Three ways to use it.
          </h2>
          <p className="max-w-xl text-pretty text-base leading-relaxed text-muted md:justify-self-end">
            Each surface keeps the same evidence rules: source, freshness,
            billing class, and missing data stay explicit.
          </p>
        </div>

        <div className="mt-10">
          <ProductTour />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-start gap-x-6 gap-y-3 font-mono text-xs">
          <a
            href="https://github.com/futurastudio/ai-spend-agent"
            target="_blank"
            rel="noreferrer"
            className="text-muted transition-colors hover:text-ink"
          >
            View the source ↗
          </a>
          <a
            href="https://github.com/futurastudio/ai-spend-agent/blob/main/docs/MCP.md"
            target="_blank"
            rel="noreferrer"
            className="text-muted transition-colors hover:text-ink"
          >
            Configure MCP ↗
          </a>
          <a
            href="https://github.com/futurastudio/ai-spend-agent/tree/main/apps/glance-macos"
            target="_blank"
            rel="noreferrer"
            className="text-muted transition-colors hover:text-ink"
          >
            Build Glance ↗
          </a>
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-content px-6 py-20">
        <div className="max-w-3xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-green">
            The accountability gap
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.045em] text-ink sm:text-5xl">
            Financial accountability starts with four questions.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-muted">
            Today&apos;s beta answers only what local and provider evidence can
            support. Company-wide reconciliation, accepted outcomes, approvals,
            and ROI stay explicitly next.
          </p>
        </div>

        <div className="mt-10 grid overflow-hidden rounded-3xl border border-white/[0.08] bg-surface/80 sm:grid-cols-2">
          {accountabilityQuestions.map((step, index) => (
            <div
              key={step.title}
              className="relative border-b border-white/[0.07] p-6 last:border-b-0 sm:p-8 sm:[&:nth-child(even)]:border-l sm:[&:nth-child(3)]:border-b-0 sm:[&:nth-child(4)]:border-b-0"
            >
              <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-green">
                {step.status}
              </span>
              <div className="mt-7 flex items-start justify-between gap-5">
                <h3 className="max-w-lg text-balance text-xl font-semibold leading-tight tracking-[-0.03em] text-ink sm:text-2xl">
                  {step.title}
                </h3>
                <span className="font-mono text-xs text-faint">0{index + 1}</span>
              </div>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-muted">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section id="beta" className="relative z-10 mx-auto max-w-content scroll-mt-24 px-6 py-20">
        <div className="relative mx-auto grid max-w-5xl overflow-hidden rounded-[2rem] border border-white/[0.08] bg-elevated/80 px-6 py-10 text-left shadow-2xl sm:px-10 sm:py-12 md:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)] md:items-center md:gap-12">
          <div>
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-green">
              Design partners
            </span>
            <h2 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-[-0.045em] text-ink sm:text-5xl">
              Build the financial accountability system with us.
            </h2>
            <p className="mt-4 max-w-xl text-pretty text-base leading-relaxed text-muted">
              The planned Workspace will connect agent work to costs, owners,
              accepted outcomes, budgets, approvals, and verified results—so
              engineering and finance can act from the same evidence.
            </p>
          </div>
          <div className="mt-8 max-w-xl md:mt-0">
            <WaitlistForm />
            <p className="mt-5 text-xs leading-relaxed text-faint">
              Workspace is not launched. Local mode stays free and private.
            </p>
          </div>
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-24 pt-8">
        <h2 className="text-left text-xs font-semibold uppercase tracking-[0.2em] text-faint">
          The short answers
        </h2>
        <div className="mt-7 divide-y divide-white/[0.07] border-y border-white/[0.07]">
          {faqs.map((faq) => (
            <details key={faq.question} className="group">
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-6 py-4 text-left text-base font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green/40 [&::-webkit-details-marker]:hidden">
                {faq.question}
                <span
                  aria-hidden="true"
                  className="text-xl font-light text-faint transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-2xl pb-5 text-pretty text-sm leading-relaxed text-muted">
                {faq.answer}
              </p>
            </details>
          ))}
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/[0.07]">
        <div className="mx-auto flex max-w-content flex-col items-center justify-between gap-4 px-6 py-8 font-mono text-xs text-faint sm:flex-row">
          <span>aibill — financial intelligence for the AI-agent economy.</span>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
            <a
              href="/blog/ai-coding-context-health"
              className="transition-colors hover:text-ink"
            >
              Learn
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
              href="https://www.npmjs.com/package/aibill"
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
