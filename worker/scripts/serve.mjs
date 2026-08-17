/**
 * Local dev server for the worker — no workerd required.
 *
 * Bundles src/index.ts with esbuild (see bundle.mjs), backs it with a
 * persistent SQLite database via the D1 adapter, and serves it over HTTP on
 * :8787. This is the proot-friendly replacement for `wrangler dev`:
 *
 *   npm run serve:local          # then:
 *   curl localhost:8787/api/health
 *   curl -X POST localhost:8787/api/seed
 *
 * The database lives at worker/.local/oddket.db and survives restarts.
 */

import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { D1Adapter } from "../test/d1-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const MIGRATIONS = ["0000_init.sql", "0001_tennis.sql", "0002_multiples.sql", "0003_parlays.sql", "0004_settlement_alerts.sql"];
const BUNDLE = join(root, "dist", "worker.mjs");
const DB_DIR = join(root, ".local");
const DB_FILE = join(DB_DIR, "oddket.db");
const PORT = Number(process.env.PORT ?? 8787);

if (!existsSync(BUNDLE)) {
  console.error("Missing bundle — run `npm run serve:local` (bundles first) or `node scripts/bundle.mjs`.");
  process.exit(1);
}

mkdirSync(DB_DIR, { recursive: true });

const sqlite = new DatabaseSync(DB_FILE);
for (const m of MIGRATIONS) sqlite.exec(readFileSync(join(root, "migrations", m), "utf8"));
const DB = new D1Adapter(sqlite);

const worker = (await import(BUNDLE)).default;

// Forward worker env bindings from the shell so live mode works locally:
//   export ODDS_API_KEY=your_key && npm run serve:local
const bindings = { DB };
for (const k of ["ODDS_API_KEY", "ODDS_SPORT", "ODDS_REGIONS", "ODDS_MARKETS", "ODDS_FETCH_LIMIT", "TENNIS_SPORTS", "PREDICT_SECRET", "DASHBOARD_ORIGIN"]) {
  if (process.env[k]) bindings[k] = process.env[k];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const request = new Request(url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: body.length > 0 ? body : undefined,
    });

    const response = await worker.fetch(request, bindings, { waitUntil: () => Promise.resolve() });

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("[serve] error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`OddKet worker API on http://localhost:${PORT}`);
  console.log(`  DB: ${DB_FILE} (SQLite, D1-compatible)`);
  console.log(`  Mode: ${bindings.ODDS_API_KEY ? "LIVE (ODDS_API_KEY set)" : "demo (no ODDS_API_KEY)"}`);
  console.log(`  Try: curl http://localhost:${PORT}/api/health`);
});
