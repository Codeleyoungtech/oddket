#!/usr/bin/env python3
"""Derive Double Chance 12 (home OR away wins — no draw) predictions.

DC12 needs NO new model: it is the sum of the calibrated home + away
probabilities from the existing h2h model. Bookmaker DC12 odds are derived
from the same fixture's h2h book (books construct DC12 from their own 1X2
prices), so the EV engine can compare model P12 vs the book's implied P12
using the h2h snapshots it already stores.

Emits rows in the shape POST /api/predictions/ingest expects:
    {"fixtureId", "market": "dc12", "selection": "12",
     "probability", "confidenceLow", "confidenceHigh", "modelVersion"}

Usage:
    python3 scripts/predict_dc12.py --fixtures data/fixtures.json --h2h output/predictions.json --output data/dc12_predictions.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", required=True, help="fixtures.json (worker export shape)")
    ap.add_argument("--h2h", required=True, help="h2h predictions.json from predict.py")
    ap.add_argument("--output", required=True, help="output JSON path")
    args = ap.parse_args()

    with open(args.h2h) as f:
        h2h_preds = json.load(f)

    # Group h2h predictions by fixture: {fixtureId: {home, draw, away}}
    by_fx: dict[str, dict[str, float]] = {}
    for p in h2h_preds:
        if p.get("market") != "h2h":
            continue
        by_fx.setdefault(p["fixtureId"], {})[p["selection"]] = p["probability"]

    with open(args.fixtures) as f:
        fixtures = json.load(f)
    if isinstance(fixtures, dict):
        fixtures = fixtures.get("matches") or fixtures.get("fixtures") or []

    predictions = []
    skipped = 0
    for fx in fixtures:
        fid = fx.get("id") or fx.get("fixture_id", "")
        probs = by_fx.get(fid)
        if not probs or not (probs.get("home") and probs.get("away") and probs.get("draw")):
            skipped += 1
            continue
        ph, pa, pd = probs["home"], probs["away"], probs["draw"]
        total = ph + pa + pd
        if total <= 0:
            skipped += 1
            continue
        # Renormalize (calibrated h2h already sums ~1, but be safe).
        ph, pa, pd = ph / total, pa / total, pd / total
        p12 = ph + pa
        p12 = max(0.01, min(0.99, p12))
        # Confidence band: propagate the widest h2h CI for the summed legs.
        lo_h = next((p.get("confidenceLow", 0) for p in h2h_preds
                     if p.get("fixtureId") == fid and p.get("selection") == "home"), 0)
        lo_a = next((p.get("confidenceLow", 0) for p in h2h_preds
                     if p.get("fixtureId") == fid and p.get("selection") == "away"), 0)
        hi_h = next((p.get("confidenceHigh", 1) for p in h2h_preds
                     if p.get("fixtureId") == fid and p.get("selection") == "home"), 1)
        hi_a = next((p.get("confidenceHigh", 1) for p in h2h_preds
                     if p.get("fixtureId") == fid and p.get("selection") == "away"), 1)
        version = next((p.get("modelVersion", "h2h-xgb-v3") for p in h2h_preds
                        if p.get("fixtureId") == fid), "h2h-xgb-v3")
        predictions.append({
            "fixtureId": fid,
            "market": "dc12",
            "selection": "12",
            "probability": round(p12, 4),
            "confidenceLow": round(max(0.0, lo_h + lo_a), 4),
            "confidenceHigh": round(min(1.0, hi_h + hi_a), 4),
            "modelVersion": f"{version}-dc12",
        })

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(predictions, fh, indent=2)
    print(f"[predict] {len(fixtures)} fixtures -> {len(predictions)} dc12 predictions (skipped {skipped}) -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())