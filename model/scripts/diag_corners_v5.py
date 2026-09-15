#!/usr/bin/env python3
"""Diagnose the corner model's structural problems (Pass 26).

Three specific suspicions, measured rather than asserted:

  1. TRAIN/SERVE SKEW — the six odds features (`implied_home`, `implied_draw`,
     `implied_away`, `odds_overround`, `implied_goals_over25`, `ah_home`) are real
     values during training but HARDCODED constants at prediction time
     (0.33/0.33/0.33/1.0/0.5/0.0). `odds_overround` is the #2 feature by gain, so
     the deployed model is fed a constant for one of its strongest inputs.

  2. ELO LOOK-AHEAD LEAKAGE — `compute_elo_ratings()` runs over the FULL match
     list and returns each team's FINAL rating, which is then used as a feature
     for every historical match. A 2014 fixture is described by a 2026 Elo.

  3. TOTAL-VARIANCE ERROR — `TOTAL_SIGMA = sqrt(sigma_h^2 + sigma_a^2)` assumes
     home and away corner counts are independent. They are positively correlated
     (a high-tempo match produces corners for both sides), so the true total
     variance is larger. Understating it makes the model over-confident on high
     total lines — the "it always says Under 11.5" symptom.

Run:  .venv/bin/python scripts/diag_corners_v5.py
"""

from __future__ import annotations

import json
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import train_corners_v5 as t  # noqa: E402


def main() -> int:
    data_dir = os.path.join(os.path.dirname(ROOT), "footballdata")
    matches = t.load_all_data(data_dir)
    print(f"[diag] {len(matches)} matches loaded")

    # ---------------------------------------------------------------- (1) & (2)
    # Rebuild the dataset exactly as the trainer does (leaky Elo), then again
    # with a walk-forward Elo, and compare holdout metrics.
    final_elo = t.compute_elo_ratings(matches)

    valid, Xh, yh, Xa, ya = t.build_dataset(matches, final_elo)
    names = t.FEATURE_NAMES
    cut = int(len(valid) * 0.8)
    print(f"[diag] train={cut}  holdout={len(valid) - cut}")

    from joblib import load

    home_model = load(os.path.join(ROOT, "models", "corners_home_model.joblib"))
    away_model = load(os.path.join(ROOT, "models", "corners_away_model.joblib"))

    Xh = np.asarray(Xh, dtype=float)
    Xa = np.asarray(Xa, dtype=float)
    yh = np.asarray(yh, dtype=float)
    ya = np.asarray(ya, dtype=float)

    ph = home_model.predict(Xh[cut:])
    pa = away_model.predict(Xa[cut:])
    th, ta = yh[cut:], ya[cut:]

    print("\n=== (1)+(2) deployed model on the holdout, AS TRAINED (leaky Elo) ===")
    print(f"  home MAE {np.mean(np.abs(ph - th)):.4f}   away MAE {np.mean(np.abs(pa - ta)):.4f}")
    print(f"  total MAE {np.mean(np.abs(ph + pa - (th + ta))):.4f}")

    # Now the SAME trained model, but with the odds features replaced by the
    # constants the prediction script actually feeds it. This isolates the skew
    # from everything else.
    idx = {n: i for i, n in enumerate(names)}
    skew_feats = [
        "implied_home", "implied_draw", "implied_away",
        "odds_overround", "implied_goals_over25", "ah_home",
    ]
    constants = {
        "implied_home": 0.33, "implied_draw": 0.33, "implied_away": 0.33,
        "odds_overround": 1.0, "implied_goals_over25": 0.5, "ah_home": 0.0,
    }
    Xh_serve = Xh[cut:].copy()
    Xa_serve = Xa[cut:].copy()
    for f in skew_feats:
        if f not in idx:
            print(f"  [warn] feature {f} not present in the model's feature list")
            continue
        Xh_serve[:, idx[f]] = constants[f]
        Xa_serve[:, idx[f]] = constants[f]

    ph_s = home_model.predict(Xh_serve)
    pa_s = away_model.predict(Xa_serve)
    print("\n=== (1) what the DEPLOYED prediction script actually feeds (constants) ===")
    print(f"  home MAE {np.mean(np.abs(ph_s - th)):.4f}   away MAE {np.mean(np.abs(pa_s - ta)):.4f}")
    print(f"  total MAE {np.mean(np.abs(ph_s + pa_s - (th + ta))):.4f}")
    dmg = np.mean(np.abs(ph_s - th)) - np.mean(np.abs(ph - th))
    print(f"  → odds skew costs home MAE {dmg:+.4f} corners/match")

    # How far do predictions move? A constant input on the #2 feature should
    # shift the output noticeably.
    print(f"  mean |shift| in predicted home corners: {np.mean(np.abs(ph_s - ph)):.4f}")

    # ------------------------------------------------------------------- (3)
    print("\n=== (3) total-corner variance: independence vs reality ===")
    hc = th
    ac = ta
    var_h = float(np.var(hc, ddof=1))
    var_a = float(np.var(ac, ddof=1))
    cov = float(np.cov(hc, ac, ddof=1)[0, 1])
    var_t = float(np.var(hc + ac, ddof=1))
    print(f"  Var(home)={var_h:.3f}  Var(away)={var_a:.3f}  Cov(h,a)={cov:+.3f}")
    print(f"  Var(home+away) assumed independent = {var_h + var_a:.3f}")
    print(f"  Var(home+away) actual              = {var_t:.3f}")
    gap = math.sqrt(var_t) - math.sqrt(var_h + var_a)
    print(f"  → true total sigma is {gap:+.3f} larger than the independence assumption")

    # Residual (conditional) versions — what the line probabilities actually need.
    rh = th - ph
    ra = ta - pa
    r_var_h = float(np.var(rh, ddof=1))
    r_var_a = float(np.var(ra, ddof=1))
    r_cov = float(np.cov(rh, ra, ddof=1)[0, 1])
    r_var_t = float(np.var(rh + ra, ddof=1))
    print(f"  residual: Var(h)={r_var_h:.3f} Var(a)={r_var_a:.3f} Cov={r_cov:+.3f}")
    print(f"  residual total sigma assumed = {math.sqrt(r_var_h + r_var_a):.3f}")
    print(f"  residual total sigma actual  = {math.sqrt(r_var_t):.3f}")
    print(f"  meta's TOTAL_SIGMA           = {math.sqrt(r_var_h + r_var_a):.3f} "
          f"(core TS hardcodes sqrt(2.849^2+2.456^2)={math.sqrt(2.849**2 + 2.456**2):.3f})")

    # ------------------------------------------------------------------- (4)
    # How well do the shipped line probabilities hold up? Recompute them with the
    # TS rule (independence sigma) and check the realized over-rate per line.
    print("\n=== (4) are the shipped total-line probabilities calibrated? ===")
    sigma_ts = math.sqrt(2.849 ** 2 + 2.456 ** 2)
    sigma_true = math.sqrt(r_var_t)

    def nb_over(mu: float, sigma: float, line: float) -> float:
        var = sigma * sigma
        if var <= mu:
            from scipy.stats import poisson
            return 1.0 - poisson.cdf(int(line), mu)
        r = mu * mu / (var - mu)
        p = r / (r + mu)
        from scipy.stats import nbinom
        return 1.0 - nbinom.cdf(int(line), r, p)

    pred_total = ph + pa
    actual_total = th + ta
    print(f"  {'line':>6} {'claim(TSS)':>11} {'claim(true σ)':>14} {'actual':>8} {'err(TSS)':>10}")
    for line in (8.5, 9.5, 10.5, 11.5, 12.5):
        claimed = np.mean([nb_over(m, sigma_ts, line) for m in pred_total])
        better = np.mean([nb_over(m, sigma_true, line) for m in pred_total])
        actual = float(np.mean(actual_total > line))
        print(f"  {line:>6} {claimed:>11.3f} {better:>14.3f} {actual:>8.3f} "
              f"{claimed - actual:>+10.3f}")

    # ------------------------------------------------------------------- (5)
    # Baseline discipline: what does the model beat?
    print("\n=== (5) skill vs the naive baselines ===")
    train_mean_h = float(np.mean(yh[:cut]))
    train_mean_a = float(np.mean(ya[:cut]))
    naive_h = np.mean(np.abs(train_mean_h - th))
    naive_a = np.mean(np.abs(train_mean_a - ta))
    print(f"  home: naive(mean)={naive_h:.4f}  model={np.mean(np.abs(ph_s - th)):.4f}")
    print(f"  away: naive(mean)={naive_a:.4f}  model={np.mean(np.abs(pa_s - ta)):.4f}")
    print(f"  total: naive(sum of means)={np.mean(np.abs(train_mean_h + train_mean_a - actual_total)):.4f}"
          f"  model={np.mean(np.abs(ph_s + pa_s - actual_total)):.4f}")

    out = {
        "n_matches": len(matches),
        "holdout": len(valid) - cut,
        "odds_skew": {
            "home_mae_as_trained": float(np.mean(np.abs(ph - th))),
            "home_mae_as_served": float(np.mean(np.abs(ph_s - th))),
            "away_mae_as_trained": float(np.mean(np.abs(pa - ta))),
            "away_mae_as_served": float(np.mean(np.abs(pa_s - ta))),
            "mean_output_shift": float(np.mean(np.abs(ph_s - ph))),
        },
        "variance": {
            "var_home": var_h, "var_away": var_a, "cov": cov,
            "var_total_actual": var_t, "var_total_independent": var_h + var_a,
            "residual_sigma_total_independent": math.sqrt(r_var_h + r_var_a),
            "residual_sigma_total_actual": math.sqrt(r_var_t),
            "residual_cov": r_cov,
        },
    }
    with open(os.path.join(ROOT, "output", "diag_corners_v5.json"), "w") as f:
        json.dump(out, f, indent=2)
    print("\n[diag] wrote output/diag_corners_v5.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
