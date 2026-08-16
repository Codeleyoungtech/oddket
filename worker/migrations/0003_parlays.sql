-- OddKet schema (v4) — true parlay settlement.
-- A parlay is ONE logged unit that settles all-or-nothing (every leg must
-- win; one loser kills the whole slip). Stored separately from singles so
-- P&L tracks the actual wager, not a bundle of single-bet rows.

CREATE TABLE IF NOT EXISTS parlay_bets (
  id                  TEXT PRIMARY KEY,
  sport               TEXT NOT NULL DEFAULT 'football',  -- football | tennis | mixed
  legs                TEXT NOT NULL,                     -- JSON: ParlayLeg[]
  combined_odds       REAL NOT NULL,
  combined_probability REAL NOT NULL,
  stake               REAL NOT NULL,
  bankroll_at_bet     REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',   -- pending | won | lost | void
  outcome_amount      REAL,
  placed_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parlay_placed ON parlay_bets(placed_at);

ALTER TABLE settings ADD COLUMN max_multiple_legs INTEGER NOT NULL DEFAULT 3;
