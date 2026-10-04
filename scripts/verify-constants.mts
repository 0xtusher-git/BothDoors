/**
 * BothDoors — constant check.
 *
 *   npm run verify:constants          # offline: hashes + address shape only
 *   npm run verify:constants -- --rpc # also asks both Arc RPCs for live data
 *
 * Guards the three things the whole app leans on:
 *   1. TRANSFER_TOPIC  really is keccak256("Transfer(address,address,uint256)")
 *   2. SYSTEM_EMITTER  really is the 0xff..fffe system address, 32-byte-paddable
 *   3. the USDC ERC-20 contract really answers on both chains
 */
import { createPublicClient, getAddress, http, keccak256, toHex } from "viem";
import { USDC_ERC20_ADDRESS, arcChains } from "../lib/chain.ts";
import { getLogsWithTopics } from "./raw-logs.mts";
import {
  SYSTEM_EMITTER,
  TRANSFER_TOPIC,
  addressToTopic,
  fetchRecentPayments,
  nativeValueToUsdc,
} from "../lib/watchUsdcPayments.ts";

const live = process.argv.includes("--rpc");
let failures = 0;

/** The address in topic2 of a Transfer, i.e. the recipient. */
function topicToAddress(topic: string | undefined): string | null {
  if (!topic || topic.length < 42) return null;
  return `0x${topic.slice(26)}`;
}

/**
 * A real account that has recently received USDC on this chain.
 *
 * Discovered rather than hardcoded: a literal address would silently rot, and on
 * one chain it might not exist at all, which would turn a listener assertion into
 * a "no payments here" assertion. Scanning recent transfers also proves the token
 * contract is emitting logs right now, which is the point of this check.
 */
async function findRecentRecipient(
  client: unknown,
  head: bigint,
): Promise<{ merchant: string | null; transfers: number }> {
  const logs = await getLogsWithTopics(client, {
    address: USDC_ERC20_ADDRESS,
    topics: [TRANSFER_TOPIC, null, null],
    fromBlock: head > 400n ? head - 399n : 0n,
    toBlock: head,
  });
  for (const log of logs) {
    const to = topicToAddress(log.topics[2]);
    if (to && to !== "0x0000000000000000000000000000000000000000") return { merchant: to, transfers: logs.length };
  }
  return { merchant: null, transfers: logs.length };
}

const CHUNK_BLOCKS = 500n;

function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
  }
}

console.log("BothDoors constant check\n");

console.log("Transfer topic");
const derived = keccak256(toHex("Transfer(address,address,uint256)"));
check(`keccak256("Transfer(address,address,uint256)") === TRANSFER_TOPIC`, derived === TRANSFER_TOPIC, {
  derived,
  constant: TRANSFER_TOPIC,
});

console.log("\nEIP-7708 system emitter");
const emitterHex = SYSTEM_EMITTER.toLowerCase().replace(/^0x/, "");
check("20 bytes wide", emitterHex.length === 40, `${emitterHex.length} hex chars`);
check("0xff..fffe", /^ff+fe$/.test(emitterHex), emitterHex);
check("pads to a 32-byte topic", addressToTopic(SYSTEM_EMITTER).length === 66);
try {
  const checksummed = getAddress(SYSTEM_EMITTER);
  check("EIP-55 checksum is valid", checksummed === SYSTEM_EMITTER, {
    expected: SYSTEM_EMITTER,
    got: checksummed,
  });
} catch (error) {
  check("EIP-55 checksum is valid", false, (error as Error).message);
}

console.log("\nUSDC ERC-20 address");
check("configured", USDC_ERC20_ADDRESS === "0x3600000000000000000000000000000000000000", USDC_ERC20_ADDRESS);
check("checksums", getAddress(USDC_ERC20_ADDRESS) === USDC_ERC20_ADDRESS);

console.log("\nAmount maths (acceptance test 5)");
check("1e18 native units -> 1.0", nativeValueToUsdc(10n ** 18n) === "1.0", nativeValueToUsdc(10n ** 18n));
check("1.5e18 -> 1.5", nativeValueToUsdc(15n * 10n ** 17n) === "1.5", nativeValueToUsdc(15n * 10n ** 17n));
check("1 USDC -> 1e18 native units", nativeValueToUsdc(1_000_000_000_000_000_000n) === "1.0");

if (live) {
  console.log("\nLive RPC");
  for (const chain of arcChains) {
    const url = chain.rpcUrls.default.http[0];
    const client = createPublicClient({ chain, transport: http(url, { timeout: 20_000 }) });
    let head: bigint;
    try {
      head = await client.getBlockNumber();
      check(`${chain.name} head block reachable`, head > 0n, head);
    } catch (error) {
      check(`${chain.name} head block reachable`, false, (error as Error).message);
      continue;
    }
    try {
      const code = await client.getCode({ address: USDC_ERC20_ADDRESS });
      check(`${chain.name} USDC contract has bytecode`, Boolean(code) && code !== "0x", `${code ? code.length : 0} chars`);
    } catch (error) {
      check(`${chain.name} USDC contract has bytecode`, false, (error as Error).message);
    }
// Assert the query shape the listener actually sends, at the chunk size it
    // actually uses, and then that a real read completes.
    //
    // The obvious check — "does a wide getLogs work?" — is not a property of this
    // app and does not hold on either chain: the nodes ignore narrow filtering to
    // varying degrees and cap results by size, so a wide read is refused. Worse,
    // the shapes differ per node: Arc mainnet rejects a *single-element* `topics`
    // array with "Invalid parameters" over 500 blocks while happily serving the
    // same range with `[topic0, null, recipient]`, which is the shape
    // `watchUsdcPayments` uses. Pinning the node's mood here would make this
    // check fail for reasons that have nothing to do with the code.
    let recipient: string | null = null;
    try {
      const found = await findRecentRecipient(client, head);
      recipient = found.merchant;
      check(
        `${chain.name} USDC transfers are being emitted right now`,
        found.transfers > 0,
        `${found.transfers} transfers in 400 blocks`,
      );
    } catch (error) {
      check(`${chain.name} USDC transfers are being emitted right now`, false, (error as Error).message.slice(0, 90));
    }

    if (recipient) {
      const merchantTopics = [TRANSFER_TOPIC, null, addressToTopic(recipient)];
      for (const [label, address] of [["USDC", USDC_ERC20_ADDRESS], ["emitter", SYSTEM_EMITTER]] as const) {
        try {
          const logs = await getLogsWithTopics(client, {
            address,
            topics: merchantTopics,
            fromBlock: head > CHUNK_BLOCKS ? head - CHUNK_BLOCKS + 1n : 0n,
            toBlock: head,
          });
          check(`${chain.name} ${label} getLogs works at the chunk size the app uses`, true, `${logs.length} logs`);
        } catch (error) {
          check(
            `${chain.name} ${label} getLogs works at the chunk size the app uses`,
            false,
            (error as Error).message.slice(0, 90),
          );
        }
      }
      try {
        const result = await fetchRecentPayments({
          publicClient: client,
          merchant: recipient as `0x${string}`,
          lookbackBlocks: 1_000n,
          dedupeKey: `verify-constants:${chain.id}`,
        });
        check(`${chain.name} a real read completes`, Array.isArray(result.events), {
          events: result.events.length,
          truncated: result.truncated,
        });
        check(
          `${chain.name} it found payments for a real recipient`,
          result.events.length > 0,
          result.events.length,
        );
        check(
          `${chain.name} every amount round-trips`,
          result.events.every((e) => nativeValueToUsdc(e.nativeValue) === e.amountUsdc),
          result.events.slice(0, 2).map((e) => `${e.amountUsdc} vs ${e.nativeValue}`),
        );
        const selfSends = result.events.filter(
          (e) => e.from.toLowerCase() === e.to.toLowerCase(),
        );
        console.log(
          `  note  ${chain.name} read ${result.events.length} payment(s), ${selfSends.length} self-send(s), truncated=${result.truncated}`,
        );
      } catch (error) {
        check(`${chain.name} a real read completes`, false, (error as Error).message.slice(0, 90));
      }
    }
  }
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
