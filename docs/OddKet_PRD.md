# OddKet — Product Requirements Document

**Owner:** Eleazar Ogoyemi (codeleyoungtech)
**Status:** Draft v1
**Date:** August 2026

---

## 1. What OddKet Is

OddKet is a personal decision-support tool for sports betting on SportyBet. It does **not** predict guaranteed outcomes, does not place bets automatically, and does not promise any specific return. Its job is to tell the truth about whether a betting model has a real, measurable edge — and to help stake sensibly if it does.

**Explicitly out of scope:**
- No auto-placement of bets (you place every slip yourself, in the SportyBet app)
- No promised win rate, multiplier, or payout target
- No "fixed match" data of any kind

---

## 2. Problem Statement

Eleazar wants to build a hobby-scale sports betting tool that:
1. Tells him what to bet on, backed by real probability estimates (not gut feel)
2. Groups selections into slips (singles or multiples) with the true math shown
3. Tracks whether his picks are actually good over time — not just whether individual bets won

---

## 3. Budget Constraint (non-negotiable)

**V1 must run on $0.** No paid odds API tier, no paid data source, no paid hosting.

- **Odds API:** free tier only (e.g. The Odds API free tier, ~500 requests/month) — Cron pull frequency must be tuned to stay inside this (a few times a day, not hourly; one or two leagues at a time, not many)
- **Historical training data:** free tier sources only (e.g. football-data.org free tier)
- **Hosting/infra:** Cloudflare Workers + D1 free tier, which comfortably covers hobby-scale usage
- **Do not upgrade to any paid tier until backtesting/calibration results (Section 7.7) show the model has a real, positive signal.** No spend before there's evidence it's worth spending on.

If a build step would require a paid service to function, the correct move is to scale down scope (fewer leagues, lower Cron frequency, smaller historical window) rather than introduce cost.

---

## 4. Core Principles (non-negotiable)

- **Truth over excitement.** Every prediction ships with a confidence interval and calibration history, not just a headline number.
- **Singles by default.** Multiples are opt-in and always show true compounded probability alongside SportyBet's advertised multiplier.
- **CLV is the scoreboard.** Closing Line Value — not win/loss — is the primary metric for "is this model any good."
- **No auto-bet.** The user places every slip manually.
- **Bankroll discipline is built-in, not optional.** Stake sizing suggestions are always shown; there's no way to see a pick without also seeing the recommended stake.

---

## 5. Data Sourcing (important constraint)

SportyBet does not publish a public API for odds or bet placement. Two realistic paths, both with trade-offs to flag upfront:

| Approach | Pros | Cons |
|---|---|---|
| **Manual odds entry** | Zero ToS risk, simple to build first | Tedious, limits scale |
| **Scraping SportyBet's site/app** | Enables automation | Likely violates SportyBet's Terms of Service; risk of account flags/bans; fragile to site changes |
| **Third-party odds API** (e.g. The Odds API, OddsPortal-style aggregators) | Legitimate, stable, covers many books | Odds may not exactly match SportyBet's own margin/pricing |

**Recommendation for V1:** Start with a third-party odds API for the prediction/EV engine (legitimate, stable), and manual entry or a lightweight personal browser extension for cross-checking against your actual SportyBet slip before you bet. Revisit scraping only after checking SportyBet's ToS directly — not something to build around by default.

---

## 6. Architecture

**Stack**
- **Backend/app layer:** TypeScript — Node.js + Hono or Express, Cloudflare Workers + D1 (consistent with your existing stack)
- **Model training:** Python sidecar — XGBoost/LightGBM for classification (win/draw/loss, BTTS, over/under), scikit-learn for calibration checks
- **Frontend:** React (Next.js or your Capacitor/Ionic setup if you want mobile)
- **Database:** D1 (or Postgres if scale grows) — stores odds snapshots, predictions, bets, outcomes
- **Scheduling:** Cloudflare Cron for periodic odds pulls and model retraining triggers

**High-level flow**
```
[Odds API] → [Ingestion Worker] → [D1: odds_snapshots]
                                          ↓
[Python model] → predictions → [D1: predictions]
                                          ↓
[EV Engine] compares predictions vs odds → [D1: flagged_bets]
                                          ↓
[TS App] → Slip Builder UI → user reviews → places bet manually on SportyBet
                                          ↓
[User logs actual bet placed] → [D1: bets]
                                          ↓
[Closing odds pulled pre-kickoff] → [CLV Engine] → [D1: clv_results]
                                          ↓
[Outcome recorded post-match] → [Calibration Dashboard]
```

---

## 7. Feature Breakdown

### 7.1 Prediction Engine (Python)
- Ingests historical match data (goals, xG, form, home/away splits, head-to-head)
- Trains per-market models: match result, BTTS, over/under 2.5, correct score buckets
- Outputs a probability + confidence interval per market per fixture
- Retrains on a schedule (weekly, or after each matchday)

### 7.2 Odds & Market Intelligence (TS)
- Pulls current odds per fixture/market from the odds API
- Converts odds → implied probability (accounting for bookmaker margin)
- Computes **edge** = model probability − implied probability
- Flags positive-EV bets only when edge exceeds a configurable threshold (avoids noise-level "edges")

### 7.3 Slip Builder (TS + React)
- Default view: ranked list of single-bet EV opportunities
- Optional multiple builder: select legs, see true compounded probability vs SportyBet's advertised odds/multiplier side by side
- Correlation warning: flags when two legs in a slip aren't statistically independent (e.g. "Team A wins" + "Over 2.5 goals" in the same match)
- No "place bet" button — outputs a clean slip summary (selections, stake, expected odds) for manual entry into SportyBet

### 7.4 Staking Module (TS)
- Kelly Criterion (fractional, e.g. quarter-Kelly for safety) based on bankroll + model confidence
- Hard stop-loss setting (daily/weekly cap) enforced at the UI level
- Every recommendation ships with a stake — never a naked pick

### 7.5 Bet Logging (TS)
- User manually confirms what they actually staked on SportyBet (odds may differ slightly from when flagged)
- Stores: fixture, market, odds at bet time, stake, timestamp

### 7.6 CLV Engine (TS + Cron)
- Pulls closing odds (just before kickoff) for every logged bet
- Computes CLV = (odds you got) vs (closing odds) → positive CLV over time = real skill signal
- This is the dashboard Eleazar should watch most closely — not win/loss

### 7.7 Calibration & Backtesting (Python + TS dashboard)
- Brier score and calibration curve: do the model's "70% confidence" picks actually hit ~70% of the time?
- Backtest mode: run the model against historical odds data, no real money, see how it would have performed
- Paper-trading mode: run live for N weeks logging picks without staking, to sanity-check before real money

### 7.8 Dashboard (React)
- CLV trend line (the headline metric)
- Calibration chart
- ROI over time, by market type and league
- Bankroll curve with drawdown visualization
- Bet history log

---

## 8. Explicit Non-Goals

- No promise of any specific ROI, win rate, or payout multiplier
- No automated bet placement on SportyBet
- No "fixed match" or insider information sourcing of any kind
- No feature designed to encourage stake escalation after losses (no "chase" mechanics)

---

## 9. V1 Build Order (suggested, weekend-to-few-weeks scale)

1. Odds ingestion (third-party API) + D1 schema
2. Basic model: single market (e.g. BTTS) using historical data, Python + XGBoost
3. EV calculator (implied probability vs model probability)
4. Manual bet logging + CLV calculation against closing odds
5. Calibration dashboard (the "is this actually working" view)
6. Slip builder UI with singles-first display
7. Staking module (Kelly-based suggestions)
8. Backtest/paper-trade mode
9. Multiples support with correlation warnings

---

## 10. Success Metric (the only one that matters)

**Positive CLV, sustained over a meaningful sample (100+ bets), across multiple market types.**

Not: "did I win this week." Not: "did I hit a big multiple." If CLV trends flat or negative after a real sample size, the honest conclusion is the model doesn't have an edge yet — and OddKet's job is to say that clearly, not hide it behind a good week.
