-- Corner model validation report, served to the app.
--
-- The corner page could show live predictions but not how good they were: the
-- honest accuracy numbers lived in `model/output/corners_backtest.json`, which
-- only exists on the machine that trained the model. So the only way to judge
-- the model was to look each match up by hand.
--
-- This table holds the trained model's own out-of-sample report — holdout MAE
-- and skill vs. the league average for home/away/total, plus the claimed-vs-real
-- rate for every line. It is pushed by the same pipeline that pushes
-- predictions, so the numbers on screen always belong to the model that is
-- actually live rather than a copy that has drifted.
--
-- Single row (`id = 'current'`): only the newest model's report is meaningful,
-- and a history of stale accuracy tables would invite reading the wrong one.
CREATE TABLE IF NOT EXISTS corner_model_validation (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
