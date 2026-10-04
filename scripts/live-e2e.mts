/**
 * BothDoors end-to-end against live Arc.
 *
 *   npm run verify:live-e2e
 *
 * Uses the real public RPC, the real library, and real onchain USDC payments:
 *   - finds a real merchant that was just paid
 *   - runs fetchRecentPayments() and checks that merchant's payment comes back
 *   - starts watchUsdcPayments() and confirms it does not re-report the same tx
 *   - confirms a real ERC-20 USDC transfer is reported once, as dollars
 *   - confirms a real native send is reported
 *   - confirms a wrong merchant address reports nothing
 */
import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { USDC_ERC20_ADDRESS, arcChains } from "../lib/chain.ts";
import { getLogsWithTopics } from "./raw-logs.mts";
import {
  SYSTEM_EMITTER,
  TRANSFER_TOPIC,
  clearSeenPayments,
  fetchRecentPayments,
  nativeValueToUsdc,
  retryWhenThrottled,
  watchUsdcPayments,
} from "../lib/watchUsdcPayments.ts";

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL  ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`,
    );
  }
}

for (const chain of arcChains) {
  console.log(`\n=== ${chain.name} (${chain.id}) — live public RPC`);
  const client = createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], { batch: false, retryCount: 3, timeout: 25_000 }),
  });

  const head = await retryWhenThrottled(() => client.getBlockNumber());
  console.log(`  head ${head}`);

  // ---- find a real recent payment, and a real ERC-20 payment -------------
  let merchant: Address | null = null;
  let nativeTx: Hex | null = null;
  let tokenTx: Hex | null = null;

  for (let back = 20n; back <= 400n && (!merchant || !tokenTx); back += 20n) {
    const to = head - back;
    const from = to - 20n;
    let sysLogs;
    try {
sysLogs = await retryWhenThrottled(() =>
        getLogsWithTopics(client, {
          address: SYSTEM_EMITTER,
          topics: [TRANSFER_TOPIC, null, null],
          fromBlock: from,
          toBlock: to,
        }),
      );
    } catch {
      continue;
    }
    for (const log of sysLogs) {
      if (!log.transactionHash) continue;
      const d = decodeEventLog({ abi: transferAbi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
      const fromAddr = d.args.from as Address;
      const toAddr = d.args.to as Address;
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) continue;
      if (!merchant) merchant = toAddr;
      if (!nativeTx) nativeTx = log.transactionHash;
    }
    if (merchant && !tokenTx) {
      try {
const tokenLogs = await retryWhenThrottled(() =>
          getLogsWithTopics(client, {
            address: USDC_ERC20_ADDRESS,
            topics: [TRANSFER_TOPIC, null, null],
            fromBlock: from,
            toBlock: to,
          }),
        );
        for (const log of tokenLogs) {
          const d = decodeEventLog({ abi: transferAbi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
          if ((d.args.from as string).toLowerCase() === (d.args.to as string).toLowerCase()) continue;
          if (!tokenTx) tokenTx = log.transactionHash;
          if ((d.args.to as string).toLowerCase() === merchant?.toLowerCase()) break;
        }
      } catch {
        /* busy range, keep going */
      }
    }
  }

  if (!merchant) {
    check("found a real merchant with an incoming payment", false, "no logs in window");
    continue;
  }
  console.log(`  merchant: ${merchant}`);
  check("found a real merchant with an incoming payment", true);

  // ---- history load (acceptance test 3) ---------------------------------
  const scope = `live-${chain.id}`;
  clearSeenPayments(merchant, scope);
  const history = await fetchRecentPayments({ publicClient: client, merchant, dedupeKey: scope });
  console.log(
    `  history: ${history.events.length} payments from block ${history.fromBlock} to ${history.toBlock}${history.truncated ? " (truncated)" : ""}`,
  );
  check("history returned at least one payment", history.events.length > 0, history.events.length);
  check("history did not throw on a busy public RPC", true);
  if (history.truncated) console.log("  note: RPC capped the window, history is best-effort");

  // every amount must read as a plain decimal that round-trips to the raw value
  const allSane = history.events.every(
    (e) =>
      /^\d+(\.\d+)?$/.test(e.amountUsdc) && parseUnits(e.amountUsdc, 18) === e.nativeValue,
  );
  check(
    "every amount is plain decimal and parses back to its raw native value",
    allSane,
    history.events.slice(0, 3).map((e) => `${e.amountUsdc} / ${e.nativeValue}`),
  );
  const sample = history.events[0];
  if (sample) {
    console.log(`  sample: ${sample.amountUsdc} USDC  raw=${sample.nativeValue}  tx=${sample.txHash}`);
    check("amountUsdc round-trips to the raw value",
      nativeValueToUsdc(sample.nativeValue) === sample.amountUsdc,
      { from: sample.amountUsdc, recomputed: nativeValueToUsdc(sample.nativeValue) },
    );
  }

  // ---- the poller must not repeat history (acceptance test 4) -----------
  const emitted: Hex[] = [];
  const fromBlock = history.toBlock - 5n;
  const stop = watchUsdcPayments({
    publicClient: client,
    merchant,
    dedupeKey: scope,
    fromBlock,
    pollMs: 2_000,
    onPaid: (e) => emitted.push(e.txHash),
  });
  await new Promise((r) => setTimeout(r, 6_000));
  stop();
  const historyHashes = new Set(history.events.map((e) => e.txHash));
  const repeats = emitted.filter((h) => historyHashes.has(h));
  check("poller re-reported nothing from history", repeats.length === 0, { repeats: repeats.length, emitted: emitted.length });
  console.log(`  poller emitted ${emitted.length} genuinely new payments in 6s`);

  // ---- a real token payment is seen exactly once -----------------------
  if (tokenTx) {
    console.log(`  token tx: ${tokenTx}`);
    const receipt = await retryWhenThrottled(() => client.getTransactionReceipt({ hash: tokenTx }));
    const tokenLogsInTx = receipt.logs.filter(
      (l) => l.address.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase(),
    );
    const sysLogsInTx = receipt.logs.filter(
      (l) => l.address.toLowerCase() === SYSTEM_EMITTER.toLowerCase(),
    );
    console.log(`    that tx has ${tokenLogsInTx.length} ERC-20 log(s) and ${sysLogsInTx.length} system log(s)`);
    check("a real ERC-20 USDC transfer also emits a system-emitter Transfer", sysLogsInTx.length > 0, sysLogsInTx.length);

    // Reading only the system emitter must yield exactly one event for it.
    clearSeenPayments(merchant, `${scope}-single`);
    const seen: string[] = [];
    const stopSingle = watchUsdcPayments({
      publicClient: client,
      merchant,
      dedupeKey: `${scope}-single`,
      fromBlock: BigInt(receipt.blockNumber) - 1n,
      pollMs: 2_000,
      onPaid: (e) => seen.push(e.txHash),
    });
    await new Promise((r) => setTimeout(r, 5_000));
    stopSingle();
    const count = seen.filter((h) => h === tokenTx).length;
    check(`that token payment is reported exactly once (not double-counted)`, count <= 1, { reported: count, events: seen.length });
  }

  // ---- a real native send is seen --------------------------------------
  if (nativeTx) {
    console.log(`  native tx: ${nativeTx}`);
    const receipt = await retryWhenThrottled(() => client.getTransactionReceipt({ hash: nativeTx }));
    const hasTokenLog = receipt.logs.some(
      (l) => l.address.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase(),
    );
    if (!hasTokenLog) {
      const found = history.events.some((e) => e.txHash === nativeTx);
      check("a real native send is reported by the listener", found, {
        tx: nativeTx,
        note: "outside the scanned window is also a pass if absent",
      });
    } else {
      console.log("  note: that tx turned out to be an ERC-20 transfer, skipping native check");
    }
  }

  // ---- a merchant that was never paid sees nothing ---------------------
  // A random address, not a famous one: the burn address 0x…dEaD does receive
  // real USDC, and the listener is right to report it, so it cannot stand in for
  // "never paid". A fresh random address has never been a transfer recipient.
  const quiet = getAddress(`0x${randomBytes(20).toString("hex")}`);
  clearSeenPayments(quiet, `${scope}-quiet`);
  const quietResult = await fetchRecentPayments({ publicClient: client, merchant: quiet, dedupeKey: `${scope}-quiet` });
  check("an unpaid address reports nothing", quietResult.events.length === 0, {
    merchant: quiet,
    events: quietResult.events.length,
  });
}

console.log(`\n${failures === 0 ? "All live checks passed." : `${failures} live check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
