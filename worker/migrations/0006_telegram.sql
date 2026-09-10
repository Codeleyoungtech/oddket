-- OddKet schema (v6) — Telegram bot.
-- telegram_chats: one row per chat that has ever talked to @oddketbot.
-- Stores the digest/subscription preference so the worker can push daily
-- pick summaries and settlement alerts to every subscriber.
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id        TEXT PRIMARY KEY,
  label          TEXT,                          -- "Eleazar Ogoyemi (@codeleyoungtech)"
  digest_enabled INTEGER NOT NULL DEFAULT 1,    -- 1 = alerts on, 0 = muted
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_chats_digest ON telegram_chats(digest_enabled);
