"use client";

import React, { useMemo, useState } from "react";
import { useData } from "../../lib/data-provider";
import { Card, CardHeader, EmptyState, Loading, SectionTitle } from "../../components/ui";

/** Format timestamp to readable date. */
function fmtDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** Format timestamp to time. */
function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Color for a probability value. */
function probColor(p: number): string {
  if (p >= 0.70) return "text-emerald-400";
  if (p >= 0.55) return "text-sky-400";
  if (p >= 0.45) return "text-zinc-400";
  return "text-red-400";
}

/** Badge for a probability line. */
function LineBadge({ label, prob }: { label: string; prob: number }) {
  const pct = (prob * 100).toFixed(0);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${probColor(prob)}`}>
        {pct}%
      </span>
    </div>
  );
}

export default function CornersPage() {
  const { cornerPredictions, db, mode } = useData();
  const fixtures = db?.fixtures ?? [];
  const [filter, setFilter] = useState<"all" | "today" | "tomorrow">("all");

  // Group predictions by fixture
  const fixtureGroups = useMemo(() => {
    if (!cornerPredictions?.length) return [];

    const fixtureMap = new Map<string, { fixture: any; preds: any[] }>();
    for (const pred of cornerPredictions) {
      const fid = pred.fixtureId;
      if (!fixtureMap.has(fid)) {
        const fixture = fixtures.find((f: any) => f.id === fid);
        fixtureMap.set(fid, { fixture, preds: [] });
      }
      fixtureMap.get(fid)!.preds.push(pred);
    }

    const groups = Array.from(fixtureMap.values())
      .filter((g) => g.fixture)
      .map((g) => ({
        ...g,
        preds: g.preds.sort((a: any, b: any) => (a.side === "home" ? -1 : 1)),
      }));

    // Sort by fixture kickoff time
    groups.sort((a, b) => (a.fixture?.commenceTime ?? 0) - (b.fixture?.commenceTime ?? 0));

    // Filter
    if (filter === "today") {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
      const todayEnd = todayStart + 86400;
      return groups.filter((g) => g.fixture.commenceTime >= todayStart && g.fixture.commenceTime < todayEnd);
    }
    if (filter === "tomorrow") {
      const now = new Date();
      const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000;
      const tomorrowEnd = tomorrowStart + 86400;
      return groups.filter((g) => g.fixture.commenceTime >= tomorrowStart && g.fixture.commenceTime < tomorrowEnd);
    }
    return groups;
  }, [cornerPredictions, fixtures, filter]);

  if (mode === "loading") return <Loading />;
  if (!cornerPredictions?.length) {
    return (
      <EmptyState
        title="No Corner Predictions Yet"
        body="The corners model generates predictions for upcoming matches. They'll appear here once the predict pipeline runs."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <SectionTitle>Corners Predictions</SectionTitle>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
            ⚠️ Model prediction — not EV-checked, no odds comparison
          </span>
        </div>
      </div>

      {/* Info banner */}
      <Card className="border-amber-500/20 bg-amber-500/5">
        <div className="p-3 text-xs text-amber-200/80 space-y-1">
          <p className="font-medium text-amber-300">How to use this page:</p>
          <ul className="list-disc list-inside space-y-0.5 text-zinc-400">
            <li>Each team gets a <strong className="text-zinc-300">predicted corner count</strong> with an 80% confidence interval</li>
            <li>The <strong className="text-zinc-300">over/under line probabilities</strong> show how likely each team is to clear a corner line</li>
            <li>Compare these to your bookmaker&apos;s corner line — if the model says 70% over 4.5 but the bookmaker implies 55%, that&apos;s potential value</li>
            <li>This is <strong className="text-amber-300">NOT connected to the EV engine</strong> — check the bookmaker line yourself</li>
          </ul>
        </div>
      </Card>

      {/* Filters */}
      <div className="flex gap-2">
        {(["all", "today", "tomorrow"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              filter === f
                ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
            }`}
          >
            {f === "all" ? "All Matches" : f === "today" ? "Today" : "Tomorrow"}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          Strong ({">"}70%)
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-sky-400" />
          Moderate (55-70%)
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-zinc-400" />
          Even (45-55%)
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          Unlikely ({"<"}45%)
        </div>
      </div>

      {/* Fixture cards */}
      <div className="grid gap-4">
        {fixtureGroups.map(({ fixture, preds }) => {
          const homePred = preds.find((p: any) => p.side === "home");
          const awayPred = preds.find((p: any) => p.side === "away");
          if (!homePred || !awayPred) return null;

          return (
            <Card key={fixture.id}>
              <CardHeader
                title={`${fixture.homeTeam} vs ${fixture.awayTeam}`}
                subtitle={`${fixture.league} · ${fmtDate(fixture.commenceTime)} ${fmtTime(fixture.commenceTime)}`}
                right={<span className="text-[10px] text-zinc-600 font-mono">{homePred.modelVersion}</span>}
              />
              <div className="p-4 space-y-4">
                {/* Predicted corner counts */}
                <div className="grid grid-cols-2 gap-4">
                  {preds.map((pred: any) => (
                    <div key={pred.side} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                          pred.side === "home" ? "bg-sky-500/10 text-sky-300" : "bg-orange-500/10 text-orange-300"
                        }`}>
                          {pred.side === "home" ? "🏠 Home" : "✈️ Away"}
                        </span>
                        <span className="text-sm font-medium text-zinc-200">{pred.team}</span>
                      </div>

                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl font-bold text-zinc-100 tabular-nums">
                          {pred.predictedCorners.toFixed(1)}
                        </span>
                        <span className="text-xs text-zinc-500">
                          corners
                        </span>
                      </div>

                      <div className="text-xs text-zinc-500">
                        80% CI: {pred.confidenceLow.toFixed(1)} – {pred.confidenceHigh.toFixed(1)}
                      </div>

                      {/* Line probabilities */}
                      <div className="grid grid-cols-4 gap-2 pt-2 border-t border-zinc-800">
                        <LineBadge label="O 3.5" prob={pred.lineProbs.over35} />
                        <LineBadge label="O 4.5" prob={pred.lineProbs.over45} />
                        <LineBadge label="O 5.5" prob={pred.lineProbs.over55} />
                        <LineBadge label="O 6.5" prob={pred.lineProbs.over65} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Combined insight */}
                <div className="pt-2 border-t border-zinc-800 text-xs text-zinc-500">
                  Total predicted corners:{" "}
                  <span className="font-medium text-zinc-300">
                    {(homePred.predictedCorners + awayPred.predictedCorners).toFixed(1)}
                  </span>
                  <span className="text-zinc-600 ml-2">
                    (home {homePred.predictedCorners.toFixed(1)} + away {awayPred.predictedCorners.toFixed(1)})
                  </span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {fixtureGroups.length === 0 && (
        <EmptyState
          title="No matches in this filter"
          body="Try 'All Matches' or check back closer to match day."
        />
      )}

      {/* Footer disclaimer */}
      <div className="text-center text-xs text-zinc-600 py-4">
        Corner predictions are pre-match estimates only. No live/in-play data. No odds comparison.
        <br />
        Model: {cornerPredictions[0]?.modelVersion || "corners-xgb-v2"} · Trained on football-data.co.uk historical data
      </div>
    </div>
  );
}
