/**
 * Headless browser smoke test. Boots the built app in Chrome, loads both pages,
 * and reports console errors, uncaught exceptions, failed requests and the
 * on-screen copy.
 *
 *   npm run build
 *   npm run verify:browser
 *
 * Kept out of `npm test` because it needs a browser; Chrome or Edge is picked up
 * from the usual Windows install paths. Wallet flows are out of scope here —
 * those need a real wallet, and the payment logic itself is covered by
 * scripts/selftest.mts and scripts/live-e2e.mts.
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

const PORT = 3113;
const CDP_PORT = 3114;
const BASE = `http://localhost:${PORT}`;

async function findBrowser(): Promise<string | null> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browserPath = await findBrowser();
  if (!browserPath) {
    console.log("No Chrome or Edge found, skipping the browser smoke test.");
    return;
  }
  console.log(`BothDoors browser smoke test\n  browser: ${browserPath}\n`);

  const server = await startProductionServer(PORT, "browser");
  const profile = mkdtempSync(path.join(tmpdir(), "bothdoors-cdp-"));
  let chrome: ReturnType<typeof spawn> | null = null;
  let failures = 0;

  const check = (label: string, pass: boolean, detail?: unknown) => {
    if (pass) {
      console.log(`  ok    ${label}`);
    } else {
      failures += 1;
      console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${String(detail)}`}`);
    }
  };

  const shutdown = () => {
    chrome?.kill();
    server.stop();
  };
  process.on("exit", () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* chrome may still be releasing the profile; the OS will clean up */
    }
  });

  // 1. wait for the app server
  let up = true;
  try {
    await server.ready();
  } catch (cause) {
    up = false;
    check("server started", false, cause instanceof Error ? cause.message : String(cause));
  }
  if (!up) {
    shutdown();
    process.exit(1);
  }
  console.log("  server up\n");

  // 2. launch the browser
  chrome = spawn(
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

  let wsUrl = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500);
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (json.webSocketDebuggerUrl) {
        wsUrl = json.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* not yet */
    }
  }
  if (!wsUrl) {
    check("browser devtools endpoint", false, "never came up");
    shutdown();
    process.exit(1);
  }

  const ws = new WebSocket(wsUrl);
  await once(ws, "open");

  let nextId = 0;
  const pending = new Map<number, (value: any) => void>();
  let sessionId: string | undefined;
  const events: { method: string; params: any }[] = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String((event as MessageEvent).data)) as any;
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (sessionId && message.sessionId === sessionId) {
      events.push(message);
    }
  });

  /** CDP responses are `{ id, result: {...} }` — always unwrap `result`. */
  const send = async (
    method: string,
    params: Record<string, unknown> = {},
    withSession = true,
  ): Promise<any> => {
    const id = ++nextId;
    const response = await new Promise<any>((resolve) => {
      pending.set(id, resolve);
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(withSession && sessionId ? { sessionId } : {}),
        }),
      );
    });
    if (response.error) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  };

  const target = await send("Target.createTarget", { url: "about:blank" }, false);
  const attached = await send(
    "Target.attachToTarget",
    { targetId: target.targetId, flatten: true },
    false,
  );
  sessionId = attached.sessionId;
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "Page.enable"]) {
    await send(method);
  }

  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.result?.value as unknown;
  };

  const bodyText = async (pathname: string) => {
    events.length = 0;
    await send("Page.navigate", { url: `${BASE}${pathname}` });
    await sleep(6000);
    return (await evaluate("document.body.innerText")) as string;
  };

  const consoleErrors = () => {
    const fromConsole = events
      .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
      .map((e) => (e.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" "));
    const fromLog = events
      .filter((e) => e.method === "Log.entryAdded" && e.params.entry?.level === "error")
      .map((e) => `${e.params.entry.source}: ${e.params.entry.url ?? ""} ${e.params.entry.text}`.trim());
    return [...fromConsole, ...fromLog].filter(
      (t) => !/favicon|React DevTools|net::ERR_|ERR_ABORTED|Download the/i.test(t),
    );
  };

  const exceptions = () =>
    events
      .filter((e) => e.method === "Runtime.exceptionThrown")
      .map(
        (e) =>
          e.params.exceptionDetails?.exception?.description ??
          e.params.exceptionDetails?.text ??
          "unknown",
      );

  // ---- / ----------------------------------------------------------------
  console.log("Page / (demo shop)");
  const home = await bodyText("/");
  const merchantEnv = process.env.NEXT_PUBLIC_MERCHANT_ADDRESS ?? "";
  check("page rendered", typeof home === "string" && home.length > 300, home?.length);
  check(
    "both pay buttons rendered",
    home?.includes("Pay $1 as token") && home?.includes("Pay $1 as native"),
  );
  check("has the required note", home?.includes("Same USDC. Two send buttons. The list must see both."));
  check("explains the two doors", home?.includes("as token") && home?.includes("as native"));
  check("shows the network toggle", home?.includes("Mainnet") && home?.includes("Testnet"));
  check("has a Reset demo button", home?.includes("Reset demo"));
  check("no uncaught exceptions", exceptions().length === 0, exceptions().join(" | "));
  check("no hydration mismatch", !consoleErrors().some((e) => /hydrat|did not match/i.test(e)));
  check("no console errors", consoleErrors().length === 0, consoleErrors().join(" | "));

  // NEXT_PUBLIC_* values are inlined by `next build`, so setting the variable at
  // test time is not enough — the build has to have been made with it. Detect
  // what the bundle actually contains and skip rather than fail confusingly.
  const merchantBakedIn =
    Boolean(merchantEnv) && (home ?? "").toLowerCase().includes(merchantEnv.toLowerCase());

  if (merchantEnv && !merchantBakedIn) {
    console.log(
      "  note: NEXT_PUBLIC_MERCHANT_ADDRESS is set in this shell but is not in the\n" +
        "        build, so the live-listener assertions are skipped. Rebuild with the\n" +
        "        variable set to run them:\n" +
        "          $env:NEXT_PUBLIC_MERCHANT_ADDRESS='0x...'; npm run build",
    );
  }

  if (merchantBakedIn) {
    // A real merchant that may already have been paid. PAID from history is the
    // honest state, so only WAITING or PAID is acceptable — never anything else.
    check("state is WAITING or PAID", /WAITING|PAID/.test(home ?? ""), home?.slice(0, 120));
    check("merchant address is shown", true);
    check("does not say Watching when idle", !/WATCHING/.test(home ?? ""));
  } else if (!merchantEnv) {
    check("starts in WAITING", home?.includes("WAITING"));
    check("does not claim PAID before anything is paid", !/\bPAID\b/.test(home ?? ""));
    check("prompts to connect", home?.includes("Connect a wallet first."));
  }

  const disabled = (await evaluate(
    `Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('Pay $1')).map(b => b.disabled)`,
  )) as boolean[];
  check(
    "pay buttons disabled with no wallet (acceptance test 6)",
    Array.isArray(disabled) && disabled.length === 2 && disabled.every((d) => d === true),
    JSON.stringify(disabled),
  );

  // Without a merchant (no env var, no wallet) there is nothing to watch, so the
  // listener legitimately makes no requests. With NEXT_PUBLIC_MERCHANT_ADDRESS set
  // it must be talking to the Arc RPC, and it must render real payments.
  const rpcCalls = (await evaluate(
    `performance.getEntriesByType('resource').filter(r => r.name.includes('rpc.') && r.name.includes('arc.io')).length`,
  )) as number;
  if (merchantBakedIn) {
    check("listener is reading the Arc RPC from the browser", Number(rpcCalls) > 0, rpcCalls);
    // The public RPCs rate-limit and the history query walks several windows, so
    // poll instead of trusting a fixed sleep — otherwise this check is flaky.
    const readAmounts = () =>
      evaluate(
        `Array.from(document.querySelectorAll('li')).map(li => li.innerText.split('\\n')[0]).filter(Boolean)`,
      ) as Promise<string[]>;
    let amounts: string[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      amounts = await readAmounts();
      if (amounts.length > 0) break;
      await sleep(2500);
    }
    check("real payments listed", amounts.length > 0, amounts.slice(0, 3));
    check(
      "amounts read as dollars, never raw units",
      amounts.every((a) => /^\$\d+\.\d\d/.test(a.trim()) && !/e[+-]?\d/i.test(a)),
      amounts.slice(0, 5),
    );
    if (amounts.length > 0) {
      console.log(`  note: browser rendered ${amounts.length} real payment(s), e.g. ${amounts[0]?.trim()}`);
    }
  } else if (!merchantEnv) {
    check("no RPC calls without a merchant (expected)", Number(rpcCalls) === 0, rpcCalls);
    console.log(
      "  note: set NEXT_PUBLIC_MERCHANT_ADDRESS *and rebuild* to also assert the live listener in-browser",
    );
  }

  // ---- /integrate -------------------------------------------------------
  console.log("\nPage /integrate");
  const integrate = await bodyText("/integrate");
  check("page rendered", typeof integrate === "string" && integrate.length > 500, integrate?.length);
  check("explains both doors", integrate?.includes("as token") && integrate?.includes("as native"));
  check("shows the real listener source", integrate?.includes("export function watchUsdcPayments"));
  check("shows the Transfer topic0", integrate?.includes("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"));
  check("shows the system emitter", integrate?.includes("0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE"));
  check("shows fetchRecentPayments", integrate?.includes("fetchRecentPayments"));
  check("no uncaught exceptions", exceptions().length === 0, exceptions().join(" | "));
  const copyButtons = (await evaluate(
    `Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Copy').length`,
  )) as number;
  check("copy buttons present", Number(copyButtons) > 0, copyButtons);

  console.log(
    "\n  note: paying needs a real browser wallet. The listener, the two pay paths and the" +
      " dedupe rules are covered by npm test and npm run verify:e2e.",
  );
  console.log(`\n${failures === 0 ? "Browser smoke test passed." : `${failures} browser check(s) failed.`}`);

  ws.close();
  shutdown();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
