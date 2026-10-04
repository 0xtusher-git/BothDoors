"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, type Address, type Hash } from "viem";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { Badge, StatusCard, type DemoStatus, type Door } from "./StatusCard";
import {
  USDC_ERC20_ADDRESS,
  arcChains,
  explorerTxUrl,
  getArcChain,
  isArcChainId,
  type ArcChainId,
} from "@/lib/chain";
import { DEFAULT_CHAIN_ID, MERCHANT_ADDRESS, MERCHANT_ADDRESS_INVALID } from "@/lib/env";
import { formatDollars, formatUsdcFromErc20, formatUsdcFromNative, shortAddress } from "@/lib/format";
import { useMounted } from "@/lib/useMounted";
import { USDC_ERC20_ADDRESS as PAY_USDC, payNative, payToken, usdcAbi } from "@/lib/pay";
import {
  SYSTEM_EMITTER,
  fetchRecentPayments,
  inferPaymentSource,
  markPaymentsSeen,
  watchUsdcPayments,
  type PaidEvent,
  type UsdcReceiptClient,
} from "@/lib/watchUsdcPayments";
import { wagmiConfig } from "@/lib/wagmi";
import { EMPTY_FEED, mergeFeed, type Feed } from "@/lib/feed";

const PRICE_USDC = "1";
const PRICE_NATIVE = parseUnits(PRICE_USDC, 18);
const WATCH_GIVE_UP_MS = 60_000;
const CHAIN_STORAGE_KEY = "bothdoors.chainId";
const MAX_ROWS = 20;

void PAY_USDC; // the pay module and the chain module must agree on the address
if (USDC_ERC20_ADDRESS !== PAY_USDC) {
  throw new Error("USDC address mismatch between lib/chain.ts and lib/pay.ts");
}



export function PayDemo() {
  // Wallet state only exists in the browser, and a persisted session is already
  // back in the store when React hydrates. Mirror the server (no wallet) for the
  // first render, then swap in the real values — otherwise the connect button
  // and the merchant address mismatch the server HTML.
  const mounted = useMounted();
  const { address: rawAddress, chainId: rawChainId, isConnected: rawIsConnected } = useAccount();
  const { data: rawWalletClient } = useWalletClient();
  const address = mounted ? rawAddress : undefined;
  const chainId = mounted ? rawChainId : undefined;
  const isConnected = mounted && rawIsConnected;
  const walletClient = mounted ? rawWalletClient : undefined;

  const { connectors, connect, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const queryClient = useQueryClient();

  const [targetChainId, setTargetChainId] = useState<ArcChainId>(DEFAULT_CHAIN_ID);
  // `rows` is only what we render; `total` is how many payments we have actually
  // seen. Reporting `rows.length` as "N found" would cap the number at MAX_ROWS
  // and quietly claim that 20 was the whole truth.
  const [feed, setFeed] = useState<Feed>(EMPTY_FEED);
  const rows = feed.rows;
  const [awaiting, setAwaiting] = useState<{ door: Door; txHash: Hash | null } | null>(null);
  const [sending, setSending] = useState<Door | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  // Remember the network toggle across reloads.
  useEffect(() => {
    const saved = window.localStorage.getItem(CHAIN_STORAGE_KEY);
    if (saved !== null) {
      const id = Number(saved);
      if (isArcChainId(id)) setTargetChainId(id);
    }
  }, []);

  // The toggle picks which Arc network the demo is on. If a wallet is connected
  // we also move it, so the badge and the wallet never disagree.
  const chooseChain = useCallback(
    (id: ArcChainId) => {
      setTargetChainId(id);
      try {
        window.localStorage.setItem(CHAIN_STORAGE_KEY, String(id));
      } catch {
        /* private mode, not worth surfacing */
      }
      if (!isConnected || chainId === id) return;
      void switchChainAsync({ chainId: id }).catch(() => {
        setError(
          `Could not switch your wallet to ${getArcChain(id)?.name ?? "that network"}. Add Arc to your wallet, then switch manually.`,
        );
      });
    },
    [isConnected, chainId, switchChainAsync],
  );

  // ---- who gets paid -------------------------------------------------------
  // Env address wins so a judge can pay from a second wallet. Without it we use
  // the connected wallet, so one person can run the whole demo alone.
  const merchant: Address | null = MERCHANT_ADDRESS ?? (address ?? null);
  const walletOnArc = isArcChainId(chainId);
  const walletOnTarget = chainId === targetChainId;
  const isDemoSelfPay = Boolean(
    merchant && address && merchant.toLowerCase() === address.toLowerCase(),
  );

  // Read logs from the wallet's chain when it is on Arc, otherwise from whichever
  // Arc chain the toggle points at — so the merchant and history are visible even
  // before the wallet is switched over.
  const readChainId: ArcChainId =
    chainId !== undefined && isArcChainId(chainId) ? chainId : targetChainId;
  const readChain = getArcChain(readChainId) ?? arcChains[0];
  const publicClient = usePublicClient({ chainId: readChainId });

  const receiptClient = useMemo<UsdcReceiptClient | null>(
    () =>
      publicClient
        ? {
            getTransactionReceipt: ({ hash }) => publicClient.getTransactionReceipt({ hash }),
          }
        : null,
    [publicClient],
  );

  // ---- the listener --------------------------------------------------------
  // One receipt lookup per tx, ever. inferPaymentSource() answers "unknown" when
  // the node refuses, and retrying that forever would hammer the RPC.
  const attemptedDoors = useRef<Set<string>>(new Set());

  /**
   * Add payments to the feed, ignoring any tx we already hold.
   *
   * `mergeFeed` owns the dedupe, the ordering and the true total; see the notes
   * there for why that cannot be left to the listener's `seen` set alone.
   */
  const addRows = useCallback((events: readonly PaidEvent[]) => {
    if (events.length === 0) return;
    setFeed((prev) => mergeFeed(prev, events, MAX_ROWS, PRICE_NATIVE));
  }, []);

  // Switching network or merchant must not leave the previous one's rows on
  // screen: they would sum into one count, and their explorer links would point
  // at the wrong chain.
  const feedIdentity = `${readChainId}:${merchant ?? ""}:${isDemoSelfPay}`;
  const feedIdentityRef = useRef(feedIdentity);
  if (feedIdentityRef.current !== feedIdentity) {
    feedIdentityRef.current = feedIdentity;
    attemptedDoors.current = new Set<string>();
    // Render-phase reset of derived state; React re-renders before committing.
    setFeed(EMPTY_FEED);
    // `awaiting` belongs to the chain it was started on, not to this component.
    // Carrying it over made the new chain claim to be waiting for a payment that
    // can never arrive on it — "Waiting for a token payment…" after switching to
    // a network nothing had been paid on — and rebuilt the explorer link from the
    // *new* chain id around a hash from the old one, offering a testnet
    // transaction on the mainnet explorer.
    setAwaiting(null);
    // Same reasoning: an error about the previous chain's payment or merchant is
    // not news about this one.
    setError(null);
  }

  // The chain as of this render, for settling an in-flight pay against: the
  // wallet round-trip resolves long after the user may have switched networks,
  // and its result belongs to the chain it was sent on, not to whatever is on
  // screen by then.
  const readChainIdRef = useRef(readChainId);
  readChainIdRef.current = readChainId;

  useEffect(() => {
    if (!publicClient || !merchant) {
      setFeed(EMPTY_FEED);
      return;
    }
    let cancelled = false;
    let stop: (() => void) | null = null;
    const dedupeKey = String(readChainId);
    const decode = { merchant, allowSelfTransfer: isDemoSelfPay };

    void (async () => {
      // Capture head BEFORE the history read so nothing lands in the gap between
      // the two. Combined with the shared seen-set, no tx is reported twice.
      let fromBlock: bigint | undefined;
      try {
        fromBlock = await publicClient.getBlockNumber();
      } catch {
        fromBlock = undefined;
      }

      try {
        const result = await fetchRecentPayments({
          publicClient,
          ...decode,
          dedupeKey,
          // Do not claim these tx hashes on the way out. If this read is thrown
          // away (cancelled, or StrictMode's second mount), the payments are
          // still owed to us, so we must not have already marked them as seen.
          // `addRows` dedupes, so re-reporting them later is harmless.
          markSeen: false,
        });
        if (cancelled) return;
        if (result.truncated) {
          const span = result.toBlock - result.fromBlock + 1n;
          setHistoryNote(
            `Short history: the public RPC caps how many logs one query returns, so this scanned the last ${span.toString()} blocks.`,
          );
        } else {
          setHistoryNote(null);
        }
        addRows(result.events);
        // Only now, after the rows are committed, do we claim these hashes. See
        // `addRows`: it dedupes, so the poller overlapping this range is safe.
        markPaymentsSeen(
          merchant,
          result.events.map((event) => event.txHash),
          dedupeKey,
        );
      } catch (cause) {
        if (!cancelled) setHistoryNote(`Could not load history: ${plainError(cause)}`);
      }

      if (cancelled) return;
      stop = watchUsdcPayments({
        publicClient,
        ...decode,
        dedupeKey,
        fromBlock,
        onPaid: (event) => addRows([event]),
      });
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [publicClient, merchant, isDemoSelfPay, readChainId, resetToken, addRows]);

  // ---- label which door each payment came through --------------------------
  // `attemptedDoors` is declared above, next to the feed it annotates.
  useEffect(() => {
    if (!receiptClient) return;
    const pending = rows
      .filter((row) => row.door === "unknown" && !attemptedDoors.current.has(row.txHash))
      .slice(0, 4);
    if (pending.length === 0) return;
    for (const row of pending) attemptedDoors.current.add(row.txHash);
    let cancelled = false;
    void (async () => {
      for (const row of pending) {
        const door = await inferPaymentSource({
          publicClient: receiptClient,
          txHash: row.txHash,
        });
        if (cancelled) return;
        setFeed((prev) => ({
          ...prev,
          rows: prev.rows.map((item) => (item.txHash === row.txHash ? { ...item, door } : item)),
          // The qualifying payment may have scrolled out of `rows` but still be
          // the one holding the door open, so annotate it too.
          qualifying: prev.qualifying?.txHash === row.txHash ? { ...prev.qualifying, door } : prev.qualifying,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, receiptClient]);

  // ---- state machine -------------------------------------------------------
  // Read from the feed rather than scanning `rows`: the paying transaction must
  // keep the door open even after newer payments push it out of the 20-row
  // window, which on a busy merchant happens within seconds of it landing.
  const qualifying = feed.qualifying;
  const status: DemoStatus = qualifying ? "paid" : awaiting ? "watching" : "waiting";

  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => {
      setAwaiting(null);
      setError(
        "No matching Transfer log after 60 seconds. Check the merchant address above is the one you paid, then try again.",
      );
    }, WATCH_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [awaiting]);

  // ---- balances: the same pile, shown twice -------------------------------
  const canReadBalances = Boolean(address && walletOnTarget);
  const { data: nativeBalance } = useBalance({
    address,
    chainId: readChainId,
    query: { enabled: canReadBalances },
  });
  const { data: erc20Balance } = useReadContract({
    address: USDC_ERC20_ADDRESS,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: readChainId,
    query: { enabled: canReadBalances },
  });

  const nativeUsdc = formatUsdcFromNative(nativeBalance?.value ?? 0n);
  const erc20Usdc = formatUsdcFromErc20(erc20Balance ?? 0n);
  // Same pile, same 18-decimal base: 6-decimal USDC lifted by 1e12.
  const combinedNativeUnits =
    (nativeBalance?.value ?? 0n) + (erc20Balance ?? 0n) * 10n ** 12n;
  const combinedUsdc = formatUsdcFromNative(combinedNativeUnits);

  // ---- actions -------------------------------------------------------------
  const firstConnector = connectors[0];
  const blockingReason = getBlockingReason({
    isConnected,
    hasConnector: Boolean(firstConnector),
    walletClient,
    walletOnArc,
    walletOnTarget,
    merchant,
    readChainName: readChain.name,
    walletChainName: chainNameOf(chainId),
  });
  // Once paid, the session is over: the buttons stay disabled until Reset demo.
  const canPay = blockingReason === null && !qualifying;

  const handlePay = useCallback(
    async (door: "token" | "native") => {
      if (!walletClient || !merchant) return;
      const paidOnChain = readChainIdRef.current;
      setError(null);
      setSending(door);
      setAwaiting({ door, txHash: null });
      try {
        const args = {
          walletClient,
          merchant,
          amountUsdc: PRICE_USDC,
          chain: readChain,
        };
        const hash = door === "token" ? await payToken(args) : await payNative(args);
        // The user may have moved networks while the wallet was open. That
        // transaction is on `paidOnChain` and its log is watched there, so it
        // must not be adopted by the chain now on screen.
        if (readChainIdRef.current !== paidOnChain) return;
        setAwaiting((current) => (current ? { ...current, txHash: hash } : current));
        // Balances move; refresh them once the receipt is in.
        void queryClient.invalidateQueries();
      } catch (cause) {
        if (readChainIdRef.current !== paidOnChain) return;
        setAwaiting(null);
        setError(plainError(cause));
      } finally {
        setSending(null);
      }
    },
    [walletClient, merchant, readChain, queryClient],
  );

  const handleCopy = useCallback(async () => {
    if (!merchant) return;
    try {
      await navigator.clipboard.writeText(merchant);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      setError("Your browser blocked the clipboard. Select the address and copy it by hand.");
    }
  }, [merchant]);

  const handleReset = useCallback(() => {
    setFeed(EMPTY_FEED);
    setAwaiting(null);
    setError(null);
    setHistoryNote(null);
    // The library's `seen` set is deliberately NOT cleared. The payments above
    // stay claimed, so this reset does not immediately re-trip PAID from history
    // and a brand new payment is the only thing that can light the shop up again.
    setResetToken((n) => n + 1);
  }, []);

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-1">
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
          BothDoors — see both USDC send paths.
        </h1>
        <p className="text-sm text-door-dim">
          Built on Arc. One USDC, two ways to send it, one listener that sees both.
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        {/* ------------------------------------------------------------ left */}
        <div className="space-y-5">
          <div className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="label">Wallet</p>
                <div className="mt-1.5">
                  {isConnected ? (
                    <button
                      type="button"
                      onClick={() => disconnect()}
                      className="rounded-lg border border-door-line px-2 py-1 font-mono text-xs hover:border-door-dim"
                    >
                      {shortAddress(address, 8, 6)} · disconnect
                    </button>
                  ) : firstConnector ? (
                    <button
                      type="button"
                      onClick={() => connect({ connector: firstConnector })}
                      disabled={isConnecting}
                      className="rounded-lg border border-door-accent/50 bg-door-accent/10 px-3 py-1.5 text-sm font-semibold text-door-accent transition hover:bg-door-accent/20 disabled:opacity-50"
                    >
                      {isConnecting ? "Connecting…" : "Connect wallet"}
                    </button>
                  ) : (
                    <span className="text-sm text-door-dim">No wallet found</span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <p className="label">Network</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {arcChains.map((chain) => {
                    const active = chain.id === readChainId;
                    return (
                      <button
                        key={chain.id}
                        type="button"
                        onClick={() => chooseChain(chain.id)}
                        className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                          active
                            ? "border-door-accent bg-door-accent/15 text-door-accent"
                            : "border-door-line text-door-dim hover:text-door-ink"
                        }`}
                      >
                        {chain.id === arcChains[0].id ? "Mainnet" : "Testnet"}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {isConnected && !walletOnArc ? (
              <p className="mt-4 rounded-lg border border-door-wait/30 bg-door-wait/10 px-3 py-2 text-xs text-door-wait">
                Your wallet is on {chainNameOf(chainId)}. BothDoors only reads Arc, so the shop stays
                WAITING until you switch.
              </p>
            ) : null}

            {isConnected && walletOnArc && !walletOnTarget ? (
              <p className="mt-4 rounded-lg border border-door-wait/30 bg-door-wait/10 px-3 py-2 text-xs text-door-wait">
                {/* `targetChain`, not `readChain`: readChain follows the wallet
                    whenever the wallet is on Arc, so naming it here made this
                    render "you are on Arc Testnet, and the demo is pointed at Arc
                    Testnet, switch to Arc Testnet" — three times, with nothing to
                    do. This message only appears when the two disagree, which is
                    exactly when `readChain` is the wrong one to print. */}
                Your wallet is on {chainNameOf(chainId)}, and the demo is pointed at{" "}
                {getArcChain(targetChainId)?.name ?? "another network"}. Switch to{" "}
                {getArcChain(targetChainId)?.name ?? "it"}.
              </p>
            ) : null}

            {isConnected && !walletOnTarget ? (
              <button
                type="button"
                onClick={() => void switchChainAsync({ chainId: targetChainId })}
                disabled={isSwitching}
                className="btn-quiet mt-3 !py-2.5 !text-sm"
              >
                {isSwitching ? "Switching…" : `Switch to ${getArcChain(targetChainId)?.name ?? "Arc"}`}
              </button>
            ) : null}

            {!isConnected && firstConnector ? (
              <button
                type="button"
                onClick={() => connect({ connector: firstConnector })}
                disabled={isConnecting}
                className="btn-quiet mt-4 !py-2.5 !text-sm"
              >
                {isConnecting ? "Connecting…" : `Connect ${firstConnector.name}`}
              </button>
            ) : null}

            {!isConnected && !firstConnector ? (
              <p className="mt-4 text-xs text-door-wait">
                No browser wallet found. Install one, or set NEXT_PUBLIC_MERCHANT_ADDRESS so the demo
                has a merchant without a wallet.
              </p>
            ) : null}

            {connectError ? (
              <p className="mt-3 text-xs text-door-wait">{plainError(connectError)}</p>
            ) : null}
          </div>

          <div className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="label">Merchant address</p>
              {isDemoSelfPay ? <Badge tone="warn">demo mode</Badge> : null}
            </div>

            {merchant ? (
              <>
                <p className="mt-2 break-all font-mono text-sm">{merchant}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void handleCopy()} className="btn-quiet !w-auto !py-1.5 !text-xs">
                    {copied ? "Copied" : "Copy"}
                  </button>
                  {isConnected ? (
                    <button
                      type="button"
                      onClick={() => disconnect()}
                      className="btn-quiet !w-auto !py-1.5 !text-xs"
                    >
                      Use a different wallet
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-door-dim">
                {MERCHANT_ADDRESS_INVALID ? (
                  <span className="text-door-wait">
                    NEXT_PUBLIC_MERCHANT_ADDRESS is set to{" "}
                    <span className="font-mono">{MERCHANT_ADDRESS_INVALID}</span> but that is not a
                    valid address. Check for a typo or a bad checksum, then restart.
                  </span>
                ) : (
                  "Connect a wallet and this becomes the merchant, so you can test alone. Or set NEXT_PUBLIC_MERCHANT_ADDRESS to use a fixed address."
                )}
              </p>
            )}

            {isDemoSelfPay ? (
              <p className="mt-3 text-xs text-door-dim">
                The merchant is you, so self-payments are allowed here or the demo could never finish
                with one wallet. With a real merchant address, self-sends are ignored by default.
              </p>
            ) : null}
          </div>

          <div className="panel p-5">
            <p className="label">Your USDC on {readChain.name}</p>
            {!isConnected ? (
              <p className="mt-2 text-sm text-door-dim">Connect a wallet to see balances.</p>
            ) : !walletOnTarget ? (
              <p className="mt-2 text-sm text-door-dim">
                Switch to {readChain.name} to read balances.
              </p>
            ) : (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-door-dim">Native USDC (gas)</dt>
                  <dd className="font-mono">{formatDollars(nativeUsdc)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-door-dim">ERC-20 USDC (token)</dt>
                  <dd className="font-mono">{formatDollars(erc20Usdc)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-door-line pt-2">
                  <dt className="font-semibold">One pile</dt>
                  <dd className="font-mono font-semibold text-door-paid">
                    {formatDollars(combinedUsdc)}
                  </dd>
                </div>
              </dl>
            )}
            <p className="mt-3 text-xs text-door-dim">
              18 decimals and 6 decimals are the same dollars. The list has to see both.
            </p>
          </div>
        </div>

        {/* ----------------------------------------------------------- right */}
        <div className="space-y-5">
          <StatusCard
            status={status}
            event={qualifying ?? rows[0] ?? null}
            door={qualifying?.door ?? rows[0]?.door ?? "unknown"}
            chainId={readChainId}
            warning={awaiting && !qualifying ? `Waiting for a ${awaiting.door} payment…` : null}
          />

          <div className="panel space-y-3 p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="label">Pay</p>
              <p className="font-mono text-sm font-semibold">{formatDollars(PRICE_USDC)} USDC</p>
            </div>

            <button
              type="button"
              onClick={() => void handlePay("token")}
              disabled={!canPay || sending !== null}
              className="btn-primary"
            >
              {sending === "token" ? "Confirm in wallet…" : "Pay $1 as token"}
              <span className="text-xs font-normal opacity-75">ERC-20 transfer</span>
            </button>

            <button
              type="button"
              onClick={() => void handlePay("native")}
              disabled={!canPay || sending !== null}
              className="btn-quiet"
            >
              {sending === "native" ? "Confirm in wallet…" : "Pay $1 as native"}
              <span className="text-xs font-normal text-door-dim">chain send</span>
            </button>

            {qualifying ? (
              <p className="pt-1 text-xs text-door-dim">
                Paid in this session. Reset the demo to run it again.
              </p>
            ) : blockingReason ? (
              <p className="pt-1 text-xs text-door-wait">{blockingReason}</p>
            ) : null}

            <p className="pt-1 text-xs text-door-dim">
              Same USDC. Two send buttons. The list must see both.
            </p>

            {error ? (
              <p className="rounded-lg border border-door-wait/30 bg-door-wait/10 px-3 py-2 text-xs text-door-wait">
                {error}
              </p>
            ) : null}

            <div className="flex gap-2 border-t border-door-line pt-3">
              <button
                type="button"
                onClick={handleReset}
                className="btn-quiet !py-2 !text-xs"
              >
                Reset demo
              </button>
              {awaiting?.txHash ? (
                <a
                  href={explorerTxUrl(readChainId, awaiting.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-quiet !py-2 !text-xs"
                >
                  Open submitted tx
                </a>
              ) : null}
            </div>
          </div>

          <div className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="label">Incoming to this merchant</p>
              <span className="text-xs text-door-dim">
                {feed.total} found
                {feed.total > rows.length ? ` · showing latest ${rows.length}` : ""}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-door-dim">
                Nothing yet. Pay from either button above, or from a second wallet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {rows.map((row) => (
                  <li key={row.txHash} className="rounded-lg border border-door-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm">
                        {formatDollars(row.amountUsdc)}{" "}
                        <span className="text-xs text-door-dim">USDC</span>
                      </span>
                      {row.nativeValue >= PRICE_NATIVE ? (
                        <Badge tone="paid">paid</Badge>
                      ) : (
                        <Badge tone="dim">under {formatDollars(PRICE_USDC)}</Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-door-dim">
                      <span className="font-mono">{shortAddress(row.from, 6, 4)}</span>
                      {row.door === "token" ? (
                        <Badge tone="accent">token</Badge>
                      ) : row.door === "native" ? (
                        <Badge tone="paid">native</Badge>
                      ) : null}
                      <a
                        href={explorerTxUrl(readChainId, row.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-door-accent underline underline-offset-2"
                      >
                        {shortAddress(row.txHash, 10, 8)}
                      </a>
                      <span className="font-mono">#{row.blockNumber.toString()}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {historyNote ? <p className="mt-3 text-xs text-door-dim">{historyNote}</p> : null}

            <p className="mt-4 border-t border-door-line pt-3 text-xs text-door-dim">
              Two log sources, one payment: Transfer from the EIP-7708 system emitter{" "}
              <span className="font-mono text-door-ink">0xffff…fffe</span> at{" "}
              <span className="font-mono">{shortAddress(SYSTEM_EMITTER, 10, 8)}</span>, 18
              decimals, filtered to <span className="font-mono">to = merchant</span>; plus Transfer on
              the USDC contract itself, in 6 decimals, because Arc does not mirror every ERC-20
              transfer into the emitter. A token payment usually appears in both, so each row is keyed
              by transaction hash and counted once.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function chainNameOf(chainId: number | undefined): string {
  if (chainId === undefined) return "an unknown network";
  return wagmiConfig.chains.find((chain) => chain.id === chainId)?.name ?? `chain ${chainId}`;
}

/** Returns null when paying is allowed, otherwise a plain-language reason. */
function getBlockingReason(input: {
  isConnected: boolean;
  hasConnector: boolean;
  walletClient: unknown;
  walletOnArc: boolean;
  walletOnTarget: boolean;
  merchant: Address | null;
  readChainName: string;
  walletChainName: string;
}): string | null {
  const {
    isConnected,
    hasConnector,
    walletClient,
    walletOnArc,
    walletOnTarget,
    merchant,
    readChainName,
    walletChainName,
  } = input;

  if (!isConnected) {
    return hasConnector
      ? "Connect a wallet first."
      : "No browser wallet found. Install one to pay.";
  }
  if (!walletClient) return "Wallet is still connecting. One second.";
  if (!walletOnArc) return `Your wallet is on ${walletChainName}. Switch to ${readChainName} to pay.`;
  if (!walletOnTarget) return `Your wallet is on ${walletChainName}. Switch to ${readChainName} to pay.`;
  if (!merchant) return "No merchant address yet. Connect a wallet or set NEXT_PUBLIC_MERCHANT_ADDRESS.";
  return null;
}

function plainError(cause: unknown): string {
  if (cause instanceof Error) {
    const message = cause.message;
    if (/user rejected|user denied|rejected the request|cancel/i.test(message)) {
      return "You cancelled that in your wallet. Nothing was sent.";
    }
    if (/insufficient funds/i.test(message)) {
      return "Not enough USDC in this wallet to cover the amount plus gas.";
    }
    if (/intrinsic gas too low|gas required exceeds|out of gas/i.test(message)) {
      return "The network asked for more gas than that transaction used. Try again.";
    }
    if (/nonce/i.test(message)) {
      return "Wallet nonce hiccup. Wait a second and send it again.";
    }
    if (/chain|network/i.test(message) && /unrecognized|unsupported|missing/i.test(message)) {
      return "This chain is not in your wallet yet. Add Arc, then switch to it.";
    }
    const short = message.split("\n")[0] ?? message;
    return short.length > 180 ? `${short.slice(0, 180)}…` : short;
  }
  return typeof cause === "string" ? cause : "Something went wrong. Try again.";
}
