"use client";

import Link from "next/link";
import { marketLabel } from "@oddket/core";
import { useData } from "../lib/data-provider";
import { BankrollChart, ByMarketChart, ClvChart } from "../components/charts";
import { Badge, Card, CardHeader, EmptyState, PageSkeleton, SectionTitle, Skeleton, SkeletonCard, SkeletonStatGrid, StatCard } from "../components/ui";
import { clvClass, fmtDateShort, fmtMoney, fmtOdds, fmtPct, fmtSignedPct, pnlClass } from "../lib/format";

export default function OverviewPage() {
  const { mode, dashboard, clvSeries, bets, slips } = useData();

  if (!dashboard)
    return (
      <PageSkeleton>
        <SkeletonStatGrid />
        <SkeletonCard lines={6} />
        <div className="grid gap-6 lg:grid-cols-2">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={6} />
        </div>
        <SkeletonCard lines={4} />
      </PageSkeleton>
    );

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

      {/* Today's hero picks — the two bets worth looking at right now */}
      <TodayPicks />

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
          sub={`${fmtPct(s.positiveClvRate)} beat closing · avg ${fmtSignedPct(s.avgClv, 2)}`}
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
          subtitle={`${fmtPct(s.positiveClvRate)} of bets beat the closing line · positive slope over 100+ bets = real edge`}
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

/**
 * Today's hero cards — "Best Edge" and "Highest Probability" from today's
 * flagged slips. Tapping either jumps to the Slip Builder. If there's nothing
 * flagged today, shows a friendly nudge instead of an empty card.
 */
function TodayPicks() {
  const { slips } = useData();
  const nowSec = Math.floor(Date.now() / 1000);
  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  const today = slips.filter((l) => l.fixture.commenceTime >= startOfToday && l.fixture.commenceTime < startOfToday + 86400 && l.odds !== 0);

  const bestEdge = today.reduce<(typeof today)[number] | null>(
    (best, l) => (!best || l.edge > best.edge ? l : best),
    null,
  );
  const highestProb = today.reduce<(typeof today)[number] | null>(
    (best, l) => (!best || l.probability > best.probability ? l : best),
    null,
  );

  if (!bestEdge || !highestProb) {
    return (
      <Link
        href="/slips"
        className="card card-pad block transition-colors hover:border-emerald-400/40"
      >
        <p className="text-sm font-semibold text-slate-200">
          🔥 No flagged picks for today yet
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Open the Slip Builder to see the full pool of value opportunities — odds update throughout the day.
        </p>
      </Link>
    );
  }

  const card = (
    l: (typeof today)[number],
    opts: { title: string; icon: string; badge: string; badgeTone: string },
  ) => (
    <Link
      key={opts.title}
      href="/slips"
      className="card card-pad group block transition-all hover:-translate-y-0.5 hover:border-emerald-400/40"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="label">{opts.icon} {opts.title}</p>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${opts.badgeTone}`}>
          {opts.badge}
        </span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-slate-100">
        {l.fixture.homeTeam} <span className="font-normal text-slate-500">vs</span> {l.fixture.awayTeam}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-400">
        {marketLabel(l.market, l.selection)} · <span className="num">@{fmtOdds(l.odds)}</span> · {l.fixture.league}
      </p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <p className="text-[10px] text-slate-500">Win prob</p>
          <p className="num text-lg font-bold text-slate-200">{fmtPct(l.probability)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-slate-500">{fmtDateShort(l.fixture.commenceTime)}</p>
          <p className={`num text-lg font-bold ${l.edge >= 0.07 ? "text-emerald-400" : l.edge > 0 ? "text-sky-400" : "text-red-400"}`}>
            {fmtSignedPct(l.edge)}
          </p>
        </div>
      </div>
    </Link>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Today&apos;s picks</p>
        <Link href="/slips" className="text-xs font-medium text-emerald-400 hover:text-emerald-300">
          See all →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {card(bestEdge, {
          title: "Best edge",
          icon: "💎",
          badge: `${fmtPct(bestEdge.probability)} win`,
          badgeTone: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
        })}
        {card(highestProb, {
          title: "Highest probability",
          icon: "🎯",
          badge: `${fmtSignedPct(highestProb.edge)} EV`,
          badgeTone: "border-sky-400/30 bg-sky-400/10 text-sky-300",
        })}
      </div>
    </div>
  );
}
