#!/usr/bin/env python3
"""Train the micro-markets models (Over 1.5 goals, Team To Score) on REAL data.

Three binary models, same feature pipeline as the totals (ou) model:
  - ou15        : P(total goals > 1.5)
  - team_home   : P(home team scores >= 1)
  - team_away   : P(away team scores >= 1)

Same honest discipline as every other model in this repo:
  - TIME-ORDERED split (oldest 80% train, newest 20% holdout)
  - Calibration fit on TRAIN via internal CV, applied to holdout (no leakage)
  - Backtest reports hit rate at the 70% confidence threshold (the "sure bet"
    gate this market family exists for), plus Brier and overall hit rate.

Outputs (per market):
    model/models/{market}_model.joblib, {market}_calibrator.joblib
    model/models/micro_meta.json — metrics + feature list

Usage:
    .venv/bin/python scripts/train_micro.py            # all three markets
    .venv/bin/python scripts/train_micro.py --market ou15
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import math  # noqa: E402

import numpy as np  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV  # noqa: E402

from features import (  # noqa: E402
    FEATURE_GROUPS,
    load_matches_dict,
)

MICRO_VERSION_TAG = "micro-xgb-v1"
MICRO_FALLBACK_TAG = "micro-gbc-v1"

# Feature groups shared with the totals (ou) model. `ou_goals` carries the
# goal-VOLUME rates (how often each team scores / concedes, combined average,
# Poisson expected total) — the single most relevant signal for "does this
# team score at least once", which the v1 feature set did not include.
GROUPS = ["base", "ou_goals", "ou_odds", "ew_form", "rest"]

MARKETS = {
    "ou15": {
        "target": lambda m: 1 if m.home_goals + m.away_goals > 1.5 else 0,
        "classes": ["under", "over"],
        "settle": lambda m, sel: (m.home_goals + m.away_goals > 1.5) == (sel == "over"),
        "line_label": "Over 1.5 goals",
    },
    "team_home": {
        "target": lambda m: 1 if m.home_goals > 0 else 0,
        "classes": ["no", "yes"],
        "settle": lambda m, sel: (m.home_goals > 0) == (sel == "yes"),
        "line_label": "Home team to score (O0.5)",
    },
    "team_away": {
        "target": lambda m: 1 if m.away_goals > 0 else 0,
        "classes": ["no", "yes"],
        "settle": lambda m, sel: (m.away_goals > 0) == (sel == "yes"),
        "line_label": "Away team to score (O0.5)",
    },
}


def load_clf() -> tuple:
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05,
            subsample=0.85, colsample_bytree=0.85,
            eval_metric="logloss", n_jobs=-1, random_state=42,
        ), MICRO_VERSION_TAG
    except ImportError:
        print("[train] xgboost unavailable — falling back to sklearn GradientBoostingClassifier")
        from sklearn.ensemble import GradientBoostingClassifier

        return GradientBoostingClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.85, random_state=42
        ), MICRO_FALLBACK_TAG


def brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    return float(np.mean((proba[:, 1] - y_true) ** 2))


def fill_ou_features(matches: list) -> None:
    """Populate the odd_over / odd_under features from the totals market,
    exactly like train.py does for the ou model (same features at predict)."""
    for m in matches:
        mk = m.market or {}
        ou = mk.get("ou") or {}
        inv_all = []
        for sel in ("over", "under"):
            o = (ou.get(sel) or {}).get("best") or (ou.get(sel) or {}).get("open")
            if o and o > 1.0:
                inv_all.append(1.0 / o)
            else:
                inv_all.append(None)
        valid = [x for x in inv_all if x is not None]
        if len(valid) == 2:
            s = sum(valid)
            impl = {k: v / s for k, v in zip(("over", "under"), valid)}
            m.features["odd_over"] = round(float(np.log(max(1e-6, min(1 - 1e-6, impl["over"])))), 4)
            m.features["odd_under"] = round(float(np.log(max(1e-6, min(1 - 1e-6, impl["under"])))), 4)
        else:
            m.features["odd_over"] = 0.0
            m.features["odd_under"] = 0.0


def reliability_table(p_pos: np.ndarray, y: np.ndarray, width: float = 0.1) -> list:
    """Out-of-sample reliability per 0.1-wide probability band.

    For each band: the holdout sample size, the OBSERVED outcome rate, and a
    Wilson 95% interval around it. The predictor ships these bands so the
    confidence interval shown in the app is the model's measured out-of-sample
    uncertainty rather than an invented width (the old band was
    +/- (0.08 + 0.25*|p-0.5|), which stretched 67%-99% at p=0.83).
    """
    z = 1.959963984540054
    n_bands = int(round(1.0 / width))
    bands = []
    for i in range(n_bands):
        lo, hi = i * width, (i + 1) * width
        if i < n_bands - 1:
            mask = (p_pos >= lo) & (p_pos < hi)
        else:
            mask = (p_pos >= lo) & (p_pos <= hi)
        n = int(mask.sum())
        if n == 0:
            bands.append({"lo": round(lo, 2), "hi": round(hi, 2), "n": 0, "observed": None, "low": None, "high": None})
            continue
        r = float(y[mask].mean())
        denom = 1 + (z * z) / n
        center = (r + (z * z) / (2 * n)) / denom
        half = z * math.sqrt(r * (1 - r) / n + (z * z) / (4 * n * n)) / denom
        bands.append({
            "lo": round(lo, 2),
            "hi": round(hi, 2),
            "n": n,
            "observed": round(r, 4),
            "low": round(max(0.0, center - half), 4),
            "high": round(min(1.0, center + half), 4),
        })
    return bands


def hit_rate_at_threshold(proba_pos: np.ndarray, y: np.ndarray, thresholds=(0.65, 0.70, 0.75, 0.80)) -> dict:
    out = {}
    for t in thresholds:
        mask = proba_pos >= t
        n = int(mask.sum())
        out[f"p>={t:.2f}"] = {
            "n": n,
            "hitRate": round(float(y[mask].mean()), 4) if n else 0.0,
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=list(MARKETS.keys()), default=None, help="train one market (default: all)")
    ap.add_argument("--data", default=None, help="historical.json path")
    ap.add_argument("--seed", type=int, default=20260813)
    args = ap.parse_args()

    markets = [args.market] if args.market else list(MARKETS.keys())

    path = args.data or os.path.join(ROOT, "data", "historical.json")
    if not os.path.exists(path):
        print(f"[train] data not found at {path} — run fetch_historical.py first", file=sys.stderr)
        return 1
    matches = load_matches_dict(path)
    if len(matches) < 200:
        print(f"[train] only {len(matches)} matches — need at least 200", file=sys.stderr)
        return 1

    fill_ou_features(matches)
    matches.sort(key=lambda m: m.ts)
    n = len(matches)
    cut = int(n * 0.8)
    train_m, test_m = matches[:cut], matches[cut:]

    features = [f for g in GROUPS for f in FEATURE_GROUPS[g]]
    missing = [f for f in features if f not in train_m[0].features]
    if missing:
        print(f"[train] features missing from dataset: {missing[:10]}", file=sys.stderr)
        return 1

    print(f"[train] {len(train_m)} train / {len(test_m)} holdout ({test_m[0].date} -> {test_m[-1].date}) | features={len(features)}")

    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    from joblib import dump  # noqa: E402

    meta = {
        "version": MICRO_VERSION_TAG,
        "source": "football-data.co.uk EPL/Bundesliga/LaLiga/SerieA 2019-2026 (historical.json)",
        "feature_groups": GROUPS,
        "features": features,
        "n_train": len(train_m),
        "n_test": len(test_m),
        "holdout_range": f"{test_m[0].date} -> {test_m[-1].date}",
        "markets": {},
    }

    X_tr = np.array([[m.features[f] for f in features] for m in train_m], dtype=float)
    X_te = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)

    for market in markets:
        cfg = MARKETS[market]
        y_tr = np.array([cfg["target"](m) for m in train_m], dtype=int)
        y_te = np.array([cfg["target"](m) for m in test_m], dtype=int)

        clf, version = load_clf()
        clf.fit(X_tr, y_tr)
        calibrator = CalibratedClassifierCV(clf, method="isotonic", cv=5)
        calibrator.fit(X_tr, y_tr)
        proba = calibrator.predict_proba(X_te)
        pos_idx = 1  # classes are [under/no, over/yes]
        p_pos = proba[:, pos_idx]
        brier_raw = brier(y_te, clf.predict_proba(X_te))
        brier_cal = brier(y_te, proba)
        overall_hit = float((p_pos >= 0.5).mean()) if len(y_te) else 0.0
        overall_win = float(np.mean((p_pos >= 0.5) == (y_te == 1))) if len(y_te) else 0.0

        # "Sure bet" backtest: how often do picks at each confidence threshold
        # actually land? This is the 70% gate the micro markets exist for.
        thresholds = hit_rate_at_threshold(p_pos, y_te)
        overall_rate = float(y_te.mean())  # base rate of the market

        reliability = reliability_table(p_pos, y_te)

        # ROI-style backtest with a FIXED fair price (1.0/implied) is meaningless
        # without a real book line — the user compares against their bookmaker
        # manually. Report hit rate + calibration instead (honest).

        dump(clf, os.path.join(ROOT, "models", f"{market}_model.joblib"))
        dump(calibrator, os.path.join(ROOT, "models", f"{market}_calibrator.joblib"))

        meta["markets"][market] = {
            "version": version,
            "label": cfg["line_label"],
            "classes": cfg["classes"],
            "baseRate": round(overall_rate, 4),
            "brier_raw": round(brier_raw, 4),
            "brier_calibrated": round(brier_cal, 4),
            "overall_positive_rate": round(overall_hit, 4),
            "overall_accuracy_at_0.5": round(overall_win, 4),
            "hit_rate_at_threshold": thresholds,
            "reliability": reliability,
            "n_holdout": int(len(y_te)),
            "seed": args.seed,
        }

        print(f"[train] {market}: base {overall_rate:.3f} | brier {brier_cal:.4f} | "
              f"acc@0.5 {overall_win:.4f} | "
              f"p>=0.70 n={thresholds['p>=0.70']['n']} hit={thresholds['p>=0.70']['hitRate']:.4f}")

    with open(os.path.join(ROOT, "models", "micro_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"[train] wrote models/*_model.joblib + micro_meta.json ({len(markets)} markets)")
    return 0


if __name__ == "__main__":
    sys.exit(main())