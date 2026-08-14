# OddKet — Model Accuracy Upgrade Prompt

Use this with your AI coding agent on the existing OddKet codebase. Read the current model code, training pipeline, and backtest results before making changes.

## Non-negotiable constraints (unchanged from the PRD — do not violate these)
- **$0 budget.** Free data sources only (football-data.co.uk, FBref — check ToS/robots.txt before scraping; free-tier odds API only). No paid data, no paid hosting.
- **No fabricated edges.** If a feature doesn't improve the honest backtest, do not ship it, do not fudge the numbers, and report the negative result plainly.
- **No leakage.** Every new feature must be computed only from information available *before* kickoff. Before adding any feature, explicitly state what data it uses and confirm none of it comes from the match being predicted or from after kickoff.
- **Time-ordered validation stays mandatory.** Every retrain must re-run the time-ordered split backtest (never random split) and report ROI, win rate, and calibration (Brier score + bin gaps) before and after the change.
- **Report the true number every time**, even if it's still negative. The goal is finding real signal, not making the backtest number look better through overfitting or leakage.

## Current state (for context)
- 5,784 real matches, 4 leagues, 2021–2025
- 12 team-level features (form, Elo, goals, shots-on-target, H2H) — leakage-free
- Time-ordered split, calibrated (Brier 0.601)
- Backtest without odds feature: ROI -8.75%
- Backtest with market odds as a feature: ROI -4.71%, win rate 34.3% — improved but still no proven edge

## Task list (implement and backtest each one independently before moving to the next — do not batch changes together, or you won't know which change actually helped)

### 1. Expected goals (xG) feature — highest priority
- Source xG data from FBref (or another free, ToS-compliant source) for the same leagues/seasons already in the dataset
- Add as team-level rolling features: xG for, xG against, over last N matches
- Retrain, re-backtest, report the delta vs. the current -4.71% baseline

### 2. Split home/away team strength
- Replace the single blended Elo/strength rating with separate home-Elo and away-Elo, computed independently from home and away match results only
- Retrain, re-backtest, report delta

### 3. Recency-weighted form
- Replace flat-average "last N games" form with exponentially weighted recent form (recent matches weighted more heavily than older ones)
- Retrain, re-backtest, report delta

### 4. Fixture congestion / rest days
- Add: days since each team's last match, and a binary flag for whether that prior match was a midweek cup/European fixture
- This is computable entirely from existing match date data — no new data source needed
- Retrain, re-backtest, report delta

### 5. Odds movement (steam)
- Pull both opening and current/closing odds for each fixture (not just one snapshot)
- Add the delta (movement) as a feature, not just the current price
- Retrain, re-backtest, report delta

### 6. Cross-bookmaker odds spread
- If multiple bookmaker odds are available per fixture, compute the spread/variance across books as a feature (tight consensus vs. wide disagreement)
- Retrain, re-backtest, report delta

### 7. Historical volume expansion
- Pull additional seasons (not additional leagues) for the same four leagues already in use, from football-data.co.uk's free historical archives
- Re-run the full pipeline on the expanded dataset with the best feature set found in steps 1–6
- Report final delta

## After all steps: final honest report

Produce a summary table: baseline ROI/win-rate/Brier vs. final ROI/win-rate/Brier, with each step's individual contribution listed (including any step that made things worse or had no effect — those results matter too and should not be hidden).

State plainly whether the model now shows a real, sustained edge or not. If it doesn't, say so — do not round up, do not cherry-pick the best-looking backtest window, and do not ship a positive-sounding summary if the honest number is flat or negative. The CLV/calibration dashboards exist specifically so this project never has to lie about its own performance — that principle applies to this upgrade work too.

## Explicitly out of scope for this task
- No LLM-based prediction of match outcomes or probabilities (keep the numeric model as the sole prediction engine)
- No injury/lineup data sourcing yet (no reliable free source at sufficient depth — this stays a documented future gap, not a V1 task)
- No auto-bet placement, no guaranteed-return claims, no changes to the singles-first / stake-suggestion / manual-slip-only behavior already locked into the PRD
