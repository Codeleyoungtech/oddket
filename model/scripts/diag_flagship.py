"""Fast band-sweep + significance analysis on the saved model.

Loads the trained model + calibrator (deterministic, same seed/data as
train.py), recomputes holdout probabilities ONCE, then sweeps odds bands and
bootstraps the per-bet profit distribution for honest confidence intervals.

Usage: .venv/bin/python scripts/diag_flagship.py [max_odds...]
"""
import json
import os
import sys
import numpy as np
from joblib import load

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from features import load_matches_dict  # noqa: E402
from train import fill_market_features, simulate_staking  # noqa: E402

meta = json.load(open(os.path.join(ROOT, "models", "model_meta.json")))
features = meta["features"]

matches = load_matches_dict(os.path.join(ROOT, "data", "historical.json"))
fill_market_features(matches)
matches.sort(key=lambda m: m.ts)
n = len(matches)
cut = int(n * 0.8)
train_m, test_m = matches[:cut], matches[cut:]

X_tr = np.array([[m.features[f] for f in features] for m in train_m], dtype=float)
y_tr = np.array([m.outcome for m in train_m], dtype=int)
X_te = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)

cccv = load(os.path.join(ROOT, "models", "h2h_calibrator.joblib"))
proba = cccv.predict_proba(X_te)
print(f"holdout: {len(test_m)} matches ({test_m[0].date} -> {test_m[-1].date}), "
      f"features={len(features)}, model={meta['version']}\n")

bands = [float(x) for x in sys.argv[1:]] or [0.0, 1.6, 1.8, 2.0, 2.5, 3.0]
for b in bands:
    res = simulate_staking(test_m, proba, max_odds=b)
    bets = res["bets"]
    profits = np.array([bt["profit"] for bt in bets], dtype=float)
    stakes = np.array([bt["stake"] for bt in bets], dtype=float)
    # bootstrap 95% CI on ROI (resample bets with replacement)
    rng = np.random.default_rng(42)
    rois = []
    for _ in range(2000):
        idx = rng.integers(0, len(profits), size=len(profits))
        rois.append(profits[idx].sum() / stakes[idx].sum())
    rois = np.array(rois)
    lo, hi = np.percentile(rois, [2.5, 97.5])
    print(f"max_odds={b:>4}: bets={res['nBets']:>5}  win={res['winRate']:.1%}  "
          f"ROI={res['roiPct']:>7.2f}%  [95% CI {lo*100:+.2f}% .. {hi*100:+.2f}%]  "
          f"CLV={res['avgClvPct']:+.2f}%  maxDD={res['maxDrawdown']:,.0f}")
