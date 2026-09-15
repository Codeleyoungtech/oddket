-- Corner model v6: the total market, honest sigmas, and REAL corner results.
--
-- Three gaps this closes:
--
-- 1. TOTAL LINES WERE NEVER STORED. `corners_predictions` holds two rows per
--    fixture (one per side) and only the TEAM line probabilities. The match
--    total was recomputed in TypeScript from `sqrt(HOME_SIGMA^2 + AWAY_SIGMA^2)`
--    — a hardcoded constant that assumed home and away corners are independent.
--    They are not: measured residual covariance is -1.28, so that sigma was ~11%
--    too wide and the tail probabilities were correspondingly off. The total now
--    comes from its own model, and its lines and sigma are stored as computed.
--
-- 2. SIGMAS WERE HARDCODED IN THE APP. The TypeScript constants (2.849 / 2.456)
--    did not even match the trainer's own meta (2.832 / 2.4585). Sigmas are now
--    persisted per row so the app displays what the model actually used.
--
-- 3. THERE WAS NO WAY TO SEE HOW A CORNER PREDICTION TURNED OUT. Grading required
--    looking the match up by hand. `corner_outcomes` stores the real corner
--    counts so every past prediction can be scored automatically.
ALTER TABLE corners_predictions ADD COLUMN total_corners REAL;
ALTER TABLE corners_predictions ADD COLUMN total_line_probs TEXT;
ALTER TABLE corners_predictions ADD COLUMN sigma_home REAL;
ALTER TABLE corners_predictions ADD COLUMN sigma_away REAL;
ALTER TABLE corners_predictions ADD COLUMN sigma_total REAL;
-- 1 when the fixture had a real 1X2 book at prediction time. The model uses six
-- market-derived features, so a prediction made without a book is measurably
-- weaker and the UI should say so instead of presenting both identically.
ALTER TABLE corners_predictions ADD COLUMN has_odds INTEGER NOT NULL DEFAULT 0;
-- Kept so a prediction whose clubs could not be resolved is never silently
-- scored from a league-average default.
ALTER TABLE corners_predictions ADD COLUMN league TEXT;

CREATE TABLE IF NOT EXISTS corner_outcomes (
  fixture_id   TEXT PRIMARY KEY,
  home_corners INTEGER NOT NULL,
  away_corners INTEGER NOT NULL,
  total_corners INTEGER NOT NULL,
  league       TEXT,
  source       TEXT NOT NULL DEFAULT 'api-football',
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corner_outcomes_league ON corner_outcomes(league);
