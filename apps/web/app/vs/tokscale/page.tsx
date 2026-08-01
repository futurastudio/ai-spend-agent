import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";

const title = "aibill vs tokscale (2026) — AI usage tools compared";
const description =
  "A current comparison of aibill and tokscale: tokscale offers broad agent coverage, a TUI, quota views, and social graphs; aibill focuses on financial semantics, provenance, Context Health, and recommended actions.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/vs/tokscale" },
};

const rows: Array<[string, string, string]> = [
  ["Local agent coverage", "Claude Code + Codex", "20+ coding-agent clients"],
  ["Estimates usage at API-equivalent rates", "Yes", "Yes"],
  ["Interactive TUI and contribution graphs", "Terminal receipt + SVG card", "Yes"],
  [
    "Live subscription quota views",
    "Detected plan + projected plan math",
    "Yes — multiple providers",
  ],
  [
    "Adds official provider cost reports (OpenAI/Anthropic admin key)",
    "Yes — kept separate from local estimates",
    "Quota display; not independently reconciled",
  ],
  ["Ranked cost opportunities with modeled $/mo impact", "Yes", "—"],
  ["Dead-context detection and measured estimates", "Yes", "—"],
  ["Optional public leaderboard", "No", "Yes — opt-in submission"],
  ["Local-first by default", "Yes", "Yes"],
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
          <h1 className="mt-4 text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-ink sm:text-5xl">
            aibill vs tokscale
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            tokscale is a broad open-source usage product. It supports more
            than twenty coding-agent clients, an interactive TUI, subscription
            quota views, contribution graphs, and an optional public
            leaderboard. If breadth and visualization are the priority, it has
            the advantage.
          </p>
          <p className="mt-4 text-base leading-relaxed text-muted">
            aibill treats that number as the starting point, not the answer. It
            reads your Claude Code and Codex logs the same way — locally, no
            account — then adds the layers you need to act:{" "}
            <span className="text-ink">
              plan-vs-API math, ranked cost opportunities with a verification
              step, hook-aware Context Health, and official provider cost
              reports kept separate from local estimates
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
            Reviewed against tokscale&apos;s documentation on July 28, 2026 —
            check{" "}
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
            Use tokscale when you want broad tool coverage, live quota views,
            a TUI, or social usage graphs. Use aibill when the question behind
            the number is what to do next: which plan fits, what to investigate,
            and how local estimates compare with provider cost reports. Both are free;
            trying both takes two npx commands.
          </p>
        </Reveal>
      </article>
    </PageShell>
  );
}
