"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { WalletOption } from "@/lib/wallets";

type WalletPickerProps = {
  open: boolean;
  wallets: readonly WalletOption[];
  pendingId: string | null;
  error: ReactNode;
  onSelect: (wallet: WalletOption) => void;
  onClose: () => void;
};

export function WalletPicker({
  open,
  wallets,
  pendingId,
  error,
  onSelect,
  onClose,
}: WalletPickerProps) {
  const firstOption = useRef<HTMLButtonElement>(null);

  // Move focus into the list so the dialog is usable from the keyboard, and so a
  // stray Enter does not activate the connect button underneath it.
  useEffect(() => {
    if (open) firstOption.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      // A click that lands on the backdrop, not on the panel, dismisses.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="w-full max-w-sm rounded-2xl border border-door-line bg-door-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-door-ink">Connect a wallet</h2>
            <p className="mt-1 text-xs text-door-dim">
              {wallets.length === 1
                ? "One wallet detected."
                : `${wallets.length} wallets detected. Pick the one you want.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 rounded-lg px-2 py-1 text-lg leading-none text-door-dim transition hover:text-door-ink"
          >
            &times;
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {wallets.map((wallet, index) => {
            const pending = pendingId === wallet.id;
            return (
              <button
                key={wallet.id}
                ref={index === 0 ? firstOption : undefined}
                type="button"
                onClick={() => onSelect(wallet)}
                disabled={pendingId !== null}
                className="flex items-center gap-3 rounded-xl border border-door-line px-3 py-2.5 text-left transition hover:border-door-accent/60 hover:bg-door-accent/5 disabled:opacity-50"
              >
                {wallet.icon ? (
                  // Wallet icons are remote data-URI/bitmaps supplied by the wallet
                  // itself, so they are decorative and carry no meaning here.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={wallet.icon} alt="" className="h-7 w-7 shrink-0 rounded-md" />
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-door-line text-xs font-semibold text-door-dim">
                    {wallet.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="text-sm font-medium text-door-ink">
                  {pending ? "Connecting…" : wallet.name}
                </span>
              </button>
            );
          })}
        </div>

        {error ? <div className="mt-3 text-xs text-door-wait">{error}</div> : null}
      </div>
    </div>
  );
}
