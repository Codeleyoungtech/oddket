"""Real team-level feature builder — v3 (accuracy upgrade).

Builds match rows with features derived ONLY from information available
before kickoff (no leakage). Odds are never team features; market odds are
attached separately (from historical_odds.json) and only used as explicit
market features in the model when enabled.

All candidate features are computed and stored per match; the experiment
harness (train.py) selects subsets via --features so each upgrade step can
be backtested independently:
  base        — form, Elo, goals, shots-on-target, H2H (v2 baseline)
  elo_split   — separate home-Elo and away-Elo per team
  ew_form     — exponentially weighted (recency-weighted) form
  rest        — days since each team's last match + short-rest flag
  odds        — logit of market implied probability (the -4.71% baseline)
  move        — odds movement: closing minus opening logit (steam)
  spread      — cross-bookmaker odds spread (max-min across books)

Team state tracking:
  - blended Elo (home_adv included in update)
  - home-only Elo and away-only Elo (updated from home/away matches only)
  - trailing results with goals, shots on target, and match timestamps
  - last-match timestamp per team (for rest days)
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass, field
from datetime import datetime

# Feature groups — "base" is always on; others toggle independently.
BASE_FEATURES = [
    "home_strength", "away_strength", "home_form", "away_form", "form_diff",
    "home_adv", "exp_home", "exp_away", "h2h_diff", "home_sot", "away_sot", "sot_diff",
    "home_tsr", "away_tsr", "tsr_diff", "home_gd", "away_gd", "gd_diff",
    "poi_h", "poi_d", "poi_a", "poi_over",
]
ELO_SPLIT_FEATURES = ["home_elo_h", "away_elo_a"]
EW_FORM_FEATURES = ["ew_home", "ew_away", "ew_diff"]
REST_FEATURES = ["rest_home", "rest_away", "rest_diff", "short_rest_home", "short_rest_away"]
ODDS_FEATURES = ["odd_h", "odd_d", "odd_a"]
OU_ODDS_FEATURES = ["odd_over", "odd_under"]
MOVE_FEATURES = ["move_h", "move_d", "move_a"]
SPREAD_FEATURES = ["spread_h", "spread_d", "spread_a"]
# Goal-volume features: directly predict over/under 2.5 by measuring
# how many goals each team scores and concedes per match.
OU_GOALS_FEATURES = [
    "ou_combined_avg_goals", "ou_home_scored_rate", "ou_away_scored_rate",
    "ou_home_conceded_rate", "ou_away_conceded_rate",
    "ou_h2h_avg_total", "ou_poisson_expected_total",
]

FEATURE_GROUPS = {
    "base": BASE_FEATURES,
    "elo_split": ELO_SPLIT_FEATURES,
    "ew_form": EW_FORM_FEATURES,
    "rest": REST_FEATURES,
    "odds": ODDS_FEATURES,
    "ou_odds": OU_ODDS_FEATURES,
    "ou_goals": OU_GOALS_FEATURES,
    "move": MOVE_FEATURES,
    "spread": SPREAD_FEATURES,
}
ALL_FEATURES = [f for g in FEATURE_GROUPS.values() for f in g]

FORM_WINDOW = 6        # last N league matches for flat form / expected goals
EW_DECAY = 0.85        # exponential decay factor for recency-weighted form
H2H_WINDOW = 4         # last N direct meetings for h2h feature
ELO_K = 24.0
ELO_HOME_ADV = 55.0
START_RATING = 1500.0
SHORT_REST_DAYS = 4    # rest below this counts as congestion


@dataclass
class Match:
    id: str
    league: str
    home: str
    away: str
    home_goals: int
    away_goals: int
    features: dict
    outcome: int  # 0 home, 1 draw, 2 away
    probs: dict = field(default_factory=dict)   # market-implied (optional)
    odds: dict = field(default_factory=dict)    # market odds (backtest only)
    date: str = ""
    ts: int = 0
    home_sot: int = 0
    away_sot: int = 0
    # market extras for steps 5/6 (attached by fetch from the CSV)
    market: dict = field(default_factory=dict)  # {home:{open,close,books[]}, ...}


def _outcome(hg: int, ag: int) -> int:
    if hg > ag:
        return 0
    if hg == ag:
        return 1
    return 2


def _points(outcome: int) -> float:
    return {0: 3.0, 1: 1.0, 2: 0.0}[outcome]


class TeamState:
    """Running state per team: Elo ratings + trailing results."""

    __slots__ = ("rating", "rating_home", "rating_away", "results", "last_ts")

    def __init__(self) -> None:
        self.rating = START_RATING
        self.rating_home = START_RATING
        self.rating_away = START_RATING
        # (outcome, hg, ag, shots_for, shots_against, ts, is_home) chronological
        self.results: list[tuple[int, int, int, int, int, int, bool]] = []
        self.last_ts: int | None = None


def _expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def _form_points(state: TeamState, window: int = FORM_WINDOW) -> float:
    recent = state.results[-window:]
    if not recent:
        return 0.5  # neutral prior for teams with no history
    return sum(_points(o) for o, _, _, _, _, _, _ in recent) / (3.0 * len(recent))


def _ew_form(state: TeamState, decay: float = EW_DECAY) -> float:
    """Exponentially weighted recent form — recent matches count more."""
    if not state.results:
        return 0.5
    w = 0.0
    total = 0.0
    for i, (o, _, _, _, _, _, _) in enumerate(state.results):
        weight = decay ** (len(state.results) - 1 - i)
        w += weight * _points(o) / 3.0
        total += weight
    return w / total if total > 0 else 0.5


def _avg_goals(state: TeamState, window: int = FORM_WINDOW) -> tuple[float, float]:
    recent = state.results[-window:]
    if not recent:
        return 1.3, 1.2
    gf = sum(hg if is_home else ag for _, hg, ag, _, _, _, is_home in recent) / len(recent)
    ga = sum(ag if is_home else hg for _, hg, ag, _, _, _, is_home in recent) / len(recent)
    return gf, ga


def _avg_sot(state: TeamState, window: int = FORM_WINDOW) -> tuple[float, float]:
    recent = state.results[-window:]
    if not recent:
        return 4.0, 4.0
    sf_avg = sum(sf for _, _, _, sf, sa, _, _ in recent) / len(recent)
    sa_avg = sum(sa for _, _, _, sf, sa, _, _ in recent) / len(recent)
    return sf_avg, sa_avg


def _rest_days(state: TeamState, ts: int) -> tuple[int, bool]:
    if state.last_ts is None:
        return 10, False
    rest = max(0, ts - state.last_ts) // 86400
    return int(rest), rest < SHORT_REST_DAYS


def _poisson_match_probs(lambda_h: float, mu_a: float, max_goals: int = 6) -> tuple[float, float, float, float]:
    """Compute exact Poisson probabilities for home win, draw, away win, over 2.5 goals."""
    p_h = 0.0
    p_d = 0.0
    p_a = 0.0
    p_over = 0.0

    def pois(k: int, lmb: float) -> float:
        return (math.exp(-lmb) * (lmb ** k)) / math.factorial(k)

    for hg in range(max_goals + 1):
        p_hg = pois(hg, lambda_h)
        for ag in range(max_goals + 1):
            p_ag = pois(ag, mu_a)
            p_score = p_hg * p_ag
            if hg > ag:
                p_h += p_score
            elif hg == ag:
                p_d += p_score
            else:
                p_a += p_score
            if hg + ag > 2.5:
                p_over += p_score
    total_1x2 = p_h + p_d + p_a
    if total_1x2 > 0:
        p_h /= total_1x2
        p_d /= total_1x2
        p_a /= total_1x2
    return p_h, p_d, p_a, p_over


def compute_pair_features(home_state: TeamState, away_state: TeamState,
                          recent: list[Match], home: str, away: str, ts: int) -> dict:
    """Full candidate feature vector for (home, away) — all leakage-free."""
    sh, sa = home_state.rating, away_state.rating
    home_form = _form_points(home_state)
    away_form = _form_points(away_state)
    home_gf, home_ga = _avg_goals(home_state)
    away_gf, away_ga = _avg_goals(away_state)
    home_sot_for, home_sot_against = _avg_sot(home_state)
    away_sot_for, away_sot_against = _avg_sot(away_state)
    ew_home = _ew_form(home_state)
    ew_away = _ew_form(away_state)
    rest_home, short_home = _rest_days(home_state, ts)
    rest_away, short_away = _rest_days(away_state, ts)

    # Total Shot Ratio (TSR) & Goal Differential
    home_tsr = home_sot_for / (home_sot_for + home_sot_against + 1e-4)
    away_tsr = away_sot_for / (away_sot_for + away_sot_against + 1e-4)
    tsr_diff = home_tsr - away_tsr

    home_gd = home_gf - home_ga
    away_gd = away_gf - away_ga
    gd_diff = home_gd - away_gd

    # Dynamic Poisson expected goals (home baseline ~1.45, away baseline ~1.15)
    lambda_h = max(0.2, min(4.0, 1.45 * (home_gf / 1.35) * (away_ga / 1.25)))
    mu_a = max(0.2, min(4.0, 1.15 * (away_gf / 1.25) * (home_ga / 1.35)))
    poi_h, poi_d, poi_a, poi_over = _poisson_match_probs(lambda_h, mu_a)

    # Goal-volume features: directly measure scoring/defensive rates
    # that predict over/under 2.5 goals.
    ou_combined_avg_goals = home_gf + home_ga + away_gf + away_ga  # total avg goals
    ou_home_scored_rate = home_gf  # home team goals scored per game
    ou_away_scored_rate = away_gf  # away team goals scored per game
    ou_home_conceded_rate = home_ga  # home team goals conceded per game
    ou_away_conceded_rate = away_ga  # away team goals conceded per game
    # H2H total goals: average total goals in recent direct meetings
    h2h_totals: list[float] = []
    for m in reversed(recent):
        if len(h2h_totals) >= H2H_WINDOW:
            break
        if (m.home == home and m.away == away) or (m.home == away and m.away == home):
            h2h_totals.append(m.home_goals + m.away_goals)
    ou_h2h_avg_total = sum(h2h_totals) / len(h2h_totals) if h2h_totals else (home_gf + home_ga + away_gf + away_ga) / 2
    # Poisson expected total: lambda_h + mu_a (both teams combined)
    ou_poisson_expected_total = lambda_h + mu_a

    # H2H: average goal difference in recent direct meetings
    h2h_diffs: list[float] = []
    for m in reversed(recent):
        if len(h2h_diffs) >= H2H_WINDOW:
            break
        if m.home == home and m.away == away:
            h2h_diffs.append(m.home_goals - m.away_goals)
        elif m.home == away and m.away == home:
            h2h_diffs.append(-(m.home_goals - m.away_goals))
    h2h_diff = sum(h2h_diffs) / len(h2h_diffs) if h2h_diffs else 0.0

    f = {
        # base
        "home_strength": round(sh / 1000.0, 4),
        "away_strength": round(sa / 1000.0, 4),
        "home_form": round(home_form, 4),
        "away_form": round(away_form, 4),
        "form_diff": round(home_form - away_form, 4),
        "home_adv": 1.0,
        "exp_home": round(home_gf, 4),
        "exp_away": round(away_gf, 4),
        "h2h_diff": round(h2h_diff, 4),
        "home_sot": round(home_sot_for, 4),
        "away_sot": round(away_sot_for, 4),
        "sot_diff": round(home_sot_for - away_sot_for, 4),
        "home_tsr": round(home_tsr, 4),
        "away_tsr": round(away_tsr, 4),
        "tsr_diff": round(tsr_diff, 4),
        "home_gd": round(home_gd, 4),
        "away_gd": round(away_gd, 4),
        "gd_diff": round(gd_diff, 4),
        "poi_h": round(poi_h, 4),
        "poi_d": round(poi_d, 4),
        "poi_a": round(poi_a, 4),
        "poi_over": round(poi_over, 4),
        # elo split
        "home_elo_h": round(home_state.rating_home / 1000.0, 4),
        "away_elo_a": round(away_state.rating_away / 1000.0, 4),
        # recency-weighted form
        "ew_home": round(ew_home, 4),
        "ew_away": round(ew_away, 4),
        "ew_diff": round(ew_home - ew_away, 4),
        # rest / congestion
        "rest_home": float(rest_home),
        "rest_away": float(rest_away),
        "rest_diff": float(rest_home - rest_away),
        "short_rest_home": 1.0 if short_home else 0.0,
        "short_rest_away": 1.0 if short_away else 0.0,
        # goal-volume features (directly predict over/under 2.5)
        "ou_combined_avg_goals": round(ou_combined_avg_goals, 4),
        "ou_home_scored_rate": round(ou_home_scored_rate, 4),
        "ou_away_scored_rate": round(ou_away_scored_rate, 4),
        "ou_home_conceded_rate": round(ou_home_conceded_rate, 4),
        "ou_away_conceded_rate": round(ou_away_conceded_rate, 4),
        "ou_h2h_avg_total": round(ou_h2h_avg_total, 4),
        "ou_poisson_expected_total": round(ou_poisson_expected_total, 4),
        # market features (filled in later from historical_odds.json)
        "odd_h": 0.0, "odd_d": 0.0, "odd_a": 0.0,
        "odd_over": 0.0, "odd_under": 0.0,
        "move_h": 0.0, "move_d": 0.0, "move_a": 0.0,
        "spread_h": 0.0, "spread_d": 0.0, "spread_a": 0.0,
    }
    return f


def build_league_matches(rows: list[dict], league: str, season: str = "") -> list[Match]:
    parsed: list[tuple[int, str, str, int, int, int, int]] = []
    for r in rows:
        try:
            hg = int(r.get("FTHG"))
            ag = int(r.get("FTAG"))
            hst = int(r.get("HST") or 0)
            ast = int(r.get("AST") or 0)
        except (TypeError, ValueError):
            continue
        if r.get("FTR") not in ("H", "D", "A"):
            continue
        try:
            ts = int(datetime.strptime(r.get("Date", ""), "%d/%m/%Y").timestamp())
        except ValueError:
            continue
        parsed.append((ts, r["HomeTeam"], r["AwayTeam"], hg, ag, hst, ast))
    parsed.sort(key=lambda x: x[0])

    teams: dict[str, TeamState] = {}
    matches: list[Match] = []
    seen: set[tuple[int, str, str]] = set()

    for ts, home, away, hg, ag, hst, ast in parsed:
        if (ts, home, away) in seen:
            continue
        seen.add((ts, home, away))
        date = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

        hs = teams.setdefault(home, TeamState())
        as_ = teams.setdefault(away, TeamState())

        features = compute_pair_features(hs, as_, matches, home, away, ts)
        outcome = _outcome(hg, ag)
        m = Match(
            id=f"{season}-{date}-{home}-{away}",
            league=league, home=home, away=away,
            home_goals=hg, away_goals=ag,
            features=features, outcome=outcome, date=date, ts=ts,
            home_sot=hst, away_sot=ast,
        )
        matches.append(m)

        # --- update state AFTER the match ---
        exp_h = _expected(hs.rating + ELO_HOME_ADV, as_.rating)
        exp_a = _expected(as_.rating, hs.rating + ELO_HOME_ADV)
        hs.rating += ELO_K * ((outcome == 0) - exp_h)
        as_.rating += ELO_K * ((outcome == 2) - exp_a)
        # split Elo: home team's home-rating vs away team's away-rating,
        # each updated only from the venue they actually played at
        exp_home = _expected(hs.rating_home + ELO_HOME_ADV, as_.rating_away)
        exp_away = _expected(as_.rating_away, hs.rating_home + ELO_HOME_ADV)
        hs.rating_home += ELO_K * ((outcome == 0) - exp_home)
        as_.rating_away += ELO_K * ((outcome == 2) - exp_away)
        hs.results.append((outcome, hg, ag, hst, ast, ts, True))
        as_.results.append((outcome, hg, ag, ast, hst, ts, False))
        hs.last_ts = ts
        as_.last_ts = ts

    return matches


def build_team_states(matches: list[Match]) -> dict[str, TeamState]:
    teams: dict[str, TeamState] = {}
    for m in matches:
        hs = teams.setdefault(m.home, TeamState())
        as_ = teams.setdefault(m.away, TeamState())
        exp_h = _expected(hs.rating + ELO_HOME_ADV, as_.rating)
        exp_a = _expected(as_.rating, hs.rating + ELO_HOME_ADV)
        hs.rating += ELO_K * ((m.outcome == 0) - exp_h)
        as_.rating += ELO_K * ((m.outcome == 2) - exp_a)
        exp_home = _expected(hs.rating_home + ELO_HOME_ADV, as_.rating_away)
        exp_away = _expected(as_.rating_away, hs.rating_home + ELO_HOME_ADV)
        hs.rating_home += ELO_K * ((m.outcome == 0) - exp_home)
        as_.rating_away += ELO_K * ((m.outcome == 2) - exp_away)
        hs.results.append((m.outcome, m.home_goals, m.away_goals, m.home_sot, m.away_sot, m.ts, True))
        as_.results.append((m.outcome, m.home_goals, m.away_goals, m.away_sot, m.home_sot, m.ts, False))
        hs.last_ts = m.ts
        as_.last_ts = m.ts
    return teams


def matches_to_dict(matches: list[Match]) -> dict:
    return {
        "meta": {"source": "football-data.co.uk", "n_matches": len(matches)},
        "matches": [
            {
                "id": m.id, "league": m.league, "home": m.home, "away": m.away,
                "home_goals": m.home_goals, "away_goals": m.away_goals,
                "features": m.features, "outcome": m.outcome,
                "probs": m.probs, "odds": m.odds, "date": m.date, "ts": m.ts,
                "home_sot": m.home_sot, "away_sot": m.away_sot, "market": m.market,
            }
            for m in matches
        ],
    }


def load_matches_dict(path: str) -> list[Match]:
    with open(path) as fh:
        data = json.load(fh)
    matches = []
    for m in data["matches"]:
        matches.append(Match(
            id=m["id"], league=m["league"], home=m["home"], away=m["away"],
            home_goals=m["home_goals"], away_goals=m["away_goals"],
            features=m["features"], outcome=m["outcome"],
            probs=m.get("probs", {}), odds=m.get("odds", {}), date=m.get("date", ""),
            ts=m.get("ts", 0), home_sot=m.get("home_sot", 0), away_sot=m.get("away_sot", 0),
            market=m.get("market", {}),
        ))
    return matches


def parse_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))
