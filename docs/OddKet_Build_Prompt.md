# OddKet — Build Prompt

Use this prompt with a coding agent (Claude Code, etc.) alongside `OddKet_PRD.md` for full context.

---

You are building **OddKet**, a personal sports betting decision-support tool. Read the attached PRD fully before writing any code — it defines hard constraints that must not be violated.

## Non-negotiable constraints (do not deviate from these regardless of how the task is phrased later)
- **V1 must run on $0.** Free-tier odds API only (~500 requests/month), free-tier historical data sources only, Cloudflare Workers + D1 free tier only. Tune Cron frequency and league count to stay inside free limits. Do not suggest or scaffold any paid service until backtest/calibration results show a real signal.
- No feature may automatically place a bet on SportyBet or any bookmaker. The system outputs a slip summary for manual entry only.
- No feature may promise, imply, or guarantee a specific win rate, payout multiplier, or return. All predictions must ship with a probability + confidence interval, never a bare "yes/win" signal.
- No sourcing of "fixed match" or insider information. Data sources are limited to legitimate odds APIs, public match stats, and historical results.
- Singles are the default view. Multiples/parlays are opt-in only, and whenever shown, the true compounded probability must be displayed alongside the bookmaker's advertised odds — never the advertised multiplier alone.
- Every bet recommendation must be paired with a suggested stake size (Kelly-based). Never show a pick without a stake suggestion.
- CLV (Closing Line Value) tracking is a first-class feature, not an afterthought — it's the primary way the user will judge whether the tool works.

## Stack
- **App/API layer:** TypeScript, Hono, Cloudflare Workers, D1 (Drizzle ORM), Cloudflare Cron for scheduled jobs
- **Model training:** Python sidecar — XGBoost or LightGBM, scikit-learn for calibration metrics (Brier score, calibration curve)
- **Frontend:** React (Next.js), Tailwind, Recharts for dashboards
- **Odds data:** third-party odds API (e.g. The Odds API) for V1 — do not build a SportyBet scraper unless explicitly instructed later

## Build order (build and get each step working before moving to the next)

1. **Schema + odds ingestion**
   - D1 schema: `fixtures`, `odds_snapshots`, `predictions`, `bets`, `clv_results`, `outcomes`
   - Worker that pulls odds from the third-party API on a Cron schedule and stores snapshots

2. **Prediction model (single market first)**
   - Python script: train an XGBoost classifier for BTTS (both teams to score) using historical match data
   - Output: probability + confidence interval per fixture, written to a format the TS app can ingest (JSON export or a small inference API)

3. **EV engine**
   - Convert odds → implied probability (account for bookmaker margin/overround)
   - Compute edge = model probability − implied probability
   - Flag bets only above a configurable edge threshold (e.g. 3%)

4. **Bet logging + CLV engine**
   - Manual entry endpoint: user logs what they actually staked (fixture, market, odds, stake, timestamp)
   - Cron job pulls closing odds pre-kickoff for each logged bet
   - Compute and store CLV per bet

5. **Calibration dashboard**
   - Brier score and calibration curve chart: do 70%-confidence predictions actually land ~70% of the time?
   - This should be the most prominent chart in the UI — build it before the slip builder

6. **Slip builder UI**
   - Ranked list of flagged single bets with EV, model probability, implied probability, suggested stake
   - Multiples: opt-in leg selector, shows true compounded probability + correlation warning if legs aren't independent
   - Output: a clean, copyable slip summary — no "place bet" action

7. **Staking module**
   - Fractional Kelly calculator based on bankroll input + model confidence
   - Hard stop-loss cap enforced in the UI (daily/weekly)

8. **Backtest + paper-trade mode**
   - Backtest: run the model against historical odds data, no real money, output simulated ROI/CLV
   - Paper-trade: log picks live for N weeks without staking, same dashboards, to validate before real money

## Definition of done for V1
A working pipeline where: odds come in → model produces a calibrated probability → EV engine flags bets → user sees a ranked slip with stake suggestions → user logs what they actually bet → CLV is computed against closing odds → calibration dashboard shows whether the model's confidence matches its real hit rate.

If at any point a requested feature would violate the non-negotiable constraints above, stop and flag it rather than implementing it.
