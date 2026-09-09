#!/usr/bin/env python3
"""Generate corner predictions for upcoming fixtures.

Uses the V5 trained models to predict per-team corner counts,
then computes line probabilities using Negative Binomial distribution.

Output: JSON with predictions including:
  - expected corners (μ)
  - confidence interval
  - over/under line probabilities (O3.5, O4.5, O5.5, O6.5, O7.5, O8.5)
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
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
SEASONS = [
    "2014_15", "2015_16", "2016_17", "2017_18", "2018_19",
    "2019_20", "2020_21", "2021_22", "2022_23", "2023_24",
    "2024_25", "2025_26",
]
FORM_WINDOWS = [5, 10, 15]
TEAM_LEAGUE_AVG = 5.25

# Lines to compute probabilities for
TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]
TOTAL_LINES = [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5]

# Team name aliases (API name → historical name)
TEAM_ALIASES = {
    # EPL: API name → football-data.co.uk name
    "Nottingham Forest": "Nott'm Forest",
    "Nott'm Forest": "Nott'm Forest",
    "Manchester United": "Man United",
    "Man United": "Man United",
    "Manchester City": "Man City",
    "Man City": "Man City",
    "Newcastle United": "Newcastle",
    "Newcastle": "Newcastle",
    "West Ham United": "West Ham",
    "West Ham": "West Ham",
    "Brighton & Hove Albion": "Brighton",
    "Brighton": "Brighton",
    "Wolverhampton Wanderers": "Wolves",
    "Wolves": "Wolves",
    "Tottenham Hotspur": "Tottenham",
    "Tottenham": "Tottenham",
    "Sheffield United": "Sheffield United",
    "Burnley": "Burnley",
    "Luton Town": "Luton",
    "Luton": "Luton",
    "Bournemouth": "Bournemouth",
    "AFC Bournemouth": "Bournemouth",
    # La Liga
    "Real Madrid": "Real Madrid",
    "FC Barcelona": "Barcelona",
    "Barcelona": "Barcelona",
    "Atlético Madrid": "Ath Madrid",
    "Ath Madrid": "Ath Madrid",
    "Athletic Club": "Ath Bilbao",
    "Ath Bilbao": "Ath Bilbao",
    "Real Sociedad": "Sociedad",
    "Sociedad": "Sociedad",
    "Real Betis": "Betis",
    "Betis": "Betis",
    "Sevilla FC": "Sevilla",
    "Sevilla": "Sevilla",
    "RC Celta de Vigo": "Celta",
    "RC Celta": "Celta",
    "Celta Vigo": "Celta",
    "Celta": "Celta",
    "Valencia CF": "Valencia",
    "Valencia": "Valencia",
    "Getafe CF": "Getafe",
    "Getafe": "Getafe",
    "CA Osasuna": "Osasuna",
    "Osasuna": "Osasuna",
    "RCD Espanyol": "Espanol",
    "Espanyol": "Espanol",
    "Espanol": "Espanol",
    "RCD Mallorca": "Mallorca",
    "Mallorca": "Mallorca",
    "UD Almería": "Almeria",
    "Almería": "Almeria",
    "Almeria": "Almeria",
    "Cádiz CF": "Cadiz",
    "Cádiz": "Cadiz",
    "Cadiz": "Cadiz",
    "UD Las Palmas": "Las Palmas",
    "Las Palmas": "Las Palmas",
    "Deportivo Alavés": "Alaves",
    "Alavés": "Alaves",
    "Alaves": "Alaves",
    "Girona FC": "Girona",
    "Girona": "Girona",
    "Real Valladolid": "Valladolid",
    "Valladolid": "Valladolid",
    "CD Leganés": "Leganes",
    "Leganes": "Leganes",
    "Rayo Vallecano": "Vallecano",
    "Vallecano": "Vallecano",
    "UD Granada": "Granada",
    "Granada": "Granada",
    # Bundesliga
    "Bayern Munich": "Bayern Munich",
    "FC Bayern München": "Bayern Munich",
    "Borussia Dortmund": "Dortmund",
    "Dortmund": "Dortmund",
    "Borussia Mönchengladbach": "M'gladbach",
    "Borussia Monchengladbach": "M'gladbach",
    "M'gladbach": "M'gladbach",
    "Eintracht Frankfurt": "Ein Frankfurt",
    "Ein Frankfurt": "Ein Frankfurt",
    "SC Freiburg": "Freiburg",
    "Freiburg": "Freiburg",
    "VfB Stuttgart": "Stuttgart",
    "Stuttgart": "Stuttgart",
    "VfL Wolfsburg": "Wolfsburg",
    "Wolfsburg": "Wolfsburg",
    "TSG Hoffenheim": "Hoffenheim",
    "Hoffenheim": "Hoffenheim",
    "FC Augsburg": "Augsburg",
    "Augsburg": "Augsburg",
    "1. FC Union Berlin": "Union Berlin",
    "Union Berlin": "Union Berlin",
    "FC St. Pauli": "St Pauli",
    "St Pauli": "St Pauli",
    "1. FC Heidenheim": "Heidenheim",
    "Heidenheim": "Heidenheim",
    "Holstein Kiel": "Holstein Kiel",
    "SV Darmstadt 98": "Darmstadt",
    "Darmstadt": "Darmstadt",
    "1. FC Köln": "FC Koln",
    "FC Köln": "FC Koln",
    "FC Koln": "FC Koln",
    "VfL Bochum": "Bochum",
    "Bochum": "Bochum",
    "Bayer Leverkusen": "Leverkusen",
    "Leverkusen": "Leverkusen",
    "RB Leipzig": "RB Leipzig",
    # Serie A
    "AC Milan": "Milan",
    "Milan": "Milan",
    "Inter Milan": "Inter",
    "Inter": "Inter",
    "SSC Napoli": "Napoli",
    "Napoli": "Napoli",
    "ACF Fiorentina": "Fiorentina",
    "Fiorentina": "Fiorentina",
    "AS Roma": "Roma",
    "Roma": "Roma",
    "SS Lazio": "Lazio",
    "Lazio": "Lazio",
    "US Lecce": "Lecce",
    "Lecce": "Lecce",
    "Hellas Verona": "Verona",
    "Verona": "Verona",
    "AC Monza": "Monza",
    "Monza": "Monza",
    "US Sassuolo": "Sassuolo",
    "Sassuolo": "Sassuolo",
    "Empoli FC": "Empoli",
    "Empoli": "Empoli",
    "Cagliari Calcio": "Cagliari",
    "Cagliari": "Cagliari",
    "Genoa CFC": "Genoa",
    "Genoa": "Genoa",
    "Udinese Calcio": "Udinese",
    "Udinese": "Udinese",
    "Bologna FC": "Bologna",
    "Bologna": "Bologna",
    "Torino FC": "Torino",
    "Torino": "Torino",
    "Parma Calcio": "Parma",
    "Parma": "Parma",
    "Venezia FC": "Venezia",
    "Venezia": "Venezia",
    "Como 1907": "Como",
    "Como": "Como",
    "Juventus": "Juventus",
    "US Salernitana": "Salernitana",
    "Salernitana": "Salernitana",
    "US Frosinone": "Frosinone",
    "Frosinone": "Frosinone",
    "AC Perugia": "Perugia",
    "Perugia": "Perugia",
}

# Accent normalization
ACCENT_MAP = {
    "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u",
    "ñ": "n", "ü": "u", "ß": "ss",
}


def normalize_name(name: str) -> str:
    """Normalize team name for matching."""
    name = name.strip()
    # Check alias table
    if name in TEAM_ALIASES:
        return TEAM_ALIASES[name]
    # Strip accents
    for acc, rep in ACCENT_MAP.items():
        name = name.replace(acc, rep)
    # Strip common suffixes
    lower = name.lower()
    for suffix in [" fc", " cf", " afc", " sc", " ac", " bc", " sv", " oss", " us", " ss", " rc"]:
        if lower.endswith(suffix):
            name = name[:-len(suffix)].strip()
            lower = name.lower()
    return name


# ---------------------------------------------------------------------------
# Data loading (same as train script)
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
    try:
        return float(val.strip())
    except (ValueError, TypeError):
        return 0.0


class TeamState:
    __slots__ = (
        "cf_home", "cf_away", "ca_home", "ca_away",
        "shots_home", "shots_away", "sot_home", "sot_away",
        "fouls_home", "fouls_away", "cards_home", "cards_away",
        "goals_home", "goals_away", "gc_home", "gc_away",
        "corner_history", "last_ts", "n_matches",
    )

    def __init__(self):
        self.cf_home: list[int] = []
        self.cf_away: list[int] = []
        self.ca_home: list[int] = []
        self.ca_away: list[int] = []
        self.shots_home: list[int] = []
        self.shots_away: list[int] = []
        self.sot_home: list[int] = []
        self.sot_away: list[int] = []
        self.fouls_home: list[int] = []
        self.fouls_away: list[int] = []
        self.cards_home: list[int] = []
        self.cards_away: list[int] = []
        self.goals_home: list[int] = []
        self.goals_away: list[int] = []
        self.gc_home: list[int] = []
        self.gc_away: list[int] = []
        self.corner_history: list[tuple[int, bool]] = []
        self.last_ts: int = 0
        self.n_matches: int = 0


def _mean(lst: list, n: int = 0) -> float:
    w = lst[-n:] if n > 0 else lst
    return sum(w) / len(w) if w else 0.0


def _std(lst: list, n: int = 0) -> float:
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
    return (s[mid - 1] + s[mid]) / 2.0 if len(s) % 2 == 0 else float(s[mid])


def _ew_mean(values: list[float], decay: float = 0.85) -> float:
    if not values:
        return 0.0
    w_sum = v_sum = 0.0
    for i, v in enumerate(values):
        w = decay ** (len(values) - 1 - i)
        w_sum += w
        v_sum += w * v
    return v_sum / w_sum if w_sum > 0 else 0.0


def _over_rate(values: list[int], line: float) -> float:
    if not values:
        return 0.0
    return sum(1 for v in values if v > line) / len(values)


def _elo_update(elo: float, expected: float, actual: float, k: float = 20.0) -> float:
    return elo + k * (actual - expected)


# ---------------------------------------------------------------------------
# Load historical data for team state building
# ---------------------------------------------------------------------------
def load_historical(data_dir: str) -> list[dict]:
    """Load all historical matches for building team state."""
    matches = []
    seen = set()
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
                    with open(path, encoding="utf-8-sig") as f:
                        reader = csv.DictReader(f)
                        for i, row in enumerate(reader):
                            hc = row.get("HC", "").strip()
                            ac = row.get("AC", "").strip()
                            if not hc.isdigit() or not ac.isdigit():
                                continue
                            date_str, ts = _parse_date(row.get("Date", ""))
                            if not ts:
                                continue
                            h_name = normalize_name(row.get("HomeTeam", "").strip())
                            a_name = normalize_name(row.get("AwayTeam", "").strip())
                            match_key = f"{h_name}:{a_name}:{date_str}"
                            if match_key in seen:
                                continue
                            seen.add(match_key)
                            matches.append({
                                "home": h_name,
                                "away": a_name,
                                "league": league,
                                "date": date_str,
                                "ts": ts,
                                "hc": int(hc), "ac": int(ac),
                                "hs": _int(row.get("HS", "0")), "as_": _int(row.get("AS", "0")),
                                "hst": _int(row.get("HST", "0")), "ast": _int(row.get("AST", "0")),
                                "hf": _int(row.get("HF", "0")), "af": _int(row.get("AF", "0")),
                                "hy": _int(row.get("HY", "0")), "ay": _int(row.get("AY", "0")),
                                "hr": _int(row.get("HR", "0")), "ar": _int(row.get("AR", "0")),
                                "fthg": _int(row.get("FTHG", "0")), "ftag": _int(row.get("FTAG", "0")),
                                "odds_h": _float(row.get("B365H", row.get("AvgH", "0"))),
                                "odds_d": _float(row.get("B365D", row.get("AvgD", "0"))),
                                "odds_a": _float(row.get("B365A", row.get("AvgA", "0"))),
                                "ou_25_over": _float(row.get("B365>2.5", row.get("Avg>2.5", "0"))),
                                "ah_home": _float(row.get("AHh", "0")),
                                "total_corners": int(hc) + int(ac),
                            })
    matches.sort(key=lambda m: m["ts"])
    return matches


def compute_elo(matches: list[dict]) -> dict[str, float]:
    elos: dict[str, float] = {}
    for m in matches:
        h = elos.setdefault(m["home"], 1500.0)
        a = elos.setdefault(m["away"], 1500.0)
        exp_h = 1.0 / (1.0 + 10 ** ((a - h) / 400.0))
        actual_h = min(1.0, max(0.0, 0.5 + (m["hc"] - m["ac"]) / 8.0))
        elos[m["home"]] = _elo_update(h, exp_h, actual_h)
        elos[m["away"]] = _elo_update(a, 1.0 - exp_h, 1.0 - actual_h)
    return elos


def build_team_states(matches: list[dict]) -> dict[str, TeamState]:
    """Build team states from historical data (same as training)."""
    teams: dict[str, TeamState] = {}
    for m in matches:
        home = m["home"]
        away = m["away"]
        hs = teams.setdefault(home, TeamState())
        as_ = teams.setdefault(away, TeamState())

        hs.cf_home.append(m["hc"])
        hs.ca_home.append(m["ac"])
        hs.shots_home.append(m["hs"])
        hs.sot_home.append(m["hst"])
        hs.fouls_home.append(m["hf"])
        hs.cards_home.append(m["hy"] + m["hr"])
        hs.goals_home.append(m["fthg"])
        hs.gc_home.append(m["ftag"])
        hs.corner_history.append((m["hc"], True))
        hs.last_ts = m["ts"]
        hs.n_matches += 1

        as_.cf_away.append(m["ac"])
        as_.ca_away.append(m["hc"])
        as_.shots_away.append(m["as_"])
        as_.sot_away.append(m["ast"])
        as_.fouls_away.append(m["af"])
        as_.cards_away.append(m["ay"] + m["ar"])
        as_.goals_away.append(m["ftag"])
        as_.gc_away.append(m["fthg"])
        as_.corner_history.append((m["ac"], False))
        as_.last_ts = m["ts"]
        as_.n_matches += 1

    return teams


# ---------------------------------------------------------------------------
# Feature computation (must match training exactly)
# ---------------------------------------------------------------------------
def compute_features(home: TeamState, away: TeamState,
                     home_name: str, away_name: str,
                     ts: int, elo_ratings: dict[str, float]) -> dict:
    features = {}

    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        cf_venue = state.cf_home if is_home else state.cf_away
        ca_venue = state.ca_home if is_home else state.ca_away

        for w in FORM_WINDOWS:
            features[f"{prefix}_cf_l{w}"] = round(_mean(cf_venue, w), 4)
            features[f"{prefix}_ca_l{w}"] = round(_mean(ca_venue, w), 4)

        all_cf = state.cf_home + state.cf_away
        all_ca = state.ca_home + state.ca_away
        features[f"{prefix}_cf_season"] = round(_mean(all_cf), 4)
        features[f"{prefix}_ca_season"] = round(_mean(all_ca), 4)

        if len(all_cf) > 30:
            prev = all_cf[:-min(10, len(all_cf))]
            features[f"{prefix}_cf_prev_season"] = round(_mean(prev[-30:]), 4) if len(prev) >= 10 else features[f"{prefix}_cf_season"]
        else:
            features[f"{prefix}_cf_prev_season"] = features[f"{prefix}_cf_season"]

        features[f"{prefix}_cf_ew"] = round(_ew_mean([float(x) for x in cf_venue]), 4)

        home_cf = _mean(state.cf_home if is_home else state.cf_away, 10)
        opp_ca = _mean(away.ca_away if is_home else home.ca_home, 10)
        features[f"{prefix}_baseline"] = round((home_cf + opp_ca) / 2.0, 4)

    # Layer 2: consistency
    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        cf_venue = state.cf_home if is_home else state.cf_away
        features[f"{prefix}_cf_std"] = round(_std(cf_venue, 10), 4)
        features[f"{prefix}_cf_cv"] = round(_std(cf_venue, 10) / max(_mean(cf_venue, 10), 0.1), 4)
        features[f"{prefix}_cf_median"] = round(_median(cf_venue, 10), 1)
        features[f"{prefix}_cf_min"] = float(min(cf_venue[-10:]) if cf_venue else 0)
        features[f"{prefix}_cf_max"] = float(max(cf_venue[-10:]) if cf_venue else 0)
        for line in [3.5, 4.5, 5.5, 6.5]:
            features[f"{prefix}_over_{line}"] = round(_over_rate(cf_venue, line), 4)

    # Layer 3: home/away strength
    features["home_cf_home_l10"] = round(_mean(home.cf_home, 10), 4)
    features["home_ca_home_l10"] = round(_mean(home.ca_home, 10), 4)
    features["away_cf_away_l10"] = round(_mean(away.cf_away, 10), 4)
    features["away_ca_away_l10"] = round(_mean(away.ca_away, 10), 4)
    features["home_total_home_l10"] = round(_mean(home.cf_home, 10) + _mean(home.ca_home, 10), 4)
    features["away_total_away_l10"] = round(_mean(away.cf_away, 10) + _mean(away.ca_away, 10), 4)

    # Layer 4: opponent interaction
    features["h_attack_x_a_defense"] = round(_mean(home.cf_home, 10) * _mean(away.ca_away, 10) / 25.0, 4)
    features["a_attack_x_h_defense"] = round(_mean(away.cf_away, 10) * _mean(home.ca_home, 10) / 25.0, 4)
    home_matchup = _mean(home.cf_home, 10) + _mean(away.ca_away, 10)
    away_matchup = _mean(away.cf_away, 10) + _mean(home.ca_home, 10)
    features["home_matchup"] = round(home_matchup, 4)
    features["away_matchup"] = round(away_matchup, 4)
    features["matchup_diff"] = round(home_matchup - away_matchup, 4)

    # Layer 5: shots/fouls/cards/goals
    for prefix, state, is_home in [("h", home, True), ("a", away, False)]:
        shots_venue = state.shots_home if is_home else state.shots_away
        sot_venue = state.sot_home if is_home else state.sot_away
        fouls_venue = state.fouls_home if is_home else state.fouls_away
        cards_venue = state.cards_home if is_home else state.cards_away
        goals_venue = state.goals_home if is_home else state.goals_away
        conceded_venue = state.gc_home if is_home else state.gc_away

        for w in [5, 10]:
            features[f"{prefix}_shots_l{w}"] = round(_mean(shots_venue, w), 4)
            features[f"{prefix}_sot_l{w}"] = round(_mean(sot_venue, w), 4)
            features[f"{prefix}_fouls_l{w}"] = round(_mean(fouls_venue, w), 4)
            features[f"{prefix}_cards_l{w}"] = round(_mean(cards_venue, w), 4)
            features[f"{prefix}_goals_l{w}"] = round(_mean(goals_venue, w), 4)
            features[f"{prefix}_conceded_l{w}"] = round(_mean(conceded_venue, w), 4)

        features[f"{prefix}_shots_corners_ratio"] = round(
            _mean(shots_venue, 10) / max(_mean(shots_venue, 10) + 5.0, 1.0), 4
        )

    features["h_shots_x_a_conceded"] = round(
        _mean(home.shots_home, 10) * _mean(away.gc_away, 10) / 50.0, 4
    )
    features["a_shots_x_h_conceded"] = round(
        _mean(away.shots_away, 10) * _mean(home.gc_home, 10) / 50.0, 4
    )

    # Layer 6: Elo
    features["home_elo"] = round(elo_ratings.get(home_name, 1500.0), 1)
    features["away_elo"] = round(elo_ratings.get(away_name, 1500.0), 1)
    features["elo_diff"] = round(
        elo_ratings.get(home_name, 1500.0) - elo_ratings.get(away_name, 1500.0), 1
    )
    features["elo_expected_home"] = round(
        1.0 / (1.0 + 10 ** ((elo_ratings.get(away_name, 1500) - elo_ratings.get(home_name, 1500)) / 400.0)), 4
    )

    # Layer 7: odds (default for prediction — no live odds)
    features["implied_home"] = 0.33
    features["implied_draw"] = 0.33
    features["implied_away"] = 0.33
    features["odds_overround"] = 1.0
    features["implied_goals_over25"] = 0.5
    features["ah_home"] = 0.0

    # Layer 8: context
    home_rest = max(0, (ts - home.last_ts) // 86400) if home.last_ts else 14
    away_rest = max(0, (ts - away.last_ts) // 86400) if away.last_ts else 14
    features["home_rest"] = float(home_rest)
    features["away_rest"] = float(away_rest)
    features["rest_diff"] = float(home_rest - away_rest)
    features["home_n"] = float(min(home.n_matches, 40))
    features["away_n"] = float(min(away.n_matches, 40))

    for league in ACTIVE_LEAGUES:
        features[f"league_{league}"] = 0.0  # unknown for prediction

    return features


# ---------------------------------------------------------------------------
# Negative Binomial line probabilities
# ---------------------------------------------------------------------------
def nb_line_prob(mu: float, sigma: float, line: float) -> float:
    """Compute P(X > line) using Negative Binomial distribution.

    mu: expected corner count
    sigma: model's prediction error std (from backtest)
    line: the betting line (e.g. 6.5)
    """
    from scipy.stats import nbinom

    if mu <= 0 or sigma <= 0:
        return 0.0

    # Negative Binomial parameterization: Var = mu + mu²/r
    # sigma² ≈ Var → r = mu² / (sigma² - mu)
    var = sigma ** 2
    if var <= mu:
        # Underdispersed → use Poisson instead
        from scipy.stats import poisson
        return 1.0 - poisson.cdf(int(line), mu)

    r = mu ** 2 / (var - mu)
    p = r / (r + mu)

    # P(X > line) = 1 - CDF(line)
    return 1.0 - nbinom.cdf(int(line), r, p)


# ---------------------------------------------------------------------------
# Main prediction
# ---------------------------------------------------------------------------
def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(ROOT, "data", "corners"))
    ap.add_argument("--upcoming", default=None, help="JSON file with upcoming fixtures")
    ap.add_argument("--fixtures", default=None, help="Alias for --upcoming")
    ap.add_argument("--api-url", default=None, help="Worker API URL to fetch fixtures")
    args = ap.parse_args()

    # Project root for footballdata
    project_root = os.path.dirname(ROOT)
    data_dir = os.path.join(project_root, "footballdata")

    # Load historical data for team states
    print("[predict] Loading historical data for team states...")
    historical = load_historical(data_dir)
    print(f"[predict] {len(historical)} historical matches loaded")

    teams = build_team_states(historical)
    elo = compute_elo(historical)
    print(f"[predict] {len(teams)} teams, {len(elo)} Elo ratings")

    # Load models
    from joblib import load
    home_model = load(os.path.join(ROOT, "models", "corners_home_model.joblib"))
    away_model = load(os.path.join(ROOT, "models", "corners_away_model.joblib"))

    # Load feature names from meta
    with open(os.path.join(ROOT, "models", "corners_meta.json")) as f:
        meta = json.load(f)
    feature_names = meta["features"]

    # Load σ from backtest
    sigma_h = meta["home_metrics"]["sigma"]
    sigma_a = meta["away_metrics"]["sigma"]
    sigma_total = math.sqrt(sigma_h**2 + sigma_a**2)
    print(f"[predict] Models loaded (σ_h={sigma_h:.2f}, σ_a={sigma_a:.2f}, σ_total={sigma_total:.2f})")

    # Get upcoming fixtures
    upcoming_file = args.upcoming or args.fixtures
    if upcoming_file:
        with open(upcoming_file) as f:
            fixtures = json.load(f)
    elif args.api_url:
        import urllib.request
        with urllib.request.urlopen(args.api_url) as resp:
            fixtures = json.loads(resp.read())
    else:
        # Read from stdin
        fixtures = json.loads(sys.stdin.read())

    # Normalize fixtures
    if isinstance(fixtures, dict) and "fixtures" in fixtures:
        fixtures = fixtures["fixtures"]

    predictions = []
    for fx in fixtures:
        home_name = normalize_name(fx.get("homeTeam", fx.get("home_team", fx.get("home", ""))))
        away_name = normalize_name(fx.get("awayTeam", fx.get("away_team", fx.get("away", ""))))
        fixture_id = fx.get("fixture_id", fx.get("id", ""))
        kickoff = fx.get("commenceTime", fx.get("kickoff", fx.get("date", "")))
        league = fx.get("league", "")

        if not home_name or not away_name:
            continue

        hs = teams.get(home_name)
        as_ = teams.get(away_name)

        if not hs or not as_:
            # New team with no history — use league average
            print(f"  [warn] No history for {home_name} or {away_name}, using defaults")
            hs = hs or TeamState()
            as_ = as_ or TeamState()

        ts = int(datetime.now().timestamp())
        feats = compute_features(hs, as_, home_name, away_name, ts, elo)

        # Ensure correct feature order
        x = np.array([[feats.get(f, 0.0) for f in feature_names]], dtype=float)

        pred_h = float(home_model.predict(x)[0])
        pred_a = float(away_model.predict(x)[0])
        pred_total = pred_h + pred_a

        # Confidence interval (±1.5σ)
        ci_h = (max(0, pred_h - 1.5 * sigma_h), pred_h + 1.5 * sigma_h)
        ci_a = (max(0, pred_a - 1.5 * sigma_a), pred_a + 1.5 * sigma_a)

        # Line probabilities using Negative Binomial
        team_lines = {}
        for line in TEAM_LINES:
            team_lines[f"O{line}"] = round(nb_line_prob(pred_h, sigma_h, line), 4)

        total_lines = {}
        for line in TOTAL_LINES:
            total_lines[f"O{line}"] = round(nb_line_prob(pred_total, sigma_total, line), 4)

        predictions.append({
            "fixture_id": fixture_id,
            "home": fx.get("homeTeam", fx.get("home_team", fx.get("home", ""))),
            "away": fx.get("awayTeam", fx.get("away_team", fx.get("away", ""))),
            "league": league,
            "kickoff": kickoff,
            "home_team_corners": {
                "expected": round(pred_h, 2),
                "ci_low": round(ci_h[0], 2),
                "ci_high": round(ci_h[1], 2),
                "lines": team_lines,
            },
            "away_team_corners": {
                "expected": round(pred_a, 2),
                "ci_low": round(ci_a[0], 2),
                "ci_high": round(ci_a[1], 2),
                "lines": {
                    f"O{line}": round(nb_line_prob(pred_a, sigma_a, line), 4)
                    for line in TEAM_LINES
                },
            },
            "total_corners": {
                "expected": round(pred_total, 2),
                "lines": total_lines,
            },
        })

    # Output
    output = {
        "generated_at": datetime.now().isoformat(),
        "model_version": meta["version"],
        "sigma": {"home": sigma_h, "away": sigma_a, "total": round(sigma_total, 2)},
        "n_fixtures": len(predictions),
        "predictions": predictions,
    }

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
