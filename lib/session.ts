/**
 * Where this demo session began, per merchant and chain.
 *
 * "Paid" has to mean paid *since the demo was opened*. History is read over a
 * 5000-block lookback on purpose, so a merchant that was paid last week always
 * has rows on screen — and treating one of those as this session's payment marked
 * the shop PAID the instant it loaded. That also disabled both pay buttons, so
 * pressing one did nothing at all, which read as a fake PAID.
 *
 * The block is stored rather than kept in memory so a reload does not lose a
 * payment you just made: the marker stays where it was, the payment is still
 * newer than it, and the shop is still PAID. "Reset demo" clears it and re-arms
 * at the current head, which is the only way to un-stick the buttons.
 */
const KEY_PREFIX = "bothdoors.session.";

export function sessionKey(merchant: string, chainId: number): string {
  return `${KEY_PREFIX}${chainId}:${merchant.toLowerCase()}`;
}

/** The block this session started at, or null if this is a new session. */
export function readSessionStart(key: string): bigint | null {
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === null) return null;
    const block = BigInt(saved);
    return block < 0n ? null : block;
  } catch {
    // Private mode, or a value that is not a block. Either way, treat it as new.
    return null;
  }
}

export function writeSessionStart(key: string, block: bigint): void {
  try {
    window.localStorage.setItem(key, block.toString());
  } catch {
    /* private mode, not worth surfacing */
  }
}

export function clearSessionStart(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode, not worth surfacing */
  }
}
