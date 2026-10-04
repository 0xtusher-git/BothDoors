/**
 * Shared server launcher for the browser and hydration checks.
 *
 * Both need a *production* server, which means a production build. Building
 * into `.next` would break as soon as anyone has `next dev` running, because
 * dev overwrites the same directory. So these checks get their own dist dir and
 * build it themselves, making them independent of whatever else is running.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ProductionServer = {
  /** Resolves once the app answers HTTP, or throws if it never does. */
  ready: () => Promise<void>;
  stop: () => void;
};

export async function startProductionServer(port: number, label: string): Promise<ProductionServer> {
  const distDir = `.next-${label}`;
  const nextBin = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
  const env = { ...process.env, NEXT_DIST_DIR: distDir };

  await new Promise<void>((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { stdio: "ignore", env });
    build.on("error", reject);
    build.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`production build for the ${label} check failed (exit ${String(code)})`)),
    );
  });

  const next = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    stdio: "ignore",
    env,
  });
  const base = `http://localhost:${port}`;

  return {
    ready: async () => {
      // 90s: the build is already done, so this is only server boot, but a cold
      // first start on a slow machine still wants more than a minute.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          if ((await fetch(base, { signal: AbortSignal.timeout(3000) })).ok) return;
        } catch {
          /* not yet */
        }
      }
      throw new Error("server did not come up in 90s");
    },
    stop: () => next.kill(),
  };
}
