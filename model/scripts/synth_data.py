"""Deterministic-ish synthetic match data generator.

The generator models a hidden "true" process (team strengths + home advantage +
form noise) and derives results + bookmaker odds from it. A model trained on
this data therefore has *real signal to find* — the same shape as the offline
demo dataset used by the web app — while staying fully offline.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field

SEED = 20260813
TEAMS = [
    "Arsenal", "Chelsea", "Liverpool", "Man City", "Man Utd", "Tottenham",
    "Newcastle", "Aston Villa", "Brighton", "West Ham",
    "Real Madrid", "Barcelona", "Atletico", "Sevilla", "Villarreal",
    "Bayern", "Dortmund", "Leverkusen", "Leipzig", "Inter",
    "Milan", "Juventus", "Napoli", "Roma", "Lazio",
]


def rng(seed: int):
    """SplitMix64 PRNG — deterministic across runs."""
    state = seed & 0xFFFFFFFFFFFFFFFF

    def next_u64() -> int:
        nonlocal state
        state = (state + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        z = state
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9 & 0xFFFFFFFFFFFFFFFF
        z = (z ^ (z >> 27)) * 0x94D049BB133111EB & 0xFFFFFFFFFFFFFFFF
        return z ^ (z >> 31)

    def rand() -> float:
        return next_u64() / 2**64

    return rand


@dataclass
class Match:
    id: str
    league: str
    home: str
    away: str
    home_goals: int
    away_goals: int
    features: dict  # inputs for the model
    outcome: int  # 0 = home, 1 = draw, 2 = away
    probs: dict  # hidden truth probabilities (h2h)
    odds: dict  # bookmaker odds (h2h)


@dataclass
class SynthDataset:
    matches: list = field(default_factory=list)
    meta: dict = field(default_factory=dict)


def _team_strength(seed: int, name: str) -> float:
    h = hashlib.sha256(f"{seed}:{name}".encode()).digest()
    return int.from_bytes(h[:2], "big") / 65535.0  # 0..1


def generate_synthetic(n_matches: int = 900, seed: int = SEED, out_path: str | None = None) -> SynthDataset:
    rand = rng(seed)
    leagues = {
        "EPL": TEAMS[:10],
        "La Liga": TEAMS[10:15],
        "Bundesliga": TEAMS[15:19],
        "Serie A": TEAMS[19:25],
    }

    strengths = {name: _team_strength(seed, name) for name in TEAMS}
    matches: list[Match] = []
    idx = 0

    while len(matches) < n_matches:
        for league, teams in leagues.items():
            if len(matches) >= n_matches:
                break
            home, away = teams[idx % len(teams)], teams[(idx + 1) % len(teams)]
            if home == away:
                idx += 1
                continue

            sh, sa = strengths[home], strengths[away]
            # Home advantage ~0.06 goals, form noise per team
            home_form = rand() - 0.5
            away_form = rand() - 0.5

            # Hidden truth: expected goals
            exp_home = max(0.3, 1.15 + (sh - sa) * 2.2 + home_form * 0.5)
            exp_away = max(0.3, 0.95 + (sa - sh) * 2.2 + away_form * 0.5)

            # True win/draw/loss probabilities from a bivariate Poisson-ish model
            lam_h = exp_home
            lam_a = exp_away
            p_home = 1 - math.exp(-lam_h) * (1 + lam_a * 0.55)
            p_away = 1 - math.exp(-lam_a) * (1 + lam_h * 0.55)
            p_draw = max(0.05, 1 - p_home - p_away)
            total = p_home + p_away + p_draw
            p_home, p_draw, p_away = p_home / total, p_draw / total, p_away / total

            probs = {"home": p_home, "draw": p_draw, "away": p_away}

            # Bookmaker odds = fair odds + margin (1.06), rounded
            margin = 0.06
            fair = {k: 1.0 / v for k, v in probs.items()}
            odds = {
                k: round((fair[k] * (1 + margin)) * 100) / 100
                for k in fair
            }
            odds = {k: max(1.05, v) for k, v in odds.items()}

            # Sample the result
            r = rand()
            if r < p_home:
                outcome, hg, ag = 0, 1, 0
            elif r < p_home + p_draw:
                outcome, hg, ag = 1, 1, 1
            else:
                outcome, hg, ag = 2, 0, 1
            # sprinkle extra goals around the sampled result
            hg += 1 if rand() < (exp_home * 0.22) else 0
            ag += 1 if rand() < (exp_away * 0.22) else 0
            hg += 1 if (hg == ag and outcome == 0) else 0
            ag += 1 if (hg == ag and outcome == 2) else 0

            features = {
                "home_strength": sh,
                "away_strength": sa,
                "home_adv": 1.0,
                "form_diff": home_form - away_form,
                "exp_home": round(exp_home, 3),
                "exp_away": round(exp_away, 3),
            }

            matches.append(
                Match(
                    id=f"syn-{league.replace(' ', '').lower()}-{idx:04d}",
                    league=league,
                    home=home,
                    away=away,
                    home_goals=hg,
                    away_goals=ag,
                    features=features,
                    outcome=outcome,
                    probs=probs,
                    odds=odds,
                )
            )
            idx += 1

    ds = SynthDataset(
        matches=matches,
        meta={
            "seed": seed,
            "n_matches": len(matches),
            "leagues": list(leagues.keys()),
            "description": "Synthetic matches with a hidden team-strength process. Offline, deterministic.",
        },
    )

    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w") as fh:
            json.dump(_to_dict(ds), fh, indent=2)
    return ds


def _to_dict(ds: SynthDataset) -> dict:
    return {
        "meta": ds.meta,
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
            }
            for m in ds.matches
        ],
    }


def load_synthetic(path: str) -> SynthDataset:
    with open(path) as fh:
        data = json.load(fh)
    matches = [
        Match(
            id=m["id"],
            league=m["league"],
            home=m["home"],
            away=m["away"],
            home_goals=m["home_goals"],
            away_goals=m["away_goals"],
            features=m["features"],
            outcome=m["outcome"],
            probs=m["probs"],
            odds=m["odds"],
        )
        for m in data["matches"]
    ]
    return SynthDataset(matches=matches, meta=data["meta"])


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "data", "synthetic.json")
    ds = generate_synthetic(out_path=out)
    print(f"Generated {len(ds.matches)} synthetic matches -> {os.path.abspath(out)}")
