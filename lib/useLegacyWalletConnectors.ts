"use client";

import { useEffect } from "react";
import { useConnect } from "wagmi";
import { identifyLegacyProvider } from "./wallets";
import { wagmiConfig } from "./wagmi";

type ConnectorInternal = {
  setup?: (connectorFn: unknown) => unknown;
  providerDetailToConnector?: (detail: unknown) => unknown;
  setState?: (value: ((previous: unknown[]) => unknown[]) | unknown[]) => void;
};

/**
 * Collect providers that only exist in the legacy arrays.
 *
 * EIP-6963 is the good path and wagmi handles it: a wallet announces itself and
 * wagmi turns each announcement into its own connector. It only covers wallets
 * new enough to announce though. Older extensions publish themselves on
 * `window.ethereum.providers` instead, and nothing reads that array — so with
 * MetaMask, OKX and Phantom all installed, only whichever extension won
 * `window.ethereum` was ever reachable.
 */
function legacyProviders(): unknown[] {
  if (typeof window === "undefined") return [];
  const injected = (window as { ethereum?: { providers?: unknown[] } }).ethereum;
  const found = Array.isArray(injected?.providers) ? [...injected.providers] : [];
  // Phantom keeps a second reference for its EVM provider.
  const phantom = (window as { phantom?: { ethereum?: unknown } }).phantom?.ethereum;
  if (phantom && !found.includes(phantom)) found.push(phantom);
  return found;
}

/**
 * Register every legacy provider as a connector of its own.
 *
 * They go into the config's connector store rather than being connected through a
 * throwaway connector, because that store is what `reconnect` walks on page load —
 * a connector that is not in it would silently fail to restore after a refresh.
 */
export function useLegacyWalletConnectors(): void {
  const { connectors } = useConnect();

  // Re-runs as wallets appear, since extensions inject at different times and a
  // slow one may not be listening when the others announced.
  useEffect(() => {
    const internals = (
      wagmiConfig as unknown as { _internal?: { connectors?: ConnectorInternal } }
    )._internal?.connectors;
    const setup = internals?.setup;
    const providerDetailToConnector = internals?.providerDetailToConnector;
    const setState = internals?.setState;
    if (!setup || !providerDetailToConnector || !setState) return;

    const candidates = legacyProviders();
    if (candidates.length === 0) return;

    let cancelled = false;
    const register = async () => {
      // Whatever wagmi already knows about, by provider identity: the catch-all
      // connector resolves `window.ethereum`, which is one entry of that array, and
      // any wallet that also announced is registered already.
      const known: unknown[] = await Promise.all(
        wagmiConfig.connectors.map((connector) => connector.getProvider().catch(() => undefined)),
      );
      if (cancelled) return;

      const added: unknown[] = [];
      for (const [index, provider] of candidates.entries()) {
        if (known.includes(provider)) continue;
        const brand = identifyLegacyProvider(provider as Record<string, unknown>, index);
        if (!brand) continue;
        const connector = setup(
          providerDetailToConnector({
            info: { uuid: `${brand.rdns}-${index}`, name: brand.name, rdns: brand.rdns },
            provider,
          }),
        );
        if (connector) added.push(connector);
      }
      if (added.length === 0) return;
      setState((previous) => [...previous, ...added]);
    };

    void register();
    return () => {
      cancelled = true;
    };
  }, [connectors.length]);
}
