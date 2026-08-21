#!/usr/bin/env python3
"""Train the match-result model (home/draw/away) on REAL historical data.

Experiment harness for the accuracy-upgrade work. Feature groups are
selected with --features (comma-separated) so each candidate change is
backtested independently:
  base,elo_split,ew_form,rest,odds,move,spread

The split is TIME-ORDERED (first 80% train, newest 20% validate). Calibration
is fit on TRAIN with internal CV and applied to the holdout (no leakage):
sigmoid for multiclass h2h, isotonic for binary totals.

Outputs:
    model/models/h2h_model.joblib, h2h_calibrator.joblib
    model/output/calibration.json, model/output/backtest.json
    model/models/model_meta.json  — metrics + feature list
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import numpy as np  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV  # noqa: E402

from features import (  # noqa: E402
    FEATURE_GROUPS,
    load_matches_dict,
)

MODEL_VERSION_TAG = "h2h-xgb-v3"
OU_MODEL_VERSION_TAG = "ou-xgb-v3"
FALLBACK_TAG = "h2h-gbc-v3"
OU_FALLBACK_TAG = "ou-gbc-v3"


def load_clf(market: str = "h2h") -> tuple:
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05,
            subsample=0.85, colsample_bytree=0.85,
            eval_metric="mlogloss", n_jobs=-1, random_state=42,
        ), OU_MODEL_VERSION_TAG if market == "ou" else MODEL_VERSION_TAG
    except ImportError:
        print("[train] xgboost unavailable — falling back to sklearn GradientBoostingClassifier")
        from sklearn.ensemble import GradientBoostingClassifier

        return GradientBoostingClassifier(
            n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.85, random_state=42
        ), OU_FALLBACK_TAG if market == "ou" else FALLBACK_TAG


def multiclass_brier(y_true: np.ndarray, proba: np.ndarray) -> float:
    n = len(y_true)
    k = proba.shape[1]
    y_onehot = np.zeros((n, k))
    y_onehot[np.arange(n), y_true] = 1.0
    return float(np.mean(np.sum((proba - y_onehot) ** 2, axis=1)))


def brier_score(y_true: np.ndarray, proba: np.ndarray) -> float:
    if proba.shape[1] == 2:
        return float(np.mean((proba[:, 1] - y_true) ** 2))
    return multiclass_brier(y_true, proba)


def logit(p: float) -> float:
    return math.log(max(1e-6, min(1 - 1e-6, p)))


def fill_market_features(matches: list, market: str = "h2h") -> None:
    """Compute odds / move / spread features from each match's market extras.
    All values are known before kickoff (opening and closing odds are both
    published pre-match) — leakage-free.

    odd_* uses the BEST price (MaxH/MaxD/MaxA) — this is what a sharp bettor
    actually gets and what the live pipeline exports as "current best odds",
    so training and prediction see the same thing. For market='ou' the
    odd_over/odd_under features come from the totals market's best prices."""
    for m in matches:
        f = m.features
        mk = m.market or {}
        if market == "ou":
            ou = mk.get("ou") or {}
            inv_all = []
            for sel in ("over", "under"):
                o = (ou.get(sel) or {}).get("best")
                if not o or o <= 0:
                    o = (ou.get(sel) or {}).get("open")
                inv_all.append(1.0 / o if o and o > 0 else None)
            if all(v is not None for v in inv_all):
                s = sum(inv_all)
                impl = {k: v / s for k, v in zip(("over", "under"), inv_all)}
                f["odd_over"] = round(logit(impl["over"]), 4)
                f["odd_under"] = round(logit(impl["under"]), 4)
            continue
        inv_all = []
        for sel in ("home", "draw", "away"):
            o = (mk.get(sel) or {}).get("best")
            if not o or o <= 0:
                o = (mk.get(sel) or {}).get("open")
            if o and o > 0:
                inv_all.append(1.0 / o)
            else:
                inv_all.append(None)
        if all(v is not None for v in inv_all):
            s = sum(inv_all)
            impl = {k: v / s for k, v in zip(("home", "draw", "away"), inv_all)}
            f["odd_h"] = round(logit(impl["home"]), 4)
            f["odd_d"] = round(logit(impl["draw"]), 4)
            f["odd_a"] = round(logit(impl["away"]), 4)
        # odds movement: closing minus opening (in log-odds space)
        for sel, key in (("home", "move_h"), ("draw", "move_d"), ("away", "move_a")):
            op = (mk.get(sel) or {}).get("open")
            cl = (mk.get(sel) or {}).get("close")
            if op and op > 0 and cl and cl > 0:
                f[key] = round(logit(1.0 / cl) - logit(1.0 / op), 4)
        # cross-book spread: max minus min across books
        for sel, key in (("home", "spread_h"), ("draw", "spread_d"), ("away", "spread_a")):
            books = [b for b in (mk.get(sel) or {}).get("books", []) if b and b > 0]
            if len(books) >= 2:
                f[key] = round((max(books) - min(books)) / min(books), 4)


def calibrate_on_train(clf, X_tr, y_tr, X_te, cv: int = 3, n_classes: int = 3):
    """Calibration fitted on TRAIN (internal CV), applied to the holdout.

    - Binary (n_classes=2, ou market): isotonic regression — non-parametric,
      no shape assumptions, works well on binary with enough samples.
    - Multiclass (n_classes=3, h2h): sigmoid (Platt) — monotonic and smooth,
      avoids isotonic's over-extrapolation on sparse high-probability bins
      (which inflated draw to 65%+ nonsense on 3-class)."""
    method = "isotonic" if n_classes == 2 else "sigmoid"
    cccv = CalibratedClassifierCV(clf, method=method, cv=cv)
    cccv.fit(X_tr, y_tr)
    return cccv, cccv.predict_proba(X_tr), cccv.predict_proba(X_te), method


def odds_for_market(match, classes: list[str]) -> dict[str, float]:
    """Return only the odds columns belonging to this market.

    The historical summary also carries close_* and other-market odds. Including
    those in the normalization turns a 3-way football market into a fake 8-way
    market and massively overstates edge.
    """
    raw = match.odds or {}
    out: dict[str, float] = {}
    for sel in classes:
        v = raw.get(sel)
        if v and v > 1.0:
            out[sel] = float(v)
    return out


def calibration_bins(y_true: np.ndarray, proba: np.ndarray, classes: list[str]) -> tuple[list[dict], dict[str, list[dict]]]:
    """10-bin calibration view.

    Binary markets use the positive class only. Multiclass h2h uses every
    class probability as a one-vs-rest sample so home/draw/away calibration is
    visible instead of reporting draw-only bins.
    """
    def build(probs: np.ndarray, actuals: np.ndarray) -> list[dict]:
        bins = []
        for i in range(10):
            lo, hi = i / 10.0, (i + 1) / 10.0
            mask = (probs >= lo) & (probs < hi)
            cnt = int(mask.sum())
            bins.append({
                "bin": round(lo + 0.05, 2),
                "count": cnt,
                "predicted": round(float(probs[mask].mean()), 4) if cnt else 0.0,
                "actual": round(float(actuals[mask].mean()), 4) if cnt else 0.0,
            })
        return bins

    if len(classes) == 2:
        return build(proba[:, 1], (y_true == 1).astype(int)), {
            classes[1]: build(proba[:, 1], (y_true == 1).astype(int)),
        }

    y_onehot = np.zeros_like(proba)
    y_onehot[np.arange(len(y_true)), y_true] = 1
    overall = build(proba.ravel(), y_onehot.ravel())
    by_class = {
        label: build(proba[:, idx], (y_true == idx).astype(int))
        for idx, label in enumerate(classes)
    }
    return overall, by_class


def simulate_staking(test_m, proba_cal, bankroll: float = 10000.0,
                     kelly_fraction: float = 0.25, edge_min: float = 0.0,
                     max_odds: float = 0.0, min_odds: float = 0.0,
                     market: str = "h2h") -> dict:
    """Backtest with BEST-price entry + CLV measurement + optional odds band.

    max_odds/min_odds: restrict bets to a price band (0 = no restriction).
    The longshot-bleed diagnosis showed the model's +5% estimated edge is real
    on favorites (<=1.8: ROI +14%) but collapses to -36% on 6+ longshots, so
    restricting to a band is a strategy decision, not a data leak.

    market='ou': bets over/under 2.5 at best price, settled by total goals.
    proba_cal columns are [under, over] for ou (binary) — index 1 = over."""
    if market == "ou":
        classes = ["under", "over"]
        settle = lambda m, sel: (m.home_goals + m.away_goals > 2.5) == (sel == "over")
    else:
        classes = ["home", "draw", "away"]
        settle = lambda m, sel: m.outcome == classes.index(sel)
    n_bets = 0
    wins = 0
    staked = 0.0
    returned = 0.0
    edge_sum = 0.0
    clv_sum = 0.0
    clv_n = 0
    bank = bankroll
    peak = bankroll
    max_dd = 0.0
    bets_log = []

    for i, m in enumerate(test_m):
        o = odds_for_market(m, classes)
        if len(o) != len(classes):
            continue
        p = proba_cal[i]
        inv = {k: 1.0 / o[k] for k in classes}
        s = sum(inv.values())
        implied = {k: v / s for k, v in inv.items()}
        edges = {c: p[j] - implied[c] for j, c in enumerate(classes)}
        sel = max(edges, key=edges.get)
        if edges[sel] <= edge_min:
            continue
        odds = o[sel]
        if not odds or odds <= 1.0:
            continue
        # odds-band restriction (strategy filter, no leakage)
        if max_odds and odds > max_odds:
            continue
        if min_odds and odds < min_odds:
            continue
        b = odds - 1
        q = p[classes.index(sel)]
        kelly = (b * q - (1 - q)) / b if b > 0 else 0.0
        stake = min(bank * kelly_fraction * max(kelly, 0), bank * 0.05)
        if stake <= 0:
            continue
        n_bets += 1
        staked += stake
        won = settle(m, sel)
        wins += won
        returned += stake * odds if won else 0.0
        profit = stake * (odds - 1) if won else -stake
        bank += profit
        edge_sum += edges[sel]
        # CLV: entry price vs closing line. Positive = beat the market.
        close = (m.market or {}).get("ou", {}).get(sel, {}).get("close") if market == "ou" else (m.market or {}).get(sel, {}).get("close")
        clv = None
        if close and close > 0:
            entry_imp = 1.0 / odds
            close_imp = 1.0 / close
            clv = (close_imp - entry_imp) / entry_imp
            clv_sum += clv
            clv_n += 1
        peak = max(peak, bank)
        max_dd = max(max_dd, peak - bank)
        bets_log.append({
            "date": m.date, "league": m.league, "home": m.home, "away": m.away,
            "sel": sel, "odds": odds, "prob": round(q, 4), "edge": round(edges[sel], 4),
            "stake": round(stake, 2), "profit": round(profit, 2), "won": bool(won),
            "clvPct": round(clv * 100, 2) if clv is not None else None,
        })

    roi = (returned - staked) / staked if staked > 0 else 0.0
    return {
        "nBets": int(n_bets),
        "winRate": float(round(wins / n_bets, 4)) if n_bets else 0.0,
        "totalStaked": float(round(staked, 2)),
        "totalReturn": float(round(returned, 2)),
        "roiPct": float(round(roi * 100, 2)),
        "avgEdge": float(round(edge_sum / n_bets, 4)) if n_bets else 0.0,
        "avgClvPct": float(round(clv_sum / clv_n * 100, 2)) if clv_n else 0.0,
        "nClvMeasured": int(clv_n),
        "maxDrawdown": float(round(max_dd, 2)),
        "bets": bets_log,
        "entry": "best price (Max odds), fallback avg open",
        "market": market,
        "note": "Holdout backtest, edge>0, quarter Kelly, 5% cap. "
                "ROI>0 = real signal. avgClvPct>0 = beat the closing line.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["historical", "synthetic"], default="historical")
    ap.add_argument("--data", default=None, help="historical.json path")
    ap.add_argument("--seed", type=int, default=20260813)
    ap.add_argument("--market", choices=["h2h", "ou"], default="h2h",
                    help="h2h = match result (home/draw/away); ou = over/under 2.5 goals")
    ap.add_argument("--features", default=None,
                    help="comma-separated feature groups; defaults: h2h -> base,odds,move,ew_form,rest | "
                         "ou -> base,ou_odds,ew_form,rest")
    ap.add_argument("--edge-min", type=float, default=0.0, help="min edge for backtest")
    ap.add_argument("--max-odds", type=float, default=0.0, help="only bet selections at odds <= this (0=off)")
    ap.add_argument("--min-odds", type=float, default=0.0, help="only bet selections at odds >= this (0=off)")
    args = ap.parse_args()

    market = args.market
    if args.features:
        groups = [g.strip() for g in args.features.split(",") if g.strip()]
    else:
        groups = (["base", "odds", "move", "ew_form", "rest"] if market == "h2h"
                  else ["base", "ou_odds", "ew_form", "rest"])
    for g in groups:
        if g not in FEATURE_GROUPS:
            print(f"[train] unknown feature group '{g}'", file=sys.stderr)
            return 1
    if market == "ou" and ("move" in groups or "spread" in groups):
        print("[train] ou market doesn't support move/spread (totals closing/spread data is sparse)", file=sys.stderr)
        return 1
    features = [f for g in groups for f in FEATURE_GROUPS[g]]

    path = args.data or os.path.join(ROOT, "data", "historical.json")
    if not os.path.exists(path):
        print(f"[train] data not found at {path} — run fetch_historical.py first", file=sys.stderr)
        return 1
    matches = load_matches_dict(path)

    if len(matches) < 200:
        print(f"[train] only {len(matches)} matches — need at least 200", file=sys.stderr)
        return 1

    fill_market_features(matches, market=market)

    # TIME-ORDERED split. The data file is grouped by league (EPL, then
    # Bundesliga, then La Liga, then Serie A), so an unsorted slice would test
    # on a mix of old+new matches from one league — a cross-league test, not a
    # time test. Sort globally by kickoff time first (features are stored, so
    # sorting only changes the split, not the feature values).
    matches.sort(key=lambda m: m.ts)
    n = len(matches)
    cut = int(n * 0.8)
    train_m, test_m = matches[:cut], matches[cut:]
    print(f"[train] market={market} groups={groups} | features={len(features)}")
    print(f"[train] {len(train_m)} train (oldest) / {len(test_m)} holdout ({test_m[0].date} -> {test_m[-1].date})")

    def target(m):
        # NOTE: the ternary chain `1 if goals > 2.5 else 0 if market == "ou" else
        # outcome` used to corrupt h2h labels — any match with >2.5 goals got
        # labeled a draw (~70% of labels), so the model learned to predict draw
        # for everything while the corrupted metrics looked "great".
        if market == "ou":
            return 1 if m.home_goals + m.away_goals > 2.5 else 0
        return m.outcome

    X_tr = np.array([[m.features[f] for f in features] for m in train_m], dtype=float)
    y_tr = np.array([target(m) for m in train_m], dtype=int)
    X_te = np.array([[m.features[f] for f in features] for m in test_m], dtype=float)
    y_te = np.array([target(m) for m in test_m], dtype=int)

    clf, version = load_clf(market)
    clf.fit(X_tr, y_tr)

    # Calibration fitted on TRAIN (internal CV), applied to holdout.
    # Binary (ou) gets isotonic; multiclass (h2h) gets sigmoid.
    n_cls = 2 if market == "ou" else 3
    calibrator, _, proba_cal, calibration_method = calibrate_on_train(clf, X_tr, y_tr, X_te, n_classes=n_cls)
    if proba_cal.shape[1] != n_cls:
        print(f"[train] expected {n_cls} classes for {market}, got {proba_cal.shape[1]}", file=sys.stderr)
        return 1
    raw_brier = brier_score(y_te, clf.predict_proba(X_te))
    cal_brier = brier_score(y_te, proba_cal)
    acc = float((proba_cal.argmax(axis=1) == y_te).mean())

    backtest = simulate_staking(test_m, proba_cal, edge_min=args.edge_min,
                                max_odds=args.max_odds, min_odds=args.min_odds,
                                market=market)

    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump  # noqa: E402

    suffix = "" if market == "h2h" else "_ou"
    dump(clf, os.path.join(ROOT, "models", f"{('h2h' if market == 'h2h' else 'ou')}_model.joblib"))
    dump(calibrator, os.path.join(ROOT, "models", f"{('h2h' if market == 'h2h' else 'ou')}_calibrator.joblib"))

    classes = (["home", "draw", "away"] if market == "h2h" else ["under", "over"])
    meta = {
        "version": version,
        "market": market,
        "source": "football-data.co.uk EPL/Bundesliga/LaLiga/SerieA 2019-2026",
        "feature_groups": groups,
        "features": features,
        "n_train": len(train_m),
        "n_test": len(test_m),
        "holdout_range": f"{test_m[0].date} -> {test_m[-1].date}",
        "accuracy": round(acc, 4),
        "brier_raw": round(raw_brier, 4),
        "brier_calibrated": round(cal_brier, 4),
        "calibration_method": calibration_method,
        "backtest": backtest,
        "classes": classes,
        "seed": args.seed,
        "filters": {"edgeMin": args.edge_min, "maxOdds": args.max_odds or None,
                    "minOdds": args.min_odds or None},
    }
    with open(os.path.join(ROOT, "models", f"model_meta{suffix}.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    bins, class_bins = calibration_bins(y_te, proba_cal, classes)
    cal_out = {
        "model_version": version,
        "sample_size": int(len(y_te)),
        "brier": round(cal_brier, 4),
        "bins": bins,
        "class_bins": class_bins,
    }
    with open(os.path.join(ROOT, "output", f"calibration{suffix}.json"), "w") as fh:
        json.dump(cal_out, fh, indent=2)
    with open(os.path.join(ROOT, "output", f"backtest{suffix}.json"), "w") as fh:
        json.dump(backtest, fh, indent=2)

    print(f"[train] accuracy {acc:.3f} | brier raw {raw_brier:.4f} -> calibrated {cal_brier:.4f}")
    print(f"[train] backtest: {backtest['nBets']} bets, ROI {backtest['roiPct']:.2f}%, "
          f"win {backtest['winRate']:.1%}, CLV {backtest['avgClvPct']:.2f}%")
    print(f"[train] wrote models/ + output/calibration{suffix}.json + output/backtest{suffix}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
