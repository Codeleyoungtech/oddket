"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  buildMultiple,
  checkLegIndependence,
  legRefs,
  marketLabel,
  suggestParlays,
  type ParlaySuggestion,
  type SlipLeg,
} from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { api } from "../../lib/api";
import { Badge, Card, CardHeader, EmptyState, PageSkeleton, SectionTitle, Skeleton, SkeletonList } from "../../components/ui";
import { edgeClass, fmtDate, fmtMoney, fmtOdds, fmtPct, fmtSignedPct } from "../../lib/format";
import { renderSlipImage } from "../../lib/slip-image";
import { VirtualList } from "../../components/virtual-list";

export default function SlipsPage() {
  const { slips, allPredictions, bets, db, logBet, logParlay, refresh, sport } = useData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [justLogged, setJustLogged] = useState<Set<string>>(new Set());
  // Legs currently being logged — the button shows a spinner and disables so
  // a slow request can't be double-fired by impatient tapping.
  const [loggingKeys, setLoggingKeys] = useState<Set<string>>(new Set());
  const [logError, setLogError] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<"all" | "today" | "tomorrow" | "week">("all");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [strategyFilter, setStrategyFilter] = useState<"all" | "high_prob" | "big_edge" | "favorites">("all");
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  // Mobile only: the multiple builder is an accordion, collapsed on first
  // load so it doesn't push predictions off-screen. Desktop (lg+) always
  // shows it. Auto-opens when the first leg is selected.
  const [multiplesOpen, setMultiplesOpen] = useState(false);
  // Per-leg stake override (₦). Defaults to the Kelly suggestion; lets the
  // user log what they ACTUALLY staked on SportyBet instead of what the
  // model suggested. Keyed by legKey.
  const [stakeOverrides, setStakeOverrides] = useState<Record<string, string>>({});
  // Shown when the leg cap blocks an extra selection.
  const [capNotice, setCapNotice] = useState<string | null>(null);
  // True parlay logging (one unit, settles all-or-nothing).
  const [loggingParlay, setLoggingParlay] = useState<string | null>(null);
  const [parlayError, setParlayError] = useState<string | null>(null);
  const [loggedParlays, setLoggedParlays] = useState<Set<string>>(new Set());
  // Share-as-image + Telegram state. `legs`/`combined` record WHAT the rendered
  // image represents, so sharing a suggested accumulator doesn't fall back to
  // describing whatever happens to be selected in the manual builder.
  const [shareState, setShareState] = useState<{
    status: "idle" | "generating" | "ready" | "sending" | "sent" | "error";
    imageUrl?: string;
    error?: string;
    legs?: SlipLeg[];
    combined?: { odds: number; probability: number; fairOdds: number } | null;
  }>({ status: "idle" });
  const sharePanelRef = useRef<HTMLDivElement | null>(null);

  // When showAll is on, use allPredictions instead of flagged slips.
  const activeLegs = showAll ? allPredictions : slips;

  const selectedLegs = useMemo(
    () => activeLegs.filter((l) => selected.has(legKey(l))),
    [activeLegs, selected],
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
    return activeLegs.filter((l) => {
      const t = l.fixture.commenceTime;
      if (timeFilter === "today" && (t < today || t >= today + 86400)) return false;
      if (timeFilter === "tomorrow" && (t < today + 86400 || t >= today + 2 * 86400)) return false;
      if (timeFilter === "week" && (t < today || t >= weekEnd)) return false;
      if (leagueFilter !== "all" && l.fixture.league !== leagueFilter) return false;
      if (strategyFilter === "high_prob" && l.probability < 0.60) return false;
      if (strategyFilter === "big_edge" && l.edge < 0.07) return false;
      if (strategyFilter === "favorites" && l.odds > 1.85) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const ht = (l.fixture.homeTeam ?? "").toLowerCase();
        const at = (l.fixture.awayTeam ?? "").toLowerCase();
        const lg = (l.fixture.league ?? "").toLowerCase();
        if (!ht.includes(q) && !at.includes(q) && !lg.includes(q)) return false;
      }
      return true;
    });
  }, [activeLegs, timeFilter, leagueFilter, strategyFilter, search, nowSec]);

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

  /**
   * Auto-suggest rule-compliant parlays (EV-ranked, independent legs only,
   * within the Settings leg cap) from the flagged singles pool. Selection +
   * logging stays MANUAL — this only surfaces candidate groupings.
   *
   * NOTE: this useMemo MUST live before the `if (!db) return <Loading />`
   * guard — a hook after a conditional early-return makes React throw #310
   * (more hooks than the previous render) once db loads.
   */
  const suggestions = useMemo(() => {
    if (!db || !db.settings.multiplesEnabled) return [];
    return suggestParlays(slips, db.settings, sport, 9);
  }, [db, slips, sport]);

  /**
   * Model-only accumulators.
   *
   * Markets like O1.5 and team-to-score have a model probability but NO
   * bookmaker price in the feed (the odds pull requests h2h + totals 2.5 only),
   * so they can never enter the EV-checked builder above — a parlay's
   * multiplier IS the product of its leg prices. This combines them on
   * probability alone: real joint chance, break-even odds, no multiplier/EV/stake.
   *
   * Correlation still matters here and is handled by the same same-match rule:
   * O1.5 and both team-to-score lines in ONE fixture are strongly dependent, so
   * at most one leg per match can be chosen.
   *
   * Same hook-ordering rule as `suggestions`: must stay before `if (!db)`.
   */
  const modelOnlySuggestions = useMemo(() => {
    if (!db) return [];
    const unpriced = allPredictions.filter((l) => !(l.odds > 1));
    if (unpriced.length === 0) return [];
    return suggestParlays(unpriced, db.settings, sport, 3, "model-only");
  }, [db, allPredictions, sport]);

  if (!db)
    return (
      <PageSkeleton>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-2.5">
          <div className="flex gap-2">
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-16" />
          </div>
          <div className="mt-2 flex gap-2">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
          </div>
        </div>
        <SkeletonList rows={5} />
      </PageSkeleton>
    );

  // Gated behind Settings → Multiples. OFF = the builder is completely hidden;
  // ON = opt-in selection with a configurable leg cap (Settings → max legs,
  // default 3). Calibration error compounds badly beyond a few legs at longer
  // combined odds — the longshot-bleed pattern.
  const multiplesOn = db.settings.multiplesEnabled === true;
  const MAX_LEGS = Math.max(2, Math.min(db.settings.maxMultipleLegs ?? 3, 6));

  const toggle = (key: string, hasOdds: boolean) => {
    if (!multiplesOn || !hasOdds) return; // skip model-only predictions (no odds = can't build a slip)
    setCapNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_LEGS) {
          setCapNotice(`Max ${MAX_LEGS} legs per multiple — pick ${MAX_LEGS} and deselect one to swap.`);
          return prev;
        }
        // First selection on mobile → surface the builder so the user sees
        // the slip they're building without scrolling back up.
        setMultiplesOpen(true);
        next.add(key);
      }
      return next;
    });
  };

  /** Log a suggested parlay as ONE unit — settles all-or-nothing. */
  const handleLogParlay = async (s: ParlaySuggestion) => {
    const key = parlayKey(s);
    if (loggedParlays.has(key)) return;
    setParlayError(null);
    setLoggingParlay(key);
    try {
      await logParlay({
        legIds: s.legs.map((l) => legKey(l)),
        stake: Math.max(MIN_STAKE, Math.round(s.stake)),
      });
      setLoggedParlays((prev) => new Set(prev).add(key));
      setSelected((prev) => {
        const next = new Set(prev);
        s.legs.forEach((l) => next.delete(legKey(l))); // clear consumed legs from the manual builder
        return next;
      });
    } catch (err) {
      setParlayError(err instanceof Error ? err.message : "Couldn't log the parlay — please try again.");
    } finally {
      setLoggingParlay(null);
      refresh();
    }
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

  /** Combined-stats shape carried by a share (manual builder or a suggestion). */
  type ShareCombined = { odds: number; probability: number; fairOdds: number };

  /** The stats for whatever is currently selected in the manual builder. */
  const selectionCombined: ShareCombined | null = multiple
    ? { odds: multiple.advertisedOdds, probability: multiple.compoundProbability, fairOdds: multiple.compoundFairOdds }
    : null;

  /** Legs + stats the in-flight share refers to (falls back to the selection). */
  const shareLegs = shareState.legs ?? selectedLegs;
  const shareCombined = shareState.combined !== undefined ? shareState.combined : selectionCombined;

  /** Plain-text version of a slip — used by Copy, share, and Telegram. */
  const slipTextFor = (legs: SlipLeg[], combined: ShareCombined | null): string => {
    const lines = legs.map(
      (l, i) =>
        `${i + 1}. ${l.fixture.homeTeam} vs ${l.fixture.awayTeam} — ${marketLabel(l.market, l.selection)} @ ${fmtOdds(l.odds)} (stake ₦${fmtMoney(stakeFor(l), 0)})`,
    );
    const combinedLine = combined
      ? `\nCombined ${combined.odds.toFixed(2)}x | true prob ${fmtPct(combined.probability)} | fair odds ${combined.fairOdds.toFixed(2)}x`
      : "";
    return `OddKet slip — ${legs.length} leg${legs.length > 1 ? "s" : ""}\n${lines.join("\n")}${combinedLine}\n\nPlace manually in SportyBet. No auto-betting.`;
  };

  const copySlip = async () => {
    const text = slipTextFor(selectedLegs, selectionCombined);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard unavailable (http context) — fall back to select-able textarea
      window.prompt("Copy your slip:", text);
    }
  };

  /**
   * Render a slip to a PNG (client-side) and reveal the share panel.
   * Call with no args to share the manual builder selection, or with a
   * suggested accumulator's legs + stats to share that ticket directly.
   */
  const openShare = async (legsArg?: SlipLeg[], combinedArg?: ShareCombined | null) => {
    const legs = legsArg ?? selectedLegs;
    if (legs.length === 0) return;
    setShareState({ status: "generating" });
    try {
      const stakes: Record<string, number> = {};
      legs.forEach((l) => {
        stakes[legKey(l)] = stakeFor(l);
      });
      const combined = combinedArg !== undefined ? combinedArg : selectionCombined;
      const imageUrl = await renderSlipImage({
        legs,
        stakes,
        combinedOdds: combined?.odds ?? null,
        combinedProbability: combined?.probability ?? null,
        combinedFairOdds: combined?.fairOdds ?? null,
      });
      setShareState({ status: "ready", imageUrl, legs, combined });
      // The panel sits lower in the builder than the suggestion cards, so pull
      // it into view when the share was started from a suggestion.
      requestAnimationFrame(() => sharePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } catch (err) {
      setShareState({ status: "error", error: err instanceof Error ? err.message : "Couldn't render the slip image." });
    }
  };

  /** Save the rendered PNG to the device (mobile downloads / desktop <a>). */
  const downloadSlipImage = () => {
    if (!shareState.imageUrl) return;
    const a = document.createElement("a");
    a.href = shareState.imageUrl;
    a.download = `oddket-slip-${Date.now()}.png`;
    a.click();
  };

  /** Send the slip (image + text) to your Telegram chat via the worker. */
  const shareToTelegram = async () => {
    if (!shareState.imageUrl) return;
    setShareState((s) => ({ ...s, status: "sending" }));
    try {
      await api.telegramShare({ text: slipTextFor(shareLegs, shareCombined), imageDataUrl: shareState.imageUrl });
      setShareState((s) => ({ ...s, status: "sent" }));
    } catch (err) {
      setShareState({
        status: "error",
        imageUrl: shareState.imageUrl,
        error: err instanceof Error ? err.message : "Telegram share failed — is it configured on the worker?",
      });
    }
  };

  /** Native share sheet (mobile) with the image attached, fallback to Telegram. */
  const nativeShare = async () => {
    if (!shareState.imageUrl) return;
    try {
      const blob = await (await fetch(shareState.imageUrl)).blob();
      const file = new File([blob], "oddket-slip.png", { type: "image/png" });
      const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        await navigator.share({ text: slipTextFor(shareLegs, shareCombined), files: [file] });
      } else {
        await navigator.share({ text: slipTextFor(shareLegs, shareCombined) });
      }
    } catch {
      // user dismissed or share unsupported — fall back to Telegram + download
      await shareToTelegram();
    }
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Slip Builder</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            Ranked value opportunities with proven closing-line edge.
          </p>
        </div>
        <div className="flex items-center gap-2">            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
              showAll ? "border-amber-400/30 bg-amber-400/10 text-amber-300" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
            }`}>
            <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${showAll ? "bg-amber-400" : "bg-emerald-400"}`} />
            {showAll ? `${filteredSlips.length} Prediction${filteredSlips.length === 1 ? "" : "s"}` : `${filteredSlips.length} Value Pick${filteredSlips.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="order-last min-w-0 space-y-4 lg:order-first lg:col-span-2">
          {/* Filter Bar */}
          <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-2.5 space-y-2">
            {/* Search + league select + show-all toggle */}
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
                onClick={() => setShowAll(!showAll)}
                className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${
                  showAll
                    ? "border-amber-400/50 bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/20"
                    : "border-ink-700/60 bg-ink-800/80 text-slate-400 hover:border-ink-600 hover:text-slate-200"
                }`}
              >
                {showAll ? "🏷️ Picks" : "👁️ All"}
              </button>
            </div>
            {/* Time + strategy filter pills — scrollable on mobile */}
            <div className="flex items-center gap-2">
              <div className="scrollbar-none flex flex-1 gap-1 overflow-x-auto">
                {(
                  [
                    ["all", "All"],
                    ["today", "Today"],
                    ["tomorrow", "Tmrw"],
                    ["week", "Week"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTimeFilter(key)}
                    className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      timeFilter === key ? "bg-emerald-400 text-ink-950 shadow-sm" : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="shrink-0 text-[11px] text-slate-500">
                {filteredSlips.length}
              </span>
            </div>
          </div>

          {/* Quick Strategy Filters */}
          <div className="scrollbar-none flex gap-1.5 overflow-x-auto">
            {[
              ["all", "All", "bg-ink-800 text-slate-200 border-ink-600"],
              ["high_prob", "🟢 ≥60%", "bg-emerald-400/15 text-emerald-300 border-emerald-400/40"],
              ["big_edge", "💎 ≥7%", "bg-sky-400/15 text-sky-300 border-sky-400/40"],
              ["favorites", "⚽ ≤1.85", "bg-purple-400/15 text-purple-300 border-purple-400/40"],
            ].map(([key, label, activeStyle]) => (
              <button
                key={key}
                onClick={() => setStrategyFilter(key as any)}
                className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
                  strategyFilter === key
                    ? `${activeStyle} shadow-sm ring-1 ring-current/20`
                    : "border-ink-800 bg-ink-900/30 text-slate-400 hover:border-ink-700 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {showAll && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-700/40 bg-ink-800/30 px-3 py-2 text-[11px] text-slate-400">
              <span className="font-medium text-slate-300">Legend:</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Edge ≥ 7% (strong)</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-400" /> Edge 0–7% (moderate)</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400" /> Edge &lt; 0% (no edge)</span>
              <span className="text-slate-500">· All model probabilities shown — only flagged picks (green/sky) qualify for slips.</span>
            </div>
          )}

          {logError && (
            <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300">
              ⚠ {logError}
            </div>
          )}

          {filteredSlips.length === 0 ? (
            <EmptyState
              title={showAll ? "No predictions match your filters" : "No flagged singles in this view"}
              body={showAll ? "Try switching your filter or selecting another league." : "Try switching your filter or selecting another league — every pick must clear the edge threshold and stay inside the strategy odds band."}
            />
          ) : (
            <VirtualList
              items={groupedSlips}
              estimatedHeight={160}
              overscan={10}
              keyFn={(item) => item[0]}
              // min-h on desktop guarantees the left column always fills the
              // viewport, so the sticky multiple builder next to it has room
              // to scroll — with one slip the card used to get clipped.
              className="max-h-[calc(100vh-12rem)] lg:min-h-[calc(100vh-14rem)]"
              renderItem={([fixtureId, legs]) => {
                const first = legs[0]!;
                return (
                  <div className="mb-3 card overflow-hidden rounded-xl border border-ink-700/50 bg-ink-900/50 transition-all hover:border-ink-600/70">
                    <div className="flex flex-col gap-1 border-b border-ink-800/80 bg-ink-800/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:py-2.5">
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-semibold text-slate-100">
                          {first.fixture.homeTeam} <span className="text-slate-500 font-normal">vs</span> {first.fixture.awayTeam}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs font-medium text-slate-400">
                        {fmtDate(first.fixture.commenceTime)} · <span className="text-slate-500">{first.fixture.league}</span>
                      </span>
                    </div>
                    <div className="divide-y divide-ink-800/40">
                      {legs.map((leg) => {
                        const key = legKey(leg);
                        const checked = selected.has(key);
                        const isLogged = justLogged.has(key) || loggedKeys.has(key);
                        return (
                          <div
                            key={key}
                            role="button"
                            tabIndex={0}
                            onClick={() => toggle(key, leg.odds !== 0)}
                            onKeyDown={(e) => e.key === "Enter" && toggle(key, leg.odds !== 0)}
                            className={`group flex w-full flex-col gap-3 p-4 text-left transition-all sm:flex-row sm:items-center sm:justify-between sm:py-3.5 ${
                              leg.odds === 0 ? "cursor-default" : "cursor-pointer"
                            } ${
                              checked ? "bg-emerald-400/[0.04]" : "hover:bg-ink-800/30"
                            }`}
                          >
                            <div className="flex items-start gap-3 min-w-0 flex-1">
                              {multiplesOn && leg.odds !== 0 && (
                                <span
                                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold transition-colors ${
                                    checked ? "border-emerald-400 bg-emerald-400 text-ink-950" : "border-ink-600 bg-ink-800/60 text-transparent"
                                  }`}
                                >
                                  ✓
                                </span>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-bold text-slate-100">
                                    {marketLabel(leg.market, leg.selection)}
                                  </span>
                                  {leg.odds === 0 ? (
                                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold border bg-amber-400/15 text-amber-300 border-amber-400/30">
                                      📊 Model Only
                                    </span>
                                  ) : (
                                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold border ${
                                      leg.edge < 0 ? "bg-red-400/15 text-red-300 border-red-400/30" :
                                      leg.edge >= 0.07 ? "bg-emerald-400/15 text-emerald-300 border-emerald-400/30" : "bg-sky-400/15 text-sky-300 border-sky-400/30"
                                    }`}>
                                      {fmtSignedPct(leg.edge)} EV
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-slate-400">
                                  Win Prob: <span className="font-semibold text-slate-200">{fmtPct(leg.probability)}</span>
                                  <span className="text-slate-500"> ({fmtPct(leg.confidenceLow, 0)}–{fmtPct(leg.confidenceHigh, 0)} CI)</span>
                                </p>
                              </div>
                            </div>                            <div className="flex items-center justify-between sm:justify-end gap-2.5 pt-2.5 border-t border-ink-800/50 sm:border-0 sm:pt-0 shrink-0">
                              <div className="flex items-center gap-2">
                                {leg.odds === 0 ? (
                                  <span className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs font-bold text-amber-300">
                                    Check bookmaker
                                  </span>
                                ) : (
                                  <>
                                    <span className="rounded-lg border border-ink-700/60 bg-ink-800/80 px-2.5 py-1.5 text-xs font-bold text-slate-100">
                                      @{fmtOdds(leg.odds)}
                                    </span>
                                    <div className="relative">
                                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">₦</span>
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
                                        className="w-20 rounded-lg border border-ink-700/60 bg-ink-800/80 py-1.5 pl-6 pr-2 text-right text-xs font-semibold text-slate-100 focus:border-sky-400/50 focus:outline-none"
                                        title="Edit stake amount"
                                      />
                                    </div>
                                  </>
                                )}
                              </div>
                              {leg.odds !== 0 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleLogBet(leg);
                                  }}
                                  disabled={isLogged || loggingKeys.has(key)}
                                  className={`rounded-lg border px-4 py-1.5 text-xs font-semibold transition-all disabled:cursor-wait ${
                                    isLogged
                                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                                      : "border-sky-400/40 bg-sky-400/20 text-sky-200 hover:bg-sky-400/30 shadow-sm"
                                  }`}>
                                  {loggingKeys.has(key) ? "Logging…" : isLogged ? "✓ Logged" : "Log Bet"}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }}
            />
          )}
        </div>

        {/* Multiple panel — on mobile this appears FIRST (order-first) so
            users see parlays without scrolling through all predictions.
            On desktop it stays in the right column. */}
        <div className="order-first min-w-0 lg:order-last lg:col-span-1">
          {/* Mobile accordion header — collapsed by default, expanded on lg+ */}
          <button
            type="button"
            onClick={() => setMultiplesOpen((v) => !v)}
            aria-expanded={multiplesOpen}
            className="mb-3 flex w-full items-center justify-between gap-2 rounded-xl border border-ink-700/60 bg-ink-900/60 px-4 py-3 text-left transition-colors lg:hidden"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="text-base">🎯</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-100">Multiple builder</span>
                <span className="block truncate text-[10px] text-slate-500">
                  {multiplesOn
                    ? selectedLegs.length > 0
                      ? `${selectedLegs.length} leg${selectedLegs.length > 1 ? "s" : ""} selected`
                      : "Suggestions & manual combos — tap to open"
                    : "Disabled — enable in Settings → Multiples"}
                </span>
              </span>
            </span>
            <span className={`flex shrink-0 items-center gap-1.5 text-slate-400 transition-transform ${multiplesOpen ? "rotate-180" : ""}`}>
              {selectedLegs.length > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-400/15 px-1.5 text-[10px] font-bold text-emerald-300">
                  {selectedLegs.length}
                </span>
              )}
              <span className="text-sm">▾</span>
            </span>
          </button>

          <div className={`${multiplesOpen ? "block" : "hidden"} lg:block`}>
          <div className="hidden lg:block">
            <SectionTitle sub="Opt-in only — the true math always shown">Multiple builder</SectionTitle>
          </div>
          <Card className="card-pad lg:sticky lg:top-20">
            {!multiplesOn ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">
                  Multiples are <span className="font-semibold text-amber-300">disabled</span> — the singles must prove
                  their edge first (100+ logged bets, positive CLV vs. the closing line, CI not straddling zero).
                </p>
                <p className="text-xs text-slate-600">
                  When the validation checklist is cleared, flip it on in{" "}
                  <span className="font-semibold text-slate-400">Settings → Multiples</span> and the builder appears here.
                </p>
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
                  Multiples are not lower-risk than singles — they raise variance by construction. Max 3 legs, every leg
                  must clear the single-bet EV threshold on its own.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {parlayError && (
                  <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300">
                    ⚠ {parlayError}
                  </div>
                )}

                {/* Auto-suggest: risk-tiered, independent-legs-only groupings,
                    built from the HIGHEST-probability flagged singles (never
                    EV-chasing longshots). Selection stays manual — these are
                    candidates, not auto-bets. */}
                {suggestions.length > 0 && (
                  <div>
                    <p className="label mb-2">
                      Suggested parlays <span className="font-normal text-slate-600">· highest-probability legs, ranked by chance of landing</span>
                    </p>
                    <ul className="space-y-2">
                      {suggestions.map((s) => {
                        const key = parlayKey(s);
                        const done = loggedParlays.has(key);
                        const tierStyle =
                          s.tier === "safe"
                            ? { border: "border-emerald-400/40", chip: "bg-emerald-400/15 text-emerald-300 border-emerald-400/40", prob: "text-emerald-300" }
                            : s.tier === "balanced"
                              ? { border: "border-sky-400/40", chip: "bg-sky-400/15 text-sky-300 border-sky-400/40", prob: "text-sky-300" }
                              : { border: "border-rose-400/40", chip: "bg-rose-400/15 text-rose-300 border-rose-400/40", prob: "text-rose-300" };
                        return (
                          <li key={key} className={`rounded-lg border bg-ink-800/40 p-3 ${tierStyle.border}`}>
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${tierStyle.chip}`}>
                                {s.tier === "safe" ? "🟢" : s.tier === "balanced" ? "🟡" : "🔴"} {s.tierLabel}
                              </span>
                              <span className="text-[10px] text-slate-500">{s.legs.length} legs</span>
                            </div>
                            <div className="mb-2 space-y-1">
                              {s.legs.map((l) => (
                                <p key={legKey(l)} className="truncate text-xs text-slate-400">
                                  <span className="text-slate-300">{l.fixture.homeTeam} vs {l.fixture.awayTeam}</span> —{" "}
                                  {marketLabel(l.market, l.selection)} @ <span className="num text-slate-300">{fmtOdds(l.odds)}</span>
                                </p>
                              ))}
                            </div>
                            <div className="mb-2 grid grid-cols-3 gap-1 text-[11px]">
                              <div>
                                <p className="text-slate-600">Combined odds</p>
                                <p className="num font-semibold text-slate-200">{s.combinedOdds.toFixed(2)}x</p>
                              </div>
                              <div>
                                <p className="text-slate-600">Chance to land</p>
                                <p className={`num font-semibold ${tierStyle.prob}`}>{fmtPct(s.combinedProbability)}</p>
                              </div>
                              <div>
                                <p className="text-slate-600">EV</p>
                                <p className={`num font-semibold ${edgeClass(s.ev)}`}>{fmtSignedPct(s.ev)}</p>
                              </div>
                            </div>
                            {s.warnings.map((w, i) => (
                              <p key={i} className="mb-2 rounded border border-amber-400/30 bg-amber-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
                                ⚠ {w}
                              </p>
                            ))}
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                              <button
                                onClick={() => void handleLogParlay(s)}
                                disabled={done || loggingParlay === key}
                                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-wait ${
                                  done
                                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                                    : "border-emerald-400/40 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
                                }`}
                              >
                                {loggingParlay === key ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-300/40 border-t-emerald-300" />
                                    Logging…
                                  </span>
                                ) : done ? (
                                  "✓ Parlay logged"
                                ) : (
                                  `Log parlay · ₦${fmtMoney(Math.max(MIN_STAKE, Math.round(s.stake)), 0)}`
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void openShare(s.legs, {
                                    odds: s.combinedOdds,
                                    probability: s.combinedProbability,
                                    fairOdds: s.fairOdds,
                                  })
                                }
                                disabled={shareState.status === "generating"}
                                title="Render this ticket as an image to save or send"
                                className="rounded-lg border border-ink-600 bg-ink-800/60 px-3 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:border-ink-500 hover:text-slate-100 disabled:cursor-wait"
                              >
                                📤 Share
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/* Model-only accumulators — probability only, never EV-checked.
                    Kept visually separate from the priced suggestions above so a
                    no-odds ticket can never be mistaken for a flagged slip. */}
                {modelOnlySuggestions.length > 0 && (
                  <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.04] p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <p className="text-xs font-semibold text-slate-200">Model-only accumulators</p>
                      <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                        ⚠ NOT EV-CHECKED
                      </span>
                    </div>
                    <p className="mb-3 text-[11px] leading-relaxed text-amber-200/70">
                      These markets have a model probability but{" "}
                      <span className="font-semibold">no bookmaker price</span> in the feed, so there is no edge to
                      compute — no multiplier, no EV, no stake. The combined chance is real; the{" "}
                      <span className="font-semibold">break-even odds</span> is the price your bookmaker must beat for
                      the ticket to be worth placing. Check every line yourself.
                    </p>
                    <ul className="space-y-2">
                      {modelOnlySuggestions.map((s) => (
                        <li key={parlayKey(s)} className="rounded-lg border border-ink-700/60 bg-ink-800/40 p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="inline-flex items-center rounded-full border border-ink-600 bg-ink-800/60 px-2 py-0.5 text-[10px] font-bold text-slate-300">
                              {s.tier === "safe" ? "🟢" : s.tier === "balanced" ? "🟡" : "🔴"}{" "}
                              {s.tierLabel.replace(/ \(option \d+\)$/, "")}
                            </span>
                            <span className="text-[10px] text-slate-500">{s.legs.length} legs</span>
                          </div>
                          <div className="mb-2 space-y-1">
                            {s.legs.map((l) => (
                              <p key={legKey(l)} className="truncate text-xs text-slate-400">
                                <span className="text-slate-300">
                                  {l.fixture.homeTeam} vs {l.fixture.awayTeam}
                                </span>{" "}
                                — {marketLabel(l.market, l.selection)}{" "}
                                <span className="num text-slate-300">{fmtPct(l.probability)}</span>
                                <span className="text-slate-600"> · check bookmaker</span>
                              </p>
                            ))}
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-[11px]">
                            <div>
                              <p className="text-slate-600">True chance</p>
                              <p className="num font-semibold text-amber-200">{fmtPct(s.combinedProbability)}</p>
                            </div>
                            <div>
                              <p className="text-slate-600">Break-even odds</p>
                              <p className="num font-semibold text-slate-200">{s.fairOdds.toFixed(2)}x</p>
                            </div>
                          </div>
                          {s.warnings.map((w, i) => (
                            <p
                              key={i}
                              className="mt-2 rounded border border-amber-400/30 bg-amber-400/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-amber-200/80"
                            >
                              ⚠ {w}
                            </p>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Manual builder */}
                {selectedLegs.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Select <span className="font-semibold text-emerald-400">2+ singles</span> to combine manually — or log a
                    suggested parlay above. Singles are always the default.
                  </p>
                ) : (
              <div className="space-y-4">
                {capNotice && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/80">
                    ⚠ {capNotice}
                  </div>
                )}
                <div>
                  <p className="label mb-2">
                    Selected legs ({selectedLegs.length}/{MAX_LEGS})
                  </p>
                  <ul className="space-y-1.5">
                    {selectedLegs.map((l) => (
                      <li key={legKey(l)} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-slate-400">
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

                {/* Share: image + Telegram + native sheet */}
                <button
                  className="btn-ghost w-full"
                  onClick={() => void openShare()}
                  disabled={shareState.status === "generating" || shareState.status === "sending"}
                >
                  {shareState.status === "generating"
                    ? "Rendering image…"
                    : shareState.status === "sending"
                      ? "Sending to Telegram…"
                      : "📤 Share slip"}
                </button>
                {shareState.status === "ready" || shareState.status === "sent" ? (
                  <div ref={sharePanelRef} className="space-y-2 rounded-lg border border-ink-700/60 bg-ink-800/40 p-3">
                    {shareState.imageUrl && (
                      <img
                        src={shareState.imageUrl}
                        alt="OddKet slip preview"
                        className="max-h-48 w-full rounded-lg border border-ink-700/50 object-contain"
                      />
                    )}
                    {shareState.status === "sent" && (
                      <p className="rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1.5 text-[11px] font-medium text-emerald-300">
                        ✓ Sent to your Telegram
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      <button className="btn-ghost px-2 py-1.5 text-[11px]" onClick={downloadSlipImage}>
                        💾 Save
                      </button>
                      <button className="btn-ghost px-2 py-1.5 text-[11px]" onClick={() => void shareToTelegram()}>
                        ✈️ Telegram
                      </button>
                      <button className="btn-ghost px-2 py-1.5 text-[11px]" onClick={() => void nativeShare()}>
                        📤 Share…
                      </button>
                    </div>
                    <button
                      className="w-full text-center text-[10px] text-slate-500 hover:text-slate-300"
                      onClick={() => setShareState({ status: "idle" })}
                    >
                      Close
                    </button>
                  </div>
                ) : shareState.status === "error" ? (
                  <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-2 text-[11px] font-medium text-red-300">
                    ⚠ {shareState.error}
                  </p>
                ) : null}

                <button className="btn-ghost w-full" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
                <p className="text-center text-[11px] text-slate-600">
                  Output is a text slip for manual entry. No bets are placed by OddKet.
                </p>
              </div>
                )}
              </div>
            )}
          </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function legKey(l: SlipLeg): string {
  return `${l.fixture.id}:${l.market}:${l.selection}`;
}

/** Stable id for a suggestion = sorted leg keys, so the same combo dedupes. */
function parlayKey(s: ParlaySuggestion): string {
  return s.legs.map(legKey).sort().join("+");
}
