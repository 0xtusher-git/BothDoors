/**
 * Hydration regression test.
 *
 * Reproduces the original bug: with a wallet already connected, wagmi
 * rehydrates from localStorage synchronously (ssr: false => skipHydration is
 * false), so useAccount() is already `isConnected` on the FIRST client render.
 * The server has no wallet, so it renders "Connect wallet" — and React used to
 * report a hydration mismatch.
 *
 * Runs the real built app in headless Chrome with a mock EIP-1193 provider and a
 * pre-seeded wagmi store, then asserts:
 *   1. SSR HTML says "Connect wallet" (no wallet on the server)
 *   2. no hydration error / mismatch in the console
 *   3. the connected address DOES appear after mount (the gate is not just
 *      hiding the state forever)
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startProductionServer } from "./serve-production.mts";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const PORT = 3123;
const CDP_PORT = 3124;
const BASE = `http://localhost:${PORT}`;

/** Any valid address; the mock provider never touches a real wallet. */
const ACCOUNT = "0x4ae0358e1c6b0e4e2a0f8ab9d3c1e5f7a910fee0";
const CHAIN_ID = 5042;
/** A hash for a transaction that is never mined, so no log ever arrives for it. */
const FAKE_TX_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Injected before any page script: a fake EIP-1193 wallet. */
function seedScript(): string {
  return `
    (() => {
      const ACCOUNT = ${JSON.stringify(ACCOUNT)};
      const calls = [];
      window.__mockCalls = calls;
      // Every transaction the app asks a wallet to sign, with its parameters.
      // Asserting only that "a click happened" cannot tell a real $1 native send
      // from one that sent nothing, sent to the wrong place, or sent calldata
      // while the button claimed to be the native door.
      const txs = [];
      window.__mockTxs = txs;
      // Set by the cancellation phase: the wallet prompt opens and the user backs
      // out, which is the most common thing that happens and the one this harness
      // had no coverage for at all.
      window.__mockRejectSend = false;
      // Which wallet the user approved, in localStorage because it has to survive
      // the reload that the reconnect test does.
      const APPROVED = "mock-approved";
      const isApproved = (name) => { try { return localStorage.getItem(APPROVED) === name; } catch { return false; } };
      const approve = (name) => { try { localStorage.setItem(APPROVED, name); } catch {} };

      const makeWallet = (name, flags) => {
      let chainId = ${CHAIN_ID};
      const listeners = {};
      const hex = (id) => "0x" + id.toString(16);
      // A wallet can be switched between networks. Firing chainChanged is what
      // wagmi actually listens for, so the app must react the way it would with
      // a real wallet rather than the way it would on a fresh page load.
      window.__mockSetChain = (id) => {
        chainId = id;
        for (const fn of listeners.chainChanged ?? []) fn(hex(id));
      };
      const provider = {
        ...flags,
        isConnected: () => isApproved(name),
        get chainId() { return hex(chainId); },
        selectedAddress: ACCOUNT,
        request: async ({ method, params }) => {
          calls.push(name + ":" + method);
          switch (method) {
            case "eth_requestAccounts":
              approve(name);
              return [ACCOUNT];
            case "eth_accounts":
              // Only the approved wallet reports an account, like a real one.
              return isApproved(name) ? [ACCOUNT] : [];
            case "eth_chainId":
              return hex(chainId);
            case "net_version":
              return String(chainId);
            case "wallet_switchEthereumChain": {
              const [target] = params ?? [];
              chainId = parseInt(String(target?.chainId ?? "0x0"), 16);
              for (const fn of listeners.chainChanged ?? []) fn(hex(chainId));
              return null;
            }
            case "eth_sendTransaction":
              // The app only needs a hash back; no log will ever arrive for it,
              // which is exactly the state the network-switch test needs.
              if (window.__mockRejectSend) {
                const e = new Error("User rejected the request.");
                e.code = 4001;
                throw e;
              }
              txs.push({ wallet: name, params: params && params[0] ? params[0] : null });
              return ${JSON.stringify(FAKE_TX_HASH)};
            case "eth_getTransactionCount":
              return "0x7";
            case "eth_estimateGas":
              return "0x5208";
            case "eth_gasPrice":
            case "eth_maxPriorityFeePerGas":
              return "0x3b9aca00";
            case "eth_getBalance":
              return "0x21e19e0c9bab2400000";
            case "eth_blockNumber":
              return "0x112a880";
            case "eth_call":
              return "0x";
            case "eth_getCode":
              return "0x";
            default:
              // be permissive: wagmi probes a lot of optional methods
              return null;
          }
        },
        on: (event, fn) => { (listeners[event] ||= []).push(fn); },
        removeListener: (event, fn) => {
          listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
        },
      };
      return provider;
      };

      // Two wallets announce themselves over EIP-6963, the modern path.
      const announcers = [
        { info: { uuid: "mock-1", name: "MetaMask", rdns: "io.metamask" }, flags: { isMetaMask: true } },
        // Phantom and OKX both set isMetaMask too, which is why brand detection has
        // to check the specific flag first. Mocked so a regression there fails.
        { info: { uuid: "mock-2", name: "OKX Wallet", rdns: "com.okex.wallet" }, flags: { isMetaMask: true, isOkxWallet: true } },
      ];
      const announced = announcers.map((a) => makeWallet(a.info.name, a.flags));
      // The third never announces, the way an older extension behaves: it is only
      // reachable through the legacy window.ethereum.providers array.
      const legacy = makeWallet("Phantom", { isMetaMask: true, isPhantom: true });
      const providers = [...announced, legacy];

      // window.ethereum goes to the first announcement, as in a browser where the
      // earliest-installed extension claimed it.
      Object.defineProperty(window, "ethereum", { value: providers[0], configurable: true });
      Object.defineProperty(providers[0], "providers", { value: providers, configurable: true });

      window.addEventListener("eip6963:requestProvider", () => {
        announcers.forEach(({ info }, index) => {
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: { info: { ...info, icon: "" }, provider: announced[index] },
            }),
          );
        });
      });
    })();
  `;
}

async function findBrowser(): Promise<string | null> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

async function main() {
  const browserPath = await findBrowser();
  if (!browserPath) {
    console.log("No Chrome or Edge found, skipping the hydration test.");
    return;
  }

  let failures = 0;
  const check = (label: string, pass: boolean, detail?: unknown) => {
    if (pass) {
      console.log(`  ok    ${label}`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
    }
  };

  // 1. what the server actually sent
  const server = await startProductionServer(PORT, "hydration");
  try {
    await server.ready();
  } catch (cause) {
    check("server started", false, cause instanceof Error ? cause.message : String(cause));
    server.stop();
    process.exit(1);
  }
  check("server started", true);

  const ssrHtml = await (await fetch(BASE)).text();
  check("SSR HTML renders the connect button, not an address", ssrHtml.includes("Connect wallet"));
  check("SSR HTML has no wallet address", !ssrHtml.includes("0x4ae035"), "address leaked into SSR HTML");

  // 2. the client, with a wallet already connected
  const profile = mkdtempSync(path.join(tmpdir(), "hydration-"));
  const chrome = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  process.on("exit", () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  });

  let wsUrl = "";
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      wsUrl = ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? "";
      if (wsUrl) break;
    } catch {
      /* not yet */
    }
  }
  if (!wsUrl) {
    check("browser devtools endpoint", false, "never came up");
    chrome.kill();
    server.stop();
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  await once(ws, "open");
  let nextId = 0;
  const pending = new Map<number, (v: any) => void>();
  const events: { method: string; params: any }[] = [];
  let sessionId: string | undefined;

  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String((e as MessageEvent).data)) as any;
    if (typeof m.id === "number") {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
      return;
    }
    if (sessionId && m.sessionId === sessionId) events.push(m);
  });

  const send = async (method: string, params: Record<string, unknown> = {}, withSession = true) => {
    const id = ++nextId;
    const res = await new Promise<any>((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(withSession && sessionId ? { sessionId } : {}) }));
    });
    if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
    return res.result;
  };

  const target = await send("Target.createTarget", { url: "about:blank" }, false);
  sessionId = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false)).sessionId;
  for (const m of ["Runtime.enable", "Log.enable", "Page.enable"]) await send(m);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: seedScript() });

  // Phase 1: connect once, the way a user would, so wagmi writes its OWN
  // persisted store (the connector uid is generated per module instance, so it
  // cannot be guessed from outside the page).
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(7000);

  const evaluate = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;

  const walletButtonText = () =>
    evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /disconnect|Connect wallet|No wallet/.test(x.textContent)); return b ? b.textContent.trim() : null; })()`,
    ) as Promise<string | null>;

  const clickButton = (pattern: string) =>
    evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => ${pattern}.test(x.textContent)); if (!b) return false; b.click(); return true; })()`,
    ) as Promise<boolean>;

  const dialogWallets = async () => {
    const text = (await evaluate(
      `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.innerText : null; })()`,
    )) as string | null;
    return text ?? "";
  };

  // Every installed wallet has to be offered, not just whichever extension won
  // window.ethereum. This was the reported bug: OKX and Phantom were installed and
  // unreachable.
  await clickButton("/Connect wallet/");
  await sleep(1500);
  const offered = await dialogWallets();
  check("phase 1: connect opens a wallet list", offered.length > 0, "no dialog appeared");
  for (const wallet of ["MetaMask", "OKX Wallet", "Phantom"]) {
    check(`phase 1: ${wallet} is offered`, offered.includes(wallet), offered.replace(/\s+/g, " ").slice(0, 160));
  }
  check(
    "phase 1: the generic injected connector is not listed twice",
    !/Injected/i.test(offered),
    offered.replace(/\s+/g, " ").slice(0, 160),
  );

  // Connect with OKX rather than the first entry, so the choice has to be honoured
  // and not quietly replaced by MetaMask. Matched loosely because each row also
  // carries an initial-letter avatar, so the text is "OOKX Wallet".
  await clickButton("/OKX Wallet/");
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (/disconnect/.test((await walletButtonText()) ?? "")) break;
  }
  check(
    "phase 1: mock wallet connected",
    /disconnect/.test((await walletButtonText()) ?? ""),
    await walletButtonText(),
  );
  const okxWasUsed = ((await evaluate(`JSON.stringify(window.__mockCalls)`)) as string).includes(
    "OKX Wallet:eth_requestAccounts",
  );
  check("phase 1: the chosen wallet is the one that was asked", okxWasUsed, "OKX was never prompted");
  const stored = await evaluate(`localStorage.getItem('wagmi.store')`);
  const hasAccounts = typeof stored === "string" && /"accounts":\s*\[\s*"0x/i.test(stored);
  check("phase 1: wagmi persisted a real account", hasAccounts, String(stored).slice(0, 120));

  // Phase 2: reload. wagmi now rehydrates synchronously from localStorage, so
  // useAccount() is connected on the FIRST client render while the server HTML
  // says "Connect wallet" — the exact mismatch that was reported.
  events.length = 0;
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(8000);

  const consoleText = [
    ...events
      .filter((e) => e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type))
      .map((e) => `${e.params.type}: ${(e.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ")}`),
    ...events
      .filter((e) => e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry?.level))
      .map((e) => `${e.params.entry.level}: ${e.params.entry.text}`),
  ];

  const hydrationIssues = [
    ...consoleText.filter((t) => /hydrat|did not match|server rendered|Text content does not match/i.test(t)),
    // In a production build React throws instead of warning, so the mismatch
    // surfaces as a minified error: #418 (server HTML didn't match the client),
    // #423 (error while hydrating) or #425 (text content does not match).
    ...events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map(
        (e) =>
          e.params.exceptionDetails?.exception?.description ??
          e.params.exceptionDetails?.text ??
          "",
      )
      .filter((t) => /#418|#423|#425|hydrat/i.test(t)),
  ];
  check(
    "no hydration mismatch with a pre-connected wallet",
    hydrationIssues.length === 0,
    hydrationIssues.join(" | ").slice(0, 300),
  );

  const exceptions = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text ?? "");
  check("no uncaught exceptions", exceptions.length === 0, exceptions.join(" | ").slice(0, 300));

  const body = (await evaluate("document.body.innerText")) as string;
  const walletButton = await walletButtonText();

  check(
    "phase 2: wallet still connected after reload (test has teeth)",
    Boolean(walletButton && /disconnect/.test(walletButton)),
    walletButton,
  );
  check("connected address is shown after mount", body.includes("0x4ae035"), walletButton);

  // Phase 3: pay on one network, switch to the other. The pending state names a
  // transaction on a specific chain, so the new chain must not inherit it —
  // "Waiting for a token payment…" on a network nothing was paid on was the
  // reported bug, and its explorer link pointed at the wrong network too.
  //
  // Switched with the app's own network toggle rather than by poking the wallet,
  // because that is the real user path and it moves the wallet with it, keeping
  // paying enabled.
  const bodyText = async () => (await evaluate("document.body.innerText")) as string;
  const waitingFor = async () => /Waiting for a .* payment/i.test(await bodyText());
  const clickToggle = async (label: string) => {
    await evaluate(
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return 'missing';
        b.click();
        return 'clicked';
      })()`,
    );
    await sleep(7000);
  };
  const clickPay = async (label: RegExp) =>
    (await evaluate(
      `(() => {
        const b = Array.from(document.querySelectorAll('button')).find(x => ${label.toString()}.test(x.textContent));
        if (!b) return 'missing';
        if (b.disabled) {
          // Report why, so a failure names the rule that blocked it instead of
          // just "disabled".
          const note = Array.from(document.querySelectorAll('p')).find(x => /wallet is on|merchant address|still connecting|Connect a wallet/i.test(x.textContent || ''));
          return 'disabled: ' + ((note && note.textContent.trim().replace(/\\s+/g, ' ')) || 'no reason shown');
        }
        b.click();
        return 'clicked';
      })()`,
    )) as string;

  // Testnet is not the default here, so select it, pay, then move back.
  await clickToggle("Testnet");
  const testnetActive = (await evaluate(
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Testnet'); return b ? /text-door-accent/.test(b.className) : null; })()`,
  )) as boolean | null;
  check("phase 3: demo moved to testnet", testnetActive === true, `testnet toggle active=${testnetActive}`);

  const clickResult = await clickPay(/Pay \$1 as token/);
  check("phase 3: token pay button is clickable", clickResult === "clicked", clickResult);

  for (let i = 0; i < 15 && !(await waitingFor()); i++) await sleep(1000);
  check("phase 3: it waits for the payment on testnet", await waitingFor(), (await bodyText()).replace(/\s+/g, " ").slice(0, 160));

  await clickToggle("Mainnet");
  check(
    "phase 3: the new chain does not claim to be waiting for testnet's payment",
    !(await waitingFor()),
    (await bodyText()).replace(/\s+/g, " ").slice(0, 160),
  );
  // The wrong-chain explorer link lives in an href, not in the text, so read the
  // links rather than the words: a testnet hash shown against mainnet would look
  // fine to a text match.
  const explorerHrefs = async () =>
    ((await evaluate(
      `Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => /\\/tx\\//.test(h)).join(' ')`,
    )) as string) ?? "";
  check(
    "phase 3: no stale testnet transaction link is offered",
    !(await explorerHrefs()).includes(FAKE_TX_HASH),
    await explorerHrefs(),
  );
  check(
    "phase 3: no testnet explorer link survives the switch",
    !(await explorerHrefs()).includes("testnet.arc.io"),
    await explorerHrefs(),
  );
  check(
    "phase 3: no warning tells the user to switch to the chain they are on",
    !/is on (Arc Testnet|Arc)[^.]*pointed at \1/.test(await bodyText()),
    "self-contradictory network message",
  );

  // The native door. Nothing about what it sends was covered before: the token
  // phase only proved a button was clickable, so a native send that sent no
  // value, sent it to the wrong address, or sent calldata while advertising the
  // system-emitter path would have passed every test in the suite.
  const sentTxs = async (): Promise<any[]> =>
    JSON.parse(((await evaluate("JSON.stringify(window.__mockTxs || [])")) as string) || "[]");

  const before = (await sentTxs()).length;
  const nativeClick = await clickPay(/Pay \$1 as native/);
  check("phase 4: native pay button is clickable", nativeClick === "clicked", nativeClick);

  for (let i = 0; i < 12 && !(await waitingFor()); i++) await sleep(1000);
  check("phase 4: the native door waits for its payment", await waitingFor(), (await bodyText()).replace(/\s+/g, " ").slice(0, 160));

  const sent = (await sentTxs()).slice(before);
  check("phase 4: the native door asks the wallet for one transaction", sent.length === 1, `sent ${sent.length}`);

  const tx = sent[0]?.params ?? null;
  check("phase 4: it sends value, not a contract call", tx !== null && !tx.data, tx ? `data=${tx.data}` : "no transaction");
  check(
    "phase 4: it sends exactly $1 of native USDC",
    tx !== null && BigInt(tx.value ?? "0x0") === 10n ** 18n,
    tx ? `value=${tx.value} (${BigInt(tx.value ?? "0x0")})` : "no transaction",
  );
  check(
    "phase 4: it pays the merchant address shown on the page",
    typeof tx?.to === "string" && tx.to.toLowerCase() === ACCOUNT.toLowerCase(),
    tx ? `to=${tx.to} expected=${ACCOUNT}` : "no transaction",
  );

  // A hash with no log behind it must not turn into a payment row. This is the
  // "fake data" shape: the wallet reported a transaction, so the UI is free to
  // link it for tracking, but nothing on chain has happened yet and the door
  // must stay shut.
  const bodyAfterNative = (await bodyText()).replace(/\s+/g, " ");
  check(
    "phase 4: an unmined transaction never shows as a payment",
    !/Paid\b/.test(bodyAfterNative),
    bodyAfterNative.slice(0, 160),
  );
  check(
    "phase 4: it still waits rather than claiming the door is open",
    await waitingFor(),
    bodyAfterNative.slice(0, 160),
  );
  check(
    "phase 4: the pending native tx is traceable while it waits",
    (await explorerHrefs()).includes(FAKE_TX_HASH),
    await explorerHrefs(),
  );

  // Cancelling the wallet prompt. Reported as: cancel the confirmation, and the
  // app says Paid citing an old transaction. The button has to survive a cancelled
  // attempt, and nothing may claim the door is open.
  await evaluate("window.__mockRejectSend = true");
  const cancelClick = await clickPay(/Pay \$1 as native/);
  check("phase 5: the native door can be tried again", cancelClick === "clicked", cancelClick);

  let rejected = false;
  for (let i = 0; i < 15 && !rejected; i++) {
    await sleep(1000);
    rejected = /reject|denied|cancel|declin/i.test(await bodyText());
  }
  const afterCancel = (await bodyText()).replace(/\s+/g, " ");
  check("phase 5: cancelling is reported honestly", rejected, afterCancel.slice(0, 160));
  check(
    "phase 5: cancelling does not claim the door is paid",
    !/Paid\b/.test(afterCancel),
    afterCancel.slice(0, 160),
  );
  check(
    "phase 5: cancelling does not leave a transaction link behind",
    !(await explorerHrefs()).includes(FAKE_TX_HASH),
    await explorerHrefs(),
  );
  const retryable = (await evaluate(
    `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Pay \\$1 as native/.test(x.textContent)); return b ? !b.disabled : null; })()`,
  )) as boolean | null;
  check("phase 5: the native button is usable again after a cancel", retryable === true, `disabled=${retryable}`);

  console.log(`\n${failures === 0 ? "Hydration test passed." : `${failures} hydration check(s) failed.`}`);
  ws.close();
  chrome.kill();
  server.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
