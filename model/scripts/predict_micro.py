#!/usr/bin/env python3
"""Predict micro-market probabilities (O1.5 goals, Team To Score) for fixtures.

Loads the micro_meta.json feature list + per-market model/calibrator and emits
rows in the shape POST /api/predictions/ingest expects:
    {"fixtureId", "market", "selection", "probability", "confidenceLow",
     "confidenceHigh", "modelVersion"}

Markets:
  ou15        -> selection "over"  = P(total > 1.5)   (also emits "under")
  team_home   -> selection "yes"   = P(home scores)   (also emits "no")
  team_away   -> selection "yes"   = P(away scores)   (also emits "no")

Usage:
    python3 scripts/predict_micro.py --fixtures data/fixtures.json --output data/micro_predictions.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import numpy as np  # noqa: E402

from features import TeamState, build_team_states, compute_pair_features, load_matches_dict  # noqa: E402
from predict import NAME_MAP  # noqa: E402 — reuse the same team-name mapping

MICRO_META = os.path.join(ROOT, "models", "micro_meta.json")


def normalize_name(name: str) -> str:
    if not name:
        return ""
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return NAME_MAP.get(name, name)


def load_history() -> tuple:
    hist_path = os.path.join(ROOT, "data", "historical.json")
    with open(hist_path) as f:
        hist = json.load(f)
    matches = load_matches_dict(hist_path)
    states = build_team_states(matches)
    return states, matches


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True, help="fixtures.json (worker export shape)")
    ap.add_argument("--output", required=True, help="output JSON path")
    args = ap.parse_args()

    with open(MICRO_META) as f:
        meta = json.load(f)
    feature_names = meta["features"]

    with open(args.fixtures) as f:
        fixtures = json.load(f)
    if isinstance(fixtures, dict):
        fixtures = fixtures.get("matches") or fixtures.get("fixtures") or []

    states, matches = load_history()
    from joblib import load  # noqa: E402

    models = {}
    for market in ("ou15", "team_home", "team_away"):
        if market not in meta["markets"]:
            print(f"[predict] {market} not in micro_meta.json — skipping", file=sys.stderr)
            continue
        models[market] = (
            load(os.path.join(ROOT, "models", f"{market}_model.joblib")),
            load(os.path.join(ROOT, "models", f"{market}_calibrator.joblib")),
            meta["markets"][market],
        )

    # Compute pair features ONCE per fixture; each market model consumes the
    # same feature vector (the ou_odds features come from the fixture's own
    # current totals odds — leakage-free, known before kickoff).
    from predict import fill_odds_features  # noqa: E402

    predictions = []
    skipped = 0
    for fx in fixtures:
        home = normalize_name(fx.get("homeTeam") or fx.get("home", ""))
        away = normalize_name(fx.get("awayTeam") or fx.get("away", ""))
        if not home or not away:
            skipped += 1
            continue
        hs = states.get(home)
        as_ = states.get(away)
        if hs is None or as_ is None:
            print(f"  [warn] no history for {home} or {away} — using defaults", file=sys.stderr)
            hs = hs or TeamState()
            as_ = as_ or TeamState()
        ts = int(fx.get("commenceTime") or 0)
        feats = compute_pair_features(hs, as_, matches, home, away, ts)
        odds = fx.get("odds") or {}
        # ou_odds features need the fixture's totals odds (best over/under).
        feats["odd_over"] = 0.0
        feats["odd_under"] = 0.0
        if odds.get("over") and odds.get("under"):
            inv = [1.0 / odds["over"], 1.0 / odds["under"]]
            s = sum(inv)
            impl = [v / s for v in inv]
            import math
            feats["odd_over"] = round(math.log(max(1e-6, min(1 - 1e-6, impl[0]))), 4)
            feats["odd_under"] = round(math.log(max(1e-6, min(1 - 1e-6, impl[1]))), 4)

        x = np.array([[feats.get(f, 0.0) for f in feature_names]], dtype=float)

        for market, (clf, cal, cfg) in models.items():
            classes = cfg["classes"]  # [under/no, over/yes]
            proba = cal.predict_proba(x)[0]
            version = cfg["version"]
            if market == "ou15":
                # selection "over" = classes index 1
                p_over = float(np.clip(proba[1], 0.01, 0.99))
                hw = 0.08 + 0.25 * abs(p_over - 0.5)
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": "ou15",
                    "selection": "over",
                    "probability": round(p_over, 4),
                    "confidenceLow": round(max(0.0, p_over - hw), 4),
                    "confidenceHigh": round(min(1.0, p_over + hw), 4),
                    "modelVersion": version,
                })
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": "ou15",
                    "selection": "under",
                    "probability": round(1.0 - p_over, 4),
                    "confidenceLow": round(max(0.0, (1.0 - p_over) - hw), 4),
                    "confidenceHigh": round(min(1.0, (1.0 - p_over) + hw), 4),
                    "modelVersion": version,
                })
            else:
                side = "home" if market == "team_home" else "away"
                p_yes = float(np.clip(proba[1], 0.01, 0.99))
                hw = 0.08 + 0.25 * abs(p_yes - 0.5)
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": f"team_{side}_goals",
                    "selection": "yes",
                    "probability": round(p_yes, 4),
                    "confidenceLow": round(max(0.0, p_yes - hw), 4),
                    "confidenceHigh": round(min(1.0, p_yes + hw), 4),
                    "modelVersion": version,
                })
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": f"team_{side}_goals",
                    "selection": "no",
                    "probability": round(1.0 - p_yes, 4),
                    "confidenceLow": round(max(0.0, (1.0 - p_yes) - hw), 4),
                    "confidenceHigh": round(min(1.0, (1.0 - p_yes) + hw), 4),
                    "modelVersion": version,
                })

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(predictions, fh, indent=2)
    print(f"[predict] {len(fixtures)} fixtures -> {len(predictions)} predictions -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())