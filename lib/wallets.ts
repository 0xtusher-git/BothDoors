import type { Connector } from "wagmi";

/**
 * One row in the "connect a wallet" list.
 *
 * `generic` marks wagmi's catch-all injected connector, which resolves whichever
 * wallet happened to claim `window.ethereum`. It is kept only as a fallback: with
 * several wallets installed it is not a distinct wallet, it is one of them wearing
 * a generic label, so offering it alongside MetaMask and Phantom would show the
 * same wallet twice under two different names.
 *
 * It is identified by id rather than by a missing `rdns`: wagmi's injected
 * connector does not populate `rdns` at all, named or not.
 */
export type WalletOption = {
  connector: Connector;
  id: string;
  name: string;
  icon?: string;
  generic: boolean;
};

/** Which brands a legacy provider can be identified as, by its own flags. */
type LegacyFlags = Record<string, unknown>;

const LEGACY_BRANDS: ReadonlyArray<{ flag: string; name: string; rdns: string }> = [
  // Order is load-bearing. MetaMask-compatible providers set `isMetaMask`, so
  // every brand that borrows that flag has to be tested first or it gets reported
  // as MetaMask. Phantom and OKX are both known to do this.
  { flag: "isPhantom", name: "Phantom", rdns: "app.phantom" },
  { flag: "isOkxWallet", name: "OKX Wallet", rdns: "com.okex.wallet" },
  { flag: "isOKExWallet", name: "OKX Wallet", rdns: "com.okex.wallet" },
  { flag: "isCoinbaseWallet", name: "Coinbase Wallet", rdns: "com.coinbase.wallet" },
  { flag: "isRabby", name: "Rabby", rdns: "io.rabby" },
  { flag: "isBraveWallet", name: "Brave Wallet", rdns: "com.brave.wallet" },
  { flag: "isTrust", name: "Trust Wallet", rdns: "com.trustwallet.app" },
  { flag: "isTrustWallet", name: "Trust Wallet", rdns: "com.trustwallet.app" },
  { flag: "isTokenPocket", name: "TokenPocket", rdns: "com.tokenpocket.pro" },
  { flag: "isBitKeep", name: "BitKeep", rdns: "com.bitkeep.web3" },
  { flag: "isKuCoinWallet", name: "KuCoin Wallet", rdns: "com.kucoin.wallet" },
  { flag: "isRainbow", name: "Rainbow", rdns: "me.rainbow" },
  { flag: "isBackpack", name: "Backpack", rdns: "app.backpack" },
  { flag: "isZerion", name: "Zerion", rdns: "io.zerion" },
  { flag: "isMetaMask", name: "MetaMask", rdns: "io.metamask" },
];

const UNKNOWN_RDNS = "com.bothdoors.legacy";

/**
 * Name a provider that never announced itself over EIP-6963.
 *
 * Wallets that predate EIP-6963 are only reachable through the legacy
 * `window.ethereum.providers` array, and they still advertise a brand through
 * boolean flags. Returns null only for a provider that is not EIP-1193 at all.
 */
export function identifyLegacyProvider(
  provider: LegacyFlags | null | undefined,
  index: number,
): { name: string; rdns: string } | null {
  if (!provider || typeof provider !== "object") return null;
  if (typeof (provider as { request?: unknown }).request !== "function") return null;
  for (const brand of LEGACY_BRANDS) {
    if (provider[brand.flag] === true) return { name: brand.name, rdns: brand.rdns };
  }
  // Unidentified, but still a real wallet. Numbered so two of them stay distinct.
  return { name: "Browser Wallet", rdns: `${UNKNOWN_RDNS}.${index}` };
}

/**
 * Turn wagmi's connector list into the rows to show, hiding the catch-all
 * connector whenever at least one wallet named itself.
 */
export function listWallets(connectors: readonly Connector[]): WalletOption[] {
  const seen = new Set<string>();
  const options: WalletOption[] = [];
  for (const connector of connectors) {
    const option: WalletOption = {
      connector,
      id: connector.id,
      name: connector.name,
      generic: connector.type === "injected" && connector.id === "injected",
    };
    if (connector.icon) option.icon = connector.icon;
    // A wallet can reach the list twice: once by announcing itself and once
    // through the legacy scan. Same id means the same wallet, so keep the first.
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    options.push(option);
  }
  const named = options.filter((option) => !option.generic);
  return named.length > 0 ? named : options;
}
