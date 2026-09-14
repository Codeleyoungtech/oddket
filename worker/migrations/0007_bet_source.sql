-- Persist the model/manual tag on a bet.
--
-- Before this migration `source` was computed in the browser and never stored:
-- the API dropped it on write and re-guessed it on every read, so a bet could
-- silently change buckets as odds moved. That made the model-vs-manual split
-- untrustworthy precisely where it matters — the paper-trade ROI/CLV numbers.
--
-- Rows that predate this migration keep NULL on purpose. NULL means UNTAGGED,
-- not "model": untagged bets are excluded from BOTH the model and the manual
-- summaries rather than being quietly counted as model-flagged.
ALTER TABLE bets ADD COLUMN source TEXT;
ALTER TABLE tennis_bets ADD COLUMN source TEXT;
