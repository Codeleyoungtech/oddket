#!/usr/bin/env python3
"""Corners prediction model V5 — full 8-layer feature system.

Predicts per-team corner counts using:
  Layer 1: Historical corner production (CF/CA, L5/L10/L15/season)
  Layer 2: Corner consistency (std dev, variance, over-rate %)
  Layer 3: Home/away strength (venue-filtered stats)
  Layer 4: Opponent interaction (attack vs defense profiles)
  Layer 5: Shots/fouls/cards/goals (attacking pressure)
  Layer 6: Team strength Elo rating
  Layer 7: Odds-derived features (market expectations)
  Layer 8: Context (rest days, sample size)

Data: 17K matches across 12 seasons × 4 leagues from football-data.co.uk
Model: LightGBM regressor with Poisson line probabilities
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
from typing import Optional

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(ROOT)
# footballdata/ lives at project root, not inside model/
DATA_DIR = os.path.join(PROJECT_ROOT, "footballdata")

# ---------------------------------------------------------------------------
# League / season mapping
# ---------------------------------------------------------------------------
# football-data.co.uk uses these div codes
LEAGUE_MAP = {
    "E0": "EPL",
    "SP1": "La Liga",
    "D1": "Bundesliga",
    "I1": "Serie A",
    "E1": "Championship",  # sometimes present
}
# Abbreviated file prefixes from footballdata/
FILE_PREFIXES = {
    "EPL": ["EPL", "E0"],
    "La Liga": ["LLL", "SP1"],
    "Bundesliga": ["BDS", "D1"],
    "Serie A": ["SRA", "I1"],
    "Championship": ["E1"],
    "League One": ["E2"],
    "League Two": ["E3"],
    "2. Bundesliga": ["D2"],
    "Segunda": ["SP2"],
    "Serie B": ["I2"],
    "Super Lig": ["T1"],
}
ACTIVE_LEAGUES = [
    "EPL",
    "La Liga",
    "Bundesliga",
    "Serie A",
    "Championship",
    "League One",
    "League Two",
    "2. Bundesliga",
    "Segunda",
    "Serie B",
    "Super Lig",
]

SEASONS = [
    "2014_15", "2015_16", "2016_17", "2017_18", "2018_19",
    "2019_20", "2020_21", "2021_22", "2022_23", "2023_24",
    "2024_25", "2025_26",
]

# Rolling windows for form
FORM_WINDOWS = [5, 10, 15]
LEAGUE_AVG_CORNERS = 10.5  # approximate avg total corners per match
TEAM_LEAGUE_AVG = 5.25     # per team

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass
class Match:
    id: str
    league: str
    season: str
    home: str
    away: str
    date: str
    ts: int
    # Corners (targets)
    hc: int = 0
    ac: int = 0
    # Shots
    hs: int = 0
    as_: int = 0
    hst: int = 0
    ast: int = 0
    # Fouls / cards
    hf: int = 0
    af: int = 0
    hy: int = 0
    ay: int = 0
    hr: int = 0
    ar: int = 0
    # Goals
    fthg: int = 0
    ftag: int = 0
    hthg: int = 0
    htag: int = 0
    # Result
    ftr: str = ""
    htr: str = ""
    # Odds (best available)
    odds_h: float = 0.0
    odds_d: float = 0.0
    odds_a: float = 0.0
    ou_25_over: float = 0.0
    ah_home: float = 0.0
    # Computed
    total_corners: int = 0
    features: dict = field(default_factory=dict)


@dataclass
class TeamState:
    """Running per-team state across all matches."""
    # Corner production
    cf_home: list[int] = field(default_factory=list)   # corners for at home
    cf_away: list[int] = field(default_factory=list)   # corners for away
    ca_home: list[int] = field(default_factory=list)   # corners against at home
    ca_away: list[int] = field(default_factory=list)   # corners against away
    # Shots
    shots_home: list[int] = field(default_factory=list)
    shots_away: list[int] = field(default_factory=list)
    sot_home: list[int] = field(default_factory=list)
    sot_away: list[int] = field(default_factory=list)
    # Fouls / cards
    fouls_home: list[int] = field(default_factory=list)
    fouls_away: list[int] = field(default_factory=list)
    cards_home: list[int] = field(default_factory=list)
    cards_away: list[int] = field(default_factory=list)
    # Goals
    goals_home: list[int] = field(default_factory=list)
    goals_away: list[int] = field(default_factory=list)
    goals_conceded_home: list[int] = field(default_factory=list)
    goals_conceded_away: list[int] = field(default_factory=list)
    # Corner history (all, with is_home flag)
    corner_history: list[tuple[int, bool]] = field(default_factory=list)
    # Elo rating (starts at 1500)
    elo: float = 1500.0
    # Last match timestamp
    last_ts: int = 0
    # Match count
    n_matches: int = 0


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def _parse_date(date_str: str) -> tuple[str, int]:
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%d"), int(dt.timestamp())
        except ValueError:
            continue
    return "", 0


def _int(val: str) -> int:
    val = val.strip()
    if val and val.replace("-", "").isdigit():
        return int(val)
    return 0


def _float(val: str) -> float:
    val = val.strip()
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def _find_odds(row: dict, h_key: str, d_key: str, a_key: str) -> tuple[float, float, float]:
    """Extract odds from a row, returning (h, d, a)."""
    h = _float(row.get(h_key, ""))
    d = _float(row.get(d_key, ""))
    a = _float(row.get(a_key, ""))
    if h > 1.0 and d > 1.0 and a > 1.0:
        return h, d, a
    return 0.0, 0.0, 0.0


def load_match_csv(path: str, league: str, season: str) -> list[Match]:
    """Load a single CSV, extracting all available stats."""
    matches = []
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        cols = reader.fieldnames or []
        for i, row in enumerate(reader):
            hc = row.get("HC", "").strip()
            ac = row.get("AC", "").strip()
            if not hc.isdigit() or not ac.isdigit():
                continue
            date_str, ts = _parse_date(row.get("Date", ""))
            if not ts:
                continue

            hc_i, ac_i = int(hc), int(ac)

            # Try multiple odds providers (B365 > BW > IW > PS > WH > VC > Avg)
            odds_h, odds_d, odds_a = 0.0, 0.0, 0.0
            for prefix in ["B365", "BW", "IW", "PS", "WH", "VC", "Avg"]:
                h, d, a = _find_odds(row, f"{prefix}H", f"{prefix}D", f"{prefix}A")
                if h > 1.0:
                    odds_h, odds_d, odds_a = h, d, a
                    break

            # Over/Under 2.5 goals odds
            ou_25 = 0.0
            for prefix in ["B365", "P", "Avg", "Max"]:
                val = _float(row.get(f"{prefix}>2.5", ""))
                if val > 1.0:
                    ou_25 = val
                    break

            # Asian handicap
            ah = _float(row.get("AHh", row.get("BbAHh", "")))

            matches.append(Match(
                id=f"corners-{league}-{season}-{i}",
                league=league,
                season=season,
                home=row.get("HomeTeam", "").strip(),
                away=row.get("AwayTeam", "").strip(),
                date=date_str,
                ts=ts,
                hc=hc_i,
                ac=ac_i,
                hs=_int(row.get("HS", "0")),
                as_=_int(row.get("AS", "0")),
                hst=_int(row.get("HST", "0")),
                ast=_int(row.get("AST", "0")),
                hf=_int(row.get("HF", "0")),
                af=_int(row.get("AF", "0")),
                hy=_int(row.get("HY", "0")),
                ay=_int(row.get("AY", "0")),
                hr=_int(row.get("HR", "0")),
                ar=_int(row.get("AR", "0")),
                fthg=_int(row.get("FTHG", "0")),
                ftag=_int(row.get("FTAG", "0")),
                hthg=_int(row.get("HTHG", "0")),
                htag=_int(row.get("HTAG", "0")),
                ftr=row.get("FTR", "").strip(),
                htr=row.get("HTR", "").strip(),
                odds_h=odds_h,
                odds_d=odds_d,
                odds_a=odds_a,
                ou_25_over=ou_25,
                ah_home=ah,
                total_corners=hc_i + ac_i,
            ))
    return matches


def load_all_data(data_dir: str) -> list[Match]:
    """Load all leagues and seasons from footballdata and model/data/corners."""
    all_matches = []
    seen_ids = set()
    dirs = [data_dir, os.path.join(ROOT, "data", "corners")]
    for league in ACTIVE_LEAGUES:
        prefixes = FILE_PREFIXES.get(league, [league])
        if isinstance(prefixes, str):
            prefixes = [prefixes]
        for season in SEASONS + ["2012", "2020", "2021"]:
            for d in dirs:
                for prefix in prefixes:
                    path = os.path.join(d, f"{prefix}_{season}.csv")
                    if not os.path.exists(path):
                        continue
                    ms = load_match_csv(path, league, season)
                    added = 0
                    for m in ms:
                        if m.id not in seen_ids:
                            seen_ids.add(m.id)
                            all_matches.append(m)
                            added += 1
                    if added > 0:
                        print(f"  {league} {season} ({prefix}): {added} matches")
    all_matches.sort(key=lambda m: m.ts)
    return all_matches


# ---------------------------------------------------------------------------
# Feature helpers
# ---------------------------------------------------------------------------
def _mean(lst: list, n: int = 0) -> float:
    """Mean of last n items, or all if n=0."""
    w = lst[-n:] if n > 0 else lst
    return sum(w) / len(w) if w else 0.0


def _std(lst: list, n: int = 0) -> float:
    """Std dev of last n items."""
    w = lst[-n:] if n > 0 else lst
    if len(w) < 2:
        return 0.0
    m = sum(w) / len(w)
    return math.sqrt(sum((x - m) ** 2 for x in w) / (len(w) - 1))


def _median(lst: list, n: int = 0) -> float:
    w = lst[-n:] if n > 0 else lst
    if not w:
        return 0.0
    s = sorted(w)
    mid = len(s) // 2
    if len(s) % 2 == 0:
        return (s[mid - 1] + s[mid]) / 2.0
    return float(s[mid])


def _ew_mean(values: list[float], decay: float = 0.85) -> float:
    """Exponentially weighted mean."""
    if not values:
        return 0.0
    w_sum = 0.0
    v_sum = 0.0
    for i, v in enumerate(values):
        w = decay ** (len(values) - 1 - i)
        w_sum += w
        v_sum += w * v
    return v_sum / w_sum if w_sum > 0 else 0.0


def _over_rate(values: list[int], line: float) -> float:
    """Percentage of values over the line."""
    if not values:
        return 0.0
    return sum(1 for v in values if v > line) / len(values)


def _elo_update(elo: float, expected: float, actual: float, k: float = 20.0) -> float:
    """Simple Elo update."""
    return elo + k * (actual - expected)


# ---------------------------------------------------------------------------
# Layer 6: Team Strength Elo (corner-based)
# ---------------------------------------------------------------------------
def compute_elo_ratings(matches: list[Match]) -> dict[str, float]:
    """Compute corner-based Elo ratings for all teams."""
    elos: dict[str, float] = {}
    for m in matches:
        h = elos.setdefault(m.home, 1500.0)
        a = elos.setdefault(m.away, 1500.0)

        # Expected score from Elo difference
        exp_h = 1.0 / (1.0 + 10 ** ((a - h) / 400.0))
        exp_a = 1.0 - exp_h

        # Actual score: normalized corner difference
        corner_diff = m.hc - m.ac
        # Map to 0-1: +4 corners ≈ 1.0, 0 diff ≈ 0.5
        actual_h = min(1.0, max(0.0, 0.5 + corner_diff / 8.0))
        actual_a = 1.0 - actual_h

        elos[m.home] = _elo_update(h, exp_h, actual_h)
        elos[m.away] = _elo_update(a, exp_a, actual_a)

    return elos


# ---------------------------------------------------------------------------
# Feature computation
# ---------------------------------------------------------------------------
def compute_features(
    home: TeamState,
    away: TeamState,
    match: Match,
    elo_ratings: dict[str, float],
    all_matches_before: list[Match],
) -> dict:
    """Compute the full 8-layer feature vector for a match."""

    # ── Layer 1: Historical corner production ──
    features = {}

    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        # Venue-filtered corner rates
        cf_venue = state.cf_home if is_home else state.cf_away
        ca_venue = state.ca_home if is_home else state.ca_away

        for w in FORM_WINDOWS:
            features[f"{prefix}_cf_l{w}"] = round(_mean(cf_venue, w), 4)
            features[f"{prefix}_ca_l{w}"] = round(_mean(ca_venue, w), 4)

        # Season average (all matches)
        all_cf = state.cf_home + state.cf_away
        all_ca = state.ca_home + state.ca_away
        features[f"{prefix}_cf_season"] = round(_mean(all_cf), 4)
        features[f"{prefix}_ca_season"] = round(_mean(all_ca), 4)

        # Previous season avg (if we have enough data)
        if len(all_cf) > 30:
            prev = all_cf[:-min(10, len(all_cf))]
            features[f"{prefix}_cf_prev_season"] = round(_mean(prev[-30:]), 4) if len(prev) >= 10 else features[f"{prefix}_cf_season"]
        else:
            features[f"{prefix}_cf_prev_season"] = features[f"{prefix}_cf_season"]

        # Exponentially weighted form
        features[f"{prefix}_cf_ew"] = round(_ew_mean([float(x) for x in cf_venue]), 4)

        # Baseline: avg of team's rate + opponent's conceded rate
        home_cf = _mean(state.cf_home if is_home else state.cf_away, 10)
        opp_ca = _mean(away.ca_away if is_home else home.ca_home, 10)
        features[f"{prefix}_baseline"] = round((home_cf + opp_ca) / 2.0, 4)

    # ── Layer 2: Corner consistency ──
    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        cf_venue = state.cf_home if is_home else state.cf_away

        features[f"{prefix}_cf_std"] = round(_std(cf_venue, 10), 4)
        features[f"{prefix}_cf_cv"] = round(
            _std(cf_venue, 10) / max(_mean(cf_venue, 10), 0.1), 4
        )
        features[f"{prefix}_cf_median"] = round(_median(cf_venue, 10), 1)
        features[f"{prefix}_cf_min"] = float(min(cf_venue[-10:]) if cf_venue else 0)
        features[f"{prefix}_cf_max"] = float(max(cf_venue[-10:]) if cf_venue else 0)

        # Over-rate percentages for common team corner lines
        for line in [3.5, 4.5, 5.5, 6.5]:
            features[f"{prefix}_over_{line}"] = round(_over_rate(cf_venue, line), 4)

    # ── Layer 3: Home/Away strength ──
    # Home team's home stats vs away team's away stats
    features["home_cf_home_l10"] = round(_mean(home.cf_home, 10), 4)
    features["home_ca_home_l10"] = round(_mean(home.ca_home, 10), 4)
    features["away_cf_away_l10"] = round(_mean(away.cf_away, 10), 4)
    features["away_ca_away_l10"] = round(_mean(away.ca_away, 10), 4)

    # Home total corners at home venue
    features["home_total_home_l10"] = round(
        _mean(home.cf_home, 10) + _mean(home.ca_home, 10), 4
    )
    features["away_total_away_l10"] = round(
        _mean(away.cf_away, 10) + _mean(away.ca_away, 10), 4
    )

    # ── Layer 4: Opponent interaction ──
    # How well does home attack match against away defense?
    features["h_attack_x_a_defense"] = round(
        _mean(home.cf_home, 10) * _mean(away.ca_away, 10) / 25.0, 4
    )
    features["a_attack_x_h_defense"] = round(
        _mean(away.cf_away, 10) * _mean(home.ca_home, 10) / 25.0, 4
    )

    # Matchup corner strength
    home_matchup = _mean(home.cf_home, 10) + _mean(away.ca_away, 10)
    away_matchup = _mean(away.cf_away, 10) + _mean(home.ca_home, 10)
    features["home_matchup"] = round(home_matchup, 4)
    features["away_matchup"] = round(away_matchup, 4)
    features["matchup_diff"] = round(home_matchup - away_matchup, 4)

    # ── Layer 5: Shots, fouls, cards, goals ──
    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        shots_venue = state.shots_home if is_home else state.shots_away
        sot_venue = state.sot_home if is_home else state.sot_away
        fouls_venue = state.fouls_home if is_home else state.fouls_away
        cards_venue = state.cards_home if is_home else state.cards_away
        goals_venue = state.goals_home if is_home else state.goals_away
        conceded_venue = state.goals_conceded_home if is_home else state.goals_conceded_away

        for w in [5, 10]:
            features[f"{prefix}_shots_l{w}"] = round(_mean(shots_venue, w), 4)
            features[f"{prefix}_sot_l{w}"] = round(_mean(sot_venue, w), 4)
            features[f"{prefix}_fouls_l{w}"] = round(_mean(fouls_venue, w), 4)
            features[f"{prefix}_cards_l{w}"] = round(_mean(cards_venue, w), 4)
            features[f"{prefix}_goals_l{w}"] = round(_mean(goals_venue, w), 4)
            features[f"{prefix}_conceded_l{w}"] = round(_mean(conceded_venue, w), 4)

        # Shots → corners proxy
        features[f"{prefix}_shots_corners_ratio"] = round(
            _mean(shots_venue, 10) / max(_mean(shots_venue, 10) + 5.0, 1.0), 4
        )

    # Interaction: shots × opponent defense
    features["h_shots_x_a_conceded"] = round(
        _mean(home.shots_home, 10) * _mean(away.goals_conceded_away, 10) / 50.0, 4
    )
    features["a_shots_x_h_conceded"] = round(
        _mean(away.shots_away, 10) * _mean(home.goals_conceded_home, 10) / 50.0, 4
    )

    # ── Layer 6: Team strength Elo ──
    features["home_elo"] = round(elo_ratings.get(match.home, 1500.0), 1)
    features["away_elo"] = round(elo_ratings.get(match.away, 1500.0), 1)
    features["elo_diff"] = round(
        elo_ratings.get(match.home, 1500.0) - elo_ratings.get(match.away, 1500.0), 1
    )
    features["elo_expected_home"] = round(
        1.0 / (1.0 + 10 ** ((elo_ratings.get(match.away, 1500) - elo_ratings.get(match.home, 1500)) / 400.0)), 4
    )

    # ── Layer 7: Odds-derived features ──
    if match.odds_h > 1.0:
        # Implied probabilities from 1X2 odds
        total_implied = 1.0/match.odds_h + 1.0/match.odds_d + 1.0/match.odds_a
        features["implied_home"] = round((1.0/match.odds_h) / total_implied, 4)
        features["implied_draw"] = round((1.0/match.odds_d) / total_implied, 4)
        features["implied_away"] = round((1.0/match.odds_a) / total_implied, 4)
        features["odds_overround"] = round(total_implied, 4)
    else:
        features["implied_home"] = 0.33
        features["implied_draw"] = 0.33
        features["implied_away"] = 0.33
        features["odds_overround"] = 1.0

    if match.ou_25_over > 1.0:
        ou_implied = 1.0 / match.ou_25_over
        features["implied_goals_over25"] = round(ou_implied, 4)
    else:
        features["implied_goals_over25"] = 0.5

    features["ah_home"] = match.ah_home

    # ── Layer 8: Context ──
    home_rest = max(0, (match.ts - home.last_ts) // 86400) if home.last_ts else 14
    away_rest = max(0, (match.ts - away.last_ts) // 86400) if away.last_ts else 14
    features["home_rest"] = float(home_rest)
    features["away_rest"] = float(away_rest)
    features["rest_diff"] = float(home_rest - away_rest)

    features["home_n"] = float(min(home.n_matches, 40))
    features["away_n"] = float(min(away.n_matches, 40))

    # League encoding (one-hot)
    for league in ACTIVE_LEAGUES:
        features[f"league_{league}"] = 1.0 if match.league == league else 0.0

    return features


# ---------------------------------------------------------------------------
# Build full dataset
# ---------------------------------------------------------------------------
FEATURE_NAMES: list[str] = []


def build_dataset(
    matches: list[Match],
    elo_ratings: dict[str, float],
) -> tuple[list[Match], list[list[float]], list[int], list[int]]:
    """Build feature matrix and targets chronologically."""
    global FEATURE_NAMES

    teams: dict[str, TeamState] = {}
    X_home: list[list[float]] = []
    y_home: list[int] = []
    X_away: list[list[float]] = []
    y_away: list[int] = []
    valid: list[Match] = []
    seen_features = False

    for m in matches:
        hs = teams.setdefault(m.home, TeamState())
        as_ = teams.setdefault(m.away, TeamState())

        feats = compute_features(hs, as_, m, elo_ratings, valid)
        m.features = feats

        if not seen_features:
            FEATURE_NAMES = sorted(feats.keys())
            seen_features = True

        X_home.append([feats[f] for f in FEATURE_NAMES])
        y_home.append(m.hc)
        X_away.append([feats[f] for f in FEATURE_NAMES])
        y_away.append(m.ac)

        valid.append(m)

        # Update state AFTER computing features (no leakage)
        hs.cf_home.append(m.hc)
        hs.ca_home.append(m.ac)
        hs.cf_away  # no update needed for home team's away stats here
        hs.corner_history.append((m.hc, True))
        hs.shots_home.append(m.hs)
        hs.sot_home.append(m.hst)
        hs.fouls_home.append(m.hf)
        hs.cards_home.append(m.hy + m.hr)
        hs.goals_home.append(m.fthg)
        hs.goals_conceded_home.append(m.ftag)
        hs.last_ts = m.ts
        hs.n_matches += 1

        as_.cf_away.append(m.ac)
        as_.ca_away.append(m.hc)
        as_.corner_history.append((m.ac, False))
        as_.shots_away.append(m.as_)
        as_.sot_away.append(m.ast)
        as_.fouls_away.append(m.af)
        as_.cards_away.append(m.ay + m.ar)
        as_.goals_away.append(m.ftag)
        as_.goals_conceded_away.append(m.fthg)
        as_.last_ts = m.ts
        as_.n_matches += 1

    return valid, X_home, y_home, X_away, y_away


# ---------------------------------------------------------------------------
# Training & evaluation
# ---------------------------------------------------------------------------
def train_model(X_train, y_train, X_test, y_test, label: str):
    """Train LightGBM regressor, return model + metrics."""
    try:
        import lightgbm as lgb
        model = lgb.LGBMRegressor(
            n_estimators=1000,
            max_depth=7,
            learning_rate=0.02,
            subsample=0.8,
            colsample_bytree=0.7,
            reg_alpha=0.1,
            reg_lambda=2.0,
            min_child_weight=8,
            num_leaves=63,
            n_jobs=-1,
            random_state=42,
            verbose=-1,
        )
        version = "corners-lgb-v5"
    except ImportError:
        from xgboost import XGBRegressor
        model = XGBRegressor(
            n_estimators=1000,
            max_depth=7,
            learning_rate=0.02,
            subsample=0.8,
            colsample_bytree=0.7,
            reg_alpha=0.1,
            reg_lambda=2.0,
            min_child_weight=8,
            n_jobs=-1,
            random_state=42,
        )
        version = "corners-xgb-v5"

    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    mae = float(np.mean(np.abs(y_pred - y_test)))
    rmse = float(np.sqrt(np.mean((y_pred - y_test) ** 2)))
    ss_res = np.sum((y_test - y_pred) ** 2)
    ss_tot = np.sum((y_test - np.mean(y_test)) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0

    within_1 = float(np.mean(np.abs(y_pred - y_test) <= 1.0))
    within_05 = float(np.mean(np.abs(y_pred - y_test) <= 0.5))

    # Line accuracy
    line_acc = {}
    for line in [3.5, 4.5, 5.5, 6.5, 7.5, 8.5]:
        pred_over = (y_pred > line).astype(float)
        actual_over = (y_test > line).astype(float)
        line_acc[f"over_{line}"] = round(float(np.mean(pred_over == actual_over)), 4)

    # Feature importance
    importance = {}
    if hasattr(model, "feature_importances_"):
        imp = model.feature_importances_
        importance = dict(sorted(
            zip(FEATURE_NAMES, [round(float(x), 4) for x in imp]),
            key=lambda kv: kv[1],
            reverse=True,
        ))

    # Error sigma (for Poisson line probs)
    sigma = float(np.std(y_pred - y_test))

    print(f"  [{label}] MAE={mae:.3f} | RMSE={rmse:.3f} | R²={r2:.4f} | "
          f"within±1={within_1:.1%} | σ={sigma:.3f}")

    return model, {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "consistency_1": round(within_1, 4),
        "consistency_05": round(within_05, 4),
        "line_accuracy": line_acc,
        "sigma": round(sigma, 4),
        "feature_importance_top20": dict(list(importance.items())[:20]),
        "version": version,
    }


def backtest(
    matches: list[Match],
    y_pred_home: np.ndarray,
    y_pred_away: np.ndarray,
) -> dict:
    """Full backtest with line probabilities."""
    bets = []
    for i, m in enumerate(matches):
        ph, pa = float(y_pred_home[i]), float(y_pred_away[i])
        bets.append({
            "date": m.date,
            "league": m.league,
            "home": m.home,
            "away": m.away,
            "pred_h": round(ph, 2),
            "pred_a": round(pa, 2),
            "pred_total": round(ph + pa, 2),
            "actual_h": m.hc,
            "actual_a": m.ac,
            "actual_total": m.hc + m.ac,
            "error_h": round(abs(ph - m.hc), 2),
            "error_a": round(abs(pa - m.ac), 2),
        })

    n = len(bets)

    # Team line accuracy
    team_lines = {}
    for line in [3.5, 4.5, 5.5, 6.5, 7.5]:
        h_correct = sum(1 for b in bets if (b["pred_h"] > line) == (b["actual_h"] > line))
        a_correct = sum(1 for b in bets if (b["pred_a"] > line) == (b["actual_a"] > line))
        team_lines[f"team_{line}"] = round((h_correct + a_correct) / (2 * n), 4)

    # Total lines accuracy
    total_lines = {}
    for line in [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]:
        correct = sum(1 for b in bets if (b["pred_total"] > line) == (b["actual_total"] > line))
        total_lines[f"total_{line}"] = round(correct / n, 4)

    # Consistency
    within_1_h = sum(1 for b in bets if b["error_h"] <= 1.0) / n
    within_1_a = sum(1 for b in bets if b["error_a"] <= 1.0) / n
    within_1_5_total = sum(
        1 for b in bets if abs(b["pred_total"] - b["actual_total"]) <= 1.5
    ) / n

    return {
        "n_matches": n,
        "home_mae": round(float(np.mean([b["error_h"] for b in bets])), 4),
        "away_mae": round(float(np.mean([b["error_a"] for b in bets])), 4),
        "total_mae": round(float(np.mean([abs(b["pred_total"] - b["actual_total"]) for b in bets])), 4),
        "home_consistency": round(within_1_h, 4),
        "away_consistency": round(within_1_a, 4),
        "total_consistency": round(within_1_5_total, 4),
        "team_line_accuracy": team_lines,
        "total_line_accuracy": total_lines,
        "avg_pred_total": round(float(np.mean([b["pred_total"] for b in bets])), 2),
        "avg_actual_total": round(float(np.mean([b["actual_total"] for b in bets])), 2),
        "bets": bets[:50],  # first 50 for inspection
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=DATA_DIR)
    args = ap.parse_args()

    print("[v5] Loading all match data...")
    matches = load_all_data(args.data_dir)
    print(f"[v5] Total: {len(matches)} matches across {len(ACTIVE_LEAGUES)} leagues\n")

    if len(matches) < 500:
        print(f"[v5] Only {len(matches)} matches — need at least 500", file=sys.stderr)
        return 1

    # Compute Elo ratings across entire history
    print("[v5] Computing team Elo ratings...")
    elo = compute_elo_ratings(matches)
    print(f"[v5] {len(elo)} teams rated\n")

    # Build features
    print("[v5] Building 8-layer features...")
    valid, X_home, y_home, X_away, y_away = build_dataset(matches, elo)
    print(f"[v5] {len(valid)} matches with {len(FEATURE_NAMES)} features\n")

    # Time-ordered split: 80% train, 20% test
    n = len(valid)
    cut = int(n * 0.8)
    print(f"[v5] Train: {cut} matches (oldest)")
    print(f"[v5] Test:  {n - cut} matches ({valid[cut].date} → {valid[-1].date})\n")

    Xh_train = np.array(X_home[:cut], dtype=float)
    yh_train = np.array(y_home[:cut], dtype=float)
    Xh_test = np.array(X_home[cut:], dtype=float)
    yh_test = np.array(y_home[cut:], dtype=float)

    Xa_train = np.array(X_away[:cut], dtype=float)
    ya_train = np.array(y_away[:cut], dtype=float)
    Xa_test = np.array(X_away[cut:], dtype=float)
    ya_test = np.array(y_away[cut:], dtype=float)

    # Train
    print("[v5] Training HOME corner model...")
    home_model, home_metrics = train_model(Xh_train, yh_train, Xh_test, yh_test, "home")

    print("[v5] Training AWAY corner model...")
    away_model, away_metrics = train_model(Xa_train, ya_train, Xa_test, ya_test, "away")

    # Backtest
    print("\n[v5] Running time-ordered backtest...")
    y_pred_h = home_model.predict(Xh_test)
    y_pred_a = away_model.predict(Xa_test)
    bt = backtest(valid[cut:], y_pred_h, y_pred_a)

    print(f"  Matches: {bt['n_matches']}")
    print(f"  Home MAE: {bt['home_mae']:.3f} | Away MAE: {bt['away_mae']:.3f} | Total MAE: {bt['total_mae']:.3f}")
    print(f"  Home consistency (±1): {bt['home_consistency']:.1%}")
    print(f"  Away consistency (±1): {bt['away_consistency']:.1%}")
    print(f"  Total consistency (±1.5): {bt['total_consistency']:.1%}")
    print(f"  Avg predicted total: {bt['avg_pred_total']:.1f} | Avg actual: {bt['avg_actual_total']:.1f}")

    # Team line accuracy
    print("\n  === Team Corner Line Accuracy ===")
    for k, v in bt["team_line_accuracy"].items():
        line = k.split("_")[1]
        print(f"  Over {line} corners (team): {v:.1%}")

    # Total line accuracy
    print("\n  === Total Corner Line Accuracy ===")
    for k, v in bt["total_line_accuracy"].items():
        line = k.split("_")[1]
        print(f"  Over {line} total corners: {v:.1%}")

    # 70% consistency rule
    avg_consistency = (bt["home_consistency"] + bt["away_consistency"]) / 2
    print(f"\n  === 70% Consistency Rule ===")
    print(f"  Overall: {avg_consistency:.1%}")
    print(f"  {'✅ PASS' if avg_consistency >= 0.70 else '⚠️  BELOW'}")

    # Poisson line probabilities from error distribution
    sigma_h = home_metrics["sigma"]
    sigma_a = away_metrics["sigma"]
    print(f"\n  === Line Probabilities (Normal approx, σ_h={sigma_h:.2f}, σ_a={sigma_a:.2f}) ===")

    # Sample: first 5 test matches
    for i in range(min(5, len(valid[cut:]))):
        m = valid[cut + i]
        ph, pa = float(y_pred_h[i]), float(y_pred_a[i])
        pt = ph + pa
        print(f"  {m.home} vs {m.away}: pred={ph:.1f}+{pa:.1f}={pt:.1f} "
              f"actual={m.hc}+{m.ac}={m.total_corners}")

    # Save
    os.makedirs(os.path.join(ROOT, "models"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "output"), exist_ok=True)

    from joblib import dump
    dump(home_model, os.path.join(ROOT, "models", "corners_home_model.joblib"))
    dump(away_model, os.path.join(ROOT, "models", "corners_away_model.joblib"))

    meta = {
        "version": home_metrics["version"],
        "market": "corners",
        "source": "football-data.co.uk EPL/LaLiga/Bundesliga/SerieA 2014-2026",
        "features": FEATURE_NAMES,
        "n_features": len(FEATURE_NAMES),
        "n_train": cut,
        "n_test": n - cut,
        "holdout_range": f"{valid[cut].date} -> {valid[-1].date}",
        "home_metrics": home_metrics,
        "away_metrics": away_metrics,
        "backtest": {
            "n_matches": bt["n_matches"],
            "home_mae": bt["home_mae"],
            "away_mae": bt["away_mae"],
            "total_mae": bt["total_mae"],
            "home_consistency": bt["home_consistency"],
            "away_consistency": bt["away_consistency"],
            "total_consistency": bt["total_consistency"],
            "team_line_accuracy": bt["team_line_accuracy"],
            "total_line_accuracy": bt["total_line_accuracy"],
        },
        "seeds": SEASONS,
        "leagues": ACTIVE_LEAGUES,
    }

    with open(os.path.join(ROOT, "models", "corners_meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    with open(os.path.join(ROOT, "output", "corners_backtest.json"), "w") as f:
        json.dump(bt, f, indent=2)

    print(f"\n[v5] Saved to models/ and output/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
