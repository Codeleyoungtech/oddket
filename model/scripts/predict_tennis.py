#!/usr/bin/env python3
"""Predict tennis match-winner probabilities for live fixtures.

Reads model/output fixtures (worker /api/tennis/fixtures/export shape:
{id, league, home, away, commenceTime, odds:{home,away}}), rebuilds per-player
states from tennis_historical.json, orders each fixture by PRE-MATCH
surface-specific Elo (p1 = higher), predicts P(p1 wins) with the trained
Platt-calibrated model, and maps probabilities back to the API's home/away
selections for POST /api/tennis/predictions/ingest.

Surface / best-of / tour level are derived from the tournament name (live
fixtures don't carry them). ATP rankings aren't in the live feed on $0, so
rank features default to neutral (0) at predict time — the model's Elo gap is
the primary strength signal, same as trained.

Usage:
    python3 scripts/predict_tennis.py --data data/tennis_fixtures.json
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

from tennis_features import (  # noqa: E402
    compute_pair_features,
    load_tennis_matches_dict,
    build_player_states,
    normalize_name,
)

# Tournament -> (surface, best_of, tour_level) for live fixtures.
GRAND_SLAMS = {"ausopen", "frenchopen", "wimbledon", "usopen"}
TOURNAMENT_SURFACE = {
    # grass
    "wimbledon": "grass", "halle": "grass", "queens": "grass",
    # clay
    "frenchopen": "clay", "montecarlo": "clay", "madrid": "clay",
    "rome": "clay", "barcelona": "clay", "hamburg": "clay",
    # everything else defaults to hard
}
LEVEL_NAMES = {"grand slam": 4, "masters": 3, "500": 2, "250": 1}


def surface_for(league: str) -> str:
    key = league.lower().replace(" ", "").replace("'", "").replace("-", "")
    for tok, surf in TOURNAMENT_SURFACE.items():
        if tok in key:
            return surf
    return "hard"


def best_of_for(league: str) -> int:
    key = league.lower()
    if any(gs in key for gs in ("australian open", "french open", "wimbledon", "us open")):
        return 5
    return 3


def tour_level_for(league: str) -> int:
    key = league.lower()
    for name, lvl in LEVEL_NAMES.items():
        if name in key:
            return lvl
    return 1


def logit(p: float) -> float:
    return math.log(max(1e-6, min(1 - 1e-6, p)))


def build_surname_index(states: dict) -> dict[str, str]:
    """Map surname (lowercased) -> canonical history key.

    The Odds API sends full names ('Joao Fonseca', 'Botic van de Zandschulp')
    while tennis-data.co.uk history keys are surname+initial normalized to
    surname ('Fonseca', 'Van De Zandschulp'). Resolve by surname so live
    fixtures find their pre-match state.
    """
    idx: dict[str, str] = {}
    for key in states:
        # canonical key may be multi-word (e.g. 'Van De Zandschulp'): index
        # both the full lowercased key and its final token.
        low = key.lower()
        idx.setdefault(low, key)
        idx.setdefault(low.split()[-1], key)
    return idx


def resolve_player(name: str, states: dict, idx: dict) -> str | None:
    """Resolve an API full name to a history state key (or None)."""
    if not name:
        return None
    norm = normalize_name(name)
    if norm in states:
        return norm
    low = norm.lower()
    if low in idx:
        return idx[low]
    return idx.get(low.split()[-1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=None, help="tennis fixtures json path")
    ap.add_argument("--market", choices=["h2h"], default="h2h")
    args = ap.parse_args()

    model_path = os.path.join(ROOT, "models", "tennis_model.joblib")
    cal_path = os.path.join(ROOT, "models", "tennis_calibrator.joblib")
    hist_path = os.path.join(ROOT, "data", "tennis_historical.json")
    meta_path = os.path.join(ROOT, "models", "tennis_meta.json")
    if not os.path.exists(model_path) or not os.path.exists(cal_path):
        print("[predict] no trained tennis model — run train_tennis.py first", file=sys.stderr)
        return 1
    if not os.path.exists(hist_path):
        print(f"[predict] no history at {hist_path} — run tennis_fetch.py first", file=sys.stderr)
        return 1

    from joblib import load  # noqa: E402

    clf = load(model_path)
    calibrated = load(cal_path)
    meta = json.load(open(meta_path))
    features_needed = meta.get("features", [])
    print(f"[predict] model {meta.get('version')} | features: {len(features_needed)}")

    path = args.data or os.path.join(ROOT, "data", "tennis_fixtures.json")
    if not os.path.exists(path):
        print(f"[predict] fixtures file not found at {path}", file=sys.stderr)
        return 1
    fixtures = json.load(open(path)).get("matches", [])

    history = load_tennis_matches_dict(hist_path)
    states = build_player_states(history)
    idx = build_surname_index(states)

    rows = []
    skipped = 0
    for f in fixtures:
        home = resolve_player(f.get("home", ""), states, idx)
        away = resolve_player(f.get("away", ""), states, idx)
        hs = states.get(home)
        as_ = states.get(away)
        if hs is None or as_ is None:
            skipped += 1
            print(f"[predict] unknown player(s) for '{f.get('home')}' vs '{f.get('away')}' — skipping", file=sys.stderr)
            continue
        league = f.get("league", "")
        surface = surface_for(league)
        best_of = best_of_for(league)
        tlevel = tour_level_for(league)
        ts = int(f.get("commenceTime") or 0)

        # Order by pre-match surface Elo (same rule as training).
        from tennis_features import _surface_rating
        r_home = _surface_rating(hs, surface)
        r_away = _surface_rating(as_, surface)
        if r_home >= r_away:
            p1, p2, p1_state, p2_state, home_is_p1 = home, away, hs, as_, True
        else:
            p1, p2, p1_state, p2_state, home_is_p1 = away, home, as_, hs, False

        features = compute_pair_features(
            p1_state, p2_state, [], p1, p2, surface, 0.0, 0.0, best_of, tlevel, ts,
        )
        odds = f.get("odds") or {}
        # Fill implied features from the fixture's own best odds (leakage-free).
        oh, oa = odds.get("home"), odds.get("away")
        if oh and oa and oh > 1 and oa > 1:
            inv_h, inv_a = 1.0 / oh, 1.0 / oa
            s = inv_h + inv_a
            implied_home = inv_h / s
        else:
            implied_home = None
        # p1's implied prob depends on whether p1 is home.
        p1_implied = implied_home if home_is_p1 else (1.0 - implied_home) if implied_home is not None else None
        if p1_implied is not None:
            features["implied_p1"] = round(p1_implied, 4)
            features["implied_p2"] = round(1.0 - p1_implied, 4)
            features["implied_gap"] = round(2 * p1_implied - 1, 4)
        rows.append((f, features, home_is_p1))

    print(f"[predict] resolved {len(rows)}/{len(fixtures)} fixtures (skipped {skipped})")
    if not rows:
        print("[predict] no predictable fixtures", file=sys.stderr)
        return 1

    X = np.array([[r[1][fname] for fname in features_needed] for r in rows], dtype=float)
    raw = clf.predict_proba(X)[:, 1]
    cal = calibrated.predict_proba(X)[:, 1]
    # uncertainty band from raw spread
    half = 0.10 + 0.35 * np.abs(raw - 0.5)

    predictions = []
    for i, (f, _, home_is_p1) in enumerate(rows):
        p_p1 = float(np.clip(cal[i], 0.01, 0.99))
        hw = float(np.clip(half[i], 0.02, 0.25))
        for sel, prob in (("home", p_p1 if home_is_p1 else 1.0 - p_p1),
                          ("away", 1.0 - p_p1 if home_is_p1 else p_p1)):
            predictions.append({
                "fixtureId": f["id"],
                "market": "h2h",
                "selection": sel,
                "probability": round(prob, 4),
                "confidenceLow": round(max(0.0, prob - hw), 4),
                "confidenceHigh": round(min(1.0, prob + hw), 4),
                "modelVersion": meta.get("version", "tennis-xgb-v1"),
            })

    out_path = os.path.join(ROOT, "output", "tennis_predictions.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(predictions, fh, indent=2)

    print(f"[predict] {len(rows)} fixtures -> {len(predictions)} predictions -> {out_path}")
    print("[predict] push with:")
    print(f"  curl -s -X POST http://localhost:8787/api/tennis/predictions/ingest -H 'Content-Type: application/json' -d @{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
