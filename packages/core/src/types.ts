/**
 * Canonical record shapes shared across the whole system.
 * These mirror the D1 tables in `worker/src/db/schema.ts` 1:1.
 */

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
