# OddKet — ATP Tennis Model Report

**Date:** August 15, 2026
**Model version:** `tennis-xgb-v1`
**Market:** Match winner (h2h), ATP main tour
**Status:** ✅ Pipeline built & verified live · ❌ No proven edge on holdout (honest)

---

## 1. TL;DR

The full tennis pipeline (fetch → features → train → predict → live odds → slips) is built,
tested, and verified against **real live data** (ATP Cincinnati Open, Aug 15 2026). The model
itself is calibrated and leakage-free, but the honest holdout backtest shows **no proven edge**:
1,347 bets at **ROI −3.52%**. That is the number to care about — the market (Pinnacle, Bet365,
etc.) prices ATP main tour sharply. The CLV loop is the real scoreboard going forward.

---

## 2. Why tennis at all (context)

The original plan was ATP Challenger, but two hard blockers were confirmed (recorded in
`HANDOFF.md` §11):

| Route | Status |
|---|---|
| **The Odds API** (current $0 provider) | ❌ No Challenger coverage — tennis = Grand Slams + ATP 1000/500 + WTA only |
| **Betfair Exchange** (free delayed API, lists Challenger) | ❌ Geo-blocked — Nigeria is a restricted country; account can't even be created |

Pivot (owner-approved): **ATP main tour via The Odds API**, same pipeline discipline as the
football model (Platt calibration, time-ordered backtest, odds-as-feature, odds-band sweep).

---

## 3. Data

| Source | What | Coverage |
|---|---|---|
| **tennis-data.co.uk** (free) | Historical results + per-book odds | 2019–2026, ATP main tour, **9,224 matches**; updated daily (14 Aug 2026) |
| **The Odds API** (free tier, live) | Live fixtures + odds for prediction + closing lines for CLV | Per-tournament keys (e.g. `tennis_atp_cincinnati_open`) |

**Multi-book coverage (training):** 8,114/9,224 matches (88%) have both **B365** (Bet365) and
**Pinnacle** on both sides — cross-bookmaker spread is computable.

**Multi-book coverage (live feed) — verified with a real key, Aug 15 2026:** **22 distinct
bookmakers** per event, Pinnacle present on all matches, 16–22 books per match, with real
sharp-vs-soft spreads (e.g. Cincinnati h2h: Pinnacle 1.18 / Betfair 1.16 / Winamax 1.10 on
Djokovic). So cross-book spread works end-to-end, live and in training.

---

## 4. Features (21, all leakage-free — pre-match info only)

| Group | Features |
|---|---|
| `base` | Elo gap, rank gap, best-of-5, surface (hard/clay/grass/carpet), tour level |
| `h2h` | Head-to-head wins (p1), H2H gap |
| `ew_form` | Exponentially-weighted recent form (p1, p2, diff) |
| `rest` | Rest days (p1, p2, diff), matches played this tournament (p1, p2) |
| `odds` | Margin-adjusted implied probability (p1, p2, gap) |

**Leakage note:** tennis-data.co.uk keys odds to **Winner/Loser** (outcome-labeled). The odds
features are built by **name-resolving** each player's price at construction time — the same
information a bettor has pre-match. Routing by outcome instead (an early bug) produced 100%
accuracy / Brier 0 — caught, fixed, and the honest pipeline below uses the fixed version.

---

## 5. Training & validation

- **Model:** XGBoost, Platt-calibrated (isotonic-free, monotone sigmoid fit)
- **Split:** strict **time-ordered** — 7,379 train / 1,845 holdout (Apr 25 2025 → Aug 14 2026)
- **Staking (backtest only):** quarter Kelly, 5% of bankroll cap

### Holdout results

| Metric | Value |
|---|---|
| Accuracy | 0.683 |
| Brier (raw → calibrated) | 0.2037 → **0.2022** |
| Bets | 1,347 |
| Win rate | 40.8% |
| ROI | **−3.52%** |
| Avg flagged edge | +5.68% |
| Max drawdown | ₦15,960 (of ₦10,000 starting bankroll) |

### Odds-band sweep (entry odds → n / win% / ROI%)

| Band | n | Win% | ROI% |
|---|---|---|---|
| 1.00–1.50 | 197 | 66.0% | −5.42% |
| 1.50–2.00 | 295 | 60.0% | −2.88% |
| **2.00–2.50** | 206 | 49.0% | **+5.89%** |
| 2.50–3.50 | 183 | 33.9% | −1.47% |
| 3.50+ | 466 | 17.0% | −2.19% |

### Honest read

- The model is **calibrated** (Brier 0.2022 ≈ raw 0.2037 — Platt adds little, meaning the raw
  probabilities were already well-scaled).
- The model flags an average **+5.68% edge** but **loses money** — the classic longshot-bleed /
  over-confidence pattern: small calibration error × large odds destroys value at long prices.
- The **2.00–2.50 band** is the only positive band (+5.89% on 206 bets). It's post-hoc and a
  small sample — reported as **likely noise, not evidence of an edge**. It will be re-tested
  on fresh data after the US Open + Asian swing (see §8).
- **Conclusion: no proven edge on ATP main tour.** This matches the PRD's warning that main
  tour is sharply priced. The CLV loop is the definitive test once bets are logged.

---

## 6. Live verification (real key, Aug 15 2026)

Full live loop exercised end-to-end:

1. `POST /api/tennis/ingest` → **25 Cincinnati Open fixtures, 1,042 odds snapshots** stored
2. `GET /api/tennis/fixtures/export` → fixtures + best h2h odds → `predict_tennis.py`
3. Model predicted all 25 fixtures (name-matching to history via surname resolution)
4. `POST /api/tennis/predictions/ingest` → **50 predictions** (h2h, both sides)
5. `GET /api/tennis/slips` → **14 legs flagged** with real player names, model probability +
   confidence interval, margin-adjusted implied, edge, Kelly stake

Worker health: `{"ok":true,"mode":"live",...}`. Dashboard endpoint returns full
bankroll/calibration/CLV series (empty until bets are logged — expected).

---

## 7. Bugs caught during the build (both documented in HANDOFF §12)

1. **Odds-as-feature leaked the outcome** — routing odds by `p1_won` gave 100% accuracy.
   Fixed by name-resolving each player's price.
2. **Stale loop reference** — books resolved for only 344/9,224 matches (loop read the last
   CSV row). Fixed; now 88% coverage.

---

## 8. Next steps

| When | Action |
|---|---|
| **Now → Aug 23** | Cincinnati Open live; dashboard shows real slips; log bets to start CLV accrual |
| **~Aug 20** | US Open fixtures post → `predict-tennis` CI job flags edges automatically (frozen model — no retrain, no overfitting risk) |
| **Mid-Oct (after Shanghai Masters)** | **Retrain** — by then the dataset has US Open + Chengdu/Hangzhou + Shanghai = real tournament variety. Re-check the band sweep: does the 2.00–2.50 band survive? |
| **Ongoing** | Log bets → 18:30 closing-odds pull → CLV accrues → calibration page shows whether confidence matches reality |

**Deliberately not retraining now:** the only new event since the current data is Cincinnati;
retraining on one tournament's results risks overfitting to its quirks. Live *prediction* uses
the frozen model, so there's no downside to waiting.

---

## 9. How to see it yourself

```bash
# 1) Worker API (live mode — needs your ODDS_API_KEY)
cd worker && ODDS_API_KEY=your_key npm run serve:local   # http://localhost:8787

# 2) Dashboard (separate terminal)
pnpm dev:web                                              # http://localhost:3000

# 3) In the dashboard, flip the sport selector to 🎾 Tennis
#    → Slips page: ranked flagged bets with model probability + CI + stake
#    → Calibration / CLV / Bets pages switch to tennis data
```

Demo mode (no key): `pnpm dev:web` alone shows the seeded football + tennis demo data.

---

## 10. Key files

| File | Purpose |
|---|---|
| `model/scripts/tennis_fetch.py` | Pull tennis-data.co.uk → `data/tennis_historical.json` |
| `model/scripts/tennis_features.py` | 21 leakage-free features incl. surface Elo, EW form, spread |
| `model/scripts/train_tennis.py` | Time-ordered train, Platt calibration, backtest + band sweep |
| `model/scripts/predict_tennis.py` | Score live fixtures → `output/tennis_predictions.json` |
| `worker/src/odds/tennis-*.ts` | Live odds client + ingest (per-tournament keys) |
| `worker/src/db.ts`, `worker/src/index.ts` | Tennis tables + `/api/tennis/*` endpoints |
| `worker/migrations/0001_tennis.sql` | Isolated tennis schema (5 tables) |
| `packages/core/src/seed-tennis.ts` | Demo-mode tennis seed |
| `apps/web/lib/data-provider.tsx` | ⚽/🎾 sport selector + data routing |
