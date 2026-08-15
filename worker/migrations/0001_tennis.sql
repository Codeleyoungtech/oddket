-- OddKet Tennis schema (v2) — ATP main tour.
-- Completely isolated from the football tables: tennis paper-trade data never
-- mixes with the football pipeline's data. Reuses the same record shapes
-- (Fixture/OddsSnapshot/Prediction/Bet/ClvResult) so the existing dashboard
-- components work unchanged — only the queried tables differ per sport.
--
-- Tennis is match-winner only for V1: no draw, no totals, no BTTS.
-- A tennis match result is just a winner ('home' | 'away'), stored on the
-- match row. The worker synthesizes Outcome-shaped records from `winner` so
-- the shared calibration/aggregate code needs no tennis-specific forks.

CREATE TABLE IF NOT EXISTS tennis_matches (
  id            TEXT PRIMARY KEY,
  sport         TEXT NOT NULL DEFAULT 'tennis',
  league        TEXT NOT NULL,          -- tournament name, e.g. "ATP French Open"
  home_team     TEXT NOT NULL,          -- player 1 (The Odds API h2h order)
  away_team     TEXT NOT NULL,          -- player 2
  commence_time INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | live | finished
  winner        TEXT                     -- 'home' | 'away' once finished
);
CREATE INDEX IF NOT EXISTS idx_tennis_matches_status ON tennis_matches(status);
CREATE INDEX IF NOT EXISTS idx_tennis_matches_commence ON tennis_matches(commence_time);

CREATE TABLE IF NOT EXISTS tennis_odds_snapshots (
  id          TEXT PRIMARY KEY,
  fixture_id  TEXT NOT NULL,
  market      TEXT NOT NULL DEFAULT 'h2h',   -- h2h only for V1
  selection   TEXT NOT NULL,                 -- home | away (player names resolved)
  odds        REAL NOT NULL,
  bookmaker   TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  is_closing  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (fixture_id) REFERENCES tennis_matches(id)
);
CREATE INDEX IF NOT EXISTS idx_tennis_odds_fixture ON tennis_odds_snapshots(fixture_id, market, selection);

CREATE TABLE IF NOT EXISTS tennis_predictions (
  id              TEXT PRIMARY KEY,
  fixture_id      TEXT NOT NULL,
  market          TEXT NOT NULL DEFAULT 'h2h',
  selection       TEXT NOT NULL,             -- home | away
  probability     REAL NOT NULL,
  confidence_low  REAL NOT NULL,
  confidence_high REAL NOT NULL,
  model_version   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES tennis_matches(id)
);
CREATE INDEX IF NOT EXISTS idx_tennis_preds_fixture ON tennis_predictions(fixture_id);

CREATE TABLE IF NOT EXISTS tennis_bets (
  id                TEXT PRIMARY KEY,
  fixture_id        TEXT NOT NULL,
  market            TEXT NOT NULL DEFAULT 'h2h',
  selection         TEXT NOT NULL,           -- home | away
  odds              REAL NOT NULL,
  stake             REAL NOT NULL,
  bankroll_at_bet   REAL NOT NULL,
  edge              REAL NOT NULL,
  model_probability REAL NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | won | lost | void
  outcome_amount    REAL,
  placed_at         INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES tennis_matches(id)
);
CREATE INDEX IF NOT EXISTS idx_tennis_bets_placed ON tennis_bets(placed_at);

CREATE TABLE IF NOT EXISTS tennis_clv_results (
  id           TEXT PRIMARY KEY,
  bet_id       TEXT NOT NULL,
  opening_odds REAL NOT NULL,
  closing_odds REAL NOT NULL,
  clv          REAL NOT NULL,
  captured_at  INTEGER NOT NULL,
  FOREIGN KEY (bet_id) REFERENCES tennis_bets(id)
);
CREATE INDEX IF NOT EXISTS idx_tennis_clv_bet ON tennis_clv_results(bet_id);
