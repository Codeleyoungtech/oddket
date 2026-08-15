import type { Fixture, OddsSnapshot } from "@oddket/core";
import { fetchOdds, type ApiOddsEvent } from "./client";

export interface TennisMappedEvent {
  fixture: Fixture;
  snapshots: OddsSnapshot[];
}

/**
 * Map a tennis API event into a Fixture + h2h odds snapshots.
 * Tennis h2h outcomes are named after the PLAYERS (no Draw outcome), so
 * home/away resolve purely by name match against home_team/away_team.
 */
export function mapTennisEvent(event: ApiOddsEvent, capturedAt: number): TennisMappedEvent {
  const fixture: Fixture = {
    id: event.id,
    sport: "tennis",
    league: event.sport_title,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: Math.floor(new Date(event.commence_time).getTime() / 1000),
    status: "scheduled",
  };

  const snapshots: OddsSnapshot[] = [];
  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets) {
      if (market.key !== "h2h") continue; // match-winner only for V1
      for (const outcome of market.outcomes) {
        let selection: "home" | "away" | null = null;
        if (outcome.name === fixture.homeTeam) selection = "home";
        else if (outcome.name === fixture.awayTeam) selection = "away";
        if (selection === null) continue;
        if (outcome.price <= 1.01) continue;
        snapshots.push({
          id: `${fixture.id}:h2h:${selection}:${book.key.replace(/\W+/g, "").toLowerCase()}`,
          fixtureId: fixture.id,
          market: "h2h",
          selection,
          odds: Math.round(outcome.price * 100) / 100,
          bookmaker: book.title,
          capturedAt,
          isClosing: false,
        });
      }
    }
  }

  return { fixture, snapshots };
}

/**
 * Pull current odds for a list of tennis tournament sport keys (each key is
 * one API credit; out-of-season tournaments return an empty array). Returns
 * mapped fixtures + snapshots, and the list of sport keys that had data.
 */
export async function fetchTennisOdds(
  apiKey: string,
  sportKeys: string[],
  opts: { regions?: string; fetchLimit?: number } = {},
): Promise<{ events: TennisMappedEvent[]; activeSports: string[] }> {
  const capturedAt = Math.floor(Date.now() / 1000);
  const events: TennisMappedEvent[] = [];
  const activeSports: string[] = [];

  for (const sport of sportKeys) {
    try {
      const apiEvents = await fetchOdds(apiKey, {
        sport,
        regions: opts.regions ?? "eu",
        markets: "h2h", // match-winner only for V1
        fetchLimit: opts.fetchLimit ?? 50,
      });
      if (apiEvents.length === 0) continue; // out of season — no credit wasted on mapping
      activeSports.push(sport);
      for (const e of apiEvents) events.push(mapTennisEvent(e, capturedAt));
    } catch (err) {
      // A single tournament key failing shouldn't kill the whole pull —
      // log and continue (the free tier's coverage varies per tournament).
      console.error(`[tennis] ${sport} pull failed: ${String(err).slice(0, 200)}`);
    }
  }

  return { events, activeSports };
}
