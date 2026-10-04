"use client";

import { useEffect, useState } from "react";

/**
 * False on the server and on the first client render, true from the next one on.
 *
 * Wallet state (`useAccount`, `useWalletClient`) is client-only: the server has
 * no extension to read, and the client can rehydrate a connected account from
 * persisted storage before React hydrates. Rendering either directly causes a
 * hydration mismatch. Gating on this hook makes the first client render
 * identical to the server HTML, then the real state lands one tick later.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
