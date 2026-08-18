-- Add min bookmakers + max spread settings for the EV engine quality gates.
-- These control how strict the slip builder is about bookmaker depth and
-- market-width before flagging a bet.

ALTER TABLE settings ADD COLUMN min_bookmakers INTEGER NOT NULL DEFAULT 4;
ALTER TABLE settings ADD COLUMN max_spread_pct REAL NOT NULL DEFAULT 0.10;
