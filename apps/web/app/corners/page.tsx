"use client";

import React, { useMemo, useState } from "react";
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
  return (
    <div className={`flex-1 rounded border px-1 py-0.5 text-center ${probBg(prob)}`}>
      <div className="text-[8px] text-zinc-500 leading-none">{label}</div>
      <div className={`text-[10px] font-bold tabular-nums leading-tight ${probColor(prob)}`}>
        {(prob * 100).toFixed(0)}%
      </div>
    </div>
  );
}

/** Team column in the fixture card */
function TeamColumn({
  pred,
  lines,
}: {
  pred: { predictedCorners: number; confidenceLow: number; confidenceHigh: number; team: string };
  lines: Record<string, number>;
}) {
  const lineOrder = ["O2.5", "O3.5", "O4.5", "O5.5", "O6.5", "O7.5", "O8.5"] as const;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold text-zinc-100 tabular-nums">
          {pred.predictedCorners.toFixed(1)}
        </span>
        <span className="text-xs text-zinc-400 truncate">{pred.team}</span>
      </div>
      <div className="text-[10px] text-zinc-600">
        Range: {pred.confidenceLow.toFixed(1)} – {pred.confidenceHigh.toFixed(1)}
      </div>
      <div className="flex gap-1">
        {lineOrder.map((key) => {
          const p = lines[key];
          if (p === undefined) return null;
          return <LineBadge key={key} label={key} prob={p} />;
        })}
      </div>
    </div>
  );
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
    return fixtureGroups
      .filter((g) => {
        const t = g.fixture.commenceTime;
        if (timeFilter === "today" && (t < today || t >= today + 86400)) return false;
        if (timeFilter === "week" && (t < today || t >= weekEnd)) return false;
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
          <SectionTitle>Corners</SectionTitle>
          <p className="text-xs text-zinc-500 mt-1">
            Team &amp; total corner predictions — Negative Binomial line probabilities
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-300 self-start">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Not EV-checked
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
          <option value="all">All Leagues</option>
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

      {/* How to read */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-400">How to read:</span>{" "}
        Each team gets a predicted corner count with{" "}
        <span className="text-sky-400">over/under line probabilities</span>. The{" "}
        <span className="text-emerald-400 font-medium">green %</span> = how likely they clear that line.
        Compare to your bookmaker — if the model says 68% over 4.5 but the bookmaker implies 55%, that&apos;s
        potential value.
      </div>

      {/* Fixture cards */}
      <div className="grid gap-3">
        {filtered.map(({ fixture, home, away }) => {
          const totalExpected = (home.predictedCorners + away.predictedCorners).toFixed(1);
          const totalLines = (home as any).totalCorners?.lines ?? {};
          const totalLineOrder = ["over55", "over65", "over75", "over85", "over95", "over105", "over115", "over125"];
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
                      {fixture.league} · {fmtDate(fixture.commenceTime)}{" "}
                      {fmtTime(fixture.commenceTime)}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <div className="text-[10px] text-zinc-500">Total corners</div>
                    <div className="text-lg font-bold text-zinc-200 tabular-nums">
                      {totalExpected}
                    </div>
                  </div>
                </div>

                {/* Two-team grid */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <TeamColumn
                    pred={home}
                    lines={{
                      "O2.5": home.lineProbs.over25,
                      "O3.5": home.lineProbs.over35,
                      "O4.5": home.lineProbs.over45,
                      "O5.5": home.lineProbs.over55,
                      "O6.5": home.lineProbs.over65,
                      "O7.5": home.lineProbs.over75,
                      "O8.5": home.lineProbs.over85,
                    }}
                  />
                  <TeamColumn
                    pred={away}
                    lines={{
                      "O2.5": away.lineProbs.over25,
                      "O3.5": away.lineProbs.over35,
                      "O4.5": away.lineProbs.over45,
                      "O5.5": away.lineProbs.over55,
                      "O6.5": away.lineProbs.over65,
                      "O7.5": away.lineProbs.over75,
                      "O8.5": away.lineProbs.over85,
                    }}
                  />
                </div>

                {/* Total corners lines */}
                {Object.keys(totalLines).length > 0 && (
                  <div className="border-t border-zinc-800 pt-2">
                    <div className="text-[10px] text-zinc-500 mb-1.5 font-medium">
                      Total corners over/under
                    </div>
                    <div className="flex gap-1">
                      {totalLineOrder.map((key) => {
                        const p = totalLines[key];
                        if (p === undefined) return null;
                        const lineNum = key.replace("over", "");
                        return (
                          <LineBadge
                            key={key}
                            label={`O${lineNum}`}
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
          Trained on 17,351 matches (12 seasons × 4 leagues) · Team lines O2.5–O8.5 · Total lines
          O5.5–O12.5
        </div>
      </div>
    </div>
  );
}
