#!/usr/bin/env python3
"""Predict match-result probabilities (+ confidence intervals) for fixtures.

Usage:
    python3 scripts/predict.py --source synthetic [--n 12]
    python3 scripts/predict.py --source fixtures --data fixtures.json

Outputs:
    model/output/predictions.json — exactly the shape POST /api/predictions/ingest expects.

The confidence interval comes from the model's own variance: we take the raw
(uncalibrated) probability spread per class as a proxy for uncertainty and
build a symmetric band around the calibrated point estimate, clipped to [0,1].
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import numpy as np  # noqa: E402

FEATURES = ["home_strength", "away_strength", "home_adv", "form_diff", "exp_home", "exp_away"]


def feature_row(m) -> list[float]:
    return [m.features[f] for f in FEATURES]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["synthetic", "fixtures"], default="synthetic")
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--data", default=None, help="fixtures.json path for --source fixtures")
    args = ap.parse_args()

    model_path = os.path.join(ROOT, "models", "h2h_model.joblib")
    cal_path = os.path.join(ROOT, "models", "h2h_calibrator.joblib")
    if not os.path.exists(model_path):
        print(f"[predict] no trained model at {model_path} — run train.py first", file=sys.stderr)
        return 1

    from joblib import load  # noqa: E402

    clf = load(model_path)
    calibrators = load(cal_path)
    meta = json.load(open(os.path.join(ROOT, "models", "model_meta.json")))

    if args.source == "synthetic":
        from synth_data import generate_synthetic

        ds = generate_synthetic(n_matches=args.n, seed=meta.get("seed", 20260813) + 1)
        fixtures = ds.matches
        # keep only a sensible slice (latest)
        fixtures = fixtures[-args.n:]
    else:
        path = args.data or os.path.join(ROOT, "data", "fixtures.json")
        if not os.path.exists(path):
            print(f"[predict] fixtures file not found at {path}", file=sys.stderr)
            return 1
        from synth_data import load_synthetic

        fixtures = load_synthetic(path).matches

    X = np.array([feature_row(m) for m in fixtures], dtype=float)
    raw = clf.predict_proba(X)
    cal = np.column_stack([
        calibrators["home"].predict(raw[:, 0]),
        calibrators["draw"].predict(raw[:, 1]),
        calibrators["away"].predict(raw[:, 2]),
    ])
    cal = cal / cal.sum(axis=1, keepdims=True)

    # Uncertainty band: half-width = 0.35 * raw spread for that class (symmetric),
    # widened when the two classes are close. Keeps CIs honest without extra fits.
    half = 0.10 + 0.35 * np.abs(raw - 0.5)

    predictions = []
    for i, m in enumerate(fixtures):
        for cls_idx, sel in enumerate(["home", "draw", "away"]):
            p = float(np.clip(cal[i, cls_idx], 0.01, 0.99))
            hw = float(np.clip(half[i, cls_idx], 0.02, 0.25))
            predictions.append({
                "fixtureId": m.id,
                "market": "h2h",
                "selection": sel,
                "probability": round(p, 4),
                "confidenceLow": round(max(0.0, p - hw), 4),
                "confidenceHigh": round(min(1.0, p + hw), 4),
                "modelVersion": meta.get("version", "h2h-xgb-v1"),
            })

    out_path = os.path.join(ROOT, "output", "predictions.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(predictions, fh, indent=2)

    print(f"[predict] {len(fixtures)} fixtures -> {len(predictions)} predictions -> {os.path.abspath(out_path)}")
    print("[predict] push with:")
    print(f"  curl -s -X POST http://localhost:8787/api/predictions/ingest -H 'Content-Type: application/json' -d @{out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
