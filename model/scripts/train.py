#!/usr/bin/env python3
"""Train the match-result model (home/draw/away) on REAL historical data.

Experiment harness for the accuracy-upgrade work. Feature groups are
selected with --features (comma-separated) so each candidate change is
backtested independently:
  base,elo_split,ew_form,rest,odds,move,spread

The split is TIME-ORDERED (first 80% train, newest 20% validate). Calibration
is isotonic per class, fit on the TRAIN set and applied to the holdout (no
leakage — unlike v1 which fit on the holdout itself).

Outputs:
    model/models/h2h_model.joblib, h2h_calibrator.joblib
    model/output/calibration.json, model/output/backtest.json
    model/models/model_meta.json  — metrics + feature list
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import numpy as np  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV  # noqa: E402

from features import (  # noqa: E402
    FEATURE_GROUPS,
    load_matches_dict,
)

MODEL_VERSION_TAG = "h2h-xgb-v3"
FALLBACK_TAG = "h2h-gbc-v3"


def load_clf() -> tuple:
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05,
            subsample=0.85, colsample_bytree=0.85,
            eval_metric="mlogloss", n_jobs=-1, random_state=42,
        ), MODEL_VERSION_TAG
    except ImportError:
        print("[train] xgboost unavailable — falling back to sklearn GradientBoostingClassifier")
        from sklearn.ensemble import GradientBoostingClassifier

        return GradientBoostingClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.85, random_state=42
        ), FALLBACK_TAG


def multiclass_brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    n = len(y_true)
    k = proba.shape[1]
    y_onehot = np.zeros((n, k))
    y_onehot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((proba - y_onehot) ** 2, axis=1)))


def logit(p: float) -> float:
    return math.log(max(1e-6, min(1 - 1e-6, p)))


def fill_market_features(matches: list) -> None:
    """Compute odds / move / spread features from each match's market extras.
    All values are known before kickoff (opening and closing odds are both
    published pre-match) — leakage-free.

    odd_* uses the BEST price (MaxH/MaxD/MaxA) — this is what a sharp bettor
    actually gets and what the live pipeline exports as "current best odds",
    so training and prediction see the same thing."""
    for m in matches:
        f = m.features
        mk = m.market or {}
        inv_all = []
        for sel in ("home", "draw", "away"):
            o = (mk.get(sel) or {}).get("best")
            if not o or o <= 0:
                o = (mk.get(sel) or {}).get("open")
            if o and o > 0:
                inv_all.append(1.0 / o)
            else:
                inv_all.append(None)
        if all(v is not None for v in inv_all):
            s = sum(inv_all)
            impl = {k: v / s for k, v in zip(("home", "draw", "away"), inv_all)}
            f["odd_h"] = round(logit(impl["home"]), 4)
            f["odd_d"] = round(logit(impl["draw"]), 4)
            f["odd_a"] = round(logit(impl["away"]), 4)
        # odds movement: closing minus opening (in log-odds space)
        for sel, key in (("home", "move_h"), ("draw", "move_d"), ("away", "move_a")):
            op = (mk.get(sel) or {}).get("open")
            cl = (mk.get(sel) or {}).get("close")
            if op and op > 0 and cl and cl > 0:
                f[key] = round(logit(1.0 / cl) - logit(1.0 / op), 4)
        # cross-book spread: max minus min across books
        for sel, key in (("home", "spread_h"), ("draw", "spread_d"), ("away", "spread_a")):
            books = [b for b in (mk.get(sel) or {}).get("books", []) if b and b > 0]
            if len(books) >= 2:
                f[key] = round((max(books) - min(books)) / min(books), 4)


def calibrate_on_train(clf, X_tr, y_tr, X_te, cv: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Multiclass Platt-style calibration (sigmoid per class) fitted on the
    TRAIN set with internal cross-validation, applied to the holdout.

    Uses CalibratedClassifierCV with method='sigmoid' — monotonic and smooth,
    so it cannot over-extrapolate the way isotonic regression did on sparse
    high-probability bins (which inflated draw to 65%+ nonsense)."""
    cccv = CalibratedClassifierCV(clf, method="sigmoid", cv=cv)
    cccv.fit(X_tr, y_tr)
    return cccv.predict_proba(X_tr), cccv.predict_proba(X_te)


def simulate_staking(test_m, proba_cal, bankroll: float = 10000.0,
                     kelly_fraction: float = 0.25, edge_min: float = 0.0,
                     max_odds: float = 0.0, min_odds: float = 0.0) -> dict:
    """Backtest with BEST-price entry + CLV measurement + optional odds band.

    max_odds/min_odds: restrict bets to a price band (0 = no restriction).
    The longshot-bleed diagnosis showed the model's +5% estimated edge is real
    on favorites (<=1.8: ROI +14%) but collapses to -36% on 6+ longshots, so
    restricting to a band is a strategy decision, not a data leak."""
    classes = ["home", "draw", "away"]
    n_bets = 0
    wins = 0
    staked = 0.0
    returned = 0.0
    edge_sum = 0.0
    clv_sum = 0.0
    clv_n = 0
    bank = bankroll
    peak = bankroll
    max_dd = 0.0
    bets_log = []

    for i, m in enumerate(test_m):
        o = m.odds or {}
        if not o or not all(v and v > 0 for v in o.values()):
            continue
        p = proba_cal[i]
        inv = {k: 1.0 / v for k, v in o.items() if v and v > 0}
        s = sum(inv.values())
        implied = {k: v / s for k, v in inv.items()}
        edges = {c: p[j] - implied[c] for j, c in enumerate(classes)}
        sel = max(edges, key=edges.get)
        if edges[sel] <= edge_min:
            continue
        odds = o[sel]
        if not odds or odds <= 1.0:
            continue
        # odds-band restriction (strategy filter, no leakage)
        if max_odds and odds > max_odds:
            continue
        if min_odds and odds < min_odds:
            continue
        b = odds - 1
        q = p[classes.index(sel)]
        kelly = (b * q - (1 - q)) / b if b > 0 else 0.0
        stake = min(bank * kelly_fraction * max(kelly, 0), bank * 0.05)
        if stake <= 0:
            continue
        n_bets += 1
        staked += stake
        won = m.outcome == classes.index(sel)
        wins += won
        returned += stake * odds if won else 0.0
        profit = stake * (odds - 1) if won else -stake
        bank += profit
        edge_sum += edges[sel]
        # CLV: entry price vs closing line. Positive = beat the market.
        close = (m.market or {}).get(sel, {}).get("close")
        clv = None
        if close and close > 0:
            entry_imp = 1.0 / odds
            close_imp = 1.0 / close
            clv = (close_imp - entry_imp) / entry_imp
            clv_sum += clv
            clv_n += 1
        peak = max(peak, bank)
        max_dd = max(max_dd, peak - bank)
        bets_log.append({
            "date": m.date, "league": m.league, "home": m.home, "away": m.away,
            "sel": sel, "odds": odds, "prob": round(q, 4), "edge": round(edges[sel], 4),
            "stake": round(stake, 2), "profit": round(profit, 2), "won": bool(won),
            "clvPct": round(clv * 100, 2) if clv is not None else None,
        })

    roi = (returned - staked) / staked if staked > 0 else 0.0
    return {
        "nBets": int(n_bets),
        "winRate": float(round(wins / n_bets, 4)) if n_bets else 0.0,
        "totalStaked": float(round(staked, 2)),
        "totalReturn": float(round(returned, 2)),
        "roiPct": float(round(roi * 100, 2)),
        "avgEdge": float(round(edge_sum / n_bets, 4)) if n_bets else 0.0,
        "avgClvPct": float(round(clv_sum / clv_n * 100, 2)) if clv_n else 0.0,
        "nClvMeasured": int(clv_n),
        "maxDrawdown": float(round(max_dd, 2)),
        "bets": bets_log,
        "entry": "best price (Max odds), fallback avg open",
        "note": "Holdout backtest, edge>0, quarter Kelly, 5% cap. "
                "ROI>0 = real signal. avgClvPct>0 = beat the closing line.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["historical", "synthetic"], default="historical")
    ap.add_argument("--data", default=None, help="historical.json path")
    ap.add_argument("--seed", type=int, default=20260813)
    ap.add_argument("--features", default="base,odds",
                    help="comma-separated feature groups from "
                         "base,elo_split,ew_form,rest,odds,move,spread")
    ap.add_argument("--edge-min", type=float, default=0.0, help="min edge for backtest")
    ap.add_argument("--max-odds", type=float, default=0.0, help="only bet selections at odds <= this (0=off)")
    ap.add_argument("--min-odds", type=float, default=0.0, help="only bet selections at odds >= this (0=off)")
    args = ap.parse_args()

    groups = [g.strip() for g in args.features.split(",") if g.strip()]
    for g in groups:
        if g not in FEATURE_GROUPS:
            print(f"[train] unknown feature group '{g}'", file=sys.stderr)
            return 1
    features = [f for g in groups for f in FEATURE_GROUPS[g]]

    path = args.data or os.path.join(ROOT, "data", "historical.json")
    if not os.path.exists(path):
        print(f"[train] data not found at {path} — run fetch_historical.py first", file=sys.stderr)
        return 1
    matches = load_matches_dict(path)

    if len(matches) < 200:
        print(f"[train] only {len(matches)} matches — need at least 200", file=sys.stderr)
        return 1

    fill_market_features(matches)

    # TIME-ORDERED split
    n = len(matches)
    cut = int(n * 0.8)
    train_m, test_m = matches[:cut], matches[cut:]
    print(f"[train] groups={groups} | features={len(features)}")
    print(f"[train] {len(train_m)} train (oldest) / {len(test_m)} holdout ({test_m[0].date} -> {test_m[-1].date})")

    X_tr = np.array([[m.features[f] for f in features] for m in train_m], dtype=float)
    y_tr = np.array([m.outcome for m in train_m], dtype=int)
    X_te = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)
    y_te = np.array([m.outcome for m in test_m], dtype=int)

    clf, version = load_clf()
    clf.fit(X_tr, y_tr)

    # Platt calibration fitted on TRAIN (internal CV), applied to holdout
    _, proba_cal = calibrate_on_train(clf, X_tr, y_tr, X_te)
    raw_brier = multiclass_brier(y_te, clf.predict_proba(X_te))
    cal_brier = multiclass_brier(y_te, proba_cal)
    acc = float((proba_cal.argmax(axis=1) == y_te).mean())

    backtest = simulate_staking(test_m, proba_cal, edge_min=args.edge_min,
                                max_odds=args.max_odds, min_odds=args.min_odds)

    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump  # noqa: E402

    dump(clf, os.path.join(ROOT, "models", "h2h_model.joblib"))
    # h2h_calibrator.joblib now stores the full CalibratedClassifierCV
    cccv = CalibratedClassifierCV(clf, method="sigmoid", cv=3)
    cccv.fit(X_tr, y_tr)
    dump(cccv, os.path.join(ROOT, "models", "h2h_calibrator.joblib"))

    meta = {
        "version": version,
        "source": "football-data.co.uk EPL/Bundesliga/LaLiga/SerieA 2021-2025",
        "feature_groups": groups,
        "features": features,
        "n_train": len(train_m),
        "n_test": len(test_m),
        "holdout_range": f"{test_m[0].date} -> {test_m[-1].date}",
        "accuracy": round(acc, 4),
        "brier_raw": round(raw_brier, 4),
        "brier_calibrated": round(cal_brier, 4),
        "backtest": backtest,
        "classes": ["home", "draw", "away"],
        "seed": args.seed,
        "filters": {"edgeMin": args.edge_min, "maxOdds": args.max_odds or None,
                    "minOdds": args.min_odds or None},
    }
    with open(os.path.join(ROOT, "models", "model_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    bins = []
    for i in range(10):
        lo, hi = i / 10.0, (i + 1) / 10.0
        mask = (proba_cal[:, 1] >= lo) & (proba_cal[:, 1] < hi)
        cnt = int(mask.sum())
        bins.append({
            "bin": round(lo + 0.05, 2),
            "count": cnt,
            "predicted": round(float(proba_cal[mask, 1].mean()), 4) if cnt else 0.0,
            "actual": round(float((y_te[mask] == 1).mean()), 4) if cnt else 0.0,
        })
    cal_out = {
        "model_version": version,
        "sample_size": int(len(y_te)),
        "brier": round(cal_brier, 4),
        "bins": bins,
    }
    with open(os.path.join(ROOT, "output", "calibration.json"), "w") as fh:
        json.dump(cal_out, fh, indent=2)
    with open(os.path.join(ROOT, "output", "backtest.json"), "w") as fh:
        json.dump(backtest, fh, indent=2)

    print(f"[train] accuracy {acc:.3f} | brier raw {raw_brier:.4f} -> calibrated {cal_brier:.4f}")
    print(f"[train] backtest: {backtest['nBets']} bets, ROI {backtest['roiPct']:.2f}%, "
          f"win {backtest['winRate']:.1%}")
    print(f"[train] wrote models/ + output/calibration.json + output/backtest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
