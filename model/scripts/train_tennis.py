#!/usr/bin/env python3
"""Train the tennis match-winner model (binary: does the higher-Elo player win?).

ATP main tour, match-winner only (V1). Same honesty discipline as football:
  - TIME-ORDERED split (never random) — first 80% train, newest 20% holdout.
  - Platt (sigmoid) calibration fitted on the TRAIN set, applied to holdout
    (no isotonic — it over-extrapolated on sparse bins in the football model).
  - Odds-band sweep from the start: the longshot-bleed lesson applied on day
    one, not discovered after a -22% run.
  - Feature groups toggle independently via --features so each candidate
    change is backtested on its own (base,h2h,ew_form,rest,odds,spread).

Odds note: tennis-data.co.uk stores raw odds in Winner/Loser columns. The
feature builder resolves those prices by player name before training; routing
by result slot leaked the outcome and produced impossible 100% accuracy.

Outputs:
    model/models/tennis_model.joblib, tennis_calibrator.joblib
    model/output/tennis_backtest.json, tennis_calibration.json, tennis_meta.json
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

from tennis_features import (  # noqa: E402
    FEATURE_GROUPS,
    fill_odds_features,
    load_tennis_matches_dict,
)

MODEL_VERSION_TAG = "tennis-xgb-v1"


def load_clf():
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05,
            subsample=0.85, colsample_bytree=0.85,
            eval_metric="logloss", n_jobs=-1, random_state=42,
        )
    except ImportError:
        print("[train] xgboost unavailable — falling back to sklearn GradientBoostingClassifier")
        from sklearn.ensemble import GradientBoostingClassifier

        return GradientBoostingClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.85, random_state=42
        )


def binary_brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    return float(np.mean((proba - y_true) ** 2))


def logit(p: float) -> float:
    return math.log(max(1e-6, min(1 - 1e-6, p)))


def simulate_staking(test_m, proba_cal, bankroll: float = 10000.0,
                     kelly_fraction: float = 0.25, edge_min: float = 0.0,
                     max_odds: float = 0.0, min_odds: float = 0.0) -> dict:
    """Backtest with best-price entry + optional odds band.

    max_odds/min_odds restrict to a price band (0 = off). The model outputs
    P(p1 wins); we bet p1 when its edge (model prob − implied prob) is
    positive, else p2 at 1−P(p1). Entry price = best book odds for that side.
    CLV is NOT measurable here (single odds snapshot per book) — reported as
    None and measured live by the worker's closing-odds pull instead.
    """
    n_bets = 0
    wins = 0
    staked = 0.0
    returned = 0.0
    edge_sum = 0.0
    bank = bankroll
    peak = bankroll
    max_dd = 0.0
    bets_log = []

    for i, m in enumerate(test_m):
        # Name-resolved best prices (pre-match info, not winner/loser slots).
        p1_books = [b for b in m.p1_books if b and b > 1]
        p2_books = [b for b in m.p2_books if b and b > 1]
        p1_odds = max(p1_books) if p1_books else None
        p2_odds = max(p2_books) if p2_books else None
        if not (p1_odds and p2_odds and p1_odds > 1 and p2_odds > 1):
            continue

        p = float(proba_cal[i])
        inv1, inv2 = 1.0 / p1_odds, 1.0 / p2_odds
        s = inv1 + inv2
        impl1, impl2 = inv1 / s, inv2 / s
        edge1, edge2 = p - impl1, (1.0 - p) - impl2

        if edge1 >= edge2:
            sel, prob, odds, implied, edge = "p1", p, p1_odds, impl1, edge1
        else:
            sel, prob, odds, implied, edge = "p2", 1.0 - p, p2_odds, impl2, edge2

        if edge <= edge_min:
            continue
        if max_odds and odds > max_odds:
            continue
        if min_odds and odds < min_odds:
            continue

        b = odds - 1
        q = prob
        kelly = (b * q - (1 - q)) / b if b > 0 else 0.0
        stake = min(bank * kelly_fraction * max(kelly, 0), bank * 0.05)
        if stake <= 0:
            continue

        won = (sel == "p1") == bool(m.p1_won)
        n_bets += 1
        staked += stake
        wins += won
        returned += stake * odds if won else 0.0
        profit = stake * (odds - 1) if won else -stake
        bank += profit
        edge_sum += edge
        peak = max(peak, bank)
        max_dd = max(max_dd, peak - bank)
        bets_log.append({
            "date": m.date, "tournament": m.tournament, "p1": m.p1, "p2": m.p2,
            "sel": sel, "odds": odds, "prob": round(q, 4), "edge": round(edge, 4),
            "stake": round(stake, 2), "profit": round(profit, 2), "won": bool(won),
            "clvPct": None,  # not measurable from single-snapshot training odds
        })

    roi = (returned - staked) / staked if staked > 0 else 0.0
    return {
        "nBets": int(n_bets),
        "winRate": float(round(wins / n_bets, 4)) if n_bets else 0.0,
        "totalStaked": float(round(staked, 2)),
        "totalReturn": float(round(returned, 2)),
        "roiPct": float(round(roi * 100, 2)),
        "avgEdge": float(round(edge_sum / n_bets, 4)) if n_bets else 0.0,
        "avgClvPct": None,
        "nClvMeasured": 0,
        "maxDrawdown": float(round(max_dd, 2)),
        "bets": bets_log,
        "entry": "best price across books (B365/CB/EX/IW/PS)",
        "market": "h2h",
        "note": "Tennis holdout backtest, edge>0, quarter Kelly, 5% cap. "
                "Odds features are player-name resolved before training; "
                "ROI/CLV measured live via the worker's closing-odds pull.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="tennis_historical.json path")
    ap.add_argument("--seed", type=int, default=20260815)
    ap.add_argument("--features", default=None,
                    help="comma-separated feature groups (base,h2h,ew_form,rest,odds,spread)")
    ap.add_argument("--edge-min", type=float, default=0.0)
    ap.add_argument("--max-odds", type=float, default=0.0)
    ap.add_argument("--min-odds", type=float, default=0.0)
    args = ap.parse_args()

    groups = ([g.strip() for g in args.features.split(",") if g.strip()]
              if args.features else ["base", "h2h", "ew_form", "rest", "odds"])
    for g in groups:
        if g not in FEATURE_GROUPS:
            print(f"[train] unknown feature group '{g}'", file=sys.stderr)
            return 1
    features = [f for g in groups for f in FEATURE_GROUPS[g]]

    path = args.data or os.path.join(ROOT, "data", "tennis_historical.json")
    if not os.path.exists(path):
        print(f"[train] data not found at {path} — run tennis_fetch.py first", file=sys.stderr)
        return 1
    matches = load_tennis_matches_dict(path)
    if len(matches) < 200:
        print(f"[train] only {len(matches)} matches — need at least 200", file=sys.stderr)
        return 1

    for m in matches:
        fill_odds_features(m)

    # TIME-ORDERED split
    matches.sort(key=lambda m: m.ts)
    n = len(matches)
    cut = int(n * 0.8)
    train_m, test_m = matches[:cut], matches[cut:]
    print(f"[train] groups={groups} | features={len(features)}")
    print(f"[train] {len(train_m)} train / {len(test_m)} holdout ({test_m[0].date} -> {test_m[-1].date})")

    X_tr = np.array([[m.features[f] for f in features] for m in train_m], dtype=float)
    y_tr = np.array([m.p1_won for m in train_m], dtype=int)
    X_te = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)
    y_te = np.array([m.p1_won for m in test_m], dtype=int)

    clf = load_clf()
    clf.fit(X_tr, y_tr)

    # Platt (sigmoid) calibration fitted on TRAIN (internal CV), applied to holdout.
    cccv = CalibratedClassifierCV(clf, method="sigmoid", cv=3)
    cccv.fit(X_tr, y_tr)
    proba_cal = cccv.predict_proba(X_te)[:, 1]
    raw_brier = binary_brier(y_te, clf.predict_proba(X_te)[:, 1])
    cal_brier = binary_brier(y_te, proba_cal)
    acc = float(((proba_cal >= 0.5).astype(int) == y_te).mean())

    backtest = simulate_staking(test_m, proba_cal, edge_min=args.edge_min,
                                max_odds=args.max_odds, min_odds=args.min_odds)

    # Odds-band sweep (the longshot-bleed lesson applied from day one):
    # report per-band n / win% / ROI so a losing band can't hide inside an
    # aggregate. Each band is the SAME holdout bets, bucketed by entry odds.
    band_sweep = _band_sweep(test_m, proba_cal)

    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump  # noqa: E402

    dump(clf, os.path.join(ROOT, "models", "tennis_model.joblib"))
    dump(cccv, os.path.join(ROOT, "models", "tennis_calibrator.joblib"))

    meta = {
        "version": MODEL_VERSION_TAG,
        "market": "h2h",
        "source": "tennis-data.co.uk ATP main tour 2019-2026 (Grand Slams + Masters + 500s)",
        "feature_groups": groups,
        "features": features,
        "n_train": len(train_m),
        "n_test": len(test_m),
        "holdout_range": f"{test_m[0].date} -> {test_m[-1].date}",
        "accuracy": round(acc, 4),
        "brier_raw": round(raw_brier, 4),
        "brier_calibrated": round(cal_brier, 4),
        "backtest": backtest,
        "band_sweep": band_sweep,
        "classes": ["p2", "p1"],  # index 1 = p1 (higher-Elo player) wins
        "seed": args.seed,
        "filters": {"edgeMin": args.edge_min, "maxOdds": args.max_odds or None,
                    "minOdds": args.min_odds or None},
    }
    with open(os.path.join(ROOT, "models", "tennis_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    # Calibration bins (p1-win probability).
    bins = []
    for i in range(10):
        lo, hi = i / 10.0, (i + 1) / 10.0
        mask = (proba_cal >= lo) & (proba_cal < hi)
        cnt = int(mask.sum())
        bins.append({
            "bin": round(lo + 0.05, 2),
            "count": cnt,
            "predicted": round(float(proba_cal[mask].mean()), 4) if cnt else 0.0,
            "actual": round(float(y_te[mask].mean()), 4) if cnt else 0.0,
        })
    cal_out = {"model_version": MODEL_VERSION_TAG, "sample_size": int(len(y_te)),
               "brier": round(cal_brier, 4), "bins": bins}
    with open(os.path.join(ROOT, "output", "tennis_calibration.json"), "w") as fh:
        json.dump(cal_out, fh, indent=2)
    with open(os.path.join(ROOT, "output", "tennis_backtest.json"), "w") as fh:
        json.dump(backtest, fh, indent=2)

    print(f"[train] accuracy {acc:.3f} | brier raw {raw_brier:.4f} -> calibrated {cal_brier:.4f}")
    print(f"[train] backtest: {backtest['nBets']} bets, ROI {backtest['roiPct']:.2f}%, "
          f"win {backtest['winRate']:.1%}, avg edge {backtest['avgEdge']:.2%}")
    print("[train] band sweep (entry odds -> n / win% / ROI%):")
    for b in band_sweep:
        print(f"  {b['band']:<12} {b['nBets']:>5}  {b['winRate']*100:>5.1f}%  {b['roiPct']:>+7.2f}%")
    print(f"[train] wrote models/tennis_model.joblib + output/tennis_*.json")
    return 0


def _band_sweep(test_m, proba_cal) -> list[dict]:
    """Same holdout bets as simulate_staking, bucketed by entry odds."""
    bands = [
        ("1.00-1.50", 1.0, 1.5), ("1.50-2.00", 1.5, 2.0), ("2.00-2.50", 2.0, 2.5),
        ("2.50-3.50", 2.5, 3.5), ("3.50+", 3.5, 1e9),
    ]
    agg = {label: {"n": 0, "w": 0, "stake": 0.0, "ret": 0.0} for label, _, _ in bands}
    for i, m in enumerate(test_m):
        p1_books = [b for b in m.p1_books if b and b > 1]
        p2_books = [b for b in m.p2_books if b and b > 1]
        o1 = max(p1_books) if p1_books else None
        o2 = max(p2_books) if p2_books else None
        if not (o1 and o2):
            continue
        p = float(proba_cal[i])
        inv1, inv2 = 1.0 / o1, 1.0 / o2
        s = inv1 + inv2
        e1, e2 = p - inv1 / s, (1.0 - p) - inv2 / s
        if e1 >= e2:
            sel, odds, prob = "p1", o1, p
        else:
            sel, odds, prob = "p2", o2, 1.0 - p
        if max(e1, e2) <= 0:
            continue
        b = odds - 1
        kelly = max((b * prob - (1 - prob)) / b, 0) if b > 0 else 0.0
        stake = min(10000 * 0.25 * kelly, 500)
        if stake <= 0:
            continue
        won = (sel == "p1") == bool(m.p1_won)
        for label, lo, hi in bands:
            if lo <= odds < hi:
                d = agg[label]
                d["n"] += 1
                d["w"] += won
                d["stake"] += stake
                d["ret"] += stake * odds if won else 0.0
                break
    out = []
    for label, _, _ in bands:
        d = agg[label]
        roi = (d["ret"] - d["stake"]) / d["stake"] if d["stake"] else 0.0
        out.append({
            "band": label, "nBets": d["n"],
            "winRate": round(d["w"] / d["n"], 4) if d["n"] else 0.0,
            "roiPct": round(roi * 100, 2),
            "totalStaked": round(d["stake"], 2),
        })
    return out


if __name__ == "__main__":
    sys.exit(main())
