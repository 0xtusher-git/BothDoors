import { isAddress, type Address } from "viem";
import { arcMainnet, arcTestnet, type ArcChainId } from "./chain";

/**
 * NEXT_PUBLIC_* values are inlined at build time, so they have to be read as
 * literal member accesses — no dynamic lookup.
 */

const rawMerchant = (process.env.NEXT_PUBLIC_MERCHANT_ADDRESS ?? "").trim();

/**
 * The demo merchant. If this is empty we fall back to the connected wallet, so a
 * single person can run the whole demo alone. Set it to a real address for a
 * two-wallet demo.
 */
export const MERCHANT_ADDRESS: Address | null = isAddress(rawMerchant)
  ? (rawMerchant as Address)
  : null;

export const MERCHANT_ADDRESS_IS_SET = rawMerchant.length > 0;

/**
 * Set but not a valid address (a typo, or a bad EIP-55 checksum). Worth saying
 * out loud, otherwise the app silently falls back to the connected wallet and it
 * looks like the env var is being ignored.
 */
export const MERCHANT_ADDRESS_INVALID =
  MERCHANT_ADDRESS_IS_SET && MERCHANT_ADDRESS === null ? rawMerchant : null;

/** "mainnet" (default) or "testnet". */
export const DEFAULT_CHAIN_ID: ArcChainId =
  (process.env.NEXT_PUBLIC_DEFAULT_CHAIN ?? "mainnet").trim().toLowerCase() === "testnet"
    ? arcTestnet.id
    : arcMainnet.id;

/** Only read if you swap the injected connector for RainbowKit. Not used by v0. */
export const WC_PROJECT_ID = (process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "").trim();
