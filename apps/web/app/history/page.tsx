"use client";

import React, { useMemo, useState } from "react";
import {
  ACTIVE_RULES,
  RULES,
  RULES_BY_ID,
  RULES_FREEZE_FIXTURES,
  RULES_TARGET_FIXTURES,
  applicationsForLeg,
  evaluateRuleStandings,
  marketLabel,
  ruleApplicationsByFixture,
  selectionWon,
  settledFixtureCount,
  type Market,
  type Prediction,
  type RuleStatus,
  type Selection,
} from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Card, EmptyState, PageSkeleton, SectionTitle, Skeleton, SkeletonList } from "../../components/ui";
import { fmtDate, fmtPct } from "../../lib/format";

type DayRange = "7" | "30" | "all";
type ResultFilter = "all" | "settled" | "pending";

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

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

/** Rule-book status styling. A failed rule stays failed — this is a label, not
 *  an invitation to re-tune a threshold. */
const RULE_STATUS_BADGE: Record<RuleStatus, string> = {
  surviving: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  experimental: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  failed: "border-red-400/40 bg-red-400/10 text-red-300",
};

const RULE_STATUS_LABEL: Record<RuleStatus, string> = {
  surviving: "🔥 surviving",
  experimental: "🧪 experimental",
  failed: "❌ failed",
};

const RULE_STATUS_TEXT: Record<RuleStatus, string> = {
  surviving: "text-emerald-300",
  experimental: "text-amber-300",
  failed: "text-red-300",
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
  /** "all" | "active" (non-failed rules) | a specific rule id from the book. */
  const [ruleFilter, setRuleFilter] = useState<string>("all");

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

  /**
   * Rule book, scored over EVERY settled fixture — deliberately not over
   * `rows`. The denominator has to keep growing, so narrowing the table with a
   * filter must never change a rule's record.
   */
  const ruleApps = useMemo(
    () => (db ? ruleApplicationsByFixture(db.predictions) : null),
    [db],
  );

  const standings = useMemo(() => {
    if (!db) return [];
    return evaluateRuleStandings(
      db.fixtures.filter((f) => f.sport !== "soccer"),
      db.predictions,
      db.outcomes,
    );
  }, [db]);

  const settledTotal = useMemo(
    () => (db ? settledFixtureCount(db.fixtures.filter((f) => f.sport !== "soccer"), db.outcomes) : 0),
    [db],
  );

  /** Every rule that fires on this row's exact market + selection. */
  const ruleIdsForRow = (r: GradedRow): string[] =>
    applicationsForLeg(ruleApps?.get(r.fixtureId), r.market, r.selection).map((a) => a.ruleId);

  /** Does a row survive the rule-book filter? */
  const ruleFilterPasses = (r: GradedRow): boolean => {
    if (ruleFilter === "all") return true;
    const apps = ruleApps?.get(r.fixtureId);
    if (!apps) return false;
    const pool =
      ruleFilter === "active"
        ? apps.filter((a) => a.rule.status !== "failed")
        : apps.filter((a) => a.ruleId === ruleFilter);
    return pool.some((a) => a.market === r.market && a.selection === r.selection);
  };

  const leagues = useMemo(() => [...new Set(rows.map((r) => r.league))].sort(), [rows]);
  const markets = useMemo(() => [...new Set(rows.map((r) => r.market))].sort(), [rows]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (!ruleFilterPasses(r)) return false;
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
    [rows, leagueFilter, marketFilter, resultFilter, search, ruleFilter, ruleApps],
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

  /** The single rule behind a specific-id filter, for the banner below. */
  const activeRule =
    ruleFilter !== "all" && ruleFilter !== "active" ? RULES_BY_ID[ruleFilter] : undefined;

  const grouped = useMemo(() => {
    const map = new Map<string, GradedRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.fixtureId) ?? [];
      arr.push(r);
      map.set(r.fixtureId, arr);
    }
    return [...map.values()];
  }, [filtered]);

  const exportCsv = () => {
    const headers = [
      "fixture_id",
      "commence_time",
      "league",
      "home_team",
      "away_team",
      "market",
      "selection",
      "probability",
      "confidence_low",
      "confidence_high",
      "model_version",
      "result",
      "score",
      "rules",
    ];

    const lines = filtered.map((r) => {
      const result = r.won === null ? "pending" : r.won ? "won" : "lost";
      return [
        csvEscape(r.fixtureId),
        csvEscape(new Date(r.commenceTime * 1000).toISOString()),
        csvEscape(r.league),
        csvEscape(r.homeTeam),
        csvEscape(r.awayTeam),
        csvEscape(r.market),
        csvEscape(r.selection),
        csvEscape(r.probability),
        csvEscape(r.confidenceLow),
        csvEscape(r.confidenceHigh),
        csvEscape(r.modelVersion),
        csvEscape(result),
        csvEscape(r.score),
        csvEscape(ruleIdsForRow(r).join(" ")),
      ].join(",");
    });

    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `prediction-history-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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

      {/* Rule book — the frozen rules, tracked as the denominator grows */}
      <Card className="p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="label">Rule book · frozen at {RULES_FREEZE_FIXTURES} fixtures</p>
          <span className="text-[10px] text-slate-500">
            {settledTotal} / {RULES_TARGET_FIXTURES} settled fixtures evaluated
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400 transition-all"
            style={{ width: `${Math.min(100, (settledTotal / RULES_TARGET_FIXTURES) * 100).toFixed(1)}%` }}
          />
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
          Thresholds are frozen: a rule that loses is recorded, never re-tuned. Status only changes when the record does.
          Tap a rule to filter the table below to just its picks.
        </p>
        <div className="mt-2.5 overflow-x-auto">
          <table className="w-full min-w-[540px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-1.5">Rule</th>
                <th className="pb-1.5">Backs</th>
                <th className="pb-1.5 text-right">Frozen</th>
                <th className="pb-1.5 text-right">Now</th>
                <th className="pb-1.5 text-right">Rate</th>
                <th className="pb-1.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800/50">
              {standings.map((s) => {
                const r = s.rule;
                const selected = ruleFilter === r.id;
                return (
                  <tr key={r.id} className={selected ? "bg-emerald-400/[0.06]" : undefined}>
                    <td className="py-1.5">
                      <button
                        type="button"
                        onClick={() => setRuleFilter(selected ? "all" : r.id)}
                        title={`${r.note}\n\n${r.conditions.map((c) => c.label).join("  AND  ")}`}
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-bold transition-colors ${RULE_STATUS_BADGE[r.status]} ${
                          selected ? "ring-1 ring-current" : "hover:brightness-125"
                        }`}
                      >
                        {r.id}
                      </button>
                    </td>
                    <td className="max-w-[180px] truncate py-1.5 text-slate-300">{r.targetLabel}</td>
                    <td className="num py-1.5 text-right text-slate-500">
                      {r.frozenRecord.hits}/{r.frozenRecord.qualifying}
                    </td>
                    <td className="num py-1.5 text-right font-semibold text-slate-100">
                      {s.hits}/{s.qualifying}
                    </td>
                    <td
                      className={`num py-1.5 text-right font-semibold ${
                        s.hitRate === null
                          ? "text-slate-500"
                          : s.hitRate >= 0.95
                            ? "text-emerald-400"
                            : s.hitRate >= 0.85
                              ? "text-amber-300"
                              : "text-red-400"
                      }`}
                    >
                      {s.hitRate === null ? "—" : fmtPct(s.hitRate, 0)}
                    </td>
                    <td className={`py-1.5 text-right text-[10px] font-bold ${RULE_STATUS_TEXT[r.status]}`}>
                      {s.brokenSinceFreeze && r.status !== "failed" ? "💥 broke" : RULE_STATUS_LABEL[r.status]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

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
          <button
            type="button"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="shrink-0 rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export CSV
          </button>
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
          <select
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value)}
            title="Show only predictions that match a rule from the frozen rule book"
            className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] font-medium outline-none ${
              ruleFilter === "all"
                ? "border-ink-700/60 bg-ink-800/80 text-slate-200"
                : "border-emerald-400/50 bg-emerald-400/10 text-emerald-200"
            }`}
          >
            <option value="all">All predictions</option>
            <option value="active">📕 Rule picks ({ACTIVE_RULES.length} active rules)</option>
            <optgroup label="Surviving / experimental">
              {RULES.filter((r) => r.status !== "failed").map((r) => (
                <option key={r.id} value={r.id}>{r.id} · {r.targetLabel}</option>
              ))}
            </optgroup>
            <optgroup label="Failed (kept for the record)">
              {RULES.filter((r) => r.status === "failed").map((r) => (
                <option key={r.id} value={r.id}>{r.id} · {r.targetLabel}</option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>

      {ruleFilter !== "all" && (
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-200">
          {activeRule ? (
            <>
              <span className="font-bold">📕 {activeRule.id} · {activeRule.targetLabel}</span>
              {" — "}
              {activeRule.conditions.map((c) => c.label).join(" AND ")}.
              {" "}
              <span className="text-emerald-300/70">
                Frozen record {activeRule.frozenRecord.hits}/{activeRule.frozenRecord.qualifying}. {activeRule.note}
              </span>
            </>
          ) : (
            <>
              <span className="font-bold">📕 Rule picks</span>
              {" — "}
              every prediction whose fixture satisfies one of the {ACTIVE_RULES.length} active rules ({ACTIVE_RULES.map((r) => r.id).join(", ")}). Failed rules are excluded here, but stay listed in the rule book above.
            </>
          )}
        </div>
      )}

      {/* Graded list */}
      {grouped.length === 0 ? (
        <EmptyState
          title="No past predictions in this view"
          body="Once a fixture kicks off it moves here, and its picks are graded as soon as the settle cron records the final score. Try widening the date range, clearing the rule filter, or selecting another league."
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
                            <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-200">
                              <span className="truncate">{marketLabel(r.market, r.selection)}</span>
                              {ruleIdsForRow(r).map((id) => {
                                const rule = RULES_BY_ID[id];
                                return (
                                  <span
                                    key={id}
                                    title={
                                      rule
                                        ? `${rule.id} · ${rule.targetLabel}\n${rule.conditions.map((c) => c.label).join("  AND  ")}`
                                        : id
                                    }
                                    className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${
                                      RULE_STATUS_BADGE[rule?.status ?? "failed"]
                                    }`}
                                  >
                                    📕 {id}
                                  </span>
                                );
                              })}
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
