#!/usr/bin/env python3
"""Team-name resolution for the corner pipeline.

The corner model is keyed on football-data.co.uk's raw team names (`Man United`,
`Nott'm Forest`, `M'gladbach`), while upcoming fixtures arrive from The Odds API
with their own spellings (`Manchester United`, `Nottingham Forest`,
`Borussia Monchengladbach`). The old pipeline relied on a hand-written alias
table for the four original leagues, so:

  * every club outside those four leagues failed to match, and
  * a promoted or renamed club failed to match even inside them,

and the fixture was then scored from a DEFAULT (league-average) state — silently
producing a confident-looking prediction built on no information. That is worse
than emitting nothing.

This module resolves names in tiers and always reports *how* it resolved, so the
caller can refuse to predict rather than guess. Order:

  1. exact
  2. normalised (accents folded, club-type suffixes stripped, punctuation
     removed, city/abbreviation expansions)
  3. token-set match (order- and filler-insensitive)
  4. fuzzy fallback via difflib, preferring clubs seen in the fixture's league

Tier 4 is deliberately conservative (0.88) — a wrong club is worse than no club.
"""

from __future__ import annotations

import unicodedata
from difflib import get_close_matches

# Club-type words that carry no identifying information.
SUFFIX_TOKENS = {
    "fc", "cf", "afc", "sc", "ac", "bc", "sv", "vfl", "vfb", "tsg", "ssc",
    "ss", "as", "us", "rc", "rcd", "ud", "cd", "sd", "ca", "cs", "cska",
    "1899", "1907", "1909", "1913", "1846", "1904", "1900", "1848", "98",
}

# Abbreviations football-data.co.uk uses that a naive strip would break.
# Tokens that mark a reserve / age-group side. Sharing every other token with the
# parent club must not be enough to match.
RESERVE_MARKERS = {"b", "ii", "iii", "castilla", "reserves", "reserve", "u19", "u21", "u23"}

ABBREV = {
    "man": "manchester",
    "nottm": "nottingham",
    "wolves": "wolverhampton",
    "spurs": "tottenham",
    "gladbach": "monchengladbach",
    "mgldbach": "monchengladbach",
    "ath": "athletic",
    "atl": "atletico",
    "dep": "deportivo",
    "espanol": "espanyol",
    "koln": "cologne",
    "ein": "eintracht",
    "bay": "bayern",
    "vallecano": "rayo vallecano",
    "sociedad": "real sociedad",
    "betis": "real betis",
    "inter": "internazionale",
}

# Explicit overrides win outright. Kept small on purpose — the tiers below
# handle most cases, and this table is a place where mistakes hide.
OVERRIDES = {
    "paris saint germain": "Paris SG",
    "paris sg": "Paris SG",
    "psg": "Paris SG",
    "bayern munich": "Bayern Munich",
    "bayern munchen": "Bayern Munich",
    "fc bayern munchen": "Bayern Munich",
    "inter milan": "Inter",
    "internazionale": "Inter",
    "ac milan": "Milan",
    "afc bournemouth": "Bournemouth",
    "brighton and hove albion": "Brighton",
    "brighton hove albion": "Brighton",
    "wolverhampton wanderers": "Wolves",
    "tottenham hotspur": "Tottenham",
    "sheffield utd": "Sheffield United",
    "newcastle utd": "Newcastle",
    "west ham utd": "West Ham",
    "man utd": "Man United",
    "man city": "Man City",
    "nott m forest": "Nott'm Forest",
    "nottingham forest": "Nott'm Forest",
    "borussia monchengladbach": "M'gladbach",
    "borussia mgldbach": "M'gladbach",
    "eintracht frankfurt": "Ein Frankfurt",
    "1 fc koln": "FC Koln",
    "fc koln": "FC Koln",
    "1 fc union berlin": "Union Berlin",
    "1 fc heidenheim": "Heidenheim",
    "sv darmstadt 98": "Darmstadt",
    "holstein kiel": "Holstein Kiel",
    "athletic club": "Ath Bilbao",
    "athletic bilbao": "Ath Bilbao",
    "atletico madrid": "Ath Madrid",
    "atletico de madrid": "Ath Madrid",
    "real sociedad": "Sociedad",
    "real betis": "Betis",
    "rc celta de vigo": "Celta",
    "rc celta": "Celta",
    "celta vigo": "Celta",
    "valencia cf": "Valencia",
    "getafe cf": "Getafe",
    "ca osasuna": "Osasuna",
    "rcd espanyol": "Espanol",
    "rcd mallorca": "Mallorca",
    "ud almeria": "Almeria",
    "cadiz cf": "Cadiz",
    "ud las palmas": "Las Palmas",
    "deportivo alaves": "Alaves",
    "girona fc": "Girona",
    "real valladolid": "Valladolid",
    "cd leganes": "Leganes",
    "rayo vallecano": "Vallecano",
    "ud granada": "Granada",
    "ssc napoli": "Napoli",
    "acf fiorentina": "Fiorentina",
    "as roma": "Roma",
    "ss lazio": "Lazio",
    "us lecce": "Lecce",
    "hellas verona": "Verona",
    "ac monza": "Monza",
    "us sassuolo": "Sassuolo",
    "empoli fc": "Empoli",
    "cagliari calcio": "Cagliari",
    "genoa cfc": "Genoa",
    "udinese calcio": "Udinese",
    "bologna fc": "Bologna",
    "torino fc": "Torino",
    "parma calcio": "Parma",
    "venezia fc": "Venezia",
    "como 1907": "Como",
    "us salernitana": "Salernitana",
    "us frosinone": "Frosinone",
}


def fold(name: str) -> str:
    """Lowercase, strip accents, drop punctuation, collapse whitespace."""
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    for ch in ".-'’,&/":
        s = s.replace(ch, " ")
    # Common club-type suffixes, and bare founding-year / numeral tokens
    # ("1. FC Magdeburg", "1899 Hoffenheim"), which carry no identity.
    toks = [
        t for t in s.split()
        if t and t not in SUFFIX_TOKENS and not t.isdigit()
    ]
    toks = [ABBREV.get(t, t) for t in toks]
    return " ".join(toks).strip()


def tokens(name: str) -> frozenset[str]:
    return frozenset(fold(name).split())


class TeamIndex:
    """Resolves API team names onto football-data.co.uk's spelling."""

    def __init__(self, names: list[str], team_leagues: dict[str, str] | None = None):
        self.exact: dict[str, str] = {}
        self.folded: dict[str, str] = {}
        self.by_token: dict[frozenset[str], str] = {}
        self.leagues: dict[str, str] = team_leagues or {}
        self._by_league: dict[str, list[str]] = {}
        for n in names:
            self.exact.setdefault(n, n)
            f = fold(n)
            if f:
                self.folded.setdefault(f, n)
                self.by_token.setdefault(tokens(n), n)
            lg = self.leagues.get(n)
            if lg:
                self._by_league.setdefault(lg, []).append(n)

    def resolve(self, name: str, league_hint: str = "") -> tuple[str | None, str]:
        """Return (resolved_name | None, method)."""
        if not name:
            return None, "empty"
        if name in self.exact:
            return self.exact[name], "exact"

        key = name.lower().strip()
        if key in OVERRIDES and OVERRIDES[key] in self.exact:
            return OVERRIDES[key], "override"

        f = fold(name)
        if f in self.folded:
            return self.folded[f], "normalised"

        tk = tokens(name)
        if tk and tk in self.by_token:
            return self.by_token[tk], "token-set"

        # Token SUBSET. This is the tier that actually matters: football-data
        # abbreviates (`Newcastle`, `Hull`, `Coventry`) while the feed spells the
        # club out (`Newcastle United`, `Hull City`, `Coventry City`). Requiring an
        # exact token-set equality missed every one of those — which is why 88 of
        # 145 fixtures were being skipped.
        sub = self._subset_candidates(tk)
        if sub:
            # A unique candidate is accepted outright. A string-ratio floor is the
            # wrong guard here — `newcastle united` vs `Newcastle` scores only 0.69
            # on SequenceMatcher purely because one name has an extra word, which is
            # exactly the case this tier exists for. Ambiguity is the real risk, so
            # that is what gets guarded: prefer the hinted league, then require a
            # clear margin over the runner-up.
            in_league = [n for n in sub if self.leagues.get(n) == league_hint]
            pool = in_league or sub
            ranked = sorted(pool, key=lambda n: -_ratio(f, fold(n)))
            best = ranked[0]
            if len(ranked) == 1:
                return best, "token-subset"
            br, second = _ratio(f, fold(best)), _ratio(f, fold(ranked[1]))
            if br - second >= 0.05:
                return best, "token-subset"

        # Fuzzy, scoped to the hinted league first so a near-miss in one country
        # can never land on a club from another, then globally as a last resort.
        for pool, method, cutoff in (
            (self._by_league.get(league_hint) or [], "fuzzy", 0.88),
            (list(self.exact), "fuzzy-global", 0.86),
        ):
            folded_pool = {n: fold(n) for n in pool if fold(n)}
            hits = get_close_matches(f, list(folded_pool.values()), n=1, cutoff=cutoff)
            if hits:
                for n, fv in folded_pool.items():
                    if fv == hits[0]:
                        return n, method
        return None, "unresolved"

    def _subset_candidates(self, tk: frozenset[str]) -> list[str]:
        """Clubs whose token set is a strict subset/superset of `tk`.

        Two guards, both aimed at the ways this could pick the wrong club:

        * a single generic token (`united`, `real`, `city`) must never be enough
          to bridge two clubs, so the smaller token set needs one token of five
          characters or more;
        * reserve/age-group sides share every token with their parent club
          (`Barcelona B`, `Real Madrid Castilla`), so any extra reserve marker
          disqualifies the match rather than folding a B team onto the first team.
        """
        if not tk:
            return []
        out: list[str] = []
        for other, cand in self.by_token.items():
            if not other or other == tk:
                continue
            if other < tk:
                smaller, extra = other, tk - other
            elif tk < other:
                smaller, extra = tk, other - tk
            else:
                continue
            if max((len(t) for t in smaller), default=0) < 5:
                continue
            if extra & RESERVE_MARKERS:
                continue
            out.append(cand)
        return out


def _ratio(a: str, b: str) -> float:
    from difflib import SequenceMatcher
    return SequenceMatcher(None, a, b).ratio()


def build_index(historical_league_by_team: dict[str, str]) -> TeamIndex:
    return TeamIndex(list(historical_league_by_team.keys()), historical_league_by_team)
