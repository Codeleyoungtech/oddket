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
    corners?: number;
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
      db.prepare("DELETE FROM corners_predictions"),
      db.prepare("DELETE FROM odds_snapshots"),
      db.prepare("DELETE FROM outcomes"),
      db.prepare("DELETE FROM parlay_bets"),
      db.prepare("DELETE FROM fixtures"),
      db.prepare("UPDATE settings SET bankroll = 10000, kelly_fraction = 0.25, edge_threshold = 0.03, daily_stop_loss = 500, weekly_stop_loss = 1500, default_stake_cap_pct = 0.05, leagues = '[]', markets = '[\"h2h\",\"totals\"]' WHERE id = 1"),
    ]);
  }

  const data = buildSeedDatabase();

  await upsertFixtures(db, data.fixtures);
  await upsertOdds(db, data.odds);
  await upsertPredictions(db, data.predictions);

  // Batch insert bets
  const { batchExecute } = await import("./db");
  const betStmt = db.prepare(
    `INSERT INTO bets (id, fixture_id, market, selection, odds, stake, bankroll_at_bet, edge, model_probability, status, outcome_amount, placed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  );
  const betBatch = data.bets.map((b) =>
    betStmt.bind(b.id, b.fixtureId, b.market, b.selection, b.odds, b.stake, b.bankrollAtBet, b.edge, b.modelProbability, b.status, b.outcomeAmount ?? null, b.placedAt),
  );
  if (betBatch.length) await batchExecute(db, betBatch);

  // Batch insert clv
  const clvStmt = db.prepare(
    `INSERT OR REPLACE INTO clv_results (id, bet_id, opening_odds, closing_odds, clv, captured_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  const clvBatch = data.clv.map((c) =>
    clvStmt.bind(c.id, c.betId, c.openingOdds, c.closingOdds, c.clv, c.capturedAt),
  );
  if (clvBatch.length) await batchExecute(db, clvBatch);

  await upsertOutcomes(db, data.outcomes);
  await putSettings(db, data.settings);

  if (data.cornerPredictions && data.cornerPredictions.length > 0) {
    const { upsertCornerPredictions } = await import("./db");
    const cornerRows = data.cornerPredictions.map((cp) => ({
      id: cp.id,
      fixtureId: cp.fixtureId,
      team: cp.team,
      side: cp.side,
      predictedCorners: cp.predictedCorners,
      confidenceLow: cp.confidenceLow,
      confidenceHigh: cp.confidenceHigh,
      lineProbs: JSON.stringify(cp.lineProbs),
      modelVersion: cp.modelVersion,
      createdAt: cp.createdAt,
    }));
    await upsertCornerPredictions(db, cornerRows);
  }

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
      corners: data.cornerPredictions?.length ?? 0,
    },
  };
}
