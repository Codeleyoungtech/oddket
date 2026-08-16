"use client";

import React, { useMemo, useState } from "react";
import { buildMultiple, checkLegIndependence, legRefs, marketLabel, type SlipLeg } from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Badge, Card, CardHeader, EmptyState, Loading, SectionTitle } from "../../components/ui";
import { edgeClass, fmtDate, fmtMoney, fmtOdds, fmtPct, fmtSignedPct } from "../../lib/format";

export default function SlipsPage() {
  const { slips, bets, db, logBet, refresh } = useData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [justLogged, setJustLogged] = useState<Set<string>>(new Set());
  // Legs currently being logged — the button shows a spinner and disables so
  // a slow request can't be double-fired by impatient tapping.
  const [loggingKeys, setLoggingKeys] = useState<Set<string>>(new Set());
  const [logError, setLogError] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<"all" | "today" | "week">("all");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  // Per-leg stake override (₦). Defaults to the Kelly suggestion; lets the
  // user log what they ACTUALLY staked on SportyBet instead of what the
  // model suggested. Keyed by legKey.
  const [stakeOverrides, setStakeOverrides] = useState<Record<string, string>>({});

  const selectedLegs = useMemo(
    () => slips.filter((l) => selected.has(legKey(l))),
    [slips, selected],
  );

  // Bets already on the books (paper-trade log) for these legs.
  const loggedKeys = useMemo(
    () => new Set(bets.map((b) => `${b.fixtureId}:${b.market}:${b.selection}`)),
    [bets],
  );

  // Leagues present in the current slips — derived from data so new sports/leagues show up automatically.
  const leagues = useMemo(
    () => [...new Set(slips.map((l) => l.fixture.league).filter(Boolean))].sort(),
    [slips],
  );

  const nowSec = Math.floor(Date.now() / 1000);
  const filteredSlips = useMemo(() => {
    const startOfToday = (t: number) => {
      const d = new Date(t * 1000);
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    };
    const today = startOfToday(nowSec);
    const weekEnd = today + 7 * 86400;
    return slips.filter((l) => {
      const t = l.fixture.commenceTime;
      if (timeFilter === "today" && (t < today || t >= today + 86400)) return false;
      if (timeFilter === "week" && (t < today || t >= weekEnd)) return false;
      if (leagueFilter !== "all" && l.fixture.league !== leagueFilter) return false;
      return true;
    });
  }, [slips, timeFilter, leagueFilter, nowSec]);

  const handleLogBet = async (leg: SlipLeg) => {
    const key = legKey(leg);
    setLogError(null);
    setLoggingKeys((prev) => new Set(prev).add(key));
    try {
      await logBet({
        fixtureId: leg.fixture.id,
        market: leg.market,
        selection: leg.selection,
        odds: leg.odds,
        stake: stakeFor(leg),
        edge: leg.edge,
        modelProbability: leg.probability,
        placedAt: Math.floor(Date.now() / 1000),
      });
      setJustLogged((prev) => new Set(prev).add(key));
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Couldn't log the bet — please try again.");
    } finally {
      setLoggingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      refresh();
    }
  };

  /** Log every selected leg that isn't already on the books (one paper-trade bet per leg). */
  const handleLogAll = async () => {
    const pending = selectedLegs.filter((l) => !justLogged.has(legKey(l)) && !loggedKeys.has(legKey(l)));
    if (pending.length === 0) return;
    setLogError(null);
    const keys = new Set(pending.map(legKey));
    setLoggingKeys((prev) => new Set([...prev, ...keys]));
    try {
      for (const leg of pending) {
        await logBet({
          fixtureId: leg.fixture.id,
          market: leg.market,
          selection: leg.selection,
          odds: leg.odds,
          stake: stakeFor(leg),
          edge: leg.edge,
          modelProbability: leg.probability,
          placedAt: Math.floor(Date.now() / 1000),
        });
        setJustLogged((prev) => new Set(prev).add(legKey(leg)));
      }
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Couldn't log the bets — please try again.");
    } finally {
      setLoggingKeys(new Set());
      refresh();
    }
  };

  // Group slips by match so a fixture with legs in several markets (h2h +
  // totals) shows once, with all its qualifying picks inside one card.
  const groupedSlips = useMemo(() => {
    const groups = new Map<string, SlipLeg[]>();
    for (const leg of filteredSlips) {
      const arr = groups.get(leg.fixture.id) ?? [];
      arr.push(leg);
      groups.set(leg.fixture.id, arr);
    }
    return [...groups.entries()];
  }, [filteredSlips]);

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

  // Bookmakers enforce a minimum stake (SportyBet: ₦10). The quarter-Kelly
  // formula can suggest less (even ₦0 on thin edges) — floor display + copy
  // at the bookie minimum so a slip never says "stake ₦0".
  const MIN_STAKE = 10;
  const displayStake = (s: number) => ({ amount: Math.max(MIN_STAKE, Math.round(s)), floored: s < MIN_STAKE });

  /** Effective stake for a leg: user override if set (and sane), else the Kelly suggestion. */
  const stakeFor = (leg: SlipLeg): number => {
    const raw = stakeOverrides[legKey(leg)];
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    return displayStake(leg.stake).amount;
  };

  const copySlip = async () => {
    const lines = selectedLegs.map(
      (l, i) =>
        `${i + 1}. ${l.fixture.homeTeam} vs ${l.fixture.awayTeam} — ${marketLabel(l.market, l.selection)} @ ${fmtOdds(l.odds)} (stake ₦${fmtMoney(stakeFor(l), 0)})`,
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
          {/* Filters — time range + league. League list is derived from the data,
              so when other sports are added the options grow automatically. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ink-600/60 bg-ink-800/40 p-0.5">
              {(
                [
                  ["all", "All"],
                  ["today", "Today"],
                  ["week", "This week"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTimeFilter(key)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    timeFilter === key ? "bg-emerald-400 text-ink-950" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={leagueFilter}
              onChange={(e) => setLeagueFilter(e.target.value)}
              className="rounded-lg border border-ink-600/60 bg-ink-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-300 outline-none focus:border-sky-400/50"
            >
              <option value="all">All leagues</option>
              {leagues.map((lg) => (
                <option key={lg} value={lg}>
                  {lg}
                </option>
              ))}
            </select>
          </div>

          <SectionTitle sub={`${filteredSlips.length} of ${slips.length} flagged singles · edge ≥ ${fmtPct(db.settings.edgeThreshold, 0)}`}>
            Ranked opportunities
          </SectionTitle>
          {logError && (
            <div className="mb-3 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300">
              ⚠ {logError}
            </div>
          )}
          {filteredSlips.length === 0 ? (
            <EmptyState title="No flagged singles in this view" body="Try a wider time range or another league — every pick must clear the edge threshold and stay inside the strategy odds band." />
          ) : (
            <div className="space-y-3">
              {groupedSlips.map(([fixtureId, legs]) => {
                const first = legs[0]!;
                return (
                  <div key={fixtureId} className="card overflow-hidden">
                    <div className="flex items-center justify-between gap-3 border-b border-ink-700/40 bg-ink-800/30 px-4 py-2.5">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {first.fixture.homeTeam} <span className="text-slate-500">vs</span> {first.fixture.awayTeam}
                      </p>
                      <p className="shrink-0 text-xs text-slate-500">
                        {fmtDate(first.fixture.commenceTime)} · {first.fixture.league}
                      </p>
                    </div>
                    <div className="divide-y divide-ink-700/30">
                      {legs.map((leg) => {
                        const key = legKey(leg);
                        const checked = selected.has(key);
                        const isLogged = justLogged.has(key) || loggedKeys.has(key);
                        return (
                          <div
                            key={key}
                            role="button"
                            tabIndex={0}
                            onClick={() => toggle(key)}
                            onKeyDown={(e) => e.key === "Enter" && toggle(key)}
                            className={`group flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left transition-all duration-150 ${
                              checked ? "bg-emerald-400/[0.05]" : "hover:bg-ink-800/40"
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
                              <p className="truncate text-sm font-medium text-slate-200">
                                {marketLabel(leg.market, leg.selection)}
                                {displayStake(leg.stake).floored && (
                                  <span
                                    title="Thin edge — below the ₦10 min stake. Don't add this leg to a multiple."
                                    className="ml-1.5 inline-flex h-4 w-4 translate-y-[-1px] items-center justify-center rounded-full border border-amber-400/40 bg-amber-400/10 text-[10px] leading-none text-amber-300"
                                  >
                                    ⚠
                                  </span>
                                )}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500">
                                prob <span className="num text-slate-300">{fmtPct(leg.probability)}</span>
                                <span className="num text-slate-600"> ({fmtPct(leg.confidenceLow, 0)}–{fmtPct(leg.confidenceHigh, 0)})</span>
                              </p>
                            </div>
                            <div className="hidden shrink-0 text-right sm:block">
                              <p className={`num text-sm font-semibold ${edgeClass(leg.edge)}`}>{fmtSignedPct(leg.edge)} edge</p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="num text-sm font-semibold text-slate-200">@{fmtOdds(leg.odds)}</p>
                              <div className="relative mt-0.5 inline-block">
                                {/* ₦ sits INSIDE the field: absolutely positioned over the input's left padding. */}
                                <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">₦</span>
                                <input
                                  type="number"
                                  min={MIN_STAKE}
                                  step={10}
                                  value={stakeOverrides[legKey(leg)] ?? String(displayStake(leg.stake).amount)}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    setStakeOverrides((prev) => ({ ...prev, [legKey(leg)]: e.target.value }));
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  onKeyDown={(e) => e.stopPropagation()}
                                  className="num no-spinner w-16 rounded-none border border-ink-600/60 bg-ink-800/60 py-0.5 pl-5 pr-1.5 text-right text-xs text-slate-200 focus:border-sky-400/50 focus:outline-none"
                                  title="Stake to log — defaults to the Kelly suggestion, edit to match what you actually staked."
                                />
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleLogBet(leg);
                              }}
                              disabled={isLogged || loggingKeys.has(key)}
                              className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-wait ${
                                isLogged
                                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                                  : "border-sky-400/40 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20"
                              }`}
                            >
                              {loggingKeys.has(key) ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-300/40 border-t-sky-300" />
                                  Logging…
                                </span>
                              ) : isLogged ? (
                                "✓ Logged"
                              ) : (
                                "Log bet"
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
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
                      <li key={legKey(l)} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-slate-400">
                            {l.fixture.homeTeam} vs {l.fixture.awayTeam} — {marketLabel(l.market, l.selection)}
                          </span>
                          <span className="num shrink-0 text-slate-300">@{fmtOdds(l.odds)}</span>
                        </div>
                        {displayStake(l.stake).floored && (
                          <span
                            title="Thin edge — below the ₦10 min stake. Don't include this leg in a multiple."
                            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-amber-400/40 bg-amber-400/10 text-[10px] leading-none text-amber-300"
                          >
                            ⚠
                          </span>
                        )}
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
                      <span className="num text-sm font-semibold text-emerald-300">₦{fmtMoney(displayStake(multiple.stake).amount, 0)}{displayStake(multiple.stake).floored && <span className="text-slate-600"> · min</span>}</span>
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

                <div className="grid grid-cols-2 gap-2">
                  <button className="btn-primary" onClick={copySlip}>
                    Copy slip
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => void handleLogAll()}
                    disabled={
                      loggingKeys.size > 0 ||
                      selectedLegs.every((l) => justLogged.has(legKey(l)) || loggedKeys.has(legKey(l)))
                    }
                  >
                    {loggingKeys.size > 0 ? "Logging…" : "Log all bets"}
                  </button>
                </div>
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
