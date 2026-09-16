#!/usr/bin/env python3
"""Name-resolution regression check.

Three properties, all of which have been broken at least once in this project and
none of which the model training runs would catch — they fail *silently* by
skipping a fixture or by quietly scoring one club as another.

  1. SELF-RESOLUTION. Every club in the history resolves to itself. If this
     breaks, some feed spelling is being folded onto the wrong club.

  2. PINNED SPELLINGS. A hand-checked list of real feed spellings maps to the
     club that is genuinely in the history. These are the cases that were
     measurably wrong: `Hull City` and `York City` were skipped as unresolvable
     while their clubs sat in the index, and `Peterborough United` /
     `Sheffield Wednesday` / `Sporting Gijon` needed word-level abbreviation.

  3. FORBIDDEN MAPPINGS. A club must never resolve to a *different* club. This
     is the property that caught the old 0.6-ratio fuzzy fallback in predict.py,
     which resolved Millwall -> Milan, Cesena FC -> Chelsea, Cardiff City ->
     Man City, Palermo -> Parma, Samsunspor -> Sampdoria, and folded the reserve
     side `Real Sociedad B` onto the first team. Each of those published a
     confident prediction built from another club's Elo and form.

Run directly (`python3 scripts/check_names.py`) or from CI. Exits non-zero with a
per-property report on failure.
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from corners_names import build_index  # noqa: E402
from train_corners_v5 import DATA_DIR, load_all_data  # noqa: E402

# Real feed spellings -> the club that is actually in the history. Every entry
# here is a case that was wrong at some point; a future edit that breaks one of
# them should fail loudly rather than quietly drop the fixture.
PINNED: dict[str, str] = {
    "West Ham United": "West Ham",
    "Hull City": "Hull",
    "York City": "York",
    "Queens Park Rangers": "QPR",
    "Peterborough United": "Peterboro",
    "Sheffield Wednesday": "Sheffield Weds",
    "West Bromwich Albion": "West Brom",
    "Sporting Gijon": "Sp Gijon",
    "Basaksehir": "Buyuksehyr",
    "Amed SK": "Amedspor",
    "Wolverhampton Wanderers": "Wolves",
    "Newcastle United": "Newcastle",
    "Doncaster Rovers": "Doncaster",
    "Stockport County FC": "Stockport",
    "Chesterfield FC": "Chesterfield",
    "Genclerbirligi SK": "Genclerbirligi",
    "Besiktas JK": "Besiktas",
    "Preston North End": "Preston",
    "Andorra CF": "Andorra",
    "Nottingham Forest": "Nott'm Forest",
    "Tottenham Hotspur": "Tottenham",
    "Brighton and Hove Albion": "Brighton",
    # Reserve side -> the reserve side, never the parent club.
    "Celta Fortuna": "Celta B",
    "Real Sociedad B": "Sociedad B",
}

# (feed spelling, club it must NOT resolve to). Same-club confusion, not typos.
FORBIDDEN: list[tuple[str, str]] = [
    ("Millwall", "Milan"),
    ("Cesena FC", "Chelsea"),
    ("Cardiff City", "Man City"),
    ("Lincoln City", "Man City"),
    ("Salford City", "Man City"),
    ("Swansea City", "Man City"),
    ("Oxford United", "Man United"),
    ("Cambridge United", "Man United"),
    ("Rotherham United", "Man United"),
    ("Barnsley", "Burnley"),
    ("Barnet", "Burnley"),
    ("Palermo", "Parma"),
    ("Vicenza", "Venezia"),
    ("Samsunspor", "Sampdoria"),
    ("Modena", "Monza"),
    ("Portsmouth", "Bournemouth"),
    ("Northampton Town", "Southampton"),
    ("Sheffield Wednesday", "Sheffield United"),
    ("Real Sociedad B", "Sociedad"),
    ("Celta Fortuna", "Celta"),
]


def main() -> int:
    matches = load_all_data(DATA_DIR)
    team_league: dict[str, str] = {}
    for m in matches:
        team_league[m.home] = m.league
        team_league[m.away] = m.league
    index = build_index(team_league)

    failures: list[str] = []

    # 1. Self-resolution.
    for club in team_league:
        got, _method = index.resolve(club, "")
        if got != club:
            failures.append(f"[self] {club!r} resolved to {got!r}")

    # 2. Pinned spellings.
    for feed, expected in PINNED.items():
        got, method = index.resolve(feed, "")
        if got != expected:
            failures.append(
                f"[pinned] {feed!r} -> {got!r} (expected {expected!r}) via {method}"
            )

    # 3. Forbidden mappings.
    for feed, forbidden in FORBIDDEN:
        got, method = index.resolve(feed, "")
        if got == forbidden:
            failures.append(
                f"[cross-club] {feed!r} resolved to {forbidden!r} via {method}"
            )

    total = len(team_league) + len(PINNED) + len(FORBIDDEN)
    if failures:
        print(f"[check-names] FAILED — {len(failures)} of {total} assertions",
              file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    print(f"[check-names] OK — {total} assertions "
          f"({len(team_league)} clubs self-resolve, "
          f"{len(PINNED)} pinned, {len(FORBIDDEN)} forbidden)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
