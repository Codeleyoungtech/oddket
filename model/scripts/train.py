#!/usr/bin/env python3
"""Train the match-result model (home/draw/away) and calibrate it.

Usage:
    python3 scripts/train.py --source synthetic [--n 900] [--seed 20260813]
    python3 scripts/train.py --source historical --data ../data/historical.json

Outputs:
    model/models/h2h_model.joblib     — trained classifier
    model/models/h2h_calibrator.joblib — isotonic calibration on holdout
    model/output/calibration.json      — Brier + per-bin stats for the dashboard
    model/models/model_meta.json       — version string + feature list
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import numpy as np  # noqa: E402
from sklearn.calibration import IsotonicRegression  # noqa: E402
from sklearn.model_selection import train_test_split  # noqa: E402

from synth_data import generate_synthetic  # noqa: E402

FEATURES = ["home_strength", "away_strength", "home_adv", "form_diff", "exp_home", "exp_away"]

MODEL_VERSION_TAG = "h2h-xgb-v1"
FALLBACK_TAG = "h2h-gbc-v1"


def load_clf() -> tuple:
    """Prefer XGBoost, fall back to sklearn GradientBoosting. Same API."""
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=300,
            max_depth=4,
            learning_rate=0.06,
            subsample=0.85,
            colsample_bytree=0.85,
            eval_metric="mlogloss",
            n_jobs=-1,
            random_state=42,
        ), MODEL_VERSION_TAG
    except ImportError:
        print("[train] xgboost unavailable — falling back to sklearn GradientBoostingClassifier")
        from sklearn.ensemble import GradientBoostingClassifier

        return GradientBoostingClassifier(
            n_estimators=300, max_depth=3, learning_rate=0.06, subsample=0.85, random_state=42
        ), FALLBACK_TAG


def multiclass_brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    """Brier score for a K-class problem: mean squared error vs one-hot targets."""
    n = len(y_true)
    k = proba.shape[1]
    y_onehot = np.zeros((n, k))
    y_onehot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((proba - y_onehot) ** 2, axis=1)))


def build_matrix(matches, outcomes: bool = True):
    X = np.array([[m.features[f] for f in FEATURES] for m in matches], dtype=float)
    if not outcomes:
        return X
    y = np.array([m.outcome for m in matches], dtype=int)
    return X, y


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["synthetic", "historical"], default="synthetic")
    ap.add_argument("--n", type=int, default=900)
    ap.add_argument("--seed", type=int, default=20260813)
    ap.add_argument("--data", default=None, help="path to historical JSON for --source historical")
    args = ap.parse_args()

    if args.source == "synthetic":
        ds = generate_synthetic(n_matches=args.n, seed=args.seed)
        matches = ds.matches
    else:
        from synth_data import load_synthetic

        path = args.data or os.path.join(ROOT, "data", "historical.json")
        if not os.path.exists(path):
            print(f"[train] historical data not found at {path} — run fetch_historical.py first", file=sys.stderr)
            return 1
        ds = load_synthetic(path)
        matches = ds.matches

    if len(matches) < 100:
        print(f"[train] only {len(matches)} matches — need at least 100 for a meaningful model", file=sys.stderr)
        return 1

    X, y = build_matrix(matches)
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, random_state=args.seed, stratify=y)

    clf, version = load_clf()
    clf.fit(X_tr, y_tr)
    print(f"[train] fitted {version} on {len(X_tr)} rows (holdout {len(X_te)})")

    # Raw probabilities on holdout
    proba = clf.predict_proba(X_te)

    # Isotonic calibration per class (home / draw / away), fit on holdout
    calibrators = {}
    for cls_idx, label in enumerate(["home", "draw", "away"]):
        iso = IsotonicRegression(out_of_bounds="clip")
        iso.fit(proba[:, cls_idx], (y_te == cls_idx).astype(int))
        calibrators[label] = iso
    proba_cal = np.column_stack([calibrators["home"].predict(proba[:, 0]),
                                 calibrators["draw"].predict(proba[:, 1]),
                                 calibrators["away"].predict(proba[:, 2])])
    # Renormalize (isotonic is per-class, sums may drift from 1)
    proba_cal = proba_cal / proba_cal.sum(axis=1, keepdims=True)

    # Evaluate (multiclass Brier — sklearn's brier_score_loss is binary-only)
    raw_brier = multiclass_brier(y_te, proba)
    cal_brier = multiclass_brier(y_te, proba_cal)
    acc = float((proba_cal.argmax(axis=1) == y_te).mean())

    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump  # noqa: E402

    dump(clf, os.path.join(ROOT, "models", "h2h_model.joblib"))
    dump(calibrators, os.path.join(ROOT, "models", "h2h_calibrator.joblib"))

    meta = {
        "version": version,
        "source": args.source,
        "n_train": int(len(X_tr)),
        "n_test": int(len(X_te)),
        "accuracy": round(acc, 4),
        "brier_raw": round(float(raw_brier), 4),
        "brier_calibrated": round(float(cal_brier), 4),
        "features": FEATURES,
        "classes": ["home", "draw", "away"],
        "seed": args.seed,
    }
    with open(os.path.join(ROOT, "models", "model_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    # Calibration bins for the dashboard (holdout, calibrated probabilities)
    bins = []
    for i in range(10):
        lo, hi = i / 10.0, (i + 1) / 10.0
        mask = (proba_cal[:, 1] >= lo) & (proba_cal[:, 1] < hi)
        n = int(mask.sum())
        bins.append({
            "bin": round(lo + 0.05, 2),
            "count": n,
            "predicted": round(float(proba_cal[mask, 1].mean()), 4) if n else 0.0,
            "actual": round(float((y_te[mask] == 1).mean()), 4) if n else 0.0,
        })
    cal_out = {
        "model_version": version,
        "sample_size": int(len(y_te)),
        "brier": round(float(cal_brier), 4),
        "bins": bins,
    }
    with open(os.path.join(ROOT, "output", "calibration.json"), "w") as fh:
        json.dump(cal_out, fh, indent=2)

    print(f"[train] accuracy {acc:.3f} | brier raw {raw_brier:.4f} -> calibrated {cal_brier:.4f}")
    print(f"[train] wrote models/h2h_model.joblib, models/h2h_calibrator.joblib, output/calibration.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
