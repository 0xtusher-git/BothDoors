import type { PaidEvent } from "./watchUsdcPayments";
import type { Door } from "@/components/StatusCard";

export type Row = PaidEvent & { door: Door };

/**
 * Display state plus every transaction hash ever merged.
 *
 * `seen` is not derivable from `rows`: rows are capped for display, so hashes
 * that scroll out of the window must still count as already-counted or a
 * re-read double-counts them.
 */
export type Feed = {
  rows: Row[];
  total: number;
  seen: ReadonlySet<string>;
  /**
   * Newest payment that met the price, or null if none ever has.
   *
   * Tracked separately from `rows` because `rows` is a display window: a busy
   * merchant produces more payments than fit, and the one that opened the door
   * can scroll out of view. Deriving PAID from the window would silently undo
   * it — the shop would report unpaid while holding proof of payment.
   */
  qualifying: Row | null;
};

export const EMPTY_FEED: Feed = { rows: [], total: 0, seen: new Set(), qualifying: null };

/**
 * Which door a payment came through.
 *
 * A row decoded from the ERC-20 contract already knows: that log only exists
 * because the token contract moved USDC. An emitter row is genuinely ambiguous
 * on its own, so it stays "unknown" until a receipt lookup resolves it.
 */
export function doorFor(event: PaidEvent): Door {
  return event.source === "token-contract" ? "token" : "unknown";
}

export function byNewestFirst(a: Row, b: Row): number {
  if (a.blockNumber === b.blockNumber) return 0;
  return a.blockNumber > b.blockNumber ? -1 : 1;
}

/**
 * Is `a` strictly newer than `b`? Used to keep the qualifying payment pointed at
 * the most recent qualifying one; the hash breaks ties so two logs in the same
 * block cannot flip the answer between renders.
 */
function isNewer(a: Row, b: Row): boolean {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber;
  return a.txHash > b.txHash;
}

/**
 * Merge new payments into the feed, counting each transaction exactly once.
 *
 * Deduping here rather than trusting the caller's bookkeeping is deliberate.
 * Two callers can legitimately hand us the same payment:
 *
 *   - the history read and the poller overlap on purpose, because the poller
 *     starts at the block captured *before* the history read so nothing lands in
 *     the gap between them;
 *   - React StrictMode runs the mount effect twice, and a slow first read can be
 *     discarded after the second has already started.
 *
 * Without this check one payment occupies two rows, `total` runs ahead of the
 * explorer, and the shop reads PAID off a payment that was only made once.
 *
 * The dedupe set spans every hash ever merged, not just the rows still on
 * screen. That distinction is the whole point: a 40-payment history read keeps
 * 20 rows, so if the set were rebuilt from `rows`, re-offering the same 40
 * payments (StrictMode's double mount does exactly that, because history is
 * read with `markSeen: false`) would find 20 known hashes, count the other 20 a
 * second time, and report "60 found" for 40 payments.
 *
 * `total` counts everything ever merged, while `rows` keeps only the newest
 * `maxRows` for display — so the UI can say "34 found · showing latest 20"
 * instead of implying 20 was the whole truth.
 *
 * `sinceBlock` is the only thing allowed to open the door. History is real and
 * belongs on screen, but a payment from last week is not this session's payment:
 * counting it marked the shop PAID before the user had pressed anything, which
 * also disabled both pay buttons — so the demo looked paid and refused to run.
 * Rows are still added and counted; only `qualifying` respects the boundary.
 */
export function mergeFeed(
  prev: Feed,
  events: readonly PaidEvent[],
  maxRows: number,
  minNativeValue: bigint,
  sinceBlock: bigint = 0n,
): Feed {
  const known = new Set(prev.seen);
  const fresh: Row[] = [];
  for (const event of events) {
    if (known.has(event.txHash)) continue;
    known.add(event.txHash);
    fresh.push({ ...event, door: doorFor(event) });
  }
  // The inherited payment has to be re-checked, not just the fresh ones. A
  // qualifying payment is sticky once it lands, which is what keeps a reload from
  // dropping the proof of a payment you just made. But the session boundary moves
  // forward every time a new attempt starts, and a payment that predates it is no
  // longer this session's proof: without this, a shop could sit PAID forever
  // citing the block and hash of a payment from days ago.
  let qualifying =
    prev.qualifying !== null && prev.qualifying.blockNumber >= sinceBlock ? prev.qualifying : null;

  // This has to run before the "nothing new" bail-out below. Re-arming the
  // session is exactly the case where there are no new rows but the inherited
  // payment has still gone stale.
  if (fresh.length === 0) {
    return qualifying === prev.qualifying ? prev : { ...prev, qualifying };
  }

  for (const row of fresh) {
    if (row.nativeValue < minNativeValue) continue;
    if (row.blockNumber < sinceBlock) continue;
    if (qualifying === null || isNewer(row, qualifying)) qualifying = row;
  }

  const merged = [...fresh, ...prev.rows].sort(byNewestFirst);
  return {
    total: prev.total + fresh.length,
    seen: known,
    qualifying,
    rows: maxRows > 0 && merged.length > maxRows ? merged.slice(0, maxRows) : merged,
  };
}
