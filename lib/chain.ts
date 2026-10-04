import { defineChain } from "viem";

/**
 * BothDoors chain config.
 *
 * Arc has ONE asset (USDC) that can move two ways:
 *   1. as an ERC-20 transfer  (USDC contract 0x3600…0000, 6 decimals)
 *   2. as a native send      (chain currency, 18 decimals)
 *
 * Both paths are visible on chain. See lib/watchUsdcPayments.ts for the listener.
 */

export const ARC_MAINNET_ID = 5042 as const;
export const ARC_TESTNET_ID = 5042002 as const;

/** ERC-20 USDC. Same address on Arc mainnet and Arc testnet. */
export const USDC_ERC20_ADDRESS = "0x3600000000000000000000000000000000000000";

/** ERC-20 USDC uses 6 decimals. The chain-native USDC uses 18. */
export const USDC_ERC20_DECIMALS = 6;

/** Chain-native USDC (the gas currency) uses 18 decimals. */
export const USDC_NATIVE_DECIMALS = 18;

/** 1 native unit expressed in ERC-20 units: 1e18 / 1e6 = 1e12. */
export const NATIVE_TO_ERC20_RATIO = 10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS);

export const arcMainnet = defineChain({
  id: ARC_MAINNET_ID,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: USDC_NATIVE_DECIMALS,
  },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  testnet: false,
});

export const arcTestnet = defineChain({
  id: ARC_TESTNET_ID,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: USDC_NATIVE_DECIMALS,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

/** Every chain BothDoors supports, mainnet first. */
export const arcChains = [arcMainnet, arcTestnet] as const;

export type ArcChainId = (typeof arcChains)[number]["id"];

export const ARC_CHAIN_IDS: readonly number[] = arcChains.map((c) => c.id);

export function isArcChainId(chainId: number | undefined): chainId is ArcChainId {
  return chainId !== undefined && (ARC_CHAIN_IDS as number[]).includes(chainId);
}

export function getArcChain(chainId: number | undefined) {
  if (chainId === arcTestnet.id) return arcTestnet;
  if (chainId === arcMainnet.id) return arcMainnet;
  return undefined;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  const base = getArcChain(chainId)?.blockExplorers.default.url;
  return base ? `${base}/tx/${txHash}` : "";
}
