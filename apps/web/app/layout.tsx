import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const title = "ai-spend-agent — your AI spend in one view, in 90 seconds";
const description =
  "A free, local-first CLI that unifies your OpenAI, Anthropic, Cursor, and Copilot spend — plus your Claude Code and Codex session logs — into one terminal view, with a ranked list of cuts. Your data never leaves your machine.";

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
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-screen bg-bg font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
