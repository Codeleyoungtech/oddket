#!/usr/bin/env python3
"""Predict match-result probabilities (+ confidence intervals) for fixtures
using the REAL model and REAL team-level features.

Usage:
    python3 scripts/predict.py --source fixtures --data data/fixtures.json

The fixtures file is produced by worker/scripts/export-fixtures.mjs and
contains the upcoming fixtures as {id, home, away, league}. Features are
computed by features.build_team_states() over the historical dataset — the
SAME leakage-free computation used at training time (form, Elo strength,
goals, shots, H2H). Current odds are NEVER part of the features.

Outputs:
    model/output/predictions.json — shape POST /api/predictions/ingest expects.
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

from features import FEATURES, build_team_states, compute_pair_features, load_matches_dict  # noqa: E402

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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["fixtures", "synthetic"], default="fixtures")
    ap.add_argument("--data", default=None, help="fixtures.json path")
    args = ap.parse_args()

    model_path = os.path.join(ROOT, "models", "h2h_model.joblib")
    cal_path = os.path.join(ROOT, "models", "h2h_calibrator.joblib")
    hist_path = os.path.join(ROOT, "data", "historical.json")
    if not os.path.exists(model_path) or not os.path.exists(cal_path):
        print(f"[predict] no trained model — run train.py first", file=sys.stderr)
        return 1
    if not os.path.exists(hist_path):
        print(f"[predict] no historical data at {hist_path} — run fetch_historical.py first", file=sys.stderr)
        return 1

    from joblib import load  # noqa: E402

    clf = load(model_path)
    calibrators = load(cal_path)
    meta = json.load(open(os.path.join(ROOT, "models", "model_meta.json")))

    path = args.data or os.path.join(ROOT, "data", "fixtures.json")
    if not os.path.exists(path):
        print(f"[predict] fixtures file not found at {path}", file=sys.stderr)
        return 1
    fixtures = json.load(open(path)).get("matches", [])

    # Build team states from real history, then compute features per fixture.
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
        features = compute_pair_features(hs, as_, history, home, away)
        rows.append((f, features))

    if not rows:
        print("[predict] no predictable fixtures", file=sys.stderr)
        return 1

    X = np.array([[r[1][f] for f in FEATURES] for r in rows], dtype=float)
    raw = clf.predict_proba(X)
    cal = np.column_stack([
        calibrators["home"].predict(raw[:, 0]),
        calibrators["draw"].predict(raw[:, 1]),
        calibrators["away"].predict(raw[:, 2]),
    ])
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
                "modelVersion": meta.get("version", "h2h-xgb-v2"),
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
