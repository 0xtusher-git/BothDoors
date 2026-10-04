"use client";

import { explorerTxUrl } from "@/lib/chain";
import { formatDollars, shortAddress } from "@/lib/format";
import type { PaidEvent } from "@/lib/watchUsdcPayments";

export type DemoStatus = "waiting" | "watching" | "paid";
export type Door = "token" | "native" | "unknown";

const STATE_COPY: Record<DemoStatus, { label: string; sub: string; className: string }> = {
  waiting: {
    label: "WAITING",
    sub: "No matching transfer yet.",
    className: "text-door-dim",
  },
  watching: {
    label: "WATCHING",
    sub: "Reading the system Transfer logs every 2 seconds.",
    className: "text-door-wait",
  },
  paid: {
    label: "PAID",
    sub: "A matching Transfer log landed. This is onchain, not a guess.",
    className: "text-door-paid",
  },
};

export function StatusCard({
  status,
  event,
  door,
  chainId,
  warning,
}: {
  status: DemoStatus;
  event: PaidEvent | null;
  door: Door;
  chainId: number;
  warning?: string | null;
}) {
  const state = STATE_COPY[status];
  const txUrl = event ? explorerTxUrl(chainId, event.txHash) : "";

  return (
    <div className="panel p-5 sm:p-7">
      <p className="label">Order 1 USDC</p>

      <div className="mt-3 flex flex-col gap-1">
        <span
          className={`text-6xl font-black leading-[0.9] tracking-tighter sm:text-8xl ${state.className} ${
            status === "paid" ? "animate-pop" : ""
          }`}
        >
          {state.label}
        </span>
        <span className="text-sm text-door-dim">{state.sub}</span>
      </div>

      {event ? (
        <dl className="mt-6 space-y-3 border-t border-door-line pt-5 text-sm">
          <Row label="Amount">
            <span className="font-semibold text-door-paid">
              {formatDollars(event.amountUsdc)} USDC
            </span>
            <span className="ml-2 text-xs text-door-dim">
              raw {event.nativeValue.toString()} (18 decimals)
            </span>
          </Row>

          <Row label="Which door">
            {door === "token" ? (
              <Badge tone="accent">as token — ERC-20 transfer</Badge>
            ) : door === "native" ? (
              <Badge tone="paid">as native — value send</Badge>
            ) : (
              <Badge tone="dim">door not identified</Badge>
            )}
          </Row>

          <Row label="From">
            <span className="font-mono text-xs" title={event.from}>
              {shortAddress(event.from, 10, 8)}
            </span>
          </Row>

          <Row label="Tx">
            {txUrl ? (
              <a
                href={txUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-door-accent underline underline-offset-2"
              >
                {shortAddress(event.txHash, 12, 10)}
              </a>
            ) : (
              <span className="font-mono text-xs">{shortAddress(event.txHash, 12, 10)}</span>
            )}
          </Row>

          <Row label="Block">
            <span className="font-mono text-xs">{event.blockNumber.toString()}</span>
          </Row>
        </dl>
      ) : (
        <p className="mt-6 border-t border-door-line pt-5 text-sm text-door-dim">
          Amount, sender, tx hash and explorer link appear here the moment a real log is found.
        </p>
      )}

      {warning ? (
        <p className="mt-5 rounded-lg border border-door-wait/30 bg-door-wait/10 px-3 py-2 text-xs text-door-wait">
          {warning}
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline gap-3">
      <dt className="label">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "accent" | "paid" | "dim" | "warn";
  children: React.ReactNode;
}) {
  const tones = {
    accent: "border-door-accent/40 bg-door-accent/10 text-door-accent",
    paid: "border-door-paid/40 bg-door-paid/10 text-door-paid",
    dim: "border-door-line bg-white/5 text-door-dim",
    warn: "border-door-wait/40 bg-door-wait/10 text-door-wait",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
