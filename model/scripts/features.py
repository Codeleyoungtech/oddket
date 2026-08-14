"""Real team-level feature builder.

Builds match rows with features derived ONLY from each team's past results
(form, goals, an Elo-style strength rating, head-to-head). Crucially, the
current match's odds are NEVER used as features — odds are only consulted
later by the EV engine when comparing model probability to implied
probability. This kills the circularity that made the old model garbage
(it was fed features derived from the very odds it was supposed to beat).

Design:
- Matches are processed strictly chronologically. A match's features use
  only information available BEFORE kickoff (no lookahead, no leakage).
- Strength is an Elo-style rating updated after each match.
- Form / expected goals use a trailing window of the team's last N matches.
- H2H uses the last few direct meetings between the two teams.
- The exact same feature computation is used for training rows and for
  upcoming fixtures (via compute_pair_features on the final team states).
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import datetime

FEATURES = [
    "home_strength",
    "away_strength",
    "home_form",
    "away_form",
    "form_diff",
    "home_adv",
    "exp_home",
    "exp_away",
    "h2h_diff",
    "home_sot",
    "away_sot",
    "sot_diff",
]

FORM_WINDOW = 6        # last N league matches for form / expected goals
H2H_WINDOW = 4         # last N direct meetings for h2h feature
ELO_K = 24.0
ELO_HOME_ADV = 55.0
START_RATING = 1500.0


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
    probs: dict = field(default_factory=dict)   # optional market-implied
    odds: dict = field(default_factory=dict)    # optional market odds (backtest only)
    date: str = ""
    home_sot: int = 0
    away_sot: int = 0


def _outcome(hg: int, ag: int) -> int:
    if hg > ag:
        return 0
    if hg == ag:
        return 1
    return 2


def _points(outcome: int) -> float:
    return {0: 3.0, 1: 1.0, 2: 0.0}[outcome]


class TeamState:
    """Running state per team: Elo rating + trailing results (incl. shots)."""

    __slots__ = ("rating", "results")

    def __init__(self) -> None:
        self.rating = START_RATING
        # (outcome, hg, ag, shots_for, shots_against) chronological
        self.results: list[tuple[int, int, int, int, int]] = []


def _expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def _form_points(state: TeamState, window: int = FORM_WINDOW) -> float:
    recent = state.results[-window:]
    if not recent:
        return 0.5  # neutral prior for teams with no history
    return sum(_points(o) for o, _, _, _, _ in recent) / (3.0 * len(recent))


def _avg_goals(state: TeamState, window: int = FORM_WINDOW) -> tuple[float, float]:
    """Average goals scored / conceded over the trailing window."""
    recent = state.results[-window:]
    if not recent:
        return 1.3, 1.2
    gf = sum(hg if o in (0, 1) else ag for o, hg, ag, _, _ in recent) / len(recent)
    ga = sum(ag if o in (0, 1) else hg for o, hg, ag, _, _ in recent) / len(recent)
    return gf, ga


def _avg_sot(state: TeamState, window: int = FORM_WINDOW) -> tuple[float, float]:
    """Average shots on target for / against over the trailing window."""
    recent = state.results[-window:]
    if not recent:
        return 4.0, 4.0
    sf = sum(sf if o in (0, 1) else sa for o, _, _, sf, sa in recent) / len(recent)
    sa = sum(sa if o in (0, 1) else sf for o, _, _, sf, sa in recent) / len(recent)
    return sf, sa


def compute_pair_features(home_state: TeamState, away_state: TeamState, recent: list[Match], home: str, away: str) -> dict:
    """Feature vector for (home, away) from the current team states and the
    recent match history. Used identically for training rows and predictions."""
    sh, sa = home_state.rating, away_state.rating
    home_form = _form_points(home_state)
    away_form = _form_points(away_state)
    home_gf, home_ga = _avg_goals(home_state)
    away_gf, away_ga = _avg_goals(away_state)
    home_sot, _ = _avg_sot(home_state)
    away_sot, _ = _avg_sot(away_state)

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

    return {
        "home_strength": round(sh / 1000.0, 4),
        "away_strength": round(sa / 1000.0, 4),
        "home_form": round(home_form, 4),
        "away_form": round(away_form, 4),
        "form_diff": round(home_form - away_form, 4),
        "home_adv": 1.0,
        "exp_home": round(home_gf, 4),
        "exp_away": round(away_gf, 4),
        "h2h_diff": round(h2h_diff, 4),
        "home_sot": round(home_sot, 4),
        "away_sot": round(away_sot, 4),
        "sot_diff": round(home_sot - away_sot, 4),
    }


def build_league_matches(rows: list[dict], league: str, season: str = "") -> list[Match]:
    """Convert raw CSV rows (sorted by date) into leakage-free Match rows.

    rows: list of dicts with keys Date, HomeTeam, AwayTeam, FTHG, FTAG, FTR.
    """
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
        # football-data.co.uk dates are DD/MM/YYYY — parse to a sortable epoch
        try:
            ts = int(datetime.strptime(r.get("Date", ""), "%d/%m/%Y").timestamp())
        except ValueError:
            continue
        parsed.append((ts, r["HomeTeam"], r["AwayTeam"], hg, ag, hst, ast))
    parsed.sort(key=lambda x: x[0])

    teams: dict[str, TeamState] = {}
    matches: list[Match] = []
    seen: set[tuple[str, str, str]] = set()  # (date, home, away)

    for ts, home, away, hg, ag, hst, ast in parsed:
        if (ts, home, away) in seen:
            continue
        seen.add((ts, home, away))
        date = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

        hs = teams.setdefault(home, TeamState())
        as_ = teams.setdefault(away, TeamState())

        features = compute_pair_features(hs, as_, matches, home, away)
        outcome = _outcome(hg, ag)
        matches.append(Match(
            id=f"{season}-{date}-{home}-{away}",
            league=league,
            home=home,
            away=away,
            home_goals=hg,
            away_goals=ag,
            features=features,
            outcome=outcome,
            date=date,
            home_sot=hst,
            away_sot=ast,
        ))

        # --- update state AFTER the match (only info that becomes available) ---
        exp_h = _expected(hs.rating + ELO_HOME_ADV, as_.rating)
        exp_a = _expected(as_.rating, hs.rating + ELO_HOME_ADV)
        hs.rating += ELO_K * ((outcome == 0) - exp_h)
        as_.rating += ELO_K * ((outcome == 2) - exp_a)
        hs.results.append((outcome, hg, ag, hst, ast))
        as_.results.append((outcome, hg, ag, ast, hst))

    return matches


def build_team_states(matches: list[Match]) -> dict[str, TeamState]:
    """Reconstruct final team states from a list of matches (for predicting
    upcoming fixtures after training)."""
    teams: dict[str, TeamState] = {}
    for m in matches:
        hs = teams.setdefault(m.home, TeamState())
        as_ = teams.setdefault(m.away, TeamState())
        exp_h = _expected(hs.rating + ELO_HOME_ADV, as_.rating)
        exp_a = _expected(as_.rating, hs.rating + ELO_HOME_ADV)
        hs.rating += ELO_K * ((m.outcome == 0) - exp_h)
        as_.rating += ELO_K * ((m.outcome == 2) - exp_a)
        hs.results.append((m.outcome, m.home_goals, m.away_goals, m.home_sot, m.away_sot))
        as_.results.append((m.outcome, m.home_goals, m.away_goals, m.away_sot, m.home_sot))
    return teams


def matches_to_dict(matches: list[Match]) -> dict:
    return {
        "meta": {"source": "football-data.co.uk", "n_matches": len(matches)},
        "matches": [
            {
                "id": m.id,
                "league": m.league,
                "home": m.home,
                "away": m.away,
                "home_goals": m.home_goals,
                "away_goals": m.away_goals,
                "features": m.features,
                "outcome": m.outcome,
                "probs": m.probs,
                "odds": m.odds,
                "date": m.date,
                "home_sot": m.home_sot,
                "away_sot": m.away_sot,
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
            home_sot=m.get("home_sot", 0), away_sot=m.get("away_sot", 0),
        ))
    return matches


def parse_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))
