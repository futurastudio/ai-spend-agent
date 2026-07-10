import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

const title = "ai-spend-agent — your AI spend in one view, in 90 seconds";
const description =
  "A free, local-first CLI that unifies your Claude Code and Codex session logs (estimated at API rates) — plus your real OpenAI and Anthropic bills when you connect an admin key — into one terminal view, with a ranked list of cuts. Your data never leaves your machine.";

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL("https://ai-spend-agent.vercel.app"),
  openGraph: {
    title,
    description,
    type: "website",
    url: "https://ai-spend-agent.vercel.app",
    images: [
      {
        url: "https://raw.githubusercontent.com/futurastudio/ai-spend-agent/main/docs/assets/social-preview.png",
        width: 1280,
        height: 640,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [
      "https://raw.githubusercontent.com/futurastudio/ai-spend-agent/main/docs/assets/social-preview.png",
    ],
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
