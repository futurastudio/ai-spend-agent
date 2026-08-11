import type { Metadata } from "next";
import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";

export const metadata: Metadata = {
  title: "Thanks — Tilden",
  description:
    "Request received. We'll follow up about the design-partner beta.",
  robots: { index: false, follow: true },
};

export default async function Thanks({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;
  const isGlanceStudy = ref?.includes("glance-study") ?? false;

  return (
    <div className="frame flex min-h-screen flex-col">
      <header className="border-b border-hairline">
        <div className="flex h-14 items-center px-5 sm:px-8">
          <Link href="/" className="wordmark" aria-label="Tilden — home">
            Tilden
            <span className="wordmark-cursor" aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col justify-center px-5 py-24 sm:px-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-green">
          Request received
        </p>
        <h1 className="mt-3 max-w-[640px] text-2xl font-medium tracking-[-0.02em] text-ink sm:text-[32px]">
          {isGlanceStudy ? "You're in the Glance study queue." : "You're on the design-partner list."}
        </h1>
        <p className="mt-4 max-w-[560px] text-base leading-relaxed text-muted">
          {isGlanceStudy
            ? "We'll email you with study timing and the exact preview build and setup. Expect one short session and a day-seven check-in."
            : "We'll follow up about fit and onboarding for the two-week design-partner beta. Includes onboarding, two weeks of real use, and one short follow-up."}
        </p>
        <p className="mt-3 max-w-[560px] text-sm leading-relaxed text-faint">
          Workspace is not launched. Local mode stays free and private.
        </p>
        <p className="mt-8 max-w-[560px] text-[15px] leading-relaxed text-muted">
          While you wait — the local receipt works today:
        </p>
        <div className="mt-4 max-w-[380px]">
          <CopyCommand />
        </div>
        <p className="mt-8">
          <Link
            href="/"
            className="text-sm text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            ← Back to the site
          </Link>
        </p>
      </main>
    </div>
  );
}
