"""Fetch real historical match data from football-data.co.uk (free, no
signup, no token) and build a leakage-free feature dataset.

Usage:
    python3 scripts/fetch_historical.py
    python3 scripts/fetch_historical.py --seasons 2021,2022,2023,2024 --leagues E0,D1,SP1,I1

football-data.co.uk per-season CSVs use 2-digit season codes (e.g. 2425).
League codes: E0=EPL, D1=Bundesliga, SP1=La Liga, I1=Serie A.

Outputs:
    model/data/historical.json        — matches with team-level features
    model/data/historical_odds.json   — the CSV's average closing odds
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://www.football-data.co.uk/mmz4281"

LEAGUES = {"E0": "EPL", "D1": "Bundesliga", "SP1": "La Liga", "I1": "Serie A"}

from features import build_league_matches, matches_to_dict, parse_csv  # noqa: E402


def fetch_csv(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "OddKet/0.1"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    return list(reader)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2021,2022,2023,2024",
                    help="calendar-year season starts, comma-separated")
    ap.add_argument("--leagues", default="E0,D1,SP1,I1",
                    help="league codes, comma-separated (E0,D1,SP1,I1)")
    args = ap.parse_args()

    seasons = [f"{int(s) % 100:02d}{(int(s) + 1) % 100:02d}" for s in args.seasons.split(",") if s.strip()]
    leagues = [l.strip().upper() for l in args.leagues.split(",") if l.strip()]
    meta = {"source": "football-data.co.uk", "seasons": seasons, "leagues": leagues}

    all_rows: dict[str, list[dict]] = {code: [] for code in leagues}
    for season in seasons:
        for code in leagues:
            url = f"{BASE}/{season}/{code}.csv"
            try:
                rows = fetch_csv(url)
            except Exception as exc:  # noqa: BLE001
                print(f"[fetch] {season}/{code}: failed: {exc}", file=sys.stderr)
                continue
            if not rows:
                print(f"[fetch] {season}/{code}: empty", file=sys.stderr)
                continue
            all_rows[code].extend(rows)
            print(f"[fetch] {season}/{code}: {len(rows)} rows")

    all_matches = []
    odds_by_id: dict[str, dict] = {}
    for code, rows in all_rows.items():
        if not rows:
            continue
        matches = build_league_matches(rows, league=LEAGUES.get(code, code), season=code.lower())
        print(f"[fetch] {LEAGUES.get(code, code)}: {len(matches)} feature rows")
        all_matches.extend(matches)
        for m in matches:
            odds_by_id[m.id] = {"home": None, "draw": None, "away": None}

    if not all_matches:
        print("[fetch] no data fetched", file=sys.stderr)
        return 1

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)

    path = os.path.join(ROOT, "data", "historical.json")
    with open(path, "w") as fh:
        json.dump(matches_to_dict(all_matches), fh, indent=2)

    # Average closing odds from the CSV (AvgH/AvgD/AvgA) — for backtest only.
    for code, rows in all_rows.items():
        for r in rows:
            try:
                hg, ag = int(r.get("FTHG")), int(r.get("FTAG"))
            except (TypeError, ValueError):
                continue
            from datetime import datetime as _dt
            try:
                day = _dt.strptime(r.get("Date", ""), "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                continue
            mid = f"{code.lower()}-{day}-{r['HomeTeam']}-{r['AwayTeam']}"
            if mid in odds_by_id:
                odds_by_id[mid] = {
                    "home": float(r["AvgH"]) if r.get("AvgH") else None,
                    "draw": float(r["AvgD"]) if r.get("AvgD") else None,
                    "away": float(r["AvgA"]) if r.get("AvgA") else None,
                }

    with open(os.path.join(ROOT, "data", "historical_odds.json"), "w") as fh:
        json.dump(odds_by_id, fh, indent=2)

    print(f"[fetch] wrote {len(all_matches)} matches -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
