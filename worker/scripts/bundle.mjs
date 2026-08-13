/**
 * Bundle the worker for local testing without workerd.
 * workerd can't run under proot/Termux, so we use plain esbuild — the bundle
 * is a standard ESM module exporting `fetch` and `scheduled`, which we drive
 * directly in Node with a D1 adapter (see test/e2e.mjs).
 *
 * Usage: node scripts/bundle.mjs
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

mkdirSync(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(root, "dist", "worker.mjs"),
  sourcemap: false,
  logLevel: "info",
});

console.log("Bundled worker -> worker/dist/worker.mjs");
