# OddKet Tennis — Product Requirements Document

**Owner:** Eleazar Ogoyemi (codeleyoungtech)
**Status:** Draft v1
**Date:** August 2026
**Relationship to OddKet (football):** separate model, separate data, separate paper-trade track. Reuses the pipeline (XGBoost, Platt calibration, time-ordered backtest, CLV framework), not the football model or its data. Does not touch or interfere with the live football paper-trade in any way.

---

## 1. What this is

A prediction model for **ATP Challenger tour, men's singles, match-winner market**, built on the same honesty principles as OddKet: no fabricated edges, no leakage, time-ordered validation, CLV as the real scoreboard, $0 budget, no auto-bet placement.

**Why Challenger tour, not ATP main tour:** main tour tennis is one of the most heavily modeled, sharply priced markets that exists — huge liquidity, professional quant shops. Challenger tour has far less betting volume and modeling attention, meaning bookmaker pricing is more likely to have real gaps. Same logic as why lower-tier football leagues were the flagged next step.

**Why singles only, not doubles:** doubles has fundamentally different dynamics (team chemistry, different skill weighting) and far less data available. Would dilute a small dataset rather than strengthen it.

**Why match-winner first, not sets/games totals:** same discipline as starting football with BTTS alone — prove one clean market has signal before expanding.

---

## 2. Budget Constraint (non-negotiable, same as OddKet)

**V1 must run on $0.** Free data sources only. No paid odds API tier, no paid stats source, no paid hosting. Do not upgrade until backtest results show a real signal.

---

## 3. Why tennis is structurally different from football (and why that matters for features)

- **1v1, not 11v11** — no teammate variance to absorb; individual skill differences show up more directly in outcomes
- **Ranking systems are unusually predictive** — ATP ranking points, or a custom Elo built from match history, carry more signal here than any single football rating does
- **Surface matters enormously** — a player's clay record can look completely different from their hard-court record. Surface-specific form is likely the single highest-value feature, more important than anything analogous in football
- **No draws** — simpler outcome space (win/loss only) than football's three-way market, which should make calibration easier to get right

---

## 4. Features (V1)

- **Ranking / Elo, surface-specific** — not just overall ranking, but a rating computed separately per surface (hard/clay/grass) where data allows
- **Head-to-head record** — especially important in tennis, where certain matchups (playing styles) are known to be lopsided regardless of ranking
- **Recent form, surface-weighted** — recency-weighted win/loss and set-score trends, split by surface where possible
- **Fatigue / schedule** — days since last match, number of matches played in the current tournament round, straight-sets vs. long three-set wins (a grueling win can predict a flatter next match)
- **Age/experience curve** (optional, cheap to add) — Challenger tour has a wide age range; rough experience-adjusted feature may help given ranking alone is noisier at this tier

**Explicitly deferred (same reasoning as football's injuries/player stats):**
- Detailed injury/fitness status — no reliable free source at this tier
- Travel distance/jet lag modeling — real signal in principle, complex to source and compute well; V2 candidate

---

## 5. Data Sourcing

| Source | Use | Notes |
|---|---|---|
| **Jeff Sackmann's tennis_atp GitHub repo** | Historical match results, rankings, Challenger tour data | Free, well-maintained, widely used in tennis analytics research — the closest thing to football-data.co.uk for tennis |
| **Free-tier odds API** (same provider as football, if it covers tennis) | Odds ingestion | Check coverage for Challenger-tour matches specifically — main-tour coverage is common, Challenger less so; may need a secondary free source |

**Flag before building:** verify the odds API's Challenger-tour coverage before committing to this scope — if odds data is too sparse at this tier, the "beat the market" side of the project (CLV) won't be measurable even if the prediction model itself is fine. Check this first, it's a hard blocker if coverage doesn't exist.

---

## 6. Architecture

Same as OddKet: TypeScript/Hono/Cloudflare Workers/D1 for the app layer, Python/XGBoost for training, Platt calibration (already proven better than isotonic — use it from the start this time, don't re-derive that lesson), time-ordered backtest split, separate D1 tables from the football model (`tennis_matches`, `tennis_odds_snapshots`, `tennis_predictions`, `tennis_bets`, `tennis_clv_results`).

---

## 7. Build order

1. **Data pull + odds coverage check** — confirm Challenger-tour odds are actually available before building anything else (hard blocker check)
2. **Schema** — separate tennis tables, no mixing with football data
3. **Baseline model** — ranking/Elo + H2H + surface-weighted form, match-winner only
4. **Time-ordered backtest** — same honesty rules as football: report the real number, including if it's negative
5. **Odds-as-feature + odds movement** — apply the two things that actually worked for football (market odds and steam) from the start, rather than rediscovering them
6. **Band-sweep by odds range** — apply the longshot-bleed lesson immediately: test the odds-band restriction from day one instead of finding it the hard way again
7. **Calibration + CLV dashboard** — reuse the existing framework, pointed at tennis tables

---

## 8. Non-negotiables (same as OddKet, restated)

- No auto-bet placement, ever
- No fabricated or rounded-up backtest numbers
- Paper-trade only until real CLV (vs. closing line, not vs. average) shows a sustained, non-outlier-dependent edge
- Odds-band discipline applied from the start, not discovered after a -22% run
- Does not interfere with, retrain, or draw data from the football model's live paper-trade

---

## 9. Success metric

Same as football: **positive real CLV, sustained over 100+ logged bets, not dependent on a handful of outlier wins.** Nothing less than that counts as proof.
