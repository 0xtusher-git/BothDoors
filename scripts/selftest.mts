/**
 * BothDoors listener self-test.
 *
 *   npm run test
 *
 * Runs lib/watchUsdcPayments.ts against a synthetic chain that behaves the way
 * Arc does, so acceptance tests 1-5 are checked on every commit and not just on
 * mainnet with a funded wallet.
 *
 * The synthetic chain is built from the shape the live chain actually has
 * (verified by scripts/probe-two-doors.mts against both Arc RPCs):
 *   - an ERC-20 USDC transfer emits an ERC-20 log (6 dec) AND a system-emitter
 *     log (18 dec) with the same from/to and value * 1e12
 *   - a native send emits only a system-emitter log (18 dec)
 */
import { encodeAbiParameters, padHex, type Address, type Hex } from "viem";
import {
  clearSeenPayments,
  decodeTransferLog,
  fetchRecentPayments,
  inferPaymentSource,
  markPaymentsSeen,
  nativeValueToUsdc,
  watchUsdcPayments,
  type PaidEvent,
  type TransferLogLike,
  type UsdcLogClient,
} from "../lib/watchUsdcPayments.ts";
import { USDC_ERC20_ADDRESS } from "../lib/chain.ts";
import { doorFor, EMPTY_FEED, mergeFeed } from "../lib/feed.ts";
import { identifyLegacyProvider, listWallets } from "../lib/wallets.ts";

const SYSTEM_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE" as const;
const MERCHANT = "0x1111111111111111111111111111111111111111" as Address;
const PAYER_A = "0x2222222222222222222222222222222222222222" as Address;
const PAYER_B = "0x3333333333333333333333333333333333333333" as Address;

let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`}`);
  }
}

function topic(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

let nextLogIndex = 0;

/** One system-emitter Transfer log, exactly as Arc emits it. */
function systemTransfer(options: {
  from: string;
  to: string;
  /** 18-decimal native value. */
  value: bigint;
  blockNumber: bigint;
  txHash: Hex;
}): TransferLogLike {
  nextLogIndex += 1;
  return {
    address: SYSTEM_EMITTER,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      topic(options.from),
      topic(options.to),
    ],
    data: padHex(`0x${options.value.toString(16)}`, { size: 32 }),
    blockNumber: options.blockNumber,
    transactionHash: options.txHash,
    logIndex: nextLogIndex,
  };
}

/** An ERC-20 USDC Transfer log. `value` is 6-decimal, as the contract counts it. */
function tokenTransfer(options: {
  from: string;
  to: string;
  /** 6-decimal ERC-20 value. */
  value: bigint;
  blockNumber: bigint;
  txHash: Hex;
}): TransferLogLike {
  nextLogIndex += 1;
  return {
    address: USDC_ERC20_ADDRESS,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      topic(options.from),
      topic(options.to),
    ],
    data: padHex(`0x${options.value.toString(16)}`, { size: 32 }),
    blockNumber: options.blockNumber,
    transactionHash: options.txHash,
    logIndex: nextLogIndex,
  };
}

type FakeChainOptions = {
  head: bigint;
  logs: TransferLogLike[];
  /** Blocks per window the node refuses to serve in one getLogs call. */
  maxBlocksPerQuery?: bigint;
  /**
   * Fail this many `getLogs` calls with the Arc quota error before serving
   * anything, so the throttled-chunk path is exercised for real.
   */
  rateLimitFailures?: number;
};

function fakeChain(options: FakeChainOptions) {
  const maxBlocks = options.maxBlocksPerQuery ?? 5_000n;
  let throttled = 0;
  const calls: { fromBlock: bigint; toBlock: bigint; address: string }[] = [];
  const client: UsdcLogClient = {
    getBlockNumber: async () => options.head,
    getLogs: async ({ address, topics, fromBlock, toBlock }) => {
      calls.push({ fromBlock, toBlock, address });
      if (throttled < (options.rateLimitFailures ?? 0)) {
        throttled += 1;
        // Wording and code taken from a real Arc Testnet refusal.
        const error = new Error("RPC Request failed.");
        Object.assign(error, { code: -32005, shortMessage: "rate limit exceeded" });
        throw error;
      }
      if (toBlock - fromBlock + 1n > maxBlocks) {
        // Same wording the real Arc RPC uses, so the fallback path is exercised
        // against a realistic failure.
        throw new Error(
          `request exceeded max allowed range: query exceeds max results 2000, retry with the range ${fromBlock}-${toBlock}`,
        );
      }
      const [topic0, , topic2] = topics;
      return options.logs.filter((log) => {
        if (log.address.toLowerCase() !== address.toLowerCase()) return false;
        if (topic0 && log.topics[0]?.toLowerCase() !== topic0.toLowerCase()) return false;
        if (topic2 && log.topics[2]?.toLowerCase() !== topic2.toLowerCase()) return false;
        const block = log.blockNumber ?? 0n;
        return block >= fromBlock && block <= toBlock;
      });
    },
  };
  return { client, calls };
}

function receiptClientFor(logs: TransferLogLike[]) {
  return {
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
      logs: logs
        .filter((log) => log.transactionHash === hash)
        .map((log) => ({ address: log.address })),
    }),
  };
}

/** Poll until `count` callbacks arrive, or fail loudly. */
function waitFor(count: number, timeoutMs = 4_000) {
  return new Promise<{ done: boolean; count: number }>((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (emitted.length >= count) {
        resolve({ done: true, count: emitted.length });
        return;
      }
      if (Date.now() - started > timeoutMs) {
        resolve({ done: false, count: emitted.length });
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

let emitted: PaidEvent[] = [];

// ---------------------------------------------------------------------------
console.log("BothDoors listener self-test\n");

// --- acceptance test 1 + 2: both doors are detected -----------------------
console.log("Acceptance 1 and 2 — token pay and native pay both go PAID");
{
  clearSeenPayments(MERCHANT, "t1");
  const tokenTx = "0xaa0000000000000000000000000000000000000000000000000000000000aa01" as Hex;
  const nativeTx = "0xbb0000000000000000000000000000000000000000000000000000000000bb02" as Hex;

  // Door A: ERC-20 USDC transfer of 1 USDC = 1_000_000 (6 dec).
  const erc20Units = 1_000_000n;
  const tokenPair: TransferLogLike[] = [
    {
      address: USDC_ERC20_ADDRESS,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        topic(PAYER_A),
        topic(MERCHANT),
      ],
      data: padHex(`0x${erc20Units.toString(16)}`, { size: 32 }),
      blockNumber: 100n,
      transactionHash: tokenTx,
      logIndex: 1,
    },
    // ...plus the system-emitter twin at 18 decimals, value * 1e12.
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: erc20Units * 10n ** 12n, blockNumber: 100n, txHash: tokenTx }),
  ];

  // Door B: native send of 1 USDC = 1e18. System-emitter log only.
  const nativePair: TransferLogLike[] = [
    systemTransfer({ from: PAYER_B, to: MERCHANT, value: 10n ** 18n, blockNumber: 101n, txHash: nativeTx }),
  ];

  const allLogs = [...tokenPair, ...nativePair];
  const { client } = fakeChain({ head: 200n, logs: allLogs });
  const history = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t1" });

  check("history returns 2 payments", history.events.length === 2, history.events.length);
  const tokenEvent = history.events.find((e) => e.txHash === tokenTx);
  const nativeEvent = history.events.find((e) => e.txHash === nativeTx);
  check("token payment detected", Boolean(tokenEvent), history.events.map((e) => e.txHash));
  check("native payment detected", Boolean(nativeEvent), history.events.map((e) => e.txHash));
  check("newest first", history.events[0]?.txHash === nativeTx, history.events[0]?.txHash);

  // Door labelling: only door A's tx carries an ERC-20 log.
  const doorOfToken = await inferPaymentSource({ publicClient: receiptClientFor(allLogs), txHash: tokenTx });
  const doorOfNative = await inferPaymentSource({ publicClient: receiptClientFor(allLogs), txHash: nativeTx });
  check("token tx labelled 'token'", doorOfToken === "token", doorOfToken);
  check("native tx labelled 'native'", doorOfNative === "native", doorOfNative);
}

// --- acceptance test 3: history on page load ------------------------------
console.log("\nAcceptance 3 — history load shows incoming transfers");
{
  clearSeenPayments(MERCHANT, "t2");
  const logs: TransferLogLike[] = [
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: 5n * 10n ** 18n, blockNumber: 90n, txHash: "0xcc01" }),
    systemTransfer({ from: PAYER_B, to: MERCHANT, value: 2n * 10n ** 17n, blockNumber: 95n, txHash: "0xcc02" }),
    systemTransfer({ from: PAYER_B, to: "0x9999999999999999999999999999999999999999", value: 10n ** 18n, blockNumber: 96n, txHash: "0xcc03" }),
  ];
  const { client } = fakeChain({ head: 1000n, logs });
  const result = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t2" });
  check("only payments to the merchant", result.events.length === 2, result.events.map((e) => e.txHash));
  check("scanned the full 5000-block window by default", result.fromBlock === 0n, {
    fromBlock: result.fromBlock,
    toBlock: result.toBlock,
  });
  check("not truncated when the node is happy", result.truncated === false, result.truncated);
}

// --- acceptance test 3b: the lookback is a real range, read in chunks -------
console.log("\nAcceptance 3b — a node that refuses wide chunks still gets read");
{
  clearSeenPayments(MERCHANT, "t3");
  const logs: TransferLogLike[] = [
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 980n, txHash: "0xdd01" }),
  ];
  // Node refuses anything wider than 100 blocks, like the busy Arc testnet.
  const { client, calls } = fakeChain({ head: 1000n, logs, maxBlocksPerQuery: 100n });
  const result = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t3" });
  check("still returns the payment", result.events.length === 1, result.events.length);
  // A refused chunk is retried smaller rather than abandoned, so the range is
  // covered and the answer is not truncated. This is what the old
  // 5000 -> 2000 -> 500 ladder achieved, but without giving up the lookback.
  check("shrinking chunks cover the whole range", result.truncated === false, result.truncated);
  check("it took more than one chunk", calls.length > 2, calls.length);
  check(
    "and some chunk was narrowed to fit",
    calls.some((c) => c.toBlock - c.fromBlock + 1n <= 100n),
    calls.map((c) => `${c.fromBlock}-${c.toBlock}`).slice(0, 6),
  );
  // Both sources are read, and neither gives up because the other struggled.
  const tokenCalls = calls.filter((c) => c.address === USDC_ERC20_ADDRESS);
  const emitterCalls = calls.filter((c) => c.address === SYSTEM_EMITTER);
  check("both sources are read", tokenCalls.length > 0 && emitterCalls.length > 0, {
    token: tokenCalls.length,
    emitter: emitterCalls.length,
  });
  check(
    "the first token chunk starts at head",
    tokenCalls[0]?.toBlock === 1000n,
    tokenCalls[0] && `${tokenCalls[0].fromBlock}-${tokenCalls[0].toBlock}`,
  );
  check(
    "a failing token chunk does not abort the emitter read",
    emitterCalls.some((c) => c.toBlock === 1000n),
  );
}

console.log("\nAcceptance 3d — an unreadable chunk keeps what was already read");
{
  clearSeenPayments(MERCHANT, "t3d");
  const near = "0xee04000000000000000000000000000000000000000000000000000000000004" as Hex;
  const logs = [
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 990n, txHash: near }),
  ];
  // Refuses everything, even a 25-block chunk, so the walk must stop and admit it.
  const { client } = fakeChain({ head: 1000n, logs, maxBlocksPerQuery: 1n });
  const result = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t3d" });
  check("nothing readable, so nothing claimed", result.events.length === 0, result.events.length);
  check("and truncation is reported honestly", result.truncated === true, result.truncated);
  check("with an error for the UI to show", result.errors.length > 0, result.errors);
}

console.log("\nAcceptance 3c — chunking reaches back past any single-response cap");
{
  // The bug this replaces: the token source was capped at the last 100 blocks, so
  // a payment 400 blocks old was invisible forever. Arc testnet blocks are ~100ms,
  // so 100 blocks is about ten seconds of history.
  clearSeenPayments(MERCHANT, "t3c");
  const tx = "0xee03000000000000000000000000000000000000000000000000000000000003" as Hex;
  const paymentBlock = 400n;
  const head = 5_000n;
  const logs = [
    // A self-send: Arc emits no system-emitter twin, so only the token read can
    // ever see it.
    tokenTransfer({ from: MERCHANT, to: MERCHANT, value: 1_000_000n, blockNumber: paymentBlock, txHash: tx }),
  ];
  // The node will serve any single chunk; only an unchunked 5000-block read fails.
  const { client, calls } = fakeChain({ head, logs, maxBlocksPerQuery: 10_000n });
  const result = await fetchRecentPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t3c",
    allowSelfTransfer: true,
  });
  check("a payment 4600 blocks old is found", result.events.length === 1, result.events.length);
  check("and it is the right one", result.events[0]?.txHash === tx, result.events[0]?.txHash);
  check("the whole lookback was requested", result.fromBlock === 0n && result.toBlock === head, {
    from: result.fromBlock,
    to: result.toBlock,
  });
  const tokenCalls = calls.filter((c) => c.address === USDC_ERC20_ADDRESS);
  check(
    "and it was read in more than one chunk",
    tokenCalls.length > 1,
    tokenCalls.length,
  );
  check(
    "no chunk is wider than the chunk size",
    tokenCalls.every((c) => c.toBlock - c.fromBlock + 1n <= 500n),
    tokenCalls.map((c) => `${c.fromBlock}-${c.toBlock}`),
  );
}

// --- throttling is not an oversized range -----------------------------------
console.log("\nAcceptance test 3e — a throttled chunk is waited out, not shrunk away");
{
  clearSeenPayments(MERCHANT, "t3e");
  const tx = "0xee04000000000000000000000000000000000000000000000000000000000004" as Hex;
  const head = 5_000n;
  const logs = [tokenTransfer({ from: PAYER_A, to: MERCHANT, value: 2_000_000n, blockNumber: 4_600n, txHash: tx })];
  /** Collapse runs of identical ranges, which are retries of one chunk. */
  const ranges = (calls: { fromBlock: bigint; toBlock: bigint }[]) => {
    const all = calls.map((c) => `${c.fromBlock}-${c.toBlock}`);
    return all.filter((r, i) => i === 0 || r !== all[i - 1]);
  };

  // Reading the whole lookback takes 20 chunks, so hitting a shared public quota
  // mid-walk is the normal case rather than an edge case.
  clearSeenPayments(MERCHANT, "t3e-clean");
  const quiet = fakeChain({ head, logs, maxBlocksPerQuery: 10_000n });
  const baseline = await fetchRecentPayments({
    publicClient: quiet.client,
    merchant: MERCHANT,
    dedupeKey: "t3e-clean",
  });

  clearSeenPayments(MERCHANT, "t3e");
  // Same node, same quota, but the first 2 calls are refused outright.
  const busy = fakeChain({ head, logs, maxBlocksPerQuery: 10_000n, rateLimitFailures: 2 });
  const result = await fetchRecentPayments({
    publicClient: busy.client,
    merchant: MERCHANT,
    dedupeKey: "t3e",
  });

  check("the payment survives throttled chunks", result.events.length === 1, result.events.length);
  check("and is the right one", result.events[0]?.txHash === tx, result.events[0]?.txHash);
  check("throttling does not truncate the range", result.truncated === false, result.errors);
  check("the quiet baseline found it too", baseline.events.length === 1, baseline.events.length);

  const busyRanges = ranges(busy.calls);
  const quietRanges = ranges(quiet.calls);

  // The retry has to ask for the same range again. Cutting the range on a 429 is
  // the bug: a quota has nothing to do with how many blocks you asked for, so
  // halving it would only spend the remaining quota faster and give up blocks
  // that had nothing wrong with them. Checked on the raw calls, because
  // collapsing retries is what the comparison below is asserting.
  const repeatedChunk = busy.calls.some(
    (c, i) => i > 0 && c.fromBlock === busy.calls[i - 1]!.fromBlock && c.toBlock === busy.calls[i - 1]!.toBlock,
  );
  check("a refused chunk is re-asked at the identical range", repeatedChunk, busyRanges.slice(0, 3));
  check(
    "throttling costs time, not coverage",
    busyRanges.join(" ") === quietRanges.join(" "),
    { busy: busyRanges.slice(0, 4), quiet: quietRanges.slice(0, 4) },
  );
  check("more requests were made than the quiet run", busy.calls.length > quiet.calls.length, {
    throttled: busy.calls.length,
    quiet: quiet.calls.length,
  });

  // Coverage is the property that actually matters: whatever happens to chunk
  // sizes, no block in the lookback may go unasked.
  const covered = [...busy.calls].sort((a, b) =>
    a.fromBlock === b.fromBlock ? Number(a.toBlock - b.toBlock) : Number(a.fromBlock - b.fromBlock),
  );
  let cursor = 0n;
  let gap = "";
  for (const c of covered) {
    if (c.fromBlock > cursor + 1n) gap += ` ${cursor + 1n}-${c.fromBlock - 1n}`;
    if (c.toBlock > cursor) cursor = c.toBlock;
  }
  check("every block of the lookback was asked for exactly once or more", gap === "", gap);
  check("and the walk reached head", cursor >= head, cursor);
}

// --- the bug this file exists to prevent ------------------------------------
console.log("\nRegression — an ERC-20 transfer Arc does NOT mirror into the emitter");
{
  // Arc emits no system-emitter log for an ERC-20 self-transfer, so the emitter
  // alone is blind to it. Only the ERC-20 contract shows the payment.
  clearSeenPayments(MERCHANT, "t5");
  const tx = "0xaa02000000000000000000000000000000000000000000000000000000000002" as Hex;
  const logs = [
    tokenTransfer({ from: MERCHANT, to: MERCHANT, value: 1_000_000n, blockNumber: 500n, txHash: tx }),
  ];
  const { client } = fakeChain({ head: 510n, logs });

  const history = await fetchRecentPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t5",
    allowSelfTransfer: true,
  });
  check("history finds the unmirrored self-send", history.events.length === 1, history.events.length);
  check("and knows it came from the token contract", history.events[0]?.source === "token-contract", history.events[0]?.source);
  check("6-decimal value lifted to 18 decimals", history.events[0]?.amountUsdc === "1.0", history.events[0]?.amountUsdc);
  check("nativeValue is the 18-decimal amount", history.events[0]?.nativeValue === 10n ** 18n, history.events[0]?.nativeValue);

  // And the poller must see a fresh one too.
  clearSeenPayments(MERCHANT, "t6");
  const tx2 = "0xaa03000000000000000000000000000000000000000000000000000000000003" as Hex;
  const chain2 = fakeChain({
    head: 510n,
    logs: [tokenTransfer({ from: MERCHANT, to: MERCHANT, value: 2_000_000n, blockNumber: 505n, txHash: tx2 })],
  });
  emitted = [];
  const stop = watchUsdcPayments({
    publicClient: chain2.client,
    merchant: MERCHANT,
    dedupeKey: "t6",
    fromBlock: 500n,
    allowSelfTransfer: true,
    pollMs: 15,
    onPaid: (event) => emitted.push(event),
  });
  const got = await waitFor(1, 300);
  stop();
  check("poller finds the unmirrored self-send", got.done && emitted.length === 1, emitted.length);
}

console.log("\nRegression — a transfer mirrored into BOTH logs is still reported once");
{
  clearSeenPayments(MERCHANT, "t7");
  const tx = "0xbb04000000000000000000000000000000000000000000000000000000000004" as Hex;
  // Arc's usual shape: the ERC-20 log plus an exact system-emitter twin.
  const logs = [
    tokenTransfer({ from: PAYER_A, to: MERCHANT, value: 1_000_000n, blockNumber: 500n, txHash: tx }),
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 500n, txHash: tx }),
  ];
  const { client } = fakeChain({ head: 510n, logs });
  const history = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t7" });
  check("both logs, one payment", history.events.length === 1, history.events.length);
  check("the token-contract copy is the one kept", history.events[0]?.source === "token-contract", history.events[0]?.source);
  check("amount is $1.00, not double counted", history.events[0]?.amountUsdc === "1.0", history.events[0]?.amountUsdc);
}

// --- acceptance test 4: no double counting --------------------------------
console.log("\nAcceptance 4 — the same tx is never reported twice");
{
  clearSeenPayments(MERCHANT, "t4");
  const tx = "0xee01000000000000000000000000000000000000000000000000000000000001" as Hex;
  const logs = [systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 500n, txHash: tx })];
  const { client } = fakeChain({ head: 510n, logs });

  const first = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t4" });
  check("history reports it once", first.events.length === 1, first.events.length);

  // The poller starts *before* that block, so it re-reads the same log.
  emitted = [];
  const stop = watchUsdcPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t4",
    fromBlock: 400n,
    pollMs: 15,
    onPaid: (event) => emitted.push(event),
  });
  const result = await waitFor(1, 300);
  await new Promise((r) => setTimeout(r, 80));
  stop();
  check("poller did not re-report the same tx", result.done === false && emitted.length === 0, {
    waitSucceeded: result.done,
    emitted: emitted.length,
  });

  // A genuinely new payment in the same tx-shaped flow still gets through.
  const newTx = "0xee02000000000000000000000000000000000000000000000000000000000002" as Hex;
  logs.push(systemTransfer({ from: PAYER_B, to: MERCHANT, value: 10n ** 18n, blockNumber: 511n, txHash: newTx }));
  const { client: client2 } = fakeChain({ head: 512n, logs });
  emitted = [];
  const stop2 = watchUsdcPayments({
    publicClient: client2,
    merchant: MERCHANT,
    dedupeKey: "t4",
    fromBlock: 505n,
    pollMs: 15,
    onPaid: (event) => emitted.push(event),
  });
  const got = await waitFor(1, 500);
  stop2();
  check("a new tx is still reported", got.done === true && emitted[0]?.txHash === newTx, {
    done: got.done,
    hashes: emitted.map((e) => e.txHash),
  });

  // Two watchers, same merchant+chain, as React StrictMode would create.
  clearSeenPayments(MERCHANT, "t4b");
  const bTx = "0xff0000000000000000000000000000000000000000000000000000000000001" as Hex;
  const bLogs = [systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 700n, txHash: bTx })];
  const { client: c1 } = fakeChain({ head: 701n, logs: bLogs });
  const { client: c2 } = fakeChain({ head: 701n, logs: bLogs });
  const seen1: string[] = [];
  const seen2: string[] = [];
  const stopA = watchUsdcPayments({ publicClient: c1, merchant: MERCHANT, dedupeKey: "t4b", pollMs: 15, onPaid: (e) => seen1.push(e.txHash) });
  const stopB = watchUsdcPayments({ publicClient: c2, merchant: MERCHANT, dedupeKey: "t4b", pollMs: 15, onPaid: (e) => seen2.push(e.txHash) });
  await new Promise((r) => setTimeout(r, 120));
  stopA();
  stopB();
  check("two watchers, one report", seen1.length + seen2.length === 1, { a: seen1.length, b: seen2.length });
}

// --- acceptance test 5: amounts are dollars -------------------------------
console.log("\nAcceptance 5 — 1 USDC displays as 1.00, never 1e12 or 1e-12");
{
  check("1e18 native -> '1.0'", nativeValueToUsdc(10n ** 18n) === "1.0", nativeValueToUsdc(10n ** 18n));
  // The trap the spec warns about: raw units are not dollars.
  check("1e12 native -> '0.000001'", nativeValueToUsdc(10n ** 12n) === "0.000001", nativeValueToUsdc(10n ** 12n));
  check(
    "1e6 native -> '0.000000000001' (never 1e-12)",
    nativeValueToUsdc(10n ** 6n) === "0.000000000001",
    nativeValueToUsdc(10n ** 6n),
  );
  check("1.5e18 -> '1.5'", nativeValueToUsdc(15n * 10n ** 17n) === "1.5", nativeValueToUsdc(15n * 10n ** 17n));
  check("0 -> '0.0'", nativeValueToUsdc(0n) === "0.0", nativeValueToUsdc(0n));

  clearSeenPayments(MERCHANT, "t5");
  const logs = [
    systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 300n, txHash: "0x1a01" }),
    systemTransfer({ from: PAYER_B, to: MERCHANT, value: 1_000_000n * 10n ** 12n, blockNumber: 301n, txHash: "0x1a02" }),
  ];
  const { client } = fakeChain({ head: 400n, logs });
  const result = await fetchRecentPayments({ publicClient: client, merchant: MERCHANT, dedupeKey: "t5" });
  check("both read as exactly 1.0", result.events.every((e) => e.amountUsdc === "1.0"), result.events.map((e) => e.amountUsdc));
  check("6-decimal 1 USDC lifted to 18 dec is identical", result.events[0]?.nativeValue === result.events[1]?.nativeValue, {
    a: result.events[0]?.nativeValue,
    b: result.events[1]?.nativeValue,
  });
}

// --- ignore rules --------------------------------------------------------
console.log("\nIgnore rules — zero value, self-sends, wrong recipient");
{
  const zero = systemTransfer({ from: PAYER_A, to: MERCHANT, value: 0n, blockNumber: 10n, txHash: "0x2a01" });
  const self = systemTransfer({ from: MERCHANT, to: MERCHANT, value: 10n ** 18n, blockNumber: 11n, txHash: "0x2a02" });
  const other = systemTransfer({ from: PAYER_A, to: PAYER_B, value: 10n ** 18n, blockNumber: 12n, txHash: "0x2a03" });
  const good = systemTransfer({ from: PAYER_A, to: MERCHANT, value: 10n ** 18n, blockNumber: 13n, txHash: "0x2a04" });
  const notTransfer = { ...good, topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200da5ea60b7c" as Hex], transactionHash: "0x2a05" as Hex };

  const opts = { merchant: MERCHANT, minAmountUsdc: "0", allowSelfTransfer: false };
  check("zero value ignored", decodeTransferLog(zero, opts) === null);
  check("self-send ignored by default", decodeTransferLog(self, opts) === null);
  check("self-send allowed in demo mode", decodeTransferLog(self, { ...opts, allowSelfTransfer: true }) !== null);
  check("other recipient ignored", decodeTransferLog(other, opts) === null);
  check("Approval log ignored", decodeTransferLog(notTransfer, opts) === null);
  check("valid transfer decoded", decodeTransferLog(good, opts)?.txHash === "0x2a04");

  const minOne = decodeTransferLog(systemTransfer({ from: PAYER_A, to: MERCHANT, value: 5n * 10n ** 17n, blockNumber: 14n, txHash: "0x2a06" }), { merchant: MERCHANT, minAmountUsdc: "1" });
  check("below minAmountUsdc ignored", minOne === null);
  check("minAmountUsdc defaults to zero (all transfers)", decodeTransferLog(good, { merchant: MERCHANT }) !== null);
}

// --- encoding sanity: topics are lowercase 32-byte ------------------------
console.log("\nTopic encoding");
{
  clearSeenPayments(MERCHANT, "t7");
  const checksummedMerchant = MERCHANT;
  const logs = [systemTransfer({ from: PAYER_A, to: checksummedMerchant, value: 10n ** 18n, blockNumber: 20n, txHash: "0x3a01" })];
  const { client } = fakeChain({ head: 30n, logs });
  const result = await fetchRecentPayments({ publicClient: client, merchant: checksummedMerchant, dedupeKey: "t7" });
  check("mixed-case address still matches the padded topic", result.events.length === 1, result.events.length);
  const padded = encodeAbiParameters([{ type: "address" }], [MERCHANT]);
  check("addressToTopic equals viem's own encoding", `0x${MERCHANT.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` === padded, padded);
}

// --- the counting the UI actually does -------------------------------------
console.log("\nFeed counting — one tx is one row, and the total is honest");
{
  const ev = (txHash: Hex, blockNumber: bigint, source: PaidEvent["source"] = "token-contract"): PaidEvent => ({
    from: PAYER_A,
    to: MERCHANT,
    amountUsdc: "1.0",
    nativeValue: 10n ** 18n,
    txHash,
    blockNumber,
    source,
  });

  const PRICE = 10n ** 18n;
  // The history read and the poller overlap by design, and StrictMode runs the
  // mount effect twice. Both re-offer the same payments.
  let feed = mergeFeed(EMPTY_FEED, [ev("0xa1", 100n), ev("0xa2", 101n)], 20, PRICE);
  check("two payments, two rows", feed.rows.length === 2 && feed.total === 2, feed.total);
  const again = mergeFeed(feed, [ev("0xa1", 100n), ev("0xa2", 101n)], 20, PRICE);
  check("re-offering the same two changes nothing", again === feed, `${again.total}`);
  check("still two rows", again.rows.length === 2, again.rows.length);

  // One overlap, one new.
  const mixed = mergeFeed(feed, [ev("0xa2", 101n), ev("0xa3", 102n)], 20, PRICE);
  check("an overlapping batch adds only the new one", mixed.total === 3, mixed.total);
  check("and only one row for it", mixed.rows.length === 3, mixed.rows.length);

  // The count must not be capped by the display cap.
  const many = Array.from({ length: 34 }, (_, i) => ev(`0xb${i}`, BigInt(200 + i)));
  const capped = mergeFeed(EMPTY_FEED, many, 20, PRICE);
  check("34 payments: 20 shown", capped.rows.length === 20, capped.rows.length);
  check("34 payments: total says 34, not 20", capped.total === 34, capped.total);
  check("newest first", capped.rows[0]?.txHash === "0xb33", capped.rows[0]?.txHash);

  // The dedupe set has to outlive the display window. History is read with
  // `markSeen: false`, and StrictMode re-runs that read, so the full 34 come back
  // a second time — including the 14 that scrolled out of the 20-row window.
  // Rebuilding the set from `rows` would count those 14 twice: 68 for 34 payments.
  const recapped = mergeFeed(capped, many, 20, PRICE);
  check("re-reading a capped feed does not double-count", recapped.total === 34, recapped.total);
  check("and does not grow the rows", recapped.rows.length === 20, recapped.rows.length);
  const recappedTwice = mergeFeed(recapped, many, 20, PRICE);
  check("nor a third time", recappedTwice.total === 34, recappedTwice.total);
  check("the evicted hashes are still remembered", recappedTwice.seen.size === 34, recappedTwice.seen.size);
  // A genuinely new payment still counts after the window has rolled over.
  const afterRollover = mergeFeed(recappedTwice, [ev("0xd9", 999n)], 20, PRICE);
  check("new payment after rollover counts once", afterRollover.total === 35, afterRollover.total);

  // Ordering survives a merge that arrives out of order.
  const unordered = mergeFeed(EMPTY_FEED, [ev("0xc1", 10n), ev("0xc3", 30n), ev("0xc2", 20n)], 20, PRICE);
  check(
    "sorted newest first",
    unordered.rows.map((r) => r.txHash).join(",") === "0xc3,0xc2,0xc1",
    unordered.rows.map((r) => r.txHash),
  );

  // Door comes from the log source, no receipt lookup needed.
  check("a token-contract log knows its door", doorFor(ev("0xd1", 1n)) === "token", doorFor(ev("0xd1", 1n)));
  check("an emitter log stays unknown until looked up", doorFor(ev("0xd2", 1n, "system-emitter")) === "unknown");

  // The door must not be derived from the display window. A busy merchant pushes
  // the paying transaction out of the 20-row feed within seconds of it landing,
  // and a shop that forgets it was ever paid is worse than one that never saw it.
  // Every payment after the first here is dust, so only the oldest one pays.
  const payer = ev("0xp1", 10n);
  payer.nativeValue = PRICE;
  const dust = Array.from({ length: 40 }, (_, i) => {
    const row = ev(`0xdust${i}`, BigInt(100 + i));
    row.nativeValue = 1n;
    return row;
  });

  let shop = mergeFeed(EMPTY_FEED, [payer], 20, PRICE);
  check("a full payment opens the door", shop.qualifying?.txHash === "0xp1", shop.qualifying?.txHash);

  shop = mergeFeed(shop, dust, 20, PRICE);
  check("40 newer dust payments do not close it", shop.qualifying?.txHash === "0xp1", shop.qualifying?.txHash);
  check(
    "and the paying row really did scroll out of the window",
    !shop.rows.some((r) => r.txHash === "0xp1"),
    shop.rows.length,
  );
  check("while still being counted exactly once", shop.total === 41, shop.total);

  check(
    "dust alone never opens the door",
    mergeFeed(EMPTY_FEED, dust, 20, PRICE).qualifying === null,
    "opened",
  );

  // The card should describe the most recent qualifying payment.
  const payer2 = ev("0xp2", 11n);
  payer2.nativeValue = PRICE * 2n;
  check(
    "the newest qualifying payment is the one reported",
    mergeFeed(shop, [payer2], 20, PRICE).qualifying?.txHash === "0xp2",
    "wrong pick",
  );

  // A new merchant must start closed, which is what EMPTY_FEED means.
  check("resetting clears the qualifying payment", EMPTY_FEED.qualifying === null, EMPTY_FEED.qualifying);
}

// --- a discarded history read must not swallow the payment -----------------
console.log("\nRecovery — an abandoned history read does not lose the payment");
{
  clearSeenPayments(MERCHANT, "t8");
  const tx = "0xcc05000000000000000000000000000000000000000000000000000000000005" as Hex;
  const logs = [
    tokenTransfer({ from: MERCHANT, to: MERCHANT, value: 1_000_000n, blockNumber: 500n, txHash: tx }),
  ];
  const { client } = fakeChain({ head: 510n, logs });

  // What React StrictMode does: the first mount's read resolves, but the caller
  // has already been torn down and throws the result away. If the fetch claimed
  // the tx hash on the way out, no later read can ever report it again.
  const abandoned = await fetchRecentPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t8",
    allowSelfTransfer: true,
    markSeen: false,
  });
  check("the abandoned read saw it", abandoned.events.length === 1, abandoned.events.length);

  // The second mount reads again and finds nothing, because the first one already
  // claimed it. This is the bug: silent, permanent loss.
  const withoutCommit = await fetchRecentPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t8",
    allowSelfTransfer: true,
  });
  check("a read that never committed loses nothing", withoutCommit.events.length === 1, withoutCommit.events.length);

  // The real flow: commit after the rows are rendered, and a later read skips it.
  markPaymentsSeen(MERCHANT, [tx], "t8");
  const afterCommit = await fetchRecentPayments({
    publicClient: client,
    merchant: MERCHANT,
    dedupeKey: "t8",
    allowSelfTransfer: true,
  });
  check("once committed it is not repeated", afterCommit.events.length === 0, afterCommit.events.length);
}

// --- wallet discovery ------------------------------------------------------
// listWallets only reads a few fields, so a partial object cast is enough and the
// tests stay free of wagmi's machinery.
const fakeConnector = (fields: { id: string; name: string; type?: string; icon?: string }) =>
  fields as unknown as Parameters<typeof listWallets>[0][number];

const generic = fakeConnector({ id: "injected", name: "Injected", type: "injected" });
const metaMask = fakeConnector({ id: "io.metamask", name: "MetaMask", type: "injected" });
const okx = fakeConnector({ id: "com.okex.wallet", name: "OKX Wallet", type: "injected" });
const phantom = fakeConnector({ id: "app.phantom", name: "Phantom", type: "injected" });

const withSeveral = listWallets([generic, metaMask, okx, phantom]);
check(
  "the catch-all connector is hidden when real wallets are known",
  withSeveral.every((w) => !w.generic) && withSeveral.length === 3,
  withSeveral.map((w) => `${w.name}${w.generic ? "(generic)" : ""}`),
);
check(
  "every installed wallet is offered",
  ["MetaMask", "OKX Wallet", "Phantom"].every((n) => withSeveral.some((w) => w.name === n)),
  withSeveral.map((w) => w.name),
);
check(
  "the catch-all connector is still offered when it is the only wallet",
  listWallets([generic]).length === 1 && listWallets([generic])[0]?.generic === true,
  listWallets([generic]).map((w) => w.name),
);
check(
  "no wallet at all yields no rows",
  listWallets([]).length === 0,
  listWallets([]).length,
);
check(
  "the same wallet reaching the list twice is shown once",
  listWallets([metaMask, metaMask, okx]).length === 2,
  listWallets([metaMask, metaMask, okx]).map((w) => w.name),
);
check(
  "a non-injected connector is never mistaken for the catch-all",
  listWallets([generic, fakeConnector({ id: "walletConnect", name: "WalletConnect", type: "walletConnect" })])
    .every((w) => !w.generic),
  "a named connector was hidden",
);
check(
  "a wallet icon is carried through",
  listWallets([fakeConnector({ id: "x", name: "X", type: "injected", icon: "data:image/png;base64,AA" })])[0]?.icon ===
    "data:image/png;base64,AA",
  "icon lost",
);

// Brand detection for wallets too old to announce themselves.
const providerWith = (flags: Record<string, unknown>) => ({ request: () => {}, ...flags });
check(
  "Phantom is not mistaken for MetaMask",
  identifyLegacyProvider(providerWith({ isMetaMask: true, isPhantom: true }), 0)?.name === "Phantom",
  identifyLegacyProvider(providerWith({ isMetaMask: true, isPhantom: true }), 0)?.name,
);
check(
  "OKX is recognised under either of its two flags",
  identifyLegacyProvider(providerWith({ isMetaMask: true, isOkxWallet: true }), 0)?.name === "OKX Wallet" &&
    identifyLegacyProvider(providerWith({ isOKExWallet: true }), 0)?.name === "OKX Wallet",
  "OKX not detected",
);
check(
  "MetaMask is only claimed when nothing more specific is present",
  identifyLegacyProvider(providerWith({ isMetaMask: true }), 0)?.name === "MetaMask" &&
    identifyLegacyProvider(providerWith({ isMetaMask: true, isCoinbaseWallet: true }), 0)?.name ===
      "Coinbase Wallet",
  "MetaMask flag misread",
);
check(
  "an unrecognised wallet is still offered, distinctly",
  identifyLegacyProvider(providerWith({}), 0)?.name === "Browser Wallet" &&
    identifyLegacyProvider(providerWith({}), 0)?.rdns !==
      identifyLegacyProvider(providerWith({}), 1)?.rdns,
  "two unknown wallets collided",
);
check(
  "something without request() is not a wallet",
  identifyLegacyProvider({}, 0) === null && identifyLegacyProvider(null, 0) === null,
  "a non-provider was accepted",
);

// --- a payment from history must not open the door --------------------------
// The reported bug: the shop showed PAID ~2s after pressing "Pay $1 as native",
// with no transaction ever made. Nothing was fabricated — the 5000-block
// history read found a real earlier $1 payment and merged it through the same
// path the poller uses, so the door opened before the user pressed anything and
// both pay buttons (which are disabled once paid) silently did nothing.
console.log("\nSession boundary - old payments are history, not this session");

const oldPayment = decodeTransferLog(
  systemTransfer({
    from: PAYER_B,
    to: MERCHANT,
    value: 10n ** 18n,
    blockNumber: 500n,
    txHash: "0x0d5e7100" as Hex,
  }),
  { merchant: MERCHANT },
);
const freshPayment = decodeTransferLog(
  systemTransfer({
    from: PAYER_B,
    to: MERCHANT,
    value: 10n ** 18n,
    blockNumber: 900n,
    txHash: "0x0f5e7100" as Hex,
  }),
  { merchant: MERCHANT },
);
if (oldPayment === null || freshPayment === null) throw new Error("test setup failed to decode");

// A payment made *after* the boundary is re-armed. A distinct tx hash matters:
// re-reporting one already in the feed is deduped, which would make the check pass
// for the wrong reason.
const afterReArm = decodeTransferLog(
  systemTransfer({
    from: PAYER_A,
    to: MERCHANT,
    value: 10n ** 18n,
    blockNumber: 1100n,
    txHash: "0x115e7100" as Hex,
  }),
  { merchant: MERCHANT },
);
if (afterReArm === null) throw new Error("test setup failed to decode the post-re-arm payment");

const sessionStart = 800n;
const withOldHistory = mergeFeed(EMPTY_FEED, [oldPayment], 20, 10n ** 18n, sessionStart);
check(
  "an old payment is still shown",
  withOldHistory.rows.length === 1 && withOldHistory.total === 1,
  withOldHistory.rows.length,
);
check(
  "an old payment does NOT mark the shop paid",
  withOldHistory.qualifying === null,
  withOldHistory.qualifying?.txHash,
);
check(
  "a payment from this session does mark it paid",
  mergeFeed(EMPTY_FEED, [freshPayment], 20, 10n ** 18n, sessionStart).qualifying?.txHash ===
    freshPayment.txHash,
  "session payment ignored",
);
check(
  "history arriving after a session payment cannot steal the door",
  mergeFeed(
    mergeFeed(EMPTY_FEED, [freshPayment], 20, 10n ** 18n, sessionStart),
    [oldPayment],
    20,
    10n ** 18n,
    sessionStart,
  ).qualifying?.txHash === freshPayment.txHash,
  "an old payment took over as qualifying",
);
check(
  "an old payment on its own leaves the shop unpaid even with a stale feed",
  mergeFeed(withOldHistory, [oldPayment], 20, 10n ** 18n, sessionStart).qualifying === null,
  "qualifying reappeared",
);

// Starting a new attempt moves the boundary forward. An already-set qualifying
// payment is sticky so a reload keeps the proof of a payment you just made, but
// once the boundary passes it, that payment is no longer this session's and must
// be dropped even with no new rows to trigger the merge.
const paidEarlier = mergeFeed(EMPTY_FEED, [freshPayment], 20, 10n ** 18n, sessionStart);
check(
  "a payment made in this session keeps the shop paid",
  paidEarlier.qualifying?.txHash === freshPayment.txHash,
  "the payment was lost immediately",
);
check(
  "re-arming the session clears a qualifying payment from an earlier visit",
  mergeFeed(paidEarlier, [], 20, 10n ** 18n, 1000n).qualifying === null,
  "the old payment still held the door open",
);
check(
  "the rows stay on screen after re-arming, only the door re-locks",
  mergeFeed(paidEarlier, [], 20, 10n ** 18n, 1000n).rows.length === paidEarlier.rows.length,
  "history was thrown away instead of demoted",
);
// The case that must NOT regress: reload straight after paying.
check(
  "a reload after paying keeps the shop paid",
  mergeFeed(paidEarlier, [], 20, 10n ** 18n, sessionStart).qualifying?.txHash === freshPayment.txHash,
  "a reload dropped a payment that had just been made",
);
check(
  "a payment newer than a re-armed boundary still opens the door",
  mergeFeed(
    mergeFeed(paidEarlier, [], 20, 10n ** 18n, 1000n),
    [afterReArm!],
    20,
    10n ** 18n,
    1000n,
  ).qualifying?.txHash === afterReArm.txHash,
  "the payment made after the re-arm was ignored",
);
check(
  "the re-armed attempt does not have to wait for a reload to pay",
  mergeFeed(
    mergeFeed(paidEarlier, [], 20, 10n ** 18n, 1000n),
    [afterReArm!],
    20,
    10n ** 18n,
    1000n,
  ).qualifying !== null,
  "a live payment after a re-arm never opened the door",
);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);