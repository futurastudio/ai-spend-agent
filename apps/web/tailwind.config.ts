import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cool near-black surface ladder (Raycast/Linear idiom).
        bg: "#07080a",
        surface: "#0d0d0e",
        elevated: "#101113",
        well: "#060609",
        border: "#1e2127",
        "border-bright": "#2b2f37",
        ink: "#f4f4f6",
        muted: "#9aa0ad",
        faint: "#6a6e78",
        // Terminal syntax accents — saturated colors live only in terminals.
        green: "#59d499",
        "green-bright": "#5ef2a8",
        red: "#ff6161",
        cyan: "#57c1ff",
        yellow: "#ffc533",
      },
      fontFamily: {
        sans: [
          "var(--font-geist-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "var(--font-geist-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      maxWidth: {
        content: "1080px",
        terminal: "920px",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 50%": { opacity: "1" },
          "50.01%, 100%": { opacity: "0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.55s cubic-bezier(0.22, 1, 0.36, 1) both",
        blink: "blink 1.1s step-end infinite",
      },
    },
  },
  plugins: [],
};

export default config;
