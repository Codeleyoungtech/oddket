import type {
  Bet,
  ClvResult,
  Database,
  Fixture,
  Market,
  Outcome,
  Prediction,
  Selection,
} from "./types";
import { meanBrier, wilsonInterval, round } from "./math";
import { flagSlips, STRATEGY_MAX_ODDS } from "./ev";

/** Did the selection win, given the final score? */
export function selectionWon(market: Market, selection: Selection, home: number, away: number): boolean {
  switch (market) {
    case "h2h":
      if (selection === "home") return home > away;
      if (selection === "away") return away > home;
      return home === away;
    case "totals": {
      const goals = home + away;
      return selection === "over" ? goals > 2 : goals <= 2;
    }
    case "btts":
      return selection === "yes" ? home > 0 && away > 0 : !(home > 0 && away > 0);
    case "spreads":
      return home > away; // simplified — full handicap math lives in the worker
    default:
      return false;
  }
}

export interface CalibrationBin {
  /** bin center, e.g. 0.35 for [0.30, 0.40) */
  bin: number;
  count: number;
  predicted: number;
  actual: number;
  low: number;
  high: number;
}

export interface CalibrationResult {
  bins: CalibrationBin[];
  brier: number;
  sampleSize: number;
}

/**
 * Build the calibration curve: group (prediction → outcome) pairs into 10
 * probability bins and compare predicted vs actual hit rate. Wilson CIs on
 * each bin. This is the "is the model telling the truth?" chart.
 */
export function buildCalibration(
  predictions: Prediction[],
  outcomes: Outcome[],
  fixtures: Fixture[],
): CalibrationResult {
  const outcomeByFixture = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const pairs: Array<{ p: number; y: number }> = [];
  for (const pred of predictions) {
    const out = outcomeByFixture.get(pred.fixtureId);
    if (!out) continue;
    const fixture = fixtureById.get(pred.fixtureId);
    if (!fixture) continue;
    const y = selectionWon(pred.market, pred.selection, out.homeScore, out.awayScore) ? 1 : 0;
    pairs.push({ p: pred.probability, y });
  }

  const BIN = 0.1;
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * BIN;
    const hi = lo + BIN;
    const inBin = pairs.filter(({ p }) => p >= lo && p < hi);
    const count = inBin.length;
    if (count === 0) {
      bins.push({ bin: round(lo + BIN / 2), count: 0, predicted: 0, actual: 0, low: 0, high: 0 });
      continue;
    }
    const predicted = inBin.reduce((a, x) => a + x.p, 0) / count;
    const actual = inBin.reduce((a, x) => a + x.y, 0) / count;
    const [low, high] = wilsonInterval(actual, count);
    bins.push({
      bin: round(lo + BIN / 2, 1),
      count,
      predicted: round(predicted, 3),
      actual: round(actual, 3),
      low: round(low, 3),
      high: round(high, 3),
    });
  }

  return { bins, brier: round(meanBrier(pairs), 4), sampleSize: pairs.length };
}

export interface ClvPoint {
  t: number;
  cumulativeClv: number;
  n: number;
}

/**
 * Cumulative CLV series — the headline scoreboard.
 * CLV is summed (not averaged) so the trajectory is visible bet by bet.
 */
export function buildClvSeries(bets: Bet[], clv: ClvResult[]): ClvPoint[] {
  const clvByBet = new Map(clv.map((c) => [c.betId, c]));
  const withClv = bets
    .filter((b) => clvByBet.has(b.id))
    .map((b) => ({ t: b.placedAt, clv: clvByBet.get(b.id)!.clv }))
    .sort((a, b) => a.t - b.t);

  let acc = 0;
  return withClv.map((p, i) => {
    acc += p.clv;
    return { t: p.t, cumulativeClv: round(acc, 4), n: i + 1 };
  });
}

export interface BankrollPoint {
  t: number;
  bankroll: number;
  drawdown: number;
  n: number;
}

/** Bankroll curve from the betting history, starting at settings.bankroll. */
export function buildBankrollSeries(bets: Bet[], startBankroll: number): BankrollPoint[] {
  const sorted = [...bets].sort((a, b) => a.placedAt - b.placedAt);
  let bankroll = startBankroll;
  let peak = startBankroll;
  const points: BankrollPoint[] = [];

  for (const bet of sorted) {
    if (bet.status === "pending" || bet.status === "void") continue;
    const pnl = bet.outcomeAmount ?? 0;
    bankroll += pnl;
    if (bankroll > peak) peak = bankroll;
    points.push({
      t: bet.placedAt,
      bankroll: round(bankroll, 2),
      drawdown: round(peak > 0 ? (bankroll - peak) / peak : 0, 4),
      n: points.length + 1,
    });
  }
  return points;
}

export interface DashboardSummary {
  nBets: number;
  settledBets: number;
  winRate: number;
  totalStaked: number;
  totalReturn: number;
  roiPct: number;
  avgClv: number;
  cumulativeClv: number;
  positiveClvRate: number;
  brier: number;
  flaggedSingles: number;
  bankrollNow: number;
}

export interface ByMarketRow {
  market: Market;
  bets: number;
  winRate: number;
  roiPct: number;
  avgClv: number;
}

export interface Dashboard {
  summary: DashboardSummary;
  clvSeries: ClvPoint[];
  bankrollSeries: BankrollPoint[];
  calibration: CalibrationResult;
  byMarket: ByMarketRow[];
}

/**
 * One function to rule the dashboards — the worker's GET /api/dashboard and
 * the web app's demo mode both derive everything from raw records via this.
 */
export function buildDashboard(db: Database): Dashboard {
  const { bets, clv, predictions, fixtures, outcomes, settings } = db;

  const settled = bets.filter((b) => b.status === "won" || b.status === "lost");
  const won = settled.filter((b) => b.status === "won");
  const winRate = settled.length > 0 ? won.length / settled.length : 0;

  const totalStaked = settled.reduce((a, b) => a + b.stake, 0);
  const totalReturn = settled.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
  const roiPct = totalStaked > 0 ? totalReturn / totalStaked : 0;

  const clvByBet = new Map(clv.map((c) => [c.betId, c]));
  const settledClv = settled.filter((b) => clvByBet.has(b.id));
  const avgClv =
    settledClv.length > 0
      ? settledClv.reduce((a, b) => a + clvByBet.get(b.id)!.clv, 0) / settledClv.length
      : 0;
  const cumulativeClv = settledClv.reduce((a, b) => a + clvByBet.get(b.id)!.clv, 0);
  const positiveClvRate =
    settledClv.length > 0 ? settledClv.filter((b) => clvByBet.get(b.id)!.clv > 0).length / settledClv.length : 0;

  const scheduledFixtures = fixtures.filter((f) => f.status === "scheduled");
  const flaggedSingles = flagSlips(scheduledFixtures, predictions, db.odds, settings, { maxOdds: STRATEGY_MAX_ODDS }).length;

  const byMarket = buildByMarket(settled, clvByBet, totalStaked > 0 ? totalReturn / totalStaked : 0);

  const bankrollSeries = buildBankrollSeries(bets, settings.bankroll);
  const bankrollNow = bankrollSeries.length > 0 ? bankrollSeries[bankrollSeries.length - 1]!.bankroll : settings.bankroll;

  return {
    summary: {
      nBets: bets.length,
      settledBets: settled.length,
      winRate: round(winRate, 4),
      totalStaked: round(totalStaked, 2),
      totalReturn: round(totalReturn, 2),
      roiPct: round(roiPct, 4),
      avgClv: round(avgClv, 4),
      cumulativeClv: round(cumulativeClv, 4),
      positiveClvRate: round(positiveClvRate, 4),
      brier: buildCalibration(predictions, outcomes, fixtures).brier,
      flaggedSingles,
      bankrollNow,
    },
    clvSeries: buildClvSeries(bets, clv),
    bankrollSeries,
    calibration: buildCalibration(predictions, outcomes, fixtures),
    byMarket,
  };
}

function buildByMarket(
  settled: Bet[],
  clvByBet: Map<string, ClvResult>,
  overallRoi: number,
): ByMarketRow[] {
  const groups = new Map<Market, Bet[]>();
  for (const b of settled) {
    const arr = groups.get(b.market) ?? [];
    arr.push(b);
    groups.set(b.market, arr);
  }
  const rows: ByMarketRow[] = [];
  for (const [market, group] of groups) {
    const won = group.filter((b) => b.status === "won").length;
    const staked = group.reduce((a, b) => a + b.stake, 0);
    const ret = group.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
    const avgClv =
      group.length > 0 ? group.reduce((a, b) => a + (clvByBet.get(b.id)?.clv ?? 0), 0) / group.length : 0;
    rows.push({
      market,
      bets: group.length,
      winRate: group.length > 0 ? won / group.length : 0,
      roiPct: staked > 0 ? ret / staked : 0,
      avgClv: round(avgClv, 4),
    });
  }
  return rows.sort((a, b) => b.avgClv - a.avgClv);
}

/** Simple helper: total goals from an outcome. */
export function totalGoals(outcome: Outcome): number {
  return outcome.homeScore + outcome.awayScore;
}
