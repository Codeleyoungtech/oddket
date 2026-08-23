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

/**
 * Shipped strategy bands per market: only flag selections at best odds <= the
 * band. Backtested on 4 leagues x 6 seasons (2019-2025, honest holdout): the
 * model's signal is real in the low-price region but bleeds on longshots
 * where small calibration error x huge odds dominates.
 *   h2h    <=2.5  (528 bets, ROI +4.9%, CLV +5.6%)
 *   totals <=1.95 (366 bets, ROI +5.8%, CLV +3.5%)
 */
export const STRATEGY_MAX_ODDS: Partial<Record<Market, number>> = {
  totals: 1.95,
};

export const STRATEGY_MAX_ODDS_BY_SELECTION: Partial<Record<Market, Partial<Record<Selection, number>>>> = {
  h2h: {
    home: 2.5,
    away: 2.5,
    // Football draws usually price above the old 2.5 h2h favorite band. Give
    // the draw side its own band so the EV engine can evaluate draw edges.
    draw: 4.5,
  },
  totals: {
    over: 1.95,
    under: 1.95,
  },
};

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

export function requiredSelectionsForMarket(market: Market, fixture?: Fixture): Selection[] {
  if (market === "h2h") {
    return fixture?.sport === "tennis" ? ["home", "away"] : ["home", "draw", "away"];
  }
  if (market === "totals") return ["over", "under"];
  if (market === "btts") return ["yes", "no"];
  return [];
}

export function bestOddsBySelection(
  marketOdds: OddsSnapshot[],
  market: Market,
): Map<Selection, number> {
  const required = new Set(requiredSelectionsForMarket(market));
  const best = new Map<Selection, number>();
  for (const s of marketOdds) {
    if (s.odds <= 1.01) continue;
    if (required.size > 0 && !required.has(s.selection)) continue;
    const cur = best.get(s.selection);
    if (cur === undefined || s.odds > cur) best.set(s.selection, s.odds);
  }
  return best;
}

export function hasCompleteMarketOdds(
  bestPerSelection: Map<Selection, number>,
  market: Market,
  fixture?: Fixture,
): boolean {
  const required = requiredSelectionsForMarket(market, fixture);
  return required.length === 0 || required.every((selection) => (bestPerSelection.get(selection) ?? 0) > 1.01);
}

export function strategyMaxOddsFor(market: Market, selection: Selection): number {
  return STRATEGY_MAX_ODDS_BY_SELECTION[market]?.[selection] ?? STRATEGY_MAX_ODDS[market] ?? 0;
}

/**
 * Pick the best odds snapshot for a (fixture, market, selection) pair —
 * prefers closing if present, then the latest capture, then the highest price.
 */
export function bestOddsFor(
  snapshots: OddsSnapshot[],
  fixtureId: string,
  market: Market,
  selection: Selection,
): OddsSnapshot | undefined {
  const rows = snapshots.filter((s) => s.fixtureId === fixtureId && s.market === market && s.selection === selection && s.odds > 1.01);
  if (rows.length === 0) return undefined;
  const closing = rows.filter((s) => s.isClosing);
  const pool = closing.length > 0 ? closing : rows;
  const latest = Math.max(...pool.map((s) => s.capturedAt));
  return pool
    .filter((s) => s.capturedAt === latest)
    .sort((a, b) => b.odds - a.odds)[0];
}

export interface FlagOptions {
  /** probabilities below/above these are ignored (not enough signal) */
  minProb?: number;
  maxProb?: number;
  edgeThreshold?: number;
  /** strategy band: only flag selections at best odds <= maxOdds (0=off).
   *  Backtested: the model's signal is real on favorites but bleeds on
   *  longshots (small calibration error x huge odds), so the shipped
   *  strategy restricts to short prices. */
  maxOdds?: number;
  /** Minimum number of bookmakers quoting a price on this selection.
   *  Edges backed by only 1–2 books are likely stale data or a single-
   *  bookmaker margin quirk, not real value. Default 4 (calibrated against
   *  The Odds API which returns 15–24 books per EPL fixture). */
  minBookmakers?: number;
  /** If the spread (max−min)/min across bookmaker odds for this selection
   *  exceeds this fraction, the edge is flagged as low-confidence (thin
   *  line, likely stale or stale-by-book). Default 0.10 (10 %) — the 90th
   *  percentile of real EPL cross-book spreads (football-data.co.uk 2025-26). */
  maxSpreadPct?: number;
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
  const minBooks = opts.minBookmakers ?? settings.minBookmakers ?? 4;
  const maxSpread = opts.maxSpreadPct ?? settings.maxSpreadPct ?? 0.10;

  for (const fixture of fixtures) {
    const fixtureOdds = snapshots.filter((s) => s.fixtureId === fixture.id);
    for (const pred of predictions.filter((p) => p.fixtureId === fixture.id)) {
      if (settings.markets.length > 0 && !settings.markets.includes(pred.market)) continue;
      const marketOdds = fixtureOdds.filter((s) => s.market === pred.market);

      // ── Bookmaker-depth gate ─────────────────────────────────────────
      // Count unique bookmakers quoting THIS selection.  Edges backed by
      // only 1–2 books are likely stale data or a single-book margin quirk,
      // not real value.  The Odds API returns 15–24 books per EPL fixture,
      // so ≥4 is easily met for live data and only rejects stale rows.
      const selSnapshots = marketOdds.filter((s) => s.selection === pred.selection);
      const uniqueBooks = new Set(selSnapshots.map((s) => s.bookmaker));
      if (uniqueBooks.size < minBooks) continue;

      // ── Market-width sanity check ────────────────────────────────────
      // If the spread between best and worst odds across books is unusually
      // wide, the edge is likely a stale line on one book rather than real
      // value.  Calibrated against football-data.co.uk 2025-26 EPL:
      //   median spread = 2.9 %,  90th pct = 8.0 %,  95th pct = 9.9 %
      const selOdds = selSnapshots.map((s) => s.odds).filter((o) => o > 1.01);
      if (selOdds.length >= 2) {
        const lo = Math.min(...selOdds);
        const hi = Math.max(...selOdds);
        const spreadPct = (hi - lo) / lo;
        if (spreadPct > maxSpread) continue; // thin/stale line — skip entirely
      }

      // One price per selection (BEST) — otherwise every bookmaker snapshot
      // counts as a separate market outcome and implied collapses to ~0.
      const bestPerSel = bestOddsBySelection(marketOdds, pred.market);
      if (!hasCompleteMarketOdds(bestPerSel, pred.market, fixture)) continue;
      const implied = marginAdjustedImplied(
        [...bestPerSel.entries()].map(([selection, odds]) => ({ selection, odds })),
        pred.selection,
      );
      if (implied <= 0) continue;
      const edge = pred.probability - implied;
      if (edge < threshold) continue;
      if (pred.probability < minProb || pred.probability > maxProb) continue;

      const odds = bestPerSel.get(pred.selection) ?? bestOddsFor(fixtureOdds, fixture.id, pred.market, pred.selection)?.odds ?? 0;
      if (odds <= 1) continue;
      const maxOdds = opts.maxOdds ?? strategyMaxOddsFor(pred.market, pred.selection);
      if (maxOdds > 0 && odds > maxOdds) continue;

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

  // Dedupe safety net: one leg per (fixture, market, selection) — keep the
  // highest edge. Guards against stale/duplicate prediction rows sneaking in.
  const best = new Map<string, SlipLeg>();
  for (const leg of legs) {
    const key = `${leg.fixture.id}:${leg.market}:${leg.selection}`;
    const cur = best.get(key);
    if (!cur || leg.edge > cur.edge) best.set(key, leg);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
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

/**
 * Convert ALL predictions into SlipLeg-shaped objects for the "Show All" view.
 * Bypasses edge threshold, odds band, bookmaker depth, and spread filters.
 * Still computes edge (for display) but never filters on it.
 * Only requires: valid odds > 1.01 and a complete market.
 */
export function allPredictionsAsLegs(
  fixtures: Fixture[],
  predictions: Prediction[],
  snapshots: OddsSnapshot[],
  settings: Settings,
): SlipLeg[] {
  const legs: SlipLeg[] = [];

  for (const fixture of fixtures) {
    const fixtureOdds = snapshots.filter((s) => s.fixtureId === fixture.id);
    for (const pred of predictions.filter((p) => p.fixtureId === fixture.id)) {
      if (settings.markets.length > 0 && !settings.markets.includes(pred.market)) continue;
      const marketOdds = fixtureOdds.filter((s) => s.market === pred.market);
      if (marketOdds.length === 0) continue;

      const bestPerSel = bestOddsBySelection(marketOdds, pred.market);
      if (!hasCompleteMarketOdds(bestPerSel, pred.market, fixture)) continue;
      const implied = marginAdjustedImplied(
        [...bestPerSel.entries()].map(([selection, odds]) => ({ selection, odds })),
        pred.selection,
      );
      if (implied <= 0) continue;
      const edge = pred.probability - implied;

      const odds = bestPerSel.get(pred.selection) ?? 0;
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

  // Dedupe: one leg per (fixture, market, selection) — keep the best odds.
  const best = new Map<string, SlipLeg>();
  for (const leg of legs) {
    const key = `${leg.fixture.id}:${leg.market}:${leg.selection}`;
    const cur = best.get(key);
    if (!cur || leg.odds > cur.odds) best.set(key, leg);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}
