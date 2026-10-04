/**
 * `next dev` pointed at its own dist directory.
 *
 * `next dev` and `next build` both default to `.next`, so running a production
 * build while the dev server is up drops a build's vendor chunks into the middle
 * of a running server. It does not fail loudly: the dev server keeps answering
 * 200 on routes it has already recompiled and 500s the rest, with a missing-file
 * error pointing at a file nobody deleted on purpose.
 *
 * Isolating dev means `npm run build` can be run to check a build without taking
 * the dev server down. `.next-*` is already gitignored.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextBin = fileURLToPath(import.meta.resolve("next/dist/bin/next"));
const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-dev" },
});

// Relay the signals so Ctrl-C stops the server rather than orphaning it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
