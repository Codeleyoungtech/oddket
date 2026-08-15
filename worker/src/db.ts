import type {
  Bet,
  ClvResult,
  Database,
  Fixture,
  OddsSnapshot,
  Outcome,
  Prediction,
  Settings,
} from "@oddket/core";

export interface Env {
  DB: D1Database;
  ODDS_API_KEY?: string;
  /** Shared secret required by POST /api/predictions/ingest when set —
   *  protects the deployed worker from anyone pushing fake predictions. */
  PREDICT_SECRET?: string;
  /** Extra CORS origin for a deployed dashboard (e.g. your Vercel URL). */
  DASHBOARD_ORIGIN?: string;
  ODDS_SPORT?: string;
  ODDS_BOOKMAKERS?: string;
  ODDS_REGIONS?: string;
  ODDS_MARKETS?: string;
  ODDS_FETCH_LIMIT?: string;
  /** Comma-separated tennis tournament sport keys (overrides settings.leagues). */
  TENNIS_SPORTS?: string;
}

/* ---------------- row mappers ---------------- */

interface FixtureRow {
  id: string;
  sport: string;
  league: string;
  home_team: string;
  away_team: string;
  commence_time: number;
  status: string;
  home_score: number | null;
  away_score: number | null;
}

function toFixture(r: FixtureRow): Fixture {
  return {
    id: r.id,
    sport: r.sport,
    league: r.league,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    commenceTime: r.commence_time,
    status: r.status as Fixture["status"],
    homeScore: r.home_score ?? undefined,
    awayScore: r.away_score ?? undefined,
  };
}

interface OddsRow {
  id: string;
  fixture_id: string;
  market: string;
  selection: string;
  odds: number;
  bookmaker: string;
  captured_at: number;
  is_closing: number;
}

function toOdds(r: OddsRow): OddsSnapshot {
  return {
    id: r.id,
    fixtureId: r.fixture_id,
    market: r.market as OddsSnapshot["market"],
    selection: r.selection as OddsSnapshot["selection"],
    odds: r.odds,
    bookmaker: r.bookmaker,
    capturedAt: r.captured_at,
    isClosing: r.is_closing === 1,
  };
}

interface PredictionRow {
  id: string;
  fixture_id: string;
  market: string;
  selection: string;
  probability: number;
  confidence_low: number;
  confidence_high: number;
  model_version: string;
  created_at: number;
}

function toPrediction(r: PredictionRow): Prediction {
  return {
    id: r.id,
    fixtureId: r.fixture_id,
    market: r.market as Prediction["market"],
    selection: r.selection as Prediction["selection"],
    probability: r.probability,
    confidenceLow: r.confidence_low,
    confidenceHigh: r.confidence_high,
    modelVersion: r.model_version,
    createdAt: r.created_at,
  };
}

interface BetRow {
  id: string;
  fixture_id: string;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  bankroll_at_bet: number;
  edge: number;
  model_probability: number;
  status: string;
  outcome_amount: number | null;
  placed_at: number;
}

function toBet(r: BetRow): Bet {
  return {
    id: r.id,
    fixtureId: r.fixture_id,
    market: r.market as Bet["market"],
    selection: r.selection as Bet["selection"],
    odds: r.odds,
    stake: r.stake,
    bankrollAtBet: r.bankroll_at_bet,
    edge: r.edge,
    modelProbability: r.model_probability,
    status: r.status as Bet["status"],
    outcomeAmount: r.outcome_amount ?? undefined,
    placedAt: r.placed_at,
  };
}

interface ClvRow {
  id: string;
  bet_id: string;
  opening_odds: number;
  closing_odds: number;
  clv: number;
  captured_at: number;
}

function toClv(r: ClvRow): ClvResult {
  return {
    id: r.id,
    betId: r.bet_id,
    openingOdds: r.opening_odds,
    closingOdds: r.closing_odds,
    clv: r.clv,
    capturedAt: r.captured_at,
  };
}

interface OutcomeRow {
  id: string;
  fixture_id: string;
  home_score: number;
  away_score: number;
  settled_at: number;
}

function toOutcome(r: OutcomeRow): Outcome {
  return {
    id: r.id,
    fixtureId: r.fixture_id,
    homeScore: r.home_score,
    awayScore: r.away_score,
    settledAt: r.settled_at,
  };
}

/* ---------------- queries ---------------- */

export async function loadDatabase(db: D1Database): Promise<Database> {
  const [fixtures, odds, predictions, bets, clv, outcomes, settingsRows] = await Promise.all([
    db.prepare("SELECT * FROM fixtures").all<FixtureRow>(),
    db.prepare("SELECT * FROM odds_snapshots").all<OddsRow>(),
    db.prepare("SELECT * FROM predictions").all<PredictionRow>(),
    db.prepare("SELECT * FROM bets").all<BetRow>(),
    db.prepare("SELECT * FROM clv_results").all<ClvRow>(),
    db.prepare("SELECT * FROM outcomes").all<OutcomeRow>(),
    db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>(),
  ]);

  const settings = settingsRows ? rowToSettings(settingsRows) : defaultSettings();

  return {
    fixtures: (fixtures.results ?? []).map(toFixture),
    odds: (odds.results ?? []).map(toOdds),
    predictions: (predictions.results ?? []).map(toPrediction),
    bets: (bets.results ?? []).map(toBet),
    clv: (clv.results ?? []).map(toClv),
    outcomes: (outcomes.results ?? []).map(toOutcome),
    settings,
  };
}

function defaultSettings(): Settings {
  return {
    bankroll: 10000,
    kellyFraction: 0.25,
    edgeThreshold: 0.03,
    dailyStopLoss: 500,
    weeklyStopLoss: 1500,
    defaultStakeCapPct: 0.05,
    leagues: [],
    markets: ["h2h", "totals"],
  };
}

interface SettingsRow {
  bankroll: number;
  kelly_fraction: number;
  edge_threshold: number;
  daily_stop_loss: number;
  weekly_stop_loss: number;
  default_stake_cap_pct: number;
  leagues: string;
  markets: string;
}

function rowToSettings(r: SettingsRow): Settings {
  return {
    bankroll: r.bankroll,
    kellyFraction: r.kelly_fraction,
    edgeThreshold: r.edge_threshold,
    dailyStopLoss: r.daily_stop_loss,
    weeklyStopLoss: r.weekly_stop_loss,
    defaultStakeCapPct: r.default_stake_cap_pct,
    leagues: safeParseJson(r.leagues, []),
    markets: safeParseJson(r.markets, ["h2h", "totals"]),
  };
}

function safeParseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>();
  return row ? rowToSettings(row) : defaultSettings();
}

export async function putSettings(db: D1Database, s: Settings): Promise<void> {
  await db
    .prepare(
      `UPDATE settings SET
        bankroll = ?1, kelly_fraction = ?2, edge_threshold = ?3,
        daily_stop_loss = ?4, weekly_stop_loss = ?5, default_stake_cap_pct = ?6,
        leagues = ?7, markets = ?8
       WHERE id = 1`,
    )
    .bind(
      s.bankroll,
      s.kellyFraction,
      s.edgeThreshold,
      s.dailyStopLoss,
      s.weeklyStopLoss,
      s.defaultStakeCapPct,
      JSON.stringify(s.leagues),
      JSON.stringify(s.markets),
    )
    .run();
}

/* ---------------- TENNIS (isolated from football) ---------------- */

interface TennisFixtureRow {
  id: string;
  sport: string;
  league: string;
  home_team: string;
  away_team: string;
  commence_time: number;
  status: string;
  winner: string | null;
}

function toTennisFixture(r: TennisFixtureRow): Fixture {
  return {
    id: r.id,
    sport: r.sport,
    league: r.league,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    commenceTime: r.commence_time,
    status: r.status as Fixture["status"],
  };
}

/**
 * Load the TENNIS database into the shared Database shape. Tennis outcomes
 * are synthesized from the match `winner` column as winner-scores (1-0 / 0-1)
 * so the SHARED selectionWon / calibration / aggregate code works unchanged.
 */
export async function loadTennisDatabase(db: D1Database): Promise<Database> {
  const [fixtures, odds, predictions, bets, clv, settingsRows] = await Promise.all([
    db.prepare("SELECT * FROM tennis_matches").all<TennisFixtureRow>(),
    db.prepare("SELECT * FROM tennis_odds_snapshots").all<OddsRow>(),
    db.prepare("SELECT * FROM tennis_predictions").all<PredictionRow>(),
    db.prepare("SELECT * FROM tennis_bets").all<BetRow>(),
    db.prepare("SELECT * FROM tennis_clv_results").all<ClvRow>(),
    db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>(),
  ]);

  const settings = settingsRows ? rowToSettings(settingsRows) : defaultSettings();
  const rawMatches = fixtures.results ?? [];
  const matchRows = rawMatches.map(toTennisFixture);

  // Outcomes come from the RAW rows' winner column (the mapped Fixture shape
  // has no winner field) — encoded as winner-scores so the shared
  // selectionWon("h2h") logic resolves them without any tennis fork.
  const outcomes: Outcome[] = [];
  for (const r of rawMatches) {
    if (r.status !== "finished" || !r.winner) continue;
    outcomes.push({
      id: `tout-${r.id}`,
      fixtureId: r.id,
      homeScore: r.winner === "home" ? 1 : 0,
      awayScore: r.winner === "home" ? 0 : 1,
      settledAt: 0,
    });
  }

  return {
    fixtures: matchRows,
    odds: (odds.results ?? []).map(toOdds),
    predictions: (predictions.results ?? []).map(toPrediction),
    bets: (bets.results ?? []).map(toBet),
    clv: (clv.results ?? []).map(toClv),
    outcomes,
    settings,
  };
}

export async function upsertTennisFixtures(db: D1Database, fixtures: Fixture[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO tennis_matches (id, sport, league, home_team, away_team, commence_time, status, winner)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       sport = excluded.sport, league = excluded.league, home_team = excluded.home_team,
       away_team = excluded.away_team, commence_time = excluded.commence_time,
       status = excluded.status, winner = excluded.winner`,
  );
  const batch = fixtures.map((f) =>
    stmt.bind(f.id, "tennis", f.league, f.homeTeam, f.awayTeam, f.commenceTime, f.status, null),
  );
  await db.batch(batch);
}

export async function upsertTennisOdds(db: D1Database, rows: OddsSnapshot[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO tennis_odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET odds = excluded.odds, captured_at = excluded.captured_at`,
  );
  const batch = rows.map((o) =>
    stmt.bind(o.id, o.fixtureId, o.market, o.selection, o.odds, o.bookmaker, o.capturedAt, o.isClosing ? 1 : 0),
  );
  if (batch.length) await db.batch(batch);
}

export async function upsertTennisPredictions(db: D1Database, rows: Prediction[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO tennis_predictions (id, fixture_id, market, selection, probability, confidence_low, confidence_high, model_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       probability = excluded.probability, confidence_low = excluded.confidence_low,
       confidence_high = excluded.confidence_high, model_version = excluded.model_version,
       created_at = excluded.created_at`,
  );
  const batch = rows.map((p) =>
    stmt.bind(p.id, p.fixtureId, p.market, p.selection, p.probability, p.confidenceLow, p.confidenceHigh, p.modelVersion, p.createdAt),
  );
  if (batch.length) await db.batch(batch);
}

export async function insertTennisBet(db: D1Database, b: Bet): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tennis_bets (id, fixture_id, market, selection, odds, stake, bankroll_at_bet, edge, model_probability, status, outcome_amount, placed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(b.id, b.fixtureId, b.market, b.selection, b.odds, b.stake, b.bankrollAtBet, b.edge, b.modelProbability, b.status, b.outcomeAmount ?? null, b.placedAt)
    .run();
}

export async function insertTennisClv(db: D1Database, c: ClvResult): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO tennis_clv_results (id, bet_id, opening_odds, closing_odds, clv, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(c.id, c.betId, c.openingOdds, c.closingOdds, c.clv, c.capturedAt)
    .run();
}

/** Settle pending TENNIS bets whose match now has a winner. Returns # settled. */
export async function settleTennisBets(db: D1Database): Promise<number> {
  const rows = await db.prepare("SELECT * FROM tennis_bets WHERE status = 'pending'").all<BetRow>();
  const pending = (rows.results ?? []).map(toBet);
  let settled = 0;

  for (const bet of pending) {
    const match = await db.prepare("SELECT * FROM tennis_matches WHERE id = ?1").bind(bet.fixtureId).first<TennisFixtureRow>();
    if (!match || match.status !== "finished" || !match.winner) continue;

    const won = bet.selection === match.winner;
    const amount = won ? Math.round(bet.stake * (bet.odds - 1) * 100) / 100 : -bet.stake;

    await db
      .prepare("UPDATE tennis_bets SET status = ?1, outcome_amount = ?2 WHERE id = ?3")
      .bind(won ? "won" : "lost", amount, bet.id)
      .run();
    settled++;
  }
  return settled;
}

/* ---------------- writes ---------------- */

export async function upsertFixtures(db: D1Database, fixtures: Fixture[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO fixtures (id, sport, league, home_team, away_team, commence_time, status, home_score, away_score)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       sport = excluded.sport, league = excluded.league, home_team = excluded.home_team,
       away_team = excluded.away_team, commence_time = excluded.commence_time,
       status = excluded.status, home_score = excluded.home_score, away_score = excluded.away_score`,
  );
  const batch = fixtures.map((f) =>
    stmt.bind(f.id, f.sport, f.league, f.homeTeam, f.awayTeam, f.commenceTime, f.status, f.homeScore ?? null, f.awayScore ?? null),
  );
  await db.batch(batch);
}

export async function upsertOdds(db: D1Database, rows: OddsSnapshot[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO odds_snapshots (id, fixture_id, market, selection, odds, bookmaker, captured_at, is_closing)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET odds = excluded.odds, captured_at = excluded.captured_at`,
  );
  const batch = rows.map((o) =>
    stmt.bind(o.id, o.fixtureId, o.market, o.selection, o.odds, o.bookmaker, o.capturedAt, o.isClosing ? 1 : 0),
  );
  if (batch.length) await db.batch(batch);
}

export async function upsertPredictions(db: D1Database, rows: Prediction[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO predictions (id, fixture_id, market, selection, probability, confidence_low, confidence_high, model_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET
       probability = excluded.probability, confidence_low = excluded.confidence_low,
       confidence_high = excluded.confidence_high, model_version = excluded.model_version,
       created_at = excluded.created_at`,
  );
  const batch = rows.map((p) =>
    stmt.bind(p.id, p.fixtureId, p.market, p.selection, p.probability, p.confidenceLow, p.confidenceHigh, p.modelVersion, p.createdAt),
  );
  if (batch.length) await db.batch(batch);
}

export async function insertBet(db: D1Database, b: Bet): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bets (id, fixture_id, market, selection, odds, stake, bankroll_at_bet, edge, model_probability, status, outcome_amount, placed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(b.id, b.fixtureId, b.market, b.selection, b.odds, b.stake, b.bankrollAtBet, b.edge, b.modelProbability, b.status, b.outcomeAmount ?? null, b.placedAt)
    .run();
}

export async function insertClv(db: D1Database, c: ClvResult): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO clv_results (id, bet_id, opening_odds, closing_odds, clv, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(c.id, c.betId, c.openingOdds, c.closingOdds, c.clv, c.capturedAt)
    .run();
}

export async function upsertOutcomes(db: D1Database, rows: Outcome[]): Promise<void> {
  const stmt = db.prepare(
    `INSERT INTO outcomes (id, fixture_id, home_score, away_score, settled_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(fixture_id) DO UPDATE SET
       home_score = excluded.home_score, away_score = excluded.away_score, settled_at = excluded.settled_at`,
  );
  const batch = rows.map((o) => stmt.bind(o.id, o.fixtureId, o.homeScore, o.awayScore, o.settledAt));
  if (batch.length) await db.batch(batch);
}

/** Settle pending bets whose fixture now has an outcome. Returns # settled. */
export async function settlePendingBets(db: D1Database): Promise<number> {
  const rows = await db.prepare("SELECT * FROM bets WHERE status = 'pending'").all<BetRow>();
  const pending = (rows.results ?? []).map(toBet);
  let settled = 0;

  for (const bet of pending) {
    const outcome = await db.prepare("SELECT * FROM outcomes WHERE fixture_id = ?1").bind(bet.fixtureId).first<OutcomeRow>();
    if (!outcome) continue;

    const { selectionWon } = await import("@oddket/core");
    const won = selectionWon(bet.market, bet.selection, outcome.home_score, outcome.away_score);
    const amount = won ? Math.round(bet.stake * (bet.odds - 1) * 100) / 100 : -bet.stake;

    await db
      .prepare("UPDATE bets SET status = ?1, outcome_amount = ?2 WHERE id = ?3")
      .bind(won ? "won" : "lost", amount, bet.id)
      .run();
    settled++;
  }
  return settled;
}
