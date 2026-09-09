#!/usr/bin/env python3
"""Convert predict_corners_v5.py output into the worker /api/corners/ingest payload.

V5 output (model/data/corners_predictions.json):
    {"predictions": [{"fixture_id": "...", "home_team_corners": {"expected": ...}, ...}]}

Worker ingest expects:
    [{"fixtureId": "...", "homeCorners": 5.8, "awayCorners": 4.1}, ...]

Usage:
    python3 scripts/corners_to_ingest.py data/corners_predictions.json > /tmp/corners_ingest.json
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: corners_to_ingest.py <corners_predictions.json>", file=sys.stderr)
        return 2
    with open(sys.argv[1]) as f:
        data = json.load(f)

    ingest = []
    for p in data.get("predictions", []):
        fid = p.get("fixture_id")
        if not fid:
            continue
        hc = p.get("home_team_corners") or {}
        ac = p.get("away_team_corners") or {}
        ingest.append({
            "fixtureId": fid,
            "homeCorners": hc.get("expected", 0.0),
            "awayCorners": ac.get("expected", 0.0),
        })

    json.dump(ingest, sys.stdout)
    print(f"Prepared {len(ingest)} corners for ingestion", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())