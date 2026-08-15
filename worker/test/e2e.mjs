/**
 * End-to-end worker test (no workerd required).
 *
 * workerd can't run under proot/Termux (tcmalloc address-space limits), so this
 * harness runs the real thing a different way:
 *   1. Creates an in-memory SQLite database (node:sqlite — D1-compatible SQL).
 *   2. Applies the actual migration file (worker/migrations/0000_init.sql).
 *   3. Wraps it in a minimal D1 adapter (prepare/bind/all/first/run/batch).
 *   4. Imports the esbuild bundle of src/index.ts and exercises every route.
 *
 * Usage:
 *   cd worker && node test/e2e.mjs            (assumes dist/worker.mjs exists)
 *   npm run test:local                        (bundles then runs)
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { D1Adapter } from "./d1-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ["0000_init.sql", "0001_tennis.sql"];
const BUNDLE = join(__dirname, "..", "dist", "worker.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail ? `— ${detail}` : ""}`);
  }
}

/* ---------------- test body ---------------- */

if (!existsSync(BUNDLE)) {
  console.error("Missing bundle — run `npm run test:local` (or `node scripts/bundle.mjs` first).");
  process.exit(1);
}

const sqlite = new DatabaseSync(":memory:");
for (const m of MIGRATIONS) sqlite.exec(readFileSync(join(__dirname, "..", "migrations", m), "utf8"));
const DB = new D1Adapter(sqlite);

const worker = (await import(BUNDLE)).default;
const env = { DB }; // no ODDS_API_KEY → demo mode

async function api(method, path, body) {
  const req = new Request(`http://worker.local${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, { waitUntil: () => {} });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

console.log("\n[1] health");
{
  const r = await api("GET", "/api/health");
  check("200 + demo mode", r.status === 200 && r.json?.mode === "demo");
}

console.log("\n[2] seed");
{
  const r = await api("POST", "/api/seed");
  check("seeded=true", r.status === 200 && r.json?.seeded === true, JSON.stringify(r.json));
  const counts = r.json?.counts ?? {};
  check("fixtures>0", counts.fixtures > 0, `fixtures=${counts.fixtures}`);
  check("predictions>0", counts.predictions > 0, `predictions=${counts.predictions}`);
  check("bets>0", counts.bets > 0, `bets=${counts.bets}`);
  check("clv>0", counts.clv > 0, `clv=${counts.clv}`);
  const again = await api("POST", "/api/seed");
  check("second seed blocked (409)", again.status === 409);
  const force = await api("POST", "/api/seed?force=1");
  check("force reseed works", force.status === 200 && force.json?.seeded === true);
}

console.log("\n[3] dashboard / db");
{
  const d = await api("GET", "/api/dashboard");
  check("200", d.status === 200);
  check("summary.bankrollNow present", typeof d.json?.summary?.bankrollNow === "number", `bankrollNow=${d.json?.summary?.bankrollNow}`);
  check("summary.totalReturn present", typeof d.json?.summary?.totalReturn === "number", JSON.stringify(d.json?.summary));
  const db = await api("GET", "/api/db");
  check("db returns fixtures", Array.isArray(db.json?.fixtures) && db.json.fixtures.length > 0);
  check("db returns bets", Array.isArray(db.json?.bets));
}

console.log("\n[4] fixtures / predictions");
{
  const f = await api("GET", "/api/fixtures");
  check("fixtures list", f.status === 200 && Array.isArray(f.json) && f.json.length > 0);
  const scheduled = await api("GET", "/api/fixtures?status=scheduled");
  check("filter by status", scheduled.json.every((x) => x.status === "scheduled"));
  const p = await api("GET", "/api/predictions");
  check("predictions list", p.status === 200 && Array.isArray(p.json) && p.json.length > 0);
}

console.log("\n[5] slips + multiple");
{
  const s = await api("GET", "/api/slips");
  check("slips list", s.status === 200 && Array.isArray(s.json) && s.json.length > 0);
  const legs = s.json;
  const key = `${legs[0].fixture.id}:${legs[0].market}:${legs[0].selection}`;
  const m = await api("POST", "/api/slips/multiple", { legIds: [key, legs[1] && `${legs[1].fixture.id}:${legs[1].market}:${legs[1].selection}`] });
  check("multiple built", m.status === 200 && m.json?.ok === true && m.json?.multiple, JSON.stringify(m.json));
  check("multiple advertisedOdds>1", (m.json?.multiple?.advertisedOdds ?? 0) > 1);
  const empty = await api("POST", "/api/slips/multiple", { legIds: ["nope:no:way"] });
  check("invalid legs rejected (400)", empty.status === 400);
}

console.log("\n[6] bets + settlement");
{
  // pick a fixture with a prediction to log a bet against
  const db = await api("GET", "/api/db");
  const fixture = db.json.fixtures.find((x) => x.status !== "finished") ?? db.json.fixtures[0];
  const settings = await api("GET", "/api/settings");
  const stake = 100;
  const bet = {
    fixtureId: fixture.id,
    market: "h2h",
    selection: "home",
    odds: 2.1,
    stake,
    edge: 0.05,
    modelProbability: 0.55,
  };
  const placed = await api("POST", "/api/bets", bet);
  check("bet placed (201)", placed.status === 201 && placed.json?.ok === true, JSON.stringify(placed.json));
  const betId = placed.json?.bet?.id;
  check("bet has id", typeof betId === "string");

  const overCap = await api("POST", "/api/bets", { ...bet, stake: 999999, odds: 2.0 });
  check("stake over cap rejected (400)", overCap.status === 400);

  const missing = await api("POST", "/api/bets", { fixtureId: fixture.id });
  check("missing fields rejected (400)", missing.status === 400);

  const unknown = await api("POST", "/api/bets", { fixtureId: "nope", market: "h2h", selection: "home", odds: 2.0, stake: 10 });
  check("unknown fixture rejected (404)", unknown.status === 404);

  const list = await api("GET", "/api/bets");
  check("bet appears in list", list.json.some((b) => b.id === betId));

  // settle via outcome
  const homeWin = await api("POST", "/api/outcomes", [{ fixtureId: fixture.id, homeScore: 3, awayScore: 0 }]);
  check("outcome stored + settled", homeWin.status === 200 && homeWin.json?.betsSettled >= 1, JSON.stringify(homeWin.json));
  const after = await api("GET", "/api/bets");
  const settledBet = after.json.find((b) => b.id === betId);
  check("bet marked won", settledBet?.status === "won", JSON.stringify(settledBet));
  check("payout correct", Math.abs((settledBet?.outcomeAmount ?? 0) - Math.round(stake * (2.1 - 1) * 100) / 100) < 0.001, `payout=${settledBet?.outcomeAmount}`);

  const bad = await api("POST", "/api/outcomes", [{ fixtureId: fixture.id }]);
  check("bad outcome rejected (400)", bad.status === 400);
}

console.log("\n[7] CLV");
{
  const db = await api("GET", "/api/db");
  const bet = db.json.bets[0];
  const r = await api("POST", "/api/clv", { betId: bet.id, openingOdds: 2.0, closingOdds: 1.8 });
  check("clv stored (201)", r.status === 201 && r.json?.ok === true, JSON.stringify(r.json));
  const expectClv = Math.round(((2.0 - 1.8) / 1.8) * 10000) / 10000;
  check("clv value correct", Math.abs((r.json?.clv?.clv ?? 0) - expectClv) < 1e-9, `clv=${r.json?.clv?.clv}`);
  const missing = await api("POST", "/api/clv", { betId: bet.id });
  check("missing clv fields rejected (400)", missing.status === 400);

  const series = await api("GET", "/api/clv");
  check("clv series has points", Array.isArray(series.json?.series) && series.json.series.length > 0, JSON.stringify(series.json?.series));
}

console.log("\n[8] calibration + backtest");
{
  const c = await api("GET", "/api/calibration");
  check("calibration bins", c.status === 200 && Array.isArray(c.json?.bins) && c.json.bins.length === 10, JSON.stringify(c.json?.bins?.length));
  check("calibration has brier + sampleSize", typeof c.json?.brier === "number" && c.json?.sampleSize > 0, `brier=${c.json?.brier} n=${c.json?.sampleSize}`);
  const b = await api("GET", "/api/backtest");
  check("backtest rows", b.status === 200 && Array.isArray(b.json?.rows), JSON.stringify(b.json));
  check("backtest nBets>0", (b.json?.nBets ?? 0) > 0, `nBets=${b.json?.nBets}`);
  check("backtest roiPct is number", typeof b.json?.roiPct === "number");
}

console.log("\n[9] settings");
{
  const s = await api("GET", "/api/settings");
  check("defaults", s.status === 200 && s.json?.bankroll === 10000 && s.json?.kellyFraction === 0.25);
  const u = await api("PUT", "/api/settings", { bankroll: 25000, kellyFraction: 0.3 });
  check("settings updated", u.status === 200 && u.json?.settings?.bankroll === 25000, JSON.stringify(u.json));
  const s2 = await api("GET", "/api/settings");
  check("persisted", s2.json?.bankroll === 25000);
  // restore
  await api("PUT", "/api/settings", { bankroll: 10000, kellyFraction: 0.25 });
}

console.log("\n[10] predictions ingest");
{
  const db = await api("GET", "/api/db");
  const fixture = db.json.fixtures[0];
  const r = await api("POST", "/api/predictions/ingest", [
    { fixtureId: fixture.id, market: "h2h", selection: "away", probability: 0.31, confidenceLow: 0.25, confidenceHigh: 0.38, modelVersion: "e2e-test" },
  ]);
  check("ingested (200)", r.status === 200 && r.json?.ingested === 1, JSON.stringify(r.json));
  const bad = await api("POST", "/api/predictions/ingest", []);
  check("empty rejected (400)", bad.status === 400);
  const ps = await api("GET", "/api/predictions");
  check("prediction present", ps.json.some((p) => p.modelVersion === "e2e-test"));
}

console.log("\n[11] manual trigger routes (demo no-op without key)");
{
  const i = await api("POST", "/api/ingest");
  check("POST /api/ingest demo no-op", i.status === 200 && i.json?.mode === "demo" && i.json?.eventsPulled === 0, JSON.stringify(i.json));
  const c = await api("POST", "/api/closing");
  check("POST /api/closing demo no-op", c.status === 200 && c.json?.mode === "demo" && c.json?.pendingBets === 0, JSON.stringify(c.json));
}

console.log("\n[12] scheduled (demo no-op)");
{
  const ctx = { waitUntil: () => Promise.resolve() };
  const r1 = await worker.scheduled({ cron: "0 9,18 * * *" }, env, ctx);
  check("ingest cron demo no-op", r1?.mode === "demo" && r1?.eventsPulled === 0, JSON.stringify(r1));
  const r2 = await worker.scheduled({ cron: "30 18 * * *" }, env, ctx);
  check("closing cron demo no-op", r2?.mode === "demo" && r2?.pendingBets === 0, JSON.stringify(r2));
  const r3 = await worker.scheduled({ cron: "* * * * *" }, env, ctx);
  check("unknown cron handled", r3?.ok === false, JSON.stringify(r3));
}

console.log("\n[13] TENNIS (isolated tables + endpoints)");
{
  // Insert a tennis match + odds + predictions directly into tennis tables.
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO tennis_matches (id, sport, league, home_team, away_team, commence_time, status) VALUES (?,?,?,?,?,?,?)")
    .run("t1", "tennis", "ATP Wimbledon", "Alcaraz", "Sinner", now - 2 * 86400, "finished");
  sqlite.prepare("INSERT INTO tennis_matches (id, sport, league, home_team, away_team, commence_time, status) VALUES (?,?,?,?,?,?,?)")
    .run("t2", "tennis", "ATP Wimbledon", "Djokovic", "Medvedev", now + 86400, "scheduled");
  sqlite.prepare("UPDATE tennis_matches SET winner = 'home' WHERE id = 't1'").run();
  sqlite.prepare("INSERT INTO tennis_odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing) VALUES (?,?,?,?,?,?,?,?)")
    .run("to1", "t1", "h2h", "home", 1.5, "Bet365", now - 86400, 1);
  sqlite.prepare("INSERT INTO tennis_odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing) VALUES (?,?,?,?,?,?,?,?)")
    .run("to2", "t1", "h2h", "away", 2.6, "Bet365", now - 86400, 1);
  sqlite.prepare("INSERT INTO tennis_odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing) VALUES (?,?,?,?,?,?,?,?)")
    .run("to3", "t2", "h2h", "home", 1.8, "Pinnacle", now - 3600, 0);
  sqlite.prepare("INSERT INTO tennis_odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing) VALUES (?,?,?,?,?,?,?,?)")
    .run("to4", "t2", "h2h", "away", 2.1, "Pinnacle", now - 3600, 0);
  sqlite.prepare("INSERT INTO tennis_predictions (id, fixture_id, market, selection, probability, confidence_low, confidence_high, model_version, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("tp1", "t2", "h2h", "home", 0.62, 0.55, 0.69, "tennis-test", now - 3600);

  const db = await api("GET", "/api/tennis/db");
  check("tennis db has matches", Array.isArray(db.json?.fixtures) && db.json.fixtures.length === 2, JSON.stringify(db.json?.fixtures?.length));
  check("tennis outcomes synthesized from winner", db.json?.outcomes?.length === 1 && db.json.outcomes[0].homeScore === 1, JSON.stringify(db.json?.outcomes));
  check("tennis db isolated from football bets", Array.isArray(db.json?.bets) && db.json.bets.length === 0, `tennis bets=${db.json?.bets?.length}`);

  const dash = await api("GET", "/api/tennis/dashboard");
  check("tennis dashboard 200", dash.status === 200 && typeof dash.json?.summary?.bankrollNow === "number");

  // Log a tennis bet, settle it, check payout + CLV.
  const bet = { fixtureId: "t1", selection: "home", odds: 1.5, stake: 100, edge: 0.05, modelProbability: 0.62 };
  const placed = await api("POST", "/api/tennis/bets", bet);
  check("tennis bet placed (201)", placed.status === 201 && placed.json?.ok === true, JSON.stringify(placed.json));
  const betId = placed.json?.bet?.id;
  const list = await api("GET", "/api/tennis/bets");
  check("tennis bet appears", list.json?.some((b) => b.id === betId));
  // Settlement runs on the outcomes POST — re-record t1's result to settle it.
  const settle = await api("POST", "/api/tennis/outcomes", [{ fixtureId: "t1", winner: "home" }]);
  check("tennis settlement triggered", settle.status === 200 && settle.json?.betsSettled >= 1, JSON.stringify(settle.json));
  const list2 = await api("GET", "/api/tennis/bets");
  const settledBet = list2.json?.find((b) => b.id === betId);
  check("tennis bet settled won (winner=home)", settledBet?.status === "won", JSON.stringify(settledBet));
  check("tennis payout correct", Math.abs((settledBet?.outcomeAmount ?? 0) - 50) < 0.001, `payout=${settledBet?.outcomeAmount}`);

  const clv = await api("POST", "/api/tennis/clv", { betId, openingOdds: 1.6, closingOdds: 1.5 });
  check("tennis clv stored (201)", clv.status === 201 && clv.json?.ok === true, JSON.stringify(clv.json));
  const clvSeries = await api("GET", "/api/tennis/clv");
  check("tennis clv series", Array.isArray(clvSeries.json?.series) && clvSeries.json.series.length > 0);

  // Slips: t2 has a prediction + odds above the edge threshold.
  const slips = await api("GET", "/api/tennis/slips");
  check("tennis slips flag h2h home", slips.status === 200 && slips.json?.some((l) => l.fixture.id === "t2" && l.selection === "home"), JSON.stringify(slips.json?.map((l) => `${l.fixture.id}:${l.selection}`)));

  // Record an outcome on the scheduled match → settles any pending bets.
  const out = await api("POST", "/api/tennis/outcomes", [{ fixtureId: "t2", winner: "away" }]);
  check("tennis outcome stored", out.status === 200 && out.json?.outcomesStored === 1, JSON.stringify(out.json));
  const db2 = await api("GET", "/api/tennis/db");
  check("tennis outcome synthesized", db2.json?.outcomes?.length === 2, `outcomes=${db2.json?.outcomes?.length}`);

  // Predictions ingest + calibration.
  const pi = await api("POST", "/api/tennis/predictions/ingest", [{ fixtureId: "t1", selection: "home", probability: 0.7, confidenceLow: 0.6, confidenceHigh: 0.8, modelVersion: "e2e-tennis" }]);
  check("tennis predictions ingest", pi.status === 200 && pi.json?.ingested === 1, JSON.stringify(pi.json));
  const cal = await api("GET", "/api/tennis/calibration");
  check("tennis calibration bins", cal.status === 200 && Array.isArray(cal.json?.bins) && cal.json.bins.length === 10);

  // Manual triggers demo no-op (no ODDS_API_KEY).
  const ti = await api("POST", "/api/tennis/ingest");
  check("tennis ingest demo no-op", ti.status === 200 && ti.json?.mode === "demo" && ti.json?.eventsPulled === 0, JSON.stringify(ti.json));
  const tc = await api("POST", "/api/tennis/closing");
  check("tennis closing demo no-op", tc.status === 200 && tc.json?.mode === "demo" && tc.json?.pendingBets === 0, JSON.stringify(tc.json));

  const back = await api("GET", "/api/tennis/backtest");
  check("tennis backtest 200", back.status === 200, JSON.stringify(back.json));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
