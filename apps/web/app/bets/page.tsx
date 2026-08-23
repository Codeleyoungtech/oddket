"use client";

import React, { useMemo, useState } from "react";
import { marketLabel, type Parlay, type Selection } from "@oddket/core";
import { useData } from "../../lib/data-provider";


// Bets logged in the last 24h can be undone (mistaken logs). Older rows are
// kept immutable — undoing settled/CLV-scored history would corrupt the scoreboard.
const UNDO_WINDOW_SEC = 24 * 3600;
import { Badge, Card, EmptyState, Loading, SectionTitle } from "../../components/ui";
import { clvClass, fmtDate, fmtMoney, fmtOdds, fmtPct, fmtSignedPct, pnlClass } from "../../lib/format";

/** Format a unix timestamp into kickoff info with EDT (UTC-4) and WAT (UTC+1).
 *  Pass fixture status + scores for finished/in-play matches. */
function formatKickoff(
  ts: number,
  status?: string,
  homeScore?: number,
  awayScore?: number,
): { day: string; date: string; edt: string; wat: string; countdown: string; tag: string; tagColor: string } {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = Math.round(diffMs / 3600000);
  const diffD = Math.round(diffMs / 86400000);

  const fmt = (offs: number) => {
    const local = new Date(d.getTime() + offs * 3600000);
    const hh = String(local.getUTCHours()).padStart(2, "0");
    const mm = String(local.getUTCMinutes()).padStart(2, "0");
    const ampm = local.getUTCHours() >= 12 ? "PM" : "AM";
    const h12 = local.getUTCHours() % 12 || 12;
    return `${h12}:${mm} ${ampm}`;
  };

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let countdown: string;
  let tag: string;
  let tagColor: string;

  if (status === "finished" && homeScore != null && awayScore != null) {
    countdown = `${homeScore} - ${awayScore} (FT)`;
    tag = "Final";
    tagColor = "text-slate-400 bg-slate-400/10 border-slate-400/20";
  } else if (status === "finished") {
    // Finished but scores not recorded yet
    countdown = "FT (score pending)";
    tag = "Final";
    tagColor = "text-slate-400 bg-slate-400/10 border-slate-400/20";
  } else if (diffH < -2) {
    // Match started 2+ hours ago but no score recorded yet
    countdown = "in play";
    tag = "Live";
    tagColor = "text-red-400 bg-red-400/10 border-red-400/20";
  } else if (diffH < 0) {
    countdown = "kicked off";
    tag = "Started";
    tagColor = "text-amber-300 bg-amber-400/10 border-amber-400/20";
  } else if (diffH < 1) {
    countdown = "kicks off within the hour";
    tag = "Soon";
    tagColor = "text-amber-300 bg-amber-400/10 border-amber-400/20";
  } else if (diffH < 24) {
    countdown = `kicks off in ${diffH}h`;
    tag = "Today";
    tagColor = "text-amber-300 bg-amber-400/10 border-amber-400/20";
  } else {
    countdown = `kicks off in ${diffD} day${diffD !== 1 ? "s" : ""}`;
    tag = "Upcoming";
    tagColor = "text-sky-300 bg-sky-400/10 border-sky-400/20";
  }

  return {
    day: dayNames[d.getUTCDay()],
    date: `${d.getUTCDate()} ${monthNames[d.getUTCMonth()]}`,
    edt: fmt(-4),
    wat: fmt(1),
    countdown,
    tag,
    tagColor,
  };
}

export default function BetsPage() {
  const { bets, db, sport, logBet, deleteBet, recordOutcome, recordTennisOutcome, refresh } = useData();
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "won" | "lost" | "pending">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [showLogger, setShowLogger] = useState(false);
  const [settleScores, setSettleScores] = useState<Record<string, { home: string; away: string }>>({});
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [undoingIds, setUndoingIds] = useState<Set<string>>(new Set());

  const handleAutoSettle = async () => {
    setSyncingCloud(true);
    try {
      await fetch("/api/settle", {
        method: "POST",
        headers: { "x-predict-key": "ok_783eededb840c83e014dc173bcb0fcba78431c953ea5b2bb" },
      }).catch(() => null);
      refresh();
    } finally {
      setSyncingCloud(false);
    }
  };

  const handleQuickSettle = async (fixtureId: string, isTennis: boolean) => {
    const s = settleScores[fixtureId] || { home: "0", away: "0" };
    const homeScore = parseInt(s.home, 10);
    const awayScore = parseInt(s.away, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) return;
    setSettlingId(fixtureId);
    try {
      if (isTennis) {
        await recordTennisOutcome(fixtureId, homeScore > awayScore ? "home" : "away");
      } else {
        await recordOutcome(fixtureId, homeScore, awayScore);
      }
      refresh();
    } finally {
      setSettlingId(null);
    }
  };

  // --- paper-trade log form state ---
  const [formFixture, setFormFixture] = useState("");
  const [formMarket, setFormMarket] = useState<"h2h" | "totals">("h2h");
  const [formSelection, setFormSelection] = useState<Selection>("home");
  const [formOdds, setFormOdds] = useState("");
  const [formStake, setFormStake] = useState("");
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fixtureSearch, setFixtureSearch] = useState("");

  const bettableFixtures = useMemo(() => {
    if (!db) return [];
    const scheduled = db.fixtures.filter((f) => f.status === "scheduled");
    const live = scheduled.filter((f) => (sport === "tennis" ? f.sport === "tennis" : f.sport !== "tennis"));
    const pool = live.length > 0 ? live : scheduled;
    const predicted = new Set(db.predictions.map((p) => p.fixtureId));
    const filtered = pool.filter((f) => predicted.has(f.id));
    if (!fixtureSearch.trim()) return filtered;
    const q = fixtureSearch.toLowerCase();
    return filtered.filter((f) => 
      f.homeTeam.toLowerCase().includes(q) || 
      f.awayTeam.toLowerCase().includes(q) || 
      (f.league && f.league.toLowerCase().includes(q))
    );
  }, [db, sport, fixtureSearch]);

  const bestOddsFor = (fixtureId: string, market: "h2h" | "totals", selection: string): number | null => {
    if (!db) return null;
    const snaps = db.odds.filter((o) => o.fixtureId === fixtureId && o.market === market && o.selection === selection);
    const best = Math.max(...snaps.map((o) => o.odds), 0);
    return best > 0 ? best : null;
  };

  const pickFixture = (id: string) => {
    setFormFixture(id);
    const initialMarket = "h2h";
    const initialSel: Selection = "home";
    setFormMarket(initialMarket);
    setFormSelection(initialSel);
    const best = bestOddsFor(id, initialMarket, initialSel);
    setFormOdds(best ? String(best) : "");
  };

  const updateMarketAndSelection = (m: "h2h" | "totals", sel: Selection) => {
    setFormMarket(m);
    setFormSelection(sel);
    const best = bestOddsFor(formFixture, m, sel);
    if (best) setFormOdds(String(best));
  };

  const undoBet = async (b: { id: string; status: string }) => {
    if (b.status !== "pending") {
      setUndoMsg("Only pending bets can be undone — settled bets are locked to keep the scoreboard honest.");
      return;
    }
    // Optimistic: mark as undoing so the UI hides it instantly.
    setUndoingIds((prev) => new Set(prev).add(b.id));
    setUndoMsg("Bet removed from your log.");
    try {
      // Use the data provider's deleteBet — handles both live (API) and demo (local).
      await deleteBet(b.id);
    } catch {
      // Delete failed — show it again
      setUndoingIds((prev) => {
        const next = new Set(prev);
        next.delete(b.id);
        return next;
      });
      setUndoMsg("Failed to remove bet — it may have already been settled.");
    }
  };

  const submitBet = async (e: React.FormEvent) => {
    e.preventDefault();
    const odds = parseFloat(formOdds);
    const stake = parseFloat(formStake);
    if (!formFixture || !odds || odds <= 1 || !stake || stake <= 0) {
      setFormMsg("Pick a fixture, selection, odds (>1) and stake.");
      return;
    }
    if (stake < 10) {
      setFormMsg("Minimum stake is ₦10 (bookmaker minimum).");
      return;
    }
    const maxStake = (db?.settings.bankroll ?? 1000) * (db?.settings.defaultStakeCapPct ?? 0.05);
    if (stake > maxStake) {
      setFormMsg(`Stake exceeds the ₦${maxStake.toFixed(0)} cap (5% of bankroll). Increase bankroll in Settings to bet more.`);
      return;
    }
    const fixture = db?.fixtures.find((f) => f.id === formFixture);
    const pred = db?.predictions.find(
      (p) => p.fixtureId === formFixture && p.market === formMarket && p.selection === formSelection,
    );
    setSubmitting(true);
    try {
      await logBet({
        fixtureId: formFixture,
        market: formMarket,
        selection: formSelection,
        odds,
        stake,
        edge: pred ? pred.probability - 1 / odds : 0,
        modelProbability: pred?.probability ?? 0,
        placedAt: Math.floor(Date.now() / 1000),
      });
      setFormMsg(`✓ Logged: ${fixture?.homeTeam ?? ""} vs ${fixture?.awayTeam ?? ""} — ${marketLabel(formMarket, formSelection)} @ ${odds} (₦${stake})`);
      setFormOdds("");
      setFormStake("");
      setShowLogger(false);
    } catch (err) {
      setFormMsg(err instanceof Error ? err.message : "Couldn't log the bet — please try again.");
    } finally {
      setSubmitting(false);
      refresh();
    }
  };

  const filtered = useMemo(() => {
    let list = bets.filter((b) => !undoingIds.has(b.id));
    if (statusFilter !== "all") {
      list = list.filter((b) => b.status === statusFilter);
    }
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      list = list.filter((b) => 
        (b.fixture?.homeTeam?.toLowerCase().includes(q)) ||
        (b.fixture?.awayTeam?.toLowerCase().includes(q)) ||
        (b.fixture?.league?.toLowerCase().includes(q)) ||
        b.selection.toLowerCase().includes(q)
      );
    }
    return list;
  }, [bets, statusFilter, searchFilter, undoingIds]);

  const totals = useMemo(() => {
    // Model-flagged bets only for the summary stats.
    const modelBets = bets.filter((b) => (b.source ?? "model") === "model");
    const settled = modelBets.filter((b) => b.status === "won" || b.status === "lost");
    const staked = settled.reduce((a, b) => a + b.stake, 0);
    const ret = settled.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
    const withClv = settled.filter((b) => b.clv !== undefined);
    const cumClv = withClv.reduce((a, b) => a + (b.clv ?? 0), 0);
    // Manual bets count for reference.
    const manualSettled = bets.filter((b) => b.source === "manual" && (b.status === "won" || b.status === "lost"));
    return { n: settled.length, staked, ret, cumClv, nClv: withClv.length, manualN: manualSettled.length };
  }, [bets]);

  if (!db) return <Loading />;
  const pnlTotal = totals.ret - totals.staked;

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Bet Log & History</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            Real paper-trade records scored against closing line value (CLV).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoSettle}
            disabled={syncingCloud}
            className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-400/20 transition-all disabled:opacity-50"
          >
            {syncingCloud ? "Syncing…" : "🔄 Auto-Settle All"}
          </button>
          <button
            onClick={() => setShowLogger((v) => !v)}
            className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-400/20 transition-all"
          >
            {showLogger ? "✕ Close Logger" : "＋ Log Custom Bet"}
          </button>
        </div>
      </div>

      {/* KPI Stat Cards — model-flagged bets only */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Model Settled</p>
          <p className="mt-1 text-lg font-bold text-slate-100">{totals.n}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">{totals.manualN} manual · {bets.filter((b) => b.status === "pending").length} pending</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Total Staked</p>
          <p className="mt-1 text-lg font-bold text-slate-100">₦{fmtMoney(totals.staked, 0)}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">model bets only</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Net Profit / Loss</p>
          <p className={`mt-1 text-lg font-bold ${pnlTotal >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {pnlTotal >= 0 ? "+" : ""}₦{fmtMoney(pnlTotal, 0)}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">model bets only</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Cumulative CLV</p>
          <p className={`mt-1 text-lg font-bold ${clvClass(totals.cumClv)}`}>
            {fmtSignedPct(totals.cumClv, 2)}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">over {totals.nClv} scored lines</p>
        </div>
      </div>

      {/* Collapsible Manual Logger */}
      {showLogger && (
        <div className="rounded-xl border border-sky-400/30 bg-ink-900/70 p-4 space-y-3 shadow-lg">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">Manual Bet Logger</h2>
            <span className="text-[11px] text-slate-400">Auto-settles at match full-time</span>
          </div>

          <div className="space-y-2.5">
            <input
              type="text"
              placeholder="Search fixture (e.g. Arsenal, Juventus, Real)..."
              value={fixtureSearch}
              onChange={(e) => setFixtureSearch(e.target.value)}
              className="w-full rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
            />

            <form onSubmit={submitBet} className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
              <select
                value={formFixture}
                onChange={(e) => pickFixture(e.target.value)}
                className="rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-medium text-slate-200 focus:border-sky-400/50 focus:outline-none lg:col-span-2"
              >
                <option value="">Select a scheduled fixture…</option>
                {bettableFixtures.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.homeTeam} vs {f.awayTeam} ({f.league})
                  </option>
                ))}
              </select>

              <select
                value={`${formMarket}:${formSelection}`}
                onChange={(e) => {
                  const [m, sel] = e.target.value.split(":") as ["h2h" | "totals", Selection];
                  updateMarketAndSelection(m, sel);
                }}
                className="rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-medium text-slate-200 focus:border-sky-400/50 focus:outline-none"
              >
                <optgroup label="Match Result (H2H)">
                  <option value="h2h:home">Home Win</option>
                  {sport !== "tennis" && <option value="h2h:draw">Draw</option>}
                  <option value="h2h:away">Away Win</option>
                </optgroup>
                {sport !== "tennis" && (
                  <optgroup label="Totals (Over/Under 2.5)">
                    <option value="totals:over">Over 2.5 Goals</option>
                    <option value="totals:under">Under 2.5 Goals</option>
                  </optgroup>
                )}
              </select>

              <input
                type="number"
                step="0.01"
                min="1.01"
                placeholder="Odds (e.g. 1.85)"
                value={formOdds}
                onChange={(e) => setFormOdds(e.target.value)}
                className="rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
              />

              <div className="flex gap-2">
                <input
                  type="number"
                  step="1"
                  min="10"
                  placeholder="Stake (₦)"
                  value={formStake}
                  onChange={(e) => setFormStake(e.target.value)}
                  className="w-full rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg border border-sky-400/40 bg-sky-400/20 px-4 py-2 text-xs font-bold text-sky-200 hover:bg-sky-400/30 transition-all shrink-0"
                >
                  {submitting ? "..." : "Log"}
                </button>
              </div>
            </form>
          </div>

          {formMsg && <p className="text-xs text-emerald-300">{formMsg}</p>}
        </div>
      )}

      {undoMsg && <p className="text-xs text-slate-400">ℹ {undoMsg}</p>}

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-ink-700/60 bg-ink-900/40 p-0.5">
          {(["all", "won", "lost", "pending"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition-all ${
                statusFilter === s
                  ? "bg-emerald-400 text-ink-950 shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="relative min-w-[200px] flex-1 max-w-xs">
          <input
            type="text"
            placeholder="Search logged bets..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="w-full rounded-lg border border-ink-700/60 bg-ink-900/40 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
          />
          {searchFilter && (
            <button
              onClick={() => setSearchFilter("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-200"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No bets match this filter"
          body="Use the Slips page to log recommended bets or use the Manual Logger above."
        />
      ) : (
        <div className="space-y-3">
          {/* Mobile Feed View (Cards) */}
          <div className="space-y-3 sm:hidden">
            {filtered.map((b) => {
              const isExpanded = expandedId === b.id;
              const potentialReturn = b.odds * b.stake;
              return (
                <div
                  key={b.id}
                  className="rounded-xl border border-ink-700/50 bg-ink-900/50 p-4 transition-all hover:border-ink-600/70"
                >
                  <div className="flex items-center justify-between border-b border-ink-800/80 pb-2.5">
                    <span className="text-[11px] text-slate-400">{fmtDate(b.placedAt)}</span>
                    <div className="flex items-center gap-2">
                      <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "sky"}>
                        {b.status}
                      </Badge>
                      <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                        (b.source ?? "model") === "manual"
                          ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                          : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                      }`}>
                        {(b.source ?? "model") === "manual" ? "✋ Manual" : "🤖 Model"}
                      </span>
                      {b.status === "pending" && b.placedAt > Date.now() / 1000 - UNDO_WINDOW_SEC && (
                        <button
                          onClick={() => void undoBet(b)}
                          className="rounded border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold text-red-300"
                        >
                          Undo
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-2.5">
                    <p className="text-sm font-semibold text-slate-100">
                      {b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId}
                    </p>
                    <p className="text-xs text-slate-500">{b.fixture?.league}</p>
                    {b.fixture?.commenceTime && (() => {
                      const ko = formatKickoff(b.fixture.commenceTime, b.fixture.status, b.fixture.homeScore, b.fixture.awayScore);
                      return (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                          <span className={`rounded border px-1.5 py-0.5 font-semibold ${ko.tagColor}`}>
                            {ko.tag === "Final" ? "🏁" : ko.tag === "Live" ? "🔴" : "⏰"} {ko.day} {ko.date}
                          </span>
                          <span className="text-slate-400">{ko.edt} EDT</span>
                          <span className="text-slate-600">·</span>
                          <span className="text-slate-400">{ko.wat} WAT</span>
                          <span className={`ml-auto text-[10px] italic ${ko.tag === "Final" ? "text-slate-500" : ko.tag === "Live" ? "text-red-400" : "text-slate-500"}`}>{ko.countdown}</span>
                        </div>
                      );
                    })()}
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md border border-ink-700/60 bg-ink-800/80 px-2 py-0.5 text-xs font-semibold text-slate-200">
                        {marketLabel(b.market, b.selection)}
                      </span>
                      <span className="text-xs font-bold text-slate-100">@{fmtOdds(b.odds)}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-medium text-slate-300">₦{fmtMoney(b.stake, 0)}</p>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-ink-800/60 bg-ink-800/30 p-2 text-center text-xs">
                    <div>
                      <p className="text-[10px] text-slate-400">Edge</p>
                      <p className={`font-semibold ${b.edge > 0 ? "text-emerald-400" : "text-slate-400"}`}>
                        {fmtSignedPct(b.edge)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400">CLV</p>
                      <p className={`font-bold ${clvClass(b.clv)}`}>
                        {b.clv !== undefined ? fmtSignedPct(b.clv, 2) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400">P&L</p>
                      <p className={`font-bold ${pnlClass(b.outcomeAmount)}`}>
                        {b.outcomeAmount !== undefined
                          ? `${b.outcomeAmount > 0 ? "+" : ""}₦${fmtMoney(b.outcomeAmount, 0)}`
                          : "pending"}
                      </p>
                    </div>
                  </div>

                  {/* Expandable Details Button */}
                  <button
                    onClick={() => toggleExpand(b.id)}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink-800 bg-ink-800/40 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    <span>{isExpanded ? "Hide Details" : "View Details & Insights"}</span>
                    <span className="text-[10px]">{isExpanded ? "▲" : "▼"}</span>
                  </button>

                  {/* Expanded Insight Drawer */}
                  {isExpanded && (
                    <div className="mt-2 space-y-2 rounded-lg border border-ink-800 bg-ink-950/60 p-3 text-xs">
                      {b.fixture?.commenceTime && (() => {
                        const ko = formatKickoff(b.fixture.commenceTime);
                        return (
                          <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="text-amber-300 font-bold">⚽ Kickoff</span>
                              <span className={`text-[10px] italic ${ko.tag === "Final" ? "text-slate-400" : ko.tag === "Live" ? "text-red-400" : "text-amber-400/70"}`}>{ko.countdown}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-slate-400">Day</span>
                                <span className="font-semibold text-slate-200">{ko.day}, {ko.date}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">UTC</span>
                                <span className="font-semibold text-slate-200">{new Date(b.fixture.commenceTime * 1000).toUTCString().slice(17, 22)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">EDT</span>
                                <span className="font-semibold text-sky-300">{ko.edt}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-400">WAT</span>
                                <span className="font-semibold text-sky-300">{ko.wat}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                      <div className="flex justify-between border-b border-ink-800/60 pb-1.5">
                        <span className="text-slate-400">Model Probability</span>
                        <span className="font-semibold text-slate-200">{fmtPct(b.modelProbability)}</span>
                      </div>
                      <div className="flex justify-between border-b border-ink-800/60 pb-1.5">
                        <span className="text-slate-400">Implied Bookie Prob</span>
                        <span className="font-semibold text-slate-200">{fmtPct(1 / b.odds)}</span>
                      </div>
                      <div className="flex justify-between border-b border-ink-800/60 pb-1.5">
                        <span className="text-slate-400">Potential Payout</span>
                        <span className="font-semibold text-emerald-300">₦{fmtMoney(potentialReturn, 0)}</span>
                      </div>
                      {b.clv !== undefined && (
                        <div className="flex justify-between border-b border-ink-800/60 pb-1.5">
                          <span className="text-slate-400">Closing Line Edge</span>
                          <span className={`font-bold ${clvClass(b.clv)}`}>{fmtSignedPct(b.clv, 2)}</span>
                        </div>
                      )}
                      {b.status === "pending" && (
                        <div className="mt-3 border-t border-ink-800/80 pt-2.5">
                          <p className="text-[11px] font-semibold text-slate-300 mb-1.5">Manual Score Settlement</p>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min="0"
                              max="20"
                              placeholder="Home"
                              value={settleScores[b.fixtureId]?.home || ""}
                              onChange={(e) =>
                                setSettleScores((prev) => ({
                                  ...prev,
                                  [b.fixtureId]: { ...prev[b.fixtureId], home: e.target.value, away: prev[b.fixtureId]?.away || "0" },
                                }))
                              }
                              className="w-14 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-center text-xs font-bold text-slate-100 focus:outline-none"
                            />
                            <span className="text-xs font-bold text-slate-500">-</span>
                            <input
                              type="number"
                              min="0"
                              max="20"
                              placeholder="Away"
                              value={settleScores[b.fixtureId]?.away || ""}
                              onChange={(e) =>
                                setSettleScores((prev) => ({
                                  ...prev,
                                  [b.fixtureId]: { ...prev[b.fixtureId], home: prev[b.fixtureId]?.home || "0", away: e.target.value },
                                }))
                              }
                              className="w-14 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-center text-xs font-bold text-slate-100 focus:outline-none"
                            />
                            <button
                              onClick={() => handleQuickSettle(b.fixtureId, b.fixture?.sport === "tennis")}
                              disabled={settlingId === b.fixtureId}
                              className="rounded-lg border border-sky-400/40 bg-sky-400/20 px-3 py-1 text-xs font-bold text-sky-200 hover:bg-sky-400/30 transition-all disabled:opacity-50"
                            >
                              {settlingId === b.fixtureId ? "Settling…" : "⚡ Settle"}
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="flex justify-between pt-0.5">
                        <span className="text-slate-500">Fixture ID</span>
                        <span className="font-mono text-[10px] text-slate-500 truncate max-w-[150px]">{b.fixtureId}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop Table View */}
          <div className="hidden sm:block card overflow-hidden rounded-xl border border-ink-700/50 bg-ink-900/50">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-ink-800/80 bg-ink-800/40 text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="px-4 py-3 font-semibold">Placed</th>
                    <th className="px-4 py-3 font-semibold">Fixture</th>
                    <th className="px-4 py-3 font-semibold">Pick</th>
                    <th className="px-4 py-3 text-right font-semibold">Odds</th>
                    <th className="px-4 py-3 text-right font-semibold">Stake</th>
                    <th className="px-4 py-3 text-right font-semibold">Edge</th>
                    <th className="px-4 py-3 text-right font-semibold">CLV</th>
                    <th className="px-4 py-3 text-right font-semibold">P&L</th>
                    <th className="px-4 py-3 text-right font-semibold">Status</th>
                    <th className="px-4 py-3 text-center font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-800/40">
                  {filtered.map((b) => {
                    const isExpanded = expandedId === b.id;
                    const potentialReturn = b.odds * b.stake;
                    return (
                      <React.Fragment key={b.id}>
                        <tr className={`transition-colors hover:bg-ink-800/30 ${isExpanded ? "bg-ink-800/20" : ""}`}>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">{fmtDate(b.placedAt)}</td>
                          <td className="px-4 py-3">
                            <p className="text-xs font-semibold text-slate-100">
                              {b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId}
                            </p>
                            <p className="text-[11px] text-slate-500">{b.fixture?.league}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex rounded px-2 py-0.5 text-xs font-semibold bg-ink-800 text-slate-200 border border-ink-700/60">
                              {marketLabel(b.market, b.selection)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-xs font-bold text-slate-200">@{fmtOdds(b.odds)}</td>
                          <td className="px-4 py-3 text-right text-xs font-medium text-slate-300">₦{fmtMoney(b.stake, 0)}</td>
                          <td className={`px-4 py-3 text-right text-xs font-semibold ${b.edge > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                            {fmtSignedPct(b.edge)}
                          </td>
                          <td className={`px-4 py-3 text-right text-xs font-bold ${clvClass(b.clv)}`}>
                            {b.clv !== undefined ? fmtSignedPct(b.clv, 2) : <span className="text-slate-600">—</span>}
                          </td>
                          <td className={`px-4 py-3 text-right text-xs font-bold ${pnlClass(b.outcomeAmount)}`}>
                            {b.outcomeAmount !== undefined ? `${b.outcomeAmount > 0 ? "+" : ""}₦${fmtMoney(b.outcomeAmount, 0)}` : <span className="text-slate-500 font-normal">pending</span>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                                (b.source ?? "model") === "manual"
                                  ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                                  : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                              }`}>
                                {(b.source ?? "model") === "manual" ? "✋" : "🤖"}
                              </span>
                              <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "sky"}>{b.status}</Badge>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={() => toggleExpand(b.id)}
                              className="rounded border border-ink-700/60 bg-ink-800/60 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-sky-400/40 hover:text-sky-300 transition-all"
                            >
                              {isExpanded ? "Hide" : "View"}
                            </button>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-ink-950/40">
                            <td colSpan={10} className="px-6 py-4">
                              <div className="space-y-4 text-xs rounded-xl border border-ink-800 bg-ink-900/60 p-4">
                                {/* Kickoff banner */}
                                {b.fixture?.commenceTime && (() => {
                                  const ko = formatKickoff(b.fixture.commenceTime, b.fixture.status, b.fixture.homeScore, b.fixture.awayScore);
                                  return (
                                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                                      <span className="text-amber-300 font-bold text-sm">⚽ Kickoff</span>
                                      <div className="flex items-center gap-2 text-[11px]">
                                        <span className="rounded bg-ink-800/80 px-2 py-0.5 font-semibold text-slate-200">{ko.day}, {ko.date}</span>
                                        <span className="text-slate-400">UTC {new Date(b.fixture.commenceTime * 1000).toUTCString().slice(17, 22)}</span>
                                        <span className="text-slate-600">|</span>
                                        <span className="text-sky-300 font-semibold">{ko.edt} EDT</span>
                                        <span className="text-slate-600">|</span>
                                        <span className="text-sky-300 font-semibold">{ko.wat} WAT</span>
                                      </div>
                                      <span className={`ml-auto text-[11px] italic ${ko.tag === "Final" ? "text-slate-400" : ko.tag === "Live" ? "text-red-400" : "text-amber-400/70"}`}>{ko.countdown}</span>
                                    </div>
                                  );
                                })()}
                                <div className="grid grid-cols-4 gap-4">
                                <div>
                                  <p className="text-slate-500 font-medium">Model Probability</p>
                                  <p className="mt-1 text-sm font-bold text-slate-100">{fmtPct(b.modelProbability)}</p>
                                  <p className="text-[11px] text-slate-500">at bet timestamp</p>
                                </div>
                                <div>
                                  <p className="text-slate-500 font-medium">Implied Probability</p>
                                  <p className="mt-1 text-sm font-bold text-slate-100">{fmtPct(1 / b.odds)}</p>
                                  <p className="text-[11px] text-slate-500">from bookmaker odds</p>
                                </div>
                                <div>
                                  <p className="text-slate-500 font-medium">Potential Payout</p>
                                  <p className="mt-1 text-sm font-bold text-emerald-300">₦{fmtMoney(potentialReturn, 0)}</p>
                                  <p className="text-[11px] text-slate-500">profit: ₦{fmtMoney(potentialReturn - b.stake, 0)}</p>
                                </div>
                                <div>
                                  <p className="text-slate-500 font-medium">Actions & Settlement</p>
                                  <div className="mt-1 space-y-2">
                                    {b.status === "pending" && (
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="number"
                                          min="0"
                                          max="20"
                                          placeholder="H"
                                          value={settleScores[b.fixtureId]?.home || ""}
                                          onChange={(e) =>
                                            setSettleScores((prev) => ({
                                              ...prev,
                                              [b.fixtureId]: { ...prev[b.fixtureId], home: e.target.value, away: prev[b.fixtureId]?.away || "0" },
                                            }))
                                          }
                                          className="w-10 rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-center text-xs font-bold text-slate-100 focus:outline-none"
                                        />
                                        <span className="text-xs font-bold text-slate-500">-</span>
                                        <input
                                          type="number"
                                          min="0"
                                          max="20"
                                          placeholder="A"
                                          value={settleScores[b.fixtureId]?.away || ""}
                                          onChange={(e) =>
                                            setSettleScores((prev) => ({
                                              ...prev,
                                              [b.fixtureId]: { ...prev[b.fixtureId], home: prev[b.fixtureId]?.home || "0", away: e.target.value },
                                            }))
                                          }
                                          className="w-10 rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-center text-xs font-bold text-slate-100 focus:outline-none"
                                        />
                                        <button
                                          onClick={() => handleQuickSettle(b.fixtureId, b.fixture?.sport === "tennis")}
                                          disabled={settlingId === b.fixtureId}
                                          className="rounded border border-sky-400/40 bg-sky-400/15 px-2 py-0.5 text-[11px] font-bold text-sky-200 hover:bg-sky-400/25"
                                        >
                                          {settlingId === b.fixtureId ? "…" : "⚡ Settle"}
                                        </button>
                                      </div>
                                    )}
                                    {b.status === "pending" && b.placedAt > Date.now() / 1000 - UNDO_WINDOW_SEC && (
                                      <button
                                        onClick={() => void undoBet(b)}
                                        className="rounded border border-red-400/40 bg-red-400/10 px-2 py-0.5 text-[11px] font-semibold text-red-300 hover:bg-red-400/20"
                                      >
                                        Undo Bet Log
                                      </button>
                                    )}                                  </div>
                                </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}

                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* True parlays — logged as ONE unit, settle all-or-nothing. Cross-sport,
          so they show regardless of the active sport toggle. */}
      <ParlaysSection parlays={db.parlayBets} />
    </div>
  );
}

function ParlaysSection({ parlays }: { parlays: Parlay[] }) {
  const pnl = (p: Parlay) =>
    p.outcomeAmount !== undefined ? `${p.outcomeAmount > 0 ? "+" : ""}${fmtMoney(p.outcomeAmount)}` : <span className="text-slate-600">pending</span>;

  if (parlays.length === 0) {
    return (
      <div>
        <SectionTitle sub="One unit, settles all-or-nothing — every leg must win">Parlays</SectionTitle>
        <EmptyState
          title="No parlays logged yet"
          body="Build one in the Slip Builder (Settings → Multiples must be ON) — or log a suggested parlay from the EV-ranked panel."
        />
      </div>
    );
  }

  return (
    <div>
      <SectionTitle sub="One unit, settles all-or-nothing — any leg loses and the whole slip is gone">Parlays</SectionTitle>
      <Card className="overflow-hidden">
        <div className="divide-y divide-ink-700/30">
          {parlays.map((p) => (
            <div key={p.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-500">
                    {fmtDate(p.placedAt)}
                    <span className="mx-1.5 text-slate-700">·</span>
                    <span className="capitalize">{p.sport}</span>
                    <span className="mx-1.5 text-slate-700">·</span>
                    <span className="num">{p.legs.length} legs</span>
                  </p>
                  <div className="mt-1.5 space-y-1">
                    {p.legs.map((l, i) => (
                      <p key={i} className="truncate text-sm text-slate-300">
                        <span className="text-slate-500">{i + 1}.</span> {l.homeTeam} vs {l.awayTeam}{" "}
                        <span className="text-slate-500">—</span> {marketLabel(l.market, l.selection)}{" "}
                        <span className="num text-slate-300">@{fmtOdds(l.odds)}</span>
                      </p>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-5">
                  <div className="text-right">
                    <p className="text-[11px] text-slate-500">Combined odds</p>
                    <p className="num text-sm font-semibold text-slate-100">{p.combinedOdds.toFixed(2)}x</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-slate-500">True prob</p>
                    <p className="num text-sm font-semibold text-sky-300">{fmtPct(p.combinedProbability)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-slate-500">Stake</p>
                    <p className="num text-sm font-semibold text-slate-300">{fmtMoney(p.stake)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-slate-500">P&L</p>
                    <p className={`num text-sm font-semibold ${pnlClass(p.outcomeAmount)}`}>{pnl(p)}</p>
                  </div>
                  <Badge tone={p.status === "won" ? "green" : p.status === "lost" ? "red" : "sky"}>{p.status}</Badge>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
