import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm green-black ground ladder. Depth = ground → panel → well +
        // hairlines; never shadows.
        ground: "#0C0D09",
        panel: "#12140E",
        well: "#0A0B07",
        hairline: "rgba(255, 255, 255, 0.08)",
        "hairline-bright": "rgba(255, 255, 255, 0.14)",
        gridline: "rgba(255, 255, 255, 0.03)",
        ink: "#EDEDED",
        muted: "rgba(255, 255, 255, 0.62)",
        faint: "rgba(255, 255, 255, 0.42)",
        // THE accent. Green marks provider-proven money and command
        // affordances only — the color system is the evidence-label system.
        green: "#4CC98A",
        "green-hi": "#5FDF9E",
        "green-line": "rgba(76, 201, 138, 0.30)",
        "green-wash": "rgba(76, 201, 138, 0.08)",
        // Estimated money inside product art (.receipt scope) only.
        "receipt-amber": "#C9A24B",
        danger: "#E5484D",
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
      },
      keyframes: {
        blink: {
          "0%, 50%": { opacity: "1" },
          "50.01%, 100%": { opacity: "0" },
        },
      },
      animation: {
        blink: "blink 1.1s step-end infinite",
      },
    },
  },
  plugins: [],
};

export default config;
