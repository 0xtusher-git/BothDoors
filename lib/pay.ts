import { parseUnits, type Address, type Chain, type Hash } from "viem";

/**
 * BothDoors — the two pay buttons.
 *
 * Door A  payToken  -> USDC.transfer(to, parseUnits(amount, 6))   (an ERC-20 send)
 * Door B  payNative -> sendTransaction({ to, value: parseUnits(amount, 18) })
 *
 * Same $1. Same asset. Different door, different log. BothDoors' listener
 * watches the system emitter so it sees both.
 *
 * Acceptance tests 1 and 2: calling either of these makes the shop go PAID.
 */

export const USDC_ERC20_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

export const USDC_ERC20_DECIMALS = 6;
export const USDC_NATIVE_DECIMALS = 18;

/** Minimal ERC-20 USDC ABI. Same contract on Arc mainnet and Arc testnet. */
export const usdcAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const DEFAULT_AMOUNT_USDC = "1";

/**
 * Structural type for a viem WalletClient. Declared with method syntax so any
 * client — a raw `createWalletClient`, or a wagmi `useWalletClient()` result —
 * fits without generics gymnastics.
 */
export type PayWalletClient = {
  writeContract: (args: {
    address: Address;
    abi: typeof usdcAbi;
    functionName: "transfer";
    args: readonly [Address, bigint];
    chain?: Chain | null;
    account?: Address;
  }) => Promise<Hash>;
  sendTransaction: (args: {
    to: Address;
    value: bigint;
    chain?: Chain | null;
    account?: Address;
  }) => Promise<Hash>;
};

export type PayArgs = {
  walletClient: PayWalletClient;
  merchant: Address;
  /** Human dollars, e.g. "1" or "1.25". Defaults to $1. */
  amountUsdc?: string;
  chain?: Chain | null;
  account?: Address;
};

function validateAmount(amountUsdc: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amountUsdc)) {
    throw new Error(`Amount must be a plain dollar figure like "1" or "1.25", got "${amountUsdc}".`);
  }
  const value = parseUnits(amountUsdc, decimals);
  if (value <= 0n) throw new Error("Amount must be more than zero.");
  return value;
}

/** Door A. An ERC-20 USDC transfer. 6 decimals. */
export async function payToken(args: PayArgs): Promise<Hash> {
  const { walletClient, merchant, amountUsdc = DEFAULT_AMOUNT_USDC, chain, account } = args;
  const amount = validateAmount(amountUsdc, USDC_ERC20_DECIMALS);
  return walletClient.writeContract({
    address: USDC_ERC20_ADDRESS,
    abi: usdcAbi,
    functionName: "transfer",
    args: [merchant, amount],
    ...(chain ? { chain } : {}),
    ...(account ? { account } : {}),
  });
}

/** Door B. The chain-native send, like sending ETH on Ethereum. 18 decimals. */
export async function payNative(args: PayArgs): Promise<Hash> {
  const { walletClient, merchant, amountUsdc = DEFAULT_AMOUNT_USDC, chain, account } = args;
  const value = validateAmount(amountUsdc, USDC_NATIVE_DECIMALS);
  return walletClient.sendTransaction({
    to: merchant,
    value,
    ...(chain ? { chain } : {}),
    ...(account ? { account } : {}),
  });
}
