#!/usr/bin/env python3
"""Download football-data.co.uk season CSVs for the corner model.

The site serves every division and season from a predictable path:

    https://football-data.co.uk/mmz4281/<YYYY_YY>/<DIV>.csv

so nothing here needs a browser, a session, or an API key. Each file carries the
`HC` / `AC` corner columns the corner model is trained on, plus shots and odds.

Usage:
    python3 scripts/fetch_footballdata.py                 # all divisions, all seasons
    python3 scripts/fetch_footballdata.py --check          # report what is on disk, download nothing
    python3 scripts/fetch_footballdata.py --div E1 D2      # a subset of divisions
    python3 scripts/fetch_footballdata.py --season 2627    # a single season

Files are written to `footballdata/<DIV>_<YYYY_YY>.csv`, which is the naming
`load_all_data` in `train_corners_v5.py` resolves (`FILE_PREFIXES` maps the
division code onto the model's league name, so `E1_*` loads as "Championship").

Every download is verified before it is kept: the file must parse, must have
`HC` and `AC`, and must contain at least one row. A failed or truncated
download is retried and, if it still fails, reported rather than written — a
half-empty season file would silently poison the training history.

Re-run this each season (and mid-season for current form); it overwrites.

On a slow link a serial run takes half an hour, so downloads run a few at a time
(`--jobs`, default 4). A failed file is skipped and reported rather than written,
and re-running picks up only what is missing.
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, "footballdata")

BASE = "https://football-data.co.uk/mmz4281"

# Division codes, and the league each one loads as (must stay in step with
# FILE_PREFIXES in train_corners_v5.py).
DIVISIONS: dict[str, str] = {
    "E0": "EPL",
    "E1": "Championship",
    "E2": "League One",
    "E3": "League Two",
    "D1": "Bundesliga",
    "D2": "2. Bundesliga",
    "SP1": "La Liga",
    "SP2": "Segunda",
    "I1": "Serie A",
    "I2": "Serie B",
    "T1": "Super Lig",
}

# football-data.co.uk season codes: YYYY_YY, e.g. 1415 = 2014/15.
SEASONS = [
    "1415", "1516", "1617", "1718", "1819", "1920",
    "2021", "2122", "2223", "2324", "2425", "2526", "2627",
]

UA = "Mozilla/5.0 (X11; Linux x86_64) oddket-corner-model/1.0"


def season_label(code: str) -> str:
    """`1415` -> `2014_15`, which is the naming the loader expects."""
    return f"20{code[:2]}_{code[2:]}"


def fetch(url: str, attempts: int = 5, timeout: int = 60) -> bytes | None:
    """GET with backoff. The owner's link is slow, so a single failure means
    very little — retrying is the difference between a full history and a
    randomly-holed one."""
    delay = 2.0
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            if data:
                return data
            print(f"    empty body (attempt {attempt})", file=sys.stderr)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            print(f"    {type(e).__name__}: {e} (attempt {attempt})", file=sys.stderr)
        if attempt < attempts:
            time.sleep(delay)
            delay = min(delay * 2, 20.0)
    return None


def inspect(data: bytes) -> tuple[int, bool, bool]:
    """Return (rows, has_hc, has_ac) for a downloaded file, or (0, False, False)
    when it is not a usable CSV."""
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fields = reader.fieldnames or []
    has_hc = "HC" in fields
    has_ac = "AC" in fields
    rows = 0
    if has_hc and has_ac:
        for row in reader:
            if (row.get("HC") or "").strip():
                rows += 1
    return rows, has_hc, has_ac


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--div", nargs="*", default=None,
                    help=f"division codes, default all: {' '.join(DIVISIONS)}")
    ap.add_argument("--season", nargs="*", default=None,
                    help=f"season codes, default all: {' '.join(SEASONS)}")
    ap.add_argument("--check", action="store_true",
                    help="report what is already on disk and download nothing")
    ap.add_argument("--jobs", type=int, default=4,
                    help="concurrent downloads (default 4; the site is free, keep it polite)")
    ap.add_argument("--force", action="store_true",
                    help="re-download files that are already on disk")
    args = ap.parse_args()

    divs = [d.upper() for d in (args.div or list(DIVISIONS))]
    unknown = [d for d in divs if d not in DIVISIONS]
    if unknown:
        print(f"unknown division(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"known: {', '.join(DIVISIONS)}", file=sys.stderr)
        return 2
    seasons = args.season or SEASONS

    os.makedirs(OUT_DIR, exist_ok=True)

    if args.check:
        print(f"{'div':<5}{'league':<16}" + "".join(f"{s:>7}" for s in seasons))
        for div in divs:
            cells = []
            for s in seasons:
                path = os.path.join(OUT_DIR, f"{div}_{season_label(s)}.csv")
                cells.append("  ok" if os.path.exists(path) else "  --")
            print(f"{div:<5}{DIVISIONS[div]:<16}" + "".join(f"{c:>7}" for c in cells))
        return 0

    jobs = [(div, s) for div in divs for s in seasons]
    todo = []
    already = 0
    for div, s in jobs:
        name = f"{div}_{season_label(s)}.csv"
        if not args.force and os.path.exists(os.path.join(OUT_DIR, name)):
            already += 1
            continue
        todo.append((div, s))

    if already:
        print(f"{already} file(s) already on disk (use --force to re-download)")
    if not todo:
        print("nothing to do")
        return 0
    print(f"downloading {len(todo)} file(s), {args.jobs} at a time\n")

    def one(job: tuple[str, str]):
        div, s = job
        name = f"{div}_{season_label(s)}.csv"
        data = fetch(f"{BASE}/{s}/{div}.csv")
        if data is None:
            return ("failed", name, "unreachable", 0)
        rows, has_hc, has_ac = inspect(data)
        if not has_hc or not has_ac:
            return ("skipped", name, "no HC/AC — corners not published", 0)
        if rows == 0:
            return ("skipped", name, "no played matches yet", 0)
        with open(os.path.join(OUT_DIR, name), "wb") as f:
            f.write(data)
        return ("ok", name, DIVISIONS[div], rows)

    written: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for status, name, detail, rows in pool.map(one, todo):
            if status == "ok":
                written.append(name)
                print(f"  {name:<22} ok  {rows:>4} matches  {detail}")
            elif status == "skipped":
                skipped.append(f"{name} ({detail})")
                print(f"  {name:<22} SKIPPED ({detail})")
            else:
                failed.append(f"{name} ({detail})")
                print(f"  {name:<22} FAILED ({detail})")

    print()
    print(f"wrote {len(written)} file(s), skipped {len(skipped)}, failed {len(failed)}")
    print(f"now on disk: {len([f for f in os.listdir(OUT_DIR) if f.endswith('.csv')])} CSV file(s) in footballdata/")
    if skipped:
        print("skipped:")
        for s in skipped:
            print(f"  {s}")
    if failed:
        print("failed (re-run to retry just these):")
        for f_ in failed:
            print(f"  {f_}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
