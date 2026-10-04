import { formatUnits, getAddress, type Address } from "viem";
import { USDC_ERC20_DECIMALS, USDC_NATIVE_DECIMALS } from "./chain";

/**
 * USDC comes in two decimal bases on Arc. Format both to plain dollars.
 *
 * Acceptance test 5: formatUsdcFromNative(parseUnits("1", 18)) === "1.0"
 * (never "1e12" and never "1e-12").
 */

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return `${value}.0`;
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.length > 0 ? trimmed : "0"}`;
}

/** 18-decimal chain-native USDC -> human dollars, e.g. 1000000000000000000n -> "1.0" */
export function formatUsdcFromNative(value: bigint): string {
  return trimTrailingZeros(formatUnits(value < 0n ? -value : value, USDC_NATIVE_DECIMALS));
}

/** 6-decimal ERC-20 USDC -> human dollars, e.g. 1000000n -> "1.0" */
export function formatUsdcFromErc20(value: bigint): string {
  return trimTrailingZeros(formatUnits(value < 0n ? -value : value, USDC_ERC20_DECIMALS));
}

/** Native units (18 dec) -> 6-decimal ERC-20 units: 1e18 -> 1000000 */
export function nativeToErc20Units(nativeValue: bigint): bigint {
  return nativeValue / (10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS));
}

/** 6-decimal ERC-20 units -> native units (18 dec): 1000000 -> 1e18 */
export function erc20ToNativeUnits(erc20Value: bigint): bigint {
  return erc20Value * (10n ** BigInt(USDC_NATIVE_DECIMALS - USDC_ERC20_DECIMALS));
}

/** "$1.00" style. Input is human dollars like "1" or "1.25". */
export function formatDollars(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const padded = fraction.padEnd(2, "0").slice(0, 2);
  return `$${whole}.${padded}`;
}

/** "0x3600…0000" */
export function shortAddress(address: string | undefined, lead = 6, tail = 4): string {
  if (!address) return "";
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function checksum(address: Address): Address {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}
