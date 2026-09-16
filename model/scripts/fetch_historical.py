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
import gzip
import io
import json
import os
import sys
import urllib.request
from datetime import datetime as _dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://www.football-data.co.uk/mmz4281"

# Canonical football-data.co.uk divisions. The first four are what the models
# used to train on; the rest are divisions the live odds feed ALREADY covers, so
# every fixture in them was being scored with no club data at all.
#
# Seasons before 2019/20 are deliberately absent: those files predate the
# Avg*/Max* odds columns (they carry Betbrain's BbAv*/BbMx* instead), so
# including them would train on matches with no odds features and then serve on
# matches where the model is given them.
LEAGUES = {
    "E0": "EPL", "E1": "Championship", "E2": "League One", "E3": "League Two",
    "D1": "Bundesliga", "D2": "2. Bundesliga",
    "SP1": "La Liga", "SP2": "Segunda",
    "I1": "Serie A", "I2": "Serie B",
    "T1": "Super Lig",
}

from features import build_multi_league_matches, matches_to_dict  # noqa: E402

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


def read_csv_local(path: str) -> list[dict]:
    """Same shape as fetch_csv, from a `<DIV>_<YYYY>_<YY>.csv` file on disk.

    Tolerant of the encoding quirks these files actually carry: a byte-order mark,
    and a stray non-breaking space sitting inside a numeric field, which strict
    decoding turns into a hard failure for the whole run.
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    text = text.replace("\u00a0", " ")
    return list(csv.DictReader(io.StringIO(text)))


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
    ap.add_argument("--seasons", default="2019,2020,2021,2022,2023,2024,2025,2026",
                    help="calendar-year season starts, comma-separated")
    ap.add_argument("--leagues", default=",".join(LEAGUES),
                    help="division codes, comma-separated")
    ap.add_argument("--local-dir", default=None,
                    help="read <DIV>_<YYYY>_<YY>.csv from this directory instead of "
                         "downloading, so the build needs no network")
    # Gzipped by default. The uncompressed history is 95 MB at 11 divisions and
    # the identical data gzips to 8.5 MB, which matters both for git history
    # (permanent) and for pushing over a metered connection. `history_path()` in
    # features.py resolves the file for every reader.
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "historical.json.gz"))
    args = ap.parse_args()

    years = [int(s) for s in args.seasons.split(",") if s.strip()]
    leagues = [l.strip().upper() for l in args.leagues.split(",") if l.strip()]
    # football-data's URL path uses the two-digit start/end pair ("1920"), while
    # the on-disk filename spells both years out ("E0_2019_20.csv").
    seasons = [f"{y % 100:02d}{(y + 1) % 100:02d}" for y in years]
    meta = {"source": "football-data.co.uk", "seasons": seasons, "leagues": leagues}

    all_rows: dict[str, list[dict]] = {code: [] for code in leagues}
    for year, season in zip(years, seasons):
        for code in leagues:
            rows: list[dict] | None = None
            if args.local_dir:
                path = os.path.join(
                    args.local_dir, f"{code}_{year}_{str(year + 1)[2:]}.csv")
                if not os.path.exists(path):
                    print(f"[fetch] {code} {year}: no local file at {path}", file=sys.stderr)
                    continue
                try:
                    rows = read_csv_local(path)
                except Exception as exc:  # noqa: BLE001
                    print(f"[fetch] {path}: failed: {exc}", file=sys.stderr)
                    continue
            else:
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

    all_matches = build_multi_league_matches(all_rows, LEAGUES)
    per_league: dict[str, int] = {}
    for m in all_matches:
        per_league[m.league] = per_league.get(m.league, 0) + 1
    for code in leagues:
        name = LEAGUES.get(code, code)
        print(f"[fetch] {name:14s} {per_league.get(name, 0):5d} matches", file=sys.stderr)

    if not all_matches:
        print("[fetch] no data fetched", file=sys.stderr)
        return 1

    # Attach market extras (opening/closing/spread) + backtest odds by id.
    # Indexed by id: this used to scan every match inside the row loop, which is
    # O(rows x matches). That was survivable at 10k rows and hopeless at 55k.
    by_id = {m.id: m for m in all_matches}
    with_odds = 0
    for code, rows in all_rows.items():
        for r in rows:
            try:
                int(r.get("FTHG")), int(r.get("FTAG"))
            except (TypeError, ValueError):
                continue
            try:
                day = _dt.strptime(r.get("Date", ""), "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                continue
            mid = f"{code.lower()}-{day}-{r['HomeTeam']}-{r['AwayTeam']}"
            m = by_id.get(mid)
            if m is None:
                continue
            summary = _odds_summary(r)
            m.market = _market_extras(r)
            m.odds = summary
            if summary.get("home"):
                with_odds += 1

    print(f"[fetch] {with_odds}/{len(all_matches)} matches carry usable odds "
          f"({100 * with_odds // max(1, len(all_matches))}%)", file=sys.stderr)

    # The separate `historical_odds.json` side-file is gone: every match already
    # carries `odds` inline, and nothing in the repo ever read the side-file —
    # it was 7.9 MB of committed weight with no consumer.
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    payload = matches_to_dict(all_matches)
    if args.out.endswith(".gz"):
        with gzip.open(args.out, "wt", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
    else:
        with open(args.out, "w") as fh:
            json.dump(payload, fh, indent=2)

    print(f"[fetch] wrote {len(all_matches)} matches -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
