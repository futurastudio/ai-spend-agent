import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "../lib/site";
import { JsonLd } from "@/components/JsonLd";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

const title = "Tilden — financial accountability for AI agents";
const description =
  "Know what your AI agents cost and prove what they're worth. Tilden reads your coding agents' own activity and your real bills — local-first, verified, in 90 seconds. Built on the open-source aibill engine (npx aibill).";

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  keywords: [
    "Tilden",
    "AI cost tracker",
    "AI bill",
    "Claude Code cost",
    "Claude Code usage limit",
    "Codex usage limit",
    "AI coding runway",
    "AI coding context health",
    "Claude usage credits",
    "Copilot AI credits",
    "AI usage tracker",
    "token cost tracker",
    "ccusage alternative",
    "AI spend",
    "AI financial accountability",
    "AI agent workforce",
  ],
  openGraph: {
    title,
    description,
    type: "website",
    url: "/",
    images: [{ url: "/og.png", width: 1280, height: 640 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-screen bg-ground font-sans antialiased">
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "aibill",
            alternateName: ["Tilden", "AI Spend Agent"],
            description,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "macOS, Linux, Windows",
            url: SITE_URL,
            downloadUrl: "https://www.npmjs.com/package/aibill",
            codeRepository: "https://github.com/futurastudio/ai-spend-agent",
            license: "https://opensource.org/license/mit",
          }}
        />
        {/* Scroll-reveal is progressive enhancement — without JS, content
            must simply be visible. */}
        <noscript>
          <style>{`.reveal { opacity: 1 !important; transform: none !important; }`}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
