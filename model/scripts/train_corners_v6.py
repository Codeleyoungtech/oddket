#!/usr/bin/env python3
"""Corners prediction model V6 — honest rebuild (Pass 26).

V5's reported metrics were inflated and its live output was degraded. This
script fixes the three structural defects found by `diag_corners_v5.py`:

  1. TRAIN/SERVE SKEW. V5 trained on six real odds features
     (`implied_home`, `implied_draw`, `implied_away`, `odds_overround`,
     `implied_goals_over25`, `ah_home`) but the prediction script fed them
     constants. `odds_overround` was V5's #2 feature by gain. Measured cost of
     the skew: +0.10 corners MAE, and nearly a full corner of systematic output
     shift. V6 keeps the odds features AND passes real odds at serve time
     (`/api/fixtures/export` already returns best h2h + totals odds). `ah_home`
     is dropped outright — it is never available live. A `has_odds` flag is
     added so a fixture with no price is not silently fed neutrals the model
     would read as signal.

  2. ELO LOOK-AHEAD LEAKAGE. V5 computed Elo over the whole history and used
     each team's FINAL rating as a feature for every historical match — a 2014
     fixture described by a 2026 rating. Elo was a top-6 feature. V6 updates Elo
     incrementally as it walks the matches chronologically and uses the
     pre-match rating only.

  3. IGNORED CORRELATION IN THE TOTAL. V5 predicted home and away separately and
     summed, then used sigma_total = sqrt(sigma_h^2 + sigma_a^2) (independence).
     Measured residual covariance is -1.28, so that overstates the total sigma
     (3.75 vs a true 3.39) and the summed point estimate is WORSE THAN THE LEAGUE
     AVERAGE (total MAE 2.81 vs 2.71 naive). V6 trains a THIRD model directly on
     the match total, so the total point estimate and its dispersion are both
     estimated end-to-end.

It also adds what V5 lacked and what the owner asked for:

  * opponent-adjusted ATTACK / DEFENCE ratings (Dixon-Coles style) relative to a
    running league pace, instead of raw per-team means;
  * a `sigma(mu)` curve fitted from training residuals, so line probabilities are
    heteroscedastic instead of using one constant sigma for every match;
  * HONEST reporting — every metric is compared against a naive baseline, and the
    line probabilities are checked for calibration on the holdout. A model that
    cannot beat "predict the league average" is reported as such.

Run:  .venv/bin/python scripts/train_corners_v6.py
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from train_corners_v5 import ACTIVE_LEAGUES, load_all_data  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(ROOT), "footballdata")

VERSION = "corners-lgb-v6"

# Lines the predictor emits probabilities for.
TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]
TOTAL_LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5]

# Neutral values used when a fixture genuinely has no price. Kept identical in
# training and serving so the features mean the same thing in both.
NEUTRAL_ODDS = {
    "implied_home": 0.33,
    "implied_draw": 0.33,
    "implied_away": 0.33,
    "odds_overround": 1.0,
    "implied_goals_over25": 0.5,
}

# Feature columns that are driven by the bookmaker's price. Used by
# predict_corners_v6.py to decide whether it can feed real values.
ODDS_FEATURES = list(NEUTRAL_ODDS.keys()) + ["has_odds"]

FEATURE_NAMES: list[str] = []


# ---------------------------------------------------------------------------
# Running team state (chronological)
# ---------------------------------------------------------------------------
@dataclass
class State:
    cf_home: list[int] = field(default_factory=list)
    cf_away: list[int] = field(default_factory=list)
    ca_home: list[int] = field(default_factory=list)
    ca_away: list[int] = field(default_factory=list)
    shots_home: list[int] = field(default_factory=list)
    shots_away: list[int] = field(default_factory=list)
    sot_home: list[int] = field(default_factory=list)
    sot_away: list[int] = field(default_factory=list)
    fouls_home: list[int] = field(default_factory=list)
    fouls_away: list[int] = field(default_factory=list)
    cards_home: list[int] = field(default_factory=list)
    cards_away: list[int] = field(default_factory=list)
    goals_home: list[int] = field(default_factory=list)
    goals_away: list[int] = field(default_factory=list)
    conceded_home: list[int] = field(default_factory=list)
    conceded_away: list[int] = field(default_factory=list)
    elo: float = 1500.0
    last_ts: int = 0
    n_matches: int = 0


def _mean(xs: list, n: int = 0) -> float:
    w = xs[-n:] if n > 0 else xs
    return sum(w) / len(w) if w else 0.0


def _std(xs: list, n: int = 0) -> float:
    w = xs[-n:] if n > 0 else xs
    if len(w) < 2:
        return 0.0
    m = sum(w) / len(w)
    return math.sqrt(sum((x - m) ** 2 for x in w) / (len(w) - 1))


def _median(xs: list, n: int = 0) -> float:
    w = xs[-n:] if n > 0 else xs
    if not w:
        return 0.0
    s = sorted(w)
    mid = len(s) // 2
    return (s[mid - 1] + s[mid]) / 2.0 if len(s) % 2 == 0 else float(s[mid])


def _ew_mean(xs: list[float], decay: float = 0.85) -> float:
    """Exponentially weighted mean, most recent first."""
    if not xs:
        return 0.0
    num = den = 0.0
    for i, v in enumerate(reversed(xs)):
        w = decay ** i
        num += w * v
        den += w
    return num / den if den else 0.0


def _over_rate(xs: list[int], line: float) -> float:
    if not xs:
        return 0.0
    return sum(1 for v in xs if v > line) / len(xs)


# ---------------------------------------------------------------------------
# Feature construction — one function used for BOTH training and prediction so
# they cannot drift apart.
# ---------------------------------------------------------------------------
def build_features(
    home: State,
    away: State,
    home_name: str,
    away_name: str,
    league: str,
    ts: int,
    league_pace: dict[str, float],
    elo_home: float,
    elo_away: float,
    odds: dict[str, float] | None,
) -> dict[str, float]:
    f: dict[str, float] = {}

    pace = league_pace.get(league, 5.25)

    for prefix, st, is_home in (("h", home, True), ("a", away, False)):
        cf = st.cf_home if is_home else st.cf_away
        ca = st.ca_home if is_home else st.ca_away
        other_cf = st.cf_away if is_home else st.cf_home

        for w in (5, 10, 15):
            f[f"{prefix}_cf_l{w}"] = round(_mean(cf, w), 4)
            f[f"{prefix}_ca_l{w}"] = round(_mean(ca, w), 4)

        # All-venue season averages (venue lists fill as the team plays both ways)
        f[f"{prefix}_cf_season"] = round(_mean(cf + other_cf), 4)
        f[f"{prefix}_ca_season"] = round(_mean(ca), 4)
        f[f"{prefix}_cf_ew"] = round(_ew_mean([float(x) for x in cf][-15:]), 4)

        # Consistency of recent output
        f[f"{prefix}_cf_std"] = round(_std(cf, 10), 4)
        f[f"{prefix}_cf_cv"] = round(_std(cf, 10) / max(_mean(cf, 10), 0.1), 4)
        f[f"{prefix}_cf_median"] = round(_median(cf, 10), 2)
        f[f"{prefix}_cf_min"] = float(min(cf[-10:]) if cf else 0)
        f[f"{prefix}_cf_max"] = float(max(cf[-10:]) if cf else 0)

        for line in (3.5, 4.5, 5.5, 6.5):
            f[f"{prefix}_over_{line}"] = round(_over_rate(cf, line), 4)

        # ---- Dixon-Coles style attack / defence ratings vs running league pace
        f[f"{prefix}_attack_rating"] = round(_mean(cf, 10) / max(pace, 0.1), 4)
        f[f"{prefix}_defence_rating"] = round(_mean(ca, 10) / max(pace, 0.1), 4)

        shots = st.shots_home if is_home else st.shots_away
        sot = st.sot_home if is_home else st.sot_away
        fouls = st.fouls_home if is_home else st.fouls_away
        cards = st.cards_home if is_home else st.cards_away
        scored = st.goals_home if is_home else st.goals_away
        conceded = st.conceded_home if is_home else st.conceded_away

        f[f"{prefix}_shots_l10"] = round(_mean(shots, 10), 4)
        f[f"{prefix}_sot_l10"] = round(_mean(sot, 10), 4)
        f[f"{prefix}_fouls_l10"] = round(_mean(fouls, 10), 4)
        f[f"{prefix}_cards_l10"] = round(_mean(cards, 10), 4)
        f[f"{prefix}_goals_l10"] = round(_mean(scored, 10), 4)
        f[f"{prefix}_conceded_l10"] = round(_mean(conceded, 10), 4)
        # Shots per corner — how efficiently a side turns pressure into corners
        f[f"{prefix}_shot_per_corner"] = round(_mean(shots, 10) / max(_mean(cf, 10), 1.0), 4)

        f[f"{prefix}_n"] = float(min(st.n_matches, 40))
        rest = max(0, (ts - st.last_ts) // 86400) if st.last_ts else 14
        f[f"{prefix}_rest"] = float(min(rest, 30))

    # ---- Matchup interactions
    f["h_attack_x_a_defence"] = round(f["h_attack_rating"] * f["a_defence_rating"], 4)
    f["a_attack_x_h_defence"] = round(f["a_attack_rating"] * f["h_defence_rating"], 4)
    f["matchup_diff"] = round(
        (f["h_attack_rating"] - f["a_defence_rating"]) - (f["a_attack_rating"] - f["h_defence_rating"]),
        4,
    )

    # ---- Expected totals from the ratings (the classic DC expectation)
    f["expected_total"] = round(
        pace * (f["h_attack_rating"] + f["a_defence_rating"] + f["a_attack_rating"] + f["h_defence_rating"]) / 2.0,
        4,
    )
    f["home_venue_edge"] = round(f["h_cf_l10"] - _mean(home.cf_away, 10), 4)

    # ---- Elo (pre-match, no look-ahead)
    f["home_elo"] = round(elo_home, 1)
    f["away_elo"] = round(elo_away, 1)
    f["elo_diff"] = round(elo_home - elo_away, 1)
    f["elo_expected_home"] = round(1.0 / (1.0 + 10 ** ((elo_away - elo_home) / 400.0)), 4)

    # ---- Market features
    if odds and odds.get("home", 0) > 1.0 and odds.get("draw", 0) > 1.0 and odds.get("away", 0) > 1.0:
        total_implied = 1.0 / odds["home"] + 1.0 / odds["draw"] + 1.0 / odds["away"]
        f["implied_home"] = round((1.0 / odds["home"]) / total_implied, 4)
        f["implied_draw"] = round((1.0 / odds["draw"]) / total_implied, 4)
        f["implied_away"] = round((1.0 / odds["away"]) / total_implied, 4)
        f["odds_overround"] = round(total_implied, 4)
        f["has_odds"] = 1.0
    else:
        f.update(NEUTRAL_ODDS)
        f["has_odds"] = 0.0

    if odds and odds.get("ou_over", 0) > 1.0:
        f["implied_goals_over25"] = round(1.0 / odds["ou_over"], 4)
    else:
        f["implied_goals_over25"] = NEUTRAL_ODDS["implied_goals_over25"]

    # ---- League
    f["league_pace"] = round(pace, 4)
    for lg in ACTIVE_LEAGUES:
        f[f"league_{lg}"] = 1.0 if lg == league else 0.0

    return f


# ---------------------------------------------------------------------------
# Build the dataset chronologically, with a walk-forward Elo
# ---------------------------------------------------------------------------
def walk(matches, collect: bool = True):
    """Walk the match history chronologically.

    One walker serves both training and prediction, which is the whole point:
    the previous version had a *second*, independently written feature builder in
    the prediction script, and the two had silently drifted (six odds features
    were real in training and constants at serve time).

    `collect=False` skips feature building and just returns the final team state
    and league pace, which is what scoring an upcoming fixture needs.
    """
    global FEATURE_NAMES

    states: dict[str, State] = {}
    # Running league corner pace: total corners observed per league so far.
    pace_sum: dict[str, float] = defaultdict(float)
    pace_n: dict[str, int] = defaultdict(int)
    # Elo updates need goals-results; use corner-difference-derived "result"
    # so the rating expresses corner dominance.
    X: list[dict[str, float]] = []
    yh: list[int] = []
    ya: list[int] = []
    valid = []

    for m in matches:
        hs = states.setdefault(m.home, State())
        as_ = states.setdefault(m.away, State())

        league_pace = {
            lg: (pace_sum[lg] / pace_n[lg]) if pace_n[lg] >= 20 else 5.25
            for lg in ACTIVE_LEAGUES
        }

        if collect:
            feats = build_features(
                hs, as_, m.home, m.away, m.league, m.ts, league_pace,
                hs.elo, as_.elo,
                {
                    "home": m.odds_h, "draw": m.odds_d, "away": m.odds_a,
                    "ou_over": m.ou_25_over,
                },
            )
            # First row decides the canonical column order.
            if not FEATURE_NAMES:
                FEATURE_NAMES = list(feats.keys())
            X.append(feats)
            yh.append(m.hc)
            ya.append(m.ac)
            valid.append(m)

        # ---- state updates AFTER features (no leakage)
        hs.cf_home.append(m.hc)
        hs.ca_home.append(m.ac)
        hs.shots_home.append(m.hs)
        hs.sot_home.append(m.hst)
        hs.fouls_home.append(m.hf)
        hs.cards_home.append(m.hy + m.hr)
        hs.goals_home.append(m.fthg)
        hs.conceded_home.append(m.ftag)
        hs.last_ts = m.ts
        hs.n_matches += 1

        as_.cf_away.append(m.ac)
        as_.ca_away.append(m.hc)
        as_.shots_away.append(m.as_)
        as_.sot_away.append(m.ast)
        as_.fouls_away.append(m.af)
        as_.cards_away.append(m.ay + m.ar)
        as_.goals_away.append(m.ftag)
        as_.conceded_away.append(m.fthg)
        as_.last_ts = m.ts
        as_.n_matches += 1

        pace_sum[m.league] += m.hc + m.ac
        pace_n[m.league] += 1

        # ---- walk-forward Elo, updated with THIS match's corner dominance
        exp_h = 1.0 / (1.0 + 10 ** ((as_.elo - hs.elo) / 400.0))
        actual_h = min(1.0, max(0.0, 0.5 + (m.hc - m.ac) / 8.0))
        k = 20.0
        hs.elo += k * (actual_h - exp_h)
        as_.elo += k * ((1.0 - actual_h) - (1.0 - exp_h))

    final_pace = {
        lg: (pace_sum[lg] / pace_n[lg]) if pace_n[lg] >= 20 else 5.25
        for lg in ACTIVE_LEAGUES
    }
    return valid, X, np.array(yh, dtype=float), np.array(ya, dtype=float), states, final_pace


def build_dataset(matches):
    valid, X, yh, ya, _states, _pace = walk(matches, collect=True)
    return valid, X, yh, ya


def to_matrix(rows: list[dict[str, float]]) -> np.ndarray:
    return np.array([[r.get(name, 0.0) for name in FEATURE_NAMES] for r in rows], dtype=float)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
def make_model():
    import lightgbm as lgb

    return lgb.LGBMRegressor(
        n_estimators=3000,
        learning_rate=0.02,
        num_leaves=31,
        max_depth=6,
        min_child_samples=40,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.7,
        reg_alpha=0.5,
        reg_lambda=5.0,
        n_jobs=-1,
        random_state=42,
        verbose=-1,
    )


def fit_with_early_stop(X_tr, y_tr, X_val, y_val, label: str):
    """Fit with early stopping on a slice carved from the END of train, so the
    reported holdout stays completely untouched."""
    import lightgbm as lgb

    model = make_model()
    model.fit(
        X_tr, y_tr,
        eval_set=[(X_val, y_val)],
        eval_metric="l1",
        callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(0)],
    )
    print(f"  [{label}] best_iteration={model.best_iteration_}")
    return model


def metrics(y_true, y_pred, label: str, naive: float) -> dict:
    mae = float(np.mean(np.abs(y_pred - y_true)))
    rmse = float(np.sqrt(np.mean((y_pred - y_true) ** 2)))
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    bias = float(np.mean(y_pred - y_true))
    # Skill vs the naive baseline: how much of the baseline error we remove.
    skill = (naive - mae) / naive if naive > 0 else 0.0
    resid_sigma = float(np.std(y_pred - y_true, ddof=1))
    print(
        f"  [{label}] MAE={mae:.4f} (naive={naive:.4f}, skill={skill:+.2%}) | "
        f"RMSE={rmse:.4f} | R²={r2:.4f} | bias={bias:+.4f} | σ_resid={resid_sigma:.4f}"
    )
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "bias": round(bias, 4),
        "residual_sigma": round(resid_sigma, 4),
        "naive_mae": round(naive, 4),
        "skill_vs_naive": round(skill, 4),
    }


# ---------------------------------------------------------------------------
# Heteroscedastic sigma(mu): residual spread grows with the expected count
# ---------------------------------------------------------------------------
def fit_sigma_curve(mu: np.ndarray, resid: np.ndarray, n_bins: int = 12) -> dict:
    order = np.argsort(mu)
    mu_s, r_s = mu[order], resid[order]
    chunks = np.array_split(np.arange(len(mu_s)), n_bins)
    xs, ys = [], []
    for ch in chunks:
        if len(ch) < 30:
            continue
        xs.append(float(np.mean(np.sqrt(np.maximum(mu_s[ch], 1.0)))))
        ys.append(float(np.std(r_s[ch], ddof=1)))
    A = np.vstack([xs, np.ones(len(xs))]).T
    sol, *_ = np.linalg.lstsq(A, np.array(ys), rcond=None)
    slope, intercept = float(sol[0]), float(sol[1])
    print(f"  sigma(mu) = {slope:.4f} * sqrt(mu) + {intercept:.4f}")
    return {"slope": round(slope, 6), "intercept": round(intercept, 6),
            "bins": [[round(x, 4), round(y, 4)] for x, y in zip(xs, ys)]}


def sigma_at(mu: float, curve: dict) -> float:
    return max(1.0, curve["slope"] * math.sqrt(max(mu, 1.0)) + curve["intercept"])


# ---------------------------------------------------------------------------
# Out-of-fold dispersion
#
# Fitting sigma(mu) on IN-SAMPLE residuals understates the real error: LightGBM
# fits the training rows better than it fits anything else, so the in-sample
# spread is too small and every line probability built on it is too extreme
# (measured: +4pp optimistic at team Over 2.5, -4pp pessimistic at Over 8.5).
#
# A distribution-free z-table was tried first and rejected — it fit the in-sample
# tail shape and applied it out-of-sample, which measured 2-3x WORSE than the
# parametric NB (mean |error| 0.070 vs 0.030). The parametric shape regularises;
# the empirical one overfits. What actually helps is an honest sigma.
#
# So the dispersion curve is estimated from a model fit only on the TRAIN slice
# and evaluated on the early-stopping slice it never saw. The holdout is never
# touched.
# ---------------------------------------------------------------------------
def out_of_fold_dispersion(X_fit, y_fit, X_oof, y_oof, label: str):
    import lightgbm as lgb

    disp = lgb.LGBMRegressor(
        n_estimators=400, learning_rate=0.05, num_leaves=31, max_depth=6,
        min_child_samples=40, subsample=0.8, subsample_freq=1,
        colsample_bytree=0.7, reg_alpha=0.5, reg_lambda=5.0,
        n_jobs=-1, random_state=7, verbose=-1,
    )
    disp.fit(X_fit, y_fit)
    mu = disp.predict(X_oof)
    resid = y_oof - mu
    in_sample_sigma = float(np.std(disp.predict(X_fit) - y_fit, ddof=1))
    oof_sigma = float(np.std(resid, ddof=1))
    print(f"  [{label}] dispersion model: in-sample σ={in_sample_sigma:.4f} "
          f"vs out-of-fold σ={oof_sigma:.4f} ({oof_sigma / max(in_sample_sigma, 1e-9):.2f}x)")
    return fit_sigma_curve(mu, resid)


def nb_over(mu: float, sigma: float, line: float) -> float:
    """P(X > line) under a Negative Binomial matched to (mu, sigma)."""
    from scipy.stats import nbinom, poisson

    if mu <= 0 or sigma <= 0:
        return 0.0
    var = sigma * sigma
    if var <= mu:
        return float(1.0 - poisson.cdf(int(line), mu))
    r = mu * mu / (var - mu)
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(int(line), r, p))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
CACHE = os.path.join(ROOT, "output", "corners_v6_dataset.npz")


def load_or_build_dataset(data_dir: str, rebuild: bool):
    """Feature building is the slow, pure-Python half of this script (~100s over
    31k matches) and the model fit is the other half. Caching between the two
    makes a retrain resumable and lets each half run inside a single command
    instead of timing out as one long job."""
    if not rebuild and os.path.exists(CACHE):
        z = np.load(CACHE, allow_pickle=True)
        names = list(z["feature_names"])
        globals()["FEATURE_NAMES"] = names
        print(f"[v6] Loaded cached feature matrix from {os.path.relpath(CACHE, ROOT)}")
        return (
            z["X"], z["yh"], z["ya"], list(z["date"]), list(z["league"]),
            float(z["ts_min"]), float(z["ts_max"]),
        )

    print("[v6] Loading match data...")
    matches = load_all_data(data_dir)
    print(f"[v6] {len(matches)} matches, {len(ACTIVE_LEAGUES)} leagues\n")

    print("[v6] Building features (walk-forward Elo, real odds)...")
    valid, rows, yh, ya = build_dataset(matches)
    X = to_matrix(rows)

    # The holdout boundary needs the first holdout match's date, so carry dates.
    dates = np.array([m.date for m in valid], dtype=object)
    leagues = np.array([m.league for m in valid], dtype=object)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    np.savez_compressed(
        CACHE, X=X, yh=yh, ya=ya, date=dates, league=leagues,
        feature_names=np.array(FEATURE_NAMES, dtype=object),
        ts_min=float(valid[0].ts), ts_max=float(valid[-1].ts),
    )
    print(f"[v6] Cached feature matrix → {os.path.relpath(CACHE, ROOT)}")
    return X, yh, ya, list(dates), list(leagues), float(valid[0].ts), float(valid[-1].ts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=DATA_DIR)
    ap.add_argument("--train-frac", type=float, default=0.8)
    ap.add_argument("--rebuild", action="store_true",
                    help="ignore the cached feature matrix and rebuild it")
    args = ap.parse_args()

    X, yh, ya, dates, leagues, _ts0, _ts1 = load_or_build_dataset(args.data_dir, args.rebuild)
    y_total = yh + ya
    print(f"[v6] {X.shape[0]} rows × {X.shape[1]} features\n")

    n = int(X.shape[0])
    cut = int(n * args.train_frac)
    # Carve an early-stopping slice from the end of TRAIN so the holdout is clean.
    val_cut = int(cut * 0.9)

    print(f"[v6] train={val_cut}  early-stop={cut - val_cut}  holdout={n - cut} "
          f"({dates[cut]} → {dates[-1]})\n")

    Xtr, Xval, Xte = X[:val_cut], X[val_cut:cut], X[cut:]
    yh_tr, yh_val, yh_te = yh[:val_cut], yh[val_cut:cut], yh[cut:]
    ya_tr, ya_val, ya_te = ya[:val_cut], ya[val_cut:cut], ya[cut:]
    yt_tr, yt_val, yt_te = y_total[:val_cut], y_total[val_cut:cut], y_total[cut:]

    # ---- Naive baselines, computed from TRAIN ONLY.
    naive_h = float(np.mean(np.abs(np.full_like(yh_te, yh_tr.mean()) - yh_te)))
    naive_a = float(np.mean(np.abs(np.full_like(ya_te, ya_tr.mean()) - ya_te)))
    naive_t = float(np.mean(np.abs(np.full_like(yt_te, yt_tr.mean()) - yt_te)))
    print(f"[v6] Naive (league average) holdout MAE — home {naive_h:.4f} | "
          f"away {naive_a:.4f} | total {naive_t:.4f}\n")

    out = {"version": VERSION, "features": FEATURE_NAMES, "n_features": len(FEATURE_NAMES),
           "n_train": val_cut, "n_holdout": n - cut,
           "holdout_range": f"{dates[cut]} -> {dates[-1]}"}

    preds = {}
    for key, ytr, yval, yte, naive in (
        ("home", yh_tr, yh_val, yh_te, naive_h),
        ("away", ya_tr, ya_val, ya_te, naive_a),
        ("total", yt_tr, yt_val, yt_te, naive_t),
    ):
        print(f"[v6] Training {key.upper()} model...")
        model = fit_with_early_stop(Xtr, ytr, Xval, yval, key)
        pred_te = model.predict(Xte)
        pred_tr = model.predict(Xtr)
        m = metrics(yte, pred_te, key, naive)
        curve_in = fit_sigma_curve(pred_tr, ytr - pred_tr)
        curve_oof = out_of_fold_dispersion(Xtr, ytr, Xval, yval, key)
        m["sigma_curve"] = curve_oof
        m["sigma_curve_in_sample"] = curve_in
        m["model_type"] = "lightgbm"
        out[f"{key}_metrics"] = m
        preds[key] = {"model": model, "pred": pred_te, "train_pred": pred_tr,
                      "curve_in": curve_in}

    ph = preds["home"]["pred"]
    pa = preds["away"]["pred"]
    pt = preds["total"]["pred"]

    # ---- The V5 approach, for an honest before/after on the total.
    print("\n[v6] --- total corners: summed two-model approach (V5) vs direct model ---")
    v5_total_mae = float(np.mean(np.abs(ph + pa - yt_te)))
    direct_total_mae = float(np.mean(np.abs(pt - yt_te)))
    print(f"  V5-style (home + away summed): MAE {v5_total_mae:.4f}")
    print(f"  V6 direct total model:         MAE {direct_total_mae:.4f}")
    print(f"  naive league average:          MAE {naive_t:.4f}")
    out["total_model_comparison"] = {
        "summed_mae": round(v5_total_mae, 4),
        "direct_mae": round(direct_total_mae, 4),
        "naive_mae": round(naive_t, 4),
    }

    # ---- Line-probability calibration on the holdout: in-sample sigma vs the
    #      out-of-fold sigma curve. The lower-error one ships.
    print("\n[v6] --- line probability calibration (claimed vs realized, holdout) ---")
    calib = {}
    for key, mu_pred, actual, lines, label in (
        ("home", ph, yh_te, TEAM_LINES, "team home"),
        ("away", pa, ya_te, TEAM_LINES, "team away"),
        ("total", pt, yt_te, TOTAL_LINES, "match total"),
    ):
        curve = out[f"{key}_metrics"]["sigma_curve"]
        curve_in = preds[key]["curve_in"]
        rows_c = []
        oof_errs, in_errs = [], []
        for line in lines:
            oof_claim = float(np.mean([nb_over(float(mu), sigma_at(float(mu), curve), line) for mu in mu_pred]))
            in_claim = float(np.mean([nb_over(float(mu), sigma_at(float(mu), curve_in), line) for mu in mu_pred]))
            actual_rate = float(np.mean(actual > line))
            oof_errs.append(abs(oof_claim - actual_rate))
            in_errs.append(abs(in_claim - actual_rate))
            rows_c.append({
                "line": line,
                "claimed": round(oof_claim, 4),
                "claimed_in_sample_sigma": round(in_claim, 4),
                "actual": round(actual_rate, 4),
                "error": round(oof_claim - actual_rate, 4),
                "abs_error": round(abs(oof_claim - actual_rate), 4),
                "abs_error_in_sample_sigma": round(abs(in_claim - actual_rate), 4),
            })
        mean_abs = float(np.mean([r["abs_error"] for r in rows_c]))
        max_abs = float(np.max([r["abs_error"] for r in rows_c]))
        calib[key] = {
            "label": label, "lines": rows_c,
            "mean_abs_error": round(mean_abs, 4), "max_abs_error": round(max_abs, 4),
            "mean_abs_error_in_sample_sigma": round(float(np.mean(in_errs)), 4),
            "max_abs_error_in_sample_sigma": round(float(np.max(in_errs)), 4),
            "method": "negative binomial, out-of-fold sigma(mu)",
        }
        print(f"  {label}: out-of-fold σ mean |err| {mean_abs:.4f} (max {max_abs:.4f})  "
              f"vs in-sample σ {np.mean(in_errs):.4f} (max {np.max(in_errs):.4f})")
        for r in rows_c:
            print(f"     over {r['line']:>5}: oofσ {r['claimed']:.3f}  inσ {r['claimed_in_sample_sigma']:.3f}  "
                  f"actual {r['actual']:.3f}  Δ {r['error']:+.3f}")
    out["line_calibration"] = calib

    # ---- Residual correlation between home and away (documented, not assumed).
    rh, ra = yh_te - ph, ya_te - pa
    out["residuals"] = {
        "home_away_corr": round(float(np.corrcoef(rh, ra)[0, 1]), 4),
        "cov_home_away": round(float(np.cov(rh, ra, ddof=1)[0, 1]), 4),
        "var_home": round(float(np.var(rh, ddof=1)), 4),
        "var_away": round(float(np.var(ra, ddof=1)), 4),
        "var_total_actual": round(float(np.var(yh_te + ya_te - ph - pa, ddof=1)), 4),
        "var_total_if_independent": round(float(np.var(rh, ddof=1) + np.var(ra, ddof=1)), 4),
    }

    # ---- Persist
    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)
    from joblib import dump

    dump(preds["home"]["model"], os.path.join(ROOT, "models", "corners_home_model.joblib"))
    dump(preds["away"]["model"], os.path.join(ROOT, "models", "corners_away_model.joblib"))
    dump(preds["total"]["model"], os.path.join(ROOT, "models", "corners_total_model.joblib"))

    out["line_method"] = "negative binomial with out-of-fold sigma(mu) = a*sqrt(mu)+b"
    out["market"] = "corners"
    out["source"] = "football-data.co.uk 11 leagues 2012-2026"
    out["leagues"] = ACTIVE_LEAGUES
    out["team_lines"] = TEAM_LINES
    out["total_lines"] = TOTAL_LINES
    out["neutral_odds"] = NEUTRAL_ODDS
    out["odds_features"] = ODDS_FEATURES
    out["feature_importance"] = {
        k: dict(sorted(
            zip(FEATURE_NAMES, [round(float(x), 2) for x in preds[k]["model"].feature_importances_]),
            key=lambda kv: kv[1], reverse=True)[:25])
        for k in preds
    }

    meta_path = os.path.join(ROOT, "models", "corners_meta.json")
    with open(meta_path, "w") as f:
        json.dump(out, f, indent=2)
    with open(os.path.join(ROOT, "output", "corners_backtest.json"), "w") as f:
        json.dump(out, f, indent=2)

    print(f"\n[v6] Saved {VERSION} → models/corners_meta.json (+3 joblib models)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
