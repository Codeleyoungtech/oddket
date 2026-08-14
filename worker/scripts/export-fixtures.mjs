/**
 * Export UPCOMING fixtures (from The Odds API, sport=soccer_epl) into
 * model/data/fixtures.json — what the Python model consumes.
 *
 *   node scripts/export-fixtures.mjs
 *   cd ../model && .venv/bin/python scripts/predict.py --source fixtures --data data/fixtures.json
 *   curl -X POST http://localhost:8787/api/predictions/ingest \
 *     -H 'Content-Type: application/json' -d @model/output/predictions.json
 *
 * Each fixture carries: id, home, away, league, commenceTime (unix seconds)
 * and the current best h2h odds {home, draw, away} (highest available price
 * across bookmakers, closing snapshot preferred). Team-level features are
 * computed by the model from real history; the odds are used ONLY for the
 * model's market-implied features (odd_h/d/a) — they are not disguised as
 * team strength, and the EV engine compares the model's own probability
 * against the same market line.
 */

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const DB_FILE = join(root, ".local", "oddket.db");
const OUT = join(root, "..", "model", "data", "fixtures.json");

const sqlite = new DatabaseSync(DB_FILE);

// Live fixtures are the ones ingested from The Odds API (any sport key — the
// seed demo fixtures use sport = 'soccer'). Only export leagues the user has
// selected in Settings (defaults to all when unset).
const LEAGUE_SPORTS = {
  "English Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  "Bundesliga": "soccer_germany_bundesliga",
  "Serie A": "soccer_italy_serie_a",
};

const settingsRow = sqlite.prepare("SELECT leagues FROM settings WHERE id = 1").get();
let leagueNames = [];
try {
  leagueNames = JSON.parse(settingsRow?.leagues ?? "[]");
} catch {
  leagueNames = [];
}
const sports = leagueNames.map((n) => LEAGUE_SPORTS[n]).filter(Boolean);
const where = sports.length > 0
  ? `sport IN (${sports.map(() => "?").join(",")}) AND status = 'scheduled'`
  : "sport != 'soccer' AND status = 'scheduled'";
const fixtures = sqlite.prepare(`SELECT * FROM fixtures WHERE ${where}`).all(...sports);

const odds = sqlite.prepare("SELECT * FROM odds_snapshots WHERE is_closing = 0").all();

function bestOdds(fixtureId, market, selection) {
  let best = null;
  for (const o of odds) {
    if (o.fixture_id !== fixtureId || o.market !== market || o.selection !== selection) continue;
    if (best === null || o.odds > best) best = o.odds;
  }
  return best;
}

const matches = fixtures.map((f) => ({
  id: f.id,
  league: f.league,
  home: f.home_team,
  away: f.away_team,
  commenceTime: Number(f.commence_time) || 0,
  odds: {
    home: bestOdds(f.id, "h2h", "home"),
    draw: bestOdds(f.id, "h2h", "draw"),
    away: bestOdds(f.id, "h2h", "away"),
    // totals market (over/under 2.5) for the ou model
    over: bestOdds(f.id, "totals", "over"),
    under: bestOdds(f.id, "totals", "under"),
  },
}));

mkdirSync(join(__dirname, "..", "..", "model", "data"), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta: { source: "live-odds", n_matches: matches.length }, matches }, null, 2));

console.log(`Exported ${matches.length} live fixtures -> ${OUT}`);
for (const m of matches) {
  console.log(`  ${m.home} vs ${m.away} | odds ${JSON.stringify(m.odds)}`);
}
