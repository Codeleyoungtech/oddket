-- OddKet D1 schema (v1)
-- Mirrors packages/core/src/types.ts 1:1.

CREATE TABLE IF NOT EXISTS fixtures (
  id            TEXT PRIMARY KEY,
  sport         TEXT NOT NULL DEFAULT 'soccer',
  league        TEXT NOT NULL,
  home_team     TEXT NOT NULL,
  away_team     TEXT NOT NULL,
  commence_time INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | live | finished
  home_score    INTEGER,
  away_score    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures(status);
CREATE INDEX IF NOT EXISTS idx_fixtures_commence ON fixtures(commence_time);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id         TEXT PRIMARY KEY,
  fixture_id TEXT NOT NULL,
  market     TEXT NOT NULL,        -- h2h | totals | btts | spreads
  selection  TEXT NOT NULL,        -- home | draw | away | over | under | yes | no
  odds       REAL NOT NULL,
  bookmaker  TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  is_closing INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id)
);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds_snapshots(fixture_id, market, selection);

CREATE TABLE IF NOT EXISTS predictions (
  id             TEXT PRIMARY KEY,
  fixture_id     TEXT NOT NULL,
  market         TEXT NOT NULL,
  selection      TEXT NOT NULL,
  probability    REAL NOT NULL,
  confidence_low REAL NOT NULL,
  confidence_high REAL NOT NULL,
  model_version  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id)
);
CREATE INDEX IF NOT EXISTS idx_preds_fixture ON predictions(fixture_id);

CREATE TABLE IF NOT EXISTS bets (
  id               TEXT PRIMARY KEY,
  fixture_id       TEXT NOT NULL,
  market           TEXT NOT NULL,
  selection        TEXT NOT NULL,
  odds             REAL NOT NULL,
  stake            REAL NOT NULL,
  bankroll_at_bet  REAL NOT NULL,
  edge             REAL NOT NULL,
  model_probability REAL NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | won | lost | void
  outcome_amount   REAL,
  placed_at        INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id)
);
CREATE INDEX IF NOT EXISTS idx_bets_placed ON bets(placed_at);

CREATE TABLE IF NOT EXISTS clv_results (
  id            TEXT PRIMARY KEY,
  bet_id        TEXT NOT NULL,
  opening_odds  REAL NOT NULL,
  closing_odds  REAL NOT NULL,
  clv           REAL NOT NULL,
  captured_at   INTEGER NOT NULL,
  FOREIGN KEY (bet_id) REFERENCES bets(id)
);
CREATE INDEX IF NOT EXISTS idx_clv_bet ON clv_results(bet_id);

CREATE TABLE IF NOT EXISTS outcomes (
  id         TEXT PRIMARY KEY,
  fixture_id TEXT NOT NULL UNIQUE,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id)
);

CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  bankroll             REAL NOT NULL DEFAULT 10000,
  kelly_fraction       REAL NOT NULL DEFAULT 0.25,
  edge_threshold       REAL NOT NULL DEFAULT 0.03,
  daily_stop_loss      REAL NOT NULL DEFAULT 500,
  weekly_stop_loss     REAL NOT NULL DEFAULT 1500,
  default_stake_cap_pct REAL NOT NULL DEFAULT 0.05,
  leagues              TEXT NOT NULL DEFAULT '[]',   -- JSON array
  markets              TEXT NOT NULL DEFAULT '["h2h","totals"]'  -- JSON array
);

INSERT OR IGNORE INTO settings (id) VALUES (1);
