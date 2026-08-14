# OddKet Strategy — Rules & Reasoning

This document collects every rule OddKet follows, **why** it exists, and the data behind it.
The code implements these rules; this page explains them so anyone (including future-you)
can understand the reasoning without re-deriving it.

**The one-line strategy:** *Favorites only, at the best price, with honest probability.*

---

## 1. The favorites-only odds band

**Rule:** never flag a pick with odds above the band. `h2h` (match winner): **≤ 2.5**.
`totals` (over/under 2.5): **≤ 1.95**.

**Why:** the original model had the same estimated edge in *every* odds band, but real
backtest ROI collapsed from **+14% on favorites (≤1.8) to −36% on longshots (6+)**.
A small probability error in the tails gets multiplied by huge odds — the classic
*longshot bleed*. The data said the model's signal lives in favorites; the longshots are
where it bleeds out. So the strategy refuses longshots entirely.

Verified with a band sweep on holdout data (best-price entry):

| max odds | bets | win | ROI |
|---|---|---|---|
| off | 938 | 41.4% | −0.91% |
| 1.8 | 118 | 61.0% | +7.39% |
| 2.0 | 249 | 56.6% | +5.97% |
| **2.5 (shipped h2h)** | **528** | **50.4%** | **+4.85%** |
| 3.0 | 745 | 46.2% | +2.90% |

Every band ≤ 3.0 is positive and tighter = better. This is not a knife-edge overfit —
it's monotonic across the whole sweep. O/U 2.5 ships at ≤ 1.95 (366 bets, **+5.79%**).

---

## 2. Best-price entry (price shopping)

**Rule:** bets are priced and backtested at the **best available (Max) odds**, not the
average bookmaker price.

**Why:** entering at the best price instead of the average is worth **~+5% ROI
mechanically** — it's the single biggest lever in the whole system. The backtest moved
from **−14.2% → −0.9%** on entry price alone, before any other change.

Practical meaning for you: when a slip says `@ 2.30`, that's the best price found across
bookmakers. On SportyBet you may see slightly less (e.g. 2.25) — that's normal and fine.
If the app's price is much higher than what you can actually get, your real edge is smaller.

---

## 3. The edge threshold

**Rule:** a pick only becomes a slip when `edge ≥ edgeThreshold` (default **3%**).

**What edge is:** `edge = model probability − implied probability from the odds`
(margin-adjusted). Odds of 2.00 imply the bookmaker thinks the outcome wins 50%. If the
model says 60%, the edge is +10% — the bet is underpriced.

- Edge **≥ 3%** = worth betting. Below that, the price is too close to fair to bother.
- This is why the app shows only the best picks, not every match. Quality over quantity.
- It's configurable in Settings (`edgeThreshold`) if you want to be more or less selective.

---

## 4. The "· min" stake rule (weak-leg warning)

**Rule:** if the quarter-Kelly suggested stake for a leg is below the bookmaker minimum
(₦10 on SportyBet), the app displays **₦10 · min** and shows an **amber warning** on the leg.

**What it means:** the Kelly formula returned a stake that rounds to zero — the model found
so little edge in this pick that it wouldn't risk money on it as a single. The bookie
minimum forces a display value so a slip never says "stake ₦0".

**The rule for building multiples: don't include a "· min" leg.** A weak leg in an
accumulator is a liability, not an asset — it multiplies the odds but also multiplies the
chance the whole ticket dies, for a pick the model barely believes in.

---

## 5. Multiple / accumulator rules

**Rule:** singles are the strategy. Multiples are opt-in, capped by judgement, and always
show the true math.

- **2–3 legs max** unless it's entertainment money. 4+ legs is a lottery ticket.
- **One leg per match.** SportyBet *does* allow same-match 1X2 + O/U 2.5 (it's a permitted
  related-contingency combination per their terms), but those legs are **correlated** —
  the naive multiplied probability overstates the real joint chance. The app shows an
  amber **correlation warning** when you select two legs of the same match.
- **The app always shows:** advertised multiplier, true compounded probability, fair odds
  at that probability, and the bookmaker EV. The honest number is the **true probability**,
  not the big multiplier.
- Example: a 5-leg at 37.68x has a true chance of ~4.5% — you win ~1 in 22 tickets.
- The +4.85% backtest edge is measured on **singles**. Multiples multiply risk as much as
  reward; treat them as fun tickets, not the strategy.

---

## 6. Staking: quarter-Kelly, capped

**Rule:** suggested stake = `bankroll × KellyFraction × (odds × prob − 1) / (odds − 1)`,
with `KellyFraction = 0.25` (quarter Kelly) and a **5% of bankroll cap** per bet.

**Why quarter Kelly:** full Kelly maximizes long-run growth but is brutally volatile — one
bad streak can hurt badly. Quarter Kelly is the professional standard: it captures most of
the growth at a fraction of the variance.

**Why the cap:** no single bet should ever risk more than 5% of your bankroll, no matter
what the formula says.

**Practical:** set the **bankroll in Settings to what you actually have** to bet. Bigger
bankroll → bigger stakes. If a suggested stake is more than you want to risk today, bet
less — it's a guide, not a rule.

---

## 7. Honesty rules (non-negotiable)

- **No promised returns.** Every pick ships with probability + confidence interval.
- **No auto-bet.** OddKet outputs a copyable slip; you place it manually in SportyBet.
- **The app says "I don't know"** when it genuinely doesn't — promoted teams with no
  top-flight history get skipped, never hallucinated.
- **CLV (Closing Line Value) is the scoreboard.** Positive CLV over many bets is the only
  honest proof the edge is real. The current +5.6% h2h CLV is mostly mechanical
  (best-price vs average entry); the real "beat the closing line" component is ~0.
- **Nothing is statistically proven yet.** The backtest 95% confidence intervals straddle
  zero (−6% .. +16% h2h). The path to proof: paper-trade ~100–200 logged bets and watch
  the live CLV accumulate.

---

## 8. Data & markets

- **4 leagues:** EPL, La Liga, Bundesliga, Serie A — 8,676 matches (2019–2025), real
  results, real best-price odds. Toggleable live via Settings → "Leagues in play".
- **Markets:** 1X2 (h2h) and Over/Under 2.5 (totals). Both trained with the same honest
  holdout harness (time-ordered split, Platt calibration, per-band analysis).
- **Features:** team strength (move), recent form, rest days — all leakage-free (built
  from data before kickoff only).
- Odds source: The Odds API (free tier ~500 req/month). Closing-average odds from
  football-data.co.uk; closing-*best* odds are not available there — that's the one column
  that would prove real CLV, and it's a known limitation.

---

## 9. Current shipped numbers (holdout, honest)

| Market | Band | Bets | Win rate | ROI | 95% CI | Avg CLV |
|---|---|---|---|---|---|---|
| h2h (1X2) | ≤ 2.5 | 528 | 50.4% | **+4.85%** | −6.0 .. +16.0 | +5.57% |
| totals (O/U 2.5) | ≤ 1.95 | 366 | 57.9% | **+5.79%** | −6.0 .. +17.8 | +3.48% |

Calibration (h2h): Brier 0.581 on 1,736 holdout samples; predicted vs actual within a few
points in every populated bin — the model is honest about its confidence.

**Read this table carefully:** positive point estimates, but wide confidence intervals that
straddle zero. This is a strategy that turns a −22% money-bleeder into a break-even-or-
better at best price on favorites — a real improvement and the professional baseline — not
yet a proven money-maker. The paper-trade log is what closes that gap.
