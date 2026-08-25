import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { PageShell } from "@/components/PageShell";
import { Reveal } from "@/components/Reveal";
import { SITE_URL } from "@/lib/site";

const title = "AI coding context health: hooks, MCP tools, and fresh sessions";
const description =
  "Measure discoverable, invoked, MCP-configured, and hook-injected AI coding context locally. Learn when to continue, review hooks, inspect tools, or start a fresh session.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/blog/ai-coding-context-health" },
  keywords: [
    "AI coding context health",
    "Claude Code hooks",
    "Codex MCP tools",
    "AI agent context window",
    "dead context",
    "start fresh coding agent session",
  ],
};

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 text-xl font-semibold tracking-[-0.025em] text-ink sm:text-2xl">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-base leading-relaxed text-muted">{children}</p>;
}

export default function Page() {
  return (
    <PageShell ctaRef="context-health-blog">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: title,
          description,
          datePublished: "2026-07-29",
          dateModified: "2026-08-24",
          mainEntityOfPage: `${SITE_URL}/blog/ai-coding-context-health`,
          author: { "@type": "Organization", name: "Futura Studio" },
          publisher: { "@type": "Organization", name: "Futura Studio" },
        }}
      />
      <article className="relative z-10 mx-auto max-w-3xl px-6 pb-8 pt-14 sm:pt-20">
        <Reveal>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-faint">
            July 2026 · Product method
          </p>
          <h1 className="mt-4 text-balance text-3xl font-semibold leading-[1.08] tracking-[-0.04em] text-ink sm:text-5xl">
            AI coding context health: hooks, MCP tools, and fresh sessions
          </h1>
          <P>
            Your coding agent can carry more context than the visible chat
            suggests. Skill descriptions may be discoverable, an MCP server may
            be configured or explicitly requested as always-loaded, lifecycle
            hooks can inject instructions, and a long session can keep
            accumulating history. Those are different states, so one generic
            &ldquo;context used&rdquo; number is not enough.
          </P>
        </Reveal>

        <Reveal>
          <H2>The missing distinction: available is not active</H2>
          <P>
            A skill listed to the model is not the same as a skill explicitly
            invoked. An MCP server in configuration is not proof that one of
            its tools ran. A lifecycle hook is different again: events such as
            <span className="font-mono text-ink"> SessionStart</span>,{" "}
            <span className="font-mono text-ink">UserPromptSubmit</span>, or{" "}
            <span className="font-mono text-ink">SubagentStart</span> can add
            runtime context without appearing as a normal tool call.
          </P>
          <P>
            aibill separates discoverable, explicitly invoked, MCP-configured,
            explicit always-load requests, hook-injected, and
            invocation-unobservable states. MCP configuration proves
            availability or intent—not the schema payload loaded at runtime.
            It reads installed hook configuration as metadata, but never
            executes the command and never guesses the emitted token payload.
          </P>
        </Reveal>

        <Reveal>
          <H2>One decision, backed by your own history</H2>
          <P>
            Context Health prioritizes directly observed compaction evidence.
            Where the transcript exposes it, it otherwise compares latest-turn
            input context with comparable prior sessions from the same coding
            agent and project—not cumulative lifetime totals. The action may be
            to preserve a checkpoint and start fresh, inspect configured hooks
            or inventory with no matching invocation, continue, or collect more
            history.
          </P>
          <P>
            That is a workflow signal, not a universal efficiency claim. Token
            volume does not prove code quality, latency, or money saved, and a
            configured item with no matching invocation may still be valuable
            tomorrow.
          </P>
        </Reveal>

        <Reveal>
          <H2>Run it in the interface you already use</H2>
          <div className="mt-5 space-y-3">
            {[
              ["Terminal", "npx aibill context"],
              ["Structured terminal", "npx aibill context --json"],
              ["AI client", "$aibill-check through the optional MCP plugin"],
              ["macOS", "source-built aibill Glance preview, hidden until menu-bar hover"],
            ].map(([label, command]) => (
              <div className="rounded-sm border border-hairline bg-panel px-5 py-4" key={label}>
                <span className="text-ink">{label}</span>
                <span className="ml-3 font-mono text-sm text-muted">{command}</span>
              </div>
            ))}
          </div>
          <P>
            The terminal JSON, MCP tool, and Glance card consume the same
            versioned contract. That matters more than visual consistency: a
            session should not be &ldquo;healthy&rdquo; in one interface and
            &ldquo;start fresh&rdquo; in another.
          </P>
        </Reveal>

        <Reveal>
          <H2>What we borrowed—and what we did not</H2>
          <P>
            Developer tools such as{" "}
            <a
              href="https://github.com/DietrichGebert/ponytail"
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-white/25 underline-offset-4 hover:decoration-white/60"
            >
              Ponytail
            </a>{" "}
            show the appeal of a memorable single job, operational skills,
            portable adapters, and a public benchmark method. aibill adopted
            those product-engineering ideas. It did not copy always-on prompt
            injection, reuse another project&apos;s benchmark percentages, or
            treat lines of code as a universal cost proxy.
          </P>
          <P>
            Our public fixture benchmark tests classification, decision
            precedence, and safety invariants. It explicitly does not claim
            universal token savings, faster delivery, or better code. Those
            claims would require a controlled baseline and raw results.
          </P>
        </Reveal>

        <Reveal>
          <H2>Privacy depends on the surface</H2>
          <P>
            Terminal and Glance analysis stays on the machine: transcripts,
            prompts, file names, and dollar amounts are never uploaded. The
            CLI counts which commands run — anonymous, never your data or
            content — after a printed first-run notice, and{" "}
            <span className="font-mono text-ink">aibill telemetry off</span>{" "}
            (or DO_NOT_TRACK) ends it. If you explicitly invoke an MCP-backed
            skill, the selected structured result is returned to that AI
            client and is governed by the client&apos;s data policy. That
            boundary is more useful than a vague promise: you can choose the
            terminal when you want no AI-client handoff and the plugin when
            conversational explanation is worth it.
          </P>
          <p className="mt-4 text-sm leading-relaxed text-faint">
            Correction (August 24, 2026): an earlier version of this post said
            aibill sends no telemetry. Since v0.9.2 the CLI sends disclosed,
            anonymous command counts as described above; the MCP server still
            sends none.
          </p>
        </Reveal>
      </article>
    </PageShell>
  );
}
