import type { BetStatus, Fixture, Outcome, Parlay, ParlayLeg, Settings } from "./types";
import type { SlipLeg } from "./ev";
import { clamp01, round } from "./math";
import { suggestedStake } from "./kelly";

/** Risk tier of a suggested parlay — safe parlays are few legs with high
 *  per-leg probability; risky parlays chase the big multiplier with more
 *  legs. Every tier still only uses legs that clear the singles EV gate, so
 *  the extra risk is variance, not negative-EV picks. */
export type ParlayTier = "safe" | "balanced" | "risky";

export interface ParlaySuggestion {
  legs: SlipLeg[];
  combinedOdds: number;
  combinedProbability: number;
  /** Break-even price derived from `combinedProbability` (1 / p). Always
   *  meaningful — for a model-only ticket it is the price the bookmaker must
   *  beat for the ticket to be worth placing. */
  fairOdds: number;
  /** bookmaker EV on the parlay = prob × advertised − 1 */
  ev: number;
  stake: number;
  warnings: string[];
  tier: ParlayTier;
  /** human label, e.g. "Safe accumulator · 2–4 legs" */
  tierLabel: string;
  /**
   * false for MODEL-ONLY tickets, built from legs that have no bookmaker price
   * in the feed. The probability math is real, but `combinedOdds`/`ev`/`stake`
   * are 0 and must NOT be presented as a payout — there is no price to compare
   * against, so there is no edge to claim.
   */
  priced: boolean;
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

/** Tier configs — the smarter picker builds ONE parlay per tier, greedily
 *  taking the HIGHEST-probability independent legs (never EV-chasing
 *  longshots, which is what made the old combos "never occur"). Every leg
 *  still comes from the flagged pool, so each one clears the singles EV gate
 *  by construction. More legs = bigger multiplier = higher variance — that's
 *  the honest trade labelled on each tier. */
const TIERS: Array<{ tier: ParlayTier; label: string; minLegs: number; maxLegs: number; minProb: number }> = [
  { tier: "safe", label: "Safe accumulator · 2–4 legs", minLegs: 2, maxLegs: 4, minProb: 0.68 },
  { tier: "balanced", label: "Balanced accumulator · 5–8 legs", minLegs: 5, maxLegs: 8, minProb: 0.58 },
  { tier: "risky", label: "Risky accumulator · 9–20 legs", minLegs: 9, maxLegs: 20, minProb: 0.50 },
];

/** Kickoff correlation window — matches in the same league kicking off within
 *  ~4h of each other share context (scheduling pressure, table stakes) and are
 *  treated as one "window" for the same-league constraint. */
const KICKOFF_WINDOW = 4 * 3600;

/** A (league, kickoff-window) bucket key. */
function kickoffWindowKey(f: Fixture): string {
  return `${f.league}:${Math.floor(f.commenceTime / KICKOFF_WINDOW)}`;
}

/**
 * Tier-aware correlation gate for the greedy picker.
 *
 * Same-Match (STRICT, all tiers): two legs from the exact same fixture are
 * never allowed — they share outcome space and can directly conflict (e.g.
 * Home Win + Away Win on one ticket).
 *
 * Same-League + Same-Kickoff (DYNAMIC BY TIER):
 *   🟢 safe     — max 1 match per league per kickoff window
 *   🟡 balanced — max 2 matches per league per kickoff window
 *   🔴 risky    — constraint disabled (the pool needs freedom to reach 20 legs)
 *
 * Because same-match is already blocked above, counting legs in a window is
 * exactly counting distinct matches in it.
 */
function canAddLeg(leg: SlipLeg, chosen: SlipLeg[], tier: ParlayTier): boolean {
  for (const c of chosen) {
    if (c.fixture.id === leg.fixture.id) return false; // same match — always strict
  }
  const maxPerWindow = tier === "safe" ? 1 : tier === "balanced" ? 2 : Infinity;
  if (!Number.isFinite(maxPerWindow)) return true; // risky: no league/window restriction
  const key = kickoffWindowKey(leg.fixture);
  let sameWindow = 0;
  for (const c of chosen) {
    if (kickoffWindowKey(c.fixture) === key) {
      sameWindow++;
      if (sameWindow >= maxPerWindow) return false;
    }
  }
  return true;
}

/**
 * Auto-suggest rule-compliant parlays from the flagged singles pool.
 *
 * How this picks (v2 — intelligent, risk-tiered):
 *  - the pool is the flagged singles, sorted by MODEL PROBABILITY descending
 *    (not by EV — EV-chasing floats longshots to the top and produces
 *    parlays that mathematically never land);
 *  - for each tier (safe 2–4 / balanced 5–8 / risky 9–20 legs) it greedily
 *    takes the next highest-probability leg that passes the tier's correlation
 *    gate — never same-match; same-league same-kickoff limited to 1 (safe) / 2
 *    (balanced) matches per window, and unlimited for risky;
 *  - legs below the tier's minimum probability are skipped — a 20-leg
 *    accumulator built from 50%+ legs is the "risky but live" profile;
 *  - one suggestion per tier, ranked by combined probability (chance of
 *    landing) so the UI shows the most-likely pick first.
 *
 * Selection + logging stays MANUAL — this only surfaces candidate groupings.
 */
export function suggestParlays(
  legs: SlipLeg[],
  settings: Settings,
  sport: "football" | "tennis",
  maxSuggestions = 12,
  pricing: "priced" | "model-only" = "priced",
): ParlaySuggestion[] {
  // "model-only" builds from the UNPRICED legs (`odds` 0 — markets the odds
  // feed has no line for, e.g. O1.5 / team-to-score). It is deliberately a
  // separate mode rather than a fallback: without a price there is no EV, so
  // the output is a probability tool, not a bet recommendation.
  const modelOnly = pricing === "model-only";
  const pool = legs
    .filter((l) => l.fixture.status === "scheduled" && Number.isFinite(l.odds))
    .filter((l) => (modelOnly ? !(l.odds > 1) : l.odds > 1))
    .sort((a, b) => b.probability - a.probability);

  const suggestions: ParlaySuggestion[] = [];
  for (const tier of TIERS) {
    // Generate up to 3 ALTERNATIVE parlays per tier. Each pass skips the top
    // `pass` eligible legs, so pass 0 builds the best combo, pass 1 the
    // second-best, pass 2 the third — genuinely different tickets instead of
    // near-duplicates of the same one.
    const perTierCount = tier.tier === "risky" ? 1 : 3;
    const usedLegKeys = new Set<string>();
    const eligible = pool.filter((l) => l.probability >= tier.minProb);

    for (let pass = 0; pass < perTierCount; pass++) {
      const chosen: SlipLeg[] = [];
      for (let i = pass; i < eligible.length && chosen.length < tier.maxLegs; i++) {
        const leg = eligible[i]!;
        const lk = `${leg.fixture.id}:${leg.market}:${leg.selection}`;
        if (usedLegKeys.has(lk)) continue; // skip legs already used by an earlier pass
        if (!canAddLeg(leg, chosen, tier.tier)) continue;
        chosen.push(leg);
      }
      if (chosen.length < tier.minLegs) break; // not enough eligible legs for another combo

      const p = clamp01(product(chosen.map((l) => l.probability)));
      // No price on any leg → no multiplier, no EV, no stake. `fairOdds` still
      // stands: it is 1/p, derived purely from the model probabilities.
      const odds = modelOnly ? 0 : product(chosen.map((l) => l.odds));
      const fairOdds = p > 0 ? 1 / p : 0;
      const stake = modelOnly ? 0 : suggestedStake(p, odds, settings.bankroll, settings);
      const warnings: string[] = [];
      if (modelOnly) {
        warnings.push(
          "Model-only: none of these legs have a bookmaker price in the feed, so there is NO EV check here. Compare every line against your own bookmaker — only place the ticket if its combined price beats the break-even odds above.",
        );
      }
      if (tier.tier === "risky") {
        warnings.push(
          "Risky tier: a big multiplier comes from compounding many legs — the true chance of ALL of them landing is low. Only stake money you can afford to lose.",
        );
      }
      suggestions.push({
        legs: chosen,
        combinedOdds: round(odds, 4),
        combinedProbability: round(p, 4),
        fairOdds: round(fairOdds, 4),
        ev: modelOnly ? 0 : round(p * odds - 1, 4),
        stake,
        warnings,
        tier: tier.tier,
        tierLabel: pass === 0 ? tier.label : `${tier.label} (option ${pass + 1})`,
        priced: !modelOnly,
      });
      // Mark these legs so the next pass picks a different combo
      for (const l of chosen) {
        usedLegKeys.add(`${l.fixture.id}:${l.market}:${l.selection}`);
      }
    }
  }

  return suggestions.sort((a, b) => b.combinedProbability - a.combinedProbability).slice(0, maxSuggestions);
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
