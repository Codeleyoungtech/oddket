#!/usr/bin/env python3
"""Fetch historical match data from the football-data.org free tier.

Free tier gives you one competition (e.g. EPL) of recent results without a
token; a free token lifts rate limits. Output is converted into the same
synthetic JSON shape so train.py --source historical just works.

Usage:
    FD_TOKEN=your_token python3 scripts/fetch_historical.py [--competition PL]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://api.football-data.org/v4"


def fetch(competition: str, token: str | None) -> list[dict]:
    url = f"{BASE}/competitions/{competition}/matches?status=FINISHED&limit=300"
    req = urllib.request.Request(url)
    if token:
        req.add_header("X-Auth-Token", token)
    req.add_header("User-Agent", "OddKet/0.1")
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.loads(res.read().decode())
    return data.get("matches", [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--competition", default="PL")
    args = ap.parse_args()

    token = os.environ.get("FD_TOKEN")
    try:
        matches = fetch(args.competition, token)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch] failed: {exc}", file=sys.stderr)
        print("[fetch] the free tier may block anonymous calls — set FD_TOKEN for a free token", file=sys.stderr)
        return 1

    if not matches:
        print("[fetch] no matches returned", file=sys.stderr)
        return 1

    out = {
        "meta": {
            "source": f"football-data.org {args.competition}",
            "n_matches": len(matches),
            "description": "Real historical results; features are simplified strength estimates.",
        },
        "matches": [],
    }
    for m in matches:
        home, away = m["homeTeam"]["name"], m["awayTeam"]["name"]
        hs, as_ = m["score"].get("fullTime", {}).get("home"), m["score"].get("fullTime", {}).get("away")
        if hs is None or as_ is None:
            continue
        # Simplified strength proxy from recent form is out of scope here; use
        # a neutral prior so train.py runs, then improve with real features.
        out["matches"].append({
            "id": m["id"],
            "league": m["competition"]["name"],
            "home": home,
            "away": away,
            "home_goals": hs,
            "away_goals": as_,
            "features": {
                "home_strength": 0.5, "away_strength": 0.5, "home_adv": 1.0,
                "form_diff": 0.0, "exp_home": 1.35, "exp_away": 1.15,
            },
            "outcome": 0 if hs > as_ else (1 if hs == as_ else 2),
            "probs": {"home": 0.4, "draw": 0.27, "away": 0.33},
            "odds": {"home": 2.5, "draw": 3.4, "away": 2.9},
        })

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    path = os.path.join(ROOT, "data", "historical.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"[fetch] wrote {len(out['matches'])} matches -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
