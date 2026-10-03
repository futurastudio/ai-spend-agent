import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SITE_URL } from "../lib/site";
import { JsonLd } from "@/components/JsonLd";

const geistSans = localFont({
  src: "../public/fonts/geist-latin.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "../public/fonts/geist-mono-latin.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--font-geist-mono",
});

const title = "Tilden | Explain your AI spend";
const description =
  "AI spend visibility for engineering leaders, founders and finance teams. Review supported provider costs and shared agent activity. Join the Tilden waitlist.";

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
    "AI usage tracker",
    "AI spend",
    "AI spend management",
    "AI financial accountability",
    "AI agent workforce",
  ],
  openGraph: {
    title,
    description,
    type: "website",
    url: "/",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Tilden. Your agents are doing more. Know where the money goes." }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/opengraph-image"],
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
            "@type": "Organization",
            name: "Tilden",
            legalName: "Futura Studio, LLC",
            description,
            url: SITE_URL,
            logo: `${SITE_URL}/brand/lockup/tilden-lockup-horizontal-ink.svg`,
          }}
        />
        {/* Scroll-reveal is progressive enhancement: without JS, content
            must simply be visible. */}
        <noscript>
          <style>{`.reveal { opacity: 1 !important; transform: none !important; }`}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
