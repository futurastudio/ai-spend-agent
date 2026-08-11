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
          dateModified: "2026-08-08",
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
            <a
              href="https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
            >
              GitHub moved Copilot usage to AI Credits on June 1, 2026
            </a>
            . The useful takeaway is narrower than &ldquo;every plan became
            pay-as-you-go&rdquo;: AI coding cost now mixes subscription allowances,
            shared limits, model-specific credits, and optional metered overages.
          </P>
        </Reveal>

        <Reveal>
          <H2>Why the total is hard to explain</H2>
          <P>
            Ask a heavy Claude Code user what their AI setup costs per month and
            you&apos;ll usually get the subscription price. That may be the cash
            charge, but it does not explain capacity consumed or whether separate
            API/provider charges exist. Those facts live in different places: a
            subscription meter here, a provider report there, a second tool with
            its own credit pool, and local agent-session evidence.
          </P>
          <P>
            The raw material for a useful comparison already exists — Claude Code
            and Codex write detailed session logs to your machine as you work.
            Pricing supported token usage at published API-equivalent rates
            provides one input to a plan decision. It does not prove incremental
            spend, remaining entitlement, or what a subscription covers; combine
            it with detected or declared plan context and provider-reported limits
            when those limits are available.
          </P>
        </Reveal>

        <Reveal>
          <H2>Check your local evidence</H2>
          <P>
            <span className="font-mono text-green">npx aibill</span> reads the
            session logs already on your machine—locally, with no signup,
            provider connection, or upload—and shows:
          </P>
          <ul className="mt-4 space-y-3 text-base leading-relaxed text-muted">
            <li className="rounded-sm border border-hairline bg-panel px-5 py-4">
              <span className="text-ink">Observed API-equivalent value</span> —
              supported local usage priced at published rates, broken down by
              project and model where the transcript exposes them.
            </li>
            <li className="rounded-sm border border-hairline bg-panel px-5 py-4">
              <span className="text-ink">Plan context and comparison</span> —
              API-rate value beside a detected or user-declared plan label. It
              is comparison math, not proof of plan coverage or the cheapest option.
            </li>
            <li className="rounded-sm border border-hairline bg-panel px-5 py-4">
              <span className="text-ink">Evidence-ranked action candidates</span>
              {" "}— local transcript aggregates are treated as observed exposure,
              not invented monthly savings. Apply asks the coding agent to inspect
              the exact source, propose one reversible change, wait for approval,
              and compare matched future sessions. A dollar result requires a
              source-supported counterfactual and, for a cash claim, provider cost.
            </li>
            <li className="rounded-sm border border-hairline bg-panel px-5 py-4">
              <span className="text-ink">Context inventory and invocation evidence</span>
              {" "}— items that are discoverable, invoked, MCP-configured,
              explicitly requested as always-loaded, hook-injected, unmeasured,
              or invocation-unobservable. Configuration alone does not prove a
              schema payload was loaded; aibill reports no matching invocation
              only where the transcript supports it.
            </li>
          </ul>
        </Reveal>

        <Reveal>
          <H2>Local estimate vs provider report</H2>
          <P>
            Numbers derived from local logs are{" "}
            <span className="text-ink">estimates</span> at published API rates —
            useful for comparisons and cost investigations, but not a bill. If
            you want official provider-reported cost, connect a user-referenced
            org admin/owner credential with the required read permissions. aibill keeps that report
            beside—not merged into—the local estimate. A final invoice can still
            include credits, discounts, tax, or adjustments. Anything the source
            cannot establish remains labeled accordingly.
          </P>
        </Reveal>

        <Reveal>
          <H2>Local-first, because it&apos;s your evidence</H2>
          <P>
            Default transcript analysis runs on your machine with no signup,
            telemetry, or upload. A deliberate provider connection sends the
            referenced credential only to that provider&apos;s official API; an
            explicit MCP result goes only to the AI client you invoked. The code
            is MIT-licensed and open source. aibill never sits in the inference path and never stores, prints, or proxies provider credentials. The
            meters are multiplying; know which number you are looking at before
            acting on it.
          </P>
        </Reveal>
      </article>
    </PageShell>
  );
}
