import type { Metadata } from "next";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";
import { JsonLd } from "@/components/JsonLd";
import { SITE_URL } from "@/lib/site";

const title = "Claude Code cost in 2026: plans, limits, and usage credits";
const description =
  "Claude Code pricing now mixes plan limits, model-specific usage credits, and optional API overages. Learn what changed by plan and check your own API-equivalent usage locally with npx aibill.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/blog/claude-code-cost-usage-credits" },
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 text-xl font-semibold tracking-[-0.025em] text-ink sm:text-2xl">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-base leading-relaxed text-muted">{children}</p>
  );
}

export default function Page() {
  return (
    <PageShell ctaRef="seo-blog">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: title,
          description,
          datePublished: "2026-07-20",
          dateModified: "2026-07-28",
          mainEntityOfPage: `${SITE_URL}/blog/claude-code-cost-usage-credits`,
          author: { "@type": "Organization", name: "Futura Studio" },
          publisher: { "@type": "Organization", name: "Futura Studio" },
        }}
      />
      <article className="relative z-10 mx-auto max-w-3xl px-6 pb-8 pt-14 sm:pt-20">
        <Reveal>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-faint">
            July 2026 · Guide
          </p>
          <h1 className="mt-4 text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-ink sm:text-5xl">
            Claude Code cost in 2026: plans, limits, and usage credits
          </h1>
          <P>
            On <span className="text-ink">July 20, 2026</span>, Anthropic changed
            how Fable 5 access works across paid plans. It remains included
            within limits for Max and premium Team or Enterprise seats, while
            Pro and standard seats use pay-as-you-go usage credits for that
            model. Claude Code itself remains included with Pro and Max plan
            limits, with optional API-credit usage after those limits.{" "}
            <a
              href="https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
            >
              Check Anthropic&apos;s current plan guidance
            </a>{" "}
            before making a purchase decision.
          </P>
          <P>
            GitHub Copilot also moved organization billing to AI Credits in
            June. The useful takeaway is narrower than &ldquo;every plan became
            pay-as-you-go&rdquo;: AI coding cost now mixes subscription
            allowances, shared limits, model-specific credits, and optional
            metered overages.
          </P>
        </Reveal>

        <Reveal>
          <H2>Why nobody knows their real number</H2>
          <P>
            Ask a heavy Claude Code user what their AI setup costs per month and
            you&apos;ll usually get the subscription price. That&apos;s the
            floor, not the number. Real usage is spread across places that
            don&apos;t add themselves up: a subscription meter here, an API bill
            there, a second tool with its own credit pool, and agent sessions
            whose consumption has no dashboard at all.
          </P>
          <P>
            The raw material for the real answer already exists — Claude Code
            and Codex write detailed session logs to your machine as you work.
            Priced at published API-equivalent rates, those logs tell you what
            your usage would cost pay-per-token, which is exactly the comparison
            you need when a plan goes metered: is the subscription still worth
            it, or are you paying for headroom you don&apos;t use — or burning
            past what the plan covers?
          </P>
        </Reveal>

        <Reveal>
          <H2>Check yours in 90 seconds</H2>
          <P>
            <span className="font-mono text-green">npx aibill</span> reads the
            session logs already on your machine — locally, no account, no keys,
            no upload — and shows:
          </P>
          <ul className="mt-4 space-y-3 text-base leading-relaxed text-muted">
            <li className="glass rounded-xl px-5 py-4">
              <span className="text-ink">Your headline number</span> — total
              usage estimated at API-equivalent rates, broken down by project
              and model.
            </li>
            <li className="glass rounded-xl px-5 py-4">
              <span className="text-ink">The plan-vs-API math</span> — your
              projected usage against subscription tiers, so you can see which
              way of paying is actually cheapest for how you work.
            </li>
            <li className="glass rounded-xl px-5 py-4">
              <span className="text-ink">A ranked cut list</span> — concrete
              changes (cheaper model for a given task, batching, caching
              repeats) with estimated monthly savings for each.
            </li>
            <li className="glass rounded-xl px-5 py-4">
              <span className="text-ink">Dead context</span> — MCP tools your
              agent loads but never calls. aibill names those entries and
              estimates overhead where the logs contain enough evidence;
              config-only MCP entries are clearly marked as unmeasured.
            </li>
          </ul>
        </Reveal>

        <Reveal>
          <H2>Estimated vs verified — an honest distinction</H2>
          <P>
            Numbers derived from local logs are{" "}
            <span className="text-ink">estimates</span> at published API rates —
            useful for plan decisions and cut lists, but not a bill. If you want
            billing truth, connect an org admin/owner key (OpenAI or Anthropic,
            a few minutes, read-only) and aibill reconciles the estimates
            against your actual invoices. Every figure in the report is labeled
            as one or the other. Anything it can&apos;t verify, it says so.
          </P>
        </Reveal>

        <Reveal>
          <H2>Local-first, because it&apos;s your bill</H2>
          <P>
            Everything runs on your machine: no signup, no telemetry, nothing
            uploaded. The code is MIT-licensed and open source — read every line
            before you run it. The meters are multiplying; the least you can do
            is know your own number before they do.
          </P>
        </Reveal>
      </article>
    </PageShell>
  );
}
