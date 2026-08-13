import {
  decimalToProb,
  normalizeImplied,
  clamp01,
} from "./math";
import type {
  Bet,
  Fixture,
  Market,
  OddsSnapshot,
  Prediction,
  Selection,
  Settings,
} from "./types";
import { stopLossViolation, suggestedStake } from "./kelly";

export interface SlipLeg {
  fixture: Fixture;
  market: Market;
  selection: Selection;
  /** model probability (with CI) */
  probability: number;
  confidenceLow: number;
  confidenceHigh: number;
  /** best available decimal odds (closing snapshot preferred) */
  odds: number;
  /** margin-adjusted implied probability from the bookmaker odds */
  impliedProbability: number;
  /** edge = model probability − implied probability */
  edge: number;
  /** recommended stake via fractional Kelly (singles only) */
  stake: number;
}

export interface SlipCandidate {
  leg: SlipLeg;
  /** true compound probability when combined into a multiple */
  compoundProbability: number;
  compoundFairOdds: number;
  /** advertised bookmaker multiplier for the multiple (product of legs' odds) */
  advertisedOdds: number;
  /** suggested stake via fractional Kelly against the advertised multiplier */
  stake: number;
  flagged: boolean;
  skippedReason?: string;
}

/**
 * Margin-adjusted implied probability for one selection, given the full
 * bookmaker market. `marketOdds` = { selection: odds } for every outcome
 * in the market. If the market is incomplete, falls back to 1/odds.
 */
export function marginAdjustedImplied(
  marketOdds: Array<{ selection: Selection; odds: number }>,
  target: Selection,
): number {
  if (marketOdds.length === 0) return 0;
  const raw = marketOdds.map((m) => ({ selection: m.selection, p: decimalToProb(m.odds) }));
  const norm = normalizeImplied(raw.map((r) => r.p));
  const idx = raw.findIndex((r) => r.selection === target);
  return idx >= 0 ? norm[idx]! : 0;
}

/**
 * Pick the best odds snapshot for a (fixture, market, selection) pair —
 * prefers closing, then most recent.
 */
export function bestOddsFor(
  snapshots: OddsSnapshot[],
  fixtureId: string,
  market: Market,
  selection: Selection,
): OddsSnapshot | undefined {
  return snapshots
    .filter((s) => s.fixtureId === fixtureId && s.market === market && s.selection === selection)
    .sort((a, b) => Number(b.isClosing) - Number(a.isClosing) || b.capturedAt - a.capturedAt)[0];
}

export interface FlagOptions {
  /** probabilities below/above these are ignored (not enough signal) */
  minProb?: number;
  maxProb?: number;
  edgeThreshold?: number;
}

/**
 * The EV engine. Ranks single-bet opportunities by edge
 * (model probability − margin-adjusted implied probability).
 * Only returns legs above the configurable edge threshold.
 */
export function flagSlips(
  fixtures: Fixture[],
  predictions: Prediction[],
  snapshots: OddsSnapshot[],
  settings: Settings,
  opts: FlagOptions = {},
): SlipLeg[] {
  const minProb = opts.minProb ?? 0.05;
  const maxProb = opts.maxProb ?? 0.95;
  const threshold = opts.edgeThreshold ?? settings.edgeThreshold;

  const legs: SlipLeg[] = [];

  for (const fixture of fixtures) {
    const fixtureOdds = snapshots.filter((s) => s.fixtureId === fixture.id);
    for (const pred of predictions.filter((p) => p.fixtureId === fixture.id)) {
      const marketOdds = fixtureOdds.filter((s) => s.market === pred.market);
      const implied = marginAdjustedImplied(
        marketOdds.map((s) => ({ selection: s.selection, odds: s.odds })),
        pred.selection,
      );
      if (implied <= 0) continue;
      const edge = pred.probability - implied;
      if (edge < threshold) continue;
      if (pred.probability < minProb || pred.probability > maxProb) continue;

      const odds = bestOddsFor(fixtureOdds, fixture.id, pred.market, pred.selection)?.odds ?? 0;
      if (odds <= 1) continue;

      legs.push({
        fixture,
        market: pred.market,
        selection: pred.selection,
        probability: pred.probability,
        confidenceLow: pred.confidenceLow,
        confidenceHigh: pred.confidenceHigh,
        odds,
        impliedProbability: implied,
        edge,
        stake: suggestedStake(pred.probability, odds, settings.bankroll, settings),
      });
    }
  }

  return legs.sort((a, b) => b.edge - a.edge);
}

/**
 * Combine selected legs into a multiple (opt-in only).
 * Always shows true compounded probability + fair odds alongside the
 * advertised bookmaker multiplier.
 */
export function buildMultiple(
  legs: SlipLeg[],
  settings: Settings,
): SlipCandidate | null {
  if (legs.length === 0) return null;

  const compoundProbability = legs.reduce((acc, l) => acc * l.probability, 1);
  const compoundFairOdds = compoundProbability > 0 ? 1 / compoundProbability : 0;
  const advertisedOdds = legs.reduce((acc, l) => acc * l.odds, 1);
  const p = clamp01(compoundProbability);

  // Stake sizing for a multiple uses fractional Kelly against the *advertised*
  // bookmaker multiplier with the model's true joint probability.
  const stake = suggestedStake(p, advertisedOdds, settings.bankroll, settings);

  return {
    leg: legs[0]!, // representative leg (compound fields on top-level)
    compoundProbability,
    compoundFairOdds,
    advertisedOdds,
    flagged: true,
    stake,
  };
}

/**
 * Produce the "Bet with CLV" enrichment used by tables: attach fixture + CLV.
 */
export function enrichBets(
  bets: Bet[],
  fixtures: Fixture[],
  clv: Array<{ betId: string; clv: number; closingOdds: number }>,
) {
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));
  const clvByBet = new Map(clv.map((c) => [c.betId, c]));
  return bets.map((bet) => ({
    ...bet,
    fixture: fixtureById.get(bet.fixtureId),
    clv: clvByBet.get(bet.id)?.clv,
    closingOdds: clvByBet.get(bet.id)?.closingOdds,
  }));
}

/**
 * Apply stop-loss check to a prospective stake. Returns { allowed, reason }.
 */
export function checkStakeAgainstStopLoss(
  stake: number,
  bets: Bet[],
  settings: Settings,
  now = Date.now() / 1000,
): { allowed: boolean; reason?: string } {
  const day = 86400;
  const week = 7 * day;
  const spentToday = bets
    .filter((b) => now - b.placedAt < day)
    .reduce((a, b) => a + b.stake, 0);
  const spentThisWeek = bets
    .filter((b) => now - b.placedAt < week)
    .reduce((a, b) => a + b.stake, 0);
  const reason = stopLossViolation(stake, spentToday, spentThisWeek, settings);
  return reason ? { allowed: false, reason } : { allowed: true };
}

