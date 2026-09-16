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
    python3 scripts/corners_to_ingest.py --meta > /tmp/corners_validation.json

The `--meta` mode emits the model's honest holdout report (accuracy + claimed
vs. realized rate for every line) for `/api/corners/validation`. It is read
straight from `models/corners_meta.json`, so the accuracy on screen always
belongs to the model that is actually serving predictions.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_validation(meta: dict) -> dict:
    """Condense corners_meta.json into the payload the app displays.

    Only out-of-sample numbers are published: every figure below is measured on
    the chronological holdout the models never trained on (or, for the
    recalibration delta, on a half of that holdout the correction never saw).
    """
    def acc(key: str) -> dict:
        m = meta.get(f"{key}_metrics") or {}
        return {
            "mae": m.get("mae"),
            "naive_mae": m.get("naive_mae"),
            "skill_vs_naive": m.get("skill_vs_naive"),
            "r2": m.get("r2"),
            "bias": m.get("bias"),
            "residual_sigma": m.get("residual_sigma"),
        }

    lines: dict[str, list] = {}
    for key in ("home", "away", "total"):
        cal = ((meta.get("line_calibration") or {}).get(key) or {}).get("lines") or []
        rec = ((meta.get("probability_recalibration") or {}).get(key) or {}).get("lines") or {}
        out = []
        for row in cal:
            r = rec.get(str(row.get("line"))) or {}
            out.append({
                "line": row.get("line"),
                "claimed": row.get("claimed"),
                "actual": row.get("actual"),
                "error": row.get("error"),
                # Out-of-sample delta for the shape correction, when one shipped.
                "corrected": r.get("corrected"),
                "error_after": r.get("abs_error_after"),
                "error_before": r.get("abs_error_before"),
                "recalibrated": bool(r and (r.get("a") or 0.0) != 0.0),
            })
        lines[key] = out

    recal = {}
    for key in ("home", "away", "total"):
        r = (meta.get("probability_recalibration") or {}).get(key) or {}
        recal[key] = {
            "mean_abs_error_before": r.get("mean_abs_error_before"),
            "mean_abs_error_after": r.get("mean_abs_error_after"),
            "max_abs_error_before": r.get("max_abs_error_before"),
            "max_abs_error_after": r.get("max_abs_error_after"),
            "fit_n": r.get("fit_n"),
            "eval_n": r.get("eval_n"),
        }

    return {
        "modelVersion": meta.get("version"),
        "source": meta.get("source"),
        "lineMethod": meta.get("line_method"),
        "holdoutSize": meta.get("n_holdout"),
        "holdoutRange": meta.get("holdout_range"),
        "trainSize": meta.get("n_train"),
        "leagues": meta.get("leagues") or [],
        "accuracy": {k: acc(k) for k in ("home", "away", "total")},
        "lines": lines,
        "recalibration": recal,
        "totalModel": meta.get("total_model_comparison") or {},
        "teamLines": meta.get("team_lines") or [],
        "totalLines": meta.get("total_lines") or [],
    }


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--meta":
        with open(os.path.join(ROOT, "models", "corners_meta.json")) as f:
            meta = json.load(f)
        json.dump(build_validation(meta), sys.stdout)
        print(f"Prepared corner validation for {meta.get('version')}", file=sys.stderr)
        return 0

    if len(sys.argv) < 2:
        print("usage: corners_to_ingest.py <corners_predictions.json> | --meta", file=sys.stderr)
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
