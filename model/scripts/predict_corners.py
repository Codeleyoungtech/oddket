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
    RECENT_WINDOW, MOMENTUM_WINDOW, H2H_CORNERS_WINDOW,
    _avg, _ew_avg,
)
# Also try importing from the v4 script for newer features
try:
    from train_corners_v4 import compute_corners_features as v4_features
except ImportError:
    pass

# Alias table: API team name -> historical team name
# Built by comparing football-data.co.uk CSVs with The Odds API team names.
TEAM_ALIASES: dict[str, str] = {
    # EPL
    "Manchester City": "Man City",
    "Manchester United": "Man United",
    "Tottenham Hotspur": "Tottenham",
    "Brighton and Hove Albion": "Brighton",
    "Newcastle United": "Newcastle",
    "Nottingham Forest": "Nott'm Forest",
    "West Ham United": "West Ham",
    "Wolverhampton Wanderers": "Wolves",
    "Wolverhampton": "Wolves",
    "Leeds United": "Leeds",
    "Leicester City": "Leicester",
    "Ipswich Town": "Ipswich",
    "Coventry City": "Coventry",
    "Hull City": "Hull",
    "Sunderland": "Sunderland",
    # La Liga
    "Atlético Madrid": "Ath Madrid",
    "Athletic Bilbao": "Ath Bilbao",
    "Real Sociedad": "Sociedad",
    "Real Betis": "Betis",
    "CA Osasuna": "Osasuna",
    "Rayo Vallecano": "Vallecano",
    "Deportivo La Coruña": "Deportivo La Coru",
    "Elche CF": "Elche",
    "Real Racing Club de Santander": "Racing Santande",
    "RCD Espanyol": "Espanyol",
    "Espanyol": "Espanyol",
    "RCD Mallorca": "Mallorca",
    "Málaga": "Malaga",
    "Girona": "Girona",
    "Alavés": "Alaves",
    # Bundesliga
    "Bayer Leverkusen": "Leverkusen",
    "Borussia Dortmund": "Dortmund",
    "Borussia Monchengladbach": "M'gladbach",
    "Eintracht Frankfurt": "Ein Frankfurt",
    "TSG Hoffenheim": "Hoffenheim",
    "VfB Stuttgart": "Stuttgart",
    "FC Schalke 04": "Schalke 04",
    "FSV Mainz 05": "Mainz",
    "Hamburger SV": "Hamburg",
    "1. FC Köln": "Koln",
    "SC Freiburg": "Freiburg",
    "SC Paderborn": "Paderborn",
    "Elversberg": "Elversberg",
    # Serie A
    "AC Milan": "Milan",
    "Inter Milan": "Inter",
    "AS Roma": "Roma",
    "Atalanta BC": "Atalanta",
    "Hellas Verona": "Verona",
    "US Lecce": "Lecce",
    "US Sassuolo": "Sassuolo",
    "Cagliari Calcio": "Cagliari",
    "Genoa CFC": "Genoa",
    "Como": "Como",
}

# Teams genuinely not in historical data (renewed/promoted with no corner history).
# The resolve function returns None for these — caller should use league-average prior.
NO_DATA_TEAMS = {
    "Elversberg", "Real Racing Club de Santander", "Deportivo La Coruña",
    "Racing Santander", "Deportivo La Coru",
}


def _strip_accents(s: str) -> str:
    """Remove accents for fuzzy matching (e.g. 'Alavés' -> 'Alaves')."""
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def resolve_team(name: str, known_teams: set[str]) -> str | None:
    """Resolve an API team name to its historical equivalent.
    
    Returns None if the team genuinely has no historical data.
    
    1. Exact match (already in history)
    2. Alias table lookup
    3. Accent-insensitive match
    4. Fuzzy: strip common suffixes (FC, CF, AFC, SC, etc.) and try again
    5. Fuzzy: last-word match
    6. Returns None if no match found (team has no data)
    """
    if name in known_teams:
        return name
    
    # Alias table
    if name in TEAM_ALIASES:
        alias = TEAM_ALIASES[name]
        if alias in known_teams:
            return alias
    
    # Accent-insensitive match
    name_asc = _strip_accents(name).lower()
    for t in known_teams:
        if _strip_accents(t).lower() == name_asc:
            return t
    
    # Strip suffixes and try
    stripped = name_asc
    for suffix in [' fc', ' cf', ' afc', ' sc', ' ac', ' bc', ' sv', ' dfb']:
        stripped = stripped.replace(suffix, '')
    for t in known_teams:
        if _strip_accents(t).lower() == stripped:
            return t
    
    # Last-word match
    name_parts = name_asc.split()
    if len(name_parts) > 1:
        last = name_parts[-1]
        if len(last) > 3:
            for t in known_teams:
                t_parts = _strip_accents(t).lower().split()
                if t_parts[-1] == last and len(t_parts[-1]) > 3:
                    return t
    
    return None  # team has no historical data


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
    recent_matches: list[CornerMatch] | None = None,
) -> list[dict]:
    """Predict corner counts for each fixture."""
    known_teams = set(teams.keys())
    predictions = []
    skipped = []
    for fx in fixtures:
        home_raw = fx.get("homeTeam", "")
        away_raw = fx.get("awayTeam", "")
        home = resolve_team(home_raw, known_teams)
        away = resolve_team(away_raw, known_teams)
        fid = fx.get("id", "")
        ts = fx.get("commenceTime", 0)

        hs = teams.get(home)
        as_ = teams.get(away)

        if not hs or not as_:
            skipped.append(f"{home_raw} vs {away_raw}")
            continue

        features = compute_corners_features(hs, as_, home, away, ts, recent_matches=recent_matches)
        X = np.array([[features[f] for f in FEATURE_NAMES]], dtype=float)

        home_corners = float(home_model.predict(X)[0])
        away_corners = float(away_model.predict(X)[0])

        # Clamp to reasonable range (0-16 corners per team)
        home_corners = max(0.0, min(16.0, home_corners))
        away_corners = max(0.0, min(16.0, away_corners))

        predictions.append({
            "fixtureId": fid,
            "home": home_raw,
            "away": away_raw,
            "homeCorners": round(home_corners, 2),
            "awayCorners": round(away_corners, 2),
        })

    return predictions, skipped


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
    # Keep the full match list for H2H corner features
    recent_matches = hist

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

    preds, skipped = predict_fixtures(upcoming, teams, home_model, away_model, recent_matches=recent_matches)
    print(f"[predict] {len(preds)} predictions generated", file=sys.stderr)
    if skipped:
        print(f"[predict] {len(skipped)} skipped (team not in historical data):", file=sys.stderr)
        for s in skipped[:10]:
            print(f"  {s}", file=sys.stderr)
        if len(skipped) > 10:
            print(f"  ... and {len(skipped)-10} more", file=sys.stderr)

    # Output JSON to stdout
    print(json.dumps(preds, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
