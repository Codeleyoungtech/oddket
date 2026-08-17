-- OddKet schema (v5) — settlement alerts.
-- settlement_events: one human-readable row per settled unit (single OR
-- parlay), written by the settle functions so the dashboard banner and the
-- web-push notification can show "Won: Arsenal 2-1 Chelsea (+₦120)" without
-- re-deriving labels.
CREATE TABLE IF NOT EXISTS settlement_events (
  id          TEXT PRIMARY KEY,
  sport       TEXT NOT NULL,             -- football | tennis | mixed
  kind        TEXT NOT NULL DEFAULT 'single',  -- single | parlay
  label       TEXT NOT NULL,             -- "Arsenal 2-1 Chelsea" | "3-leg parlay"
  result      TEXT NOT NULL,             -- won | lost
  amount      REAL NOT NULL,             -- +profit or -stake (negative = loss)
  settled_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlement_events_at ON settlement_events(settled_at);

-- push_subscriptions: browser push endpoints (one row per device) so the
-- worker can ping the user when a bet settles while the app is closed.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
