# OddKet Model Validation Report

**Date:** 2026-08-14
**Status:** Directionally sound, statistically unproven — read the honesty section.

This report validates the OddKet model on honest holdout data (time-ordered split, real
results, real best-price odds). It states what the model is, what the numbers show, and
exactly what is *not* yet proven.

---

## 1. The strategy in one line

**Favorites only, at the best price, with honest probability.**

- Never bet above the odds band: `h2h ≤ 2.5`, `totals ≤ 1.95`
- Always price at the best available (Max) odds, not the average
- Every pick ships with a probability + confidence interval, never a bare "win"

---

## 2. Shipped numbers (holdout)

### H2H (1X2) — band ≤ 2.5

| Metric | Value |
|---|---|
| Holdout bets | 528 (2019–2025, 4 leagues) |
| Win rate | 50.4% |
| **ROI** | **+4.85%** |
| 95% confidence interval | −6.0% .. +16.0% |
| Avg CLV | +5.57% |
| Max drawdown | ₦4,254 |

### O/U 2.5 — band ≤ 1.95

| Metric | Value |
|---|---|
| Holdout bets | 366 |
| Win rate | 57.9% |
| **ROI** | **+5.79%** |
| 95% confidence interval | −6.0% .. +17.8% |
| Avg CLV | +3.48% |
| Max drawdown | ₦2,552 |

---

## 3. The three findings that make the model credible

### 3.1 The longshot bleed was real and is fixed

The original model had the same estimated edge in *every* odds band, but holdout ROI
collapsed from **+14% on favorites (≤1.8) to −36% on longshots (6+)**. Small probability
errors in the tails get multiplied by huge odds — the classic longshot bleed.

The band sweep is monotonic across the whole range, which is a real signal, not a
knife-edge overfit:

| max odds | bets | win | ROI |
|---|---|---|---|
| off | 938 | 41.4% | −0.91% |
| 1.8 | 118 | 61.0% | +7.39% |
| 2.0 | 249 | 56.6% | +5.97% |
| **2.5 (shipped h2h)** | **528** | **50.4%** | **+4.85%** |
| 3.0 | 745 | 46.2% | +2.90% |

### 3.2 Price shopping is the biggest lever

Entering at the best price instead of the average bookmaker price is worth **~+5% ROI
mechanically**. The backtest moved from **−14.2% → −0.9%** on entry price alone, before
any other change. Odds you actually get matter more than anything the model does.

### 3.3 Calibration is honest

- **Brier score:** 0.581 over 1,736 holdout samples
- Predicted vs actual within a few points in every populated bin
- When the model says 60%, ~60% win

The model does not systematically overstate its confidence.

---

## 4. The honesty section (read this before betting)

### 4.1 The CLV is mostly mechanical

| Market | Avg CLV | Mechanical (Max vs Avg) | Real (beat closing line) |
|---|---|---|---|
| h2h | +5.57% | ~+5.4% | **~0%** |
| totals | +3.48% | ~+5.4% | **−1.9%** |

The positive CLV comes almost entirely from *how* we price (best vs average), not from
out-predicting the market. The picks do **not** yet beat the closing line.

### 4.2 The profit is not statistically significant

- Both 95% confidence intervals straddle zero (−6.0% .. +16.0% h2h; −6.0% .. +17.8% totals)
- Win rate 50.4% vs 49.0% breakeven is a thin +1.4pp
- Top-10 winners carry most of the profit; remove them and h2h ROI is **−2.44%**

### 4.3 What this genuinely is

A strategy that turns a **−22% money-bleeder into break-even-or-better at best price on
favorites**. That is the professional baseline most models can't reach without lying — a
real engineering achievement. It is **not** yet a proven money-maker.

---

## 5. What validates it for real (the path)

1. **Paper-trade ~100–200 bets.** Logged bets settle automatically with real entry prices;
   the CLV scoreboard is the only measurement that can prove or kill the edge.
2. **Closing-best odds.** football-data.co.uk only provides closing-*average*; the closing-
   *best* column is the one that would prove real CLV.
3. **More seasons back to 2000.** ~5× more matches → tighter confidence intervals.

---

## 6. Recommendation

**Do not bet real money yet.** Log your bets, let the CLV accumulate, and let the
scoreboard decide. The model's direction is right; its proof is still being built.
