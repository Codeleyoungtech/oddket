"use client";

import React, { useMemo, useState } from "react";
import { buildMultiple, checkLegIndependence, legRefs, marketLabel, type SlipLeg } from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Badge, Card, CardHeader, EmptyState, Loading, SectionTitle } from "../../components/ui";
import { edgeClass, fmtMoney, fmtOdds, fmtPct, fmtSignedPct } from "../../lib/format";

export default function SlipsPage() {
  const { slips, db } = useData();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectedLegs = useMemo(
    () => slips.filter((l) => selected.has(legKey(l))),
    [slips, selected],
  );

  if (!db) return <Loading />;

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const multiple = selectedLegs.length >= 2 ? buildMultiple(selectedLegs, db.settings) : null;
  const correlation = selectedLegs.length >= 2 ? checkLegIndependence(legRefs(selectedLegs)) : null;
  const flagTone = multiple && multiple.compoundProbability >= multiple.compoundFairOdds ? "green" : "amber";

  const copySlip = async () => {
    const lines = selectedLegs.map(
      (l, i) =>
        `${i + 1}. ${l.fixture.homeTeam} vs ${l.fixture.awayTeam} — ${marketLabel(l.market, l.selection)} @ ${fmtOdds(l.odds)} (stake ₦${fmtMoney(l.stake, 0)})`,
    );
    const combined = multiple
      ? `\nCombined ${multiple.advertisedOdds.toFixed(2)}x | true prob ${fmtPct(multiple.compoundProbability)} | fair odds ${multiple.compoundFairOdds.toFixed(2)}x`
      : "";
    const text = `OddKet slip — ${selectedLegs.length} leg${selectedLegs.length > 1 ? "s" : ""}\n${lines.join("\n")}${combined}\n\nPlace manually in SportyBet. No auto-betting.`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard unavailable (http context) — fall back to select-able textarea
      window.prompt("Copy your slip:", text);
    }
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Slip Builder</h1>
        <p className="mt-1 text-sm text-slate-500">
          Singles by default, ranked by edge. Multiples are opt-in and always show the true math.{" "}
          <span className="text-amber-400/90">You place the bet yourself in SportyBet — OddKet never does.</span>
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Singles list */}
        <div className="lg:col-span-2">
          <SectionTitle sub={`${slips.length} flagged singles with edge ≥ ${fmtPct(db.settings.edgeThreshold, 0)}`}>
            Ranked opportunities
          </SectionTitle>
          {slips.length === 0 ? (
            <EmptyState title="No flagged singles right now" body="When a fixture has both a model prediction and odds with edge above the threshold, it shows up here." />
          ) : (
            <div className="space-y-2.5">
              {slips.map((leg) => {
                const key = legKey(leg);
                const checked = selected.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggle(key)}
                    className={`card group flex w-full items-center gap-4 px-4 py-3 text-left transition-all duration-150 ${
                      checked ? "border-emerald-400/50 bg-emerald-400/[0.04]" : "hover:border-ink-600 hover:bg-ink-800/40"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold transition-colors ${
                        checked ? "border-emerald-400 bg-emerald-400 text-ink-950" : "border-ink-600 bg-ink-800/60 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-100">
                        {leg.fixture.homeTeam} <span className="text-slate-500">vs</span> {leg.fixture.awayTeam}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {leg.fixture.league} · {marketLabel(leg.market, leg.selection)}
                      </p>
                    </div>
                    <div className="hidden shrink-0 text-right sm:block">
                      <p className="text-xs text-slate-500">
                        prob <span className="num text-slate-300">{fmtPct(leg.probability)}</span>
                        <span className="num text-slate-600"> ({fmtPct(leg.confidenceLow, 0)}–{fmtPct(leg.confidenceHigh, 0)})</span>
                      </p>
                      <p className={`num mt-0.5 text-sm font-semibold ${edgeClass(leg.edge)}`}>{fmtSignedPct(leg.edge)} edge</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-sm font-semibold text-slate-200">@{fmtOdds(leg.odds)}</p>
                      <p className="num mt-0.5 text-xs text-slate-400">₦{fmtMoney(leg.stake, 0)}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Multiple panel */}
        <div className="lg:col-span-1">
          <SectionTitle sub="Opt-in only — the true math always shown">Multiple builder</SectionTitle>
          <Card className="card-pad sticky top-20">
            {selectedLegs.length === 0 ? (
              <p className="text-sm text-slate-500">
                Select <span className="font-semibold text-emerald-400">2+ singles</span> to combine. Singles are always the
                default — a multiple is only worth it when the correlation is understood.
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="label mb-2">Selected legs ({selectedLegs.length})</p>
                  <ul className="space-y-1.5">
                    {selectedLegs.map((l) => (
                      <li key={legKey(l)} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-slate-400">
                          {l.fixture.homeTeam} vs {l.fixture.awayTeam} — {marketLabel(l.market, l.selection)}
                        </span>
                        <span className="num shrink-0 text-slate-300">@{fmtOdds(l.odds)}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {multiple && (
                  <div className="space-y-2 rounded-lg border border-ink-700/60 bg-ink-800/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Advertised multiplier</span>
                      <span className="num text-base font-bold text-slate-100">{multiple.advertisedOdds.toFixed(2)}x</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">True compounded probability</span>
                      <span className="num text-sm font-semibold text-sky-300">{fmtPct(multiple.compoundProbability)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Fair odds at that probability</span>
                      <span className="num text-sm text-slate-300">{multiple.compoundFairOdds.toFixed(2)}x</span>
                    </div>
                    <div className="my-1 border-t border-ink-700/40" />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Suggested stake (quarter Kelly)</span>
                      <span className="num text-sm font-semibold text-emerald-300">₦{fmtMoney(multiple.stake, 0)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">Bookmaker EV on this multiple</span>
                      <Badge tone={flagTone}>{fmtSignedPct(multiple.compoundProbability * multiple.advertisedOdds - 1)}</Badge>
                    </div>
                  </div>
                )}

                {correlation && !correlation.independent && (
                  <div className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-300">Correlation warnings</p>
                    {correlation.warnings.map((w, i) => (
                      <p key={i} className="text-xs leading-relaxed text-amber-200/80">
                        ⚠ {w}
                      </p>
                    ))}
                  </div>
                )}

                <button className="btn-primary w-full" onClick={copySlip}>
                  Copy slip for SportyBet
                </button>
                <button className="btn-ghost w-full" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
                <p className="text-center text-[11px] text-slate-600">
                  Output is a text slip for manual entry. No bets are placed by OddKet.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function legKey(l: SlipLeg): string {
  return `${l.fixture.id}:${l.market}:${l.selection}`;
}
