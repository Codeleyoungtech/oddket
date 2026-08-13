"use client";

import Link from "next/link";
import { useData } from "../lib/data-provider";
import { BankrollChart, ByMarketChart, ClvChart } from "../components/charts";
import { Badge, Card, CardHeader, EmptyState, Loading, SectionTitle, StatCard } from "../components/ui";
import { clvClass, fmtMoney, fmtOdds, fmtPct, fmtSignedPct, pnlClass } from "../lib/format";

export default function OverviewPage() {
  const { mode, dashboard, clvSeries, bets } = useData();

  if (!dashboard) return <Loading />;

  const s = dashboard.summary;
  const recent = bets.slice(0, 6);

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Overview</h1>
          <p className="mt-1 text-sm text-slate-500">
            Closing line value is the scoreboard. Everything else is context.
          </p>
        </div>
        <Link
          href="/slips"
          className="btn-primary"
        >
          Build a slip →
        </Link>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Bankroll now"
          value={`₦${fmtMoney(s.bankrollNow, 0)}`}
          sub={`started ₦${fmtMoney(dashboard.bankrollSeries[0]?.bankroll ?? s.bankrollNow, 0)}`}
          tone="accent"
        />
        <StatCard
          label="Cumulative CLV"
          value={fmtSignedPct(s.cumulativeClv, 2)}
          sub={`avg ${fmtSignedPct(s.avgClv, 2)} across ${s.settledBets} settled bets`}
          tone={s.cumulativeClv >= 0 ? "positive" : "negative"}
        />
        <StatCard label="Win rate" value={fmtPct(s.winRate)} sub={`${s.settledBets} settled`} />
        <StatCard label="ROI" value={fmtSignedPct(s.roiPct)} sub="net P&L / staked" tone={s.roiPct >= 0 ? "positive" : "negative"} />
        <StatCard label="Brier score" value={s.brier.toFixed(4)} sub="lower = more honest" />
        <StatCard
          label="Flagged bets"
          value={s.flaggedSingles}
          sub="edge above threshold"
          tone={s.flaggedSingles > 0 ? "positive" : "default"}
        />
      </div>

      {/* CLV — the headline chart */}
      <Card>
        <CardHeader
          title="Cumulative closing line value"
          subtitle="Positive slope over 100+ bets = the model has a real edge. Watch this, not the streak."
          right={<Badge tone={s.cumulativeClv >= 0 ? "green" : "red"}>{s.cumulativeClv >= 0 ? "edge" : "no edge yet"}</Badge>}
        />
        {clvSeries.length > 1 ? <ClvChart data={clvSeries} /> : <EmptyState title="No CLV data yet" body="Log a bet and pull closing odds to start the scoreboard." />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Bankroll" subtitle="With drawdown visible as dips from the peak" />
          {dashboard.bankrollSeries.length > 1 ? <BankrollChart data={dashboard.bankrollSeries} /> : <EmptyState title="No settled bets yet" />}
        </Card>

        <Card>
          <CardHeader title="ROI by market" subtitle="Where the edge actually lives" />
          <ByMarketChart data={dashboard.byMarket} />
        </Card>
      </div>

      {/* Recent bets */}
      <div>
        <SectionTitle>Recent bets</SectionTitle>
        {recent.length === 0 ? (
          <EmptyState title="No bets logged yet" body="Log what you actually staked on SportyBet so CLV can do its job." />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ink-700/60 text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="px-4 py-3 font-semibold">Fixture</th>
                    <th className="px-4 py-3 font-semibold">Pick</th>
                    <th className="px-4 py-3 text-right font-semibold">Odds</th>
                    <th className="px-4 py-3 text-right font-semibold">Stake</th>
                    <th className="px-4 py-3 text-right font-semibold">CLV</th>
                    <th className="px-4 py-3 text-right font-semibold">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((b) => (
                    <tr key={b.id} className="border-b border-ink-700/40 transition-colors last:border-0 hover:bg-ink-800/40">
                      <td className="px-4 py-3">
                        <p className="text-slate-200">{b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId}</p>
                        <p className="text-xs text-slate-500">{b.fixture?.league}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "slate"}>{b.selection}</Badge>
                      </td>
                      <td className="tabular px-4 py-3 text-right text-slate-300">{fmtOdds(b.odds)}</td>
                      <td className="tabular px-4 py-3 text-right text-slate-300">{fmtMoney(b.stake)}</td>
                      <td className={`tabular px-4 py-3 text-right ${clvClass(b.clv)}`}>{b.clv !== undefined ? fmtSignedPct(b.clv, 2) : "—"}</td>
                      <td className={`tabular px-4 py-3 text-right ${pnlClass(b.outcomeAmount)}`}>
                        {b.outcomeAmount !== undefined ? `${b.outcomeAmount > 0 ? "+" : ""}${fmtMoney(b.outcomeAmount)}` : "pending"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {mode === "demo" && (
        <p className="text-center text-xs text-slate-600">
          Demo mode — deterministic seed data. Start the worker (<span className="num">cd worker && pnpm dev</span>) and it switches to LIVE automatically.
        </p>
      )}
    </div>
  );
}
