import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const title = "AI Spend Analyst — See your AI spend in one view in 90 seconds";
const description =
  "A free, local-first CLI that unifies your OpenAI, Anthropic, Cursor, and Copilot spend in one view — and shows you exactly where to cut. Your data never leaves your machine.";

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL("https://aispendanalyst.dev"),
  openGraph: {
    title,
    description,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
