#!/usr/bin/env python3
"""Convert predict_corners_v6.py output into the worker /api/corners/ingest payload.

V6 output (model/data/corners_predictions.json):
    {"predictions": [{"fixture_id": "...",
                      "home_team_corners": {"expected": .., "sigma": .., "lines": {..}},
                      "away_team_corners": {...},
                      "total_corners":     {"expected": .., "sigma": .., "lines": {..}},
                      "has_odds": true, "league": "EPL"}, ...]}

Worker ingest expects an array of:
    {fixtureId, homeCorners, awayCorners, totalCorners,
     homeLines, awayLines, totalLines,
     sigmaHome, sigmaAway, sigmaTotal, hasOdds, league}

The line probabilities and sigmas are passed through rather than recomputed in
TypeScript. The app used to recompute them from hardcoded constants that had
drifted from the trainer's own metadata, so the numbers on screen were not the
numbers the model produced.

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
        tc = p.get("total_corners") or {}
        ingest.append({
            "fixtureId": fid,
            "homeCorners": hc.get("expected", 0.0),
            "awayCorners": ac.get("expected", 0.0),
            "totalCorners": tc.get("expected", 0.0),
            "homeLines": hc.get("lines") or {},
            "awayLines": ac.get("lines") or {},
            "totalLines": tc.get("lines") or {},
            "sigmaHome": hc.get("sigma"),
            "sigmaAway": ac.get("sigma"),
            "sigmaTotal": tc.get("sigma"),
            "hasOdds": bool(p.get("has_odds")),
            "league": p.get("league", ""),
        })

    json.dump(ingest, sys.stdout)
    print(
        f"Prepared {len(ingest)} corners for ingestion "
        f"({sum(1 for i in ingest if i['hasOdds'])} with real odds)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
