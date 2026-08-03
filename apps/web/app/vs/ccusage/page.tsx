import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";

const title = "aibill vs ccusage (2026) — AI usage tools compared";
const description =
  "A current comparison of aibill and ccusage for Claude Code and Codex usage: ccusage excels at detailed local reporting; aibill adds provider cost reports, Context Health, and an action-oriented evidence layer.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/vs/ccusage" },
};

const rows: Array<[string, string, string]> = [
  ["Local agent coverage", "Claude Code + Codex", "15 local sources; Codex support is experimental"],
  ["Claude Code session logs", "Yes", "Yes"],
  ["Codex session logs", "Yes", "Yes — documented as beta"],
  ["Estimates usage at API-equivalent rates", "Yes", "Yes"],
  [
    "Primary focus",
    "Evidence-constrained spend decisions",
    "Detailed local usage and cost reporting",
  ],
  [
    "Adds official provider cost reports (OpenAI/Anthropic admin key)",
    "Anthropic live-verified; OpenAI auth/endpoint exercised, non-empty reconciliation pending",
    "Not a stated focus",
  ],
  [
    "Subscription-vs-API plan math",
    "API-rate comparison beside detected/declared plan; no entitlement inference",
    "Block, quota, and usage reporting",
  ],
  ["Evidence-ranked action candidates", "Observed exposure locally; modeled $ only with a source-supported counterfactual", "—"],
  ["Context inventory and invocation coverage", "Yes — loading/overhead stays unmeasured where the host does not expose it", "—"],
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
          <h1 className="mt-4 text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-ink sm:text-5xl">
            aibill vs ccusage
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            First, credit where it&apos;s due:{" "}
            <span className="text-ink">ccusage is excellent.</span> It&apos;s
            mature, fast, widely used, and it popularized the idea that local
            coding-agent logs can tell you what usage would cost at API rates.
            It now documents both Claude Code and Codex support. If you want a
            detailed local usage readout, it&apos;s a strong choice.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted">
            aibill starts from the same insight — read the logs you already have
            — and asks the next question:{" "}
            <span className="text-ink">
              okay, that&apos;s the number. Now what?
            </span>{" "}
            It adds API-rate comparison beside plan context, evidence-ranked
            candidates with approval and matched verification, hook-aware Context Health, and optional
            official provider cost reports kept separate from local estimates.
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
            Reviewed against ccusage&apos;s documentation on July 28, 2026 —
            check{" "}
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
            Use ccusage when detailed Claude Code or Codex usage reporting is
            the job. Use aibill when you want the decision layer on top: plan
            economics, evidence-backed actions, and — when you connect an
            admin billing key — official provider cost reports beside local
            estimates. Both are free
            and local-first; running both is a sensible comparison.
          </p>
        </Reveal>
      </article>
    </PageShell>
  );
}
