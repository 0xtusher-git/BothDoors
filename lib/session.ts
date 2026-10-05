/**
 * Where this demo's last payment attempt began, per merchant and chain.
 *
 * "Paid" has to mean paid *since the last attempt*, not "has ever been paid".
 * History is read over a 5000-block lookback on purpose, so a merchant that was
 * paid last week always has rows on screen — and treating one of those as this
 * session's payment marked the shop PAID the instant it loaded. That also disabled
 * both pay buttons, so pressing one did nothing at all, which read as a fake PAID.
 *
 * The marker moves forward every time the user presses pay, because pressing pay
 * means "count from now". That is what makes a cancelled attempt leave the shop
 * unpaid, and what stops a payment from a previous visit holding the door open
 * forever while its stale block and hash are quoted as the proof.
 *
 * It is stored rather than kept in memory so a reload does not lose a payment you
 * just made: the marker stays where the attempt put it, the payment is still newer
 * than it, and the shop is still PAID. "Reset demo" clears it for a clean slate.
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

const PENDING_PREFIX = "bothdoors.pending.";

/**
 * The native transaction this page is still waiting on.
 *
 * Watching a sent transaction normally lives in memory, which is fine right up
 * until the page reloads - and a reload is exactly what someone does after paying
 * to check whether it went through. The watcher dies with the component, the hash
 * dies with it, and a payment that did land goes unconfirmed forever while the page
 * insists it is still waiting.
 *
 * So the hash is kept per merchant and chain until the payment is confirmed. The
 * page picks it up again on the next load and keeps watching.
 */
export function pendingTxKey(merchant: string, chainId: number): string {
  return `${PENDING_PREFIX}${chainId}:${merchant.toLowerCase()}`;
}

export function readPendingTx(key: string): `0x${string}` | null {
  try {
    const saved = window.localStorage.getItem(key);
    return saved && /^0x[0-9a-f]{64}$/i.test(saved) ? (saved as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export function writePendingTx(key: string, hash: `0x${string}`): void {
  try {
    window.localStorage.setItem(key, hash);
  } catch {
    /* private mode, not worth surfacing */
  }
}

export function clearPendingTx(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode, not worth surfacing */
  }
}
