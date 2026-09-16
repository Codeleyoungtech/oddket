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

from features import TeamState, build_team_states, compute_pair_features, history_path, load_matches_dict  # noqa: E402
from predict import NAME_MAP  # noqa: E402 — reuse the same team-name mapping

MICRO_META = os.path.join(ROOT, "models", "micro_meta.json")

# Used only when a market ships without a reliability table (older artifact).
FALLBACK_HALF_WIDTH = 0.05


def reliability_interval(p: float, bands: list | None) -> tuple[float, float]:
    """Out-of-sample interval for a probability, from the model's own holdout
    reliability table (observed rate + Wilson 95% bounds for the band `p`
    falls in).

    The shipped interval used to be an invented ±(0.08 + 0.25·|p−0.5|) band,
    which produced absurd 67%–99% ranges at p≈0.83. A model's honest
    uncertainty is how its own probabilities have held up out of sample —
    which is exactly what this table measures.
    """
    if not bands:
        return max(0.0, p - FALLBACK_HALF_WIDTH), min(1.0, p + FALLBACK_HALF_WIDTH)
    for b in bands:
        if b.get("n") and b.get("observed") is not None and b["lo"] <= p < b["hi"]:
            return float(b["low"]), float(b["high"])
    # Top band is inclusive of 1.0 — match it explicitly.
    top = bands[-1]
    if top.get("n") and p >= top["lo"]:
        return float(top["low"]), float(top["high"])
    return max(0.0, p - FALLBACK_HALF_WIDTH), min(1.0, p + FALLBACK_HALF_WIDTH)


def load_history() -> tuple:
    # The file used to be parsed twice here — a redundant `json.load` whose result
    # was never read. It went unnoticed until the data became gzip-compressed,
    # at which point the pointless parse was the only thing that failed.
    matches = load_matches_dict(history_path())
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
        cfg = meta["markets"][market]
        cfg["reliability"] = cfg.get("reliability")
        print(
            f"[predict] {market}: {cfg.get('version')} | holdout base {cfg.get('baseRate')} | "
            f"reliability bands {len(cfg.get('reliability') or [])}",
            file=sys.stderr,
        )

    # Compute pair features ONCE per fixture; each market model consumes the
    # same feature vector (the ou_odds features come from the fixture's own
    # current totals odds — leakage-free, known before kickoff).
    from predict import fill_odds_features, resolve_team  # noqa: E402
    from corners_names import build_index  # noqa: E402

    # Two fixes predict.py already needed, applied here for the same reasons:
    #
    # * Name resolution goes through the tiered TeamIndex instead of an exact
    #   NAME_MAP hit, so a spelling variant (`Newcastle United`, `Girona FC`)
    #   resolves to the club that is genuinely in the history.
    # * Clubs with no history get a FIELD-MEDIAN prior, not `TeamState()`. A bare
    #   TeamState carries START_RATING (1500), but the field's Elo has drifted to
    #   a median near 940 — so the default made a club with no data look stronger
    #   than the best real team, and every fixture in a league this model never
    #   trained on was scored as two elite sides.
    _index = build_index({t: "" for t in states})
    _ratings = sorted(s.rating for s in states.values())
    _ratings_home = sorted(s.rating_home for s in states.values())
    _ratings_away = sorted(s.rating_away for s in states.values())
    _mid = len(states) // 2
    prior_elo, prior_home, prior_away = _ratings[_mid], _ratings_home[_mid], _ratings_away[_mid]
    print(f"[predict] neutral prior Elo = {prior_elo:.0f} "
          f"(home {prior_home:.0f} / away {prior_away:.0f}), field median", file=sys.stderr)

    def _fresh_prior() -> TeamState:
        st = TeamState()
        st.rating = prior_elo
        st.rating_home = prior_home
        st.rating_away = prior_away
        return st

    predictions = []
    skipped = 0
    for fx in fixtures:
        home = resolve_team(fx.get("homeTeam") or fx.get("home", ""), _index)
        away = resolve_team(fx.get("awayTeam") or fx.get("away", ""), _index)
        if not home or not away:
            skipped += 1
            continue
        hs = states.get(home)
        as_ = states.get(away)
        if hs is None or as_ is None:
            print(f"  [warn] no history for {home} or {away} — scoring on neutral prior", file=sys.stderr)
            hs = hs or _fresh_prior()
            as_ = as_ or _fresh_prior()
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
            bands = cfg.get("reliability")
            if market == "ou15":
                # selection "over" = classes index 1
                p_over = float(np.clip(proba[1], 0.01, 0.99))
                lo, hi = reliability_interval(p_over, bands)
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": "ou15",
                    "selection": "over",
                    "probability": round(p_over, 4),
                    "confidenceLow": round(lo, 4),
                    "confidenceHigh": round(hi, 4),
                    "modelVersion": version,
                })
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": "ou15",
                    "selection": "under",
                    "probability": round(1.0 - p_over, 4),
                    "confidenceLow": round(1.0 - hi, 4),
                    "confidenceHigh": round(1.0 - lo, 4),
                    "modelVersion": version,
                })
            else:
                side = "home" if market == "team_home" else "away"
                p_yes = float(np.clip(proba[1], 0.01, 0.99))
                lo, hi = reliability_interval(p_yes, bands)
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": f"team_{side}_goals",
                    "selection": "yes",
                    "probability": round(p_yes, 4),
                    "confidenceLow": round(lo, 4),
                    "confidenceHigh": round(hi, 4),
                    "modelVersion": version,
                })
                predictions.append({
                    "fixtureId": fx.get("id") or fx.get("fixture_id", ""),
                    "market": f"team_{side}_goals",
                    "selection": "no",
                    "probability": round(1.0 - p_yes, 4),
                    "confidenceLow": round(1.0 - hi, 4),
                    "confidenceHigh": round(1.0 - lo, 4),
                    "modelVersion": version,
                })

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(predictions, fh, indent=2)
    print(f"[predict] {len(fixtures)} fixtures -> {len(predictions)} predictions -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())