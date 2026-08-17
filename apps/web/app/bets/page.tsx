"use client";

import { useMemo, useState } from "react";
import { marketLabel, type Parlay } from "@oddket/core";
import { useData } from "../../lib/data-provider";

// Bets logged in the last 24h can be undone (mistaken logs). Older rows are
// kept immutable — undoing settled/CLV-scored history would corrupt the scoreboard.
const UNDO_WINDOW_SEC = 24 * 3600;
import { Badge, Card, EmptyState, Loading, SectionTitle } from "../../components/ui";
import { clvClass, fmtDate, fmtMoney, fmtOdds, fmtPct, fmtSignedPct, pnlClass } from "../../lib/format";

export default function BetsPage() {
  const { bets, db, sport, logBet, deleteBet, refresh } = useData();
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "won" | "lost" | "pending">("all");

  // --- paper-trade log form state ---
  // Tennis has no draw — the form's selection set is sport-scoped.
  const selections: Array<"home" | "draw" | "away"> = sport === "tennis" ? ["home", "away"] : ["home", "draw", "away"];
  const [formFixture, setFormFixture] = useState("");
  const [formSelection, setFormSelection] = useState<"home" | "draw" | "away">("home");
  const [formOdds, setFormOdds] = useState("");
  const [formStake, setFormStake] = useState("");
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If the active sport can't have the current selection (e.g. draw on tennis),
  // coerce back to a valid one when the sport switches.
  const [prevSport, setPrevSport] = useState(sport);
  if (prevSport !== sport) {
    setPrevSport(sport);
    if (sport === "tennis" && formSelection === "draw") setFormSelection("home");
  }

  const bettableFixtures = useMemo(() => {
    if (!db) return [];
    const scheduled = db.fixtures.filter((f) => f.status === "scheduled");
    // In live mode, only surface fixtures for the ACTIVE sport (football seeds
    // use sport 'soccer', live football uses 'soccer_*'; tennis always 'tennis').
    const live = scheduled.filter((f) => (sport === "tennis" ? f.sport === "tennis" : f.sport !== "tennis"));
    const pool = live.length > 0 ? live : scheduled;
    const predicted = new Set(db.predictions.map((p) => p.fixtureId));
    return pool.filter((f) => predicted.has(f.id));
  }, [db, sport]);

  const bestOddsFor = (fixtureId: string, selection: string): number | null => {
    if (!db) return null;
    const snaps = db.odds.filter((o) => o.fixtureId === fixtureId && o.market === "h2h" && o.selection === selection);
    const best = Math.max(...snaps.map((o) => o.odds), 0);
    return best > 0 ? best : null;
  };

  const pickFixture = (id: string) => {
    setFormFixture(id);
    const best = bestOddsFor(id, "home");
    setFormOdds(best ? String(best) : "");
  };

  const pickSelection = (sel: "home" | "draw" | "away") => {
    setFormSelection(sel);
    const best = bestOddsFor(formFixture, sel);
    setFormOdds(best ? String(best) : "");
  };

  const undoBet = async (b: { id: string; status: string }) => {
    if (b.status !== "pending") {
      setUndoMsg("Only pending bets can be undone — settled bets are locked to keep the scoreboard honest.");
      return;
    }
    await deleteBet(b.id);
    setUndoMsg("Bet removed from your log.");
    refresh();
  };

  const submitBet = async (e: React.FormEvent) => {
    e.preventDefault();
    const odds = parseFloat(formOdds);
    const stake = parseFloat(formStake);
    if (!formFixture || !odds || odds <= 1 || !stake || stake <= 0) {
      setFormMsg("Pick a fixture, fill odds (>1) and a stake.");
      return;
    }
    const fixture = db?.fixtures.find((f) => f.id === formFixture);
    const pred = db?.predictions.find(
      (p) => p.fixtureId === formFixture && p.market === "h2h" && p.selection === formSelection,
    );
    setSubmitting(true);
    try {
      await logBet({
        fixtureId: formFixture,
        market: "h2h",
        selection: formSelection,
        odds,
        stake,
        edge: pred ? pred.probability - 1 / odds : 0,
        modelProbability: pred?.probability ?? 0,
        placedAt: Math.floor(Date.now() / 1000),
      });
      setFormMsg(`Logged: ${fixture?.homeTeam ?? ""} vs ${fixture?.awayTeam ?? ""} — ${marketLabel("h2h", formSelection)} @ ${odds} for ₦${stake}`);
      setFormOdds("");
      setFormStake("");
    } catch (err) {
      setFormMsg(err instanceof Error ? err.message : "Couldn't log the bet — please try again.");
    } finally {
      setSubmitting(false);
      refresh();
    }
  };

  const filtered = useMemo(
    () => (statusFilter === "all" ? bets : bets.filter((b) => b.status === statusFilter)),
    [bets, statusFilter],
  );

  const totals = useMemo(() => {
    const settled = bets.filter((b) => b.status === "won" || b.status === "lost");
    const staked = settled.reduce((a, b) => a + b.stake, 0);
    const ret = settled.reduce((a, b) => a + (b.outcomeAmount ?? 0), 0);
    const withClv = settled.filter((b) => b.clv !== undefined);
    const cumClv = withClv.reduce((a, b) => a + (b.clv ?? 0), 0);
    return { n: settled.length, staked, ret, cumClv, nClv: withClv.length };
  }, [bets]);

  if (!db) return <Loading />;
  const pnlTotal = totals.ret - totals.staked;

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/50 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Bet Log & History</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            Paper-trade record scored against bookmaker closing lines (CLV).
          </p>
        </div>
      </div>

      {/* KPI Stat Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Settled Bets</p>
          <p className="mt-1 text-lg font-bold text-slate-100">{totals.n}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">{bets.filter(b => b.status === "pending").length} pending</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Total Staked</p>
          <p className="mt-1 text-lg font-bold text-slate-100">₦{fmtMoney(totals.staked, 0)}</p>
          <p className="mt-0.5 text-[10px] text-slate-500">across settled</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Net Profit / Loss</p>
          <p className={`mt-1 text-lg font-bold ${pnlTotal >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {pnlTotal >= 0 ? "+" : ""}₦{fmtMoney(pnlTotal, 0)}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">actual returns</p>
        </div>
        <div className="rounded-xl border border-ink-700/50 bg-ink-900/40 p-3.5">
          <p className="text-[11px] font-medium text-slate-400">Cumulative CLV</p>
          <p className={`mt-1 text-lg font-bold ${clvClass(totals.cumClv)}`}>
            {fmtSignedPct(totals.cumClv, 2)}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-500">over {totals.nClv} scored lines</p>
        </div>
      </div>

      {/* Paper-trade: log the bets you actually place on SportyBet */}
      <div className="rounded-xl border border-ink-700/50 bg-ink-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Manual Bet Logger</h2>
          <span className="text-[11px] text-slate-400">Auto-settles at match full-time</span>
        </div>
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
            value={formSelection}
            onChange={(e) => {
              const sel = e.target.value as "home" | "draw" | "away";
              setFormSelection(sel);
              pickSelection(sel);
            }}
            className="rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-medium text-slate-200 focus:border-sky-400/50 focus:outline-none capitalize"
          >
            {selections.map((s) => (
              <option key={s} value={s} className="capitalize">
                {s === "home" ? "Home Win" : s === "away" ? "Away Win" : "Draw"}
              </option>
            ))}
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
              step="50"
              min="1"
              placeholder="Stake (₦)"
              value={formStake}
              onChange={(e) => setFormStake(e.target.value)}
              className="w-full rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
            />
            <button type="submit" disabled={submitting} className="rounded-lg border border-sky-400/40 bg-sky-400/15 px-4 py-2 text-xs font-bold text-sky-200 hover:bg-sky-400/25 transition-all shrink-0">
              {submitting ? "Logging…" : "Log"}
            </button>
          </div>
        </form>
        {formMsg && <p className="mt-2 text-xs text-emerald-300">✓ {formMsg}</p>}
        {undoMsg && <p className="mt-2 text-xs text-slate-400">ℹ {undoMsg}</p>}
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
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
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No bets match this filter" body="Use the form above or the Slips page to log bets — every row feeds the live CLV scoreboard." />
      ) : (
        <div className="card overflow-hidden rounded-xl border border-ink-700/50 bg-ink-900/50">
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
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/40">
                {filtered.map((b) => (
                  <tr key={b.id} className="transition-colors hover:bg-ink-800/30">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">{fmtDate(b.placedAt)}</td>
                    <td className="px-4 py-3">
                      <p className="text-xs font-semibold text-slate-100">{b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId}</p>
                      <p className="text-[11px] text-slate-500">{b.fixture?.league}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded px-1.5 py-0.5 text-xs font-semibold bg-ink-800 text-slate-200 border border-ink-700/60 capitalize">
                        {b.selection}
                      </span>
                      <p className="mt-0.5 text-[10px] text-slate-500 uppercase">{b.market}</p>
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-bold text-slate-200">@{fmtOdds(b.odds)}</td>
                    <td className="px-4 py-3 text-right text-xs font-medium text-slate-300">₦{fmtMoney(b.stake, 0)}</td>
                    <td className={`px-4 py-3 text-right text-xs font-semibold ${b.edge > 0 ? "text-emerald-400" : "text-slate-500"}`}>{fmtSignedPct(b.edge)}</td>
                    <td className={`px-4 py-3 text-right text-xs font-bold ${clvClass(b.clv)}`}>
                      {b.clv !== undefined ? fmtSignedPct(b.clv, 2) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className={`px-4 py-3 text-right text-xs font-bold ${pnlClass(b.outcomeAmount)}`}>
                      {b.outcomeAmount !== undefined ? `${b.outcomeAmount > 0 ? "+" : ""}₦${fmtMoney(b.outcomeAmount, 0)}` : <span className="text-slate-500 font-normal">pending</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge tone={b.status === "won" ? "green" : b.status === "lost" ? "red" : "sky"}>{b.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {b.status === "pending" && b.placedAt > Date.now() / 1000 - UNDO_WINDOW_SEC && (
                        <button
                          onClick={() => void undoBet(b)}
                          title="Remove this mistaken bet log"
                          className="rounded-md border border-ink-700/60 px-2 py-1 text-[11px] font-semibold text-slate-400 transition-colors hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-300"
                        >
                          Undo
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
