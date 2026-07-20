import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";

const title = "aibill vs ccusage — Claude Code cost trackers compared";
const description =
  "An honest comparison of aibill and ccusage for tracking Claude Code usage and cost: both read your local session logs; aibill adds Codex logs, plan-vs-API math, a ranked cut list, and billing-API reconciliation.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/vs/ccusage" },
};

const rows: Array<[string, string, string]> = [
  ["Reads Claude Code session logs locally", "Yes", "Yes"],
  ["Codex session logs", "Yes", "Claude Code–focused"],
  ["Estimates usage at API-equivalent rates", "Yes", "Yes"],
  [
    "Reconciles against real provider bills (OpenAI/Anthropic admin key)",
    "Yes — estimates become verified",
    "Estimates from logs",
  ],
  [
    "Subscription-vs-API plan math",
    "Yes — projects your usage against plan tiers",
    "Usage and cost reporting",
  ],
  ["Ranked savings cut list with $/mo estimates", "Yes", "—"],
  ["Dead-context pricing (MCP tools loaded but never called)", "Yes", "—"],
  ["Local-first, no telemetry", "Yes", "Yes"],
  ["Open source", "MIT", "MIT"],
  ["Install", "npx aibill", "npx ccusage"],
];

export default function Page() {
  return (
    <PageShell ctaRef="seo-vs">
      <article className="relative z-10 mx-auto max-w-3xl px-6 pb-8 pt-14 sm:pt-20">
        <Reveal>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-faint">
            Comparison
          </p>
          <h1 className="mt-4 text-balance font-mono text-3xl font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-4xl">
            aibill vs ccusage
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            First, credit where it&apos;s due:{" "}
            <span className="text-ink">ccusage is excellent.</span> It&apos;s
            mature, fast, widely used (thousands of GitHub stars), and it
            popularized the idea that your Claude Code session logs can tell you
            what your usage would cost at API rates. If you want a focused
            Claude Code usage readout, it&apos;s a great choice.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted">
            aibill starts from the same insight — read the logs you already have
            — and asks the next question:{" "}
            <span className="text-ink">
              okay, that&apos;s the number. Now what?
            </span>{" "}
            It adds the plan-vs-API decision math, a ranked list of cuts with
            estimated savings, dead-context pricing, and the option to reconcile
            estimates against your actual provider bills.
          </p>
        </Reveal>

        <Reveal>
          <div className="glass mt-10 overflow-x-auto rounded-2xl">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-xs uppercase tracking-wider text-faint">
                  <th className="px-5 py-4 font-medium"> </th>
                  <th className="px-5 py-4 font-medium text-green">aibill</th>
                  <th className="px-5 py-4 font-medium">ccusage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([feature, a, b]) => (
                  <tr key={feature} className="border-b border-white/5 last:border-0">
                    <td className="px-5 py-3.5 text-muted">{feature}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-ink">{a}</td>
                    <td className="px-5 py-3.5 font-mono text-xs text-muted">{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-faint">
            Comparison reflects our understanding of ccusage&apos;s
            documentation as of July 2026 — check{" "}
            <a
              href="https://ccusage.com/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              ccusage.com
            </a>{" "}
            for the current feature set. &ldquo;—&rdquo; means not a stated
            focus, not necessarily absent.
          </p>
        </Reveal>

        <Reveal>
          <h2 className="mt-12 font-mono text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Which should you use?
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            If you want a clean, focused view of Claude Code usage, use ccusage
            — it does that job well. Use aibill when you want the decision layer
            on top: whether your subscription still beats pay-per-token now that
            plans are metered, which concrete changes would lower your bill and
            by roughly how much, and — when you connect a billing key — numbers
            verified against real invoices instead of estimates. Both are free
            and local-first; running both costs you nothing.
          </p>
        </Reveal>
      </article>
    </PageShell>
  );
}
