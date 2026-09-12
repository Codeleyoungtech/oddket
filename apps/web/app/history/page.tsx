"use client";

import React, { useMemo, useState } from "react";
import { marketLabel, selectionWon, type Market, type Prediction, type Selection } from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Card, EmptyState, PageSkeleton, SectionTitle, Skeleton, SkeletonList } from "../../components/ui";
import { fmtDate, fmtPct } from "../../lib/format";

type DayRange = "7" | "30" | "all";
type ResultFilter = "all" | "settled" | "pending";

/** One graded prediction row for a fixture that has already kicked off. */
interface GradedRow {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  commenceTime: number;
  market: Market;
  selection: Selection;
  probability: number;
  confidenceLow: number;
  confidenceHigh: number;
  modelVersion: string;
  /** null until the auto-settle cron has recorded a result for the fixture. */
  won: boolean | null;
  score: string | null;
}

const RESULT_BADGE: Record<string, string> = {
  won: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  lost: "border-red-400/40 bg-red-400/10 text-red-300",
  pending: "border-ink-600 bg-ink-800/60 text-slate-400",
};

/**
 * Prediction History — every prediction the model made for a fixture that has
 * already kicked off, graded against the final score once the settle cron has
 * recorded it.
 *
 * Why it exists: logging every flagged pick by hand is not realistic (and
 * never was). This page lets the model's real-world accuracy be checked from
 * the predictions that were ALREADY generated, whether or not a bet was
 * logged — so validation no longer depends on manual bet logging.
 */
export default function HistoryPage() {
  const { db, mode } = useData();
  const [days, setDays] = useState<DayRange>("7");
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [search, setSearch] = useState("");

  const nowSec = Math.floor(Date.now() / 1000);

  const rows = useMemo<GradedRow[]>(() => {
    if (!db) return [];
    const outcomeByFixture = new Map(db.outcomes.map((o) => [o.fixtureId, o]));
    const cutoff = days === "7" ? nowSec - 7 * 86400 : days === "30" ? nowSec - 30 * 86400 : 0;

    const predictionsByFixture = new Map<string, Prediction[]>();
    for (const p of db.predictions) {
      const arr = predictionsByFixture.get(p.fixtureId) ?? [];
      arr.push(p);
      predictionsByFixture.set(p.fixtureId, arr);
    }

    const out: GradedRow[] = [];
    for (const f of db.fixtures) {
      // Skip the demo seed (sport === "soccer"), exactly like the slip builder.
      if (f.sport === "soccer") continue;
      const outcome = outcomeByFixture.get(f.id);
      const isPast = f.status === "finished" || Boolean(outcome) || f.commenceTime < nowSec;
      if (!isPast) continue;
      if (cutoff && f.commenceTime < cutoff) continue;
      for (const p of predictionsByFixture.get(f.id) ?? []) {
        out.push({
          fixtureId: f.id,
          homeTeam: f.homeTeam,
          awayTeam: f.awayTeam,
          league: f.league,
          commenceTime: f.commenceTime,
          market: p.market,
          selection: p.selection,
          probability: p.probability,
          confidenceLow: p.confidenceLow,
          confidenceHigh: p.confidenceHigh,
          modelVersion: p.modelVersion,
          won: outcome ? selectionWon(p.market, p.selection, outcome.homeScore, outcome.awayScore) : null,
          score: outcome ? `${outcome.homeScore}–${outcome.awayScore}` : null,
        });
      }
    }
    return out.sort((a, b) => b.commenceTime - a.commenceTime);
  }, [db, days, nowSec]);

  const leagues = useMemo(() => [...new Set(rows.map((r) => r.league))].sort(), [rows]);
  const markets = useMemo(() => [...new Set(rows.map((r) => r.market))].sort(), [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (leagueFilter !== "all" && r.league !== leagueFilter) return false;
        if (marketFilter !== "all" && r.market !== marketFilter) return false;
        if (resultFilter === "settled" && r.won === null) return false;
        if (resultFilter === "pending" && r.won !== null) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          if (
            !r.homeTeam.toLowerCase().includes(q) &&
            !r.awayTeam.toLowerCase().includes(q) &&
            !r.league.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      }),
    [rows, leagueFilter, marketFilter, resultFilter, search],
  );

  /**
   * Validation stats. Two different questions, answered honestly:
   *  - Brier score over EVERY settled row (both sides of each market) — the
   *    proper probabilistic accuracy measure, comparable to a coin flip.
   *  - Hit rate over the MODEL PICK (highest-probability selection per
   *    fixture+market) — what the app would actually have put in front of you.
   */
  const stats = useMemo(() => {
    const settled = filtered.filter((r) => r.won !== null);
    const brier =
      settled.length > 0
        ? settled.reduce((s, r) => s + (r.probability - (r.won ? 1 : 0)) ** 2, 0) / settled.length
        : null;

    const best = new Map<string, GradedRow>();
    for (const r of filtered) {
      const k = `${r.fixtureId}|${r.market}`;
      const cur = best.get(k);
      if (!cur || r.probability > cur.probability) best.set(k, r);
    }
    const picks = [...best.values()].filter((p) => p.won !== null);
    const hitRate = picks.length > 0 ? picks.filter((p) => p.won).length / picks.length : null;

    const perMarket = new Map<string, { n: number; pickN: number; pickWins: number; brierSum: number }>();
    const bucket = (m: string) => {
      let b = perMarket.get(m);
      if (!b) {
        b = { n: 0, pickN: 0, pickWins: 0, brierSum: 0 };
        perMarket.set(m, b);
      }
      return b;
    };
    for (const r of settled) {
      const b = bucket(r.market);
      b.n += 1;
      b.brierSum += (r.probability - (r.won ? 1 : 0)) ** 2;
    }
    for (const p of picks) {
      const b = bucket(p.market);
      b.pickN += 1;
      if (p.won) b.pickWins += 1;
    }

    return { settledCount: settled.length, totalCount: filtered.length, brier, pickCount: picks.length, hitRate, perMarket };
  }, [filtered]);

  const grouped = useMemo(() => {
    const map = new Map<string, GradedRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.fixtureId) ?? [];
      arr.push(r);
      map.set(r.fixtureId, arr);
    }
    return [...map.values()];
  }, [filtered]);

  if (mode === "loading")
    return (
      <PageSkeleton>
        <SkeletonList rows={5} />
      </PageSkeleton>
    );

  return (
    <div className="animate-fade-in space-y-5">
      <div className="border-b border-ink-700/50 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Prediction History</h1>
        <p className="mt-0.5 text-xs text-slate-400">
          Past predictions graded against the final score — whether or not you logged a bet.
        </p>
      </div>

      {/* Summary — the honest scoreboard */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3">
          <p className="label">Predictions</p>
          <p className="num mt-1 text-xl font-bold text-slate-100">{stats.totalCount}</p>
          <p className="text-[10px] text-slate-500">{stats.settledCount} with a result</p>
        </Card>
        <Card className="p-3">
          <p className="label">Model-pick hit rate</p>
          <p className={`num mt-1 text-xl font-bold ${stats.hitRate === null ? "text-slate-500" : stats.hitRate >= 0.6 ? "text-emerald-400" : stats.hitRate >= 0.5 ? "text-sky-400" : "text-red-400"}`}>
            {stats.hitRate === null ? "—" : fmtPct(stats.hitRate, 0)}
          </p>
          <p className="text-[10px] text-slate-500">{stats.pickCount} settled picks</p>
        </Card>
        <Card className="p-3">
          <p className="label">Brier score</p>
          <p className="num mt-1 text-xl font-bold text-slate-100">
            {stats.brier === null ? "—" : stats.brier.toFixed(4)}
          </p>
          <p className="text-[10px] text-slate-500">lower is better · 0.25 = coin flip</p>
        </Card>
        <Card className="p-3">
          <p className="label">Markets tracked</p>
          <p className="num mt-1 text-xl font-bold text-slate-100">{stats.perMarket.size}</p>
          <p className="text-[10px] text-slate-500">graded per market below</p>
        </Card>
      </div>

      {/* Per-market scoreboard */}
      {stats.perMarket.size > 0 && (
        <Card className="p-3">
          <p className="label mb-2">By market</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-1.5">Market</th>
                  <th className="pb-1.5 text-right">Picks</th>
                  <th className="pb-1.5 text-right">Won</th>
                  <th className="pb-1.5 text-right">Hit rate</th>
                  <th className="pb-1.5 text-right">Brier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/50">
                {[...stats.perMarket.entries()]
                  .sort((a, b) => b[1].pickN - a[1].pickN)
                  .map(([market, s]) => {
                    const hit = s.pickN > 0 ? s.pickWins / s.pickN : null;
                    const br = s.n > 0 ? s.brierSum / s.n : null;
                    return (
                      <tr key={market}>
                        <td className="py-1.5 text-slate-300">{market}</td>
                        <td className="num py-1.5 text-right text-slate-400">{s.pickN}</td>
                        <td className="num py-1.5 text-right text-slate-400">{s.pickWins}</td>
                        <td className={`num py-1.5 text-right font-semibold ${hit === null ? "text-slate-500" : hit >= 0.6 ? "text-emerald-400" : hit >= 0.5 ? "text-sky-400" : "text-red-400"}`}>
                          {hit === null ? "—" : fmtPct(hit, 0)}
                        </td>
                        <td className="num py-1.5 text-right text-slate-400">{br === null ? "—" : br.toFixed(4)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Filters */}
      <div className="space-y-2 rounded-xl border border-ink-700/50 bg-ink-900/40 p-2.5">
        <div className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search team or league…"
            className="min-w-0 flex-1 rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-emerald-400/50"
          />
          <select
            value={leagueFilter}
            onChange={(e) => setLeagueFilter(e.target.value)}
            className="w-auto shrink-0 rounded-lg border border-ink-700/60 bg-ink-800/80 px-2 py-1.5 text-xs font-medium text-slate-200 outline-none focus:border-sky-400/50"
          >
            <option value="all">All Leagues</option>
            {leagues.map((lg) => (
              <option key={lg} value={lg}>{lg}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="scrollbar-none flex flex-1 gap-1 overflow-x-auto">
            {([
              ["7", "7 days"],
              ["30", "30 days"],
              ["all", "All time"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setDays(key)}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  days === key ? "bg-emerald-400 text-ink-950 shadow-sm" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="mx-1 w-px shrink-0 bg-ink-700" />
            {(["all", "settled", "pending"] as const).map((key) => (
              <button
                key={key}
                onClick={() => setResultFilter(key)}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors ${
                  resultFilter === key ? "bg-sky-400/20 text-sky-200 ring-1 ring-sky-400/30" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {key}
              </button>
            ))}
          </div>
          <select
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            className="shrink-0 rounded-lg border border-ink-700/60 bg-ink-800/80 px-2 py-1 text-[11px] font-medium text-slate-200 outline-none focus:border-sky-400/50"
          >
            <option value="all">All markets</option>
            {markets.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Graded list */}
      {grouped.length === 0 ? (
        <EmptyState
          title="No past predictions in this view"
          body="Once a fixture kicks off it moves here, and its picks are graded as soon as the settle cron records the final score. Try widening the date range or clearing filters."
        />
      ) : (
        <div className="space-y-3">
          {grouped.map((legs) => {
            const first = legs[0]!;
            return (
              <div key={first.fixtureId} className="cv-row card overflow-hidden rounded-xl border border-ink-700/50 bg-ink-900/50">
                <div className="flex flex-col gap-1 border-b border-ink-800/80 bg-ink-800/40 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 text-sm font-semibold text-slate-100">
                    {first.homeTeam} <span className="font-normal text-slate-500">vs</span> {first.awayTeam}
                    {first.score && (
                      <span className="ml-2 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[11px] font-bold text-emerald-300">
                        {first.score}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {fmtDate(first.commenceTime)} · <span className="text-slate-500">{first.league}</span>
                  </span>
                </div>
                <div className="divide-y divide-ink-800/40">
                  {legs
                    .slice()
                    .sort((a, b) => b.probability - a.probability)
                    .map((r) => {
                      const tone = r.won === null ? "pending" : r.won ? "won" : "lost";
                      return (
                        <div
                          key={`${r.market}:${r.selection}`}
                          className="flex items-center justify-between gap-3 px-4 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-200">
                              {marketLabel(r.market, r.selection)}
                            </p>
                            <p className="text-[10px] text-slate-500">
                              Model {fmtPct(r.probability)} · {fmtPct(r.confidenceLow, 0)}–{fmtPct(r.confidenceHigh, 0)}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${RESULT_BADGE[tone]}`}
                            title={r.won === null ? "Waiting for the settle cron to record this fixture's result" : undefined}
                          >
                            {tone === "won" ? "✓ Won" : tone === "lost" ? "✗ Lost" : "⏳ Awaiting"}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="py-2 text-center text-[10px] text-zinc-600">
        {rows.length > 0 ? `${rows.length} predictions across ${grouped.length} past fixtures` : ""}
        {" · "}Results are recorded by the auto-settle cron (twice daily).
      </div>
    </div>
  );
}
