#!/usr/bin/env python3
"""Multi-league historical data downloader.

Downloads real match-level statistics (results, corners, shots, fouls, cards, odds)
for:
1. Tier 1-4 European Leagues (EPL, Championship, League 1/2, Bundesliga 1/2, La Liga 1/2, Serie A/B, Super Lig)
2. Global Leagues (Japan J-League, Norway, Sweden, USA MLS, Brazil Serie A, Argentina, Mexico)

Saves clean CSVs to footballdata/ and model/data/corners/ for immediate model training.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(ROOT)
FOOTBALLDATA_DIR = os.path.join(PROJECT_ROOT, "footballdata")
CORNERS_DATA_DIR = os.path.join(ROOT, "data", "corners")

os.makedirs(FOOTBALLDATA_DIR, exist_ok=True)
os.makedirs(CORNERS_DATA_DIR, exist_ok=True)

SEASONS_MAP = {
    "1516": "2015_16",
    "1617": "2016_17",
    "1718": "2017_18",
    "1819": "2018_19",
    "1920": "2019_20",
    "2021": "2020_21",
    "2122": "2021_22",
    "2223": "2022_23",
    "2324": "2023_24",
    "2425": "2024_25",
    "2526": "2025_26",
}

EURO_LEAGUES = {
    "E0": "EPL",
    "E1": "Championship",
    "E2": "LeagueOne",
    "E3": "LeagueTwo",
    "D1": "Bundesliga",
    "D2": "Bundesliga2",
    "SP1": "LaLiga",
    "SP2": "Segunda",
    "I1": "SerieA",
    "I2": "SerieB",
    "F1": "Ligue1",
    "F2": "Ligue2",
    "N1": "Eredivisie",
    "B1": "BelgianPro",
    "P1": "PrimeiraLiga",
    "T1": "SuperLig",
    "SC0": "ScottishPrem",
}

GLOBAL_LEAGUES = {
    "JPN": "Japan_JLeague",
    "NOR": "Norway_Eliteserien",
    "SWE": "Sweden_Allsvenskan",
    "USA": "USA_MLS",
    "BRA": "Brazil_SerieA",
    "ARG": "Argentina_Primera",
    "MEX": "Mexico_LigaMX",
    "POL": "Poland_Ekstraklasa",
    "DNK": "Denmark_Superliga",
    "AUT": "Austria_Bundesliga",
    "SWZ": "Swiss_SuperLeague",
    "FIN": "Finland_Veikkausliiga",
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}


def download_file(url: str, dest_path: str) -> bool:
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as resp:
            content = resp.read()
        if len(content) < 500 or b"<html" in content[:200].lower():
            return False
        with open(dest_path, "wb") as f:
            f.write(content)
        return True
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description="Download multi-league football data")
    parser.add_argument("--global-only", action="store_true", help="Download only global/summer leagues")
    parser.add_argument("--euro-only", action="store_true", help="Download only European divisions")
    args = parser.parse_args()

    print("=================================================================")
    print("  OddKet Multi-League Historical Data Ingestion Engine")
    print("=================================================================")

    downloaded = 0
    failed = 0

    if not args.euro_only:
        print("\n[1/2] Fetching Global / Summer Leagues (J-League, Scandinavia, MLS, Brazil)...")
        for code, name in GLOBAL_LEAGUES.items():
            url = f"https://www.football-data.co.uk/new/{code}.csv"
            dest = os.path.join(CORNERS_DATA_DIR, f"{code}_all.csv")
            print(f"  --> Fetching {name} ({code})... ", end="", flush=True)
            success = download_file(url, dest)
            if success:
                size_kb = os.path.getsize(dest) / 1024
                print(f"SUCCESS ({size_kb:.1f} KB)")
                downloaded += 1
            else:
                print("SKIPPED / UNAVAILABLE")
                failed += 1
            time.sleep(0.3)

    if not args.global_only:
        print("\n[2/2] Fetching European Tier 1-4 Divisions (Championship, Segunda, Serie B, 2. Bundesliga)...")
        for code, name in EURO_LEAGUES.items():
            for s_code, s_name in SEASONS_MAP.items():
                url = f"https://www.football-data.co.uk/mmz4281/{s_code}/{code}.csv"
                dest_corners = os.path.join(CORNERS_DATA_DIR, f"{code}_{s_name}.csv")
                dest_root = os.path.join(FOOTBALLDATA_DIR, f"{code}_{s_name}.csv")
                
                if os.path.exists(dest_corners) and os.path.getsize(dest_corners) > 1000:
                    continue

                success = download_file(url, dest_corners)
                if success:
                    try:
                        with open(dest_corners, "rb") as sf, open(dest_root, "wb") as df:
                            df.write(sf.read())
                    except Exception:
                        pass
                    print(f"  --> Downloaded {name} ({code}) {s_name}")
                    downloaded += 1
                    time.sleep(0.2)
                else:
                    failed += 1

    print("\n=================================================================")
    print(f"  Ingestion Finished: {downloaded} new files downloaded, {failed} unavailable.")
    print(f"  Data Stored in: {CORNERS_DATA_DIR}")
    print("=================================================================")


if __name__ == "__main__":
    main()
