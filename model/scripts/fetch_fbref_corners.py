#!/usr/bin/env python3
"""Scrape match-level corner data from FBref.

FBref blocks automated requests from cloud servers. Run this script
locally on your machine to download historical corner data.

Usage:
    python fetch_fbref_corners.py

Output:
    model/data/corners/fbref_{league}_{season}.csv

Requirements:
    pip install pandas lxml requests

Rate limit: FBref allows ~20 requests/minute. The script sleeps 4s between requests.
"""

import os
import sys
import time

import pandas as pd
import requests

# FBref league URLs and their competition IDs
LEAGUES = {
    "EPL": {"comp_id": 9, "name": "Premier-League"},
    "LaLiga": {"comp_id": 12, "name": "La-Liga"},
    "Bundesliga": {"comp_id": 20, "name": "Bundesliga"},
    "SerieA": {"comp_id": 11, "name": "Serie-A"},
    "Ligue1": {"comp_id": 13, "name": "Ligue-1"},
    "Eredivisie": {"comp_id": 23, "name": "Eredivisie"},
    "PrimeiraLiga": {"comp_id": 23, "name": "Primeira-Liga"},
}

# Seasons to fetch (FBref uses "YYYY-YYYY" format)
SEASONS = [
    "2013-2014", "2014-2015", "2015-2016", "2016-2017",
    "2017-2018", "2018-2019", "2019-2020", "2020-2021",
    "2021-2022", "2022-2023", "2023-2024", "2024-2025", "2025-2026",
]

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "corners")


def build_schedule_url(comp_id: int, season: str) -> str:
    """Build FBref match log URL for a specific season."""
    return (
        f"https://fbref.com/en/comps/{comp_id}/{season}/matchlogs/"
        f"{season}/schedule/{season.replace('-', '')}-Scores-and-Fixtures"
    )


def fetch_match_corners(session: requests.Session, comp_id: int, season: str) -> pd.DataFrame | None:
    """Fetch match-level corner data from FBref for one league/season."""
    url = build_schedule_url(comp_id, season)
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code == 403:
            print(f"  ⚠️  403 Forbidden — IP may be rate-limited. Wait a few minutes.")
            return None
        if resp.status_code != 200:
            print(f"  ❌ HTTP {resp.status_code}")
            return None

        # Parse HTML tables
        import io
        tables = pd.read_html(io.StringIO(resp.text))

        for table in tables:
            # Flatten multi-level columns
            if isinstance(table.columns, pd.MultiIndex):
                table.columns = ["_".join(str(c) for c in col) for col in table.columns]

            # Look for corner columns
            corner_cols = [c for c in table.columns if "CK" in c or "Performance_CK" in c]
            if not corner_cols:
                continue

            # Extract match data
            result = pd.DataFrame()
            result["date"] = table.get("Date", table.get("Match_Date", ""))
            result["home"] = table.get("Home", table.get("HomeTeam", ""))
            result["away"] = table.get("Away", table.get("AwayTeam", ""))
            result["score"] = table.get("Score", "")

            # Corner columns: usually "Performance_CK" or similar
            ck_col = corner_cols[0]
            # FBref sometimes splits corners into home/away in the match log
            # The "CK" column in match logs is usually total corners
            result["total_corners"] = pd.to_numeric(table[ck_col], errors="coerce")

            # Try to get home/away corners from match report columns
            hck = [c for c in table.columns if "HxCK" in c or "Home_CK" in c]
            ack = [c for c in table.columns if "xCK" in c and "Hx" not in c]
            if hck:
                result["home_corners"] = pd.to_numeric(table[hck[0]], errors="coerce")
            if ack:
                result["away_corners"] = pd.to_numeric(table[ack[0]], errors="coerce")

            # Drop rows with no data
            result = result.dropna(subset=["home", "away"])
            result = result[~result["home"].str.contains("Total|Average", na=False)]

            if len(result) > 10:
                return result

        print(f"  ⚠️  No corner columns found in tables")
        return None

    except Exception as e:
        print(f"  ❌ Error: {e}")
        return None


def main() -> int:
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    })

    # Hit homepage first to get cookies
    print("Warming up session...")
    session.get("https://fbref.com/en/", timeout=15)
    time.sleep(2)

    total_matches = 0
    for league, info in LEAGUES.items():
        for season in SEASONS:
            outfile = os.path.join(OUTPUT_DIR, f"fbref_{league}_{season.replace('-', '_')}.csv")
            if os.path.exists(outfile):
                print(f"  {league} {season}: already exists, skipping")
                continue

            print(f"Fetching {league} {season}...")
            df = fetch_match_corners(session, info["comp_id"], season)
            if df is not None and len(df) > 0:
                df.to_csv(outfile, index=False)
                print(f"  ✅ {len(df)} matches saved")
                total_matches += len(df)
            else:
                print(f"  ❌ No data")

            time.sleep(4)  # Rate limit: 20 req/min

    print(f"\nTotal: {total_matches} new matches downloaded")
    print(f"Files saved to: {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
