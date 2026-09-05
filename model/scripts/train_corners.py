#!/usr/bin/env python3
"""Train per-team corner prediction model.

Predicts how many corners each team will win in a match.
Uses individual team corner totals (NOT match totals).

Features:
  - Team's home/away corner average (for and against), venue-filtered
  - Opponent's corners-conceded average, venue-filtered
  - Baseline: avg of team corner rate + opponent conceded rate
  - Recency-weighted form on corner counts
  - Shots / shots on target (proxy for attacking intent → corners)
  - Rest days, Elo strength proxy

Evaluation:
  - MAE (Mean Absolute Error) — how far off on average
  - R² — variance explained
  - Consistency % — predictions within ±1 corner of actual
  - Time-ordered backtest (80/20 split)

Outputs:
  model/models/corners_model.joblib
  model/models/corners_meta.json
  model/output/corners_backtest.json
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
FORM_WINDOW = 8          # last N matches for corner form
EW_DECAY = 0.85          # recency-weighted decay
LEAGUES = {
    "E0": "EPL", "E1": "Championship", "E2": "League 1", "E3": "League 2",
    "SP1": "La Liga", "SP2": "La Liga 2",
    "D1": "Bundesliga", "D2": "Bundesliga 2",
    "I1": "Serie A", "I2": "Serie B",
    "T1": "Super Lig",
}
SEASONS = ["2012", "2020", "2021"]  # seasons with corner data


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
@dataclass
class CornerMatch:
    id: str
    league: str
    season: str
    home: str
    away: str
    home_corners: int
    away_corners: int
    home_goals: int
    away_goals: int
    home_shots: int
    away_shots: int
    home_sot: int
    away_sot: int
    date: str
    ts: int
    features: dict = field(default_factory=dict)


class CornerTeamState:
    """Running state for corner-specific team stats."""
    __slots__ = ("corner_rate_home", "corner_rate_away",
                 "conceded_rate_home", "conceded_rate_away",
                 "corner_history", "shots_history", "last_ts",
                 "n_home", "n_away")

    def __init__(self):
        self.corner_rate_home: list[float] = []   # corners FOR at home
        self.corner_rate_away: list[float] = []   # corners FOR away
        self.conceded_rate_home: list[float] = []  # corners CONCEDED at home
        self.conceded_rate_away: list[float] = []  # corners CONCEDED away
        self.corner_history: list[tuple[float, bool]] = []  # (corners, is_home)
        self.shots_history: list[tuple[float, bool]] = []   # (shots, is_home)
        self.last_ts: int | None = None
        self.n_home: int = 0
        self.n_away: int = 0


def _parse_date(date_str: str) -> tuple[str, int]:
    """Parse DD/MM/YYYY to (YYYY-MM-DD, unix_ts)."""
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%d"), int(dt.timestamp())
        except ValueError:
            continue
    return "", 0


def load_corner_csv(path: str, league: str, season: str) -> list[CornerMatch]:
    """Load a single CSV and extract matches with corner data."""
    matches = []
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for i, r in enumerate(reader):
            hc = r.get("HC", "").strip()
            ac = r.get("AC", "").strip()
            if not hc.isdigit() or not ac.isdigit():
                continue
            date_str, ts = _parse_date(r.get("Date", ""))
            if not ts:
                continue
            matches.append(CornerMatch(
                id=f"corners-{league}-{season}-{i}",
                league=league,
                season=season,
                home=r["HomeTeam"].strip(),
                away=r["AwayTeam"].strip(),
                home_corners=int(hc),
                away_corners=int(ac),
                home_goals=int(r.get("FTHG", 0) or 0),
                away_goals=int(r.get("FTAG", 0) or 0),
                home_shots=int(r.get("HS", 0) or 0),
                away_shots=int(r.get("AS", 0) or 0),
                home_sot=int(r.get("HST", 0) or 0),
                away_sot=int(r.get("AST", 0) or 0),
                date=date_str,
                ts=ts,
            ))
    return matches


def load_all_corners(data_dir: str) -> list[CornerMatch]:
    """Load corner data from all leagues and seasons."""
    all_matches = []
    for code, name in LEAGUES.items():
        for season in SEASONS:
            path = os.path.join(data_dir, f"{code}_{season}.csv")
            if os.path.exists(path):
                ms = load_corner_csv(path, name, season)
                all_matches.extend(ms)
                print(f"  {name} {season}: {len(ms)} matches with corners")
    all_matches.sort(key=lambda m: m.ts)
    return all_matches


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------
def _avg(lst: list[float], n: int = 0) -> float:
    window = lst[-n:] if n > 0 else lst
    return sum(window) / len(window) if window else 5.5  # league avg prior


def _ew_avg(values: list[float], decay: float = EW_DECAY) -> float:
    if not values:
        return 5.5  # league average prior
    w = 0.0
    total = 0.0
    for i, v in enumerate(values):
        weight = decay ** (len(values) - 1 - i)
        w += weight * v
        total += weight
    return w / total if total > 0 else 5.5


def compute_corners_features(home_state: CornerTeamState, away_state: CornerTeamState,
                              home: str, away: str, ts: int) -> dict:
    """Feature vector for predicting per-team corner counts."""
    # Team's corner rate (venue-filtered)
    home_corners_for_home = _avg(home_state.corner_rate_home, FORM_WINDOW)
    away_corners_for_away = _avg(away_state.corner_rate_away, FORM_WINDOW)

    # Opponent's corners conceded (venue-filtered)
    # Home team concedes corners at home; away team concedes corners away
    home_conceded_at_home = _avg(home_state.conceded_rate_home, FORM_WINDOW)
    away_conceded_away = _avg(away_state.conceded_rate_away, FORM_WINDOW)

    # Baseline: avg of team's rate + opponent's conceded rate
    home_baseline = (home_corners_for_home + away_conceded_away) / 2.0
    away_baseline = (away_corners_for_away + home_conceded_at_home) / 2.0

    # Recency-weighted form on corner counts
    home_ew_corners = _ew_avg([c for c, _ in home_state.corner_history[-FORM_WINDOW:]])
    away_ew_corners = _ew_avg([c for c, _ in away_state.corner_history[-FORM_WINDOW:]])

    # Overall corner averages (venue-agnostic)
    home_overall_avg = _avg(home_state.corner_rate_home + home_state.corner_rate_away)
    away_overall_avg = _avg(away_state.corner_rate_away + away_state.corner_rate_away)

    # Shots (proxy for attacking intent → corners)
    home_shots_avg = _avg([s for s, _ in home_state.shots_history[-FORM_WINDOW:]])
    away_shots_avg = _avg([s for s, _ in away_state.shots_history[-FORM_WINDOW:]])

    # Rest days
    home_rest = max(0, (ts - home_state.last_ts) // 86400) if home_state.last_ts else 14
    away_rest = max(0, (ts - away_state.last_ts) // 86400) if away_state.last_ts else 14

    # Sample size (number of matches played)
    home_n = len(home_state.corner_history)
    away_n = len(away_state.corner_history)

    return {
        # Core corner features
        "home_corners_for": round(home_corners_for_home, 4),
        "away_corners_for": round(away_corners_for_away, 4),
        "home_conceded": round(home_conceded_at_home, 4),
        "away_conceded": round(away_conceded_away, 4),
        "home_baseline": round(home_baseline, 4),
        "away_baseline": round(away_baseline, 4),
        "home_ew_corners": round(home_ew_corners, 4),
        "away_ew_corners": round(away_ew_corners, 4),
        "home_overall_avg": round(home_overall_avg, 4),
        "away_overall_avg": round(away_overall_avg, 4),
        # Shots (proxy)
        "home_shots": round(home_shots_avg, 4),
        "away_shots": round(away_shots_avg, 4),
        "shots_diff": round(home_shots_avg - away_shots_avg, 4),
        # Rest
        "home_rest": float(home_rest),
        "away_rest": float(away_rest),
        "rest_diff": float(home_rest - away_rest),
        # Sample size (confidence proxy)
        "home_n": float(min(home_n, 30)),
        "away_n": float(min(away_n, 30)),
    }


FEATURE_NAMES = [
    "home_corners_for", "away_corners_for",
    "home_conceded", "away_conceded",
    "home_baseline", "away_baseline",
    "home_ew_corners", "away_ew_corners",
    "home_overall_avg", "away_overall_avg",
    "home_shots", "away_shots", "shots_diff",
    "home_rest", "away_rest", "rest_diff",
    "home_n", "away_n",
]


def build_dataset(matches: list[CornerMatch]) -> tuple[list[CornerMatch], list[dict], list[int], list[int]]:
    """Build feature matrix and targets from chronological match list.
    
    Returns (matches, features, home_targets, away_targets).
    Each match produces TWO rows: one for home team corners, one for away.
    """
    teams: dict[str, CornerTeamState] = {}
    X_home = []
    y_home = []
    X_away = []
    y_away = []
    valid_matches = []

    for m in matches:
        hs = teams.setdefault(m.home, CornerTeamState())
        as_ = teams.setdefault(m.away, CornerTeamState())

        features = compute_corners_features(hs, as_, m.home, m.away, m.ts)
        m.features = features

        # Home team row
        X_home.append([features[f] for f in FEATURE_NAMES])
        y_home.append(m.home_corners)

        # Away team row
        X_away.append([features[f] for f in FEATURE_NAMES])
        y_away.append(m.away_corners)

        valid_matches.append(m)

        # Update state AFTER the match
        hs.corner_rate_home.append(m.home_corners)
        hs.conceded_rate_home.append(m.away_corners)
        hs.corner_history.append((m.home_corners, True))
        hs.shots_history.append((m.home_shots, True))
        hs.last_ts = m.ts

        as_.corner_rate_away.append(m.away_corners)
        as_.conceded_rate_away.append(m.home_corners)
        as_.corner_history.append((m.away_corners, False))
        as_.shots_history.append((m.away_shots, False))
        as_.last_ts = m.ts

    return valid_matches, X_home, y_home, X_away, y_away


# ---------------------------------------------------------------------------
# Model training and evaluation
# ---------------------------------------------------------------------------
def train_and_evaluate(X_train, y_train, X_test, y_test, match_type: str = "home"):
    """Train XGBoost regressor and evaluate."""
    try:
        from xgboost import XGBRegressor
        model = XGBRegressor(
            n_estimators=500, max_depth=5, learning_rate=0.03,
            subsample=0.8, colsample_bytree=0.8,
            reg_alpha=0.1, reg_lambda=1.0,
            min_child_weight=5,
            n_jobs=-1, random_state=42,
        )
        version = "corners-xgb-v2"
    except ImportError:
        from sklearn.ensemble import GradientBoostingRegressor
        model = GradientBoostingRegressor(
            n_estimators=500, max_depth=5, learning_rate=0.03,
            subsample=0.8, random_state=42,
        )
        version = "corners-gbr-v2"

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    # Metrics
    mae = float(np.mean(np.abs(y_pred - y_test)))
    rmse = float(np.sqrt(np.mean((y_pred - y_test) ** 2)))
    ss_res = np.sum((y_test - y_pred) ** 2)
    ss_tot = np.sum((y_test - np.mean(y_test)) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    # Consistency: % within ±1 corner
    within_1 = float(np.mean(np.abs(y_pred - y_test) <= 1.0))
    within_05 = float(np.mean(np.abs(y_pred - y_test) <= 0.5))

    # Brier-like score for corner bins (binned into under/over lines)
    # Check accuracy for common corner lines
    line_results = {}
    for line in [3.5, 4.5, 5.5, 6.5, 7.5]:
        pred_over = (y_pred > line).astype(float)
        actual_over = (y_test > line).astype(float)
        accuracy = float(np.mean(pred_over == actual_over))
        line_results[f"over_{line}"] = round(accuracy, 4)

    # Feature importance
    if hasattr(model, "feature_importances_"):
        importance = dict(zip(FEATURE_NAMES, [round(float(x), 4) for x in model.feature_importances_]))
    else:
        importance = {}

    print(f"  [{match_type}] MAE={mae:.3f} | RMSE={rmse:.3f} | R²={r2:.4f} | "
          f"within±1={within_1:.1%} | within±0.5={within_05:.1%}")

    return model, {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "consistency_1": round(within_1, 4),
        "consistency_05": round(within_05, 4),
        "line_accuracy": line_results,
        "feature_importance": importance,
        "version": version,
    }


# ---------------------------------------------------------------------------
# Backtest
# ---------------------------------------------------------------------------
def corner_backtest(matches, y_pred_home, y_pred_away):
    """Honest backtest: predict each team's corner count and measure accuracy."""
    bets = []
    for i, m in enumerate(matches):
        pred_h = y_pred_home[i]
        pred_a = y_pred_away[i]
        actual_h = m.home_corners
        actual_a = m.away_corners
        error_h = abs(pred_h - actual_h)
        error_a = abs(pred_a - actual_a)

        bets.append({
            "date": m.date,
            "league": m.league,
            "home": m.home,
            "away": m.away,
            "pred_home_corners": round(float(pred_h), 2),
            "pred_away_corners": round(float(pred_a), 2),
            "actual_home_corners": actual_h,
            "actual_away_corners": actual_a,
            "error_home": round(float(error_h), 2),
            "error_away": round(float(error_a), 2),
            "total_pred": round(float(pred_h + pred_a), 2),
            "total_actual": actual_h + actual_a,
        })

    all_errors = [b["error_home"] for b in bets] + [b["error_away"] for b in bets]
    total_preds = [b["total_pred"] for b in bets]
    total_actuals = [b["total_actual"] for b in bets]
    total_errors = [abs(p - a) for p, a in zip(total_preds, total_actuals)]

    # 70% consistency rule: % of predictions within ±1 corner
    within_1_home = sum(1 for b in bets if b["error_home"] <= 1.0) / len(bets)
    within_1_away = sum(1 for b in bets if b["error_away"] <= 1.0) / len(bets)
    within_1_total = sum(1 for e in total_errors if e <= 1.5) / len(bets)

    # Line accuracy: can we predict over/under 4.5 corners for a team?
    line_accuracy = {}
    for line in [3.5, 4.5, 5.5, 6.5]:
        home_correct = sum(1 for b in bets
                          if (b["pred_home_corners"] > line) == (b["actual_home_corners"] > line))
        away_correct = sum(1 for b in bets
                          if (b["pred_away_corners"] > line) == (b["actual_away_corners"] > line))
        line_accuracy[f"team_over_{line}"] = round((home_correct + away_correct) / (2 * len(bets)), 4)

    return {
        "nMatches": len(bets),
        "home_mae": round(float(np.mean([b["error_home"] for b in bets])), 4),
        "away_mae": round(float(np.mean([b["error_away"] for b in bets])), 4),
        "total_mae": round(float(np.mean(total_errors)), 4),
        "home_consistency": round(within_1_home, 4),
        "away_consistency": round(within_1_away, 4),
        "total_consistency": round(within_1_total, 4),
        "line_accuracy": line_accuracy,
        "avg_pred_corners": round(float(np.mean(total_preds)), 2),
        "avg_actual_corners": round(float(np.mean(total_actuals)), 2),
        "note": "Time-ordered 80/20 split. MAE = avg absolute error in corners. "
                "consistency = % within ±1 corner (target: ≥70%). "
                "line_accuracy = % correctly predicting over/under a given line.",
        "bets": bets,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data", "corners"))
    ap.add_argument("--seed", type=int, default=20260829)
    args = ap.parse_args()

    print("[corners] Loading historical corner data...")
    matches = load_all_corners(args.data_dir)
    print(f"[corners] Total: {len(matches)} matches across {len(LEAGUES)} leagues\n")

    if len(matches) < 200:
        print(f"[corners] Only {len(matches)} matches — need at least 200", file=sys.stderr)
        return 1

    # Build features and targets
    print("[corners] Building features...")
    valid_matches, X_home, y_home, X_away, y_away = build_dataset(matches)
    print(f"[corners] {len(valid_matches)} matches with features\n")

    # TIME-ORDERED split
    n = len(valid_matches)
    cut = int(n * 0.8)
    print(f"[corners] Train: {cut} matches (oldest) | Holdout: {n - cut} matches "
          f"({valid_matches[cut].date} -> {valid_matches[-1].date})\n")

    X_home_train = np.array(X_home[:cut], dtype=float)
    y_home_train = np.array(y_home[:cut], dtype=float)
    X_home_test = np.array(X_home[cut:], dtype=float)
    y_home_test = np.array(y_home[cut:], dtype=float)

    X_away_train = np.array(X_away[:cut], dtype=float)
    y_away_train = np.array(y_away[:cut], dtype=float)
    X_away_test = np.array(X_away[cut:], dtype=float)
    y_away_test = np.array(y_away[cut:], dtype=float)

    # Train home model
    print("[corners] Training HOME corner model...")
    home_model, home_metrics = train_and_evaluate(
        X_home_train, y_home_train, X_home_test, y_home_test, "home"
    )

    # Train away model
    print("[corners] Training AWAY corner model...")
    away_model, away_metrics = train_and_evaluate(
        X_away_train, y_away_train, X_away_test, y_away_test, "away"
    )

    # Predictions for backtest
    y_pred_home = home_model.predict(X_home_test)
    y_pred_away = away_model.predict(X_away_test)

    # Backtest
    print("\n[corners] Running time-ordered backtest...")
    test_matches = valid_matches[cut:]
    backtest = corner_backtest(test_matches, y_pred_home, y_pred_away)

    print(f"  Matches: {backtest['nMatches']}")
    print(f"  Home MAE: {backtest['home_mae']:.3f} corners")
    print(f"  Away MAE: {backtest['away_mae']:.3f} corners")
    print(f"  Total MAE: {backtest['total_mae']:.3f} corners")
    print(f"  Home consistency (±1): {backtest['home_consistency']:.1%}")
    print(f"  Away consistency (±1): {backtest['away_consistency']:.1%}")
    print(f"  Total consistency (±1.5): {backtest['total_consistency']:.1%}")
    print(f"  Avg predicted total: {backtest['avg_pred_corners']:.1f}")
    print(f"  Avg actual total: {backtest['avg_actual_corners']:.1f}")

    # 70% consistency rule check
    overall_consistency = (backtest["home_consistency"] + backtest["away_consistency"]) / 2
    print(f"\n  === 70% Consistency Rule ===")
    print(f"  Overall team-level consistency: {overall_consistency:.1%}")
    if overall_consistency >= 0.70:
        print(f"  ✅ PASS — model meets 70% consistency threshold")
    else:
        print(f"  ⚠️  BELOW threshold — model may not be reliable enough for betting")

    # Compute Poisson-based line probabilities from predicted corner count
    # The MAE gives us a sigma for the error distribution
    home_sigma = home_metrics["mae"] / 0.8  # approximate std from MAE
    away_sigma = away_metrics["mae"] / 0.8
    print(f"\n  === Line Probabilities (from Poisson approximation) ===")
    print(f"  Home σ≈{home_sigma:.2f}, Away σ≈{away_sigma:.2f}")
    for line in [3.5, 4.5, 5.5, 6.5, 7.5]:
        home_over = float(np.mean(y_pred_home > line))
        away_over = float(np.mean(y_pred_away > line))
        print(f"  Over {line}: Home {home_over:.1%} | Away {away_over:.1%}")

    # Save artifacts
    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump

    dump(home_model, os.path.join(ROOT, "models", "corners_home_model.joblib"))
    dump(away_model, os.path.join(ROOT, "models", "corners_away_model.joblib"))

    meta = {
        "version": home_metrics["version"],
        "market": "corners",
        "source": "football-data.co.uk EPL/LaLiga/Bundesliga/SerieA/Championship 2012-2022",
        "features": FEATURE_NAMES,
        "n_train": cut,
        "n_test": n - cut,
        "holdout_range": f"{valid_matches[cut].date} -> {valid_matches[-1].date}",
        "home_metrics": home_metrics,
        "away_metrics": away_metrics,
        "backtest_summary": {
            "nMatches": backtest["nMatches"],
            "home_mae": backtest["home_mae"],
            "away_mae": backtest["away_mae"],
            "total_mae": backtest["total_mae"],
            "home_consistency": backtest["home_consistency"],
            "away_consistency": backtest["away_consistency"],
            "total_consistency": backtest["total_consistency"],
            "line_accuracy": backtest["line_accuracy"],
        },
        "seeds": SEASONS,
        "leagues": list(LEAGUES.values()),
    }
    with open(os.path.join(ROOT, "models", "corners_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    with open(os.path.join(ROOT, "output", "corners_backtest.json"), "w") as fh:
        json.dump(backtest, fh, indent=2)

    print(f"\n[corners] Wrote models/corners_home_model.joblib + corners_away_model.joblib")
    print(f"[corners] Wrote models/corners_meta.json + output/corners_backtest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
