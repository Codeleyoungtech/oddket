# OddKet — Corner Model v6 (validation report)

> The owner's instinct was right: *"I don't know if it is overfitting or
> something, something just doesn't fit right with the corner model."* It was not
> overfitting. It was three specific defects, and all three were measurable.

Reproduce everything below with:

```bash
cd model
.venv/bin/python scripts/diag_corners_v5.py       # the diagnosis
.venv/bin/python scripts/train_corners_v6.py      # the rebuild + honest report
.venv/bin/python scripts/predict_corners_v6.py \
    --fixtures data/fixtures.json --output data/corners_predictions.json
```

---

## 1. What was actually wrong

### 1.1 Train/serve skew on the model's second-strongest feature

`train_corners_v5.py` trained on six market-derived features with **real values**:

```
implied_home, implied_draw, implied_away, odds_overround,
implied_goals_over25, ah_home
```

`predict_corners_v5.py` fed those same columns **hardcoded constants**:
`0.33 / 0.33 / 0.33 / 1.0 / 0.5 / 0.0`.

This was not a minor input. `odds_overround` was the **#2 feature by gain** for
both team models (1,369 and 1,383), and the three implied probabilities all sat
in the top 12. The deployed model was being fed a constant for one of its
strongest inputs, on every prediction, forever.

**Measured cost** — same trained model, holdout of 6,272 matches:

| | home MAE | total MAE |
|---|---|---|
| as trained (real odds) | 2.2396 | 2.7077 |
| **as served (constants)** | **2.3384** | **2.8054** |
| damage | **+0.099** | **+0.098** |

And the systematic output shift from the skew alone was **0.81 corners** — the
model's own prediction moved by nearly a full corner depending on whether it got
the real price or the placeholder.

### 1.2 Elo look-ahead leakage

`compute_elo_ratings()` walked the **whole** match list and returned each team's
**final** rating, which `build_dataset()` then used as a feature for *every*
historical match. A fixture played in 2014 was described by a rating that only
exists in 2026.

Elo was a top-6 feature (`elo_diff` 1,175, `away_elo` 1,057, `home_elo` 941), so
the reported metrics were inflated by information the model cannot have live.
v6 updates Elo incrementally *inside* the chronological walk and uses only the
pre-match rating. Rebuilding with the leaky version reproduced the v5 holdout
exactly (home MAE 2.2396), which is how the leak was confirmed rather than
assumed.

### 1.3 The total was worse than a constant

v5 predicted home and away separately, summed them, and used
`sigma_total = sqrt(sigma_h² + sigma_a²)` — the **independence assumption**.
Measuring the residuals kills that assumption:

```
residual Var(home) = 8.022   Var(away) = 6.045   Cov(home, away) = -1.283
sigma_total if independent = 3.751
sigma_total actual         = 3.391      → ~11% too wide
```

Home and away corner counts are **negatively** correlated: a match has a roughly
finite number of corners, so possession swings one way. The independence formula
therefore overstated the total spread and the tail probabilities were
correspondingly wrong.

Worse, the summed point estimate was **worse than predicting the league average
total for every match**:

| | home | away | **total** |
|---|---|---|---|
| naive (league average) | 2.3649 | 2.0882 | **2.7113** |
| v5 **as deployed** | 2.3384 | 1.9978 | **2.8054** ← worse than naive |

That is the arithmetic behind "all totals is shite". The total was not just
uninformative, it was **harmful**, and it was feeding live flagged bets.

---

## 2. What v6 changes

1. **Real odds at serve time.** `/api/fixtures/export` already returns the best
   h2h + totals price per fixture, so the six market features get real values in
   production. `ah_home` is dropped outright — it is never available live. A
   `has_odds` flag is stored so a prediction made without a book is labelled as
   the weaker thing it is.
2. **One feature function.** `train_corners_v6.build_features` is called by both
   the trainer and the predictor. v5 had a second, hand-copied implementation,
   which is how the skew happened in the first place.
3. **A direct total model.** `corners_total_model.joblib` predicts the match total
   end-to-end, with its own out-of-fold dispersion. No summing, no independence
   assumption.
4. **Walk-forward Elo.** No future information in any feature.
5. **Heteroscedastic `sigma(mu)`.** `sigma(mu) = slope·sqrt(mu) + intercept`,
   fitted on **out-of-fold** residuals. In-sample residuals understate real error
   (the dispersion model's own in-sample σ was 1.85 against an out-of-fold 2.27 —
   a 1.22× understatement), and every line probability built on them is too
   extreme.
6. **Honest reporting.** Every metric is compared to a naive baseline, and the
   line probabilities are checked for calibration on an untouched holdout.

### A rejected idea, recorded

A distribution-free approach was tried first: standardise training residuals by
`sigma(mu)` and read probabilities off the empirical quantile function. It scored
**2–3× worse** than the parametric Negative Binomial (mean |error| 0.070 vs
0.030). It had fit the *in-sample* tail shape and applied it out-of-sample.
Keeping NB and fixing `sigma` was the right call; the parametric shape
regularises where the empirical one overfits.

---

## 3. Results (holdout 2022-02-24 → 2026-05-24, 6,272 matches)

Skill is measured against the naive "predict the league average" baseline, which
is the only honest yardstick for a regression.

| | naive MAE | **v5 as deployed** | skill | **v6** | skill | Δ vs deployed |
|---|---|---|---|---|---|---|
| home corners | 2.3649 | 2.3384 | +1.1% | **2.2445** | **+5.1%** | **−0.094** |
| away corners | 2.0882 | 1.9978 | +4.3% | **1.9523** | **+6.5%** | **−0.046** |
| match total | 2.7113 | 2.8054 | **−3.5%** | **2.6888** | **+0.8%** | **−0.117** |

R²: home 0.1037, away 0.0943, total **0.0129**.

**Read the total honestly.** It went from actively harmful to marginally
useful. +0.8% skill and R² 0.013 means match-total corners are *barely*
predictable — the signal lives in the **team** corner lines (R² ≈ 0.10, 5–6.5%
better than baseline), not in the match total. That is a real finding and it
should shape the UI: lead with team lines.

### Line-probability calibration (holdout)

Claimed vs realised, out-of-fold `sigma(mu)`, both sides of every rung:

| market | mean \|error\| | max \|error\| | worst rung |
|---|---|---|---|
| team home | **0.0285** | 0.0390 | Over 2.5 (+3.9pp) |
| team away | **0.0263** | 0.0525 | Over 2.5 (+5.2pp) |
| match total | **0.0135** | 0.0286 | Over 7.5 (+2.9pp) |

The total ladder is now within **2.9pp** everywhere, and within 0.2pp at Over
10.5 and Over 11.5 — the rungs that actually matter for "Over/Under X.5" bets.
The team ladders carry a systematic **+3 to +5pp optimism on the low rungs**
(the model thinks Over 2.5 is likelier than it is) and a matching pessimism on
the high rungs. That is the remaining known weakness, and it is the reason the
"safe band" can pick a line it calls 75% that is closer to 71%.

---

## 4. Team-name resolution

The model is keyed on football-data.co.uk spellings (`Man United`,
`Nott'm Forest`); fixtures arrive from The Odds API with their own (`Manchester
United`, `Nottingham Forest`). v5 used a hand-written alias table covering only
the original four leagues, so **every** club in the seven added leagues failed to
match, and it then scored the fixture from a **league-average default** —
producing a confident-looking prediction built on no information.

v6 resolves in tiers, always reporting *how*: `exact → override → normalised →
token-set → token-subset → fuzzy (league-scoped, then global)`.

The token-subset tier is the one that matters, and getting it right took two
attempts. Requiring an *exact* token-set match missed `Newcastle United` →
`Newcastle`; guarding with a string-ratio floor (0.75) also rejected it, because
`newcastle united` vs `Newcastle` scores only 0.69 on `SequenceMatcher` purely
because one name has an extra word. The correct guard is **ambiguity**, not
similarity: a unique candidate is accepted; ties are broken by the fixture's
league and require a clear margin. Reserve sides (`Barcelona B`,
`Real Madrid Castilla`) are rejected outright so a B team can never fold onto its
first team.

**Coverage on the live feed: 0 → 97 of 145 fixtures**, across all 11 leagues:

| EPL | La Liga | Serie A | Bundesliga | Championship | League One | League Two | 2. Bundesliga | Segunda | Serie B | Super Lig |
|---|---|---|---|---|---|---|---|---|---|---|
| 18 | 17 | 10 | 8 | 10 | 8 | 10 | 5 | 6 | 2 | 3 |

### The remaining gap is DATA, not code

The still-unresolved clubs are genuinely absent from the training history. The
`footballdata/` folder has 12 seasons × 4 leagues (EPL, La Liga, Bundesliga,
Serie A) but only **3 seasons** (2012, 2020, 2021) for the seven second-tier
leagues, so clubs promoted since 2021 have no history at all. Adding more
seasons of `E1/E2/E3/D2/SP2/I2/T1` to `footballdata/` is the fix, and it is a
download, not a code change. J-League fixtures are out of scope entirely — the
model has never seen them and correctly declines to predict.

---

## 5. What is stored now

Migration `0008_corner_v6.sql` adds `total_corners`, `total_line_probs`,
`sigma_home`, `sigma_away`, `sigma_total`, `has_odds`, `league` to
`corners_predictions`, plus a new `corner_outcomes` table.

Two consequences worth stating:

* **The app no longer recomputes the model's numbers.** The predictor ships its
  line probabilities and sigmas and the worker stores them verbatim. The old
  TypeScript constants (2.849 / 2.456) did not even match the trainer's own
  metadata (2.832 / 2.4585) — the numbers on screen were not the numbers the
  model produced.
* **Corner results are now recorded**, so grading is automatic. `corner_outcomes`
  is filled by `POST /api/corners/fetch-results`, which uses the API-Football
  client (`worker/src/corners/api-football.ts`) with a round-robin key pool.

---

## 6. Seeing the results (this used to be manual)

`/corners` now opens with a **scoreboard**, computed by
`gradeCornerPredictions` in `packages/core/src/corners.ts`:

* team lines and total lines scored **separately** (they are different bets and
  they perform differently),
* **line accuracy** — how often the over/under call was right,
* **Brier** per line, both sides of every rung, so a model that is right about
  Over 4.5 and wrong about Under 4.5 cannot hide,
* **MAE** per side and for the total,
* **80% band coverage** — the share of results inside the model's own interval,
  which should be ~80%,
* a **reliability table** (claimed vs observed by probability bin).

Every stored line is graded. Nothing is filtered to "picks", so the scoreboard
cannot be improved by declining to publish the bad lines.

The cron (`corners` endpoint, 21:45 UTC daily) pulls real corner counts for
finished fixtures we predicted. It costs credits only for fixtures not yet
graded, so a quiet day costs nothing.

---

## 7. Still open

1. **API-Football keys are not configured yet.** Set `API_FOOTBALL_KEYS` on the
   Cloudflare worker (comma- or whitespace-separated, one key or many). Without
   it `POST /api/corners/fetch-results` returns `501 {configured:false}` and
   nothing else breaks — the scoreboard simply stays empty. Note the
   `/fixtures/statistics` endpoint must be included in your plan; that is where
   corner counts live.
2. **The +3 to +5pp low-rung optimism on team lines** (§3) is the next real
   modelling win. It is the difference between "the safe band said 75%" and
   "it was 71%".
3. **The match total is barely predictable** (R² 0.013). Size expectations
   accordingly; team lines are where the signal is.
4. **More second-tier seasons** would lift name coverage and team-history depth
   together (§4).
5. **No corner rule book yet.** The football rule book exists
   (`docs/RULES.md`) because there was enough graded history to mine it. Corner
   rules need the same thing, and that requires item 1 running for a while
   first — which is exactly the discipline the football book was built on.
