import type { BetStatus, Outcome, Parlay, ParlayLeg, Settings } from "./types";
import { checkLegIndependence, legRefs } from "./correlation";
import type { SlipLeg } from "./ev";
import { clamp01, round } from "./math";
import { suggestedStake } from "./kelly";

export interface ParlaySuggestion {
  legs: SlipLeg[];
  combinedOdds: number;
  combinedProbability: number;
  fairOdds: number;
  /** bookmaker EV on the parlay = prob × advertised − 1 */
  ev: number;
  stake: number;
  warnings: string[];
}

/** Product of leg odds / probabilities, with a guard for empty input. */
function product(nums: number[]): number {
  return nums.reduce((acc, n) => acc * n, 1);
}

/**
 * Combine legs into a parlay-shaped object (true compounded math only —
 * never the advertised multiplier alone).
 */
export function buildParlay(legs: SlipLeg[], sport: Parlay["sport"]): Omit<Parlay, "id" | "stake" | "bankrollAtBet" | "status" | "outcomeAmount" | "placedAt"> {
  const combinedProbability = product(legs.map((l) => l.probability));
  const combinedOdds = product(legs.map((l) => l.odds));
  const parlayLegs: ParlayLeg[] = legs.map((l) => ({
    fixtureId: l.fixture.id,
    market: l.market,
    selection: l.selection,
    odds: l.odds,
    probability: l.probability,
    sport: l.fixture.sport === "tennis" ? "tennis" : "football",
    homeTeam: l.fixture.homeTeam,
    awayTeam: l.fixture.awayTeam,
  }));
  return {
    sport,
    legs: parlayLegs,
    combinedOdds: round(combinedOdds, 4),
    combinedProbability: round(combinedProbability, 4),
  };
}

/**
 * Auto-suggest rule-compliant parlays from the flagged singles pool.
 *
 * Rules (from the multiples prompt):
 *  - max `settings.maxMultipleLegs` legs (default 3)
 *  - every leg individually clears the EV threshold (they come from the
 *    flagged-singles pool, so this holds by construction)
 *  - legs must be independent (correlation filter: no same-match legs, no
 *    same-league same-kickoff-window legs)
 *  - ranked by combined EV, most transparent first
 *
 * Selection + logging stays MANUAL — this only surfaces candidate groupings.
 */
export function suggestParlays(
  legs: SlipLeg[],
  settings: Settings,
  sport: "football" | "tennis",
  maxSuggestions = 8,
): ParlaySuggestion[] {
  const maxLegs = Math.max(2, Math.min(settings.maxMultipleLegs ?? 3, 6));
  const pool = legs.filter((l) => l.fixture.status === "scheduled");

  // Only cross-match combinations are safe: reject any combo with two legs
  // on the same fixture, and drop soft-correlated same-kickoff combos too.
  const combinations = generateCombinations(pool, 2, maxLegs);

  const suggestions: ParlaySuggestion[] = [];
  for (const combo of combinations) {
    const corr = checkLegIndependence(legRefs(combo));
    if (!corr.independent) continue; // rule-compliant only

    const p = clamp01(product(combo.map((l) => l.probability)));
    const odds = product(combo.map((l) => l.odds));
    const fairOdds = p > 0 ? 1 / p : 0;
    const stake = suggestedStake(p, odds, settings.bankroll, settings);
    suggestions.push({
      legs: combo,
      combinedOdds: round(odds, 4),
      combinedProbability: round(p, 4),
      fairOdds: round(fairOdds, 4),
      ev: round(p * odds - 1, 4),
      stake,
      warnings: [],
    });
  }

  return suggestions.sort((a, b) => b.ev - a.ev).slice(0, maxSuggestions);
}

/** All combinations of size k in [min, max] from the pool. */
function generateCombinations<T>(pool: T[], min: number, max: number): Array<T[]> {
  const out: Array<T[]> = [];
  const combos: T[] = [];
  const rec = (start: number) => {
    if (combos.length >= min) out.push([...combos]);
    if (combos.length === max) return;
    for (let i = start; i < pool.length; i++) {
      combos.push(pool[i]!);
      rec(i + 1);
      combos.pop();
    }
  };
  rec(0);
  return out;
}

/**
 * Resolve a parlay against fixture outcomes — ALL-OR-NOTHING.
 * Returns 'won' if every leg won, 'lost' if any leg lost, or null if any
 * leg's fixture has no outcome yet (still pending).
 */
export function resolveParlay(
  parlay: Parlay,
  outcomeByFixture: Map<string, Outcome>,
  tennisWinner: Map<string, "home" | "away">,
): { status: BetStatus; amount: number } | null {
  let anyPending = false;
  for (const leg of parlay.legs) {
    let won: boolean;
    if (leg.sport === "tennis") {
      const winner = tennisWinner.get(leg.fixtureId);
      if (!winner) {
        anyPending = true;
        continue;
      }
      won = leg.selection === winner;
    } else {
      const out = outcomeByFixture.get(leg.fixtureId);
      if (!out) {
        anyPending = true;
        continue;
      }
      won = selectionWonH2hOrTotal(leg.market, leg.selection, out.homeScore, out.awayScore);
    }
    if (!won) {
      // One leg lost → the whole parlay is lost (net = −stake).
      return { status: "lost", amount: -parlay.stake };
    }
  }
  if (anyPending) return null; // not fully resolved yet
  // Every leg won → payout at the combined multiplier.
  const amount = round(parlay.stake * (parlay.combinedOdds - 1), 2);
  return { status: "won", amount };
}

function selectionWonH2hOrTotal(market: string, selection: string, home: number, away: number): boolean {
  if (market === "totals") {
    const goals = home + away;
    return selection === "over" ? goals > 2 : goals <= 2;
  }
  // h2h (parlays only surface h2h/totals from the flagged pool)
  if (selection === "home") return home > away;
  if (selection === "away") return away > home;
  return home === away;
}
