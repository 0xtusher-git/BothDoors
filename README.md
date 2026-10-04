# BothDoors

**BothDoors is a USDC payment listener built on Arc. It detects ERC-20 transfers AND native USDC sends.**

Same USDC. Two send buttons. The list must see both.

## Why Arc

On Arc, USDC is the gas currency *and* an ERC-20. It is one asset with two send
paths:

| Path | What you do | What lands onchain |
| --- | --- | --- |
| **as token** | `USDC.transfer(merchant, 1e6)` | Transfer from the ERC-20 contract, 6 decimals |
| **as native** | `sendTransaction({ to, value: 1e18 })` | Transfer from the EIP-7708 system emitter, 18 decimals |

Arc's system emitter `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` writes a
Transfer log for the native asset on **every** movement — including the movement
an ERC-20 USDC transfer causes. Verified on both chains: an ERC-20 transfer emits
one ERC-20 log (6 dec) plus one system-emitter log with the same `from`/`to` and
`value × 1e12`.

So an app that watches only the token contract marks every native payment as
unpaid, forever. BothDoors watches the one log source that covers both:

```ts
getLogs({
  address: "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE",   // system emitter
  topics: [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
    null,                                                                 // any from
    padMerchantToTopic,                                                   // to = merchant
  ],
})
```

One query, one decimal base, no double counting. `amountUsdc` is
`formatUnits(value, 18)`, so $1 reads as `1.0` — never `1e12`, never `1e-12`.

## Run it

```bash
npm install
cp .env.example .env.local     # optional, works without it
npm run dev                    # http://localhost:3000
```

Node 18.18+.

`npm run dev` builds into `.next-dev`, not `.next`, so a production build can be
run without taking the dev server down. Sharing one directory is a quiet failure:
the running server keeps answering 200 on routes it has already recompiled and
500s the rest, complaining about a vendor chunk file that was never deleted.

### Env vars

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MERCHANT_ADDRESS` | *(empty)* | Who gets paid. Empty means "use the connected wallet", so you can test alone. |
| `NEXT_PUBLIC_DEFAULT_CHAIN` | `mainnet` | `mainnet` or `testnet`. The in-app toggle wins and is remembered. |
| `NEXT_PUBLIC_WC_PROJECT_ID` | *(empty)* | Not used by v0. Only if you swap in RainbowKit / WalletConnect. |

## Mainnet demo, 60 seconds

1. Open the app, click **Connect wallet**, switch to **Arc mainnet**.
2. Read the merchant address on the left. With no env var set, it is your own
   address and the panel says *demo mode* — self-payments are allowed there only,
   so one wallet can finish the demo. Set `NEXT_PUBLIC_MERCHANT_ADDRESS` to use a
   fixed address instead.
3. Click **Pay $1 as token**. Status goes `WAITING → WATCHING → PAID`.
4. Hit **Reset demo**, then click **Pay $1 as native**. Same $1, same shop, `PAID`
   again. The badge says which door it came through.
5. Or use two wallets: leave the app open in one, pay the displayed address from
   another, or from a normal USDC transfer in any wallet. The listener does not
   care who sends.

Nothing is faked. The state only flips to `PAID` when a matching onchain log is
found, and it stays `PAID` until **Reset demo**.

## Addresses and chain ids

| | Arc mainnet | Arc testnet |
| --- | --- | --- |
| chainId | `5042` | `5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |
| Native currency | USDC, 18 decimals | USDC, 18 decimals |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000` (6 decimals) | same |

- System emitter (EIP-7708), all native USDC Transfer logs: `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`
- Transfer topic0: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- `nativeUnits = erc20Units × 1e12` · `1 USDC = 1e18 native = 1e6 ERC-20`

## Use it in your own dapp

Copy `lib/watchUsdcPayments.ts`. It depends on viem types and nothing else. Full
walkthrough on the `/integrate` page, which renders the real file at build time so
it can never drift.

```ts
import { watchUsdcPayments } from "@/lib/watchUsdcPayments"

const stop = watchUsdcPayments({
  publicClient: client,
  merchant: "0x...",
  onPaid: ({ from, amountUsdc, txHash, nativeValue }) => {
    markOrderPaid({ from, amountUsdc, txHash, nativeValue })
  },
})
// stop() unsubscribes
```

```ts
type PaidEvent = {
  from: `0x${string}`
  to: `0x${string}`
  amountUsdc: string    // "1.0"  — human dollars
  nativeValue: bigint   // 1000000000000000000n — 18 decimals
  txHash: `0x${string}`
  blockNumber: bigint
  source: "system-emitter"
}
```

`lib/pay.ts` has the other half: `payToken()` for the ERC-20 door, `payNative()`
for the native door. Same `$1`, two decimal bases.

## Acceptance tests

| # | Test | How it is verified |
| --- | --- | --- |
| 1 | Token pay of 1 USDC → shop becomes PAID | `npm test` "Acceptance 1 and 2"; `npm run verify:e2e` finds a real ERC-20 transfer onchain and asserts the listener reports it |
| 2 | Native pay of 1 USDC → shop becomes PAID | same two suites; `verify:e2e` asserts a real native send is reported |
| 3 | History load shows incoming transfers to the merchant | `npm test` "Acceptance 3" and "3b"; `verify:e2e` loads a real merchant's real history |
| 4 | Same tx never listed twice | `npm test` "Acceptance 4": history then poller over an overlapping range, plus two watchers on one merchant |
| 5 | Amount displays as 1 USDC, not 1e12 or 1e-12 | `npm test` "Acceptance 5"; `verify:e2e` round-trips real amounts |
| 6 | Wrong network blocks the pay buttons | `components/PayDemo.tsx` — `getBlockingReason()` returns a plain-language reason and both buttons stay disabled unless the wallet is on Arc; `verify:browser` asserts both are disabled with no wallet |
| 7 | A payment that the system emitter never mirrors is still seen | `npm test` "Regression — an ERC-20 transfer Arc does NOT mirror into the emitter", plus the mirrored case asserting it is still counted once |
| 8 | One transaction is never two rows, and the count is honest | `npm test` "Feed counting" — overlapping history/poller batches, StrictMode's double mount, and a 34-payment feed that must report 34 while showing 20 *and still report 34 when re-read after 14 of those rows scrolled out of the window* |
| 9 | An abandoned history read cannot swallow a payment | `npm test` "Recovery" — a read whose result is discarded leaves the payment still owed, and only a committed read stops re-reporting it |
| 10 | A rate-limited node does not cost us history | `npm test` "Acceptance test 3e" — a throttled chunk is re-asked at the identical range rather than narrowed, the throttled run requests exactly the ranges an unthrottled one does, and no block of the lookback is left unasked |
| 11 | Every installed wallet is offered, not just the first | `npm test` "wallet discovery" - the catch-all injected connector is hidden when named wallets exist so one wallet cannot appear twice, and brand detection asserts Phantom and OKX are not misread as MetaMask; `verify:hydration` installs three mock wallets and asserts all three are listed and that picking one is honoured |
| 12 | A payment from history cannot fake a PAID | `npm test` "Session boundary" - a real earlier $1 payment is still listed but does not open the door, so the shop cannot read PAID before the user has pressed anything. Reproduced live against an Arc testnet merchant: without the fix its history set `qualifying` and both pay buttons were disabled |
| 13 | The native door sends a real $1 native transfer | `npm run verify:hydration` phase 4 - the mock wallet now records the transaction the app asks it to sign, and asserts it carries `value` of exactly 1e18, no calldata, and the merchant address on screen. It also asserts an unmined hash never becomes a payment row. Previously the token phase only proved a button was clickable, so a native send that sent no value, sent it elsewhere, or sent a contract call while advertising the emitter path passed every test |

```bash
npm test                 # 105 checks, synthetic chain, no network needed
npm run typecheck        # tsc --noEmit, strict
npm run build            # production build

npm run verify:constants # offline: topic0, emitter checksum, amount maths
npm run verify:live      # + asks both Arc RPCs for real data
npm run verify:two-doors # proves onchain that an ERC-20 transfer emits a system-emitter twin
npm run verify:e2e       # runs the real listener against real payments on both chains
npm run verify:browser   # boots the built app in Chrome, checks both pages
npm run verify:hydration # connects a mock wallet, reloads, asserts no hydration mismatch
```

`verify:two-doors`, `verify:e2e`, `verify:browser` and `verify:hydration` need
network access and take ~30s because the public RPCs rate-limit. `verify:browser`
finds Chrome or Edge on Windows and skips itself if neither is installed. To have it
assert the live listener, build with a merchant — `NEXT_PUBLIC_*` values are inlined
at build time, so setting the variable only at run time is not enough:

```bash
# a busy USDC address, so the incoming list has real rows to render
$env:NEXT_PUBLIC_MERCHANT_ADDRESS = "0x8366a39CC670B4001A1121B8F6A443A643e40951"
npm run verify:browser
```

`verify:browser` and `verify:hydration` build and serve on their own, into
`.next-browser/` and `.next-hydration/`, so they work while `npm run dev` is
running. One collision is left and it is worth knowing about: **`npm run build`
must not run while `npm run dev` is running.** Both own `.next/`, and the dev
server then fails with `__webpack_modules__[moduleId] is not a function` until you
stop it, delete `.next/`, and start it again.

### Counting a payment exactly once

Two callers legitimately hand the UI the same payment, so the dedupe lives in
`lib/feed.ts` rather than in the listener's bookkeeping:

- the history read and the poller **overlap on purpose** — the poller starts at
  the block captured *before* the history read, so a payment landing in the gap
  between them cannot be lost;
- React StrictMode runs the mount effect **twice**, and a slow first read can be
  discarded after the second has begun.

`mergeFeed` dedupes on transaction hash, so one payment is one row no matter how
often it is offered. Two more things follow from the same rule:

- **A read that gets thrown away must not claim anything.** The history load
  passes `markSeen: false` and calls `markPaymentsSeen` only *after* the rows are
  rendered. Otherwise an abandoned read would mark a payment as already reported
  and nothing would ever surface it again — a silent, permanent loss.
- **`total` is not `rows.length`.** Only the newest `MAX_ROWS` are rendered, so
  the header says `34 found · showing latest 20` rather than implying 20 was the
  whole truth.

Switching network or merchant clears the feed and the door-lookup memo. Otherwise
the previous chain's rows would sum into one count and their explorer links would
point at the wrong chain.

### Finding the installed wallets

With more than one wallet extension installed, "Connect wallet" used to open
MetaMask for everyone, because the demo always connected `connectors[0]`. That is
whatever extension claimed `window.ethereum` first, which makes the choice depend
on install order rather than on what the user wants.

Wallets are now collected from all three places they can show up:

- **EIP-6963 announcements.** The modern path, handled by wagmi itself: each
  wallet announces itself and wagmi gives it a connector. A wallet installed
  later still appears, because wagmi keeps listening.
- **`window.ethereum.providers`.** The legacy array, which nothing reads by
  default. `lib/useLegacyWalletConnectors.ts` registers each provider that is not
  already known, so an extension too old to announce is still reachable. They go
  into the config's connector store rather than being connected through a
  throwaway connector, because that store is what `reconnect` walks on page load.
- **The catch-all connector.** Kept only as a fallback. With named wallets
  present it is hidden, since it is not a separate wallet — it is one of them
  under a generic label, and listing both would show the same wallet twice.

Wallets that predate EIP-6963 identify themselves only through boolean flags, and
several of them set `isMetaMask` too. Phantom and OKX both do, so brand detection
has to test the specific flag before the generic one or both get reported as
MetaMask.

### What counts as paid

`PAID` means paid *since this demo was opened*, not "has ever been paid". History
is read over a 5000-block lookback deliberately, so a merchant that was paid last
week always has rows on screen — and treating one of those as this session's
payment marked the shop paid on load. That also disabled both pay buttons, so
pressing one did nothing at all and looked like a fake PAID arriving a couple of
seconds later.

Rows from history are still shown and still counted. Only `qualifying`, the payment
that opens the door, respects a session boundary: the block the session started
at, held in `localStorage` per merchant and chain. Storing it means a reload
straight after paying keeps the proof, since the payment is still newer than the
marker. "Reset demo" clears the marker and re-arms at the current head, which is
the only thing that un-sticks the buttons.

### Hydration

The app is statically prerendered, but a wallet is a browser-only thing. With
`ssr: false`, wagmi rehydrates its persisted session from `localStorage`
synchronously, so `useAccount()` can already be connected on the *first* client
render while the server HTML says "Connect wallet" — React then discards the
server-rendered tree. `lib/useMounted.ts` keeps the first client render identical
to the server output and lets the real wallet state land one tick later.

`verify:hydration` reproduces exactly that: it injects a mock EIP-1193 provider,
connects it, reloads so wagmi restores its own persisted session, and fails if
React reports a mismatch (production React throws #418/#423/#425 rather than
warning). Reverting the `useMounted` gate makes it fail, so it is a real guard.

### How tests 3 and 4 hold up against a real RPC

Public Arc RPCs cap `eth_getLogs` by **result count** (~2000), not by block
count — on the busy testnet a 500-block window can already be refused. So
`fetchRecentPayments` never asks for the whole lookback in one call. It walks
backwards from head in 500-block chunks and a refused chunk is retried at half
the size down to 25 blocks, because a node that refuses a 500-block chunk must
still yield the payments inside it. A chunk that cannot be read even at 25
blocks ends the walk, and the result is flagged `truncated: true` with the
reasons in `errors`; the UI says so rather than pretending the history is
complete. Each source is read independently, so a refused token query can never
cost you the emitter read.

Refusals are not all the same, and the two kinds are handled differently:

- **"this range is too large"** is fixed by asking for less, hence the halving.
- **"you are rate limited"** is not. The public RPC shares one quota across
  everyone, and reading the full lookback costs 20 chunked requests, so throttling
  mid-walk is the normal case. A throttled chunk is therefore re-asked at the
  *identical* range after a short backoff, up to three times, before any size is
  cut. Halving the range on a 429 would spend the remaining quota faster and
  abandon blocks that had nothing wrong with them. Acceptance test 3e asserts the
  throttled run asks for exactly the same set of ranges as an unthrottled one.

The poller also backs off exponentially when the node answers 429, and never
stops trying — a payment is still owed.

### Not every ERC-20 transfer reaches the system emitter

The `verify:two-doors` sample shows that most ERC-20 transfers do get an
exact system-emitter twin, but **not all of them** — a token self-send is the
common case with none. An emitter-only listener therefore reports $0 for a
payment that plainly succeeded, so the listener reads **both** the USDC contract
and the emitter and dedupes by transaction hash. 6-decimal token values are
lifted by `1e12` to the 18-decimal native unit the UI already used.

That second source has a real cost, and it is worth being blunt about it. The
Arc **testnet** node ignores `topics` for *both* addresses and returns every log
in the range, so a single self-send can end up costing 10MB of response body.
Chunking is what absorbs that: 500 blocks per request keeps each response small
enough to return, and the topics are filtered client-side after decoding. An
earlier version capped the token read at the most recent 100 blocks to cope with
this, which was worse than useless — testnet blocks are ~100ms, so 100 blocks is
ten seconds of history, and a payment made slightly earlier was silently never
seen again. The cap is gone.

What remains is honest rather than fixed: if a chunk cannot be read even at the
25-block floor, that part of the lookback is missing and the UI's `truncated`
note says so instead of letting the number look authoritative. The one
structurally unmissable payment is one older than `DEFAULT_LOOKBACK_BLOCKS`
(5000 blocks, roughly eight minutes on testnet) that is *only* discoverable by a
page load and has no emitter twin — the poller cannot find it either, because it
starts at head. Payment confirmation is deliberately left to the wallet for that
case rather than pretending a bounded scan is complete.

## Deploy

Zero backend. Everything runs client-side against the public Arc RPC, so it
deploys to Vercel with no configuration:

```bash
npx vercel
```

If you ever need a proxy, add an `app/api/rpc/route.ts` that forwards to
`https://rpc.mainnet.arc.io` and point the transport at it. The listener does not
care where the client came from.

## Grant

BothDoors is a small, honest piece of infrastructure: one function that watches
the correct log on Arc and tells a shop page the truth about what it was paid.
We are asking for a small grant to keep it open source, ship it as a reusable
listener, and document the EIP-7708 system-emitter pattern so other Arc teams stop
missing native USDC payments. No custom contract, no custody, no fees, no lock-in.

## Not in v0

Deliberately not built: invoices, escrow, bridges, other chains, memos, agent
wallets, a decimal converter. No smart contract of our own. BothDoors never
touches funds — it only reads logs.
