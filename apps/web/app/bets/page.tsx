"use client";

import { useMemo, useState } from "react";
import { useData } from "../../lib/data-provider";
import { Badge, Card, EmptyState, Loading, SectionTitle } from "../../components/ui";
import { clvClass, fmtDate, fmtMoney, fmtOdds, fmtSignedPct, pnlClass } from "../../lib/format";

export default function BetsPage() {
  const { bets, db } = useData();
  const [statusFilter, setStatusFilter] = useState<"all" | "won" | "lost" | "pending">("all");

  const filtered = useMemo(
    () => (statusFilter === "all" ? bets : bets.filter((b) => b.status === statusFilter)),
    [bets, statusFilter],
  );

  const totals = useMemo(() => {
    const settled = bets.filter((b) => b.status === "won" || b.status === "lost");
    const staked = settled.reduce((a, b) => a + b.stake, 0);
    const ret = settled.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
    const withClv = settled.filter((b) => b.clv !== undefined);
    const cumClv = withClv.reduce((a, b) => a + (b.clv ?? 0), 0);
    return { n: settled.length, staked, ret, cumClv, nClv: withClv.length };
  }, [bets]);

  if (!db) return <Loading />;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Bet log</h1>
        <p className="mt-1 text-sm text-slate-500">
          What you actually staked on SportyBet, scored against closing odds. <span className="text-slate-400">Every row you log feeds the CLV scoreboard.</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["all", "won", "lost", "pending"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              statusFilter === s
                ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                : "border-ink-600/60 text-slate-400 hover:text-slate-200"
            }`}
          >
            {s}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">
          {totals.n} settled · ₦{fmtMoney(totals.staked, 0)} staked · <span className={clvClass(totals.cumClv)}>{fmtSignedPct(totals.cumClv, 2)} cumulative CLV</span> over {totals.nClv}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No bets match this filter" body="Log bets on the Overview or via the API (POST /api/bets) to build history." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-ink-700/60 text-[11px] uppercase tracking-widest text-slate-500">
                  <th className="px-4 py-3 font-semibold">Placed</th>
                  <th className="px-4 py-3 font-semibold">Fixture</th>
                  <th className="px-4 py-3 font-semibold">Pick</th>
                  <th className="px-4 py-3 text-right font-semibold">Odds</th>
                  <th className="px-4 py-3 text-right font-semibold">Stake</th>
                  <th className="px-4 py-3 text-right font-semibold">Edge</th>
                  <th className="px-4 py-3 text-right font-semibold">CLV</th>
                  <th className="px-4 py-3 text-right font-semibold">P&L</th>
                  <th className="px-4 py-3 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr key={b.id} className="border-b border-ink-700/40 transition-colors last:border-0 hover:bg-ink-800/40">
                    <td className="num whitespace-nowrap px-4 py-3 text-slate-500">{fmtDate(b.placedAt)}</td>
                    <td className="px-4 py-3">
                      <p className="text-slate-200">{b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId}</p>
                      <p className="text-xs text-slate-500">{b.fixture?.league}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "slate"}>{b.selection}</Badge>
                      <p className="mt-1 text-[11px] text-slate-500">{b.market}</p>
                    </td>
                    <td className="num px-4 py-3 text-right text-slate-300">{fmtOdds(b.odds)}</td>
                    <td className="num px-4 py-3 text-right text-slate-300">{fmtMoney(b.stake)}</td>
                    <td className={`num px-4 py-3 text-right ${b.edge > 0 ? "text-emerald-400" : "text-slate-500"}`}>{fmtSignedPct(b.edge)}</td>
                    <td className={`num px-4 py-3 text-right font-medium ${clvClass(b.clv)}`}>
                      {b.clv !== undefined ? fmtSignedPct(b.clv, 2) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className={`num px-4 py-3 text-right font-medium ${pnlClass(b.outcomeAmount)}`}>
                      {b.outcomeAmount !== undefined ? `${b.outcomeAmount > 0 ? "+" : ""}${fmtMoney(b.outcomeAmount)}` : <span className="text-slate-600">pending</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "sky"}>{b.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
