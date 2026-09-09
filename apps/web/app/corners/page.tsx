"use client";

import React, { useMemo, useState } from "react";
import {
  computeTeamCornerLines,
  computeTotalCornerLines,
  bestCornerLine,
  bestTotalCornerLine,
} from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Card, EmptyState, Loading, SectionTitle } from "../../components/ui";

function fmtDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Color class for a probability value. */
function probColor(p: number): string {
  if (p >= 0.75) return "text-emerald-400";
  if (p >= 0.60) return "text-sky-400";
  if (p >= 0.45) return "text-zinc-400";
  return "text-red-400";
}
function probBg(p: number): string {
  if (p >= 0.75) return "bg-emerald-400/10 border-emerald-400/30";
  if (p >= 0.60) return "bg-sky-400/10 border-sky-400/30";
  if (p >= 0.45) return "bg-zinc-400/10 border-zinc-400/30";
  return "bg-red-400/10 border-red-400/30";
}

/** Compact line badge */
function LineBadge({ label, prob }: { label: string; prob: number }) {
  const safeProb = typeof prob === "number" && !isNaN(prob) ? prob : 0;
  return (
    <div className={`flex-1 rounded border px-1 py-0.5 text-center ${probBg(safeProb)}`}>
      <div className="text-[8px] text-zinc-500 leading-none">{label}</div>
      <div className={`text-[10px] font-bold tabular-nums leading-tight ${probColor(safeProb)}`}>
        {(safeProb * 100).toFixed(0)}%
      </div>
    </div>
  );
}

/** Team column in the fixture card */
function TeamColumn({
  pred,
  lines,
}: {
  pred: { predictedCorners: number; confidenceLow?: number; confidenceHigh?: number; team: string; side?: "home" | "away" };
  lines: Record<string, number>;
}) {
  const lineOrder = ["O2.5", "O3.5", "O4.5", "O5.5", "O6.5", "O7.5", "O8.5"] as const;
  const low = typeof pred.confidenceLow === "number" ? pred.confidenceLow.toFixed(1) : Math.max(0, pred.predictedCorners - 1.28 * 2.85).toFixed(1);
  const high = typeof pred.confidenceHigh === "number" ? pred.confidenceHigh.toFixed(1) : (pred.predictedCorners + 1.28 * 2.85).toFixed(1);

  // Compute best line pick
  const best = useMemo(() => {
    const pRecord = {
      ...pred,
      id: "",
      fixtureId: "",
      side: pred.side || "home",
      confidenceLow: parseFloat(low),
      confidenceHigh: parseFloat(high),
      lineProbs: {
        over25: lines["O2.5"] ?? 0,
        over35: lines["O3.5"] ?? 0,
        over45: lines["O4.5"] ?? 0,
        over55: lines["O5.5"] ?? 0,
        over65: lines["O6.5"] ?? 0,
        over75: lines["O7.5"] ?? 0,
        over85: lines["O8.5"] ?? 0,
      },
      modelVersion: "corners-lgb-v5",
      createdAt: 0,
    };
    return bestCornerLine(pRecord);
  }, [pred, lines, low, high]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-1">
        <div className="flex items-baseline gap-2 min-w-0 truncate">
          <span className="text-lg font-bold text-zinc-100 tabular-nums">
            {(pred.predictedCorners ?? 0).toFixed(1)}
          </span>
          <span className="text-xs text-zinc-300 font-medium truncate">{pred.team}</span>
        </div>
        {best && best.probability >= 0.65 && (
          <span className="shrink-0 rounded bg-emerald-400/10 border border-emerald-400/30 px-1.5 py-0.2 text-[9px] font-semibold text-emerald-400">
            {best.over ? "O" : "U"}{best.line} ({(best.probability * 100).toFixed(0)}%)
          </span>
        )}
      </div>
      <div className="text-[10px] text-zinc-500">
        80% Range: <span className="text-zinc-400">{low} – {high}</span>
      </div>
      <div className="flex gap-1">
        {lineOrder.map((key) => {
          const p = lines[key];
          if (p === undefined || isNaN(p)) return null;
          return <LineBadge key={key} label={key} prob={p} />;
        })}
      </div>
    </div>
  );
}

const TOTAL_LINE_LABELS: Record<string, string> = {
  over55: "O5.5",
  over65: "O6.5",
  over75: "O7.5",
  over85: "O8.5",
  over95: "O9.5",
  over105: "O10.5",
  over115: "O11.5",
  over125: "O12.5",
};

// Keyed by BOTH the live The-Odds-API league titles (what /api/fixtures
// returns) and the old seed names, so the badges survive either source.
const LEAGUE_GOLDMINES: Record<string, { badge: string; note: string; color: string }> = {
  "La Liga 2 - Spain": {
    badge: "💎 Low-Block Defense",
    note: "65.8% Under 2.5 · 69.9% Cards >3.5",
    color: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  },
  "Spanish Segunda": {
    badge: "💎 Low-Block Defense",
    note: "65.8% Under 2.5 · 69.9% Cards >3.5",
    color: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  },
  "Bundesliga 2 - Germany": {
    badge: "⚽ High-Pace Transition",
    note: "60.1% Over 2.5 · 57.8% BTTS",
    color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  },
  "German 2. Bundesliga": {
    badge: "⚽ High-Pace Transition",
    note: "60.1% Over 2.5 · 57.8% BTTS",
    color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  },
  "Serie B - Italy": {
    badge: "🚩 Stalemate & Corners",
    note: "34.5% Draws · 57.1% Over 9.5 Corners",
    color: "text-indigo-400 bg-indigo-400/10 border-indigo-400/30",
  },
  "Italian Serie B": {
    badge: "🚩 Stalemate & Corners",
    note: "34.5% Draws · 57.1% Over 9.5 Corners",
    color: "text-indigo-400 bg-indigo-400/10 border-indigo-400/30",
  },
  "League 1": {
    badge: "🚩 High Cross Volume",
    note: "54.2% Over 9.5 Corners",
    color: "text-sky-400 bg-sky-400/10 border-sky-400/30",
  },
  "English League One": {
    badge: "🚩 High Cross Volume",
    note: "54.2% Over 9.5 Corners",
    color: "text-sky-400 bg-sky-400/10 border-sky-400/30",
  },
  "Championship": {
    badge: "⚡ Direct Wing Attack",
    note: "High shot & cross frequency",
    color: "text-purple-400 bg-purple-400/10 border-purple-400/30",
  },
  "EFL Championship": {
    badge: "⚡ Direct Wing Attack",
    note: "High shot & cross frequency",
    color: "text-purple-400 bg-purple-400/10 border-purple-400/30",
  },
  "J League": {
    badge: "🎯 Tactical Discipline",
    note: "High consistency · Low ref variance",
    color: "text-rose-400 bg-rose-400/10 border-rose-400/30",
  },
  "Japan J1 League": {
    badge: "🎯 Tactical Discipline",
    note: "High consistency · Low ref variance",
    color: "text-rose-400 bg-rose-400/10 border-rose-400/30",
  },
};

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
    return Array.from(map.values())
      .filter((g) => g.home && g.away)
      .map((g) => {
        const fixture = g.fixture ?? {
          id: g.home.fixtureId,
          homeTeam: g.home.team,
          awayTeam: g.away.team,
          league: g.home.league || "Football",
          commenceTime: g.home.createdAt || Math.floor(Date.now() / 1000),
          status: "scheduled",
          sport: "soccer",
        };
        return { ...g, fixture };
      });
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
    return fixtureGroups
      .filter((g) => {
        const t = g.fixture.commenceTime;
        if (timeFilter === "today" && t > 0 && (t < today || t >= today + 86400)) return false;
        if (timeFilter === "week" && t > 0 && (t < today || t >= weekEnd)) return false;
        if (leagueFilter !== "all" && g.fixture.league !== leagueFilter) return false;
        return true;
      })
      .sort((a, b) => a.fixture.commenceTime - b.fixture.commenceTime);
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
          <SectionTitle>Corners &amp; Micro-Markets</SectionTitle>
          <p className="text-xs text-zinc-500 mt-1">
            Team &amp; total corner predictions across Tier 1 and Niche Lower-Tier leagues — Negative Binomial line probabilities
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-300 self-start">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Model Projections
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-2.5">
        <div className="flex rounded-lg border border-zinc-700/60 bg-zinc-800/60 p-0.5">
          {(
            [
              ["all", "All"],
              ["today", "Today"],
              ["week", "This Week"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTimeFilter(key)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                timeFilter === key
                  ? "bg-emerald-400 text-zinc-950 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
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
          <option value="all">All Leagues ({leagues.length})</option>
          {leagues.map((lg) => (
            <option key={lg} value={lg}>
              {lg}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-zinc-500">
          {filtered.length} match{filtered.length !== 1 ? "es" : ""}
        </span>
      </div>

      {/* How to read & betting guide */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3.5 py-2.5 text-xs text-zinc-400 space-y-1">
        <div>
          <span className="font-semibold text-zinc-200">Niche League Value Strategy:</span>{" "}
          Compare the model&apos;s <span className="text-emerald-400 font-medium">win %</span> against your sportsbook&apos;s implied odds.
          Secondary leagues (Segunda, Serie B, 2. Bundesliga, League 1, J1) exhibit less quant pricing efficiency, giving sharper edges on Total Corners &amp; Micro-Markets.
        </div>
        <div className="text-[11px] text-zinc-500">
          • <span className="text-zinc-300 font-medium">Team lines:</span> Individual team corner output • <span className="text-zinc-300 font-medium">Total lines:</span> Combined match corners • <span className="text-zinc-300 font-medium">Range:</span> 80% confidence interval.
        </div>
      </div>

      {/* Fixture cards */}
      <div className="grid gap-3">
        {filtered.map(({ fixture, home, away }) => {
          const totalExpectedNum = (home.predictedCorners || 0) + (away.predictedCorners || 0);
          const totalExpected = totalExpectedNum.toFixed(1);

          // Get or compute team lines
          const homeLinesComputed = computeTeamCornerLines(home.predictedCorners, "home");
          const awayLinesComputed = computeTeamCornerLines(away.predictedCorners, "away");

          const homeLines = {
            "O2.5": home.lineProbs?.over25 ?? home.lineProbs?.["O2.5"] ?? homeLinesComputed.over25,
            "O3.5": home.lineProbs?.over35 ?? home.lineProbs?.["O3.5"] ?? homeLinesComputed.over35,
            "O4.5": home.lineProbs?.over45 ?? home.lineProbs?.["O4.5"] ?? homeLinesComputed.over45,
            "O5.5": home.lineProbs?.over55 ?? home.lineProbs?.["O5.5"] ?? homeLinesComputed.over55,
            "O6.5": home.lineProbs?.over65 ?? home.lineProbs?.["O6.5"] ?? homeLinesComputed.over65,
            "O7.5": home.lineProbs?.over75 ?? home.lineProbs?.["O7.5"] ?? homeLinesComputed.over75,
            "O8.5": home.lineProbs?.over85 ?? home.lineProbs?.["O8.5"] ?? homeLinesComputed.over85,
          };

          const awayLines = {
            "O2.5": away.lineProbs?.over25 ?? away.lineProbs?.["O2.5"] ?? awayLinesComputed.over25,
            "O3.5": away.lineProbs?.over35 ?? away.lineProbs?.["O3.5"] ?? awayLinesComputed.over35,
            "O4.5": away.lineProbs?.over45 ?? away.lineProbs?.["O4.5"] ?? awayLinesComputed.over45,
            "O5.5": away.lineProbs?.over55 ?? away.lineProbs?.["O5.5"] ?? awayLinesComputed.over55,
            "O6.5": away.lineProbs?.over65 ?? away.lineProbs?.["O6.5"] ?? awayLinesComputed.over65,
            "O7.5": away.lineProbs?.over75 ?? away.lineProbs?.["O7.5"] ?? awayLinesComputed.over75,
            "O8.5": away.lineProbs?.over85 ?? away.lineProbs?.["O8.5"] ?? awayLinesComputed.over85,
          };

          // Get or compute total lines
          const totalLines = (home as any).totalCorners?.lines ?? computeTotalCornerLines(totalExpectedNum);
          const totalLineOrder = ["over55", "over65", "over75", "over85", "over95", "over105", "over115", "over125"];

          // Best total line recommendation
          const bestTotal = bestTotalCornerLine(totalExpectedNum);
          const goldmine = LEAGUE_GOLDMINES[fixture.league];

          return (
            <Card key={fixture.id}>
              <div className="p-3 sm:p-4">
                {/* Match header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-zinc-100 text-sm truncate">
                        {fixture.homeTeam} vs {fixture.awayTeam}
                      </h3>
                      {goldmine && (
                        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${goldmine.color}`}>
                          {goldmine.badge} <span className="opacity-70 font-normal">({goldmine.note})</span>
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      {fixture.league} {fixture.commenceTime > 0 ? `· ${fmtDate(fixture.commenceTime)} ${fmtTime(fixture.commenceTime)}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="text-[10px] text-zinc-500">Total Expected</div>
                    <div className="text-lg font-bold text-zinc-200 tabular-nums">
                      {totalExpected} <span className="text-xs font-normal text-zinc-500">corners</span>
                    </div>
                  </div>
                </div>

                {/* Two-team grid */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <TeamColumn
                    pred={home}
                    lines={homeLines}
                  />
                  <TeamColumn
                    pred={away}
                    lines={awayLines}
                  />
                </div>

                {/* Total corners lines */}
                {totalLines && (
                  <div className="border-t border-zinc-800 pt-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[10px] text-zinc-400 font-medium">
                        Total Match Corners Over/Under
                      </div>
                      {bestTotal && (
                        <div className="text-[10px] font-semibold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-1.5 py-0.2 rounded">
                          Best: {bestTotal.label} ({(bestTotal.probability * 100).toFixed(0)}%)
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {totalLineOrder.map((key) => {
                        const p = totalLines[key];
                        if (p === undefined || isNaN(p)) return null;
                        const label = TOTAL_LINE_LABELS[key] || key;
                        return (
                          <LineBadge
                            key={key}
                            label={label}
                            prob={p}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
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
        <div>
          Model: {cornerPredictions[0]?.modelVersion || "corners-lgb-v5"} · Negative Binomial line
          probabilities · Pre-match only
        </div>
        <div>
          Trained on 31,358 matches (238 teams across 11 leagues) · Team lines O2.5–O8.5 · Total lines
          O5.5–O12.5
        </div>
      </div>
    </div>
  );
}
