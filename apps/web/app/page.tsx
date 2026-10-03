import type { Metadata } from "next";
import TraceNext from "../components/iterations/trace-next/TraceNext";
import "../components/iterations/trace-next/tokens.css";

export const metadata: Metadata = {
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
};

export default function Home() { return <TraceNext />; }
