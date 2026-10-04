/**
 * Does an ERC-20 USDC transfer ALSO emit a system-emitter Transfer?
 * That claim is the whole product. Verify it against live chain data.
 */
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from "viem";
import { USDC_ERC20_ADDRESS, arcChains } from "../lib/chain.ts";
import { SYSTEM_EMITTER, TRANSFER_TOPIC } from "../lib/watchUsdcPayments.ts";
import { getLogsWithTopics } from "./raw-logs.mts";

const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

for (const chain of arcChains) {
  console.log(`\n========== ${chain.name} (${chain.id})`);
  const client = createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], { retryCount: 3, timeout: 20_000 }),
  });

  const head = await client.getBlockNumber();
  console.log("head:", head);

  // A) viem getLogs with toBlock: "latest"  -> suspected RPC bug
  try {
    const a = await getLogsWithTopics(client, {
      address: SYSTEM_EMITTER,
      topics: [TRANSFER_TOPIC],
      fromBlock: head - 10n,
      toBlock: "latest",
    });
    console.log(`A) toBlock "latest": ${a.length} logs`);
  } catch (e) {
    console.log("A) toBlock \"latest\" FAILS:", (e as Error).message.slice(0, 80));
  }

  // B) viem getLogs with explicit toBlock
  try {
    const b = await getLogsWithTopics(client, {
      address: SYSTEM_EMITTER,
      topics: [TRANSFER_TOPIC],
      fromBlock: head - 10n,
      toBlock: head,
    });
    console.log(`B) toBlock <number>: ${b.length} logs`);
  } catch (e) {
    console.log("B) toBlock <number> FAILS:", (e as Error).message.slice(0, 80));
  }

  // C) find a recent ERC-20 USDC Transfer, then check its receipt for a system-emitter twin
  let found = 0;
  let erc20Checked = 0;
  let withTwin = 0;
  let twinExact = 0;
  let twinSamples: string[] = [];

  for (let attempt = 0; attempt < 12 && found < 3; attempt++) {
    const to = head - BigInt(attempt * 60);
    const from = to - 40n;
    let tokenLogs;
    try {
      tokenLogs = await getLogsWithTopics(client, {
        address: USDC_ERC20_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.log(`C) attempt ${attempt} ERC-20 getLogs failed:`, (e as Error).message.slice(0, 90));
      continue;
    }
    console.log(`C) ERC-20 USDC Transfers in blocks ${from}..${to}: ${tokenLogs.length}`);
    for (const log of tokenLogs.slice(0, 6)) {
      if (!log.transactionHash) continue;
      erc20Checked += 1;
      try {
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
        const decoded = decodeEventLog({ abi: erc20Abi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
        const erc20Value = decoded.args.value as bigint;
        // Only Transfer logs: a receipt can also contain an Approval (0x8c5be1e5…)
        // from the system emitter, which would throw if decoded as a Transfer.
        const sysLogs = receipt.logs.filter(
          (l) =>
            l.address.toLowerCase() === SYSTEM_EMITTER.toLowerCase() &&
            l.topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase(),
        );
        const hasTwin = sysLogs.length > 0;
        if (hasTwin) withTwin += 1;

        // exact match: same from/to, value = erc20Value * 1e12
        let exact = false;
        for (const s of sysLogs) {
          try {
            const d = decodeEventLog({ abi: erc20Abi, topics: [...s.topics], data: s.data });
            if (
              (d.args.from as string).toLowerCase() === (decoded.args.from as string).toLowerCase() &&
              (d.args.to as string).toLowerCase() === (decoded.args.to as string).toLowerCase() &&
              (d.args.value as bigint) === erc20Value * 10n ** 12n
            ) {
              exact = true;
              break;
            }
          } catch {
            // not a decodable Transfer — already filtered by topic, so just skip
          }
        }
        if (exact) twinExact += 1;
        if (twinSamples.length < 3) {
          twinSamples.push(
            `   erc20 ${erc20Value} (6dec) | system logs in receipt: ${sysLogs.length} | exact twin(1e12): ${exact}`,
          );
        }
        found += 1;
        if (found >= 3) break;
      } catch (e) {
        console.log(
          "   skipped sample:",
          (e as Error).message.slice(0, 80),
          "| outer topic0:",
          log.topics[0],
        );
      }
    }
  }
  console.log(twinSamples.join("\n"));
  console.log(`C) RESULT: ${erc20Checked} ERC-20 transfers inspected, ${withTwin} had a system-emitter log, ${twinExact} had an exact from/to/value*1e12 twin`);

  // D) a pure native send: system-emitter log whose tx has NO ERC-20 log
  let nativeChecked = 0;
  let nativeClean = 0;
  const sysRecent = await getLogsWithTopics(client, {
    address: SYSTEM_EMITTER,
    topics: [TRANSFER_TOPIC],
    fromBlock: head - 30n,
    toBlock: head,
  });
  for (const log of sysRecent.slice(0, 10)) {
    if (!log.transactionHash) continue;
    const d = decodeEventLog({ abi: erc20Abi, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
    if ((d.args.from as string).toLowerCase() === (d.args.to as string).toLowerCase()) continue;
    nativeChecked += 1;
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    const hasTokenLog = receipt.logs.some(
      (l) => l.address.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase(),
    );
    if (!hasTokenLog) {
      nativeClean += 1;
      if (nativeClean === 1) {
        console.log(
          `D) pure native sample: from=${d.args.from} to=${d.args.to} value(18dec)=${d.args.value} = ${(d.args.value as bigint) / 10n ** 18n} USDC  txTo=${receipt.to}  hasErc20Log=${hasTokenLog}`,
        );
      }
    }
    if (nativeChecked >= 10) break;
  }
  console.log(`D) RESULT: ${nativeChecked} system-emitter transfers inspected, ${nativeClean} had no ERC-20 log (=> pure native send)`);

}
