# OddKet Corners — Build Prompt

Use with your AI coding agent on the existing OddKet codebase. This is a new prediction target for football, built as an isolated track — same isolation discipline as the tennis build relative to football.

## Non-negotiable constraints
- **Full isolation from the live h2h/totals model.** New tables (`corners_predictions`, `corners_odds_snapshots`, `corners_bets`, `corners_clv_results`), new training script. Reuse only the existing fixture/odds ingestion pipeline (fetching fixtures and bookmaker odds) — do NOT modify, retrain, or touch the h2h/totals model or its tables in any way. Those are mid-observation on a live paper-trade run and must not be disturbed.
- **$0 budget.** Use API-Football's free tier (lineups endpoint) for starting-XI confirmation. No paid injury data sourcing — deep injury history stays a documented gap, not a task.
- **Pre-match only, no live/in-play betting.** The "wait for the live line to drop" idea from research is a separate, more complex feature (real-time in-play data, different infrastructure) — explicitly out of scope for V1. This build predicts and flags pre-match only, same as everything else in OddKet.
- **Individual team totals, not match totals.** Per the research: isolate one team's corner output rather than betting on the combined unpredictable total of both teams.
- **No fabricated edges, no leakage, time-ordered validation, Platt calibration from the start** — same rules as every other model in this codebase.
- **Gated behind a flag** (`CORNERS_ENABLED = false`) until it clears its own honest backtest — same pattern as the multiples builder. Does not go live to real slip suggestions until that's confirmed.

## Data sourcing
- **Historical corners data:** check football-data.co.uk (some seasons include corner stats) and any other free source already in use; if corners history isn't available there, flag this as a hard blocker before building further — same discipline as the tennis/Betfair check.
- **Starting lineups (pre-match):** API-Football free tier, lineups endpoint — confirms actual starting XI shortly before kickoff, used to check whether key wide players are actually playing. This is NOT full injury history — just starting-XI confirmation.
- **Odds for corner props:** confirm the existing free-tier odds API actually covers individual-team corner markets before building the EV engine around it — this is a real coverage risk, corner props are a much thinner market than h2h, and this must be checked first, same as every other hard-blocker check in this project.

## Features (V1)
- Team's home/away corner average (for and against), filtered by venue
- Opponent's corners-conceded average, filtered by venue
- Baseline expectation: average of team's corner rate and opponent's conceded rate (per the formula in the research — validate this empirically against your own backtest rather than assuming it's correct)
- Recency-weighted form on corner counts, same weighting approach as the football h2h model
- Starting-lineup check (via API-Football): flag if a confirmed key wide attacking player is not in the starting XI

## Build order
1. **Hard blocker check first:** confirm corners historical data exists in a free source, and confirm the odds API covers individual-team corner props. If either fails, stop and report — do not proceed to model-building on an unconfirmed data foundation.
2. Schema (isolated tables, listed above)
3. Baseline model: team corner rate + opponent conceded rate → predicted probability of clearing a given line
4. Time-ordered backtest — report the honest number, including if it's negative
5. Validate the "70% consistency rule" threshold empirically against your own data rather than assuming it holds
6. Same EV/CLV/odds-band discipline as football and tennis — reuse the existing framework, point it at the new tables
7. Same bookmaker-depth and market-width gates as the football model (a thinner market like corners will likely fail these gates more often — that's expected, not a bug)

## Explicitly out of scope for V1
- Live/in-play betting or line-drop timing strategies
- Deep injury history beyond starting-XI confirmation
- Weather data (mentioned in research as a filter — real factor, but not worth the added complexity until the baseline model proves it has any signal at all)
- Match-total corners (both teams combined) — individual team totals only

## Final honest report
Same format as every other model in this project: report ROI, win rate, Brier score, and whether real signal exists — including if the answer is "corners has no more edge than h2h did." A niche market being less bookmaker-attention doesn't guarantee it's beatable; it just means it's worth honestly checking.

---

## V1 Implementation Status (built)

**✅ Completed:**
- Historical corner data sourced from football-data.co.uk (14,007 matches, 11 leagues)
- Training script: `model/scripts/train_corners.py` (XGBoost regressor, per-team)
- Prediction script: `model/scripts/predict_corners.py` (generates JSON for upcoming fixtures)
- TypeScript inference: `packages/core/src/corners.ts` (line probabilities, confidence intervals)
- D1 schema: `corners_predictions` table (isolated from h2h/totals)
- Worker endpoints: `GET /api/corners`, `POST /api/corners/ingest` (secret-protected)
- UI page: `/corners` with over/under line cards, clearly labeled as "not EV-checked"
- GitHub Actions: corners prediction step added to predict workflow
- Honest backtest: MAE 1.8, line accuracy 65-77%, 70% consistency NOT met (35%)

**❌ Skipped (per user request):**
- EV/odds layer — no live odds integration, no edge calculation, no slip generation
- Starting XI confirmation (API-Football free tier) — documented gap
- Deep injury history — documented gap
- Weather data — documented gap
- Live/in-play betting — out of scope for V1
- Match-total corners — V1 is individual team totals only
