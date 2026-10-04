import { PayDemo } from "@/components/PayDemo";

export default function HomePage() {
  return (
    <>
      <PayDemo />
      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <div className="panel p-5">
          <p className="label">Door A — as token</p>
          <p className="mt-2 text-sm text-door-dim">
            A normal <span className="font-mono text-door-ink">USDC.transfer</span> to the merchant.
            The token contract logs it in 6 decimals.
          </p>
        </div>
        <div className="panel p-5">
          <p className="label">Door B — as native</p>
          <p className="mt-2 text-sm text-door-dim">
            The chain-native send, the same shape as sending ETH on Ethereum. No token contract
            involved. 18 decimals.
          </p>
        </div>
        <div className="panel p-5 sm:col-span-2">
          <p className="label">Both</p>
          <p className="mt-2 text-sm text-door-dim">
            Arc&apos;s EIP-7708 system emitter logs a Transfer with 18 decimals for the native asset on
            every movement — including most of the ones an ERC-20 USDC transfer causes. But not all of
            them: Arc does not mirror every token transfer, and a self-send is the common case with
            no emitter log at all. So BothDoors reads both sources, filtered to{" "}
            <span className="font-mono text-door-ink">to = merchant</span>, and keys every row by
            transaction hash so a payment seen twice still counts once. Apps that watch only the token
            contract never see door B; apps that watch only the emitter miss those self-sends.
          </p>
        </div>
      </section>
    </>
  );
}
