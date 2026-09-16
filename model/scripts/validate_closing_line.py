#!/usr/bin/env python3
"""Benchmark a shipped h2h model against the closing line.

This answers the only question that decides whether the model should be trusted:
on matches it has never seen, does its probability beat the market's own closing
price — and does it beat simply backing the bookmaker's favourite?

Every number is computed on the SAME matches for every competitor, because a
model and a market evaluated on different subsets cannot be compared at all.
The split mirrors train.py exactly (global sort by kickoff, 80/20 time cut), so
"holdout" means the same thing here as it does in training.

Usage:
    python3 scripts/validate_closing_line.py
    python3 scripts/validate_closing_line.py --model /tmp/h2h_model_before.joblib \
        --calibrator /tmp/h2h_calibrator_before.joblib --label before
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from features import history_path, load_matches_dict  # noqa: E402
from train import fill_market_features, multiclass_brier  # noqa: E402

CLASSES = ("home", "draw", "away")
ORIGINAL_LEAGUES = {"EPL", "Bundesliga", "La Liga", "Serie A"}


def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(p, 1e-12, 1.0)
    return float(-np.mean(np.log(p[np.arange(len(y)), y])))


def deoverround(odds: np.ndarray) -> np.ndarray:
    """(n,3) decimal odds -> (n,3) probabilities summing to 1."""
    inv = 1.0 / odds
    return inv / inv.sum(axis=1, keepdims=True)


def load_split(data_path: str):
    """Load exactly as train.py does: same loader, same market features, same cut.

    Using the raw JSON's stored `odd_*` / `move_*` values instead would compare
    the model against inputs it was never trained on — those columns are
    RECOMPUTED from the match's market extras by `fill_market_features`, and the
    values sitting in the file are not the ones the model saw.
    """
    matches = load_matches_dict(data_path)
    fill_market_features(matches, market="h2h")
    matches.sort(key=lambda m: m.ts)
    cut = int(len(matches) * 0.8)
    return matches[:cut], matches[cut:]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=history_path())
    ap.add_argument("--model", default=os.path.join(ROOT, "models", "h2h_model.joblib"))
    ap.add_argument("--meta", default=os.path.join(ROOT, "models", "model_meta.json"),
                    help="meta file whose `features` list describes the model")
    ap.add_argument("--label", default="model")
    args = ap.parse_args()

    from joblib import load

    # RAW model probabilities, deliberately — not the calibrator's output. The
    # shipped calibrator is a CalibratedClassifierCV, which embeds its OWN fitted
    # base estimator, so `calibrator.predict_proba` ignores whatever model you
    # point the script at and silently scores the calibrator's internal copy.
    # Two different models then produce byte-identical reports, which is exactly
    # how this bug announced itself. Comparing raw probabilities is also the
    # honest question: does the model itself beat the closing line?
    with open(args.meta) as fh:
        features = json.load(fh)["features"]

    train_m, holdout = load_split(args.data)
    if not holdout:
        print("[validate] empty holdout", file=sys.stderr)
        return 1

    # Closing line, where the file actually carries one. Everything below is
    # restricted to these matches so model and market see identical fixtures.
    keep = []
    for m in holdout:
        o = m.odds or {}
        cs = [o.get(f"close_{c}") for c in CLASSES]
        keep.append(all(v and v > 1.0 for v in cs))
    if sum(keep) < 100:
        print(f"[validate] only {sum(keep)} matches have closing odds — "
              f"cannot benchmark the market", file=sys.stderr)
        return 1

    picked = [m for m, k in zip(holdout, keep) if k]
    X = np.array([[m.features[f] for f in features] for m in picked], dtype=float)
    y = np.array([m.outcome for m in picked], dtype=int)
    close = np.array(
        [[(m.odds or {})[f"close_{c}"] for c in CLASSES] for m in picked], dtype=float)
    leagues = [m.league for m in picked]
    dates = [m.date for m in picked]

    model = load(args.model)
    raw = model.predict_proba(X)

    market = deoverround(close)
    # Base rate: the class distribution of the TRAINING split (what a model that
    # learned nothing but the label frequencies would predict).
    train_y = np.array([m.outcome for m in train_m], dtype=int)
    rates = np.bincount(train_y, minlength=3) / len(train_y)
    base = np.tile(rates, (len(y), 1))

    fav = np.zeros(len(y), dtype=int)
    for i in range(len(y)):
        fav[i] = int(np.argmax(market[i]))

    def row(name: str, p: np.ndarray, acc: float) -> str:
        return (f"  {name:22s} brier {multiclass_brier(y, p):.4f}   "
                f"logloss {log_loss(y, p):.4f}   accuracy {acc:.4f}")

    print(f"\n[{args.label}] holdout {len(y)} matches ({dates[0]} -> {dates[-1]})")
    print(row("base rate", base, float((np.argmax(base, axis=1) == y).mean())))
    print(row("closing line", market, float((fav == y).mean())))
    print(row(args.label, raw, float((np.argmax(raw, axis=1) == y).mean())))

    mb = multiclass_brier(y, market)
    rb = multiclass_brier(y, raw)
    print(f"  -> {args.label} vs closing line: Brier {rb - mb:+.4f} "
          f"({'BETTER' if rb < mb else 'worse'} than the market)")

    for group, sel in (("original 4 leagues", ORIGINAL_LEAGUES),
                       ("added 7 leagues", None)):
        if sel is None:
            idx = [i for i, lg in enumerate(leagues) if lg not in ORIGINAL_LEAGUES]
        else:
            idx = [i for i, lg in enumerate(leagues) if lg in sel]
        if len(idx) < 50:
            continue
        yi, ri, mi = y[idx], raw[idx], market[idx]
        print(f"  -- {group} (n={len(idx)}): {args.label} brier "
              f"{multiclass_brier(yi, ri):.4f} vs closing {multiclass_brier(yi, mi):.4f}"
              f"   accuracy {float((np.argmax(ri, axis=1) == yi).mean()):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
