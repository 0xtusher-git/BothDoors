import { mainnet, sepolia } from "viem/chains";
import { createConfig, http, injected } from "wagmi";
import { arcMainnet, arcTestnet } from "./chain";

/**
 * Injected-only connectors, so the demo needs no WalletConnect project id and no
 * backend. The two Ethereum chains are in the list purely so wagmi can recognise
 * a wallet sitting on the wrong network and offer a switch. BothDoors itself only
 * ever reads and pays on Arc.
 *
 * Note: `injected` is imported from "wagmi", not "wagmi/connectors". The barrel
 * re-exports every bundled connector, which drags in optional wallet SDKs (and
 * their optional native deps) that this app does not use.
 */
export const wagmiConfig = createConfig({
  chains: [arcMainnet, arcTestnet, mainnet, sepolia],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [arcMainnet.id]: http(arcMainnet.rpcUrls.default.http[0], { batch: false }),
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0], { batch: false }),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  // No server-side wallet state: there is no backend and no session cookie, and
  // rehydrating cookies into statically-prerendered HTML only invites a hydration
  // mismatch. The wallet connects after mount, which is all this demo needs.
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
