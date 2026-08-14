import type { Fixture, OddsSnapshot, Selection } from "@oddket/core";

export const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

export interface ApiOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface ApiMarket {
  key: string; // h2h | totals | btts | spreads
  outcomes: ApiOutcome[];
}

export interface ApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: ApiMarket[];
}

export interface ApiOddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: ApiBookmaker[];
}

/** Map an API outcome name + market to our Selection enum. */
export function toSelection(market: string, name: string): Selection | null {
  switch (market) {
    case "h2h":
      return name === "Draw" ? "draw" : null; // home/away resolved by team name match below
    case "totals":
      return name.toLowerCase().startsWith("over") ? "over" : name.toLowerCase().startsWith("under") ? "under" : null;
    case "btts":
      return name.toLowerCase() === "yes" ? "yes" : name.toLowerCase() === "no" ? "no" : null;
    default:
      return null;
  }
}

export interface MappedEvent {
  fixture: Fixture;
  snapshots: OddsSnapshot[];
}

/**
 * Convert an API event into a Fixture + opening odds snapshots.
 * Draw outcome only exists for h2h; home/away are matched by team name.
 */
export function mapEvent(event: ApiOddsEvent, bookmakerKeys: string[], capturedAt: number): MappedEvent {
  const fixture: Fixture = {
    id: event.id,
    sport: event.sport_key,
    league: event.sport_title,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: Math.floor(new Date(event.commence_time).getTime() / 1000),
    status: "scheduled",
  };

  const snapshots: OddsSnapshot[] = [];
  for (const book of event.bookmakers ?? []) {
    // empty bookmakerKeys = keep ALL bookmakers (best-price + totals coverage)
    if (bookmakerKeys.length > 0 && !bookmakerKeys.includes(book.key)) continue;
    for (const market of book.markets) {
      // Only h2h / totals-2.5 / btts are supported on the free tier budget.
      if (market.key === "totals") {
        const line = market.outcomes[0]?.point;
        if (line !== undefined && line !== 2.5) continue;
      }
      for (const outcome of market.outcomes) {
        if (market.key === "h2h") {
          // h2h outcomes are named after the teams (+ Draw) — resolve by name,
          // since toSelection() only maps non-team outcomes (e.g. Draw).
          if (outcome.name === "Draw") {
            push(snapshots, fixture.id, "h2h", "draw", outcome.price, book.title, capturedAt);
          } else if (outcome.name === fixture.homeTeam) {
            push(snapshots, fixture.id, "h2h", "home", outcome.price, book.title, capturedAt);
          } else if (outcome.name === fixture.awayTeam) {
            push(snapshots, fixture.id, "h2h", "away", outcome.price, book.title, capturedAt);
          }
        } else {
          const selection = toSelection(market.key, outcome.name);
          if (selection === null) continue;
          push(snapshots, fixture.id, market.key, selection, outcome.price, book.title, capturedAt);
        }
      }
    }
  }

  return { fixture, snapshots };
}

function push(
  out: OddsSnapshot[],
  fixtureId: string,
  market: string,
  selection: Selection,
  odds: number,
  bookmaker: string,
  capturedAt: number,
) {
  if (odds <= 1.01) return;
  const marketKey = market as OddsSnapshot["market"];
  out.push({
    id: `${fixtureId}:${marketKey}:${selection}:${bookmaker.replace(/\W+/g, "").toLowerCase()}`,
    fixtureId,
    market: marketKey,
    selection,
    odds: Math.round(odds * 100) / 100,
    bookmaker,
    capturedAt,
    isClosing: false,
  });
}

export async function fetchOdds(
  apiKey: string,
  opts: { sport?: string; sports?: string[]; regions?: string; markets?: string; fetchLimit?: number; bookmakers?: string } = {},
): Promise<ApiOddsEvent[]> {
  const regions = opts.regions ?? "eu";
  const markets = opts.markets ?? "h2h,totals";
  const limit = opts.fetchLimit ?? 10;

  // The Odds API wants strict YYYY-MM-DDTHH:MM:SSZ — toISOString() has milliseconds.
  const commenceTimeFrom = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Multiple leagues: one API credit per sport key.
  const sports = opts.sports && opts.sports.length > 0 ? opts.sports : [opts.sport ?? "soccer_epl"];

  // No bookmaker filter: limiting to bet365/sportybet/betway silently dropped
  // the totals market (only some books carry it in the eu region). Pulling all
  // books also gives better best-price entry, which is the strategy's lever.
  const bookmakers = opts.bookmakers ? `&bookmakers=${encodeURIComponent(opts.bookmakers)}` : "";

  const all: ApiOddsEvent[] = [];
  for (const sport of sports) {
    const url =
      `${ODDS_API_BASE}/sports/${sport}/odds/` +
      `?apiKey=${encodeURIComponent(apiKey)}` +
      `&regions=${encodeURIComponent(regions)}` +
      `&markets=${encodeURIComponent(markets)}` +
      `&oddsFormat=decimal` +
      `${bookmakers}` +
      `&commenceTimeFrom=${encodeURIComponent(commenceTimeFrom)}`;

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`The Odds API ${res.status} for ${sport}: ${body.slice(0, 300)}`);
    }
    const events = (await res.json()) as ApiOddsEvent[];
    all.push(...events.slice(0, limit));
  }
  return all;
}
