"use client";

import React, { useMemo, useState } from "react";
import { useData } from "../../lib/data-provider";
import { Card, EmptyState, Loading, SectionTitle } from "../../components/ui";

function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Color class for a probability value. */
function probColor(p: number): string {
  if (p >= 0.70) return "text-emerald-400";
  if (p >= 0.55) return "text-sky-400";
  if (p >= 0.45) return "text-zinc-400";
  return "text-red-400";
}
function probBg(p: number): string {
  if (p >= 0.70) return "bg-emerald-400/10 border-emerald-400/30";
  if (p >= 0.55) return "bg-sky-400/10 border-sky-400/30";
  if (p >= 0.45) return "bg-zinc-400/10 border-zinc-400/30";
  return "bg-red-400/10 border-red-400/30";
}

export default function CornersPage() {
  const { cornerPredictions, db, mode } = useData();
  const fixtures = db?.fixtures ?? [];
  const [timeFilter, setTimeFilter] = useState<"all" | "today" | "week">("all");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");

  // Build fixture groups from predictions
  const fixtureGroups = useMemo(() => {
    if (!cornerPredictions?.length) return [];
    const map = new Map<string, { fixture: any; home: any; away: any }>();
    for (const pred of cornerPredictions) {
      const fid = pred.fixtureId;
      if (!map.has(fid)) {
        const fixture = fixtures.find((f: any) => f.id === fid);
        map.set(fid, { fixture, home: null, away: null });
      }
      const g = map.get(fid)!;
      if (pred.side === "home") g.home = pred;
      else g.away = pred;
    }
    return Array.from(map.values()).filter((g) => g.fixture && g.home && g.away);
  }, [cornerPredictions, fixtures]);

  // Available leagues
  const leagues = useMemo(
    () => [...new Set(fixtureGroups.map((g) => g.fixture.league).filter(Boolean))].sort(),
    [fixtureGroups],
  );

  // Filtered groups
  const nowSec = Math.floor(Date.now() / 1000);
  const filtered = useMemo(() => {
    const startOfToday = (t: number) => {
      const d = new Date(t * 1000);
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    };
    const today = startOfToday(nowSec);
    const weekEnd = today + 7 * 86400;
    return fixtureGroups.filter((g) => {
      const t = g.fixture.commenceTime;
      if (timeFilter === "today" && (t < today || t >= today + 86400)) return false;
      if (timeFilter === "week" && (t < today || t >= weekEnd)) return false;
      if (leagueFilter !== "all" && g.fixture.league !== leagueFilter) return false;
      return true;
    }).sort((a, b) => a.fixture.commenceTime - b.fixture.commenceTime);
  }, [fixtureGroups, timeFilter, leagueFilter, nowSec]);

  if (mode === "loading") return <Loading />;
  if (!cornerPredictions?.length) {
    return (
      <EmptyState
        title="No Corner Predictions Yet"
        body="The corners model generates predictions for upcoming matches. They appear here once the predict pipeline runs (4x daily via GitHub Actions)."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <SectionTitle>Corners</SectionTitle>
          <p className="text-xs text-zinc-500 mt-1">
            Per-team corner predictions — compare to your bookmaker&apos;s corner line
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-300 self-start">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Not EV-checked
        </span>
      </div>

      {/* Filter bar — same pattern as slips page */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="flex rounded-lg border border-zinc-700/60 bg-zinc-800/60 p-0.5">
          {([["all", "All"], ["today", "Today"], ["week", "This Week"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTimeFilter(key)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                timeFilter === key ? "bg-emerald-400 text-zinc-950 shadow-sm" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={leagueFilter}
          onChange={(e) => setLeagueFilter(e.target.value)}
          className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 outline-none focus:border-sky-400/50"
        >
          <option value="all">All Leagues</option>
          {leagues.map((lg) => (
            <option key={lg} value={lg}>{lg}</option>
          ))}
        </select>
        <span className="ml-auto text-xs text-zinc-500">
          {filtered.length} match{filtered.length !== 1 ? "es" : ""}
        </span>
      </div>

      {/* How to read */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-400">How to read:</span>{" "}
        Each team gets a predicted corner count. The{" "}
        <span className="text-emerald-400 font-medium">green %</span> means how likely they are to get{" "}
        <strong className="text-zinc-300">Over X.5 corners</strong>. Compare to your bookmaker — if the
        model says 70% over 4.5 but the bookmaker&apos;s odds imply 55%, that&apos;s potential value.
      </div>

      {/* Fixture cards */}
      <div className="grid gap-3">
        {filtered.map(({ fixture, home, away }) => {
          const total = (home.predictedCorners + away.predictedCorners).toFixed(1);
          return (
            <Card key={fixture.id}>
              <div className="p-3 sm:p-4">
                {/* Match header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-zinc-100 text-sm truncate">
                      {fixture.homeTeam} vs {fixture.awayTeam}
                    </h3>
                    <p className="text-[11px] text-zinc-500">
                      {fixture.league} · {fmtDate(fixture.commenceTime)} {fmtTime(fixture.commenceTime)}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="text-xs text-zinc-500">Total</div>
                    <div className="text-lg font-bold text-zinc-200 tabular-nums">{total}</div>
                  </div>
                </div>

                {/* Two-team grid */}
                <div className="grid grid-cols-2 gap-3">
                  {[home, away].map((pred) => (
                    <div key={pred.side} className="space-y-2">
                      {/* Team name + predicted count */}
                      <div className="flex items-baseline gap-2">
                        <span className="text-lg font-bold text-zinc-100 tabular-nums">
                          {pred.predictedCorners.toFixed(1)}
                        </span>
                        <span className="text-xs text-zinc-400 truncate">{pred.team}</span>
                      </div>

                      {/* Confidence interval */}
                      <div className="text-[10px] text-zinc-600">
                        80% range: {pred.confidenceLow.toFixed(1)} – {pred.confidenceHigh.toFixed(1)}
                      </div>

                      {/* Line probabilities — compact horizontal bar */}
                      <div className="flex gap-1.5">
                        {([3.5, 4.5, 5.5, 6.5] as const).map((line) => {
                          const key = `over${line}` as keyof typeof pred.lineProbs;
                          const p = pred.lineProbs[key];
                          return (
                            <div
                              key={line}
                              className={`flex-1 rounded border px-1 py-0.5 text-center ${probBg(p)}`}
                            >
                              <div className="text-[9px] text-zinc-500 leading-none">O{line}</div>
                              <div className={`text-xs font-bold tabular-nums leading-tight ${probColor(p)}`}>
                                {(p * 100).toFixed(0)}%
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <EmptyState
          title="No matches in this filter"
          body="Try 'All' or check back closer to match day."
        />
      )}

      {/* Footer */}
      <div className="text-center text-[10px] text-zinc-600 py-2 space-y-0.5">
        <div>Model: {cornerPredictions[0]?.modelVersion || "corners-xgb-v2"} · No odds comparison · Pre-match only</div>
        <div>Trained on 14,007 matches from football-data.co.uk · MAE ≈ 1.8 corners · Line accuracy 65–77%</div>
      </div>
    </div>
  );
}
