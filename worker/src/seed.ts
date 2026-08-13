import { buildSeedDatabase } from "@oddket/core";
import {
  insertBet,
  insertClv,
  putSettings,
  upsertFixtures,
  upsertOdds,
  upsertOutcomes,
  upsertPredictions,
} from "./db";

export interface SeedResult {
  seeded: boolean;
  note: string;
  counts: {
    fixtures: number;
    odds: number;
    predictions: number;
    bets: number;
    clv: number;
    outcomes: number;
  };
}

/** Populate D1 from the deterministic demo dataset. Wipes on force. */
export async function seedDatabase(db: D1Database, force: boolean): Promise<SeedResult> {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM fixtures").first<{ n: number }>();
  if (!force && existing && existing.n > 0) {
    return {
      seeded: false,
      note: "Database already has data — pass ?force=1 to reseed.",
      counts: { fixtures: existing.n, odds: 0, predictions: 0, bets: 0, clv: 0, outcomes: 0 },
    };
  }

  if (force) {
    await db.batch([
      db.prepare("DELETE FROM clv_results"),
      db.prepare("DELETE FROM bets"),
      db.prepare("DELETE FROM predictions"),
      db.prepare("DELETE FROM odds_snapshots"),
      db.prepare("DELETE FROM outcomes"),
      db.prepare("DELETE FROM fixtures"),
      db.prepare("UPDATE settings SET bankroll = 10000, kelly_fraction = 0.25, edge_threshold = 0.03, daily_stop_loss = 500, weekly_stop_loss = 1500, default_stake_cap_pct = 0.05, leagues = '[]', markets = '[\"h2h\",\"totals\"]' WHERE id = 1"),
    ]);
  }

  const data = buildSeedDatabase();

  await upsertFixtures(db, data.fixtures);
  await upsertOdds(db, data.odds);
  await upsertPredictions(db, data.predictions);
  for (const b of data.bets) await insertBet(db, b);
  for (const c of data.clv) await insertClv(db, c);
  await upsertOutcomes(db, data.outcomes);
  await putSettings(db, data.settings);

  return {
    seeded: true,
    note: force ? "Reseeded (wiped + rebuilt)." : "Seeded demo dataset.",
    counts: {
      fixtures: data.fixtures.length,
      odds: data.odds.length,
      predictions: data.predictions.length,
      bets: data.bets.length,
      clv: data.clv.length,
      outcomes: data.outcomes.length,
    },
  };
}
