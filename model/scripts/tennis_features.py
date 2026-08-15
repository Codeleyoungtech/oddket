"""Tennis team/player-level feature builder — ATP main tour (v1).

Mirrors the football features.py discipline: features are computed ONLY from
information available before the match starts (no leakage), and each feature
group toggles independently so train_tennis.py can backtest them one at a
time (the tennis upgrade discipline from the PRD).

Design: tennis has no home advantage and no venue-meaningful ordering. The
Odds API assigns home/away arbitrarily (player 1 / player 2). So matches are
stored with p1/p2 ordered by PRE-MATCH surface-specific Elo (computed from
prior matches only). The model learns P(higher-Elo player wins). At predict
time the same ordering is applied to live fixtures, then mapped back to the
API's home/away.

Feature groups:
  base      — surface-specific Elo gap, ATP rank gap, best-of (3/5), surface
  h2h       — head-to-head win record between the two players
  ew_form   — exponentially weighted recent form (surface-weighted)
  rest      — days since last match + matches played in this tournament
  odds      — margin-adjusted implied probability from best book odds
  spread    — cross-bookmaker odds spread (max-min across books incl. Pinnacle)

Market extras (odds) are attached by tennis_fetch.py from the raw CSV row and
are never part of the team features themselves.
"""

from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass, field
from datetime import datetime

# Feature groups
BASE_FEATURES = ["elo_gap", "rank_gap", "best_of", "surface_hard", "surface_clay", "surface_grass", "surface_carpet", "tour_level"]
H2H_FEATURES = ["h2h_wins_p1", "h2h_gap"]
EW_FORM_FEATURES = ["ew_p1", "ew_p2", "ew_diff"]
REST_FEATURES = ["rest_p1", "rest_p2", "rest_diff", "tourn_matches_p1", "tourn_matches_p2"]
ODDS_FEATURES = ["implied_p1", "implied_p2", "implied_gap"]
SPREAD_FEATURES = ["spread_p1", "spread_p2", "spread_diff"]

FEATURE_GROUPS = {
    "base": BASE_FEATURES,
    "h2h": H2H_FEATURES,
    "ew_form": EW_FORM_FEATURES,
    "rest": REST_FEATURES,
    "odds": ODDS_FEATURES,
    "spread": SPREAD_FEATURES,
}
ALL_FEATURES = [f for g in FEATURE_GROUPS.values() for f in g]

EW_DECAY = 0.9       # recency decay for EW form
H2H_WINDOW = 6       # last N direct meetings considered
ELO_K = 32.0
START_RATING = 1500.0

TOUR_LEVEL = {"Grand Slam": 4, "Masters 1000": 3, "ATP 500": 2, "ATP 250": 1, "ATP 125": 0, "Other": 0}


@dataclass
class TennisMatch:
    id: str
    tournament: str
    year: str
    date: str
    ts: int
    p1: str          # pre-match higher-Elo player
    p2: str          # pre-match lower-Elo player
    p1_rank: float   # ATP ranking at match time (lower = better), 0 if unknown
    p2_rank: float
    surface: str     # hard | clay | grass | carpet
    best_of: int     # 3 or 5
    tour_level: int
    p1_won: int      # 1 if p1 (higher-Elo) won, 0 otherwise
    p1_sets: int     # sets won by p1
    p2_sets: int
    # Per-player best odds + cross-book prices, resolved BY NAME from the raw
    # CSV row at construction time. A bettor knows each player's price
    # pre-match, so this is outcome-independent (no winner/loser slot routing).
    p1_odds: float | None = None
    p2_odds: float | None = None
    p1_books: list = field(default_factory=list)
    p2_books: list = field(default_factory=list)
    features: dict = field(default_factory=dict)
    market: dict = field(default_factory=dict)   # {winner:{best,books}, loser:{best,books}}
    odds: dict = field(default_factory=dict)     # backtest odds (winner/loser best)
    market_raw: dict | None = None               # original CSV row (attached by fetch)


def _f(v) -> float | None:
    if v is None or str(v).strip() in ("", "-", "N/A"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def normalize_name(name: str) -> str:
    """'Sinner J.' -> 'Sinner'. Strip diacritics for cross-source matching."""
    n = re.sub(r"\s+[A-Za-z]\.$", "", name.strip())
    n = re.sub(r"\s+", " ", n).strip()
    return n


class PlayerState:
    """Running per-player state: surface Elos + trailing results."""

    __slots__ = ("elo", "elo_hard", "elo_clay", "elo_grass", "results", "last_ts")

    def __init__(self) -> None:
        self.elo = START_RATING
        self.elo_hard = START_RATING
        self.elo_clay = START_RATING
        self.elo_grass = START_RATING
        # (won_flag, surface, ts, sets_won, sets_lost, tourn_id) chronological
        self.results: list[tuple[int, str, int, int, int, str]] = []
        self.last_ts: int | None = None


def _expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def _surface_rating(state: PlayerState, surface: str) -> float:
    return {"hard": state.elo_hard, "clay": state.elo_clay, "grass": state.elo_grass}.get(surface, state.elo)


def _ew_form(state: PlayerState, surface: str, decay: float = EW_DECAY) -> float:
    """Exponentially weighted recent win rate — surface-weighted: matches on
    the same surface count double, others count once (recency decay applies)."""
    if not state.results:
        return 0.5
    w = 0.0
    total = 0.0
    for i, (won, surf, _, _, _, _) in enumerate(state.results):
        weight = decay ** (len(state.results) - 1 - i)
        if surf == surface:
            weight *= 2.0
        w += weight * (1.0 if won else 0.0)
        total += weight
    return w / total if total > 0 else 0.5


def _rest_days(state: PlayerState, ts: int) -> int:
    if state.last_ts is None:
        return 14
    return max(0, int((ts - state.last_ts) // 86400))


def compute_pair_features(p1: PlayerState, p2: PlayerState, recent: list[TennisMatch],
                          name1: str, name2: str, surface: str, p1_rank: float, p2_rank: float,
                          best_of: int, tour_level: int, ts: int) -> dict:
    """Full candidate feature vector for (p1, p2) — all leakage-free."""
    r1 = _surface_rating(p1, surface)
    r2 = _surface_rating(p2, surface)
    elo_gap = (r1 - r2) / 400.0

    # ATP rank gap (lower = better; unknown ranks get 0 -> treated as worst).
    rank1 = p1_rank if p1_rank and p1_rank > 0 else 9999
    rank2 = p2_rank if p2_rank and p2_rank > 0 else 9999
    rank_gap = (rank2 - rank1) / 100.0

    # H2H: wins for p1 (and p2) in recent direct meetings (up to H2H_WINDOW).
    h2h_p1 = h2h_p2 = 0
    for m in reversed(recent):
        if h2h_p1 + h2h_p2 >= H2H_WINDOW:
            break
        if m.p1 == name1 and m.p2 == name2:
            h2h_p1 += m.p1_won
            h2h_p2 += 1 - m.p1_won
        elif m.p1 == name2 and m.p2 == name1:
            h2h_p2 += m.p1_won
            h2h_p1 += 1 - m.p1_won

    ew1 = _ew_form(p1, surface)
    ew2 = _ew_form(p2, surface)
    rest1 = _rest_days(p1, ts)
    rest2 = _rest_days(p2, ts)

    # Matches played in the CURRENT tournament by each player (fatigue within
    # the week). Recent results carry the tournament id.
    tourn_m1 = sum(1 for (_, _, _, _, _, tid) in p1.results if tid and tid == f"{tour_level}@{ts // (7 * 86400)}")
    tourn_m2 = sum(1 for (_, _, _, _, _, tid) in p2.results if tid and tid == f"{tour_level}@{ts // (7 * 86400)}")

    f = {
        "elo_gap": round(elo_gap, 4),
        "rank_gap": round(rank_gap, 4),
        "best_of": float(best_of),
        "surface_hard": 1.0 if surface == "hard" else 0.0,
        "surface_clay": 1.0 if surface == "clay" else 0.0,
        "surface_grass": 1.0 if surface == "grass" else 0.0,
        "surface_carpet": 1.0 if surface == "carpet" else 0.0,
        "tour_level": float(tour_level),
        "h2h_wins_p1": float(h2h_p1),
        "h2h_gap": float(h2h_p1 - h2h_p2),
        "ew_p1": round(ew1, 4),
        "ew_p2": round(ew2, 4),
        "ew_diff": round(ew1 - ew2, 4),
        "rest_p1": float(rest1),
        "rest_p2": float(rest2),
        "rest_diff": float(rest1 - rest2),
        "tourn_matches_p1": float(tourn_m1),
        "tourn_matches_p2": float(tourn_m2),
        # market features (filled later from the CSV odds)
        "implied_p1": 0.0, "implied_p2": 0.0, "implied_gap": 0.0,
        "spread_p1": 0.0, "spread_p2": 0.0, "spread_diff": 0.0,
    }
    return f


def build_tennis_matches(rows: list[dict], meta: dict) -> list[TennisMatch]:
    """Chronologically walk raw tennis-data.co.uk rows, tracking per-player
    state, and emit TennisMatch objects ordered by PRE-MATCH surface Elo."""
    parsed: list[tuple[int, str, str, str, int, float, float, int, int, int, int, str]] = []
    for r in rows:
        try:
            ts = int(datetime.strptime(r["Date"], "%d/%m/%Y").timestamp())
        except (KeyError, ValueError):
            continue
        w = normalize_name(r.get("Winner", ""))
        l = normalize_name(r.get("Loser", ""))
        if not w or not l:
            continue
        surface = str(r.get("Surface", "")).strip()
        if surface not in ("Hard", "Clay", "Grass", "Carpet"):
            continue
        # set scores from W1..W5 / L1..L5 — count non-empty cells
        sets_w = sum(1 for i in range(1, 6) if str(r.get(f"W{i}", "")).strip() not in ("", "-"))
        sets_l = sum(1 for i in range(1, 6) if str(r.get(f"L{i}", "")).strip() not in ("", "-"))
        best_of = 5 if "5" in str(r.get("Best of", "")) else 3
        wrank = _f(r.get("WRank")) or 0.0
        lrank = _f(r.get("LRank")) or 0.0
        tour_level = TOUR_LEVEL.get(str(r.get("Series", "")).strip(), 0)
        parsed.append((ts, w, l, surface, best_of, wrank, lrank, sets_w, sets_l, tour_level, int(r.get("_year", 0)), r.get("_tournament", ""), r))

    parsed.sort(key=lambda x: x[0])
    players: dict[str, PlayerState] = {}
    matches: list[TennisMatch] = []
    seen: set[tuple[int, str, str]] = set()

    for (ts, w, l, surface, best_of, wrank, lrank, sets_w, sets_l, tour_level, year, tourn, r) in parsed:
        if (ts, w, l) in seen:
            continue
        seen.add((ts, w, l))
        ws = players.setdefault(w, PlayerState())
        ls = players.setdefault(l, PlayerState())

        # Order by pre-match surface Elo: p1 = higher, p2 = lower.
        rw = _surface_rating(ws, surface)
        rl = _surface_rating(ls, surface)
        if rw >= rl:
            p1, p2, p1_rank, p2_rank, p1_won, p1_sets, p2_sets = w, l, wrank, lrank, 1, sets_w, sets_l
            p1_state, p2_state = ws, ls
        else:
            p1, p2, p1_rank, p2_rank, p1_won, p1_sets, p2_sets = l, w, lrank, wrank, 0, sets_l, sets_w
            p1_state, p2_state = ls, ws

        date = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        tourn_week = f"{tour_level}@{ts // (7 * 86400)}"
        features = compute_pair_features(
            p1_state, p2_state, matches, p1, p2, surface.lower(),
            p1_rank, p2_rank, best_of, tour_level, ts,
        )
        # Resolve each player's odds BY NAME (winner/loser columns both carry
        # the player name + their price, so name matching is pre-match info).
        wname = normalize_name(r.get("Winner", ""))
        lname = normalize_name(r.get("Loser", ""))
        w_books = [_f(r.get(c)) for c in ("B365W", "PSW")]
        l_books = [_f(r.get(c)) for c in ("B365L", "PSL")]
        w_books = [b for b in w_books if b is not None and b > 1]
        l_books = [b for b in l_books if b is not None and b > 1]
        p1_books = w_books if p1 == wname else (l_books if p1 == lname else [])
        p2_books = w_books if p2 == wname else (l_books if p2 == lname else [])

        m = TennisMatch(
            id=f"{year}-{date}-{p1}-{p2}",
            tournament=tourn, year=str(year), date=date, ts=ts,
            p1=p1, p2=p2, p1_rank=p1_rank, p2_rank=p2_rank,
            surface=surface.lower(), best_of=best_of, tour_level=tour_level,
            p1_won=p1_won, p1_sets=p1_sets, p2_sets=p2_sets,
            p1_odds=max(p1_books) if p1_books else None,
            p2_odds=max(p2_books) if p2_books else None,
            p1_books=p1_books, p2_books=p2_books,
            features=features, market_raw=r,
        )
        matches.append(m)

        # --- update state AFTER the match (leakage-free) ---
        exp = _expected(rw, rl)          # P(winner-beats-loser) under current Elos
        ws.elo += ELO_K * (1.0 - exp)    # winner: actual 1, expected exp
        ls.elo += ELO_K * ((0.0) - (1.0 - exp))  # loser: actual 0, expected (1-exp)
        # surface Elos: update both from the match played on that surface
        surf_attr = f"elo_{surface.lower()}"
        if hasattr(ws, surf_attr):
            setattr(ws, surf_attr, getattr(ws, surf_attr) + ELO_K * (1.0 - exp))
        if hasattr(ls, surf_attr):
            setattr(ls, surf_attr, getattr(ls, surf_attr) + ELO_K * ((0.0) - (1.0 - exp)))
        ws.results.append((1, surface.lower(), ts, sets_w, sets_l, tourn_week))
        ls.results.append((0, surface.lower(), ts, sets_l, sets_w, tourn_week))
        ws.last_ts = ts
        ls.last_ts = ts

    return matches


def build_player_states(matches: list[TennisMatch]) -> dict[str, PlayerState]:
    """Replay history into per-player states (used by predict_tennis.py)."""
    players: dict[str, PlayerState] = {}
    for m in matches:
        ws = players.setdefault(m.p1, PlayerState())
        ls = players.setdefault(m.p2, PlayerState())
        exp_p1 = _expected(_surface_rating(ws, m.surface), _surface_rating(ls, m.surface))
        for st, won, sets_w, sets_l in ((ws, m.p1_won, m.p1_sets, m.p2_sets), (ls, 1 - m.p1_won, m.p2_sets, m.p1_sets)):
            # expected win prob: p1 -> exp_p1, p2 -> 1 - exp_p1
            exp_st = exp_p1 if st is ws else (1.0 - exp_p1)
            st.elo += ELO_K * (won - exp_st)
            surf = m.surface
            if hasattr(st, f"elo_{surf}"):
                setattr(st, f"elo_{surf}", getattr(st, f"elo_{surf}") + ELO_K * (won - exp_st))
            st.results.append((won, surf, m.ts, sets_w, sets_l, f"{m.tour_level}@{m.ts // (7 * 86400)}"))
            st.last_ts = m.ts
    return players


def fill_odds_features(m: TennisMatch) -> None:
    """Margin-adjusted implied probabilities + cross-book spread for p1/p2.
    Uses the NAME-resolved books (each player's price known pre-match), NOT
    the winner/loser slot — routing by outcome leaked the result (verified:
    100% accuracy / 0 Brier when fill used m.p1_won)."""
    p1_books = [b for b in m.p1_books if b and b > 1]
    p2_books = [b for b in m.p2_books if b and b > 1]
    p1_odds = max(p1_books) if p1_books else None
    p2_odds = max(p2_books) if p2_books else None
    if p1_odds and p2_odds and p1_odds > 1 and p2_odds > 1:
        inv1, inv2 = 1.0 / p1_odds, 1.0 / p2_odds
        s = inv1 + inv2
        m.features["implied_p1"] = round(inv1 / s, 4)
        m.features["implied_p2"] = round(inv2 / s, 4)
        m.features["implied_gap"] = round((inv1 - inv2) / s, 4)
    for key, books in (("spread_p1", p1_books), ("spread_p2", p2_books)):
        if len(books) >= 2:
            mn, mx = min(books), max(books)
            m.features[key] = round((mx - mn) / mn, 4) if mn > 0 else 0.0
    if m.features["spread_p1"] and m.features["spread_p2"]:
        m.features["spread_diff"] = round(m.features["spread_p1"] - m.features["spread_p2"], 4)


def matches_to_dict(matches: list[TennisMatch], meta: dict) -> dict:
    return {
        "meta": {**meta, "n_matches": len(matches)},
        "matches": [
            {
                "id": m.id, "tournament": m.tournament, "year": m.year, "date": m.date, "ts": m.ts,
                "p1": m.p1, "p2": m.p2, "p1_rank": m.p1_rank, "p2_rank": m.p2_rank,
                "surface": m.surface, "best_of": m.best_of, "tour_level": m.tour_level,
                "p1_won": m.p1_won, "p1_sets": m.p1_sets, "p2_sets": m.p2_sets,
                "p1_odds": m.p1_odds, "p2_odds": m.p2_odds,
                "p1_books": m.p1_books, "p2_books": m.p2_books,
                "features": m.features, "market": m.market, "odds": m.odds,
            }
            for m in matches
        ],
    }


def load_tennis_matches_dict(path: str) -> list[TennisMatch]:
    with open(path) as fh:
        data = json.load(fh)
    matches = []
    for m in data["matches"]:
        matches.append(TennisMatch(
            id=m["id"], tournament=m.get("tournament", ""), year=m.get("year", ""),
            date=m.get("date", ""), ts=m.get("ts", 0),
            p1=m["p1"], p2=m["p2"], p1_rank=m.get("p1_rank", 0.0), p2_rank=m.get("p2_rank", 0.0),
            surface=m.get("surface", "hard"), best_of=m.get("best_of", 3), tour_level=m.get("tour_level", 0),
            p1_won=m["p1_won"], p1_sets=m.get("p1_sets", 0), p2_sets=m.get("p2_sets", 0),
            p1_odds=m.get("p1_odds"), p2_odds=m.get("p2_odds"),
            p1_books=m.get("p1_books", []), p2_books=m.get("p2_books", []),
            features=m.get("features", {}), market=m.get("market", {}), odds=m.get("odds", {}),
        ))
    return matches


def parse_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))
