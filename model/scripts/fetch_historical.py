"""Fetch real historical match data from football-data.co.uk (free, no
signup, no token) and build a leakage-free feature dataset.

football-data.co.uk per-season CSVs contain results + odds for the main
European leagues. Columns used:
  FTHG/FTAG/FTR      — result
  HST/AST            — shots on target
  AvgH/AvgD/AvgA     — average opening odds
  AvgCH/AvgCD/AvgCA  — average CLOSING odds (for odds-movement feature)
  B365H.. 1XBA, MaxH — per-bookmaker odds (for spread feature)

IMPORTANT: opening/closing odds are attached to each match as MARKET extras
and are never part of the team-level features — the harness enables them
explicitly via --features odds/move/spread. Closing odds are known before
kickoff, so using them as model input is leakage-free.

Usage:
    python3 scripts/fetch_historical.py
    python3 scripts/fetch_historical.py --seasons 2021,2022,2023,2024 --leagues E0,D1,SP1,I1

Outputs:
    model/data/historical.json      — matches with team features + market extras
    model/data/historical_odds.json — per-match odds summary (backtest)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import datetime as _dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://www.football-data.co.uk/mmz4281"

LEAGUES = {"E0": "EPL", "D1": "Bundesliga", "SP1": "La Liga", "I1": "Serie A"}

from features import build_league_matches, matches_to_dict  # noqa: E402

# Bookmaker odds columns per selection (some missing in old data)
BOOK_COLS = {
    "home": ["B365H", "BWH", "BFH", "PSH", "WHH", "1XBH"],
    "draw": ["B365D", "BWD", "BFD", "PSD", "WHD", "1XBD"],
    "away": ["B365A", "BWA", "BFA", "PSA", "WHA", "1XBA"],
}


def fetch_csv(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "OddKet/0.1"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    return list(reader)


def _f(r: dict, key: str) -> float | None:
    v = r.get(key)
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _market_extras(r: dict) -> dict:
    """Opening + closing + BEST (Max) odds and per-book spread per outcome.

    best  = MaxH/MaxD/MaxA — the best available price across books (what a
            sharp bettor actually gets for entry).
    close = AvgCH/AvgCD/AvgCA — the market's closing line (for CLV).

    Also attaches the over/under 2.5 market ("ou") with the same shape
    (open/best/close per over/under selection) for the totals model.
    """
    open_ = {"home": _f(r, "AvgH"), "draw": _f(r, "AvgD"), "away": _f(r, "AvgA")}
    best = {"home": _f(r, "MaxH"), "draw": _f(r, "MaxD"), "away": _f(r, "MaxA")}
    close = {"home": _f(r, "AvgCH"), "draw": _f(r, "AvgCD"), "away": _f(r, "AvgCA")}
    out = {}
    for sel in ("home", "draw", "away"):
        books = []
        for col in BOOK_COLS[sel]:
            v = _f(r, col)
            if v is not None:
                books.append(v)
        out[sel] = {"open": open_[sel], "best": best[sel], "close": close[sel], "books": books}
    # Over/Under 2.5 market (only where the CSV has the columns)
    ou = {}
    for sel, gt, lt in (("over", ">2.5", ">2.5"), ("under", "<2.5", "<2.5")):
        ou[sel] = {
            "open": _f(r, f"Avg{gt}"),
            "best": _f(r, f"Max{gt}") or _f(r, f"Avg{gt}"),
            "close": _f(r, f"AvgC{lt}"),
        }
    out["ou"] = ou
    return out


def _odds_summary(r: dict) -> dict:
    """Backtest odds summary — bets at BEST price (Max), CLV vs closing (AvgC)."""
    return {
        "home": _f(r, "MaxH") or _f(r, "AvgH"),
        "draw": _f(r, "MaxD") or _f(r, "AvgD"),
        "away": _f(r, "MaxA") or _f(r, "AvgA"),
        "close_home": _f(r, "AvgCH"),
        "close_draw": _f(r, "AvgCD"),
        "close_away": _f(r, "AvgCA"),
        # totals: best (Max) entry price + closing avg for CLV
        "over": _f(r, "Max>2.5") or _f(r, "Avg>2.5"),
        "under": _f(r, "Max<2.5") or _f(r, "Avg<2.5"),
        "close_over": _f(r, "AvgC>2.5"),
        "close_under": _f(r, "AvgC<2.5"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2019,2020,2021,2022,2023,2024,2025",
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
            odds_by_id[m.id] = {"home": None, "draw": None, "away": None,
                                "close_home": None, "close_draw": None, "close_away": None}

    if not all_matches:
        print("[fetch] no data fetched", file=sys.stderr)
        return 1

    # Attach market extras (opening/closing/spread) + backtest odds by id.
    for code, rows in all_rows.items():
        for r in rows:
            try:
                hg, ag = int(r.get("FTHG")), int(r.get("FTAG"))
            except (TypeError, ValueError):
                continue
            try:
                day = _dt.strptime(r.get("Date", ""), "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                continue
            mid = f"{code.lower()}-{day}-{r['HomeTeam']}-{r['AwayTeam']}"
            if mid in odds_by_id:
                odds_by_id[mid] = _odds_summary(r)
            for m in all_matches:
                if m.id == mid:
                    m.market = _market_extras(r)
                    m.odds = _odds_summary(r)
                    break

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    path = os.path.join(ROOT, "data", "historical.json")
    with open(path, "w") as fh:
        json.dump(matches_to_dict(all_matches), fh, indent=2)
    with open(os.path.join(ROOT, "data", "historical_odds.json"), "w") as fh:
        json.dump(odds_by_id, fh, indent=2)

    print(f"[fetch] wrote {len(all_matches)} matches -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
