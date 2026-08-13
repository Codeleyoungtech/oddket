"use client";

import { useData } from "../../lib/data-provider";
import { BankrollChart, ByMarketChart, ClvChart } from "../../components/charts";
import { Badge, Card, CardHeader, EmptyState, Loading, SectionTitle, StatCard } from "../../components/ui";
import { fmtMoney, fmtPct, fmtSignedPct } from "../../lib/format";

export default function BacktestPage() {
  const { backtest, db } = useData();

  if (!backtest || !db) return <Loading />;

  const b = backtest;
  const series = b.clvSeries.length ? b.clvSeries : [];

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Backtest</h1>
        <p className="mt-1 text-sm text-slate-500">
          Historical replay of the EV engine over settled fixtures. No real money — this is how the model would have
          done, using the exact same rules as today&apos;s slip builder.
        </p>
      </div>

      <Card className="card-pad border-sky-400/20 bg-sky-400/[0.03]">
        <p className="text-xs leading-relaxed text-slate-400">
          <span className="font-semibold text-sky-300">Method:</span> every settled fixture is replayed with the current
          settings — bets are taken wherever model edge ≥ {fmtPct(db.settings.edgeThreshold, 0)}, staked at quarter Kelly
          ({fmtPct(db.settings.kellyFraction, 0)} × full Kelly), capped at {fmtPct(db.settings.defaultStakeCapPct, 0)} of
          a ₦{fmtMoney(db.settings.bankroll, 0)} bankroll. The same engine powers the live slip builder.
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Bets replayed" value={b.nBets} sub="all settled fixtures" />
        <StatCard label="Win rate" value={fmtPct(b.winRate)} />
        <StatCard label="ROI" value={fmtSignedPct(b.roiPct)} tone={b.roiPct >= 0 ? "positive" : "negative"} />
        <StatCard label="Net P&L" value={`₦${fmtMoney(b.totalReturn, 0)}`} sub={`₦${fmtMoney(b.totalStaked, 0)} staked`} tone={b.totalReturn >= 0 ? "positive" : "negative"} />
        <StatCard label="Cumulative CLV" value={fmtSignedPct(b.cumulativeClv, 2)} tone={b.cumulativeClv >= 0 ? "positive" : "negative"} />
        <StatCard label="Avg CLV" value={fmtSignedPct(b.avgClv, 2)} sub="per replayed bet" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Backtest CLV series" subtitle="If the slope is positive, the engine was picking value." />
          {series.length > 1 ? <ClvChart data={series} /> : <EmptyState title="Not enough settled history" />}
        </Card>
        <Card>
          <CardHeader title="Backtest bankroll" subtitle="What the bankroll would have done." />
          {b.bankrollSeries.length > 1 ? <BankrollChart data={b.bankrollSeries} /> : <EmptyState title="Not enough settled history" />}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="ROI by market (backtest)" />
          <ByMarketChart data={b.byMarket} />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Per-market breakdown" />
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-ink-700/60 text-[11px] uppercase tracking-widest text-slate-500">
                <th className="px-4 py-2.5 font-semibold">Market</th>
                <th className="px-4 py-2.5 text-right font-semibold">Bets</th>
                <th className="px-4 py-2.5 text-right font-semibold">Win rate</th>
                <th className="px-4 py-2.5 text-right font-semibold">ROI</th>
                <th className="px-4 py-2.5 text-right font-semibold">Avg CLV</th>
              </tr>
            </thead>
            <tbody>
              {b.byMarket.map((row) => (
                <tr key={row.market} className="border-b border-ink-700/40 last:border-0 hover:bg-ink-800/40">
                  <td className="px-4 py-2.5">
                    <Badge>{row.market}</Badge>
                  </td>
                  <td className="num px-4 py-2.5 text-right text-slate-300">{row.bets}</td>
                  <td className="num px-4 py-2.5 text-right text-slate-300">{fmtPct(row.winRate, 0)}</td>
                  <td className={`num px-4 py-2.5 text-right ${row.roiPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtSignedPct(row.roiPct)}</td>
                  <td className={`num px-4 py-2.5 text-right ${row.avgClv >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtSignedPct(row.avgClv, 2)}</td>
                </tr>
              ))}
              {b.byMarket.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-slate-500">
                    No replayable markets yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      <p className="text-center text-xs text-slate-600">
        Paper-trade mode (log picks for N weeks without staking) is the natural next step once this replay holds up over 100+ bets.
      </p>
    </div>
  );
}
