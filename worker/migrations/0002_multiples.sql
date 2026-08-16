-- OddKet schema (v3) — multiples gate.
-- The multiple (parlay) builder exists in code but stays OFF until a sport
-- clears the validation checklist (100+ bets, positive CLV, CI not straddling
-- zero). This column is the gate: 0 = builder hidden everywhere, 1 = enabled
-- via the Settings UI. Defaults OFF.

ALTER TABLE settings ADD COLUMN multiples_enabled INTEGER NOT NULL DEFAULT 0;
