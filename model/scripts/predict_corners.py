#!/usr/bin/env python3
"""Generate corner predictions for upcoming fixtures.

Reads the trained model + team historical corner data, computes features
for each upcoming fixture, and outputs JSON predictions.

Usage:
    python predict_corners.py [--fixtures ../../worker/data/fixtures_cloud.json]

Output: JSON array to stdout, one entry per fixture:
{
  "fixtureId": "...",
  "home": "Team A",
  "away": "Team B",
  "homeCorners": 5.8,
  "awayCorners": 4.1
}
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime

import numpy as np
from joblib import load

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from train_corners import (
    CornerMatch, CornerTeamState, LEAGUES, SEASONS,
    compute_corners_features, FEATURE_NAMES, FORM_WINDOW, EW_DECAY,
    _avg, _ew_avg,
)


def load_historical_corners(data_dir: str) -> list[CornerMatch]:
    """Load all historical corner data to build team states."""
    all_matches = []
    for code, name in LEAGUES.items():
        for season in SEASONS:
            path = os.path.join(data_dir, f"{code}_{season}.csv")
            if os.path.exists(path):
                ms = []
                with open(path, encoding="utf-8-sig") as f:
                    reader = csv.DictReader(f)
                    for i, r in enumerate(reader):
                        hc = r.get("HC", "").strip()
                        ac = r.get("AC", "").strip()
                        if not hc.isdigit() or not ac.isdigit():
                            continue
                        date_str = r.get("Date", "").strip()
                        ts = 0
                        for fmt in ("%d/%m/%Y", "%d/%m/%y"):
                            try:
                                ts = int(datetime.strptime(date_str, fmt).timestamp())
                                break
                            except ValueError:
                                continue
                        if not ts:
                            continue
                        ms.append(CornerMatch(
                            id=f"hist-{name}-{season}-{i}",
                            league=name, season=season,
                            home=r["HomeTeam"].strip(), away=r["AwayTeam"].strip(),
                            home_corners=int(hc), away_corners=int(ac),
                            home_goals=int(r.get("FTHG", 0) or 0),
                            away_goals=int(r.get("FTAG", 0) or 0),
                            home_shots=int(r.get("HS", 0) or 0),
                            away_shots=int(r.get("AS", 0) or 0),
                            home_sot=int(r.get("HST", 0) or 0),
                            away_sot=int(r.get("AST", 0) or 0),
                            date="", ts=ts,
                        ))
                all_matches.extend(ms)
    all_matches.sort(key=lambda m: m.ts)
    return all_matches


def build_team_states(matches: list[CornerMatch]) -> dict[str, CornerTeamState]:
    """Replay historical matches to build current team states."""
    teams: dict[str, CornerTeamState] = {}
    for m in matches:
        hs = teams.setdefault(m.home, CornerTeamState())
        as_ = teams.setdefault(m.away, CornerTeamState())

        hs.corner_rate_home.append(m.home_corners)
        hs.conceded_rate_home.append(m.away_corners)
        hs.corner_history.append((m.home_corners, True))
        hs.shots_history.append((m.home_shots, True))
        hs.last_ts = m.ts

        as_.corner_rate_away.append(m.away_corners)
        as_.conceded_rate_away.append(m.home_corners)
        as_.corner_history.append((m.away_corners, False))
        as_.shots_history.append((m.away_shots, False))
        as_.last_ts = m.ts
    return teams


def predict_fixtures(
    fixtures: list[dict],
    teams: dict[str, CornerTeamState],
    home_model,
    away_model,
) -> list[dict]:
    """Predict corner counts for each fixture."""
    predictions = []
    for fx in fixtures:
        home = fx.get("homeTeam", "")
        away = fx.get("awayTeam", "")
        fid = fx.get("id", "")
        ts = fx.get("commenceTime", 0)

        hs = teams.get(home)
        as_ = teams.get(away)

        if not hs or not as_:
            # Team not in historical data — use league average prior
            print(f"  [warn] {home} or {away} not in historical data, skipping", file=sys.stderr)
            continue

        features = compute_corners_features(hs, as_, home, away, ts)
        X = np.array([[features[f] for f in FEATURE_NAMES]], dtype=float)

        home_corners = float(home_model.predict(X)[0])
        away_corners = float(away_model.predict(X)[0])

        # Clamp to reasonable range (0-16 corners per team)
        home_corners = max(0.0, min(16.0, home_corners))
        away_corners = max(0.0, min(16.0, away_corners))

        predictions.append({
            "fixtureId": fid,
            "home": home,
            "away": away,
            "homeCorners": round(home_corners, 2),
            "awayCorners": round(away_corners, 2),
        })

    return predictions


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data", "corners"))
    ap.add_argument("--fixtures", default=None, help="Path to fixtures JSON")
    args = ap.parse_args()

    models_dir = os.path.join(ROOT, "models")
    home_model_path = os.path.join(models_dir, "corners_home_model.joblib")
    away_model_path = os.path.join(models_dir, "corners_away_model.joblib")

    if not os.path.exists(home_model_path):
        print(f"[predict] Model not found at {home_model_path} — run train_corners.py first", file=sys.stderr)
        return 1

    print("[predict] Loading trained models...", file=sys.stderr)
    home_model = load(home_model_path)
    away_model = load(away_model_path)

    print("[predict] Loading historical corner data for team states...", file=sys.stderr)
    hist = load_historical_corners(args.data_dir)
    teams = build_team_states(hist)
    print(f"[predict] {len(teams)} teams loaded", file=sys.stderr)

    # Load fixtures
    fixtures_path = args.fixtures
    if not fixtures_path:
        # Try common locations
        for p in [
            os.path.join(ROOT, "..", "worker", "data", "fixtures_cloud.json"),
            os.path.join(ROOT, "..", "worker", "data", "fixtures.json"),
        ]:
            if os.path.exists(p):
                fixtures_path = p
                break

    if not fixtures_path or not os.path.exists(fixtures_path):
        print("[predict] No fixtures file found — outputting empty predictions", file=sys.stderr)
        print("[]")
        return 0

    with open(fixtures_path) as f:
        fixtures_data = json.load(f)

    # Handle both array and {fixtures: [...]} formats
    if isinstance(fixtures_data, dict):
        fixtures = fixtures_data.get("fixtures", [])
    else:
        fixtures = fixtures_data

    # Filter to upcoming only
    now = int(datetime.utcnow().timestamp())
    upcoming = [fx for fx in fixtures if fx.get("commenceTime", 0) > now]
    print(f"[predict] {len(upcoming)} upcoming fixtures", file=sys.stderr)

    preds = predict_fixtures(upcoming, teams, home_model, away_model)
    print(f"[predict] {len(preds)} predictions generated", file=sys.stderr)

    # Output JSON to stdout
    print(json.dumps(preds, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
