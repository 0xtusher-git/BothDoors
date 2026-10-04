/**
 * Raw `topics` log queries for the verification scripts.
 *
 * viem's public `getLogs` type only models `event`/`events`/`args`, not raw
 * `topics`, but the nodes we test against do honour `topics` — and this app's
 * whole premise is a specific topic shape. So the diagnostic scripts talk to
 * `eth_getLogs` directly rather than pretending viem supports it.
 */
import type { Address, Hex } from "viem";
import type { TransferLogLike } from "../lib/watchUsdcPayments.ts";

type RawLogClient = {
  getLogs: (args: {
    address: Address;
    topics: readonly (Hex | null)[];
    fromBlock: bigint;
    // Some checks deliberately compare a numeric head against "latest".
    toBlock: bigint | "latest";
  }) => Promise<readonly TransferLogLike[]>;
};

export function getLogsWithTopics(
  client: unknown,
  args: {
    address: Address;
    topics: readonly (Hex | null)[];
    fromBlock: bigint;
    toBlock: bigint | "latest";
  },
): Promise<readonly TransferLogLike[]> {
  return (client as RawLogClient).getLogs(args);
}
