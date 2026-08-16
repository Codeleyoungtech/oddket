/**
 * Canonical record shapes shared across the whole system.
 * These mirror the D1 tables in `worker/src/db/schema.ts` 1:1.
 */

/**
 * The Odds API sport keys OddKet can pull live, keyed by the seed's league
 * names (Settings.leagues uses these display names). The model is trained on
 * these 4 leagues, so everything else gets skipped honestly at predict time.
 */
export const LEAGUE_SPORTS: Record<string, string> = {
  "English Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  "Bundesliga": "soccer_germany_bundesliga",
  "Serie A": "soccer_italy_serie_a",
};

/**
 * The Odds API TENNIS sport keys OddKet can pull live, keyed by tournament
 * display name. The Odds API covers tennis PER-TOURNAMENT (there is no single
 * `tennis_atp` key): Grand Slams + ATP 1000/500 + WTA equivalents. The tennis
 * build is ATP main tour (men's singles) — Challenger is NOT covered by any
 * free-tier odds source (see HANDOFF §11).
 *
 * NOTE: each tournament key is one API credit per pull, and out-of-season
 * tournaments return empty. The worker's tennis ingest loops only the keys
 * selected via settings/TENNIS_SPORTS env and skips empty responses.
 */
export const TENNIS_SPORTS: Record<string, string> = {
  "ATP Australian Open": "tennis_atp_aus_open_singles",
  "ATP French Open": "tennis_atp_french_open",
  "ATP Wimbledon": "tennis_atp_wimbledon",
  "ATP US Open": "tennis_atp_us_open",
  "ATP Indian Wells": "tennis_atp_indian_wells",
  "ATP Miami Open": "tennis_atp_miami_open",
  "ATP Monte-Carlo Masters": "tennis_atp_monte_carlo_masters",
  "ATP Madrid Open": "tennis_atp_madrid_open",
  "ATP Italian Open": "tennis_atp_italian_open",
  "ATP Canadian Open": "tennis_atp_canadian_open",
  "ATP Cincinnati Open": "tennis_atp_cincinnati_open",
  "ATP Shanghai Masters": "tennis_atp_shanghai_masters",
  "ATP Paris Masters": "tennis_atp_paris_masters",
  "ATP Barcelona Open": "tennis_atp_barcelona_open",
  "ATP Dubai Championships": "tennis_atp_dubai",
  "ATP Hamburg Open": "tennis_atp_hamburg_open",
  "ATP Halle Open": "tennis_atp_halle_open",
  "ATP Munich": "tennis_atp_munich",
  "ATP Queen's Club Championships": "tennis_atp_queens_club_champ",
  "ATP Washington Open": "tennis_atp_washington_open",
  "ATP Qatar Open": "tennis_atp_qatar_open",
};

/** Tennis surface (for surface-specific ratings/features). */
export type TennisSurface = "hard" | "clay" | "grass" | "carpet";

export type Market = "h2h" | "totals" | "btts" | "spreads";
export type Selection = "home" | "draw" | "away" | "over" | "under" | "yes" | "no";
export type FixtureStatus = "scheduled" | "live" | "finished";
export type BetStatus = "pending" | "won" | "lost" | "void";

export interface Fixture {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  /** epoch seconds (UTC) */
  commenceTime: number;
  status: FixtureStatus;
  homeScore?: number;
  awayScore?: number;
}

export interface OddsSnapshot {
  id: string;
  fixtureId: string;
  market: Market;
  selection: Selection;
  /** decimal odds (e.g. 1.85) */
  odds: number;
  bookmaker: string;
  /** epoch seconds */
  capturedAt: number;
  isClosing: boolean;
}

export interface Prediction {
  id: string;
  fixtureId: string;
  market: Market;
  selection: Selection;
  /** model probability 0..1 */
  probability: number;
  confidenceLow: number;
  confidenceHigh: number;
  modelVersion: string;
  createdAt: number;
}

export interface Bet {
  id: string;
  fixtureId: string;
  market: Market;
  selection: Selection;
  odds: number;
  stake: number;
  bankrollAtBet: number;
  /** edge (model prob − margin-adjusted implied prob) at bet time */
  edge: number;
  modelProbability: number;
  status: BetStatus;
  /** net P&L in currency units (stake*odds − stake on a win) */
  outcomeAmount?: number;
  placedAt: number;
}

export interface ClvResult {
  id: string;
  betId: string;
  openingOdds: number;
  closingOdds: number;
  /** fractional CLV = (opening − closing) / closing */
  clv: number;
  capturedAt: number;
}

export interface Outcome {
  id: string;
  fixtureId: string;
  homeScore: number;
  awayScore: number;
  settledAt: number;
}

export interface Settings {
  bankroll: number;
  /** fractional Kelly, e.g. 0.25 = quarter Kelly */
  kellyFraction: number;
  /** minimum edge to flag a slip, e.g. 0.03 = 3% */
  edgeThreshold: number;
  dailyStopLoss: number;
  weeklyStopLoss: number;
  /** hard cap on any single stake as a fraction of bankroll */
  defaultStakeCapPct: number;
  leagues: string[];
  markets: Market[];
  /**
   * Gate for the multiple (parlay) builder. Defaults OFF — multiples only go
   * live after a sport clears the validation checklist (100+ bets, positive
   * CLV, CI not straddling zero). OFF hides the builder everywhere.
   */
  multiplesEnabled: boolean;
}

/** A bet enriched with fixture + CLV context for UI tables. */
export interface BetWithClv extends Bet {
  fixture?: Fixture;
  clv?: number;
  closingOdds?: number;
}

/** Everything the dashboards need, as raw records. */
export interface Database {
  fixtures: Fixture[];
  odds: OddsSnapshot[];
  predictions: Prediction[];
  bets: Bet[];
  clv: ClvResult[];
  outcomes: Outcome[];
  settings: Settings;
}
