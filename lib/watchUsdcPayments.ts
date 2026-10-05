import { parseUnits, type Address, type Hash, type Hex } from "viem";

/**
 * BothDoors — the USDC payment listener.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * On Arc, USDC is one asset with two send paths:
 *
 *   Path A "as token"   -> USDC.transfer(...)  emits Transfer from the ERC-20
 *                           contract 0x3600…0000, value in 6 decimals.
 *   Path B "as native"  -> sendTransaction({ value })  emits Transfer from the
 *                           EIP-7708 system emitter, value in 18 decimals.
 *
 * A shop that only watches the ERC-20 contract marks Path B as unpaid, forever.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 * Arc's EIP-7708 system emitter 0xffff…fffe emits a Transfer log with 18-decimal
 * value for EVERY movement of the native currency — INCLUDING the ones caused by
 * an ERC-20 USDC transfer. So:
 *
 *   native send   -> 1 system-emitter Transfer (18 dec)
 *   ERC-20 send   -> 1 ERC-20 Transfer (6 dec)  +  usually 1 system-emitter twin
 *
 * The system emitter covers both doors in one decimal base, which is elegant —
 * but on its own it is NOT sufficient. Measured against Arc testnet, a
 * self-transfer of ERC-20 USDC emits NO system-emitter log at all: the receipt
 * holds only the ERC-20 Transfer. An emitter-only listener therefore never sees
 * it, which is exactly what the demo's own self-pay path does.
 *
 * So both log sources are read. Events are lifted into a common 18-decimal base
 * and deduped by tx hash, so a mirrored payment is still reported exactly once
 * while an unmirrored one is never missed.
 *
 * ---------------------------------------------------------------------------
 * ACCEPTANCE TESTS (see README for the same list with manual steps)
 * ---------------------------------------------------------------------------
 *  1. Token pay of 1 USDC -> shop becomes PAID
 *     Read from the ERC-20 contract, whether or not Arc mirrors it into the
 *     system emitter.
 *  2. Native pay of 1 USDC -> shop becomes PAID
 *     A native send is a system-emitter Transfer and nothing else. Covered.
 *  3. History load shows incoming transfers to the merchant
 *     fetchRecentPayments() reads the last ~5000 blocks on page load.
 *  4. The same tx is never reported twice
 *     A Set of tx hashes per merchant+chain, shared between the history load and
 *     the poller (and it survives React StrictMode remounts). This is what keeps
 *     the two log sources from double-counting a mirrored payment.
 *  5. Amount displays as 1 USDC, not 1e12 and not 1e-12
 *     nativeValue is 18 decimals; amountUsdc is formatUnits(nativeValue, 18).
 *  6. Wrong network blocks the pay buttons
 *     Enforced in the UI; the listener itself is chain-agnostic and only ever
 *     reads logs from the client you hand it.
 * ---------------------------------------------------------------------------
 */

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC: Hex =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * EIP-7708 system emitter on Arc. Every native-currency Transfer log on the
 * chain carries this address as its emitter — for native sends and for ERC-20
 * USDC transfers alike. This is the address we filter `address` on.
 */
export const SYSTEM_EMITTER: Address = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";

/**
 * The ERC-20 USDC contract.
 *
 * Read as a log source in its own right, not just to tell "token" from "native":
 * Arc only *sometimes* mirrors an ERC-20 transfer into the system emitter (a
 * self-transfer emits no emitter log), so watching the emitter alone misses real
 * payments.
 */
export const USDC_ERC20_ADDRESS: Address = "0x3600000000000000000000000000000000000000";

/** 6-decimal ERC-20 units -> 18-decimal native units: 1e6 -> 1e18. */
const ERC20_TO_NATIVE = 10n ** 12n;

/**
 * Both log sources, token contract first.
 *
 * Token-first matters: when a payment is mirrored into both logs, the ERC-20 log
 * proves the door on its own, so we keep that event and skip the receipt lookup
 * the emitter-only path would need.
 *
 * The 3-element topics shape is required: the Arc RPCs silently ignore `topics`
 * arrays shorter than 3, so `[TRANSFER_TOPIC]` alone would return Approval logs.
 */
const LOG_SOURCES: readonly Address[] = [USDC_ERC20_ADDRESS, SYSTEM_EMITTER];

/**
 * Chunk size for `readSourceChunked`, per source.
 *
 * Measured on the live Arc testnet (2026-10-03): the node ignores `topics` for
 * BOTH addresses and returns ~3 logs per block regardless, so the only thing
 * that keeps a query alive is staying under its ~10MB response cap — roughly
 * 9000 logs. Log density is not steady: the same 700-block range measured 8.1
 * logs/block at one moment and 2.9 at another, a 3x swing. These sizes are set
 * for the bad case, not the good one, so a density spike costs a chunk rather
 * than the whole read.
 */
const TOKEN_CHUNK_BLOCKS = 500n;
const EMITTER_CHUNK_BLOCKS = 500n;
/** Below this a chunk is not worth retrying; the walk gives up and says so. */
const MIN_CHUNK_BLOCKS = 25n;
export const USDC_NATIVE_DECIMALS = 18;

export const DEFAULT_POLL_MS = 2_000;
export const DEFAULT_LOOKBACK_BLOCKS = 5_000n;

/** Re-scan a few already-seen blocks each poll so a reorg cannot hide a payment. */
const REORG_REWIND_BLOCKS = 5n;
/** Give the public RPC some room when it starts answering 429. */
const MAX_POLL_BACKOFF_MS = 15_000;
/**
 * A throttled chunk is re-asked this many times, waiting between attempts.
 * The public testnet RPC shares one quota across everyone, so throttling is
 * routine rather than exceptional.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 500;

/**
 * Re-ask an RPC call that was refused for quota reasons.
 *
 * Only throttled failures are retried: an oversized-range refusal is a property of
 * the request and retrying it identically just wastes quota, so that has to be
 * answered by asking for less. Exported because the verification scripts talk to
 * the same shared public RPC and would otherwise crash on a routine 429.
 */
export async function retryWhenThrottled<T>(
  call: () => Promise<T>,
  options: { retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = options.retries ?? RATE_LIMIT_RETRIES;
  const backoff = options.backoffMs ?? RATE_LIMIT_BACKOFF_MS;
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isThrottled(error) || attempt >= retries) throw error;
      await wait(backoff * 2 ** attempt);
    }
  }
}

/**
 * Every scrap of text an RPC refusal carries, including its causes.
 *
 * viem wraps the useful part: `message` is the flat "RPC Request failed.", while
 * the quota code, the `details` sentence and the nested cause hold what actually
 * distinguishes a throttle from an oversized range. Reading only `message`
 * would classify a 429 as a size problem and shrink the range into a refusal.
 */
function errorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined || depth > 4) return "";
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "shortMessage", "details", "code", "status"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") parts.push(String(value));
  }
  if (record.cause !== undefined) parts.push(errorText(record.cause, depth + 1));
  return parts.join(" ");
}

/**
 * Is this refusal about our request size, or about how many requests we owe?
 *
 * Only the second is worth waiting out.
 */
function isThrottled(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("rate-limit") ||
    text.includes("too many requests") ||
    text.includes("-32005") ||
    text.includes("429") ||
    text.includes("quota") ||
    text.includes("exceeded the limit")
  );
}

export type PaidEvent = {
  from: `0x${string}`;
  to: `0x${string}`;
  amountUsdc: string; // human dollars, e.g. "1.0"
  nativeValue: bigint; // 18 decimals
  txHash: `0x${string}`;
  blockNumber: bigint;
  /**
   * Which log produced this event.
   *
   * "token-contract" = read straight from the ERC-20 USDC contract (6 decimals).
   * "system-emitter" = read from the EIP-7708 emitter (18 decimals).
   *
   * Arc does NOT always mirror an ERC-20 transfer into the system emitter — a
   * self-transfer emits no emitter log at all — so a listener that only watches
   * the emitter is blind to a real payment. Both doors are read; dedupe is by
   * tx hash, so a mirrored payment is still reported exactly once.
   */
  source: "token-contract" | "system-emitter";
};

/** "token" = also carried an ERC-20 USDC Transfer. "native" = value send only. */
export type PaymentSource = "token" | "native" | "unknown";

export type WatchState = {
  /** Highest block this watcher has read to. */
  cursor: bigint | null;
  /** True while a getLogs round-trip is in flight. */
  busy: boolean;
  polls: number;
  lastPollAt: number | null;
  lastError: string | null;
};

export type TransferLogLike = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
};

/**
 * The slice of a viem PublicClient this file needs. Declared structurally so a
 * real `PublicClient`, a wagmi `usePublicClient()` result, or a hand-rolled
 * read-only client all satisfy it.
 */
export type UsdcLogClient = {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (args: {
    address: Address;
    topics: readonly (Hex | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly TransferLogLike[]>;
};

export type UsdcReceiptClient = {
  getTransactionReceipt: (args: {
    hash: Hash;
  }) => Promise<{ logs: readonly { address: Address }[] }>;
};

// ---------------------------------------------------------------------------
// Dedup registry
// ---------------------------------------------------------------------------

/**
 * Shared across every watcher for a given chain+merchant, so a log that already
 * came back from fetchRecentPayments() cannot come back through the poller, and
 * so a React StrictMode double-mount cannot fire onPaid twice.
 * (Acceptance test 4.)
 */
const seenByScope = new Map<string, Set<string>>();

function scopeKey(merchant: Address, dedupeKey?: string): string {
  const base = merchant.toLowerCase();
  return dedupeKey ? `${dedupeKey}:${base}` : base;
}

function seenSetFor(merchant: Address, dedupeKey?: string): Set<string> {
  const key = scopeKey(merchant, dedupeKey);
  let set = seenByScope.get(key);
  if (!set) {
    set = new Set<string>();
    seenByScope.set(key, set);
  }
  return set;
}

/**
 * Claim tx hashes as already reported, after the caller has actually committed
 * them to its UI.
 *
 * Pair this with `fetchRecentPayments({ markSeen: false })` when the caller can
 * throw a result away — a cancelled read, or a React StrictMode remount. Marking
 * seen inside the fetch means a discarded read has already swallowed the payment
 * and nothing will ever report it again.
 */
export function markPaymentsSeen(
  merchant: Address,
  txHashes: readonly string[],
  dedupeKey?: string,
): void {
  const seen = seenSetFor(merchant, dedupeKey);
  for (const hash of txHashes) seen.add(hash);
}

/** Forget everything already reported for a merchant. Mainly for tests. */
export function clearSeenPayments(merchant?: Address, dedupeKey?: string): void {
  if (!merchant) {
    seenByScope.clear();
    return;
  }
  seenByScope.delete(scopeKey(merchant, dedupeKey));
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Left-pad a 20-byte address into a 32-byte topic. Topics are lowercased on chain. */
export function addressToTopic(address: string): Hex {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return `0x${hex.padStart(64, "0")}`;
}

function topicToAddress(topic: Hex): Address {
  return `0x${topic.replace(/^0x/, "").slice(-40).toLowerCase()}` as Address;
}

/** Human dollars from an 18-decimal system-emitter value. (Acceptance test 5.) */
export function nativeValueToUsdc(nativeValue: bigint): string {
  const negative = nativeValue < 0n;
  const abs = negative ? -nativeValue : nativeValue;
  const whole = abs / 10n ** 18n;
  const fraction = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction.length > 0 ? fraction : "0"}`;
}

type DecodeOptions = {
  merchant: Address;
  minAmountUsdc?: string;
  allowSelfTransfer?: boolean;
};

/**
 * Turn one raw log into a PaidEvent, or null if it should be ignored.
 * Ignores: non-Transfer logs, the wrong `to`, zero value, from == to,
 * anything below minAmountUsdc.
 */
export function decodeTransferLog(
  log: TransferLogLike,
  options: DecodeOptions,
): PaidEvent | null {
  const { merchant, minAmountUsdc = "0", allowSelfTransfer = false } = options;

  if (log.topics.length < 3) return null;
  const [topic0, fromTopic, toTopic] = log.topics;
  if (topic0 === undefined || fromTopic === undefined || toTopic === undefined) return null;
  if (topic0.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!log.transactionHash) return null;

  const from = topicToAddress(fromTopic);
  const to = topicToAddress(toTopic);
  if (to !== merchant.toLowerCase()) return null;

  // Ignore self-sends. A merchant crediting its own withdrawal is a real bug in
  // naive listeners, so it is off by default. The demo turns it on only when the
  // merchant IS the connected wallet, so one person can test alone.
  if (!allowSelfTransfer && from === to) return null;

  const value = BigInt(log.data === "0x" ? "0x0" : log.data);
  if (value <= 0n) return null;

  // The ERC-20 contract counts in 6 decimals; the system emitter counts in 18.
  // Lift both into the same 18-decimal base so amounts compare and format alike.
  const isTokenContract =
    typeof log.address === "string" &&
    log.address.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase();
  const nativeValue = isTokenContract ? value * ERC20_TO_NATIVE : value;

  const amountUsdc = nativeValueToUsdc(nativeValue);
  if (minAmountUsdc !== "0") {
    const min = parseUnits(minAmountUsdc, USDC_NATIVE_DECIMALS);
    if (nativeValue < min) return null;
  }

  return {
    from,
    to,
    amountUsdc,
    nativeValue,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber ?? 0n,
    source: isTokenContract ? "token-contract" : "system-emitter",
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FetchPaymentsOptions = DecodeOptions & {
  publicClient: UsdcLogClient;
  /** How far back to read. Read in chunks, so a wide range is fine. */
  lookbackBlocks?: bigint;
  dedupeKey?: string;
  /** Record these tx hashes as seen so the poller will not repeat them. Default true. */
  markSeen?: boolean;
  onError?: (error: unknown) => void;
};

export type FetchPaymentsResult = {
  /** Newest first. */
  events: PaidEvent[];
  /** First block scanned. */
  fromBlock: bigint;
  /** Last block scanned (chain head at call time). */
  toBlock: bigint;
  /**
   * True when a chunk could not be read, so the range is shorter than the one
   * asked for. The UI says so rather than pretending the history is complete.
   */
  truncated: boolean;
  /** Ranges the node rejected, newest error last. */
  errors: string[];
};

/**
 * Load recent incoming payments — the page-load history.
 *
 * Both log sources are read over the full lookback in fixed-size chunks, newest
 * first, because the Arc testnet node ignores `topics` on both addresses and
 * refuses any single query big enough to matter. Chunking means the lookback is
 * a real range rather than whatever fitted in one response, which is what lets a
 * payment made minutes ago still be there after a reload. (Acceptance test 3.)
 */
export async function fetchRecentPayments(
  options: FetchPaymentsOptions,
): Promise<FetchPaymentsResult> {
  const {
    publicClient,
    merchant,
    lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
    onError,
  } = options;

  const head = await publicClient.getBlockNumber();
  const topics = [TRANSFER_TOPIC, null, addressToTopic(merchant)] as const;
  const errors: string[] = [];
  const toBlock = head;
  const fromBlock = head > lookbackBlocks ? head - lookbackBlocks + 1n : 0n;

  // The ERC-20 contract is read first, and its events are listed first, so that a
  // payment Arc mirrors into BOTH logs dedupes down to the ERC-20 event — the one
  // that already knows which door it came through, with no receipt lookup.
  const tokenRead = await readSourceChunked({
    publicClient,
    address: USDC_ERC20_ADDRESS,
    topics,
    fromBlock,
    toBlock,
    chunkBlocks: TOKEN_CHUNK_BLOCKS,
    onError,
  });
  const emitterRead = await readSourceChunked({
    publicClient,
    address: SYSTEM_EMITTER,
    topics,
    fromBlock,
    toBlock,
    chunkBlocks: EMITTER_CHUNK_BLOCKS,
    onError,
  });
  for (const error of [tokenRead, emitterRead]) if (!error.complete) errors.push("incomplete log read");

  const events = [
    ...collect(tokenRead.logs, { ...options, merchant }),
    ...collect(emitterRead.logs, { ...options, merchant }),
  ];

  return {
    events: dedupeEvents(events, options),
    fromBlock,
    toBlock,
    truncated: !tokenRead.complete || !emitterRead.complete,
    errors,
  };
}

function dedupeEvents(
  events: readonly PaidEvent[],
  options: DecodeOptions & { dedupeKey?: string; markSeen?: boolean },
): PaidEvent[] {
  const seen =
    options.markSeen === false ? null : seenSetFor(options.merchant, options.dedupeKey);
  const out: PaidEvent[] = [];
  for (const event of events) {
    if (seen) {
      if (seen.has(event.txHash)) continue;
      seen.add(event.txHash);
    }
    out.push(event);
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

function collect(logs: readonly TransferLogLike[], options: DecodeOptions): PaidEvent[] {
  const events: PaidEvent[] = [];
  for (const log of logs) {
    const event = decodeTransferLog(log, options);
    if (event) events.push(event);
  }
  return events.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
}

/**
 * Read one address over `[fromBlock, toBlock]` newest first, in chunks.
 *
 * This exists because the Arc testnet node does not apply `topics` to either
 * address we care about: measured on 2026-10-03, both the USDC contract and the
 * system emitter return roughly 3 logs per block whatever we ask for, so a query
 * wide enough to cover a payment dies on the node's 10MB response cap — 5000
 * blocks fails outright. Capping the window instead (the old
 * `TOKEN_HISTORY_BLOCKS`) was worse than useless: testnet blocks are ~100ms, so
 * 100 blocks is about ten seconds of history, and a payment made slightly
 * earlier was silently never seen again.
 *
 * So the range is chunked, and a chunk the node refuses is retried at half the
 * size rather than abandoned. Shrinking matters as much as chunking: a node that
 * refuses even a 500-block chunk must still yield the payments inside it, which
 * is what the old 5000 -> 2000 -> 500 ladder was doing, only without giving up
 * the range. A chunk that cannot be read at `MIN_CHUNK_BLOCKS` ends the walk and
 * is reported — a partial answer beats no answer.
 *
 * Retrying has to distinguish two refusals that look alike but are not. A node
 * saying "this range is too large" is fixed by asking for less; a node saying
 * "you are rate limited" is not, and halving the range would just burn the
 * remaining quota on requests that are refused for a reason shrinking cannot
 * address. So a throttled chunk waits and asks again, same range, before the
 * size is cut.
 */
async function readSourceChunked(args: {
  publicClient: UsdcLogClient;
  address: Address;
  topics: readonly (Hex | null)[];
  fromBlock: bigint;
  toBlock: bigint;
  chunkBlocks: bigint;
  onError?: (error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ logs: TransferLogLike[]; complete: boolean }> {
  const { publicClient, address, topics, fromBlock, toBlock, chunkBlocks, onError } = args;
  const retry = <T,>(call: () => Promise<T>) =>
    retryWhenThrottled(call, args.sleep ? { sleep: args.sleep } : {});
  const logs: TransferLogLike[] = [];
  let complete = true;
  let cursor = toBlock;

  while (cursor >= fromBlock) {
    let size = chunkBlocks;
    let start: bigint | null = null;
    while (size >= MIN_CHUNK_BLOCKS) {
      const candidate = cursor - size + 1n > fromBlock ? cursor - size + 1n : fromBlock;
      try {
        const part = await retry(() =>
          publicClient.getLogs({
            address,
            topics,
            fromBlock: candidate,
            toBlock: cursor,
          }),
        );
        logs.push(...part);
        start = candidate;
        break;
      } catch (error) {
        onError?.(error);
        size = size / 2n;
      }
    }
    if (start === null) {
      complete = false;
      break;
    }
    if (start <= fromBlock) break;
    cursor = start - 1n;
  }
  return { logs, complete };
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

export type WatchUsdcPaymentsOptions = FetchPaymentsOptions & {
  onPaid: (event: PaidEvent) => void;
  onState?: (state: WatchState) => void;
  pollMs?: number;
  /** Start here instead of at head. Pass the block captured before the history load. */
  fromBlock?: bigint;
};

/**
 * Start polling the system emitter for incoming USDC.
 * Calls onPaid exactly once per tx hash, newest-first inside each batch.
 * Returns an unsubscribe function. (Acceptance test 4.)
 */
export function watchUsdcPayments(options: WatchUsdcPaymentsOptions): () => void {
  const {
    publicClient,
    merchant,
    fromBlock,
    onPaid,
    onState,
    pollMs = DEFAULT_POLL_MS,
    dedupeKey,
    allowSelfTransfer = false,
    minAmountUsdc = "0",
  } = options;

  const seen = seenSetFor(merchant, dedupeKey);
  const topics = [TRANSFER_TOPIC, null, addressToTopic(merchant)] as const;
  const decodeOptions: DecodeOptions = { merchant, minAmountUsdc, allowSelfTransfer };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cursor: bigint | null = fromBlock ?? null;
  let consecutiveErrors = 0;
  let lastSourceError: string | null = null;
  let state: WatchState = {
    cursor: fromBlock ?? null,
    busy: false,
    polls: 0,
    lastPollAt: null,
    lastError: null,
  };

  const publish = (patch: Partial<WatchState>) => {
    state = { ...state, ...patch };
    onState?.(state);
  };

  const poll = async () => {
    if (stopped) return;
    publish({ busy: true });
    try {
      const head = await publicClient.getBlockNumber();
      const from =
        cursor === null ? head : cursor > REORG_REWIND_BLOCKS ? cursor - REORG_REWIND_BLOCKS : 0n;

      if (from <= head) {
        // Each source is read independently and in chunks. One source blowing
        // the node's response cap must not cost us the other: a native send
        // going unseen because an unrelated token query failed is exactly the
        // bug this app exists to avoid.
        let sourceErrors = 0;
        for (const address of LOG_SOURCES) {
          const chunkBlocks =
            address === USDC_ERC20_ADDRESS ? TOKEN_CHUNK_BLOCKS : EMITTER_CHUNK_BLOCKS;
          const read = await readSourceChunked({
            publicClient,
            address,
            topics,
            fromBlock: from,
            toBlock: head,
            chunkBlocks,
          });
          if (!read.complete) {
            sourceErrors += 1;
            lastSourceError = "incomplete log read";
          }
          for (const log of read.logs) {
            if (stopped) return;
            const event = decodeTransferLog(log, decodeOptions);
            if (!event) continue;
            // One event per tx hash: a token transfer that Arc also mirrors into
            // the system emitter must not be reported twice.
            if (seen.has(event.txHash)) continue;
            seen.add(event.txHash);
            onPaid(event);
          }
        }
        if (sourceErrors === LOG_SOURCES.length) {
          throw new Error(lastSourceError ?? "all log sources failed");
        }
      }

      // The cursor advances even if a source read came back incomplete. Refusing
      // to advance would wedge the poller on one bad range and stop every future
      // payment from being seen; moving on can only cost the one range that
      // failed. The incompleteness is published rather than swallowed.
      cursor = head;
      consecutiveErrors = 0;
      publish({
        cursor: head,
        busy: false,
        polls: state.polls + 1,
        lastPollAt: Date.now(),
        lastError: lastSourceError,
      });
    } catch (error) {
      consecutiveErrors += 1;
      publish({
        busy: false,
        polls: state.polls + 1,
        lastPollAt: Date.now(),
        lastError: message(error),
      });
      options.onError?.(error);
    } finally {
      // Back off on repeated failures (the public RPC answers 429 under load) but
      // never stop trying: a payment is still owed.
      if (!stopped && timer === null) {
        const delay = consecutiveErrors === 0
          ? pollMs
          : Math.min(pollMs * 2 ** (consecutiveErrors - 1), MAX_POLL_BACKOFF_MS);
        timer = schedule(delay);
      }
    }
  };

  // Kick off immediately, then chain timeouts. A self-rescheduling timeout never
  // overlaps requests, which setInterval would.
  timer = schedule(0);

  function schedule(delay: number) {
    return setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  }

  return function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Telling the two doors apart
// ---------------------------------------------------------------------------

/**
 * Label a payment that came from the system emitter, which cannot say on its own
 * whether an ERC-20 transfer was involved. One receipt lookup is enough.
 *
 * Events read from the ERC-20 contract already know they are "token", so callers
 * should not bother asking.
 */
export async function inferPaymentSource(args: {
  publicClient: UsdcReceiptClient;
  txHash: Hash;
}): Promise<PaymentSource> {
  try {
    const receipt = await args.publicClient.getTransactionReceipt({ hash: args.txHash });
    const hasTokenLog = receipt.logs.some(
      (log) => log.address.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase(),
    );
    return hasTokenLog ? "token" : "native";
  } catch {
    return "unknown";
  }
}

/**
 * Build a payment event from the transaction itself rather than from a log.
 *
 * The native door is `sendTransaction({ to, value })`, and a plain value transfer
 * produces no contract log of its own: on Arc it only shows up because the EIP-7708
 * system emitter mirrors it. That mirror is not guaranteed. Sending native currency
 * to yourself emits nothing at all, and this demo defaults to paying the connected
 * wallet, so that is exactly what "Pay $1 as native" does for a single-person run.
 * The payment really lands; the emitter just never announces it, so a listener that
 * only reads logs waits forever.
 *
 * The transaction is the primary record anyway. Once it is mined, its recipient and
 * its value say what happened, so the app asks the chain directly instead of waiting
 * to be told. Dedupe is by tx hash, so a payment that *is* mirrored is still counted
 * exactly once.
 */
export function nativePaymentFromReceipt(
  receipt: {
    transactionHash: Hash;
    from?: Address | null;
    to?: Address | null;
    value: bigint;
    blockNumber: bigint;
    status?: "success" | "reverted" | boolean;
  },
  options: { merchant: Address; minAmountUsdc?: string; allowSelfTransfer?: boolean },
): PaidEvent | null {
  const { merchant, minAmountUsdc = "0", allowSelfTransfer = false } = options;

  // A reverted transaction moved nothing.
  if (receipt.status === "reverted" || receipt.status === false) return null;
  if (!receipt.to) return null;
  if (receipt.to.toLowerCase() !== merchant.toLowerCase()) return null;

  const from = receipt.from;
  if (!from) return null;
  if (!allowSelfTransfer && from.toLowerCase() === receipt.to.toLowerCase()) return null;

  const value = receipt.value;
  if (value <= 0n) return null;

  const nativeValue = value;
  if (minAmountUsdc !== "0") {
    const min = parseUnits(minAmountUsdc, USDC_NATIVE_DECIMALS);
    if (nativeValue < min) return null;
  }

  return {
    from: from.toLowerCase() as Address,
    to: receipt.to.toLowerCase() as Address,
    amountUsdc: nativeValueToUsdc(nativeValue),
    nativeValue,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    source: "system-emitter",
  };
}

/**
 * Poll one sent transaction until it is mined, then report it as a payment if it
 * really did send native currency to the merchant.
 *
 * Returns an unsubscribe function. Stops on the first matching receipt, and gives
 * up after `timeoutMs` so a dropped transaction cannot poll forever.
 */
export function watchNativePayment(args: {
  publicClient: {
    getTransactionReceipt: (params: { hash: Hash }) => Promise<unknown>;
  };
  txHash: Hash;
  merchant: Address;
  allowSelfTransfer?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  onPaid: (event: PaidEvent) => void;
}): () => void {
  const { publicClient, txHash, merchant, allowSelfTransfer = false, onPaid } = args;
  const intervalMs = args.intervalMs ?? 2_000;
  const timeoutMs = args.timeoutMs ?? 180_000;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();

  const tick = async () => {
    if (stopped) return;
    try {
      const receipt = (await publicClient.getTransactionReceipt({ hash: txHash })) as {
        transactionHash?: Hash;
        from?: Address | null;
        to?: Address | null;
        value?: bigint;
        blockNumber?: bigint;
        status?: "success" | "reverted" | boolean;
      } | null;
      if (receipt && receipt.blockNumber !== undefined && receipt.transactionHash) {
        const event = nativePaymentFromReceipt(
          {
            transactionHash: receipt.transactionHash,
            from: receipt.from,
            to: receipt.to,
            value: receipt.value ?? 0n,
            blockNumber: receipt.blockNumber,
            status: receipt.status,
          },
          { merchant, allowSelfTransfer },
        );
        if (event) {
          onPaid(event);
          return;
        }
      }
    } catch {
      // Not mined yet, or the node is briefly unavailable. Keep trying.
    }
    if (stopped || Date.now() - startedAt >= timeoutMs) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  return function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
