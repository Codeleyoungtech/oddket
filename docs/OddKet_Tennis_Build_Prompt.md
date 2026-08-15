# OddKet Tennis — Build Prompt

Use this with your AI coding agent, alongside `OddKet_Tennis_PRD.md`. This extends the existing OddKet codebase — read the current football model, schema, and dashboard code before starting.

## Non-negotiable constraints (same as football OddKet — do not violate)
- **$0 budget.** Free data sources only (Jeff Sackmann's tennis_atp GitHub repo for historical matches/rankings, free-tier odds API). No paid data, no paid hosting.
- **No fabricated edges.** Report every backtest number honestly, including negative ones. No rounding up, no cherry-picked windows.
- **No leakage.** Every feature must use only pre-match information. State explicitly what each new feature uses and confirm none of it leaks from the match outcome or post-match data.
- **Time-ordered validation only**, never random split.
- **Platt (sigmoid) calibration from the start** — do not use isotonic calibration; it over-extrapolates on sparse bins, which caused a real bug in the football model. Don't repeat that mistake.
- **No auto-bet placement.** Manual slip logging only, same as football.
- **Complete data isolation from the football model.** Separate D1 tables, separate training pipeline, separate paper-trade tracking. This build must not read from, write to, or in any way interfere with the live football paper-trade data currently running.

## Data sourcing — hard blocker check first
Before writing any model code:
1. Confirm the free-tier odds API actually covers ATP Challenger-tour matches (not just main tour). If coverage is too sparse to measure CLV meaningfully, stop and report this — do not proceed with a model that can't be validated against real odds.
2. Pull historical match/ranking data from Jeff Sackmann's tennis_atp GitHub repo (or an equivalent free, actively maintained source) for the Challenger tour, men's singles.

## Schema (new tables, isolated from football)
- `tennis_matches`
- `tennis_odds_snapshots`
- `tennis_predictions`
- `tennis_bets`
- `tennis_clv_results`

## Feature build order (implement and backtest each independently, same discipline as the football upgrade work — do not batch changes)

1. **Baseline: surface-specific ranking/Elo**
   - Not overall ranking — compute or source a rating that's specific to hard/clay/grass where data allows
   - Backtest, report ROI/win-rate/Brier

2. **Head-to-head record**
   - Add H2H win/loss history between the two players
   - Backtest, report delta

3. **Recency-weighted, surface-weighted form**
   - Exponentially weighted recent form, split by surface where match volume allows
   - Backtest, report delta

4. **Fatigue/schedule features**
   - Days since last match, matches played in current tournament round, set-count of most recent win (straight sets vs. long three-setter)
   - Backtest, report delta

5. **Market odds as a feature**
   - Apply this from the start (this took the football model from -8.75% to -4.71% — don't rediscover it, use it immediately)
   - Backtest, report delta

6. **Odds movement (steam)**
   - Opening vs. current/closing odds delta as a feature (this was the one feature that consistently helped in football — prioritize it)
   - Backtest, report delta

7. **Odds-band sweep — apply immediately, don't wait for a bad backtest to force it**
   - Test restricting bets to different max-odds bands (e.g. ≤1.8, ≤2.0, ≤2.5, ≤3.0, off) and report ROI/win-rate per band
   - This directly replicates the fix that turned the football model's -22% into +4.85% — apply this discipline from the first backtest, not after the fact

## Dashboard extension (shared, not duplicated)
- Extend the existing Calibration/CLV dashboard with a **sport selector** (Football / Tennis)
- The underlying charts (calibration curve, Brier score, CLV trend, ROI-by-odds-band) stay the same components — only the data source (which D1 tables get queried) changes based on the selector
- Do not build a second, separate dashboard UI — this is a data-source switch on the existing views, not a new codebase
- Confirm the sport selector cannot accidentally blend football and tennis data in a single chart — each view must be scoped to one sport's data at a time

## Final honest report (same format as the football upgrade report)
Summary table: each feature step's ROI/win-rate/Brier delta, including any step that made things worse. State plainly whether the tennis model shows a real, sustained edge, mirroring the same "do not bet real money yet" discipline until paper-trade CLV confirms it — same threshold as football: 100+ logged bets, real CLV vs. closing line, not dependent on a handful of outlier wins.

## Explicitly out of scope
- No sets/games totals market yet — match-winner only for V1
- No doubles matches
- No injury/fitness data sourcing (no reliable free source at this tier — documented gap, not a task)
- No auto-bet placement, no guaranteed-return claims
- No changes to, or interaction with, the football model's live paper-trade data or tables
