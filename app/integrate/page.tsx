import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodeBlock } from "@/components/CodeBlock";
import { Badge } from "@/components/StatusCard";

// Read the real files at build time so this page can never drift from the code
// that actually runs.
export const dynamic = "force-static";

async function readLib(relative: string): Promise<string> {
  return readFile(path.join(process.cwd(), relative), "utf8");
}

const USAGE = `import { watchUsdcPayments, fetchRecentPayments } from "@/lib/watchUsdcPayments"
import { usePublicClient } from "wagmi"

function Shop() {
  const client = usePublicClient({ chainId: 5042 })
  const merchant = "0xYourMerchantAddress" as \`0x\${string}\`

  // Optional: show payments that already landed.
  useEffect(() => {
    void fetchRecentPayments({ publicClient: client, merchant })
      .then(({ events }) => events.forEach(fillOrder))
  }, [client, merchant])

  useEffect(() => {
    const stop = watchUsdcPayments({
      publicClient: client,
      merchant,
      onPaid: ({ from, amountUsdc, txHash, nativeValue }) => {
        console.log("paid", { from, amountUsdc, txHash, nativeValue })
        fillOrder()
      },
    })
    return stop   // unsubscribe
  }, [client, merchant])
}`;

const PAY_USAGE = `import { payToken, payNative } from "@/lib/pay"

// Door A — an ERC-20 USDC transfer. 6 decimals.
const tokenTx = await payToken({
  walletClient,
  merchant,
  amountUsdc: "1",              // defaults to 1
})

// Door B — the chain-native send. 18 decimals.
const nativeTx = await payNative({
  walletClient,
  merchant,
  amountUsdc: "1",
})`;

export default async function IntegratePage() {
  const [watcher, payer] = await Promise.all([
    readLib("lib/watchUsdcPayments.ts"),
    readLib("lib/pay.ts"),
  ]);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
          Add BothDoors to your dapp
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-door-dim">
          One file. It watches the right log, so a customer can pay your shop either way and you
          still see PAID.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center gap-2">
            <Badge tone="accent">Button A</Badge>
            <span className="text-sm font-semibold">as token</span>
          </div>
          <p className="mt-2 text-sm text-door-dim">
            An ordinary <span className="font-mono text-door-ink">USDC.transfer</span> to the merchant.
            The token contract logs it in 6 decimals.
          </p>
        </div>
        <div className="panel p-5">
          <div className="flex items-center gap-2">
            <Badge tone="paid">Button B</Badge>
            <span className="text-sm font-semibold">as native</span>
          </div>
          <p className="mt-2 text-sm text-door-dim">
            The chain-native send, like sending ETH on Ethereum. No token contract involved, 18
            decimals.
          </p>
        </div>
      </section>

      <section className="panel space-y-3 p-5">
        <p className="label">In plain English</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-door-dim">
          <li>
            Same USDC both times. Same $1. Only the send path differs.
          </li>
          <li>
            On Arc, the EIP-7708 system emitter{" "}
            <span className="font-mono text-door-ink">0xffff…fffe</span> writes a Transfer log in
            18 decimals for the native asset on every movement — including most of the movements an
            ERC-20 USDC transfer causes. Not all of them, though: Arc does not mirror every token
            transfer, and a self-send is the common case with no emitter log at all.
          </li>
          <li>
            So we read <em>both</em> sources — the emitter and the USDC contract — each filtered to{" "}
            <span className="font-mono text-door-ink">to = your merchant address</span>, and lifted
            into the same 18-decimal base (the token contract counts in 6). Both doors light up the
            same order.
          </li>
          <li>
            Because a mirrored transfer appears in both logs, dedupe by transaction hash. That is the
            whole reason to read two sources, and the whole reason it cannot double-count.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold">1. Drop in the listener</h2>
          <span className="text-xs text-door-dim">
            lib/watchUsdcPayments.ts · {watcher.split("\n").length} lines
          </span>
        </div>
        <p className="text-sm text-door-dim">
          Copy this file into your project as{" "}
          <span className="font-mono text-door-ink">lib/watchUsdcPayments.ts</span>. It only depends
          on viem types.
        </p>
        <CodeBlock
          code={watcher}
          label="lib/watchUsdcPayments.ts"
          maxHeight="32rem"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">2. Watch for payments</h2>
        <p className="text-sm text-door-dim">
          Call it once with your merchant address. It returns an unsubscribe function, so you can
          stop it on unmount.
        </p>
        <CodeBlock code={USAGE} label="example usage" />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">3. The two pay buttons</h2>
        <p className="text-sm text-door-dim">
          Optional, if you also want the send side. Same file shape, same $1, two decimal bases.
        </p>
        <CodeBlock code={PAY_USAGE} label="lib/pay.ts usage" />
        <CodeBlock code={payer} label="lib/pay.ts" maxHeight="20rem" />
      </section>

      <section className="panel space-y-3 p-5">
        <p className="label">What you get back</p>
        <CodeBlock language="ts" label="PaidEvent">
          {`type PaidEvent = {
  from: \`0x\${string}\`
  to: \`0x\${string}\`
  amountUsdc: string    // "1.0"  <- human dollars, not 1e18
  nativeValue: bigint  // 1000000000000000000n  <- 18 decimals
  txHash: \`0x\${string}\`
  blockNumber: bigint
  source: "system-emitter"
}`}
        </CodeBlock>
      </section>

      <section className="panel space-y-3 p-5">
        <p className="label">Rules the listener already handles</p>
        <ul className="space-y-2 text-sm text-door-dim">
          <li>
            <span className="text-door-ink">Ignores zero-value transfers.</span> A 0 transfer is not
            a payment.
          </li>
          <li>
            <span className="text-door-ink">Ignores self-sends by default.</span> A merchant
            withdrawing to itself should never mark an order paid. Pass{" "}
            <span className="font-mono">allowSelfTransfer: true</span> only for a solo demo.
          </li>
          <li>
            <span className="text-door-ink">One callback per tx hash.</span> History load and the
            poller share a dedupe set, so a reload never double-counts.
          </li>
          <li>
            <span className="font-mono text-door-ink">minAmountUsdc</span> filters small transfers, so
            a dust tip cannot satisfy a $1 order.
          </li>
          <li>
            <span className="font-mono text-door-ink">fetchRecentPayments</span> loads the last{" "}
            <span className="font-mono">5000</span> blocks and falls back to{" "}
            <span className="font-mono">2000</span>, then <span className="font-mono">500</span>,
            then walks backwards adaptively, because public Arc RPCs cap how many logs one query
            may return.
          </li>
        </ul>
      </section>

      <section className="panel space-y-3 p-5">
        <p className="label">Client-side only</p>
        <p className="text-sm text-door-dim">
          There is no server component to this. Point a viem client at an Arc RPC and read logs from
          the browser — BothDoors itself does exactly that, straight against the public RPC, with no
          backend. If a node ever blocks you on CORS, proxy it through a single route handler; the
          listener does not care where the client came from.
        </p>
      </section>
    </div>
  );
}
