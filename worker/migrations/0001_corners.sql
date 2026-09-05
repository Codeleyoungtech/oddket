-- Corners predictions — isolated from h2h/totals.
-- No odds, no bets, no CLV — just raw model output per team per fixture.

CREATE TABLE IF NOT EXISTS corners_predictions (
  id               TEXT PRIMARY KEY,
  fixture_id       TEXT NOT NULL,
  team             TEXT NOT NULL,
  side             TEXT NOT NULL,            -- 'home' | 'away'
  predicted_corners REAL NOT NULL,
  confidence_low   REAL NOT NULL,
  confidence_high  REAL NOT NULL,
  line_probs       TEXT NOT NULL DEFAULT '{}', -- JSON: {over35, over45, over55, over65}
  model_version    TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id)
);
CREATE INDEX IF NOT EXISTS idx_corners_pred_fixture ON corners_predictions(fixture_id);
CREATE INDEX IF NOT EXISTS idx_corners_pred_team ON corners_predictions(team);
