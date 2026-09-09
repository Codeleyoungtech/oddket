#!/usr/bin/env python3
"""Train per-team corner LINE prediction model (V4).

Instead of predicting exact corner counts (noisy), this predicts the
probability of clearing common lines: Over 3.5, 4.5, 5.5, 6.5.

This is what the user actually needs — the bookmaker offers lines like
"Team X Over 4.5 corners @ 1.85" and we need to know the true probability.

Uses the same features as V3 (H2H corners, momentum, recent form, etc.)
but trains binary classifiers for each line instead of a regressor.

Outputs:
    model/models/corners_line_model.joblib  — trained classifier
    model/models/corners_line_meta.json     — metrics + calibration
    model/output/corners_line_backtest.json — honest backtest
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
FORM_WINDOW = 8
EW_DECAY = 0.85
RECENT_WINDOW = 10
MOMENTUM_WINDOW = 5
H2H_CORNERS_WINDOW = 4

# Lines to predict (matching what bookmakers offer)
LINES = [3.5, 4.5, 5.5, 6.5]

# Leagues — now using football-data.co.uk naming
LEAGUES = {
    "E0": "EPL", "E1": "Championship",
    "SP1": "La Liga", "SP2": "La Liga 2",
    "D1": "Bundesliga", "D2": "Bundesliga 2",
    "I1": "Serie A", "I2": "Serie B",
}

# Seasons to load — matches the file naming: E0_2014_15.csv, etc.
SEASONS = [
    "2014_15", "2015_16", "2016_17", "2017_18", "2018_19",
    "2019_20", "2020_21", "2021_22", "2022_23", "2023_24",
    "2024_25", "2025_26",
]


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


class CornerTeamState:
    __slots__ = ("corner_rate_home", "corner_rate_away",
                 "conceded_rate_home", "conceded_rate_away",
                 "corner_history", "shots_history", "last_ts")

    def __init__(self):
        self.corner_rate_home: list[float] = []
        self.corner_rate_away: list[float] = []
        self.conceded_rate_home: list[float] = []
        self.conceded_rate_away: list[float] = []
        self.corner_history: list[tuple[float, bool]] = []
        self.shots_history: list[tuple[float, bool]] = []
        self.last_ts: int | None = None


def _parse_date(date_str: str) -> tuple[str, int]:
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%d"), int(dt.timestamp())
        except ValueError:
            continue
    return "", 0


def load_corner_csv(path: str, league: str, season: str) -> list[CornerMatch]:
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
                league=league, season=season,
                home=r["HomeTeam"].strip(), away=r["AwayTeam"].strip(),
                home_corners=int(hc), away_corners=int(ac),
                home_goals=int(r.get("FTHG", 0) or 0),
                away_goals=int(r.get("FTAG", 0) or 0),
                home_shots=int(r.get("HS", 0) or 0),
                away_shots=int(r.get("AS", 0) or 0),
                home_sot=int(r.get("HST", 0) or 0),
                away_sot=int(r.get("AST", 0) or 0),
                date=date_str, ts=ts,
            ))
    return matches


def load_all_corners(data_dir: str) -> list[CornerMatch]:
    all_matches = []
    for code, name in LEAGUES.items():
        for season in SEASONS:
            path = os.path.join(data_dir, f"{code}_{season}.csv")
            if os.path.exists(path):
                ms = load_corner_csv(path, name, season)
                all_matches.extend(ms)
                print(f"  {name} {season}: {len(ms)} matches")
    all_matches.sort(key=lambda m: m.ts)
    return all_matches


# ---------------------------------------------------------------------------
# Feature engineering (same as V3)
# ---------------------------------------------------------------------------
def _avg(lst: list[float], n: int = 0) -> float:
    window = lst[-n:] if n > 0 else lst
    return sum(window) / len(window) if window else 5.5


def _ew_avg(values: list[float], decay: float = EW_DECAY) -> float:
    if not values:
        return 5.5
    w = 0.0
    total = 0.0
    for i, v in enumerate(values):
        weight = decay ** (len(values) - 1 - i)
        w += weight * v
        total += weight
    return w / total if total > 0 else 5.5


def compute_corners_features(home_state: CornerTeamState, away_state: CornerTeamState,
                              home: str, away: str, ts: int,
                              recent_matches: list[CornerMatch] | None = None) -> dict:
    home_corners_for_home = _avg(home_state.corner_rate_home, FORM_WINDOW)
    away_corners_for_away = _avg(away_state.corner_rate_away, FORM_WINDOW)
    home_conceded_at_home = _avg(home_state.conceded_rate_home, FORM_WINDOW)
    away_conceded_away = _avg(away_state.conceded_rate_away, FORM_WINDOW)
    home_baseline = (home_corners_for_home + away_conceded_away) / 2.0
    away_baseline = (away_corners_for_away + home_conceded_at_home) / 2.0
    home_ew_corners = _ew_avg([c for c, _ in home_state.corner_history[-FORM_WINDOW:]])
    away_ew_corners = _ew_avg([c for c, _ in away_state.corner_history[-FORM_WINDOW:]])

    # V2 features
    home_recent10 = _avg([c for c, _ in home_state.corner_history[-RECENT_WINDOW:]])
    away_recent10 = _avg([c for c, _ in away_state.corner_history[-RECENT_WINDOW:]])

    home_history = [c for c, _ in home_state.corner_history]
    away_history = [c for c, _ in away_state.corner_history]
    if len(home_history) >= MOMENTUM_WINDOW * 2:
        home_momentum = _avg(home_history[-MOMENTUM_WINDOW:]) - _avg(home_history[-MOMENTUM_WINDOW*2:-MOMENTUM_WINDOW])
    else:
        home_momentum = 0.0
    if len(away_history) >= MOMENTUM_WINDOW * 2:
        away_momentum = _avg(away_history[-MOMENTUM_WINDOW:]) - _avg(away_history[-MOMENTUM_WINDOW*2:-MOMENTUM_WINDOW])
    else:
        away_momentum = 0.0

    home_h2h_corners = 0.0
    away_h2h_corners = 0.0
    h2h_count = 0
    if recent_matches:
        for m in reversed(recent_matches):
            if h2h_count >= H2H_CORNERS_WINDOW:
                break
            if (m.home == home and m.away == away) or (m.home == away and m.away == home):
                if m.home == home:
                    home_h2h_corners += m.home_corners
                    away_h2h_corners += m.away_corners
                else:
                    home_h2h_corners += m.away_corners
                    away_h2h_corners += m.home_corners
                h2h_count += 1
        if h2h_count > 0:
            home_h2h_corners /= h2h_count
            away_h2h_corners /= h2h_count

    home_venue_strength = home_corners_for_home / 5.5
    away_venue_strength = away_corners_for_away / 5.5
    home_opponent_weakness = away_conceded_away / 5.5
    away_opponent_weakness = home_conceded_at_home / 5.5
    home_total_tendency = home_corners_for_home + home_conceded_at_home
    away_total_tendency = away_corners_for_away + away_conceded_away
    home_overall_avg = _avg(home_state.corner_rate_home + home_state.corner_rate_away)
    away_overall_avg = _avg(away_state.corner_rate_away + away_state.corner_rate_away)
    home_shots_avg = _avg([s for s, _ in home_state.shots_history[-FORM_WINDOW:]])
    away_shots_avg = _avg([s for s, _ in away_state.shots_history[-FORM_WINDOW:]])
    home_rest = max(0, (ts - home_state.last_ts) // 86400) if home_state.last_ts else 14
    away_rest = max(0, (ts - away_state.last_ts) // 86400) if away_state.last_ts else 14
    home_n = len(home_state.corner_history)
    away_n = len(away_state.corner_history)

    return {
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
        "home_recent10": round(home_recent10, 4),
        "away_recent10": round(away_recent10, 4),
        "recent10_diff": round(home_recent10 - away_recent10, 4),
        "home_momentum": round(home_momentum, 4),
        "away_momentum": round(away_momentum, 4),
        "momentum_diff": round(home_momentum - away_momentum, 4),
        "home_h2h_corners": round(home_h2h_corners, 4),
        "away_h2h_corners": round(away_h2h_corners, 4),
        "h2h_corners_diff": round(home_h2h_corners - away_h2h_corners, 4),
        "home_venue_strength": round(home_venue_strength, 4),
        "away_venue_strength": round(away_venue_strength, 4),
        "home_opponent_weakness": round(home_opponent_weakness, 4),
        "away_opponent_weakness": round(away_opponent_weakness, 4),
        "home_total_tendency": round(home_total_tendency, 4),
        "away_total_tendency": round(away_total_tendency, 4),
        "home_shots": round(home_shots_avg, 4),
        "away_shots": round(away_shots_avg, 4),
        "shots_diff": round(home_shots_avg - away_shots_avg, 4),
        "home_rest": float(home_rest),
        "away_rest": float(away_rest),
        "rest_diff": float(home_rest - away_rest),
        "home_n": float(min(home_n, 30)),
        "away_n": float(min(away_n, 30)),
    }


FEATURE_NAMES = [
    "home_corners_for", "away_corners_for",
    "home_conceded", "away_conceded",
    "home_baseline", "away_baseline",
    "home_ew_corners", "away_ew_corners",
    "home_overall_avg", "away_overall_avg",
    "home_recent10", "away_recent10", "recent10_diff",
    "home_momentum", "away_momentum", "momentum_diff",
    "home_h2h_corners", "away_h2h_corners", "h2h_corners_diff",
    "home_venue_strength", "away_venue_strength",
    "home_opponent_weakness", "away_opponent_weakness",
    "home_total_tendency", "away_total_tendency",
    "home_shots", "away_shots", "shots_diff",
    "home_rest", "away_rest", "rest_diff",
    "home_n", "away_n",
]


def build_dataset(matches: list[CornerMatch]):
    teams: dict[str, CornerTeamState] = {}
    X_home, y_home = [], []
    X_away, y_away = [], []
    valid_matches = []

    for m in matches:
        hs = teams.setdefault(m.home, CornerTeamState())
        as_ = teams.setdefault(m.away, CornerTeamState())
        features = compute_corners_features(hs, as_, m.home, m.away, m.ts, recent_matches=valid_matches)
        m.features = features
        X_home.append([features[f] for f in FEATURE_NAMES])
        y_home.append(m.home_corners)
        X_away.append([features[f] for f in FEATURE_NAMES])
        y_away.append(m.away_corners)
        valid_matches.append(m)

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
# LINE prediction — the core of V4
# ---------------------------------------------------------------------------
def train_line_model(X_train, y_train, X_test, y_test, line: float):
    """Train a binary classifier: will this team get Over {line} corners?"""
    from xgboost import XGBClassifier
    from sklearn.calibration import CalibratedClassifierCV

    y_tr_bin = (np.array(y_train) > line).astype(int)
    y_te_bin = (np.array(y_test) > line).astype(int)

    # Check if we have enough positive samples
    if y_tr_bin.sum() < 50 or (1 - y_tr_bin).sum() < 50:
        print(f"  [warn] Line {line}: insufficient samples, skipping")
        return None, None

    clf = XGBClassifier(
        n_estimators=400, max_depth=4, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        reg_alpha=0.1, reg_lambda=1.0,
        min_child_weight=5,
        eval_metric="logloss", n_jobs=-1, random_state=42,
    )

    # Calibrate with isotonic regression (best for binary)
    cal_clf = CalibratedClassifierCV(clf, method="isotonic", cv=5)
    cal_clf.fit(X_train, y_tr_bin)

    # Evaluate
    proba = cal_clf.predict_proba(X_test)[:, 1]
    accuracy = float(np.mean((proba > 0.5) == y_te_bin))

    # Brier score (lower is better)
    brier = float(np.mean((proba - y_te_bin) ** 2))

    # Line-specific accuracy: how often the model's >50% prediction matches reality
    # If model says >50% over, does it actually go over?
    predicted_over = proba > 0.5
    if predicted_over.sum() > 0:
        precision_over = float(y_te_bin[predicted_over].mean())
    else:
        precision_over = 0.0

    # How often does the model say "no edge" (45-55%) — these are the uncertain ones
    uncertain = (proba > 0.45) & (proba < 0.55)
    uncertain_rate = float(uncertain.mean())

    # Brier skill score vs constant prediction (base rate)
    base_rate = y_te_bin.mean()
    brier_base = base_rate * (1 - base_rate)
    bss = 1 - brier / brier_base if brier_base > 0 else 0.0

    return cal_clf, {
        "line": line,
        "accuracy": round(accuracy, 4),
        "brier": round(brier, 4),
        "bss": round(bss, 4),  # Brier Skill Score (>0 = better than base rate)
        "precision_over": round(precision_over, 4),
        "uncertain_rate": round(uncertain_rate, 4),
        "base_rate": round(float(base_rate), 4),
        "n_test": int(len(y_te_bin)),
        "n_over_test": int(y_te_bin.sum()),
    }


def line_backtest(matches, models: dict, X_test_home, y_test_home, X_test_away, y_test_away):
    """Backtest line predictions: accuracy, Brier, calibration per line."""
    results = {}
    for line in LINES:
        if line not in models or models[line] is None:
            continue

        clf_home = models[line]["home"]
        clf_away = models[line]["away"]

        # Predict on test set
        proba_home = clf_home.predict_proba(X_test_home)[:, 1] if clf_home else np.full(len(y_test_home), 0.5)
        proba_away = clf_away.predict_proba(X_test_away)[:, 1] if clf_away else np.full(len(y_test_away), 0.5)

        y_home_bin = (np.array(y_test_home) > line).astype(int)
        y_away_bin = (np.array(y_test_away) > line).astype(int)

        # Combined: both home AND away line predictions
        all_proba = np.concatenate([proba_home, proba_away])
        all_actual = np.concatenate([y_home_bin, y_away_bin])

        accuracy = float(np.mean((all_proba > 0.5) == all_actual))
        brier = float(np.mean((all_proba - all_actual) ** 2))

        # Calibration bins
        bins = []
        for i in range(10):
            lo, hi = i / 10, (i + 1) / 10
            mask = (all_proba >= lo) & (all_proba < hi)
            cnt = int(mask.sum())
            bins.append({
                "bin": round(lo + 0.05, 2),
                "count": cnt,
                "predicted": round(float(all_proba[mask].mean()), 4) if cnt else 0,
                "actual": round(float(all_actual[mask].mean()), 4) if cnt else 0,
            })

        results[line] = {
            "accuracy": round(accuracy, 4),
            "brier": round(brier, 4),
            "n_total": int(len(all_actual)),
            "n_over": int(all_actual.sum()),
            "base_rate": round(float(all_actual.mean()), 4),
            "calibration_bins": bins,
        }

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data", "corners"))
    args = ap.parse_args()

    print("[corners-v4] Loading data...")
    matches = load_all_corners(args.data_dir)
    print(f"[corners-v4] Total: {len(matches)} matches\n")

    if len(matches) < 1000:
        print(f"[corners-v4] Only {len(matches)} matches — need at least 1000", file=sys.stderr)
        return 1

    print("[corners-v4] Building features...")
    valid_matches, X_home, y_home, X_away, y_away = build_dataset(matches)
    print(f"[corners-v4] {len(valid_matches)} matches with features\n")

    n = len(valid_matches)
    cut = int(n * 0.8)
    print(f"[corners-v4] Train: {cut} (oldest) | Test: {n - cut} ({valid_matches[cut].date} -> {valid_matches[-1].date})\n")

    X_h_train = np.array(X_home[:cut], dtype=float)
    y_h_train = np.array(y_home[:cut], dtype=float)
    X_h_test = np.array(X_home[cut:], dtype=float)
    y_h_test = np.array(y_home[cut:], dtype=float)

    X_a_train = np.array(X_away[:cut], dtype=float)
    y_a_train = np.array(y_away[:cut], dtype=float)
    X_a_test = np.array(X_away[cut:], dtype=float)
    y_a_test = np.array(y_away[cut:], dtype=float)

    # Train line models for each threshold
    models = {}
    line_metrics = {}
    for line in LINES:
        print(f"[corners-v4] Training Over {line} model...")
        home_clf, home_m = train_line_model(X_h_train, y_h_train, X_h_test, y_h_test, line)
        away_clf, away_m = train_line_model(X_a_train, y_a_train, X_a_test, y_a_test, line)

        if home_clf and away_clf:
            models[line] = {"home": home_clf, "away": away_clf}
            line_metrics[line] = {"home": home_m, "away": away_m}
            print(f"  Home: acc={home_m['accuracy']:.1%} brier={home_m['brier']:.4f} BSS={home_m['bss']:.4f} "
                  f"prec_over={home_m['precision_over']:.1%}")
            print(f"  Away: acc={away_m['accuracy']:.1%} brier={away_m['brier']:.4f} BSS={away_m['bss']:.4f} "
                  f"prec_over={away_m['precision_over']:.1%}")
        else:
            print(f"  [skip] insufficient data for line {line}")

    # Backtest
    print(f"\n[corners-v4] Running backtest...")
    bt = line_backtest(valid_matches[cut:], models, X_h_test, y_h_test, X_a_test, y_a_test)

    for line, res in bt.items():
        print(f"  Over {line}: acc={res['accuracy']:.1%} brier={res['brier']:.4f} "
              f"base={res['base_rate']:.1%} n={res['n_total']}")

    # Save artifacts
    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump

    # Save all line models
    for line, clfs in models.items():
        dump(clfs["home"], os.path.join(ROOT, "models", f"corners_line_{line}_home.joblib"))
        dump(clfs["away"], os.path.join(ROOT, "models", f"corners_line_{line}_away.joblib"))

    meta = {
        "version": "corners-line-v4",
        "market": "corners_lines",
        "source": "football-data.co.uk EPL/LaLiga/Bundesliga/SerieA 2014-2026",
        "features": FEATURE_NAMES,
        "lines": LINES,
        "n_train": cut,
        "n_test": n - cut,
        "holdout_range": f"{valid_matches[cut].date} -> {valid_matches[-1].date}",
        "line_metrics": line_metrics,
        "backtest": bt,
    }
    with open(os.path.join(ROOT, "models", "corners_line_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    with open(os.path.join(ROOT, "output", "corners_line_backtest.json"), "w") as fh:
        json.dump(bt, fh, indent=2)

    # Summary
    print(f"\n{'='*60}")
    print(f"CORNERS V4 — LINE PREDICTION SUMMARY")
    print(f"{'='*60}")
    print(f"Training data: {len(matches)} matches (12 seasons × 4 leagues)")
    print(f"Features: {len(FEATURE_NAMES)}")
    print(f"Lines predicted: {', '.join(f'Over {l}' for l in LINES)}")
    print()
    for line, res in bt.items():
        skill = "✅" if res['accuracy'] > 0.55 else "⚠️" if res['accuracy'] > 0.52 else "❌"
        print(f"  {skill} Over {line}: {res['accuracy']:.1%} accuracy (base: {res['base_rate']:.1%})")
    print(f"\nWrote models/corners_line_*.joblib + corners_line_meta.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())
