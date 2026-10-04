import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        door: {
          bg: "#07090d",
          panel: "#0e1117",
          line: "#1c2230",
          ink: "#e8ecf4",
          dim: "#8b95a8",
          accent: "#4f8cff",
          paid: "#22c55e",
          wait: "#f5a524",
        },
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        pop: {
          "0%": { transform: "scale(0.94)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        pop: "pop 180ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
