#!/usr/bin/env python3
"""Predict match-result probabilities (+ confidence intervals) for fixtures
using the trained model and the SAME feature computation used at training.

Usage:
    python3 scripts/predict.py --source fixtures --data data/fixtures.json

fixtures.json is produced by worker/scripts/export-fixtures.mjs and carries,
per fixture: id, home, away, league, commenceTime (unix s) and the current
best h2h odds {home, draw, away}. Team-level features come from real history
(features.build_team_states); the market-implied odds features (odd_*) come
from the fixture's own current odds (known before kickoff — leakage-free);
rest features use the fixture kickoff time. The exact feature list is read
from the trained model's model_meta.json, so predict always matches train.

Outputs:
    model/output/predictions.json — shape POST /api/predictions/ingest expects.
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

from features import build_team_states, compute_pair_features, load_matches_dict  # noqa: E402

# Map The Odds API team names -> football-data.co.uk names.
NAME_MAP = {
    "Manchester United": "Man United",
    "Manchester City": "Man City",
    "Newcastle United": "Newcastle",
    "Tottenham Hotspur": "Tottenham",
    "Wolverhampton Wanderers": "Wolves",
    "Brighton and Hove Albion": "Brighton",
    "Nottingham Forest": "Nott'm Forest",
    "West Ham United": "West Ham",
    "Luton Town": "Luton",
    "Sheffield United": "Sheffield Utd",
    "Leeds United": "Leeds",
    "Crystal Palace": "Crystal Palace",
    "Aston Villa": "Aston Villa",
    "Everton": "Everton",
    "Fulham": "Fulham",
    "Brentford": "Brentford",
    "Bournemouth": "Bournemouth",
    "Ipswich Town": "Ipswich",
    "Southampton": "Southampton",
    "Leicester City": "Leicester",
    "Arsenal": "Arsenal",
    "Chelsea": "Chelsea",
    "Liverpool": "Liverpool",
    "Hull City": "Hull",
}


def normalize(name: str) -> str:
    return NAME_MAP.get(name, name)


def logit(p: float) -> float:
    return math.log(max(1e-6, min(1 - 1e-6, p)))


def fill_odds_features(f: dict, features: dict, odds: dict) -> None:
    """Market-implied odds features (odd_h/d/a) from the fixture's current
    odds. These are the same features train.py computes from opening odds."""
    inv = [1.0 / odds[s] for s in ("home", "draw", "away") if odds.get(s) and odds[s] > 0]
    if len(inv) == 3:
        s = sum(inv)
        impl = {k: v / s for k, v in zip(("home", "draw", "away"), inv)}
        features["odd_h"] = round(logit(impl["home"]), 4)
        features["odd_d"] = round(logit(impl["draw"]), 4)
        features["odd_a"] = round(logit(impl["away"]), 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["fixtures", "synthetic"], default="fixtures")
    ap.add_argument("--data", default=None, help="fixtures.json path")
    args = ap.parse_args()

    model_path = os.path.join(ROOT, "models", "h2h_model.joblib")
    cal_path = os.path.join(ROOT, "models", "h2h_calibrator.joblib")
    hist_path = os.path.join(ROOT, "data", "historical.json")
    meta_path = os.path.join(ROOT, "models", "model_meta.json")
    if not os.path.exists(model_path) or not os.path.exists(cal_path):
        print(f"[predict] no trained model — run train.py first", file=sys.stderr)
        return 1
    if not os.path.exists(hist_path):
        print(f"[predict] no historical data at {hist_path} — run fetch_historical.py first", file=sys.stderr)
        return 1

    from joblib import load  # noqa: E402

    clf = load(model_path)
    calibrated = load(cal_path)
    meta = json.load(open(meta_path))
    features_needed = meta.get("features", [])
    print(f"[predict] model {meta.get('version')} | features: {len(features_needed)}")

    path = args.data or os.path.join(ROOT, "data", "fixtures.json")
    if not os.path.exists(path):
        print(f"[predict] fixtures file not found at {path}", file=sys.stderr)
        return 1
    fixtures = json.load(open(path)).get("matches", [])

    history = load_matches_dict(hist_path)
    states = build_team_states(history)

    rows = []
    for f in fixtures:
        home, away = normalize(f.get("home", "")), normalize(f.get("away", ""))
        hs = states.get(home)
        as_ = states.get(away)
        if hs is None or as_ is None:
            print(f"[predict] unknown team(s) for '{f.get('home')}' vs '{f.get('away')}' — skipping", file=sys.stderr)
            continue
        ts = int(f.get("commenceTime") or 0)
        features = compute_pair_features(hs, as_, history, home, away, ts)
        fill_odds_features(f, features, f.get("odds") or {})
        rows.append((f, features))

    if not rows:
        print("[predict] no predictable fixtures", file=sys.stderr)
        return 1

    X = np.array([[r[1][fname] for fname in features_needed] for r in rows], dtype=float)
    raw = clf.predict_proba(X)
    # Platt-calibrated probabilities (sigmoid per class, fitted on train)
    cal = calibrated.predict_proba(X)
    s = cal.sum(axis=1, keepdims=True)
    s[s == 0] = 1
    cal = cal / s

    # Uncertainty band from raw spread — wider when the model is unsure.
    half = 0.10 + 0.35 * np.abs(raw - 0.5)

    predictions = []
    for i, (f, _) in enumerate(rows):
        for cls_idx, sel in enumerate(["home", "draw", "away"]):
            p = float(np.clip(cal[i, cls_idx], 0.01, 0.99))
            hw = float(np.clip(half[i, cls_idx], 0.02, 0.25))
            predictions.append({
                "fixtureId": f["id"],
                "market": "h2h",
                "selection": sel,
                "probability": round(p, 4),
                "confidenceLow": round(max(0.0, p - hw), 4),
                "confidenceHigh": round(min(1.0, p + hw), 4),
                "modelVersion": meta.get("version", "h2h-xgb-v3"),
            })

    out_path = os.path.join(ROOT, "output", "predictions.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(predictions, fh, indent=2)

    print(f"[predict] {len(rows)} fixtures -> {len(predictions)} predictions -> {out_path}")
    print("[predict] push with:")
    print(f"  curl -s -X POST http://localhost:8787/api/predictions/ingest -H 'Content-Type: application/json' -d @{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
