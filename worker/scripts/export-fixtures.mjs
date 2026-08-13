/**
 * Export LIVE fixtures (from The Odds API, sport=soccer_epl) + their best h2h
 * odds into model/data/fixtures.json — the shape the Python model expects.
 *
 *   node scripts/export-fixtures.mjs
 *   cd ../model && .venv/bin/python scripts/predict.py --source fixtures --data data/fixtures.json
 *   curl -X POST http://localhost:8787/api/predictions/ingest \
 *     -H 'Content-Type: application/json' -d @model/output/predictions.json
 *
 * Features are derived from the market: implied h2h probabilities become the
 * strength estimates, so the model sees real, odds-driven inputs.
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

// Live fixtures are the ones ingested from The Odds API (sport = soccer_epl);
// seed fixtures use sport = 'soccer'.
const fixtures = sqlite
  .prepare("SELECT * FROM fixtures WHERE sport = 'soccer_epl' AND status = 'scheduled'")
  .all();

const odds = sqlite
  .prepare("SELECT * FROM odds_snapshots WHERE is_closing = 0")
  .all();

const bestByFixture = new Map();
for (const o of odds) {
  if (o.market !== "h2h") continue;
  const cur = bestByFixture.get(o.fixture_id) ?? {};
  if (!cur[o.selection] || o.odds > cur[o.selection].odds) {
    cur[o.selection] = { odds: o.odds, bookmaker: o.bookmaker };
  }
  bestByFixture.set(o.fixture_id, cur);
}

const matches = [];
for (const f of fixtures) {
  const h2h = bestByFixture.get(f.id);
  const home = h2h?.home?.odds;
  const draw = h2h?.draw?.odds;
  const away = h2h?.away?.odds;
  if (!home || !draw || !away) continue; // need a full h2h line

  // Margin-stripped implied probabilities (simple proportional method).
  const inv = { home: 1 / home, draw: 1 / draw, away: 1 / away };
  const sum = inv.home + inv.draw + inv.away;
  const p = { home: inv.home / sum, draw: inv.draw / sum, away: inv.away / sum };

  matches.push({
    id: f.id,
    league: f.league,
    home: f.home_team,
    away: f.away_team,
    home_goals: 0,
    away_goals: 0,
    features: {
      home_strength: Math.round(p.home * 10) / 10,
      away_strength: Math.round(p.away * 10) / 10,
      home_adv: 1.0,
      form_diff: 0.0,
      exp_home: Math.round((1.35 + p.home * 1.2) * 100) / 100,
      exp_away: Math.round((1.15 + p.away * 1.2) * 100) / 100,
    },
    outcome: 0, // unknown — unused by predict.py
    probs: { home: p.home, draw: p.draw, away: p.away },
    odds: { home, draw, away },
  });
}

mkdirSync(join(__dirname, "..", "..", "model", "data"), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta: { source: "live-odds", n_matches: matches.length }, matches }, null, 2));

console.log(`Exported ${matches.length} live fixtures -> ${OUT}`);
for (const m of matches) {
  console.log(`  ${m.home} vs ${m.away} | P(home)=${m.probs.home.toFixed(3)} draw=${m.probs.draw.toFixed(3)} away=${m.probs.away.toFixed(3)}`);
}
