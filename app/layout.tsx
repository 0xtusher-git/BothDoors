import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "BothDoors — see both USDC send paths",
  description:
    "BothDoors is a USDC payment listener built on Arc. It detects ERC-20 transfers AND native USDC sends.",
};

export const viewport: Viewport = {
  themeColor: "#07090d",
  width: "device-width",
  initialScale: 1,
};

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="flex gap-1">
        <span className="block h-5 w-2.5 rounded-[3px] bg-door-accent" />
        <span className="block h-5 w-2.5 rounded-[3px] bg-door-paid" />
      </span>
      <span className="text-lg font-black tracking-tight">BothDoors</span>
    </span>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <Providers>
          <header className="border-b border-door-line/80">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
              <Link href="/" className="shrink-0">
                <Wordmark />
              </Link>
              <nav className="flex items-center gap-1 text-sm">
                <Link
                  href="/"
                  className="rounded-lg px-3 py-1.5 text-door-dim transition hover:bg-white/5 hover:text-door-ink"
                >
                  Demo
                </Link>
                <Link
                  href="/integrate"
                  className="rounded-lg px-3 py-1.5 text-door-dim transition hover:bg-white/5 hover:text-door-ink"
                >
                  Integrate
                </Link>
              </nav>
            </div>
          </header>

          <main className="mx-auto max-w-5xl px-4 py-6 sm:py-10">{children}</main>

          <footer className="mx-auto max-w-5xl px-4 pb-10 pt-2 text-xs text-door-dim">
            Built on Arc. One asset, two send doors, one listener. Not a wallet, not a custodian, not a
            bridge.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
