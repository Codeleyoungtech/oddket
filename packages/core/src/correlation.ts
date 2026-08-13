import type { Fixture, Market, Selection } from "./types";
import type { SlipLeg } from "./ev";

export interface CorrelationCheck {
  independent: boolean;
  warnings: string[];
}

interface LegRef {
  fixture: Fixture;
  market: Market;
  selection: Selection;
  probability: number;
}

/**
 * Heuristic correlation check for multiple legs.
 *
 * True statistical independence is hard to prove, so we flag the obvious
 * dependence structures:
 *   1. Two legs on the SAME fixture are never independent (e.g. "Team A wins"
 *      + "Over 2.5" in the same match share outcome space).
 *   2. Two legs in the same league on the same matchday are correlated through
 *      shared context (table pressure, scheduling, rest days) — soft warning.
 */
export function checkLegIndependence(legs: LegRef[]): CorrelationCheck {
  const warnings: string[] = [];

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]!;
      const b = legs[j]!;
      if (a.fixture.id === b.fixture.id) {
        warnings.push(
          `"${a.fixture.homeTeam} vs ${a.fixture.awayTeam}" appears twice — these legs are NOT independent and the compounded probability overstates the real joint chance.`,
        );
      } else if (sameKickoffWindow(a.fixture, b.fixture)) {
        warnings.push(
          `${a.fixture.league} legs kicking off within hours of each other (${a.fixture.homeTeam} vs ${a.fixture.awayTeam} / ${b.fixture.homeTeam} vs ${b.fixture.awayTeam}) — results can be correlated through shared context.`,
        );
      }
    }
  }

  return { independent: warnings.length === 0, warnings };
}

function sameKickoffWindow(a: Fixture, b: Fixture): boolean {
  const HOUR = 3600;
  return a.league === b.league && Math.abs(a.commenceTime - b.commenceTime) < 4 * HOUR;
}

/** Wrap SlipLegs for the independence check. */
export function legRefs(legs: SlipLeg[]): LegRef[] {
  return legs.map((l) => ({
    fixture: l.fixture,
    market: l.market,
    selection: l.selection,
    probability: l.probability,
  }));
}

/**
 * Human label for a market+selection, e.g. ("totals","over") → "Over 2.5 goals".
 */
export function marketLabel(market: Market, selection: Selection): string {
  switch (market) {
    case "h2h":
      return selection === "home" ? "Match winner — Home" : selection === "away" ? "Match winner — Away" : "Match winner — Draw";
    case "totals":
      return selection === "over" ? "Over 2.5 goals" : "Under 2.5 goals";
    case "btts":
      return selection === "yes" ? "Both teams to score — Yes" : "Both teams to score — No";
    case "spreads":
      return `${selection === "home" ? "Home" : "Away"} handicap`;
    default:
      return `${market}: ${selection}`;
  }
}
