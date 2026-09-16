#!/usr/bin/env python3
"""Generate corner predictions for upcoming fixtures (V6).

Differences from the V5 predictor, all of which were live defects:

  * REAL ODDS. V5 fed hardcoded constants (implied_home=0.33, odds_overround=1.0,
    ...) for six features the model had been trained on with real values, one of
    which (`odds_overround`) was its #2 feature by gain. `/api/fixtures/export`
    already ships best h2h + totals odds, so V6 uses them.

  * ONE FEATURE FUNCTION. The feature vector is built by
    `train_corners_v6.build_features` — the same code path the model was trained
    on. V5 had a second, hand-copied implementation that had drifted.

  * A REAL TOTAL MODEL. `corners_total_model.joblib` predicts the match total
    directly instead of summing two independent team models, and its dispersion
    comes from its own out-of-fold residuals.

  * HONEST NAME RESOLUTION. Names resolve in tiers (exact → normalised →
    token-set → league-scoped fuzzy). A fixture whose teams cannot be resolved is
    SKIPPED with a reported reason instead of being scored from a league-average
    default, which used to produce a confident-looking prediction built on no
    information.

Usage:
    python3 scripts/predict_corners_v6.py --fixtures data/fixtures.json \
        --output data/corners_predictions.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from train_corners_v5 import ACTIVE_LEAGUES, load_all_data  # noqa: E402
from train_corners_v6 import (  # noqa: E402
    NEUTRAL_ODDS,
    TEAM_LINES,
    TOTAL_LINES,
    apply_calibration,
    build_features,
    nb_over,
    sigma_at,
    walk,
)
from corners_names import build_index  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(ROOT), "footballdata")

# The Odds API league titles → the canonical names the model was trained on.
LEAGUE_ALIASES = {
    "premier league": "EPL",
    "english premier league": "EPL",
    "epl": "EPL",
    "la liga 2": "Segunda",
    "laliga 2": "Segunda",
    "la liga smartbank": "Segunda",
    "spain la liga 2": "Segunda",
    "bundesliga 2": "2. Bundesliga",
    "germany bundesliga 2": "2. Bundesliga",
    "league 1": "League One",
    "league 2": "League Two",
    "efl league 1": "League One",
    "efl league 2": "League Two",
    "la liga": "La Liga",
    "laliga": "La Liga",
    "primera division": "La Liga",
    "spain la liga": "La Liga",
    "bundesliga": "Bundesliga",
    "germany bundesliga": "Bundesliga",
    "serie a": "Serie A",
    "italy serie a": "Serie A",
    "championship": "Championship",
    "efl championship": "Championship",
    "england championship": "Championship",
    "league one": "League One",
    "efl league one": "League One",
    "league two": "League Two",
    "efl league two": "League Two",
    "2 bundesliga": "2. Bundesliga",
    "bundesliga 2": "2. Bundesliga",
    "segunda division": "Segunda",
    "laliga 2": "Segunda",
    "serie b": "Serie B",
    "super lig": "Super Lig",
    "superliga": "Super Lig",
    "turkey super league": "Super Lig",
    "süper lig": "Super Lig",
}

# Matched longest-first, so "la liga 2" is tested before "la liga" and
# "bundesliga 2" before "bundesliga". Without this the second divisions in
# Spain and Germany were silently labelled as the top divisions, which fed the
# model the wrong league pace.
_ALIAS_KEYS_LONGEST_FIRST = sorted(LEAGUE_ALIASES.keys(), key=len, reverse=True)


def canonical_league(raw: str) -> str:
    if not raw:
        return ""
    if raw in ACTIVE_LEAGUES:
        return raw
    key = raw.lower().replace(".", " ").replace("-", " ").strip()
    key = " ".join(key.split())
    if key in LEAGUE_ALIASES:
        return LEAGUE_ALIASES[key]
    for alias in _ALIAS_KEYS_LONGEST_FIRST:
        if alias in key:
            return LEAGUE_ALIASES[alias]
    return raw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", default=None)
    ap.add_argument("--output", default=None)
    ap.add_argument("--api-url", default=None)
    ap.add_argument("--data-dir", default=DATA_DIR)
    args = ap.parse_args()

    with open(os.path.join(ROOT, "models", "corners_meta.json")) as f:
        meta = json.load(f)
    if not str(meta.get("version", "")).endswith("-v6"):
        print(f"[predict] WARNING: meta version is {meta.get('version')}, expected corners-lgb-v6",
              file=sys.stderr)

    feature_names: list[str] = meta["features"]
    home_curves = meta["home_metrics"]["sigma_curve"]
    away_curves = meta["away_metrics"]["sigma_curve"]
    total_curves = meta["total_metrics"]["sigma_curve"]

    # Per-line shape correction fitted out-of-sample by the trainer. Absent on an
    # older meta file, in which case the raw negative-binomial ladder ships (and
    # the warning above has already flagged the version mismatch).
    recal = meta.get("probability_recalibration") or {}

    def calib_for(side: str) -> dict:
        return (recal.get(side) or {}).get("lines") or {}

    print("[predict] Loading history to rebuild team state...", file=sys.stderr)
    matches = load_all_data(args.data_dir)
    _v, _x, _yh, _ya, states, pace = walk(matches, collect=False)
    print(f"[predict] {len(matches)} historical matches → {len(states)} teams", file=sys.stderr)

    team_league: dict[str, str] = {}
    for m in matches:
        team_league[m.home] = m.league
        team_league[m.away] = m.league
    index = build_index(team_league)
    print(f"[predict] name index: {len(index.exact)} clubs across "
          f"{len(index._by_league)} leagues", file=sys.stderr)

    from joblib import load

    home_model = load(os.path.join(ROOT, "models", "corners_home_model.joblib"))
    away_model = load(os.path.join(ROOT, "models", "corners_away_model.joblib"))
    total_model = load(os.path.join(ROOT, "models", "corners_total_model.joblib"))

    if args.fixtures:
        with open(args.fixtures) as f:
            payload = json.load(f)
    elif args.api_url:
        import urllib.request
        with urllib.request.urlopen(args.api_url) as resp:
            payload = json.loads(resp.read())
    else:
        payload = json.loads(sys.stdin.read())

    fixtures = payload.get("matches") or payload.get("fixtures") or [] if isinstance(payload, dict) else payload

    predictions = []
    skips: list[dict] = []
    methods: Counter = Counter()
    odds_seen = 0
    now_ts = int(datetime.now().timestamp())

    for fx in fixtures:
        raw_home = fx.get("home") or fx.get("homeTeam") or fx.get("home_team") or ""
        raw_away = fx.get("away") or fx.get("awayTeam") or fx.get("away_team") or ""
        fixture_id = fx.get("id") or fx.get("fixture_id") or ""
        league = canonical_league(fx.get("league") or "")
        kickoff = fx.get("commenceTime") or fx.get("kickoff") or fx.get("date") or ""

        home_name, h_method = index.resolve(raw_home, league)
        away_name, a_method = index.resolve(raw_away, league)
        methods[f"home:{h_method}"] += 1
        methods[f"away:{a_method}"] += 1

        missing = [n for n, r in ((raw_home, home_name), (raw_away, away_name)) if not r]
        if missing:
            skips.append({
                "fixture_id": fixture_id, "home": raw_home, "away": raw_away,
                "reason": "unresolved team name", "unresolved": missing,
                "methods": {"home": h_method, "away": a_method},
            })
            continue

        hs = states.get(home_name)
        as_ = states.get(away_name)
        if hs is None or as_ is None or hs.n_matches < 3 or as_.n_matches < 3:
            skips.append({
                "fixture_id": fixture_id, "home": raw_home, "away": raw_away,
                "reason": "insufficient history",
                "n_home": getattr(hs, "n_matches", 0), "n_away": getattr(as_, "n_matches", 0),
            })
            continue

        odds_in = fx.get("odds") or {}
        odds = {
            "home": float(odds_in.get("home") or 0.0),
            "draw": float(odds_in.get("draw") or 0.0),
            "away": float(odds_in.get("away") or 0.0),
            "ou_over": float(odds_in.get("over") or 0.0),
        }
        if odds["home"] > 1.0:
            odds_seen += 1

        feats = build_features(
            hs, as_, home_name, away_name, league, now_ts, pace,
            hs.elo, as_.elo, odds,
        )
        x = np.array([[feats.get(n, 0.0) for n in feature_names]], dtype=float)
        mu_h = float(home_model.predict(x)[0])
        mu_a = float(away_model.predict(x)[0])
        mu_t = float(total_model.predict(x)[0])

        # Clamp to a sane football range — an out-of-range regression output must
        # not be published as a "prediction".
        mu_h = min(max(mu_h, 0.5), 15.0)
        mu_a = min(max(mu_a, 0.5), 15.0)
        mu_t = min(max(mu_t, 1.0), 30.0)

        def lines_for(mu: float, curve: dict, lines: list[float], side: str) -> dict[str, float]:
            sigma = sigma_at(mu, curve)
            coeffs = calib_for(side)
            raw = [nb_over(mu, sigma, line) for line in lines]
            # Correct each rung, then force the ladder to stay non-increasing in
            # the line. Independent per-line corrections can cross over each
            # other; a crossing probability ladder would be plainly wrong in the
            # UI, so a running minimum is applied from the lowest line up.
            fixed: list[float] = []
            for line, p in zip(lines, raw):
                v = apply_calibration(p, coeffs.get(str(line)))
                v = min(v, fixed[-1]) if fixed else v
                fixed.append(v)
            return {f"O{line}": round(p, 4) for line, p in zip(lines, fixed)}

        sigma_h = sigma_at(mu_h, home_curves)
        sigma_a = sigma_at(mu_a, away_curves)
        sigma_t = sigma_at(mu_t, total_curves)

        predictions.append({
            "fixture_id": fixture_id,
            "home": raw_home,
            "away": raw_away,
            "home_resolved": home_name,
            "away_resolved": away_name,
            "resolution": {"home": h_method, "away": a_method},
            "league": league,
            "kickoff": kickoff,
            "has_odds": bool(odds["home"] > 1.0),
            "home_team_corners": {
                "expected": round(mu_h, 2),
                "ci_low": round(max(0.0, mu_h - 1.28 * sigma_h), 2),
                "ci_high": round(mu_h + 1.28 * sigma_h, 2),
                "sigma": round(sigma_h, 3),
                "lines": lines_for(mu_h, home_curves, TEAM_LINES, "home"),
            },
            "away_team_corners": {
                "expected": round(mu_a, 2),
                "ci_low": round(max(0.0, mu_a - 1.28 * sigma_a), 2),
                "ci_high": round(mu_a + 1.28 * sigma_a, 2),
                "sigma": round(sigma_a, 3),
                "lines": lines_for(mu_a, away_curves, TEAM_LINES, "away"),
            },
            "total_corners": {
                "expected": round(mu_t, 2),
                "sum_of_teams": round(mu_h + mu_a, 2),
                "sigma": round(sigma_t, 3),
                "lines": lines_for(mu_t, total_curves, TOTAL_LINES, "total"),
            },
        })

    output = {
        "generated_at": datetime.now().isoformat(),
        "model_version": meta["version"],
        "line_method": meta.get("line_method"),
        "calibrated": bool(recal),
        "sigmas": {
            "home_curve": home_curves, "away_curve": away_curves, "total_curve": total_curves,
        },
        "n_fixtures": len(predictions),
        "n_skipped": len(skips),
        "n_with_odds": odds_seen,
        "resolution_methods": dict(methods),
        "skips": skips,
        "predictions": predictions,
    }

    print(f"[predict] {len(predictions)} predictions, {len(skips)} skipped, "
          f"{odds_seen} with real odds", file=sys.stderr)
    if skips:
        print(f"[predict] resolution methods: {dict(methods)}", file=sys.stderr)
        for s in skips[:10]:
            print(f"[predict]   SKIP {s['home']} vs {s['away']}: {s['reason']}", file=sys.stderr)

    text = json.dumps(output, indent=2)
    if args.output:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w") as f:
            f.write(text)
        print(f"[predict] wrote {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
