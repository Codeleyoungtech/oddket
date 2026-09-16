#!/usr/bin/env python3
"""Sweep the edge threshold, and measure it against a NO-INFORMATION control.

A gate is only a filter if it excludes things. The question this script answers
is: at what edge threshold does the model's selection start to carry information
the market does not already have?

The control is what makes that answerable. For each threshold we also run the
same gate with the model's probability rows SHUFFLED across matches — same
probabilities, same odds, same gate, but the pairing between a prediction and a
fixture destroyed. Whatever ROI survives that is the gate's noise floor: the
return you get from selecting on nothing. A threshold whose real ROI sits on top
of its own shuffled ROI is not filtering, it is just picking.

The `best/avgC` column is NOT value-versus-close. It is the BEST available entry
price over the AVERAGE closing price, and a best-vs-average spread is positive by
construction — reading it as "we beat the close by 8%" would be wrong. A true
closing-line comparison needs closing prices PER BOOK, which the historical file
does not carry yet; until it does, the Brier comparison in
`validate_closing_line.py` is the honest test of whether the model knows
something the market does not.

Usage:
    python3 scripts/sweep_edge_threshold.py
    python3 scripts/sweep_edge_threshold.py --max-odds 2.5 --shuffles 30
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from features import history_path, load_matches_dict  # noqa: E402
from train import fill_market_features, odds_for_market  # noqa: E402

CLASSES = ("home", "draw", "away")


def build(test_m):
    best = np.full((len(test_m), 3), np.nan)
    close = np.full((len(test_m), 3), np.nan)
    won = np.zeros((len(test_m), 3), dtype=bool)
    for i, m in enumerate(test_m):
        o = odds_for_market(m, list(CLASSES))
        if len(o) != 3:
            continue
        for j, c in enumerate(CLASSES):
            best[i, j] = o[c]
            cv = (m.odds or {}).get(f"close_{c}")
            close[i, j] = cv if cv and cv > 1.0 else np.nan
            won[i, j] = m.outcome == j
    return best, close, won


def evaluate(P, best, close, won, thr, max_odds):
    edge = P * best - 1.0
    sel = edge >= thr
    if max_odds:
        sel &= best <= max_odds
    sel &= np.isfinite(best) & (best > 1.0)
    n = int(sel.sum())
    if n == 0:
        return None
    ret = np.where(won[sel], best[sel], 0.0).sum()
    staked = float(n)
    roi = (ret - staked) / staked
    clv = (best[sel] / close[sel] - 1.0)
    clv = clv[np.isfinite(clv)]
    return {
        "n": n,
        "win": float(won[sel].mean()),
        "roi": float(roi),
        "edge": float(edge[sel].mean()),
        "clv": float(clv.mean()) if len(clv) else float("nan"),
        "n_clv": len(clv),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=history_path())
    ap.add_argument("--model", default=os.path.join(ROOT, "models", "h2h_calibrator.joblib"),
                    help="the shipped calibrator (what the app actually serves)")
    ap.add_argument("--features-from", default=os.path.join(ROOT, "models", "model_meta.json"))
    ap.add_argument("--max-odds", type=float, default=0.0,
                    help="restrict to selections at or below this price (0 = off)")
    ap.add_argument("--shuffles", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    import json

    from joblib import load

    features = json.load(open(args.features_from))["features"]
    matches = load_matches_dict(args.data)
    fill_market_features(matches, market="h2h")
    matches.sort(key=lambda m: m.ts)
    cut = int(len(matches) * 0.8)
    test_m = matches[cut:]

    X = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)
    P = load(args.model).predict_proba(X)
    best, close, won = build(test_m)
    print(f"[sweep] holdout {len(test_m)} matches, "
          f"{int(np.isfinite(best).sum())} priced selections"
          + (f", restricted to odds <= {args.max_odds}" if args.max_odds else ""))

    rng = np.random.default_rng(args.seed)
    print()
    print(f"{'edge >= ':>9s} {'bets':>6s} {'win%':>6s} {'avgEdge':>8s} "
          f"{'ROI':>8s} {'best/avgC':>9s} {'shuffled ROI':>13s} {'lift':>7s}")
    for thr in (0.0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.15):
        r = evaluate(P, best, close, won, thr, args.max_odds)
        if r is None or r["n"] < 30:
            continue
        ctrl = []
        for _ in range(args.shuffles):
            perm = rng.permutation(len(P))
            c = evaluate(P[perm], best, close, won, thr, args.max_odds)
            if c:
                ctrl.append(c["roi"])
        ctrl_roi = float(np.mean(ctrl)) if ctrl else float("nan")
        ctrl_sd = float(np.std(ctrl)) if ctrl else float("nan")
        lift = r["roi"] - ctrl_roi
        print(f"{thr:9.2f} {r['n']:6d} {r['win']*100:5.1f}% {r['edge']:+8.3f} "
              f"{r['roi']*100:+7.2f}% {r['clv']*100:+6.2f}% "
              f"{ctrl_roi*100:+8.2f}%+-{ctrl_sd*100:.2f} {lift*100:+6.2f}%")
    print()
    print("'shuffled ROI' is the same gate run on probabilities paired with the "
          "WRONG matches; 'lift' is the part of ROI that comes from the pairing.")
    print("'best/avgC' is a spread, not CLV — see the module docstring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
