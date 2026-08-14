/**
 * Export UPCOMING fixtures (from The Odds API, sport=soccer_epl) into
 * model/data/fixtures.json — the identity file the Python model consumes.
 *
 *   node scripts/export-fixtures.mjs
 *   cd ../model && .venv/bin/python scripts/predict.py --source fixtures --data data/fixtures.json
 *   curl -X POST http://localhost:8787/api/predictions/ingest \
 *     -H 'Content-Type: application/json' -d @model/output/predictions.json
 *
 * IMPORTANT: this file contains ONLY fixture identity (id, home team, away
 * team). Team-level features (form, Elo strength, goals, shots, H2H) are
 * computed by the model from the real historical dataset (features.py) —
 * never from the current odds. That kills the circularity where the old
 * model was fed features derived from the very odds it was supposed to beat.
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

const matches = fixtures.map((f) => ({
  id: f.id,
  league: f.league,
  home: f.home_team,
  away: f.away_team,
}));

mkdirSync(join(__dirname, "..", "..", "model", "data"), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta: { source: "live-odds", n_matches: matches.length }, matches }, null, 2));

console.log(`Exported ${matches.length} live fixtures -> ${OUT}`);
for (const m of matches) {
  console.log(`  ${m.home} vs ${m.away}`);
}
