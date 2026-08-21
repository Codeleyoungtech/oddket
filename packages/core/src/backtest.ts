import type {
  Bet,
  Database,
  Market,
  Outcome,
  Prediction,
  Settings,
} from "./types";
import { selectionWon, buildBankrollSeries, buildClvSeries } from "./aggregates";
import { bestOddsBySelection, bestOddsFor, hasCompleteMarketOdds, marginAdjustedImplied } from "./ev";
import { suggestedStake } from "./kelly";
import { round } from "./math";

export interface BacktestRow {
  bet: Bet;
  outcome?: Outcome;
  won: boolean;
}

export interface BacktestResult {
  rows: BacktestRow[];
  nBets: number;
  winRate: number;
  roiPct: number;
  totalStaked: number;
  totalReturn: number;
  cumulativeClv: number;
  avgClv: number;
  clvSeries: ReturnType<typeof buildClvSeries>;
  bankrollSeries: ReturnType<typeof buildBankrollSeries>;
  byMarket: Array<{ market: Market; bets: number; winRate: number; roiPct: number; avgClv: number }>;
}

/**
 * Historical replay: for every finished fixture, bet every prediction whose
 * edge clears the threshold (using the closing snapshot as the achievable
 * odds) and settle against the recorded outcome. This is the "would we have
 * made money?" view, powered by the same EV engine as the live slip builder.
 */
export function runBacktest(db: Database, opts: { edgeThreshold?: number } = {}): BacktestResult {
  const { fixtures, predictions, odds, outcomes, settings } = db;
  const threshold = opts.edgeThreshold ?? settings.edgeThreshold;

  const outcomeByFixture = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const settled: Bet[] = [];
  const clvRows: Array<{ betId: string; clv: number; openingOdds: number; closingOdds: number; capturedAt: number }> = [];
  let id = 0;

  for (const fixture of fixtures) {
    if (fixture.status !== "finished") continue;
    const outcome = outcomeByFixture.get(fixture.id);
    if (!outcome) continue;

    const fixtureOdds = odds.filter((o) => o.fixtureId === fixture.id);

    for (const pred of predictions.filter((p) => p.fixtureId === fixture.id)) {
      const marketOdds = fixtureOdds.filter((o) => o.market === pred.market);
      const bestPerSel = bestOddsBySelection(marketOdds, pred.market);
      if (!hasCompleteMarketOdds(bestPerSel, pred.market, fixture)) continue;
      const implied = marginAdjustedImplied(
        [...bestPerSel.entries()].map(([selection, odds]) => ({ selection, odds })),
        pred.selection,
      );
      if (implied <= 0) continue;
      const edge = pred.probability - implied;
      if (edge < threshold) continue;

      const snap = bestOddsFor(fixtureOdds, fixture.id, pred.market, pred.selection);
      if (!snap || snap.odds <= 1) continue;

      const won = selectionWon(pred.market, pred.selection, outcome.homeScore, outcome.awayScore);
      const stake = suggestedStake(pred.probability, snap.odds, settings.bankroll, settings);
      const bet: Bet = {
        id: `bt-${id++}`,
        fixtureId: fixture.id,
        market: pred.market,
        selection: pred.selection,
        odds: snap.odds,
        stake,
        bankrollAtBet: settings.bankroll,
        edge: round(edge, 4),
        modelProbability: pred.probability,
        status: won ? "won" : "lost",
        outcomeAmount: won ? round(stake * (snap.odds - 1), 2) : -stake,
        placedAt: fixture.commenceTime - 43200,
      };
      settled.push(bet);

      const opening = marketOdds.find((o) => !o.isClosing && o.selection === pred.selection);
      if (opening) {
        clvRows.push({
          betId: bet.id,
          clv: round((opening.odds - snap.odds) / snap.odds, 4),
          openingOdds: opening.odds,
          closingOdds: snap.odds,
          capturedAt: 0,
        });
      }
    }
  }

  const won = settled.filter((b) => b.status === "won").length;
  const totalStaked = settled.reduce((a, b) => a + b.stake, 0);
  const totalReturn = settled.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);

  const clvSeries = buildClvSeries(settled, clvRows.map((c) => ({ id: `c${c.betId}`, betId: c.betId, clv: c.clv, openingOdds: c.openingOdds, closingOdds: c.closingOdds, capturedAt: c.capturedAt })));
  const bankrollSeries = buildBankrollSeries(settled, settings.bankroll);

  const byMarketMap = new Map<Market, Bet[]>();
  for (const b of settled) {
    const arr = byMarketMap.get(b.market) ?? [];
    arr.push(b);
    byMarketMap.set(b.market, arr);
  }
  const byMarket = [...byMarketMap.entries()].map(([market, group]) => {
    const w = group.filter((b) => b.status === "won").length;
    const staked = group.reduce((a, b) => a + b.stake, 0);
    const ret = group.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
    const avgClv = clvRows.filter((c) => group.some((b) => b.id === c.betId)).reduce((a, c) => a + c.clv, 0) / group.length || 0;
    return {
      market,
      bets: group.length,
      winRate: group.length ? round(w / group.length, 4) : 0,
      roiPct: staked ? round(ret / staked, 4) : 0,
      avgClv: round(avgClv, 4),
    };
  }).sort((a, b) => b.avgClv - a.avgClv);

  const cumulativeClv = clvRows.reduce((a, c) => a + c.clv, 0);

  return {
    rows: settled.map((bet) => ({ bet, outcome: outcomeByFixture.get(bet.fixtureId), won: bet.status === "won" })),
    nBets: settled.length,
    winRate: settled.length ? round(won / settled.length, 4) : 0,
    roiPct: totalStaked ? round(totalReturn / totalStaked, 4) : 0,
    totalStaked: round(totalStaked, 2),
    totalReturn: round(totalReturn, 2),
    cumulativeClv: round(cumulativeClv, 4),
    avgClv: clvRows.length ? round(cumulativeClv / clvRows.length, 4) : 0,
    clvSeries,
    bankrollSeries,
    byMarket,
  };
}

/** Edge threshold note helper for the UI. */
export function backtestThresholdNote(settings: Settings): string {
  return `Replay of every settled fixture using edge ≥ ${(settings.edgeThreshold * 100).toFixed(0)}%, quarter-Kelly staking, ${settings.bankroll.toLocaleString()} starting bankroll.`;
}
