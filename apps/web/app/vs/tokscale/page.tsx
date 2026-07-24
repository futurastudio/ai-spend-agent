import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";

const title = "aibill vs tokscale — AI token cost trackers compared";
const description =
  "An honest comparison of aibill and tokscale for tracking AI coding-agent token usage and cost: both estimate from local logs; aibill adds plan-vs-API math, a ranked cut list, dead-context pricing, and billing-API reconciliation.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/vs/tokscale" },
};

const rows: Array<[string, string, string]> = [
  ["Reads local agent session logs", "Claude Code + Codex", "Multi-tool"],
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
  ["Provider billing connectors (OpenAI, Anthropic; Cursor/Copilot beta)", "Yes", "—"],
  ["Local-first, no telemetry", "Yes", "Yes"],
  ["Open source", "MIT", "Yes"],
  ["Install", "npx aibill", "npx tokscale"],
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
            aibill vs tokscale
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            tokscale is a solid open-source token tracker: it reads the usage
            your AI coding tools record locally and turns it into a cost
            estimate at API rates, across multiple tools. If your question is
            &ldquo;how many tokens am I burning and what would they cost?&rdquo;,
            it answers it.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted">
            aibill treats that number as the starting point, not the answer. It
            reads your Claude Code and Codex logs the same way — locally, no
            account — then adds the layers you need to act:{" "}
            <span className="text-ink">
              plan-vs-API math, a ranked cut list with estimated savings,
              dead-context pricing, and reconciliation against your real
              provider bills
            </span>{" "}
            when you connect an admin key.
          </p>
        </Reveal>

        <Reveal>
          <div className="glass mt-10 overflow-x-auto rounded-2xl">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 font-mono text-xs uppercase tracking-wider text-faint">
                  <th className="px-5 py-4 font-medium"> </th>
                  <th className="px-5 py-4 font-medium text-green">aibill</th>
                  <th className="px-5 py-4 font-medium">tokscale</th>
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
            Comparison reflects our understanding of tokscale&apos;s
            documentation as of July 2026 — check{" "}
            <a
              href="https://github.com/junhoyeo/tokscale"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-muted"
            >
              the tokscale repo
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
            Use tokscale if you want a lightweight multi-tool token counter. Use
            aibill when the question behind the question is money: which plan to
            be on now that everything is metered, what to cut and what it saves,
            and — with a billing key connected — figures verified against actual
            invoices rather than estimated from logs. Both are free and run
            entirely on your machine; trying both takes two npx commands.
          </p>
        </Reveal>
      </article>
    </PageShell>
  );
}
