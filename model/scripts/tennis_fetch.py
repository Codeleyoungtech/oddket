"""Fetch real historical ATP main-tour data from tennis-data.co.uk (free,
no signup) and build a leakage-free feature dataset.

tennis-data.co.uk per-tournament CSVs contain results + odds for the ATP main
tour (Grand Slams + Masters + 500s + smaller events). Columns used:
  Date, Series, Court, Surface, Round, Best of, Winner, Loser,
  WRank, LRank, W1..W5, L1..L5, Wsets, Lsets, Comment,
  B365W/B365L (Bet365), CBW/CBL, EXW/EXL, IWW/IWL, PSW/PSL (Pinnacle)

The file covers main-tour matches only (the tennis build's scope after the
Challenger pivot — see HANDOFF §11). Match-winner market only for V1.

IMPORTANT: opening/closing odds are NOT both present in this source (single
snapshot per book per match), so odds-MOVEMENT cannot be computed from
training data; cross-bookmaker SPREAD (max-min across books, incl. Pinnacle)
is available and is the market feature that carries over. Live odds movement
comes from the worker's snapshot history instead (see HANDOFF §11).

Usage:
    python3 scripts/tennis_fetch.py
    python3 scripts/tennis_fetch.py --tournaments ausopen,frenchopen,wimbledon,usopen,indianwells

Outputs:
    model/data/tennis_historical.json      — matches + team features + market extras
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
from datetime import datetime as _dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://www.tennis-data.co.uk"

# ATP main-tour tournaments (the scope after the Challenger pivot). Slugs are
# tennis-data.co.uk's per-tournament filenames. Expand as needed.
DEFAULT_TOURNAMENTS = [
    "ausopen", "frenchopen", "wimbledon", "usopen",          # Grand Slams
    "indianwells", "miami", "montecarlo", "madrid", "rome-tms",  # Masters 1000
    "canada", "cincinnati", "shanghai", "paris-tms", "montreal", "toronto",
    "barcelona", "dubai", "hamburg-tms", "halle", "munich",   # 500s
    "queens", "washington", "stuttgart-tms", "doha", "basel", "beijing",
]

# Bookmaker odds columns per player (winner = W, loser = L). Verified across
# all years 2019-2026: only B365 (soft) + PS/Pinnacle (sharp) are present per
# match, plus market-wide MaxW/L (best price across books) and AvgW/L.
BOOK_COLS = {
    "winner": ["B365W", "PSW"],
    "loser": ["B365L", "PSL"],
}
# Market-wide best price columns (max across all books) for entry pricing.
MAX_COLS = {"winner": "MaxW", "loser": "MaxL"}

SURFACE_MAP = {"Hard": "hard", "Clay": "clay", "Grass": "grass", "Carpet": "carpet"}


def fetch_csv(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "OddKetTennis/0.1"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    # tennis-data.co.uk files start with a few header rows before the column
    # header line. Find the real header (starts with "ATP,").
    text = data.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    header_idx = None
    for i, line in enumerate(lines):
        if line.startswith("ATP,") and "Winner" in line:
            header_idx = i
            break
    if header_idx is None:
        return []
    reader = csv.DictReader(io.StringIO("\n".join(lines[header_idx:])))
    return list(reader)


def _f(r: dict, key: str) -> float | None:
    v = r.get(key)
    if v is None or str(v).strip() == "" or str(v).strip() in ("-", "N/A"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _market_extras(r: dict) -> dict:
    """Per-outcome best odds + cross-book spread (Pinnacle + Bet365 + more)."""
    out = {}
    for side, cols in BOOK_COLS.items():
        books = [b for b in (_f(r, c) for c in cols) if b is not None]
        mx = _f(r, MAX_COLS[side])
        best = mx if mx is not None else (max(books) if books else None)
        out[side] = {"best": best, "books": books}
    return out


def _odds_summary(r: dict) -> dict:
    """Backtest odds summary: best available price per player (winner/loser
    side is resolved AFTER the fact by the model, so training sees raw books)."""
    w = _market_extras(r)
    return {
        "winner_best": w["winner"]["best"],
        "loser_best": w["loser"]["best"],
        "winner_books": w["winner"]["books"],
        "loser_books": w["loser"]["books"],
    }


def normalize_name(name: str) -> str:
    """Tennis-Data names: 'Sinner J.' -> 'Sinner'. Strip accents."""
    n = name.strip()
    n = re.sub(r"\s+[A-Za-z]\.$", "", n)  # trailing initials
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tournaments", default=",".join(DEFAULT_TOURNAMENTS),
                    help="comma-separated tennis-data.co.uk tournament slugs")
    ap.add_argument("--years", default="2019,2020,2021,2022,2023,2024,2025,2026",
                    help="years to fetch, comma-separated")
    args = ap.parse_args()

    tournaments = [t.strip() for t in args.tournaments.split(",") if t.strip()]
    years = [y.strip() for y in args.years.split(",") if y.strip()]
    meta = {"source": "tennis-data.co.uk", "tournaments": tournaments, "years": years}

    rows: list[dict] = []
    for year in years:
        for t in tournaments:
            url = f"{BASE}/{year}/{t}.csv"
            try:
                r = fetch_csv(url)
            except Exception as exc:  # noqa: BLE001
                print(f"[fetch] {year}/{t}: failed: {exc}", file=sys.stderr)
                continue
            if not r:
                print(f"[fetch] {year}/{t}: empty or no data", file=sys.stderr)
                continue
            for row in r:
                row["_tournament"] = t
                row["_year"] = year
            rows.extend(r)
            print(f"[fetch] {year}/{t}: {len(r)} rows")

    if not rows:
        print("[fetch] no data fetched", file=sys.stderr)
        return 1

    # Build match objects (chronological) with features + market extras.
    from tennis_features import build_tennis_matches, matches_to_dict  # noqa: E402

    matches = build_tennis_matches(rows, meta)
    for m in matches:
        # Attach market extras + backtest odds by match id.
        if m.market_raw is not None:
            m.market = _market_extras(m.market_raw)
            m.odds = _odds_summary(m.market_raw)

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    path = os.path.join(ROOT, "data", "tennis_historical.json")
    with open(path, "w") as fh:
        json.dump(matches_to_dict(matches, meta), fh, indent=2)

    print(f"[fetch] wrote {len(matches)} matches -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
