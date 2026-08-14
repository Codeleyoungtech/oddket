#!/usr/bin/env python3
"""Diagnose backtest losses by odds band — finds the longshot bleed.

Usage: python3 scripts/diag_bands.py [--features base,odds,move,ew_form,rest]
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
from sklearn.calibration import CalibratedClassifierCV  # noqa: E402

from features import FEATURE_GROUPS, load_matches_dict  # noqa: E402
from train import fill_market_features  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default="base,odds,move,ew_form,rest")
    args = ap.parse_args()
    groups = [g.strip() for g in args.features.split(",") if g.strip()]
    feats = [f for g in groups for f in FEATURE_GROUPS[g]]

    matches = load_matches_dict(os.path.join(ROOT, "data", "historical.json"))
    fill_market_features(matches)
    n = len(matches)
    cut = int(n * 0.8)
    train_m, test_m = matches[:cut], matches[cut:]

    X_tr = np.array([[m.features[f] for f in feats] for m in train_m], dtype=float)
    y_tr = np.array([m.outcome for m in train_m], dtype=int)
    X_te = np.array([[m.features[f] for f in feats] for m in test_m], dtype=float)
    y_te = np.array([m.outcome for m in test_m], dtype=int)

    from joblib import load  # noqa: E402
    clf = load(os.path.join(ROOT, "models", "h2h_model.joblib"))
    cccv = CalibratedClassifierCV(clf, method="sigmoid", cv=3)
    cccv.fit(X_tr, y_tr)
    pcal = cccv.predict_proba(X_te)

    classes = ["home", "draw", "away"]
    bands = [(0, 1.8), (1.8, 2.5), (2.5, 4), (4, 6), (6, 99)]
    res = {b: {"bets": 0, "wins": 0, "staked": 0.0, "ret": 0.0, "edge_sum": 0.0} for b in bands}
    all_bets = []
    for i, m in enumerate(test_m):
        o = m.odds or {}
        if not o or not all(v and v > 0 for v in o.values()):
            continue
        inv = {k: 1.0 / v for k, v in o.items() if v and v > 0}
        s = sum(inv.values())
        implied = {k: v / s for k, v in inv.items()}
        edges = {c: pcal[i][j] - implied[c] for j, c in enumerate(classes)}
        sel = max(edges, key=edges.get)
        if edges[sel] <= 0:
            continue
        odds = o[sel]
        if not odds or odds <= 1:
            continue
        b = odds - 1
        q = pcal[i][classes.index(sel)]
        kelly = (b * q - (1 - q)) / b if b > 0 else 0
        stake = min(10000 * 0.25 * max(kelly, 0), 500)
        if stake <= 0:
            continue
        for band in bands:
            lo, hi = band
            if lo <= odds < hi:
                res[band]["bets"] += 1
                res[band]["staked"] += stake
                res[band]["edge_sum"] += edges[sel]
                won = m.outcome == classes.index(sel)
                if won:
                    res[band]["wins"] += 1
                    res[band]["ret"] += stake * odds
                all_bets.append((odds, stake, won))
                break

    print(f"{'odds band':10s} {'bets':>5s} {'win%':>6s} {'avgOdds':>8s} {'avgEdge':>8s} {'ROI':>8s}")
    for band in bands:
        lo, hi = band
        r = res[band]
        if r["bets"] == 0:
            continue
        roi = (r["ret"] - r["staked"]) / r["staked"]
        bet_odds = [o for o, _, _ in all_bets if lo <= o < hi]
        avg_o = sum(bet_odds) / len(bet_odds) if bet_odds else 0
        print(f"{lo}-{hi:<7g} {r['bets']:5d} {r['wins']/r['bets']*100:5.1f}% "
              f"{avg_o:8.2f} {r['edge_sum']/r['bets']:+7.3f} {roi*100:+7.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
