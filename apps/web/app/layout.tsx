import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "../lib/site";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

const title = "aibill — your AI bill in one view, in 90 seconds";
const description =
  "npx aibill: a free, local-first CLI that unifies your Claude Code and Codex session logs (estimated at API rates) — plus your real OpenAI and Anthropic bills when you connect an admin key — into one terminal view, with a ranked list of cuts. Also on npm as ai-spend-agent. Your data never leaves your machine.";

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  keywords: [
    "AI cost tracker",
    "AI bill",
    "Claude Code cost",
    "Claude usage credits",
    "Copilot AI credits",
    "AI usage tracker",
    "token cost tracker",
    "ccusage alternative",
    "AI spend",
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
      <body className="min-h-screen bg-bg font-sans antialiased">
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
